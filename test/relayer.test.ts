// Relayer client vs an in-process node:http stub implementing the observed wire protocol
// (fixtures adapted from the frontend's functions/api/offers.ts behavior). Anvil dev key #0 —
// publicly known, testing only — signs the maker fixtures.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { adapterFor } from "../src/sdk/lineage.ts";
import { ratifyDigest } from "../src/sdk/ratify.ts";
import {
  cancelMessage,
  deleteSignedOffer,
  fetchRelayerBook,
  publishSignedOffer,
  requireRelayerV2,
  wireOffer,
  type RelayerDomain,
} from "../src/sdk/relayer.ts";
import { marketParamsFromOffer } from "../src/sdk/offer.ts";
import type { Address, Hex, Offer } from "../src/sdk/types.ts";
import { startRelayerStub, type RelayerStub } from "./helpers/relayer-stub.ts";

const ANVIL0_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const ANVIL1_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const maker = privateKeyToAccount(ANVIL0_PK);
const stranger = privateKeyToAccount(ANVIL1_PK);

const CORE = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const RATIFIER = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const CHAIN_ID = 31337;
const adapter = adapterFor("core-v2");
const chainDomain = { chainId: CHAIN_ID, core: CORE };

const now = BigInt(Math.floor(Date.now() / 1000));
const MATURITY = now + 30n * 86_400n;

function makeAskOffer(tick: bigint, group: Hex): Offer {
  return {
    loanToken: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    collateralToken: "0x0000000000000000000000000000000000000002",
    maturity: MATURITY,
    strike: 3n * 10n ** 27n,
    allowPartialRepay: false,
    gate: "0x0000000000000000000000000000000000000000",
    maker: maker.address as Address,
    buy: false,
    tick,
    maxUnits: 1_000_000n,
    maxAssets: 0n,
    start: 0n,
    expiry: now + 7n * 86_400n,
    group,
    ratifier: RATIFIER,
  };
}

async function signOffer(offer: Offer): Promise<Hex> {
  const commitment = adapter.offerCommitment(chainDomain, offer);
  return await maker.sign({ hash: ratifyDigest(CHAIN_ID, offer.ratifier, commitment) });
}

let stub: RelayerStub;
let domain: RelayerDomain;

before(async () => {
  stub = await startRelayerStub({ chainId: CHAIN_ID, core: CORE });
  domain = { chainId: CHAIN_ID, core: CORE, abiProfile: "core-v2", signatureRatifier: RATIFIER, relayerUrl: stub.url };
});

after(async () => {
  await stub.close();
});

beforeEach(() => {
  stub.rows.length = 0;
  stub.mode = "ok";
});

const G1 = ("0x" + "01".repeat(32)) as Hex;
const G2 = ("0x" + "02".repeat(32)) as Hex;

test("POST then GET round-trips a signed offer through the wire shape", async () => {
  const offer = makeAskOffer(4032n, G1);
  const signature = await signOffer(offer);
  const { commitment } = await publishSignedOffer(domain, offer, signature);
  assert.equal(commitment, adapter.offerCommitment(chainDomain, offer));

  const result = await fetchRelayerBook(domain, marketParamsFromOffer(offer));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0];
    assert.equal(entry.commitment.toLowerCase(), commitment.toLowerCase());
    assert.equal(entry.side, "ask");
    assert.equal(entry.size, offer.maxUnits);
    assert.equal(entry.signature, signature);
    assert.deepEqual(entry.offer, offer);
  }
});

test("healthy empty book is ok:true — distinct from a down relayer", async () => {
  const params = marketParamsFromOffer(makeAskOffer(4032n, G1));
  const empty = await fetchRelayerBook(domain, params);
  assert.deepEqual(empty, { ok: true, entries: [] });

  stub.mode = "http500";
  const down = await fetchRelayerBook(domain, params);
  assert.equal(down.ok, false);

  stub.mode = "not-array";
  const garbage = await fetchRelayerBook(domain, params);
  assert.equal(garbage.ok, false);

  const dead = await fetchRelayerBook({ ...domain, relayerUrl: "http://127.0.0.1:1" }, params, { timeoutMs: 1_000 });
  assert.equal(dead.ok, false);
});

