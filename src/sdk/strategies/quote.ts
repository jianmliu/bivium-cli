// quote(): the five numbers an agent (or a confirm screen) needs before executing —
// worstCase, prepay, breakEven, exerciseProbability, payoff[] — for a RESOLVED strategy at a fill
// price. Preview and execute are separate calls: this one never touches the chain.
import { computeMarketId } from "../market.ts";
import {
  borrowSellPayoff,
  lendAssetPayoff,
  lendQuotePayoff,
  leveredLongPayoff,
  protectivePutPayoff,
} from "./payoff.ts";
import { exerciseProbability } from "./probability.ts";
import type { QuoteInputs, StrategyQuote } from "./types.ts";

const DAY = 86_400n;

export function quoteStrategy(q: QuoteInputs, size: bigint): StrategyQuote {
  const r = q.resolution;
  const dec = { assetDecimals: r.assetDecimals, numeraireDecimals: r.numeraireDecimals };
  const days = Number((r.row.market.params.maturity - q.now) * 1000n / DAY) / 1000;
  const probability = q.sigmaAnnual === undefined ? null : exerciseProbability(r.realizedBufferPct, q.sigmaAnnual, days);
  const base = {
    strategyId: r.strategy.id,
    marketId: computeMarketId(r.row.market.params),
    maturity: r.row.market.params.maturity,
    side: r.side,
    exerciseProbability: probability,
    asset: r.asset,
    numeraire: r.numeraire,
    estimateBasis: "spot" as const,
  };

  switch (r.strategy.id) {
    case "short":
    case "pairShort": {
      const p = borrowSellPayoff({ units: size, priceWad: q.priceWad, spot: q.spot, strike: r.strike, ...dec });
      return { ...base, units: size, prepay: p.prepay, premium: p.premium, payoff: p.payoff };
    }
    case "leveredLong": {
      const borrowFace = q.borrowFace ?? maxBorrowFor(size, r.strike);
      const p = leveredLongPayoff({ holding: size, borrowFace, priceWad: q.priceWad, spot: q.spot, strike: r.strike, ...dec });
      return { ...base, units: borrowFace, prepay: p.topUp, premium: p.premium, payoff: p.payoff };
    }
    case "protectivePut": {
      const p = protectivePutPayoff({ holding: size, borrowFace: q.borrowFace, priceWad: q.priceWad, spot: q.spot, strike: r.strike, ...dec });
      return { ...base, units: p.borrowFace, prepay: size, premium: p.premium, payoff: p.payoff };
    }
    case "lendAsset": {
      const p = lendAssetPayoff({ units: size, priceWad: q.priceWad, spot: q.spot, strike: r.strike, ...dec });
      return { ...base, units: size, prepay: p.lent, premium: p.premium, payoff: p.payoff };
    }
    case "lendQuote": {
      const p = lendQuotePayoff({ face: size, priceWad: q.priceWad, spot: q.spot, strike: r.strike, ...dec });
      return { ...base, units: size, prepay: p.lent, premium: p.premium, payoff: p.payoff };
    }
    default:
      throw new Error(`strategy ${r.strategy.id} is not quotable as one unit yet`);
  }
}

/** Max numeraire face the strike allows against `holding` of collateral. */
function maxBorrowFor(holding: bigint, strike: bigint): bigint {
  // debtForCollateral, inlined to keep quote.ts free of a math import cycle.
  return (holding * strike) / 10n ** 36n;
}
