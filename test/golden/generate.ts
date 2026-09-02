// Golden vectors for the strategy lens — generated from THIS SDK (the L1 canonical) and consumed by every other
// implementation (bivium-frontend's Functions today). Regenerate with `npx tsx test/golden/generate.ts` only when
// the canonical math changes on purpose; the sibling test re-derives every vector so a drift here is a red CI.
import { writeFileSync } from "node:fs";
import { strikeFromFloor } from "../../src/sdk/math.ts";
import { tickToPrice } from "../../src/sdk/tick.ts";
import { WAD, type Address } from "../../src/sdk/types.ts";
import type { DiscoveredMarket } from "../../src/sdk/discovery.ts";
import { humanStrike, orientation, quoteStrategy, realizedBufferPct, resolveStrategy, classifyLine, getStrategy, type PoolRow } from "../../src/sdk/strategies/index.ts";

const ADDR: Record<string, { address: Address; decimals: number }> = {
  bUSD: { address: "0x0000000000000000000000000000000000000b01", decimals: 6 },
  mAI: { address: "0x0000000000000000000000000000000000000a01", decimals: 18 },
  TSLA: { address: "0x0000000000000000000000000000000000000c01", decimals: 18 },
  WETH: { address: "0x0000000000000000000000000000000000000e01", decimals: 18 },
};
const MATURITY = 1_789_113_600n; // w0911
const NOW = MATURITY - 7n * 86_400n;
const SIGMA = 7.11;

type Case = { id: string; strategyId: string; loan: string; coll: string; strikeFloor: string; tick: bigint; size: bigint; spotLoanPerCollateral: number };
const CASES: Case[] = [
  { id: "short-mai", strategyId: "short", loan: "mAI", coll: "bUSD", strikeFloor: "3.5", tick: 4000n, size: 500n * WAD, spotLoanPerCollateral: 7 },
  { id: "pairshort-mai-weth", strategyId: "pairShort", loan: "mAI", coll: "WETH", strikeFloor: "9000", tick: 3980n, size: 1000n * WAD, spotLoanPerCollateral: 18000 },
  { id: "leveredlong-tsla", strategyId: "leveredLong", loan: "bUSD", coll: "TSLA", strikeFloor: "200", tick: 3990n, size: 10n * WAD, spotLoanPerCollateral: 408 },
  { id: "protectiveput-tsla", strategyId: "protectivePut", loan: "bUSD", coll: "TSLA", strikeFloor: "200", tick: 3990n, size: 10n * WAD, spotLoanPerCollateral: 408 },
  { id: "lendasset-mai", strategyId: "lendAsset", loan: "mAI", coll: "bUSD", strikeFloor: "3.5", tick: 4000n, size: 500n * WAD, spotLoanPerCollateral: 7 },
  { id: "lendquote-tsla", strategyId: "lendQuote", loan: "bUSD", coll: "TSLA", strikeFloor: "200", tick: 3990n, size: 2000n * 10n ** 6n, spotLoanPerCollateral: 408 },
];

function vector(c: Case) {
  const loan = ADDR[c.loan], coll = ADDR[c.coll];
  const strike = strikeFromFloor(c.strikeFloor, loan.decimals, coll.decimals);
  const market: DiscoveredMarket = { id: "0x00", params: { loanToken: loan.address, collateralToken: coll.address, maturity: MATURITY, strike, allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" }, firstSeenBlock: 0n };
  const row: PoolRow = { market, loanSymbol: c.loan, collateralSymbol: c.coll, loanDecimals: loan.decimals, collateralDecimals: coll.decimals };
  const line = classifyLine(c.loan, c.coll)!;
  // Spot in the strategy's human orientation (numeraire per whole asset), WAD. The pair feed answers loan per
  // collateral; options/exchange invert it.
  const spotLpcWad = BigInt(Math.round(c.spotLoanPerCollateral * 1e6)) * 10n ** 12n;
  const spot = line === "credit" ? spotLpcWad : (WAD * WAD) / spotLpcWad;
  const def = getStrategy(c.strategyId)!;
  const o = orientation(line, row);
  const kHuman = humanStrike(line, strike, loan.decimals, coll.decimals);
  const buffer = realizedBufferPct(kHuman, spot, def.otmDirection);
  const spec = { strategyId: c.strategyId, asset: o.asset, counter: c.strategyId === "pairShort" ? o.numeraire : undefined, size: c.size, maturity: MATURITY, bufferPct: buffer };
  const res = resolveStrategy(spec, [row], spot);
  const q = quoteStrategy({ resolution: res, priceWad: tickToPrice(c.tick), spot, sigmaAnnual: SIGMA, now: NOW }, c.size);
  const s = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());
  return {
    id: c.id, strategyId: c.strategyId, line, side: q.side,
    inputs: { loanSymbol: c.loan, collateralSymbol: c.coll, loanDecimals: loan.decimals, collateralDecimals: coll.decimals, strike: strike.toString(), strikeFloor: c.strikeFloor,
      tick: c.tick.toString(), priceWad: tickToPrice(c.tick).toString(), size: c.size.toString(), spotLoanPerCollateral: c.spotLoanPerCollateral, spotHumanWad: spot.toString(),
      maturity: MATURITY.toString(), now: NOW.toString(), sigmaAnnual: SIGMA },
    expected: {
      units: s(q.units), prepay: s(q.prepay), premium: s(q.premium),
      worstCase: s(q.payoff.worstCase.amount), worstCaseForm: q.payoff.worstCase.form,
      bestCase: q.strategyId === "leveredLong" || q.strategyId === "protectivePut" ? null : s(q.payoff.bestCase.amount),
      breakEvenWad: s(q.payoff.breakEven), boundaryWad: s(q.payoff.boundary),
      realizedBufferPct: res.realizedBufferPct, strikeHumanWad: kHuman.toString(), exerciseProbability: q.exerciseProbability,
      assetDecimals: res.assetDecimals, numeraireDecimals: res.numeraireDecimals,
    },
  };
}

const out = { generatedBy: "bivium-cli src/sdk/strategies (L1 canonical)", conventions: {
  buffer: "percent in the strategy's OTM direction, human price space: options/exchange = 100·(K/S₀ − 1), credit = 100·(1 − K/S₀)",
  probability: "one-sided lognormal: 1 − Φ(ln(1 + b)/(σ·√(days/365)))",
  prepayUnit: "numeraire for short/pairShort/lendQuote; asset for leveredLong (topUp), protectivePut (holding) and lendAsset (lent)",
  amounts: "exact bigint atoms; human floats must match to 1e-6 relative",
}, vectors: CASES.map(vector) };
writeFileSync(new URL("./strategy-golden.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("wrote", out.vectors.length, "vectors");
