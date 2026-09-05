# Router upstream fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Correct the two upstream routing defects before merging CLI PR #35 into main.

**Architecture:** Keep gate selection in the existing CLI builder. Publish the selected client's router, and require a successful gate policy read instead of interpreting any error as a legacy policy. Unsupported legacy gates fail closed; no unverified bytecode heuristics or new configuration bypass is introduced.

**Tech Stack:** TypeScript, viem, node:test, loopback JSON-RPC fixtures.

---

### Task 1: Routing correctness and regression coverage

Files: `src/cli/main.ts`, `src/sdk/strategyRouter.ts`, `test/strategyRouter.test.ts`.

- [ ] Extend the existing CLI loopback fixture to exercise nonzero gates and record call destinations. First assert that automatic router selection is reflected by `JSON.parse(result.stdout).router`, including the human preview, and compare with the real SDK approval spender and execute destination using inert write capture. Cover admitted defaults and rejected explicit overrides.
- [ ] Add failures for RPC errors, empty revert/return, malformed policy data, plus explicit true/false success cases. Assert failures produce no program and do not claim the gate permits direct lender fills.
- [ ] Run `node --import tsx --test test/strategyRouter.test.ts`; observe the regression assertions fail before production edits.
- [ ] Change the open-program preview to `router: c.router` and add `router ${c.router}` to its human text. Leave unwind routing behavior unchanged.
- [ ] Replace the policy fallback with an actionable error preserving its cause:

```ts
let lenderMustRoute: boolean;
try {
  lenderMustRoute = await this.pub.readContract({ address: gate, abi: gateAbi, functionName: "LENDER_MUST_ROUTE" });
} catch (cause) {
  throw new Error(`Cannot read LENDER_MUST_ROUTE from gate ${gate}; the gate may be unsupported or the RPC unavailable. Verify a compatible gate and RPC, then re-quote before executing; refusing to assume lenders can fill directly.`, { cause });
}
```

- [ ] Re-run the focused tests, then `npm test` and `npm run typecheck`.
- [ ] Obtain independent requirements review followed by quality review. Resolve blocking findings and re-review.

### Task 2: Integration and handoff

- [ ] Commit reviewed fixes and this record on the existing feature branch; push normally to PR #35. Do not modify the user's main checkout.
- [ ] Confirm GitHub checks, exact head and base, mark Ready, then squash merge into main using the reviewed head guard. Stop for failed checks, merge conflicts, or changed unreviewed code; never bypass protections.
- [ ] Fetch the actual merged main commit and verify its tests and typecheck. Report the PR link and results.

No Core changes, deployments, live transactions, funds, or real keys are in scope. Runtime PR #45 is already merged and is not repeated.

Self-review: both confirmed defects are covered; original router selection and fee semantics remain unchanged. Legacy contracts without a readable policy getter are intentionally unsupported by this program path until compatibility can be positively established.

## Execution evidence

- Integrated upstream `981b674` into the isolated feature branch; baseline 175 tests passed.
- Regression-first run: 14 focused tests, 8 passed and 6 failed on the original implementation (JSON router mismatch, missing human router, and four unknown-policy cases).
- Minimal fixes: actual selected router in JSON/human output; cause-preserving fail-closed policy-read error.
- After fixes: 14 focused tests and 185 full tests passed; typecheck and whitespace checks passed. Parent independently repeated the full suite and typecheck.
- Independent requirements and final quality reviews passed, each repeating focused tests and typecheck. Quality review found no critical, important, or minor issues. PR integration remains the final gate.

## Authorized follow-up: existing-credit sell orders

Upstream PR #37 (`c553dec`) added an escrow-only precheck for every sell offer. The user authorized fixing its rejection of credit-backed secondary sells before continuing PR #35 integration.

Files: `src/cli/main.ts` (maker offer precheck), `test/maker-offer.test.ts` (loopback CLI regressions). Reuse `askBackingShortfall` from `src/sdk/trade.ts`; do not change Core or existing router fixes.

- [ ] Write and observe failing CLI tests for sufficient held credit with zero/unavailable escrow, both ABI lineages, and mixed credit plus escrow covering only newly issued units. Use a public synthetic test key and local RPC only, with temporary offer outputs; never load user keys or broadcast transactions.
- [ ] Read credit first. If `credit >= maxUnits`, skip escrow completely. Otherwise refuse new issuance at/after maturity, and read escrow without a guessed-zero fallback. Missing getters/RPC failures stop with an actionable compatibility/read error.
- [ ] Reuse exact Core rounding with `askBackingShortfall({ units: maxUnits, credit, escrow, strike: params.strike })`. Reject positive shortfall; state that reducing the order or acquiring credit avoids new debt, whereas escrow-backed issuance opens debt. Never automatically escrow, fund, or issue a write.
- [ ] Cover one-unit collateral shortfall, pure escrow origination before maturity, insufficient credit/escrow, failed credit/escrow reads, maturity boundaries, and held-credit sell behavior at maturity. Keep ordinary buy behavior unchanged.
- [ ] Run focused tests RED then GREEN, full suite and typecheck; obtain specification then quality review. Push reviewed fix, confirm current base and checks, and merge #35 with an exact head guard. Repeat tests on the actual merged result. New unrelated important upstream defects remain a stop condition, not implicit authority to expand scope.

Follow-up evidence: 15 maker regression tests first produced 14 expected failures and one passing buy-path check. After the credit-first fix, all 15 maker tests and all 201 full-suite tests passed; typecheck passed. The parent repeated the full suite independently. Requirements review independently passed 29 maker/router focused tests and typecheck; no specification gaps were found.

Final quality review also passed 29 focused tests, typecheck, and whitespace checks, with no remaining important or minor findings. The previously identified PR #37 integration blocker is closed; merge remains subject to current remote checks and head verification.
