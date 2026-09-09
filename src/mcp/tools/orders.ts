import { OrderService, type OrderIntent } from "../../sdk/actions/orders.ts";
import { addressSchema, integerStringSchema } from "../schema.ts";
import { SIMULATION_TIMEOUT_MS, type ToolDef, type ToolDefinition } from "../registry.ts";
import { bytesSchema, hashSchema, objectSchema, offerSchema, reviveOffer } from "./reads.ts";
import { riskProperties } from "./actions.ts";
const prepareSchema = objectSchema({ marketId: hashSchema, account: addressSchema, side: { type: "string", enum: ["bid", "ask"] }, maxUnits: integerStringSchema, maxAssets: integerStringSchema, tick: integerStringSchema, aprBps: integerStringSchema, expiry: integerStringSchema, ...riskProperties, ratifierKind: { type: "string", enum: ["signature", "setter"] }, backing: { type: "string", enum: ["secondary", "origination"] }, group: { oneOf: [objectSchema({ mode: { const: "independent" } }), objectSchema({ mode: { const: "shared" }, group: hashSchema, budgetUnit: { enum: ["face", "loan_assets"] } })] } }, ["marketId", "account", "side", "expiry", "policyId", "collateralKind", "evidence", "group"]);
export const ORDER_TOOL_SPECS: ToolDef[] = [
  { name: "order_prepare", description: "Prepare a risk-screened maker order and EIP712 or setter-root wallet steps; stores public intent without signing or funding.", inputSchema: prepareSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
  { name: "order_publish", description: "Opt-in relayer write of a previously prepared, externally authorized order; preserves unknown-submission state.", inputSchema: objectSchema({ prepareId: { type: "string", maxLength: 100 }, signature: bytesSchema }, ["prepareId"]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  { name: "order_cancel_prepare", description: "Prepare unsigned authoritative cancellation: known caps, permanent group consumption, or setter-root revocation with explicit scope.", inputSchema: objectSchema({ account: addressSchema, offers: { type: "array", items: offerSchema, minItems: 1, maxItems: 100 }, mode: { enum: ["selected_offers", "group_permanent", "root"] }, root: hashSchema, proofs: { type: "array", minItems: 1, maxItems: 100, items: { type: "array", items: hashSchema, maxItems: 64 } } }, ["account", "offers", "mode"]), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  { name: "order_delist", description: "Opt-in advisory relayer removal with external maker cancel signature; does not revoke signatures or cancel on chain.", inputSchema: objectSchema({ offer: offerSchema, commitment: hashSchema, cancelSignature: bytesSchema }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
];
export function createOrderTools(service: OrderService): ToolDefinition[] {
  return ORDER_TOOL_SPECS.map((tool) => ({ ...tool, concurrency: "managed", timeoutMs: SIMULATION_TIMEOUT_MS, handler: async (args, { signal }) => {
    switch (tool.name) {
      case "order_prepare": return service.prepare(args as unknown as OrderIntent, signal);
      case "order_publish": {
        const response = await service.publish(args as Parameters<OrderService["publish"]>[0], signal);
        return { ...response, data: { ...response.data, acceptedByRelayer: response.data.state === "published", onchainFillable: "unknown", filled: "unknown" } };
      }
      case "order_cancel_prepare": return service.cancelPrepare({ ...args, offers: (args.offers as Record<string, unknown>[]).map((wire) => reviveOffer(service.context, wire)) } as Parameters<OrderService["cancelPrepare"]>[0], signal);
      case "order_delist": return service.delist({ ...args, offer: reviveOffer(service.context, args.offer as Record<string, unknown>) } as Parameters<OrderService["delist"]>[0], signal);
    }
  } }));
}
