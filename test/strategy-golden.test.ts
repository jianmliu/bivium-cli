import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { tickToPrice } from "../src/sdk/tick.ts";
import { WAD, type Address } from "../src/sdk/types.ts";
import type { DiscoveredMarket } from "../src/sdk/discovery.ts";
import { classifyLine, getStrategy, humanStrike, orientation, quoteStrategy, realizedBufferPct, resolveStrategy, type PoolRow } from "../src/sdk/strategies/index.ts";

// The golden vectors are GENERATED from this SDK (test/golden/generate.ts). This test re-derives every one of
// them so that an unintended change to the canonical math — or to the conventions the vectors document — is a
// red CI here before it silently disagrees with the frontend, which consumes the same file.
type Vector = ReturnType<typeof load>["vectors"][number];
function load() {
  return JSON.parse(readFileSync(new URL("./golden/strategy-golden.json", import.meta.url), "utf8")) as {
    conventions: Record<string, string>;
    vectors: { id: string; strategyId: string; line: "options" | "credit" | "exchange"; side: string;
      inputs: { loanSymbol: string; collateralSymbol: string; loanDecimals: number; collateralDecimals: number; strike: string; tick: string; size: string; spotHumanWad: string; maturity: string; now: string; sigmaAnnual: number };
      expected: Record<string, string | number | null> }[];
  };
}
const ADDR: Record<string, Address> = { bUSD: "0x0000000000000000000000000000000000000b01", mAI: "0x0000000000000000000000000000000000000a01", TSLA: "0x0000000000000000000000000000000000000c01", WETH: "0x0000000000000000000000000000000000000e01" };

function rederive(v: Vector) {
  const i = v.inputs;
  const market: DiscoveredMarket = { id: "0x00", params: { loanToken: ADDR[i.loanSymbol], collateralToken: ADDR[i.collateralSymbol], maturity: BigInt(i.maturity), strike: BigInt(i.strike), allowPartialRepay: true, gate: "0x0000000000000000000000000000000000000000" }, firstSeenBlock: 0n };
  const row: PoolRow = { market, loanSymbol: i.loanSymbol, collateralSymbol: i.collateralSymbol, loanDecimals: i.loanDecimals, collateralDecimals: i.collateralDecimals };
  const line = classifyLine(i.loanSymbol, i.collateralSymbol)!;
  const spot = BigInt(i.spotHumanWad);
  const o = orientation(line, row);
  const buffer = realizedBufferPct(humanStrike(line, BigInt(i.strike), i.loanDecimals, i.collateralDecimals), spot, getStrategy(v.strategyId).otmDirection);
  const res = resolveStrategy({ strategyId: v.strategyId, asset: o.asset, counter: v.strategyId === "pairShort" ? o.numeraire : undefined, size: BigInt(i.size), maturity: BigInt(i.maturity), bufferPct: buffer }, [row], spot);
  return { line, res, q: quoteStrategy({ resolution: res, priceWad: tickToPrice(BigInt(i.tick)), spot, sigmaAnnual: i.sigmaAnnual, now: BigInt(i.now) }, BigInt(i.size)) };
}

test("golden vectors: every vector re-derives exactly from the canonical SDK", () => {
  const { vectors, conventions } = load();
  assert.equal(vectors.length, 6);
  assert.ok(conventions.buffer.includes("K/S₀") && conventions.probability.includes("1 − Φ"));
  for (const v of vectors) {
    const { line, res, q } = rederive(v);
    const e = v.expected;
    assert.equal(line, v.line, v.id);
    assert.equal(q.side, v.side, v.id);
    assert.equal(q.units.toString(), e.units, `${v.id} units`);
    assert.equal(q.prepay.toString(), e.prepay, `${v.id} prepay`);
    assert.equal(q.premium.toString(), e.premium, `${v.id} premium`);
    assert.equal(q.payoff.worstCase.amount.toString(), e.worstCase, `${v.id} worst`);
    assert.equal(q.payoff.worstCase.form, e.worstCaseForm, `${v.id} form`);
    if (e.bestCase !== null) assert.equal(q.payoff.bestCase.amount.toString(), e.bestCase, `${v.id} best`);
    assert.equal(q.payoff.breakEven?.toString() ?? null, e.breakEvenWad, `${v.id} breakEven`);
    assert.equal(q.payoff.boundary.toString(), e.boundaryWad, `${v.id} boundary`);
    assert.ok(Math.abs(res.realizedBufferPct - (e.realizedBufferPct as number)) < 1e-9, `${v.id} buffer`);
    assert.ok(Math.abs((q.exerciseProbability as number) - (e.exerciseProbability as number)) < 1e-12, `${v.id} probability`);
  }
});

test("golden vectors: the documented conventions hold on the numbers", () => {
  const { vectors } = load();
  const short = vectors.find((v) => v.id === "short-mai")!.expected;
  // 3.5 mAI per bUSD against a 7 mAI per bUSD spot: K = 1/3.5 bUSD per mAI is 100% ABOVE S₀ = 1/7.
  assert.ok(Math.abs((short.realizedBufferPct as number) - 100) < 1e-9);
  // "你付出的就是你最多会失去的"
  assert.equal(short.prepay, String(-BigInt(short.worstCase as string)));
  const put = vectors.find((v) => v.id === "lendquote-tsla")!.expected;
  assert.equal(put.bestCase, put.premium);
  assert.equal(put.worstCase, String(-BigInt(put.prepay as string)));
  void WAD;
});
