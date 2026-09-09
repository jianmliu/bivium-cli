import assert from "node:assert/strict";
import test from "node:test";
import { outAtDepth, outAtPoolPrice, priceImpactBps, swapFloor } from "../src/sdk/strategies/pools.ts";
import type { PoolKey } from "../src/sdk/settler.ts";
import type { Address, Hex } from "../src/sdk/types.ts";

// The live bUSD/mCASHCAT pool on Robinhood testnet, read on 2026-09-09 — the one a 500 mCASHCAT program was
// bounded against with the marginal price and reverted `TooLittleOut` on.
const MCASHCAT = "0x34a456c0365B78c5E04b97dee228207cf9CaB35D" as Address;
const BUSD = "0x628626dE13DD4B5b1cb80d468c261C15dF00D717" as Address;
const KEY: PoolKey = { currency0: MCASHCAT, currency1: BUSD, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as Address };
const SQRT = 43624946568329790485051n;
const LIQ = 3200000000000000n;
const STATE_VIEW = "0xf3334192D15450cdd385c8B70e03f9A6bD9E673b" as Address;

test("depth prices what the pool gives; the marginal price prices what it would give if the trade were nothing", () => {
  // 100 mCASHCAT. The fill that actually went through returned 29.618522 bUSD against a 30.12491 marginal quote.
  const small = 100n * 10n ** 18n;
  const marginalSmall = outAtPoolPrice(KEY, SQRT, MCASHCAT, small);
  const depthSmall = outAtDepth(KEY, SQRT, LIQ, MCASHCAT, small);
  assert.ok(depthSmall < marginalSmall, "depth is never better than the marginal quote");
  assert.ok(depthSmall > 29_500000n && depthSmall < 29_800000n, `expected ~29.6 bUSD, got ${depthSmall}`);
  assert.equal(priceImpactBps(marginalSmall, depthSmall), 168); // 1.68%, which is what the chain charged

  // 500 mCASHCAT is the size that reverted: marginal says 151, the pool gives 139.
  const big = 500n * 10n ** 18n;
  const marginalBig = outAtPoolPrice(KEY, SQRT, MCASHCAT, big);
  const depthBig = outAtDepth(KEY, SQRT, LIQ, MCASHCAT, big);
  assert.ok(marginalBig > 151_000000n && depthBig < 140_000000n, `${marginalBig} / ${depthBig}`);
  // A 200 bps cut off the marginal quote lands ABOVE what the pool would pay — which is the revert, in arithmetic.
  assert.ok((marginalBig * 9800n) / 10_000n > depthBig, "the old floor was unreachable");
  // Off the depth quote it lands below, which is a floor a fill can clear.
  assert.ok((depthBig * 9800n) / 10_000n < depthBig);
  assert.ok(priceImpactBps(marginalBig, depthBig) > 700, "a 500-size moves this pool more than 7%");
});

test("impact grows with size and vanishes on a trade the pool does not notice", () => {
  const bps = [1n, 10n, 100n, 500n].map((n) =>
    priceImpactBps(outAtPoolPrice(KEY, SQRT, MCASHCAT, n * 10n ** 18n), outAtDepth(KEY, SQRT, LIQ, MCASHCAT, n * 10n ** 18n)));
  assert.deepEqual(bps, [1, 17, 168, 790]);
  assert.deepEqual(bps, [...bps].sort((a, b) => a - b), "impact is monotone in size");
});

test("selling the other currency walks the price the other way", () => {
  const out = outAtDepth(KEY, SQRT, LIQ, BUSD, 30_000000n);
  const marginal = outAtPoolPrice(KEY, SQRT, BUSD, 30_000000n);
  assert.ok(out > 0n && out < marginal, `${out} vs ${marginal}`);
  // Round trip: what 100 mCASHCAT fetches, sold back, cannot return the 100 — two fees and two impacts.
  const backOut = outAtDepth(KEY, SQRT, LIQ, BUSD, outAtDepth(KEY, SQRT, LIQ, MCASHCAT, 100n * 10n ** 18n));
  assert.ok(backOut < 100n * 10n ** 18n, "a round trip cannot be free");
});

test("the depth quote is a tight bound, not a promise — which is why a slippage cut stays on top", () => {
  // The 100-size fill that went through returned 29.618522 bUSD on-chain. This estimate says 29.717926: within a
  // third of a percent, and OPTIMISTIC, because the real swap meets liquidity this formula assumes stays constant.
  // Pinned as a number rather than described, so a change to the arithmetic has to argue with the chain.
  const estimate = outAtDepth(KEY, SQRT, LIQ, MCASHCAT, 100n * 10n ** 18n);
  const realised = 29_618522n;
  assert.equal(estimate, 29_717926n);
  assert.ok(estimate > realised, "the estimate leans optimistic, so the floor must be cut below it");
  assert.ok(((estimate - realised) * 10_000n) / estimate < 40n, "but by well under half a percent");
});

test("a swap that moves the pool past the caller's limit is refused, not quoted", async () => {
  const slot0 = `0x${SQRT.toString(16).padStart(64, "0")}${"00".repeat(96)}` as Hex;
  const liq = `0x${LIQ.toString(16).padStart(64, "0")}` as Hex;
  const call = async (_to: Address, data: Hex) => (data.startsWith("0xc815641c") ? slot0 : liq);

  const ok = await swapFloor({ call, key: KEY, tokenIn: MCASHCAT, amountIn: 100n * 10n ** 18n,
    slippageBps: 200, stateView: STATE_VIEW, maxImpactBps: 500 });
  assert.equal(ok.source, "pool-depth");
  assert.equal(ok.impactBps, 168);
  assert.ok(ok.minOut < ok.estimate);

  // The same call at the size that reverted on-chain now refuses BEFORE a transaction exists.
  await assert.rejects(
    swapFloor({ call, key: KEY, tokenIn: MCASHCAT, amountIn: 500n * 10n ** 18n,
      slippageBps: 200, stateView: STATE_VIEW, maxImpactBps: 500 }),
    /moves the pool .* past the/,
  );
  // Without a limit it still quotes, and says how far it moved so a caller can decide for itself.
  const loud = await swapFloor({ call, key: KEY, tokenIn: MCASHCAT, amountIn: 500n * 10n ** 18n,
    slippageBps: 200, stateView: STATE_VIEW });
  assert.equal(loud.source, "pool-depth");
  assert.ok(loud.impactBps > 700);
});

test("a pool with no liquidity in range falls back to the marginal price rather than dividing by it", async () => {
  const slot0 = `0x${SQRT.toString(16).padStart(64, "0")}${"00".repeat(96)}` as Hex;
  const zero = `0x${"0".repeat(64)}` as Hex;
  const call = async (_to: Address, data: Hex) => (data.startsWith("0xc815641c") ? slot0 : zero);
  const floor = await swapFloor({ call, key: KEY, tokenIn: MCASHCAT, amountIn: 100n * 10n ** 18n,
    slippageBps: 200, stateView: STATE_VIEW });
  assert.equal(floor.source, "pool-price");
  assert.equal(floor.impactBps, 0);
  assert.equal(outAtDepth(KEY, SQRT, 0n, MCASHCAT, 100n), 0n);
});
