import { parseAbi } from "viem";

/** core-v1 lineage (6-field MarketParams / 15-field Offer) — the subset the SDK drives. */
export const coreV1Abi = parseAbi([
  "struct MarketParams { address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; }",
  "struct Offer { address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; address maker; bool buy; uint256 tick; uint256 maxUnits; uint256 maxAssets; uint256 start; uint256 expiry; bytes32 group; address ratifier; }",
  "struct MarketState { bool touched; uint256 activeCredit; uint256 repaidCredit; uint256 activeCollateral; uint256 claimedCredit; }",
  "struct Position { uint256 debt; uint256 collateral; uint256 collateralWithdrawable; }",
  "function computeId(MarketParams params) pure returns (bytes32)",
  "function tickToPrice(uint256 tick) pure returns (uint256)",
  "function fund(MarketParams params, uint256 assets)",
  "function withdrawLiquidity(MarketParams params, address lender, uint256 assets, address receiver)",
  "function fill(Offer offer, bytes ratifierData, uint256 units, address taker, address receiver) returns (uint256, uint256)",
  "function repay(MarketParams params, uint256 assets, address borrower) returns (uint256)",
  "function withdrawCollateral(MarketParams params, address borrower, address receiver) returns (uint256)",
  "function claim(MarketParams params, uint256 units, address holder, address receiver) returns (uint256, uint256)",
  "function setRatifier(address ratifier, bool newIsRatifier)",
  "function setConsumed(bytes32 group, uint256 amount, address onBehalf)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function isRatifier(address maker, address ratifier) view returns (bool)",
  "function consumed(address maker, bytes32 group) view returns (uint256)",
  "function marketState(bytes32 id) view returns (MarketState)",
  "function position(bytes32 id, address borrower) view returns (Position)",
  "function creditOf(bytes32 id, address holder) view returns (uint256)",
  "function liquidityOf(bytes32 id, address lender) view returns (uint256)",
]);

/** core-v2 lineage (domain-bound): 8-field MarketParams / 17-field Offer, same function surface. */
export const coreV2Abi = parseAbi([
  "struct MarketParams { uint256 chainId; address bivium; address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; }",
  "struct Offer { uint256 chainId; address bivium; address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; address maker; bool buy; uint256 tick; uint256 maxUnits; uint256 maxAssets; uint256 start; uint256 expiry; bytes32 group; address ratifier; }",
  "struct MarketState { bool touched; uint256 activeCredit; uint256 repaidCredit; uint256 activeCollateral; uint256 claimedCredit; }",
  "struct Position { uint256 debt; uint256 collateral; uint256 collateralWithdrawable; }",
  "function computeId(MarketParams params) pure returns (bytes32)",
  "function hashOffer(Offer offer) pure returns (bytes32)",
  "function tickToPrice(uint256 tick) pure returns (uint256)",
  "function fund(MarketParams params, uint256 assets)",
  "function withdrawLiquidity(MarketParams params, address lender, uint256 assets, address receiver)",
  "function fill(Offer offer, bytes ratifierData, uint256 units, address taker, address receiver) returns (uint256, uint256)",
  "function repay(MarketParams params, uint256 assets, address borrower) returns (uint256)",
  "function withdrawCollateral(MarketParams params, address borrower, address receiver) returns (uint256)",
  "function claim(MarketParams params, uint256 units, address holder, address receiver) returns (uint256, uint256)",
  "function setRatifier(address ratifier, bool newIsRatifier)",
  "function setConsumed(bytes32 group, uint256 amount, address onBehalf)",
  "function multicall(bytes[] data) returns (bytes[])",
  "function isRatifier(address maker, address ratifier) view returns (bool)",
  "function consumed(address maker, bytes32 group) view returns (uint256)",
  "function marketState(bytes32 id) view returns (MarketState)",
  "function position(bytes32 id, address borrower) view returns (Position)",
  "function creditOf(bytes32 id, address holder) view returns (uint256)",
  "function liquidityOf(bytes32 id, address lender) view returns (uint256)",
  // bivium-core #171: collateral a borrower escrowed so its resting ASK can originate debt when filled.
  "function collateralEscrowOf(bytes32 id, address borrower) view returns (uint256)",
]);

export const ratifierV1Abi = parseAbi([
  "function isRatified(address maker, uint256 units, bytes32 commitment, bytes ratifierData) view returns (bytes32)",
]);

/** core-v2 IRatifier gained the represented-taker argument. */
export const ratifierV2Abi = parseAbi([
  "function isRatified(address maker, address taker, uint256 units, bytes32 commitment, bytes ratifierData) view returns (bytes32)",
]);

/** @deprecated alias kept for existing imports — v1 shape. */
export const ratifierAbi = ratifierV1Abi;

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);
