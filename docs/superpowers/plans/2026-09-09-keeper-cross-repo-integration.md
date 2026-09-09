# Bounded Keeper Cross-Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task, with specification then independent quality review. The user already chose this execution mode and approved the design scope; do not ask again between tasks.

**Goal:** Connect Core bounded keeper, MM v2, CLI/SDK, operator Skill and frontend without deploying or starting a keeper.

**Architecture:** Core merged ABI is authoritative. Explicit bounded CLI execution coexists with legacy manual routes; automation remains in MM v2. A pinned integration verifier/package artifact connects consumers while release admission stays closed.

**Tech Stack:** Solidity ABI artifacts, TypeScript/viem, node:test, React mounted tests, npm pack, Git object provenance.

## Task 1 — Explicit bounded SDK/CLI entry

Files: `src/sdk/settler.ts`, `src/sdk/index.ts` only if export needed, `src/cli/main.ts`, new focused `src/cli/boundedKeeper.ts` if needed to avoid enlarging command logic, `test/bounded-keeper.test.ts`, existing CLI test helpers.

- [x] Write failing tests for the new ABI/method, calldata tuple order, both sorted orientations, zero collateral cap and legacy selector compatibility. Public SDK shape:

```ts
type ExecutionBounds = { deadline: bigint; maxDebt: bigint; maxLoanBalance: bigint; maxCollateralBalance: bigint };
settleWithFlashBounded(jit, params, borrower, collateralAsk, key, minProfit, bounds);
```

- [x] Add explicit `settle execute --via-jit-bounded`, mutually exclusive with legacy JIT/Morpho. Require `--bounded-jit-wrapper`, `--bounded-jit-code-hash`, `--deadline`, `--max-debt`, `--max-loan-balance`, `--max-collateral-balance`, positive `--min-profit`. Parse human amounts with the correct loan/collateral decimals and strict uint256 integer bounds; zero wallet caps allowed. Do not infer the bounded address from `profile.v4JitKeeper`.
- [x] Test missing/negative/overflow/invalid bounds, conflicting routes and new-bound flags on legacy routes. Require chain 46630, zero hooks, sorted matching currencies, timestamp < deadline <= maturity. Validate wrapper runtime hash and BIVIUM/SETTLER/POOL_MANAGER relationships against the profile and reviewed chain manager before any write. The reviewed manager address/hash are the existing Core fork-test constants; do not invent another deployment.
- [x] Implement minimal dispatch and SDK validation after RED. Preserve old methods/selectors. Correct the old comment claiming reverted transactions cost nothing. No key reads or transactions in tests; use the real handler with synthetic transport/account fixtures.
- [x] Run `npm test` and `npm run typecheck`, then spec review and quality review. Root commits only scoped reviewed files in CAI identity.

## Task 2 — Operator Skill v2 guidance

Files: `skills/bivium/SKILL.md` if routing needs a short update, `skills/bivium/references/operators.md`, mirrored `.claude/skills/bivium/` counterparts; `test/skill-sync.test.ts`; behavioral evaluation evidence in integration report.

- [x] Before edits, run independent retrieval/pressure scenarios against old guide: stopped legacy v1 with pending tx; zero-inventory v2 setup near expiry; urge to use old JIT/Worker after deployment missing. Record actual wrong/missing answers, not invented failures.
- [x] Add minimal version-specific guidance: v2 only for new keeper signing, all four on-chain limits, zero collateral cap, fresh bounded wrapper pin, both final wallet balances, exact deadline <= session end/maturity, positive surplus and Gas risk. Keep software-key vs on-chain-entry scope distinction.
- [x] Include exact recovery command:

```sh
npm run session -- reconcile --state-dir "$STATE_DIR"
```

- [x] Keep keyless reconciliation after stop/expiry, v1 status/stop/reconcile only, fresh account migration without resetting history, no wallet/Morpho/legacy Worker fallback. Explain manual bounded CLI is not automatic session approval.
- [x] Synchronize secondary copy from canonical source. Run skill-sync tests and quick validator; rerun independent behavioral scenarios with new guide. Spec review, then quality review before committing.

