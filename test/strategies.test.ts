import assert from "node:assert/strict";
import { test } from "node:test";
import { strikeFromFloor, collateralForDebt } from "../src/sdk/math.ts";
import { WAD, type Address } from "../src/sdk/types.ts";
import type { DiscoveredMarket } from "../src/sdk/discovery.ts";
import {
  STRATEGIES, getStrategy, classifyLine, humanStrike, exerciseProbability,
  borrowSellPayoff, leveredLongPayoff, lendQuotePayoff, priceWhereWorth,
  resolveStrategy, quoteStrategy, buildPlan, type MarketRiskReport, type PoolRow,
} from "../src/sdk/strategies/index.ts";

// ── fixture: the design note's worked example ─────────────────────────────────────────────
// short 10,000 mAI · K = 0.20 bUSD · S₀ = 0.1346 bUSD · 7 days · σ = 711% · premium ≈ 312 bUSD
const mAI = "0x0000000000000000000000000000000000000a01" as Address; // 18 dec
const bUSD = "0x0000000000000000000000000000000000000b01" as Address; // 6 dec
const N = 10_000n * WAD;
const P = 768_200_000_000_000_000n; // 0.7682 — implies premium ≈ 312 at S₀
const S0 = 134_600_000_000_000_000n; // 0.1346
const K20 = strikeFromFloor("5", 18, 6); // 5 mAI per bUSD  ⇔  0.20 bUSD per mAI
const K25 = strikeFromFloor("4", 18, 6); // 4 mAI per bUSD  ⇔  0.25 bUSD per mAI
const MATURITY = 1_800_000_000n;
const NOW = MATURITY - 7n * 86_400n;

function row(strike: bigint): PoolRow {
  const market: DiscoveredMarket = {
    id: "0x00",
    params: { loanToken: mAI, collateralToken: bUSD, maturity: MATURITY, strike, allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" },
    firstSeenBlock: 0n,
  };
  return { market, loanSymbol: "mAI", collateralSymbol: "bUSD", loanDecimals: 18, collateralDecimals: 6 };
}

test("catalog: ids unique, every mirror resolves, exactly the six single-leg strategies are quotable", () => {
  const ids = STRATEGIES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of STRATEGIES) if (s.mirrorOf) assert.ok(getStrategy(s.mirrorOf));
  assert.deepEqual(STRATEGIES.filter((s) => s.quotable).map((s) => s.id).sort(), ["lendAsset", "lendQuote", "leveredLong", "pairShort", "protectivePut", "short"]);
  for (const s of STRATEGIES) assert.ok(s.legs.length >= 1);
});

test("catalog: aliases resolve to stable ids and initial products expose outcome labels", () => {
  assert.equal(getStrategy("earnOnHoldings").id, "lendAsset");
  assert.equal(getStrategy("buyAtTarget").id, "lendQuote");
  assert.equal(getStrategy("cappedRiskShort").id, "short");

  assert.deepEqual(
    STRATEGIES.filter((s) => s.initialRelease).map((s) => s.id).sort(),
    ["lendAsset", "lendQuote", "leveredLong", "short"],
  );
  for (const s of STRATEGIES) {
    assert.ok(s.outcomeLabels.length >= 2, `${s.id} needs at least two outcome labels`);
    assert.ok(s.outcomeLabels.every((label) => label.length > 0), `${s.id} has an empty outcome label`);
  }
});

test("lines: derived from token roles; human strike is the reciprocal on options/exchange", () => {
  assert.equal(classifyLine("mAI", "bUSD"), "options");
  assert.equal(classifyLine("bUSD", "mNVDA"), "credit");
  assert.equal(classifyLine("mAI", "mNVDA"), "exchange");
  assert.equal(classifyLine("USDC", "bUSD"), null);
  // 5 mAI per bUSD → 0.20 bUSD per mAI
  assert.equal(humanStrike("options", K20, 18, 6), 200_000_000_000_000_000n);
  // credit line keeps the core orientation: strike "3000 USDC per WETH" reads back as 3000
  assert.equal(humanStrike("credit", strikeFromFloor("3000", 6, 18), 6, 18), 3000n * WAD);
});

