import { concatHex, encodeAbiParameters, keccak256, stringToHex } from "viem";
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
