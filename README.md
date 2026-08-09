# @bivium/cli

SDK + CLI for driving a Bivium market lifecycle from the command line — market identity, maker
funding and offer signing, borrower quote/fill, repay, reclaim, and claim. Distilled from the
2026-08-09 manual `cast` run against the Sepolia multi-loan candidate core; the test suite pins that
run's chain-verified values as golden vectors.

Design: [docs/spec/2026-08-09-bivium-cli-spec.md](docs/spec/2026-08-09-bivium-cli-spec.md)

## Install / test

```bash
npm install
npm test
```

## Quick start (Sepolia multi-loan candidate)

```bash
export BIVIUM_PROFILE=profiles/sepolia-multiloan-v1.json
export BIVIUM_PK=0x...            # signing key, via env only — never argv

# market identity (cross-checked against on-chain computeId)
npm run cli -- market id --loan USDC --collateral WBTC --maturity 1788828951 --floor 60000

# maker: register ratifier, fund, sign a resting bid at 10% APR
npm run cli -- maker set-ratifier
npm run cli -- maker fund --loan USDC --collateral WBTC --maturity 1788828951 --floor 60000 --assets 600
npm run cli -- maker make-offer --loan USDC --collateral WBTC --maturity 1788828951 --floor 60000 \
    --side buy --apr-bps 1000 --max-units 600 --out bid.json

# borrower: quote, execute, repay, reclaim
npm run cli -- borrow quote --offer bid.json
npm run cli -- borrow execute --offer bid.json --units 600
npm run cli -- repay --offer bid.json --assets 600
npm run cli -- reclaim --offer bid.json

# reads
npm run cli -- market state --offer bid.json
npm run cli -- read position --offer bid.json --account 0x...
```

## Safety model (enforced in the SDK)

- **Profile pinning, fail closed** — every run is scoped to a profile file pinning
  `{chainId, core, signatureRatifier, abiProfile}`; `verifyProfile()` cross-checks the core's
  `computeId` against the SDK's local hash before any write. A wrong-lineage core refuses to run.
- **Exact integer math only** — strikes, prices, amounts are BigInt end to end; core rounding
  (floor principal, ceil collateral) is mirrored and golden-tested.
- **Simulate-first writes, exact allowances, balance-delta postconditions.**
- **Ratification prechecked** — offers are only emitted/accepted when the on-chain ratifier returns
  the `RATIFIED` magic for the commitment.
- Keys come from an env var (`--key-env NAME`, default `BIVIUM_PK`); never argv, never logged.

## TBV (whole vault, ERC-1155)

The `tbv` command group drives a deployed TBV family (factory / vault token / collateral manager /
receipt / redemption) on the core-v2 lineage: escrow one complete canonical ERC-1155 vault, borrow
its exact whole-lot face against a keeper's resting bid, repay the face and get the vault back —
or release a defaulted vault to the keeper. Profiles carry the family in an optional `tbv` section
(`{factory, manager, receipt, vaultToken, keeper, redemption, redemptionAsset}`); TBV commands fail
cleanly without it, and `verifyTbv()` cross-checks the section against the manager's immutable
bindings plus the frozen `BORROW_AUTHORIZATION_TYPEHASH` before any write.

```bash
npm run cli -- tbv create-vault --token-id 1 --amount 100 --receiver 0x…   # key = redemption issuer
npm run cli -- tbv vault-status --token-id 1
npm run cli -- tbv fund --token-id 1 --gate 0x…        # market read + cross-checked from the gate
npm run cli -- tbv borrow --token-id 1 --offer bid.json  # signs the EIP-712 BorrowAuthorization
npm run cli -- tbv repay --token-id 1                    # exact face; vault returns to the owner
npm run cli -- tbv cancel-funding --token-id 1
npm run cli -- tbv redeem-delivered --position-id 0x…
```

Safety mirrors the base client: whole-lot math (`tbvQuote`) is an exact BigInt mirror of
`TBVMath.quote` including the ceil-inverse round trip; the `BorrowAuthorization` digest is
cross-checked against `manager.borrowAuthorizationDigest` before signing; borrow/repay enforce
balance-delta and vault-return postconditions.

### Anvil quickstart

```bash
anvil                                   # terminal 1: chain id 31337, default funded accounts
# terminal 2, in the bivium-core checkout (branch agent/tbv-sepolia-canary-rollout):
export ANVIL0_PK=0x…                    # anvil account 0 key, via env only
forge script script/DeployTBVLocal.s.sol:DeployTBVLocal \
    --rpc-url http://127.0.0.1:8545 --broadcast --private-key "$ANVIL0_PK"
# Fresh anvil + account-0 deployer reproduces the addresses pinned in
# profiles/anvil-tbv-local.json. Note the printed TBV_GATE / TBV_MATURITY / TBV_STRIKE.

cd bivium-cli && export BIVIUM_PROFILE=profiles/anvil-tbv-local.json
export BIVIUM_PK="$ANVIL0_PK"           # account 0 = deployer, redemption issuer, keeper (maker)
npm run cli -- mock mint --token USDC --to <maker> --amount 1000
npm run cli -- mock mint --token USDC --to <borrower> --amount 50
npm run cli -- maker set-ratifier
npm run cli -- maker fund --loan USDC --collateral TBVR \
    --maturity $MATURITY --strike $STRIKE --gate $GATE --assets 200
npm run cli -- maker make-offer --loan USDC --collateral TBVR \
    --maturity $MATURITY --strike $STRIKE --gate $GATE \
    --side buy --apr-bps 1000 --max-units 200 --out tbv-bid.json
npm run cli -- tbv create-vault --token-id 1 --amount 100 --receiver <borrower>

export BIVIUM_PK=<borrower key>         # anvil account 1: vault owner + borrower
npm run cli -- tbv fund   --token-id 1 --gate $GATE
npm run cli -- tbv borrow --token-id 1 --offer tbv-bid.json
npm run cli -- tbv repay  --token-id 1
npm run cli -- tbv vault-status --token-id 1     # → Repaid, complete vault back with the owner
```

## ABI lineages

Two lineages are supported behind one adapter boundary (`src/sdk/lineage.ts`):

- `core-v1` — 6-field MarketParams / 15-field Offer (Sepolia multi-loan candidate core `0x344BA9…`,
  profile `profiles/sepolia-multiloan-v1.json`)
- `core-v2` — domain-bound 8/17-field (Sepolia Router V3 core `0x3d6083…`, profile
  `profiles/sepolia-routerv3-v2.json`); market ids and offer commitments include `{chainId, core}`,
  pinned by live-chain golden vectors in `test/lineage.test.ts`
