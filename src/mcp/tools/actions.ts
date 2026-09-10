import { readFileSync } from "node:fs";
import { ActionService, type ActionIntent } from "../../sdk/actions/preview.ts";
import { ActionError } from "../../sdk/actions/types.ts";
import type { ConfiguredRiskPolicy } from "../../sdk/actions/marketAnalysis.ts";
import { addressSchema, decimalAmountSchema, integerStringSchema, validator } from "../schema.ts";
import { READ_ONLY_ANNOTATIONS, SIMULATION_TIMEOUT_MS, type ToolDef, type ToolDefinition } from "../registry.ts";
import { bytesSchema, hashSchema, objectSchema, offerSchema, reviveOffer } from "./reads.ts";

const datum = { type: "object", additionalProperties: false, required: ["state"], properties: { state: { type: "string", enum: ["observed", "warning", "unknown", "not_applicable"] }, value: { anyOf: [{ type: "boolean" }, { type: "number" }] }, source: { type: "string", maxLength: 1000 }, observedAt: { type: "string", maxLength: 100 } } };
export const evidenceSchema = { type: "object", additionalProperties: false, properties: Object.fromEntries(["mintable", "freezable", "blacklistable", "upgradeable", "sellability", "top10HolderPct", "exitSlippageBps", "referencePrice"].map((key) => [key, datum])) };
export const riskProperties = { policyId: { type: "string", minLength: 1, maxLength: 100 }, collateralKind: { type: "string", enum: ["stock-token", "ai-token", "meme", "other"] }, evidence: evidenceSchema };
const base = { marketId: hashSchema, account: addressSchema, receiver: addressSchema, ...riskProperties, ttlSeconds: { type: "integer", minimum: 1, maximum: 60 } };
const requiredBase = ["action", "marketId", "account", "receiver", "policyId", "collateralKind", "evidence"];
const fills = { type: "array", minItems: 1, maxItems: 20, items: objectSchema({ offer: offerSchema, commitment: hashSchema, ratifierData: bytesSchema, units: { ...integerStringSchema, description: "Face in raw loan-token units" } }) };
const trade = { fills, deadline: integerStringSchema, router: addressSchema, maxCost: integerStringSchema, minProceeds: integerStringSchema };
const poolKey = objectSchema({ currency0: addressSchema, currency1: addressSchema, fee: { type: "integer", minimum: 0, maximum: 1000000 }, tickSpacing: { type: "integer", minimum: -8388608, maximum: 8388607 }, hooks: addressSchema });
export const actionSchema = { type: "object", oneOf: [
  ...["fund", "repay", "withdraw_liquidity", "claim", "escrow_collateral", "withdraw_collateral_escrow"].map((action) => objectSchema({ ...base, action: { const: action }, amount: decimalAmountSchema }, [...requiredBase, "amount"])),
  objectSchema({ ...base, action: { const: "withdraw_collateral" } }, requiredBase),
  objectSchema({ ...base, fills, deadline: integerStringSchema, router: addressSchema, maxCost: integerStringSchema, action: { const: "buy_dcn" } }, [...requiredBase, "fills", "deadline", "maxCost"]),
  objectSchema({ ...base, fills, deadline: integerStringSchema, minProceeds: integerStringSchema, action: { const: "sell_dcn" } }, [...requiredBase, "fills", "deadline", "minProceeds"]),
  objectSchema({ ...base, fills, deadline: integerStringSchema, router: addressSchema, minProceeds: integerStringSchema, maxTopUp: integerStringSchema, action: { const: "borrow" } }, [...requiredBase, "fills", "deadline", "minProceeds", "maxTopUp"]),
  objectSchema({ ...base, ...trade, action: { const: "strategy_program" }, strategyId: { type: "string", enum: ["lendAsset", "lendQuote", "leveredLong", "short", "protectivePut"] }, poolKey, minOut: integerStringSchema, maxTopUp: integerStringSchema }, [...requiredBase, "fills", "deadline", "strategyId"]),
] };
export const ACTION_TOOL_SPECS: ToolDef[] = [
  { name: "risk_assess", description: "Evaluate evidence under a trusted startup policy. An accept report is not a protocol permission or signature.", inputSchema: objectSchema({ marketId: hashSchema, ...riskProperties }) },
  { name: "action_preview", description: "Evaluate an exact intent and risk policy, read state and simulate; does not reserve funds or return signing authority.", inputSchema: actionSchema },
  { name: "action_prepare", description: "Revalidate a server-held preview; return an unsigned wallet payload or prerequisite approvals requiring a new preview.", inputSchema: objectSchema({ previewId: { type: "string", minLength: 1, maxLength: 200 } }) },
].map((tool) => ({ ...tool, annotations: READ_ONLY_ANNOTATIONS }));
export function createActionTools(service: ActionService): ToolDefinition[] {
  return ACTION_TOOL_SPECS.map((tool) => ({ ...tool, concurrency: "managed", timeoutMs: SIMULATION_TIMEOUT_MS, handler: async (args, { signal }) => {
    if (tool.name === "risk_assess") return service.risk(args.marketId as ActionIntent["marketId"], args.collateralKind as ActionIntent["collateralKind"], args.evidence as ActionIntent["evidence"], args.policyId as string, signal);
    if (tool.name === "action_prepare") return service.prepare(args.previewId as string, signal);
    const intent = { ...args } as unknown as ActionIntent;
    if (args.fills) intent.fills = (args.fills as Array<Record<string, unknown>>).map((fill) => ({ ...fill, offer: reviveOffer(service.context, fill.offer as Record<string, unknown>) })) as NonNullable<ActionIntent["fills"]>;
    return service.preview(intent, signal);
  } }));
}
const inventorySchema = objectSchema({ maxCredit: integerStringSchema, maxNewDebt: integerStringSchema, minCash: integerStringSchema, maxCommittedLoan: integerStringSchema, maxLoss: integerStringSchema, allowOrigination: { type: "boolean" }, requireDailyLossAccounting: { type: "boolean" } }, ["maxCredit", "maxNewDebt", "minCash", "maxCommittedLoan", "maxLoss", "allowOrigination"]);
const selectedPolicySchema = objectSchema({ inventory: { type: "object", maxProperties: 100, propertyNames: hashSchema, additionalProperties: inventorySchema }, source: { enum: ["user-policy", "agent-policy"] }, rules: objectSchema({ rejectArbitraryMint: { type: "boolean" }, rejectUnsellable: { type: "boolean" }, confirmOnUnknown: { type: "boolean" }, maxTop10HolderPct: { type: "number", minimum: 0, maximum: 100 }, maxExitSlippageBps: { type: "number", minimum: 0 } }, ["rejectArbitraryMint", "rejectUnsellable", "confirmOnUnknown"]) }, ["source", "rules"]);
/** Startup file only. MCP inputs cannot select arbitrary paths or replace policy rules. */
export function loadPolicies(path: string): { [id: string]: ConfiguredRiskPolicy } {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const validate = validator({ type: "object", maxProperties: 50, propertyNames: { type: "string", minLength: 1, maxLength: 100 }, additionalProperties: selectedPolicySchema });
  if (!validate(parsed)) throw new ActionError("INVALID_ARGUMENT", "Invalid startup policy file");
  return parsed as { [id: string]: ConfiguredRiskPolicy };
}
