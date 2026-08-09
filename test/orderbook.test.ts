// Order-book vectors — the numeric cases are lifted from the frontend's lib/orderbook.test.ts so
// both implementations stay pinned to the same fills (same tickToPrice grid, same maker-direction
// rounding, same sweep walks).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateLevels,
  entryFromSignedOffer,
  fillCost,
  filterByLimitTick,
  offerActiveAt,
  offerCap,
  planExactSpend,
  planSweepByFace,
  planSweepBySpend,
  queuePosition,
  reconcileConsumedEntries,
  remainingFace,
  sortSide,
  type BookEntry,
} from "../src/sdk/orderbook.ts";
import { tickToPrice } from "../src/sdk/tick.ts";
import { WAD, type Address, type Hex, type Offer } from "../src/sdk/types.ts";

const GROUP = ("0x" + "00".repeat(32)) as Hex;
const SIG = ("0x" + "11".repeat(65)) as Hex;

function makeOffer(side: "ask" | "bid", tick: bigint, maker: string, maxUnits = 1000n, maxAssets = 0n): Offer {
  return {
    loanToken: "0x0000000000000000000000000000000000000001",
    collateralToken: "0x0000000000000000000000000000000000000002",
    maturity: 1_800_000_000n,
    strike: 10n ** 36n,
    allowPartialRepay: false,
    gate: "0x0000000000000000000000000000000000000000",
    maker: maker as Address,
    buy: side === "bid",
    tick,
    maxUnits,
    maxAssets,
    start: 0n,
    expiry: 1_799_000_000n,
    group: GROUP,
    ratifier: "0x00000000000000000000000000000000000000bb",
  };
}

function clob(side: "ask" | "bid", tick: bigint, maker: string): BookEntry {
  const offer = makeOffer(side, tick, maker);
  return { side, offer, signature: SIG, commitment: GROUP, price: tickToPrice(tick), size: 1000n, maker: maker as Address };
}

function sizedAsk(tick: bigint, size: bigint, maker: string): BookEntry {
  const entry = clob("ask", tick, maker);
  return { ...entry, size, offer: { ...entry.offer, maxUnits: size } };
}

test("entryFromSignedOffer tags the side from buy and sizes from the caps", () => {
  const ask = entryFromSignedOffer(makeOffer("ask", 3000n, "0xa".padEnd(42, "0"), 500n), GROUP, SIG);
  assert.equal(ask.side, "ask");
  assert.equal(ask.size, 500n);
  assert.equal(ask.price, tickToPrice(3000n));
  const bid = entryFromSignedOffer(makeOffer("bid", 2900n, "0xa".padEnd(42, "0"), 0n, 1000n * WAD), GROUP, SIG);
  assert.equal(bid.side, "bid");
  assert.equal(bid.size, (1000n * WAD * WAD) / tickToPrice(2900n));
});

test("sortSide: best ask = lowest price, best bid = highest price", () => {
  const all = [clob("ask", 3200n, "0xa"), clob("ask", 3000n, "0xb"), clob("bid", 2950n, "0xc"), clob("bid", 2900n, "0xd")];
  const asks = sortSide(all, "ask");
  const bids = sortSide(all, "bid");
  assert.equal(asks.length, 2);
  assert.ok(asks[0].price <= asks[1].price);
  assert.equal(asks[0].offer.tick, 3000n);
  assert.equal(bids.length, 2);
  assert.ok(bids[0].price >= bids[1].price);
  assert.equal(bids[0].offer.tick, 2950n);
});

test("offerCap + remainingFace: assets-capped bid vs units-capped ask (frontend vectors)", () => {
  const bid = makeOffer("bid", 2900n, "0xa", 0n, 1000n * WAD);
  const ask = makeOffer("ask", 3000n, "0xb", 500n);
  assert.equal(offerCap(bid), 1000n * WAD);
  assert.equal(offerCap(ask), 500n);
  const price = tickToPrice(2900n);
  assert.equal(remainingFace(bid, 500n * WAD, price), (500n * WAD * WAD) / price);
  assert.equal(remainingFace(ask, 200n, price), 300n);
  assert.equal(remainingFace(ask, 500n, price), 0n);
});

test("reconcileConsumedEntries fails closed until every consumed read succeeds", () => {
  const entry = clob("bid", 2900n, "0xa");
  assert.deepEqual(reconcileConsumedEntries([entry], []), { ready: false, entries: [] });
  assert.deepEqual(reconcileConsumedEntries([entry], [undefined]), { ready: false, entries: [] });
  assert.deepEqual(reconcileConsumedEntries([], []), { ready: true, entries: [] });
});