test("one tampered-commitment row poisons the whole batch (fail closed)", async () => {
  const good = makeAskOffer(4032n, G1);
  await publishSignedOffer(domain, good, await signOffer(good));

  // Same market identity, but the stored commitment does not match the offer fields.
  const evil = makeAskOffer(4048n, G2);
  stub.rows.push({
    offer: wireOffer(chainDomain, evil),
    signature: await signOffer(evil),
    commitment: adapter.offerCommitment(chainDomain, good), // lies
  });

  const result = await fetchRelayerBook(domain, marketParamsFromOffer(good));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /malformed or mismatched/);
});

test("a structurally invalid row (off-grid tick) also poisons the batch", async () => {
  const good = makeAskOffer(4032n, G1);
  await publishSignedOffer(domain, good, await signOffer(good));

  const offGrid = makeAskOffer(4033n, G2); // tick % 4 != 0
  stub.rows.push({
    offer: wireOffer(chainDomain, offGrid),
    signature: await signOffer(offGrid),
    commitment: adapter.offerCommitment(chainDomain, offGrid),
  });

  const result = await fetchRelayerBook(domain, marketParamsFromOffer(good));
  assert.equal(result.ok, false);
});

test("a lying relayer serving another market's (valid) offer is rejected as a batch", async () => {
  const served = makeAskOffer(4032n, G1);
  const row = {
    offer: wireOffer(chainDomain, served),
    signature: await signOffer(served),
    commitment: adapter.offerCommitment(chainDomain, served),
  };
  const liar = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([row]));
  });
  await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
  const port = (liar.address() as { port: number }).port;
  try {
    // Request a DIFFERENT market (other maturity): the served row's identity must not pass.
    const other = { ...marketParamsFromOffer(served), maturity: served.maturity + 86_400n };
    const result = await fetchRelayerBook({ ...domain, relayerUrl: `http://127.0.0.1:${port}` }, other);
    assert.equal(result.ok, false);
  } finally {
    await new Promise<void>((resolve, reject) => liar.close((e) => (e ? reject(e) : resolve())));
  }
});

test("expired offers are skipped, not treated as poison", async () => {
  const offer = makeAskOffer(4032n, G1);
  await publishSignedOffer(domain, offer, await signOffer(offer));
  const result = await fetchRelayerBook(domain, marketParamsFromOffer(offer), { nowSec: offer.expiry });
  assert.deepEqual(result, { ok: true, entries: [] });
});

test("POST rejection surfaces the server error (signature from a non-maker)", async () => {
  const offer = makeAskOffer(4032n, G1);
  const commitment = adapter.offerCommitment(chainDomain, offer);
  const badSignature = await stranger.sign({ hash: ratifyDigest(CHAIN_ID, offer.ratifier, commitment) });
  await assert.rejects(publishSignedOffer(domain, offer, badSignature), /401.*signer/);
});

test("DELETE requires the maker's EIP-191 cancel signature", async () => {
  const offer = makeAskOffer(4032n, G1);
  const signature = await signOffer(offer);
  const { commitment } = await publishSignedOffer(domain, offer, signature);

  const strangerSig = await stranger.signMessage({ message: cancelMessage(commitment) });
  await assert.rejects(deleteSignedOffer(domain, offer, commitment, strangerSig), /401|refused/);
  assert.equal(stub.rows.length, 1);

  const makerSig = await maker.signMessage({ message: cancelMessage(commitment) });
  await deleteSignedOffer(domain, offer, commitment, makerSig);
  assert.equal(stub.rows.length, 0);
  const result = await fetchRelayerBook(domain, marketParamsFromOffer(offer));
  assert.deepEqual(result, { ok: true, entries: [] });
});

test("relayer surface is core-v2 only (17-field wire offers)", async () => {
  assert.throws(() => requireRelayerV2("core-v1"), /core-v2/);
  await assert.rejects(
    publishSignedOffer({ ...domain, abiProfile: "core-v1" }, makeAskOffer(4032n, G1), ("0x" + "11".repeat(65)) as Hex),
    /core-v2/,
  );
});
