// Input gathering for the strategy engine — the ONE implementation the CLI, the MCP server and an
// HTTP API all call. It turns a user's view (strategy, asset, size, tenor, buffer) plus a pricing
// choice into a resolved market + quote, fetching only what the engine needs: discovered markets,
// the pair feed's spot (re-oriented to "numeraire per whole asset"), and a fill price (an explicit
// WAD, a target simple APR, or the live book's best bid/ask). Errors are thrown, never printed.
import type { BiviumClient } from "../client.ts";
import { discoverMarketsOnChain, fetchRelayerMarkets, type DiscoveredMarket } from "../discovery.ts";
import { formatAmount, parseAmount } from "../math.ts";
import { sortSide, type BookEntry } from "../orderbook.ts";
import { resolveToken } from "../profile.ts";
import { fetchRelayerBook, requireRelayerV2, type RelayerDomain } from "../relayer.ts";
import { fetchPairRatio, pairFor } from "../spot.ts";
import { priceFromSimpleAprBps } from "../tick.ts";
import type { Address, DeploymentProfile, MarketParams } from "../types.ts";
import { getStrategy } from "./catalog.ts";
import { classifyLine, humanStrike, orientation } from "./lines.ts";
import { buildPlan } from "./plan.ts";
import { quoteStrategy } from "./quote.ts";
import { resolveStrategy } from "./resolve.ts";
import type { Line, Plan, PoolRow, PxWad, StrategyQuote, StrategyResolution } from "./types.ts";
import { fetchHttpQuote, quoteParity, type HttpQuoteLoader, type QuoteParity } from "./http.ts";

export interface MarketSource {
  /** Default: relayer when the profile has one, else chain. */
  source?: "relayer" | "chain";
  /** Chain scans start here; default: profile.coreDeploymentBlock. */
  fromBlock?: bigint;
  /** getLogs range per call for chain scans (default 900; raise it when the RPC allows wide ranges). */
  chunkSize?: bigint;
}

/** Discovered markets — the same sources as `market list`. A down index is an error, not an empty set. */
export async function loadDiscoveredMarkets(
  profile: DeploymentProfile,
  client: BiviumClient | undefined,
  opts: MarketSource = {},
): Promise<DiscoveredMarket[]> {
  const source = opts.source ?? (profile.relayerUrl ? "relayer" : "chain");
  if (source === "relayer") {
    const result = await fetchRelayerMarkets(profile);
    if (!result.ok) throw new Error(`relayer market index unavailable — not an empty market set: ${result.reason}`);
    if (result.suspiciousEmpty) throw new Error("index reports full coverage but zero markets — likely a lineage mismatch; use source=chain");
    return result.markets;
  }
  if (!client) throw new Error("a chain scan needs a BiviumClient");
  const fromBlock = opts.fromBlock ?? (profile.coreDeploymentBlock === undefined ? undefined : BigInt(profile.coreDeploymentBlock));
  if (fromBlock === undefined) throw new Error("profile has no coreDeploymentBlock — pass fromBlock");
  return await discoverMarketsOnChain(client, { fromBlock, chunkSize: opts.chunkSize });
}

/** Decorate markets with profile symbols/decimals (unknown tokens: exact decimals from the chain). */
export async function poolRowsFor(
  profile: DeploymentProfile,
  client: BiviumClient | undefined,
  markets: DiscoveredMarket[],
): Promise<PoolRow[]> {
  const by = new Map(Object.entries(profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), { sym, dec: t.decimals }]));
  const decimals = async (token: Address): Promise<number> => {
    const known = by.get(token.toLowerCase());
    if (known) return known.dec;
    if (!client) throw new Error(`token ${token} is not in the profile and no client is available to read its decimals`);
    return await client.tokenDecimals(token);
  };
  const rows: PoolRow[] = [];
  for (const m of markets) {
    rows.push({
      market: m,
      loanSymbol: by.get(m.params.loanToken.toLowerCase())?.sym,
      collateralSymbol: by.get(m.params.collateralToken.toLowerCase())?.sym,
      loanDecimals: await decimals(m.params.loanToken),
      collateralDecimals: await decimals(m.params.collateralToken),
    });
  }
  return rows;
}

