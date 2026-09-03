import assert from "node:assert/strict";
import test from "node:test";
import { decodeAbiParameters } from "viem";
import {
  LEG_KIND,
  buildOpenProgram,
  buildUnwindProgram,
  defaultUnwindVia,
  fillCost,
  originationFee,
  type ProgramView,
} from "../src/sdk/strategies/program.ts";
import { outAtPoolPrice, poolIdOf, poolKeyCarries, swapCeiling, swapFloor } from "../src/sdk/strategies/pools.ts";
import { grantCoversProgram, programNeedsGrant, PROGRAM_CAPS } from "../src/sdk/strategyRouter.ts";
import { getStrategy } from "../src/sdk/strategies/catalog.ts";
import { poolKeyFor } from "../src/sdk/settler.ts";
import { tickToPrice } from "../src/sdk/tick.ts";
import type { Address, Hex, MarketParams, Offer } from "../src/sdk/types.ts";

// The live Robinhood testnet shapes, so the numbers below are the ones a real program carries.
const CORE = "0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4" as Address;
const BUSD = "0x628626dE13DD4B5b1cb80d468c261C15dF00D717" as Address;
const MNVDA = "0xb0F5bb3028A46Ab101b29A540E304aE3a5bBE877" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const MATURITY = 1789113600n;
const TICK = 4000n;
/// core-v2: the chain and the core are what the encoder prefixes onto every struct.
const DOMAIN = { chainId: 46630, core: CORE };

/** The credit rung: mNVDA collateral, bUSD loan, 125 bUSD per mNVDA. */
const PUT: MarketParams = {
  loanToken: BUSD, collateralToken: MNVDA,
  maturity: MATURITY, strike: 125n * 10n ** 24n, allowPartialRepay: false, gate: ZERO,
};
/** Its mirror on the options line: bUSD collateral, mNVDA loan, 250 bUSD per mNVDA. */
const CALL: MarketParams = {
  loanToken: MNVDA, collateralToken: BUSD,
  maturity: MATURITY, strike: 10n ** 48n / 250n, allowPartialRepay: true, gate: ZERO,
};

function offerOn(params: MarketParams, buy: boolean): Offer {
  return {
    loanToken: params.loanToken,
    collateralToken: params.collateralToken, maturity: params.maturity, strike: params.strike,
    allowPartialRepay: params.allowPartialRepay, gate: params.gate,
    maker: "0xE66edaD6148E0d1273793e283F0b8224E5f1F935" as Address,
    buy, tick: TICK, maxUnits: 10n ** 30n, maxAssets: 0n, start: 0n, expiry: MATURITY,
    group: `0x${"11".repeat(32)}` as Hex, ratifier: "0x3209e5C85c93d4fD352be018f4777007D2619fb3" as Address,
  };
}

function view(strategyId: string, params: MarketParams): ProgramView {
  const strategy = getStrategy(strategyId);
  const creditLine = strategy.line === "credit";
  return {
    strategy,
    strike: params.strike,
    asset: creditLine ? params.collateralToken : params.loanToken,
    numeraire: creditLine ? params.loanToken : params.collateralToken,
    line: strategy.line,
  };
}

const POOL = poolKeyFor(MNVDA, BUSD, 3000, 60, ZERO);

const LEG_TUPLE = [{
  type: "tuple",
  components: [{ name: "kind", type: "uint8" }, { name: "data", type: "bytes" }],
}] as const;

test("a fill's cost is exact and rounds toward the resting maker, so a program can bound itself", () => {
  const units = 1_000n * 10n ** 6n;
  const price = tickToPrice(TICK);
  // A bid: the taker borrows, and the core rounds the principal DOWN.
  assert.equal(fillCost(offerOn(PUT, true), units), (units * price) / 10n ** 18n);
  // An ask: the taker lends, and the core rounds the cost UP.
  assert.equal(fillCost(offerOn(PUT, false), units), (units * price + 10n ** 18n - 1n) / 10n ** 18n);
});

