import { ActionContext } from "../../sdk/actions/context.ts";
import { accountSnapshot, marketDetails, orderStatus, transactionStatus, bookSnapshot } from "../../sdk/actions/reads.ts";
import { ActionError, result } from "../../sdk/actions/types.ts";
import type { Address, Hex, Offer } from "../../sdk/types.ts";
import { addressSchema, integerStringSchema } from "../schema.ts";
import { READ_ONLY_ANNOTATIONS, type ToolDef, type ToolDefinition } from "../registry.ts";
export const hashSchema = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
export const bytesSchema = { type: "string", pattern: "^0x([0-9a-fA-F]{2})*$", maxLength: 16386 };
export const offerSchema = {
  type: "object", additionalProperties: false,
  properties: {
    chainId: { type: "integer", minimum: 1 }, bivium: addressSchema,
    loanToken: addressSchema, collateralToken: addressSchema, maturity: integerStringSchema, strike: integerStringSchema,
    allowPartialRepay: { type: "boolean" }, gate: addressSchema, maker: addressSchema, buy: { type: "boolean" }, tick: integerStringSchema,
    maxUnits: integerStringSchema, maxAssets: integerStringSchema, start: integerStringSchema, expiry: integerStringSchema, group: hashSchema, ratifier: addressSchema,
  },
  required: ["chainId", "bivium", "loanToken", "collateralToken", "maturity", "strike", "allowPartialRepay", "gate", "maker", "buy", "tick", "maxUnits", "maxAssets", "start", "expiry", "group", "ratifier"],
};
export const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
export function reviveOffer(context: ActionContext, wire: Record<string, unknown>): Offer {
  if (wire.chainId !== context.profile.chainId || String(wire.bivium).toLowerCase() !== context.profile.core.toLowerCase()) throw new ActionError("DOMAIN_MISMATCH", "Offer belongs to another chain/Core");
  const { chainId, bivium, ...fields } = wire;
  for (const field of ["maturity", "strike", "tick", "maxUnits", "maxAssets", "start", "expiry"]) fields[field] = BigInt(String(fields[field]));
  const offer = fields as unknown as Offer;
  if (offer.strike <= 0n || (offer.maxAssets === 0n) === (offer.maxUnits === 0n) || offer.start > offer.expiry) throw new ActionError("INVALID_ARGUMENT", "Invalid offer cap, strike or window");
  return offer;
}
export const READ_TOOL_SPECS: ToolDef[] = [
  { name: "server_info", description: "Fixed deployment, supported tools and execution boundaries. No chain access.", inputSchema: objectSchema({}) },
  { name: "market_details", description: "Canonical market identity and block-pinned state, token decimals, route and fees.", inputSchema: objectSchema({ marketId: hashSchema }) },
  { name: "book_snapshot", description: "Advertised depth versus shared-group and backing-bounded capacity; exact fills still require simulation.", inputSchema: objectSchema({ marketId: hashSchema, side: { enum: ["bid", "ask"], type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 200 } }, ["marketId"]) },
  { name: "account_snapshot", description: "Block-pinned balances, credit, debt and separately withdrawable collateral; outstanding signatures may be incomplete.", inputSchema: objectSchema({ account: addressSchema, marketIds: { type: "array", items: hashSchema, minItems: 1, maxItems: 20, uniqueItems: true } }) },
  { name: "order_status", description: "Recompute offer identity and separate cap, authorization, expiry and unknown cancellation history.", inputSchema: objectSchema({ offer: offerSchema, ratifierData: bytesSchema, commitment: hashSchema }, ["offer", "ratifierData"]) },
  { name: "transaction_status", description: "One lookup: unknown, pending, successful or reverted receipt; no waiting for mining.", inputSchema: objectSchema({ txHash: hashSchema }) },
].map((tool) => ({ ...tool, annotations: READ_ONLY_ANNOTATIONS }));
export function createReadTools(context: ActionContext, capabilities: { relayerWrites?: boolean; policyIds?: string[]; tools?: string[] } = {}): ToolDefinition[] {
  return READ_TOOL_SPECS.map((tool) => ({ ...tool, handler: async (args, { signal }) => {
    switch (tool.name) {
      case "server_info": return result({ version: "0.1.0", profile: context.profile.name, chainId: context.profile.chainId, core: context.profile.core, abiProfile: context.profile.abiProfile, supportedActions: ["fund", "repay", "withdraw_liquidity", "claim", "escrow_collateral", "withdraw_collateral_escrow", "withdraw_collateral", "buy_dcn", "sell_dcn", "borrow", "strategy_program"], tools: capabilities.tools ?? [], policyIds: capabilities.policyIds ?? [], ratifiers: { signature: context.profile.signatureRatifier, setter: context.profile.setterRatifier ?? null }, relayerWrites: capabilities.relayerWrites ?? false, chainSigning: false, chainBroadcasting: false, executableNetwork: context.profile.chainId === 46630 && context.profile.abiProfile === "core-v2", limits: { list: 100, marketIds: 20, rpcConcurrency: 8, requestMs: 30000, simulationMs: 60000, upstreamMs: 8000 }, limitations: ["Legacy strategy plans are descriptive.", "Snapshots do not reserve funds.", "Complete outstanding signature inventory is unknown."] }, null);
      case "market_details": return marketDetails(context, args.marketId as Hex, signal);
      case "book_snapshot": return bookSnapshot(context, args.marketId as Hex, { side: args.side as "bid" | "ask" | undefined, limit: args.limit as number | undefined, cursor: args.cursor as string | undefined }, signal);
      case "account_snapshot": return accountSnapshot(context, args.account as Address, args.marketIds as Hex[], signal);
      case "order_status": return orderStatus(context, reviveOffer(context, args.offer as Record<string, unknown>), args.ratifierData as Hex, args.commitment as Hex | undefined, signal);
      case "transaction_status": return transactionStatus(context, args.txHash as Hex, signal);
    }
  } }));
}
