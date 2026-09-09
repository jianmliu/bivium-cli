import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionContext } from "../src/sdk/actions/context.ts";
import { ActionService, canonicalHash } from "../src/sdk/actions/preview.ts";
import { PreviewStore } from "../src/sdk/actions/store.ts";
import { adapterFor } from "../src/sdk/lineage.ts";
import { ZERO_ADDRESS, type DeploymentProfile } from "../src/sdk/types.ts";

const profile: DeploymentProfile = { name: "fixture", chainId: 46630, abiProfile: "core-v2", core: `0x${"01".repeat(20)}`, signatureRatifier: `0x${"02".repeat(20)}`, rpcUrl: "http://localhost:1" };
const account = `0x${"03".repeat(20)}` as const, hash = `0x${"04".repeat(32)}` as const;
const params = { loanToken: account, collateralToken: profile.core, maturity: 2000n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true };
const marketId = adapterFor("core-v2").computeMarketId(profile, params);
const request = { action: "fund" as const, marketId, account, receiver: account, amount: "1", policyId: "test", collateralKind: "other" as const, evidence: {} };
const policy = { source: "user-policy" as const, rules: { rejectArbitraryMint: true, rejectUnsellable: true, confirmOnUnknown: false } };
function fixture() {
  let now = 1_000_000, state = 1;
  const context = new ActionContext({ profile, now: () => now, markets: async () => [{ id: marketId, params, firstSeenBlock: 1n }], rpc: { getChainId: async () => profile.chainId, getBlock: async () => ({ number: 1n, hash, timestamp: 1000n }), readContract: async (r) => adapterFor("core-v2").computeMarketId(profile, r.args![0] as typeof params) } });
  const service = new ActionService(context, { test: policy }, { evaluate: async () => ({ keyState: { state }, before: {}, after: {}, transaction: { chainId: profile.chainId, from: account, to: profile.core, data: "0x1234", value: "0" }, prerequisites: [], onchainConstraints: [], postExecutionChecks: [], simulation: "success" }) });
  return { service, context, advance: () => { now += 61_000; }, change: () => { state++; } };
}
test("preview binds canonical intent and trusted policy; prepare has no override arguments", async () => {
  const { service } = fixture();
  await assert.rejects(service.preview({ ...request, policyId: "forged" }), /POLICY_REJECTED/);
  const preview = await service.preview(request);
  assert.ok(preview.data.previewId);
  assert.equal((await service.prepare(preview.data.previewId!)).data.kind, "ready");
  assert.notEqual(canonicalHash(request), canonicalHash({ ...request, receiver: profile.core }));
  assert.equal(canonicalHash({ b: 1, a: 2 }), canonicalHash({ a: 2, b: 1 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
});
test("changed state, expired and restarted preview cannot prepare", async () => {
  const changed = fixture(); const p = await changed.service.preview(request); changed.change();
  await assert.rejects(changed.service.prepare(p.data.previewId!), /STATE_CHANGED/);
  const expired = fixture(); const p2 = await expired.service.preview(request); expired.advance();
  await assert.rejects(expired.service.prepare(p2.data.previewId!), /STALE_PREVIEW/);
  await assert.rejects(fixture().service.prepare(p2.data.previewId!), /STALE_PREVIEW/);
});
test("unknown evidence requiring confirmation gives no executable record", async () => {
  const f = fixture();
  f.service.policies.test = { ...policy, rules: { ...policy.rules, confirmOnUnknown: true } };
  const preview = await f.service.preview(request);
  assert.equal(preview.data.risk.decision, "require_user_confirmation");
  assert.equal(preview.data.previewId, null);
  assert.equal(preview.data.transaction, undefined);
});
test("preview store is bounded and never extends expiry on lookup", () => {
  let now = 0;
  const store = new PreviewStore<number>(2, () => now);
  store.put("a", 1, 100); store.put("b", 2, 100); store.put("c", 3, 100);
  assert.throws(() => store.get("a"), /STALE_PREVIEW/);
  now = 101;
  assert.throws(() => store.get("b"), /STALE_PREVIEW/);
});
test("reorg during evaluation fails before returning unsigned data", async () => {
  const f = fixture();
  const preview = await f.service.preview(request);
  const readBlock = f.context.rpc.getBlock;
  let reads = 0;
  f.context.rpc.getBlock = async (args) => {
    const b = await readBlock(args);
    return ++reads > 2 ? { ...b, hash: `0x${"ff".repeat(32)}` } : b;
  };
  await assert.rejects(f.service.prepare(preview.data.previewId!), /STATE_CHANGED/);
});
test("policy mutation, slow expiry and caller mutation do not alter saved intent", async () => {
  const f = fixture(); const p = await f.service.preview(request);
  f.service.policies.test.rules.confirmOnUnknown = true;
  await assert.rejects(f.service.prepare(p.data.previewId!), /STATE_CHANGED/);
  // Restore shared fixture policy before the next independent fixture.
  policy.rules.confirmOnUnknown = false;
  const slow = fixture(); const before = await slow.service.preview(request);
  const read = slow.context.rpc.getBlock;
  slow.context.rpc.getBlock = async (args) => { slow.advance(); return read(args); };
  await assert.rejects(slow.service.prepare(before.data.previewId!), /STALE_PREVIEW/);
  const store = new PreviewStore<{ amount: number }>(2, () => 0);
  const original = { amount: 1 }; store.put("x", original, 100); original.amount = 9;
  const copy = store.get("x"); copy.amount = 8; assert.equal(store.get("x").amount, 1);
  for (const patch of [{ amount: "2" }, { marketId: hash }, { ttlSeconds: 5 }, { chainId: 1 }, { fills: [{ commitment: "a" }, { commitment: "b" }] }]) assert.notEqual(canonicalHash(request), canonicalHash({ ...request, ...patch }));
});
test("raw checksum and unused SDK economic constraints are rejected", async () => {
  const f = fixture();
  await assert.rejects(f.service.preview({ ...request, receiver: "0x52908400098527886E0F7030069857D2E4169Ee7" }), /INVALID_ARGUMENT/);
  await assert.rejects(f.service.preview({ ...request, deadline: "0", maxCost: "0" }), /INVALID_ARGUMENT/);
});