test("short: the design note's numbers — prepay = worst case ≈ 966, AI→0 ≈ +1,034, break-even = S₀·p", () => {
  const r = borrowSellPayoff({ units: N, priceWad: P, spot: S0, strike: K20, assetDecimals: 18, numeraireDecimals: 6 });
  assert.equal(r.collateral, 2_000_000_000n); // 2,000 bUSD = N·K, exact from the core strike
  assert.equal(r.received, 7_682n * WAD);
  assert.equal(r.premium, 312_002_800n); // ≈ 312 bUSD
  assert.equal(r.sold, 1_033_997_200n); // ≈ 1,034 bUSD
  assert.equal(r.prepay, 966_002_800n); // ≈ 966 = (K − S₀)·N + premium
  assert.equal(r.payoff.worstCase.amount, -r.prepay);
  assert.equal(r.payoff.worstCase.form, "forfeit-collateral");
  assert.equal(r.forfeitAbove, 200_000_000_000_000_000n); // K
  // the plot: at S=0 the short keeps everything it sold; at/after K it forfeits exactly the prepay
  const at = (S: bigint) => r.payoff.points.find((p) => p.S === S)?.pnl;
  assert.equal(at(0n), r.sold);
  assert.equal(at(r.forfeitAbove), -r.prepay);
  // break-even sits at S₀·p (you paid the premium): 0.1346 × 0.7682 ≈ 0.1034
  assert.equal(r.payoff.breakEven, priceWhereWorth(N, r.sold, 18, 6));
  assert.ok(r.payoff.breakEven! > 103_000_000_000_000_000n && r.payoff.breakEven! < 104_000_000_000_000_000n);
  // "你付出的就是你最多会失去的"
  assert.equal(r.prepay, -r.payoff.worstCase.amount);
});

test("exercise probability: σ = 711%, 7 days, +48.6% → ≈ 34% (one-sided)", () => {
  const p = exerciseProbability(48.59, 7.11, 7)!;
  assert.ok(p > 0.33 && p < 0.36, `got ${p}`);
  assert.equal(exerciseProbability(48, 0, 7), null);
  assert.ok(exerciseProbability(0, 7.11, 7)! > 0.49 && exerciseProbability(0, 7.11, 7)! < 0.51); // ATM ≈ 50%
});

test("levered long: max loss is the stake, never more; break-even needs repaying face + stake", () => {
  const WETH = "0x0000000000000000000000000000000000000e01" as Address;
  void WETH;
  const strike = strikeFromFloor("2000", 6, 18); // 2,000 USDC per WETH
  const r = leveredLongPayoff({ holding: WAD, borrowFace: 1_000_000_000n, priceWad: 950_000_000_000_000_000n, spot: 3000n * WAD, strike, assetDecimals: 18, numeraireDecimals: 6 });
  assert.equal(r.required, collateralForDebt(1_000_000_000n, strike)); // 0.5 WETH backs 1,000 USDC at K=2000
  assert.equal(r.topUp, 0n);
  assert.equal(r.payoff.worstCase.amount, -r.stake);
  assert.equal(r.payoff.worstCase.form, "deliver-collateral");
  assert.ok(r.payoff.points.every((p) => p.pnl >= -r.stake), "loss never exceeds the stake");
});

test("lend quote (paid dip-buy): best case is the premium, assigned below K", () => {
  const strike = strikeFromFloor("2000", 6, 18);
  const r = lendQuotePayoff({ face: 1_000_000_000n, priceWad: 950_000_000_000_000_000n, spot: 3000n * WAD, strike, assetDecimals: 18, numeraireDecimals: 6 });
  assert.equal(r.premium, 50_000_000n); // 1,000 − 950
  assert.equal(r.payoff.bestCase.amount, r.premium);
  assert.equal(r.payoff.worstCase.form, "assigned");
  assert.equal(r.assignedBelow, 2000n * WAD);
});

