import type {
  AgentRiskPolicy,
  MarketRiskEvidence,
  MarketRiskEvidenceKey,
  MarketRiskInput,
  MarketRiskReport,
  RiskEvidence,
  RiskWarning,
  SelectedRiskPolicy,
} from "./types.ts";

export const DEFAULT_AGENT_POLICY: Readonly<AgentRiskPolicy> = Object.freeze({
  rejectArbitraryMint: true,
  rejectUnsellable: true,
  confirmOnUnknown: true,
  maxTop10HolderPct: 80,
  maxExitSlippageBps: 2_000,
});

export const DEFAULT_POLICY_SELECTION: Readonly<SelectedRiskPolicy> = Object.freeze({
  source: "agent-policy",
  rules: DEFAULT_AGENT_POLICY,
});

export function observed<T>(value: T, source = "unspecified", observedAt?: string): RiskEvidence<T> {
  return { state: "observed", value, source, observedAt };
}

export function unknown<T>(source = "not provided", observedAt?: string): RiskEvidence<T> {
  return { state: "unknown", source, observedAt };
}

const evidenceKeys: MarketRiskEvidenceKey[] = [
  "mintable",
  "freezable",
  "blacklistable",
  "upgradeable",
  "sellability",
  "top10HolderPct",
  "exitSlippageBps",
  "referencePrice",
];

function isKnown<T>(evidence: RiskEvidence<T>): evidence is RiskEvidence<T> & { value: T } {
  return (evidence.state === "observed" || evidence.state === "warning") && evidence.value !== undefined;
}

const booleanKeys = new Set<MarketRiskEvidenceKey>([
  "mintable", "freezable", "blacklistable", "upgradeable", "sellability",
]);

function validValue(key: MarketRiskEvidenceKey, value: unknown): boolean {
  if (booleanKeys.has(key)) return typeof value === "boolean";
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (key === "top10HolderPct") return value >= 0 && value <= 100;
  if (key === "exitSlippageBps") return value >= 0;
  return value > 0;
}

function validatePolicy(policy: AgentRiskPolicy): void {
  const concentration = policy.maxTop10HolderPct;
  if (concentration !== undefined
      && (!Number.isFinite(concentration) || concentration < 0 || concentration > 100)) {
    throw new Error("invalid risk policy: maxTop10HolderPct must be finite and between 0 and 100");
  }
  const slippage = policy.maxExitSlippageBps;
  if (slippage !== undefined && (!Number.isFinite(slippage) || slippage < 0)) {
    throw new Error("invalid risk policy: maxExitSlippageBps must be finite and non-negative");
  }
}

/**
 * Agent-side screening only. This reports risky collateral; it does not mutate or call Core.
 * Core is permissionless and does not approve assets.
 */
export function assessRisk(
  input: MarketRiskInput,
  selectedPolicy: SelectedRiskPolicy = DEFAULT_POLICY_SELECTION,
): MarketRiskReport {
  const policy = selectedPolicy.rules;
  validatePolicy(policy);
  let malformedEvidence = false;
  const evidence = Object.fromEntries(evidenceKeys.map((key) => {
    const datum = input.evidence[key];
    if (!datum) return [key, unknown("required evidence not provided")];
    if ((datum.state === "observed" || datum.state === "warning") && !validValue(key, datum.value)) {
      malformedEvidence = true;
      return [key, unknown(`invalid ${key} evidence type`, datum.observedAt)];
    }
    return [key, datum];
  })) as MarketRiskEvidence;
  const unknowns: string[] = [];
  const facts: MarketRiskReport["facts"] = [];

  for (const key of evidenceKeys) {
    const datum = evidence[key];
    if (datum.state === "unknown" || (datum.state !== "not_applicable" && datum.value === undefined)) {
      unknowns.push(key);
    } else if (datum.state !== "not_applicable") {
      facts.push({ key, value: datum.value, source: datum.source, observedAt: datum.observedAt });
    }
  }

  const warnings: RiskWarning[] = [];
  let rejected = false;
  const warn = (code: string, severity: RiskWarning["severity"], message: string): void => {
    warnings.push({ code, severity, message });
  };

  if (isKnown(evidence.mintable) && evidence.mintable.value === true) {
    const critical = policy.rejectArbitraryMint;
    warn("ARBITRARY_MINT", critical ? "critical" : "warning", "Collateral supply can be minted arbitrarily.");
    rejected ||= critical;
  }
  if (isKnown(evidence.freezable) && evidence.freezable.value === true) {
    warn("FREEZABLE", "warning", "Collateral can be frozen by an administrator.");
  }
  if (isKnown(evidence.blacklistable) && evidence.blacklistable.value === true) {
    warn("BLACKLISTABLE", "warning", "Collateral transfers can be blocked by an administrator.");
  }
  if (isKnown(evidence.upgradeable) && evidence.upgradeable.value === true) {
    warn("UPGRADEABLE", "warning", "Collateral behavior can change through an upgrade.");
  }
  if (isKnown(evidence.sellability) && evidence.sellability.value === false) {
    const critical = policy.rejectUnsellable;
    warn("UNSELLABLE", critical ? "critical" : "warning", "No viable exit venue was observed for the collateral.");
    rejected ||= critical;
  }
  if (policy.maxTop10HolderPct !== undefined && isKnown(evidence.top10HolderPct)
      && typeof evidence.top10HolderPct.value === "number" && evidence.top10HolderPct.value > policy.maxTop10HolderPct) {
    warn("HOLDER_CONCENTRATION", "warning", `Top-ten holders exceed ${policy.maxTop10HolderPct}% of supply.`);
  }
  if (policy.maxExitSlippageBps !== undefined && isKnown(evidence.exitSlippageBps)
      && typeof evidence.exitSlippageBps.value === "number" && evidence.exitSlippageBps.value > policy.maxExitSlippageBps) {
    warn("EXIT_SLIPPAGE", "warning", `Estimated exit slippage exceeds ${policy.maxExitSlippageBps} bps.`);
  }
  if (input.collateralKind === "meme") {
    warn(
      "MEME_DELIVERY_RISK",
      "warning",
      "After a Meme collapse, the borrower may rationally not repay; the lender may receive severely impaired or worthless Meme. No-liquidation settlement can operate correctly while all economically recoverable principal is lost. Core does not approve assets; it is permissionless.",
    );
  }

  const decision = rejected
    ? "reject"
    : (policy.confirmOnUnknown || malformedEvidence) && unknowns.length > 0
      ? "require_user_confirmation"
      : "accept";

  return { market: input.market, facts, warnings, unknowns, decision, decisionSource: selectedPolicy.source };
}
