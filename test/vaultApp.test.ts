// Whole-lot vault app — offline vectors. Face/strike math mirrors BiviumVaultApp._openGroup /
// _escrowFill (units = Σsats·strike/1e36, collateral must round-trip to Σsats); lot-state resolution
// mirrors the frontend's portfolio semantics (lib/wholeLotPositions.ts) so CLI and app agree on
// "what to do next" at every stage.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProfile } from "../src/sdk/profile.ts";
import {
  CAP_FILL,
  LotStatus,
  assertWholeLotStrike,
  grantCoversFill,
  lotIsBound,
  lotStatusName,
  lotView,
  minSatsAt,
  redemptionRow,
  validateRedemptionPost,
  wholeLotFace,
  type VaultLot,
} from "../src/sdk/vaultApp.ts";
import { STRIKE_SCALE, type Address, type Hex } from "../src/sdk/types.ts";

const A = (n: string) => `0x${n.padStart(40, "0")}` as Address;
const H = (n: string) => `0x${n.padStart(64, "0")}` as Hex;
const STRIKE = 600000000000000000000000000000000000000n; // $60,000 floor: 8-dec vaultBTC, 6-dec USDC (dust-free)
const ORIGIN = A("a11ce");

const lot = (status: number, loanId: Hex, amount = 400000n, converted = false): VaultLot => ({
  vaultId: H("1"),
  origin: ORIGIN,
  amount,
  status,
  loanId,
  borrower: lotIsBound({ loanId }) ? ORIGIN : A("0"),
  maturity: lotIsBound({ loanId }) ? 1800000000n : 0n,
  converted,
  keeperVersion: 0n,
});

test("wholeLotFace: 400000 sats at the $60k dust-free strike = 240 USDC face, no dust", () => {
  assert.equal(wholeLotFace(400000n, STRIKE), 240_000000n);
  assert.equal(wholeLotFace(0n, STRIKE), 0n);
  assert.equal((wholeLotFace(400000n, STRIKE) * STRIKE_SCALE) / STRIKE, 400000n);
  assert.throws(() => wholeLotFace(1n, 0n), /positive/);
});

test("assertWholeLotStrike refuses off-grid strikes and sub-grid vaults before gas is spent", () => {
  assert.equal(assertWholeLotStrike(400000n, STRIKE), 240_000000n);
  assert.equal(assertWholeLotStrike(1n, STRIKE), 600n); // one sat is still exact on this grid
  // an off-grid strike: face floors, ceil-inverse no longer reproduces the group
  assert.throws(() => assertWholeLotStrike(3n, STRIKE_SCALE / 2n), /off-grid/);
  // sub-grid vault: units floor to zero
  assert.throws(() => assertWholeLotStrike(1n, STRIKE_SCALE / 2n), /zero/);
});

test("grantCoversFill matrix: CAP_FILL bit + unexpired (0 = forever)", () => {
  assert.equal(CAP_FILL, 4n);
  assert.equal(grantCoversFill(CAP_FILL, 0n, 100n), true);
  assert.equal(grantCoversFill(CAP_FILL | 1n, 200n, 100n), true); // extra bits are fine
  assert.equal(grantCoversFill(CAP_FILL, 100n, 100n), true); // expiry inclusive
  assert.equal(grantCoversFill(CAP_FILL, 99n, 100n), false); // expired
  assert.equal(grantCoversFill(1n, 0n, 100n), false); // wrong capability
  assert.equal(grantCoversFill(0n, 0n, 100n), false);
});

test("lotStatusName + lotIsBound", () => {
  assert.equal(lotStatusName(LotStatus.None), "None");
  assert.equal(lotStatusName(LotStatus.Reserved), "Reserved");
  assert.equal(lotStatusName(LotStatus.Delivered), "Delivered");
  assert.equal(lotStatusName(LotStatus.Consumed), "Consumed");
  assert.equal(lotStatusName(7), "Unknown(7)");
  assert.equal(lotIsBound({ loanId: H("0") }), false);
  assert.equal(lotIsBound({ loanId: H("beef") }), true);
});

