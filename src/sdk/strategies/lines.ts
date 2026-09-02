// Product line = which token roles a market has. Core-v1 has no "line" field — a market is just
// (loanToken, collateralToken, strike) — so the line is DERIVED from what is stable and what is not:
//   options  : borrow a volatile asset against stable collateral   (loan=asset, collateral=numeraire)
//   credit   : borrow stable against a volatile collateral          (loan=numeraire, collateral=asset)
//   exchange : both legs volatile — price is a ratio                (loan=asset, collateral=numeraire)
// The strategy's S is always "numeraire per whole asset". Core strike is "loan per whole collateral",
// so for options/exchange the human strike is the RECIPROCAL of the core orientation.
import { STRIKE_SCALE, WAD, type Address } from "../types.ts";
import type { Line, PoolRow, PxWad } from "./types.ts";

export const DEFAULT_STABLES: ReadonlySet<string> = new Set(["BUSD", "USDC", "USDT", "USDG", "DAI", "USD"]);

export function isStable(symbol: string | undefined, stables: ReadonlySet<string> = DEFAULT_STABLES): boolean {
  return !!symbol && stables.has(symbol.toUpperCase());
}

/** Classify a market by its token roles; null when both legs are stable (not a strategy market). */
export function classifyLine(
  loanSymbol: string | undefined,
  collateralSymbol: string | undefined,
  stables: ReadonlySet<string> = DEFAULT_STABLES,
): Line | null {
  const loanStable = isStable(loanSymbol, stables);
  const collStable = isStable(collateralSymbol, stables);
  if (loanStable && collStable) return null;
  if (!loanStable && collStable) return "options";
  if (loanStable && !collStable) return "credit";
  return "exchange";
}

/** Which token is the strategy's asset (whose price S we plot) and which is the numeraire. */
export function orientation(
  line: Line,
  row: Pick<PoolRow, "market" | "loanDecimals" | "collateralDecimals">,
): { asset: Address; numeraire: Address; assetDecimals: number; numeraireDecimals: number } {
  const p = row.market.params;
  if (line === "credit") {
    return { asset: p.collateralToken, numeraire: p.loanToken, assetDecimals: row.collateralDecimals, numeraireDecimals: row.loanDecimals };
  }
  return { asset: p.loanToken, numeraire: p.collateralToken, assetDecimals: row.loanDecimals, numeraireDecimals: row.collateralDecimals };
}

const pow10 = (d: number): bigint => 10n ** BigInt(d);

/** Core strike (loan per whole collateral, 1e36-scaled) → WAD price of one whole collateral in loan. */
export function strikeToLoanPerCollateralWad(strike: bigint, loanDecimals: number, collateralDecimals: number): bigint {
  // floor(WAD) = strike · 10^collDec · WAD / (1e36 · 10^loanDec)
  return (strike * pow10(collateralDecimals) * WAD) / (STRIKE_SCALE * pow10(loanDecimals));
}

/**
 * The strike in the strategy's human orientation (numeraire per whole asset). Exact for `credit`;
 * for options/exchange it is a floor-divided reciprocal — fine for display and rung RANKING, and
 * never used for amounts (those go through `collateralForDebt` on the exact core strike).
 */
export function humanStrike(line: Line, strike: bigint, loanDecimals: number, collateralDecimals: number): PxWad {
  const loanPerColl = strikeToLoanPerCollateralWad(strike, loanDecimals, collateralDecimals);
  if (line === "credit") return loanPerColl;
  if (loanPerColl === 0n) throw new RangeError("strike too small to invert");
  return (WAD * WAD) / loanPerColl;
}
