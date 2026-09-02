// Strategy toolbox — types. A strategy is a NAMED COMPOSITION of existing core actions (fill a bid,
// take an ask, fund, repay) plus at most one swap; it never introduces a new primitive. Everything
// here is "maturity-only": every payoff is a function of ONE variable, S_T, the asset's price in the
// strategy's numeraire at maturity. Amounts are exact bigints in native token units; the only floats
// are advisory (exercise probability, rung ranking) and never touch an amount or an identity.
import type { Address, Hex, MarketParams, Offer } from "../types.ts";
import type { DiscoveredMarket } from "../discovery.ts";

/** Product line, derived from the market's token roles (see lines.ts). */
export type Line = "options" | "credit" | "exchange";
/** Which side of the market the strategy takes. Every borrower strategy mirrors a lender one. */
export type StrategySide = "borrow" | "lend";
/** Catalog grouping — the question the user is answering. */
export type Group = "bearish" | "bullish" | "hold" | "yield" | "volatility" | "relative";
/** The FORM the worst case takes — always stated, never a "liquidation". */
export type WorstCaseForm = "forfeit-collateral" | "deliver-collateral" | "called-away" | "assigned" | "premium";
/** One executable step. Every kind is an existing core / ERC-20 / AMM action. */
export type StepKind =
  | "grant-auth"
  | "approve"
  | "fill-bid" // taker sells face into a lender's BUY bid  → borrow
  | "fill-ask" // taker buys face from a resting ask         → lend (secondary)
  | "fund" // primary lend: deposit liquidity
  | "swap"
  | "repay"
  | "withdraw-collateral"
  | "claim";

/**
 * A price in the HUMAN orientation the strategy talks about: numeraire tokens per ONE WHOLE asset,
 * WAD-scaled. (Core strikes are loan-per-collateral; lines.ts converts.)
 */
export type PxWad = bigint;

export interface StrategyLeg {
  line: Line;
  side: StrategySide;
  kind: StepKind;
  note: string;
}

export interface InputField {
  name: string;
  type: "address" | "bigint" | "number" | "maturity";
  required: boolean;
  description: string;
}

export interface StrategyDef {
  id: string;
  /** True only for products exposed in the first Robinhood release. */
  initialRelease: boolean;
  /** User-facing labels for the distinct maturity outcomes. */
  outcomeLabels: readonly string[];
  /** User-facing name (zh) and one-liner. */
  name: string;
  oneLiner: string;
  group: Group;
  side: StrategySide;
  line: Line;
  legs: StrategyLeg[];
  /** Capabilities beyond a plain core call: a swap leg and/or the StrategyRouter for atomicity. */
  requires: ("swap" | "router")[];
  holdingRequired: "none" | "asset" | "quote" | "counter";
  worstCaseForm: WorstCaseForm;
  /** The OTM direction of the strike relative to spot: "above" (short-type) or "below" (long-type). */
  otmDirection: "above" | "below";
  /** The lender/borrower twin — "strategies are the mirror of markets". */
  mirrorOf?: string;
  /** False for combos that need the Router before they can be quoted as one unit. */
  quotable: boolean;
  inputs: InputField[];
}

/** The user's VIEW, before any market is chosen. Markets are resolved for them (never picked). */
export interface StrategySpec {
  strategyId: string;
  /** The asset the view is about (shorted / held). */
  asset: Address;
  /** The other leg of a relative strategy (pairShort). */
  counter?: Address;
  /** Size in the asset's native units (face for shorts / lends; holding for longs). */
  size: bigint;
  /** Chosen from EXISTING maturities. */
  maturity: bigint;
  /** Strike buffer vs spot in the OTM direction, percent, positive = OTM. */
  bufferPct: number;
}

/** A discovered market decorated with what the engine needs to reason about it. */
export interface PoolRow {
  market: DiscoveredMarket;
  loanSymbol?: string;
  collateralSymbol?: string;
  loanDecimals: number;
  collateralDecimals: number;
}

export interface StrategyResolution {
  strategy: StrategyDef;
  row: PoolRow;
  side: StrategySide;
  line: Line;
  /** Core strike (loan per collateral, 1e36-scaled) — the exact value amounts are computed from. */
  strike: bigint;
  /** The same strike in the human orientation (numeraire per whole asset), for display/plots. */
  strikeHuman: PxWad;
  realizedBufferPct: number;
  /** The nearest other rungs (up to two), shown when no rung matches the requested buffer. */
  alternatives: PoolRow[];
  asset: Address;
  numeraire: Address;
  assetDecimals: number;
  numeraireDecimals: number;
}