export interface SpotRef {
  /** Numeraire per whole asset, WAD — advisory; every derived figure is an estimate. */
  px: PxWad;
  status: "ready" | "stale";
  pair: string;
  /** Annualised realised σ when the feed serves it (`stat=sigma21d`); absent until it does. */
  sigmaAnnual?: number;
}

/**
 * Spot in the strategy's own orientation. The pair feed answers loan-per-collateral, which IS
 * "numeraire per asset" on the credit line and its reciprocal on options/exchange.
 */
export async function spotPxFor(
  relayerUrl: string | undefined,
  line: Line,
  loanSymbol: string | undefined,
  collateralSymbol: string | undefined,
): Promise<SpotRef> {
  const pair = pairFor(collateralSymbol, loanSymbol);
  if (!pair) throw new Error("cannot name the spot pair — both legs must be profile token symbols");
  const ratio = await fetchPairRatio(relayerUrl, pair, { stat: "sigma21d" });
  if (!ratio) throw new Error(`spot unavailable for ${pair} (profile.relayerUrl /spot) — the engine cannot place a strike buffer without it`);
  const x = line === "credit" ? ratio.loanPerCollateral : 1 / ratio.loanPerCollateral;
  return { px: parseAmount(x.toFixed(18), 18), status: ratio.status, pair, ...(ratio.sigma21d !== undefined ? { sigmaAnnual: ratio.sigma21d } : {}) };
}

export interface BookLoad {
  entries: BookEntry[];
  source: string;
}
export type BookLoader = (params: MarketParams) => Promise<BookLoad>;

/** The relayer's signed book for one market. A down relayer is an error, not an empty book. */
export function relayerBookLoader(profile: DeploymentProfile): BookLoader {
  return async (params) => {
    if (!profile.relayerUrl) throw new Error("profile has no relayerUrl — no book to price from; pass aprBps or priceWad");
    requireRelayerV2(profile.abiProfile);
    const domain: RelayerDomain = {
      chainId: profile.chainId,
      core: profile.core,
      abiProfile: profile.abiProfile,
      signatureRatifier: profile.signatureRatifier,
      relayerUrl: profile.relayerUrl,
    };
    const result = await fetchRelayerBook(domain, params);
    if (!result.ok) throw new Error(`relayer unavailable — not an empty book: ${result.reason}`);
    return { entries: result.entries, source: profile.relayerUrl };
  };
}

export interface GatherRequest {
  strategy: string;
  /** Profile symbol or address. */
  asset: string;
  counter?: string;
  /** Human amount in the asset's units (numeraire units for lendQuote). */
  size: string;
  maturity: bigint;
  /** Strike distance from spot in the OTM direction, percent, positive = OTM. */
  bufferPct: number;
  /** Pricing, in precedence order: explicit WAD, target simple APR (bps), else the live book. */
  priceWad?: bigint;
  aprBps?: bigint;
  /** Overrides the feed's σ (annualised, e.g. 7.11). */
  sigmaAnnual?: number;
  market?: MarketSource;
  /** Book source for the live-book price; default: the profile's relayer. */
  book?: BookLoader;
  now?: bigint;
  /** Injection points (tests, or a caller that already holds them): skip discovery / the feed. */
  rows?: PoolRow[];
  spot?: SpotRef;
  /**
   * Parity with the app's quote (POST /api/strategies/quote): the number a human sees comes from there, this
   * SDK recomputes to build transactions, and the two must agree. Default: the profile's relayer; `false`
   * skips; a loader injects (tests).
   */
  parity?: HttpQuoteLoader | false;
}

