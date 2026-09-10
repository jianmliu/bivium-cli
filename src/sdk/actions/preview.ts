import { randomUUID } from "node:crypto";
import { keccak256, stringToHex, getAddress, isAddress } from "viem";
import { assessRisk } from "../strategies/risk.ts";
import type { MarketRiskInput, SelectedRiskPolicy } from "../strategies/types.ts";
import type { Address, Hex, Offer } from "../types.ts";
import type { PoolKey } from "../strategies/program.ts";
import { evaluateAction } from "./prepare.ts";
import { ActionContext, type ReadContext } from "./context.ts";
import { PreviewStore } from "./store.ts";
import { ActionError, result, type Prepared, type UnsignedTx } from "./types.ts";

export type ActionName = "fund" | "repay" | "withdraw_liquidity" | "withdraw_collateral" | "claim" | "escrow_collateral" | "withdraw_collateral_escrow" | "borrow" | "buy_dcn" | "sell_dcn" | "strategy_program";
export interface ActionIntent {
  action: ActionName; marketId: Hex; account: Address; receiver: Address;
  amount?: string; policyId: string; collateralKind: MarketRiskInput["collateralKind"]; evidence: MarketRiskInput["evidence"];
  ttlSeconds?: number;
  fills?: Array<{ offer: Offer; commitment: Hex; ratifierData: Hex; units: string }>;
  maxCost?: string; minProceeds?: string; deadline?: string; router?: Address;
  strategyId?: string; poolKey?: PoolKey; minOut?: string; maxTopUp?: string;
}
export interface PreviewBinding {
  version: 1; chainId: number; core: Address; marketId: Hex; account: Address; receiver: Address;
  action: ActionName; intentHash: Hex; policyHash: Hex; evidenceHash: Hex; blockHash: Hex; expiresAt: string; sourceHash?: Hex;
}
export interface ActionEvaluation {
  keyState: unknown; before: unknown; after: unknown;
  transaction: UnsignedTx; prerequisites: UnsignedTx[];
  onchainConstraints: string[]; postExecutionChecks: string[]; simulation: "success" | "prerequisites_required";
}
export type ActionEvaluator = (intent: ActionIntent, ctx: ReadContext) => Promise<ActionEvaluation>;
type Record = { intent: ActionIntent; binding: PreviewBinding; keyStateHash: Hex; blockNumber: bigint; source?: unknown };
/** Sorted object keys; arrays preserve economic execution order; bigint hashes as decimal text. */
export function canonicalHash(value: unknown): Hex {
  function normalize(v: unknown): unknown {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number" && !Number.isFinite(v)) throw new ActionError("INVALID_ARGUMENT", "Nonfinite value in intent");
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)]));
    return v;
  }
  return keccak256(stringToHex(JSON.stringify(normalize(value))));
}
export class ActionService {
  private readonly store: PreviewStore<Record>;
  readonly evaluate: ActionEvaluator;
  constructor(readonly context: ActionContext, readonly policies: { [id: string]: SelectedRiskPolicy }, options: { evaluate?: ActionEvaluator } = {}) {
    this.store = new PreviewStore(1000, context.now);
    this.evaluate = options.evaluate ?? ((intent, ctx) => evaluateAction(context, intent, ctx));
  }
  policy(id: string): SelectedRiskPolicy {
    if (!Object.hasOwn(this.policies, id)) throw new ActionError("POLICY_REJECTED", "Unknown policyId; load a trusted policy at startup");
    return this.policies[id];
  }
  async risk(marketId: Hex, collateralKind: MarketRiskInput["collateralKind"], evidence: MarketRiskInput["evidence"], policyId: string, signal?: AbortSignal) {
    await this.context.market(marketId, signal);
    const policy = this.policy(policyId);
    const report = assessRisk({ market: marketId, collateralKind, evidence }, policy);
    return result({ report, policyId, policyHash: canonicalHash(policy), evidenceHash: canonicalHash({ marketId, collateralKind, evidence }) }, null);
  }
  async preview(input: ActionIntent, signal?: AbortSignal, resolved?: { ctx: ReadContext; source: unknown }) {
    const source = resolved ? structuredClone(resolved.source) : undefined;
    if (!isAddress(input.account) || !isAddress(input.receiver)) throw new ActionError("INVALID_ARGUMENT", "Account and receiver must have valid address checksums");
    if (["fund", "repay", "withdraw_liquidity", "withdraw_collateral", "claim", "escrow_collateral", "withdraw_collateral_escrow"].includes(input.action)) {
      const allowed = new Set(["action", "marketId", "account", "receiver", "policyId", "collateralKind", "evidence", "ttlSeconds", ...(input.action === "withdraw_collateral" ? [] : ["amount"])]);
      for (const key of Object.keys(input)) if (!allowed.has(key)) throw new ActionError("INVALID_ARGUMENT", `Unused field for ${input.action}: ${key}`);
    }
    const intent = structuredClone(input);
    intent.account = getAddress(intent.account);
    intent.receiver = getAddress(intent.receiver);
    const ttl = intent.ttlSeconds ?? 60;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) throw new ActionError("INVALID_ARGUMENT", "Preview TTL must be 1–60 seconds");
    const observed = resolved ? Date.parse(resolved.ctx.snapshot.observedAt) : this.context.now();
    const expires = Math.min(this.context.now(), observed) + ttl * 1000;
    if (!Number.isFinite(expires) || expires <= this.context.now()) throw new ActionError("STALE_PREVIEW", "Resolution snapshot expired; repeat strategy_preview");
    if (resolved && (resolved.ctx.account.toLowerCase() !== intent.account.toLowerCase() || resolved.ctx.chainId !== this.context.profile.chainId || resolved.ctx.core.toLowerCase() !== this.context.profile.core.toLowerCase())) throw new ActionError("DOMAIN_MISMATCH", "Resolved snapshot differs from action account/deployment");
    const assessment = await this.risk(intent.marketId, intent.collateralKind, intent.evidence, intent.policyId, signal);
    const risk = assessment.data.report;
    if (risk.decision !== "accept") return result({ previewId: null, risk, source, transaction: undefined, analysisOnly: true }, null, risk.warnings);
    this.context.requireExecutable();
    const ctx = resolved?.ctx ?? await this.context.pin(intent.account, signal);
    const evaluation = await this.evaluate(intent, ctx);
    const previewBlock = await this.context.limited(() => ctx.rpc.getBlock({ blockNumber: ctx.blockNumber }), signal);
    if (previewBlock.hash !== ctx.blockHash) throw new ActionError("STATE_CHANGED", "Snapshot reorganized during preview");
    const binding: PreviewBinding = { version: 1, chainId: this.context.profile.chainId, core: this.context.profile.core, marketId: intent.marketId, account: intent.account, receiver: intent.receiver, action: intent.action, intentHash: canonicalHash(intent), policyHash: assessment.data.policyHash, evidenceHash: assessment.data.evidenceHash, blockHash: ctx.blockHash, expiresAt: new Date(expires).toISOString(), ...(source === undefined ? {} : { sourceHash: canonicalHash(source) }) };
    const previewId = `${source === undefined ? "" : "strategy:"}${canonicalHash(binding)}:${randomUUID()}`;
    if (this.context.now() >= expires) throw new ActionError("STALE_PREVIEW", "Preview expired during evaluation");
    this.store.put(previewId, { intent, binding, source, keyStateHash: canonicalHash(evaluation.keyState), blockNumber: ctx.blockNumber }, expires);
    return result({ previewId, risk, binding, source, before: evaluation.before, after: evaluation.after, simulation: evaluation.simulation, prerequisitesRequired: evaluation.prerequisites.length > 0, onchainConstraints: evaluation.onchainConstraints, postExecutionChecks: evaluation.postExecutionChecks, transaction: undefined, analysisOnly: false }, ctx.snapshot, [{ code: "NO_RESERVATION", severity: "info", message: "Preview does not reserve funds; expiry is a service deadline unless calldata enforces it." }], [{ tool: "action_prepare", reason: "Recheck state and construct wallet payload" }]);
  }
  async prepare(previewId: string, signal?: AbortSignal) {
    try { return await this.prepareStored(previewId, signal); }
    catch (error) {
      if (error instanceof ActionError && previewId.startsWith("strategy:") && ["STATE_CHANGED", "STALE_PREVIEW", "EXPIRED", "INVALID_ARGUMENT"].includes(error.code)) {
        throw new ActionError(error.code, error.message.replace(`${error.code}: `, ""), error.retryable, error.field, "strategy_preview");
      }
      throw error;
    }
  }
  private async prepareStored(previewId: string, signal?: AbortSignal) {
    this.context.requireExecutable();
    const record = this.store.get(previewId);
    const { intent, binding, source } = record;
    if (binding.sourceHash && canonicalHash(source) !== binding.sourceHash) throw new ActionError("STATE_CHANGED", "Strategy source changed; repeat strategy_preview");
    const assessment = await this.risk(intent.marketId, intent.collateralKind, intent.evidence, intent.policyId, signal);
    if (assessment.data.policyHash !== binding.policyHash || assessment.data.evidenceHash !== binding.evidenceHash || canonicalHash(intent) !== binding.intentHash) throw new ActionError("STATE_CHANGED", "Intent or trusted risk policy changed; repreview");
    if (assessment.data.report.decision !== "accept") throw new ActionError(assessment.data.report.decision === "reject" ? "POLICY_REJECTED" : "POLICY_CONFIRMATION_REQUIRED", "Risk screening does not permit preparation");
    const ctx = await this.context.pin(intent.account, signal);
    const originalBlock = await this.context.limited(() => ctx.rpc.getBlock({ blockNumber: record.blockNumber }), signal);
    if (originalBlock.hash !== binding.blockHash) throw new ActionError("STATE_CHANGED", "Preview block was reorganized");
    const evaluation = await this.evaluate(intent, ctx);
    if (canonicalHash(evaluation.keyState) !== record.keyStateHash) throw new ActionError("STATE_CHANGED", "Execution state changed; create a new preview", false, undefined, "action_preview");
    const [originalAfter, currentAfter] = await Promise.all([
      this.context.limited(() => ctx.rpc.getBlock({ blockNumber: record.blockNumber }), signal),
      this.context.limited(() => ctx.rpc.getBlock({ blockNumber: ctx.blockNumber }), signal),
    ]);
    if (originalAfter.hash !== binding.blockHash || currentAfter.hash !== ctx.blockHash) throw new ActionError("STATE_CHANGED", "Chain reorganized during preparation");
    this.store.get(previewId); // Slow revalidation must not revive an expired intention.
    const prepared: Prepared = evaluation.prerequisites.length ? { kind: "prerequisites", previewId, transactions: evaluation.prerequisites, repreviewRequired: true } : { kind: "ready", previewId, transaction: evaluation.transaction, expiresAt: binding.expiresAt };
    return result({ ...prepared, ...(source === undefined ? {} : { source }) }, ctx.snapshot, [{ code: "WALLET_REQUIRED", severity: "info", message: "Unsigned payload only. External wallet signs and sends. Repeated preparation is not duplicate-transaction protection." }]);
  }
}
