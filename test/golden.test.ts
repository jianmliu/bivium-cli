// Golden vectors — every value here was returned by the live Sepolia core
// 0x344BA9909d952D0d404f37Cc9C93c40A35F35c07 (or its SignatureRatifier) during the
// 2026-08-09 WBTC market lifecycle run. If one of these fails, the SDK no longer
// matches the chain — do not "fix" the expectation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMarketId } from "../src/sdk/market.ts";
import { collateralForDebt, principalForUnits, strikeFromFloor } from "../src/sdk/math.ts";
import { offerCommitment } from "../src/sdk/offer.ts";
import { ratifyDigest, RATIFIED } from "../src/sdk/ratify.ts";
import { tickToPrice } from "../src/sdk/tick.ts";
import { WAD, ZERO_ADDRESS, type Offer } from "../src/sdk/types.ts";

const USDC = "0x1DbF8Dee40739cd2b17C12EC63A67499F9796278" as const;
const WETH = "0x8E87161d2827613FE129daF8FA330460F95d629C" as const;
const WBTC = "0x822c57AEf2766ddd9aA570B53bF2917f0cF07761" as const;
const RATIFIER = "0x0cE9bA63a31f3252aF9918E0Fe7DF0c4745f3323" as const;
const MAKER = "0x9931eA03B88c9D0458b3E1900f881205FAA0C54d" as const;
const MATURITY = 1788828951n;

export const SESSION_OFFER: Offer = {
  loanToken: USDC,
  collateralToken: WBTC,
  maturity: MATURITY,
  strike: 600000000000000000000000000000000000000n,
  allowPartialRepay: false,
  gate: ZERO_ADDRESS,
  maker: MAKER,
  buy: true,
  tick: 3936n,
  maxUnits: 600000000n,
  maxAssets: 0n,
  start: 1786285680n,
  expiry: 1786890780n,
  group: "0x9035859c15eccda3e379afc4a36f93bc572675f4b25c8bcdd00187cb16bb11ba",
  ratifier: RATIFIER,
};

test("tickToPrice matches core TickLib (chain: tickToPrice(3936))", () => {
  assert.equal(tickToPrice(3936n), 994043024418464930n);
  assert.equal(tickToPrice(5820n), WAD); // MAX_TICK pinned to par
});

test("market id: WETH/USDC manager market (chain: computeId)", () => {
  assert.equal(
    computeMarketId({
      loanToken: USDC,
      collateralToken: WETH,
      maturity: MATURITY,
      strike: 3000000000000000000000000000n,
      allowPartialRepay: false,
      gate: "0x211E41242A50352189141f0E50Ae279b24A710A7",
    }),
    "0x8f8e4feebd86c46c13689baa77a3ad37a7d4494112870bcfc4fdc83fc335cd2c",
  );
});

test("market id: WBTC/USDC pure-CLOB market (chain: computeId)", () => {
  assert.equal(
    computeMarketId({
      loanToken: USDC,
      collateralToken: WBTC,
      maturity: MATURITY,
      strike: 600000000000000000000000000000000000000n,
      allowPartialRepay: false,
      gate: ZERO_ADDRESS,
    }),
    "0x1d707a4684f4882a3b0c41c31086e1b3c92b31415bf8f492b310aed876f5bfed",
  );
});

test("offer commitment (chain: consumed keyed on this, RATIFIED returned for it)", () => {
  assert.equal(offerCommitment(SESSION_OFFER), "0xcc0e619ef520f67269465acebc0a72f663e4b4ed22bf2bf6dad4cf2375755eb1");
});

test("ratify digest (chain: signature over this digest returned RATIFIED)", () => {
  assert.equal(
    ratifyDigest(11155111, RATIFIER, "0xcc0e619ef520f67269465acebc0a72f663e4b4ed22bf2bf6dad4cf2375755eb1"),
    "0xa7652332d439768df64430babae437614b5e82d4ac76ca40e1baf9f483acd8c8",
  );
});

test("RATIFIED magic value (chain: isRatified return)", () => {
  assert.ok(RATIFIED.startsWith("0x914629ce"));
});

test("principal rounding (chain: borrower received exactly 596.425814 USDC)", () => {
  assert.equal(principalForUnits(600000000n, tickToPrice(3936n)), 596425814n);
});

test("collateral rounding (chain: exactly 0.01 WBTC locked)", () => {
  assert.equal(collateralForDebt(600000000n, SESSION_OFFER.strike), 1000000n);
});

test("strike derivation is exact integer math", () => {
  assert.equal(strikeFromFloor("60000", 6, 8), 600000000000000000000000000000000000000n); // WBTC floor $60k
  assert.equal(strikeFromFloor("3000", 6, 18), 3000000000000000000000000000n); // WETH floor $3k
});
