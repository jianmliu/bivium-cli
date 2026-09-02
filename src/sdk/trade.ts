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
import type { ChainDomain } from "./lineage.ts";
import { marketParamsFromOffer } from "./offer.ts";
import {
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
import type { DeploymentProfile, Hex } from "./types.ts";

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
    const consumedValues = await Promise.all(
      unique.map((e) => this.consumed(e.maker, e.offer.group).then((v): bigint | undefined => v, () => undefined)),
    );
    const result = reconcileConsumedEntries(unique, consumedValues);
    if (!result.ready) throw new Error("could not read on-chain consumed for every offer — book unusable (fail closed)");
    return result.entries;
  }

  /** Plan a taker BUY (sweep the asks) sized by face units or by loan-token spend. */
  async planBuy(entries: BookEntry[], request: TradePlanRequest): Promise<TradePlan> {
    if ((request.units === undefined) === (request.spend === undefined)) {
      throw new Error("size the buy with exactly one of units or spend");
    }
    const book = filterByLimitTick(sortSide(await this.reconcileBook(entries), "ask"), "ask", request.limitTick);
    let takes: SweepTake[];
    let totalUnits: bigint;
    let totalCost: bigint;
    if (request.units !== undefined) {
      const plan = planSweepByFace(book, request.units);
      takes = plan.takes;
      totalUnits = plan.filled;
      totalCost = plan.cost;
    } else if (request.exactSpend) {
      const quote = planExactSpend(book, request.spend!);
      if (quote.kind !== "executable") {
        throw new Error(
          `exact spend not executable: book absorbs at most ${quote.maxAssets} (${quote.maxUnits} face) of requested ${quote.requestedAssets} — shortfall ${quote.shortfallAssets}`,
        );
      }
      takes = quote.plan.takes;
      totalUnits = quote.plan.units;
      totalCost = quote.plan.cost;
    } else {
      const plan = planSweepBySpend(book, request.spend!);
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
    const plan = planSweepByFace(book, request.units);
    return { side: "bid", takes: plan.takes, totalUnits: plan.filled, totalCost: plan.cost, worstTick: worstTickOf(plan.takes, "bid") };
  }

  /** Every check either sweep runs before spending gas. Throws with the first violation. */
  private async preflight(plan: TradePlan): Promise<{ marketId: Hex }> {
    if (plan.takes.length === 0) throw new Error("nothing to fill — empty or filtered-out book");
    const taker = this.account;
    const block = await this.pub.getBlock();
    const now = block.timestamp;
    const marketIds = new Set(plan.takes.map((t) => this.marketId(marketParamsFromOffer(t.entry.offer))));
    if (marketIds.size !== 1) throw new Error("sweep spans multiple markets — refusing");
    const marketId = [...marketIds][0] as Hex;

    for (const { entry } of plan.takes) {
      const o = entry.offer;
      if (o.maker.toLowerCase() === taker.toLowerCase()) {
        throw new Error(`offer ${entry.commitment} is your own (SelfDeal) — cancel it instead of filling it`);
      }
      if (now < o.start || now > o.expiry) {
        throw new Error(`offer ${entry.commitment} is outside its [start, expiry] window`);
      }
      const registered = await this.pub.readContract({
        address: this.profile.core,
        abi: this.adapter.coreAbi,
        functionName: "isRatifier",
        args: [o.maker, o.ratifier],
      } as never);
      if (registered !== true) throw new Error(`maker of ${entry.commitment} has not registered its ratifier on core`);
      const ratified = await this.pub
        .readContract({
          address: o.ratifier,
          abi: this.adapter.ratifierAbi,
          functionName: "isRatified",
          args: this.adapter.ratifierArgs(o.maker, o.maxUnits, entry.commitment, entry.signature),
        } as never)
        .catch(() => undefined);
      if (ratified !== RATIFIED) throw new Error(`ratifier precheck did not return RATIFIED for ${entry.commitment}`);
    }

    if (plan.side === "ask") {
      // Buying resting asks: each maker transfers the credit it holds and originates the rest against its escrow.
      const strike = plan.takes[0].entry.offer.strike;
      const maturity = plan.takes[0].entry.offer.maturity;
      const perMaker = new Map<string, bigint>();
      for (const t of plan.takes) perMaker.set(t.entry.maker, (perMaker.get(t.entry.maker) ?? 0n) + t.units);
      for (const [maker, units] of perMaker) {
        const credit = await this.creditOf(marketId, maker as Hex);
        if (credit >= units) continue;
        const escrow = await this.collateralEscrowOf(marketId, maker as Hex).catch(() => 0n);
        const shortfall = askBackingShortfall({ units, credit, escrow, strike });
        if (shortfall > 0n) {
          throw new Error(
            escrow === 0n
              ? `maker ${maker} holds ${credit} credit and no escrowed collateral but the plan takes ${units} — ask fill would revert (OnlyTakerMayBorrow)`
              : `maker ${maker} holds ${credit} credit and ${escrow} escrowed collateral, short ${shortfall} collateral for the ${units - credit} units it would originate — ask fill would revert (InsufficientCollateralEscrow)`,
          );
        }
        if (now >= maturity) {
          throw new Error(`maker ${maker} would originate ${units - credit} units but the market matured — fill would revert (MaturityPassed)`);
        }
      }
    } else {
      // Selling into resting bids: the taker must hold every unit it sells (no origination slip),
      // and each bid maker's pre-funded liquidity must cover its proceeds.
      const credit = await this.creditOf(marketId, taker);
      if (credit < plan.totalUnits) {
        throw new Error(`you hold ${credit} credit but are selling ${plan.totalUnits} — a shortfall would originate new debt, refusing`);
      }
      const perMaker = new Map<string, bigint>();
      for (const t of plan.takes) {
        const cost = fillCost(t.entry.offer, t.units, t.entry.price);
        perMaker.set(t.entry.maker, (perMaker.get(t.entry.maker) ?? 0n) + cost);
      }
      for (const [maker, cost] of perMaker) {
        const liquidity = await this.liquidityOf(marketId, maker as Hex);
        if (liquidity < cost) throw new Error(`bid maker ${maker} liquidity ${liquidity} below required ${cost}`);
      }
    }
    return { marketId };
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
