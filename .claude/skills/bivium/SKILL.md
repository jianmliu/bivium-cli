---
name: bivium
description: >
  Use when a user wants to discover, assess, quote, or execute Bivium fixed-term credit and
  repay-or-deliver strategies on Robinhood Chain, including Earn on Holdings, Buy at Target,
  Capped-Risk Short, DCN trading, repayment, delivery, claims, or strategy attribution.
---

# Bivium on Robinhood Chain

Bivium is fixed-term, oracle-free credit with a CLOB and repay-or-deliver settlement. This Skill
turns a user's goal into an inspectable risk decision and a bounded Bivium action. The user owns
the capital, risk policy, and final signature.

## Execution boundary

The only executable public target is **Robinhood Chain testnet, chain ID `46630`**, using
`profiles/robinhood-testnet.json`. Robinhood Chain mainnet, chain ID `4663`, may be used only to
validate identity or label reference data. Do not construct, sign, submit, or suggest executable
mainnet transactions until a separate mainnet release is explicitly approved.

Sepolia and local deployments are historical development environments, not executable targets in
this public Skill. Historical repository documents may describe them; do not copy their commands
into a user flow.

## Fixed trust boundary

Bivium Core is an **immutable, non-upgradeable, permissionless** settlement layer with no
administrator. Core cannot pause markets, cannot maintain an asset or collateral allowlist, cannot
approve strategies or assets, and cannot prevent a rug pull. It enforces market identity,
authorization, accounting, order execution, and repay-or-deliver settlement only. Optional gates
and ratifiers affect only markets or offers that choose them; they are not Core administrators.

Risk checks are advice from the identified user or agent policy, never a Core safety verdict.
Registration, a valid signature, successful simulation, or correct settlement does not certify an
asset or strategy as safe.

## Required agent flow

Follow this order for every proposed action:

1. **Discover an existing market.** Set `BIVIUM_PROFILE=profiles/robinhood-testnet.json`, verify
   chain `46630` and the pinned Core, then run `market list --json`. Prefer an existing full market
   identity; a different token, strike, maturity, partial-repay flag, gate, chain, or Core is a
   separate market and fragments liquidity.
2. **Catalog and resolve the goal.** Run `strategy catalog --json`. Resolve the goal to an initial
   strategy (`lendAsset`, `lendQuote`, or `short`) and an existing market. Never describe a
   non-atomic multi-leg sequence as atomic.
3. **Gather evidence.** Record asset capabilities, transfer restrictions, holder concentration,
   executable depth and slippage, reference-source identity and freshness, and sellability. Mark
   missing or stale facts `unknown`; do not turn provider failure into a passing check.
4. **Assess policy.** Put evidence in a bounded JSON risk file and run
   `strategy assess --risk-file <risk.json> --json`. Its decision belongs to `agent-policy` or
   `user-policy`; it is not a protocol verdict.
5. **Show outcomes.** Before discussing yield, show principal, face amount, repayment deadline,
   repay asset, delivery asset, and the 50%, 90%, and 100% collateral-decline stress cases. State
   what the user receives if the borrower repays and if the borrower delivers.
6. **Obtain policy acceptance.** Stop on `reject`. On `require_user_confirmation`, obtain an
   explicit `user-policy` acceptance bound to the same market and evidence before building a plan.
7. **Preview.** Re-read market, book, balances, capacity, expiry, and quote. Show chain, Core,
   market, strategy, account, amount, maximum loss, slippage/price bound, expiry, destination, and
   each transaction. Use `borrow quote` or `--dry-run` where supported.
8. **Sign and execute.** The current release requires the user to approve and sign **each
   transaction**. Short-lived scoped sessions are future work and are not implemented. Never ask
   for, print, or pass a raw private key on the command line. Stop on any domain, lineage,
   simulation, quote, authorization, or state mismatch; never retry a financial transaction
   blindly.
9. **Report attribution.** Preserve and report
   `strategyId -> intentId -> orderId -> fillId -> position and realized outcome`. Use
   `strategy trace` to bind the start of that chain to chain, Core, account, quote, and nonce.

## Meme lender disclosure

For Meme collateral, always emit `MEME_DELIVERY_RISK` prominently before funding or signing. Tell
the lender all three facts: the borrower may rationally choose not to repay; delivery may be a
severely impaired or worthless token; and settlement can operate correctly while the lender loses
all economically recoverable principal. No-liquidation is a settlement rule, not rug prevention.

## Optional external inputs

External Stock Token discovery, price, wallet, swap, and analytics Skills are optional evidence or
execution inputs. They are never protocol truth. Record their source and freshness, distinguish
observations from conclusions, and keep the Bivium assessment usable when an optional provider is
unavailable. Onchain market identity and settlement state come from the selected profile and Core.

Robinhood Agentic Trading brokerage and Robinhood Chain are separate execution domains. Brokerage
quotes or positions may be explicitly labeled reference evidence, but a brokerage security is not
an onchain token. Never place a brokerage order, rebalance a brokerage account, or imply that a
brokerage order is part of a Bivium flow.

## Install and machine-readable commands

```bash
git clone https://github.com/jianmliu/bivium-cli
cd bivium-cli
npm install
export BIVIUM_PROFILE=profiles/robinhood-testnet.json

npm run cli --silent -- strategy catalog --json
npm run cli --silent -- strategy assess --risk-file test/fixtures/meme-risk.json --json
npm run cli --silent -- strategy trace --strategy-id lendQuote \
  --quote-id 0x<64-hex> --nonce 0 --account 0x<40-hex> --json
```

All three strategy commands require `--json`. `catalog` is discovery metadata; `assess` returns
facts, warnings, unknowns, stress outcomes, and a policy-owned decision; `trace` is attribution
metadata and does not sign or execute a transaction.

## Operational safety

- Verify chain ID, Core address, ABI lineage, and complete market identity before every write.
- Use exact decimal strings for token amounts. The CLI rejects over-precision rather than rounding.
- Treat a relayer failure as unknown book state, never as an empty book. Onchain consumption is the
  authority for order capacity and cancellation.
- Repayment requires the exact face amount before maturity; principal received can be lower because
  the difference is interest. Reclaiming collateral is a separate transaction.
- At or after maturity, an unpaid position delivers collateral into settlement. Claims may return
  loan tokens, collateral, or a mix.
- A borrow position is bound to its wallet. Preserve access through repayment or maturity; never
  commit or share key files.
- A stopped agent action does not pause a permissionless market. Report whether the stop came from
  Core state, Bivium infrastructure, an optional provider, or the selected policy.

For command details, read `README.md` and `docs/spec/2026-08-09-bivium-cli-spec.md`, while keeping
the Robinhood Chain execution boundary above.
