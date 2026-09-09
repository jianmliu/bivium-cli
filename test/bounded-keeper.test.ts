import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, type Abi, type Address, type Hex } from "viem";
import * as sdk from "../src/sdk/index.ts";
import * as keeper from "../src/sdk/settler.ts";
import { ZERO_ADDRESS, type DeploymentProfile, type MarketParams } from "../src/sdk/types.ts";
import * as cli from "../src/cli/main.ts";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const profile: DeploymentProfile = { name: "offline", chainId: 46630, abiProfile: "core-v2", rpcUrl: "http://127.0.0.1:1", core: address(1), signatureRatifier: address(2), maturitySettler: address(3), v4JitKeeper: address(4), morphoJitFunder: address(5) };
const params: MarketParams = { loanToken: address(10), collateralToken: address(20), maturity: 2000n, strike: 10n ** 36n, allowPartialRepay: true, gate: ZERO_ADDRESS };
const bounds = { deadline: 1900n, maxDebt: 101n, maxLoanBalance: 23n, maxCollateralBalance: 0n };
// Independent declaration of the authoritative Core tuple, not a re-export of the SDK ABI.
const coreBoundedAbi = parseAbi([
  "function settleWithFlashBounded((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params,address borrower,uint256 collateralAsk,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key,uint256 minProfit,(uint256 deadline,uint256 maxDebt,uint256 maxLoanBalance,uint256 maxCollateralBalance) bounds) returns(uint256)",
]);

test("bounded SDK exports its method/ABI and exactly encodes Core tuple order in both orientations", async () => {
  assert.equal(typeof (sdk as any).SettlerClient, "function");
  assert.ok((keeper as any).boundedKeeperAbi);
  for (const p of [params, { ...params, loanToken: params.collateralToken, collateralToken: params.loanToken }]) {
    const client = new keeper.SettlerClient(profile, undefined, profile.maturitySettler!);
    let data: `0x${string}` | undefined;
    (client as any).write = async (request: any) => { data = encodeFunctionData(request); return { hash: "0x01", gasUsed: 1n, blockNumber: 1n }; };
    const key = keeper.poolKeyFor(p.collateralToken, p.loanToken, 3000, 60, ZERO_ADDRESS);
    await (client as any).settleWithFlashBounded(address(6), p, address(7), 99n, key, 2n, bounds);
    const expected = encodeFunctionData({ abi: coreBoundedAbi, functionName: "settleWithFlashBounded", args: [{ chainId: 46630n, bivium: profile.core, ...p }, address(7), 99n, key, 2n, bounds] });
    assert.equal(data, expected);
    assert.deepEqual(decodeFunctionData({ abi: coreBoundedAbi, data: data! }).args![5], bounds);
  }
});

test("legacy JIT, Morpho and wallet SDK calldata selectors stay unchanged", async () => {
  const client = new keeper.SettlerClient(profile, undefined, profile.maturitySettler!);
  const calls: { abi: Abi; functionName: string; args: readonly unknown[] }[] = [];
  (client as any).write = async (request: any) => { calls.push(request); return { hash: "0x01" }; };
  const key = keeper.poolKeyFor(params.collateralToken, params.loanToken, 3000, 60, ZERO_ADDRESS);
  await client.settleWithFlash(address(4), params, address(7), 99n, key, 0n);
  await client.settleWithMorpho(address(5), params, address(7), 99n, key, 0n);
  await client.settle(params, address(7), 101n, 99n);
  const reference = parseAbi([
    "function settleWithFlash((uint256,address,address,address,uint256,uint256,bool,address),address,uint256,(address,address,uint24,int24,address),uint256) returns(uint256)",
    "function settleWithMorpho((uint256,address,address,address,uint256,uint256,bool,address),address,uint256,(address,address,uint24,int24,address),uint256) returns(uint256)",
    "function settle((uint256,address,address,address,uint256,uint256,bool,address),address,uint256,uint256) returns(uint256)",
  ]);
  for (const call of calls) {
    const decoded = decodeFunctionData({ abi: reference, data: encodeFunctionData(call) });
    assert.equal(decoded.functionName, call.functionName);
    assert.equal(decoded.args!.length, call.functionName === "settle" ? 4 : 5);
  }
});

