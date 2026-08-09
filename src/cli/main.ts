#!/usr/bin/env node
// bivium — CLI over the Bivium SDK (core-v1 lineage). See docs/spec/2026-08-09-bivium-cli-spec.md.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BiviumClient,
  buildSignedOfferFile,
  computeMarketId,
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
  RATIFIED,
  ZERO_ADDRESS,
  type Address,
  type DeploymentProfile,
  type Hex,
  type MarketParams,
  type Offer,
} from "../sdk/index.ts";

const USAGE = `bivium — Bivium market lifecycle CLI (core-v1)

usage: bivium <command> [options]

  market id|state       compute the market id / read MarketState
  read position|credit|liquidity --account <addr>
  maker set-ratifier [--off]
  maker fund --assets <human>
  maker withdraw-liquidity --assets <human> [--receiver <addr>]
  maker make-offer --side buy|sell (--tick <n> | --apr-bps <n>) --max-units <human> [--ttl <s>] [--out <file>]
  offer status --offer <file>
  borrow quote --offer <file> [--units <human>]
  borrow execute --offer <file> --units <human> [--receiver <addr>]
  repay (--offer <file> | market flags) --assets <human>
  reclaim (--offer <file> | market flags) [--receiver <addr>]
  claim (--offer <file> | market flags) --units <human> [--receiver <addr>]
  mock mint --token <symbol|addr> --to <addr> --amount <human>

market flags: --loan <symbol|addr> --collateral <symbol|addr> --maturity <unix>
              (--floor <human> | --strike <raw>) [--allow-partial] [--gate <addr>]
global:       --profile <path> (or BIVIUM_PROFILE) [--key-env NAME] [--json]`;

const OPTIONS = {
  profile: { type: "string" },
  "key-env": { type: "string", default: "BIVIUM_PK" },
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

function loadKeyAccount(keyEnv: string) {
  const raw = process.env[keyEnv];
  if (!raw) fail(`signing key required: set ${keyEnv} (or pass --key-env NAME)`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) fail(`${keyEnv} is not a 32-byte hex private key`);
  return privateKeyToAccount(raw as Hex);
}

interface Ctx {
  profile: DeploymentProfile;
  json: boolean;
  keyEnv: string;
  values: Record<string, string | boolean | undefined>;
}

function tokenDecimalsOrFail(ctx: Ctx, address: Address, label: string): number {
  const entry = Object.values(ctx.profile.tokens ?? {}).find((t) => t.address === address);
  if (!entry) fail(`${label} ${address} is not in the profile token allowlist (needed for exact decimals)`);
  return entry.decimals;
}

/** Market params from --offer file or explicit flags. */
function resolveMarket(ctx: Ctx): { params: MarketParams; loanDecimals: number; collateralDecimals: number } {
  const v = ctx.values;
  if (typeof v.offer === "string") {
    const { offer } = parseSignedOfferFile(readFileSync(v.offer, "utf8"), ctx.profile);
    const params = marketParamsFromOffer(offer);
    return {
      params,
      loanDecimals: tokenDecimalsOrFail(ctx, params.loanToken, "loan token"),
      collateralDecimals: tokenDecimalsOrFail(ctx, params.collateralToken, "collateral token"),
    };
  }
  const loan = resolveToken(ctx.profile, need(v.loan as string | undefined, "loan"));
  const collateral = resolveToken(ctx.profile, need(v.collateral as string | undefined, "collateral"));
  if (!loan.info) fail(`--loan ${v.loan} not in profile token allowlist`);
  if (!collateral.info) fail(`--collateral ${v.collateral} not in profile token allowlist`);
  const maturity = BigInt(need(v.maturity as string | undefined, "maturity"));
  let strike: bigint;
  if (typeof v.strike === "string") strike = BigInt(v.strike);
  else if (typeof v.floor === "string") strike = strikeFromFloor(v.floor, loan.info.decimals, collateral.info.decimals);
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
    loanDecimals: loan.info.decimals,
    collateralDecimals: collateral.info.decimals,
  };
}

function client(ctx: Ctx, signing: boolean): BiviumClient {
  return new BiviumClient(ctx.profile, signing ? loadKeyAccount(ctx.keyEnv) : undefined);
}

