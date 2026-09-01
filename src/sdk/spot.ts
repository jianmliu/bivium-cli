// Display-only spot reference for economic guardrails. Bivium is oracle-free — spot NEVER enters
// market identity, offers, or settlement. It exists purely to warn a human (or agent) before they
// quote against an in-the-money strike.
//
// The reference is the deployment's own PAIR feed (`/api/spot?pair=COLLATERAL-LOAN`), which answers
// in the strike's exact unit: loan tokens per whole collateral. That makes the guard one rule for
// every market shape — volatile collateral, volatile loan, or both legs volatile:
//
//   ITM  ⟺  S ≥ R      (S = the strike ratio, R = the same ratio at spot)
//
// because the lender is underwater exactly when the collateral no longer covers the debt it backs.
// The old form compared a dollar floor against a Coinbase price, which was blind to every asset but
// ETH/BTC and read the comparison backwards on volatile-loan markets. S/R is also the market-level
// LTV, so the same number that gates also explains.

/** The pair feed's ticker for a token symbol — the frontend's convention: WETH quotes as ETH,
 *  everything else as its uppercased symbol. */
export function tickerFor(symbol: string | undefined): string | null {
  if (!symbol) return null;
  const s = symbol.toUpperCase();
  if (s === "WETH") return "ETH";
  if (s === "WBTC" || s === "VAULTBTC" || s === "TBTC") return "BTC";
  return /^[A-Z][A-Z0-9]{1,11}$/.test(s) ? s : null;
}

/** COLLATERAL-LOAN, the strike's own orientation; null when either leg has no ticker. */
export function pairFor(collateralSymbol: string | undefined, loanSymbol: string | undefined): string | null {
  const base = tickerFor(collateralSymbol);
  const quote = tickerFor(loanSymbol);
  return base && quote ? `${base}-${quote}` : null;
}

export interface PairRatio {
  /** Loan tokens per whole collateral at spot — the strike's unit. */
  loanPerCollateral: number;
  status: "ready" | "stale";
  /** Legs the feed took at a declared unit of account instead of a live price. */
  assumed: { symbol: string; unit: string }[];
}

/** The deployment's pair feed; null on any failure — callers degrade to "moneyness unknown". */
export async function fetchPairRatio(relayerUrl: string | undefined, pair: string): Promise<PairRatio | null> {
  if (!relayerUrl) return null;
  try {
    const res = await fetch(`${relayerUrl.replace(/\/$/, "")}/spot?pair=${encodeURIComponent(pair)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { loanPerCollateral?: unknown; status?: unknown; assumed?: unknown };
    if (typeof body.loanPerCollateral !== "number" || !Number.isFinite(body.loanPerCollateral) || body.loanPerCollateral <= 0) return null;
    if (body.status !== "ready" && body.status !== "stale") return null;
    return {
      loanPerCollateral: body.loanPerCollateral,
      status: body.status,
      assumed: Array.isArray(body.assumed) ? (body.assumed as PairRatio["assumed"]) : [],
    };
  } catch {
    return null;
  }
}

export interface Moneyness {
  /** S / R — the strike over the pair's spot ratio, which is also the market-level LTV. */
  ratio: number;
  /** The lender-underwater gate: S ≥ R, one rule for every market shape. */
  itm: boolean;
}

/**
 * Advisory comparison only — floats are acceptable because the result never touches identity or
 * amounts, it only decides whether to print a warning. `strikeRatioHuman` is `floorFromStrike`'s
 * output verbatim: loan per collateral, never reciprocated.
 */
export function assessMoneyness(strikeRatioHuman: string, loanPerCollateral: number): Moneyness | null {
  const strike = Number(strikeRatioHuman);
  if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(loanPerCollateral) || loanPerCollateral <= 0) return null;
  const ratio = strike / loanPerCollateral;
  return { ratio, itm: ratio >= 1 };
}
