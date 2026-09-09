// DCN secondary-trading order book — pure BigInt transforms, no I/O (relayer fetch lives in
// relayer.ts, chain reconciliation + execution in trade.ts). Mirrors the frontend's
// lib/orderbook.ts semantics; the numeric vectors in test/orderbook.test.ts are lifted from its
// test suite so both implementations stay pinned to the same fills.
//
// An ASK is a maker SELLING credit (`Offer{buy:false}`) — a taker buys it. A BID is a maker
// BUYING credit (`Offer{buy:true}`) — a taker sells existing credit into it (or a borrower
// originates debt against it).
import { collateralForDebt } from "./math.ts";
import { tickToPrice } from "./tick.ts";
import { WAD, type Address, type Hex, type Offer } from "./types.ts";

export type Side = "ask" | "bid";

/** One resting signed order as the book sees it. `size` is the fillable FACE units. */
export interface BookEntry {
  side: Side;
  offer: Offer;
  signature: Hex;
  commitment: Hex;
  price: bigint; // WAD discount price per face unit (tickToPrice(offer.tick))
  size: bigint;
  /** Exact on-chain group counter, in the offer cap currency. */
  consumed?: bigint;
  maker: Address;
}

/** Build a book entry from a validated signed offer (size assumes nothing consumed yet). */
export function entryFromSignedOffer(offer: Offer, commitment: Hex, signature: Hex): BookEntry {
  const price = tickToPrice(offer.tick);
  return {
    side: offer.buy ? "bid" : "ask",
    offer,
    signature,
    commitment,
    price,
    size: remainingFace(offer, 0n, price),
    maker: offer.maker,
  };
}

/**
 * The core meters an offer group's `consumed` in its capped currency: loan tokens for an
 * assets-capped offer (`maxAssets > 0`), else face units — mirrors Bivium's `_offerCap`.
 * Cancelling an offer on-chain is `setConsumed(group, offerCap(offer))`.
 */
export function offerCap(o: Offer): bigint {
  return o.maxAssets > 0n ? o.maxAssets : o.maxUnits;
}

/**
 * Loan-token cost of filling `units` face — EXACT core rounding, which goes BY MAKER DIRECTION
 * (always against the active taker): a maker BUY pays assets rounded down, a maker SELL receives
 * assets rounded up.
 */
