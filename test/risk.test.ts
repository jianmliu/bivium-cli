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
});

test("complete benign evidence is accepted", () => {
  const report = assessRisk(benign());

  assert.equal(report.decision, "accept");
  assert.deepEqual(report.unknowns, []);
  assert.equal(report.warnings.length, 0);
});

test("caller can identify a user policy as the decision source", () => {
  const report = assessRisk(benign(), { maxTop10HolderPct: 50 }, "user-policy");

  assert.equal(report.decision, "accept");
  assert.equal(report.decisionSource, "user-policy");
});

test("a reject condition wins over unknown evidence deterministically", () => {
  const input = benign();
  input.evidence.sellability = observed(false, "venue check", at);
  input.evidence.referencePrice = unknown("feed unavailable", at);

  const report = assessRisk(input);

  assert.equal(report.decision, "reject");
  assert.deepEqual(report.unknowns, ["referencePrice"]);
});
