# MM and keeper operator sessions

Read this guide when the user wants to run, authorize, inspect or stop market making or a
maturity-settlement keeper. These are operational roles, not new consumer strategy IDs.

## Capability first; no silent activation

The bounded executor lives in the companion `bivium-mm` repository, using its local `session`
entry. Check the installed revision, its `docs/agent-sessions.md`, and `capabilities` before
promising automatic operation. If the entry, role, persistent limits or stop capability is
missing, offer a read-only plan or ordinary individually signed actions; do not substitute
legacy `POST /run`, a wrapper around unrestricted commands, or a prompt-only budget.

The legacy Worker combines quoting, taker, self-arm and keeper; `MM_ENABLED` does not stop all
of them. The separate `bivium-keeper` repository is a different vault/BTC workflow, not this
Robinhood maturity keeper. Never configure, trigger or deploy official shared workers as a
user session. Do not enable cron, install a service, create/fund accounts or read keys merely
because the user discussed or approved the design.

## Resolve only missing material choices

Reuse the user's known role, assets, markets, budget and duration. Explain technical choices
in terms of funds used, exposure, costs and stopping. Ask for missing choices that affect
authorization; derive exact market addresses, raw amounts and execution settings from verified
data and present them for confirmation.

| User goal | Session boundary | What needs confirmation |
|---|---|---|
| “帮我做市，不要自动借款” | MM only: funded bids and held-credit asks | Exact markets, funded assets, gross/cumulative limits, quote terms, runtime |
| “只跑 keeper，不垫本金” | Keeper only: approved flash route, no wallet advance | Markets/eligible borrowers, route, minimum expected net surplus, Gas budget, runtime |
| “两个都跑” | Two independent sessions and dedicated accounts | Separate capital, Gas budgets and durations; no shared main-wallet signer |

Never silently enable taking orders, opening debt, self-arming, auto-funding, minting, borrowing
to seed inventory, rolling positions or expanding to new markets. No ask inventory means
one-sided MM or waiting, not permission to manufacture inventory.

## Risk acceptance and run authorization are different

Before approval, apply the main Skill's chain/Core identity, evidence and user-risk-policy
checks to the selected markets. Preserve unknowns and `MEME_DELIVERY_RISK` with repayment,
delivery and 50%/90%/100% collateral-decline stress outcomes where applicable. Resolve rejection
or required user-risk acceptance before preparing an executable session. The session's risk
acknowledgment does not certify safety or bypass a rejected assessment.

Show a concise approval summary and the exact policy digest it represents:
role, dedicated account, chain 46630/Core, full market set, permitted contracts/operations,
token-denominated limits, Gas price/per-transaction/total caps, maximum attempts/failures,
start/end, interval, evidence validity, payout account and stop behavior. Market prices are
inputs, not permission to invent a fiat-denominated hard loss cap.

Explicit approval of that specific policy is required before saving approval and starting.
A general “好”, approval of this software design, or permission to inspect wallets is not
approval to trade autonomously. Policy changes, increased limits and extensions require a new
review and explicit authorization; never erase old accounting or create a replacement session
to bypass an exhausted budget.

The operator account is a dedicated EOA controlled by the user. Its secret can sign arbitrary
transactions if stolen: the executor's limits are software checks, not onchain session-key
restrictions. Use separate MM and keeper accounts, never the main wallet or official quoting
key. The user provisions the private key file in their own host; pass its path to the executor
without opening, printing or copying its contents into the conversation. Do not assume access
to a key because a user approved the policy.

## Commands and truthful progress

From the verified `bivium-mm` checkout, first inspect capabilities and preview without a key:

```bash
npm run session -- capabilities
npm run session -- preview --policy "$POLICY_FILE"
```

Use the installed executor's documented schema to build `POLICY_FILE`; do not paste a live
operator configuration, fabricate hashes, reuse expired evidence or guess unsupported fields.
Preview can read public state but must not publish offers, request approvals or transact.

