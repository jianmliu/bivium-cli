import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, toFunctionSelector } from "viem";
import { adapterFor } from "../src/sdk/lineage.ts";
import { buildSignedOfferFile } from "../src/sdk/offer.ts";
import { fillCost } from "../src/sdk/strategies/program.ts";
import type { Address, DeploymentProfile, Hex, Offer } from "../src/sdk/types.ts";
import { StrategyRouterClient } from "../src/sdk/strategyRouter.ts";
import type { Leg } from "../src/sdk/strategies/program.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const BORROW_FEE = toFunctionSelector("FEE_BPS()");
const LENDER_FEE = toFunctionSelector("LENDER_FEE_BPS()");
const QUOTE_BID = toFunctionSelector("quoteLeg(uint256,uint256)");
const QUOTE_ASK = toFunctionSelector("quoteLenderFee(uint256,uint256)");
const ROUTERS = toFunctionSelector("routers()");
const LENDER_ROUTE = toFunctionSelector("LENDER_MUST_ROUTE()");
const GATE: Address = `0x${"11".repeat(20)}`;
const DEFAULT_ROUTER: Address = `0x${"22".repeat(20)}`;
const ADMITTED_ROUTER: Address = `0x${"33".repeat(20)}`;
type ProgramOptions = {
  gate?: Address;
  defaultRouter?: Address;
  explicitRouter?: Address;
  human?: boolean;
  unwind?: boolean;
  inspectGate?: boolean;
  command?: string[];
  maturity?: bigint;
  errors?: Record<string, { code: number; message: string; data?: string }>;
};

