// Whole-lot vault app extension — drives one deployed vault-contracts-bivium `BiviumVaultApp` family
// (TBVBTC lineage) end to end: mock activate (testnet faucet) → borrowAgainst (whole-group escrow of
// soulbound vaultBTC into ONE lender bid) → releaseRepaid | reclaim | markDelivered, the vaultBTC ↔ TBVBTC
// door (convert / unconvert / convertDelivered), the native-BTC redemption book, and keeper settlement.
// Same safety invariants as the base client: BigInt-only math, simulate-first writes, exact allowances,
// fail-closed cross-checks against the chain before every state change.
import { decodeEventLog, parseAbi, type Account } from "viem";
import { erc20Abi } from "./abi.ts";
import { BiviumClient, type TxResult } from "./client.ts";
import { collateralForDebt, principalForUnits } from "./math.ts";
import { marketParamsFromOffer } from "./offer.ts";
import { tickToPrice } from "./tick.ts";
import { STRIKE_SCALE, type Address, type DeploymentProfile, type Hex, type Offer, type VaultAppSection } from "./types.ts";

// ---- ABIs (hand-written from vault-contracts-bivium/src, core-v2 lineage only) ---------------------

export const vaultAppAbi = parseAbi([
  "struct Offer { uint256 chainId; address bivium; address loanToken; address collateralToken; uint256 maturity; uint256 strike; bool allowPartialRepay; address gate; address maker; bool buy; uint256 tick; uint256 maxUnits; uint256 maxAssets; uint256 start; uint256 expiry; bytes32 group; address ratifier; }",
  "function borrowAgainst(bytes32[] vaultIds, Offer offer, bytes ratifierData, address receiver) returns (uint256 principal)",
  "function releaseRepaid(bytes32 vaultId)",
  "function reclaim(bytes32 vaultId)",
  "function markDelivered(bytes32 vaultId)",
  "function convert(bytes32 vaultId)",
  "function unconvert(bytes32 vaultId)",
  "function convertDelivered(uint256 sats)",
  "function settleDelivered(bytes32 vaultId)",
  "function postRedemption(uint256 amount, uint256 minSatsStart, uint256 minSatsEnd, bytes btcDest, uint256 deadline) returns (uint256 id)",
  "function cancelRedemption(uint256 id)",
  "function claimFill(uint256 id, bytes32 btcTxid)",
  "function redemptionCount() view returns (uint256)",
  "function redemptions(uint256 id) view returns (address owner, uint256 amount, uint256 minSatsStart, uint256 minSatsEnd, uint256 postedAt, uint256 deadline, bool closed, bytes btcDest)",
  "function minSatsAt(uint256 id, uint256 t) view returns (uint256)",
  "function lots(bytes32 vaultId) view returns (address origin, uint256 amount, uint8 status, bytes32 loanId, address borrower, uint256 maturity, bool converted, uint256 keeperVersion)",
  "function groupVaults(bytes32 loanId, address borrower) view returns (bytes32[])",
  "function keeperCount() view returns (uint256)",
  "function keepers(uint256 index) view returns (address)",
  "function avkKeyOf(address keeper) view returns (bytes32)",
  "function keeperIndexOf(address keeper) view returns (uint256)",
  "function REGISTRY() view returns (address)",
  "function VAULT_BTC() view returns (address)",
  "function ESCROW() view returns (address)",
  "function TBV_BTC() view returns (address)",
  "function BIVIUM() view returns (address)",
  "event Wrapped(bytes32 indexed vaultId, address indexed depositor, uint256 amount)",
  "event Borrowed(bytes32 indexed loanId, address indexed borrower, uint256 units, uint256 principal)",
  "event Delivered(bytes32 indexed vaultId)",
  "event Reclaimed(bytes32 indexed vaultId, address indexed depositor)",
  "event Released(bytes32 indexed loanId, address indexed borrower)",
  "event Converted(bytes32 indexed vaultId, address indexed origin, uint256 amount)",
  "event Unconverted(bytes32 indexed vaultId, address indexed origin, uint256 amount, bool wasDefault)",
  "event RedemptionPosted(uint256 indexed id, address indexed owner, uint256 amount, uint256 minSatsStart, uint256 minSatsEnd, uint256 deadline, bytes btcDest)",
  "event RedemptionCancelled(uint256 indexed id)",
  "event RedemptionFilled(uint256 indexed id, bytes32 btcTxid, uint256 minSatsDue)",
  "event Settled(bytes32 indexed vaultId, bytes32 keeperKey)",
]);

/** Testnet peg-in stand-in: `activate` is permissionless and IS the "Get Mock Vault" faucet. */
export const mockVaultRegistryAbi = parseAbi([
  "function activate(address app, bytes32 vaultId, address depositor, uint256 sats)",
  "function lastDepositorRedeem() view returns (bytes32)",
  "function lastAvkRedeem() view returns (bytes32)",
  "function redeemCount(bytes32 vaultId) view returns (uint256)",
]);

export const vaultBtcEscrowAbi = parseAbi([
  "function checkInvariant() view returns (bool balanced, uint256 lockedVaultBtc, uint256 tbvbtcSupply)",
  "function TBV_BTC() view returns (address)",
]);

/** vaultBTC is a soulbound-to-origin ERC-20; `canTransfer` exposes its policy. */
export const vaultBtcAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function canTransfer(address operator, address from, address to, uint256 amount) view returns (bool)",
]);

