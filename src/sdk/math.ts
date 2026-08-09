import { STRIKE_SCALE, WAD } from "./types.ts";

/** Parse a human decimal string into an exact scaled bigint. Rejects floats-needed precision. */
export function parseAmount(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`invalid decimal amount: ${JSON.stringify(value)}`);
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new Error(`amount ${value} needs more precision than ${decimals} decimals`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** Render a scaled bigint as an exact human decimal string (no trailing zeros, never floats). */
export function formatAmount(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/**
 * strike from a human floor price (loan per whole collateral unit):
 *   strike = floor · 10^loanDecimals · 10^36 / 10^collateralDecimals — exact, or it throws.
 * Never use JS numbers here: an 18-decimal price exceeds Number.MAX_SAFE_INTEGER.
 */
export function strikeFromFloor(floor: string, loanDecimals: number, collateralDecimals: number): bigint {
  const scaledLoan = parseAmount(floor, loanDecimals);
  const numerator = scaledLoan * STRIKE_SCALE;
  const denominator = 10n ** BigInt(collateralDecimals);
  if (numerator % denominator !== 0n) throw new Error(`floor ${floor} is not exactly representable`);
  return numerator / denominator;
}

/** Inverse of strikeFromFloor, exact division required. */
export function floorFromStrike(strike: bigint, loanDecimals: number, collateralDecimals: number): string {
  const numerator = strike * 10n ** BigInt(collateralDecimals);
  if (numerator % STRIKE_SCALE !== 0n) throw new Error("strike is not on the exact human-floor grid");
  return formatAmount(numerator / STRIKE_SCALE, loanDecimals);
}

/** Principal a lender pays for `units` face at `priceWad`: floor(units·price/WAD) — mirrors core. */
export function principalForUnits(units: bigint, priceWad: bigint): bigint {
  return (units * priceWad) / WAD;
}

/** Collateral locked for issued debt: ceil(debt·STRIKE_SCALE/strike) — mirrors core's _mulDivUp. */
export function collateralForDebt(debt: bigint, strike: bigint): bigint {
  if (strike <= 0n) throw new RangeError("strike must be positive");
  return (debt * STRIKE_SCALE + strike - 1n) / strike;
}

/** Face debt supportable by collateral: floor(collateral·strike/STRIKE_SCALE). */
export function debtForCollateral(collateral: bigint, strike: bigint): bigint {
  return (collateral * strike) / STRIKE_SCALE;
}