async function program(strategy: string, answers: Record<string, Hex>, buy = false, options: ProgramOptions = {}) {
  const calls: string[] = [];
  const destinations: { selector: string; to: string | undefined; block?: string }[] = [];
  const profile: DeploymentProfile = JSON.parse(readFileSync(join(root, "profiles/robinhood-testnet.json"), "utf8"));
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    const selector = rpc.params?.[0]?.data?.slice(0, 10) ?? rpc.method;
    calls.push(selector);
    destinations.push({ selector, to: rpc.params?.[0]?.to, block: rpc.params?.[1] });
    let result: unknown = answers[selector];
    if(result===undefined){
      if(rpc.method==='eth_chainId')result='0xb626';
      else if(rpc.method==='eth_getBlockByNumber')result={number:'0xa',hash:`0x${'11'.repeat(32)}`,timestamp:'0x6fffffff',transactions:[]};
      else if(rpc.method==='eth_getCode')result='0x6000';
      else if(selector===toFunctionSelector('BIVIUM()'))result=encodeAbiParameters([{type:'address'}],[profile.core]);
      else if(selector===toFunctionSelector('MAX_LEGS()'))result=`0x${word(16n)}`;
      else if(selector===toFunctionSelector('decimals()'))result=`0x${word(rpc.params[0].to.toLowerCase()===profile.tokens!.bUSD.address.toLowerCase()?6n:18n)}`;
      else if(selector===toFunctionSelector('POOL_MANAGER()')||selector===toFunctionSelector('poolManager()'))result=encodeAbiParameters([{type:'address'}],[DEFAULT_ROUTER]);
      else if(selector===toFunctionSelector('computeId((uint256,address,address,address,uint256,uint256,bool,address))'))result=adapterFor('core-v2').computeMarketId(profile,{loanToken:`0x${'00'.repeat(20)}`,collateralToken:`0x${'00'.repeat(20)}`,maturity:1n,strike:1n,allowPartialRepay:false,gate:`0x${'00'.repeat(20)}`});
      else if(selector===QUOTE_ASK&&answers[LENDER_FEE]){
        const data=rpc.params[0].data as string,units=BigInt(`0x${data.slice(10,74)}`),cost=BigInt(`0x${data.slice(74,138)}`),fee=(units>cost?units-cost:0n)*BigInt(answers[LENDER_FEE])/10000n;
        result=encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[fee,cost+fee]);
      }
    }
    const error = options.errors?.[selector];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(error || result === undefined
      ? { jsonrpc: "2.0", id: rpc.id, error: error ?? { code: -32000, message: "execution reverted: unavailable fee read" } }
      : { jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const dir = mkdtempSync(join(tmpdir(), "bivium-router-fee-"));
  try {
    profile.rpcUrl = `http://127.0.0.1:${address.port}`;
    if (options.command) delete profile.relayerUrl;
    if (options.defaultRouter) profile.strategyRouter = options.defaultRouter;
    const offer: Offer = {
      loanToken: profile.tokens!.bUSD.address, collateralToken: profile.tokens!.mNVDA.address,
      maturity: options.maturity ?? 2_000_000_000n, strike: 125n * 10n ** 24n, allowPartialRepay: false,
      gate: options.gate ?? "0x0000000000000000000000000000000000000000", maker: profile.core,
      buy, tick: 4000n, maxUnits: 10n ** 30n, maxAssets: 0n, start: 0n, expiry: 2_000_000_000n,
      group: `0x${"11".repeat(32)}`, ratifier: profile.signatureRatifier,
    };
    const commitment = adapterFor(profile.abiProfile).offerCommitment(profile, offer);
    const offerFile = join(dir, "offer.json");
    const profileFile = join(dir, "profile.json");
    writeFileSync(offerFile, JSON.stringify(buildSignedOfferFile(profile, offer, commitment, "0x")));
    writeFileSync(profileFile, JSON.stringify(profile));
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", ...(options.command??["strategy", "program"]),
        "--strategy", strategy, "--offer", offerFile, "--units", "2.000001", "--min-out", "0.001",
        "--profile", profileFile, ...(options.human ? [] : ["--json"]),
        ...(options.explicitRouter ? ["--router", options.explicitRouter] : []),
        ...(options.unwind ? ["--unwind", "--via", "wallet", "--assets", "2.000001"] : [])], {
        cwd: root, env: { ...process.env, BIVIUM_PK: "", BIVIUM_PROFILE: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    let gateResult: Awaited<ReturnType<StrategyRouterClient["gateRouting"]>> | undefined;
    let gateError: unknown;
    if (options.inspectGate) {
      try { gateResult = await new StrategyRouterClient(profile, undefined, profile.strategyRouter!).gateRouting(offer.gate); }
      catch (error) { gateError = error; }
    }
    return { ...result, calls, destinations, offer, profile, gateResult, gateError };
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
  assert.ok(result.calls.includes(LENDER_FEE));
  assert.ok(!result.calls.includes(BORROW_FEE), "an ask does not need the borrow-side fee getter");
});

test('CLI opening program uses authoritative exact fee and all admission reads are pinned',async()=>{
 const base=await program('lendQuote',{[LENDER_FEE]:`0x${word(1000n)}`});assert.equal(base.code,0,base.stderr);
 const cost=fillCost(base.offer,2000001n),result=await program('lendQuote',{[LENDER_FEE]:`0x${word(1000n)}`,[QUOTE_ASK]:encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[7n,cost+7n])});
 assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).derived.fee,'7');
 assert.ok(result.destinations.filter(c=>c.selector==='eth_getCode'||c.selector.startsWith('0x')).every(c=>c.block==='0xa'));
});
test('legacy gated trade and borrow commands stop before signer access or writes',async()=>{
 for(const command of [['borrow','quote'],['borrow','execute'],['trade','buy'],['trade','sell']]){
  const r=await program('protectivePut',{},true,{gate:GATE,command});assert.notEqual(r.code,0);assert.match(r.stderr,/unsupported.*gated|gated.*unsupported/i);assert.match(r.stderr,/action_preview|strategy program/);assert.doesNotMatch(r.stderr,/signing key required/);assert.equal(r.calls.length,0);
 }
});
test('legacy gated mature secondary sell retains recovery path after pinned maturity check',async()=>{
 const r=await program('protectivePut',{},true,{gate:GATE,command:['trade','sell'],maturity:100n});
 assert.match(r.stderr,/pick a book source/);assert.doesNotMatch(r.stderr,/gated.*unsupported/i);assert.ok(r.calls.includes('eth_getBlockByNumber'));
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

const gatedAnswers = (router = ADMITTED_ROUTER, lenderMustRoute = true): Record<string, Hex> => ({
  [ROUTERS]: encodeAbiParameters([{ type: "address[]" }], [[router]]),
  [LENDER_ROUTE]: encodeAbiParameters([{ type: "bool" }], [lenderMustRoute]),
  [LENDER_FEE]: `0x${word(1_000n)}`,
});

class CapturingStrategyRouter extends StrategyRouterClient {
  readonly writes: { address: Address; functionName: string; args: readonly unknown[] }[] = [];
  protected override async write(request: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) {
    this.writes.push(request);
    return { hash: `0x${"00".repeat(32)}` as Hex, gasUsed: 0n, blockNumber: 0n };
  }
}

test("auto-selected router is identical in preview, fee reads, approval spender and execution target", async () => {
  const result = await program("lendQuote", gatedAnswers(), false, { gate: GATE, defaultRouter: DEFAULT_ROUTER });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  const feeDestination = result.destinations.find(call => call.selector === LENDER_FEE)?.to;
  assert.equal(feeDestination?.toLowerCase(), ADMITTED_ROUTER);
  assert.equal(body.router.toLowerCase(), feeDestination?.toLowerCase());
  // Exercise the real SDK program methods, stopping only at the external write boundary: no account/key/RPC write.
  const client = new CapturingStrategyRouter(result.profile, undefined, feeDestination as Address);
  for (const approval of body.approvals) await client.approveForProgram(approval.token, BigInt(approval.amount));
  await client.execute(body.legs as Leg[], BigInt(body.deadline));
  assert.equal(client.writes[0].functionName, "approve");
  assert.equal(client.writes[0].address.toLowerCase(), body.approvals[0].token.toLowerCase());
  assert.equal((client.writes[0].args[0] as string).toLowerCase(), body.router.toLowerCase());
  assert.equal(client.writes[0].args[1], BigInt(body.approvals[0].amount));
  assert.equal(client.writes[1].functionName, "execute");
  assert.equal(client.writes[1].address.toLowerCase(), body.router.toLowerCase());
  assert.deepEqual(client.writes[1].args, [body.legs, BigInt(body.deadline)]);
});

test("human open preview names the gate-selected router", async () => {
  const result = await program("lendQuote", gatedAnswers(), false, { gate: GATE, defaultRouter: DEFAULT_ROUTER, human: true });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`router ${ADMITTED_ROUTER}`, "i"));
  assert.doesNotMatch(result.stdout, new RegExp(DEFAULT_ROUTER, "i"));
});