test("reconcileConsumedEntries derives live assets-capped bid face from consumed assets", () => {
  const base = clob("bid", 2900n, "0xa");
  const maxAssets = 1_000n * WAD;
  const bid: BookEntry = { ...base, offer: { ...base.offer, maxUnits: 0n, maxAssets }, size: 0n };
  const fullFace = remainingFace(bid.offer, 0n, bid.price);

  const full = reconcileConsumedEntries([bid], [0n]);
  assert.equal(full.ready, true);
  assert.equal(full.entries[0]?.size, fullFace);
  assert.ok(fullFace > 0n);

  const partial = reconcileConsumedEntries([bid], [500n * WAD]);
  assert.equal(partial.ready, true);
  assert.equal(partial.entries[0]?.size, remainingFace(bid.offer, 500n * WAD, bid.price));
  assert.ok(partial.entries[0]!.size < fullFace);

  assert.deepEqual(reconcileConsumedEntries([bid], [maxAssets]), { ready: true, entries: [] });
  assert.deepEqual(reconcileConsumedEntries([bid], [maxAssets + 1n]), { ready: true, entries: [] });
});

test("reconcileConsumedEntries drops remaining capacity whose full face rounds to zero assets", () => {
  const base = clob("bid", 2900n, "0xa");
  const dust: BookEntry = { ...base, offer: { ...base.offer, maxUnits: 0n, maxAssets: 1n }, size: 0n };
  assert.ok(remainingFace(dust.offer, 0n, dust.price) > 0n);
  assert.deepEqual(reconcileConsumedEntries([dust], [0n]), { ready: true, entries: [] });
});

test("reconcileConsumedEntries keeps the remaining units of a units-capped ask", () => {
  const base = clob("ask", 3000n, "0xb");
  const ask: BookEntry = { ...base, offer: { ...base.offer, maxUnits: 500n, maxAssets: 0n }, size: 0n };
  const reconciled = reconcileConsumedEntries([ask], [200n]);
  assert.equal(reconciled.ready, true);
  assert.equal(reconciled.entries[0]?.size, 300n);
});

test("aggregateLevels merges same-price entries and accumulates depth", () => {
  const a1 = clob("ask", 3000n, "0xa");
  const a2 = clob("ask", 3000n, "0xb");
  const a3 = clob("ask", 3100n, "0xc");
  const levels = aggregateLevels(sortSide([a3, a1, a2], "ask"));
  assert.equal(levels.length, 2);
  assert.equal(levels[0].size, 2000n);
  assert.equal(levels[0].entries.length, 2);
  assert.equal(levels[0].cumulative, 2000n);
  assert.equal(levels[1].cumulative, 3000n);
  assert.ok(levels[0].price <= levels[1].price);
});

test("fillCost mirrors core rounding: maker-buy bids floor and maker-sell asks ceil", () => {
  const price = WAD / 3n;
  const bid = makeOffer("bid", 2900n, "0xa");
  const ask = makeOffer("ask", 2900n, "0xb");
  assert.equal(fillCost(bid, 0n, price), 0n);
  assert.equal(fillCost(bid, 1n, price), 0n);
  assert.equal(fillCost(bid, 4n, price), 1n);
  assert.equal(fillCost(ask, 1n, price), 1n);
  assert.equal(fillCost(ask, 4n, price), 2n);
});

test("planSweepByFace walks levels best-first and reports partial fills (frontend vectors)", () => {
  const a1 = clob("ask", 3000n, "0xa");
  const a2 = clob("ask", 3100n, "0xb");
  const sorted = sortSide([a2, a1], "ask");
  const plan = planSweepByFace(sorted, 1500n);
  assert.equal(plan.takes.length, 2);
  assert.equal(plan.takes[0].units, 1000n);
  assert.equal(plan.takes[1].units, 500n);
  assert.equal(plan.filled, 1500n);
  const expect =
    (1000n * tickToPrice(3000n) + WAD - 1n) / WAD + (500n * tickToPrice(3100n) + WAD - 1n) / WAD;
  assert.equal(plan.cost, expect);
  const dry = planSweepByFace(sorted, 5000n);
  assert.equal(dry.filled, 2000n);
});

test("planSweepByFace skips a dust take whose cost rounds to zero", () => {
  const dust = { ...clob("bid", 3000n, "0xa"), size: 1n, price: WAD / 3n };
  const real = { ...clob("bid", 2900n, "0xb"), size: 100n };
  const plan = planSweepByFace([dust, real], 100n);
  assert.equal(plan.takes.length, 1);
  assert.equal(plan.takes[0].entry.maker, real.maker);
  assert.equal(plan.filled, 100n);
  assert.ok(plan.takes.every((take) => fillCost(take.entry.offer, take.units, take.entry.price) > 0n));
});

