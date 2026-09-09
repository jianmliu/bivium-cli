import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterFor } from "../src/sdk/lineage.ts";
import { ZERO_ADDRESS, type DeploymentProfile, type MarketParams } from "../src/sdk/types.ts";
import { ActionContext, type ActionRpc } from "../src/sdk/actions/context.ts";
import { accountSnapshot, marketDetails, transactionStatus } from "../src/sdk/actions/reads.ts";
import { createStrategyMcp } from "../src/mcp/server.ts";
import { discoverMarketsOnChain } from "../src/sdk/discovery.ts";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const hash = `0x${"11".repeat(32)}` as const;
const profile: DeploymentProfile = { name: "fixture", abiProfile: "core-v2", chainId: 46630, core: address(1), signatureRatifier: address(2), rpcUrl: "http://localhost:1" };
const params: MarketParams = { loanToken: address(3), collateralToken: address(4), maturity: 2000n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true };
const adapter = adapterFor(profile.abiProfile);
const market = { id: adapter.computeMarketId(profile, params), params, firstSeenBlock: 1n };
function fixture(fail?: string) {
  const calls: Record<string, unknown>[] = [];
  const rpc: ActionRpc = {
    getChainId: async () => profile.chainId,
    getBlock: async () => ({ number: 10n, hash, timestamp: 1000n }),
    readContract: async (r) => {
      calls.push(r);
      if (r.functionName === fail) throw new Error("RPC unavailable");
      if (r.functionName === "computeId") return adapter.computeMarketId(profile, r.args![0] as MarketParams);
      if (r.functionName === "decimals") return 6;
      if (r.functionName === "position") return { debt: 5n, collateral: 9n, collateralWithdrawable: 2n };
      if (r.functionName === "marketState") return { touched: true, activeCredit: 5n, repaidCredit: 2n, activeCollateral: 9n, claimedCredit: 0n };
      return 10n;
    },
    getTransactionReceipt: async () => { const e = new Error("not found"); e.name = "TransactionReceiptNotFoundError"; throw e; },
    getTransaction: async () => { const e = new Error("not found"); e.name = "TransactionNotFoundError"; throw e; },
  };
  return { calls, context: new ActionContext({ profile, rpc, markets: async () => [market] }) };
}
test("new reads pin every contract read and preserve full v2 identity", async () => {
  const { context, calls } = fixture();
  const result = await marketDetails(context, market.id);
  assert.equal(result.data.identity.chainId, 46630);
  assert.equal(result.data.identity.allowPartialRepay, true);
  assert.equal(result.snapshot!.blockNumber, "10");
  assert.ok(calls.length > 2 && calls.every((c) => c.blockNumber === 10n));
  assert.notEqual(adapter.computeMarketId(profile, { ...params, gate: address(5) }), market.id);
  assert.notEqual(adapter.computeMarketId(profile, { ...params, allowPartialRepay: false }), market.id);
});
test("foreign chain and market identity fail closed", async () => {
  const { context } = fixture();
  context.rpc.getChainId = async () => 1;
  await assert.rejects(marketDetails(context, market.id), /DOMAIN_MISMATCH/);
  const other = fixture().context;
  await assert.rejects(marketDetails(other, hash), /MARKET_NOT_FOUND/);
});
test("account partial results distinguish missing escrow from zero and separate collateral balances", async () => {
  const { context } = fixture("collateralEscrowOf");
  const result = await accountSnapshot(context, address(6), [market.id]);
  assert.equal(result.snapshot!.coverage, "partial");
  assert.equal(result.data.markets[0].collateralEscrow, null);
  assert.equal(result.data.markets[0].position!.collateralWithdrawable!.raw, "2");
  assert.equal(result.data.orderCoverage, "unknown");
});
test("upstream failure is not an empty account and unknown receipt is not reverted", async () => {
  const { context } = fixture("marketState");
  await assert.rejects(marketDetails(context, market.id), /UPSTREAM_UNAVAILABLE/);
  const result = await transactionStatus(fixture().context, hash);
  assert.equal(result.data.status, "unknown");
  assert.equal(result.data.indexerStatus, "unknown");
});
test("MCP reads are available through registry and list cursor is bound to domain/filter", async () => {
  const { context } = fixture();
  const rows = [market, { ...market, params: { ...params, maturity: 3000n }, id: adapter.computeMarketId(profile, { ...params, maturity: 3000n }) }].map((market) => ({ market, loanDecimals: 6, collateralDecimals: 6 }));
  const mcp = createStrategyMcp({ profile, actionContext: context, overrides: { rows } });
  const details = await mcp.callTool("market_details", { marketId: market.id }) as any;
  assert.equal(details.data.identity.bivium, profile.core);
  const page = await mcp.callTool("market_list", { limit: 1 }) as any;
  assert.equal(page.markets.length, 1);
  assert.equal(page.markets[0].allowPartialRepay, true);
  assert.ok(page.nextCursor);
  const next = await mcp.callTool("market_list", { limit: 1, cursor: page.nextCursor }) as any;
  assert.equal(next.markets[0].maturity, 3000n);
  await assert.rejects(mcp.callTool("market_list", { limit: 1, cursor: page.nextCursor, filters: { maturity: "2000" } }), /cursor/);
});
test("bounded chain discovery rejects an oversized scan before querying logs", async () => {
  const client = { profile, verifyProfile: async () => {}, pub: { getBlockNumber: async () => 100_000n, getLogs: async () => { throw new Error("must not query logs"); } } };
  await assert.rejects(discoverMarketsOnChain(client as never, { fromBlock: 0n, maxScanBlocks: 18_000n }), /request budget/);
});
test("unknown IDs retain MARKET_NOT_FOUND and mixed successful balances survive partial reads", async () => {
  await assert.rejects(accountSnapshot(fixture().context, address(6), [hash]), /MARKET_NOT_FOUND/);
  const { context } = fixture();
  const read = context.rpc.readContract;
  context.rpc.readContract = async (r) => {
    if (["position", "creditOf", "balanceOf"].includes(r.functionName)) throw new Error("unavailable");
    return read(r);
  };
  const partial = await accountSnapshot(context, address(6), [market.id]);
  assert.equal(partial.data.markets[0].liquidity!.raw, "10");
});
test("one failed market retains other market state and amounts have exact token metadata", async () => {
  const { context } = fixture();
  const params2 = { ...params, maturity: 3000n };
  const second = { ...market, id: adapter.computeMarketId(profile, params2), params: params2 };
  context.options.markets = async () => [market, second];
  const read = context.rpc.readContract;
  context.rpc.readContract = async (request) => {
    if (request.args?.[0] === second.id) throw new Error("one market RPC failure");
    return read(request);
  };
  const snapshot = await accountSnapshot(context, address(6), [market.id, second.id]);
  assert.equal(snapshot.snapshot!.coverage, "partial");
  assert.deepEqual(snapshot.data.markets[0].credit, { raw: "10", decimals: 6, human: "0.00001", token: params.loanToken });
  assert.equal(snapshot.data.markets[1].position, null);
});
test("newer receipts carry independently observed block evidence instead of claiming pinned status", async () => {
  const { context } = fixture();
  const newerHash = `0x${"22".repeat(32)}` as const;
  context.rpc.getTransactionReceipt = async () => ({ status: "success", blockNumber: 11n, blockHash: newerHash });
  const receipt = await transactionStatus(context, hash);
  assert.equal(receipt.data.status, "mined_success");
  assert.deepEqual(receipt.data.receiptBlock, { number: "11", hash: newerHash });
  assert.equal(receipt.data.confirmations, 0n);
  assert.equal(receipt.snapshot!.coverage, "partial");
});
test("partial index resolution failure does not discard a resolved account market", async () => {
  const { context } = fixture();
  let loads = 0;
  context.options.markets = async () => {
    if (++loads > 1) throw new Error("index temporarily unavailable");
    return [market];
  };
  const response = await accountSnapshot(context, address(6), [market.id, hash]);
  assert.equal(response.data.markets[0].credit!.raw, "10");
  assert.equal(response.data.markets[1].credit, null);
  assert.equal(loads, 2);
});
