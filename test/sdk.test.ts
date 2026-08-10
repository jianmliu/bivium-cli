import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAmount, parseAmount, floorFromStrike, strikeFromFloor, debtForCollateral, collateralForDebt } from "../src/sdk/math.ts";
import { buildSignedOfferFile, offerCommitment, parseSignedOfferFile } from "../src/sdk/offer.ts";
import { priceFromSimpleAprBps, priceToTick, simpleAprBpsFromPrice, tickToPrice, MAX_TICK, TICK_SPACING } from "../src/sdk/tick.ts";
import { WAD } from "../src/sdk/types.ts";
import { SESSION_OFFER } from "./golden.test.ts";

test("parseAmount is exact and rejects over-precision", () => {
  assert.equal(parseAmount("600", 6), 600000000n);
  assert.equal(parseAmount("0.01", 8), 1000000n);
  assert.equal(parseAmount("596.425814", 6), 596425814n);
  assert.throws(() => parseAmount("0.0000001", 6));
  assert.throws(() => parseAmount("1e5", 6));
  assert.throws(() => parseAmount("-1", 6));
});

test("formatAmount round-trips without floats", () => {
  assert.equal(formatAmount(596425814n, 6), "596.425814");
  assert.equal(formatAmount(1000000n, 8), "0.01");
  assert.equal(formatAmount(0n, 18), "0");
  // an 18-decimal amount beyond Number.MAX_SAFE_INTEGER stays exact
  assert.equal(parseAmount(formatAmount(123456789012345678901234567n, 18), 18), 123456789012345678901234567n);
});

test("floorFromStrike inverts strikeFromFloor", () => {
  assert.equal(floorFromStrike(strikeFromFloor("60000", 6, 8), 6, 8), "60000");
  assert.equal(floorFromStrike(strikeFromFloor("3000", 6, 18), 6, 18), "3000");
});

test("debt/collateral conversions honour core rounding direction", () => {
  const strike = strikeFromFloor("60000", 6, 8);
  // ceil on collateral: one extra face unit forces one more collateral atom
  assert.equal(collateralForDebt(600000001n, strike), 1000001n);
  // floor on debt supported by collateral
  assert.equal(debtForCollateral(1000000n, strike), 600000000n);
});

test("tick grid is monotonic and pinned at par", () => {
  let previous = 0n;
  for (let t = 0n; t <= MAX_TICK; t += 388n * TICK_SPACING) {
    const price = tickToPrice(t);
    assert.ok(price >= previous);
    previous = price;
  }
  assert.equal(tickToPrice(MAX_TICK), WAD);
});

test("priceToTick honours its rounding contract against the exact forward map", () => {
  const price = tickToPrice(3936n);
  assert.equal(priceToTick(price, false), 3936n); // exact grid price: both directions land on it
  assert.equal(priceToTick(price, true), 3936n);
  const between = price + 1n; // just above a grid price
  assert.ok(tickToPrice(priceToTick(between, false)) <= between);
  assert.ok(tickToPrice(priceToTick(between, true)) >= between);
});

test("apr <-> price round-trip is consistent", () => {
  const term = 22n * 24n * 3600n;
  const price = priceFromSimpleAprBps(1000n, term); // 10%
  const apr = simpleAprBpsFromPrice(price, term);
  assert.ok(apr >= 999n && apr <= 1000n);
});

test("signed offer file round-trips and rejects tampering", () => {
  const profile = { chainId: 11155111, core: "0x344BA9909d952D0d404f37Cc9C93c40A35F35c07" as const, abiProfile: "core-v1" as const };
  const commitment = offerCommitment(SESSION_OFFER);
  const signature = `0x${"11".repeat(65)}` as const;
  const file = buildSignedOfferFile(profile, SESSION_OFFER, commitment, signature);
  const parsed = parseSignedOfferFile(JSON.stringify(file), profile);
  assert.equal(offerCommitment(parsed.offer), commitment);
  assert.equal(parsed.signature, signature);

  // tampered tick → embedded commitment no longer matches recomputed one
  const tampered = JSON.parse(JSON.stringify(file));
  tampered.offer.tick = "4000";
  assert.throws(() => parseSignedOfferFile(JSON.stringify(tampered), profile), /commitment mismatch/);

  // wrong chain / core rejected
  assert.throws(() => parseSignedOfferFile(JSON.stringify(file), { ...profile, chainId: 1 }), /chain/);
  assert.throws(
    () => parseSignedOfferFile(JSON.stringify(file), { ...profile, core: "0x0000000000000000000000000000000000000001" }),
    /different core/,
  );
});

test("verifyTouchedMarket accepts chain-verified ids and rejects lineage mismatches", async () => {
  const { verifyTouchedMarket } = await import("../src/sdk/discovery.ts");
  const domain = { chainId: 11155111, core: "0x344BA9909d952D0d404f37Cc9C93c40A35F35c07" as const };
  const params = {
    loanToken: "0x1DbF8Dee40739cd2b17C12EC63A67499F9796278" as const,
    collateralToken: "0x822c57AEf2766ddd9aA570B53bF2917f0cF07761" as const,
    maturity: 1788828951n,
    strike: 600000000000000000000000000000000000000n,
    allowPartialRepay: false,
    gate: "0x0000000000000000000000000000000000000000" as const,
  };
  const id = "0x1d707a4684f4882a3b0c41c31086e1b3c92b31415bf8f492b310aed876f5bfed" as const;
  verifyTouchedMarket("core-v1", domain, id, params); // chain-verified WBTC market
  assert.throws(() => verifyTouchedMarket("core-v2", domain, id, params), /lineage mismatch/);
});