export interface GatheredStrategy {
  res: StrategyResolution;
  quote: StrategyQuote;
  spot: PxWad;
  spotStatus: "ready" | "stale";
  pair: string;
  priceWad: bigint;
  priceFrom: string;
  size: bigint;
  now: bigint;
  sigmaSource: "request" | "feed" | "none";
  /** Agreement with the app's own quote — the runtime twin of the golden vectors. */
  parity: QuoteParity;
}

export async function gatherStrategyInputs(
  profile: DeploymentProfile,
  client: BiviumClient | undefined,
  req: GatherRequest,
): Promise<GatheredStrategy> {
  const strategy = getStrategy(req.strategy);
  const asset = resolveToken(profile, req.asset);
  const counter = req.counter ? resolveToken(profile, req.counter) : undefined;
  if (!Number.isFinite(req.bufferPct)) throw new Error("bufferPct must be a number (percent, positive = OTM)");
  const now = req.now ?? BigInt(Math.floor(Date.now() / 1000));
  if (req.maturity <= now) throw new Error("maturity is in the past");

  const rows = req.rows ?? (await poolRowsFor(profile, client, await loadDiscoveredMarkets(profile, client, req.market)));
  // One spot fetch: any row on this line that carries the asset names the pair.
  const probe = rows.find((r) => classifyLine(r.loanSymbol, r.collateralSymbol) === strategy.line && orientation(strategy.line, r).asset.toLowerCase() === asset.address.toLowerCase());
  if (!probe) throw new Error(`no ${strategy.line}-line market carries ${asset.symbol ?? asset.address}`);
  const spot = req.spot ?? (await spotPxFor(profile.relayerUrl, strategy.line, probe.loanSymbol, probe.collateralSymbol));

  const res = resolveStrategy({ strategyId: strategy.id, asset: asset.address, counter: counter?.address, size: 0n, maturity: req.maturity, bufferPct: req.bufferPct }, rows, spot.px);
  const sizeDecimals = strategy.id === "lendQuote" ? res.numeraireDecimals : res.assetDecimals;
  const size = parseAmount(req.size, sizeDecimals);

  let priceWad: bigint;
  let priceFrom: string;
  if (req.priceWad !== undefined) {
    if (req.priceWad <= 0n) throw new Error("priceWad must be positive (1e18 = par)");
    priceWad = req.priceWad;
    priceFrom = "priceWad";
  } else if (req.aprBps !== undefined) {
    priceWad = priceFromSimpleAprBps(req.aprBps, req.maturity - now);
    priceFrom = `aprBps ${req.aprBps.toString()}`;
  } else {
    const { entries, source } = await (req.book ?? relayerBookLoader(profile))(res.row.market.params);
    const side = res.side === "borrow" ? "bid" : "ask";
    const best = sortSide(entries, side)[0];
    if (!best) throw new Error(`no resting ${side} on the resolved market (${source}) — pass aprBps or priceWad to quote a target rate`);
    priceWad = best.price;
    priceFrom = `best ${side} on ${source} (tick ${best.offer.tick.toString()}, ${formatAmount(best.size, res.side === "borrow" ? res.assetDecimals : res.numeraireDecimals)} face)`;
  }

  let sigmaAnnual = req.sigmaAnnual;
  let sigmaSource: GatheredStrategy["sigmaSource"] = "request";
  if (sigmaAnnual === undefined && spot.sigmaAnnual !== undefined) {
    sigmaAnnual = spot.sigmaAnnual;
    sigmaSource = "feed";
  }
  if (sigmaAnnual === undefined) sigmaSource = "none";
  if (sigmaAnnual !== undefined && !(Number.isFinite(sigmaAnnual) && sigmaAnnual > 0)) throw new Error("sigmaAnnual must be a positive annualised volatility (e.g. 7.11 for 711%)");

  const quote = quoteStrategy({ resolution: res, priceWad, spot: spot.px, sigmaAnnual, now }, size);
  const gathered = { res, quote, spot: spot.px, spotStatus: spot.status, pair: spot.pair, priceWad, priceFrom, size, now, sigmaSource } as GatheredStrategy;

  // Parity: only on the live-book basis (an explicit price or APR has no app-side counterpart), only when a
  // loader exists. Never fatal — a missing app is "unavailable"; a disagreeing one is a loud "mismatch".
  const pricedOffBook = req.priceWad !== undefined || req.aprBps !== undefined;
  const loader: HttpQuoteLoader | undefined = req.parity === false ? undefined : req.parity ?? (profile.relayerUrl ? (spec) => fetchHttpQuote(profile.relayerUrl, spec) : undefined);
  if (!loader) gathered.parity = { status: "skipped", reason: req.parity === false ? "parity disabled" : "profile has no relayerUrl" };
  else if (pricedOffBook) gathered.parity = quoteParity(gathered, { ok: false, reason: "n/a" }, { pricedOffBook: true });
  else {
    const counterSymbol = counter ? (counter.symbol ?? counter.address) : undefined;
    gathered.parity = quoteParity(gathered, await loader({
      kind: strategy.id, asset: asset.symbol ?? asset.address, counter: counterSymbol, size: req.size, maturity: req.maturity, bufferPct: req.bufferPct, sigmaAnnual,
    }));
  }
  return gathered;
}

