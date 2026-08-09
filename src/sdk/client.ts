import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
  type Transport,
  type Chain,
} from "viem";
import { coreV1Abi, erc20Abi, ratifierAbi } from "./abi.ts";
import { computeMarketId } from "./market.ts";
import { collateralForDebt, principalForUnits } from "./math.ts";
import { offerCommitment, marketParamsFromOffer } from "./offer.ts";
import { RATIFIED } from "./ratify.ts";
import { simpleAprBpsFromPrice, tickToPrice } from "./tick.ts";
import {
  ZERO_ADDRESS,
  type Address,
  type DeploymentProfile,
  type Hex,
  type MarketParams,
  type MarketState,
  type Offer,
  type Position,
} from "./types.ts";

export interface TxResult {
  hash: Hex;
  gasUsed: bigint;
  blockNumber: bigint;
}

export interface FillQuote {
  priceWad: bigint;
  principal: bigint;
  collateral: bigint;
  aprBps: bigint;
  secondsToMaturity: bigint;
}

export interface OfferStatus {
  commitment: Hex;
  marketId: Hex;
  withinWindow: boolean;
  matured: boolean;
  consumed: bigint;
  cap: bigint;
  remainingUnits: bigint;
  makerLiquidity: bigint;
  ratifierRegistered: boolean;
  ratified: boolean;
}

// Canary tuple for verifyProfile(): any fixed params work — the check is that the on-chain
// computeId selector exists AND hashes identically to the SDK's local implementation.
const CANARY: MarketParams = {
  loanToken: "0x0000000000000000000000000000000000000001",
  collateralToken: "0x0000000000000000000000000000000000000002",
  maturity: 1n,
  strike: 10n ** 36n,
  allowPartialRepay: false,
  gate: ZERO_ADDRESS,
};

export class BiviumClient {
  readonly profile: DeploymentProfile;
  readonly pub: PublicClient<Transport>;
  private readonly wallet?: WalletClient<Transport, Chain | undefined, Account>;
  private profileVerified = false;