export function fillCost(offer: Pick<Offer, "buy">, units: bigint, price: bigint): bigint {
  if (units === 0n) return 0n;
  const product = units * price;
  return offer.buy ? product / WAD : (product + WAD - 1n) / WAD;
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One side, sorted on the price axis: best ASK = lowest price (a buyer pays least);
 * best BID = highest price (a seller receives most).
 */
export function sortSide(entries: BookEntry[], side: Side): BookEntry[] {
  return entries
    .filter((e) => e.side === side)
    .sort((a, b) => (side === "ask" ? cmp(a.price, b.price) : cmp(b.price, a.price)));
}

/**
 * Slippage bound: drop entries beyond `limitTick`. HIGHER tick = HIGHER price, so a buyer of asks
 * caps the price it pays (keep tick ≤ limit) and a seller into bids floors the price it receives
 * (keep tick ≥ limit). `undefined` = no bound.
 */
export function filterByLimitTick(entries: BookEntry[], side: Side, limitTick?: bigint): BookEntry[] {
  if (limitTick === undefined) return entries;
  return entries.filter((e) => (side === "ask" ? e.offer.tick <= limitTick : e.offer.tick >= limitTick));
}

/** One aggregated price level with running cumulative depth; entries kept for the sweep planner. */
export interface DepthLevel {
  price: bigint;
  tick: bigint;
  size: bigint;
  cumulative: bigint;
  entries: BookEntry[];
}

/** Raw advertised depth; shared group caps and maker backing are NOT deducted. */
export function aggregateLevels(sorted: BookEntry[]): DepthLevel[] {
  const levels: DepthLevel[] = [];
  for (const e of sorted) {
    const last = levels[levels.length - 1];
    if (last && last.price === e.price) {
      last.size += e.size;
      last.entries.push(e);
    } else {
      levels.push({ price: e.price, tick: e.offer.tick, size: e.size, cumulative: 0n, entries: [e] });
    }
  }
  let run = 0n;
  for (const l of levels) {
    run += l.size;
    l.cumulative = run;
  }
  return levels;
}

export interface SweepTake {
  entry: BookEntry;
  units: bigint;
}

/** Shared group budget in its capped currency; subtraction saturates at zero. */
export function groupAvailable(cap: bigint, onchain: bigint, inplan: bigint): bigint {
  return cap > onchain + inplan ? cap - onchain - inplan : 0n;
}

export interface MakerBacking { liquidity: bigint; credit: bigint; escrow: bigint }
export type Backing = ReadonlyMap<string, MakerBacking>;

/** Canonical market + maker key, without requiring valid addresses in pure offline models. */
export function makerBackingKey(entry: BookEntry): string {
  const o = entry.offer;
  return [o.loanToken, o.collateralToken, o.maturity, o.strike, o.allowPartialRepay, o.gate, o.maker]
    .map(String).join(":").toLowerCase();
}
const groupKey = (e: BookEntry) => `${e.offer.maker}:${e.offer.group}`.toLowerCase();

function validateGroups(entries: BookEntry[]): void {
  const groups = new Map<string, { assets: boolean; consumed: bigint }>();
  for (const e of entries) {
    const key = groupKey(e);
    const state = { assets: e.offer.maxAssets > 0n, consumed: e.consumed ?? 0n };
    const previous = groups.get(key);
    if (previous && previous.assets !== state.assets) throw new Error(`mixed cap currencies in maker/group ${key}`);
    if (state.consumed < 0n || (previous && previous.consumed !== state.consumed)) {
      throw new Error(`contradictory consumed values in maker/group ${key}`);
    }
    groups.set(key, state);
  }
}

function sweep(sorted: BookEntry[], target: bigint, bySpend: boolean, backing?: Backing) {
  validateGroups(sorted);
  const groups = new Map<string, bigint>();
  const balances = new Map<string, MakerBacking>();
  if (backing) for (const [key, value] of backing) balances.set(key, { ...value });
  const seen = new Set<string>();
  const takes: SweepTake[] = [];
  let units = 0n, cost = 0n;
  for (const e of sorted) {
    const commitment = e.commitment.toLowerCase();
    if (seen.has(commitment)) continue;
    seen.add(commitment);
    const key = groupKey(e);
    const available = groupAvailable(offerCap(e.offer), e.consumed ?? 0n, groups.get(key) ?? 0n);
    const balance = balances.get(makerBackingKey(e));
    if (backing && (!balance || Object.values(balance).some(v => v < 0n))) throw new Error(`missing or invalid maker backing for ${makerBackingKey(e)}`);
    const fits = (n: bigint) => {
      const assets = fillCost(e.offer, n, e.price);
      if ((e.offer.maxAssets > 0n ? assets : n) > available) return false;
      if (bySpend ? cost + assets > target : units + n > target) return false;
      if (!balance) return true;
      if (e.offer.buy) return assets <= balance.liquidity;
      const issued = n > balance.credit ? n - balance.credit : 0n;
      return issued === 0n || collateralForDebt(issued, e.offer.strike) <= balance.escrow;
    };
    let low = 0n, high = e.size;
    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      if (fits(mid)) low = mid; else high = mid - 1n;
    }
    const takeCost = fillCost(e.offer, low, e.price);
    if (low <= 0n || takeCost <= 0n) continue;
    takes.push({ entry: e, units: low });
    units += low; cost += takeCost;
    groups.set(key, (groups.get(key) ?? 0n) + (e.offer.maxAssets > 0n ? takeCost : low));
    if (balance) {
      if (e.offer.buy) balance.liquidity -= takeCost;
      else {
        const transfer = low < balance.credit ? low : balance.credit;
        balance.credit -= transfer;
        if (low > transfer) balance.escrow -= collateralForDebt(low - transfer, e.offer.strike);
      }
    }
  }
  return { takes, units, cost };
}

/** Group-safe face sweep. Without explicit backing this does not establish full executability. */
export function planSweepByFace(sorted: BookEntry[], units: bigint, backing?: Backing): { takes: SweepTake[]; filled: bigint; cost: bigint } {
  const plan = sweep(sorted, units, false, backing);
  return { takes: plan.takes, filled: plan.units, cost: plan.cost };
}

/** Group-safe spend sweep. Without explicit backing this does not establish full executability. */
export function planSweepBySpend(sorted: BookEntry[], spend: bigint, backing?: Backing): { takes: SweepTake[]; units: bigint; cost: bigint } {
  return sweep(sorted, spend, true, backing);
}

