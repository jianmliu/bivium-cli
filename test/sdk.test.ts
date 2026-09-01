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

test("moneyness guardrail: S >= R, one rule for every market shape", async () => {
  const { assessMoneyness, pairFor, tickerFor } = await import("../src/sdk/spot.ts");
  // `floorFromStrike` output is always loan-per-collateral — the strike ratio S — and the pair feed answers R
  // in the same unit, so no market shape needs a reciprocal or a dollar anywhere.
  // Volatile collateral: $3000 strike vs $1912 ETH — deep ITM, and the ratio IS the LTV (157%).
  const itm = assessMoneyness("3000", 1912.435);
  assert.ok(itm && itm.itm && itm.ratio > 1.5);
  // Volatile loan (a meme drawn against dollars): S = 5 memes per dollar vs R = 7.43 — 67% LTV, OTM.
  const meme = assessMoneyness("5", 7.43);
  assert.ok(meme && !meme.itm && Math.abs(meme.ratio - 0.673) < 0.01);
  // Both legs volatile (the ratio market): S = 1000 mAI per mNVDA vs R = 1263 — 79% LTV, OTM;
  // and the pre-calibration 8000 strike is ITM at 633%, exactly what gated it live.
  const pairOtm = assessMoneyness("1000", 1263);
  assert.ok(pairOtm && !pairOtm.itm);
  const pairItm = assessMoneyness("8000", 1263);
  assert.ok(pairItm && pairItm.itm && Math.abs(pairItm.ratio - 6.334) < 0.01);
  assert.equal(assessMoneyness("0", 100), null);
  // Tickers follow the deployment feed's convention: WETH quotes as ETH, everything else as itself.
  assert.equal(tickerFor("WETH"), "ETH");
  assert.equal(tickerFor("vaultBTC"), "BTC");
  assert.equal(tickerFor("mAI"), "MAI");
  assert.equal(tickerFor(undefined), null);
  assert.equal(pairFor("mNVDA", "mAI"), "MNVDA-MAI");
  assert.equal(pairFor("bUSD", "WETH"), "BUSD-ETH");
  assert.equal(pairFor(undefined, "mAI"), null);
});
