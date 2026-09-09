// Secondary DCN trading on top of BiviumClient: plan a sweep against resting signed offers,
// preflight it against the core's live state, execute every fill in ONE core `multicall`, and
// enforce exact balance-delta postconditions.
//
// Core `fill` semantics this client mirrors (src/Bivium.sol `_fill`/`_moveClaim`):
// - ASK fill (offer.buy=false): the taker is the buyer; cost = ceil(units·price/WAD) pulled live
//   from the taker. The maker is the seller: it TRANSFERS the credit it holds, and — since
//   bivium-core #171 — ORIGINATES the rest against collateral it escrowed (`escrowCollateral`), so
//   a resting ask is also a resting borrow order. We precheck per maker that the units beyond its
//   credit are covered: ceil(issued·STRIKE_SCALE/strike) ≤ collateralEscrowOf(maker), and that
//   issuance is still open (now < maturity). A core without the escrow surface answers no escrow,
//   which collapses to the pre-#171 rule `creditOf(maker) ≥ units` (OnlyTakerMayBorrow otherwise).
// - BID fill (offer.buy=true): the taker is the seller; proceeds = floor(units·price/WAD) drawn
//   from the maker's pre-funded liquidity. Selling EXISTING credit is a pure secondary transfer
//   and stays legal at/after maturity (`MaturityPassed` only guards new issuance) — we therefore
//   do NOT reuse the borrow-path matured guard, and instead require `creditOf(taker) ≥ units` so
//   the fill cannot slip into new-debt origination.
import { encodeFunctionData, type Account } from "viem";
import { BiviumClient, type TxResult } from "./client.ts";
import { adapterFor, type ChainDomain } from "./lineage.ts";
import { marketParamsFromOffer } from "./offer.ts";
import {
  entryFromSignedOffer,
  makerBackingKey,
  type MakerBacking,
  fillCost,
  filterByLimitTick,
  offerCap,
  planExactSpend,
  planSweepByFace,
  planSweepBySpend,
  reconcileConsumedEntries,
  sortSide,
  type BookEntry,
  type Side,
  type SweepTake,
} from "./orderbook.ts";
import { collateralForDebt } from "./math.ts";
import { RATIFIED } from "./ratify.ts";
import { cancelMessage, deleteSignedOffer, requireRelayerV2 } from "./relayer.ts";
import type { Address, DeploymentProfile, Hex } from "./types.ts";

/**
 * Collateral a resting ask's maker is short of for `units`: what core would lock for the units beyond the maker's
 * credit (`ceil(issued·STRIKE_SCALE/strike)`, its `_mulDivUp`) minus what it escrowed. Zero means the fill clears.
 */
export function askBackingShortfall(args: { units: bigint; credit: bigint; escrow: bigint; strike: bigint }): bigint {
  const issued = args.units > args.credit ? args.units - args.credit : 0n;
  if (issued === 0n) return 0n;
  const locked = collateralForDebt(issued, args.strike);
  return locked > args.escrow ? locked - args.escrow : 0n;
}

export interface TradePlanRequest {
  units?: bigint;
  spend?: bigint;
  /** With `spend`: require the book to absorb EXACTLY the budget (no partial spend). */
  exactSpend?: boolean;
  /** Slippage bound: buy keeps tick ≤ limit (price cap), sell keeps tick ≥ limit (price floor). */
  limitTick?: bigint;
}

export interface TradePlan {
  /** Side of the book being consumed: "ask" for a taker buy, "bid" for a taker sell. */
  side: Side;
  takes: SweepTake[];
  totalUnits: bigint;
  /** Loan-token cash: total paid (buy) or total proceeds (sell). */
  totalCost: bigint;
  /** Worst executed tick — highest for a buy, lowest for a sell. */
  worstTick?: bigint;
}

export interface SweepResult extends TradePlan, TxResult {
  creditDelta: bigint;
  loanDelta: bigint;
}

