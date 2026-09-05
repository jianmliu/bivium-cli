import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeAbiParameters, recoverAddress, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { adapterFor } from "../src/sdk/lineage.ts";
import { RATIFIED, ratifyDigest } from "../src/sdk/ratify.ts";
import type { DeploymentProfile, Hex, MarketParams, SignedOfferFile } from "../src/sdk/types.ts";

// Public Anvil fixture key: never funded; this fixture permits only read-only loopback RPC.
const ANVIL0_PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const NOW = 1_800_000_000;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CREDIT = toFunctionSelector("creditOf(bytes32,address)");
const ESCROW = toFunctionSelector("collateralEscrowOf(bytes32,address)");
type Fixture = {
  lineage?: "core-v1" | "core-v2";
  credit?: bigint | "unavailable";
  escrow?: bigint | "unavailable";
  maturity?: number;
  side?: "buy" | "sell";
};

async function makeOffer(f: Fixture = {}) {
  const calls: string[] = [], writes: string[] = [];
  const profile: DeploymentProfile = {
    name: "read-only-maker-fixture", chainId: 46630, abiProfile: f.lineage ?? "core-v2",
    core: `0x${"33".repeat(20)}`, signatureRatifier: `0x${"44".repeat(20)}`, rpcUrl: "",
    tokens: {
      TESTLOAN: { address: `0x${"11".repeat(20)}`, decimals: 0 },
      TESTCOLL: { address: `0x${"22".repeat(20)}`, decimals: 0 },
    },
  };
  const adapter = adapterFor(profile.abiProfile);
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    try {
      let result: unknown;
      if (rpc.method === "eth_chainId") result = "0xb626";
      else if (rpc.method === "eth_getBlockByNumber") result = { number: "0x1", timestamp: `0x${NOW.toString(16)}`, hash: `0x${"55".repeat(32)}`, transactions: [] };
      else if (rpc.method === "eth_call") {
        const selector = rpc.params[0].data.slice(0, 10); calls.push(selector);
        if (selector === CREDIT || selector === ESCROW) {
          const value = selector === CREDIT ? f.credit ?? 7n : f.escrow ?? "unavailable";
          if (value === "unavailable") throw new Error(`fixture ${selector === CREDIT ? "creditOf" : "collateralEscrowOf"} unavailable`);
          result = encodeAbiParameters([{ type: "uint256" }], [value]);
        } else if (rpc.params[0].to.toLowerCase() === profile.signatureRatifier.toLowerCase()) {
          result = RATIFIED;
        } else {
          const call = decodeFunctionData({ abi: adapter.coreAbi, data: rpc.params[0].data });
          if (call.functionName === "computeId") result = adapter.computeMarketId(profile, (call.args as unknown[])[0] as MarketParams);
          else if (call.functionName === "isRatifier") result = encodeAbiParameters([{ type: "bool" }], [true]);
          else if (["consumed", "liquidityOf"].includes(call.functionName)) result = encodeAbiParameters([{ type: "uint256" }], [0n]);
          else throw new Error(`unexpected read ${call.functionName}`);
        }
      } else { writes.push(rpc.method); throw new Error(`non-read RPC forbidden: ${rpc.method}`); }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch (error) { res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: String(error) } })); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  profile.rpcUrl = `http://127.0.0.1:${address.port}`;
  const dir = mkdtempSync(join(tmpdir(), "bivium-maker-offer-"));
  try {
    const profileFile = join(dir, "profile.json"), outputFile = join(dir, "offer.json");
    writeFileSync(profileFile, JSON.stringify(profile));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,Date.now=()=>${NOW * 1000}`,
        "src/cli/main.ts", "maker", "make-offer", "--side", f.side ?? "sell", "--tick", "4000", "--max-units", "7",
        "--loan", "TESTLOAN", "--collateral", "TESTCOLL", "--strike", (3n * 10n ** 36n).toString(),
        "--maturity", String(f.maturity ?? NOW + 1000), "--ratifier", "signature", "--profile", profileFile, "--out", outputFile, "--json"],
      { cwd: root, env: { ...process.env, BIVIUM_PROFILE: "", BIVIUM_PK: ANVIL0_PK } });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    const file: SignedOfferFile | undefined = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, "utf8")) : undefined;
    assert.deepEqual(writes, [], "offer creation must never publish or submit transactions");
    if (file) {
      assert.equal(JSON.parse(result.stdout).published, false);
      const recovered = await recoverAddress({ hash: ratifyDigest(profile.chainId, profile.signatureRatifier, file.commitment), signature: file.signature });
      assert.equal(recovered, privateKeyToAccount(ANVIL0_PK).address);
    }
    return { ...result, calls, file };
  } finally {
    rmSync(dir, { recursive: true, force: true }); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

for (const lineage of ["core-v1", "core-v2"] as const) {
  for (const escrow of [0n, "unavailable"] as const) {
    test(`${lineage}: held credit covers sell with ${escrow} escrow without reading escrow`, async () => {
      const result = await makeOffer({ lineage, credit: 7n, escrow });
      assert.equal(result.code, 0, result.stderr); assert.ok(result.file);
      assert.equal(result.calls.filter(c => c === CREDIT).length, 1);
      assert.ok(!result.calls.includes(ESCROW));
    });
  }
}

test("mixed held credit and exact rounded-up escrow back only newly issued units", async () => {
  // 7 units minus 3 held = 4 issued; ceil(4 / 3) = 2 collateral atomic units, not ceil(7 / 3) = 3.
  const result = await makeOffer({ credit: 3n, escrow: 2n });
  assert.equal(result.code, 0, result.stderr); assert.ok(result.file);
  assert.deepEqual(result.calls.slice(0, 2), [CREDIT, ESCROW]);
});

test("one atomic unit below mixed backing refuses and offers debt-free alternatives", async () => {
  const result = await makeOffer({ credit: 3n, escrow: 1n });
  assert.notEqual(result.code, 0); assert.equal(result.file, undefined);
  assert.match(result.stderr, /reduce/i); assert.match(result.stderr, /acquir.*credit|obtain.*credit/i);
  assert.match(result.stderr, /collateral-backed issuance adds debt/i);
});

test("pure collateral escrow still supports new issuance before maturity", async () => {
  const result = await makeOffer({ credit: 0n, escrow: 3n });
  assert.equal(result.code, 0, result.stderr); assert.ok(result.file);
  assert.deepEqual(result.calls.slice(0, 2), [CREDIT, ESCROW]);
});

test("insufficient held credit and escrow do not emit an offer", async () => {
  const result = await makeOffer({ credit: 0n, escrow: 0n });
  assert.notEqual(result.code, 0); assert.equal(result.file, undefined);
  assert.match(result.stderr, /credit/i); assert.match(result.stderr, /adds debt/i);
});

test("failed held-credit read stops before trying escrow or emitting an offer", async () => {
  const result = await makeOffer({ credit: "unavailable", escrow: 100n });
  assert.notEqual(result.code, 0); assert.equal(result.file, undefined);
  assert.match(result.stderr, /creditOf/); assert.ok(!result.calls.includes(ESCROW));
});

test("unavailable escrow for uncovered units is an actionable failure, not zero backing", async () => {
  const result = await makeOffer({ credit: 3n, escrow: "unavailable" });
  assert.notEqual(result.code, 0); assert.equal(result.file, undefined);
  assert.match(result.stderr, /collateralEscrowOf/); assert.match(result.stderr, /unsupported|compatible/i);
  assert.match(result.stderr, /RPC/); assert.match(result.stderr, /refusing to assume/i);
});

for (const maturity of [NOW, NOW - 1]) {
  test(`held-credit transfer remains allowed ${maturity === NOW ? "at" : "after"} maturity`, async () => {
    const result = await makeOffer({ credit: 7n, escrow: "unavailable", maturity });
    assert.equal(result.code, 0, result.stderr); assert.ok(result.file); assert.ok(!result.calls.includes(ESCROW));
  });
  test(`uncovered issuance is rejected ${maturity === NOW ? "at" : "after"} maturity before reading escrow`, async () => {
    const result = await makeOffer({ credit: 6n, escrow: 100n, maturity });
    assert.notEqual(result.code, 0); assert.equal(result.file, undefined);
    assert.match(result.stderr, /matur/i); assert.ok(!result.calls.includes(ESCROW));
  });
}

test("buy offer path does not inherit sell credit or escrow checks", async () => {
  const result = await makeOffer({ side: "buy", credit: "unavailable", escrow: "unavailable" });
  assert.equal(result.code, 0, result.stderr); assert.ok(result.file);
  assert.ok(!result.calls.includes(CREDIT)); assert.ok(!result.calls.includes(ESCROW));
});
