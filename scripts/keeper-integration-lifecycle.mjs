// SYNTHETIC integration assertions using pinned production MM code, never MM test modules.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from "viem";

const TX = `0x${"aa".repeat(32)}`, BLOCK = `0x${"bb".repeat(32)}`, FINAL = `0x${"cc".repeat(32)}`;
const allowedRpc = new Set(["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);

function actionFor(p, vector, data) {
  return { id: "SYNTHETIC-known-pending", kind: "keeper", marketId: p.markets[0].id, createdAt: 1000,
    phase: "broadcast", amounts: {}, consumedRaw: "0", gasReservedWei: "5000000", gasSpentWei: "0",
    tx: { nonce: 0, hash: TX, to: p.keeper.wrapper.address, data, gas: "500000", gasPriceWei: "10", value: "0" },
    keeper: { borrower: vector.borrower, indicativeDebtRaw: "1100", askRaw: vector.ask, minProfitRaw: vector.minProfit } };
}

function receiptFixture(p, vector, abi, scenario) {
  const log = (eventName, values, logIndex, borrower = vector.borrower) => ({
    address: p.keeper.wrapper.address,
    topics: encodeEventTopics({ abi, eventName, args: { keeper: p.account, borrower } }),
    data: encodeAbiParameters(values.map(() => ({ type: "uint256" })), values),
    blockNumber: "0x64", blockHash: BLOCK, transactionHash: TX, transactionIndex: "0x0", logIndex, removed: false,
  });
  return { transactionHash: TX, transactionIndex: "0x0", blockHash: BLOCK, blockNumber: "0x64", from: p.account,
    to: p.keeper.wrapper.address, cumulativeGasUsed: "0x186a0", gasUsed: "0x186a0", effectiveGasPrice: "0xa",
    status: scenario === "reverted" ? "0x0" : "0x1", type: "0x0", contractAddress: null,
    logs: scenario === "reverted" ? [] : [log("FlashSettled", [scenario === "debt-cap" ? 2001n : 1100n, 2000n, 1000000000n], "0x0"),
      log("BoundedFlashSettled", [scenario === "arithmetic" ? 1999n : 2000n, 0n,
        scenario === "loan-wallet-cap" ? 2000000001n : 1000000000n, scenario === "collateral-wallet-cap" ? 1n : 0n], "0x1",
        scenario === "identity" ? p.ratifier.address : vector.borrower)] };
}

export async function checkLifecycle(mm, sdk, vectors, coreAbi, cliCalldata) {
  // Exact real SDK write interception -> real MM reconstruction and shape authorization.
  let shapeChecks = 0;
  for (const vector of vectors) {
    const p = mm.parsePolicy(vector.policy), market = p.markets[0], data = await cliCalldata(sdk, vector);
    const bounds = mm.executionBounds(p, market);
    assert.deepEqual(Object.fromEntries(Object.entries(bounds).map(([k, v]) => [k, v.toString()])), vector.bounds);
    assert.equal(bounds.deadline, BigInt(Math.min(p.endsAt, Number(market.params.maturity))));
    assert.equal(bounds.maxCollateralBalance, 0n);
    const args = [{ chainId: BigInt(p.chainId), bivium: p.core.address, ...mm.params(market) }, vector.borrower,
      BigInt(vector.ask), market.keeper.pool, BigInt(vector.minProfit), bounds];
    assert.equal(encodeFunctionData({ abi: mm.boundedKeeperAbi, functionName: "settleWithFlashBounded", args }), data, `${vector.name}: CLI/MM full calldata mismatch`);
    const action = actionFor(p, vector, data);
    mm.validateKeeperShape(p, action); shapeChecks++;
    for (const field of Object.keys(bounds)) {
      const mutated = structuredClone(action);
      mutated.tx.data = encodeFunctionData({ abi: mm.boundedKeeperAbi, functionName: "settleWithFlashBounded",
        args: [...args.slice(0, 5), { ...bounds, [field]: bounds[field] + 1n }] });
      assert.throws(() => mm.validateKeeperShape(p, mutated), /calldata differs/, `MM shape accepted changed ${field}`); shapeChecks++;
    }
    const wallet = Object.fromEntries(p.tokens.map(t => [t.address, BigInt(t.maxWalletBalanceRaw)]));
    mm.assertWalletBalances(p, wallet);
    assert.throws(() => mm.assertWalletBalances(p, { ...wallet, [market.params.collateralToken]: 1n }), /wallet balance exceeds/);
    const invalid = structuredClone(vector.policy); invalid.tokens[1].maxWalletBalanceRaw = "-1";
    assert.throws(() => mm.parsePolicy(invalid), /raw uint256/);
  }

  // All RPC results below are fabricated and local. No keys, signing, sending, session run/start,
  // price fetches, or contract writes are needed to seed and reconcile known pending fixtures.
  const vector = vectors[0], requests = [];
  let active;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const q = JSON.parse(body), { method, params = [] } = q;
    requests.push({ method, params });
    try {
      assert.ok(allowedRpc.has(method), `forbidden SYNTHETIC RPC method ${method}`);
      const { p, scenario } = active;
      let result;
      if (method === "eth_chainId") result = "0xb626";
      else if (method === "eth_getTransactionReceipt") {
        assert.equal(params[0], TX);
        if (scenario === "rpc-failure") throw new Error("SYNTHETIC receipt RPC unavailable");
        result = scenario === "missing" ? null : receiptFixture(p, vector, coreAbi, scenario);
      } else {
        const tag = params[0];
        assert.ok(["finalized", "0x64", "0x6a"].includes(tag), `unexpected block tag ${tag}`);
        result = { number: tag === "finalized" ? (scenario === "unfinalized" ? "0x63" : "0x6a") : tag,
          hash: tag === "0x64" ? BLOCK : FINAL, timestamp: "0x3e8", transactions: [] };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    } catch (error) { res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32602, message: error.message } })); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const cases = [];
  try {
    for (const terminal of ["stopped", "expired"]) {
      for (const scenario of ["valid", "identity", "arithmetic", "debt-cap", "loan-wallet-cap", "collateral-wallet-cap", "unfinalized", "missing", "reverted", "rpc-failure"]) {
        const root = mkdtempSync(join(tmpdir(), "keeper-v2-SYNTHETIC-"));
        try {
          const p = mm.parsePolicy({ ...structuredClone(vector.policy), rpcUrl }); active = { p, scenario };
          const store = new mm.SessionStore(join(root, "session"), join(root, "private-registry"));
          const state = store.approve(p, mm.policyDigest(p), 1000);
          state.actions.push(actionFor(p, vector, vector.calldata)); state.attempts = 1; state.status = "running"; store.save(state);
          if (terminal === "stopped") store.stop();
          const now = terminal === "expired" ? p.endsAt : 1000;
          const adapter = mm.createLiveAdapter(p, undefined, () => now);
          assert.equal(adapter.account, undefined, "fixture must be keyless");
          const offset = requests.length;
          if (!["valid", "unfinalized", "missing", "reverted"].includes(scenario)) {
            await assert.rejects(adapter.receipt(p, TX, state.actions[0]), scenario === "rpc-failure" ? /SYNTHETIC receipt RPC unavailable/ : /bounded settlement receipt/);
          }
          // Only the real read-only methods are exposed to reconciliation.
          await mm.reconcileOnly(store, { consumed: adapter.consumed, receipt: adapter.receipt }, () => now);
          const saved = store.load(), action = saved.actions[0];
          assert.equal(saved.status, terminal); assert.equal(saved.attempts, 1); assert.equal(saved.actions.length, 1);
          if (scenario === "valid" || scenario === "reverted") {
            assert.equal(action.phase, scenario === "reverted" ? "reverted" : "mined"); assert.equal(action.gasReservedWei, "0"); assert.equal(action.gasSpentWei, "1000000");
            assert.deepEqual(action.inclusion, { blockNumber: "100", blockHash: BLOCK });
            if (scenario === "reverted") {
              assert.equal(action.settlement, undefined); assert.equal(saved.failures, 1);
              assert.match(saved.reason, /transaction reverted; native gas spent/);
            } else {
              assert.deepEqual(action.settlement, { borrower: vector.borrower, debtRaw: "1100", collateralAskRaw: "2000", grossProfitRaw: "1000000000",
                keeper: p.account, consumedCollateralRaw: "2000", leftoverCollateralRaw: "0", finalLoanBalanceRaw: "1000000000", finalCollateralBalanceRaw: "0" });
            }
            const reads = requests.slice(offset);
            assert.equal(reads.filter(r => r.method === "eth_getBlockByNumber" && r.params[0] === "finalized").length, 1);
            assert.equal(reads.filter(r => r.method === "eth_getBlockByNumber" && r.params[0] === "0x64").length, 2);
          } else {
            assert.equal(action.phase, "broadcast"); assert.equal(action.gasReservedWei, "5000000"); assert.equal(action.gasSpentWei, "0");
            assert.equal(action.settlement, undefined); assert.equal(action.inclusion, undefined);
            if (!["unfinalized", "missing"].includes(scenario)) assert.match(saved.reason, /unresolved reservations retained/);
            if (scenario === "rpc-failure") {
              assert.equal(saved.failures, 1);
              assert.equal(requests.slice(offset).filter(r => r.method === "eth_getTransactionReceipt").length, 2, "one direct rejection and one reconciliation read; no retries");
            }
          }
          cases.push(`${terminal}:${scenario}`);
        } finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
    assert.ok(requests.length > 0); assert.ok(requests.every(r => allowedRpc.has(r.method)));
    return { evidence: "SYNTHETIC_LOOPBACK_KEYLESS", shapeChecks, cases, rpcMethods: [...new Set(requests.map(r => r.method))].sort(),
      signingOrSending: false, liveKeeperE2E: false };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
