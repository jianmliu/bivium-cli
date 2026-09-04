# Agent MM / Keeper implementation plan

> **For agentic workers:** Use subagent-driven-development. The user approved the design and execution method; proceed through implementation and independent reviews without another design gate. Do not deploy, fund, load real keys, or start a live session.

**Goal:** Ship an opt-in local executor and Skill for independently authorized, bounded Robinhood testnet MM and keeper sessions.

**Architecture:** A new Node entry in `bivium-mm` owns a private persistent session directory and exclusive signer lock. It exposes preview, approval, run, status and stop, and routes only one approved role through a common pre-signing guard and durable action ledger. Existing Worker entry/config are unchanged. `bivium-cli` supplies goal-oriented Skill guidance referencing the verified new capabilities.

**Tech Stack:** TypeScript, Node filesystem/crypto, viem, existing quote/offer/settlement primitives, node:test; no new contracts or hosted service.

## Task 1: Bounded local executor

Worktree: `/Users/jianmingliu/.config/superpowers/worktrees/bivium-mm/agent-mm-keeper` (initial base f898322; synchronized to main 5b898d1 before final review).

Create focused modules under `src/session/`: `policy.ts` (strict versioned policy and digest),
`store.ts` (private durable state/lock/stop marker), `engine.ts` (lifecycle, reservations and role dispatch),
`chain.ts` (read/preview adapters and bounded signing), `shape.ts` (exact pre-signing payload checks), `cli.ts` (local entry).
Tests under `src/session*.test.ts` are included by existing test command. Add `session` package script and `docs/agent-sessions.md`.

- [x] Write and run failing tests for invalid/missing approval, role isolation, expiry, raw-token limits, outstanding-offer reservation and two processes contending for one signer.
- [x] Implement explicit immutable policy: version/id, role, account, chain 46630/Core/ratifier, exact markets and token units, endpoints/contracts, start/end, evidence acceptance/freshness, quote limits or keeper route/profit, gas/attempt caps and interval. Hash canonical validated policy; exact digest confirmation required. Reject unknown fields and invalid numeric shapes.
- [x] Store policy approval digest, status, action IDs, signed offer commitments/expiry, pending tx nonce/hash, conservative spend/gas reservations and failures atomically. Exclusive signer lock cannot be silently stolen. Restart never resets budgets; malformed/missing initialized state stops. Stop marker can be written by another process and is checked immediately before any signing/broadcast. Session state and key files are not part of source control.
- [x] MM builds bids from funded escrow and asks from held credit only. No collateral-backed asks/new borrowing/taker/self-arm/mint/fund. Track all outstanding signatures incl publication-unknown; clip all market/side ladders by aggregate raw-token and cumulative limits. Use conservative gross accounting, no cross-strike debt netting. Expiry ≤ authorization expiry and market boundary. First-release conservative refinement: read onchain consumption for reporting, but never recycle any quote reservation, including expired/unfilled offers.
- [x] Keeper scans authorized borrowers only, uses configured flash wrapper exclusively, validates actual chain/contracts/tokens/pool and bounded fresh prices, simulates, estimates maximum gas and converts it conservatively into profit units. Encode positive minProfit covering required surplus; reject when net-profit or gas budget cannot be verified. No wallet advance and no unlimited approval. Serialize nonce and sign a fully bounded transaction only after durable reservation. Persist signed tx hash before broadcast; unknown send/receipt reconciles rather than sends again.
- [x] Commands: `capabilities`, `preview --policy <file>`, `approve --policy <file> --state-dir <private-dir> --confirm <digest>`, `run --state-dir <private-dir> --key-file <private-file> [--once]`, `status --state-dir <private-dir>`, `stop --state-dir <private-dir>`. Preview requires no key and performs no external writes. Approval/start are user-authorized local operations, never implicit from Skill discovery. Continuous loop belongs to user host; stopping returns residual offers/positions/pending tx and never claims to unwind.
- [x] Test stop/expiry during asynchronous preflight, post-reservation failures, restart, duplicated invocation, malformed state, stale prices, ask inventory race, near-cap clipping, no route, failed simulation, gas loss, unknown nonce/receipt and signer mismatch. Real network calls are replaced with local fixtures/injected adapters, not live trading.
- [x] Independently review spec compliance, then code quality; fix important findings. Run `npm test` and `npm run typecheck` with zero failures.

