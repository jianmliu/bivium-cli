export type OpportunityKind = "estimated_spread" | "atomic_candidate";
export interface CandidateLeg {
  marketId: string; token: string; amount: bigint; units: bigint; feesIncluded: boolean;
  executionPriceKnown: boolean; depthKnown: boolean; ownOrder: boolean;
}
export function netAfterCosts(proceeds: bigint, entry: bigint, fees: bigint, gasBudget: bigint): bigint { return proceeds - entry - fees - gasBudget; }
/** Analyze one candidate supplied by a verified adapter, never discover/execute routes. */
export function previewArbitrage(input: { entry: CandidateLeg; exit: CandidateLeg; fees: bigint | null; gasBudget: bigint | null; minProfit: bigint; atomicVerification?: { programHash: string; simulated: boolean; onchainProfitFloor: bigint | null } }) {
  const { entry, exit, fees, gasBudget } = input;
  if (entry.marketId.toLowerCase() !== exit.marketId.toLowerCase()) throw new Error("Different market identities are different settlement claims");
  if (entry.token.toLowerCase() !== exit.token.toLowerCase()) throw new Error("Candidate costs must share one numeraire token");
  if (entry.units <= 0n || entry.units !== exit.units) throw new Error("Entry and exit must exchange the same positive DCN face units");
  if (entry.ownOrder || exit.ownOrder) throw new Error("Cannot arbitrage against own order");
  if (entry.feesIncluded || exit.feesIncluded) throw new Error("Adapter must normalize entry/proceeds to fee-exclusive amounts before analysis");
  for (const n of [entry.amount, exit.amount, fees, gasBudget, input.minProfit]) if (n !== null && n < 0n) throw new Error("Candidate amounts and budgets must be nonnegative");
  const unknowns = [fees === null ? "fees" : null, gasBudget === null ? "gas_budget_in_numeraire" : null, !entry.depthKnown || !exit.depthKnown ? "executable_depth" : null, !entry.executionPriceKnown || !exit.executionPriceKnown ? "execution_price" : null].filter((x): x is string => x !== null);
  const netProfitLowerBound = unknowns.length ? null : netAfterCosts(exit.amount, entry.amount, fees!, gasBudget!);
  const atomic = input.atomicVerification;
  const kind: OpportunityKind = atomic?.simulated && atomic.programHash ? "atomic_candidate" : "estimated_spread";
  return { kind, token: entry.token, entry: entry.amount, proceeds: exit.amount, fees, gasBudget, netProfitLowerBound, meetsThreshold: netProfitLowerBound !== null && netProfitLowerBound >= input.minProfit, unknowns, onchainProfitFloor: kind === "atomic_candidate" ? atomic!.onchainProfitFloor : null, guaranteedProfit: false, limitations: ["Computed profit is conditional on quoted legs, declared costs and gas budget; gas is not a guaranteed cost.", "Without a verified single transaction and onchain profit constraint, this remains an estimate with leg execution risk."] };
}