test("an admitted default router stays selected and explicit true routing remains valid", async () => {
  const result = await program("lendQuote", gatedAnswers(DEFAULT_ROUTER), false, { gate: GATE, defaultRouter: DEFAULT_ROUTER, inspectGate: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).router.toLowerCase(), DEFAULT_ROUTER);
  assert.equal(result.destinations.find(call => call.selector === LENDER_FEE)?.to?.toLowerCase(), DEFAULT_ROUTER);
  assert.equal(result.gateResult?.lenderMustRoute, true);
});

test("an explicitly rejected router is not silently replaced", async () => {
  const result = await program("lendQuote", gatedAnswers(), false, { gate: GATE, defaultRouter: DEFAULT_ROUTER, explicitRouter: DEFAULT_ROUTER });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /router.*not admitted/i);
  assert.ok(!result.calls.includes(LENDER_FEE));
});

test("explicit false lender routing remains a valid direct-fill policy", async () => {
  const result = await program("lendQuote", gatedAnswers(DEFAULT_ROUTER, false), false, { gate: GATE, defaultRouter: DEFAULT_ROUTER, inspectGate: true });
  assert.equal(result.gateResult?.lenderMustRoute, false);
  assert.equal(result.gateError, undefined);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /fills the ask directly on the core/);
});

for (const failure of ["RPC error", "empty revert", "empty return", "malformed bool"] as const) {
  test(`unknown gate policy (${failure}) fails closed without a program or direct-fill guidance`, async () => {
    const answers = gatedAnswers();
    const errors: ProgramOptions["errors"] = {};
    if (failure === "RPC error") errors[LENDER_ROUTE] = { code: -32000, message: "fixture RPC unavailable" };
    else if (failure === "empty revert") errors[LENDER_ROUTE] = { code: 3, message: "execution reverted", data: "0x" };
    else answers[LENDER_ROUTE] = failure === "empty return" ? "0x" : `0x${word(2n)}`;
    const result = await program("lendQuote", answers, false, { gate: GATE, defaultRouter: DEFAULT_ROUTER, errors, inspectGate: true });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /LENDER_MUST_ROUTE/);
    assert.match(result.stderr, /unsupported|compatible/i);
    assert.match(result.stderr, /RPC/);
    assert.match(result.stderr, /re-?quote/i);
    assert.match(result.stderr, /refusing to assume direct lender fill/i);
    assert.doesNotMatch(result.stderr, /does not route lenders|fills the ask directly on the core/);
    assert.ok(!result.calls.includes(LENDER_FEE));
    assert.ok(result.gateError instanceof Error);
    assert.ok(result.gateError.cause instanceof Error, "retain the underlying RPC/decode failure as cause");
  });
}

test("wallet unwind preserves its configured router and does not perform open gate auto-selection", async () => {
  const result = await program("lendQuote", {}, false, { gate: GATE, defaultRouter: DEFAULT_ROUTER, unwind: true });
  assert.equal(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.mode, "unwind");
  assert.equal(body.router.toLowerCase(), DEFAULT_ROUTER);
  assert.deepEqual(result.calls, []);
});
