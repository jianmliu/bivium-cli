# Robinhood Testnet Agent Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement sequentially with spec and quality reviews.

**Goal:** Align CLI/MCP price, product markets and routed CLOB preparation with the testnet frontend, including safe DCN capability reporting.

**Architecture:** Shared SDK helpers own exact deployment policy, Mock provenance and pinned route admission. CLI/stdio/HTTP are consumers; raw discovery/recovery stays complete. No contract mutation, signing or remote deployment.

**Tech Stack:** TypeScript, viem, Node 22, node:test/tsx, existing MCP registry and Cloudflare build.

## Workspace and baseline

Worktree `/Volumes/T7-Data/bendle/bivium-cli/.worktrees/strategy-agent-flow`; branch `docs/testnet-agent-compat-20260925`; base `640e81e`. Existing node_modules, Node `/Volumes/T7-Data/bendle/.tools/node-v22.16.0-darwin-arm64/bin`. Baseline `npm test`: 401/401, log `/tmp/bivium-compat-baseline.log`. Preserve other worktrees and untracked files.

All steps below are local. Each task follows RED → GREEN → self-review → independent specification review → independent quality review. Do not proceed with open important findings.

## Task 1 — shared deployment-bound Mock reference

Files: create `src/sdk/mockReference.ts`, `test/mock-reference.test.ts`; modify `src/sdk/spot.ts`, `src/sdk/strategies/gather.ts`, `src/sdk/actions/strategyFlow.ts`, their callers in `src/cli/main.ts`, exports in `src/sdk/index.ts`, and relevant tests.

- [x] Add failing HTTP-boundary tests for both orientations, observedAt boundaries, wrong chain/Core/assets, malformed payload, stale/network failure without legacy fallback. Use the actual current deployment identity and local HTTP fixture; never real wallet keys.
- [x] Run `node --import tsx --test test/mock-reference.test.ts` and retain expected missing-feature failures.
- [x] Implement a pure identity predicate over profile chain/Core/token addresses and a bounded fetch/parser. Metadata is `{mock:true,source,observedAt,expiresAt}`; canonical price is bigint WAD. The implementation invariant is:

```ts
const age = nowSeconds - observedAt;
if (!Number.isSafeInteger(observedAt) || observedAt <= 0 || age < 0 || age >= 1800)
  throw new Error('Mock reference unavailable or stale');
const canonical = BigInt(mnvdaBusdWad);
if (canonical <= 0n || canonical >= 1n << 256n) throw new Error('Invalid Mock price');
const reverse = 10n ** 36n / canonical;
if (reverse === 0n) throw new Error('Mock reciprocal underflows');
```

- [x] Wire actual profile/market identity into shared spot gathering. Preserve legacy behavior for unrelated domains. No symbol-only opt-in; no fabricated volatility; no legacy fallback on configured Mock failure. Carry exact canonical strategy WAD rather than inverting an already rounded reciprocal. Preserve metadata in human/JSON/MCP outputs and bound preview expiry to source expiry.
- [x] Run new tests, existing spot/strategy/preview tests and `npm run typecheck`; commit only task files.
- [x] Independent spec review then quality review; address findings before Task 2. Accepted at `62d5674`; review fixes bind the eligible token family before price lookup and cap the inclusive Router deadline at exclusive source expiry minus one second.

## Task 2 — new-business status without breaking recovery

Files: create `src/sdk/productMarketPolicy.ts`, `test/product-market-policy.test.ts`; modify `src/mcp/server.ts`, `src/sdk/strategies/gather.ts`, `src/sdk/actions/strategyFlow.ts`, `src/sdk/actions/orders.ts`, `src/sdk/actions/prepare.ts`, `src/sdk/actions/tradePrepare.ts`, `src/sdk/actions/reads.ts`, `src/cli/main.ts` and relevant tests.

- [x] Add failing tests with FUTURE-dated CASHCAT markets in either orientation, case-insensitive addresses, another Core/chain controls, expired mNVDA, and preserved historical account/recovery access.
- [x] Shared result shape and decision:

```ts
type ProductMarketStatus = {
  delisted: boolean;
  matured: boolean;
  newBusiness: boolean;
  reasons: string[];
};
// delisted = exact 46630/Core identity AND either leg equals CASHCAT.
// matured = maturity <= evaluation timestamp.
// newBusiness = !delisted && !matured.
```