  constructor(profile: DeploymentProfile, account?: Account) {
    this.profile = profile;
    const chain = {
      id: profile.chainId,
      name: profile.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [profile.rpcUrl] } },
    } satisfies Chain;
    this.pub = createPublicClient({ chain, transport: http(profile.rpcUrl) });
    if (account) this.wallet = createWalletClient({ account, chain, transport: http(profile.rpcUrl) });
  }

  get account(): Address {
    if (!this.wallet) throw new Error("no signing account configured");
    return this.wallet.account.address;
  }

  /**
   * Fail-closed ABI-lineage check: the live core must expose the core-v1 computeId selector and
   * agree byte-for-byte with the SDK's local market hash. A domain-bound (core-v2) core reverts
   * here — refusing to run is the point (this exact mismatch happened in the wild).
   */
  async verifyProfile(): Promise<void> {
    if (this.profileVerified) return;
    const chainId = await this.pub.getChainId();
    if (chainId !== this.profile.chainId) {
      throw new Error(`RPC chain ${chainId} != profile chain ${this.profile.chainId}`);
    }
    let onchain: Hex;
    try {
      onchain = await this.pub.readContract({
        address: this.profile.core,
        abi: coreV1Abi,
        functionName: "computeId",
        args: [CANARY],
      });
    } catch {
      throw new Error(
        `core ${this.profile.core} does not answer core-v1 computeId — wrong ABI lineage for profile "${this.profile.name}"`,
      );
    }
    if (onchain !== computeMarketId(CANARY)) {
      throw new Error("on-chain computeId disagrees with SDK market hash — refusing to continue");
    }
    this.profileVerified = true;
  }

  // ---- reads -------------------------------------------------------------

  marketId(params: MarketParams): Hex {
    return computeMarketId(params);
  }

  async marketState(id: Hex): Promise<MarketState> {
    return await this.pub.readContract({ address: this.profile.core, abi: coreV1Abi, functionName: "marketState", args: [id] });
  }

  async position(id: Hex, borrower: Address): Promise<Position> {
    return await this.pub.readContract({ address: this.profile.core, abi: coreV1Abi, functionName: "position", args: [id, borrower] });
  }

  async creditOf(id: Hex, holder: Address): Promise<bigint> {
    return await this.pub.readContract({ address: this.profile.core, abi: coreV1Abi, functionName: "creditOf", args: [id, holder] });
  }

  async liquidityOf(id: Hex, lender: Address): Promise<bigint> {
    return await this.pub.readContract({ address: this.profile.core, abi: coreV1Abi, functionName: "liquidityOf", args: [id, lender] });
  }

  async consumed(maker: Address, group: Hex): Promise<bigint> {
    return await this.pub.readContract({ address: this.profile.core, abi: coreV1Abi, functionName: "consumed", args: [maker, group] });
  }

  async tokenDecimals(token: Address): Promise<number> {
    return await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  }

  async balanceOf(token: Address, account: Address): Promise<bigint> {
    return await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
  }

  /** Quote a fill of `units` face against a resting BUY offer — exact core rounding. */
  async quoteFill(offer: Offer, units: bigint): Promise<FillQuote> {
    const priceWad = tickToPrice(offer.tick);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const secondsToMaturity = offer.maturity > now ? offer.maturity - now : 0n;
    return {
      priceWad,
      principal: principalForUnits(units, priceWad),
      collateral: collateralForDebt(units, offer.strike),
      aprBps: secondsToMaturity > 0n ? simpleAprBpsFromPrice(priceWad, secondsToMaturity) : 0n,
      secondsToMaturity,
    };
  }

  /** Every check `borrow execute` runs before spending gas. */
  async offerStatus(offer: Offer, signature: Hex): Promise<OfferStatus> {
    const commitment = offerCommitment(offer);
    const marketId = computeMarketId(marketParamsFromOffer(offer));
    const block = await this.pub.getBlock();
    const now = block.timestamp;
    const [consumed, makerLiquidity, ratifierRegistered] = await Promise.all([
      this.consumed(offer.maker, offer.group),
      this.liquidityOf(marketId, offer.maker),
      this.pub.readContract({
        address: this.profile.core,
        abi: coreV1Abi,
        functionName: "isRatifier",
        args: [offer.maker, offer.ratifier],
      }),
    ]);
    let ratified = false;
    try {
      const result = await this.pub.readContract({
        address: offer.ratifier,
        abi: ratifierAbi,
        functionName: "isRatified",
        args: [offer.maker, offer.maxUnits, commitment, signature],
      });
      ratified = result === RATIFIED;
    } catch {
      ratified = false;
    }
    const cap = offer.maxUnits;
    return {
      commitment,
      marketId,
      withinWindow: now >= offer.start && now <= offer.expiry,
      matured: now >= offer.maturity,
      consumed,
      cap,
      remainingUnits: consumed >= cap ? 0n : cap - consumed,
      makerLiquidity,
      ratifierRegistered,
      ratified,
    };
  }

  // ---- writes (simulate-first, exact allowances, balance-delta postconditions) ----

  private async write(request: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<TxResult> {
    if (!this.wallet) throw new Error("no signing account configured");
    await this.verifyProfile();
    // Simulation first: custom errors surface with names instead of estimateGas noise.
    // Dynamic functionName defeats viem's literal-type inference; the boundary cast is contained here.
    const { request: simulated } = await this.pub.simulateContract({
      account: this.wallet.account,
      ...request,
    } as never);
    const hash = await this.wallet.writeContract(simulated as never);
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return { hash, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber };
  }

  /** Exact-amount approval — never unlimited. */
  async approveExact(token: Address, spender: Address, amount: bigint): Promise<TxResult> {
    return await this.write({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  }

  async mint(token: Address, to: Address, amount: bigint): Promise<TxResult> {
    return await this.write({ address: token, abi: erc20Abi, functionName: "mint", args: [to, amount] });
  }

  async setRatifier(ratifier: Address, on: boolean): Promise<TxResult> {
    return await this.write({ address: this.profile.core, abi: coreV1Abi, functionName: "setRatifier", args: [ratifier, on] });
  }

  async fund(params: MarketParams, assets: bigint): Promise<TxResult> {
    await this.approveExact(params.loanToken, this.profile.core, assets);
    const before = await this.liquidityOf(computeMarketId(params), this.account);
    const tx = await this.write({ address: this.profile.core, abi: coreV1Abi, functionName: "fund", args: [params, assets] });
    const after = await this.liquidityOf(computeMarketId(params), this.account);
    if (after - before !== assets) throw new Error("fund postcondition failed: liquidity delta != assets");
    return tx;
  }

  async withdrawLiquidity(params: MarketParams, assets: bigint, receiver: Address): Promise<TxResult> {
    return await this.write({
      address: this.profile.core,
      abi: coreV1Abi,
      functionName: "withdrawLiquidity",
      args: [params, this.account, assets, receiver],
    });
  }

  /**
   * Borrow: approve exact collateral, fill the resting BUY offer as taker, verify the received
   * principal equals the local quote exactly.
   */
  async fillAsBorrower(offer: Offer, signature: Hex, units: bigint, receiver?: Address): Promise<TxResult & FillQuote> {
    const to = receiver ?? this.account;
    const status = await this.offerStatus(offer, signature);
    if (!status.withinWindow) throw new Error("offer is outside its [start, expiry] window");
    if (status.matured) throw new Error("market is at/past maturity — new debt cannot be issued");
    if (units > status.remainingUnits) throw new Error(`units ${units} exceed remaining capacity ${status.remainingUnits}`);
    if (!status.ratifierRegistered) throw new Error("maker has not registered the offer's ratifier on core");
    if (!status.ratified) throw new Error("ratifier precheck did not return RATIFIED for this signature");
    const quote = await this.quoteFill(offer, units);
    if (status.makerLiquidity < quote.principal) throw new Error("maker liquidity below required principal");

    await this.approveExact(offer.collateralToken, this.profile.core, quote.collateral);
    const balanceBefore = await this.balanceOf(offer.loanToken, to);
    const tx = await this.write({
      address: this.profile.core,
      abi: coreV1Abi,
      functionName: "fill",
      args: [offer, signature, units, this.account, to],
    });
    const balanceAfter = await this.balanceOf(offer.loanToken, to);
    if (balanceAfter - balanceBefore !== quote.principal) {
      throw new Error(`fill postcondition failed: received ${balanceAfter - balanceBefore}, quoted ${quote.principal}`);
    }
    return { ...tx, ...quote };
  }

  async repay(params: MarketParams, assets: bigint): Promise<TxResult> {
    await this.approveExact(params.loanToken, this.profile.core, assets);
    return await this.write({ address: this.profile.core, abi: coreV1Abi, functionName: "repay", args: [params, assets, this.account] });
  }

  async withdrawCollateral(params: MarketParams, receiver?: Address): Promise<TxResult> {
    return await this.write({
      address: this.profile.core,
      abi: coreV1Abi,
      functionName: "withdrawCollateral",
      args: [params, this.account, receiver ?? this.account],
    });
  }

  async claim(params: MarketParams, units: bigint, receiver?: Address): Promise<TxResult> {
    return await this.write({
      address: this.profile.core,
      abi: coreV1Abi,
      functionName: "claim",
      args: [params, units, this.account, receiver ?? this.account],
    });
  }
}
