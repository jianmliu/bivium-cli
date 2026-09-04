# Meme Skill conversation implementation plan

> **For agentic workers:** Use subagent-driven-development for the focused Skill change and independent behavioral review.

**Goal:** Implement the user-confirmed goal → minimal questions → executable proposal → short confirmation → position-management experience for dual-currency yield and Meme long/short.

**Architecture:** Add a concise conversational entry point to both distributed Skill copies, with a focused supporting reference for routing, outcome summaries and lifecycle handling. Retain existing execution/risk checks; protocol details stay available without becoming an onboarding questionnaire.

**Tech stack:** Markdown Skill instructions; existing CLI/SDK unchanged.

## Confirmed design and self-review

- Four primary operations remain lendAsset, lendQuote, leveredLong and short. Plain-language buy/sell intent alone does not authorize dual-currency exposure.
- Discover available terms and liquidity, reuse supplied information, ask only missing material choices. Do not invent maturities, prices, loss budgets or user risk acceptance.
- Show spend, received/locked assets, duration, fee-inclusive outcome and downside in everyday language. Keep pooled repayment/delivery and Meme rug risk explicit. Do not turn indicative payoff into guaranteed return or stop-loss protection.
- Retain testnet-only execution, user policy acceptance, fresh previews and per-transaction signatures. A short summary is not blanket execution approval.
- Report resting/unfilled, partially filled, active and matured states accurately. Optional keepers are not guaranteed; no automatic rollover or monitoring promise without capability and authorization.
- Scope excludes Core, frontend and runtime changes. Update Draft PR #34, do not merge it.

Self-review: the UI simplification changes presentation, not authority or settlement semantics. Ordinary limit orders remain distinct. All required risk and transaction facts remain available before signing. No new backend feature is implied.

## Task 1: Behavioral baseline and focused implementation

- [x] Run a read-only agent baseline for target-buy ambiguity, loss-budget shorting and a three-day yield request; record actual responses and usability gaps.
- [x] Update `skills/bivium/SKILL.md` and `.claude/skills/bivium/SKILL.md` identically. Add matching `references/conversation.md` files if useful. Resolve conflicting legacy presentation instructions only where this UX requires it. Link the guide from README and preserve the reference directory in installation instructions.
- [x] Run fresh-agent scenarios against the revised Skill, including a known-preferences risk-confirmation case and a no-route case. Verify decisions and next responses, not exact wording.

## Task 2: Review and delivery

- [x] Independent spec review: four intents, minimal questions, plain language, truthful outcomes, risk boundaries and lifecycle.
- [x] Independent quality review: contradictions, packaging, reference discoverability and regressions. Approved with no new actionable regression; requested completion of the behavior record is incorporated.
- [x] Validate both Skill folders; compare duplicated files; run `git diff --check`, `npm test`, `npm run typecheck`. Both validators and mirror checks pass; 173 tests pass; typecheck passes. Package dry-run includes the conversation reference.
- [x] Delivery checks prepared for commit/push to existing Draft PR #34; no merge. The actual pushed revision and remote checks are verified in the task handoff rather than asserted by this checklist.

## Stop conditions

Stop and report if implementation needs new runtime behavior or financial authorization, if findings cannot be fixed within the Skill scope, or if the PR branch has conflicting external edits. Behavioral fixtures are read-only: never create a wallet, sign, fund, publish an order or transact during validation. Failed checks prevent a completion claim.