test("bounded public ABI retains Core receipt event tuple order and indexed provenance fields", () => {
  const event = keeper.boundedKeeperAbi.find((item) => item.type === "event");
  const reference = parseAbi(["event BoundedFlashSettled(address indexed keeper,address indexed borrower,uint256 consumedCollateral,uint256 leftoverCollateral,uint256 finalLoanBalance,uint256 finalCollateralBalance)"])[0];
  assert.deepEqual(event, reference);
});

test("CLI exposes guarded dispatch without executing on import", () => {
  assert.equal(typeof (cli as any).runCli, "function");
});

const wrapper = address(6), borrower = address(7), caller = address(8);
const runtime = "0x60006000" as Hex;
const manager = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const managerFixture = JSON.parse(readFileSync(new URL("./helpers/reviewed-manager-runtime.json", import.meta.url), "utf8"));
const txHash = `0x${"ab".repeat(32)}` as Hex;
const relationshipsAbi = parseAbi(["function BIVIUM() view returns(address)", "function SETTLER() view returns(address)", "function POOL_MANAGER() view returns(address)"]);
const rpcAbi = [...sdk.coreV2Abi, ...keeper.settlerAbi, ...coreBoundedAbi, ...keeper.jitKeeperAbi, ...keeper.morphoFunderAbi, ...relationshipsAbi, ...sdk.erc20Abi];
type RpcOptions = { chainId?: number; now?: bigint; wrapperCode?: Hex; managerCode?: Hex; bivium?: Address; settler?: Address; poolManager?: Address; settlerBivium?: Address; receiptStatus?: "0x0" | "0x1" };

