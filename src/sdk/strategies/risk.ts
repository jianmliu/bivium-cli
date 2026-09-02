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
const evidenceKeySet = new Set<string>(evidenceKeys);
const collateralKinds = new Set(["stock-token", "ai-token", "meme", "other"]);

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

function validateSelectedPolicy(selected: unknown): asserts selected is SelectedRiskPolicy {
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
    throw new Error("invalid risk policy: selection must be an object");
  }
  const candidate = selected as { source?: unknown; rules?: unknown };
  if (candidate.source !== "agent-policy" && candidate.source !== "user-policy") {
    throw new Error("invalid risk policy: source must be agent-policy or user-policy");
  }
  if (typeof candidate.rules !== "object" || candidate.rules === null || Array.isArray(candidate.rules)) {
    throw new Error("invalid risk policy: rules must be an object");
  }
  const policy = candidate.rules as Record<string, unknown>;
  for (const key of ["rejectArbitraryMint", "rejectUnsellable", "confirmOnUnknown"] as const) {
    if (typeof policy[key] !== "boolean") {
      throw new Error(`invalid risk policy: ${key} must be a boolean`);
    }
  }
  const concentration = policy.maxTop10HolderPct;
  if (concentration !== undefined
      && (typeof concentration !== "number" || !Number.isFinite(concentration)
        || concentration < 0 || concentration > 100)) {
    throw new Error("invalid risk policy: maxTop10HolderPct must be finite and between 0 and 100");
  }
  const slippage = policy.maxExitSlippageBps;
  if (slippage !== undefined
      && (typeof slippage !== "number" || !Number.isFinite(slippage) || slippage < 0)) {
    throw new Error("invalid risk policy: maxExitSlippageBps must be finite and non-negative");
  }
}

function validateRiskInput(input: unknown): asserts input is MarketRiskInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("invalid risk input: expected an object");
  }
  const candidate = input as { market?: unknown; collateralKind?: unknown; evidence?: unknown };
  if (typeof candidate.market !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(candidate.market)) {
    throw new Error("invalid risk input: invalid risk market id; expected bytes32 hex");
  }
  if (typeof candidate.collateralKind !== "string" || !collateralKinds.has(candidate.collateralKind)) {
    throw new Error("invalid risk input: unknown collateralKind");
  }
  if (typeof candidate.evidence !== "object" || candidate.evidence === null || Array.isArray(candidate.evidence)) {
    throw new Error("invalid risk input: evidence must be an object");
  }
  for (const key of Object.keys(candidate.evidence)) {
    if (!evidenceKeySet.has(key)) throw new Error(`invalid risk input: unknown evidence key ${key}`);
  }
}

function normalizeEvidence(key: MarketRiskEvidenceKey, datum: unknown): {
  evidence: RiskEvidence<never> | MarketRiskEvidence[MarketRiskEvidenceKey];
  malformed: boolean;
} {
  if (typeof datum !== "object" || datum === null || Array.isArray(datum)) {
    return { evidence: unknown(`invalid ${key} evidence entry`), malformed: true };
  }
  const entry = datum as Record<string, unknown>;
  const states = new Set(["observed", "warning", "unknown", "not_applicable"]);
  const metadataValid = (entry.source === undefined || typeof entry.source === "string")
    && (entry.observedAt === undefined || typeof entry.observedAt === "string");
  const stateValid = typeof entry.state === "string" && states.has(entry.state);
  const smuggledValue = (entry.state === "unknown" || entry.state === "not_applicable")
    && Object.hasOwn(entry, "value");
  const knownValueInvalid = (entry.state === "observed" || entry.state === "warning")
    && !validValue(key, entry.value);
  if (!metadataValid || !stateValid || smuggledValue || knownValueInvalid) {
    return {
      evidence: unknown(`invalid ${key} evidence`, typeof entry.observedAt === "string" ? entry.observedAt : undefined),
      malformed: true,
    };
  }
  return { evidence: datum as MarketRiskEvidence[MarketRiskEvidenceKey], malformed: false };
}

/**
 * Agent-side screening only. This reports risky collateral; it does not mutate or call Core.
 * Core is permissionless and does not approve assets.
 */
export function assessRisk(
  input: MarketRiskInput,
  selectedPolicy: SelectedRiskPolicy = DEFAULT_POLICY_SELECTION,
): MarketRiskReport {
  validateRiskInput(input);
  validateSelectedPolicy(selectedPolicy);
  const policy = selectedPolicy.rules;
  let malformedEvidence = false;
  const evidence = Object.fromEntries(evidenceKeys.map((key) => {
    const datum = input.evidence[key];
    if (!datum) return [key, unknown("required evidence not provided")];
    const normalized = normalizeEvidence(key, datum);
    malformedEvidence ||= normalized.malformed;
    return [key, normalized.evidence];
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
    warn("HOLDER_CONCENTRATION", "critical", `Top-ten holders exceed ${policy.maxTop10HolderPct}% of supply.`);
    rejected = true;
  }
  if (policy.maxExitSlippageBps !== undefined && isKnown(evidence.exitSlippageBps)
      && typeof evidence.exitSlippageBps.value === "number" && evidence.exitSlippageBps.value > policy.maxExitSlippageBps) {
    warn("EXIT_SLIPPAGE", "critical", `Estimated exit slippage exceeds ${policy.maxExitSlippageBps} bps.`);
    rejected = true;
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