test("the fee is a share of the premium, never of the notional, and floors", () => {
  const units = 1_000n * 10n ** 6n;
  const cost = fillCost(offerOn(PUT, true), units);
  assert.equal(originationFee(units, cost, 0n), 0n, "a fee-free router skims nothing");
  assert.equal(originationFee(units, cost, 1_000n), ((units - cost) * 1_000n) / 10_000n);
  // Par or better carries no premium and so no fee, whatever the rate.
  assert.equal(originationFee(units, units, 2_000n), 0n);
  assert.equal(originationFee(units, units + 1n, 2_000n), 0n);
});

test("a protective put is one bid leg: the account posts the whole collateral and the cash floor is exact", () => {
  const units = 1_250n * 10n ** 6n; // 10 mNVDA at the 125 strike
  const build = buildOpenProgram(view("protectivePut", PUT), { domain: DOMAIN, offer: offerOn(PUT, true), units, feeBps: 1_000n });

  assert.equal(build.legs.length, 1);
  assert.equal(build.legs[0].kind, LEG_KIND.FILL_BID);
  assert.equal(build.derived.collateral, 10n * 10n ** 18n, "the strike's own arithmetic");
  assert.equal(build.derived.maxTopUp, build.derived.collateral, "no swap, so every unit of it comes from the account");
  assert.equal(build.derived.principal, build.derived.cost - build.derived.fee);
  assert.equal(build.derived.minPrincipal, build.derived.principal, "the tick fixes the cash, so the floor is exact");
});

