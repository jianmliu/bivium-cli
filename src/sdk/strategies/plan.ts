// buildPlan(): a strategy quote → an ORDERED, BOUNDED execution plan. Three modes share one set of
// hard limits (maxLoss / minOut / deadline / a quoteId as idempotency key):
//   intent     — single leg, no swap → a signable EIP-712 intent (agent-preferred, gasless);
//   router     — a swap leg + a deployed StrategyRouter → one atomic call;
//   sequential — a swap leg but NO Router → approve → fill → swap as separate txs, explicitly non-atomic.
// This module only BUILDS the plan (data). Execution stays with the existing client / trade paths.
import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Hex, Offer } from "../types.ts";
import type { Plan, PlanStep, StrategyQuote, StrategyResolution } from "./types.ts";

export interface PlanOptions {
  now: bigint;
  /** Seconds the plan (and its quoteId) stays valid. */
  ttlSeconds?: bigint;
  /** Deployed StrategyRouter, if any. Absent → swap strategies fall back to `sequential`. */
  router?: Address;
  /** The lender bid(s) / ask(s) the fill will take, from the existing sweep planner. */
  offers?: Offer[];
  /** Swap route for the swap leg; minOut is the only field the plan needs. */
  swap?: { sellToken: Address; buyToken: Address; minOut: bigint };
  core: Address;
}

export function quoteId(res: StrategyResolution, quote: StrategyQuote, now: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [res.strategy.id, quote.marketId, quote.units, quote.prepay, now],
    ),
  );
}

export function buildPlan(res: StrategyResolution, quote: StrategyQuote, opts: PlanOptions): Plan {
  const s = res.strategy;
  const needsSwap = s.requires.includes("swap");
  const mode: Plan["mode"] = !needsSwap ? "intent" : opts.router ? "router" : "sequential";
  const validUntil = opts.now + (opts.ttlSeconds ?? 600n);
  const steps: PlanStep[] = [];
  const market = res.row.market.params;

  if (mode === "router") {
    steps.push({
      kind: "grant-auth",
      spender: opts.router,
      note: "grantAuthorization(router, CAP_FILL | CAP_WITHDRAW_COLLATERAL, expiry) — or grantAuthorizationBySig in the same tx",
    });
  }

  switch (s.id) {
    case "short":
    case "pairShort": {
      steps.push({ kind: "approve", token: res.numeraire, spender: mode === "router" ? opts.router : opts.core, amount: quote.prepay, note: "top-up collateral (= worst case)" });
      steps.push({ kind: "fill-bid", market, units: quote.units, offer: opts.offers?.[0], note: "borrow the asset; receiver = router (or self in sequential mode)" });
      steps.push({ kind: "swap", sellToken: res.asset, buyToken: res.numeraire, minOut: opts.swap?.minOut, note: "sell the borrowed asset; proceeds + top-up = collateral" });
      break;
    }
    case "leveredLong": {
      steps.push({ kind: "approve", token: res.asset, spender: mode === "router" ? opts.router : opts.core, amount: quote.prepay, note: "pledge holding (+ top-up)" });
      steps.push({ kind: "fill-bid", market, units: quote.units, offer: opts.offers?.[0], note: "borrow numeraire; receiver = router" });
      steps.push({ kind: "swap", sellToken: res.numeraire, buyToken: res.asset, minOut: opts.swap?.minOut, note: "buy more asset; holding + bought = collateral" });
      break;
    }
    case "protectivePut": {
      steps.push({ kind: "approve", token: res.asset, spender: opts.core, amount: quote.prepay, note: "pledge holding" });
      steps.push({ kind: "fill-bid", market, units: quote.units, offer: opts.offers?.[0], note: "borrow numeraire to the user's wallet — no swap" });
      break;
    }
    case "lendAsset":
    case "lendQuote": {
      steps.push({ kind: "approve", token: s.id === "lendAsset" ? res.asset : res.numeraire, spender: opts.core, amount: quote.prepay, note: "the principal lent now" });
      steps.push({ kind: "fill-ask", market, units: quote.units, offer: opts.offers?.[0], note: "Lend now: eat the ask (or rest a rate order)" });
      break;
    }
    default:
      throw new Error(`strategy ${s.id} has no single-unit plan yet (needs the Router)`);
  }

  return {
    mode,
    strategyId: s.id,
    steps,
    limits: {
      // maxLoss = maxTopUp + premium for borrow-and-sell (which IS the prepay); the stake for longs;
      // the principal lent for lenders. In every case it is |worstCase| — the one number the user saw.
      maxLoss: quote.payoff.worstCase.amount < 0n ? -quote.payoff.worstCase.amount : 0n,
      minOut: opts.swap?.minOut,
      deadline: validUntil,
    },
    worstCase: quote.payoff.worstCase.amount,
    prepay: quote.prepay,
    quoteId: quoteId(res, quote, opts.now),
    validUntil,
  };
}
