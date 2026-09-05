# Goal-first Meme conversation

Use this guide for conversational yield and directional requests. It changes the conversation,
not the protocol, supported commands, risk gates, or signing authority in `SKILL.md`.
For running an MM or keeper, use [the operator guide](operators.md); do not route those operational
roles through the four consumer strategies or treat consumer consent as automatic-run approval.

## Understand the decision before choosing a strategy

Reuse the asset, budget, target, horizon, and preferences already given. Ask only for a missing
choice that changes the decision: the goal, asset (address if the symbol is ambiguous), spend
budget or tolerable loss, target price, and deadline. Ask one focused question when possible;
do not make users repeat known facts or complete a tick/size/buffer/sigma questionnaire.

An ordinary “buy this dip” or “sell at my target” request does not authorize lending. Explain
that a spot/limit trade buys or sells the token, whereas dual-currency yield commits capital
to credit and can settle in the other asset or a pooled mix. Ask which product they mean before
routing; do not disguise this as merely choosing a maturity. If they want only spot trading,
do not force a Bivium credit strategy or imply an unsupported spot route exists.

After product consent, use the stable IDs:

| Confirmed goal | Strategy | Essential distinction |
|---|---|---|
| Earn on held Meme; accept possible quote settlement | `lendAsset` | Lend Meme to shorts; repayment/delivery determines the payout. |
| Earn on quote assets; accept possible Meme settlement | `lendQuote` | Lend quote to longs; Meme delivery can be worthless. |
| Take upside exposure | `leveredLong` | Borrow quote and buy more Meme; verify outlay and break-even. |
| Take downside exposure | `short` | Borrow Meme and sell it; verify outlay and break-even. |

A target is a preference, not an order guarantee or oracle-triggered conversion. Explain the
repay/deliver term separately from directional break-even. Preserve pooled repayment/delivery:
the lender does not necessarily get a single all-or-nothing outcome at the target price.

## Discover, then fill only the real gaps

Follow the main Skill's chain/Core checks, then `market list`/`market_list` before the strategy
catalog. Discover live addresses, exact market identities, maturities, strikes, depth and route
capability. Do not ask users to invent unavailable terms or copy stale examples. Reuse known
choices; present the relevant available alternatives when no market fits, without silently
changing their target, budget, or deadline. Discovery failure is unknown, not an empty book.

Derive quote inputs and technical bounds from verified evidence and the user's choices. Never
invent volatility, fee values, available size, or an executable quote to fill a missing field.
If an optional probability cannot be supported, label it unavailable instead of eliciting sigma
from a novice. A resting lender bid is possible when asks are empty, but filling is not promised.

Ask when funds must be usable and in which asset if that materially affects suitability. Respect
a stated needed-by date, not just maturity: allow for settlement, a holder claim, confirmation,
and any conversion back to the needed asset. Early exit, keeper execution and swap liquidity are
not guaranteed. If available terms cannot satisfy that requirement, say so and do not present
the position as suitable or silently extend the date.

## Size directional risk from a verified budget

For a stated maximum tolerable loss, size from a verified all-in worst-case outlay/loss in the
user's budget asset: collateral/top-up exposure, borrow or lender fees as applicable, swaps,
slippage bounds, gas, and relevant close/keeper costs. Check token balances and executable
capacity. A quote's `size`, `prepay`, or modeled `worstCase` alone is not the user's loss cap.
Do not promise a hard cap if required prices, fees, conversion, or execution bounds are unknown;
state that the budget cannot yet be verified and do not open the trade. A failed fee read is
not zero. No-liquidation and maximum-loss estimates are not stop losses or automatic exits.

## Short confirmation, complete verification

Lead with a compact plain-language summary of the chosen product and:

- What is spent, what remains locked, and what asset(s) can be received, with amounts and units.
- Maturity and the strictly earlier borrower repayment deadline; needed-by feasibility.
- For yield, term return after verified fees and both repayment/delivery outcomes; for direction,
  verified break-even, all-in outlay, available size, and maximum loss with its assumptions.
- Downside including prominent Meme rug/worthless-delivery risk; fees and any unknowns.
- The exact next transaction and whether more approvals/signatures will follow.

This summary never replaces material pre-signing detail. Supply the detailed verification
payload from the main Skill: chain `46630`, Core, full market, strategy, account, amount,
maximum loss, slippage/price bounds, expiry, destination and every transaction. Keep full quote
output/payoff tables as detail. Preserve the risk evidence, policy result and unknowns, principal,
face amount, repayment/delivery assets, and 50%/90%/100% collateral-decline stress cases before
quoting yield or signing. Do not call indicative figures net of all costs without verification.
APR and exercise probability are supplementary estimates, never guarantees.

For Meme collateral, prominently show `MEME_DELIVERY_RISK`: borrowers may rationally decline
repayment, delivered Meme can be worthless, and correct settlement can still lose all
economically recoverable principal. Never imply Core prevents rugs or certifies safety.
Stop on policy rejection or `require_user_confirmation`; acceptance requires SDK `assessRisk`
with explicit `user-policy` for the same market/evidence before `buildPlan`. The CLI has no
bypass. Consent to discuss a product is not policy acceptance or permission to sign. Every
ordinary consumer transaction requires its own user approval and signature on the supported
testnet only; separately approved operator sessions follow their own narrow authorization.

## Explain the lifecycle that actually exists

- **Unfilled:** escrow/order funding is not earning yield. Cancellation or unused-escrow
  withdrawal must be checked against current onchain state and signed as required.
- **Partially filled:** separate the idle remainder from active filled exposure. Canceling the
  remainder does not undo fills, repay debt, or redeem active credit.
- **Active:** report the filled exposure and deadline. Borrowers repay strictly before maturity
  with the borrower signer; collateral reclaim is a separate transaction. Selling DCN credit
  needs a buyer and does not guarantee early cash availability.
- **Matured:** unpaid collateral enters pooled settlement; the current DCN holder claims with
  the holder's signer. A borrower cannot repay late or use a lender claim as borrower reclaim.

Offer keeper support only when available and explicitly authorized. Arming is not a guarantee
of execution. Do not claim to monitor, auto-close, or roll over in the background unless the
user authorizes that specific action and the host actually supports it; new positions retain
all policy, preview, and per-transaction signature requirements.

## Example next reply (illustrative, not a quote or executable instruction)

User: “Use my quote balance to buy the Meme at my target; I need the cash back Friday.”

Agent: “Do you mean a normal target-price buy, or a dual-currency yield position that can repay
in Meme instead of cash? The latter is lending, not a limit buy, and can't guarantee cash by
Friday because settlement, claiming and selling the Meme may take longer.”

Once clarified, reuse the stated asset/target/deadline, discover available terms, and ask only
for any still-missing material choice; do not fabricate an offer or request technical flags.
