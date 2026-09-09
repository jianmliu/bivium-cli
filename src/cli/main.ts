#!/usr/bin/env node
// bivium — CLI over the Bivium SDK (core-v1 lineage). See docs/spec/2026-08-09-bivium-cli-spec.md.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  adapterFor,
  BiviumClient,
  assessMoneyness,
  askBackingShortfall,
  discoverMarketsOnChain,
  fetchRelayerMarkets,
  principalForUnits,
  type DiscoveredMarket,
  fetchPairRatio,
  floorFromStrike,
  pairFor,
  createWalletFile,
  gasFaucetAbi,
  readKeyFile,
  buildSignedOfferFile,
  formatAmount,
  loadProfile,
  marketParamsFromOffer,
  offerCommitment,
  debtForCollateral,
  parseAmount,
  parseSignedOfferFile,
  priceFromSimpleAprBps,
  priceToTick,
  ratifyDigest,
  buildOfferTree,
  encodeProofRatifierData,
  resolveRatifier,
  type RatifierKind,
  resolveToken,
  strikeFromFloor,
  tickToPrice,
  VaultAppClient,
  lotStatusName,
  lotIsBound,
  RATIFIED,
  ZERO_ADDRESS,
  aggregateLevels,
  entryFromSignedOffer,
  fetchRelayerBook,
  offerCap,
  publishSignedOffer,
  remainingFace,
  requireRelayerV2,
  simpleAprBpsFromPrice,
  sortSide,
  TradeClient,
  type BookEntry,
  type DepthLevel,
  type RelayerDomain,
  type TradePlan,
  type TradePlanRequest,
  type Address,
  type DeploymentProfile,
  type Hex,
  type MarketParams,
  type Offer,
} from "../sdk/index.ts";
import { fetchStrategyPositions } from "../sdk/strategies/http.ts";
import { SettlerClient, grantCoversSettler, keepPercentToBps, maxSettleableFloor, maxSettleableKeptBps, poolKeyFor } from "../sdk/settler.ts";
import { StrategyRouterClient, programNeedsGrant } from "../sdk/strategyRouter.ts";
import { buildOpenProgram, buildUnwindProgram, defaultUnwindVia, fillCost, type Leg } from "../sdk/strategies/program.ts";
import { poolKeyCarries, swapCeiling, swapFloor } from "../sdk/strategies/pools.ts";
import { classifyLine, orientation } from "../sdk/strategies/lines.ts";
import { getStrategy } from "../sdk/strategies/catalog.ts";
import { computeMarketId } from "../sdk/market.ts";
import { runStrategyCommand } from "./strategy.ts";
import {
  STRATEGIES,
  catalogJson,
  gatherStrategyInputs,
  gatheredToJson,
  planFromGathered,
  prepayIsAsset,
  type GatheredStrategy,
  type Plan,
} from "../sdk/index.ts";

const USAGE = `bivium — Bivium market lifecycle CLI (core-v1)

usage: bivium <command> [options]

  market list [--source chain|relayer] [--from-block N]   # discover EXISTING markets — join, don't fragment
  market id|state       compute the market id / read MarketState
  portfolio [--account <addr>] [--dir <orders>]   # aggregated positions/DCN/escrow/orders across all markets
  read position|credit|liquidity --account <addr>
  maker ratify-root (--offer <f>[,<f>...] | --commitment <hash>[,<hash>...]) [--maker <addr>] [--off]  # approve a whole book with ONE on-chain flag
  maker set-ratifier [--off]
  maker fund --assets <human>                        # lender: stake loan token so a BID can be filled
  maker escrow --assets <human>                      # borrower: stake collateral so an ASK can be filled
  maker withdraw-escrow --assets <human> [--receiver <addr>]
  maker withdraw-liquidity --assets <human> [--receiver <addr>]
  maker wizard                        # interactive quoting: pick market -> amount -> price -> confirm
  maker make-offer --side buy|sell (--tick <n> | --apr-bps <n>) --max-units <human>
                   [--ttl <s>] [--out <file>] [--publish] [--acknowledge-itm]
  offer status --offer <file>
  book list [market flags] [--depth N] (--source files --dir <path> | --source relayer)
  trade buy (--units <human> | --spend <human> [--exact-spend]) [--limit-tick <n>] [--dry-run] (--source …)
  trade sell --units <human> [--limit-tick <n>] [--dry-run] (--source …)
  order list --maker <addr> [market flags] (--source …)
  order cancel --offer <file>
  borrow quote --offer <file> [--units <human>]
  borrow execute --offer <file> --units <human> [--receiver <addr>]
  strategy list                                            # the strategy catalog (what GET /api/strategies serves)
  strategy quote --strategy <id> --asset <symbol|addr> [--counter <symbol|addr>] --size <human> --maturity <unix> --buffer <pct>
                 [--apr-bps <n> | --price <wad> | (--source relayer)] [--sigma <annual vol>] [--source chain --from-block N --chunk-blocks N]
  strategy plan  (same flags) [--router <addr>] [--min-out <human>] [--ttl <s>]   # bounded plan: maxLoss/minOut/deadline; never executes
  strategy program --strategy <id> --offer <file> --units <human> [--router <addr>]      # the StrategyRouter leg program, built and printed
                   [--pool-fee 3000] [--pool-spacing 60] [--pool-hooks 0x0] [--min-out <human>] [--slippage-bps 100]
                   [--unwind (market flags) --assets <human> [--via wallet|flash] [--max-settle-in <human>]]
  strategy execute (the same flags) [--deadline <unix>]                                 # grant once, approve exactly, send it
  strategy positions --taker <addr>          # holdings read as strategies, from the app's /api/strategies/positions
  repay (--offer <file> | market flags) --assets <human>
  reclaim (--offer <file> | market flags) [--receiver <addr>]
  claim (--offer <file> | market flags) --units <human> [--receiver <addr>]
  settle arm (market flags | --offer <file>) --keep <percent>              # grant (once) + per-market arm: keep >= x% of what settles
  settle disarm (market flags | --offer <file>)
  settle status (market flags | --offer <file>) [--borrower <addr>]        # floor share, cap now, settleable bound
  settle execute (market flags | --offer <file>) --borrower <addr> [--ask <human>]  # keeper: fund the repay (names the size)
    [--via-jit | --via-morpho] [--min-profit <loan>] [--pool-fee 3000] [--pool-spacing 60] [--pool-hooks 0x0]  # zero-capital: v4 flash accounting, or a Morpho flash loan converted on v4
  mock mint --token <symbol|addr> --to <addr> --amount <human>
  wallet create [--out <file>]        # throwaway wallet, key file mode 0600
  wallet address|balance [--key-file <f> | --account <addr>]
  wallet gas --to <addr> [--via-api]  # third-party claim; --via-api needs no local key at all
  wizard                              # interactive wizard: lend / borrow / trade

  strategy catalog --json
  strategy assess --risk-file <json> --json
  strategy trace --strategy-id <id> --quote-id <bytes32> --nonce <n> --account <addr> --json

  vault activate --sats <sats> [--vault-id <bytes32>] [--depositor <addr>]   # testnet mock faucet
  vault list [--account <addr>]
  vault status --vault-id <bytes32> [--account <viewer>]
  vault borrow --vault-id <bytes32>[,<bytes32>...] --offer <file> [--receiver <addr>] [--dry-run]
  vault release|reclaim|mark-delivered --vault-id <bytes32>
  vault convert|unconvert --vault-id <bytes32>
  vault convert-delivered --sats <sats>
  vault redemption post --amount <sats> --min-sats-start <sats> --min-sats-end <sats>
                        --btc-dest <hex> --deadline <unix>
  vault redemption cancel --id <n>
  vault redemption list [--limit N] [--account <addr>]
  vault keeper fill --id <n> --txid <bytes32>
  vault keeper settle --vault-id <bytes32>
  vault invariant [--account <addr>]
  (vault amounts are integer sats; outputs also show BTC)

market flags: --loan <symbol|addr> --collateral <symbol|addr> --maturity <unix>
              (--floor <human> | --strike <raw>) [--allow-partial] [--gate <addr>]
global:       --profile <path> (or BIVIUM_PROFILE) [--key-env NAME] [--json]`;

const OPTIONS = {
  profile: { type: "string" },
  "key-env": { type: "string", default: "BIVIUM_PK" },
  "key-file": { type: "string" },
  json: { type: "boolean", default: false },
  offer: { type: "string" },
  loan: { type: "string" },
  collateral: { type: "string" },
  maturity: { type: "string" },
  floor: { type: "string" },
  strike: { type: "string" },
  "allow-partial": { type: "boolean", default: false },
  gate: { type: "string" },
  account: { type: "string" },
  assets: { type: "string" },
  units: { type: "string" },
  "max-units": { type: "string" },
  side: { type: "string" },
  tick: { type: "string" },
  "apr-bps": { type: "string" },
  ttl: { type: "string" },
  out: { type: "string" },
  receiver: { type: "string" },
  token: { type: "string" },
  to: { type: "string" },
  amount: { type: "string" },
  off: { type: "boolean", default: false },
  "via-api": { type: "boolean", default: false },
  "from-block": { type: "string" },
  "acknowledge-itm": { type: "boolean", default: false },
  borrower: { type: "string" },
  taker: { type: "string" },
  keep: { type: "string" },
  ask: { type: "string" },
  "via-jit": { type: "boolean" },
  "via-morpho": { type: "boolean" },
  "min-profit": { type: "string" },
  "pool-fee": { type: "string" },
  "pool-spacing": { type: "string" },
  "pool-hooks": { type: "string" },
  "vault-id": { type: "string" },
  depositor: { type: "string" },
  sats: { type: "string" },
  "min-sats-start": { type: "string" },
  "min-sats-end": { type: "string" },
  "btc-dest": { type: "string" },
  id: { type: "string" },
  txid: { type: "string" },
  limit: { type: "string" },
  deadline: { type: "string" },
  depth: { type: "string" },
  source: { type: "string" },
  dir: { type: "string" },
  spend: { type: "string" },
  "exact-spend": { type: "boolean", default: false },
  "limit-tick": { type: "string" },
  "dry-run": { type: "boolean", default: false },
  publish: { type: "boolean", default: false },
  maker: { type: "string" },
  "risk-file": { type: "string" },
  "strategy-id": { type: "string" },
  "quote-id": { type: "string" },
  nonce: { type: "string" },
  strategy: { type: "string" },
  asset: { type: "string" },
  counter: { type: "string" },
  size: { type: "string" },
  buffer: { type: "string" },
  sigma: { type: "string" },
  price: { type: "string" },
  router: { type: "string" },
  "min-out": { type: "string" },
  "chunk-blocks": { type: "string" },
  ratifier: { type: "string" },
  "no-flag": { type: "boolean" },
  commitment: { type: "string" },
  "slippage-bps": { type: "string" },
  "max-settle-in": { type: "string" },
  unwind: { type: "boolean" },
  via: { type: "string" },
} as const;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function need<T>(value: T | undefined, flag: string): T {
  if (value === undefined) fail(`missing --${flag}`);
  return value;
}

function output(json: boolean, data: Record<string, unknown>, human: string): void {
  console.log(json ? JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) : human);
}

