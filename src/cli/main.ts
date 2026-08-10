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
  TbvClient,
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
  read position|credit|liquidity --account <addr>
  maker set-ratifier [--off]
  maker fund --assets <human>
  maker withdraw-liquidity --assets <human> [--receiver <addr>]
  maker wizard                        # 交互式挂单：选市场 → 输金额 → 输价格 → 确认签名
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

  tbv create-vault --token-id <n> --amount <units> [--receiver <addr>]   (key must be redemption issuer)
  tbv vault-status --token-id <n>
  tbv fund --token-id <n> --gate <addr> [--maturity <unix>] [--strike <raw>]   (market read from the gate)
  tbv cancel-funding --token-id <n>
  tbv borrow --token-id <n> --offer <file> [--deadline <s>]   (signs BorrowAuthorization with the key)
  tbv repay --token-id <n>
  tbv redeem-delivered --position-id <bytes32>

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
  "token-id": { type: "string" },
  "position-id": { type: "string" },
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

function tbvClient(ctx: Ctx, signing: boolean): TbvClient {
  return new TbvClient(ctx.profile, signing ? loadKeyAccount(ctx.keyEnv) : undefined);
}

/** Vault token ids and amounts are raw unitless integers, never token-decimal scaled. */
function rawBigInt(value: string | undefined, flag: string): bigint {
  const v = need(value, flag);
  if (!/^\d+$/.test(v)) fail(`--${flag} must be a non-negative integer`);
  return BigInt(v);
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


  "maker wizard": async (ctx) => {
    // Interactive order placement for humans: pick a discovered market, then amount and price.
    // Agents should use the flag form (make-offer) — every answer here maps to a flag.
    const c = client(ctx, false);
    const fromBlock = BigInt(ctx.profile.coreDeploymentBlock ?? fail("profile has no coreDeploymentBlock"));
    console.log("正在扫描链上已有市场（join，不要新建，避免流动性分散）…");
    const markets = await discoverMarketsOnChain(c, { fromBlock });
    if (markets.length === 0) fail("no touched markets found — nothing to quote into");
    const bySymbol = new Map(Object.entries(ctx.profile.tokens ?? {}).map(([sym, t]) => [t.address.toLowerCase(), { sym, dec: t.decimals }]));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const active = markets.filter((m) => m.params.maturity > now);
    if (active.length === 0) fail("all touched markets are already matured");
    const spots = new Map<string, number | null>();
    const rows: Array<{ market: (typeof active)[number]; label: string; itm: boolean; loanDec: number; collDec: number }> = [];
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
      const pair = `${coll?.sym ?? m.params.collateralToken.slice(0, 8)}/${loan?.sym ?? m.params.loanToken.slice(0, 8)}`;
      const flags = [
        m.params.gate === ZERO_ADDRESS ? "" : "[gated]",
        money === null ? "" : money.itm ? `[ITM ⚠ floor/spot ${money.ratio.toFixed(2)}]` : `[OTM ${money.ratio.toFixed(2)}]`,
      ].filter(Boolean).join(" ");
      rows.push({
        market: m,
        label: `${pair}  floor ${floor}  到期 ${date}  在贷 ${formatAmount(state.activeCredit, loanDec)}  已还 ${formatAmount(state.repaidCredit, loanDec)}  ${flags}`,
        itm: money?.itm === true,
        loanDec,
        collDec,
      });
    }
    rows.forEach((r, i) => console.log(`  [${i + 1}] ${r.label}`));
    const rl = makeAsker();
    try {
      const pick = Number((await rl.ask(`选择市场 [1-${rows.length}]: `)).trim());
      if (!Number.isInteger(pick) || pick < 1 || pick > rows.length) fail("invalid market selection");
      const chosen = rows[pick - 1];
      const sideAnswer = (await rl.ask("方向 buy=出借挂买单 / sell=卖出持有的 DCN [buy]: ")).trim().toLowerCase() || "buy";
      if (sideAnswer !== "buy" && sideAnswer !== "sell") fail("side must be buy or sell");
      if (chosen.itm && sideAnswer === "buy") {
        const go = (await rl.ask("⚠ 该市场 floor 高于现货——近平价出借是确定性亏损（借款人理性选择违约）。确定继续？输入 yes-itm 确认: ")).trim();
        if (go !== "yes-itm") fail("aborted at the ITM confirmation");
        ctx.values["acknowledge-itm"] = true;
      }
      const amount = (await rl.ask("面值金额（贷款代币单位，如 200）: ")).trim();
      parseAmount(amount, chosen.loanDec); // validate early, exact-decimal rules apply
      const priceAnswer = (await rl.ask("价格：年化 %（如 10 或 8.5），或 tick:<n> 直接指定网格: ")).trim();
      if (/^tick:\d+$/.test(priceAnswer)) {
        ctx.values.tick = priceAnswer.slice(5);
      } else {
        const bps = parseAmount(priceAnswer, 2); // "10" → 1000 bps, exact
        ctx.values["apr-bps"] = bps.toString();
      }
      let publish = false;
      if (ctx.profile.relayerUrl && ctx.profile.abiProfile === "core-v2") {
        publish = (await rl.ask("发布到 relayer 让 web 用户可见并可成交？[y/N]: ")).trim().toLowerCase() === "y";
      }
      const out = (await rl.ask("保存签名单到文件 [offer-<commitment>.json]: ")).trim();
      const confirm = (await rl.ask(`确认：${sideAnswer === "buy" ? "买单(出借)" : "卖单(出售 DCN)"} ${amount} 面值 @ ${priceAnswer}${publish ? "，发布 relayer" : ""} —— 签名并${sideAnswer === "buy" ? "挂单" : "挂单"}？[y/N]: `)).trim().toLowerCase();
      if (confirm !== "y") fail("aborted before signing");
      ctx.values.side = sideAnswer;
      ctx.values["max-units"] = amount;
      if (out) ctx.values.out = out;
      if (publish) ctx.values.publish = true;
      await runMakeOffer(ctx, { params: chosen.market.params, loanDecimals: chosen.loanDec, collateralDecimals: chosen.collDec });
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

  "tbv create-vault": async (ctx) => {
    const tokenId = rawBigInt(ctx.values["token-id"] as string | undefined, "token-id");
    const amount = rawBigInt(ctx.values.amount as string | undefined, "amount");
    const c = tbvClient(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : c.account;
    const tx = await c.tbvCreateVault(receiver, tokenId, amount);
    output(ctx.json, { ...tx, tokenId, amount, receiver }, `vault ${tokenId} created: ${amount} units to ${receiver} — tx ${tx.hash}`);
  },

  "tbv vault-status": async (ctx) => {
    const tokenId = rawBigInt(ctx.values["token-id"] as string | undefined, "token-id");
    const c = tbvClient(ctx, false);
    const s = await c.vaultStatus(tokenId);
    if (!s.created) {
      output(ctx.json, { created: false }, `vault ${tokenId}: not created`);
      return;
    }
    const p = s.position;
    output(
      ctx.json,
      { ...s },
      [
        `vault ${tokenId} (${s.completeSupply} units complete)`,
        `  state:           ${s.stateName}${s.isDelivered ? " (DELIVERED)" : ""}`,
        `  originalOwner:   ${p?.originalOwner}`,
        `  positionAccount: ${p?.positionAccount}`,
        `  marketId:        ${p?.marketId}`,
        `  fundingNonce:    ${p?.fundingNonce}`,
        `  borrowedFace:    ${p?.borrowedFace} (raw loan units)`,
        `  receiptAmount:   ${p?.receiptAmount}`,
        `  positionId:      ${s.positionId}`,
        `  balances:        manager ${s.managerBalance} / owner ${s.ownerBalance}`,
      ].join("\n"),
    );
  },

  "tbv fund": async (ctx) => {
    const tokenId = rawBigInt(ctx.values["token-id"] as string | undefined, "token-id");
    const gate = getAddress(need(ctx.values.gate as string | undefined, "gate")) as Address;
    const c = tbvClient(ctx, true);
    const { params } = await c.gateMarket(gate);
    // Optional cross-checks: flags must agree with what the gate is immutably bound to.
    if (typeof ctx.values.maturity === "string" && BigInt(ctx.values.maturity) !== params.maturity) {
      fail(`--maturity ${ctx.values.maturity} != gate maturity ${params.maturity}`);
    }
    if (typeof ctx.values.strike === "string" && BigInt(ctx.values.strike) !== params.strike) {
      fail(`--strike does not match gate strike ${params.strike}`);
    }
    const tx = await c.tbvFund(tokenId, gate);
    output(
      ctx.json,
      { ...tx },
      `vault ${tokenId} funded into market ${tx.marketId} (nonce ${tx.expectedFundingNonce}, max face ${tx.maximumFace}): ${tx.hash}`,
    );
  },

  "tbv cancel-funding": async (ctx) => {
    const tokenId = rawBigInt(ctx.values["token-id"] as string | undefined, "token-id");
    const tx = await tbvClient(ctx, true).tbvCancelFunding(tokenId);
    output(ctx.json, { ...tx }, `funding cancelled, vault ${tokenId} returned: ${tx.hash}`);
  },

  "tbv borrow": async (ctx) => {
    const tokenId = rawBigInt(ctx.values["token-id"] as string | undefined, "token-id");
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const deadlineSeconds = typeof ctx.values.deadline === "string" ? BigInt(ctx.values.deadline) : undefined;
    const c = tbvClient(ctx, true);
    const loanDecimals = await tokenDecimals(ctx, file.offer.loanToken);
    const result = await c.tbvBorrow(tokenId, file.offer, file.signature, { deadlineSeconds });
    output(
      ctx.json,
      { ...result },
      `borrowed against vault ${tokenId}: received ${formatAmount(result.principal, loanDecimals)} for ${formatAmount(result.face, loanDecimals)} face — tx ${result.hash}`,
    );
  },

  "tbv repay": async (ctx) => {
    const tokenId = rawBigInt(ctx.values["token-id"] as string | undefined, "token-id");
    const c = tbvClient(ctx, true);
    const loanToken = (await c.vaultStatus(tokenId)).marketParams?.loanToken;
    const loanDecimals = loanToken && loanToken !== ZERO_ADDRESS ? await tokenDecimals(ctx, loanToken) : 0;
    const tx = await c.tbvRepay(tokenId);
    output(ctx.json, { ...tx }, `repaid ${formatAmount(tx.repaid, loanDecimals)}, vault ${tokenId} returned to owner: ${tx.hash}`);
  },

  "tbv redeem-delivered": async (ctx) => {
    const positionId = need(ctx.values["position-id"] as string | undefined, "position-id");
    if (!/^0x[0-9a-fA-F]{64}$/.test(positionId)) fail("--position-id must be a bytes32 hex value");
    const tx = await tbvClient(ctx, true).tbvRedeemDelivered(positionId as Hex);
    output(ctx.json, { ...tx }, `delivered vault released to keeper: ${tx.hash}`);
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
  const commandKey = positionals.slice(0, 2).join(" ");
  const command = commands[commandKey] ?? commands[positionals[0] ?? ""];
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
