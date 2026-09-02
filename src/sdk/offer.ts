import { encodeAbiParameters, getAddress, keccak256 } from "viem";
import { adapterFor } from "./lineage.ts";
import type { Address, Hex, MarketParams, Offer, SignedOfferFile } from "./types.ts";

// Field order MUST match the Solidity core-v1 `Offer` struct (15 fields, MarketParams prefix).
const OFFER_COMPONENTS = [
  { name: "loanToken", type: "address" },
  { name: "collateralToken", type: "address" },
  { name: "maturity", type: "uint256" },
  { name: "strike", type: "uint256" },
  { name: "allowPartialRepay", type: "bool" },
  { name: "gate", type: "address" },
  { name: "maker", type: "address" },
  { name: "buy", type: "bool" },
  { name: "tick", type: "uint256" },
  { name: "maxUnits", type: "uint256" },
  { name: "maxAssets", type: "uint256" },
  { name: "start", type: "uint256" },
  { name: "expiry", type: "uint256" },
  { name: "group", type: "bytes32" },
  { name: "ratifier", type: "address" },
] as const;

const OFFER_TUPLE = { type: "tuple", components: OFFER_COMPONENTS } as const;

/** abi.encode(offer) — the preimage of the commitment the ratifier attests. */
export function encodeOffer(offer: Offer): Hex {
  return encodeAbiParameters([OFFER_TUPLE], [offer]);
}

/** The CORE-V1 commitment: keccak256(abi.encode(offer)) over the bare 15-field tuple, no domain.
 *
 *  This is NOT the commitment a core-v2 deployment (every current profile, Robinhood included) ratifies —
 *  core-v2 binds the domain into the preimage (17 fields, chainId + core prepended), so the correct call there
 *  is `adapterFor(profile.abiProfile).offerCommitment(domain, offer)`, which is what `parseSignedOfferFile`
 *  verifies against. Hashing a v2 offer with this function produces a plausible-looking hash that nothing
 *  on-chain will ever attest — when handling relayer entries, carry the entry's own `commitment` rather than
 *  recomputing with this. Kept exported for the core-v1 lineage and its golden vectors. */
export function offerCommitment(offer: Offer): Hex {
  return keccak256(encodeOffer(offer));
}

export function marketParamsFromOffer(offer: Offer): MarketParams {
  const { loanToken, collateralToken, maturity, strike, allowPartialRepay, gate } = offer;
  return { loanToken, collateralToken, maturity, strike, allowPartialRepay, gate };
}

const BIGINT_FIELDS = ["maturity", "strike", "tick", "maxUnits", "maxAssets", "start", "expiry"] as const;
const ADDRESS_FIELDS = ["loanToken", "collateralToken", "gate", "maker", "ratifier"] as const;
const BOOL_FIELDS = ["allowPartialRepay", "buy"] as const;

export function offerToJson(offer: Offer): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of ADDRESS_FIELDS) out[f] = offer[f];
  for (const f of BIGINT_FIELDS) out[f] = offer[f].toString();
  for (const f of BOOL_FIELDS) out[f] = offer[f];
  out.group = offer.group;
  return out;
}

export function offerFromJson(raw: Record<string, unknown>): Offer {
  const offer = {} as Offer;
  for (const f of ADDRESS_FIELDS) {
    const v = raw[f];
    if (typeof v !== "string") throw new Error(`offer.${f} missing`);
    offer[f] = getAddress(v) as Address;
  }
  for (const f of BIGINT_FIELDS) {
    const v = raw[f];
    if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`offer.${f} must be a decimal string`);
    offer[f] = BigInt(v);
  }
  for (const f of BOOL_FIELDS) {
    const v = raw[f];
    if (typeof v !== "boolean") throw new Error(`offer.${f} must be a boolean`);
    offer[f] = v;
  }
  const group = raw.group;
  if (typeof group !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(group)) throw new Error("offer.group must be bytes32");
  offer.group = group as Hex;
  return offer;
}

/**
 * Parse + verify a signed-offer interchange file: schema, profile domain (chain, core, ABI
 * lineage), and — critically — recompute the commitment from the offer fields with the profile's
 * lineage adapter; the embedded value is untrusted.
 */
export function parseSignedOfferFile(
  json: string,
  expected: { chainId: number; core: Address; abiProfile: "core-v1" | "core-v2" },
): { offer: Offer; commitment: Hex; signature: Hex } {
  const raw = JSON.parse(json) as SignedOfferFile;
  if (raw.schemaVersion !== 1 || (raw.abiProfile !== "core-v1" && raw.abiProfile !== "core-v2")) {
    throw new Error("unsupported offer file schema");
  }
  if (raw.abiProfile !== expected.abiProfile) {
    throw new Error(`offer file is ${raw.abiProfile}, profile is ${expected.abiProfile}`);
  }
  if (raw.chainId !== expected.chainId) throw new Error(`offer file is for chain ${raw.chainId}, profile is ${expected.chainId}`);
  if (getAddress(raw.core) !== getAddress(expected.core)) throw new Error("offer file is for a different core");
  const offer = offerFromJson(raw.offer as Record<string, unknown>);
  // Late import via live binding avoids a hard cycle with lineage.ts.
  const commitment = adapterFor(raw.abiProfile).offerCommitment({ chainId: expected.chainId, core: getAddress(expected.core) as Address }, offer);
  if (typeof raw.commitment !== "string" || commitment !== raw.commitment.toLowerCase()) {
    throw new Error("offer commitment mismatch — file does not match its own offer fields");
  }
  if (typeof raw.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(raw.signature)) {
    throw new Error("offer signature must be a 65-byte hex string");
  }
  return { offer, commitment, signature: raw.signature as Hex };
}

export function buildSignedOfferFile(
  profile: { chainId: number; core: Address; abiProfile: "core-v1" | "core-v2" },
  offer: Offer,
  commitment: Hex,
  signature: Hex,
): SignedOfferFile {
  return {
    schemaVersion: 1,
    abiProfile: profile.abiProfile,
    chainId: profile.chainId,
    core: profile.core,
    offer: offerToJson(offer) as SignedOfferFile["offer"],
    commitment,
    signature,
  };
}