function loadKeyAccount(keyEnv: string, keyFile?: string) {
  if (keyFile) return privateKeyToAccount(readKeyFile(keyFile));
  const raw = process.env[keyEnv];
  if (!raw) fail(`signing key required: set ${keyEnv} (or pass --key-env NAME / --key-file <path>)`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) fail(`${keyEnv} is not a 32-byte hex private key`);
  return privateKeyToAccount(raw as Hex);
}
/** The ratifier this invocation uses: the profile's default, or `--ratifier setter|signature`. */
function resolveRatifierOr(ctx: Ctx): { kind: RatifierKind; address: Address } {
  const o = ctx.values.ratifier;
  if (o !== undefined && o !== "setter" && o !== "signature") fail("--ratifier must be setter or signature");
  try {
    return resolveRatifier(ctx.profile, o as RatifierKind | undefined);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function accountFor(ctx: Ctx) {
  return loadKeyAccount(ctx.keyEnv, ctx.values["key-file"] as string | undefined);
}

interface Ctx {
  profile: DeploymentProfile;
  json: boolean;
  keyEnv: string;
  values: Record<string, string | boolean | undefined>;
}

async function tokenDecimals(ctx: Ctx, address: Address): Promise<number> {
  const entry = Object.values(ctx.profile.tokens ?? {}).find((t) => t.address === address);
  if (entry) return entry.decimals;
  // Not allowlisted: read the exact decimals from the chain rather than guessing.
  return await client(ctx, false).tokenDecimals(address);
}

/** Market params from --offer file or explicit flags. */
/// A strike, written in its own unit. `floorFromStrike` always answers loan-per-collateral, and that IS the
/// number on every market shape — the unit label is what makes it readable on all three product lines, and the
/// reciprocal hint saves the mental arithmetic on volatile-loan markets, where the human-quoted price is the
/// other way up ("0.005 mNVDA/bUSD (= 200 bUSD per mNVDA)").
function fmtStrikeUnit(floor: string, loanSym: string, collSym: string): string {
  const value = Number(floor);
  const base = `${floor} ${loanSym}/${collSym}`;
  if (Number.isFinite(value) && value > 0 && value < 1) return `${base} (= ${(1 / value).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${collSym} per ${loanSym})`;
  return base;
}

/** A StrategyRouter program from the CLI's flags: the offer decides the market, the strategy decides the shape,
 *  and the pool decides the one number that is not already fixed — the swap's floor. Nothing is sent here. */
async function buildStrategyProgram(ctx: Ctx, signing: boolean): Promise<{
  client: StrategyRouterClient;
  legs: Leg[];
  deadline: bigint;
  grantExpiry: bigint;
  approvals: [Address, bigint][];
  json: Record<string, unknown>;
  human: string[];
}> {
  const v = ctx.values;
  const router = getAddress(
    typeof v.router === "string" ? v.router : (ctx.profile.strategyRouter ?? fail("no --router and the profile has no strategyRouter for this chain")),
  ) as Address;
  const client = new StrategyRouterClient(ctx.profile, signing ? accountFor(ctx) : undefined, router);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const deadline = typeof v.deadline === "string" ? BigInt(v.deadline) : nowSec + 600n;
  const grantExpiry = typeof v.ttl === "string" ? nowSec + BigInt(v.ttl) : 0n;
  if (ctx.profile.abiProfile !== "core-v2") fail("the StrategyRouter is core-v2 periphery; this profile is core-v1");
  const domain = { chainId: ctx.profile.chainId, core: ctx.profile.core };
  const slippageBps = Number(v["slippage-bps"] ?? 100);
  const poolFee = Number(v["pool-fee"] ?? 3000);
  const poolSpacing = Number(v["pool-spacing"] ?? 60);
  const poolHooks = getAddress((v["pool-hooks"] as string | undefined) ?? ZERO_ADDRESS) as Address;

  if (v.unwind === true) {
    const { params, loanDecimals, collateralDecimals } = await resolveMarket(ctx);
    const assets = parseAmount(need(v.assets as string | undefined, "assets"), loanDecimals);
    const via = v.via === "wallet" ? "wallet" : v.via === "flash" || v.via === undefined ? "flash" : fail("--via is wallet or flash");
    const key = poolKeyFor(params.collateralToken, params.loanToken, poolFee, poolSpacing, poolHooks);
    let maxSettleIn: bigint | undefined;
    let ceiling: Awaited<ReturnType<typeof swapCeiling>> | undefined;
    if (via === "flash") {
      ceiling = await swapCeiling({
        call: client.ethCall, key, tokenIn: params.collateralToken, amountOut: assets, slippageBps,
        explicit: typeof v["max-settle-in"] === "string" ? parseAmount(v["max-settle-in"], collateralDecimals) : undefined,
        stateView: ctx.profile.v4StateView,
      });
      maxSettleIn = ceiling.maxIn;
    }
    const legs = buildUnwindProgram({ domain, params, assets, via, poolKey: key, maxSettleIn });
    const approvals: [Address, bigint][] = via === "wallet" ? [[params.loanToken, assets]] : [];
    return {
      client, legs, deadline, grantExpiry, approvals,
      json: {
        router, mode: "unwind", via, assets: assets.toString(), deadline: deadline.toString(),
        ceiling: ceiling ? { maxIn: ceiling.maxIn.toString(), source: ceiling.source, estimate: ceiling.estimate.toString(), slippageBps: ceiling.slippageBps } : null,
        legs: legs.map((l) => ({ kind: l.kind, data: l.data })),
      },
      human: [
        `unwind via ${via}: ${formatAmount(assets, loanDecimals)} face on ${params.collateralToken}/${params.loanToken}`,
        via === "flash"
          ? `  the buy-back may consume at most ${formatAmount(maxSettleIn!, collateralDecimals)} collateral (${ceiling!.source})`
          : `  the repayment comes from the wallet: ${formatAmount(assets, loanDecimals)} approved to the router`,
        `  ${legs.length} leg(s), deadline ${deadline}`,
      ],
    };
  }

  const strategy = getStrategy(need(v.strategy as string | undefined, "strategy"));
  const file = parseSignedOfferFile(readFileSync(need(v.offer as string | undefined, "offer"), "utf8"), ctx.profile);
  const params = marketParamsFromOffer(file.offer);
  // A gated market decides which router it accepts, and this deployment runs more than one gate generation at
  // once — the fee rule changed by opening a new series, not by changing a setting. So the profile's router is a
  // default, not an answer: ask the gate before building a program it would refuse.
  let c = client;
  if (params.gate.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
    const { routers, lenderMustRoute } = await client.gateRouting(params.gate);
    if (!file.offer.buy && !lenderMustRoute) {
      fail(
        `this market's gate ${params.gate} does not route lenders, so a lend fills the ask directly on the core; `
          + "building a router program here would charge a fee the gate never asks for",
      );
    }
    const admitted = routers.map((r) => r.toLowerCase());
    if (!admitted.includes(client.router.toLowerCase())) {
      if (typeof v.router === "string") {
        fail(`--router ${client.router} is not admitted by this market's gate ${params.gate}, which lists ${routers.join(", ")}`);
      }
      if (routers.length === 0) fail(`this market's gate ${params.gate} admits no routers, so it cannot be originated at all`);
      c = new StrategyRouterClient(ctx.profile, signing ? accountFor(ctx) : undefined, routers[0]);
    }
  }
  const loanDecimals = await tokenDecimals(ctx, params.loanToken);
  const collateralDecimals = await tokenDecimals(ctx, params.collateralToken);
  const units = parseAmount(need(v.units as string | undefined, "units"), loanDecimals);
  const bySymbol = new Map(Object.entries(ctx.profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), sym]));
  const row = {
    // `orientation` reads only the params; the block a market was first seen in is a discovery fact this path has
    // no use for, so it is stated as zero rather than looked up.
    market: { id: computeMarketId(params), params, firstSeenBlock: 0n },
    loanSymbol: bySymbol.get(params.loanToken.toLowerCase()),
    collateralSymbol: bySymbol.get(params.collateralToken.toLowerCase()),
    loanDecimals,
    collateralDecimals,
  };
  const line = classifyLine(row.loanSymbol, row.collateralSymbol);
  if (line !== strategy.line) {
    fail(`${strategy.id} is a ${strategy.line}-line strategy and this offer's market is ${line}`);
  }
  const o = orientation(line, row);
  const view = { strategy, strike: params.strike, asset: o.asset, numeraire: o.numeraire, line };

  const carriesSwap = strategy.requires.includes("swap");
  const key = poolKeyFor(params.collateralToken, params.loanToken, poolFee, poolSpacing, poolHooks);
  const feeBps = file.offer.buy ? await c.feeBps() : 0n;
  const lenderFeeBps = file.offer.buy ? 0n : await c.lenderFeeBps();
  let floor: Awaited<ReturnType<typeof swapFloor>> | undefined;
  if (carriesSwap) {
    if (!poolKeyCarries(key, params.loanToken, params.collateralToken)) fail("the pool key does not name this market's pair");
    // The swap spends what the fill produced, so its input is the principal after the router's fee.
    const cost = fillCost(file.offer, units);
    const { principalAfterFee } = await c.quoteLeg(units, cost);
    const tokenIn = strategy.id === "leveredLong" ? o.numeraire : o.asset;
    const inDecimals = tokenIn.toLowerCase() === params.loanToken.toLowerCase() ? loanDecimals : collateralDecimals;
    const outDecimals = inDecimals === loanDecimals ? collateralDecimals : loanDecimals;
    floor = await swapFloor({
      call: c.ethCall, key, tokenIn, amountIn: principalAfterFee, slippageBps,
      explicit: typeof v["min-out"] === "string" ? parseAmount(v["min-out"], outDecimals) : undefined,
      quoter: ctx.profile.v4Quoter, stateView: ctx.profile.v4StateView,
    });
  }
  const build = buildOpenProgram(view, {
    domain,
    offer: file.offer,
    ratifierData: file.signature,
    units,
    poolKey: carriesSwap ? key : undefined,
    minOut: floor?.minOut,
    feeBps,
    lenderFeeBps,
  });
  // What the router may draw from the account: the collateral top-up on a bid, cost plus lender fee on an ask.
  const approvals: [Address, bigint][] = file.offer.buy
    ? [[params.collateralToken, build.derived.maxTopUp]]
    : [[params.loanToken, build.derived.costWithFee]];
  return {
    client: c, legs: build.legs, deadline, grantExpiry, approvals,
    json: {
      router: c.router, mode: "open", strategy: strategy.id, market: row.market.id, line,
      asset: o.asset, numeraire: o.numeraire, deadline: deadline.toString(),
      derived: Object.fromEntries(Object.entries(build.derived).map(([k, x]) => [k, x.toString()])),
      swap: floor ? { minOut: floor.minOut.toString(), source: floor.source, estimate: floor.estimate.toString(), slippageBps: floor.slippageBps } : null,
      approvals: approvals.map(([token, amount]) => ({ token, amount: amount.toString() })),
      legs: build.legs.map((l) => ({ kind: l.kind, data: l.data })),
    },
    human: [
      `${strategy.id} on ${row.collateralSymbol ?? params.collateralToken}/${row.loanSymbol ?? params.loanToken}: ${formatAmount(units, loanDecimals)} face`,
      `  router ${c.router}`,
      file.offer.buy
        ? `  cost ${formatAmount(build.derived.cost, loanDecimals)}  fee ${formatAmount(build.derived.fee, loanDecimals)}  principal ${formatAmount(build.derived.principal, loanDecimals)}`
        : `  core cost ${formatAmount(build.derived.cost, loanDecimals)}  lender fee ${formatAmount(build.derived.fee, loanDecimals)}  total cost / approval ${formatAmount(build.derived.costWithFee, loanDecimals)}`,
      `  the strike wants ${formatAmount(build.derived.collateral, collateralDecimals)} collateral; at most ${formatAmount(build.derived.maxTopUp, collateralDecimals)} comes from you`,
      floor ? `  swap floor ${formatAmount(floor.minOut, collateralDecimals)} (${floor.source}, ${floor.slippageBps} bps off ${formatAmount(floor.estimate, collateralDecimals)})` : "  no swap leg",
      `  ${build.legs.length} leg(s), deadline ${deadline}`,
    ],
  };
}

async function resolveMarket(ctx: Ctx, needDecimals = true): Promise<{ params: MarketParams; loanDecimals: number; collateralDecimals: number }> {
  const v = ctx.values;
  if (typeof v.offer === "string") {
    const { offer } = parseSignedOfferFile(readFileSync(v.offer, "utf8"), ctx.profile);
    const params = marketParamsFromOffer(offer);
    return {
      params,
      loanDecimals: await tokenDecimals(ctx, params.loanToken),
      collateralDecimals: await tokenDecimals(ctx, params.collateralToken),
    };
  }
  const loan = resolveToken(ctx.profile, need(v.loan as string | undefined, "loan"));
  const collateral = resolveToken(ctx.profile, need(v.collateral as string | undefined, "collateral"));
  // --strike (raw) never needs decimals; --floor and amount formatting do. Fetch only when needed
  // so identity-only commands work against tokens that are not deployed/allowlisted yet.
  const wantDecimals = needDecimals || typeof v.floor === "string";
  const loanDecimals = loan.info?.decimals ?? (wantDecimals ? await tokenDecimals(ctx, loan.address) : 0);
  const collateralDecimals = collateral.info?.decimals ?? (wantDecimals ? await tokenDecimals(ctx, collateral.address) : 0);
  const maturity = BigInt(need(v.maturity as string | undefined, "maturity"));
  let strike: bigint;
  if (typeof v.strike === "string") strike = BigInt(v.strike);
  else if (typeof v.floor === "string") strike = strikeFromFloor(v.floor, loanDecimals, collateralDecimals);
  else fail("provide --floor or --strike");
  return {
    params: {
      loanToken: loan.address,
      collateralToken: collateral.address,
      maturity,
      strike,
      allowPartialRepay: v["allow-partial"] === true,
      gate: typeof v.gate === "string" ? (getAddress(v.gate) as Address) : ZERO_ADDRESS,
    },
    loanDecimals,
    collateralDecimals,
  };
}

function client(ctx: Ctx, signing: boolean): BiviumClient {
  return new BiviumClient(ctx.profile, signing ? accountFor(ctx) : undefined);
}

function vaultClient(ctx: Ctx, signing: boolean): VaultAppClient {
  return new VaultAppClient(ctx.profile, signing ? accountFor(ctx) : undefined);
}

/** Vault-app amounts are integer sats (and ids plain integers), never token-decimal scaled. */
function rawBigInt(value: string | undefined, flag: string): bigint {
  const v = need(value, flag);
  if (!/^\d+$/.test(v)) fail(`--${flag} must be a non-negative integer`);
  return BigInt(v);
}

function bytes32Flag(value: string | undefined, flag: string): Hex {
  const v = need(value, flag);
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) fail(`--${flag} must be a bytes32 hex value`);
  return v as Hex;
}

/** sats → "0.001 BTC (100000 sats)" */
function btc(sats: bigint): string {
  return `${formatAmount(sats, 8)} BTC (${sats} sats)`;
}

function relayerDomain(profile: DeploymentProfile): RelayerDomain {
  if (!profile.relayerUrl) fail("profile has no relayerUrl — the relayer book source is unavailable");
  requireRelayerV2(profile.abiProfile);
  return {
    chainId: profile.chainId,
    core: profile.core,
    abiProfile: profile.abiProfile,
    signatureRatifier: profile.signatureRatifier,
    relayerUrl: profile.relayerUrl,
  };
}

/**
 * Assemble the signed book for one market from the chosen source. `files` loads every *.json
 * SignedOfferFile in --dir (each strictly validated against the profile; other markets skipped),
 * `relayer` GETs the profile's relayerUrl and FAILS on {ok:false} — a down relayer is not an
 * empty book.
 */
