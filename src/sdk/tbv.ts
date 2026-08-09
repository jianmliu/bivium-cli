// TBV (whole-vault ERC-1155) extension — drives one TBVCollateralManager family end to end:
// createVault → fund → borrow (EIP-712 BorrowAuthorization) → repay | redeemDelivered.
// Same safety invariants as the base client: BigInt-only math, simulate-first writes, exact
// allowances, fail-closed cross-checks against the chain before every state change.
import { concatHex, encodeAbiParameters, keccak256, parseAbi, stringToHex, type LocalAccount } from "viem";
import { BiviumClient, type TxResult } from "./client.ts";
import { marketParamsFromOffer } from "./offer.ts";
import type { Address, Hex, MarketParams, Offer, TbvSection } from "./types.ts";
import { STRIKE_SCALE } from "./types.ts";

// ---- ABIs (hand-written from src/tbv/*.sol, core-v2 lineage only) ----------

export const tbvManagerAbi = parseAbi([
  "struct MarketParams { uint256 chainId; address bivium; address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; }",
  "struct Offer { uint256 chainId; address bivium; address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; address maker; bool buy; uint256 tick; uint256 maxUnits; uint256 maxAssets; uint256 start; uint256 expiry; bytes32 group; address ratifier; }",
  "struct VaultPosition { address token; address originalOwner; address positionAccount; uint256 tokenId; uint256 amount; uint256 receiptAmount; bytes32 marketId; uint256 fundingNonce; uint256 borrowedFace; uint8 state; }",
  "struct BorrowAuthorization { uint256 chainId; address manager; address bivium; address token; uint256 tokenId; uint256 amount; uint256 receiptAmount; address positionAccount; bytes32 marketId; uint256 fundingNonce; uint256 face; bytes32 offerCommitment; address borrower; uint256 deadline; uint256 intentNonce; }",
  "function fund(address token, uint256 tokenId, MarketParams params, uint256 expectedFundingNonce)",
  "function cancelFunding(address token, uint256 tokenId, uint256 expectedFundingNonce)",
  "function borrow(BorrowAuthorization auth, bytes signature, Offer offer, bytes ratifierData) returns (uint256)",
  "function repay(address token, uint256 tokenId, uint256 expectedFundingNonce, uint256 assets) returns (uint256)",
  "function redeemDelivered(bytes32 requestedPositionId)",
  "function position(address token, uint256 tokenId) view returns (VaultPosition)",
  "function marketParams(address token, uint256 tokenId) view returns (MarketParams)",
  "function fundingNonce(address token, uint256 tokenId) view returns (uint256)",
  "function positionId(address token, uint256 tokenId) view returns (bytes32)",
  "function isDelivered(address token, uint256 tokenId) view returns (bool)",
  "function isLivePositionAccount(address account) view returns (bool)",
  "function usedIntentNonce(address borrower, uint256 intentNonce) view returns (bool)",
  "function borrowAuthorizationDigest(BorrowAuthorization auth) view returns (bytes32)",
  "function BORROW_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function FACTORY() view returns (address)",
  "function RECEIPT() view returns (address)",
  "function KEEPER() view returns (address)",
  "function LOAN_TOKEN() view returns (address)",
  "function VAULT_TOKEN() view returns (address)",
  "function UNIT_SCALE() view returns (uint256)",
  "function MAX_TTM() view returns (uint256)",
]);

export const tbvFactoryAbi = parseAbi([
  "function createVault(address receiver, uint256 tokenId, uint256 amount, bytes creationData)",
  "function createdId(uint256 tokenId) view returns (bool)",
  "function canonicalGate(bytes32 marketId) view returns (address)",
  "function isCanonicalGate(bytes32 marketId, address gate) view returns (bool)",
  "function VAULT_TOKEN() view returns (address)",
]);

export const tbvVaultAbi = parseAbi([
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function completeSupply(uint256 tokenId) view returns (uint256)",
]);

export const tbvGateAbi = parseAbi([
  "function CHAIN_ID() view returns (uint256)",
  "function BIVIUM() view returns (address)",
  "function LOAN_TOKEN() view returns (address)",
  "function COLLATERAL_TOKEN() view returns (address)",
  "function MATURITY() view returns (uint256)",
  "function STRIKE() view returns (uint256)",
  "function MARKET_ID() view returns (bytes32)",
  "function MANAGER() view returns (address)",
  "function KEEPER() view returns (address)",
]);

