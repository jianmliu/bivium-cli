import assert from "node:assert/strict";
import { test } from "node:test";
import { strikeFromFloor } from "../src/sdk/math.ts";
import { tickToPrice, priceToTick } from "../src/sdk/tick.ts";
import { entryFromSignedOffer } from "../src/sdk/orderbook.ts";
import { WAD, type Address, type DeploymentProfile, type Offer } from "../src/sdk/types.ts";
import type { DiscoveredMarket } from "../src/sdk/discovery.ts";
import { gatherStrategyInputs, gatheredToJson, planFromGathered, type PoolRow, type SpotRef } from "../src/sdk/strategies/index.ts";

// The SDK gather path with everything injected (rows, spot, book) — no network, no chain — reproducing
// the design note's example through the SAME code the CLI and the MCP server call.
const mAI = "0x0000000000000000000000000000000000000a01" as Address;
const bUSD = "0x0000000000000000000000000000000000000b01" as Address;
const CORE = "0x0000000000000000000000000000000000000c01" as Address;
const MATURITY = 1_800_000_000n;
const NOW = MATURITY - 7n * 86_400n;
const K20 = strikeFromFloor("5", 18, 6);

const profile: DeploymentProfile = {
  name: "test", abiProfile: "core-v1", chainId: 1, core: CORE, signatureRatifier: CORE, rpcUrl: "http://localhost:1",
  tokens: { mAI: { address: mAI, decimals: 18 }, bUSD: { address: bUSD, decimals: 6 } },
};

