import assert from "node:assert/strict";
import test from "node:test";
import {
  assessRisk,
  observed,
  unknown,
  type MarketRiskInput,
} from "../src/sdk/strategies/index.ts";

const at = "2026-09-02T12:00:00.000Z";

function benign(overrides: Partial<MarketRiskInput> = {}): MarketRiskInput {
  return {
    market: "0xmarket",
    collateralKind: "stock-token",
    evidence: {
      mintable: observed(false, "issuer docs", at),
      freezable: observed(false, "contract review", at),
      blacklistable: observed(false, "contract review", at),
      upgradeable: observed(false, "contract review", at),
      sellability: observed(true, "venue check", at),
      top10HolderPct: observed(40, "holder scan", at),
      exitSlippageBps: observed(250, "exit quote", at),
      referencePrice: observed(100, "price feed", at),
    },
    ...overrides,
  };
}

test("unknown sellability requires user confirmation rather than passing", () => {
  const input = benign();
  input.evidence.sellability = unknown("venue unavailable", at);

  const report = assessRisk(input);

  assert.equal(report.decision, "require_user_confirmation");
  assert.deepEqual(report.unknowns, ["sellability"]);
});

test("arbitrary mint is rejected and freezability is also reported", () => {
  const input = benign();
  input.evidence.mintable = observed(true, "contract review", at);
  input.evidence.freezable = observed(true, "contract review", at);

  const report = assessRisk(input);

  assert.equal(report.decision, "reject");
  assert.deepEqual(report.warnings.map(({ code }) => code), ["ARBITRARY_MINT", "FREEZABLE"]);
});

test("meme collateral always carries delivery risk and Core approval disclaimer", () => {
  const report = assessRisk(benign({ collateralKind: "meme" }));
  const warning = report.warnings.find(({ code }) => code === "MEME_DELIVERY_RISK");

  assert.ok(warning);
  assert.match(warning.message, /Core does not approve assets/i);
  assert.match(warning.message, /borrower may rationally not repay/i);
  assert.match(warning.message, /severely impaired or worthless Meme/i);
  assert.match(warning.message, /all economically recoverable principal is lost/i);
});

test("complete benign evidence is accepted", () => {
  const report = assessRisk(benign());

  assert.equal(report.decision, "accept");
  assert.deepEqual(report.unknowns, []);
  assert.equal(report.warnings.length, 0);
});

test("caller can identify a user policy as the decision source", () => {
  const report = assessRisk(benign(), {
    source: "user-policy",
    rules: {
      rejectArbitraryMint: true,
      rejectUnsellable: true,
      confirmOnUnknown: true,
      maxTop10HolderPct: 50,
      maxExitSlippageBps: 2_000,
    },
  });

  assert.equal(report.decision, "accept");
  assert.equal(report.decisionSource, "user-policy");
});

test("malformed JSON evidence fails closed instead of being treated as benign", () => {
  const malformed: Array<[string, unknown]> = [
    ["mintable", "true"],
    ["sellability", "false"],
    ["top10HolderPct", "40"],
    ["exitSlippageBps", Number.NaN],
    ["exitSlippageBps", Number.POSITIVE_INFINITY],
    ["referencePrice", Number.NEGATIVE_INFINITY],
  ];

  for (const [key, value] of malformed) {
    const input = benign();
    // Models data arriving from an untyped JSON boundary.
    (input.evidence as Record<string, unknown>)[key] = observed(value);
    const report = assessRisk(input);
    assert.notEqual(report.decision, "accept", `${key}=${String(value)} must not pass`);
    assert.ok(report.unknowns.includes(key), `${key} must be classified unknown`);
  }
});

test("malformed evidence cannot be accepted by disabling ordinary unknown confirmation", () => {
  const input = benign();
  (input.evidence as Record<string, unknown>).mintable = observed("false");

  const report = assessRisk(input, {
    source: "user-policy",
    rules: {
      rejectArbitraryMint: true,
      rejectUnsellable: true,
      confirmOnUnknown: false,
    },
  });

  assert.notEqual(report.decision, "accept");
  assert.ok(report.unknowns.includes("mintable"));
});

test("out-of-domain numeric evidence is unknown and cannot pass", () => {
  const invalid: Array<[string, number]> = [
    ["top10HolderPct", -1],
    ["top10HolderPct", 101],
    ["exitSlippageBps", -1],
    ["referencePrice", 0],
    ["referencePrice", -1],
  ];

  for (const [key, value] of invalid) {
    const input = benign();
    (input.evidence as Record<string, unknown>)[key] = observed(value);
    const report = assessRisk(input);
    assert.notEqual(report.decision, "accept", `${key}=${value} must not pass`);
    assert.ok(report.unknowns.includes(key));
  }
});

test("invalid policy thresholds are rejected explicitly", () => {
  const invalid: Array<["maxTop10HolderPct" | "maxExitSlippageBps", number]> = [
    ["maxTop10HolderPct", -1],
    ["maxTop10HolderPct", 101],
    ["maxTop10HolderPct", Number.NaN],
    ["maxTop10HolderPct", Number.POSITIVE_INFINITY],
    ["maxExitSlippageBps", -1],
    ["maxExitSlippageBps", Number.NaN],
    ["maxExitSlippageBps", Number.POSITIVE_INFINITY],
  ];

  for (const [key, value] of invalid) {
    assert.throws(() => assessRisk(benign(), {
      source: "user-policy",
      rules: {
        rejectArbitraryMint: true,
        rejectUnsellable: true,
        confirmOnUnknown: true,
        [key]: value,
      },
    }), /invalid risk policy/i, `${key}=${String(value)} must throw`);
  }
});

test("a reject condition wins over unknown evidence deterministically", () => {
  const input = benign();
  input.evidence.sellability = observed(false, "venue check", at);
  input.evidence.referencePrice = unknown("feed unavailable", at);

  const report = assessRisk(input);

  assert.equal(report.decision, "reject");
  assert.deepEqual(report.unknowns, ["referencePrice"]);
});