export const tbvRedemptionAbi = parseAbi([
  "function issuer() view returns (address)",
  "function approveCreation(address factory, address caller, address receiver, uint256 tokenId, uint256 amount, bytes creationData)",
  "function creationDigest(address factory, address caller, address receiver, uint256 tokenId, uint256 amount, bytes creationData) view returns (bytes32)",
  "function approvedCreation(bytes32 digest) view returns (bool)",
]);

// ---- types -----------------------------------------------------------------

export const VAULT_STATES = ["Owned", "Funded", "Borrowed", "Repaid", "Delivered"] as const;
export type VaultStateName = (typeof VAULT_STATES)[number];

export interface VaultPosition {
  token: Address;
  originalOwner: Address;
  positionAccount: Address;
  tokenId: bigint;
  amount: bigint;
  receiptAmount: bigint;
  marketId: Hex;
  fundingNonce: bigint;
  borrowedFace: bigint;
  state: number;
}

export interface BorrowAuthorization {
  chainId: bigint;
  manager: Address;
  bivium: Address;
  token: Address;
  tokenId: bigint;
  amount: bigint;
  receiptAmount: bigint;
  positionAccount: Address;
  marketId: Hex;
  fundingNonce: bigint;
  face: bigint;
  offerCommitment: Hex;
  borrower: Address;
  deadline: bigint;
  intentNonce: bigint;
}

export interface VaultStatus {
  created: boolean;
  completeSupply: bigint;
  position?: VaultPosition;
  stateName?: VaultStateName;
  positionId?: Hex;
  isDelivered: boolean;
  managerBalance: bigint;
  ownerBalance: bigint;
  marketParams?: MarketParams;
}

// ---- EIP-712 BorrowAuthorization -------------------------------------------

/** The frozen struct definition — the manager pins its keccak256 as BORROW_AUTHORIZATION_TYPEHASH. */
export const BORROW_AUTHORIZATION_TYPE =
  "BorrowAuthorization(uint256 chainId,address manager,address bivium,address token,uint256 tokenId,uint256 amount,uint256 receiptAmount,address positionAccount,bytes32 marketId,uint256 fundingNonce,uint256 face,bytes32 offerCommitment,address borrower,uint256 deadline,uint256 intentNonce)";

export const BORROW_AUTHORIZATION_TYPEHASH: Hex = keccak256(stringToHex(BORROW_AUTHORIZATION_TYPE));

const TBV_DOMAIN_TYPEHASH = keccak256(stringToHex("EIP712Domain(uint256 chainId,address verifyingContract)"));

/**
 * EIP-712 digest the manager verifies in `borrow`: domain is {chainId, verifyingContract: manager}
 * only (no name/version, mirroring the SignatureRatifier convention), message is the full
 * 15-field BorrowAuthorization. auth.chainId / auth.manager double as the domain inputs — the
 * contract uses block.chainid / address(this), and `borrow` rejects any mismatch.
 */
export function borrowAuthorizationDigest(auth: BorrowAuthorization): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        BORROW_AUTHORIZATION_TYPEHASH,
        auth.chainId,
        auth.manager,
        auth.bivium,
        auth.token,
        auth.tokenId,
        auth.amount,
        auth.receiptAmount,
        auth.positionAccount,
        auth.marketId,
        auth.fundingNonce,
        auth.face,
        auth.offerCommitment,
        auth.borrower,
        auth.deadline,
        auth.intentNonce,
      ],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [TBV_DOMAIN_TYPEHASH, auth.chainId, auth.manager],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

// ---- whole-lot math (exact mirror of TBVMath.quote) ------------------------

export interface TbvQuote {
  receiptAmount: bigint;
  maximumFace: bigint;
}

/**
 * receiptAmount = amount / unitScale (exact division required), maximumFace = floor(receipt·strike
 * / 1e36); rejects any tuple whose ceil-inverse does not reproduce receiptAmount — the manager
 * enforces the identical round trip, so a quote that passes here cannot mismatch on-chain.
 */
export function tbvQuote(amount: bigint, unitScale: bigint, strike: bigint): TbvQuote {
  if (amount <= 0n) throw new RangeError("vault amount must be positive");
  if (unitScale <= 0n) throw new RangeError("unitScale must be positive");
  if (strike <= 0n) throw new RangeError("strike must be positive");
  if (amount % unitScale !== 0n) throw new RangeError(`vault amount ${amount} is not a whole multiple of unitScale ${unitScale}`);
  const receiptAmount = amount / unitScale;
  const maximumFace = (receiptAmount * strike) / STRIKE_SCALE;
  if (maximumFace === 0n) throw new RangeError("maximum face is zero — strike too small for this vault");
  const coreCollateral = (maximumFace * STRIKE_SCALE + strike - 1n) / strike;
  if (coreCollateral !== receiptAmount) {
    throw new RangeError(`whole-lot mismatch: face ${maximumFace} implies collateral ${coreCollateral}, receipt is ${receiptAmount}`);
  }
  return { receiptAmount, maximumFace };
}