- [x] CLI `market list` adds `--include-history`; MCP `market_list` adds boolean `includeHistory` default false. Filter BEFORE pagination and bind cursor to flag/filter. Both historical output and market_details carry status; no deletion from underlying discovery or profile.
- [x] Enforce same policy for high-level quote/preview, new offers, borrow/buy/fund/escrow and prepare revalidation. Keep sell exit, repay/claim/withdraw/cancel/read paths separate; a future CASHCAT market must not slip through because only maturity is checked. Preserve pre-existing DCN execution safety restrictions.
- [x] Legacy CLI maker/trade/borrow/strategy entry points check policy before signing/write preparation, while raw protocol primitives remain permissionless. Never filter the portfolio source.
- [x] Run new tests plus CLI/MCP listing, action, order, strategy and recovery suites; typecheck, commit, spec review then quality review. Accepted at `286fdee`; partial-fill recovery uses current remaining group capacity, not original caps. Full suite 459/461 with only the two deferred Task 4 source-pin failures; independent spec 57/57 and quality 40/40 focused tests passed.

## Task 3 — pinned route/fee admission and DCN compatibility

Files: create `src/sdk/actions/routeAdmission.ts`, `test/route-admission.test.ts`; modify `src/sdk/actions/reads.ts`, `src/sdk/actions/tradePrepare.ts`, `src/sdk/actions/strategyFlow.ts`, relevant SDK/CLI routing callers and tests.

- [ ] Add RED cases: old configured Router is not admitted by new Gate; one compatible Router succeeds; ambiguous candidates reject; Gate/Core/code/getter failures reject; fees out of 0–2000 reject; details show partial/unknown when unresolved.
- [ ] Implement one shared pinned resolver. Read Gate BIVIUM/routers/LENDER_MUST_ROUTE, validate addresses/Core/code. Prefer explicitly configured compatible admitted router; otherwise only one compatible candidate. Check required router BIVIUM, code, fee getters and MAX_LEGS before preparation. Explicit incompatible router is an error, never silently replaced. Unsupported or uncertain capability is not free/direct execution.
- [ ] Reuse in details and actions; preserve fee-aware budgets and revalidation fingerprints. Borrow/strategy and buy_dcn must no longer select an unapproved profile Router by default. Enforce relevant max-cost/min-proceeds after per-fill fee rounding.
- [ ] Bind fee arithmetic to the selected Router's actual quote semantics, including the principal cap. Read-only evidence at block 124180013 (timestamp 1790351341): current Router returns `quoteFee(1000,100)=(20,80)`, `quoteLenderFee(1000,100)=(20,120)`, `MAX_FEE_OF_PRINCIPAL_BPS=2000`. Do not apply uncapped legacy arithmetic to this deployment or assume unrelated routers share a cap; cover capped and normal-price fills.
- [ ] Preserve safe ungated direct behavior where contract permits. Legacy CLI gated sweeps must either use admitted bounded preparation or stop before any signing with an actionable unsupported explanation; never blindly direct-fill a lender-must-route market.
- [ ] Inspect pinned StrategyRouter/Core sources for pure-secondary execution guarantee. Record concrete evidence for donated collateral and changing credit. Enable only if actual contract guards exclude debt creation. If no guard exists, keep pre-maturity sell_dcn refusal, add machine-readable capability/reason and regression coverage; do not deploy an adapter in this task.
- [ ] Test fee-bearing buy_dcn calldata/receiver/approval, explicit borrow distinct from sell, failures and safe recovery; typecheck, commit, spec review then quality review.

## Task 4 — integration, agent docs and local acceptance

Files: update `README.md`, `skills/bivium/references/mcp.md` and `.claude/skills/bivium/references/mcp.md` identically; add `docs/verification/2026-09-25-testnet-agent-compat.md`.

- [ ] Document default market filter/history switch, Mock provenance/freshness, actual fee basis, route failure behavior, DCN capability boundary and external wallet-only signing.
- [ ] After all CLI source changes are committed, refresh only affected CLI runtime source hashes and `pins.cli.commit` in `releases/keeper-v2/integration-manifest.json`. Preserve Core/MM/fixture pins; rerun portable and pinned cross-repository integration checks. Task 1 exposed two expected source-pin drift failures; these are deferred here, not waived.
- [ ] Run `npm test`, `npm run typecheck`, `npm run mcp:worker:build`, and `git diff --check`; inspect complete exit status/counts. No npm publication or Cloudflare deploy.
- [ ] Run read-only SDK/MCP smoke against public testnet services: 2 active mNVDA markets, 42 historical records with delisting state, fresh 225 Mock snapshot (actual current configured value, not hard-coded in product logic), Gate-selected Router/fees. Document observed time/block; no authentication scope expansion or remote writes.
- [ ] Independent final review and record known limitations. If an external service is unavailable, report it without substituting a fabricated success.
- [ ] Commit verified local work and report ready-for-PR vs contract-blocked capabilities precisely. Leave worktree and branches intact.
