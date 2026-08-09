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
import { erc20Abi } from "./abi.ts";
import { adapterFor, type ChainDomain, type LineageAdapter } from "./lineage.ts";
import { collateralForDebt, principalForUnits } from "./math.ts";
import { marketParamsFromOffer } from "./offer.ts";
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
// computeId selector exists AND hashes identically to the SDK's local implementation for the
// profile's declared lineage. A wrong-lineage core reverts or mismatches; both refuse to run.
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
  readonly adapter: LineageAdapter;
  readonly pub: PublicClient<Transport>;
  private readonly wallet?: WalletClient<Transport, Chain | undefined, Account>;
  private profileVerified = false;

  constructor(profile: DeploymentProfile, account?: Account) {
    this.profile = profile;
    this.adapter = adapterFor(profile.abiProfile);
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

  private get domain(): ChainDomain {
    return { chainId: this.profile.chainId, core: this.profile.core };
  }

  /** Fail-closed ABI-lineage check — see CANARY note above. */
  async verifyProfile(): Promise<void> {
    if (this.profileVerified) return;
    const chainId = await this.pub.getChainId();
    if (chainId !== this.profile.chainId) {
      throw new Error(`RPC chain ${chainId} != profile chain ${this.profile.chainId}`);
    }
    const onchain = await this.computeIdOnChain(CANARY).catch(() => {
      throw new Error(
        `core ${this.profile.core} does not answer ${this.profile.abiProfile} computeId — wrong ABI lineage for profile "${this.profile.name}"`,
      );
    });
    if (onchain !== this.marketId(CANARY)) {
      throw new Error("on-chain computeId disagrees with SDK market hash — refusing to continue");
    }
    this.profileVerified = true;
  }

  // ---- reads -------------------------------------------------------------

  marketId(params: MarketParams): Hex {
    return this.adapter.computeMarketId(this.domain, params);
  }

  async computeIdOnChain(params: MarketParams): Promise<Hex> {
    return (await this.pub.readContract({
      address: this.profile.core,
      abi: this.adapter.coreAbi,
      functionName: "computeId",
      args: [this.adapter.chainParams(this.domain, params)],
    } as never)) as Hex;
  }

  private async readCore<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return (await this.pub.readContract({
      address: this.profile.core,
      abi: this.adapter.coreAbi,
      functionName,
      args,
    } as never)) as T;
  }

  async marketState(id: Hex): Promise<MarketState> {
    return await this.readCore("marketState", [id]);
  }

  async position(id: Hex, borrower: Address): Promise<Position> {
    return await this.readCore("position", [id, borrower]);
  }

  async creditOf(id: Hex, holder: Address): Promise<bigint> {
    return await this.readCore("creditOf", [id, holder]);
  }

  async liquidityOf(id: Hex, lender: Address): Promise<bigint> {
    return await this.readCore("liquidityOf", [id, lender]);
  }

  async consumed(maker: Address, group: Hex): Promise<bigint> {
    return await this.readCore("consumed", [maker, group]);
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
    const commitment = this.adapter.offerCommitment(this.domain, offer);
    const marketId = this.marketId(marketParamsFromOffer(offer));
    const block = await this.pub.getBlock();
    const now = block.timestamp;
    const [consumed, makerLiquidity, ratifierRegistered] = await Promise.all([
      this.consumed(offer.maker, offer.group),
      this.liquidityOf(marketId, offer.maker),
      this.readCore<boolean>("isRatifier", [offer.maker, offer.ratifier]),
    ]);
    let ratified = false;
    try {
      const result = await this.pub.readContract({
        address: offer.ratifier,
        abi: this.adapter.ratifierAbi,
        functionName: "isRatified",
        args: this.adapter.ratifierArgs(offer.maker, offer.maxUnits, commitment, signature),
      } as never);
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

  private writeCore(functionName: string, args: readonly unknown[]): Promise<TxResult> {
    return this.write({ address: this.profile.core, abi: this.adapter.coreAbi, functionName, args });
  }

  /** Exact-amount approval — never unlimited. */
  async approveExact(token: Address, spender: Address, amount: bigint): Promise<TxResult> {
    return await this.write({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  }

  async mint(token: Address, to: Address, amount: bigint): Promise<TxResult> {
    return await this.write({ address: token, abi: erc20Abi, functionName: "mint", args: [to, amount] });
  }

  async setRatifier(ratifier: Address, on: boolean): Promise<TxResult> {
    return await this.writeCore("setRatifier", [ratifier, on]);
  }

  async fund(params: MarketParams, assets: bigint): Promise<TxResult> {
    await this.approveExact(params.loanToken, this.profile.core, assets);
    const id = this.marketId(params);
    const before = await this.liquidityOf(id, this.account);
    const tx = await this.writeCore("fund", [this.adapter.chainParams(this.domain, params), assets]);
    const after = await this.liquidityOf(id, this.account);
    if (after - before !== assets) throw new Error("fund postcondition failed: liquidity delta != assets");
    return tx;
  }

  async withdrawLiquidity(params: MarketParams, assets: bigint, receiver: Address): Promise<TxResult> {
    return await this.writeCore("withdrawLiquidity", [this.adapter.chainParams(this.domain, params), this.account, assets, receiver]);
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
    const tx = await this.writeCore("fill", [this.adapter.chainOffer(this.domain, offer), signature, units, this.account, to]);
    const balanceAfter = await this.balanceOf(offer.loanToken, to);
    if (balanceAfter - balanceBefore !== quote.principal) {
      throw new Error(`fill postcondition failed: received ${balanceAfter - balanceBefore}, quoted ${quote.principal}`);
    }
    return { ...tx, ...quote };
  }

  async repay(params: MarketParams, assets: bigint): Promise<TxResult> {
    await this.approveExact(params.loanToken, this.profile.core, assets);
    return await this.writeCore("repay", [this.adapter.chainParams(this.domain, params), assets, this.account]);
  }

  async withdrawCollateral(params: MarketParams, receiver?: Address): Promise<TxResult> {
    return await this.writeCore("withdrawCollateral", [this.adapter.chainParams(this.domain, params), this.account, receiver ?? this.account]);
  }

  async claim(params: MarketParams, units: bigint, receiver?: Address): Promise<TxResult> {
    return await this.writeCore("claim", [this.adapter.chainParams(this.domain, params), units, this.account, receiver ?? this.account]);
  }
}