MM additionally requires a verified Core deployment with collateral-escrow inspection support,
an already-enabled ratifier, and funded market escrow or held credit. Missing inspection is
not proof of zero collateral. These prerequisites are checked, not created by the executor;
any separate ratifier activation or funding transaction needs its own user authority.

The first release requires a price-source adapter returning a genuine observation timestamp,
`status: "ready"` and an integer `loanPerCollateralWad`; the existing display-only pair price
endpoint is not automatically compatible. Never use request/receipt time as price observation
time. Missing provenance, stale observations or a price outside the approved range prevents
new actions. Keeper Gas conversion also needs a still-valid conservative upper bound.

Only after the user explicitly authorizes the shown policy and host execution:

```bash
npm run session -- approve --policy "$POLICY_FILE" --state-dir "$STATE_DIR" --confirm "$POLICY_DIGEST"
npm run session -- run --state-dir "$STATE_DIR" --key-file "$KEY_FILE"
```

A foreground run lasts only while the user host keeps it alive; this command is not evidence
of an installed background service. An explicit host-service/scheduling request is separate.
Running an authorized operator is not the same as asking Codex to send a future reminder.

```bash
npm run session -- status --state-dir "$STATE_DIR"
npm run session -- stop --state-dir "$STATE_DIR"
```

Read real results: approved is not running, broadcast is not settled, paused is not recovered.
Never claim a running strategy from a successful installation, saved policy or process spawn
alone. Report the observed session status, last verified action and timestamp. Preserve state
across restarts, including outstanding signatures, pending transactions and consumed budgets.
Do not delete locks or recovery records just to make a failed restart succeed.

This release permanently binds each dedicated account to its approved local state directory.
Stopping does not make that account reusable for a new policy. Do not remove the account
registry to renew or bypass limits; explain this restriction before account provisioning.

## Role-specific economics and stopping

MM budgets include existing gross exposure and still-live signed offers, not only the newest
ladder. Publication failures may still leave an effective signature. Relayer replacement is
not onchain revocation. A stopped process can leave fillable offers until expiry; new bids
can become credit exposure with Meme delivery risk. No fill means no interest, and inventory
mark-to-market is not realized profit. Even a no-borrow MM account can lose principal value.

The first release conservatively retains quote reservations for the entire session, including
expired or unfilled offers. Report these as reserved signed face/potential turnover, not actual
spending or fills. Repeated quoting can exhaust that allowance without any trade; do not
promise continuous two-sided liquidity for the full authorized duration.

Keeper serves currently authorized positions in the allowed pre-maturity window, not price
liquidations. It never grants borrower authorization itself. Flash funding avoids wallet
principal advance, not Gas cost. Require a verified positive onchain surplus threshold and
expected net surplus after conservative Gas/other costs; stale prices or missing routes mean
skip/stop, not wallet fallback. The full flash-funded debt settled may change after preview;
do not describe an indicative debt size as an onchain notional ceiling. Gas/own-outlay limits
and onchain minimum surplus are the protections, not guaranteed profit. Failed transactions
can spend Gas and competition can remove an opportunity.

Honor explicit stop immediately via the identified session's stop command; do not delay it
for fresh strategy selection. Check and report the result without overstating it. This release
does not automatically cancel or close positions. Distinguish: new actions disabled, live
offers, pending transactions, credit/borrower positions, and unused escrow. A signature already
published or a transaction already broadcast may still execute; machine failure can prevent
immediate cancellation. Separate signed cancellation/withdrawal/repay/claim is outside this
session and needs its own authority.

Expiry, exhausted budget, missing evidence, domain mismatch or uncertain transaction state
must not be bypassed by restarting. Scope “stop both” to both known sessions; stopping one
does not stop the other, revoke borrower authorizations, refund deposits or unwind fills.
Report residual exposure plainly, with the next available user-controlled action.
