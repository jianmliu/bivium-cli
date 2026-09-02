// Trade-planning edge cases that need no chain: request validation, empty book, limit-tick
// exclusion feeding the planner, exact-spend refusing partial fills. (Execution paths — approvals,
// multicall, postconditions — are exercised by the recorded anvil e2e run.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { fillCost, filterByLimitTick, planSweepByFace, sortSide, type BookEntry } from "../src/sdk/orderbook.ts";
import { TradeClient, askBackingShortfall } from "../src/sdk/trade.ts";
import { tickToPrice } from "../src/sdk/tick.ts";
import type { Address, DeploymentProfile, Hex, Offer } from "../src/sdk/types.ts";

const PROFILE: DeploymentProfile = {
  name: "offline-test",
  abiProfile: "core-v2",
  chainId: 31337,
  core: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  signatureRatifier: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  rpcUrl: "http://127.0.0.1:1", // never reached in these tests
};

function ask(tick: bigint, size: bigint, maker: string): BookEntry {
  const offer: Offer = {
    loanToken: "0x0000000000000000000000000000000000000001",
    collateralToken: "0x0000000000000000000000000000000000000002",
    maturity: 1_800_000_000n,
    strike: 10n ** 36n,
    allowPartialRepay: false,
    gate: "0x0000000000000000000000000000000000000000",
    maker: maker as Address,
    buy: false,
    tick,
    maxUnits: size,
    maxAssets: 0n,
    start: 0n,
    expiry: 1_799_000_000n,
    group: ("0x" + "00".repeat(32)) as Hex,
    ratifier: "0x00000000000000000000000000000000000000bb",
  };
  return { side: "ask", offer, signature: ("0x" + "11".repeat(65)) as Hex, commitment: ("0x" + tick.toString(16).padStart(64, "0")) as Hex, price: tickToPrice(tick), size, maker: maker as Address };
}

test("planBuy demands exactly one of units or spend", async () => {
  const tc = new TradeClient(PROFILE);
  await assert.rejects(tc.planBuy([], {}), /exactly one of units or spend/);
  await assert.rejects(tc.planBuy([], { units: 1n, spend: 1n }), /exactly one of units or spend/);
});

test("planSell only takes units", async () => {
  const tc = new TradeClient(PROFILE);
  await assert.rejects(tc.planSell([], { spend: 1n }), /units/);
});

test("empty book plans to nothing and executePlan refuses before touching the chain", async () => {
  const tc = new TradeClient(PROFILE);
  const plan = await tc.planBuy([], { units: 100n });
  assert.equal(plan.takes.length, 0);
  assert.equal(plan.totalUnits, 0n);
  assert.equal(plan.totalCost, 0n);
  assert.equal(plan.worstTick, undefined);
  await assert.rejects(tc.executePlan(plan), /nothing to fill/);
});

test("exact-spend on an empty book refuses with the achievable maximum (no partial)", async () => {
  const tc = new TradeClient(PROFILE);
  await assert.rejects(tc.planBuy([], { spend: 1_000_000n, exactSpend: true }), /exact spend not executable/);
});

test("limit-tick excludes worse-priced asks from the sweep and bounds the worst tick", () => {
  const book = sortSide([ask(4032n, 1_000n, "0xa"), ask(4048n, 1_000n, "0xb"), ask(4100n, 1_000n, "0xc")], "ask");
  // A buyer capping the price at tick 4048 must never touch the 4100 level.
  const bounded = filterByLimitTick(book, "ask", 4048n);
  assert.deepEqual(bounded.map((e) => e.offer.tick), [4032n, 4048n]);
  const plan = planSweepByFace(bounded, 5_000n);
  assert.equal(plan.filled, 2_000n); // book ran dry at the bound rather than slipping to 4100
  assert.ok(plan.takes.every((t) => t.entry.offer.tick <= 4048n));
  assert.equal(
    plan.cost,
    plan.takes.reduce((sum, t) => sum + fillCost(t.entry.offer, t.units, t.entry.price), 0n),
  );
});

test("askBackingShortfall: credit alone, escrow alone, both, and the ceil that core applies", () => {
  const strike = 85n * 10n ** 24n; // 85 bUSD (6dp) per mNVDA (18dp) — the Robinhood mnvda-busd-85 market
  // pure secondary: the maker holds every unit it sells
  assert.equal(askBackingShortfall({ units: 300_000_000n, credit: 300_000_000n, escrow: 0n, strike }), 0n);
  // pure resting borrow order (bivium-core #171): 300 face against 5 mNVDA needs ceil(300e6·1e36/85e24) = 3.529… mNVDA
  assert.equal(askBackingShortfall({ units: 300_000_000n, credit: 0n, escrow: 5n * 10n ** 18n, strike }), 0n);
  assert.equal(
    askBackingShortfall({ units: 300_000_000n, credit: 0n, escrow: 3_529_411_764_705_882_352n, strike }),
    1n, // one wei short of the rounded-up lock
  );
  // mixed: 100 held + 200 originated against exactly the collateral 200 face locks
  const lock200 = (200_000_000n * 10n ** 36n + strike - 1n) / strike;
  assert.equal(askBackingShortfall({ units: 300_000_000n, credit: 100_000_000n, escrow: lock200, strike }), 0n);
  assert.equal(askBackingShortfall({ units: 300_000_000n, credit: 100_000_000n, escrow: lock200 - 1n, strike }), 1n);
  // no escrow at all collapses to the pre-#171 rule
  assert.ok(askBackingShortfall({ units: 300_000_000n, credit: 0n, escrow: 0n, strike }) > 0n);
});
