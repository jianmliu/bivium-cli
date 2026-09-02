# Robinhood Agent Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Bivium strategy SDK and public Skill into a Robinhood Chain-only, agent-ready toolbox with machine-readable risk disclosure, three goal-based products, bounded execution previews, and strategy attribution.

**Architecture:** Keep Bivium Core unchanged. Add pure TypeScript modules under `src/sdk/strategies/` for risk facts, policy evaluation, stress outcomes, and attribution; expose them through the existing SDK and a small CLI command module. Keep the public Skill thin by routing agents to deterministic SDK/CLI output and by stating the immutable Core boundary explicitly.

**Tech Stack:** TypeScript 5.9, Node.js test runner, `viem`, existing Bivium CLI/SDK, Markdown Skill packaging.

---

## File map

- `src/sdk/strategies/types.ts` — canonical product, risk, decision, and attribution types.
- `src/sdk/strategies/catalog.ts` — agent-readable product catalog and initial product aliases.
- `src/sdk/strategies/risk.ts` — normalize risk evidence and evaluate user/agent policy without imposing protocol permissioning.
- `src/sdk/strategies/stress.ts` — deterministic 50%, 90%, and 100% collateral-loss scenarios.
- `src/sdk/strategies/attribution.ts` — build and validate `strategyId -> intentId -> orderId -> fillId` envelopes.
- `src/sdk/strategies/plan.ts` — attach decision and attribution data to previews; reject execution construction when the selected policy has not accepted it.
- `src/sdk/strategies/index.ts` and `src/sdk/index.ts` — public exports only.
- `src/cli/strategy.ts` — isolated `strategy catalog`, `strategy assess`, and `strategy trace` handlers.
- `src/cli/main.ts` — option declarations and routing only; do not add risk logic here.
- `test/strategies.test.ts` — existing payoff/catalog/plan regression tests.
- `test/risk.test.ts` — risk normalization, unknown-data, Meme warning, and policy tests.
- `test/attribution.test.ts` — deterministic trace and validation tests.
- `test/strategy-cli.test.ts` — JSON contract tests for agent-facing commands.
- `skills/bivium/SKILL.md` — distributable Robinhood Chain Skill.
- `.claude/skills/bivium/SKILL.md` — byte-identical local copy.
- `README.md` — installation and agent-facing command examples.

The hosted frontend API is deliberately outside this plan: its worktree is stale and dirty, while the canonical logic belongs in `@bivium/cli`. A later deployment plan can wrap these stable JSON contracts in HTTP without duplicating calculations.

Scoped session capabilities are also outside this first implementation. The current Core grant is capability-and-expiry based and cannot itself enforce the proposed per-market, amount, and destination limits. Claiming those limits without an enforcing router or smart-account policy would create a false security boundary. This plan therefore retains per-transaction signing as the only executable path and produces the stable plan/decision contracts needed for a separately designed session-capability implementation.

### Task 1: Establish the Robinhood product catalog

**Files:**
- Modify: `src/sdk/strategies/types.ts`
- Modify: `src/sdk/strategies/catalog.ts`
- Modify: `test/strategies.test.ts`

- [ ] **Step 1: Write the failing catalog assertions**

Add to the catalog test:

```ts
assert.equal(getStrategy("earnOnHoldings").id, "lendAsset");
assert.equal(getStrategy("buyAtTarget").id, "lendQuote");
assert.equal(getStrategy("cappedRiskShort").id, "short");
for (const id of ["lendAsset", "lendQuote", "short"]) {
  const strategy = getStrategy(id);
  assert.equal(strategy.initialRelease, true);
  assert.ok(strategy.outcomeLabels.length >= 2);
}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- --test-name-pattern="catalog"`

Expected: FAIL because aliases, `initialRelease`, and `outcomeLabels` do not exist.

- [ ] **Step 3: Add catalog metadata and aliases**

Extend `StrategyDef`:

```ts
export interface StrategyDef {
  // existing fields remain unchanged
  initialRelease: boolean;
  outcomeLabels: readonly string[];
}
```

Set `initialRelease: true` only on `short`, `lendAsset`, and `lendQuote`; set it to `false` on every other entry. Add explicit outcome labels such as `repay-in-loan-token` and `deliver-collateral`, then resolve aliases without changing stable internal IDs:

```ts
const ALIASES: Readonly<Record<string, string>> = {
  earnOnHoldings: "lendAsset",
  buyAtTarget: "lendQuote",
  cappedRiskShort: "short",
};

export function getStrategy(id: string): StrategyDef {
  const canonical = ALIASES[id] ?? id;
  const strategy = STRATEGIES.find((item) => item.id === canonical);
  if (!strategy) throw new Error(`unknown strategy ${JSON.stringify(id)}`);
  return strategy;
}
```

- [ ] **Step 4: Run catalog and type tests**

Run: `npm test -- --test-name-pattern="catalog" && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/strategies/types.ts src/sdk/strategies/catalog.ts test/strategies.test.ts
git commit -m "feat: define initial Robinhood strategy products"
```

### Task 2: Add permissionless risk evidence and policy evaluation

**Files:**
- Modify: `src/sdk/strategies/types.ts`
- Create: `src/sdk/strategies/risk.ts`
- Create: `test/risk.test.ts`
- Modify: `src/sdk/strategies/index.ts`

- [ ] **Step 1: Write failing risk tests**

Create fixtures proving that missing data is unknown and dangerous token powers are warnings:

```ts
test("unknown evidence never becomes a passing check", () => {
  const report = assessRisk({ market: MARKET, collateralKind: "meme", evidence: {} }, DEFAULT_AGENT_POLICY);
  assert.ok(report.unknowns.includes("sellability"));
  assert.equal(report.decision, "require_user_confirmation");
  assert.equal(report.decisionSource, "agent-policy");
});

test("mint and freeze powers are disclosed as facts and warnings", () => {
  const report = assessRisk({
    market: MARKET,
    collateralKind: "meme",
    evidence: { mintable: observed(true), freezable: observed(true) },
  }, DEFAULT_AGENT_POLICY);
  assert.ok(report.warnings.some((warning) => warning.code === "ARBITRARY_MINT"));
  assert.ok(report.warnings.some((warning) => warning.code === "FREEZABLE"));
  assert.notEqual(report.decision, "accept");
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- --test-name-pattern="risk|unknown evidence|mint and freeze"`

Expected: FAIL because `risk.ts` and its types do not exist.

- [ ] **Step 3: Define the risk contract**

Add exact types to `types.ts`:

```ts
export type EvidenceState = "observed" | "warning" | "unknown" | "not_applicable";
export type CollateralKind = "stock-token" | "ai-token" | "meme" | "other";
export type RiskDecision = "accept" | "reject" | "require_user_confirmation";

export interface RiskEvidence<T> {
  state: EvidenceState;
  value?: T;
  source?: string;
  observedAt?: string;
}

export interface RiskWarning { code: string; severity: "info" | "warning" | "critical"; message: string; }
export interface AgentRiskPolicy {
  rejectArbitraryMint: boolean;
  rejectUnsellable: boolean;
  confirmOnUnknown: boolean;
  maxTop10HolderPct?: number;
  maxExitSlippageBps?: number;
}
export interface MarketRiskInput {
  market: string;
  collateralKind: CollateralKind;
  evidence: Partial<Record<"mintable" | "freezable" | "blacklistable" | "upgradeable" | "sellability" | "top10HolderPct" | "exitSlippageBps" | "referencePrice", RiskEvidence<boolean | number | string>>>;
}
export interface MarketRiskReport {
  market: string;
  facts: Array<{ key: string; value: unknown; source?: string; observedAt?: string }>;
  warnings: RiskWarning[];
  unknowns: string[];
  decision: RiskDecision;
  decisionSource: "user-policy" | "agent-policy";
}
```

- [ ] **Step 4: Implement deterministic evaluation**

In `risk.ts`, export `observed`, `unknown`, `DEFAULT_AGENT_POLICY`, and `assessRisk`. Evaluate reject conditions first, then unknown confirmation, then acceptance. Always emit `MEME_DELIVERY_RISK` for Meme collateral and state that Core does not approve assets.

```ts
export const DEFAULT_AGENT_POLICY: AgentRiskPolicy = {
  rejectArbitraryMint: true,
  rejectUnsellable: true,
  confirmOnUnknown: true,
  maxTop10HolderPct: 80,
  maxExitSlippageBps: 2_000,
};

export function observed<T>(value: T, source = "unspecified", observedAt?: string): RiskEvidence<T> {
  return { state: "observed", value, source, observedAt };
}
```

The evaluator must not throw merely because a market is risky; it returns a report so the user's policy remains the authority.

- [ ] **Step 5: Export and verify**

