// Display-only spot reference for economic guardrails. Bivium is oracle-free — spot NEVER enters
// market identity, offers, or settlement. It exists here purely to warn a human (or agent) before
// they quote against an in-the-money floor: a floor at or above spot means the borrower's rational
// strategy is to keep the principal and deliver the collateral, so a near-par lend price is a
// guaranteed loss, not a fixed-rate product.

/** Map a collateral token symbol to its spot reference asset; null = no reference available. */
export function spotAssetFor(collateralSymbol: string | undefined): "ETH" | "BTC" | null {
  if (!collateralSymbol) return null;
  const s = collateralSymbol.toUpperCase();
  if (s === "WETH" || s === "ETH") return "ETH";
  if (s === "WBTC" || s === "BTC" || s === "VAULTBTC" || s === "TBTC") return "BTC";
  return null;
}

/** Coinbase spot in USD; null on any failure — callers degrade to "moneyness unknown". */
export async function fetchSpotUsd(asset: "ETH" | "BTC"): Promise<number | null> {
  try {
    const res = await fetch(`https://api.coinbase.com/v2/prices/${asset}-USD/spot`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { amount?: string } };
    const value = Number(data.data?.amount);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export interface Moneyness {
  /** floor divided by spot; > 1 means the floor is above the market price. */
  ratio: number;
  /** In the money for the borrower's default option: floor >= spot. */
  itm: boolean;
}

/**
 * Advisory comparison only — floats are acceptable here because the result never touches
 * identity or amounts, it only decides whether to print a warning.
 */
export function assessMoneyness(floorHuman: string, spotUsd: number): Moneyness | null {
  const floor = Number(floorHuman);
  if (!Number.isFinite(floor) || floor <= 0 || !Number.isFinite(spotUsd) || spotUsd <= 0) return null;
  const ratio = floor / spotUsd;
  return { ratio, itm: ratio >= 1 };
}
