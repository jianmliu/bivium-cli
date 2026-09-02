import type {
  AgentRiskPolicy,
  MarketRiskEvidenceKey,
  MarketRiskInput,
  MarketRiskReport,
  RiskEvidence,
  RiskWarning,
} from "./types.ts";

export const DEFAULT_AGENT_POLICY: Readonly<AgentRiskPolicy> = Object.freeze({
  rejectArbitraryMint: true,
  rejectUnsellable: true,
  confirmOnUnknown: true,
  maxTop10HolderPct: 80,
  maxExitSlippageBps: 2_000,
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

/**
 * Agent-side screening only. This reports risky collateral; it does not mutate or call Core.
 * Core is permissionless and does not approve assets.
 */
export function assessRisk(
  input: MarketRiskInput,
  policyOverrides: Partial<AgentRiskPolicy> = {},
  decisionSource: MarketRiskReport["decisionSource"] = "agent-policy",
): MarketRiskReport {
  const policy: AgentRiskPolicy = { ...DEFAULT_AGENT_POLICY, ...policyOverrides };
  const evidence = Object.fromEntries(evidenceKeys.map((key) => [
    key,
    input.evidence[key] ?? unknown("required evidence not provided"),
  ])) as Record<MarketRiskEvidenceKey, RiskEvidence<boolean | number | string>>;
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
      "Meme collateral has heightened delivery and exit risk. Core does not approve assets; it is permissionless.",
    );
  }

  const decision = rejected
    ? "reject"
    : policy.confirmOnUnknown && unknowns.length > 0
      ? "require_user_confirmation"
      : "accept";

  return { market: input.market, facts, warnings, unknowns, decision, decisionSource };
}