async function loadBookEntries(ctx: Ctx, params: MarketParams): Promise<{ entries: BookEntry[]; source: string }> {
  const source = (ctx.values.source as string | undefined) ?? (ctx.profile.relayerUrl ? "relayer" : undefined);
  if (source === "files") {
    const dir = need(ctx.values.dir as string | undefined, "dir");
    const c = client(ctx, false);
    const wantId = c.marketId(params);
    const entries: BookEntry[] = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      const path = join(dir, name);
      let parsed;
      try {
        parsed = parseSignedOfferFile(readFileSync(path, "utf8"), ctx.profile);
      } catch (error) {
        fail(`invalid signed-offer file ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (c.marketId(marketParamsFromOffer(parsed.offer)) !== wantId) continue; // different market
      entries.push(entryFromSignedOffer(parsed.offer, parsed.commitment, parsed.signature));
    }
    return { entries, source: `files:${dir}` };
  }
  if (source === "relayer") {
    const domain = relayerDomain(ctx.profile);
    const result = await fetchRelayerBook(domain, params);
    if (!result.ok) fail(`relayer unavailable — not an empty book: ${result.reason}`);
    return { entries: result.entries, source: domain.relayerUrl };
  }
  fail("pick a book source: --source files --dir <path>, or --source relayer (needs profile.relayerUrl)");
}

function parseLimitTick(value: string | boolean | undefined): bigint | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\d+$/.test(value)) fail("--limit-tick must be a non-negative integer tick");
  return BigInt(value);
}

function renderLevels(levels: DepthLevel[], loanDecimals: number, term: bigint): string[] {
  return levels.map((l) => {
    const apr = term > 0n && l.price > 0n && l.price <= 10n ** 18n ? `${Number(simpleAprBpsFromPrice(l.price, term)) / 100}%` : "-";
    const makers = [...new Set(l.entries.map((e) => e.maker))].join(",");
    return `  tick ${l.tick}  price ${formatAmount(l.price, 18)}  APR ${apr}  face ${formatAmount(l.size, loanDecimals)}  cum ${formatAmount(l.cumulative, loanDecimals)}  ${makers}`;
  });
}

function renderPlan(plan: TradePlan, loanDecimals: number): string[] {
  const verb = plan.side === "ask" ? "buy" : "sell";
  const lines = plan.takes.map(
    ({ entry, units }) =>
      `  ${verb} ${formatAmount(units, loanDecimals)} face @ tick ${entry.offer.tick} (price ${formatAmount(entry.price, 18)}) from ${entry.maker} — ${entry.commitment.slice(0, 10)}…`,
  );
  lines.push(
    `  total: ${formatAmount(plan.totalUnits, loanDecimals)} face ${plan.side === "ask" ? "for" : "yielding"} ${formatAmount(plan.totalCost, loanDecimals)} loan tokens` +
      (plan.worstTick !== undefined ? ` (worst tick ${plan.worstTick})` : ""),
  );
  return lines;
}

async function runTrade(ctx: Ctx, side: "buy" | "sell"): Promise<void> {
  const { params, loanDecimals } = await resolveMarket(ctx);
  const { entries, source } = await loadBookEntries(ctx, params);
  const v = ctx.values;
  const request: TradePlanRequest = {
    units: typeof v.units === "string" ? parseAmount(v.units, loanDecimals) : undefined,
    spend: typeof v.spend === "string" ? parseAmount(v.spend, loanDecimals) : undefined,
    exactSpend: v["exact-spend"] === true,
    limitTick: parseLimitTick(v["limit-tick"]),
  };
  const dryRun = v["dry-run"] === true;
  const tc = new TradeClient(ctx.profile, dryRun ? undefined : loadKeyAccount(ctx.keyEnv));
  const plan = side === "buy" ? await tc.planBuy(entries, request) : await tc.planSell(entries, request);
  if (plan.takes.length === 0) fail(`no fillable ${side === "buy" ? "asks" : "bids"} in the book (source ${source})`);
  if (dryRun) {
    output(ctx.json, { dryRun: true, source, plan: planJson(plan) }, [`plan (dry run, book source ${source}):`, ...renderPlan(plan, loanDecimals)].join("\n"));
    return;
  }
  console.error([`plan (book source ${source}):`, ...renderPlan(plan, loanDecimals)].join("\n"));
  const result = await tc.executePlan(plan);
  output(
    ctx.json,
    { ...planJson(plan), hash: result.hash, gasUsed: result.gasUsed, blockNumber: result.blockNumber, creditDelta: result.creditDelta, loanDelta: result.loanDelta },
    [
      `${side === "buy" ? "bought" : "sold"} ${formatAmount(plan.totalUnits, loanDecimals)} DCN face across ${plan.takes.length} fill(s) in one multicall — tx ${result.hash}`,
      `  credit delta: ${formatAmount(result.creditDelta, loanDecimals)} (exact)`,
      `  loan-token delta: ${formatAmount(result.loanDelta, loanDecimals)} (exact)`,
    ].join("\n"),
  );
}

function planJson(plan: TradePlan): Record<string, unknown> {
  return {
    side: plan.side,
    totalUnits: plan.totalUnits,
    totalCost: plan.totalCost,
    worstTick: plan.worstTick,
    takes: plan.takes.map(({ entry, units }) => ({
      commitment: entry.commitment,
      maker: entry.maker,
      tick: entry.offer.tick,
      price: entry.price,
      units,
    })),
  };
}

// Line-buffered prompt helper: works on a TTY and with piped stdin (readline drops buffered
// lines on EOF-close, which silently kills a naive question() loop under pipes).
function makeAsker() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!("");
  });
  return {
    async ask(prompt: string): Promise<string> {
      process.stdout.write(prompt);
      const line = queue.length ? queue.shift()! : closed ? "" : await new Promise<string>((resolve) => waiters.push(resolve));
      if (process.stdin.isTTY !== true) process.stdout.write(line + "\n"); // echo piped answers for a readable transcript
      return line;
    },
    close: () => rl.close(),
  };
}

async function runMakeOffer(ctx: Ctx, market: { params: MarketParams; loanDecimals: number; collateralDecimals: number }): Promise<void> {
const { params, loanDecimals, collateralDecimals } = market;
  const side = need(ctx.values.side as string | undefined, "side");
  if (side !== "buy" && side !== "sell") fail("--side must be buy or sell");
  if (side === "buy") {
    // Economic guardrail (display-only spot, never part of the offer): a buy bid on a market
    // whose floor sits at/above spot buys collateral above market — the borrower's rational
    // strategy is to default, so a near-par lend price is a guaranteed loss.
    const collInfo = Object.entries(ctx.profile.tokens ?? {}).find(([, t]) => t.address === params.collateralToken);
    const loanInfo = Object.entries(ctx.profile.tokens ?? {}).find(([, t]) => t.address === params.loanToken);
    const pair = pairFor(collInfo?.[0], loanInfo?.[0]);
    // One rule for every market shape: the strike ratio against the SAME ratio at spot, from the deployment's
    // pair feed. S ≥ R means the collateral no longer covers the debt it backs — the borrower's rational
    // strategy is delivery, so a bid near par is a guaranteed loss, whichever leg is the volatile one.
    if (pair) {
      const spot = await fetchPairRatio(ctx.profile.relayerUrl, pair);
      let strikeRatio: string | null = null;
      try { strikeRatio = floorFromStrike(params.strike, loanDecimals, collateralDecimals); } catch { strikeRatio = null; }
      const money = spot !== null && strikeRatio !== null ? assessMoneyness(strikeRatio, spot.loanPerCollateral) : null;
      if (money?.itm && ctx.values["acknowledge-itm"] !== true) {
        fail(`this market is in the money: strike ${strikeRatio} vs ${pair} spot ${spot!.loanPerCollateral.toFixed(6)} (LTV ${(money.ratio * 100).toFixed(1)}%) — the collateral no longer covers the debt, and the borrower's rational strategy is delivery. Pass --acknowledge-itm to quote anyway.`);
      }
      if (money === null) console.error(`note: ${pair} pair ratio unavailable — cannot assess moneyness for this bid`);
    } else {
      console.error("note: no pair ticker for this market's legs — cannot assess moneyness for this bid");
    }
  }
  const maxUnits = parseAmount(need(ctx.values["max-units"] as string | undefined, "max-units"), loanDecimals);
  const now = BigInt(Math.floor(Date.now() / 1000));
  let tick: bigint;
  if (typeof ctx.values.tick === "string") {
    tick = BigInt(ctx.values.tick);
    if (tick % 4n !== 0n || tick < 0n || tick > 5820n) fail("--tick must be a grid tick (multiple of 4, 0..5820)");
  } else {
    const aprBps = BigInt(need(ctx.values["apr-bps"] as string | undefined, "apr-bps"));
    const term = params.maturity - now;
    if (term <= 0n) fail("market is already matured");
    const price = priceFromSimpleAprBps(aprBps, term);
    // buy bid rounds down (maker pays less), sell ask rounds up (maker asks more).
    tick = priceToTick(price, side === "sell");
  }
  const ttl = BigInt(typeof ctx.values.ttl === "string" ? ctx.values.ttl : "604800");
  const account = accountFor(ctx);
  if (side === "sell") {
    // Core transfers held credit first. Only the uncovered units create debt and need escrow;
    // a fully credit-backed sale also works on older cores without the escrow getter, including after maturity.
    const c = client(ctx, false);
    const marketId = c.marketId(params);
    const credit = await c.creditOf(marketId, account.address as Address);
    if (credit < maxUnits) {
      const assertIssuanceOpen = () => {
        if (BigInt(Math.floor(Date.now() / 1000)) >= params.maturity) {
          fail("this ask exceeds held credit, but new issuance is closed at or after maturity. Reduce the order to held credit or acquire more credit to sell without adding debt.");
        }
      };
      assertIssuanceOpen();
      let escrow: bigint;
      try {
        escrow = await c.collateralEscrowOf(marketId, account.address as Address);
      } catch (cause) {
        throw new Error(
          `Cannot read collateralEscrowOf from Core ${ctx.profile.core} for this ask's uncovered units; the Core may be unsupported or the RPC unavailable. Verify a compatible Core and RPC, then retry, or reduce the order to held credit; refusing to assume escrow backing.`,
          { cause },
        );
      }
      assertIssuanceOpen();
      const shortfall = askBackingShortfall({ units: maxUnits, credit, escrow, strike: params.strike });
      if (shortfall > 0n) {
        fail(
          `this ask offers ${formatAmount(maxUnits, loanDecimals)} face with ${formatAmount(credit, loanDecimals)} held credit; `
            + `the newly issued units need ${formatAmount(shortfall, collateralDecimals)} more collateral than the available escrow. `
            + "Reduce the order to held credit or acquire enough credit to cover it to avoid new debt. Collateral-backed issuance adds debt; funding more escrow is a separate explicit action.",
        );
      }
    }
  }
  const rat = resolveRatifierOr(ctx);
  const offer: Offer = {
    ...params,
    maker: account.address as Address,
    buy: side === "buy",
    tick,
    maxUnits,
    maxAssets: 0n,
    start: now - 300n,
    expiry: now + ttl,
    group: `0x${randomBytes(32).toString("hex")}` as Hex,
    ratifier: rat.address,
  };
  const commitment = adapterFor(ctx.profile.abiProfile).offerCommitment(
    { chainId: ctx.profile.chainId, core: ctx.profile.core },
    offer,
  );
  const c = new BiviumClient(ctx.profile, account);
  await c.verifyProfile();
  // `signature` carries the offer's ratifierData, whichever ratifier attests it.
  let signature: Hex;
  let flagged: string | null = null;
  if (rat.kind === "signature") {
    signature = await account.sign({ hash: ratifyDigest(ctx.profile.chainId, rat.address, commitment) });
  } else {
    // A single offer degenerates to `root == commitment` with an empty proof. Approving it on-chain is
    // what makes it fillable, so do that BEFORE the precheck below — otherwise the precheck is the one
    // reporting a failure the maker has simply not performed yet.
    signature = encodeProofRatifierData([]);
    if (ctx.values["no-flag"] === true) {
      flagged = "skipped (--no-flag): the offer cannot fill until `maker ratify-root` approves this commitment";
    } else if (await c.isRootRatified(rat.address, account.address as Address, commitment)) {
      flagged = "already approved";
    } else {
      flagged = (await c.setRootRatified(rat.address, account.address as Address, commitment, true)).hash;
    }
  }
  // Precheck: refuse to emit a file the on-chain ratifier would not accept. The one exception is a
  // deliberately unflagged setter offer: the maker is minting it to tree with others, so it is MEANT
  // to be unratified until `maker ratify-root` approves the whole book and writes the real proofs in.
  const deferred = rat.kind === "setter" && ctx.values["no-flag"] === true;
  const status = await c.offerStatus(offer, signature);
  if (!status.ratified && !deferred) fail("on-chain ratifier precheck did not return RATIFIED — aborting");
  const file = buildSignedOfferFile(ctx.profile, offer, commitment, signature);
  const path = typeof ctx.values.out === "string" ? ctx.values.out : `offer-${commitment.slice(2, 10)}.json`;
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  let published = false;
  if (ctx.values.publish === true) {
    // publishSignedOffer/relayerDomain reject core-v1 (wire protocol is 17-field domain-bound)
    // and a missing relayerUrl with clear errors before anything is sent.
    await publishSignedOffer(relayerDomain(ctx.profile), offer, signature);
    published = true;
  }
  output(
    ctx.json,
    { path, commitment, tick, price: tickToPrice(tick), ratifier: rat.address, ratifierKind: rat.kind, rootFlagged: flagged, ratifierRegistered: status.ratifierRegistered, published },
    [
      `offer written to ${path}`,
      `  commitment: ${commitment}`,
      `  tick ${tick} → price ${formatAmount(tickToPrice(tick), 18)}`,
      `  ratifier: ${rat.kind} (${rat.address})${flagged === null ? "" : `  root ${flagged}`}`,
      ...(deferred ? ["  NOT FILLABLE YET: approve it with `maker ratify-root --offer <this file>[,…]`, which also writes the tree proof back in"] : []),
      status.ratifierRegistered ? `  ratifier registered ✓` : `  WARNING: maker has not run \`maker set-ratifier\` yet`,
      ...(published ? [`  published to relayer ${ctx.profile.relayerUrl}`] : []),
    ].join("\n"),
  );
}


interface WizardMarketRow {
  market: DiscoveredMarket;
  label: string;
  itm: boolean;
  loanDec: number;
  collDec: number;
  loanSym: string;
  collSym: string;
}

type Asker = ReturnType<typeof makeAsker>;

async function pickMarketInteractive(ctx: Ctx, c: BiviumClient, rl: Asker): Promise<WizardMarketRow> {
  const fromBlock = BigInt(ctx.profile.coreDeploymentBlock ?? fail("profile has no coreDeploymentBlock"));
  console.log("Scanning for existing on-chain markets (join, don't fragment liquidity)…");
  const markets = await discoverMarketsOnChain(c, { fromBlock });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const active = markets.filter((m) => m.params.maturity > now);
  if (active.length === 0) fail("no active (unmatured) markets found");
  const bySymbol = new Map(Object.entries(ctx.profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), { sym, dec: t.decimals }]));
  const spots = new Map<string, number | null>();
  const rows: WizardMarketRow[] = [];
  for (const m of active) {
    const loan = bySymbol.get(m.params.loanToken.toLowerCase());
    const coll = bySymbol.get(m.params.collateralToken.toLowerCase());
    const loanDec = loan?.dec ?? (await c.tokenDecimals(m.params.loanToken));
    const collDec = coll?.dec ?? (await c.tokenDecimals(m.params.collateralToken));
    let floor = "?";
    try { floor = floorFromStrike(m.params.strike, loanDec, collDec); } catch { /* off-grid */ }
    const pair = pairFor(coll?.sym, loan?.sym);
    if (pair && !spots.has(pair)) spots.set(pair, (await fetchPairRatio(ctx.profile.relayerUrl, pair))?.loanPerCollateral ?? null);
    const spot = pair ? spots.get(pair) ?? null : null;
    const money = spot !== null && floor !== "?" ? assessMoneyness(floor, spot) : null;
    const state = await c.marketState(m.id);
    const date = new Date(Number(m.params.maturity) * 1000).toISOString().slice(0, 10);
    const loanSym = loan?.sym ?? m.params.loanToken.slice(0, 8);
    const collSym = coll?.sym ?? m.params.collateralToken.slice(0, 8);
    const flags = [
      m.params.gate === ZERO_ADDRESS ? "" : "[gated]",
      money === null ? "" : money.itm ? `[ITM ⚠ LTV ${(money.ratio * 100).toFixed(0)}%]` : `[OTM · LTV ${(money.ratio * 100).toFixed(0)}%]`,
    ].filter(Boolean).join(" ");
    rows.push({
      market: m,
      label: `${collSym}/${loanSym}  strike ${floor === "?" ? "?" : fmtStrikeUnit(floor, loanSym, collSym)}  matures ${date}  active ${formatAmount(state.activeCredit, loanDec)}  repaid ${formatAmount(state.repaidCredit, loanDec)}  ${flags}`,
      itm: money?.itm === true,
      loanDec,
      collDec,
      loanSym,
      collSym,
    });
  }
  rows.forEach((r, i) => console.log(`  [${i + 1}] ${r.label}`));
  const pick = Number((await rl.ask(`Select market [1-${rows.length}]: `)).trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) fail("invalid market selection");
  return rows[pick - 1];
}

/** Ask for a book source, set ctx.values accordingly, and load + reconcile the live book. */
async function loadBookInteractive(ctx: Ctx, rl: Asker, params: MarketParams): Promise<BookEntry[]> {
  const canRelayer = Boolean(ctx.profile.relayerUrl) && ctx.profile.abiProfile === "core-v2";
  let source = canRelayer ? (await rl.ask("Order source relayer/files [relayer]: ")).trim().toLowerCase() || "relayer" : "files";
  if (source !== "relayer" && source !== "files") fail("source must be relayer or files");
  if (source === "files") {
    const dir = (await rl.ask("Signed-offer JSON directory: ")).trim();
    if (!dir) fail("a directory is required for the files source");
    ctx.values.dir = dir;
  }
  ctx.values.source = source;
  const { entries } = await loadBookEntries(ctx, params);
  const tc = new TradeClient(ctx.profile);
  return await tc.reconcileBook(entries);
}