Run: `npm test -- --test-name-pattern="risk|unknown evidence|mint and freeze" && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sdk/strategies/types.ts src/sdk/strategies/risk.ts src/sdk/strategies/index.ts test/risk.test.ts
git commit -m "feat: add agent-controlled market risk evaluation"
```

### Task 3: Add worst-case delivery stress scenarios

**Files:**
- Create: `src/sdk/strategies/stress.ts`
- Modify: `src/sdk/strategies/types.ts`
- Modify: `src/sdk/strategies/index.ts`
- Modify: `test/risk.test.ts`

- [ ] **Step 1: Write failing deterministic stress tests**

```ts
test("lender stress includes 50%, 90%, and total collateral value loss", () => {
  const rows = stressDelivery({ principal: 1_000_000n, collateralValueAtEntry: 1_000_000n });
  assert.deepEqual(rows.map((row) => row.collateralDeclinePct), [50, 90, 100]);
  assert.deepEqual(rows.map((row) => row.estimatedRecovery), [500_000n, 100_000n, 0n]);
  assert.equal(rows.at(-1)?.estimatedPrincipalLossPct, 100);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- --test-name-pattern="lender stress"`

Expected: FAIL because `stressDelivery` is missing.

- [ ] **Step 3: Implement integer-safe stress output**

Define and return:

```ts
export interface DeliveryStress {
  collateralDeclinePct: 50 | 90 | 100;
  estimatedRecovery: bigint;
  estimatedLoss: bigint;
  estimatedPrincipalLossPct: number;
}

export function stressDelivery(input: { principal: bigint; collateralValueAtEntry: bigint }): DeliveryStress[] {
  if (input.principal <= 0n || input.collateralValueAtEntry < 0n) throw new Error("invalid stress inputs");
  return ([50, 90, 100] as const).map((decline) => {
    const recovery = input.collateralValueAtEntry * BigInt(100 - decline) / 100n;
    const cappedRecovery = recovery > input.principal ? input.principal : recovery;
    const loss = input.principal - cappedRecovery;
    return { collateralDeclinePct: decline, estimatedRecovery: cappedRecovery, estimatedLoss: loss, estimatedPrincipalLossPct: Number(loss * 10_000n / input.principal) / 100 };
  });
}
```

- [ ] **Step 4: Run focused and full strategy tests**

Run: `npm test -- --test-name-pattern="stress|payoff|quote" && npm run typecheck`

Expected: PASS with exact bigint recovery values.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/strategies/stress.ts src/sdk/strategies/types.ts src/sdk/strategies/index.ts test/risk.test.ts
git commit -m "feat: expose collateral delivery stress scenarios"
```

### Task 4: Bind previews to policy decisions

**Files:**
- Modify: `src/sdk/strategies/types.ts`
- Modify: `src/sdk/strategies/plan.ts`
- Modify: `test/strategies.test.ts`

- [ ] **Step 1: Write failing plan-boundary tests**

```ts
assert.throws(
  () => buildPlan(res, quote, { now: NOW, core, riskReport: confirmationReport }),
  /risk policy requires user confirmation/,
);
const accepted = buildPlan(res, quote, { now: NOW, core, riskReport: acceptedReport });
assert.equal(accepted.riskDecision, "accept");
assert.equal(accepted.marketId, quote.marketId);
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- --test-name-pattern="quote \+ plan"`

Expected: FAIL because plans do not carry a risk decision or market ID.

- [ ] **Step 3: Add explicit decision binding**

Extend `PlanOptions` with `riskReport?: MarketRiskReport` and `Plan` with `marketId: Hex`, `riskDecision: RiskDecision | "not_evaluated"`, and `riskWarnings: string[]`. When a report is supplied, require its market to equal `quote.marketId`; reject `reject`, and reject `require_user_confirmation` until the caller supplies a second report whose `decisionSource` is `user-policy` and decision is `accept`.

```ts
if (opts.riskReport && opts.riskReport.market !== quote.marketId) {
  throw new Error("risk report market does not match quote");
}
if (opts.riskReport?.decision === "reject") throw new Error("risk policy rejected this plan");
if (opts.riskReport?.decision === "require_user_confirmation") {
  throw new Error("risk policy requires user confirmation");
}
```

Do not make a risk report a protocol requirement: callers without one receive `not_evaluated`, preserving permissionless SDK use.

- [ ] **Step 4: Verify plan behavior**

Run: `npm test -- --test-name-pattern="quote \+ plan" && npm run typecheck`

Expected: PASS; plan hashes remain deterministic for unchanged economic inputs.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/strategies/types.ts src/sdk/strategies/plan.ts test/strategies.test.ts
git commit -m "feat: bind strategy previews to agent risk decisions"
```

