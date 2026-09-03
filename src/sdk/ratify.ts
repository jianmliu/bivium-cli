import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, stringToHex } from "viem";
import type { Address, Hex } from "./types.ts";

/** Magic success value returned by isRatified — keccak256("bivium.ratifier.ratified"). */
export const RATIFIED: Hex = keccak256(stringToHex("bivium.ratifier.ratified"));

const DOMAIN_TYPEHASH = keccak256(stringToHex("EIP712Domain(uint256 chainId,address verifyingContract)"));
const RATIFY_TYPEHASH = keccak256(stringToHex("Ratify(bytes32 commitment)"));

/**
 * EIP-712 digest the SignatureRatifier verifies: domain is {chainId, verifyingContract} only
 * (no name/version), message is Ratify(bytes32 commitment).
 */
export function ratifyDigest(chainId: number, ratifier: Address, commitment: Hex): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_TYPEHASH, BigInt(chainId), ratifier],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [RATIFY_TYPEHASH, commitment]),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// SetterRatifier — on-chain approval instead of a signature.
//
// The maker (or an operator it authorized in the core) flags a Merkle ROOT on-chain; every offer
// whose commitment is a leaf of that tree is then fillable by supplying the proof as `ratifierData`.
// This is the no-signature counterpart to the signature ratifier and the only form a CONTRACT maker
// can use, since a contract cannot produce an EIP-712 signature and neither ratifier falls back to
// EIP-1271. It is also what Morpho's Midnight defaults to for humans: approving a named transaction
// is far harder to phish than signing an opaque typed-data blob.
//
// The hashing MUST match the core's `SetterRatifier._merkleRoot`: commutative sorted pairs, the raw
// `commitment` as the leaf, no leaf index, and an EMPTY proof means `root == commitment` (flagging a
// single offer directly). Getting this wrong yields offers that hash to an unflagged root and simply
// never fill, so `test/ratify-setter.test.ts` re-derives these vectors against the Solidity.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One step of the fold: commutative sorted-pair hashing, identical to the core's `_merkleRoot`. */
function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concatHex([lo, hi]));
}

/** Fold a leaf up to its root with `proof`. An empty proof returns the leaf (a single-offer flag). */
export function merkleRoot(leaf: Hex, proof: readonly Hex[]): Hex {
  let computed = leaf;
  for (const p of proof) computed = hashPair(computed, p);
  return computed;
}

export interface OfferTree {
  /** The value the maker flags on-chain with `setRootRatified`. */
  root: Hex;
  /** Proof per leaf, in the order the leaves were given. */
  proofs: Hex[][];
  /** The leaves, deduplicated and in input order. */
  leaves: Hex[];
}

/**
 * Build the tree a maker flags for a whole book: one on-chain approval authorizes every offer in it,
 * and clearing that one root retires the whole book. An odd node at any level is promoted unpaired,
 * which is what the sorted-pair fold expects. A single leaf yields `root == leaf` with an empty proof.
 */
export function buildOfferTree(commitments: readonly Hex[]): OfferTree {
  const leaves = [...new Set(commitments.map((c) => c.toLowerCase() as Hex))];
  if (leaves.length === 0) throw new Error("an offer tree needs at least one commitment");
  const proofs: Hex[][] = leaves.map(() => []);
  // `indices` tracks, for every original leaf, which node of the current level it sits under.
  let level = [...leaves];
  let indices = leaves.map((_, i) => i);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (right === undefined) {
        next.push(left); // odd node: promoted unpaired, no proof element added
        continue;
      }
      next.push(hashPair(left, right));
      // Every original leaf under the left node needs `right` as its next sibling, and vice versa.
      for (let k = 0; k < indices.length; k++) {
        if (indices[k] === i) proofs[k]!.push(right);
        else if (indices[k] === i + 1) proofs[k]!.push(left);
      }
    }
    indices = indices.map((n) => Math.floor(n / 2));
    level = next;
  }
  return { root: level[0]!, proofs, leaves };
}

/** `ratifierData` for the setter ratifier: `abi.encode(bytes32[] proof)`. */
export function encodeProofRatifierData(proof: readonly Hex[]): Hex {
  return encodeAbiParameters([{ type: "bytes32[]" }], [proof as Hex[]]);
}

/** Calldata for `setRootRatified(address maker, bytes32 root, bool ratified)`. */
export function setRootRatifiedCalldata(maker: Address, root: Hex, ratified: boolean): Hex {
  return encodeFunctionData({ abi: setterRatifierAbi, functionName: "setRootRatified", args: [maker, root, ratified] });
}

export const setterRatifierAbi = [
  {
    type: "function",
    name: "setRootRatified",
    stateMutability: "nonpayable",
    inputs: [{ name: "maker", type: "address" }, { name: "root", type: "bytes32" }, { name: "ratified", type: "bool" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isRootRatified",
    stateMutability: "view",
    inputs: [{ name: "maker", type: "address" }, { name: "root", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Which ratifier attests a maker's offers on this deployment. */
export type RatifierKind = "setter" | "signature";

/**
 * The active ratifier. Midnight's default is on-chain approval, and so is ours WHENEVER the
 * deployment has a setter deployed: approving a named transaction cannot be phished the way an
 * opaque typed-data blob can, and it is the only path open to a contract maker. A profile without
 * `setterRatifier` (every profile predating this change) keeps the signature ratifier, so nothing
 * flips until an address is actually recorded. `override` is the per-invocation opt-out.
 */
export function resolveRatifier(
  profile: { signatureRatifier: Address; setterRatifier?: Address },
  override?: RatifierKind,
): { kind: RatifierKind; address: Address } {
  if (override === "signature") return { kind: "signature", address: profile.signatureRatifier };
  if (override === "setter") {
    if (!profile.setterRatifier) throw new Error("profile has no setterRatifier — deploy one, or pass --ratifier signature");
    return { kind: "setter", address: profile.setterRatifier };
  }
  return profile.setterRatifier
    ? { kind: "setter", address: profile.setterRatifier }
    : { kind: "signature", address: profile.signatureRatifier };
}
