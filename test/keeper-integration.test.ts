import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { boundedKeeperAbi } from "../src/sdk/settler.ts";
import * as sdk from "../src/sdk/settler.ts";

const script = new URL("../scripts/check-keeper-integration.mjs", import.meta.url);
const fixture = new URL("./fixtures/keeper-v2/core-abi.json", import.meta.url);
async function checker() {
  assert.ok(existsSync(script), "focused keeper integration checker must exist");
  return import(script.href);
}

test("portable evidence: compiled Core fixture and actual CLI ABI/calldata agree", async () => {
  const c = await checker();
  const report = await c.checkPortable();
  assert.equal(report.evidence, "PORTABLE_SYNTHETIC");
  assert.equal(report.vectors, 4);
  assert.equal(report.selector, "0xf1f3503a");
});

test("portable ABI checker rejects selector, recursive tuple order and indexed drift", async () => {
  const c = await checker();
  const core = JSON.parse(readFileSync(fixture, "utf8"));
  c.assertBoundedAbi(core, boundedKeeperAbi, "CLI");
  for (const mutate of [
    (a: any[]) => { a.find(x => x.type === "function").name = "settleWithFlash"; },
    (a: any[]) => { const p = a.find(x => x.type === "function").inputs[0].components; [p[0], p[1]] = [p[1], p[0]]; },
    (a: any[]) => { const p = a.find(x => x.type === "function").inputs[5].components; [p[0], p[1]] = [p[1], p[0]]; },
    (a: any[]) => { a.find(x => x.type === "event").inputs[0].indexed = false; },
  ]) {
    const changed = structuredClone(boundedKeeperAbi) as unknown as any[]; mutate(changed);
    assert.throws(() => c.assertBoundedAbi(core, changed, "mutated"), /ABI|selector|missing/);
  }
  const harmless = structuredClone(core);
  harmless.find((x: any) => x.type === "function").outputs[0].name = "irrelevantOutputLabel";
  harmless.find((x: any) => x.type === "function").inputs[0].internalType = "irrelevantInternalType";
  c.assertBoundedAbi(core, harmless, "harmless metadata");
});

test("portable SDK capture rejects wrong transaction target and nonzero native value", async () => {
  const c = await checker();
  const vector = JSON.parse(readFileSync(new URL("./fixtures/keeper-v2/vectors.json", import.meta.url), "utf8"))[0];
  for (const [change, expected] of [
    [{ address: vector.policy.core.address }, /target differs/],
    [{ value: 1n }, /native value/],
  ] as const) {
    class MutatedWriteClient extends sdk.SettlerClient {
      override settleWithFlashBounded(...args: Parameters<sdk.SettlerClient["settleWithFlashBounded"]>) {
        const capture = (this as any).write;
        (this as any).write = (request: any) => capture({ ...request, ...change });
        return super.settleWithFlashBounded(...args);
      }
    }
    await assert.rejects(c.cliCalldata({ ...sdk, SettlerClient: MutatedWriteClient }, vector), expected);
  }
});

test("provenance rejects missing commits, manifest source hash drift and runtime byte drift", async () => {
  const c = await checker(), root = mkdtempSync(join(tmpdir(), "keeper-provenance-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
  try {
    git("init", "-q", "--template="); writeFileSync(join(root, "source.ts"), "export const synthetic = true;\n");
    git("add", "source.ts"); git("-c", "user.name=Synthetic Test", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "synthetic provenance fixture");
    const commit = git("rev-parse", "HEAD");
    const hash = createHash("sha256").update(readFileSync(join(root, "source.ts"))).digest("hex");
    const pin = { commit, files: { "source.ts": hash } };
    c.verifySourcePin(root, pin, "synthetic");
    assert.throws(() => c.verifySourcePin(root, { ...pin, commit: "0".repeat(40) }, "synthetic"), /missing commit/);
    assert.throws(() => c.verifySourcePin(root, { ...pin, files: { "source.ts": "0".repeat(64) } }, "synthetic"), /source hash/);
    writeFileSync(join(root, "source.ts"), "export const synthetic = false;\n");
    assert.throws(() => c.verifySourcePin(root, pin, "synthetic"), /runtime.*drift/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("explicit cross-repository command fails without both roots; never fixture-only success", async () => {
  await checker();
  for (const args of [[], ["--core-root", "/missing"], ["--core-root", "/missing", "--mm-root", "/missing"]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script.pathname, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required|missing|ENOENT/);
    assert.doesNotMatch(result.stdout, /PASS|PORTABLE_SYNTHETIC/);
  }
});