test("planSweepBySpend converts a budget to face best-first and never overspends (frontend vectors)", () => {
  const a1 = clob("ask", 3000n, "0xa");
  const a2 = clob("ask", 3100n, "0xb");
  const sorted = sortSide([a2, a1], "ask");
  const p1 = tickToPrice(3000n);
  const p2 = tickToPrice(3100n);
  const budget = fillCost(a1.offer, 1000n, p1) + fillCost(a2.offer, 500n, p2);
  const plan = planSweepBySpend(sorted, budget);
  assert.equal(plan.takes.length, 2);
  assert.equal(plan.takes[0].units, 1000n);
  assert.ok(plan.takes[1].units >= 499n && plan.takes[1].units <= 500n);
  assert.ok(plan.cost <= budget);
  assert.equal(
    plan.cost,
    plan.takes.reduce((sum, take) => sum + fillCost(take.entry.offer, take.units, take.entry.price), 0n),
  );
  assert.equal(plan.units, plan.takes[0].units + plan.takes[1].units);
  const rich = planSweepBySpend(sorted, budget * 10n);
  assert.equal(rich.units, 2000n);
  assert.ok(rich.cost < budget * 10n);
  assert.deepEqual(planSweepBySpend(sorted, 0n), { takes: [], units: 0n, cost: 0n });
  assert.deepEqual(planSweepBySpend([], budget), { takes: [], units: 0n, cost: 0n });
});

test("planExactSpend refuses the real two-level partial quote (frontend chain vectors)", () => {
  const asks = sortSide([sizedAsk(4048n, 44_550_000n, "0xb"), sizedAsk(4032n, 44_550_000n, "0xa")], "ask");
  assert.deepEqual(planExactSpend(asks, 100_000_000n), {
    kind: "insufficient-depth",
    requestedAssets: 100_000_000n,
    maxAssets: 88_783_027n,
    maxUnits: 89_100_000n,
    shortfallAssets: 11_216_973n,
    levelCount: 2,
  });
});

test("planExactSpend enforces the USDC atomic-unit boundary (frontend chain vectors)", () => {
  const asks = sortSide([sizedAsk(4048n, 44_550_000n, "0xb"), sizedAsk(4032n, 44_550_000n, "0xa")], "ask");

  const exact = planExactSpend(asks, 88_783_027n);
  assert.equal(exact.kind, "executable");
  if (exact.kind === "executable") {
    assert.equal(exact.plan.cost, 88_783_027n);
    assert.equal(exact.plan.units, 89_100_000n);
    assert.equal(exact.plan.takes.length, 2);
    assert.equal(exact.levelCount, 2);
  }

  assert.deepEqual(planExactSpend(asks, 88_783_028n), {
    kind: "insufficient-depth",
    requestedAssets: 88_783_028n,
    maxAssets: 88_783_027n,
    maxUnits: 89_100_000n,
    shortfallAssets: 1n,
    levelCount: 2,
  });

  const oneLess = planExactSpend(asks, 88_783_026n);
  assert.equal(oneLess.kind, "executable");
  if (oneLess.kind === "executable") {
    assert.equal(oneLess.plan.cost, 88_783_026n);
    assert.equal(oneLess.plan.units, 89_099_999n);
  }
});

test("planExactSpend requires a positive request and clamps non-positive shortfall to zero", () => {
  const asks = [sizedAsk(4032n, 44_550_000n, "0xa")];
  assert.deepEqual(planExactSpend(asks, 0n), {
    kind: "insufficient-depth",
    requestedAssets: 0n,
    maxAssets: 0n,
    maxUnits: 0n,
    shortfallAssets: 0n,
    levelCount: 0,
  });
});

test("filterByLimitTick: buy caps the price paid, sell floors the price received", () => {
  const asks = [clob("ask", 3000n, "0xa"), clob("ask", 3100n, "0xb"), clob("ask", 3200n, "0xc")];
  // Buyer of asks: keep tick ≤ limit (lower tick = lower price = better for the buyer).
  assert.deepEqual(filterByLimitTick(asks, "ask", 3100n).map((e) => e.offer.tick), [3000n, 3100n]);
  const bids = [clob("bid", 2800n, "0xa"), clob("bid", 2900n, "0xb"), clob("bid", 3000n, "0xc")];
  // Seller into bids: keep tick ≥ limit (higher tick = higher price = better for the seller).
  assert.deepEqual(filterByLimitTick(bids, "bid", 2900n).map((e) => e.offer.tick), [2900n, 3000n]);
  assert.equal(filterByLimitTick(asks, "ask", undefined).length, 3);
});

test("offerActiveAt window semantics for the relayer book filter", () => {
  const offer = { start: 100n, expiry: 200n, maturity: 300n };
  assert.equal(offerActiveAt(offer, 99n), false);
  assert.equal(offerActiveAt(offer, 100n), true);
  assert.equal(offerActiveAt(offer, 199n), true);
  assert.equal(offerActiveAt(offer, 200n), false);
  assert.equal(offerActiveAt({ start: 0n, expiry: 400n, maturity: 300n }, 300n), false);
});

test("queuePosition pins the LOB direction (higher tick = higher price = filled first)", () => {
  assert.equal(queuePosition(3848n, 3840n), "ahead");
  assert.equal(queuePosition(3832n, 3840n), "behind");
  assert.equal(queuePosition(3840n, 3840n), "tied");
  assert.equal(queuePosition(undefined, 3840n), undefined);
  assert.equal(queuePosition(3840n, undefined), undefined);
});
