// Exercise probability — ADVISORY ONLY (a float shown next to the buffer slider). It never enters an
// amount, a strike, or a plan limit. Model: ln(S_T/S_0) ~ N(0, σ²T) with σ the annualised realised
// volatility (the pair feed's 21-day figure). The probability is ONE-SIDED in the strategy's exercise
// direction: a short is exercised when S rises through K (+buffer), a long-type strategy when S
// falls through K (−buffer). (The design note writes P(|Δln R| ≥ buffer); its worked number —
// σ=711%, 7d, +48% → ≈34% — is the one-sided value, which is what we implement.)

/** Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7) — more than enough for a slider. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * P(exercise) for a strike `bufferPct` percent away from spot in the OTM direction, over `days`,
 * given annualised σ. Returns null when the inputs cannot support an estimate.
 */
export function exerciseProbability(bufferPct: number, sigmaAnnual: number, days: number): number | null {
  if (!Number.isFinite(bufferPct) || !Number.isFinite(sigmaAnnual) || !Number.isFinite(days)) return null;
  if (sigmaAnnual <= 0 || days <= 0) return null;
  if (bufferPct <= -100) return null;
  const move = Math.log(1 + bufferPct / 100); // OTM distance in log space (signed by buffer)
  const sigmaT = sigmaAnnual * Math.sqrt(days / 365);
  if (sigmaT === 0) return move <= 0 ? 1 : 0;
  // one-sided: P(Δln ≥ move) for a strike above spot; P(Δln ≤ −move) is symmetric, so the same
  // formula serves the "below" direction when the caller passes the buffer as a positive OTM distance.
  return 1 - normalCdf(move / sigmaT);
}

/**
 * P(exercise) from the exact exercise boundary rather than a buffer: the probability the
 * maturity price lands on the exercise side of `boundary` under lognormal moves with no drift.
 * `above` = P(S_T ≥ boundary) (short is exercised against; a lender is called away);
 * `below` = P(S_T ≤ boundary) (a levered long delivers; a put-seller is assigned).
 * The boundary is the strategy's OWN delivery point — for a levered long that is
 * face ÷ total collateral, which sits well below K unless the position is at max LTV.
 */
export function exerciseProbabilityAt(
  spot: bigint,
  boundary: bigint,
  direction: "above" | "below",
  sigmaAnnual: number,
  days: number,
): number | null {
  if (spot <= 0n || boundary <= 0n) return null;
  if (!Number.isFinite(sigmaAnnual) || !Number.isFinite(days) || sigmaAnnual <= 0 || days <= 0) return null;
  const move = Math.log(Number(boundary) / Number(spot)); // signed log-distance to the boundary
  const sigmaT = sigmaAnnual * Math.sqrt(days / 365);
  const z = move / sigmaT;
  return direction === "above" ? 1 - normalCdf(z) : normalCdf(z);
}
