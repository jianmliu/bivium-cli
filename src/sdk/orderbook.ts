// DCN secondary-trading order book — pure BigInt transforms, no I/O (relayer fetch lives in
// relayer.ts, chain reconciliation + execution in trade.ts). Mirrors the frontend's
// lib/orderbook.ts semantics; the numeric vectors in test/orderbook.test.ts are lifted from its
// test suite so both implementations stay pinned to the same fills.
//
// An ASK is a maker SELLING credit (`Offer{buy:false}`) — a taker buys it. A BID is a maker
// BUYING credit (`Offer{buy:true}`) — a taker sells existing credit into it (or a borrower
// originates debt against it).
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

/** Aggregate one sorted side (best-first from sortSide) into price levels with cumulative depth. */
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

/**
 * Plan a market order by FACE: walk the sorted side best-first, taking min(remaining, entry.size)
 * from each entry until `units` face is filled or the book runs dry. Each take becomes one `fill`
 * call, all submitted in a single core `multicall`. Dust takes whose cost rounds to zero are
 * skipped (the core reverts ZeroAmount on them).
 */
export function planSweepByFace(sorted: BookEntry[], units: bigint): { takes: SweepTake[]; filled: bigint; cost: bigint } {
  const takes: SweepTake[] = [];
  let remaining = units;
  let cost = 0n;
  for (const e of sorted) {
    if (remaining === 0n) break;
    const take = e.size < remaining ? e.size : remaining;
    if (take === 0n) continue;
    const takeCost = fillCost(e.offer, take, e.price);
    if (takeCost === 0n) continue;
    takes.push({ entry: e, units: take });
    cost += takeCost;
    remaining -= take;
  }
  return { takes, filled: units - remaining, cost };
}

/**
 * Plan a market BUY sized by SPEND: walk the sorted asks best-first, converting the remaining
 * budget to face at each level (floor — never overspend) until the budget or the book runs out.
 * `cost ≤ spend` always; `cost < spend` means the book could not absorb the full budget. Levels
 * are price-ascending, so an unaffordable level ends the walk (break, don't skip).
 */
export function planSweepBySpend(sorted: BookEntry[], spend: bigint): { takes: SweepTake[]; units: bigint; cost: bigint } {
  const takes: SweepTake[] = [];
  let left = spend;
  let units = 0n;
  for (const e of sorted) {
    if (left === 0n || e.price === 0n) break;
    const affordable = (left * WAD) / e.price;
    const take = affordable < e.size ? affordable : e.size;
    if (take === 0n) break;
    const takeCost = fillCost(e.offer, take, e.price);
    if (takeCost === 0n) break;
    takes.push({ entry: e, units: take });
    units += take;
    left -= takeCost;
  }
  return { takes, units, cost: spend - left };
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
export function planExactSpend(sorted: BookEntry[], requestedAssets: bigint): ExactSpendQuote {
  if (requestedAssets <= 0n) {
    return { kind: "insufficient-depth", requestedAssets, maxAssets: 0n, maxUnits: 0n, shortfallAssets: 0n, levelCount: 0 };
  }
  const plan = planSweepBySpend(sorted, requestedAssets);
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
 * `remaining assets = maxAssets − consumed` converted to face at `priceWad` (floor); a
 * units-capped offer is simply `maxUnits − consumed`.
 */
export function remainingFace(o: Offer, consumed: bigint, priceWad: bigint): bigint {
  if (o.maxAssets > 0n) {
    const remAssets = o.maxAssets > consumed ? o.maxAssets - consumed : 0n;
    return priceWad > 0n ? (remAssets * WAD) / priceWad : 0n;
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
  const reconciled: BookEntry[] = [];
  for (const [i, entry] of entries.entries()) {
    const consumed = consumedValues[i];
    if (consumed === undefined) return { ready: false, entries: [] };
    const size = remainingFace(entry.offer, consumed, entry.price);
    if (size > 0n && fillCost(entry.offer, size, entry.price) > 0n) {
      reconciled.push({ ...entry, size });
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