async function wizardLend(ctx: Ctx, rl: Asker): Promise<void> {
  const c = client(ctx, false);
  const chosen = await pickMarketInteractive(ctx, c, rl);
  const sideAnswer = (await rl.ask("Side buy=lend (resting bid) / sell=sell held DCN [buy]: ")).trim().toLowerCase() || "buy";
  if (sideAnswer !== "buy" && sideAnswer !== "sell") fail("side must be buy or sell");
  if (chosen.itm && sideAnswer === "buy") {
    const go = (await rl.ask("⚠ This market's floor is ABOVE spot — lending near par is a guaranteed loss (defaulting is the borrower's rational move). Type yes-itm to continue: ")).trim();
    if (go !== "yes-itm") fail("aborted at the ITM confirmation");
    ctx.values["acknowledge-itm"] = true;
  }
  const amount = (await rl.ask(`Face amount (${chosen.loanSym}, e.g. 200): `)).trim();
  const faceUnits = parseAmount(amount, chosen.loanDec);
  if (faceUnits <= 0n) fail("amount must be positive");
  const priceAnswer = (await rl.ask("Price: APR % (e.g. 10 or 8.5), or tick:<n> for direct grid placement: ")).trim();
  let tick: bigint;
  if (/^tick:\d+$/.test(priceAnswer)) {
    tick = BigInt(priceAnswer.slice(5));
    ctx.values.tick = priceAnswer.slice(5);
  } else {
    const bps = parseAmount(priceAnswer, 2);
    const term = chosen.market.params.maturity - BigInt(Math.floor(Date.now() / 1000));
    tick = priceToTick(priceFromSimpleAprBps(bps, term), sideAnswer === "sell");
    ctx.values["apr-bps"] = bps.toString();
  }
  const signer = accountFor(ctx);
  const sc = new BiviumClient(ctx.profile, signer);
  if (sideAnswer === "buy") {
    // Funding assistance: a bid is only fillable up to the maker's escrowed liquidity.
    const principalNeeded = principalForUnits(faceUnits, tickToPrice(tick));
    const marketId = c.marketId(chosen.market.params);
    const liquidity = await c.liquidityOf(marketId, signer.address as Address);
    if (liquidity < principalNeeded) {
      const shortfall = principalNeeded - liquidity;
      console.log(`Market escrow is ${formatAmount(liquidity, chosen.loanDec)}; filling this bid fully needs ${formatAmount(principalNeeded, chosen.loanDec)}.`);
      const balance = await c.balanceOf(chosen.market.params.loanToken, signer.address as Address);
      if (balance < shortfall) {
        const info = Object.values(ctx.profile.tokens ?? {}).find((t) => t.address === chosen.market.params.loanToken);
        if (info?.mintable) {
          const mint = (await rl.ask(`Wallet balance short — mint ${formatAmount(shortfall - balance, chosen.loanDec)} test ${chosen.loanSym}? [y/N]: `)).trim().toLowerCase();
          if (mint === "y") await sc.mint(chosen.market.params.loanToken, signer.address as Address, shortfall - balance);
        } else {
          console.log("Warning: wallet balance is short and this token is not mintable — the bid cannot fill until escrow is topped up.");
        }
      }
      const fund = (await rl.ask(`Deposit the ${formatAmount(shortfall, chosen.loanDec)} ${chosen.loanSym} shortfall into market escrow? [y/N]: `)).trim().toLowerCase();
      if (fund === "y") {
        const tx = await sc.fund(chosen.market.params, shortfall);
        console.log(`funded: ${tx.hash}`);
      }
    }
  } else {
    const credit = await c.creditOf(c.marketId(chosen.market.params), signer.address as Address);
    if (credit < faceUnits) console.log(`Warning: you hold less DCN (${formatAmount(credit, chosen.loanDec)}) than the ask size — fills beyond it will revert.`);
  }
  const registered = await c.pub.readContract({ address: ctx.profile.core, abi: c.adapter.coreAbi, functionName: "isRatifier", args: [signer.address, ctx.profile.signatureRatifier] } as never);
  if (registered !== true) {
    const reg = (await rl.ask("Quote ratifier not registered yet (once per account). Register now? [y/N]: ")).trim().toLowerCase();
    if (reg === "y") {
      const tx = await sc.setRatifier(ctx.profile.signatureRatifier, true);
      console.log(`setRatifier: ${tx.hash}`);
    } else {
      console.log("Warning: without a registered ratifier the signed offer cannot fill.");
    }
  }
  let publish = false;
  if (ctx.profile.relayerUrl && ctx.profile.abiProfile === "core-v2") {
    publish = (await rl.ask("Publish to the relayer so web users can see and fill it? [y/N]: ")).trim().toLowerCase() === "y";
  }
  const out = (await rl.ask("Save signed offer to file [offer-<commitment>.json]: ")).trim();
  const confirm = (await rl.ask(`Confirm: ${sideAnswer === "buy" ? "BID (lend)" : "ASK (sell DCN)"} ${amount} ${chosen.loanSym} face @ ${priceAnswer}${publish ? ", publish to relayer" : ""} — sign and rest? [y/N]: `)).trim().toLowerCase();
  if (confirm !== "y") fail("aborted before signing");
  ctx.values.side = sideAnswer;
  ctx.values["max-units"] = amount;
  if (out) ctx.values.out = out;
  if (publish) ctx.values.publish = true;
  await runMakeOffer(ctx, { params: chosen.market.params, loanDecimals: chosen.loanDec, collateralDecimals: chosen.collDec });
}

async function wizardBorrow(ctx: Ctx, rl: Asker): Promise<void> {
  const c = client(ctx, false);
  const chosen = await pickMarketInteractive(ctx, c, rl);
  if (chosen.itm) console.log("Note: this market's floor is above spot — favorable to borrowers (principal exceeds collateral value); defaulting at maturity is rational.");
  const live = await loadBookInteractive(ctx, rl, chosen.market.params);
  const bids = sortSide(live, "bid");
  if (bids.length === 0) fail("no executable bids on this market — nothing to borrow against");
  console.log("Executable bids (borrowing capacity):");
  bids.slice(0, 5).forEach((b, i) => {
    console.log(`  [${i + 1}] remaining ${formatAmount(b.size, chosen.loanDec)} ${chosen.loanSym} face @ price ${formatAmount(b.price, 18)} (tick ${b.offer.tick})`);
  });
  const pick = Number((await rl.ask(`Select offer [1-${Math.min(5, bids.length)}]: `)).trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > Math.min(5, bids.length)) fail("invalid offer selection");
  const bid = bids[pick - 1];
  const amount = (await rl.ask(`Borrow face (≤ ${formatAmount(bid.size, chosen.loanDec)} ${chosen.loanSym}): `)).trim();
  const units = parseAmount(amount, chosen.loanDec);
  if (units <= 0n || units > bid.size) fail("units out of range for the selected offer");
  const signer = accountFor(ctx);
  const sc = new BiviumClient(ctx.profile, signer);
  const quote = await sc.quoteFill(bid.offer, units);
  console.log(`Quote: principal received ${formatAmount(quote.principal, chosen.loanDec)} ${chosen.loanSym} | collateral locked ${formatAmount(quote.collateral, chosen.collDec)} ${chosen.collSym} | implied APR ${Number(quote.aprBps) / 100}%`);
  console.log(`Repay exactly ${amount} ${chosen.loanSym} face before maturity (interest = ${formatAmount(units - quote.principal, chosen.loanDec)}); after maturity the collateral goes to settlement.`);
  const collBalance = await c.balanceOf(bid.offer.collateralToken, signer.address as Address);
  if (collBalance < quote.collateral) {
    const info = Object.values(ctx.profile.tokens ?? {}).find((t) => t.address === bid.offer.collateralToken);
    if (info?.mintable) {
      const mint = (await rl.ask(`Collateral short — mint ${formatAmount(quote.collateral - collBalance, chosen.collDec)} test ${chosen.collSym}? [y/N]: `)).trim().toLowerCase();
      if (mint === "y") await sc.mint(bid.offer.collateralToken, signer.address as Address, quote.collateral - collBalance);
      else fail("insufficient collateral");
    } else fail(`insufficient collateral: have ${formatAmount(collBalance, chosen.collDec)}, need ${formatAmount(quote.collateral, chosen.collDec)}`);
  }
  const confirm = (await rl.ask("Confirm borrow and lock collateral? [y/N]: ")).trim().toLowerCase();
  if (confirm !== "y") fail("aborted before borrowing");
  const result = await sc.fillAsBorrower(bid.offer, bid.signature, units);
  const date = new Date(Number(bid.offer.maturity) * 1000).toISOString();
  console.log(`Borrowed: received ${formatAmount(result.principal, chosen.loanDec)} ${chosen.loanSym} — tx ${result.hash}`);
  console.log(`Repay deadline (strictly before): ${date}`);
  console.log(`Repay command: bivium repay --loan ${chosen.loanSym} --collateral ${chosen.collSym} --maturity ${bid.offer.maturity} --strike ${bid.offer.strike} --assets ${amount}  then bivium reclaim …`);
}

async function wizardTrade(ctx: Ctx, rl: Asker): Promise<void> {
  const c = client(ctx, false);
  const chosen = await pickMarketInteractive(ctx, c, rl);
  const live = await loadBookInteractive(ctx, rl, chosen.market.params);
  const asks = aggregateLevels(sortSide(live, "ask")).slice(0, 5);
  const bids = aggregateLevels(sortSide(live, "bid")).slice(0, 5);
  console.log("Order book:");
  asks.forEach((l) => console.log(`  ASK  ${formatAmount(l.size, chosen.loanDec)} @ ${formatAmount(l.price, 18)} (tick ${l.tick})`));
  bids.forEach((l) => console.log(`  BID  ${formatAmount(l.size, chosen.loanDec)} @ ${formatAmount(l.price, 18)} (tick ${l.tick})`));
  const dir = (await rl.ask("Direction buy=buy DCN / sell=sell held DCN: ")).trim().toLowerCase();
  if (dir !== "buy" && dir !== "sell") fail("direction must be buy or sell");
  const request: { units?: bigint; spend?: bigint; limitTick?: bigint } = {};
  if (dir === "buy") {
    const mode = (await rl.ask("By face units or exact spend? [units/spend]: ")).trim().toLowerCase();
    const value = (await rl.ask(`Amount (${chosen.loanSym}): `)).trim();
    if (mode === "spend") request.spend = parseAmount(value, chosen.loanDec);
    else request.units = parseAmount(value, chosen.loanDec);
  } else {
    request.units = parseAmount((await rl.ask(`Sell face (${chosen.loanSym}): `)).trim(), chosen.loanDec);
  }
  const limit = (await rl.ask("Slippage bound tick (optional): ")).trim();
  if (limit) request.limitTick = BigInt(limit);
  const signer = accountFor(ctx);
  const tc = new TradeClient(ctx.profile, signer);
  const plan = dir === "buy" ? await tc.planBuy(live, request) : await tc.planSell(live, request);
  if (plan.takes.length === 0) fail("nothing executable within the given bounds");
  console.log("Sweep plan:");
  plan.takes.forEach((t) => console.log(`  take ${formatAmount(t.units, chosen.loanDec)} @ tick ${t.entry.offer.tick}`));
  console.log(`  total ${formatAmount(plan.totalUnits, chosen.loanDec)} face, ${dir === "buy" ? "cost" : "proceeds"} ${formatAmount(plan.totalCost, chosen.loanDec)} ${chosen.loanSym}, worst tick ${plan.worstTick}`);
  const confirm = (await rl.ask("Execute this plan? [y/N]: ")).trim().toLowerCase();
  if (confirm !== "y") fail("aborted before execution");
  const result = await tc.executePlan(plan);
  console.log(`Done: credit ${result.creditDelta >= 0n ? "+" : ""}${formatAmount(result.creditDelta, chosen.loanDec)}, cash ${result.loanDelta >= 0n ? "+" : ""}${formatAmount(result.loanDelta, chosen.loanDec)} — tx ${result.hash}`);
}