### Task 5: Add strategy attribution envelopes

**Files:**
- Create: `src/sdk/strategies/attribution.ts`
- Modify: `src/sdk/strategies/types.ts`
- Modify: `src/sdk/strategies/index.ts`
- Create: `test/attribution.test.ts`

- [ ] **Step 1: Write failing attribution tests**

```ts
test("trace links strategy through fill without changing prior identifiers", () => {
  const intent = startTrace({ strategyId: "lendQuote", account: USER, quoteId: QUOTE });
  const ordered = withOrder(intent, ORDER);
  const filled = withFill(ordered, FILL);
  assert.deepEqual(filled, { strategyId: "lendQuote", account: USER, quoteId: QUOTE, intentId: intent.intentId, orderId: ORDER, fillId: FILL });
  assert.throws(() => withFill(intent, FILL), /orderId is required/);
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- --test-name-pattern="trace links"`

Expected: FAIL because the attribution functions do not exist.

- [ ] **Step 3: Implement immutable trace builders**

Use `keccak256(encodeAbiParameters(...))` to derive `intentId` from chain ID, Core, account, strategy ID, quote ID, and nonce. Return new objects from `withOrder` and `withFill`; never mutate or replace earlier identifiers.

```ts
export interface StrategyTrace {
  strategyId: string;
  account: Address;
  quoteId: Hex;
  intentId: Hex;
  orderId?: Hex;
  fillId?: Hex;
}
```

Validate every ID as `bytes32` and every account as an address. Attribution is reporting metadata; it must not enter Core market identity.

- [ ] **Step 4: Verify attribution and exports**

Run: `npm test -- --test-name-pattern="trace|attribution" && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/strategies/attribution.ts src/sdk/strategies/types.ts src/sdk/strategies/index.ts test/attribution.test.ts
git commit -m "feat: preserve strategy attribution across execution"
```

### Task 6: Expose stable agent JSON commands

**Files:**
- Create: `src/cli/strategy.ts`
- Modify: `src/cli/main.ts`
- Create: `test/strategy-cli.test.ts`
- Create: `test/fixtures/meme-risk.json`

- [ ] **Step 1: Write failing CLI contract tests**

Spawn the CLI with the same `tsx` runtime used by existing tests and assert:

```ts
const catalog = await runCli(["strategy", "catalog", "--json"]);
assert.equal(catalog.status, 0);
assert.deepEqual(JSON.parse(catalog.stdout).initialRelease, ["lendAsset", "lendQuote", "short"]);

const assessed = await runCli(["strategy", "assess", "--risk-file", fixture, "--json"]);
assert.equal(JSON.parse(assessed.stdout).decisionSource, "agent-policy");
assert.match(assessed.stdout, /MEME_DELIVERY_RISK/);
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- --test-name-pattern="strategy CLI"`

Expected: FAIL with an unknown command or option.

- [ ] **Step 3: Add an isolated CLI handler**

Export `runStrategyCommand(command, values)` from `src/cli/strategy.ts`. `catalog` returns `catalogJson()` plus aliases and initial-release IDs. `assess` reads a JSON `MarketRiskInput`, evaluates it with the default policy, and includes delivery stress when `principal` and `collateralValueAtEntry` are present. `trace` accepts chain/Core/account/strategy/quote/nonce fields and returns `startTrace(...)`.

All three commands require `--json`; they are agent contracts, not interactive wizards. Parse file input with a strict object check and return a nonzero exit for malformed JSON.

Create `test/fixtures/meme-risk.json` as the stable smoke-test input:

```json
{
  "market": "0x0000000000000000000000000000000000000000000000000000000000000001",
  "collateralKind": "meme",
  "evidence": {
    "mintable": { "state": "observed", "value": true, "source": "fixture" },
    "sellability": { "state": "unknown", "source": "fixture" }
  },
  "principal": "1000000",
  "collateralValueAtEntry": "1000000"
}
```

- [ ] **Step 4: Wire command routing only**

Add these usage lines and options to `main.ts`:

```text
strategy catalog --json
strategy assess --risk-file <json> --json
strategy trace --strategy-id <id> --quote-id <bytes32> --nonce <n> --account <addr> --json
```

