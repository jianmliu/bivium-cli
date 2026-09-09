#!/usr/bin/env node
// Explicit cross-repository verification. No public RPC, key, signature or broadcast.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFunctionData, keccak256, toEventSelector, toFunctionSelector } from "viem";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const manifest = () => readJson(resolve(CLI, "releases/keeper-v2/integration-manifest.json"));
const selected = abi => ["settleWithFlashBounded", "BoundedFlashSettled"].map(name => {
  const matches = abi.filter(item => item.name === name);
  assert.equal(matches.length, 1, `ABI missing/duplicate ${name}`);
  return matches[0];
});

// Input names retain semantic tuple order even where adjacent fields have identical types.
// Output names and Solidity internalType are not part of the wire contract.
function parameter(p, output = false, event = false) {
  return { type: p.type, ...(!output ? { name: p.name } : {}),
    ...(p.components ? { components: p.components.map(c => parameter(c, output)) } : {}),
    ...(event ? { indexed: Boolean(p.indexed) } : {}) };
}
function normalize(abi) {
  return selected(abi).map(item => ({ type: item.type, name: item.name,
    inputs: item.inputs.map(p => parameter(p, false, item.type === "event")),
    ...(item.type === "function" ? { stateMutability: item.stateMutability, outputs: item.outputs.map(p => parameter(p, true)) } : { anonymous: Boolean(item.anonymous) }) }));
}
export function assertBoundedAbi(core, actual, label) {
  assert.deepEqual(normalize(actual), normalize(core), `${label} ABI differs from compiled Core`);
  const [fn, event] = selected(actual);
  assert.equal(toFunctionSelector(fn), "0xf1f3503a", `${label} selector drift`);
  assert.equal(toEventSelector(event), "0xc089e9d384c6a7d049df1ce84ecc6582325d9898b088e7a02e490a002f5a6fa8", `${label} event topic drift`);
}

function sourcePath(root, file) {
  assert.ok(!isAbsolute(file) && !file.split("/").includes("..") && !file.split("/").includes("node_modules"), "invalid provenance path");
  const path = resolve(root, file);
  assert.equal(realpathSync(path), path, `source symlink not allowed: ${file}`);
  return path;
}
function verifyRuntime(root, files, label) {
  root = realpathSync(root);
  for (const [file, hash] of Object.entries(files)) {
    assert.equal(sha256(readFileSync(sourcePath(root, file))), hash, `${label} runtime source hash drift: ${file}`);
  }
}
export function verifySourcePin(root, pin, label) {
  root = realpathSync(root);
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  try { execFileSync("git", ["-C", root, "cat-file", "-e", `${pin.commit}^{commit}`], { stdio: "pipe" }); }
  catch { throw new Error(`${label} missing commit ${pin.commit}`); }
  for (const [file, hash] of Object.entries(pin.files)) {
    let bytes;
    try { bytes = execFileSync("git", ["-C", root, "show", `${pin.commit}:${file}`], { stdio: "pipe" }); }
    catch { throw new Error(`${label} missing pinned source: ${file}`); }
    assert.equal(sha256(bytes), hash, `${label} pinned source hash drift: ${file}`);
    assert.ok(bytes.equals(readFileSync(sourcePath(root, file))), `${label} runtime byte drift: ${file}`);
  }
}

function portableInputs() {
  const m = manifest();
  for (const [file, hash] of Object.entries(m.fixtures)) assert.equal(sha256(readFileSync(resolve(CLI, file))), hash, `portable fixture hash drift: ${file}`);
  verifyRuntime(CLI, m.pins.cli.files, "CLI");
  return { m, coreAbi: readJson(resolve(CLI, "test/fixtures/keeper-v2/core-abi.json")), vectors: readJson(resolve(CLI, "test/fixtures/keeper-v2/vectors.json")) };
}
export async function cliCalldata(sdk, vector) {
  const p = vector.policy, m = p.markets[0];
  const client = new sdk.SettlerClient({ name: "SYNTHETIC", abiProfile: "core-v2", chainId: p.chainId,
    rpcUrl: "http://127.0.0.1:1", core: p.core.address, signatureRatifier: p.ratifier.address }, undefined, p.keeper.settler.address);
  let captured;
  // Intercept the real SDK write boundary before any transport or signer can be used.
  client.write = async request => {
    assert.equal(captured, undefined);
    assert.equal(request.address?.toLowerCase(), p.keeper.wrapper.address.toLowerCase(), `${vector.name}: CLI transaction target differs from approved wrapper`);
    assert.ok(request.value === undefined || request.value === 0n, `${vector.name}: CLI transaction must carry no native value`);
    captured = encodeFunctionData(request); return { hash: "0x00" };
  };
  await client.settleWithFlashBounded(p.keeper.wrapper.address,
    { ...m.params, maturity: BigInt(m.params.maturity), strike: BigInt(m.params.strike) },
    vector.borrower, BigInt(vector.ask), sdk.poolKeyFor(m.params.collateralToken, m.params.loanToken, 3000, 60, m.keeper.pool.hooks),
    BigInt(vector.minProfit), Object.fromEntries(Object.entries(vector.bounds).map(([k, v]) => [k, BigInt(v)])));
  assert.equal(captured, vector.calldata, `${vector.name}: actual CLI calldata differs from compiled Core vector`);
  return captured;
}
export async function checkPortable() {
  const { m, coreAbi, vectors } = portableInputs();
  const sdk = await import(pathToFileURL(resolve(CLI, "src/sdk/settler.ts")).href);
  assertBoundedAbi(coreAbi, sdk.boundedKeeperAbi, "CLI");
  for (const vector of vectors) await cliCalldata(sdk, vector);
  return { evidence: "PORTABLE_SYNTHETIC", selector: m.abi.selector, vectors: vectors.length,
    limitation: "Committed compiled-Core fixtures and local CLI only; no sibling MM runtime, deployment or live keeper E2E evidence." };
}