/** The core's capability-grant surface the app relies on (not part of the base lineage ABI). */
export const grantAbi = parseAbi([
  "function grantOf(address authorizer, address authorized) view returns (uint256 capabilities, uint256 expiry)",
  "function grantAuthorization(address authorized, uint256 capabilities, uint256 expiry)",
]);

const totalSupplyAbi = parseAbi(["function totalSupply() view returns (uint256)"]);

// ---- types + pure helpers --------------------------------------------------------------------------

/** 1 << 2 — the only capability the borrower grants the app. */
export const CAP_FILL = 4n;

export const LOT_STATUSES = ["None", "Reserved", "Delivered", "Consumed"] as const;
export type LotStatusName = (typeof LOT_STATUSES)[number];
export const LotStatus = { None: 0, Reserved: 1, Delivered: 2, Consumed: 3 } as const;

export function lotStatusName(status: number): LotStatusName | `Unknown(${number})` {
  return LOT_STATUSES[status] ?? `Unknown(${status})`;
}

export interface VaultLot {
  vaultId: Hex;
  origin: Address;
  /** sats — the lot's complete, indivisible size */
  amount: bigint;
  status: number;
  /** core market id of the bound loan; zero when unbound (never borrowed / released) */
  loanId: Hex;
  borrower: Address;
  maturity: bigint;
  /** Delivered via the origin's own `convert` (true) or via default (false) */
  converted: boolean;
  keeperVersion: bigint;
}

const UNBOUND = /^0x0+$/;
export function lotIsBound(lot: Pick<VaultLot, "loanId">): boolean {
  return !UNBOUND.test(lot.loanId);
}

/** The grant covers the app iff CAP_FILL is set and the grant has not expired (0 = no expiry). */
export function grantCoversFill(capabilities: bigint, expiry: bigint, nowSec: bigint): boolean {
  return (capabilities & CAP_FILL) === CAP_FILL && (expiry === 0n || nowSec <= expiry);
}

/** Face units for a whole-lot group: floor(Σsats × strike / STRIKE_SCALE) — dust-free strikes ⇒ exact. */
export function wholeLotFace(sumSats: bigint, strike: bigint): bigint {
  if (sumSats < 0n) throw new RangeError("sumSats must be non-negative");
  if (strike <= 0n) throw new RangeError("strike must be positive");
  return (sumSats * strike) / STRIKE_SCALE;
}

/**
 * The app's `_escrowFill` requires core collateral == Σsats exactly: face must be non-zero and its
 * ceil-inverse must reproduce the group size. Any other strike reverts NotWholeVaultEscrow on-chain,
 * so refuse it here before spending gas.
 */
export function assertWholeLotStrike(sumSats: bigint, strike: bigint): bigint {
  const face = wholeLotFace(sumSats, strike);
  if (face === 0n) throw new RangeError(`face is zero — ${sumSats} sats is below the strike grid`);
  const collateral = collateralForDebt(face, strike);
  if (collateral !== sumSats) {
    throw new RangeError(`off-grid strike: face ${face} implies collateral ${collateral}, group is ${sumSats} sats`);
  }
  return face;
}

export type LotAction = "reclaim" | "withdraw-first" | "repay-first" | "unconvert" | "awaiting-settle" | "none";
/**
 * `action` is the origin's primary road; `secondary: "release"` marks a repaid group whose binding can
 * be cleared to re-borrow; `convert` marks an UNBOUND Reserved lot (borrowable / convertible / reclaimable).
 */
export interface LotView {
  lot: VaultLot;
  state: string;
  action: LotAction;
  secondary?: "release";
  convert?: boolean;
}

/**
 * Resolve one lot's state (mirrors the frontend's portfolio semantics). `debt` is the bound core loan's
 * live debt (0n when unbound), `walletSats` the viewer's vaultBTC balance, `groupSats` the bound group's
 * total (whole-group reclaim burns exactly that from the borrower). `viewer` defaults to the origin; a
 * non-origin viewer of a Delivered lot (a keeper) sees the settle road instead of unconvert.
 */
export function lotView(lot: VaultLot, debt: bigint, walletSats: bigint, groupSats: bigint, viewer?: Address): LotView {
  const isOrigin = viewer === undefined || viewer.toLowerCase() === lot.origin.toLowerCase();
  if (lot.status === LotStatus.None) return { lot, state: "unknown vault id — never wrapped", action: "none" };
  if (lot.status === LotStatus.Consumed) return { lot, state: "consumed — left the system (reclaimed or settled)", action: "none" };
  if (lot.status === LotStatus.Delivered) {
    const how = lot.converted ? "converted to TBVBTC" : "defaulted · in the keeper pool";
    if (!isOrigin) return { lot, state: `${how} — awaiting keeper settlement (settleDelivered burns equal TBVBTC)`, action: "awaiting-settle" };
    return { lot, state: `${how} — buy back with equal TBVBTC (unconvert) while unsettled`, action: "unconvert" };
  }
  // Reserved:
  if (!lotIsBound(lot)) {
    return { lot, state: "wrapped · idle — borrow against it, convert to TBVBTC, or reclaim", action: "reclaim", convert: true };
  }
  if (debt > 0n) return { lot, state: "collateral for a live loan — repay the exact face on the core first", action: "repay-first" };
  if (walletSats < groupSats) {
    return { lot, state: "repaid — withdraw the group's collateral from the core first (reclaim)", action: "withdraw-first" };
  }
  return { lot, state: "repaid · still bound — release to borrow again, or reclaim", action: "reclaim", secondary: "release" };
}

export interface RedemptionOrder {
  owner: Address;
  amount: bigint;
  minSatsStart: bigint;
  minSatsEnd: bigint;
  postedAt: bigint;
  deadline: bigint;
  closed: boolean;
  btcDest: Hex;
}