const commands: Record<string, (ctx: Ctx) => Promise<void>> = {
  "strategy catalog": async (ctx) => output(ctx.json, runStrategyCommand("catalog", ctx) as Record<string, unknown>, ""),
  "strategy assess": async (ctx) => output(ctx.json, runStrategyCommand("assess", ctx) as Record<string, unknown>, ""),
  "strategy trace": async (ctx) => output(ctx.json, runStrategyCommand("trace", ctx) as Record<string, unknown>, ""),
  "market list": async (ctx) => {
    const c = client(ctx, false);
    const source = typeof ctx.values.source === "string" ? ctx.values.source : "chain";
    let markets;
    if (source === "relayer") {
      const result = await fetchRelayerMarkets(ctx.profile);
      if (!result.ok) fail(`relayer market index unavailable — not an empty market set: ${result.reason}`);
      if (result.suspiciousEmpty) {
        fail("index reports full coverage but zero markets — likely a lineage mismatch between the index and this core; use --source chain");
      }
      markets = result.markets;
    } else {
      const fromBlock = typeof ctx.values["from-block"] === "string"
        ? BigInt(ctx.values["from-block"])
        : BigInt(ctx.profile.coreDeploymentBlock ?? fail("profile has no coreDeploymentBlock — pass --from-block"));
      markets = await discoverMarketsOnChain(c, { fromBlock });
    }
    const bySymbol = new Map(Object.entries(ctx.profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), { sym, dec: t.decimals }]));
    // Display-only pair ratios for moneyness flags; one fetch per pair, failures degrade to "?".
    const spots = new Map<string, number | null>();
    for (const m of markets) {
      const pair = pairFor(bySymbol.get(m.params.collateralToken.toLowerCase())?.sym, bySymbol.get(m.params.loanToken.toLowerCase())?.sym);
      if (pair && !spots.has(pair)) spots.set(pair, (await fetchPairRatio(ctx.profile.relayerUrl, pair))?.loanPerCollateral ?? null);
    }
    const lines: string[] = [];
    const rows = [];
    for (const m of markets) {
      const loan = bySymbol.get(m.params.loanToken.toLowerCase());
      const coll = bySymbol.get(m.params.collateralToken.toLowerCase());
      const state = await c.marketState(m.id);
      let floor = "?";
      if (loan && coll) { try { floor = floorFromStrike(m.params.strike, loan.dec, coll.dec); } catch { floor = "(off-grid)"; } }
      const marketPair = pairFor(coll?.sym, loan?.sym);
      const spot = marketPair ? spots.get(marketPair) ?? null : null;
      const money = spot !== null && floor !== "?" && floor !== "(off-grid)" ? assessMoneyness(floor, spot) : null;
      const moneyLabel = money === null ? "" : money.itm ? `  LTV ${(money.ratio * 100).toFixed(0)}% [ITM ⚠ the collateral no longer covers the debt]` : `  LTV ${(money.ratio * 100).toFixed(0)}% OTM`;
      const pair = `${coll?.sym ?? m.params.collateralToken.slice(0, 8)}/${loan?.sym ?? m.params.loanToken.slice(0, 8)}`;
      rows.push({ id: m.id, pair, floor, maturity: m.params.maturity, activeCredit: state.activeCredit, repaidCredit: state.repaidCredit, gate: m.params.gate, moneyness: money });
      lines.push(`${pair}  strike ${floor.startsWith("(") || floor === "?" ? floor : fmtStrikeUnit(floor, loan?.sym ?? "loan", coll?.sym ?? "coll")}  maturity ${m.params.maturity}  active ${loan ? formatAmount(state.activeCredit, loan.dec) : state.activeCredit}  repaid ${loan ? formatAmount(state.repaidCredit, loan.dec) : state.repaidCredit}${m.params.gate === ZERO_ADDRESS ? "" : "  [gated]"}${moneyLabel}\n    ${m.id}`);
    }
    output(ctx.json, { source, count: markets.length, markets: rows },
      markets.length === 0 ? "no touched markets found in the scanned range" : lines.join("\n"));
  },

  "market id": async (ctx) => {
    const { params } = await resolveMarket(ctx, false);
    const c = client(ctx, false);
    await c.verifyProfile();
    const id = c.marketId(params);
    const onchain = await c.computeIdOnChain(params);
    if (onchain !== id) fail(`local id ${id} != on-chain ${onchain}`);
    output(ctx.json, { marketId: id, params, onchainVerified: true }, `market id: ${id} (on-chain verified)`);
  },

  // --- MaturitySettler: last-window Dutch settlement. Arming is the borrower's two signatures; the floor is a
  // SHARE of what a settlement unlocks — both their protection and the keeper's budget — so `status` prints the
  // settleable bound beside it. A share needs no re-arming when the position changes size. ---
  "settle arm": async (ctx) => {
    const settler = ctx.profile.maturitySettler ?? fail("profile has no maturitySettler for this chain");
    const market = await resolveMarket(ctx);
    let keepBps: number;
    try {
      keepBps = keepPercentToBps(need(ctx.values.keep as string | undefined, "keep"));
    } catch (error) {
      fail(String((error as Error).message));
    }
    const sc = new SettlerClient(ctx.profile, accountFor(ctx), settler);
    const me = sc.account;
    const grant = await sc.grantOf(me);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (!grantCoversSettler(grant, now)) {
      const tx = await sc.grantSettler();
      console.error(`granted CAP_WITHDRAW_COLLATERAL to the settler (one-time, until revoked): ${tx.hash}`);
    }
    const tx = await sc.arm(market.params, keepBps);
    const id = sc.marketId(market.params);
    const auth = await sc.authorization(id, me);
    output(ctx.json, { armed: auth.enabled, keepBps: auth.minKeptBps, tx: tx.hash },
      `armed: keep >= ${(auth.minKeptBps / 100).toFixed(2)}% of the collateral a settlement unlocks (${tx.hash})`);
  },
  "settle disarm": async (ctx) => {
    const settler = ctx.profile.maturitySettler ?? fail("profile has no maturitySettler for this chain");
    const market = await resolveMarket(ctx);
    const sc = new SettlerClient(ctx.profile, accountFor(ctx), settler);
    const tx = await sc.disarm(market.params);
    output(ctx.json, { disarmed: true, tx: tx.hash }, `disarmed (${tx.hash})`);
  },
  "settle status": async (ctx) => {
    const settler = ctx.profile.maturitySettler ?? fail("profile has no maturitySettler for this chain");
    const market = await resolveMarket(ctx);
    const sc = new SettlerClient(ctx.profile, undefined, settler);
    const borrower = getAddress((ctx.values.borrower as string | undefined) ?? fail("--borrower is required (status is a view; no key implies no default account)")) as Address;
    const id = sc.marketId(market.params);
    const [auth, position, window] = await Promise.all([
      sc.authorization(id, borrower), sc.position(id, borrower), sc.settleWindow(),
    ]);
    // Only the LOCKED collateral is on the auction's table: what the borrower already freed is forwarded untouched.
    const freed = position.collateral;
    const floor = await sc.floorOf(freed, auth.minKeptBps);
    const cap = await sc.maxAsk(freed, market.params.maturity, floor);
    // The settleable bound needs R; degrade to null when the pair feed cannot answer.
    const collInfo = Object.entries(ctx.profile.tokens ?? {}).find(([, t]) => t.address === market.params.collateralToken);
    const loanInfo = Object.entries(ctx.profile.tokens ?? {}).find(([, t]) => t.address === market.params.loanToken);
    const pair = pairFor(collInfo?.[0], loanInfo?.[0]);
    const ratio = pair ? await fetchPairRatio(ctx.profile.relayerUrl, pair) : null;
    const collateralUnits = Number(freed) / 10 ** market.collateralDecimals;
    const debtUnits = Number(position.debt) / 10 ** market.loanDecimals;
    const bound = ratio ? maxSettleableFloor(collateralUnits, debtUnits, ratio.loanPerCollateral) : null;
    const boundBps = ratio ? maxSettleableKeptBps(collateralUnits, debtUnits, ratio.loanPerCollateral) : null;
    const fmtC = (v: bigint) => formatAmount(v, market.collateralDecimals);
    const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
    output(ctx.json, {
      armed: auth.enabled, keepBps: auth.minKeptBps, floor: fmtC(floor), debt: formatAmount(position.debt, market.loanDecimals),
      collateral: fmtC(position.collateral), withdrawable: fmtC(position.collateralWithdrawable),
      dutchCapNow: fmtC(cap), settleWindowSeconds: window.toString(),
      settleableFloorBound: bound === null ? null : bound.toFixed(6),
      settleableKeepBpsBound: boundBps,
    }, [
      `armed ${auth.enabled} | keep >= ${pct(auth.minKeptBps)} of what settles (= ${fmtC(floor)} collateral on the current position)`,
      `debt ${formatAmount(position.debt, market.loanDecimals)} | locked collateral ${fmtC(freed)} | already withdrawable ${fmtC(position.collateralWithdrawable)} (forwarded untouched)`,
      `dutch cap now ${fmtC(cap)} | window ${window}s before maturity`,
      bound === null || boundBps === null
        ? "settleable bound: unknown (pair ratio unavailable)"
        : `settleable bound ~${bound.toFixed(6)} collateral (keep <= ${pct(boundBps)}) — a share above this arms nothing (no keeper can profit)`,
    ].join("\n"));
  },
  "settle execute": async (ctx) => {
    const settler = ctx.profile.maturitySettler ?? fail("profile has no maturitySettler for this chain");
    const market = await resolveMarket(ctx);
    const borrower = getAddress(need(ctx.values.borrower as string | undefined, "borrower")) as Address;
    const sc = new SettlerClient(ctx.profile, accountFor(ctx), settler);
    const id = sc.marketId(market.params);
    const [auth, position] = await Promise.all([sc.authorization(id, borrower), sc.position(id, borrower)]);
    if (!auth.enabled) fail("borrower has not armed this market");
    if (position.debt === 0n) fail("no debt to settle");
    // Only the locked collateral unlocks on repay; the floor is the borrower's share of it.
    const freed = position.collateral;
    const floor = await sc.floorOf(freed, auth.minKeptBps);
    // Default to the Dutch cap: asking less only helps against rival keepers, who are the mechanism for that.
    const ask = typeof ctx.values.ask === "string"
      ? parseAmount(ctx.values.ask, market.collateralDecimals)
      : await sc.maxAsk(freed, market.params.maturity, floor);
    if (ctx.values["via-jit"] && ctx.values["via-morpho"]) fail("choose one of --via-jit / --via-morpho");
    if (ctx.values["via-jit"] || ctx.values["via-morpho"]) {
      // Zero-capital routes. --via-jit: the V4JitKeeper funds the repay from a v4 pool's flash accounting.
      // --via-morpho: the MorphoJitFunder flash-borrows from Morpho Blue and only converts on the pool — for loan
      // legs whose depth is in Morpho. Either way this wallet holds nothing, approves nothing, and collects the
      // surplus; an unprofitable settle reverts whole.
      const viaMorpho = ctx.values["via-morpho"] === true;
      const wrapper = viaMorpho
        ? (ctx.profile.morphoJitFunder ?? fail("profile has no morphoJitFunder for this chain"))
        : (ctx.profile.v4JitKeeper ?? fail("profile has no v4JitKeeper for this chain"));
      const minProfit = typeof ctx.values["min-profit"] === "string"
        ? parseAmount(ctx.values["min-profit"], market.loanDecimals) : 0n;
      const key = poolKeyFor(
        market.params.collateralToken, market.params.loanToken,
        Number(ctx.values["pool-fee"] ?? 3000), Number(ctx.values["pool-spacing"] ?? 60),
        getAddress((ctx.values["pool-hooks"] as string | undefined) ?? "0x0000000000000000000000000000000000000000") as Address,
      );
      const tx = viaMorpho
        ? await sc.settleWithMorpho(wrapper, market.params, borrower, ask, key, minProfit)
        : await sc.settleWithFlash(wrapper, market.params, borrower, ask, key, minProfit);
      const route = viaMorpho ? "Morpho flash loan, converted on v4" : "v4 flash";
      output(ctx.json, { settled: true, viaJit: !viaMorpho, viaMorpho, repaid: formatAmount(position.debt, market.loanDecimals), ask: formatAmount(ask, market.collateralDecimals), tx: tx.hash },
        `settled via ${route}: repaid ${formatAmount(position.debt, market.loanDecimals)} loan with borrowed money, ask ${formatAmount(ask, market.collateralDecimals)} collateral, surplus to this wallet (${tx.hash})`);
      return;
    }
    // The keeper fronts the debt it just read and names that size on-chain: approve exactly it, then settle. If
    // the debt moves before the transaction lands, a repay-in-full market refuses the slice and a partial-repay
    // market settles exactly this much — either way the keeper never advances more than it priced.
    await sc.approveExact(market.params.loanToken, settler, position.debt);
    const tx = await sc.settle(market.params, borrower, position.debt, ask);
    output(ctx.json, { settled: true, repaid: formatAmount(position.debt, market.loanDecimals), ask: formatAmount(ask, market.collateralDecimals), tx: tx.hash },
      `settled: fronted ${formatAmount(position.debt, market.loanDecimals)} loan, ask ${formatAmount(ask, market.collateralDecimals)} collateral (${tx.hash})`);
  },
  "market state": async (ctx) => {
    const { params, loanDecimals, collateralDecimals } = await resolveMarket(ctx);
    const c = client(ctx, false);
    const id = c.marketId(params);
    const s = await c.marketState(id);
    output(
      ctx.json,
      { marketId: id, ...s },
      [
        `market ${id}`,
        `  touched:           ${s.touched}`,
        `  activeCredit:      ${formatAmount(s.activeCredit, loanDecimals)} (face)`,
        `  repaidCredit:      ${formatAmount(s.repaidCredit, loanDecimals)}`,
        `  activeCollateral:  ${formatAmount(s.activeCollateral, collateralDecimals)}`,
        `  claimedCredit:     ${formatAmount(s.claimedCredit, loanDecimals)}`,
      ].join("\n"),
    );
  },

  "read position": async (ctx) => {
    const { params, loanDecimals, collateralDecimals } = await resolveMarket(ctx);
    const account = getAddress(need(ctx.values.account as string | undefined, "account")) as Address;
    const c = client(ctx, false);
    const p = await c.position(c.marketId(params), account);
    output(
      ctx.json,
      { ...p },
      `debt ${formatAmount(p.debt, loanDecimals)} | collateral ${formatAmount(p.collateral, collateralDecimals)} | withdrawable ${formatAmount(p.collateralWithdrawable, collateralDecimals)}`,
    );
  },

  "read credit": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const account = getAddress(need(ctx.values.account as string | undefined, "account")) as Address;
    const c = client(ctx, false);
    const credit = await c.creditOf(c.marketId(params), account);
    output(ctx.json, { credit }, `credit: ${formatAmount(credit, loanDecimals)} DCN face`);
  },

  "read liquidity": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const account = getAddress(need(ctx.values.account as string | undefined, "account")) as Address;
    const c = client(ctx, false);
    const liquidity = await c.liquidityOf(c.marketId(params), account);
    output(ctx.json, { liquidity }, `liquidity: ${formatAmount(liquidity, loanDecimals)}`);
  },

  "maker set-ratifier": async (ctx) => {
    const rat = resolveRatifierOr(ctx);
    const c = client(ctx, true);
    const tx = await c.setRatifier(rat.address, ctx.values.off !== true);
    output(ctx.json, { ...tx, ratifier: rat.address, ratifierKind: rat.kind }, `setRatifier(${rat.kind} ${rat.address}, ${ctx.values.off !== true}): ${tx.hash}`);
  },

  // On-chain approval of a whole book: one flag authorizes every offer in the tree, clearing it retires
  // them all. `--commitment` may repeat; with one commitment the root IS that commitment.
  "maker ratify-root": async (ctx) => {
    const setter = ctx.profile.setterRatifier ?? fail("profile has no setterRatifier — deploy one first (bivium-core script/DeploySetterRatifier.s.sol)");
    // Two ways in: raw commitments, or the offer FILES themselves. With files the proofs are written
    // back into each file, which is what makes a multi-offer tree usable at all — an offer minted on
    // its own carries the empty proof of a single-offer root, and that proof is wrong the moment the
    // offer joins a bigger tree.
    const files = (typeof ctx.values.offer === "string" ? ctx.values.offer.split(",") : []).map((x) => x.trim()).filter(Boolean);
    const raw = ctx.values.commitment;
    let list = (typeof raw === "string" ? raw.split(",") : []).map((x) => x.trim()).filter(Boolean);
    if (files.length && list.length) fail("pass --offer or --commitment, not both");
    const loaded = files.map((f) => {
      const parsed = parseSignedOfferFile(readFileSync(f, "utf8"), ctx.profile);
      if (getAddress(parsed.offer.ratifier) !== getAddress(setter)) {
        fail(`${f} names ratifier ${parsed.offer.ratifier}, not the setter ${setter} — remake it with --ratifier setter`);
      }
      return { path: f, commitment: parsed.commitment };
    });
    if (loaded.length) list = loaded.map((l) => l.commitment);
    if (!list.length) fail("--offer <file>[,<file>...] or --commitment <hash>[,<hash>...] is required");
    for (const h of list) if (!/^0x[0-9a-fA-F]{64}$/.test(h)) fail(`not a commitment: ${h}`);
    const tree = buildOfferTree(list as Hex[]);
    const c = client(ctx, true);
    const maker = getAddress((ctx.values.maker as string | undefined) ?? c.account) as Address;
    const on = ctx.values.off !== true;
    const already = await c.isRootRatified(setter, maker, tree.root);
    const tx = already === on ? null : await c.setRootRatified(setter, maker, tree.root, on);
    const proofs = tree.leaves.map((leaf, i) => ({ commitment: leaf, proof: tree.proofs[i]!, ratifierData: encodeProofRatifierData(tree.proofs[i]!) }));
    // Write each proof back so the file is fillable as a member of THIS tree.
    const rewritten: string[] = [];
    if (on) {
      for (const l of loaded) {
        const i = tree.leaves.indexOf(l.commitment.toLowerCase() as Hex);
        const file = JSON.parse(readFileSync(l.path, "utf8")) as Record<string, unknown>;
        file.signature = proofs[i]!.ratifierData;
        writeFileSync(l.path, JSON.stringify(file, null, 2) + "\n");
        rewritten.push(l.path);
      }
    }
    output(ctx.json, { root: tree.root, maker, ratified: on, tx: tx?.hash ?? null, proofs, rewritten }, [
      `root ${tree.root}  (${tree.leaves.length} offer${tree.leaves.length === 1 ? "" : "s"})`,
      `maker ${maker}  ratified ${on}  ${tx ? tx.hash : "already in that state, no transaction sent"}`,
      ...proofs.map((p) => `  ${p.commitment}  ratifierData ${p.ratifierData.length > 74 ? p.ratifierData.slice(0, 70) + "…" : p.ratifierData}`),
      ...rewritten.map((f) => `  proof written back to ${f}`),
      on ? "each offer above fills by passing its ratifierData; clearing this one root retires them all" : "cleared: every offer in this tree is retired",
    ].join("\n"));
  },

  "maker fund": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const c = client(ctx, true);
    const tx = await c.fund(params, assets);
    output(ctx.json, { ...tx, assets }, `funded ${formatAmount(assets, loanDecimals)} into ${c.marketId(params)}: ${tx.hash}`);
  },

  "maker escrow": async (ctx) => {
    const { params, collateralDecimals } = await resolveMarket(ctx);
    const amount = parseAmount(need(ctx.values.assets as string | undefined, "assets"), collateralDecimals);
    const c = client(ctx, true);
    const tx = await c.escrowCollateral(params, amount);
    const backs = debtForCollateral(amount, params.strike);
    output(
      ctx.json,
      { ...tx, amount, backsUnits: backs },
      `escrowed ${formatAmount(amount, collateralDecimals)} into ${c.marketId(params)}: ${tx.hash}`,
      // What the stake is FOR: the face a resting ask can now be filled for. Saying it here is what stops the
      // next step being an offer larger than the escrow behind it.
    );
  },

  "maker withdraw-escrow": async (ctx) => {
    const { params, collateralDecimals } = await resolveMarket(ctx);
    const amount = parseAmount(need(ctx.values.assets as string | undefined, "assets"), collateralDecimals);
    const c = client(ctx, true);
    const receiver = (typeof ctx.values.receiver === "string" ? ctx.values.receiver : c.account) as Address;
    const tx = await c.withdrawCollateralEscrow(params, amount, receiver);
    output(ctx.json, { ...tx, amount, receiver }, `withdrew ${formatAmount(amount, collateralDecimals)} of escrow to ${receiver}: ${tx.hash}`);
  },

  "maker withdraw-liquidity": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : c.account;
    const tx = await c.withdrawLiquidity(params, assets, receiver);
    output(ctx.json, { ...tx }, `withdrew ${formatAmount(assets, loanDecimals)} to ${receiver}: ${tx.hash}`);
  },


  portfolio: async (ctx) => {
    // Aggregated view across ALL discovered markets: borrow positions, DCN holdings, escrowed
    // liquidity, and (when a book source is reachable) resting orders for one account.
    const c = client(ctx, false);
    const account = getAddress(
      typeof ctx.values.account === "string" ? ctx.values.account : accountFor(ctx).address,
    ) as Address;
    const fromBlock = BigInt(ctx.profile.coreDeploymentBlock ?? fail("profile has no coreDeploymentBlock"));
    const markets = await discoverMarketsOnChain(c, { fromBlock });
    const bySymbol = new Map(Object.entries(ctx.profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), { sym, dec: t.decimals }]));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const canRelayerOrders = Boolean(ctx.profile.relayerUrl) && ctx.profile.abiProfile === "core-v2";
    const wantOrders = canRelayerOrders || typeof ctx.values.dir === "string";
    const lines: string[] = [`portfolio of ${account}`];
    const rows = [];
    for (const m of markets) {
      const id = c.marketId(m.params);
      const [position, credit, liquidity] = await Promise.all([
        c.position(id, account),
        c.creditOf(id, account),
        c.liquidityOf(id, account),
      ]);
      let orders: Array<{ commitment: Hex; side: string; remaining: bigint; tick: bigint }> = [];
      if (wantOrders) {
        try {
          if (!canRelayerOrders) ctx.values.source = "files";
          else ctx.values.source = "relayer";
          const { entries } = await loadBookEntries(ctx, m.params);
          const tc = new TradeClient(ctx.profile);
          const live = await tc.reconcileBook(entries);
          orders = live
            .filter((e) => e.offer.maker.toLowerCase() === account.toLowerCase())
            .map((e) => ({ commitment: e.commitment, side: e.side, remaining: e.size, tick: e.offer.tick }));
        } catch {
          orders = []; // book source unreachable — positions remain authoritative from the chain
        }
      }
      const empty = position.debt === 0n && position.collateral === 0n && position.collateralWithdrawable === 0n && credit === 0n && liquidity === 0n && orders.length === 0;
      if (empty) continue;
      const loan = bySymbol.get(m.params.loanToken.toLowerCase());
      const coll = bySymbol.get(m.params.collateralToken.toLowerCase());
      const loanDec = loan?.dec ?? (await c.tokenDecimals(m.params.loanToken));
      const collDec = coll?.dec ?? (await c.tokenDecimals(m.params.collateralToken));
      const pair = `${coll?.sym ?? m.params.collateralToken.slice(0, 8)}/${loan?.sym ?? m.params.loanToken.slice(0, 8)}`;
      const matured = m.params.maturity <= now;
      rows.push({ marketId: id, pair, matured, position, credit, liquidity, orders });
      lines.push(`\n${pair}  maturity ${m.params.maturity}${matured ? "  [MATURED]" : ""}  ${id}`);
      if (position.debt > 0n) lines.push(`  Loan: debt ${formatAmount(position.debt, loanDec)}, locked ${formatAmount(position.collateral, collDec)}${matured ? " — repayment window closed; collateral goes to settlement" : " — repay the exact face before maturity"}`);
      if (position.collateralWithdrawable > 0n) lines.push(`  Reclaimable collateral: ${formatAmount(position.collateralWithdrawable, collDec)} (run reclaim)`);
      if (credit > 0n) lines.push(`  DCN holdings: ${formatAmount(credit, loanDec)}${matured ? " (matured — claim the settlement basket)" : ""}`);
      if (liquidity > 0n) lines.push(`  Escrowed liquidity: ${formatAmount(liquidity, loanDec)}`);
      for (const o of orders) lines.push(`  Order[${o.side}] remaining ${formatAmount(o.remaining, loanDec)} @ tick ${o.tick}  ${o.commitment.slice(0, 10)}…`);
    }
    if (rows.length === 0) lines.push("  (no positions, holdings, or resting orders on any discovered market)");
    if (!wantOrders) lines.push("\n(resting orders need a relayer or --dir order directory to be visible; on-chain positions are unaffected)");
    output(ctx.json, { account, markets: rows }, lines.join("\n"));
  },

  "wizard": async (ctx) => {
    const rl = makeAsker();
    try {
      console.log("bivium wizard — what would you like to do?");
      console.log("  [1] Lend / quote (deposit liquidity and sign a resting offer)");
      console.log("  [2] Borrow (take a resting bid against collateral)");
      console.log("  [3] Trade DCN (market buy/sell existing credit)");
      const intent = (await rl.ask("Choose [1-3]: ")).trim();
      if (intent === "1") await wizardLend(ctx, rl);
      else if (intent === "2") await wizardBorrow(ctx, rl);
      else if (intent === "3") await wizardTrade(ctx, rl);
      else fail("invalid intent selection");
    } finally {
      rl.close();
    }
  },

  "maker wizard": async (ctx) => {
    const rl = makeAsker();
    try {
      await wizardLend(ctx, rl);
    } finally {
      rl.close();
    }
  },


  "maker make-offer": async (ctx) => {
    await runMakeOffer(ctx, await resolveMarket(ctx));
  },

  "book list": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const { entries, source } = await loadBookEntries(ctx, params);
    const tc = new TradeClient(ctx.profile);
    const live = await tc.reconcileBook(entries);
    const depth = typeof ctx.values.depth === "string" ? Number(ctx.values.depth) : 10;
    if (!Number.isInteger(depth) || depth <= 0) fail("--depth must be a positive integer");
    const asks = aggregateLevels(sortSide(live, "ask")).slice(0, depth);
    const bids = aggregateLevels(sortSide(live, "bid")).slice(0, depth);
    const block = await tc.pub.getBlock();
    const term = params.maturity > block.timestamp ? params.maturity - block.timestamp : 0n;
    output(
      ctx.json,
      {
        source,
        marketId: tc.marketId(params),
        asks: asks.map((l) => ({ tick: l.tick, price: l.price, size: l.size, cumulative: l.cumulative, makers: [...new Set(l.entries.map((e) => e.maker))] })),
        bids: bids.map((l) => ({ tick: l.tick, price: l.price, size: l.size, cumulative: l.cumulative, makers: [...new Set(l.entries.map((e) => e.maker))] })),
      },
      [
        `book for market ${tc.marketId(params)} (source ${source})`,
        `ASKS (makers selling credit — best price first):`,
        ...(asks.length ? renderLevels(asks, loanDecimals, term) : ["  (empty)"]),
        `BIDS (makers buying credit — best price first):`,
        ...(bids.length ? renderLevels(bids, loanDecimals, term) : ["  (empty)"]),
      ].join("\n"),
    );
  },

  "trade buy": async (ctx) => await runTrade(ctx, "buy"),

  "trade sell": async (ctx) => await runTrade(ctx, "sell"),

  "order list": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const maker = getAddress(need(ctx.values.maker as string | undefined, "maker")) as Address;
    const { entries, source } = await loadBookEntries(ctx, params);
    const mine = entries.filter((e) => e.maker.toLowerCase() === maker.toLowerCase());
    const c = client(ctx, false);
    const block = await c.pub.getBlock();
    const rows = await Promise.all(
      mine.map(async (e) => {
        const consumed = await c.consumed(maker, e.offer.group);
        const cap = offerCap(e.offer);
        return {
          commitment: e.commitment,
          side: e.side,
          tick: e.offer.tick,
          price: e.price,
          consumed,
          cap,
          remainingFace: remainingFace(e.offer, consumed, e.price),
          withinWindow: block.timestamp >= e.offer.start && block.timestamp <= e.offer.expiry,
        };
      }),
    );
    output(
      ctx.json,
      { source, maker, orders: rows },
      [
        `${rows.length} resting order(s) by ${maker} (source ${source})`,
        ...rows.map(
          (r) =>
            `  ${r.side.toUpperCase()} tick ${r.tick}  consumed ${r.consumed}/${r.cap}${r.consumed >= r.cap ? " (DEAD)" : ""}  remaining face ${formatAmount(r.remainingFace, loanDecimals)}  window ${r.withinWindow ? "open" : "CLOSED"}  ${r.commitment}`,
        ),
      ].join("\n"),
    );
  },

  "order cancel": async (ctx) => {
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const tc = new TradeClient(ctx.profile, loadKeyAccount(ctx.keyEnv));
    const r = await tc.cancelOffer(file);
    const relayerNote = r.relayer === "deleted" ? "relayer copy delisted" : r.relayer === "skipped" ? "no relayer configured" : `WARNING: relayer delist failed (${r.relayer.failed}) — on-chain cancel is the authority`;
    output(
      ctx.json,
      { commitment: file.commitment, cap: r.cap, consumedBefore: r.consumedBefore, hash: r.tx?.hash, relayer: r.relayer },
      [
        r.tx
          ? `offer ${file.commitment} cancelled on-chain: consumed pinned to cap ${r.cap} — tx ${r.tx.hash}`
          : `offer ${file.commitment} already dead on-chain (consumed ${r.consumedBefore} ≥ cap ${r.cap})`,
        `  ${relayerNote}`,
      ].join("\n"),
    );
  },

  "offer status": async (ctx) => {
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const c = client(ctx, false);
    await c.verifyProfile();
    const s = await c.offerStatus(file.offer, file.signature);
    const loanDecimals = await tokenDecimals(ctx, file.offer.loanToken);
    output(
      ctx.json,
      { ...s },
      [
        `offer ${s.commitment}`,
        `  market:      ${s.marketId}`,
        `  window:      ${s.withinWindow ? "open" : "CLOSED"}${s.matured ? " (MATURED)" : ""}`,
        `  consumed:    ${formatAmount(s.consumed, loanDecimals)} / ${formatAmount(s.cap, loanDecimals)} (remaining ${formatAmount(s.remainingUnits, loanDecimals)})`,
        `  maker liq:   ${formatAmount(s.makerLiquidity, loanDecimals)}`,
        `  ratifier:    ${s.ratifierRegistered ? "registered" : "NOT REGISTERED"}, precheck ${s.ratified ? "RATIFIED ✓" : "FAILED"}`,
      ].join("\n"),
    );
  },

  "borrow quote": async (ctx) => {
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const loanDecimals = await tokenDecimals(ctx, file.offer.loanToken);
    const collateralDecimals = await tokenDecimals(ctx, file.offer.collateralToken);
    const units = typeof ctx.values.units === "string" ? parseAmount(ctx.values.units, loanDecimals) : file.offer.maxUnits;
    const q = await client(ctx, false).quoteFill(file.offer, units);
    output(
      ctx.json,
      { units, ...q },
      [
        `borrow ${formatAmount(units, loanDecimals)} face:`,
        `  price:      ${formatAmount(q.priceWad, 18)}`,
        `  principal:  ${formatAmount(q.principal, loanDecimals)} (you receive)`,
        `  collateral: ${formatAmount(q.collateral, collateralDecimals)} (locked)`,
        `  simple APR: ${Number(q.aprBps) / 100}%  (term ${q.secondsToMaturity}s)`,
      ].join("\n"),
    );
  },

  "borrow execute": async (ctx) => {
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const loanDecimals = await tokenDecimals(ctx, file.offer.loanToken);
    const units = parseAmount(need(ctx.values.units as string | undefined, "units"), loanDecimals);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : undefined;
    const result = await c.fillAsBorrower(file.offer, file.signature, units, receiver);
    output(
      ctx.json,
      { ...result },
      `borrowed: received ${formatAmount(result.principal, loanDecimals)} for ${formatAmount(units, loanDecimals)} face — tx ${result.hash}`,
    );
  },

  repay: async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const tx = await client(ctx, true).repay(params, assets);
    output(ctx.json, { ...tx }, `repaid ${formatAmount(assets, loanDecimals)}: ${tx.hash}`);
  },

  reclaim: async (ctx) => {
    const { params } = await resolveMarket(ctx);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : undefined;
    const tx = await c.withdrawCollateral(params, receiver);
    output(ctx.json, { ...tx }, `collateral withdrawn: ${tx.hash}`);
  },

  claim: async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const units = parseAmount(need(ctx.values.units as string | undefined, "units"), loanDecimals);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : undefined;
    const tx = await c.claim(params, units, receiver);
    output(ctx.json, { ...tx }, `claimed ${formatAmount(units, loanDecimals)} DCN face: ${tx.hash}`);
  },

  // ── strategies: view → market → the five confirm-screen numbers → a bounded plan ─────────────
  // The engine (src/sdk/strategies) is pure; this layer only gathers inputs: discovered markets,
  // the pair feed's spot, and a fill price (an explicit rate, or the live book's best bid/ask).

  "strategy list": async (ctx) => {
    const lines = STRATEGIES.map((s) =>
      `${s.id.padEnd(14)} ${s.name.padEnd(10)} ${s.group.padEnd(10)} ${s.side}/${s.line.padEnd(8)} ${s.quotable ? "quotable" : s.requires.length ? "needs " + s.requires.join("+") + " (declared)" : "2 legs, orchestrate separately (declared)"}${s.mirrorOf ? `  mirror: ${s.mirrorOf}` : ""}\n    ${s.oneLiner}`,
    );
    output(ctx.json, { count: STRATEGIES.length, strategies: catalogJson() as unknown as Record<string, unknown>[] }, lines.join("\n"));
  },

  "strategy quote": async (ctx) => {
    const g = await gatherStrategy(ctx);
    output(ctx.json, gatheredToJson(g), renderStrategyQuote(ctx, g));
  },

  "strategy program": async (ctx) => {
    const built = await buildStrategyProgram(ctx, false);
    output(ctx.json, built.json, built.human.join("\n"));
  },

  "strategy execute": async (ctx) => {
    const built = await buildStrategyProgram(ctx, true);
    const c = built.client;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const sent: Record<string, string> = {};
    if (programNeedsGrant(built.legs)) {
      const grant = await c.grantIfNeeded(built.grantExpiry, nowSec);
      if (grant) sent.grant = grant.hash;
    }
    for (const [token, amount] of built.approvals) {
      if (amount > 0n) sent[`approve:${token}`] = (await c.approveForProgram(token, amount)).hash;
    }
    const tx = await c.execute(built.legs, built.deadline);
    output(
      ctx.json,
      { ...built.json, sent: { ...sent, execute: tx.hash } },
      [...built.human, "", `executed: ${tx.hash}`].join("\n"),
    );
  },

  "strategy positions": async (ctx) => {
    const taker = getAddress(need(ctx.values.taker as string | undefined, "taker")) as Address;
    const result = await fetchStrategyPositions(ctx.profile.relayerUrl, taker);
    if (!result.ok) fail(`positions unavailable — not an empty account: ${result.reason}`);
    const lines = result.positions.length === 0
      ? [`no positions for ${taker} across ${result.marketsScanned} listed markets`]
      : result.positions.map((p) => {
        const road = p.branches ? ` | maturity: ${p.branches.better} wins by ${p.branches.netFromRepaying.toFixed(4)} loan` : p.lenderOutcome ? ` | likely ${p.lenderOutcome}` : "";
        const arm = p.autoSettle ? ` | auto-settle ${p.autoSettle.armed ? `armed keep ${(p.autoSettle.keepBps / 100).toFixed(1)}%` : "off"}` : "";
        return `${p.urgent ? "⚠ " : ""}${p.key}  ${p.side}${p.kinds.length ? ` (${p.kinds.join(" | ")})` : ""}  debt ${p.debt} coll ${p.collateral} credit ${p.credit} liq ${p.liquidity}${p.bufferPct === undefined ? "" : ` | buffer ${p.bufferPct.toFixed(1)}%`}${road}${arm}\n    exit: ${p.exit.action} — ${p.exit.note}`;
      });
    output(ctx.json, result as unknown as Record<string, unknown>, lines.join("\n"));
  },

  "strategy plan": async (ctx) => {
    const g = await gatherStrategy(ctx);
    const v = ctx.values;
    const plan = planFromGathered(ctx.profile, g, {
      router: typeof v.router === "string" ? (getAddress(v.router) as Address) : undefined,
      minOut: typeof v["min-out"] === "string" ? v["min-out"] : undefined,
      ttlSeconds: typeof v.ttl === "string" ? BigInt(v.ttl) : undefined,
    });
    output(ctx.json, { ...gatheredToJson(g), plan: plan as unknown as Record<string, unknown> }, [renderStrategyQuote(ctx, g), "", ...renderStrategyPlan(g, plan)].join("\n"));
  },

  "vault activate": async (ctx) => {
    const sats = rawBigInt(ctx.values.sats as string | undefined, "sats");
    const vaultId = typeof ctx.values["vault-id"] === "string"
      ? bytes32Flag(ctx.values["vault-id"], "vault-id")
      : (`0x${randomBytes(32).toString("hex")}` as Hex);
    const c = vaultClient(ctx, true);
    const depositor = typeof ctx.values.depositor === "string" ? (getAddress(ctx.values.depositor) as Address) : c.account;
    const r = await c.activateMock(vaultId, depositor, sats);
    output(
      ctx.json,
      { ...r },
      [
        `mock vault activated: ${vaultId}`,
        `  depositor: ${depositor}`,
        `  amount:    ${btc(sats)} vaultBTC minted, lot Reserved`,
        `  tx ${r.hash}`,
      ].join("\n"),
    );
  },

  "vault list": async (ctx) => {
    const c = vaultClient(ctx, false);
    const account = getAddress(typeof ctx.values.account === "string" ? ctx.values.account : accountFor(ctx).address) as Address;
    const lots = await c.listLots(account);
    const views = await c.resolveLots(lots, account);
    const rows = views.map((v) => ({
      vaultId: v.lot.vaultId,
      status: lotStatusName(v.lot.status),
      amount: v.lot.amount,
      loanId: lotIsBound(v.lot) ? v.lot.loanId : null,
      borrower: lotIsBound(v.lot) ? v.lot.borrower : null,
      maturity: lotIsBound(v.lot) ? v.lot.maturity : null,
      converted: v.lot.converted,
      state: v.state,
      action: v.action,
      secondary: v.secondary,
      convert: v.convert === true,
    }));
    output(
      ctx.json,
      { account, count: rows.length, lots: rows },
      rows.length === 0
        ? `no vaults wrapped for ${account} (vault activate --sats <sats> opens a mock one on testnet)`
        : [
            `${rows.length} vault(s) wrapped for ${account}`,
            ...rows.map((r) => `  ${r.vaultId}\n    ${r.status}${r.converted ? " (converted)" : ""}  ${btc(r.amount)}${r.loanId ? `  loan ${r.loanId.slice(0, 10)}… maturity ${r.maturity}` : ""}\n    ${r.state}`),
          ].join("\n"),
    );
  },

  "vault status": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const c = vaultClient(ctx, false);
    const viewer = typeof ctx.values.account === "string" ? (getAddress(ctx.values.account) as Address) : undefined;
    const v = await c.resolveLot(vaultId, viewer);
    const l = v.lot;
    const bound = lotIsBound(l);
    const next = [
      v.action === "reclaim" && v.convert ? "borrow (vault borrow), convert (vault convert), or reclaim (vault reclaim)" : "",
      v.action === "reclaim" && !v.convert ? "reclaim (vault reclaim)" : "",
      v.secondary === "release" ? "release the binding to borrow again (vault release)" : "",
      v.action === "repay-first" ? "repay the exact face on the core (bivium repay), then bivium reclaim, then vault release" : "",
      v.action === "withdraw-first" ? "withdraw the group's collateral (bivium reclaim), then vault release or vault reclaim" : "",
      v.action === "unconvert" ? "unconvert (burn equal TBVBTC) while no keeper has settled it" : "",
      v.action === "awaiting-settle" ? "keeper: vault keeper settle" : "",
      v.action === "none" ? "none" : "",
    ].filter(Boolean).join("; ");
    output(
      ctx.json,
      { ...l, statusName: lotStatusName(l.status), state: v.state, action: v.action, secondary: v.secondary, convert: v.convert === true },
      [
        `vault ${vaultId}`,
        `  status:        ${lotStatusName(l.status)}${l.converted ? " (converted)" : ""}`,
        `  origin:        ${l.origin}`,
        `  amount:        ${btc(l.amount)}`,
        ...(bound ? [`  loanId:        ${l.loanId}`, `  borrower:      ${l.borrower}`, `  maturity:      ${l.maturity}`] : [`  loan:          unbound`]),
        `  keeperVersion: ${l.keeperVersion}`,
        `  state:         ${v.state}`,
        `  next:          ${next}`,
      ].join("\n"),
    );
  },

  "vault borrow": async (ctx) => {
    const ids = need(ctx.values["vault-id"] as string | undefined, "vault-id").split(",").map((v) => bytes32Flag(v.trim(), "vault-id"));
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const loanDecimals = await tokenDecimals(ctx, file.offer.loanToken);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : undefined;
    const dryRun = ctx.values["dry-run"] === true;
    const c = vaultClient(ctx, true);
    if (dryRun) {
      const q = await c.quoteBorrow(ids, file.offer, c.account);
      const p = await c.borrowPrereqs(ids);
      const status = await c.offerStatus(file.offer, file.signature);
      output(
        ctx.json,
        { dryRun: true, ...q, lots: q.lots.map((l) => l.vaultId), approved: p.approved, granted: p.granted, remainingUnits: status.remainingUnits, ratified: status.ratified, withinWindow: status.withinWindow },
        [
          `whole-lot borrow (dry run) — ${ids.length} vault(s), ${btc(q.sumSats)}`,
          `  market:     ${q.marketId}`,
          `  face:       ${formatAmount(q.face, loanDecimals)} (Σsats × strike / 1e36)`,
          `  swept credit: ${formatAmount(q.credit, loanDecimals)} → units filled ${formatAmount(q.units, loanDecimals)}`,
          `  price:      ${formatAmount(q.priceWad, 18)} (tick ${file.offer.tick})`,
          `  principal:  ${formatAmount(q.principal, loanDecimals)} (receiver gets)`,
          `  offer:      remaining ${formatAmount(status.remainingUnits, loanDecimals)}, window ${status.withinWindow ? "open" : "CLOSED"}, precheck ${status.ratified ? "RATIFIED" : "FAILED"}`,
          `  prereqs:    vaultBTC approve ${p.approved ? "ok" : "NEEDED"}, CAP_FILL grant ${p.granted ? "ok" : "NEEDED"}`,
        ].join("\n"),
      );
      return;
    }
    const pre = await c.ensureBorrowPrereqs(ids);
    if (pre.approveTx) console.error(`approved ${pre.sumSats} sats vaultBTC to the app: ${pre.approveTx.hash}`);
    if (pre.grantTx) console.error(`granted CAP_FILL to the app: ${pre.grantTx.hash}`);
    const r = await c.borrowAgainst(ids, file.offer, file.signature, receiver);
    output(
      ctx.json,
      { ...r, lots: r.lots.map((l) => l.vaultId), approveTx: pre.approveTx?.hash, grantTx: pre.grantTx?.hash },
      [
        `borrowed against ${ids.length} vault(s) (${btc(r.sumSats)}): received ${formatAmount(r.principal, loanDecimals)} for ${formatAmount(r.units, loanDecimals)} units (face ${formatAmount(r.face, loanDecimals)} + swept credit ${formatAmount(r.credit, loanDecimals)}) — tx ${r.hash}`,
        `  loan ${r.loanId} — repay the exact face before maturity ${file.offer.maturity} (bivium repay), then bivium reclaim, then vault release`,
      ].join("\n"),
    );
  },

  "vault release": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const tx = await vaultClient(ctx, true).releaseRepaid(vaultId);
    output(ctx.json, { ...tx, vaultId }, `repaid group released — vault ${vaultId} is unbound and borrowable again: ${tx.hash}`);
  },

  "vault reclaim": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const tx = await vaultClient(ctx, true).reclaim(vaultId);
    output(ctx.json, { ...tx, vaultId }, `vault ${vaultId} reclaimed (vaultBTC burned, lot Consumed): ${tx.hash}`);
  },

  "vault mark-delivered": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const tx = await vaultClient(ctx, true).markDelivered(vaultId);
    output(ctx.json, { ...tx, vaultId }, `defaulted group marked Delivered (vault ${vaultId}): ${tx.hash}`);
  },

  "vault convert": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const r = await vaultClient(ctx, true).convert(vaultId);
    output(
      ctx.json,
      { ...r, vaultId, approveTx: r.approveTx?.hash },
      `vault ${vaultId} converted: ${btc(r.amount)} vaultBTC locked in the escrow, equal TBVBTC minted — tx ${r.hash}${r.approveTx ? ` (approve ${r.approveTx.hash})` : ""}`,
    );
  },

  "vault unconvert": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const r = await vaultClient(ctx, true).unconvert(vaultId);
    output(
      ctx.json,
      { ...r, vaultId },
      `vault ${vaultId} unconverted (${r.wasDefault ? "was defaulted" : "was converted"}): ${btc(r.amount)} TBVBTC burned, vault back as a fresh Reserved lot — tx ${r.hash}`,
    );
  },

  "vault convert-delivered": async (ctx) => {
    const sats = rawBigInt(ctx.values.sats as string | undefined, "sats");
    const r = await vaultClient(ctx, true).convertDelivered(sats);
    output(ctx.json, { ...r, sats, approveTx: r.approveTx?.hash }, `${btc(sats)} delivered vaultBTC converted to TBVBTC: ${r.hash}`);
  },

  "vault redemption post": async (ctx) => {
    const v = ctx.values;
    const input = {
      amount: rawBigInt(v.amount as string | undefined, "amount"),
      minSatsStart: rawBigInt(v["min-sats-start"] as string | undefined, "min-sats-start"),
      minSatsEnd: rawBigInt(v["min-sats-end"] as string | undefined, "min-sats-end"),
      btcDest: need(v["btc-dest"] as string | undefined, "btc-dest") as Hex,
      deadline: rawBigInt(v.deadline as string | undefined, "deadline"),
    };
    if (!/^0x[0-9a-fA-F]+$/.test(input.btcDest) || input.btcDest.length % 2 !== 0) fail("--btc-dest must be hex bytes (0x…)");
    const r = await vaultClient(ctx, true).postRedemption(input);
    output(
      ctx.json,
      { ...r, ...input, approveTx: r.approveTx?.hash },
      [
        `redemption order #${r.id} posted: ${btc(input.amount)} TBVBTC escrowed — tx ${r.hash}`,
        `  asks ${input.minSatsStart} → ${input.minSatsEnd} native sats to ${input.btcDest} by ${input.deadline}; cancelable after the deadline if unfilled`,
      ].join("\n"),
    );
  },

  "vault redemption cancel": async (ctx) => {
    const id = rawBigInt(ctx.values.id as string | undefined, "id");
    const r = await vaultClient(ctx, true).cancelRedemption(id);
    output(ctx.json, { ...r, id }, `redemption order #${id} cancelled, ${btc(r.amount)} TBVBTC returned: ${r.hash}`);
  },

  "vault redemption list": async (ctx) => {
    const limit = typeof ctx.values.limit === "string" ? Number(ctx.values.limit) : 20;
    if (!Number.isInteger(limit) || limit <= 0) fail("--limit must be a positive integer");
    const c = vaultClient(ctx, false);
    const me = typeof ctx.values.account === "string"
      ? (getAddress(ctx.values.account) as Address)
      : process.env[ctx.keyEnv] || ctx.values["key-file"] ? (accountFor(ctx).address as Address) : undefined;
    const rows = await c.listRedemptions(limit, me);
    output(
      ctx.json,
      { count: rows.length, rows },
      rows.length === 0
        ? "redemption book is empty"
        : [
            `${rows.length} most recent redemption order(s)`,
            ...rows.map(
              (r) =>
                `  #${r.id}  ${r.closed ? "CLOSED" : "open"}  ${btc(r.amount)}  min now ${r.minSatsNow} sats (${r.minSatsStart} → ${r.minSatsEnd})  deadline ${r.deadline}  owner ${r.owner}${r.mine ? " (mine)" : ""}${r.cancelable ? " [cancelable]" : ""}\n      dest ${r.btcDest}`,
            ),
          ].join("\n"),
    );
  },

  "vault keeper fill": async (ctx) => {
    const id = rawBigInt(ctx.values.id as string | undefined, "id");
    const txid = bytes32Flag(ctx.values.txid as string | undefined, "txid");
    const r = await vaultClient(ctx, true).claimFill(id, txid);
    output(ctx.json, { ...r, id, btcTxid: txid }, `redemption order #${id} filled: ${btc(r.amount)} TBVBTC claimed against ${r.minSatsDue} native sats due (btc txid ${txid}) — tx ${r.hash}`);
  },

  "vault keeper settle": async (ctx) => {
    const vaultId = bytes32Flag(ctx.values["vault-id"] as string | undefined, "vault-id");
    const tx = await vaultClient(ctx, true).settleDelivered(vaultId);
    output(ctx.json, { ...tx, vaultId }, `delivered vault ${vaultId} settled: keeper TBVBTC + locked vaultBTC burned, vault redeemed to the keeper's AVK key — tx ${tx.hash}`);
  },

  "vault invariant": async (ctx) => {
    const c = vaultClient(ctx, false);
    const account = typeof ctx.values.account === "string"
      ? (getAddress(ctx.values.account) as Address)
      : process.env[ctx.keyEnv] || ctx.values["key-file"] ? (accountFor(ctx).address as Address) : undefined;
    const r = await c.checkInvariant(account);
    output(
      ctx.json,
      { ...r },
      [
        `escrow invariant: ${r.balanced ? "BALANCED ✓" : "BROKEN ✗"} — locked vaultBTC ${btc(r.lockedVaultBtc)} vs TBVBTC supply ${btc(r.tbvbtcSupply)}`,
        `  vaultBTC total supply: ${btc(r.vaultBtcSupply)}`,
        ...(r.account ? [`  ${r.account}: vaultBTC ${btc(r.accountVaultBtc ?? 0n)}, TBVBTC ${btc(r.accountTbvbtc ?? 0n)}`] : []),
      ].join("\n"),
    );
  },

  "wallet create": async (ctx) => {
    const path = typeof ctx.values.out === "string" ? ctx.values.out : "bivium-wallet.key";
    const { address } = createWalletFile(path);
    output(ctx.json, { address, path }, [
      `new wallet ${address}`,
      `key file: ${path} (mode 0600 — never share or commit it)`,
      `use it via --key-file ${path}; fund gas with: wallet gas --to ${address}`,
    ].join("\n"));
  },

  "wallet address": async (ctx) => {
    const account = accountFor(ctx);
    output(ctx.json, { address: account.address }, account.address);
  },

  "wallet balance": async (ctx) => {
    const c = client(ctx, false);
    const account = (typeof ctx.values.account === "string"
      ? getAddress(ctx.values.account)
      : accountFor(ctx).address) as Address;
    const eth = await c.pub.getBalance({ address: account });
    const lines = [`${account}`, `  ETH: ${formatAmount(eth, 18)}`];
    const balances: Record<string, string> = { eth: eth.toString() };
    for (const [symbol, info] of Object.entries(ctx.profile.tokens ?? {})) {
      const bal = await c.balanceOf(info.address, account);
      balances[symbol] = bal.toString();
      lines.push(`  ${symbol}: ${formatAmount(bal, info.decimals)}`);
    }
    output(ctx.json, { address: account, balances }, lines.join("\n"));
  },

  "wallet gas": async (ctx) => {
    const to = getAddress(need(ctx.values.to as string | undefined, "to")) as Address;
    if (ctx.values["via-api"] === true) {
      // Keyless path: the relayer-side claimer submits claim(to); nothing is signed locally.
      const api = ctx.profile.gasApi;
      if (!api) fail("profile has no gasApi URL — cannot claim via API");
      const res = await fetch(api, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) fail(`gas API refused (${res.status}): ${JSON.stringify(data)}`);
      output(ctx.json, data, `dripped via API to ${to}: ${String(data.hash ?? "(no hash returned)")}`);
      return;
    }
    const faucet = ctx.profile.gasFaucet;
    if (!faucet) fail("profile has no gasFaucet address");
    const c = client(ctx, true);
    const [drip, nextAt, globalAt] = await Promise.all([
      c.pub.readContract({ address: faucet, abi: gasFaucetAbi, functionName: "DRIP" }),
      c.pub.readContract({ address: faucet, abi: gasFaucetAbi, functionName: "nextClaimAt", args: [to] }),
      c.pub.readContract({ address: faucet, abi: gasFaucetAbi, functionName: "globalNextClaimAt" }),
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (nextAt > now) fail(`recipient cooldown active until ${nextAt} (unix)`);
    if (globalAt > now) fail(`global claim interval active until ${globalAt} (unix) — retry shortly`);
    const tx = await c.claimGas(faucet, to);
    output(ctx.json, { ...tx, drip }, `dripped ${formatAmount(drip, 18)} ETH to ${to}: ${tx.hash}`);
  },

  "mock mint": async (ctx) => {
    const token = resolveToken(ctx.profile, need(ctx.values.token as string | undefined, "token"));
    if (!token.info?.mintable) fail(`token is not marked mintable in the profile — refusing to mint`);
    const to = getAddress(need(ctx.values.to as string | undefined, "to")) as Address;
    const amount = parseAmount(need(ctx.values.amount as string | undefined, "amount"), token.info.decimals);
    const tx = await client(ctx, true).mint(token.address, to, amount);
    output(ctx.json, { ...tx }, `minted ${formatAmount(amount, token.info.decimals)} ${token.symbol ?? token.address} to ${to}: ${tx.hash}`);
  },
};

// ───────────────────────── strategy helpers ─────────────────────────
// Input gathering lives in the SDK (src/sdk/strategies/gather.ts) and is shared with the MCP server;
// this layer only maps flags → GatherRequest and renders.

/** formatAmount is unsigned; P&L figures carry a sign. */
function signedAmount(x: bigint, decimals: number): string {
  return x < 0n ? `-${formatAmount(-x, decimals)}` : formatAmount(x, decimals);
}

function symbolMap(ctx: Ctx): Map<string, { sym: string; dec: number }> {
  return new Map(Object.entries(ctx.profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), { sym, dec: t.decimals }]));
}