Route the three command keys to `runStrategyCommand`; do not duplicate evaluator logic in `main.ts`.

- [ ] **Step 5: Verify CLI contracts**

Run: `npm test -- --test-name-pattern="strategy CLI" && npm run typecheck`

Expected: PASS with parseable JSON and no signing-key requirement.

- [ ] **Step 6: Commit**

```bash
git add src/cli/strategy.ts src/cli/main.ts test/strategy-cli.test.ts test/fixtures/meme-risk.json
git commit -m "feat: expose agent strategy JSON commands"
```

### Task 7: Rewrite and synchronize the public Skill

**Files:**
- Modify: `skills/bivium/SKILL.md`
- Modify: `.claude/skills/bivium/SKILL.md`
- Modify: `test/skill-sync.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing Skill assertions**

Extend `test/skill-sync.test.ts`:

```ts
for (const required of [
  "Robinhood Chain",
  "immutable",
  "non-upgradeable",
  "permissionless",
  "MEME_DELIVERY_RISK",
  "strategy assess",
  "require_user_confirmation",
]) assert.match(dist, new RegExp(required, "i"));

assert.doesNotMatch(dist, /Bivium Core (approves|allowlists|pauses)/i);
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- --test-name-pattern="distributable skill"`

Expected: FAIL because the current Skill lacks the confirmed risk and trust-boundary text.

- [ ] **Step 3: Rewrite the Skill around agent goals**

Keep setup and operational safety instructions that remain correct, but change the top-level flow to:

```text
discover existing market
-> strategy catalog/resolve
-> gather risk evidence
-> strategy assess
-> show repay and delivery outcomes plus stress cases
-> obtain user-policy acceptance when required
-> preview
-> sign/execute
-> report order/fill/position attribution
```

State explicitly that Core has no administrator, cannot be upgraded, cannot pause or allowlist assets, and cannot prevent a rug pull. For Meme collateral funding, require the warning that a correctly settled position can still lose all economic principal. Describe external Stock Token, price, wallet, and swap Skills as optional evidence/execution providers, never protocol truth.

Limit executable deployment instructions to Robinhood Chain testnet `46630`. Mention mainnet `4663` for identity validation only and state that mainnet execution requires a separately approved release.

- [ ] **Step 4: Synchronize the local copy mechanically**

Run: `cp skills/bivium/SKILL.md .claude/skills/bivium/SKILL.md`

Expected: the two files have identical hashes.

- [ ] **Step 5: Update README installation and examples**

Document the three JSON commands, the user-signature default, optional future scoped sessions, and the separation between Robinhood Agentic brokerage execution and Robinhood Chain execution.

- [ ] **Step 6: Verify Skill packaging**

Run: `npm test -- --test-name-pattern="distributable skill" && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add skills/bivium/SKILL.md .claude/skills/bivium/SKILL.md test/skill-sync.test.ts README.md
git commit -m "docs: publish Robinhood Chain agent risk workflow"
```

### Task 8: Full verification and handoff

**Files:**
- Modify only files needed to correct failures caused by Tasks 1-7.

- [ ] **Step 1: Run the complete automated suite**

Run: `npm test`

Expected: all Node test cases PASS with zero failures.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck && git diff --check`

Expected: both commands exit 0 and `git diff --check` prints nothing.

- [ ] **Step 3: Smoke-test agent output**

Run:

```bash
npm run cli --silent -- strategy catalog --json
npm run cli --silent -- strategy assess --risk-file test/fixtures/meme-risk.json --json
```

Expected: the first command lists exactly three `initialRelease` strategies; the second includes facts, warnings, unknowns, the three stress scenarios, `MEME_DELIVERY_RISK`, and a policy-owned decision.

- [ ] **Step 4: Confirm Core remains untouched**

Run: `git diff HEAD~7 --name-only | rg '(^|/)(src/.*\.sol|bivium-core/)'`

Expected: no output. If the number of implementation commits differs, compare against commit `effde7a` instead.

- [ ] **Step 5: Record final verification**

Add the exact test counts and command results to the pull-request description. Do not claim mainnet readiness, asset safety, or rug prevention.

- [ ] **Step 6: Finish with a clean verification state**

Run: `git status --short`

Expected: no uncommitted implementation changes. If verification exposed a defect, return to the task that owns that file, add a focused regression test, apply the minimal correction, rerun that task's verification commands, and commit it with `fix: correct Robinhood agent verification failure` before repeating Steps 1-5.
