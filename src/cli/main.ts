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
  discoverMarketsOnChain,
  fetchRelayerMarkets,
  principalForUnits,
  type DiscoveredMarket,
  fetchSpotUsd,
  floorFromStrike,
  spotAssetFor,
  createWalletFile,
  gasFaucetAbi,
  readKeyFile,
  buildSignedOfferFile,
  formatAmount,
  loadProfile,
  marketParamsFromOffer,
  offerCommitment,
  parseAmount,
  parseSignedOfferFile,
  priceFromSimpleAprBps,
  priceToTick,
  ratifyDigest,
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

const USAGE = `bivium — Bivium market lifecycle CLI (core-v1)

usage: bivium <command> [options]

  market list [--source chain|relayer] [--from-block N]   # discover EXISTING markets — join, don't fragment
  market id|state       compute the market id / read MarketState
  portfolio [--account <addr>] [--dir <orders>]   # aggregated positions/DCN/escrow/orders across all markets
  read position|credit|liquidity --account <addr>
  maker set-ratifier [--off]
  maker fund --assets <human>
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
  repay (--offer <file> | market flags) --assets <human>
  reclaim (--offer <file> | market flags) [--receiver <addr>]
  claim (--offer <file> | market flags) --units <human> [--receiver <addr>]
  mock mint --token <symbol|addr> --to <addr> --amount <human>
  wallet create [--out <file>]        # throwaway wallet, key file mode 0600
  wallet address|balance [--key-file <f> | --account <addr>]
  wallet gas --to <addr> [--via-api]  # third-party claim; --via-api needs no local key at all
  wizard                              # interactive wizard: lend / borrow / trade

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
    const asset = spotAssetFor(collInfo?.[0]);
    if (asset) {
      const spot = await fetchSpotUsd(asset);
      let floorHuman: string | null = null;
      try { floorHuman = floorFromStrike(params.strike, loanDecimals, collateralDecimals); } catch { floorHuman = null; }
      const money = spot !== null && floorHuman !== null ? assessMoneyness(floorHuman, spot) : null;
      if (money?.itm && ctx.values["acknowledge-itm"] !== true) {
        fail(`this market's floor (${floorHuman}) is ${((money.ratio - 1) * 100).toFixed(1)}% ABOVE ${asset} spot (${spot}) — your bid would buy collateral above market and the borrower's rational strategy is to default. Pass --acknowledge-itm to quote anyway.`);
      }
      if (money === null) console.error("note: spot unavailable — cannot assess floor moneyness for this bid");
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
    ratifier: ctx.profile.signatureRatifier,
  };
  const commitment = adapterFor(ctx.profile.abiProfile).offerCommitment(
    { chainId: ctx.profile.chainId, core: ctx.profile.core },
    offer,
  );
  const digest = ratifyDigest(ctx.profile.chainId, ctx.profile.signatureRatifier, commitment);
  const signature = await account.sign({ hash: digest });
  // Precheck: refuse to emit a file the on-chain ratifier would not accept.
  const c = new BiviumClient(ctx.profile, account);
  await c.verifyProfile();
  const status = await c.offerStatus(offer, signature);
  if (!status.ratified) fail("on-chain ratifier precheck did not return RATIFIED — aborting");
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
    { path, commitment, tick, price: tickToPrice(tick), ratifierRegistered: status.ratifierRegistered, published },
    [
      `offer written to ${path}`,
      `  commitment: ${commitment}`,
      `  tick ${tick} → price ${formatAmount(tickToPrice(tick), 18)}`,
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
    const asset = spotAssetFor(coll?.sym);
    if (asset && !spots.has(asset)) spots.set(asset, await fetchSpotUsd(asset));
    const spot = asset ? spots.get(asset) ?? null : null;
    const money = spot !== null && floor !== "?" ? assessMoneyness(floor, spot) : null;
    const state = await c.marketState(m.id);
    const date = new Date(Number(m.params.maturity) * 1000).toISOString().slice(0, 10);
    const loanSym = loan?.sym ?? m.params.loanToken.slice(0, 8);
    const collSym = coll?.sym ?? m.params.collateralToken.slice(0, 8);
    const flags = [
      m.params.gate === ZERO_ADDRESS ? "" : "[gated]",
      money === null ? "" : money.itm ? `[ITM ⚠ floor/spot ${money.ratio.toFixed(2)}]` : `[OTM ${money.ratio.toFixed(2)}]`,
    ].filter(Boolean).join(" ");
    rows.push({
      market: m,
      label: `${collSym}/${loanSym}  floor ${floor}  matures ${date}  active ${formatAmount(state.activeCredit, loanDec)}  repaid ${formatAmount(state.repaidCredit, loanDec)}  ${flags}`,
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
    // Display-only spot for moneyness flags; one fetch per referenced asset, failures degrade to "?".
    const spots = new Map<string, number | null>();
    for (const m of markets) {
      const asset = spotAssetFor(bySymbol.get(m.params.collateralToken.toLowerCase())?.sym);
      if (asset && !spots.has(asset)) spots.set(asset, await fetchSpotUsd(asset));
    }
    const lines: string[] = [];
    const rows = [];
    for (const m of markets) {
      const loan = bySymbol.get(m.params.loanToken.toLowerCase());
      const coll = bySymbol.get(m.params.collateralToken.toLowerCase());
      const state = await c.marketState(m.id);
      let floor = "?";
      if (loan && coll) { try { floor = floorFromStrike(m.params.strike, loan.dec, coll.dec); } catch { floor = "(off-grid)"; } }
      const asset = spotAssetFor(coll?.sym);
      const spot = asset ? spots.get(asset) ?? null : null;
      const money = spot !== null && floor !== "?" && floor !== "(off-grid)" ? assessMoneyness(floor, spot) : null;
      const moneyLabel = money === null ? "" : money.itm ? `  floor/spot ${money.ratio.toFixed(2)} [ITM ⚠ lending near par is a guaranteed loss]` : `  floor/spot ${money.ratio.toFixed(2)} OTM`;
      const pair = `${coll?.sym ?? m.params.collateralToken.slice(0, 8)}/${loan?.sym ?? m.params.loanToken.slice(0, 8)}`;
      rows.push({ id: m.id, pair, floor, maturity: m.params.maturity, activeCredit: state.activeCredit, repaidCredit: state.repaidCredit, gate: m.params.gate, moneyness: money });
      lines.push(`${pair}  floor ${floor}  maturity ${m.params.maturity}  active ${loan ? formatAmount(state.activeCredit, loan.dec) : state.activeCredit}  repaid ${loan ? formatAmount(state.repaidCredit, loan.dec) : state.repaidCredit}${m.params.gate === ZERO_ADDRESS ? "" : "  [gated]"}${moneyLabel}\n    ${m.id}`);
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
    const c = client(ctx, true);
    const tx = await c.setRatifier(ctx.profile.signatureRatifier, ctx.values.off !== true);
    output(ctx.json, { ...tx }, `setRatifier(${ctx.profile.signatureRatifier}, ${ctx.values.off !== true}): ${tx.hash}`);
  },

  "maker fund": async (ctx) => {
    const { params, loanDecimals } = await resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const c = client(ctx, true);
    const tx = await c.fund(params, assets);
    output(ctx.json, { ...tx, assets }, `funded ${formatAmount(assets, loanDecimals)} into ${c.marketId(params)}: ${tx.hash}`);
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    console.log(USAGE);
    return;
  }
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  const commandKey = positionals.slice(0, 3).join(" ");
  const command = commands[commandKey] ?? commands[positionals.slice(0, 2).join(" ")] ?? commands[positionals[0] ?? ""];
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
