import { collateralForDebt } from "./math.ts";
import { entryFromSignedOffer, remainingFace, fillCost, planSweepByFace, sortSide, validateGroups, type BookEntry } from "./orderbook.ts";
import type { Address, Hex, MarketParams } from "./types.ts";

export type InventoryCase = "none_filled" | "bids_filled" | "asks_filled" | "both_filled";
export interface InventoryPolicy {
  maxCredit: bigint; maxNewDebt: bigint; minCash: bigint; maxCommittedLoan: bigint;
  maxLoss: bigint; allowOrigination: boolean; requireDailyLossAccounting?: boolean;
}
export interface MarketMakingInput {
  account: Address; marketId: Hex; params: MarketParams; now: bigint;
  credit: bigint; debt: bigint; liquidity: bigint; collateralEscrow: bigint; cash: bigint;
  existingOrders: BookEntry[]; candidateOrders: BookEntry[];
  coverage: "complete" | "partial" | "unknown"; policy: InventoryPolicy;
}
export function creditAfter(credit: bigint, bought: bigint, sold: bigint): bigint { return credit + bought - sold; }
/** Known-order stress cases, per market/token. No prices, signing, reservations or automatic quoting. */
export function previewMarketMaking(input: MarketMakingInput) {
  const p = input.policy;
  for (const n of [input.credit, input.debt, input.liquidity, input.collateralEscrow, input.cash, p.maxCredit, p.maxNewDebt, p.minCash, p.maxCommittedLoan, p.maxLoss]) if (n < 0n) throw new Error("Inventory and limits must be nonnegative");
  const all = [...input.existingOrders, ...input.candidateOrders].map((entry) => {
    const canonical = entryFromSignedOffer(entry.offer, entry.commitment, entry.signature);
    const consumed = entry.consumed ?? 0n;
    if (consumed < 0n) throw new Error("Consumed must be nonnegative");
    return { ...canonical, consumed, size: remainingFace(entry.offer, consumed, canonical.price) };
  });
  for (const entry of all) {
    const o = entry.offer;
    if (o.maker.toLowerCase() !== input.account.toLowerCase()) throw new Error("Order maker differs from inventory account");
    for (const key of ["loanToken", "collateralToken", "maturity", "strike", "gate", "allowPartialRepay"] as const) if (String(o[key]).toLowerCase() !== String(input.params[key]).toLowerCase()) throw new Error("Order belongs to another market");
  }
  validateGroups(all);
  const live = all.filter((entry) => entry.offer.start <= input.now && input.now <= entry.offer.expiry);
  const evaluate = (kind: string, orders: BookEntry[]) => {
    // Budget the group once across both sides. Backing shortfalls are reported, never hidden by shrinking quotes.
    const fills = planSweepByFace(orders, orders.reduce((sum, e) => sum + e.size, 0n)).takes;
    let credit = input.credit, liquidity = input.liquidity, cash = input.cash, escrow = input.collateralEscrow;
    let newDebt = 0n, lockedCollateral = 0n, bidCost = 0n, askProceeds = 0n;
    const violations: string[] = [];
    for (const { entry, units } of fills) {
      const cost = fillCost(entry.offer, units, entry.price);
      if (entry.offer.buy) { credit += units; liquidity -= cost; bidCost += cost; }
      else {
        const issued = units > credit ? units - credit : 0n;
        const moved = units - issued;
        credit -= moved;
        const locked = issued > 0n ? collateralForDebt(issued, input.params.strike) : 0n;
        newDebt += issued; lockedCollateral += locked; escrow -= locked; cash += cost; askProceeds += cost;
      }
    }
    if (credit > p.maxCredit) violations.push("MAX_CREDIT");
    if (newDebt > p.maxNewDebt) violations.push("MAX_NEW_DEBT");
    if (newDebt > 0n && !p.allowOrigination) violations.push("ORIGINATION_DISABLED");
    if (newDebt > 0n && input.now >= input.params.maturity) violations.push("MATURED_ORIGINATION");
    if (liquidity < 0n || escrow < 0n) violations.push("INSUFFICIENT_BACKING");
    if (cash < p.minCash) violations.push("MIN_CASH");
    if (bidCost > p.maxCommittedLoan) violations.push("MAX_COMMITTED_LOAN");
    // Budget new loan-token outlay assuming acquired collateral/credit becomes worthless.
    if (bidCost > p.maxLoss) violations.push("MAX_INCREMENTAL_LOAN_LOSS");
    if (p.requireDailyLossAccounting) violations.push("DAILY_PNL_UNKNOWN");
    return { kind, credit, debt: input.debt + newDebt, newDebt, lockedCollateral, liquidity, cash, collateralEscrow: escrow, bidCost, askProceeds, cashFlow: askProceeds - bidCost, incrementalLoanLossBound: bidCost, violations, maturityExposure: { repaymentFace: credit, repaymentAsset: input.params.loanToken, alternativeDeliveryAsset: input.params.collateralToken, deliveryValue: "unknown", existingInventoryCostBasis: "unknown" } };
  };
  const bids = sortSide(live, "bid"), asks = sortSide(live, "ask");
  const scenarios = [evaluate("none_filled", []), evaluate("bids_filled", bids), evaluate("asks_filled", asks), evaluate("both_filled", [...bids, ...asks])];
  const stressScenarios = [evaluate("bids_reverse", [...bids].reverse()), evaluate("asks_reverse", [...asks].reverse()), evaluate("asks_then_bids", [...asks, ...bids]), ...live.map((entry, i) => evaluate(`only_order_${i}`, [entry]))];
  const groups = new Set<string>();
  let sharedAlternatives = false;
  for (const entry of live) { const key = entry.offer.group.toLowerCase(); if (groups.has(key)) sharedAlternatives = true; groups.add(key); }
  const fragmentedFillRisk = live.some((entry) => entry.offer.buy ? entry.offer.maxAssets > 0n : p.allowOrigination);
  const rejected = [...scenarios, ...stressScenarios].some((scenario) => scenario.violations.length > 0);
  return { kind: "inventory_backed_market_making" as const, marketId: input.marketId, token: input.params.loanToken, scenarios, stressScenarios, sharedAlternatives, fragmentedFillRisk, decision: rejected ? "reject" as const : input.coverage === "complete" && !sharedAlternatives && !fragmentedFillRisk ? "within_known_limits" as const : "incomplete" as const, accountSafe: false, coverage: input.coverage, fundsReserved: false, pnlAccounting: "unavailable", bothFilledOrdering: "bids_then_asks; standalone ask case also tested", limitations: ["Assets-capped bids and origination asks require additional fragmented-fill rounding bounds; no within-known-limits verdict is issued for them.", "Known order scenarios only; not a guarantee about externally signed orders or partial-fill permutations.", "Cash flow is not realized profit; acquisition cost and delivery value of existing inventory are unknown.", "Limits are per market/token and do not establish daily realized loss limits."] };
}
