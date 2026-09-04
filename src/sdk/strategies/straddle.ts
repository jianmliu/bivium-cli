// The straddle: the only strategy that needs TWO markets, and the reason the series pairing rule exists.
//
// Both legs are BORROWS, one on each line, on the same asset at the same expiry:
//   credit line  — pledge N of the asset, borrow numeraire against it   → long asset + long put at K_put
//   options line — pledge numeraire, borrow N of the asset and sell it  → short asset + long call at K_call
// The two spot exposures are equal and opposite, so they cancel and what is left is a long strangle: flat between
// the strikes, gaining outside either. That cancellation is exact only when both legs are sized by the SAME N of
// the asset, which is why `size` here is the asset amount and not a face on either leg.
//
// Because the spot drops out, this is the one position whose value is pure volatility. That makes it the sharpest
// instrument against a maker who prices by moneyness rather than by vol: a single-leg quote carries spot risk that
// blunts the mispricing, and this one does not. Whoever runs the book on a market that admits straddles needs a
// vol input, or this is the trade that finds out.
import { WAD, type Address } from "../types.ts";
import { getStrategy } from "./catalog.ts";
import { samplePayoff } from "./payoff.ts";
import { normalCdf } from "./probability.ts";
import { quoteStrategy } from "./quote.ts";
import { realizedBufferPct, resolveStrategy } from "./resolve.ts";
import type { Payoff, PoolRow, PxWad, StrategyQuote, StrategyResolution, StrategySpec } from "./types.ts";

/** The two legs a straddle resolves onto — one market per line, mirrored around the mark. */
export interface StraddleResolution {
  /** The credit-line leg: the asset is the collateral, and its strike is the floor BELOW the mark. */
  put: StrategyResolution;
  /** The options-line leg: the asset is borrowed, and its strike is the cap ABOVE the mark. */
  call: StrategyResolution;
  asset: Address;
  numeraire: Address;
  maturity: bigint;
  lowerStrike: PxWad;
  upperStrike: PxWad;
  /** How far apart the strikes sit, as a multiple of the mark: the width being bought. */
  widthPct: { lower: number; upper: number };
}

export interface StraddleQuote {
  strategyId: "straddle";
  side: "borrow";
  maturity: bigint;
  asset: Address;
  numeraire: Address;
  /** The asset amount both legs are sized by. Equal on each side is what makes the spot cancel. */
  units: bigint;
  legs: { put: StrategyQuote; call: StrategyQuote };
  /** Everything the position costs, in numeraire: the only thing at risk between the strikes. */
  premium: bigint;
  /** Numeraire the account must bring beyond the asset it pledges, NET of what the credit leg hands it. The two
   *  legs run inside one router program, so the cash borrowed on the credit line funds the options leg's
   *  collateral before the account is asked for anything — sequentially it would need the gross instead. */
  prepay: bigint;
  /** What the options leg must post before that netting: the sequential path's requirement. */
  grossPrepay: bigint;
  /** The asset amount pledged on the credit leg. Equals `units`, and is the other half of what is tied up. */
  pledged: bigint;
  lowerStrike: PxWad;
  upperStrike: PxWad;
  breakEvens: { lower: PxWad; upper: PxWad };
  payoff: Payoff;
  /** P(finishes outside either strike) — the odds the position pays anything at all. */
  exerciseProbability: number | null;
  estimateBasis: "spot";
}

const DAY = 86_400n;

/// Resolve both legs. The mirror is not assumed: the credit leg's strike must sit below the mark and the options
/// leg's above it, or the pair is not straddling anything and the position is a directional bet wearing a name it
/// does not deserve.
export function resolveStraddle(
  spec: Omit<StrategySpec, "strategyId">,
  rows: PoolRow[],
  spot: PxWad,
  options: Parameters<typeof resolveStrategy>[3] = {},
): StraddleResolution {
  getStrategy("straddle"); // the definition is the contract; throws if it ever leaves the catalog
  // Each leg is resolved as the single-leg strategy it IS, so a straddle can never reach a market the plain
  // position could not — same rung ranking, same tolerance, same refusal to invent a market.
  const put = resolveStrategy({ ...spec, strategyId: "protectivePut" }, rows, spot, options);
  const call = resolveStrategy({ ...spec, strategyId: "short" }, rows, spot, options);
  if (put.row.market.params.maturity !== call.row.market.params.maturity) {
    throw new Error("a straddle's legs must expire together; the two lines resolved to different maturities");
  }
  if (!(put.strikeHuman < spot && call.strikeHuman > spot)) {
    throw new Error(
      `these rungs do not straddle the mark: the credit leg is at ${put.strikeHuman} and the options leg at `
        + `${call.strikeHuman} against a spot of ${spot}`,
    );
  }
  return {
    put,
    call,
    asset: call.asset,
    numeraire: call.numeraire,
    maturity: call.row.market.params.maturity,
    lowerStrike: put.strikeHuman,
    upperStrike: call.strikeHuman,
    widthPct: {
      lower: realizedBufferPct(put.strikeHuman, spot, "below"),
      upper: realizedBufferPct(call.strikeHuman, spot, "above"),
    },
  };
}