test("resolve: picks the rung nearest the requested buffer; offers the two nearest when nothing matches", () => {
  const rows = [row(K20), row(K25)]; // +48.6% and +85.7% OTM at S₀
  const hit = resolveStrategy({ strategyId: "short", asset: mAI, size: N, maturity: MATURITY, bufferPct: 48 }, rows, S0);
  assert.equal(hit.strike, K20);
  assert.ok(Math.abs(hit.realizedBufferPct - 48.59) < 0.1);
  assert.deepEqual(hit.alternatives, []);
  assert.equal(hit.asset, mAI);
  assert.equal(hit.numeraire, bUSD);
  const miss = resolveStrategy({ strategyId: "short", asset: mAI, size: N, maturity: MATURITY, bufferPct: 70 }, rows, S0);
  assert.equal(miss.strike, K25);
  assert.equal(miss.alternatives.length, 2);
  assert.throws(() => resolveStrategy({ strategyId: "straddle", asset: mAI, size: N, maturity: MATURITY, bufferPct: 10 }, rows, S0), /Router/);
  assert.throws(() => resolveStrategy({ strategyId: "short", asset: mAI, size: N, maturity: MATURITY + 1n, bufferPct: 48 }, rows, S0), /no options market/);
});

test("quote + plan: the confirm-screen numbers and a bounded plan whose maxLoss is |worstCase|", () => {
  const res = resolveStrategy({ strategyId: "short", asset: mAI, size: N, maturity: MATURITY, bufferPct: 48 }, [row(K20)], S0);
  const q = quoteStrategy({ resolution: res, priceWad: P, spot: S0, sigmaAnnual: 7.11, now: NOW }, N);
  assert.equal(q.prepay, 966_002_800n);
  assert.equal(q.premium, 312_002_800n);
  assert.ok(q.exerciseProbability! > 0.33 && q.exerciseProbability! < 0.36);
  assert.equal(q.estimateBasis, "spot");

  const core = "0x0000000000000000000000000000000000000c01" as Address;
  const seq = buildPlan(res, q, { now: NOW, core });
  assert.equal(seq.mode, "sequential"); // swap leg, no Router → explicitly non-atomic
  assert.equal(seq.marketId, q.marketId);
  assert.equal(seq.riskDecision, "not_evaluated");
  assert.deepEqual(seq.riskWarnings, []);
  assert.equal(seq.limits.maxLoss, 966_002_800n);
  assert.deepEqual(seq.steps.map((s) => s.kind), ["approve", "fill-bid", "swap"]);

  const report = (overrides: Partial<MarketRiskReport> = {}): MarketRiskReport => ({
    market: q.marketId,
    facts: [],
    warnings: [{ code: "FREEZABLE", severity: "warning", message: "collateral can be frozen" }],
    unknowns: [],
    decision: "accept",
    decisionSource: "user-policy",
    ...overrides,
  });
  assert.throws(
    () => buildPlan(res, q, { now: NOW, core, riskReport: report({ market: `0x${"00".repeat(32)}` as typeof q.marketId }) }),
    /risk report market does not match quote/,
  );
  assert.throws(
    () => buildPlan(res, q, { now: NOW, core, riskReport: report({ market: undefined as never }) }),
    /risk report market does not match quote/,
  );
  const upperCaseMarketId = `0x${q.marketId.slice(2).toUpperCase()}` as typeof q.marketId;
  assert.equal(buildPlan(res, q, { now: NOW, core, riskReport: report({ market: upperCaseMarketId }) }).riskDecision, "accept");
  assert.throws(
    () => buildPlan(res, q, { now: NOW, core, riskReport: report({ decision: "reject", decisionSource: "agent-policy" }) }),
    /risk policy rejected this plan/,
  );
  assert.throws(
    () => buildPlan(res, q, { now: NOW, core, riskReport: report({ decision: "require_user_confirmation", decisionSource: "agent-policy" }) }),
    /risk policy requires user confirmation/,
  );
  const accepted = buildPlan(res, q, { now: NOW, core, riskReport: report() });
  assert.equal(accepted.marketId, q.marketId);
  assert.equal(accepted.riskDecision, "accept");
  assert.deepEqual(accepted.riskWarnings, ["collateral can be frozen"]);
  assert.equal(accepted.quoteId, seq.quoteId);

  const otherRes = resolveStrategy({ strategyId: "short", asset: mAI, size: N, maturity: MATURITY, bufferPct: 80 }, [row(K25)], S0);
  assert.throws(
    () => buildPlan(otherRes, q, { now: NOW, core }),
    /quote market does not match resolution/,
  );
  assert.throws(
    () => buildPlan(res, { ...q, strategyId: "lendAsset" }, { now: NOW, core }),
    /quote strategy does not match resolution/,
  );

  const router = "0x0000000000000000000000000000000000000d01" as Address;
  const atomic = buildPlan(res, q, { now: NOW, core, router, swap: { sellToken: mAI, buyToken: bUSD, minOut: 1_000_000_000n } });
  assert.equal(atomic.mode, "router");
  assert.equal(atomic.steps[0]!.kind, "grant-auth");
  assert.equal(atomic.limits.minOut, 1_000_000_000n);
  assert.equal(atomic.quoteId.length, 66);
  assert.equal(atomic.quoteId, seq.quoteId); // same economic inputs → same deterministic id

  // a single-leg lend is an intent
  const lendRes = resolveStrategy({ strategyId: "lendAsset", asset: mAI, size: N, maturity: MATURITY, bufferPct: 48 }, [row(K20)], S0);
  const lendQ = quoteStrategy({ resolution: lendRes, priceWad: P, spot: S0, now: NOW }, N);
  assert.equal(buildPlan(lendRes, lendQ, { now: NOW, core }).mode, "intent");
});