async function fixtureRpc(options: RpcOptions = {}) {
  const requests: { method: string; params: any[] }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    const { method, params: args = [] } = message;
    requests.push({ method, params: args });
    let result: unknown;
    try {
      if (method === "eth_chainId") result = `0x${(options.chainId ?? 46630).toString(16)}`;
      else if (method === "eth_blockNumber") result = "0xa";
      else if (method === "eth_getBlockByNumber") result = { number: "0xa", hash: txHash, timestamp: `0x${(options.now ?? 1000n).toString(16)}`, transactions: [] };
      else if (method === "eth_getCode") result = args[0].toLowerCase() === manager ? (options.managerCode ?? managerFixture.runtime) : (options.wrapperCode ?? runtime);
      else if (method === "eth_call") {
        const call = decodeFunctionData({ abi: rpcAbi, data: args[0].data });
        const name = call.functionName;
        if (name === "BIVIUM") result = args[0].to.toLowerCase() === profile.maturitySettler!.toLowerCase() ? (options.settlerBivium ?? profile.core) : (options.bivium ?? profile.core);
        else if (name === "SETTLER") result = options.settler ?? profile.maturitySettler;
        else if (name === "POOL_MANAGER") result = options.poolManager ?? manager;
        else if (name === "computeId") result = sdk.adapterFor("core-v2").computeMarketId(profile, call.args![0] as MarketParams);
        else if (name === "position") result = { debt: 100_000_000n, collateral: 200_000_000n, collateralWithdrawable: 0n };
        else if (name === "authorizations") result = [1000, true];
        else if (name === "floorOf") result = 20_000_000n;
        else if (name === "maxAsk") result = 180_000_000n;
        else if (name === "approve") result = true;
        else if (["settle", "settleWithFlash", "settleWithFlashBounded", "settleWithMorpho"].includes(name)) result = 2_000_000n;
        else throw new Error(`Unexpected call ${name}`);
        result = encodeFunctionResult({ abi: rpcAbi, functionName: name, result } as any);
      } else if (method === "eth_sendTransaction") result = txHash;
      else if (method === "eth_getTransactionReceipt") result = { transactionHash: txHash, transactionIndex: "0x0", blockHash: txHash, blockNumber: "0xa", from: caller, to: wrapper, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, status: options.receiptStatus ?? "0x1", type: "0x0", contractAddress: null };
      else throw new Error(`Unexpected RPC ${method}`);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) {
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { requests, rpcUrl: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const boundedFlags = ["--via-jit-bounded", "--bounded-jit-wrapper", wrapper, "--bounded-jit-code-hash", keccak256(runtime), "--deadline", "1900", "--max-debt", "101", "--max-loan-balance", "23", "--max-collateral-balance", "0", "--min-profit", "2"];
function replaceFlag(flags: string[], flag: string, value?: string) {
  const copy = [...flags], index = copy.indexOf(flag);
  assert.notEqual(index, -1);
  copy.splice(index, 2, ...(value === undefined ? [] : [flag, value]));
  return copy;
}
async function runFixture(flags: string[], options: RpcOptions = {}, profileOverrides: Partial<DeploymentProfile> = {}, omitAsk = false) {
  const rpc = await fixtureRpc(options), dir = mkdtempSync(join(tmpdir(), "bounded-cli-"));
  const path = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify({ ...profile, rpcUrl: rpc.rpcUrl, tokens: { LOAN: { address: params.loanToken, decimals: 6 }, COLL: { address: params.collateralToken, decimals: 8 } }, ...profileOverrides }));
  let accountRequests = 0, error: unknown;
  const output: string[] = [], log = console.log;
  console.log = (...args) => output.push(args.join(" "));
  try {
    await (cli as any).runCli(["settle", "execute", "--profile", path, "--loan", "LOAN", "--collateral", "COLL", "--maturity", "2000", "--strike", "1000000000000000000000000000000000000", "--borrower", borrower, ...(omitAsk ? [] : ["--ask", "1.8"]), "--json", ...flags], () => { accountRequests++; return { address: caller, type: "json-rpc" }; });
  } catch (e) { error = e; }
  finally { console.log = log; await rpc.close(); rmSync(dir, { recursive: true }); }
  return { error, accountRequests, requests: rpc.requests, output: output.join("\n") };
}

test("CLI rejects incomplete, malformed, overflowing or conflicting bounds before account access", async () => {
  const required = ["--bounded-jit-wrapper", "--bounded-jit-code-hash", "--deadline", "--max-debt", "--max-loan-balance", "--max-collateral-balance", "--min-profit"];
  const cases: [string[], RegExp][] = required.map((flag) => [replaceFlag(boundedFlags, flag), new RegExp(flag)]);
  for (const flag of ["--deadline", "--max-debt", "--max-loan-balance", "--max-collateral-balance", "--min-profit"]) {
    for (const value of ["-1", "+1", " 1", "0x10", ".1", "1.", "1e3", "NaN", "1.000000001", (1n << 256n).toString(), "9".repeat(1000)]) cases.push([replaceFlag(boundedFlags, flag, value), new RegExp(flag)]);
  }
  cases.push([replaceFlag(boundedFlags, "--min-profit", "0"), /min-profit/], [replaceFlag(boundedFlags, "--bounded-jit-wrapper", ZERO_ADDRESS), /wrapper/], [replaceFlag(boundedFlags, "--bounded-jit-code-hash", "0x1234"), /code-hash/]);
  for (const route of ["--via-jit", "--via-morpho"]) cases.push([[...boundedFlags, route], /choose one|exclusive/]);
  for (const route of [[], ["--via-jit"], ["--via-morpho"]]) {
    for (const flag of required.filter((f) => f !== "--min-profit")) cases.push([[...route, flag, boundedFlags[boundedFlags.indexOf(flag) + 1]!], /via-jit-bounded/]);
  }
  for (const [flags, expected] of cases) {
    const result = await runFixture(flags);
    assert.match(String(result.error), expected, flags.join(" "));
    assert.equal(result.accountRequests, 0);
    assert.ok(!result.requests.some((r) => r.method === "eth_sendTransaction"));
  }
});

test("CLI validates chain, chain clock, hooks and pinned deployment relationships before account access", async () => {
  const cases: [string[], RpcOptions, Partial<DeploymentProfile>, RegExp][] = [
    [boundedFlags, {}, { chainId: 1 }, /46630/], [boundedFlags, { chainId: 1 }, {}, /chain/],
    [boundedFlags, { now: 1900n }, {}, /deadline/], [boundedFlags, { now: 2001n }, {}, /deadline/],
    [replaceFlag(boundedFlags, "--deadline", "2001"), {}, {}, /maturity/],
    [[...boundedFlags, "--pool-hooks", address(9)], {}, {}, /hook/],
    [boundedFlags, { wrapperCode: "0x" }, {}, /wrapper/], [boundedFlags, { wrapperCode: "0x1234" }, {}, /hash/],
    [boundedFlags, { managerCode: "0x" }, {}, /manager/i], [boundedFlags, { managerCode: "0x1234" }, {}, /hash/],
    [boundedFlags, { bivium: address(99) }, {}, /BIVIUM/], [boundedFlags, { settler: address(99) }, {}, /SETTLER/],
    [boundedFlags, { poolManager: address(99) }, {}, /POOL_MANAGER/], [boundedFlags, { settlerBivium: address(99) }, {}, /BIVIUM/],
    [[...boundedFlags, "--pool-fee", "-1"], {}, {}, /pool-fee/], [[...boundedFlags, "--pool-spacing", "1.5"], {}, {}, /pool-spacing/],
    [boundedFlags, {}, { tokens: { LOAN: { address: params.loanToken, decimals: 6 }, COLL: { address: params.loanToken, decimals: 6 } } }, /pair|distinct/],
  ];
  for (const [flags, rpc, p, expected] of cases) {
    const result = await runFixture(flags, rpc, p);
    assert.match(String(result.error), expected);
    assert.equal(result.accountRequests, 0);
    assert.ok(!result.requests.some((r) => r.method === "eth_sendTransaction"));
  }
});

test("actual bounded CLI dispatch uses explicit wrapper, real SDK calldata, zero caps and chain snapshot", async () => {
  for (const reverse of [false, true]) {
    const p = reverse ? { ...params, loanToken: params.collateralToken, collateralToken: params.loanToken } : params;
    const result = await runFixture(boundedFlags, {}, { tokens: { LOAN: { address: p.loanToken, decimals: 6 }, COLL: { address: p.collateralToken, decimals: 8 } } });
    assert.equal(result.error, undefined);
    assert.equal(result.accountRequests, 1);
    const sends = result.requests.filter((r) => r.method === "eth_sendTransaction");
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.params[0].to.toLowerCase(), wrapper);
    const decoded = decodeFunctionData({ abi: coreBoundedAbi, data: sends[0]!.params[0].data });
    assert.equal(decoded.functionName, "settleWithFlashBounded");
    assert.deepEqual(decoded.args![5], { deadline: 1900n, maxDebt: 101_000_000n, maxLoanBalance: 23_000_000n, maxCollateralBalance: 0n });
    assert.equal(decoded.args![4], 2_000_000n);
    assert.equal(decoded.args![2], 180_000_000n);
    assert.equal(decoded.args![3].currency0.toLowerCase(), address(10));
    const data = JSON.parse(result.output);
    assert.equal(data.indicativeDebt, "100");
    assert.equal(data.repaid, undefined);
    assert.equal(data.snapshotTimestamp, "1000");
    assert.equal(data.snapshotBlockNumber, "10");
    assert.equal(data.actualNotional, null);
    for (const r of result.requests.filter((r) => r.method === "eth_getCode")) assert.equal(r.params[1], "0xa");
    for (const r of result.requests.filter((r) => r.method === "eth_call")) {
      const name = decodeFunctionData({ abi: rpcAbi, data: r.params[0].data }).functionName;
      if (["BIVIUM", "SETTLER", "POOL_MANAGER", "position", "authorizations", "floorOf", "maxAsk"].includes(name)) assert.equal(r.params[1], "0xa");
    }
  }
});

test("bounded CLI permits both zero wallet caps, exact decimal units and the uint256 ceiling", async () => {
  const ceiling = (1n << 256n) - 1n;
  let flags = replaceFlag(boundedFlags, "--max-debt", sdk.formatAmount(ceiling, 6));
  flags = replaceFlag(flags, "--max-loan-balance", "0");
  flags = replaceFlag(flags, "--max-collateral-balance", "0.00000001");
  flags = replaceFlag(flags, "--deadline", "2000");
  const result = await runFixture(flags);
  assert.equal(result.error, undefined);
  const send = result.requests.find((r) => r.method === "eth_sendTransaction")!;
  const decoded = decodeFunctionData({ abi: coreBoundedAbi, data: send.params[0].data });
  assert.deepEqual(decoded.args![5], { deadline: 2000n, maxDebt: ceiling, maxLoanBalance: 0n, maxCollateralBalance: 1n });
  // Fixture success only proves dispatch/encoding; a real zero loan cap with positive profit will revert.
  assert.equal(managerFixture.runtime.length, 2 + 24009 * 2);
  assert.equal(keccak256(managerFixture.runtime), "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626");
});

test("bounded CLI default ask reads floor and Dutch cap at the chain snapshot before SDK dispatch", async () => {
  const result = await runFixture(boundedFlags, {}, {}, true);
  assert.equal(result.error, undefined);
  assert.equal(result.accountRequests, 1);
  const reads = result.requests.filter((r) => r.method === "eth_call").map((r) => ({ request: r, call: decodeFunctionData({ abi: rpcAbi, data: r.params[0].data }) }));
  const floor = reads.filter((r) => r.call.functionName === "floorOf");
  const cap = reads.filter((r) => r.call.functionName === "maxAsk");
  assert.equal(floor.length, 1);
  assert.equal(cap.length, 1);
  assert.deepEqual(floor[0]!.call.args, [200_000_000n, 1000n]);
  assert.deepEqual(cap[0]!.call.args, [200_000_000n, 2000n, 20_000_000n]);
  for (const { request } of [...floor, ...cap]) {
    assert.equal(request.params[0].to.toLowerCase(), profile.maturitySettler!.toLowerCase());
    assert.equal(request.params[1], "0xa");
  }
  assert.ok(result.requests.indexOf(floor[0]!.request) < result.requests.indexOf(cap[0]!.request));
  const sends = result.requests.filter((r) => r.method === "eth_sendTransaction");
  assert.equal(sends.length, 1);
  assert.ok(result.requests.indexOf(cap[0]!.request) < result.requests.indexOf(sends[0]!));
  assert.equal(decodeFunctionData({ abi: coreBoundedAbi, data: sends[0]!.params[0].data }).args![2], 180_000_000n);
  assert.equal(JSON.parse(result.output).ask, "1.8");
});

test("CLI preserves legacy route dispatch and receipt failure handling without approvals on flash routes", async () => {
  for (const [flags, name, to] of [[[], "settle", profile.maturitySettler], [["--via-jit"], "settleWithFlash", profile.v4JitKeeper], [["--via-morpho"], "settleWithMorpho", profile.morphoJitFunder]] as const) {
    const result = await runFixture([...flags]);
    assert.equal(result.error, undefined);
    const sends = result.requests.filter((r) => r.method === "eth_sendTransaction");
    assert.equal(sends.length, name === "settle" ? 2 : 1);
    const last = sends.at(-1)!.params[0];
    assert.equal(last.to.toLowerCase(), to!.toLowerCase());
    assert.equal(decodeFunctionData({ abi: rpcAbi, data: last.data }).functionName, name);
  }
  const failed = await runFixture(boundedFlags, { receiptStatus: "0x0" });
  assert.match(String(failed.error), /reverted/);
  assert.equal(failed.output, "");
});

test("both CLI entrypoints preserve help and error exits", () => {
  for (const entry of [["--import", "tsx", "src/cli/main.ts"], ["bin/bivium.mjs"]]) {
    const help = spawnSync(process.execPath, [...entry, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /via-jit-bounded/);
    const bad = spawnSync(process.execPath, [...entry, "bad-command"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /unknown command/);
  }
  const imported = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./src/cli/main.ts"); console.log("import-only");'], { encoding: "utf8" });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "import-only\n");
  assert.equal(imported.stderr, "");
});

test("CLI imports through stdin and unresolvable argv paths do not execute the entrypoint", () => {
  for (const input of [
    'await import("./src/cli/main.ts"); console.log("import-only");',
    'process.argv[1] = "/nonexistent/bivium-import-fixture"; await import("./src/cli/main.ts"); console.log("import-only");',
  ]) {
    const imported = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-"], { encoding: "utf8", input });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "import-only\n");
    assert.equal(imported.stderr, "");
  }
});