test("lot lifecycle resolves to the exact next action at each stage", () => {
  // wrapped, never borrowed → borrow / convert / reclaim (primary reclaim, door open)
  const idle = lotView(lot(LotStatus.Reserved, H("0")), 0n, 0n, 400000n);
  assert.equal(idle.action, "reclaim");
  assert.equal(idle.convert, true);
  assert.equal(idle.secondary, undefined);
  // borrowed, live debt → repay on the core first
  const live = lotView(lot(LotStatus.Reserved, H("beef")), 240_000000n, 0n, 400000n);
  assert.equal(live.action, "repay-first");
  assert.equal(live.secondary, undefined);
  assert.equal(live.convert, undefined);
  // repaid but collateral still escrowed in the core → withdraw first
  const escrowed = lotView(lot(LotStatus.Reserved, H("beef")), 0n, 0n, 400000n);
  assert.equal(escrowed.action, "withdraw-first");
  assert.equal(escrowed.secondary, undefined);
  // repaid + wallet holds the group's sats → the fork: reclaim (primary) or release to re-borrow
  const repaid = lotView(lot(LotStatus.Reserved, H("beef")), 0n, 400000n, 400000n);
  assert.equal(repaid.action, "reclaim");
  assert.equal(repaid.secondary, "release");
  assert.equal(repaid.convert, undefined); // still bound — the door only opens once released
  // multi-vault group: the wallet must cover the WHOLE group, not just this lot
  assert.equal(lotView(lot(LotStatus.Reserved, H("beef")), 0n, 400000n, 900000n).action, "withdraw-first");
  // delivered by default, unsettled → origin may unconvert; copy says defaulted
  const defaulted = lotView(lot(LotStatus.Delivered, H("beef")), 0n, 0n, 400000n);
  assert.equal(defaulted.action, "unconvert");
  assert.match(defaulted.state, /defaulted/);
  assert.equal(defaulted.convert, undefined);
  // delivered via the origin's own convert → same road, converted copy
  const converted = lotView(lot(LotStatus.Delivered, H("0"), 400000n, true), 0n, 0n, 400000n);
  assert.equal(converted.action, "unconvert");
  assert.match(converted.state, /converted/);
  // a non-origin viewer (keeper) of a delivered lot sees the settle road
  const keeperSide = lotView(lot(LotStatus.Delivered, H("beef")), 0n, 0n, 400000n, A("beef"));
  assert.equal(keeperSide.action, "awaiting-settle");
  assert.equal(lotView(lot(LotStatus.Delivered, H("beef")), 0n, 0n, 400000n, ORIGIN).action, "unconvert");
  // consumed / unknown → nothing to do
  assert.equal(lotView(lot(LotStatus.Consumed, H("0")), 0n, 0n, 0n).action, "none");
  assert.equal(lotView(lot(LotStatus.None, H("0"), 0n), 0n, 0n, 0n).action, "none");
});

test("redemption rows mark ownership and cancelability (mine + open + past deadline only)", () => {
  const base = { owner: A("me"), amount: 400000n, minSatsStart: 400000n, minSatsEnd: 390000n, postedAt: 0n, deadline: 100n, closed: false, btcDest: "0xab" as Hex };
  assert.equal(redemptionRow(0n, base, 1n, A("me"), 101n).cancelable, true);
  assert.equal(redemptionRow(0n, base, 1n, A("me"), 100n).cancelable, false); // at the deadline: still binding
  assert.equal(redemptionRow(0n, base, 1n, A("me"), 99n).cancelable, false);
  assert.equal(redemptionRow(0n, { ...base, closed: true }, 1n, A("me"), 101n).cancelable, false);
  assert.equal(redemptionRow(0n, base, 1n, A("other"), 101n).cancelable, false);
  assert.equal(redemptionRow(0n, base, 1n, undefined, 101n).mine, false);
  assert.equal(redemptionRow(3n, base, 395000n, A("ME"), 50n).mine, true); // case-insensitive owner match
  assert.equal(redemptionRow(3n, base, 395000n, A("me"), 50n).minSatsNow, 395000n);
});

test("minSatsAt mirrors the app's linear decay (floored, constant outside the window)", () => {
  const order = { minSatsStart: 400000n, minSatsEnd: 390000n, postedAt: 100n, deadline: 200n };
  assert.equal(minSatsAt(order, 50n), 400000n);
  assert.equal(minSatsAt(order, 100n), 400000n);
  assert.equal(minSatsAt(order, 150n), 395000n);
  assert.equal(minSatsAt(order, 133n), 396700n); // 400000 - floor(10000·33/100)
  assert.equal(minSatsAt(order, 200n), 390000n);
  assert.equal(minSatsAt(order, 999n), 390000n);
});

test("post-redemption validation mirrors BadOrder", () => {
  const good = { amount: 400000n, minSatsStart: 400000n, minSatsEnd: 390000n, btcDest: "0xab", deadline: 200n, nowSec: 100n };
  assert.equal(validateRedemptionPost(good), undefined);
  assert.match(validateRedemptionPost({ ...good, amount: 0n })!, /amount/);
  assert.match(validateRedemptionPost({ ...good, minSatsEnd: 0n })!, /min-sats-end/);
  assert.match(validateRedemptionPost({ ...good, minSatsEnd: 400001n })!, /min-sats-end/);
  assert.match(validateRedemptionPost({ ...good, minSatsStart: 400001n })!, /min-sats-start/);
  assert.match(validateRedemptionPost({ ...good, btcDest: "bc1q..." })!, /hex/);
  assert.match(validateRedemptionPost({ ...good, btcDest: "0x" })!, /hex/);
  assert.match(validateRedemptionPost({ ...good, deadline: 100n })!, /deadline/);
});

