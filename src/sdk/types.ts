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

/**
 * Addresses of one deployed whole-lot vault app family (vault-contracts-bivium `BiviumVaultApp`,
 * TBVBTC lineage): the (mock) BTC vault registry, the app, the soulbound vaultBTC credential, the
 * FOC escrow and the fungible TBVBTC claim. `appBlock` is the app's deployment block (Wrapped scan floor).
 */
export interface VaultAppSection {
  registry: Address;
  app: Address;
  vaultBtc: Address;
  escrow: Address;
  tbvbtc: Address;
  appBlock: number;
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
  vaultApp?: VaultAppSection;
  gasFaucet?: Address;
  gasApi?: string;
  /** MaturitySettler periphery for last-window Dutch settlement; absent = not deployed on this chain. */
  maturitySettler?: Address;
  v4JitKeeper?: Address;
  /** MorphoJitFunder: the same zero-capital settle, funded by a Morpho Blue flash loan and converted on v4. */
  morphoJitFunder?: Address;
  /** StrategyRouter: one `execute(Leg[])` for a whole strategy; absent = not deployed on this chain. */
  strategyRouter?: Address;
  /** Uniswap v4 Quoter — a depth-aware floor for a swap leg. Absent: fall back to the pool's current price. */
  v4Quoter?: Address;
  /** Uniswap v4 StateView — the pool's current price, the marginal (and optimistic) floor. */
  v4StateView?: Address;
  coreDeploymentBlock?: number;
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