## Task 2: Skill onboarding and operating guide

Worktree: `/Volumes/T7-Data/bendle/bivium-cli/.worktrees/agent-mm-keeper` (base 6ee3978 plus approved spec).

- [x] Baseline behavioral fixture: “只做市，不允许自动借款”; “只跑 keeper，不垫本金”; “两个都跑”; “现在马上停”; “预算达到上限后重启继续”. Record current capability/authorization gaps before modifying Skill.
- [x] Update both `skills/bivium/SKILL.md` and `.claude/skills/bivium/SKILL.md`; add matched `references/operators.md`. Four consumer strategy IDs remain unchanged; MM and keeper are operational roles. Preserve ordinary per-transaction signing while narrowly allowing digest-bound automatic sessions only when the new executor reports actual supported capabilities.
- [x] Explain dedicated EOA vs cryptographic session key; bound roles/accounts/markets/budgets/expiry, distinguish risk acceptance from activation, never load real keys during previews. User refusal of debt/advance is preserved. Installation/start remain separate explicit host actions.
- [x] Document current executable commands from verified capabilities and runtime guide, status/stop behavior, remaining offers, pending transactions and positions. Do not call legacy `/run` or claim MM_ENABLED stops all roles. Correct directly conflicting legacy safety text.
- [x] Run fresh-agent behavioral fixtures and spec review, followed by quality review. Six scenarios and both reviews pass for instructions; both Skill validators and mirror tests pass. CLI 174 tests and typecheck pass. Runtime command compatibility and final package inclusion check also pass.

## Task 3: PR delivery

- [x] Update design status and record observed checks/limits, without promising an untested live deployment.
- [x] Commit/push isolated branches and create separate Draft PRs targeting each repo's main branch with dependency notes. Do not merge, deploy, enable cron or move keys/funds.

## Stop conditions

Stop implementation only on genuinely missing authority or an architectural conflict with the approved scope; otherwise fix failed tests/review findings and continue. Do not claim completion if a production adapter is a placeholder, any advertised bound lacks enforcement, tests fail, or live capabilities cannot be truthfully exposed. An unavailable external price or route must prevent execution, not fall back to guessed data.

## Plan self-review

The executor and Skill are independently editable across separate repositories. Every design safety requirement maps to Task 1 enforcement plus Task 2 disclosure and behavior tests. Local-only runtime is an implementation of the approved user-controlled executor; it neither creates a shared service nor changes the existing Worker. Software/EOA trust limits remain explicit. Tests validate observable side effects and accounting, not generated wording.

## Observed verification

Runtime specification review passed after fixing independent reproductions of stop/save races,
ancestor-symlink lock aliases, successful keeper continuation, reverted-receipt recovery,
ordinary unprofitable skips, sparse MM scheduling, and freshness across asynchronous reads.
Final freshness checks retain each source observation and revalidate immediately before writes.
The full suite has 72 passing tests, including 28 session tests and loopback production-signing
fixtures. CLI has 174 passing tests; typechecks, both Skill validators, mirror tests, and package
inclusion checks pass. No public-chain compatibility, profitability, live run, or deployment is
implied by these local checks. Final quality review passed with no important open findings.

Delivered as Draft PRs targeting main:

- Runtime: https://github.com/jianmliu/bivium-mm/pull/45 (implementation commit 9a6fbe4; base 5b898d1).
- Skill: https://github.com/jianmliu/bivium-cli/pull/35 (implementation commit 5878c23; base 6ee3978).

Neither PR was merged. No deployment, host service, key provisioning, funding, or live session was started.
