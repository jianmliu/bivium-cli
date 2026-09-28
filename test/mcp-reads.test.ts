import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { adapterFor } from "../src/sdk/lineage.ts";
import { ZERO_ADDRESS, type DeploymentProfile, type MarketParams } from "../src/sdk/types.ts";
import { ActionContext, type ActionRpc } from "../src/sdk/actions/context.ts";
import { accountSnapshot, marketDetails, transactionStatus, bookSnapshot } from "../src/sdk/actions/reads.ts";
import { entryFromSignedOffer } from "../src/sdk/orderbook.ts";
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
  return { calls, context: new ActionContext({ profile: { ...profile }, rpc, markets: async () => [market] }) };
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
  const mcp = createStrategyMcp({ profile, actionContext: context, now: () => 1000n, overrides: { rows } });
  const details = await mcp.callTool("market_details", { marketId: market.id }) as any;
  assert.equal(details.data.identity.bivium, profile.core);
  const page = await mcp.callTool("market_list", { limit: 1 }) as any;
  assert.equal(page.markets.length, 1);
  assert.equal(page.markets[0].allowPartialRepay, true);
  assert.ok(page.nextCursor);
  const next = await mcp.callTool("market_list", { limit: 1, cursor: page.nextCursor }) as any;
  assert.equal(next.markets[0].maturity, 3000n);
  await assert.rejects(mcp.callTool("market_list", { limit: 1, cursor: page.nextCursor, filters: { maturity: "2000" } }), /cursor/);
  rows.unshift({ ...rows[0], market: { ...market, id: hash } });
  await assert.rejects(mcp.callTool("market_list", { limit: 1, cursor: page.nextCursor }), /cursor/);
});
test('product history filters before pagination and binds normalized history mode to eligible collection', async () => {
  const domain = { ...profile, core: '0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4' as const };
  const historical = { ...params, loanToken: '0x34a456c0365B78c5E04b97dee228207cf9CaB35D' as const };
  const rows = [historical, params, { ...params, maturity: 999n }, { ...params, maturity: 3000n }].map(p => ({ market: { ...market, params: p, id: adapter.computeMarketId(domain, p) }, loanDecimals: 6, collateralDecimals: 6 }));
  let now = 1000n;
  const mcp = createStrategyMcp({ profile: domain, now: () => now, overrides: { rows } });
  const page = await mcp.callTool('market_list', { limit: 1 }) as any;
  assert.equal(page.count, 2);
  assert.equal(page.markets[0].id, rows[1].market.id);
  assert.equal(page.markets[0].newBusiness, true);
  const next = await mcp.callTool('market_list', { limit: 1, includeHistory: false, cursor: page.nextCursor }) as any;
  assert.equal(next.markets[0].id, rows[3].market.id);
  await assert.rejects(mcp.callTool('market_list', { includeHistory: true, cursor: page.nextCursor }), /cursor/);
  const history = await mcp.callTool('market_list', { includeHistory: true }) as any;
  assert.equal(history.count, 4);
  assert.equal(history.markets[0].delisted, true);
  assert.equal(history.markets[2].matured, true);
  now = 2000n;
  await assert.rejects(mcp.callTool('market_list', { cursor: page.nextCursor }), /cursor/);
});
test('market details and account recovery retain delisted market identities', async () => {
  const { context } = fixture();
  context.profile.core = '0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4';
  const originalRead = context.rpc.readContract;
  context.rpc.readContract = async r => r.functionName === 'computeId' ? adapter.computeMarketId(context.profile, r.args![0] as MarketParams) : originalRead(r);
  const p = { ...params, loanToken: '0x34a456c0365B78c5E04b97dee228207cf9CaB35D' as const };
  const m = { ...market, params: p, id: adapter.computeMarketId(context.profile, p) };
  context.options.markets = async () => [m];
  const details = await marketDetails(context, m.id);
  assert.equal((details.data as any).delisted, true);
  assert.equal((details.data as any).newBusiness, false);
  assert.equal((await accountSnapshot(context, address(6), [m.id])).data.markets[0].credit!.raw, '10');
  context.profile.core = profile.core;
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
test("real RPC transport enforces upstream timeout even with a parent signal", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const parent = new AbortController();
  const context = new ActionContext({ profile: { ...profile, rpcUrl: `http://127.0.0.1:${port}` }, rpcTimeoutMs: 25 });
  const fallback = setTimeout(() => parent.abort(), 1000);
  const start = Date.now();
  try {
    await assert.rejects(context.pin(address(6), parent.signal), /UPSTREAM_UNAVAILABLE/);
    assert.ok(Date.now() - start < 500, "upstream deadline must not wait for parent abort");
    assert.equal(parent.signal.aborted, false);
  } finally { clearTimeout(fallback); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test("book snapshot budgets shared groups and never equates capacity with exact fill simulation", async () => {
  const { context } = fixture();
  const offer = { ...params, maker: address(6), buy: false, tick: 4096n, maxUnits: 250n, maxAssets: 0n, start: 0n, expiry: 1900n, group: hash, ratifier: profile.signatureRatifier };
  const entries = [offer, { ...offer, expiry: 1901n }].map((o) => entryFromSignedOffer(o, adapter.offerCommitment(profile, o), "0x"));
  context.options.book = async () => ({ entries, source: "fixture", coverage: "complete" });
  const oldRead = context.rpc.readContract;
  context.rpc.readContract = async (r) => r.functionName === "creditOf" ? 1000n : r.functionName === "consumed" ? 100n : oldRead(r);
  const response = await bookSnapshot(context, market.id, { side: "ask" });
  assert.equal(response.data.rawAdvertisedDepth[0].cumulative, 500n);
  assert.equal(response.data.conservativeCapacityDepth[0].cumulative, 150n);
  assert.equal(response.data.executableDepth, null);
  assert.equal(response.snapshot!.coverage, "partial");
  const conflicting = { ...offer, buy: true, maxUnits: 0n, maxAssets: 250n };
  entries.push(entryFromSignedOffer(conflicting, adapter.offerCommitment(profile, conflicting), "0x"));
  await assert.rejects(bookSnapshot(context, market.id, { side: "ask", limit: 1 }), /mixed cap/);
  await assert.rejects(bookSnapshot(context, market.id, { limit: 1 }), /mixed cap/);
});
test("cached books are reconstructed and filtered at the pinned timestamp", async () => {
  const { context } = fixture();
  const o = { ...params, maker: address(6), buy: false, tick: 4096n, maxUnits: 250n, maxAssets: 0n, start: 0n, expiry: 900n, group: hash, ratifier: profile.signatureRatifier };
  let entries = [entryFromSignedOffer(o, adapter.offerCommitment(profile, o), "0x")];
  context.options.book = async () => ({ entries, source: "cache" });
  assert.equal((await bookSnapshot(context, market.id)).data.conservativeCapacityDepth.length, 0);
  const live = { ...o, expiry: 1900n };
  entries = [{ ...entryFromSignedOffer(live, adapter.offerCommitment(profile, live), "0x"), maker: address(9), price: 1n }];
  const snapshot = await bookSnapshot(context, market.id);
  assert.equal(snapshot.data.entries[0].maker, o.maker);
  assert.notEqual(snapshot.data.entries[0].price, 1n);
});
