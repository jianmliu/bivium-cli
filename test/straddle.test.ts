import assert from "node:assert/strict";
import { test } from "node:test";
import { strikeFromFloor } from "../src/sdk/math.ts";
import { WAD, type Address } from "../src/sdk/types.ts";
import type { DiscoveredMarket } from "../src/sdk/discovery.ts";
import { breakoutProbability, getStrategy, quoteStraddle, resolveStraddle, type PoolRow } from "../src/sdk/strategies/index.ts";

// The live mCASHCAT venue: a $0.193 mark, a call rung at $0.40 on the options line and a put rung at $0.10 on the
// credit line. Two markets, mirrored around the mark — the pair the series rule exists to make possible.
const BUSD: Address = "0x0000000000000000000000000000000000000b01";
const MEME: Address = "0x0000000000000000000000000000000000000c01";
const MATURITY = 1788768000n;
const NOW = MATURITY - 3n * 86400n;
const SPOT = 193000000000000000n; // $0.193, WAD

function market(loanToken: Address, collateralToken: Address, strike: bigint, allowPartialRepay: boolean): DiscoveredMarket {
  return { id: "0x00", params: { loanToken, collateralToken, maturity: MATURITY, strike, allowPartialRepay, gate: "0x0000000000000000000000000000000000000000" }, firstSeenBlock: 0n };
}
// options line: loan = meme (18dp), collateral = bUSD (6dp). Strike is memes per whole bUSD, so K=$0.40 is 2.5.
const callRow: PoolRow = { market: market(MEME, BUSD, strikeFromFloor("2.5", 18, 6), true), loanSymbol: "mCASHCAT", collateralSymbol: "bUSD", loanDecimals: 18, collateralDecimals: 6 };
// credit line: loan = bUSD, collateral = meme. Strike is dollars per whole meme.
const putRow: PoolRow = { market: market(BUSD, MEME, strikeFromFloor("0.1", 6, 18), false), loanSymbol: "bUSD", collateralSymbol: "mCASHCAT", loanDecimals: 6, collateralDecimals: 18 };
const rows = [callRow, putRow];
const spec = { asset: MEME, size: 0n, maturity: MATURITY, bufferPct: 50 };

test("a straddle is the catalog's own definition: two borrows, one per line, and not quotable as one market", () => {
  const def = getStrategy("straddle");
  assert.equal(def.quotable, false, "one market is exactly what a straddle is not");
  assert.equal(def.composite, true, "so it is reached through its own path instead");
  assert.deepEqual(def.legs.map((l) => `${l.line}:${l.side}`), ["credit:borrow", "options:borrow"]);
});

test("resolution finds one market per line, expiring together and straddling the mark", () => {
  const r = resolveStraddle(spec, rows, SPOT);
  assert.equal(r.maturity, MATURITY);
  assert.equal(r.asset, MEME);
  assert.equal(r.numeraire, BUSD);
  assert.ok(r.lowerStrike < SPOT, "the credit leg is the floor below the mark");
  assert.ok(r.upperStrike > SPOT, "the options leg is the cap above it");
  // $0.10 and $0.40 against $0.193: −48% and +107%.
  assert.ok(Math.abs(r.widthPct.lower - 48.2) < 0.5, `lower ${r.widthPct.lower}`);
  assert.ok(Math.abs(r.widthPct.upper - 107.3) < 0.5, `upper ${r.widthPct.upper}`);
});

test("rungs that do not straddle the mark are refused rather than priced as a straddle", () => {
  // A credit rung struck ABOVE the mark still resolves as a protective put — the resolver's job is the rung, not
  // the moneyness — so both legs are found and only the straddle's own check can catch that they both bet the
  // same way. Without it the pair would be priced as a straddle while being a levered directional position.
  const itmPut: PoolRow = { ...putRow, market: market(BUSD, MEME, strikeFromFloor("0.30", 6, 18), false) };
  assert.throws(() => resolveStraddle(spec, [callRow, itmPut], SPOT), /do not straddle the mark/);
  // And the case where one line simply is not listed is refused by the resolver, before the pair is considered.
  const secondCall: PoolRow = { ...callRow, market: market(MEME, BUSD, strikeFromFloor("4", 18, 6), true) };
  assert.throws(() => resolveStraddle(spec, [callRow, secondCall], SPOT), /no credit market/);
});