export interface RedemptionRow extends RedemptionOrder {
  id: bigint;
  minSatsNow: bigint;
  mine: boolean;
  /** mine + open + past deadline */
  cancelable: boolean;
}

export function redemptionRow(id: bigint, order: RedemptionOrder, minSatsNow: bigint, me: Address | undefined, nowSec: bigint): RedemptionRow {
  const mine = Boolean(me && order.owner.toLowerCase() === me.toLowerCase());
  return { id, ...order, minSatsNow, mine, cancelable: mine && !order.closed && nowSec > order.deadline };
}

/** Local mirror of `minSatsAt`: linear decay start → end over [postedAt, deadline], floored. */
export function minSatsAt(order: Pick<RedemptionOrder, "minSatsStart" | "minSatsEnd" | "postedAt" | "deadline">, t: bigint): bigint {
  if (t <= order.postedAt) return order.minSatsStart;
  if (t >= order.deadline) return order.minSatsEnd;
  return order.minSatsStart - ((order.minSatsStart - order.minSatsEnd) * (t - order.postedAt)) / (order.deadline - order.postedAt);
}

/** Mirror of the app's `BadOrder` guard, evaluated before spending gas. */
export function validateRedemptionPost(input: { amount: bigint; minSatsStart: bigint; minSatsEnd: bigint; btcDest: string; deadline: bigint; nowSec: bigint }): string | undefined {
  if (input.amount <= 0n) return "amount must be positive";
  if (input.minSatsEnd <= 0n) return "min-sats-end must be positive";
  if (input.minSatsEnd > input.minSatsStart) return "min-sats-end must not exceed min-sats-start";
  if (input.minSatsStart > input.amount) return "min-sats-start must not exceed amount";
  if (!/^0x[0-9a-fA-F]{2,}$/.test(input.btcDest) || input.btcDest.length % 2 !== 0) return "btc-dest must be non-empty hex bytes (0x…)";
  if (input.deadline <= input.nowSec) return "deadline must be in the future";
  return undefined;
}

export interface WholeLotQuote {
  lots: VaultLot[];
  sumSats: bigint;
  marketId: Hex;
  /** issued face — Σsats × strike / 1e36 */
  face: bigint;
  /** the borrower's pre-existing credit in the market, swept into the fill by the app */
  credit: bigint;
  /** units the app fills = face + credit */
  units: bigint;
  priceWad: bigint;
  /** floor(units × price / WAD) — what the receiver gets */
  principal: bigint;
}

export interface BorrowPrereqs {
  sumSats: bigint;
  allowance: bigint;
  approved: boolean;
  granted: boolean;
}

// ---- client ------------------------------------------------------------------------------------------

export class VaultAppClient extends BiviumClient {
  private vaultAppVerified = false;

  constructor(profile: DeploymentProfile, account?: Account) {
    super(profile, account);
  }

  get vaultApp(): VaultAppSection {
    const section = this.profile.vaultApp;
    if (!section) {
      throw new Error(`profile "${this.profile.name}" has no vaultApp section — vault commands need a whole-lot vault app deployment`);
    }
    return section;
  }