/** What the user puts in, per strategy — the unit of `quote.prepay`. */
export function prepayIsAsset(strategyId: string): boolean {
  return strategyId === "leveredLong" || strategyId === "protectivePut" || strategyId === "lendAsset";
}

/** JSON-safe (bigints remain bigints here; serialise with a replacer) summary shared by --json and the MCP. */
export function gatheredToJson(g: GatheredStrategy): Record<string, unknown> {
  const { res, quote } = g;
  return {
    strategy: res.strategy.id,
    market: {
      id: quote.marketId,
      params: res.row.market.params,
      line: res.line,
      side: res.side,
      strikeHuman: res.strikeHuman,
      realizedBufferPct: res.realizedBufferPct,
      alternatives: res.alternatives.map((r) => ({ id: r.market.id, strike: r.market.params.strike, strikeHuman: humanStrike(res.line, r.market.params.strike, r.loanDecimals, r.collateralDecimals) })),
    },
    asset: res.asset,
    numeraire: res.numeraire,
    assetDecimals: res.assetDecimals,
    numeraireDecimals: res.numeraireDecimals,
    spot: g.spot,
    spotStatus: g.spotStatus,
    pair: g.pair,
    priceWad: g.priceWad,
    priceFrom: g.priceFrom,
    size: g.size,
    prepayToken: prepayIsAsset(res.strategy.id) ? res.asset : res.numeraire,
    sigmaSource: g.sigmaSource,
    parity: g.parity,
    quote,
  };
}

export interface PlanRequest {
  /** Deployed StrategyRouter, if any. */
  router?: Address;
  /** Human amount; required when the strategy has a swap leg. */
  minOut?: string;
  ttlSeconds?: bigint;
}

/** The bounded plan for a gathered quote — swap direction and the minOut unit follow the strategy. */
export function planFromGathered(profile: DeploymentProfile, g: GatheredStrategy, req: PlanRequest = {}): Plan {
  const s = g.res.strategy;
  const needsSwap = s.requires.includes("swap");
  const buysAsset = s.id === "leveredLong"; // the swap BUYS the asset; every other swap sells it
  const minOut = req.minOut === undefined ? undefined : parseAmount(req.minOut, buysAsset ? g.res.assetDecimals : g.res.numeraireDecimals);
  if (needsSwap && minOut === undefined) throw new Error("this strategy has a swap leg: minOut is required (the swap's floor is a hard limit of the plan)");
  const swap = needsSwap
    ? buysAsset
      ? { sellToken: g.res.numeraire, buyToken: g.res.asset, minOut: minOut! }
      : { sellToken: g.res.asset, buyToken: g.res.numeraire, minOut: minOut! }
    : undefined;
  return buildPlan(g.res, g.quote, { now: g.now, core: profile.core, router: req.router, swap, ttlSeconds: req.ttlSeconds });
}