export interface StraddleQuoteInputs {
  resolution: StraddleResolution;
  /** Fill price of the credit leg's bid and the options leg's bid, WAD. */
  putPriceWad: bigint;
  callPriceWad: bigint;
  spot: PxWad;
  sigmaAnnual?: number;
  now: bigint;
}

/// Price the pair. Each leg goes through the same `quoteStrategy` a lone position would, and the strangle is their
/// sum — so a straddle and its two halves can never disagree about what either half costs.
export function quoteStraddle(q: StraddleQuoteInputs, size: bigint): StraddleQuote {
  const { resolution: r, spot } = q;
  if (size <= 0n) throw new RangeError("size must be positive");
  const put = quoteStrategy({ resolution: r.put, priceWad: q.putPriceWad, spot, now: q.now, sigmaAnnual: q.sigmaAnnual }, size);
  const call = quoteStrategy({ resolution: r.call, priceWad: q.callPriceWad, spot, now: q.now, sigmaAnnual: q.sigmaAnnual }, size);
  const dec = { assetDecimals: r.call.assetDecimals, numeraireDecimals: r.call.numeraireDecimals };

  // Between the strikes both legs unwind at par and the position has cost exactly its two premiums. Outside, one
  // leg is abandoned and the other pays the distance — so the whole payoff is the sum of the legs, sampled once.
  const premium = put.premium + call.premium;
  // What the credit leg actually pays out: its face less the discount the fill conceded.
  const putPrincipal = put.units > put.premium ? put.units - put.premium : 0n;
  const pnl = (S: PxWad): bigint => legPnl(put, S) + legPnl(call, S);
  const lower = r.lowerStrike;
  const upper = r.upperStrike;
  // Break-evens: the premium expressed as a price move beyond each strike, on `size` of the asset.
  const perUnit = (amount: bigint): PxWad => (amount * WAD * 10n ** BigInt(dec.assetDecimals))
    / (size * 10n ** BigInt(dec.numeraireDecimals));
  const breakEvens = { lower: lower > perUnit(premium) ? lower - perUnit(premium) : 0n, upper: upper + perUnit(premium) };
  const ceiling = (upper * 5n) / 2n;
  const payoff: Payoff = {
    points: samplePayoff(pnl, [lower, upper, spot, breakEvens.lower, breakEvens.upper], ceiling),
    worstCase: { amount: -premium, at: "S_T between the two strikes: both legs unwind at par and the premiums are the whole cost", form: "premium" },
    bestCase: { amount: pnl(ceiling), at: "unbounded above (value at the plot edge, 2.5x the upper strike)" },
    breakEven: breakEvens.upper,
    boundary: upper,
  };
  return {
    strategyId: "straddle",
    side: "borrow",
    maturity: r.maturity,
    asset: r.asset,
    numeraire: r.numeraire,
    units: size,
    legs: { put, call },
    premium,
    // The credit leg pledges the asset and hands back principal; the options leg posts numeraire collateral. Run
    // as one program the first pays for the second, so the account brings only the difference.
    prepay: call.prepay > putPrincipal ? call.prepay - putPrincipal : 0n,
    grossPrepay: call.prepay,
    pledged: size,
    lowerStrike: lower,
    upperStrike: upper,
    breakEvens,
    payoff,
    exerciseProbability: breakoutProbability(spot, lower, upper, q.sigmaAnnual, Number((r.maturity - q.now) * 1000n / DAY) / 1000),
    estimateBasis: "spot",
  };
}

/// A leg's P&L at S_T, read off the curve the leg's own payoff already sampled: linear between its points and flat
/// beyond its boundary, which is exactly how both single-leg payoffs are defined.
function legPnl(leg: StrategyQuote, S: PxWad): bigint {
  const pts = leg.payoff.points;
  if (S <= pts[0].S) return pts[0].pnl;
  for (let i = 1; i < pts.length; i++) {
    if (S > pts[i].S) continue;
    const [a, b] = [pts[i - 1], pts[i]];
    const span = b.S - a.S;
    return span === 0n ? b.pnl : a.pnl + ((b.pnl - a.pnl) * (S - a.S)) / span;
  }
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
  const span = b.S - a.S;
  return span === 0n ? b.pnl : b.pnl + ((b.pnl - a.pnl) * (S - b.S)) / span;
}

/// P(S_T outside [lower, upper]) under lognormal moves with no drift — the odds the straddle pays anything.
export function breakoutProbability(
  spot: PxWad, lower: PxWad, upper: PxWad, sigmaAnnual: number | undefined, days: number,
): number | null {
  if (sigmaAnnual === undefined) return null;
  if (spot <= 0n || lower <= 0n || upper <= 0n) return null;
  if (!Number.isFinite(sigmaAnnual) || !Number.isFinite(days) || sigmaAnnual <= 0 || days <= 0) return null;
  const sigmaT = sigmaAnnual * Math.sqrt(days / 365);
  const below = normalCdf(Math.log(Number(lower) / Number(spot)) / sigmaT);
  const above = 1 - normalCdf(Math.log(Number(upper) / Number(spot)) / sigmaT);
  return below + above;
}