test("a short carries its swap inside the bid leg, and the swap's floor is what bounds the top-up", () => {
  const units = 2n * 10n ** 18n; // two mNVDA of face on the call line
  const minOut = 400n * 10n ** 6n;
  const build = buildOpenProgram(view("short", CALL), {
    domain: DOMAIN, offer: offerOn(CALL, true), units, poolKey: POOL, minOut, feeBps: 1_000n,
  });

  assert.equal(build.legs.length, 1);
  const [decoded] = decodeAbiParameters(
    [{
      type: "tuple",
      components: [
        { name: "offer", type: "tuple", components: [
          { name: "chainId", type: "uint256" }, { name: "bivium", type: "address" }, { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" }, { name: "maturity", type: "uint256" }, { name: "strike", type: "uint256" },
          { name: "allowPartialRepay", type: "bool" }, { name: "gate", type: "address" }, { name: "maker", type: "address" },
          { name: "buy", type: "bool" }, { name: "tick", type: "uint256" }, { name: "maxUnits", type: "uint256" },
          { name: "maxAssets", type: "uint256" }, { name: "start", type: "uint256" }, { name: "expiry", type: "uint256" },
          { name: "group", type: "bytes32" }, { name: "ratifier", type: "address" },
        ] },
        { name: "ratifierData", type: "bytes" },
        { name: "units", type: "uint256" },
        { name: "maxTopUp", type: "uint256" },
        { name: "minPrincipal", type: "uint256" },
        { name: "inner", ...LEG_TUPLE[0] , type: "tuple[]" },
      ],
    }],
    build.legs[0].data,
  ) as unknown as [{ units: bigint; maxTopUp: bigint; inner: { kind: number }[]; offer: { tick: bigint; chainId: bigint; bivium: Address } }];

  assert.equal(decoded.units, units, "the payload round-trips through the contract's own shape");
  assert.equal(decoded.offer.tick, TICK);
  assert.equal(decoded.offer.chainId, 46630n, "the domain is prefixed the way the core-v2 adapter does it");
  assert.equal(decoded.offer.bivium, CORE);
  assert.equal(decoded.inner.length, 1);
  assert.equal(decoded.inner[0].kind, LEG_KIND.SWAP, "the sale runs inside the take callback");
  assert.equal(decoded.maxTopUp, build.derived.collateral - minOut, "only what the swap cannot be relied on to deliver");
  assert.equal(build.derived.maxTopUp, decoded.maxTopUp);
});

test("a swap-carrying strategy refuses to be built without the pool and the floor that bound it", () => {
  const units = 2n * 10n ** 18n;
  assert.throws(
    () => buildOpenProgram(view("short", CALL), { domain: DOMAIN, offer: offerOn(CALL, true), units }),
    /pool key is required/,
  );
  assert.throws(
    () => buildOpenProgram(view("short", CALL), { domain: DOMAIN, offer: offerOn(CALL, true), units, poolKey: POOL }),
    /minOut is required/,
  );
  // And a strategy takes the side it is: a lend leg is not a bid.
  assert.throws(
    () => buildOpenProgram(view("protectivePut", PUT), { domain: DOMAIN, offer: offerOn(PUT, false), units }),
    /takes a lender's bid, not an ask/,
  );
  assert.throws(
    () => buildOpenProgram(view("lendQuote", PUT), { domain: DOMAIN, offer: offerOn(PUT, true), units }),
    /takes a resting ask, not a bid/,
  );
});

test("a lend is one ask leg whose ceiling is the cost the core will charge, to the wei", () => {
  const units = 2_000n * 10n ** 6n;
  const build = buildOpenProgram(view("lendQuote", PUT), { domain: DOMAIN, offer: offerOn(PUT, false), units });
  assert.equal(build.legs.length, 1);
  assert.equal(build.legs[0].kind, LEG_KIND.FILL_ASK);
  assert.equal(build.derived.cost, fillCost(offerOn(PUT, false), units));
  assert.equal(build.derived.fee, 0n, "the taker-lender pays no origination");
});

test("an unwind is pull-repay-withdraw out of pocket, or one flash leg out of the collateral", () => {
  const assets = 1_250n * 10n ** 6n;
  const wallet = buildUnwindProgram({ domain: DOMAIN, params: PUT, assets, via: "wallet" });
  assert.deepEqual(wallet.map((l) => l.kind), [LEG_KIND.PULL, LEG_KIND.REPAY, LEG_KIND.WITHDRAW]);

  const flash = buildUnwindProgram({
    domain: DOMAIN, params: CALL, assets: 2n * 10n ** 18n, via: "flash", poolKey: POOL, maxSettleIn: 600n * 10n ** 6n,
  });
  assert.deepEqual(flash.map((l) => l.kind), [LEG_KIND.FLASH], "the repay and withdraw are inside it");

  assert.throws(() => buildUnwindProgram({ domain: DOMAIN, params: CALL, assets, via: "flash" }), /needs the pool/);
  assert.throws(() => buildUnwindProgram({ domain: DOMAIN, params: CALL, assets, via: "flash", poolKey: POOL }), /needs maxSettleIn/);
  assert.throws(() => buildUnwindProgram({ domain: DOMAIN, params: PUT, assets: 0n, via: "wallet" }), /positive size/);

  // A cash borrow can be repaid out of pocket; a position whose loan token was sold cannot.
  assert.equal(defaultUnwindVia(view("protectivePut", PUT)), "wallet");
  assert.equal(defaultUnwindVia(view("short", CALL)), "flash");
  assert.equal(defaultUnwindVia(view("leveredLong", PUT)), "flash");
});

test("a pool key is sorted, hashes to its id, and is checked against the market's own pair", () => {
  assert.deepEqual(poolKeyFor(MNVDA, BUSD, 3000, 60, ZERO), poolKeyFor(BUSD, MNVDA, 3000, 60, ZERO));
  assert.match(poolIdOf(POOL), /^0x[0-9a-f]{64}$/);
  assert.notEqual(poolIdOf(POOL), poolIdOf(poolKeyFor(MNVDA, BUSD, 500, 10, ZERO)), "a fee tier is a different pool");
  assert.equal(poolKeyCarries(POOL, BUSD, MNVDA), true);
  assert.equal(poolKeyCarries(POOL, BUSD, CORE), false);
});

test("the pool price prices both directions and takes its fee off the input", () => {
  // sqrtPriceX96 for a price of 1: currency1 per currency0 == 1.
  const one = 2n ** 96n;
  const amountIn = 1_000_000n;
  const zeroIn = outAtPoolPrice(POOL, one, POOL.currency0, amountIn);
  const oneIn = outAtPoolPrice(POOL, one, POOL.currency1, amountIn);
  assert.equal(zeroIn, (amountIn * 997_000n) / 1_000_000n, "0.3% off the input, then the price");
  assert.equal(oneIn, zeroIn, "at a price of one the two directions agree");
  assert.equal(outAtPoolPrice(POOL, one, POOL.currency0, 0n), 0n);
  assert.throws(() => outAtPoolPrice(POOL, one, CORE, amountIn), /not one of the pool's currencies/);
});

test("a swap floor prefers what the caller said, then depth, then the pool's price — and refuses to guess", async () => {
  const call = async () => "0x" as Hex;
  const explicit = await swapFloor({ call, key: POOL, tokenIn: MNVDA, amountIn: 1n, slippageBps: 100, explicit: 42n });
  assert.deepEqual(explicit, { minOut: 42n, source: "explicit", estimate: 42n, slippageBps: 0 });

  // The Quoter answers: depth-aware, and the slippage is cut off ITS number.
  const quoted = await swapFloor({
    call: async () => (`0x${(1000n).toString(16).padStart(64, "0")}${(0n).toString(16).padStart(64, "0")}`) as Hex,
    key: POOL, tokenIn: MNVDA, amountIn: 10n ** 18n, slippageBps: 100, quoter: CORE,
  });
  assert.equal(quoted.source, "quoter");
  assert.equal(quoted.estimate, 1000n);
  assert.equal(quoted.minOut, 990n, "100 bps off the quote");

  // No Quoter, but a StateView with a live price: marginal, and it says so.
  const priced = await swapFloor({
    call: async () => (`0x${(2n ** 96n).toString(16).padStart(64, "0")}`) as Hex,
    key: POOL, tokenIn: POOL.currency0, amountIn: 1_000_000n, slippageBps: 100, stateView: CORE,
  });
  assert.equal(priced.source, "pool-price");
  assert.equal(priced.minOut, (priced.estimate * 9_900n) / 10_000n);

  // Nothing to price it with is a refusal, not a zero floor.
  await assert.rejects(
    swapFloor({ call, key: POOL, tokenIn: MNVDA, amountIn: 1n, slippageBps: 100 }),
    /no floor for the swap leg/,
  );
  await assert.rejects(
    swapFloor({ call, key: POOL, tokenIn: MNVDA, amountIn: 1n, slippageBps: 10_000, explicit: 1n }),
    /slippage must be within/,
  );
});

test("the buy-back's ceiling rounds against the caller and refuses without a price", async () => {
  const call = async () => (`0x${(2n ** 96n).toString(16).padStart(64, "0")}`) as Hex;
  const ceiling = await swapCeiling({ call, key: POOL, tokenIn: POOL.currency0, amountOut: 1_000_000n, slippageBps: 100, stateView: CORE });
  assert.equal(ceiling.source, "pool-price");
  assert.ok(ceiling.estimate > 1_000_000n, "the fee makes the input larger than the output at a price of one");
  assert.equal(ceiling.maxIn, (ceiling.estimate * 10_100n) / 10_000n, "slippage widens a ceiling rather than cutting it");

  const explicit = await swapCeiling({ call, key: POOL, tokenIn: MNVDA, amountOut: 1n, slippageBps: 100, explicit: 7n });
  assert.equal(explicit.maxIn, 7n);
  await assert.rejects(
    swapCeiling({ call: async () => "0x" as Hex, key: POOL, tokenIn: MNVDA, amountOut: 1n, slippageBps: 100 }),
    /pass --max-settle-in/,
  );
});

test("only a program that touches the account's own position needs the grant", () => {
  const lend = buildOpenProgram(view("lendQuote", PUT), { domain: DOMAIN, offer: offerOn(PUT, false), units: 10n ** 6n });
  assert.equal(programNeedsGrant(lend.legs), false, "the router is the taker on an ask");

  const put = buildOpenProgram(view("protectivePut", PUT), { domain: DOMAIN, offer: offerOn(PUT, true), units: 10n ** 6n });
  assert.equal(programNeedsGrant(put.legs), true);
  assert.equal(programNeedsGrant(buildUnwindProgram({ domain: DOMAIN, params: PUT, assets: 1n, via: "wallet" })), true);

  assert.equal(grantCoversProgram({ capabilities: PROGRAM_CAPS, expiry: 0n }, 10n), true, "0 is perpetual");
  assert.equal(grantCoversProgram({ capabilities: PROGRAM_CAPS, expiry: 5n }, 10n), false, "expired");
  assert.equal(grantCoversProgram({ capabilities: 1n << 2n, expiry: 0n }, 10n), false, "CAP_FILL alone is not enough");
});