async function gatherStrategy(ctx: Ctx): Promise<GatheredStrategy> {
  const v = ctx.values;
  const source = typeof v.source === "string" ? v.source : undefined;
  if (source !== undefined && source !== "relayer" && source !== "chain" && source !== "files") fail("--source must be relayer, chain, or files");
  const priceWad = typeof v.price === "string" ? (/^\d+$/.test(v.price) ? BigInt(v.price) : fail("--price must be a WAD integer (1e18 = par)")) : undefined;
  const aprBps = typeof v["apr-bps"] === "string" ? BigInt(v["apr-bps"]) : undefined;
  const sigmaAnnual = typeof v.sigma === "string" ? Number(v.sigma) : undefined;
  return await gatherStrategyInputs(ctx.profile, client(ctx, false), {
    strategy: need(v.strategy as string | undefined, "strategy"),
    asset: need(v.asset as string | undefined, "asset"),
    counter: typeof v.counter === "string" ? v.counter : undefined,
    size: need(v.size as string | undefined, "size"),
    maturity: BigInt(need(v.maturity as string | undefined, "maturity")),
    bufferPct: Number(need(v.buffer as string | undefined, "buffer")),
    priceWad,
    aprBps,
    sigmaAnnual,
    // `files` is a CLI-only book source (signed-offer files in --dir); chain/relayer discovery is the SDK's.
    market: {
      source: source === "files" ? undefined : source,
      fromBlock: typeof v["from-block"] === "string" ? BigInt(v["from-block"]) : undefined,
      chunkSize: typeof v["chunk-blocks"] === "string" ? BigInt(v["chunk-blocks"]) : undefined,
    },
    book: (params) => loadBookEntries(ctx, params),
  });
}

