import assert from "node:assert/strict";
import { test } from "node:test";
import { strikeFromFloor } from "../src/sdk/math.ts";
import type { Address, DeploymentProfile } from "../src/sdk/types.ts";
import type { DiscoveredMarket } from "../src/sdk/discovery.ts";
import type { PoolRow, SpotRef } from "../src/sdk/strategies/index.ts";
import { createStrategyMcp, MCP_PROTOCOL_VERSION, TOOLS } from "../src/mcp/server.ts";

// The MCP core driven in-process: a JSON-RPC handshake, the tool list, and tool calls with injected
// rows/spot so nothing touches a network. Tool failures must come back as isError results, not
// protocol errors (an agent reads the message and adjusts).
const mAI = "0x0000000000000000000000000000000000000a01" as Address;
const bUSD = "0x0000000000000000000000000000000000000b01" as Address;
const CORE = "0x0000000000000000000000000000000000000c01" as Address;
const MATURITY = 1_800_000_000n;
const NOW = MATURITY - 7n * 86_400n;

const profile: DeploymentProfile = {
  name: "test", abiProfile: "core-v1", chainId: 1, core: CORE, signatureRatifier: CORE, rpcUrl: "http://localhost:1",
  tokens: { mAI: { address: mAI, decimals: 18 }, bUSD: { address: bUSD, decimals: 6 } },
};
const market: DiscoveredMarket = {
  id: "0x01",
  params: { loanToken: mAI, collateralToken: bUSD, maturity: MATURITY, strike: strikeFromFloor("5", 18, 6), allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" },
  firstSeenBlock: 0n,
};
const rows: PoolRow[] = [{ market, loanSymbol: "mAI", collateralSymbol: "bUSD", loanDecimals: 18, collateralDecimals: 6 }];
const spot: SpotRef = { px: 134_600_000_000_000_000n, status: "ready", pair: "BUSD-MAI" };
const positions = async (taker: string) => ({ ok: true as const, taker, at: 1, marketsScanned: 1, positions: [{ key: "busd-mai-3p5-w0911", marketId: "0x01", line: "options", side: "borrow" as const, kinds: ["short"], maturity: String(MATURITY), secondsToMaturity: 1, matured: false, urgent: false, debt: 500, collateral: 142.857143, credit: 0, liquidity: 0, bufferPct: 100, branches: { collateralValueLoan: 1000, netFromRepaying: 500, better: "repay" as const }, lenderOutcome: undefined, exit: { action: "buy back + repay + reclaim", note: "" } }] });
const mcp = createStrategyMcp({ profile, overrides: { rows, spot, parity: false, positions }, now: () => NOW });

const call = (id: number, name: string, args: Record<string, unknown>) => mcp.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const parsed = (r: Awaited<ReturnType<typeof mcp.handle>>) => JSON.parse(((r!.result as { content: { text: string }[] }).content[0]!).text);

test("mcp: handshake + tools/list", async () => {
  const init = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal((init!.result as { protocolVersion: string }).protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const list = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual((list!.result as { tools: { name: string }[] }).tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepEqual(TOOLS.map((t) => t.name), ["strategy_list", "market_list", "strategy_quote", "strategy_plan", "strategy_positions"]);
  const unknown = await mcp.handle({ jsonrpc: "2.0", id: 3, method: "nope" });
  assert.equal(unknown!.error!.code, -32601);
});

test("mcp: strategy_list and market_list (injected rows)", async () => {
  const list = parsed(await call(4, "strategy_list", {}));
  assert.equal(list.count, 10);
  const markets = parsed(await call(5, "market_list", {}));
  assert.equal(markets.count, 1);
  assert.equal(markets.markets[0].line, "options");
  assert.equal(markets.markets[0].strikeHuman, "200000000000000000"); // 0.20 bUSD per mAI, bigint as string
});

test("mcp: strategy_quote returns the confirm-screen numbers; strategy_plan adds a bounded plan", async () => {
  const q = parsed(await call(6, "strategy_quote", { strategy: "short", asset: "mAI", size: "10000", maturity: String(MATURITY), bufferPct: 48, priceWad: "768200000000000000", sigma: 7.11 }));
  assert.equal(q.quote.prepay, "966002800");
  assert.equal(q.quote.payoff.worstCase.form, "forfeit-collateral");
  assert.ok(q.quote.exerciseProbability > 0.33 && q.quote.exerciseProbability < 0.36);
  const p = parsed(await call(7, "strategy_plan", { strategy: "short", asset: "mAI", size: "10000", maturity: Number(MATURITY), bufferPct: 48, aprBps: 1200, minOut: "900" }));
  assert.equal(p.plan.mode, "sequential");
  assert.equal(p.plan.limits.maxLoss, p.quote.prepay);
});

test("mcp: tool-level failures are isError results, not protocol errors", async () => {
  const r = await call(8, "strategy_plan", { strategy: "short", asset: "mAI", size: "10000", maturity: String(MATURITY), bufferPct: 48, aprBps: 1200 }); // no minOut
  const res = r!.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /minOut is required/);
  const bad = await call(9, "strategy_quote", { strategy: "short" });
  assert.equal((bad!.result as { isError?: boolean }).isError, true);
});

test("mcp: strategy_positions proxies the app's positions and refuses without a taker", async () => {
  const r = parsed(await call(20, "strategy_positions", { taker: "0x" + "1".repeat(40) }));
  assert.equal(r.positions.length, 1);
  assert.deepEqual(r.positions[0].kinds, ["short"]);
  const bad = await call(21, "strategy_positions", {});
  assert.equal((bad!.result as { isError?: boolean }).isError, true);
});