## Task 3 — Pinned cross-repository integration verifier

Files: new `scripts/check-keeper-integration.mjs`, new `test/keeper-integration.test.ts`, selected ABI/vector fixtures under `test/fixtures/keeper-v2/`, integration manifest under `releases/keeper-v2/`; package.json verification command if needed. MM/Core production changes are not required.

- [x] Test verifier rejects changed selectors, tuple ordering, indexed flags, source/module hashes, missing source commits and altered event arithmetic. Explicit workspace inputs identify Core and MM; no sibling-path guessing. Use `git show COMMIT:path` for source provenance and reject mismatched runtime input files.
- [x] Compare Core compiled bounded ABI, actual CLI ABI/encoder and actual MM `boundedKeeperAbi`/execution bounds. Check full raw calldata equality, deadline=min(session end,maturity), and event decoding/conservation through a synthetic lifecycle fixture using real MM receipt logic. Never silently skip missing integration inputs.
- [x] Provide a committed portable ABI/vector fixture checked against pinned Core; ordinary tests can verify consumers without sibling repos. The explicitly requested cross-repo command additionally requires source closure and compiled artifact validation. Fixture-only tests are labelled separately.
- [x] Record Core/MM merge commits, exact CLI selected source, relevant closure hashes and results. Do not import MM's newly tracked host-specific node_modules symlink; dependency directories are never source provenance. Preserve the existing working runtime and document this upstream packaging limitation.
- [x] Run focused/full tests, existing real-v4 fork proof where reproducible, spec and quality review. Commit reviewed code before packaging so the CLI artifact can be tied to a fixed commit.

## Task 4 — Frontend package and ARM integration

Files: frontend package.json/package-lock.json, `components/AutoSettleControl.tsx` only scoped copy changes, `lib/autoSettleArmRender.*` tests as needed, new focused package/integration check tests, `releases/cai-testnet/` integration amendment and artifact provenance. Preserve all unrelated dirty files and historical records.

- [x] Assemble exact CLI npm package from the reviewed fixed commit with `npm pack`; inspect file list, exclude historical signed orders/keys/dependencies, hash the artifact. Install locally from that artifact for verification; never commit an unavailable remote Git pin. Choose a portable checked-in artifact/reference only if small and clean; otherwise retain local evidence and explain publication requirement.
- [x] Write failing mounted ARM assertions for permission vs service availability and no settlement guarantee. Preserve already verified tuple normalization and unconditional hook order. Keep six-hour window and borrower-selected floor unchanged.
- [x] Update package provenance and minimal UI explanation; consume CLI APIs used by frontend in tests. Do not regenerate legacy pool/router ABI bundles or enable HTTP routes.
- [x] Add a new integration amendment that supersedes old keeper-v1/wallet-only assumptions without rewriting historical evidence. Software-verified candidate is not included/deploymentReady. Existing contract addresses remain untouched.
- [x] Run package compatibility, mounted ARM and full frontend regression; separate baseline accepted deltas from new changes. Final independent spec/quality review across repositories. Save evidence and local commits; offer PR path, no automatic push/merge/deploy.

## Completion checks

- [x] Actual CLI command and SDK generate the same bounded call as MM/Core.
- [x] Skill behavioral tests correctly preserve authority and recovery boundaries.
- [x] Frontend runs against the exact verified CLI package and ARM messaging remains truthful.
- [x] Reproducible cross-repo checks fail closed on drift; synthetic vs real-v4 vs live service evidence remains distinct.
- [x] No public mutations, source import, scope admission or unrelated dirty-file loss.

Completed evidence: `docs/verification/2026-09-09-keeper-cross-repo.md`. CLI packaged source is `a964a11903a6fd16b12fbcca3cd44cd336707c81`; frontend integration is `386e3ef802fccf5fcce948b73c1a2c838690f1c9`. Final whole-work review found no actionable findings. Worktrees and local branches are retained; public PR/deployment operations require separate authorization.

Self-review: source/ABI/decoder/deadline fields align across tasks; source manifests exclude host dependencies and credentials; package selection occurs after reviewed CLI commit; frontend accepted deltas remain separately attributable.