function renderStrategyQuote(ctx: Ctx, g: GatheredStrategy): string {
  const parityLine = ((p: GatheredStrategy["parity"]): string => {
    if (p.status === "ok") return "  parity:     the app's quote agrees (POST /api/strategies/quote)";
    if (p.status === "mismatch") return `  parity:     MISMATCH with the app's quote — ${p.checks.filter((c) => !c.ok).map((c) => `${c.field} local ${c.local} vs app ${c.http}`).join("; ")} — do not trust either number until this is understood`;
    return `  parity:     ${p.status} (${"reason" in p ? p.reason : ""})`;
  })(g.parity);
  const { res, quote } = g;
  const by = symbolMap(ctx);
  const sym = (a: Address): string => by.get(a.toLowerCase())?.sym ?? a.slice(0, 8);
  const A = sym(res.asset);
  const N = sym(res.numeraire);
  // Prices are advisory floats from the pair feed, so trim their display to 8 decimals; amounts stay exact.
  const px = (p: bigint): string => formatAmount(p, 18).replace(/(\.\d{8})\d+$/, "$1");
  const num = (x: bigint): string => `${signedAmount(x, res.numeraireDecimals)} ${N}`;
  const prepayDec = prepayIsAsset(res.strategy.id) ? res.assetDecimals : res.numeraireDecimals;
  const prepaySym = prepayIsAsset(res.strategy.id) ? A : N;
  const term = res.row.market.params.maturity - g.now;
  const apr = Number(simpleAprBpsFromPrice(g.priceWad, term)) / 100;
  const w = quote.payoff.worstCase;
  const lines = [
    `${res.strategy.name} (${res.strategy.id}) — ${res.side} on the ${res.line} line: ${res.strategy.oneLiner}`,
    `  market:     ${A}/${N}  K = ${px(res.strikeHuman)} ${N} per ${A}  (${res.realizedBufferPct >= 0 ? "+" : ""}${res.realizedBufferPct.toFixed(1)}% ${res.strategy.otmDirection === "above" ? "above" : "below"} spot)  maturity ${res.row.market.params.maturity} (${term / 86_400n}d)`,
    `  spot:       ${px(g.spot)} ${N} per ${A}  [${g.pair}${g.spotStatus === "stale" ? ", STALE" : ""}]  — estimates below are off this spot; execution is bounded by minOut`,
    `  price:      ${px(g.priceWad)} (simple APR ${apr.toFixed(2)}%)  from ${g.priceFrom}`,
    `  size:       ${formatAmount(g.size, res.strategy.id === "lendQuote" ? res.numeraireDecimals : res.assetDecimals)} ${res.strategy.id === "lendQuote" ? N : A}`,
    `  prepay:     ${formatAmount(quote.prepay, prepayDec)} ${prepaySym}   premium: ${num(quote.premium)}`,
    `  WORST CASE: ${num(w.amount)}  when ${w.at}  — form: ${w.form}`,
    `  best case:  ${num(quote.payoff.bestCase.amount)}  when ${quote.payoff.bestCase.at}`,
    `  break-even: ${quote.payoff.breakEven === null ? "—" : `${px(quote.payoff.breakEven)} ${N} per ${A}`}`,
    `  boundary:   ${px(quote.payoff.boundary)} ${N} per ${A}  (${{ "forfeit-collateral": "forfeit above", "deliver-collateral": "deliver below", "called-away": "called away above", assigned: "assigned below", premium: "delivery point" }[w.form]})`,
    `  P(exercise): ${quote.exerciseProbability === null ? "— (pass --sigma <annual vol>)" : `${(quote.exerciseProbability * 100).toFixed(0)}%${g.sigmaSource === "feed" ? " (σ from the pair feed)" : ""}`}`,
    parityLine,
  ];
  if (res.alternatives.length) {
    lines.push(`  note: no rung within tolerance of --buffer; nearest rungs: ${res.alternatives.map((r) => r.market.id.slice(0, 10)).join(", ")} (this quote uses the nearest)`);
  }
  // A compact payoff table: ~9 evenly spaced samples of the curve.
  const pts = quote.payoff.points;
  const step = Math.max(1, Math.floor(pts.length / 8));
  lines.push("  payoff at maturity (S_T → P&L):");
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i]!;
    lines.push(`    ${px(p.S).padEnd(24)} ${p.pnl >= 0n ? "+" : ""}${signedAmount(p.pnl, res.numeraireDecimals)} ${N}`);
  }
  return lines.join("\n");
}

