import assert from "node:assert/strict";
import { test } from "node:test";
import { strikeFromFloor } from "../src/sdk/math.ts";
import type { Address, DeploymentProfile } from "../src/sdk/types.ts";
import type { DiscoveredMarket } from "../src/sdk/discovery.ts";
import { fetchHttpQuote, fetchStrategyPositions, gatherStrategyInputs, quoteParity, type HttpQuote, type PoolRow, type SpotRef } from "../src/sdk/strategies/index.ts";

// The L2 data plane over HTTP, driven with a stubbed fetch: the app's quote and positions parse (or refuse
// cleanly), and parity — the runtime twin of the golden vectors — says ok / mismatch / skipped / unavailable
// for the right reasons.
const mAI = "0x0000000000000000000000000000000000000a01" as Address;
const bUSD = "0x0000000000000000000000000000000000000b01" as Address;
const CORE = "0x0000000000000000000000000000000000000c01" as Address;
const MATURITY = 1_800_000_000n;
const NOW = MATURITY - 7n * 86_400n;
const profile: DeploymentProfile = {
  name: "test", abiProfile: "core-v1", chainId: 1, core: CORE, signatureRatifier: CORE, rpcUrl: "http://localhost:1",
  tokens: { mAI: { address: mAI, decimals: 18 }, bUSD: { address: bUSD, decimals: 6 } },
};
const market: DiscoveredMarket = { id: "0x01", params: { loanToken: mAI, collateralToken: bUSD, maturity: MATURITY, strike: strikeFromFloor("5", 18, 6), allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" }, firstSeenBlock: 0n };
const rows: PoolRow[] = [{ market, loanSymbol: "mAI", collateralSymbol: "bUSD", loanDecimals: 18, collateralDecimals: 6 }];
const spot: SpotRef = { px: 134_600_000_000_000_000n, status: "ready", pair: "BUSD-MAI" };

const originalFetch = globalThis.fetch;
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("http: the app's positions parse, and a down endpoint is a reason, never an empty account", async () => {
  try {
    stubFetch((url) => url.includes("/strategies/positions?taker=") ? { status: 200, body: { taker: "0x" + "1".repeat(40), at: 1, marketsScanned: 7, positions: [{ key: "busd-mai-3p5-w0911", side: "borrow", kinds: ["short"], exit: { action: "buy back + repay + reclaim", note: "" } }] } } : { status: 404, body: {} });
    const ok = await fetchStrategyPositions("https://x/api", "0x" + "1".repeat(40));
    assert.ok(ok.ok && ok.positions.length === 1 && ok.marketsScanned === 7);
    stubFetch(() => ({ status: 503, body: { error: "core read failed" } }));
    const down = await fetchStrategyPositions("https://x/api", "0x" + "1".repeat(40));
    assert.ok(!down.ok && down.reason === "core read failed");
    assert.ok(!(await fetchStrategyPositions(undefined, "0x" + "1".repeat(40))).ok);
    assert.ok(!(await fetchStrategyPositions("https://x/api", "nope")).ok);
  } finally { globalThis.fetch = originalFetch; }
});

test("http: the app's quote parses and carries the spec (maturity as a decimal string)", async () => {
  try {
    let sent: Record<string, unknown> = {};
    stubFetch((url, init) => { sent = JSON.parse(String(init?.body)); return url.endsWith("/strategies/quote") ? { status: 200, body: { quote: { kind: "short", marketId: "0x01", takes: 1, partial: false, prepay: 966.0028, prepayUnit: "numeraire", premium: 312.0028, payoff: { worstCase: -966.0028, worstCaseForm: "forfeit-collateral", boundary: 0.2 } } } } : { status: 404, body: {} }; });
    const r = await fetchHttpQuote("https://x/api/", { kind: "short", asset: "mAI", size: "10000", maturity: MATURITY, bufferPct: 48 });
    assert.ok(r.ok && r.quote.prepay === 966.0028);
    assert.equal(sent.maturity, MATURITY.toString());
    stubFetch(() => ({ status: 409, body: { error: "the book cannot fill this size" } }));
    const nope = await fetchHttpQuote("https://x/api", { kind: "short", asset: "mAI", size: "1" });
    assert.ok(!nope.ok && /cannot fill/.test(nope.reason));
  } finally { globalThis.fetch = originalFetch; }
});

function appQuoteFrom(local: Awaited<ReturnType<typeof gatherStrategyInputs>>, overrides: Partial<HttpQuote> = {}): HttpQuote {
  const q = local.quote;
  return {
    kind: q.strategyId, side: q.side, market: { key: "k", marketId: q.marketId, maturity: q.maturity.toString() }, asset: "mAI", numeraire: "bUSD",
    spot: 0.1346, strike: 0.2, bufferPct: local.res.realizedBufferPct, filledAtoms: q.units.toString(), partial: false, takes: 1,
    premium: Number(q.premium) / 1e6, prepay: Number(q.prepay) / 1e6, prepayUnit: "numeraire",
    exerciseProbability: q.exerciseProbability ?? undefined,
    payoff: { worstCase: Number(q.payoff.worstCase.amount) / 1e6, worstCaseForm: q.payoff.worstCase.form, bestCase: Number(q.payoff.bestCase.amount) / 1e6, breakEven: q.payoff.breakEven === null ? undefined : Number(q.payoff.breakEven) / 1e18, boundary: Number(q.payoff.boundary) / 1e18 },
    ...overrides,
  };
}

test("parity: agreement is ok; a different number is a loud mismatch; off-book pricing and multi-level sweeps are skipped; a down app is unavailable", async () => {
  const base = { strategy: "short", asset: "mAI", size: "10000", maturity: MATURITY, bufferPct: 48, sigmaAnnual: 7.11, now: NOW, rows, spot } as const;
  // Injected loader that answers with the app's rendering of the SAME numbers.
  const local = await gatherStrategyInputs(profile, undefined, { ...base, priceWad: 768_200_000_000_000_000n, parity: false });
  assert.equal(local.parity.status, "skipped");
  const agree = quoteParity(local, { ok: true, quote: appQuoteFrom(local) });
  assert.equal(agree.status, "ok");
  assert.ok(agree.status === "ok" && agree.checks.every((c) => c.ok) && agree.checks.some((c) => c.field === "exerciseProbability"));
  const drift = quoteParity(local, { ok: true, quote: appQuoteFrom(local, { prepay: 900 }) });
  assert.equal(drift.status, "mismatch");
  assert.deepEqual(drift.status === "mismatch" ? drift.checks.filter((c) => !c.ok).map((c) => c.field) : [], ["prepay"]);
  assert.equal(quoteParity(local, { ok: true, quote: appQuoteFrom(local, { takes: 2 }) }).status, "skipped");
  assert.equal(quoteParity(local, { ok: true, quote: appQuoteFrom(local, { market: { key: "k", marketId: "0x02", maturity: String(MATURITY) } }) }).status, "mismatch");
  assert.equal(quoteParity(local, { ok: false, reason: "down" }).status, "unavailable");
  assert.equal(quoteParity(local, { ok: true, quote: appQuoteFrom(local) }, { pricedOffBook: true }).status, "skipped");
  // Through gather itself: an injected loader is consulted only on the live-book basis.
  const viaBook = await gatherStrategyInputs(profile, undefined, { ...base, aprBps: 1200n, parity: async () => ({ ok: true, quote: appQuoteFrom(local) }) });
  assert.equal(viaBook.parity.status, "skipped"); // aprBps is off-book
});