/** positionId == keccak256(abi.encode(token, tokenId, fundingNonce)) — the redeemDelivered key. */
export function tbvPositionId(token: Address, tokenId: bigint, fundingNonce: bigint): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [token, tokenId, fundingNonce]),
  );
}

// ---- client ----------------------------------------------------------------

export class TbvClient extends BiviumClient {
  private readonly signer?: LocalAccount;
  private tbvVerified = false;

  constructor(profile: BiviumClient["profile"], account?: LocalAccount) {
    super(profile, account);
    this.signer = account;
  }

  get tbv(): TbvSection {
    const section = this.profile.tbv;
    if (!section) {
      throw new Error(`profile "${this.profile.name}" has no tbv section — TBV commands need a TBV-family deployment`);
    }
    return section;
  }

  private readManager<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.pub.readContract({ address: this.tbv.manager, abi: tbvManagerAbi, functionName, args } as never) as Promise<T>;
  }

  /**
   * Fail-closed family check before any TBV write: the profile's tbv addresses must be the
   * manager's own immutable bindings, and the manager's frozen BORROW_AUTHORIZATION_TYPEHASH must
   * equal the SDK's local typed-data hash (same spirit as verifyProfile's computeId canary).
   */
  async verifyTbv(): Promise<void> {
    if (this.tbvVerified) return;
    if (this.profile.abiProfile !== "core-v2") {
      throw new Error("TBV requires the domain-bound core-v2 lineage; this profile is core-v1");
    }
    await this.verifyProfile();
    const t = this.tbv;
    const [factory, receipt, keeper, loanToken, vaultToken, typehash] = await Promise.all([
      this.readManager<Address>("FACTORY", []),
      this.readManager<Address>("RECEIPT", []),
      this.readManager<Address>("KEEPER", []),
      this.readManager<Address>("LOAN_TOKEN", []),
      this.readManager<Address>("VAULT_TOKEN", []),
      this.readManager<Hex>("BORROW_AUTHORIZATION_TYPEHASH", []),
    ]);
    const mismatch = (label: string, onchain: string, local: string): never => {
      throw new Error(`tbv profile mismatch: manager ${label} is ${onchain}, profile says ${local}`);
    };
    if (factory.toLowerCase() !== t.factory.toLowerCase()) mismatch("FACTORY", factory, t.factory);
    if (receipt.toLowerCase() !== t.receipt.toLowerCase()) mismatch("RECEIPT", receipt, t.receipt);
    if (keeper.toLowerCase() !== t.keeper.toLowerCase()) mismatch("KEEPER", keeper, t.keeper);
    if (vaultToken.toLowerCase() !== t.vaultToken.toLowerCase()) mismatch("VAULT_TOKEN", vaultToken, t.vaultToken);
    if (loanToken.toLowerCase() === t.receipt.toLowerCase()) throw new Error("tbv manager LOAN_TOKEN equals receipt — refusing");
    if (typehash !== BORROW_AUTHORIZATION_TYPEHASH) {
      throw new Error("on-chain BORROW_AUTHORIZATION_TYPEHASH disagrees with SDK typed-data — refusing to continue");
    }
    this.tbvVerified = true;
  }

  // ---- reads ---------------------------------------------------------------

  async vaultPosition(tokenId: bigint): Promise<VaultPosition> {
    return await this.readManager<VaultPosition>("position", [this.tbv.vaultToken, tokenId]);
  }

  async vaultBalance(account: Address, tokenId: bigint): Promise<bigint> {
    return await this.pub.readContract({
      address: this.tbv.vaultToken,
      abi: tbvVaultAbi,
      functionName: "balanceOf",
      args: [account, tokenId],
    });
  }

  async vaultStatus(tokenId: bigint): Promise<VaultStatus> {
    const t = this.tbv;
    const created = await this.pub.readContract({
      address: t.factory,
      abi: tbvFactoryAbi,
      functionName: "createdId",
      args: [tokenId],
    });
    if (!created) {
      return { created: false, completeSupply: 0n, isDelivered: false, managerBalance: 0n, ownerBalance: 0n };
    }
    const [completeSupply, position, isDelivered, positionId] = await Promise.all([
      this.pub.readContract({ address: t.vaultToken, abi: tbvVaultAbi, functionName: "completeSupply", args: [tokenId] }),
      this.vaultPosition(tokenId),
      this.readManager<boolean>("isDelivered", [t.vaultToken, tokenId]),
      this.readManager<Hex>("positionId", [t.vaultToken, tokenId]),
    ]);
    const [managerBalance, ownerBalance, marketParams] = await Promise.all([
      this.vaultBalance(t.manager, tokenId),
      position.originalOwner === "0x0000000000000000000000000000000000000000"
        ? Promise.resolve(0n)
        : this.vaultBalance(position.originalOwner, tokenId),
      this.readManager<{ chainId: bigint; bivium: Address } & MarketParams>("marketParams", [t.vaultToken, tokenId]),
    ]);
    return {
      created: true,
      completeSupply,
      position,
      stateName: VAULT_STATES[position.state],
      positionId,
      isDelivered,
      managerBalance,
      ownerBalance,
      marketParams,
    };
  }

  async tbvUnitScale(): Promise<bigint> {
    return await this.readManager<bigint>("UNIT_SCALE", []);
  }

  /** Read one canonical gate's bound MarketParams and cross-check its MARKET_ID + registry entry. */
  async gateMarket(gate: Address): Promise<{ params: MarketParams; marketId: Hex }> {
    const read = <T>(functionName: string): Promise<T> =>
      this.pub.readContract({ address: gate, abi: tbvGateAbi, functionName } as never) as Promise<T>;
    const [chainId, bivium, loanToken, collateralToken, maturity, strike, marketId] = await Promise.all([
      read<bigint>("CHAIN_ID"),
      read<Address>("BIVIUM"),
      read<Address>("LOAN_TOKEN"),
      read<Address>("COLLATERAL_TOKEN"),
      read<bigint>("MATURITY"),
      read<bigint>("STRIKE"),
      read<Hex>("MARKET_ID"),
    ]);
    if (chainId !== BigInt(this.profile.chainId)) throw new Error(`gate is for chain ${chainId}, profile is ${this.profile.chainId}`);
    if (bivium.toLowerCase() !== this.profile.core.toLowerCase()) throw new Error("gate is bound to a different core");
    if (collateralToken.toLowerCase() !== this.tbv.receipt.toLowerCase()) throw new Error("gate collateral is not the TBV receipt");
    const params: MarketParams = { loanToken, collateralToken, maturity, strike, allowPartialRepay: false, gate };
    const localId = this.marketId(params);
    if (localId !== marketId) throw new Error(`gate MARKET_ID ${marketId} != SDK market hash ${localId} — wrong lineage or gate`);
    const canonical = await this.pub.readContract({
      address: this.tbv.factory,
      abi: tbvFactoryAbi,
      functionName: "isCanonicalGate",
      args: [marketId, gate],
    });
    if (!canonical) throw new Error("gate is not the factory's canonical gate for its market id");
    return { params, marketId };
  }

  // ---- writes --------------------------------------------------------------

  /** approveCreation (issuer-only on the testnet redemption) + createVault, empty creationData. */
  async tbvCreateVault(receiver: Address, tokenId: bigint, amount: bigint): Promise<TxResult> {
    await this.verifyTbv();
    if (amount <= 0n) throw new Error("vault amount must be positive");
    const t = this.tbv;
    const created = await this.pub.readContract({ address: t.factory, abi: tbvFactoryAbi, functionName: "createdId", args: [tokenId] });
    if (created) throw new Error(`vault token id ${tokenId} already created`);
    const unitScale = await this.tbvUnitScale();
    if (amount % unitScale !== 0n) throw new Error(`amount ${amount} is not a whole multiple of UNIT_SCALE ${unitScale}`);
    await this.write({
      address: t.redemption,
      abi: tbvRedemptionAbi,
      functionName: "approveCreation",
      args: [t.factory, this.account, receiver, tokenId, amount, "0x"],
    });
    const tx = await this.write({
      address: t.factory,
      abi: tbvFactoryAbi,
      functionName: "createVault",
      args: [receiver, tokenId, amount, "0x"],
    });
    const balance = await this.vaultBalance(receiver, tokenId);
    if (balance !== amount) throw new Error(`createVault postcondition failed: receiver holds ${balance}, expected ${amount}`);
    return tx;
  }

  /** Escrow the complete vault into the manager against the gate's bound market. */
  async tbvFund(tokenId: bigint, gate: Address): Promise<TxResult & { marketId: Hex; expectedFundingNonce: bigint; maximumFace: bigint }> {
    await this.verifyTbv();
    const t = this.tbv;
    const { params, marketId } = await this.gateMarket(gate);
    const [position, completeSupply, unitScale] = await Promise.all([
      this.vaultPosition(tokenId),
      this.pub.readContract({ address: t.vaultToken, abi: tbvVaultAbi, functionName: "completeSupply", args: [tokenId] }),
      this.tbvUnitScale(),
    ]);
    if (VAULT_STATES[position.state] !== "Owned") {
      throw new Error(`vault is not fundable (state ${VAULT_STATES[position.state]}) — the manager only funds Owned vaults`);
    }
    const holder = await this.vaultBalance(this.account, tokenId);
    if (holder !== completeSupply) throw new Error(`caller holds ${holder} of ${completeSupply} vault units — fund needs the complete vault`);
    const { maximumFace } = tbvQuote(completeSupply, unitScale, params.strike);
    const expectedFundingNonce = position.fundingNonce;
    const tx = await this.write({
      address: t.manager,
      abi: tbvManagerAbi,
      functionName: "fund",
      args: [t.vaultToken, tokenId, this.adapter.chainParams(this.chainDomain, params), expectedFundingNonce],
    });
    const after = await this.vaultPosition(tokenId);
    if (VAULT_STATES[after.state] !== "Funded") throw new Error("fund postcondition failed: vault not in Funded state");
    return { ...tx, marketId, expectedFundingNonce, maximumFace };
  }

  async tbvCancelFunding(tokenId: bigint): Promise<TxResult> {
    await this.verifyTbv();
    const t = this.tbv;
    const position = await this.vaultPosition(tokenId);
    if (VAULT_STATES[position.state] !== "Funded") throw new Error(`vault is not Funded (state ${VAULT_STATES[position.state]})`);
    if (position.originalOwner.toLowerCase() !== this.account.toLowerCase()) throw new Error("only the vault's original owner can cancel");
    const tx = await this.write({
      address: t.manager,
      abi: tbvManagerAbi,
      functionName: "cancelFunding",
      args: [t.vaultToken, tokenId, position.fundingNonce],
    });
    const balance = await this.vaultBalance(this.account, tokenId);
    if (balance !== position.amount) throw new Error("cancelFunding postcondition failed: vault not returned in full");
    return tx;
  }

  /**
   * Borrow against the escrowed vault: build the BorrowAuthorization from the live on-chain
   * position, sign it with the borrower key, precheck the keeper's resting bid via offerStatus,
   * submit, and require the borrower's loan-token delta to equal the quoted principal exactly.
   */
  async tbvBorrow(
    tokenId: bigint,
    offer: Offer,
    offerSignature: Hex,
    options?: { deadlineSeconds?: bigint; intentNonce?: bigint },
  ): Promise<TxResult & { face: bigint; principal: bigint; auth: BorrowAuthorization }> {
    await this.verifyTbv();
    if (!this.signer?.sign) throw new Error("borrow needs a local signing key (BorrowAuthorization is EIP-712 signed)");
    const t = this.tbv;
    const position = await this.vaultPosition(tokenId);
    if (VAULT_STATES[position.state] !== "Funded") throw new Error(`vault is not Funded (state ${VAULT_STATES[position.state]})`);
    if (position.originalOwner.toLowerCase() !== this.account.toLowerCase()) {
      throw new Error("the manager only accepts a BorrowAuthorization from the vault's original owner");
    }
    if (offer.maker.toLowerCase() !== t.keeper.toLowerCase()) throw new Error("offer maker is not the TBV keeper — the manager will reject it");
    if (!offer.buy) throw new Error("TBV borrow needs a resting BUY bid");
    const offerMarketId = this.marketId(marketParamsFromOffer(offer));
    if (offerMarketId !== position.marketId) throw new Error(`offer market ${offerMarketId} != funded market ${position.marketId}`);
    const unitScale = await this.tbvUnitScale();
    const { receiptAmount, maximumFace } = tbvQuote(position.amount, unitScale, offer.strike);
    if (receiptAmount !== position.receiptAmount) {
      throw new Error(`local receipt quote ${receiptAmount} != on-chain position ${position.receiptAmount}`);
    }
    const block = await this.pub.getBlock();
    const auth: BorrowAuthorization = {
      chainId: BigInt(this.profile.chainId),
      manager: t.manager,
      bivium: this.profile.core,
      token: t.vaultToken,
      tokenId,
      amount: position.amount,
      receiptAmount: position.receiptAmount,
      positionAccount: position.positionAccount,
      marketId: position.marketId,
      fundingNonce: position.fundingNonce,
      face: maximumFace,
      offerCommitment: this.adapter.offerCommitment(this.chainDomain, offer),
      borrower: this.account,
      deadline: block.timestamp + (options?.deadlineSeconds ?? 3600n),
      intentNonce: options?.intentNonce ?? (block.timestamp << 64n) + BigInt(tokenId),
    };
    const used = await this.readManager<boolean>("usedIntentNonce", [auth.borrower, auth.intentNonce]);
    if (used) throw new Error(`intent nonce ${auth.intentNonce} already used — pass a fresh one`);
    const digest = borrowAuthorizationDigest(auth);
    const onchainDigest = await this.readManager<Hex>("borrowAuthorizationDigest", [auth]);
    if (onchainDigest !== digest) throw new Error("local BorrowAuthorization digest disagrees with the manager — refusing to sign");
    const authSignature = await this.signer.sign({ hash: digest });

    const status = await this.offerStatus(offer, offerSignature);
    if (!status.withinWindow) throw new Error("offer is outside its [start, expiry] window");
    if (status.matured) throw new Error("market is at/past maturity");
    if (maximumFace > status.remainingUnits) throw new Error(`face ${maximumFace} exceeds offer's remaining capacity ${status.remainingUnits}`);
    if (!status.ratifierRegistered) throw new Error("keeper has not registered the offer's ratifier on core");
    if (!status.ratified) throw new Error("ratifier precheck did not return RATIFIED for this offer signature");
    const quote = await this.quoteFill(offer, maximumFace);
    if (status.makerLiquidity < quote.principal) throw new Error("keeper liquidity below required principal");

    const balanceBefore = await this.balanceOf(offer.loanToken, this.account);
    const tx = await this.write({
      address: t.manager,
      abi: tbvManagerAbi,
      functionName: "borrow",
      args: [auth, authSignature, this.adapter.chainOffer(this.chainDomain, offer), offerSignature],
    });
    const balanceAfter = await this.balanceOf(offer.loanToken, this.account);
    if (balanceAfter - balanceBefore !== quote.principal) {
      throw new Error(`borrow postcondition failed: received ${balanceAfter - balanceBefore}, quoted ${quote.principal}`);
    }
    return { ...tx, face: maximumFace, principal: quote.principal, auth };
  }

  /** Repay the exact face and require the complete vault back in the owner's balance. */
  async tbvRepay(tokenId: bigint): Promise<TxResult & { repaid: bigint }> {
    await this.verifyTbv();
    const t = this.tbv;
    const position = await this.vaultPosition(tokenId);
    if (VAULT_STATES[position.state] !== "Borrowed") throw new Error(`vault is not Borrowed (state ${VAULT_STATES[position.state]})`);
    if (position.originalOwner.toLowerCase() !== this.account.toLowerCase()) throw new Error("only the vault's original owner can repay");
    const loanToken = await this.readManager<Address>("LOAN_TOKEN", []);
    const assets = position.borrowedFace;
    await this.approveExact(loanToken, t.manager, assets);
    const tx = await this.write({
      address: t.manager,
      abi: tbvManagerAbi,
      functionName: "repay",
      args: [t.vaultToken, tokenId, position.fundingNonce, assets],
    });
    const [balance, after] = await Promise.all([this.vaultBalance(this.account, tokenId), this.vaultPosition(tokenId)]);
    if (balance !== position.amount) throw new Error(`repay postcondition failed: owner holds ${balance} of ${position.amount} vault units`);
    if (VAULT_STATES[after.state] !== "Repaid") throw new Error("repay postcondition failed: vault not in Repaid state");
    return { ...tx, repaid: assets };
  }

  /** Release one defaulted vault to the keeper (permissionless; keyed by positionId). */
  async tbvRedeemDelivered(positionId: Hex): Promise<TxResult> {
    await this.verifyTbv();
    return await this.write({
      address: this.tbv.manager,
      abi: tbvManagerAbi,
      functionName: "redeemDelivered",
      args: [positionId],
    });
  }

  private get chainDomain(): { chainId: number; core: Address } {
    return { chainId: this.profile.chainId, core: this.profile.core };
  }
}