function row(strike: bigint): PoolRow {
  const market: DiscoveredMarket = {
    id: "0x01",
    params: { loanToken: mAI, collateralToken: bUSD, maturity: MATURITY, strike, allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" },
    firstSeenBlock: 0n,
  };
  return { market, loanSymbol: "mAI", collateralSymbol: "bUSD", loanDecimals: 18, collateralDecimals: 6 };
}
const spot: SpotRef = { px: 134_600_000_000_000_000n, status: "ready", pair: "BUSD-MAI" };

test("gather (injected): explicit priceWad reproduces the design note's numbers; JSON keeps bigints", async () => {
  const g = await gatherStrategyInputs(profile, undefined, {
    strategy: "short", asset: "mAI", size: "10000", maturity: MATURITY, bufferPct: 48,
    priceWad: 768_200_000_000_000_000n, sigmaAnnual: 7.11, now: NOW, rows: [row(K20)], spot,
  });
  assert.equal(g.quote.prepay, 966_002_800n);
  assert.equal(g.quote.premium, 312_002_800n);
  assert.equal(g.sigmaSource, "request");
  assert.ok(g.quote.exerciseProbability! > 0.33 && g.quote.exerciseProbability! < 0.36);
  const j = gatheredToJson(g);
  assert.equal(j.prepayToken, bUSD); // a short prepays the numeraire
  assert.equal(typeof (j.quote as { prepay: bigint }).prepay, "bigint");
});

test("gather (injected): the feed's sigma21d is used when the request has none", async () => {
  const g = await gatherStrategyInputs(profile, undefined, {
    strategy: "short", asset: "mAI", size: "10000", maturity: MATURITY, bufferPct: 48,
    aprBps: 1200n, now: NOW, rows: [row(K20)], spot: { ...spot, sigmaAnnual: 7.11 },
  });
  assert.equal(g.sigmaSource, "feed");
  assert.equal(g.priceFrom, "aprBps 1200");
  assert.ok(g.quote.exerciseProbability !== null);
});

test("gather (injected): the live-book path takes the best BID for a borrower and reports an empty book", async () => {
  const lender = "0x0000000000000000000000000000000000000d01" as Address;
  const bid = (tick: bigint, maxUnits: bigint): Offer => ({
    loanToken: mAI, collateralToken: bUSD, maturity: MATURITY, strike: K20, allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000",
    maker: lender, buy: true, tick, maxUnits, maxAssets: 0n, start: 0n, expiry: MATURITY, group: `0x${"00".repeat(32)}`, ratifier: CORE,
  });
  const worse = priceToTick(tickToPrice(3000n), false);
  const better = priceToTick(tickToPrice(3400n), false); // higher tick = higher price = better for the seller/borrower
  const sig = `0x${"11".repeat(65)}` as `0x${string}`;
  const book = async () => ({ source: "test-book", entries: [entryFromSignedOffer(bid(worse, WAD), "0x02", sig), entryFromSignedOffer(bid(better, WAD), "0x03", sig)] });
  const g = await gatherStrategyInputs(profile, undefined, { strategy: "short", asset: "mAI", size: "1", maturity: MATURITY, bufferPct: 48, now: NOW, rows: [row(K20)], spot, book });
  assert.equal(g.priceWad, tickToPrice(better));
  assert.match(g.priceFrom, /best bid on test-book/);
  await assert.rejects(
    gatherStrategyInputs(profile, undefined, { strategy: "short", asset: "mAI", size: "1", maturity: MATURITY, bufferPct: 48, now: NOW, rows: [row(K20)], spot, book: async () => ({ source: "empty", entries: [] }) }),
    /no resting bid/,
  );
});

test("plan (injected): swap strategies need minOut; the swap direction follows the strategy", async () => {
  const g = await gatherStrategyInputs(profile, undefined, { strategy: "short", asset: "mAI", size: "10000", maturity: MATURITY, bufferPct: 48, aprBps: 1200n, now: NOW, rows: [row(K20)], spot });
  assert.throws(() => planFromGathered(profile, g), /minOut is required/);
  const plan = planFromGathered(profile, g, { minOut: "900" });
  assert.equal(plan.mode, "sequential");
  const swap = plan.steps.find((s) => s.kind === "swap")!;
  assert.equal(swap.sellToken, mAI);
  assert.equal(swap.buyToken, bUSD);
  assert.equal(swap.minOut, 900_000_000n); // numeraire units (6 dec)
  assert.equal(plan.limits.maxLoss, g.quote.prepay);
});

test("gather: input validation", async () => {
  await assert.rejects(gatherStrategyInputs(profile, undefined, { strategy: "short", asset: "mAI", size: "1", maturity: NOW - 1n, bufferPct: 48, now: NOW, rows: [row(K20)], spot }), /maturity is in the past/);
  await assert.rejects(gatherStrategyInputs(profile, undefined, { strategy: "short", asset: "bUSD", size: "1", maturity: MATURITY, bufferPct: 48, now: NOW, rows: [row(K20)], spot }), /no options-line market carries/);
  await assert.rejects(gatherStrategyInputs(profile, undefined, { strategy: "nope", asset: "mAI", size: "1", maturity: MATURITY, bufferPct: 48, now: NOW, rows: [row(K20)], spot }), /unknown strategy/);
});

test("gather: the quote's market id follows the profile's lineage — core-v2 binds chainId + core, core-v1 is the bare hash", async () => {
  const { computeMarketId } = await import("../src/sdk/market.ts");
  const { computeMarketIdV2 } = await import("../src/sdk/lineage.ts");
  const base = { strategy: "short", asset: "mAI", size: "10000", maturity: MATURITY, bufferPct: 48, priceWad: 768_200_000_000_000_000n, now: NOW, rows: [row(K20)], spot, parity: false as const };
  const v1 = await gatherStrategyInputs(profile, undefined, base);
  assert.equal(v1.quote.marketId, computeMarketId(row(K20).market.params));
  const v2Profile: DeploymentProfile = { ...profile, abiProfile: "core-v2", chainId: 46630, core: "0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4" as Address };
  const v2 = await gatherStrategyInputs(v2Profile, undefined, base);
  assert.equal(v2.quote.marketId, computeMarketIdV2({ chainId: 46630, core: v2Profile.core }, row(K20).market.params));
  assert.notEqual(v2.quote.marketId, v1.quote.marketId); // the bare hash is not what a core-v2 deployment recognises
});