test("P(exercise) is measured at the strategy's own boundary, not at K", () => {
  // Levered long on mNVDA: hold 10, K = 160 below spot 170, max borrow → the delivery point is
  // face ÷ total collateral ≈ 82.7, far below K. The reported probability must reflect THAT.
  const mNVDA = "0x0000000000000000000000000000000000000f01" as Address;
  const K160 = strikeFromFloor("160", 6, 18); // 160 bUSD per mNVDA (credit line: loan bUSD, collateral mNVDA)
  const market: DiscoveredMarket = {
    id: "0x02",
    params: { loanToken: bUSD, collateralToken: mNVDA, maturity: 1_800_000_000n, strike: K160, allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" },
    firstSeenBlock: 0n,
  };
  const rows: PoolRow[] = [{ market, loanSymbol: "bUSD", collateralSymbol: "mNVDA", loanDecimals: 6, collateralDecimals: 18 }];
  const spot = 170n * WAD;
  const res = resolveStrategy({ strategyId: "leveredLong", asset: mNVDA, size: 0n, maturity: 1_800_000_000n, bufferPct: -6 }, rows, spot);
  const now = 1_800_000_000n - 22n * 86_400n;
  const q = quoteStrategy({ resolution: res, priceWad: 992_576_000_000_000_000n, spot, sigmaAnnual: 0.6, now }, 10n * WAD);
  assert.ok(q.payoff.boundary < 90n * WAD && q.payoff.boundary > 80n * WAD);
  // At K the odds would be ~34%; at the real delivery point (a −51% move over 22d at σ=60%) they are ≈0.
  const atK = exerciseProbability(res.realizedBufferPct, 0.6, 22)!;
  assert.ok(atK > 0.3);
  assert.ok(q.exerciseProbability! < 0.01);
  // The short's boundary IS K, so its number is unchanged (the design note's 34%).
  const short = quoteStrategy({ resolution: resolveStrategy({ strategyId: "short", asset: mAI, size: 0n, maturity: MATURITY, bufferPct: 48 }, [row(K20)], S0), priceWad: P, spot: S0, sigmaAnnual: 7.11, now: MATURITY - 7n * 86_400n }, N);
  assert.ok(short.exerciseProbability! > 0.33 && short.exerciseProbability! < 0.36);
});
