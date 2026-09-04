import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { toFunctionSelector } from "viem";
import { adapterFor } from "../src/sdk/lineage.ts";
import { buildSignedOfferFile } from "../src/sdk/offer.ts";
import { fillCost } from "../src/sdk/strategies/program.ts";
import type { DeploymentProfile, Hex, Offer } from "../src/sdk/types.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const BORROW_FEE = toFunctionSelector("FEE_BPS()");
const LENDER_FEE = toFunctionSelector("LENDER_FEE_BPS()");
const QUOTE_BID = toFunctionSelector("quoteLeg(uint256,uint256)");

async function program(strategy: string, answers: Record<string, Hex>, buy = false) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    const selector = rpc.params?.[0]?.data?.slice(0, 10) ?? rpc.method;
    calls.push(selector);
    const result = answers[selector];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result === undefined
      ? { jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "execution reverted: unavailable fee read" } }
      : { jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const dir = mkdtempSync(join(tmpdir(), "bivium-router-fee-"));
  try {
    const profile: DeploymentProfile = JSON.parse(readFileSync(join(root, "profiles/robinhood-testnet.json"), "utf8"));
    profile.rpcUrl = `http://127.0.0.1:${address.port}`;
    const offer: Offer = {
      loanToken: profile.tokens!.bUSD.address, collateralToken: profile.tokens!.mNVDA.address,
      maturity: 2_000_000_000n, strike: 125n * 10n ** 24n, allowPartialRepay: false,
      gate: "0x0000000000000000000000000000000000000000", maker: profile.core,
      buy, tick: 4000n, maxUnits: 10n ** 30n, maxAssets: 0n, start: 0n, expiry: 2_000_000_000n,
      group: `0x${"11".repeat(32)}`, ratifier: profile.signatureRatifier,
    };
    const commitment = adapterFor(profile.abiProfile).offerCommitment(profile, offer);
    const offerFile = join(dir, "offer.json");
    const profileFile = join(dir, "profile.json");
    writeFileSync(offerFile, JSON.stringify(buildSignedOfferFile(profile, offer, commitment, "0x")));
    writeFileSync(profileFile, JSON.stringify(profile));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", "strategy", "program",
        "--strategy", strategy, "--offer", offerFile, "--units", "2.000001", "--min-out", "0.001",
        "--profile", profileFile, "--json"], {
        cwd: root, env: { ...process.env, BIVIUM_PK: "", BIVIUM_PROFILE: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    return { ...result, calls, offer };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("strategy program approves the full ask cost plus the independently read lender fee", async () => {
  const result = await program("lendQuote", { [BORROW_FEE]: `0x${word(2_000n)}`, [LENDER_FEE]: `0x${word(1_000n)}` });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  const cost = fillCost(result.offer, 2_000_001n);
  const fee = (2_000_001n - cost) * 1_000n / 10_000n;
  assert.equal(body.derived.fee, fee.toString());
  assert.equal(body.derived.costWithFee, (cost + fee).toString());
  assert.equal(body.approvals[0].amount, (cost + fee).toString());
  assert.deepEqual(result.calls, [LENDER_FEE], "an ask does not need the borrow-side fee getter");
});

test("an older router without LENDER_FEE_BPS refuses to quote and explains how to proceed", async () => {
  const result = await program("lendQuote", { [BORROW_FEE]: `0x${word(0n)}` });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /LENDER_FEE_BPS/);
  assert.match(result.stderr, /unsupported|compatible/i);
  assert.match(result.stderr, /re-?quote/i);
  assert.equal(result.stdout, "");
});

test("a failed borrower fee read never silently builds a zero-fee bid", async () => {
  const result = await program("protectivePut", {}, true);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /FEE_BPS|unavailable fee read/);
  assert.equal(result.stdout, "");
});

test("a failed swap principal quote never silently spends the uncharged core cost", async () => {
  const result = await program("leveredLong", { [BORROW_FEE]: `0x${word(1_000n)}` }, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.calls.includes(QUOTE_BID));
  assert.equal(result.stdout, "");
});