test("the strangle's whole cost is the two premiums, and between the strikes that is all it can lose", () => {
  const r = resolveStraddle(spec, rows, SPOT);
  const size = 100n * 10n ** 18n; // 100 mCASHCAT on both legs — equal sizing is what cancels the spot
  const q = quoteStraddle({ resolution: r, putPriceWad: WAD * 9985n / 10000n, callPriceWad: WAD * 9985n / 10000n, spot: SPOT, now: NOW, sigmaAnnual: 7.11 }, size);

  assert.equal(q.units, size);
  assert.equal(q.premium, q.legs.put.premium + q.legs.call.premium, "the pair costs exactly what its halves cost");
  assert.equal(q.payoff.worstCase.form, "premium");
  assert.equal(q.payoff.worstCase.amount, -q.premium);

  // Between the strikes the two spot exposures cancel and only the premiums remain. Check the midpoint and the
  // mark itself, which is the case a directional reading would get wrong.
  const mid = (q.lowerStrike + q.upperStrike) / 2n;
  for (const S of [SPOT, mid]) {
    const at = pnlAt(q, S);
    assert.ok(at <= 0n && at >= -q.premium * 12n / 10n, `flat between the strikes, got ${at} at ${S}`);
  }
  // Outside, it pays the distance: a halving and a doubling both make money.
  assert.ok(pnlAt(q, q.lowerStrike / 2n) > 0n, "a further collapse pays");
  assert.ok(pnlAt(q, q.upperStrike * 2n) > 0n, "a further rally pays");
  // Break-evens sit outside the strikes by the premium.
  assert.ok(q.breakEvens.lower < q.lowerStrike && q.breakEvens.upper > q.upperStrike);

  // Capital: the credit leg's principal pays for the options leg's collateral inside one program, so the account
  // brings the difference rather than the whole of it. Getting this wrong overstates the requirement twofold.
  assert.equal(q.grossPrepay, q.legs.call.prepay);
  assert.equal(q.prepay, q.grossPrepay - (q.legs.put.units - q.legs.put.premium));
  assert.ok(q.prepay < q.grossPrepay / 2n + q.grossPrepay / 10n, "netting is most of the requirement, not a rounding");
  assert.equal(q.pledged, size, "and the asset side is the size itself");
});

test("the odds quoted are the odds of finishing outside either strike, and they rise with volatility", () => {
  const p = (sigma: number) => breakoutProbability(SPOT, 100000000000000000n, 400000000000000000n, sigma, 3)!;
  assert.ok(p(7.11) > p(5) && p(5) > p(3) && p(3) > p(1));
  // At the meme volatility the design note uses, a +107%/−48% strangle is a live bet rather than a lottery.
  assert.ok(p(7.11) > 0.2 && p(7.11) < 0.4, `got ${p(7.11)}`);
  // At an equity-like volatility it is worth nothing, which is the honest answer.
  assert.ok(p(1) < 0.001, `got ${p(1)}`);
  assert.equal(breakoutProbability(SPOT, 1n, 2n, undefined, 3), null);
});

/// Read the sampled curve the way a caller would.
function pnlAt(q: ReturnType<typeof quoteStraddle>, S: bigint): bigint {
  const pts = q.payoff.points;
  if (S <= pts[0].S) return pts[0].pnl;
  for (let i = 1; i < pts.length; i++) {
    if (S > pts[i].S) continue;
    const [a, b] = [pts[i - 1], pts[i]];
    return b.S === a.S ? b.pnl : a.pnl + ((b.pnl - a.pnl) * (S - a.S)) / (b.S - a.S);
  }
  return pts[pts.length - 1].pnl;
}
