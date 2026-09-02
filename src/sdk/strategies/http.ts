// The L2 data plane over HTTP: bivium-frontend's /api/strategies/* Functions are the surface humans and remote
// agents read, so the numbers THEY see come from there. This SDK recomputes locally to build transactions; the
// two must agree, and `quoteParity` says whether they do — the runtime twin of the golden vectors in CI.
import type { GatheredStrategy } from "./gather.ts";

export interface HttpQuote {
  kind: string;
  side: "borrow" | "lend";
  market: { key: string; marketId: string; maturity: string };
  asset: string;
  numeraire: string;
  spot: number;
  strike: number;
  bufferPct: number;
  filledAtoms: string;
  partial: boolean;
  takes: number;
  premium: number;
  prepay: number;
  prepayUnit: "numeraire" | "asset";
  exerciseProbability: number | undefined;
  payoff: { worstCase: number; worstCaseForm: string; bestCase: number | undefined; breakEven: number | undefined; boundary: number };
}
export interface HttpQuoteSpec {
  kind: string;
  asset: string;
  counter?: string;
  size: string;
  maturity?: bigint;
  bufferPct?: number;
  sigmaAnnual?: number;
}
export type HttpQuoteResult = { ok: true; quote: HttpQuote } | { ok: false; reason: string };
export type HttpQuoteLoader = (spec: HttpQuoteSpec) => Promise<HttpQuoteResult>;

const base = (relayerUrl: string) => relayerUrl.replace(/\/$/, "");

/** POST /api/strategies/quote — the number the app shows. A down endpoint is a reason, never a quote. */
export async function fetchHttpQuote(relayerUrl: string | undefined, spec: HttpQuoteSpec): Promise<HttpQuoteResult> {
  if (!relayerUrl) return { ok: false, reason: "profile has no relayerUrl" };
  try {
    const res = await fetch(`${base(relayerUrl)}/strategies/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...spec, maturity: spec.maturity?.toString() }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = (await res.json()) as { quote?: HttpQuote; error?: string };
    if (!res.ok || !body.quote) return { ok: false, reason: body.error ?? `http ${res.status}` };
    return { ok: true, quote: body.quote };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "fetch failed" };
  }
}

export interface HttpPosition {
  key: string;
  marketId: string;
  line: string;
  side: "borrow" | "lend" | "maker";
  kinds: string[];
  maturity: string;
  secondsToMaturity: number;
  matured: boolean;
  urgent: boolean;
  debt: number;
  collateral: number;
  credit: number;
  liquidity: number;
  bufferPct: number | undefined;
  branches: { collateralValueLoan: number; netFromRepaying: number; better: "repay" | "deliver" } | undefined;
  lenderOutcome: "repaid" | "assigned" | undefined;
  exit: { action: string; note: string };
  autoSettle?: { armed: boolean; keepBps: number };
}
export type HttpPositionsResult = { ok: true; taker: string; at: number; positions: HttpPosition[]; marketsScanned: number } | { ok: false; reason: string };

/** GET /api/strategies/positions?taker= — holdings read as strategies, the same view the app's Portfolio shows. */
export async function fetchStrategyPositions(relayerUrl: string | undefined, taker: string): Promise<HttpPositionsResult> {
  if (!relayerUrl) return { ok: false, reason: "profile has no relayerUrl" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(taker)) return { ok: false, reason: "taker must be an address" };
  try {
    const res = await fetch(`${base(relayerUrl)}/strategies/positions?taker=${taker}`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { positions?: HttpPosition[]; at?: number; marketsScanned?: number; error?: string };
    if (!res.ok || !Array.isArray(body.positions)) return { ok: false, reason: body.error ?? `http ${res.status}` };
    return { ok: true, taker, at: body.at ?? 0, positions: body.positions, marketsScanned: body.marketsScanned ?? 0 };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "fetch failed" };
  }
}

export interface ParityCheck { field: string; local: number; http: number; ok: boolean }
export type QuoteParity =
  | { status: "ok" | "mismatch"; checks: ParityCheck[]; marketId: string }
  | { status: "skipped" | "unavailable"; reason: string };

const REL_TOL = 1e-6;
const close = (a: number, b: number, absFloor: number) => Math.abs(a - b) <= Math.max(REL_TOL * Math.max(Math.abs(a), Math.abs(b)), absFloor);

/**
 * Compare the local quote with the app's. Only meaningful on the same price basis: the local quote prices at
 * the best resting level, so a sweep that crossed more than one level (or filled partially) is `skipped`, not
 * judged. A different market resolution is a mismatch outright — the two lenses disagree about which rung the
 * view lands on, which is worse than a rounding gap.
 */
export function quoteParity(local: GatheredStrategy, http: HttpQuoteResult, opts: { pricedOffBook?: boolean } = {}): QuoteParity {
  if (opts.pricedOffBook) return { status: "skipped", reason: "local quote priced at an explicit price/APR, not the book" };
  if (!http.ok) return { status: "unavailable", reason: http.reason };
  const q = http.quote;
  if (q.market.marketId.toLowerCase() !== local.quote.marketId.toLowerCase()) {
    return { status: "mismatch", marketId: q.market.marketId, checks: [{ field: "marketId", local: 0, http: 1, ok: false }] };
  }
  if (q.takes !== 1 || q.partial) return { status: "skipped", reason: `app quote swept ${q.takes} level(s)${q.partial ? ", partial" : ""}; local prices the best level only` };
  const nd = local.res.numeraireDecimals, ad = local.res.assetDecimals;
  const human = (atoms: bigint, dec: number) => Number(atoms) / 10 ** dec;
  const prepayDec = q.prepayUnit === "asset" ? ad : nd;
  const checks: ParityCheck[] = [
    { field: "prepay", local: human(local.quote.prepay, prepayDec), http: q.prepay, ok: false },
    { field: "premium", local: human(local.quote.premium, nd), http: q.premium, ok: false },
    { field: "worstCase", local: human(local.quote.payoff.worstCase.amount, nd), http: q.payoff.worstCase, ok: false },
    { field: "boundary", local: Number(local.quote.payoff.boundary) / 1e18, http: q.payoff.boundary, ok: false },
  ];
  if (local.quote.payoff.breakEven !== null && q.payoff.breakEven !== undefined) {
    checks.push({ field: "breakEven", local: Number(local.quote.payoff.breakEven) / 1e18, http: q.payoff.breakEven, ok: false });
  }
  if (local.quote.exerciseProbability !== null && q.exerciseProbability !== undefined) {
    checks.push({ field: "exerciseProbability", local: local.quote.exerciseProbability, http: q.exerciseProbability, ok: false });
  }
  // Amounts and prices must agree to the atom / 1e-9; the probability is measured at each side's own `now`, so a
  // few seconds between the two requests moves σ√t (observed ~4e-6 live) — 1e-4 absolute is far above that jitter
  // and far below any real formula disagreement (moving the boundary shifted a levered long by ~0.18).
  for (const c of checks) c.ok = close(c.local, c.http, c.field === "exerciseProbability" ? 1e-4 : 10 ** -(c.field === "boundary" || c.field === "breakEven" ? 9 : Math.min(nd, ad)) * 2);
  return { status: checks.every((c) => c.ok) ? "ok" : "mismatch", checks, marketId: q.market.marketId };
}