function verifyCoreBuild(root, m, portableAbi) {
  const artifact = readJson(resolve(root, m.coreBuild.artifact));
  assert.equal(sha256(artifact.rawMetadata), m.coreBuild.metadataSha256, "Core build metadata hash drift");
  const metadata = JSON.parse(artifact.rawMetadata);
  // Foundry normalizes remappings and drops some NatSpec in its parsed metadata.
  // Pin the exact raw compiler metadata and compare the authoritative shared fields.
  for (const field of ["compiler", "sources"]) assert.deepEqual(artifact.metadata[field], metadata[field], `Core parsed/raw ${field} mismatch`);
  assert.deepEqual(artifact.metadata.output.abi, metadata.output.abi, "Core parsed/raw ABI mismatch");
  assert.deepEqual(Object.keys(metadata.sources).sort(), Object.keys(m.coreBuild.sources).sort(), "Core build source closure drift");
  for (const [file, hash] of Object.entries(m.coreBuild.sources)) {
    assert.equal(metadata.sources[file].keccak256, hash, `Core metadata source hash drift: ${file}`);
    assert.equal(keccak256(readFileSync(sourcePath(realpathSync(root), file))), hash, `Core compiled source Keccak drift: ${file}`);
  }
  const orderedEntries = abi => [...abi].sort((a, b) => `${a.type}:${a.name ?? ""}`.localeCompare(`${b.type}:${b.name ?? ""}`));
  assert.deepEqual(orderedEntries(artifact.abi), orderedEntries(metadata.output.abi), "Core artifact ABI differs from compiler metadata");
  assertBoundedAbi(artifact.abi, portableAbi, "portable Core fixture");
  return artifact.abi;
}
export async function checkCrossRepo({ coreRoot, mmRoot }) {
  assert.ok(coreRoot && mmRoot, "--core-root and --mm-root are both required; fixture-only fallback is forbidden");
  const { m, coreAbi, vectors } = portableInputs();
  // All project sources and compiled-source metadata are checked BEFORE importing runtime modules.
  verifySourcePin(CLI, m.pins.cli, "CLI");
  verifySourcePin(coreRoot, m.pins.core, "Core");
  verifySourcePin(mmRoot, m.pins.mm, "MM");
  const authoritativeAbi = verifyCoreBuild(coreRoot, m, coreAbi);
  const sdk = await import(pathToFileURL(resolve(CLI, "src/sdk/settler.ts")).href);
  const module = async file => import(pathToFileURL(resolve(realpathSync(mmRoot), file)).href);
  const mm = { ...await module("src/session/keeperAbi.ts"), ...await module("src/session/policy.ts"),
    ...await module("src/session/shape.ts"), ...await module("src/session/chain.ts"),
    ...await module("src/session/store.ts"), ...await module("src/session/engine.ts") };
  assertBoundedAbi(authoritativeAbi, sdk.boundedKeeperAbi, "actual CLI");
  assertBoundedAbi(authoritativeAbi, mm.boundedKeeperAbi, "actual MM");
  const { checkLifecycle } = await import("./keeper-integration-lifecycle.mjs");
  const lifecycle = await checkLifecycle(mm, sdk, vectors, authoritativeAbi, cliCalldata);
  return { result: "PASS", evidence: "CROSS_REPO_SYNTHETIC", pins: Object.fromEntries(Object.entries(m.pins).map(([k, v]) => [k, v.commit])),
    selector: m.abi.selector, eventTopic: m.abi.topic, vectors: vectors.length, lifecycle,
    limitations: ["Software integration only; not live keeper E2E, deployed availability, session admission, or independent finality proof.", m.dependencyScope] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      assert.ok(["--core-root", "--mm-root"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--"), "required syntax: --core-root PATH --mm-root PATH");
      const key = args[i] === "--core-root" ? "coreRoot" : "mmRoot";
      assert.equal(options[key], undefined, `duplicate ${args[i]}`); options[key] = args[i + 1];
    }
    console.log(JSON.stringify(await checkCrossRepo(options), null, 2));
  } catch (error) { console.error(`keeper integration FAILED: ${error.message}`); process.exitCode = 1; }
}
