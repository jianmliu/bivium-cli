import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, stringToHex, decodeAbiParameters } from "viem";
import {
  buildOfferTree, merkleRoot, encodeProofRatifierData, setRootRatifiedCalldata, resolveRatifier,
} from "../src/sdk/ratify.ts";
import type { Address, Hex } from "../src/sdk/types.ts";

// These roots and proofs are cross-checked against the REAL contract: the same vectors are asserted
// in bivium-core `test/ratifiers/SetterRatifierCliVectors.t.sol`, where `SetterRatifier.isRatified`
// must return RATIFIED for each. If this fold ever drifts from `_merkleRoot`, a maker would flag a
// root no offer folds to and every quote would be silently unfillable, so both sides are pinned.
const leaf = (i: number): Hex => keccak256(stringToHex(`offer-${i}`));
const leaves = (n: number): Hex[] => Array.from({ length: n }, (_, i) => leaf(i));

test("offer tree: a single offer is its own root, with an empty proof", () => {
  const t = buildOfferTree([leaf(0)]);
  assert.equal(t.root, "0x4feb9960b76bd157f2300fab76390af1f31df1b2fe94dce8465a48ea0676c2e4");
  assert.equal(t.root, leaf(0));
  assert.deepEqual(t.proofs[0], []);
  assert.equal(merkleRoot(leaf(0), []), t.root);
});

test("offer tree: roots match the Solidity fold for 2, 3, 5 and 8 leaves", () => {
  const expected: Record<number, Hex> = {
    2: "0x3c04605d5737ee9a1f5499cbadde5a8258b3cf50ca69b3c13b660cafb2e36146",
    3: "0xed23a2d6c7ddf7b7a2c97e6e19b6472be89ad8df1fc970aad472684d2d7c17c7",
    5: "0xccd5e03048d01c6da98a6d8ef43be07089bc79e135e6edb16bbf9a14d8ab94b6",
    8: "0xfd4219307bbf9998728b47cb968e192e8fbdace7c21f250e2a4c09277cd7d533",
  };
  for (const [n, root] of Object.entries(expected)) {
    const t = buildOfferTree(leaves(Number(n)));
    assert.equal(t.root, root, `N=${n}`);
    // Every leaf must fold back to the root with its own proof.
    t.leaves.forEach((l, i) => assert.equal(merkleRoot(l, t.proofs[i]!), t.root, `N=${n} leaf ${i}`));
  }
});

test("offer tree: an odd node is promoted unpaired, giving it a shorter proof", () => {
  const t = buildOfferTree(leaves(3));
  assert.equal(t.proofs[0]!.length, 2);
  assert.equal(t.proofs[1]!.length, 2);
  assert.equal(t.proofs[2]!.length, 1); // promoted past the first level
  assert.equal(t.proofs[2]![0], "0x3c04605d5737ee9a1f5499cbadde5a8258b3cf50ca69b3c13b660cafb2e36146");
});

test("offer tree: a foreign commitment folds to a different root, and duplicates collapse", () => {
  const t = buildOfferTree(leaves(4));
  assert.notEqual(merkleRoot(leaf(9), t.proofs[0]!), t.root);
  assert.equal(buildOfferTree([leaf(0), leaf(0), leaf(1)]).leaves.length, 2);
  assert.throws(() => buildOfferTree([]), /at least one commitment/);
});

test("ratifierData is abi.encode(bytes32[] proof), and the flag call encodes correctly", () => {
  const t = buildOfferTree(leaves(3));
  const data = encodeProofRatifierData(t.proofs[0]!);
  const [decoded] = decodeAbiParameters([{ type: "bytes32[]" }], data);
  assert.deepEqual([...decoded], t.proofs[0]);
  // An empty proof is legal: it is what a single-offer root is filled with.
  const [empty] = decodeAbiParameters([{ type: "bytes32[]" }], encodeProofRatifierData([]));
  assert.deepEqual([...empty], []);
  const maker = "0x00000000000000000000000000000000000a11ce" as Address;
  const call = setRootRatifiedCalldata(maker, t.root, true);
  assert.match(call, /^0x[0-9a-f]+$/);
  assert.ok(call.includes(t.root.slice(2)), "the root is in the calldata");
  assert.ok(call.endsWith("1"), "ratified=true is the last word");
});

test("resolveRatifier: setter wins when the deployment has one, signature otherwise", () => {
  const sig = "0x0000000000000000000000000000000000000501" as Address;
  const set = "0x0000000000000000000000000000000000000502" as Address;
  // No setter recorded: nothing changes for the profiles that predate this.
  assert.deepEqual(resolveRatifier({ signatureRatifier: sig }), { kind: "signature", address: sig });
  // Setter recorded: it becomes the default, the way Midnight defaults to approval over signing.
  assert.deepEqual(resolveRatifier({ signatureRatifier: sig, setterRatifier: set }), { kind: "setter", address: set });
  // Explicit opt-out and opt-in.
  assert.deepEqual(resolveRatifier({ signatureRatifier: sig, setterRatifier: set }, "signature"), { kind: "signature", address: sig });
  assert.deepEqual(resolveRatifier({ signatureRatifier: sig, setterRatifier: set }, "setter"), { kind: "setter", address: set });
  assert.throws(() => resolveRatifier({ signatureRatifier: sig }, "setter"), /no setterRatifier/);
});