export type ExactSpendQuote =
  | { kind: "executable"; requestedAssets: bigint; plan: ReturnType<typeof planSweepBySpend>; levelCount: number }
  | {
      kind: "insufficient-depth";
      requestedAssets: bigint;
      maxAssets: bigint;
      maxUnits: bigint;
      shortfallAssets: bigint;
      levelCount: number;
    };

/**
 * Exact-spend quote: executable only when the book absorbs EXACTLY `requestedAssets` (no partial
 * spend, no rounding remainder). Anything else reports the achievable maximum instead.
 */
export function planExactSpend(sorted: BookEntry[], requestedAssets: bigint, backing?: Backing): ExactSpendQuote {
  if (requestedAssets <= 0n) {
    return { kind: "insufficient-depth", requestedAssets, maxAssets: 0n, maxUnits: 0n, shortfallAssets: 0n, levelCount: 0 };
  }
  const plan = planSweepBySpend(sorted, requestedAssets, backing);
  const levelCount = new Set(plan.takes.map((take) => take.entry.price)).size;
  if (plan.takes.length > 0 && plan.cost === requestedAssets) {
    return { kind: "executable", requestedAssets, plan, levelCount };
  }
  return {
    kind: "insufficient-depth",
    requestedAssets,
    maxAssets: plan.cost,
    maxUnits: plan.units,
    shortfallAssets: requestedAssets > plan.cost ? requestedAssets - plan.cost : 0n,
    levelCount,
  };
}

/**
 * Remaining fillable FACE of an offer given its on-chain `consumed`: an assets-capped bid has
 * `remaining assets = maxAssets − consumed`. Invert the actual cost rounding: asks use
 * floor(assets·WAD/price); bids use floor(((assets+1)·WAD−1)/price).
 * A units-capped offer is simply `maxUnits − consumed`.
 */
export function remainingFace(o: Offer, consumed: bigint, priceWad: bigint): bigint {
  if (o.maxAssets > 0n) {
    const remAssets = o.maxAssets > consumed ? o.maxAssets - consumed : 0n;
    return priceWad > 0n && remAssets > 0n
      ? (o.buy ? ((remAssets + 1n) * WAD - 1n) / priceWad : (remAssets * WAD) / priceWad) : 0n;
  }
  return o.maxUnits > consumed ? o.maxUnits - consumed : 0n;
}

/**
 * Reconcile book entries with the core's authoritative `consumed` counters. Fail closed: a single
 * missing/unreadable read makes the WHOLE batch unavailable, so callers cannot accidentally route
 * against stale capacity. Entries whose remaining face rounds to zero cost are dropped.
 */
export function reconcileConsumedEntries(
  entries: BookEntry[],
  consumedValues: readonly (bigint | undefined)[],
): { ready: boolean; entries: BookEntry[] } {
  if (entries.length !== consumedValues.length) return { ready: false, entries: [] };
  try { validateGroups(entries.map((e, i) => ({ ...e, consumed: consumedValues[i] }))); }
  catch { return { ready: false, entries: [] }; }
  const reconciled: BookEntry[] = [];
  for (const [i, entry] of entries.entries()) {
    const consumed = consumedValues[i];
    if (consumed === undefined) return { ready: false, entries: [] };
    const size = remainingFace(entry.offer, consumed, entry.price);
    if (size > 0n && fillCost(entry.offer, size, entry.price) > 0n) {
      reconciled.push({ ...entry, size, consumed });
    }
  }
  return { ready: true, entries: reconciled };
}

/** An offer is fillable at `nowSec` — relayer-book liveness filter (frontend semantics). */
export function offerActiveAt(offer: Pick<Offer, "start" | "expiry" | "maturity">, nowSec: bigint): boolean {
  return offer.start <= nowSec && nowSec < offer.expiry && nowSec < offer.maturity;
}

/**
 * Queue position of a maker's bid vs a benchmark bid. LOB law, pinned by test because the
 * direction has been gotten backwards before: HIGHER tick = higher price = LOWER lender APR =
 * filled FIRST.
 */
export function queuePosition(
  myTick: bigint | undefined,
  benchTick: bigint | undefined,
): "ahead" | "behind" | "tied" | undefined {
  if (myTick === undefined || benchTick === undefined) return undefined;
  return myTick > benchTick ? "ahead" : myTick < benchTick ? "behind" : "tied";
}
