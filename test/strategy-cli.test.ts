import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = join(root, "profiles/robinhood-testnet.json");
const fixture = join(root, "test/fixtures/meme-risk.json");

function cli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...args, "--profile", profile], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, BIVIUM_PK: "", BIVIUM_PROFILE: "" },
  });
}

test("strategy CLI: catalog emits aliases and a stable initial release", () => {
  const result = cli(["strategy", "catalog", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.ok(Array.isArray(body.catalog));
  assert.deepEqual(body.aliases, {
    earnOnHoldings: "lendAsset",
    buyAtTarget: "lendQuote",
    cappedRiskShort: "short",
  });
  assert.deepEqual(body.initialRelease, ["lendAsset", "lendQuote", "short"]);
});

test("strategy CLI: commands require JSON mode", () => {
  const result = cli(["strategy", "catalog"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--json is required/i);
});

test("strategy CLI: assess validates a Meme risk file and includes stress scenarios", () => {
  const result = cli(["strategy", "assess", "--risk-file", fixture, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.decisionSource, "agent-policy");
  assert.ok(body.warnings.some((warning: { code: string }) => warning.code === "MEME_DELIVERY_RISK"));
  assert.deepEqual(body.stress.map((scenario: { estimatedRecovery: string }) => scenario.estimatedRecovery), ["500000", "100000", "0"]);
});

test("strategy CLI: assess rejects malformed JSON and schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "bivium-risk-"));
  const malformedPath = join(dir, "malformed.json");
  writeFileSync(malformedPath, "{ nope");
  try {
    const malformed = cli(["strategy", "assess", "--risk-file", malformedPath, "--json"]);
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /invalid risk JSON/i);

    const wrongSchema = cli(["strategy", "assess", "--risk-file", profile, "--json"]);
    assert.notEqual(wrongSchema.status, 0);
    assert.match(wrongSchema.stderr, /risk/i);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("strategy CLI: trace uses the profile domain and needs no signing key", () => {
  const quoteId = `0x${"22".repeat(32)}`;
  const account = "0x00000000000000000000000000000000000000A1";
  const result = cli([
    "strategy", "trace", "--strategy-id", "short", "--quote-id", quoteId,
    "--nonce", "7", "--account", account, "--json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.strategyId, "short");
  assert.equal(body.quoteId, quoteId);
  assert.equal(body.account.toLowerCase(), account.toLowerCase());
  assert.match(body.intentId, /^0x[0-9a-f]{64}$/);
});
