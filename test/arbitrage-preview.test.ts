import assert from "node:assert/strict";
import { test } from "node:test";
import { netAfterCosts, previewArbitrage } from "../src/sdk/arbitrage.ts";
const leg = { marketId: "0x1", token: "0xa", amount: 100n, units: 110n, feesIncluded: false, executionPriceKnown: true, depthKnown: true, ownOrder: false };
test("profit accounts for fees once and gas budget; threshold enforced", () => {
  assert.equal(netAfterCosts(106n, 100n, 2n, 1n), 3n);
  const quote = previewArbitrage({ entry: leg, exit: { ...leg, amount: 106n }, fees: 2n, gasBudget: 1n, minProfit: 4n });
  assert.equal(quote.netProfitLowerBound, 3n); assert.equal(quote.meetsThreshold, false);
  assert.equal(quote.kind, "estimated_spread");
});
test("unknown economics do not silently become zero cost or guaranteed profit", () => {
  for (const missing of [{ fees: null }, { gasBudget: null }, { entry: { ...leg, depthKnown: false } }, { entry: { ...leg, executionPriceKnown: false } }]) {
    const quote = previewArbitrage({ entry: leg, exit: { ...leg, amount: 106n }, fees: 2n, gasBudget: 1n, minProfit: 0n, ...missing });
    assert.equal(quote.netProfitLowerBound, null); assert.equal(quote.meetsThreshold, false);
  }
});
test("matched quantities and numeraire are required; atomic classification is adapter evidence", () => {
  const input = { entry: leg, exit: { ...leg, amount: 106n }, fees: 2n, gasBudget: 1n, minProfit: 0n };
  assert.throws(() => previewArbitrage({ ...input, exit: { ...leg, units: 220n } }), /same positive DCN/);
  assert.throws(() => previewArbitrage({ ...input, exit: { ...leg, token: "0xb" } }), /numeraire/);
  assert.equal(previewArbitrage({ ...input, atomicVerification: { programHash: "0x1", simulated: false, onchainProfitFloor: null } }).kind, "estimated_spread");
  assert.equal(previewArbitrage({ ...input, atomicVerification: { programHash: "0x1", simulated: true, onchainProfitFloor: 1n } }).guaranteedProfit, false);
});
test("different settlement claims and self trades cannot masquerade as arbitrage", () => {
  assert.throws(() => previewArbitrage({ entry: leg, exit: { ...leg, marketId: "0x2" }, fees: 0n, gasBudget: 0n, minProfit: 0n }), /market/);
  assert.throws(() => previewArbitrage({ entry: leg, exit: { ...leg, ownOrder: true }, fees: 0n, gasBudget: 0n, minProfit: 0n }), /own order/);
});
test("fee inclusive adapters must explicitly normalize rather than deduct twice", () => {
  assert.throws(() => previewArbitrage({ entry: { ...leg, feesIncluded: true }, exit: leg, fees: 2n, gasBudget: 1n, minProfit: 0n }), /normalize/);
});
test('simulation without an onchain profit constraint remains an estimate', () => {
  const input = {entry:leg,exit:{...leg,amount:106n},fees:2n,gasBudget:1n,minProfit:0n};
  assert.equal(previewArbitrage({...input,atomicVerification:{programHash:'0x1',simulated:true,onchainProfitFloor:null}}).kind,'estimated_spread');
});