export interface PayoffPoint {
  S: PxWad;
  /** P&L in numeraire native units vs the position's own initial outlay/stake. */
  pnl: bigint;
}

export interface Payoff {
  points: PayoffPoint[];
  worstCase: { amount: bigint; at: string; form: WorstCaseForm };
  bestCase: { amount: bigint; at: string };
  /** S_T at which pnl == 0, or null if the strategy never crosses zero. */
  breakEven: PxWad | null;
}

export interface QuoteInputs {
  resolution: StrategyResolution;
  /** WAD price of the fill (the bid taken / ask eaten) — from the sweep, or a target rate. */
  priceWad: bigint;
  /** Spot in the human orientation. Advisory estimate basis; execution is bounded by minOut. */
  spot: PxWad;
  /** Annualised realised volatility (e.g. 7.11 for 711%); omit → exerciseProbability null. */
  sigmaAnnual?: number;
  now: bigint;
  /** Levered-long / protective-put only: face to borrow (numeraire native). Default = max at strike. */
  borrowFace?: bigint;
}

export interface StrategyQuote {
  strategyId: string;
  marketId: Hex;
  maturity: bigint;
  side: StrategySide;
  /** Face units of the primary leg. */
  units: bigint;
  /** What the user must put in up front (numeraire native for borrow-and-sell; asset for longs). */
  prepay: bigint;
  /** The fixed-rate cost/income implied by the fill price, in numeraire native. */
  premium: bigint;
  exerciseProbability: number | null;
  payoff: Payoff;
  asset: Address;
  numeraire: Address;
  /** Every prepay/premium/payoff figure is an estimate off `spot`; execution enforces minOut. */
  estimateBasis: "spot";
}

export interface PlanLimits {
  /** Hard cap on what the user can lose: exceeding it reverts on-chain (Router) or aborts (sequential). */
  maxLoss: bigint;
  minOut?: bigint;
  deadline: bigint;
}

export interface PlanStep {
  kind: StepKind;
  market?: MarketParams;
  token?: Address;
  spender?: Address;
  amount?: bigint;
  units?: bigint;
  offer?: Offer;
  sellToken?: Address;
  buyToken?: Address;
  minOut?: bigint;
  note: string;
}

export interface Plan {
  /**
   * intent     — single leg, no swap: a signable EIP-712 intent (agent-preferred, gasless).
   * router     — needs a swap: one atomic StrategyRouter call.
   * sequential — needs a swap but no Router deployed: approve → fill → swap as separate txs
   *              (NOT atomic; the plan says so).
   */
  mode: "intent" | "router" | "sequential";
  strategyId: string;
  steps: PlanStep[];
  limits: PlanLimits;
  worstCase: bigint;
  prepay: bigint;
  quoteId: Hex;
  validUntil: bigint;
}

/** Whether a risk datum was seen, unavailable, or does not apply to this collateral. */
export type EvidenceState = "observed" | "warning" | "unknown" | "not_applicable";
export type CollateralKind = "stock-token" | "ai-token" | "meme" | "other";
export type RiskDecision = "accept" | "reject" | "require_user_confirmation";

export interface RiskEvidence<T> {
  state: EvidenceState;
  value?: T;
  source?: string;
  observedAt?: string;
}

export interface RiskWarning {
  code: string;
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface AgentRiskPolicy {
  rejectArbitraryMint: boolean;
  rejectUnsellable: boolean;
  confirmOnUnknown: boolean;
  maxTop10HolderPct?: number;
  maxExitSlippageBps?: number;
}

export type MarketRiskEvidenceKey = "mintable" | "freezable" | "blacklistable" | "upgradeable"
  | "sellability" | "top10HolderPct" | "exitSlippageBps" | "referencePrice";

export interface MarketRiskInput {
  market: string;
  collateralKind: CollateralKind;
  evidence: Partial<Record<MarketRiskEvidenceKey, RiskEvidence<boolean | number | string>>>;
}

export interface MarketRiskReport {
  market: string;
  facts: Array<{ key: string; value: unknown; source?: string; observedAt?: string }>;
  warnings: RiskWarning[];
  unknowns: string[];
  decision: RiskDecision;
  decisionSource: "user-policy" | "agent-policy";
}
