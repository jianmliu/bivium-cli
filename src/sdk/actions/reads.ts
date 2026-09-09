import { parseAbi } from "viem";
import { erc20Abi } from "../abi.ts";
import { formatAmount } from "../math.ts";
import { offerCap, remainingFace, fillCost, sortSide, aggregateLevels, reconcileConsumedEntries, planSweepByFace, makerBackingKey, validateGroups, entryFromSignedOffer, type MakerBacking, type Side } from "../orderbook.ts";
import { fetchRelayerBook } from "../relayer.ts";
import { canonicalHash } from "./preview.ts";
import { tickToPrice } from "../tick.ts";
import { marketParamsFromOffer } from "../offer.ts";
import { RATIFIED } from "../ratify.ts";
import { ZERO_ADDRESS, type Address, type Hex, type MarketState, type Offer, type Position } from "../types.ts";
import { ActionContext, upstream, type ReadContext } from "./context.ts";
import { ActionError, result, type Amount, type Warning } from "./types.ts";

const gateAbi = parseAbi(["function routers() view returns (address[])", "function LENDER_MUST_ROUTE() view returns (bool)"]);
const routerAbi = parseAbi(["function FEE_BPS() view returns (uint256)", "function LENDER_FEE_BPS() view returns (uint256)"]);
export function amount(raw: bigint, decimals: number, token: Address): Amount { return { raw: String(raw), decimals, human: formatAmount(raw, decimals), token }; }
export async function tokenDecimals(service: ActionContext, ctx: ReadContext, token: Address): Promise<number> {
  const decimals = await service.read<number>(ctx, token, erc20Abi, "decimals");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new ActionError("UNSUPPORTED_ACTION", "Token precision is unsupported");
  return decimals;
}
export async function marketDetails(service: ActionContext, marketId: Hex, signal?: AbortSignal) {
  const ctx = await service.pin(ZERO_ADDRESS, signal);
  const market = await service.market(marketId, signal);
  const p = market.params;
  const [loanDecimals, collateralDecimals, state] = await Promise.all([
    tokenDecimals(service, ctx, p.loanToken), tokenDecimals(service, ctx, p.collateralToken), service.core<MarketState>(ctx, "marketState", [market.id]),
  ]);
  const warnings: Warning[] = [];
  let routing: { routers: Address[]; lenderMustRoute: boolean | null } | null = null;
  let fees: { router: Address; borrowerBps: bigint; lenderBps: bigint } | null = null;
  if (p.gate !== ZERO_ADDRESS) {
    try {
      const routers = await service.read<Address[]>(ctx, p.gate, gateAbi, "routers");
      const lenderMustRoute = await service.read<boolean>(ctx, p.gate, gateAbi, "LENDER_MUST_ROUTE").catch(() => null);
      routing = { routers, lenderMustRoute };
      if (lenderMustRoute === null) ctx.snapshot.omitted.push("gate.LENDER_MUST_ROUTE");
    } catch { ctx.snapshot.omitted.push("gate.routing"); }
  }
  const router = service.profile.strategyRouter;
  if (router && (!routing || routing.routers.some((r) => r.toLowerCase() === router.toLowerCase()))) {
    try {
      const [borrowerBps, lenderBps] = await Promise.all([service.read<bigint>(ctx, router, routerAbi, "FEE_BPS"), service.read<bigint>(ctx, router, routerAbi, "LENDER_FEE_BPS")]);
      fees = { router, borrowerBps, lenderBps };
    } catch { ctx.snapshot.omitted.push("router.fees"); }
  }
  if (ctx.snapshot.omitted.length) {
    ctx.snapshot.coverage = "partial";
    warnings.push({ code: "PARTIAL_COVERAGE", severity: "warning", message: "Some route or fee capabilities could not be verified; missing fees are not zero." });
  }
  return result({ marketId: market.id, identity: { chainId: service.profile.chainId, bivium: service.profile.core, ...p }, loanDecimals, collateralDecimals, state, matured: ctx.timestamp >= p.maturity, routing, fees, feeSource: fees ? "chain_at_snapshot" : "unknown", discovery: market.discovery ?? { source: "injected_index", observedAt: null, confirmedThrough: null, coverage: "unknown" } }, ctx.snapshot, warnings);
}
export async function accountState(service: ActionContext, ctx: ReadContext, marketId: Hex, account: Address) {
  const market = await service.market(marketId, ctx.signal);
  const omissions: string[] = [];
  const nullable = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try { return await read(); } catch { omissions.push(`${marketId}.${name}`); return null; }
  };
  const [position, credit, liquidity, collateralEscrow, loanBalance, collateralBalance] = await Promise.all([
    nullable("position", () => service.core<Position>(ctx, "position", [marketId, account])),
    nullable("credit", () => service.core<bigint>(ctx, "creditOf", [marketId, account])),
    nullable("liquidity", () => service.core<bigint>(ctx, "liquidityOf", [marketId, account])),
    nullable("collateralEscrow", () => service.core<bigint>(ctx, "collateralEscrowOf", [marketId, account])),
    nullable("loanBalance", () => service.read<bigint>(ctx, market.params.loanToken, erc20Abi, "balanceOf", [account])),
    nullable("collateralBalance", () => service.read<bigint>(ctx, market.params.collateralToken, erc20Abi, "balanceOf", [account])),
  ]);
  return { marketId, params: market.params, position, credit, liquidity, collateralEscrow, loanBalance, collateralBalance, omissions };
}
export async function accountSnapshot(service: ActionContext, account: Address, marketIds: Hex[], signal?: AbortSignal) {
  if (marketIds.length < 1 || marketIds.length > 20) throw new ActionError("INVALID_ARGUMENT", "Supply 1–20 market IDs");
  const ctx = await service.pin(account, signal);
  const markets = await Promise.all(marketIds.map(async (id) => {
    try { return await accountState(service, ctx, id, account); }
    catch (error) {
      if (error instanceof ActionError && ["DOMAIN_MISMATCH", "MARKET_NOT_FOUND"].includes(error.code)) throw error;
      return { marketId: id, params: null, position: null, credit: null, liquidity: null, collateralEscrow: null, loanBalance: null, collateralBalance: null, omissions: [id] };
    }
  }));
  ctx.snapshot.omitted = markets.flatMap((m) => m.omissions);
  if (markets.every((m) => [m.position, m.credit, m.liquidity, m.collateralEscrow, m.loanBalance, m.collateralBalance].every((value) => value === null))) throw new ActionError("UPSTREAM_UNAVAILABLE", "No account state could be read", true);
  const detailed = await Promise.all(markets.map(async (m) => {
    const { params } = m;
    if (!params) return { marketId: m.marketId, credit: null, liquidity: null, collateralEscrow: null, loanBalance: null, collateralBalance: null, position: null, omissions: m.omissions };
    const [loanDecimals, collateralDecimals] = await Promise.all([
      tokenDecimals(service, ctx, params.loanToken).catch(() => null), tokenDecimals(service, ctx, params.collateralToken).catch(() => null),
    ]);
    const loan = (raw: bigint | null) => raw === null ? null : loanDecimals === null ? { raw: String(raw), decimals: null, human: null, token: params.loanToken } : amount(raw, loanDecimals, params.loanToken);
    const collateral = (raw: bigint | null) => raw === null ? null : collateralDecimals === null ? { raw: String(raw), decimals: null, human: null, token: params.collateralToken } : amount(raw, collateralDecimals, params.collateralToken);
    if (loanDecimals === null || collateralDecimals === null) ctx.snapshot.omitted.push(`${m.marketId}.tokenDecimals`);
    return { marketId: m.marketId, credit: loan(m.credit), liquidity: loan(m.liquidity), collateralEscrow: collateral(m.collateralEscrow), loanBalance: loan(m.loanBalance), collateralBalance: collateral(m.collateralBalance), position: m.position ? { debt: loan(m.position.debt), lockedCollateral: collateral(m.position.collateral), collateralWithdrawable: collateral(m.position.collateralWithdrawable) } : null, omissions: m.omissions };
  }));
  ctx.snapshot.omitted.push("orders signed outside this service; complete outstanding signature inventory unknown");
  ctx.snapshot.coverage = "partial";
  return result({ account, markets: detailed, orderCoverage: "unknown" as const, knownOrderExposure: null }, ctx.snapshot, [{ code: "PARTIAL_COVERAGE", severity: "warning", message: "This snapshot does not prove complete outstanding-order exposure." }]);
}
export async function orderStatus(service: ActionContext, offer: Offer, ratifierData: Hex, commitment?: Hex, signal?: AbortSignal) {
  const ctx = await service.pin(offer.maker, signal);
  const marketId = service.adapter.computeMarketId(service.profile, marketParamsFromOffer(offer));
  await service.market(marketId, signal);
  const actual = service.adapter.offerCommitment(service.profile, offer);
  if (commitment && actual.toLowerCase() !== commitment.toLowerCase()) throw new ActionError("DOMAIN_MISMATCH", "Offer commitment mismatch");
  const [consumed, registered, ratified] = await Promise.all([
    service.core<bigint>(ctx, "consumed", [offer.maker, offer.group]),
    service.core<boolean>(ctx, "isRatifier", [offer.maker, offer.ratifier]),
    service.read<Hex>(ctx, offer.ratifier, service.adapter.ratifierAbi, "isRatified", service.adapter.ratifierArgs(offer.maker, 1n, actual, ratifierData)).catch(() => null),
  ]);
  const cap = offerCap(offer), price = tickToPrice(offer.tick), remainingUnits = remainingFace(offer, consumed, price);
  const withinWindow = ctx.timestamp >= offer.start && ctx.timestamp <= offer.expiry;
  // A precheck cannot establish arbitrary ratifier/gate behavior for every taker and amount.
  return result({ marketId, commitment: actual, cap, consumed, remainingUnits, remainingCost: fillCost(offer, remainingUnits, price), withinWindow, matured: ctx.timestamp >= offer.maturity, ratifierRegistered: registered, ratifierPrecheck: ratified === null ? "unknown" : ratified === RATIFIED ? "ratified_for_probe" : "not_ratified", onchainFillable: "requires_exact_fill_simulation", exhausted: consumed >= cap, exhaustedReason: "unknown_fill_or_cancel", relayerVisibility: "unknown", onchainCancelled: "unknown" }, { ...ctx.snapshot, coverage: "partial", omitted: ["relayer visibility", "exact taker/units simulation", "fill versus cancellation history"] });
}
export async function transactionStatus(service: ActionContext, txHash: Hex, signal?: AbortSignal) {
  const ctx = await service.pin(ZERO_ADDRESS, signal);
  if (!ctx.rpc.getTransactionReceipt || !ctx.rpc.getTransaction) throw new ActionError("UNSUPPORTED_ACTION", "RPC transaction lookup unavailable");
  let status: "unknown" | "pending" | "mined_success" | "mined_reverted" = "unknown";
  let confirmations = 0n;
  let receiptBlock: { number: string; hash: Hex } | null = null;
  try {
    const receipt = await service.limited(() => ctx.rpc.getTransactionReceipt!({ hash: txHash }), signal);
    receiptBlock = { number: String(receipt.blockNumber), hash: receipt.blockHash };
    status = receipt.status === "success" ? "mined_success" : "mined_reverted";
    confirmations = ctx.blockNumber >= receipt.blockNumber ? ctx.blockNumber - receipt.blockNumber + 1n : 0n;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TransactionReceiptNotFoundError") throw upstream(error);
    try {
      const tx = await service.limited(() => ctx.rpc.getTransaction!({ hash: txHash }), signal);
      status = tx.blockNumber === null ? "pending" : "unknown";
    } catch (error) { if (!(error instanceof Error) || error.name !== "TransactionNotFoundError") throw upstream(error); }
  }
  return result({ txHash, status, confirmations, receiptBlock, source: "rpc_receipt_lookup", observedAt: new Date(service.now()).toISOString(), confirmationsAsOfBlock: String(ctx.blockNumber), indexerStatus: "unknown" as const }, { ...ctx.snapshot, coverage: "partial", omitted: ["receipt lookup is independently observed, not pinned to snapshot", "indexer synchronization"] });
}
export async function bookSnapshot(service: ActionContext, marketId: Hex, options: { side?: Side; limit?: number; cursor?: string } = {}, signal?: AbortSignal) {
  const ctx = await service.pin(ZERO_ADDRESS, signal);
  const market = await service.market(marketId, signal);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ActionError("INVALID_ARGUMENT", "Book limit must be 1–100");
  const load = service.options.book ?? (async (params, signal) => {
    if (!service.profile.relayerUrl) throw new ActionError("UPSTREAM_UNAVAILABLE", "No orderbook source configured");
    const ratifiers = [...new Set([service.profile.signatureRatifier, service.profile.setterRatifier].filter((r): r is Address => !!r))];
    const books = await Promise.all(ratifiers.map((ratifier) => fetchRelayerBook({ ...service.profile, relayerUrl: service.profile.relayerUrl!, ratifier }, params, { nowSec: ctx.timestamp, signal })));
    if (books.some((b) => !b.ok)) throw new ActionError("UPSTREAM_UNAVAILABLE", "At least one ratifier book is unavailable", true);
    return { entries: books.flatMap((b) => b.ok ? b.entries : []), source: service.profile.relayerUrl!, observedAt: new Date(service.now()).toISOString(), coverage: "unknown" as const };
  });
  const loaded = await load(market.params, signal);
  const unique = new Map<string, typeof loaded.entries[number]>();
  for (const entry of loaded.entries) {
    if (service.adapter.computeMarketId(service.profile, marketParamsFromOffer(entry.offer)).toLowerCase() !== marketId.toLowerCase() || service.adapter.offerCommitment(service.profile, entry.offer).toLowerCase() !== entry.commitment.toLowerCase()) throw new ActionError("DOMAIN_MISMATCH", "Book entry identity mismatch");
    unique.set(entry.commitment.toLowerCase(), entryFromSignedOffer(entry.offer, entry.commitment, entry.signature));
  }
  validateGroups([...unique.values()]);
  const active = [...unique.values()].filter((entry) => entry.offer.start <= ctx.timestamp && ctx.timestamp <= entry.offer.expiry);
  const sorted = [...sortSide(active, "bid"), ...sortSide(active, "ask")].filter((e) => !options.side || e.side === options.side);
  const binding = canonicalHash([service.profile.chainId, service.profile.core.toLowerCase(), marketId.toLowerCase(), options.side, sorted.map((e) => e.commitment)]);
  let offset = 0;
  if (options.cursor) {
    const [previous, rawOffset] = options.cursor.split(":");
    offset = Number(rawOffset);
    if (previous !== binding || !Number.isSafeInteger(offset) || offset < 0) throw new ActionError("INVALID_ARGUMENT", "Book cursor does not match current collection");
  }
  // Cap RPC work independently of untrusted relayer collection size; one page is not whole-account depth.
  const page = sorted.slice(offset, offset + limit);
  const consumed = await Promise.all(page.map((e) => service.core<bigint>(ctx, "consumed", [e.maker, e.offer.group])));
  const reconciled = reconcileConsumedEntries(page, consumed);
  if (!reconciled.ready) throw new ActionError("UPSTREAM_UNAVAILABLE", "Missing consumed data; no execution capacity available", true);
  const backing = new Map<string, MakerBacking>();
  for (const entry of reconciled.entries) {
    const key = makerBackingKey(entry);
    if (backing.has(key)) continue;
    const [liquidity, credit, escrow] = await Promise.all([service.core<bigint>(ctx, "liquidityOf", [marketId, entry.maker]), service.core<bigint>(ctx, "creditOf", [marketId, entry.maker]), service.core<bigint>(ctx, "collateralEscrowOf", [marketId, entry.maker])]);
    backing.set(key, { liquidity, credit, escrow: ctx.timestamp < market.params.maturity ? escrow : 0n });
  }
  const capacity = ["bid", "ask"].flatMap((side) => {
    const entries = sortSide(reconciled.entries, side as Side);
    return planSweepByFace(entries, entries.reduce((sum, entry) => sum + entry.size, 0n), backing).takes.map((t) => ({ ...t.entry, size: t.units }));
  });
  return result({ marketId, entries: page, nextCursor: offset + limit < sorted.length ? `${binding}:${offset + limit}` : null, rawAdvertisedDepth: ["bid", "ask"].flatMap((side) => aggregateLevels(sortSide(page, side as Side)).map((level) => ({ ...level, side }))), conservativeCapacityDepth: ["bid", "ask"].flatMap((side) => aggregateLevels(sortSide(capacity, side as Side)).map((level) => ({ ...level, side }))), executableDepth: null, source: loaded.source, sourceObservedAt: loaded.observedAt ?? null, sourceCoverage: loaded.coverage ?? "unknown" }, { ...ctx.snapshot, coverage: "partial", omitted: ["exact taker, ratifier and gate simulation", "orders outside returned page and signatures absent from relayer"] }, [{ code: "CAPACITY_ONLY", severity: "warning", message: "Capacity is bounded by consumed and maker backing, but exact fills still need signature/gate verification and simulation. Side scenarios are alternatives, not simultaneous reservations." }]);
}
