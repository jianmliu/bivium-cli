// core-v2 (domain-bound) golden vectors — returned by the LIVE Sepolia Router V3 core
// 0x3d60833577De4C4D1c73F4E5bF87Dd4Ced7a0C99 on 2026-08-09 via eth_call. If one of these
// fails, the SDK no longer matches the chain — do not "fix" the expectation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { adapterFor, computeMarketIdV2, offerCommitmentV2 } from "../src/sdk/lineage.ts";
import { computeMarketId } from "../src/sdk/market.ts";
import { ZERO_ADDRESS, type MarketParams, type Offer } from "../src/sdk/types.ts";

const V2_CORE = "0x3d60833577De4C4D1c73F4E5bF87Dd4Ced7a0C99" as const;
const DOMAIN = { chainId: 11155111, core: V2_CORE };

const CANARY: MarketParams = {
  loanToken: "0x0000000000000000000000000000000000000001",
  collateralToken: "0x0000000000000000000000000000000000000002",
  maturity: 1n,
  strike: 10n ** 36n,
  allowPartialRepay: false,
  gate: ZERO_ADDRESS,
};

test("v2 market id includes the chain/core domain (chain: computeId on 0x3d6083…)", () => {
  assert.equal(
    computeMarketIdV2(DOMAIN, CANARY),
    "0x4876c49a73517306ca6b3f97559883d69fd2fa927a18e3a80d51d4046b38ea6c",
  );
  // and it MUST differ from the v1 hash of the same economic fields
  assert.notEqual(computeMarketIdV2(DOMAIN, CANARY), computeMarketId(CANARY));
});

test("v2 offer commitment is domain-bound (chain: hashOffer on 0x3d6083…)", () => {
  const offer: Offer = {
    loanToken: "0x0000000000000000000000000000000000000001",
    collateralToken: "0x0000000000000000000000000000000000000002",
    maturity: 1788828951n,
    strike: 10n ** 36n,
    allowPartialRepay: false,
    gate: ZERO_ADDRESS,
    maker: "0x9931eA03B88c9D0458b3E1900f881205FAA0C54d",
    buy: true,
    tick: 3936n,
    maxUnits: 600000000n,
    maxAssets: 0n,
    start: 1786285680n,
    expiry: 1786890780n,
    group: "0x9035859c15eccda3e379afc4a36f93bc572675f4b25c8bcdd00187cb16bb11ba",
    ratifier: "0x08C0aAd2F31F09377898Fdf3C5E5a21C3d6a87E8",
  };
  assert.equal(
    offerCommitmentV2(DOMAIN, offer),
    "0x5b06cc0be19631776af21d9c54a224495e49e417acba9a5d2ad6bf47f06c13b7",
  );
});

test("adapters expose distinct lineages, unknown profile rejected", () => {
  assert.equal(adapterFor("core-v1").abiProfile, "core-v1");
  assert.equal(adapterFor("core-v2").abiProfile, "core-v2");
  assert.throws(() => adapterFor("core-v3" as never));
  // v2 ratifier precheck args carry the represented-taker slot
  assert.equal(adapterFor("core-v2").ratifierArgs("0x9931eA03B88c9D0458b3E1900f881205FAA0C54d", 1n, "0x00", "0x00").length, 5);
  assert.equal(adapterFor("core-v1").ratifierArgs("0x9931eA03B88c9D0458b3E1900f881205FAA0C54d", 1n, "0x00", "0x00").length, 4);
});