const PROFILE_BASE = {
  name: "t",
  abiProfile: "core-v2",
  chainId: 11155111,
  core: "0x3d60833577De4C4D1c73F4E5bF87Dd4Ced7a0C99",
  signatureRatifier: "0x08C0aAd2F31F09377898Fdf3C5E5a21C3d6a87E8",
  rpcUrl: "https://example.invalid",
};
const VAULT_APP = {
  registry: "0x206A05a6483E14b55ad9Dbc2d8373AaD14E3f88F",
  app: "0x5c4807d8F5E6698ed85bff6FD0bF1AAC21388995",
  vaultBtc: "0x7BC8275C343ed3E722BD0b6E6805170b3eae82FA",
  escrow: "0x1eE9cD101E172B3b924747bb8d630c481f99284D",
  tbvbtc: "0xE617081e9A8DCbec4F2Ce946591a286F4b078163",
  appBlock: 11499525,
};

function writeProfile(json: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bivium-vault-profile-"));
  const path = join(dir, "p.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

test("profile: vaultApp section round-trips (checksummed addresses, integer appBlock)", () => {
  const p = loadProfile(writeProfile({ ...PROFILE_BASE, vaultApp: { ...VAULT_APP, app: VAULT_APP.app.toLowerCase() } }));
  assert.deepEqual(p.vaultApp, VAULT_APP);
  assert.equal(loadProfile(writeProfile(PROFILE_BASE)).vaultApp, undefined);
  assert.throws(() => loadProfile(writeProfile({ ...PROFILE_BASE, vaultApp: { ...VAULT_APP, appBlock: -1 } })), /appBlock/);
  assert.throws(() => loadProfile(writeProfile({ ...PROFILE_BASE, vaultApp: { ...VAULT_APP, appBlock: "11499525" } })), /appBlock/);
  assert.throws(() => loadProfile(writeProfile({ ...PROFILE_BASE, vaultApp: { ...VAULT_APP, escrow: undefined } })), /vaultApp\.escrow/);
  assert.throws(() => loadProfile(writeProfile({ ...PROFILE_BASE, vaultApp: "nope" })), /vaultApp must be an object/);
});

test("profile: the legacy tbv key is rejected with a pointer to vaultApp", () => {
  assert.throws(
    () => loadProfile(writeProfile({ ...PROFILE_BASE, tbv: { factory: VAULT_APP.app } })),
    /profile\.tbv is the retired core-tbv canary; use profile\.vaultApp/,
  );
});

test("profile: the shipped Sepolia profile carries the TBVBTC family", () => {
  const p = loadProfile(new URL("../profiles/sepolia-routerv3-v2.json", import.meta.url).pathname);
  assert.deepEqual(p.vaultApp, VAULT_APP);
  assert.equal(p.tokens?.vaultBTC?.address, VAULT_APP.vaultBtc);
  assert.equal(p.tokens?.TBVBTC?.address, VAULT_APP.tbvbtc);
  assert.equal(p.tokens?.vaultBTC?.decimals, 8);
});

test("profile: the fee-bearing routers load and are rejected when they are not addresses", () => {
  // On a gated series these are not an optimisation. A market naming an OriginationGate admits a borrower's own
  // origination ONLY through a listed fee-bearing router, so a profile without one cannot place the borrow at all.
  const routers = { strategyRouter: "0x2f6036fFA0F1c3fc592d2948e9fB7f67eaaf96bB", shortRouter: "0xF7F8f64F8832D104743C30b727158e408Fd02BA8" };
  const p = loadProfile(writeProfile({ ...PROFILE_BASE, ...routers }));
  assert.equal(p.strategyRouter, routers.strategyRouter);
  assert.equal(p.shortRouter, routers.shortRouter);
  assert.equal(loadProfile(writeProfile(PROFILE_BASE)).shortRouter, undefined);
  assert.throws(() => loadProfile(writeProfile({ ...PROFILE_BASE, shortRouter: "0xnope" })), /shortRouter must be an address/);
});

test("the shipped Robinhood profile names the routers the w0918 fee gate admits", () => {
  const p = loadProfile("profiles/robinhood-testnet.json");
  assert.equal(p.strategyRouter, "0x2f6036fFA0F1c3fc592d2948e9fB7f67eaaf96bB");
  assert.equal(p.shortRouter, "0xF7F8f64F8832D104743C30b727158e408Fd02BA8");
});

test("a gated market's router comes from its gate, because a deployment can run more than one generation", () => {
  // The profile names one router. On this chain two gate generations are live at once — the fee rule changed by
  // opening a new series, not by changing a setting — so the profile's router is the default for a gate-free
  // market and the gate's own list is the answer for a gated one. A program built against the wrong generation is
  // refused on-chain by OriginationMustRouteThroughFeeRouter, which is a revert, not a worse price.
  const p = loadProfile("profiles/robinhood-testnet.json");
  assert.equal(p.strategyRouter, "0x2f6036fFA0F1c3fc592d2948e9fB7f67eaaf96bB");
  assert.equal(p.shortRouter, "0xF7F8f64F8832D104743C30b727158e408Fd02BA8");
});
