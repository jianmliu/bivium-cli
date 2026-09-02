import { lstatSync, readFileSync } from "node:fs";
import { getAddress } from "viem";
import {
  assessRisk,
  catalogJson,
  startTrace,
  stressDelivery,
  type Address,
  type DeploymentProfile,
  type Hex,
  type MarketRiskInput,
} from "../sdk/index.ts";

export interface StrategyCliContext {
  profile: DeploymentProfile;
  json: boolean;
  values: Record<string, string | boolean | undefined>;
}

const ALIASES = Object.freeze({
  earnOnHoldings: "lendAsset",
  buyAtTarget: "lendQuote",
  cappedRiskShort: "short",
});
const INITIAL_RELEASE = Object.freeze(["lendAsset", "lendQuote", "short"]);
const RISK_KEYS = new Set([
  "mintable", "freezable", "blacklistable", "upgradeable", "sellability",
  "top10HolderPct", "exitSlippageBps", "referencePrice",
]);
const EVIDENCE_STATES = new Set(["observed", "warning", "unknown", "not_applicable"]);
const COLLATERAL_KINDS = new Set(["stock-token", "ai-token", "meme", "other"]);
const BOOLEAN_EVIDENCE = new Set(["mintable", "freezable", "blacklistable", "upgradeable", "sellability"]);
/** Agent risk files are small evidence envelopes, not bulk-data inputs. */
export const MAX_RISK_FILE_BYTES = 256 * 1024;
const UINT256_MAX_DECIMAL = ((1n << 256n) - 1n).toString();

function required(values: StrategyCliContext["values"], flag: string): string {
  const value = values[flag];
  if (typeof value !== "string") throw new Error(`missing --${flag}`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${label} has unexpected field ${JSON.stringify(unexpected)}`);
}

function parseUint256Decimal(value: unknown, field: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal string`);
  }
  // Bound work before BigInt parsing. uint256 max has 78 decimal digits.
  if (value.length > UINT256_MAX_DECIMAL.length
      || (value.length === UINT256_MAX_DECIMAL.length && value > UINT256_MAX_DECIMAL)) {
    throw new Error(`${field} must fit uint256`);
  }
  return BigInt(value);
}

function parseRiskFile(path: string): {
  input: MarketRiskInput;
  principal?: bigint;
  collateralValueAtEntry?: bigint;
} {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error(`invalid risk file: ${(error as Error).message}`);
  }
  if (!metadata.isFile()) throw new Error("risk file must be a regular file");
  if (metadata.size > MAX_RISK_FILE_BYTES) {
    throw new Error(`risk file is too large (maximum ${MAX_RISK_FILE_BYTES} bytes)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid risk JSON: ${(error as Error).message}`);
  }
  const root = record(parsed, "risk input");
  exactKeys(root, new Set(["market", "collateralKind", "evidence", "principal", "collateralValueAtEntry"]), "risk input");
  if (typeof root.market !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(root.market)) {
    throw new Error("invalid risk input: market must be bytes32 hex");
  }
  if (typeof root.collateralKind !== "string" || !COLLATERAL_KINDS.has(root.collateralKind)) {
    throw new Error("invalid risk input: collateralKind is invalid");
  }
  const evidence = record(root.evidence, "risk evidence");
  exactKeys(evidence, RISK_KEYS, "risk evidence");
  for (const [key, raw] of Object.entries(evidence)) {
    const datum = record(raw, `risk evidence.${key}`);
    exactKeys(datum, new Set(["state", "value", "source", "observedAt"]), `risk evidence.${key}`);
    if (typeof datum.state !== "string" || !EVIDENCE_STATES.has(datum.state)) {
      throw new Error(`risk evidence.${key}.state is invalid`);
    }
    if (datum.state === "observed" || datum.state === "warning") {
      const valid = BOOLEAN_EVIDENCE.has(key)
        ? typeof datum.value === "boolean"
        : typeof datum.value === "number" && Number.isFinite(datum.value);
      if (!valid) throw new Error(`risk evidence.${key}.value has the wrong type`);
    } else if (datum.value !== undefined) {
      throw new Error(`risk evidence.${key}.value is not allowed for ${datum.state} evidence`);
    }
    if (datum.source !== undefined && typeof datum.source !== "string") throw new Error(`risk evidence.${key}.source must be a string`);
    if (datum.observedAt !== undefined && typeof datum.observedAt !== "string") throw new Error(`risk evidence.${key}.observedAt must be a string`);
  }
  return {
    input: { market: root.market as Hex, collateralKind: root.collateralKind as MarketRiskInput["collateralKind"], evidence: evidence as MarketRiskInput["evidence"] },
    principal: parseUint256Decimal(root.principal, "principal"),
    collateralValueAtEntry: parseUint256Decimal(root.collateralValueAtEntry, "collateralValueAtEntry"),
  };
}

export function runStrategyCommand(subcommand: string, ctx: StrategyCliContext): unknown {
  if (!ctx.json) throw new Error("--json is required for strategy commands");
  if (subcommand === "catalog") {
    return { catalog: catalogJson(), aliases: ALIASES, initialRelease: INITIAL_RELEASE };
  }
  if (subcommand === "assess") {
    const risk = parseRiskFile(required(ctx.values, "risk-file"));
    const result: Record<string, unknown> = { ...assessRisk(risk.input) };
    if (risk.principal !== undefined && risk.collateralValueAtEntry !== undefined) {
      result.stress = stressDelivery({ principal: risk.principal, collateralValueAtEntry: risk.collateralValueAtEntry });
    }
    return result;
  }
  if (subcommand === "trace") {
    const nonce = parseUint256Decimal(required(ctx.values, "nonce"), "--nonce");
    return startTrace({
      chainId: ctx.profile.chainId,
      core: ctx.profile.core,
      strategyId: required(ctx.values, "strategy-id"),
      quoteId: required(ctx.values, "quote-id") as Hex,
      nonce: nonce!,
      account: getAddress(required(ctx.values, "account")) as Address,
    });
  }
  throw new Error(`unknown strategy command ${JSON.stringify(subcommand)}`);
}
