// Lineage adapters — the one place the v1 (6/15-field) and v2 (domain-bound 8/17-field) ABI
// shapes are allowed to differ. Everything above this layer speaks the 6 economic market fields;
// the adapter injects the profile's {chainId, core} domain where the lineage requires it.
import { encodeAbiParameters, keccak256 } from "viem";
import { coreV1Abi, coreV2Abi, ratifierV1Abi, ratifierV2Abi } from "./abi.ts";
import { computeMarketId } from "./market.ts";
import { encodeOffer } from "./offer.ts";
import { ZERO_ADDRESS, type Address, type Hex, type MarketParams, type Offer } from "./types.ts";

export interface ChainDomain {
  chainId: number;
  core: Address;
}

const V2_PARAMS_ABI = [
  { type: "uint256" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "bool" },
  { type: "address" },
] as const;

const V2_OFFER_COMPONENTS = [
  { name: "chainId", type: "uint256" },
  { name: "bivium", type: "address" },
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

export function computeMarketIdV2(domain: ChainDomain, params: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(V2_PARAMS_ABI, [
      BigInt(domain.chainId),
      domain.core,
      params.loanToken,
      params.collateralToken,
      params.maturity,
      params.strike,
      params.allowPartialRepay,
      params.gate,
    ]),
  );
}

export function encodeOfferV2(domain: ChainDomain, offer: Offer): Hex {
  return encodeAbiParameters([{ type: "tuple", components: V2_OFFER_COMPONENTS }], [
    { chainId: BigInt(domain.chainId), bivium: domain.core, ...offer },
  ]);
}

export function offerCommitmentV2(domain: ChainDomain, offer: Offer): Hex {
  return keccak256(encodeOfferV2(domain, offer));
}

export interface LineageAdapter {
  readonly abiProfile: "core-v1" | "core-v2";
  readonly coreAbi: readonly unknown[];
  readonly ratifierAbi: readonly unknown[];
  computeMarketId(domain: ChainDomain, params: MarketParams): Hex;
  offerCommitment(domain: ChainDomain, offer: Offer): Hex;
  /** Params tuple value as the chain's ABI expects it (object keyed by component names). */
  chainParams(domain: ChainDomain, params: MarketParams): unknown;
  /** Offer tuple value as the chain's ABI expects it. */
  chainOffer(domain: ChainDomain, offer: Offer): unknown;
  /** isRatified args — v2 inserts the represented taker (SignatureRatifier ignores it). */
  ratifierArgs(maker: Address, units: bigint, commitment: Hex, data: Hex): readonly unknown[];
}

const coreV1: LineageAdapter = {
  abiProfile: "core-v1",
  coreAbi: coreV1Abi,
  ratifierAbi: ratifierV1Abi,
  computeMarketId: (_domain, params) => computeMarketId(params),
  offerCommitment: (_domain, offer) => keccak256(encodeOffer(offer)),
  chainParams: (_domain, params) => params,
  chainOffer: (_domain, offer) => offer,
  ratifierArgs: (maker, units, commitment, data) => [maker, units, commitment, data],
};

const coreV2: LineageAdapter = {
  abiProfile: "core-v2",
  coreAbi: coreV2Abi,
  ratifierAbi: ratifierV2Abi,
  computeMarketId: computeMarketIdV2,
  offerCommitment: offerCommitmentV2,
  chainParams: (domain, params) => ({ chainId: BigInt(domain.chainId), bivium: domain.core, ...params }),
  chainOffer: (domain, offer) => ({ chainId: BigInt(domain.chainId), bivium: domain.core, ...offer }),
  // Precheck taker: SignatureRatifier's isRatified ignores the taker argument (the signature only
  // covers the commitment), so the zero address is a faithful precheck stand-in.
  ratifierArgs: (maker, units, commitment, data) => [maker, ZERO_ADDRESS, units, commitment, data],
};

export function adapterFor(abiProfile: "core-v1" | "core-v2"): LineageAdapter {
  if (abiProfile === "core-v1") return coreV1;
  if (abiProfile === "core-v2") return coreV2;
  throw new Error(`unsupported abiProfile ${JSON.stringify(abiProfile)}`);
}