const commands: Record<string, (ctx: Ctx) => Promise<void>> = {
  "market id": async (ctx) => {
    const { params } = resolveMarket(ctx);
    const id = computeMarketId(params);
    const c = client(ctx, false);
    await c.verifyProfile();
    const onchain = await c.pub.readContract({
      address: ctx.profile.core,
      abi: (await import("../sdk/abi.ts")).coreV1Abi,
      functionName: "computeId",
      args: [params],
    });
    if (onchain !== id) fail(`local id ${id} != on-chain ${onchain}`);
    output(ctx.json, { marketId: id, params, onchainVerified: true }, `market id: ${id} (on-chain verified)`);
  },

  "market state": async (ctx) => {
    const { params, loanDecimals, collateralDecimals } = resolveMarket(ctx);
    const c = client(ctx, false);
    const id = computeMarketId(params);
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
    const { params, loanDecimals, collateralDecimals } = resolveMarket(ctx);
    const account = getAddress(need(ctx.values.account as string | undefined, "account")) as Address;
    const p = await client(ctx, false).position(computeMarketId(params), account);
    output(
      ctx.json,
      { ...p },
      `debt ${formatAmount(p.debt, loanDecimals)} | collateral ${formatAmount(p.collateral, collateralDecimals)} | withdrawable ${formatAmount(p.collateralWithdrawable, collateralDecimals)}`,
    );
  },

  "read credit": async (ctx) => {
    const { params, loanDecimals } = resolveMarket(ctx);
    const account = getAddress(need(ctx.values.account as string | undefined, "account")) as Address;
    const credit = await client(ctx, false).creditOf(computeMarketId(params), account);
    output(ctx.json, { credit }, `credit: ${formatAmount(credit, loanDecimals)} DCN face`);
  },

  "read liquidity": async (ctx) => {
    const { params, loanDecimals } = resolveMarket(ctx);
    const account = getAddress(need(ctx.values.account as string | undefined, "account")) as Address;
    const liquidity = await client(ctx, false).liquidityOf(computeMarketId(params), account);
    output(ctx.json, { liquidity }, `liquidity: ${formatAmount(liquidity, loanDecimals)}`);
  },

  "maker set-ratifier": async (ctx) => {
    const c = client(ctx, true);
    const tx = await c.setRatifier(ctx.profile.signatureRatifier, ctx.values.off !== true);
    output(ctx.json, { ...tx }, `setRatifier(${ctx.profile.signatureRatifier}, ${ctx.values.off !== true}): ${tx.hash}`);
  },

  "maker fund": async (ctx) => {
    const { params, loanDecimals } = resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const c = client(ctx, true);
    const tx = await c.fund(params, assets);
    output(ctx.json, { ...tx, assets }, `funded ${formatAmount(assets, loanDecimals)} into ${computeMarketId(params)}: ${tx.hash}`);
  },

  "maker withdraw-liquidity": async (ctx) => {
    const { params, loanDecimals } = resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : c.account;
    const tx = await c.withdrawLiquidity(params, assets, receiver);
    output(ctx.json, { ...tx }, `withdrew ${formatAmount(assets, loanDecimals)} to ${receiver}: ${tx.hash}`);
  },

  "maker make-offer": async (ctx) => {
    const { params, loanDecimals } = resolveMarket(ctx);
    const side = need(ctx.values.side as string | undefined, "side");
    if (side !== "buy" && side !== "sell") fail("--side must be buy or sell");
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
    const account = loadKeyAccount(ctx.keyEnv);
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
    const commitment = offerCommitment(offer);
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
    output(
      ctx.json,
      { path, commitment, tick, price: tickToPrice(tick), ratifierRegistered: status.ratifierRegistered },
      [
        `offer written to ${path}`,
        `  commitment: ${commitment}`,
        `  tick ${tick} → price ${formatAmount(tickToPrice(tick), 18)}`,
        status.ratifierRegistered ? `  ratifier registered ✓` : `  WARNING: maker has not run \`maker set-ratifier\` yet`,
      ].join("\n"),
    );
  },

  "offer status": async (ctx) => {
    const file = parseSignedOfferFile(readFileSync(need(ctx.values.offer as string | undefined, "offer"), "utf8"), ctx.profile);
    const c = client(ctx, false);
    await c.verifyProfile();
    const s = await c.offerStatus(file.offer, file.signature);
    const loanDecimals = tokenDecimalsOrFail(ctx, file.offer.loanToken, "loan token");
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
    const loanDecimals = tokenDecimalsOrFail(ctx, file.offer.loanToken, "loan token");
    const collateralDecimals = tokenDecimalsOrFail(ctx, file.offer.collateralToken, "collateral token");
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
    const loanDecimals = tokenDecimalsOrFail(ctx, file.offer.loanToken, "loan token");
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
    const { params, loanDecimals } = resolveMarket(ctx);
    const assets = parseAmount(need(ctx.values.assets as string | undefined, "assets"), loanDecimals);
    const tx = await client(ctx, true).repay(params, assets);
    output(ctx.json, { ...tx }, `repaid ${formatAmount(assets, loanDecimals)}: ${tx.hash}`);
  },

  reclaim: async (ctx) => {
    const { params } = resolveMarket(ctx);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : undefined;
    const tx = await c.withdrawCollateral(params, receiver);
    output(ctx.json, { ...tx }, `collateral withdrawn: ${tx.hash}`);
  },

  claim: async (ctx) => {
    const { params, loanDecimals } = resolveMarket(ctx);
    const units = parseAmount(need(ctx.values.units as string | undefined, "units"), loanDecimals);
    const c = client(ctx, true);
    const receiver = typeof ctx.values.receiver === "string" ? (getAddress(ctx.values.receiver) as Address) : undefined;
    const tx = await c.claim(params, units, receiver);
    output(ctx.json, { ...tx }, `claimed ${formatAmount(units, loanDecimals)} DCN face: ${tx.hash}`);
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
