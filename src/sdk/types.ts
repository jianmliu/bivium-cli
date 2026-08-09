export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** core-v1 lineage: 6-field market identity (no chainId/bivium domain prefix). */
export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  maturity: bigint;
  strike: bigint;
  allowPartialRepay: boolean;
  gate: Address;
}

/** core-v1 lineage: 15-field offer (MarketParams prefix + order fields). */
export interface Offer extends MarketParams {
  maker: Address;
  buy: boolean;
  tick: bigint;
  maxUnits: bigint;
  maxAssets: bigint;
  start: bigint;
  expiry: bigint;
  group: Hex;
  ratifier: Address;
}

export interface TokenInfo {
  address: Address;
  decimals: number;
  mintable?: boolean;
}

/** Addresses of one deployed TBV (whole-vault ERC-1155) family. `keeper` is the maker-role EOA/contract. */
export interface TbvSection {
  factory: Address;
  manager: Address;
  receipt: Address;
  vaultToken: Address;
  keeper: Address;
  redemption: Address;
  redemptionAsset: Address;
}

export interface DeploymentProfile {
  name: string;
  abiProfile: "core-v1" | "core-v2";
  chainId: number;
  core: Address;
  signatureRatifier: Address;
  rpcUrl: string;
  /** Optional signed-offer relayer origin (http(s)); enables `--source relayer` and `--publish`. */
  relayerUrl?: string;
  tokens?: Record<string, TokenInfo>;
  tbv?: TbvSection;
}

export interface MarketState {
  touched: boolean;
  activeCredit: bigint;
  repaidCredit: bigint;
  activeCollateral: bigint;
  claimedCredit: bigint;
}

export interface Position {
  debt: bigint;
  collateral: bigint;
  collateralWithdrawable: bigint;
}

/** Signed-offer interchange file (all bigints as decimal strings). */
export interface SignedOfferFile {
  schemaVersion: 1;
  abiProfile: "core-v1" | "core-v2";
  chainId: number;
  core: Address;
  offer: Record<keyof Offer, string | boolean>;
  commitment: Hex;
  signature: Hex;
}

export const STRIKE_SCALE = 10n ** 36n;
export const WAD = 10n ** 18n;
export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
