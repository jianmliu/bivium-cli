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

## ABI lineages

This build supports `core-v1` (6-field MarketParams / 15-field Offer — the Sepolia multi-loan
candidate). The domain-bound lineage on bivium-core `dev` (8/17-field) is reserved as `core-v2`;
profiles declaring it are rejected until implemented.
