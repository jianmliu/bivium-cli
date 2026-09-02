# @bivium/cli

SDK and CLI for Bivium fixed-term, oracle-free credit: discover markets, inspect the CLOB, assess
repay-or-deliver risk, construct bounded plans, sign offers, execute fills, repay, reclaim, claim,
and preserve strategy attribution.

The public agent release executes only on **Robinhood Chain testnet (`46630`)**. Robinhood Chain
mainnet (`4663`) is identity/reference-only until a separate mainnet release is approved. Sepolia
and local material in historical design documents is retained as non-executable development
history, not as public agent instructions.

## Install

Node.js 20 or newer is required.

```bash
git clone https://github.com/jianmliu/bivium-cli
cd bivium-cli
npm install
export BIVIUM_PROFILE=profiles/robinhood-testnet.json
```

Run locally with `npm run cli -- ...` or use `./bivium-run`, which selects the local or Docker
runtime. Never put a private key in command arguments or logs.

## Agent JSON interface

The stable agent-facing surface consists of three commands, all requiring `--json`:

```bash
# Product catalog and aliases
npm run cli --silent -- strategy catalog --json

# Policy-owned risk result plus delivery stress when the input includes values
npm run cli --silent -- strategy assess \
  --risk-file test/fixtures/meme-risk.json --json

# Start domain-separated strategy attribution (no signing key required)
npm run cli --silent -- strategy trace \
  --strategy-id lendQuote \
  --quote-id 0x1111111111111111111111111111111111111111111111111111111111111111 \
  --nonce 0 \
  --account 0x1111111111111111111111111111111111111111 \
  --json
```

`catalog` exposes the initial `lendAsset`, `lendQuote`, and `short` products and their aliases.
`assess` reports facts, warnings, unknowns, `MEME_DELIVERY_RISK` where applicable, stress outcomes,
and an `agent-policy` or `user-policy` decision. `trace` binds `strategyId` and `quoteId` to the
selected profile's chain and Core plus the user's account and nonce.

## Required execution sequence

```text
discover existing market
-> catalog and resolve a strategy
-> gather risk evidence
-> assess policy
-> show repay, delivery, and 50% / 90% / 100% stress outcomes
-> obtain user-policy acceptance when required
-> preview the bounded action
-> sign and execute
-> report order, fill, position, and realized attribution
```

The current authorization default is one user approval and signature **per transaction**. Scoped,
short-lived session capabilities are future work and are not implemented. An agent must not imply
that it has standing authority, request a raw private key, or silently continue a rollover.

## Domain separation

Every executable action is bound to the profile's chain ID and Core address, complete market
identity, strategy, account, amount, expiry, and destination. Profile verification checks the Core
ABI lineage and market hashing before writes. A chain/Core mismatch, changed quote, failed
simulation, exceeded authority, or changed capacity must stop the flow.

Bivium Core is immutable, non-upgradeable, permissionless, and has no administrator. It cannot
pause markets, maintain an asset allowlist, approve assets or strategies, or prevent rug pulls.
Risk assessment is advisory user/agent policy, not protocol permissioning.

For Meme collateral, a borrower may decline repayment and deliver a severely impaired or worthless
token. Correct settlement can still cost a lender all economically recoverable principal.

## Robinhood domains and optional tools

Robinhood Agentic Trading brokerage and Robinhood Chain are separate. Brokerage quotes and
positions may be clearly labeled reference evidence, but a Bivium flow must never place a
brokerage order or treat a brokerage security as an onchain token.

External Stock Token, price, wallet, swap, and analytics Skills are optional evidence or execution
inputs, not protocol truth. Record their source and freshness; provider failure becomes `unknown`,
not a successful risk check.

## Development

```bash
npm test
npm run typecheck
```

The distributable Skill is [skills/bivium/SKILL.md](skills/bivium/SKILL.md). The implementation
specification is [docs/spec/2026-08-09-bivium-cli-spec.md](docs/spec/2026-08-09-bivium-cli-spec.md);
historical chain examples there are non-executable unless the public Skill explicitly enables that
deployment.