function renderStrategyPlan(g: GatheredStrategy, plan: Plan): string[] {
  const { res } = g;
  const lines = [
    `plan: ${plan.mode}${plan.mode === "sequential" ? "  ⚠ NOT atomic (no Router on this profile): approve → fill → swap are separate txs" : plan.mode === "intent" ? "  (single leg — signable intent)" : "  (one atomic Router call)"}`,
    `  maxLoss ${formatAmount(plan.limits.maxLoss, res.numeraireDecimals)}  minOut ${plan.limits.minOut === undefined ? "—" : plan.limits.minOut.toString()}  deadline ${plan.limits.deadline}  quoteId ${plan.quoteId.slice(0, 18)}…`,
  ];
  plan.steps.forEach((s, i) => {
    const bits = [
      s.token ? `token ${s.token.slice(0, 10)}` : "",
      s.spender ? `spender ${s.spender.slice(0, 10)}` : "",
      s.amount !== undefined ? `amount ${s.amount}` : "",
      s.units !== undefined ? `units ${s.units}` : "",
      s.minOut !== undefined ? `minOut ${s.minOut}` : "",
      s.offer ? `offer tick ${s.offer.tick}` : "",
    ].filter(Boolean).join("  ");
    lines.push(`  ${i + 1}. ${s.kind.padEnd(19)} ${bits}${bits ? "  " : ""}— ${s.note}`);
  });
  lines.push("  (nothing was sent: execute the steps with the existing commands, or hand the plan to the Router)");
  return lines;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const commandKey = positionals.slice(0, 3).join(" ");
  const command = positionals[0] === "strategy"
    ? positionals.length === 2 ? commands[positionals.join(" ")] : undefined
    : commands[commandKey] ?? commands[positionals.slice(0, 2).join(" ")] ?? commands[positionals[0] ?? ""];
  if (!command) fail(`unknown command ${JSON.stringify(commandKey)}\n\n${USAGE}`);
  const profilePath = (values.profile as string | undefined) ?? process.env.BIVIUM_PROFILE;
  if (!profilePath) fail("no profile: pass --profile <path> or set BIVIUM_PROFILE");
  const ctx: Ctx = {
    profile: loadProfile(profilePath),
    json: values.json === true,
    keyEnv: values["key-env"] as string,
    values: values as Ctx["values"],
  };
  await command(ctx);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
});
