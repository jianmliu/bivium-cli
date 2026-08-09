// TBV golden vectors — offline. The typehash is the frozen constant from
// TBVCollateralManager.sol; the digest and positionId values were cross-checked on 2026-08-09
// against the live anvil deployment in profiles/anvil-tbv-local.json (manager
// 0xa513E6E4b8f2a923D98304ec87F64353C4D5C853: borrowAuthorizationDigest / positionId eth_calls,
// and a successful signed `tbv borrow`). If one of these fails, the SDK no longer matches the
// chain — do not "fix" the expectation.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  borrowAuthorizationDigest,
  tbvPositionId,
  tbvQuote,
  BORROW_AUTHORIZATION_TYPE,
  BORROW_AUTHORIZATION_TYPEHASH,
  type BorrowAuthorization,
} from "../src/sdk/tbv.ts";

const MANAGER = "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853" as const;
const CORE = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const VAULT_TOKEN = "0x3B02fF1e626Ed7a8fd6eC5299e2C54e1421B626B" as const;

test("BORROW_AUTHORIZATION_TYPEHASH matches the manager's frozen constant", () => {
  // Recomputed from the struct definition string; the contract pins the same value.
  assert.equal(
    BORROW_AUTHORIZATION_TYPEHASH,
    "0x6f35331f5a3a01fe3ed68b1169936085c630eee7fb0e4d875643494c1ed74084",
  );
  // The type string itself is part of the wire format — field order and names are load-bearing.
  assert.match(BORROW_AUTHORIZATION_TYPE, /^BorrowAuthorization\(uint256 chainId,address manager,/);
  assert.match(BORROW_AUTHORIZATION_TYPE, /uint256 deadline,uint256 intentNonce\)$/);
});

const AUTH: BorrowAuthorization = {
  chainId: 31337n,
  manager: MANAGER,
  bivium: CORE,
  token: VAULT_TOKEN,
  tokenId: 1n,
  amount: 100n,
  receiptAmount: 100n,
  positionAccount: "0x1111111111111111111111111111111111111111",
  marketId: "0x59366fa24a1cc01c36c9f58b7eeb0091de911bb01b54e3a029c279a474f035da",
  fundingNonce: 0n,
  face: 100000000n,
  offerCommitment: "0xaceee6a3343d2886fa6b7a7c7412086e2b31b4e6d851f99b6a9159399d414092",
  borrower: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  deadline: 1788881476n,
  intentNonce: 42n,
};

test("BorrowAuthorization digest (chain: manager.borrowAuthorizationDigest on anvil)", () => {
  assert.equal(
    borrowAuthorizationDigest(AUTH),
    "0xbc0aebfd8e3e04e6b98afabfef696a6090565650fb25519e1c49658fbb2caab1",
  );
});

test("digest binds every field — flipping any one changes it", () => {
  const base = borrowAuthorizationDigest(AUTH);
  for (const key of Object.keys(AUTH) as (keyof BorrowAuthorization)[]) {
    const changed = { ...AUTH };
    const value = changed[key];
    if (typeof value === "bigint") (changed[key] as bigint) = value + 1n;
    else if (key === "marketId" || key === "offerCommitment") {
      (changed[key] as string) = "0x" + "ab".repeat(32);
    } else (changed[key] as string) = "0x2222222222222222222222222222222222222222";
    assert.notEqual(borrowAuthorizationDigest(changed), base, `field ${key} not bound`);
  }
});

test("positionId (chain: manager.positionId for vault 1 at nonces 0 and 1)", () => {
  assert.equal(tbvPositionId(VAULT_TOKEN, 1n, 0n), "0x4600d3ac5c1d065f3ad8c7c2f2dc9f39fdfafe46d763e31a4ac7b96e7ca80e71");
  assert.equal(tbvPositionId(VAULT_TOKEN, 1n, 1n), "0xbcc6a722ac129d6e959e34c5ca23b059b1c1672ed124834a40d4c6d96f55340b");
});

test("tbvQuote whole-lot math mirrors TBVMath.quote", () => {
  // The anvil market: strike 1e42 == 1.000000 USDC face per whole vault unit (chain: Funded event
  // for vault 1 reported receiptAmount 100 / maximumFace 100000000).
  const strike = 10n ** 42n;
  assert.deepEqual(tbvQuote(100n, 1n, strike), { receiptAmount: 100n, maximumFace: 100000000n });
  assert.deepEqual(tbvQuote(25n, 1n, strike), { receiptAmount: 25n, maximumFace: 25000000n });
  // unitScale > 1 requires exact normalization
  assert.deepEqual(tbvQuote(100n, 10n, strike), { receiptAmount: 10n, maximumFace: 10000000n });
  assert.throws(() => tbvQuote(101n, 10n, strike), /whole multiple/);
  // a strike whose floor(face) cannot ceil-invert back to the receipt amount fails closed
  assert.throws(() => tbvQuote(3n, 1n, 10n ** 36n / 2n), /whole-lot mismatch/);
  // zero face fails closed
  assert.throws(() => tbvQuote(1n, 1n, 10n ** 36n / 2n), /zero/);
  assert.throws(() => tbvQuote(0n, 1n, strike), /positive/);
  assert.throws(() => tbvQuote(100n, 0n, strike), /positive/);
  assert.throws(() => tbvQuote(100n, 1n, 0n), /positive/);
});