  private readApp<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.pub.readContract({ address: this.vaultApp.app, abi: vaultAppAbi, functionName, args } as never) as Promise<T>;
  }

  private writeApp(functionName: string, args: readonly unknown[]): Promise<TxResult> {
    return this.write({ address: this.vaultApp.app, abi: vaultAppAbi, functionName, args });
  }

  /**
   * Fail-closed family check before any vault write: the profile's section must equal the app's own
   * immutable bindings and the app must be bound to the profile's core (same spirit as verifyProfile).
   */
  async verifyVaultApp(): Promise<void> {
    if (this.vaultAppVerified) return;
    if (this.profile.abiProfile !== "core-v2") {
      throw new Error("the vault app requires the domain-bound core-v2 lineage; this profile is core-v1");
    }
    await this.verifyProfile();
    const v = this.vaultApp;
    const [registry, vaultBtc, escrow, tbvbtc, bivium] = await Promise.all([
      this.readApp<Address>("REGISTRY"),
      this.readApp<Address>("VAULT_BTC"),
      this.readApp<Address>("ESCROW"),
      this.readApp<Address>("TBV_BTC"),
      this.readApp<Address>("BIVIUM"),
    ]);
    const mismatch = (label: string, onchain: string, local: string): never => {
      throw new Error(`vaultApp profile mismatch: app ${label} is ${onchain}, profile says ${local}`);
    };
    if (registry.toLowerCase() !== v.registry.toLowerCase()) mismatch("REGISTRY", registry, v.registry);
    if (vaultBtc.toLowerCase() !== v.vaultBtc.toLowerCase()) mismatch("VAULT_BTC", vaultBtc, v.vaultBtc);
    if (escrow.toLowerCase() !== v.escrow.toLowerCase()) mismatch("ESCROW", escrow, v.escrow);
    if (tbvbtc.toLowerCase() !== v.tbvbtc.toLowerCase()) mismatch("TBV_BTC", tbvbtc, v.tbvbtc);
    if (bivium.toLowerCase() !== this.profile.core.toLowerCase()) mismatch("BIVIUM", bivium, this.profile.core);
    this.vaultAppVerified = true;
  }

  // ---- reads ---------------------------------------------------------------------------------------

  async lot(vaultId: Hex): Promise<VaultLot> {
    const [origin, amount, status, loanId, borrower, maturity, converted, keeperVersion] =
      await this.readApp<readonly [Address, bigint, number, Hex, Address, bigint, boolean, bigint]>("lots", [vaultId]);
    return { vaultId, origin, amount, status, loanId, borrower, maturity, converted, keeperVersion };
  }

  /** Wrapped(depositor=account) logs from appBlock → live `lots` reads (chain state is authoritative). */
  async listLots(account: Address, options?: { chunkSize?: bigint }): Promise<VaultLot[]> {
    const event = vaultAppAbi.find((item) => item.type === "event" && item.name === "Wrapped");
    const fromBlock = BigInt(this.vaultApp.appBlock);
    const args = { depositor: account };
    let logs: ReadonlyArray<{ args: { vaultId: Hex } }>;
    try {
      logs = (await this.pub.getLogs({ address: this.vaultApp.app, event: event as never, args, fromBlock, toBlock: "latest" } as never)) as never;
    } catch {
      // Provider refused the range: fall back to a chunked scan (same discipline as market discovery).
      const chunk = options?.chunkSize ?? 9000n;
      const latest = await this.pub.getBlockNumber();
      const collected: Array<{ args: { vaultId: Hex } }> = [];
      for (let from = fromBlock; from <= latest; from += chunk) {
        const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
        const page = (await this.pub.getLogs({ address: this.vaultApp.app, event: event as never, args, fromBlock: from, toBlock: to } as never)) as never;
        collected.push(...(page as Array<{ args: { vaultId: Hex } }>));
      }
      logs = collected;
    }
    const ids = [...new Set(logs.map((log) => log.args.vaultId.toLowerCase() as Hex))];
    return await Promise.all(ids.map((id) => this.lot(id)));
  }

  /** Resolve every lot's next action for `account`: live debt per bound group, wallet vaultBTC, group sizes. */
  async resolveLots(lots: VaultLot[], viewer: Address): Promise<LotView[]> {
    const walletSats = await this.balanceOf(this.vaultApp.vaultBtc, viewer);
    const groupSats = new Map<string, bigint>();
    for (const lot of lots) if (lotIsBound(lot) && lot.status === LotStatus.Reserved) {
      const key = `${lot.loanId.toLowerCase()}:${lot.borrower.toLowerCase()}`;
      groupSats.set(key, (groupSats.get(key) ?? 0n) + lot.amount);
    }
    const debts = new Map<string, bigint>();
    for (const key of groupSats.keys()) {
      const [loanId, borrower] = key.split(":") as [Hex, Address];
      debts.set(key, (await this.position(loanId, borrower)).debt);
    }
    return lots.map((lot) => {
      const key = `${lot.loanId.toLowerCase()}:${lot.borrower.toLowerCase()}`;
      return lotView(lot, debts.get(key) ?? 0n, walletSats, groupSats.get(key) ?? lot.amount, viewer);
    });
  }

  async resolveLot(vaultId: Hex, viewer?: Address): Promise<LotView> {
    const lot = await this.lot(vaultId);
    if (!lotIsBound(lot) || lot.status !== LotStatus.Reserved) return lotView(lot, 0n, 0n, lot.amount, viewer);
    // Bound Reserved: the whole group's size and live debt decide the road.
    const group = await this.readApp<readonly Hex[]>("groupVaults", [lot.loanId, lot.borrower]);
    let groupSats = 0n;
    for (const id of group) groupSats += (await this.lot(id)).amount;
    const [debt, walletSats] = await Promise.all([
      this.position(lot.loanId, lot.borrower).then((p) => p.debt),
      this.balanceOf(this.vaultApp.vaultBtc, lot.borrower),
    ]);
    return lotView(lot, debt, walletSats, groupSats === 0n ? lot.amount : groupSats, viewer);
  }

  private async grantOf(authorizer: Address): Promise<{ capabilities: bigint; expiry: bigint }> {
    const [capabilities, expiry] = await this.pub.readContract({
      address: this.profile.core,
      abi: grantAbi,
      functionName: "grantOf",
      args: [authorizer, this.vaultApp.app],
    });
    return { capabilities, expiry };
  }

  private async allowanceTo(token: Address, owner: Address): Promise<bigint> {
    return await this.pub.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, this.vaultApp.app] });
  }

  /** Read the lots of a prospective group and require each to be borrowable by `borrower`. */
  private async borrowableGroup(vaultIds: readonly Hex[], borrower: Address): Promise<{ lots: VaultLot[]; sumSats: bigint }> {
    if (vaultIds.length === 0) throw new Error("at least one vault id is required");
    if (new Set(vaultIds.map((id) => id.toLowerCase())).size !== vaultIds.length) throw new Error("duplicate vault id in the group");
    const lots = await Promise.all(vaultIds.map((id) => this.lot(id)));
    let sumSats = 0n;
    for (const lot of lots) {
      if (lot.status !== LotStatus.Reserved) throw new Error(`vault ${lot.vaultId} is ${lotStatusName(lot.status)}, not Reserved`);
      if (lot.origin.toLowerCase() !== borrower.toLowerCase()) throw new Error(`vault ${lot.vaultId} belongs to ${lot.origin}, not the signing account`);
      if (lotIsBound(lot)) throw new Error(`vault ${lot.vaultId} is already bound to loan ${lot.loanId} — releaseRepaid it first`);
      sumSats += lot.amount;
    }
    return { lots, sumSats };
  }

  /** Read-only prerequisite state for a whole-lot borrow by the signing account. */
  async borrowPrereqs(vaultIds: readonly Hex[]): Promise<BorrowPrereqs> {
    const { sumSats } = await this.borrowableGroup(vaultIds, this.account);
    const [allowance, grant, block] = await Promise.all([
      this.allowanceTo(this.vaultApp.vaultBtc, this.account),
      this.grantOf(this.account),
      this.pub.getBlock(),
    ]);
    return { sumSats, allowance, approved: allowance >= sumSats, granted: grantCoversFill(grant.capabilities, grant.expiry, block.timestamp) };
  }

  /**
   * The whole-lot quote against one lender bid: validates the offer for the app (buy, full-repay-only,
   * vaultBTC collateral, dust-free strike), derives face from the group, adds the borrower's swept credit.
   */
  async quoteBorrow(vaultIds: readonly Hex[], offer: Offer, borrower: Address): Promise<WholeLotQuote> {
    const { lots, sumSats } = await this.borrowableGroup(vaultIds, borrower);
    if (!offer.buy) throw new Error("borrowAgainst needs a lender BUY bid");
    if (offer.allowPartialRepay) throw new Error("the vault app rejects partial-repay markets (PartialRepayNotAllowed)");
    if (offer.collateralToken.toLowerCase() !== this.vaultApp.vaultBtc.toLowerCase()) {
      throw new Error(`offer collateral ${offer.collateralToken} is not the family's vaultBTC ${this.vaultApp.vaultBtc}`);
    }
    if (offer.maker.toLowerCase() === borrower.toLowerCase()) throw new Error("offer maker is the borrower (core SelfDeal)");
    const face = assertWholeLotStrike(sumSats, offer.strike);
    const marketId = this.marketId(marketParamsFromOffer(offer));
    const credit = await this.creditOf(marketId, borrower);
    const units = face + credit;
    const priceWad = tickToPrice(offer.tick);
    return { lots, sumSats, marketId, face, credit, units, priceWad, principal: principalForUnits(units, priceWad) };
  }

  /** Newest-first page of the redemption book with the live decayed requirement. */
  async listRedemptions(limit: number, me?: Address): Promise<RedemptionRow[]> {
    const count = await this.readApp<bigint>("redemptionCount");
    const block = await this.pub.getBlock();
    const rows: RedemptionRow[] = [];
    for (let id = count - 1n; id >= 0n && rows.length < limit; id -= 1n) {
      const [order, minSatsNow] = await Promise.all([this.redemption(id), this.readApp<bigint>("minSatsAt", [id, block.timestamp])]);
      rows.push(redemptionRow(id, order, minSatsNow, me, block.timestamp));
    }
    return rows;
  }

  async redemption(id: bigint): Promise<RedemptionOrder> {
    const [owner, amount, minSatsStart, minSatsEnd, postedAt, deadline, closed, btcDest] =
      await this.readApp<readonly [Address, bigint, bigint, bigint, bigint, bigint, boolean, Hex]>("redemptions", [id]);
    return { owner, amount, minSatsStart, minSatsEnd, postedAt, deadline, closed, btcDest };
  }

  async isKeeper(account: Address): Promise<boolean> {
    const key = await this.readApp<Hex>("avkKeyOf", [account]);
    return !UNBOUND.test(key);
  }

  /** Escrow invariant (`vaultBTC.balanceOf(escrow) == TBVBTC.totalSupply()`), supplies, and the caller's balances. */
  async checkInvariant(account?: Address): Promise<{
    balanced: boolean;
    lockedVaultBtc: bigint;
    tbvbtcSupply: bigint;
    vaultBtcSupply: bigint;
    account?: Address;
    accountVaultBtc?: bigint;
    accountTbvbtc?: bigint;
  }> {
    const v = this.vaultApp;
    const [[balanced, lockedVaultBtc, tbvbtcSupply], vaultBtcSupply] = await Promise.all([
      this.pub.readContract({ address: v.escrow, abi: vaultBtcEscrowAbi, functionName: "checkInvariant" }),
      this.pub.readContract({ address: v.vaultBtc, abi: totalSupplyAbi, functionName: "totalSupply" }),
    ]);
    if (!account) return { balanced, lockedVaultBtc, tbvbtcSupply, vaultBtcSupply };
    const [accountVaultBtc, accountTbvbtc] = await Promise.all([this.balanceOf(v.vaultBtc, account), this.balanceOf(v.tbvbtc, account)]);
    return { balanced, lockedVaultBtc, tbvbtcSupply, vaultBtcSupply, account, accountVaultBtc, accountTbvbtc };
  }

  // ---- writes ---------------------------------------------------------------------------------------

  /** Testnet faucet: registry.activate mints `sats` vaultBTC to `depositor` and opens a Reserved lot. */
  async activateMock(vaultId: Hex, depositor: Address, sats: bigint): Promise<TxResult & { vaultId: Hex; depositor: Address; sats: bigint }> {
    await this.verifyVaultApp();
    if (sats <= 0n) throw new Error("sats must be positive");
    const existing = await this.lot(vaultId);
    if (existing.status !== LotStatus.None) throw new Error(`vault ${vaultId} already exists (${lotStatusName(existing.status)}) — pick another id`);
    const tx = await this.write({
      address: this.vaultApp.registry,
      abi: mockVaultRegistryAbi,
      functionName: "activate",
      args: [this.vaultApp.app, vaultId, depositor, sats],
    });
    const after = await this.lot(vaultId);
    if (after.status !== LotStatus.Reserved || after.amount !== sats || after.origin.toLowerCase() !== depositor.toLowerCase()) {
      throw new Error("activate postcondition failed: lot is not a Reserved lot of the requested size for the depositor");
    }
    return { ...tx, vaultId, depositor, sats };
  }

  /** Approve the group's vaultBTC to the app and grant CAP_FILL once — only what is missing. */
  async ensureBorrowPrereqs(vaultIds: readonly Hex[]): Promise<BorrowPrereqs & { approveTx?: TxResult; grantTx?: TxResult }> {
    await this.verifyVaultApp();
    const before = await this.borrowPrereqs(vaultIds);
    let approveTx: TxResult | undefined;
    let grantTx: TxResult | undefined;
    if (!before.approved) approveTx = await this.approveExact(this.vaultApp.vaultBtc, this.vaultApp.app, before.sumSats);
    if (!before.granted) {
      grantTx = await this.write({ address: this.profile.core, abi: grantAbi, functionName: "grantAuthorization", args: [this.vaultApp.app, CAP_FILL, 0n] });
    }
    const after = await this.borrowPrereqs(vaultIds);
    if (!after.approved || !after.granted) throw new Error("borrow prerequisites still unmet after approve/grant");
    return { ...after, approveTx, grantTx };
  }

  /**
   * borrowAgainst: whole-group escrow into ONE lender bid, borrower as taker, principal to `receiver`.
   * Prechecks the offer via offerStatus, the app's one-live-group rule, then requires the receiver's
   * loan-token delta and the Borrowed event's principal to equal the local quote exactly.
   */
  async borrowAgainst(vaultIds: readonly Hex[], offer: Offer, signature: Hex, receiver?: Address): Promise<TxResult & WholeLotQuote & { receiver: Address; loanId: Hex }> {
    await this.verifyVaultApp();
    const to = receiver ?? this.account;
    const quote = await this.quoteBorrow(vaultIds, offer, this.account);
    const prereqs = await this.borrowPrereqs(vaultIds);
    if (!prereqs.approved) throw new Error(`vaultBTC allowance to the app is ${prereqs.allowance}, group needs ${quote.sumSats} — run ensureBorrowPrereqs`);
    if (!prereqs.granted) throw new Error("the app lacks CAP_FILL from this account — run ensureBorrowPrereqs");
    const group = await this.readApp<readonly Hex[]>("groupVaults", [quote.marketId, this.account]);
    if (group.length > 0) {
      const debt = (await this.position(quote.marketId, this.account)).debt;
      if (debt === 0n) throw new Error("a repaid group is still bound in this market — releaseRepaid it before borrowing again (LoanNotOpen)");
    }
    const status = await this.offerStatus(offer, signature);
    if (!status.withinWindow) throw new Error("offer is outside its [start, expiry] window");
    if (status.matured) throw new Error("market is at/past maturity — new debt cannot be issued");
    if (quote.units > status.remainingUnits) throw new Error(`units ${quote.units} (face ${quote.face} + swept credit ${quote.credit}) exceed remaining capacity ${status.remainingUnits}`);
    if (!status.ratifierRegistered) throw new Error("maker has not registered the offer's ratifier on core");
    if (!status.ratified) throw new Error("ratifier precheck did not return RATIFIED for this signature");
    if (status.makerLiquidity < quote.principal) throw new Error("maker liquidity below required principal");

    const balanceBefore = await this.balanceOf(offer.loanToken, to);
    const tx = await this.writeApp("borrowAgainst", [
      [...vaultIds],
      this.adapter.chainOffer({ chainId: this.profile.chainId, core: this.profile.core }, offer),
      signature,
      to,
    ]);
    const balanceAfter = await this.balanceOf(offer.loanToken, to);
    if (balanceAfter - balanceBefore !== quote.principal) {
      throw new Error(`borrowAgainst postcondition failed: receiver got ${balanceAfter - balanceBefore}, quoted ${quote.principal}`);
    }
    const borrowed = await this.eventArgs<{ loanId: Hex; borrower: Address; units: bigint; principal: bigint }>(tx.hash, "Borrowed");
    if (!borrowed) throw new Error("borrowAgainst postcondition failed: no Borrowed event in the receipt");
    if (borrowed.principal !== quote.principal || borrowed.units !== quote.units) {
      throw new Error(`Borrowed event (units ${borrowed.units}, principal ${borrowed.principal}) disagrees with quote (${quote.units}, ${quote.principal})`);
    }
    return { ...tx, ...quote, receiver: to, loanId: borrowed.loanId };
  }

  /** Clear a repaid group's binding so its vaults are borrowable again (permissionless, debt must be 0). */
  async releaseRepaid(vaultId: Hex): Promise<TxResult> {
    await this.verifyVaultApp();
    const lot = await this.lot(vaultId);
    if (lot.status !== LotStatus.Reserved) throw new Error(`vault is ${lotStatusName(lot.status)}, not Reserved`);
    if (!lotIsBound(lot)) throw new Error("vault is not bound to a loan (NotBorrowed)");
    const debt = (await this.position(lot.loanId, lot.borrower)).debt;
    if (debt !== 0n) throw new Error(`loan still has debt ${debt} — repay on the core first (LoanNotRepaid)`);
    const tx = await this.writeApp("releaseRepaid", [vaultId]);
    const after = await this.lot(vaultId);
    if (lotIsBound(after)) throw new Error("releaseRepaid postcondition failed: vault still bound");
    return tx;
  }

  /** Origin exit: burn the vault's vaultBTC from the wallet (whole group when bound + repaid) → Consumed. */
  async reclaim(vaultId: Hex): Promise<TxResult> {
    await this.verifyVaultApp();
    const lot = await this.lot(vaultId);
    if (lot.status !== LotStatus.Reserved) throw new Error(`vault is ${lotStatusName(lot.status)}, not Reserved`);
    if (lot.origin.toLowerCase() !== this.account.toLowerCase()) throw new Error("only the vault's origin can reclaim (NotOrigin)");
    const view = await this.resolveLot(vaultId, this.account);
    if (view.action === "repay-first") throw new Error("the bound loan still has debt — repay the exact face on the core first (LoanNotRepaid)");
    if (view.action === "withdraw-first") throw new Error("wallet holds less vaultBTC than the bound group burns — withdraw the collateral from the core first (bivium reclaim)");
    if (!lotIsBound(lot)) {
      const wallet = await this.balanceOf(this.vaultApp.vaultBtc, this.account);
      if (wallet < lot.amount) throw new Error(`wallet holds ${wallet} sats vaultBTC, reclaim burns ${lot.amount}`);
    }
    const tx = await this.writeApp("reclaim", [vaultId]);
    const after = await this.lot(vaultId);
    if (after.status !== LotStatus.Consumed) throw new Error("reclaim postcondition failed: vault not Consumed");
    return tx;
  }

  /** Permissionless default mark: flips the WHOLE bound group Reserved → Delivered iff unpaid at maturity. */
  async markDelivered(vaultId: Hex): Promise<TxResult> {
    await this.verifyVaultApp();
    const lot = await this.lot(vaultId);
    if (lot.status !== LotStatus.Reserved) throw new Error(`vault is ${lotStatusName(lot.status)}, not Reserved`);
    if (!lotIsBound(lot)) throw new Error("vault is not bound to a loan (NotBorrowed)");
    const [block, position] = await Promise.all([this.pub.getBlock(), this.position(lot.loanId, lot.borrower)]);
    if (block.timestamp < lot.maturity) throw new Error(`loan matures at ${lot.maturity}, chain time is ${block.timestamp} (NotDefaulted)`);
    if (position.debt === 0n) throw new Error("loan is repaid — nothing to deliver (NotDefaulted)");
    const tx = await this.writeApp("markDelivered", [vaultId]);
    const after = await this.lot(vaultId);
    if (after.status !== LotStatus.Delivered) throw new Error("markDelivered postcondition failed: vault not Delivered");
    return tx;
  }

  /** The door to TBVBTC: lock an UNBOUND Reserved lot's vaultBTC in the escrow, receive equal TBVBTC. */
  async convert(vaultId: Hex): Promise<TxResult & { approveTx?: TxResult; amount: bigint }> {
    await this.verifyVaultApp();
    const lot = await this.lot(vaultId);
    if (lot.status !== LotStatus.Reserved) throw new Error(`vault is ${lotStatusName(lot.status)}, not Reserved`);
    if (lot.origin.toLowerCase() !== this.account.toLowerCase()) throw new Error("only the vault's origin can convert (NotOrigin)");
    if (lotIsBound(lot)) throw new Error("vault is bound to a loan — repay, withdraw and releaseRepaid first (StillBound)");
    const wallet = await this.balanceOf(this.vaultApp.vaultBtc, this.account);
    if (wallet < lot.amount) throw new Error(`wallet holds ${wallet} sats vaultBTC, convert locks ${lot.amount}`);
    let approveTx: TxResult | undefined;
    if ((await this.allowanceTo(this.vaultApp.vaultBtc, this.account)) < lot.amount) {
      approveTx = await this.approveExact(this.vaultApp.vaultBtc, this.vaultApp.app, lot.amount);
    }
    const tbvBefore = await this.balanceOf(this.vaultApp.tbvbtc, this.account);
    const tx = await this.writeApp("convert", [vaultId]);
    const [after, tbvAfter] = await Promise.all([this.lot(vaultId), this.balanceOf(this.vaultApp.tbvbtc, this.account)]);
    if (after.status !== LotStatus.Delivered || !after.converted) throw new Error("convert postcondition failed: lot not Delivered/converted");
    if (tbvAfter - tbvBefore !== lot.amount) throw new Error(`convert postcondition failed: TBVBTC delta ${tbvAfter - tbvBefore} != ${lot.amount}`);
    return { ...tx, approveTx, amount: lot.amount };
  }

  /** Buy the same vault back: burn equal TBVBTC (escrow authority, no approval) → fresh unbound Reserved. */
  async unconvert(vaultId: Hex): Promise<TxResult & { amount: bigint; wasDefault: boolean }> {
    await this.verifyVaultApp();
    const lot = await this.lot(vaultId);
    if (lot.status !== LotStatus.Delivered) throw new Error(`vault is ${lotStatusName(lot.status)}, not Delivered`);
    if (lot.origin.toLowerCase() !== this.account.toLowerCase()) throw new Error("only the vault's origin can unconvert (NotOrigin)");
    const tbv = await this.balanceOf(this.vaultApp.tbvbtc, this.account);
    if (tbv < lot.amount) throw new Error(`wallet holds ${tbv} sats TBVBTC, unconvert burns ${lot.amount}`);
    const wasDefault = !lot.converted;
    const tx = await this.writeApp("unconvert", [vaultId]);
    const after = await this.lot(vaultId);
    if (after.status !== LotStatus.Reserved || lotIsBound(after)) throw new Error("unconvert postcondition failed: lot not a fresh unbound Reserved lot");
    return { ...tx, amount: lot.amount, wasDefault };
  }

  /** Amount-based fallback for delivered vaultBTC that reached a holder without the claim hook. */
  async convertDelivered(sats: bigint): Promise<TxResult & { approveTx?: TxResult }> {
    await this.verifyVaultApp();
    if (sats <= 0n) throw new Error("sats must be positive");
    const wallet = await this.balanceOf(this.vaultApp.vaultBtc, this.account);
    if (wallet < sats) throw new Error(`wallet holds ${wallet} sats vaultBTC, convertDelivered locks ${sats}`);
    let approveTx: TxResult | undefined;
    if ((await this.allowanceTo(this.vaultApp.vaultBtc, this.account)) < sats) {
      approveTx = await this.approveExact(this.vaultApp.vaultBtc, this.vaultApp.app, sats);
    }
    const before = await this.balanceOf(this.vaultApp.tbvbtc, this.account);
    const tx = await this.writeApp("convertDelivered", [sats]);
    const after = await this.balanceOf(this.vaultApp.tbvbtc, this.account);
    if (after - before !== sats) throw new Error(`convertDelivered postcondition failed: TBVBTC delta ${after - before} != ${sats}`);
    return { ...tx, approveTx };
  }

  /** Keeper: burn its TBVBTC + the matching locked vaultBTC and redeem the vault to its AVK key → Consumed. */
  async settleDelivered(vaultId: Hex): Promise<TxResult> {
    await this.verifyVaultApp();
    if (!(await this.isKeeper(this.account))) throw new Error("signing account is not a registered keeper (NotKeeper)");
    const lot = await this.lot(vaultId);
    if (lot.status !== LotStatus.Delivered) throw new Error(`vault is ${lotStatusName(lot.status)}, not Delivered`);
    const tbv = await this.balanceOf(this.vaultApp.tbvbtc, this.account);
    if (tbv < lot.amount) throw new Error(`keeper holds ${tbv} sats TBVBTC, settle burns ${lot.amount}`);
    const tx = await this.writeApp("settleDelivered", [vaultId]);
    const after = await this.lot(vaultId);
    if (after.status !== LotStatus.Consumed) throw new Error("settleDelivered postcondition failed: vault not Consumed");
    return tx;
  }

  /** Post a native-BTC redemption order (escrows TBVBTC; exact approval first when needed). */
  async postRedemption(input: { amount: bigint; minSatsStart: bigint; minSatsEnd: bigint; btcDest: Hex; deadline: bigint }): Promise<TxResult & { id: bigint; approveTx?: TxResult }> {
    await this.verifyVaultApp();
    const block = await this.pub.getBlock();
    const problem = validateRedemptionPost({ ...input, nowSec: block.timestamp });
    if (problem) throw new Error(`bad redemption order: ${problem} (BadOrder)`);
    const tbv = await this.balanceOf(this.vaultApp.tbvbtc, this.account);
    if (tbv < input.amount) throw new Error(`wallet holds ${tbv} sats TBVBTC, order escrows ${input.amount}`);
    let approveTx: TxResult | undefined;
    if ((await this.allowanceTo(this.vaultApp.tbvbtc, this.account)) < input.amount) {
      approveTx = await this.approveExact(this.vaultApp.tbvbtc, this.vaultApp.app, input.amount);
    }
    const tx = await this.writeApp("postRedemption", [input.amount, input.minSatsStart, input.minSatsEnd, input.btcDest, input.deadline]);
    const posted = await this.eventArgs<{ id: bigint }>(tx.hash, "RedemptionPosted");
    if (!posted) throw new Error("postRedemption postcondition failed: no RedemptionPosted event in the receipt");
    return { ...tx, id: posted.id, approveTx };
  }

  async cancelRedemption(id: bigint): Promise<TxResult & { amount: bigint }> {
    await this.verifyVaultApp();
    const [order, block] = await Promise.all([this.redemption(id), this.pub.getBlock()]);
    if (order.owner.toLowerCase() !== this.account.toLowerCase()) throw new Error("only the order owner can cancel (NotOrderOwner)");
    if (order.closed) throw new Error("order is already closed (OrderClosed)");
    if (block.timestamp < order.deadline) throw new Error(`order is binding until ${order.deadline}, chain time is ${block.timestamp} (BeforeDeadline)`);
    const tx = await this.writeApp("cancelRedemption", [id]);
    return { ...tx, amount: order.amount };
  }

  /** Keeper: claim an order's escrowed TBVBTC after front-paying its BTC destination on Bitcoin. */
  async claimFill(id: bigint, btcTxid: Hex): Promise<TxResult & { amount: bigint; minSatsDue: bigint }> {
    await this.verifyVaultApp();
    if (!(await this.isKeeper(this.account))) throw new Error("signing account is not a registered keeper (NotKeeper)");
    const [order, block] = await Promise.all([this.redemption(id), this.pub.getBlock()]);
    if (order.closed) throw new Error("order is already closed (OrderClosed)");
    const minSatsDue = await this.readApp<bigint>("minSatsAt", [id, block.timestamp]);
    const tx = await this.writeApp("claimFill", [id, btcTxid]);
    const filled = await this.eventArgs<{ id: bigint; btcTxid: Hex; minSatsDue: bigint }>(tx.hash, "RedemptionFilled");
    return { ...tx, amount: order.amount, minSatsDue: filled?.minSatsDue ?? minSatsDue };
  }

  /** Decode the first `eventName` log the app emitted in `hash`'s receipt. */
  private async eventArgs<T>(hash: Hex, eventName: string): Promise<T | undefined> {
    const receipt = await this.pub.getTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.vaultApp.app.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: vaultAppAbi, data: log.data, topics: log.topics });
        if (decoded.eventName === eventName) return decoded.args as T;
      } catch {
        // foreign / undecodable log — skip
      }
    }
    return undefined;
  }
}
