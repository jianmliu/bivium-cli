import assert from "node:assert/strict";
import { test } from "node:test";
import { creditAfter, previewMarketMaking } from "../src/sdk/marketMaking.ts";
import { entryFromSignedOffer } from "../src/sdk/orderbook.ts";
import { WAD, ZERO_ADDRESS, type Offer } from "../src/sdk/types.ts";
import { fillCost } from "../src/sdk/orderbook.ts";
const offer: Offer = { loanToken: "0xa", collateralToken: "0xb", maturity: 2000n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true, maker: "0xc", ratifier: "0xd", group: "0x1", buy: true, tick: 4096n, maxUnits: 60n, maxAssets: 0n, start: 0n, expiry: 1900n };
const bid = { ...entryFromSignedOffer(offer, "0x1", "0x"), price: WAD };
const ask = { ...entryFromSignedOffer({ ...offer, buy: false, maxUnits: 40n, group: "0x2" }, "0x2", "0x"), price: WAD };
const input = { account: offer.maker, marketId: "0x1" as const, params: offer, now: 1000n, credit: 100n, debt: 0n, liquidity: 100n, collateralEscrow: 0n, cash: 100n, existingOrders: [], candidateOrders: [bid, ask], coverage: "complete" as const, policy: { maxCredit: 150n, maxNewDebt: 0n, minCash: 0n, maxCommittedLoan: 100n, maxLoss: 1000n, allowOrigination: false } };
test("single-sided risk is not hidden by balanced fills", () => {
  assert.equal(creditAfter(100n, 60n, 0n), 160n);
  const result = previewMarketMaking(input);
  assert.deepEqual(result.scenarios.map((s) => s.credit), [100n, 160n, 60n, 120n]);
  assert.equal(result.decision, "reject");
  assert.ok(result.scenarios[1].violations.includes("MAX_CREDIT"));
});
test("old orders count, incomplete coverage never produces account-safe verdict", () => {
  const result = previewMarketMaking({ ...input, candidateOrders: [], existingOrders: [bid], coverage: "unknown", policy: { ...input.policy, maxCredit: 200n } });
  assert.equal(result.scenarios[1].credit, 160n);
  assert.equal(result.decision, "incomplete");
  assert.equal(result.accountSafe, false);
});
test("origination requires policy and per-fill collateral backing", () => {
  const rejected = previewMarketMaking({ ...input, credit: 0n, collateralEscrow: 100n, candidateOrders: [ask] });
  assert.equal(rejected.decision, "reject");
  const enabled = previewMarketMaking({ ...input, credit: 0n, collateralEscrow: 100n, candidateOrders: [ask], policy: { ...input.policy, allowOrigination: true, maxNewDebt: 50n } });
  assert.equal(enabled.scenarios[2].credit, 0n);
  assert.equal(enabled.scenarios[2].newDebt, 40n);
  assert.equal(enabled.scenarios[2].lockedCollateral, 40n);
});
test("daily PnL accounting cannot be claimed by inventory preview", () => {
  assert.equal(previewMarketMaking({ ...input, policy: { ...input.policy, requireDailyLossAccounting: true } }).decision, "reject");
});
test("existing and new groups share cash backing; wallet cash differs from deposited liquidity", () => {
  const extra = { ...entryFromSignedOffer({ ...offer, group: "0x3" }, "0x3", "0x"), price: WAD };
  const p = { ...input.policy, maxCredit: 1000n };
  const result = previewMarketMaking({ ...input, existingOrders: [extra], candidateOrders: [bid], policy: p });
  assert.ok(result.scenarios[1].violations.includes("INSUFFICIENT_BACKING"));
  assert.equal(result.scenarios[1].cash, 100n);
  assert.equal(result.scenarios[1].liquidity, 100n - 2n * fillCost(offer, 60n, entryFromSignedOffer(offer, "0x1", "0x").price));
  assert.ok(previewMarketMaking({ ...input, policy: { ...p, minCash: 101n } }).scenarios[0].violations.includes("MIN_CASH"));
});
test("own caps and consumed share budgets; non-par ticks use directional cash rounding", () => {
  const lower = { ...bid, consumed: 10n };
  const higher = { ...entryFromSignedOffer({ ...offer, maxUnits: 90n }, "0x4", "0x"), consumed: 10n };
  const result = previewMarketMaking({ ...input, candidateOrders: [lower, higher], policy: { ...input.policy, maxCredit: 1000n } });
  assert.equal(result.scenarios[1].credit, 180n);
  const discounted = entryFromSignedOffer({ ...offer, tick: 4032n, maxUnits: 7n }, "0x5", "0x");
  assert.equal(previewMarketMaking({ ...input, candidateOrders: [discounted] }).scenarios[1].bidCost, fillCost(discounted.offer, 7n, discounted.price));
  const short = previewMarketMaking({ ...input, credit: 0n, collateralEscrow: 1n, candidateOrders: [ask], policy: { ...input.policy, allowOrigination: true, maxNewDebt: 100n } });
  assert.ok(short.scenarios[2].violations.includes("INSUFFICIENT_BACKING"));
});
test("shared assets budgets explore cheap-first credit exposure", () => {
  const orders = [4000n, 2800n].map((tick, i) => entryFromSignedOffer({ ...offer, tick, maxUnits: 0n, maxAssets: 80n }, `0x${i + 10}`, "0x"));
  const result = previewMarketMaking({ ...input, credit: 0n, candidateOrders: orders, policy: { ...input.policy, maxCredit: 100n } });
  assert.equal(result.decision, "reject");
});
test("derived book metadata cannot hide signed inventory exposure", () => {
  const result = previewMarketMaking({ ...input, candidateOrders: [{ ...bid, size: 0n, price: 0n, side: "ask" }] });
  assert.equal(result.decision, "reject");
  assert.equal(result.scenarios[1].credit, 160n);
});
test("one assets bid cannot claim a bound from one fill's rounding", () => {
  const one = entryFromSignedOffer({ ...offer, tick: 4000n, maxUnits: 0n, maxAssets: 80n }, '0x10', '0x');
  const result = previewMarketMaking({ ...input, credit: 0n, candidateOrders: [one], policy: { ...input.policy, maxCredit: 100n } });
  assert.equal(result.decision, 'incomplete');
  assert.equal(result.fragmentedFillRisk, true);
});