export interface CancelResult {
  cap: bigint;
  consumedBefore: bigint;
  /** undefined when the offer group was already at/above cap (nothing to write). */
  tx?: TxResult;
  relayer: "deleted" | "skipped" | { failed: string };
}

export class TradeClient extends BiviumClient {
  private readonly signerAccount?: Account;

  constructor(profile: DeploymentProfile, account?: Account) {
    super(profile, account);
    this.signerAccount = account;
  }

  private get chainDomain(): ChainDomain {
    return { chainId: this.profile.chainId, core: this.profile.core };
  }

  /**
   * Replace every entry's size with the core's authoritative remaining capacity. Fails CLOSED:
   * one unreadable `consumed` makes the whole batch unusable. Duplicate commitments are dropped
   * first (two copies of one order would double-count its budget).
   */
  async reconcileBook(entries: BookEntry[]): Promise<BookEntry[]> {
    const seen = new Set<string>();
    const unique = entries.filter((e) => {
      const key = e.commitment.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const consumedValues = await boundedMap(unique, (e) =>
      this.consumed(e.maker, e.offer.group).then((v): bigint | undefined => v, () => undefined));
    const result = reconcileConsumedEntries(unique, consumedValues);
    if (!result.ready) throw new Error("could not read on-chain consumed for every offer — book unusable (fail closed)");
    return result.entries;
  }

  /** Authoritative maker backing, shared across every offer group in the same market. */
  async loadBacking(entries: BookEntry[]): Promise<Map<string, MakerBacking>> {
    const unique = new Map<string, BookEntry>();
    for (const entry of entries) unique.set(makerBackingKey(entry), entry);
    const values = await boundedMap([...unique], async ([key, entry]) => {
      const id = this.marketId(marketParamsFromOffer(entry.offer));
      try {
        // Read both sides when a market/maker appears on both sides of a snapshot.
        const related = entries.filter(e => makerBackingKey(e) === key);
        const liquidity = related.some(e => e.offer.buy) ? await this.liquidityOf(id, entry.maker) : 0n;
        const credit = related.some(e => !e.offer.buy) ? await this.creditOf(id, entry.maker) : 0n;
        const escrow = related.some(e => !e.offer.buy) ? await this.collateralEscrowOf(id, entry.maker) : 0n;
        return [key, { liquidity, credit, escrow }] as const;
      } catch (error) {
        throw new Error(`could not read maker backing for ${key} — fail closed`, { cause: error });
      }
    });
    return new Map(values);
  }

  /** Plan a taker BUY (sweep the asks) sized by face units or by loan-token spend. */
  async planBuy(entries: BookEntry[], request: TradePlanRequest): Promise<TradePlan> {
    if ((request.units === undefined) === (request.spend === undefined)) {
      throw new Error("size the buy with exactly one of units or spend");
    }
    const book = filterByLimitTick(sortSide(await this.reconcileBook(entries), "ask"), "ask", request.limitTick);
    const backing = await this.loadBacking(book);
    let takes: SweepTake[];
    let totalUnits: bigint;
    let totalCost: bigint;
    if (request.units !== undefined) {
      const plan = planSweepByFace(book, request.units, backing);
      takes = plan.takes;
      totalUnits = plan.filled;
      totalCost = plan.cost;
    } else if (request.exactSpend) {
      const quote = planExactSpend(book, request.spend!, backing);
      if (quote.kind !== "executable") {
        throw new Error(
          `exact spend not executable: book absorbs at most ${quote.maxAssets} (${quote.maxUnits} face) of requested ${quote.requestedAssets} — shortfall ${quote.shortfallAssets}`,
        );
      }
      takes = quote.plan.takes;
      totalUnits = quote.plan.units;
      totalCost = quote.plan.cost;
    } else {
      const plan = planSweepBySpend(book, request.spend!, backing);
      takes = plan.takes;
      totalUnits = plan.units;
      totalCost = plan.cost;
    }
    return { side: "ask", takes, totalUnits, totalCost, worstTick: worstTickOf(takes, "ask") };
  }

  /** Plan a taker SELL (sweep the bids) of `units` existing face. */
  async planSell(entries: BookEntry[], request: TradePlanRequest): Promise<TradePlan> {
    if (request.units === undefined || request.spend !== undefined) {
      throw new Error("size the sell with units");
    }
    const book = filterByLimitTick(sortSide(await this.reconcileBook(entries), "bid"), "bid", request.limitTick);
    const backing = await this.loadBacking(book);
    const plan = planSweepByFace(book, request.units, backing);
    return { side: "bid", takes: plan.takes, totalUnits: plan.filled, totalCost: plan.cost, worstTick: worstTickOf(plan.takes, "bid") };
  }

  /** Every check either sweep runs before spending gas. Throws with the first violation. */
  public async preflight(plan: TradePlan, account: Address | undefined = undefined, block?: { number: bigint; timestamp: bigint }) {
    if (!plan.takes.length) throw new Error("nothing to fill — empty or filtered-out book");
    const pinned = block ?? await this.pub.getBlock();
    if (pinned.number === null) throw new Error("No mined block available");
    return validateTradePlan(plan, { profile: this.profile, account: account ?? this.account, block: { number: pinned.number, timestamp: pinned.timestamp }, read: r => this.pub.readContract(r as never) });
  }

  /** Encode one `fill` per take and submit them as a single core `multicall`. */
  private async executeSweep(plan: TradePlan, marketId: Hex): Promise<SweepResult> {
    const taker = this.account;
    const loanToken = plan.takes[0].entry.offer.loanToken;
    if (plan.side === "ask") {
      await this.approveExact(loanToken, this.profile.core, plan.totalCost);
    }
    const creditBefore = await this.creditOf(marketId, taker);
    const loanBefore = await this.balanceOf(loanToken, taker);
    const calls = plan.takes.map((t) =>
      encodeFunctionData({
        abi: this.adapter.coreAbi,
        functionName: "fill",
        args: [this.adapter.chainOffer(this.chainDomain, t.entry.offer), t.entry.signature, t.units, taker, taker],
      } as never),
    );
    const tx = await this.write({
      address: this.profile.core,
      abi: this.adapter.coreAbi,
      functionName: "multicall",
      args: [calls],
    });
    const creditDelta = (await this.creditOf(marketId, taker)) - creditBefore;
    const loanDelta = (await this.balanceOf(loanToken, taker)) - loanBefore;
    const wantCredit = plan.side === "ask" ? plan.totalUnits : -plan.totalUnits;
    const wantLoan = plan.side === "ask" ? -plan.totalCost : plan.totalCost;
    if (creditDelta !== wantCredit) {
      throw new Error(`sweep postcondition failed: credit delta ${creditDelta}, expected ${wantCredit} (tx ${tx.hash})`);
    }
    if (loanDelta !== wantLoan) {
      throw new Error(`sweep postcondition failed: loan-token delta ${loanDelta}, expected ${wantLoan} (tx ${tx.hash})`);
    }
    return { ...plan, ...tx, creditDelta, loanDelta };
  }

  /** Preflight + execute a previously computed plan (what the CLI shows is what runs). */
  async executePlan(plan: TradePlan): Promise<SweepResult> {
    const { marketId } = await this.preflight(plan);
    return await this.executeSweep(plan, marketId);
  }

  /** Market BUY: sweep resting SELL asks in one multicall; pays exact loan tokens for exact face. */
  async sweepBuy(entries: BookEntry[], request: TradePlanRequest): Promise<SweepResult> {
    return await this.executePlan(await this.planBuy(entries, request));
  }

  /** Market SELL: sweep resting BUY bids in one multicall; pure secondary transfer of held face. */
  async sweepSell(entries: BookEntry[], request: TradePlanRequest): Promise<SweepResult> {
    return await this.executePlan(await this.planSell(entries, request));
  }

  /**
   * Cancel a resting offer. On-chain `setConsumed(group, cap)` is the AUTHORITY (kills every copy
   * of the signature forever); the relayer DELETE only delists the served copy and is tolerated
   * to fail. The signing key must be the offer's maker.
   */
  async cancelOffer(file: { offer: BookEntry["offer"]; commitment: Hex; signature: Hex }): Promise<CancelResult> {
    const { offer, commitment } = file;
    if (this.account.toLowerCase() !== offer.maker.toLowerCase()) {
      throw new Error(`signing key is ${this.account} but the offer's maker is ${offer.maker} — only the maker may cancel`);
    }
    const cap = offerCap(offer);
    const consumedBefore = await this.consumed(offer.maker, offer.group);
    let tx: TxResult | undefined;
    if (consumedBefore < cap) {
      tx = await this.write({
        address: this.profile.core,
        abi: this.adapter.coreAbi,
        functionName: "setConsumed",
        args: [offer.group, cap, offer.maker],
      });
      const after = await this.consumed(offer.maker, offer.group);
      if (after < cap) throw new Error(`cancel postcondition failed: consumed ${after} still below cap ${cap}`);
    }
    let relayer: CancelResult["relayer"] = "skipped";
    if (this.profile.relayerUrl) {
      try {
        requireRelayerV2(this.profile.abiProfile);
        if (!this.signerAccount?.signMessage) throw new Error("no signing account for the relayer cancel message");
        const cancelSignature = await this.signerAccount.signMessage({ message: cancelMessage(commitment) });
        await deleteSignedOffer(
          {
            chainId: this.profile.chainId,
            core: this.profile.core,
            abiProfile: this.profile.abiProfile,
            signatureRatifier: this.profile.signatureRatifier,
            relayerUrl: this.profile.relayerUrl,
          },
          offer,
          commitment,
          cancelSignature,
        );
        relayer = "deleted";
      } catch (error) {
        relayer = { failed: error instanceof Error ? error.message : String(error) };
      }
    }
    return { cap, consumedBefore, tx, relayer };
  }
}

function worstTickOf(takes: SweepTake[], side: Side): bigint | undefined {
  if (takes.length === 0) return undefined;
  const ticks = takes.map((t) => t.entry.offer.tick);
  // Buying asks: worst = priciest = highest tick. Selling into bids: worst = cheapest = lowest.
  return side === "ask" ? ticks.reduce((a, b) => (b > a ? b : a)) : ticks.reduce((a, b) => (b < a ? b : a));
}

/** Keep public RPC pressure bounded even for large relayer books. */
async function boundedMap<T, R>(values: T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < values.length; i += 8) result.push(...await Promise.all(values.slice(i, i + 8).map(fn)));
  return result;
}

/** One account-independent validator shared by wallet execution and unsigned action preparation. */
export async function validateTradePlan(plan: TradePlan, env: {
  profile: DeploymentProfile; account: Address; block: { number: bigint; timestamp: bigint };
  mode?: "secondary" | "borrow"; taker?: Address;
  read: (request: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; blockNumber: bigint }) => Promise<unknown>;
}) {
  if (!plan.takes.length) throw new Error("nothing to fill — empty book");
  const adapter = adapterFor(env.profile.abiProfile), state: Record<string, unknown> = {};
  const read = async <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<T> => {
    const value = await env.read({ address, abi, functionName, args, blockNumber: env.block.number });
    state[`${address.toLowerCase()}:${functionName}:${args.map(String).join(":")}`] = value;
    return value as T;
  };
  const core = <T>(name: string, args: readonly unknown[]) => read<T>(env.profile.core, adapter.coreAbi, name, args);
  const marketIds = new Set(plan.takes.map(t => adapter.computeMarketId(env.profile, marketParamsFromOffer(t.entry.offer)).toLowerCase()));
  if (marketIds.size !== 1) throw new Error("sweep spans multiple markets");
  const marketId = [...marketIds][0] as Hex;
  const seen = new Set<string>(), entries: BookEntry[] = [], backing = new Map<string, MakerBacking>();
  let total = 0n, cost = 0n;
  for (const t of plan.takes) {
    const o = t.entry.offer;
    const embedded = o as typeof o & { chainId?: bigint; bivium?: Address };
    if ((embedded.chainId !== undefined && BigInt(embedded.chainId) !== BigInt(env.profile.chainId)) || (embedded.bivium !== undefined && embedded.bivium.toLowerCase() !== env.profile.core.toLowerCase())) throw new Error('Offer domain mismatch');
    if (t.units <= 0n || o.buy !== (plan.side === "bid")) throw new Error("invalid units or side");
    if (o.maker.toLowerCase() === env.account.toLowerCase()) throw new Error("SelfDeal: own offer");
    if (env.block.timestamp < o.start || env.block.timestamp > o.expiry) throw new Error("offer outside start/expiry window");
    const commitment = adapter.offerCommitment(env.profile, o);
    if (commitment.toLowerCase() !== t.entry.commitment.toLowerCase() || seen.has(commitment)) throw new Error("invalid or duplicate commitment");
    seen.add(commitment);
    if (![env.profile.signatureRatifier, env.profile.setterRatifier].some(r => r?.toLowerCase() === o.ratifier.toLowerCase())) throw new Error("Unsupported ratifier");
    if (await core('isRatifier', [o.maker, o.ratifier]) !== true) throw new Error("Unregistered ratifier");
    const args = [...adapter.ratifierArgs(o.maker, t.units, commitment, t.entry.signature)];
    if (env.profile.abiProfile === 'core-v2') args[1] = env.taker ?? env.account;
    if (await read(o.ratifier, adapter.ratifierAbi, 'isRatified', args) !== RATIFIED) throw new Error("ratifier precheck did not return RATIFIED");
    const entry = entryFromSignedOffer(o, commitment, t.entry.signature);
    entry.consumed = await core<bigint>('consumed', [o.maker, o.group]);
    entry.size = t.units;
    entries.push(entry);
    const key = makerBackingKey(entry);
    if (!backing.has(key)) backing.set(key, {
      liquidity: o.buy ? await core<bigint>('liquidityOf', [marketId, o.maker]) : 0n,
      credit: !o.buy ? await core<bigint>('creditOf', [marketId, o.maker]) : 0n,
      escrow: !o.buy ? await core<bigint>('collateralEscrowOf', [marketId, o.maker]) : 0n,
    });
    total += t.units; cost += fillCost(o, t.units, entry.price);
  }
  if (total !== plan.totalUnits || cost !== plan.totalCost) throw new Error("plan totals mismatch");
  const checked = planSweepByFace(entries, total, backing);
  if (checked.takes.length !== entries.length || checked.takes.some((t,i) => t.units !== plan.takes[i].units)) throw new Error("insufficient shared capacity or maker backing");
  if (plan.side === 'ask' && env.block.timestamp >= entries[0].offer.maturity) {
    const credits = new Map([...backing].map(([k,v]) => [k,v.credit]));
    for (const e of entries) { const k=makerBackingKey(e), c=credits.get(k)!; if(c<e.size)throw new Error('MaturityPassed: ask would originate');credits.set(k,c-e.size); }
  }
  const credit = await core<bigint>('creditOf', [marketId, env.account]);
  if (plan.side === 'bid') {
    if (env.mode === 'borrow') {
      if (credit !== 0n) throw new Error('Borrow requires zero existing credit to guarantee full new debt');
      if (env.block.timestamp >= entries[0].offer.maturity) throw new Error('MaturityPassed: borrow');
    } else if (credit < total) throw new Error('Insufficient taker credit: fill would originate new debt');
  }
  return { marketId, keyState: { reads: state, orders: entries, backing: [...backing], matured: env.block.timestamp >= entries[0].offer.maturity }, credit };
}
