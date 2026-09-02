// MaturitySettler client — last-window Dutch settlement (bivium-core #166/#167, hardened after the 2026-09-02
// review). The borrower's side is two signatures: a one-time GLOBAL core grant of CAP_WITHDRAW_COLLATERAL to the
// settler (expiry 0 = until revoked), then a per-market arm carrying the floor as a SHARE — the basis points of
// whatever a settlement unlocks that must come back to the borrower. A share, not an amount, so it holds without
// re-arming when the position grows, shrinks, or is settled in slices. Collateral the borrower already freed is
// forwarded untouched and is never part of the keeper's budget.
//
// The keeper names the size it repays (`repayAssets`): the settler charges it no more than that, so nothing the
// borrower does between the keeper's read and its transaction can enlarge the advance. On a repay-in-full market
// the core refuses any slice that is not the whole debt; on a partial-repay market the slice settles and frees
// collateral in proportion. Settlement is reachable only while floor < unlocked − debt/R, because the keeper is
// paid at most (unlocked − floor), Dutch-released from zero at window open to everything above the floor at
// maturity. Anyone may settle; the caller is the keeper and funds the repay.
import { parseAbi, type Address, type Hex } from "viem";
import { BiviumClient } from "./client.ts";
import type { MarketParams } from "./types.ts";

export const CAP_WITHDRAW_COLLATERAL = 1n << 3n;
export const BPS = 10_000;

export const settlerAbi = parseAbi([
  "function authorize((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params, uint16 minKeptBps)",
  "function revoke((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params)",
  "function settle((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params, address borrower, uint256 repayAssets, uint256 collateralAsk) returns (uint256)",
  "function authorizations(bytes32 id, address borrower) view returns (uint16 minKeptBps, bool enabled)",
  "function floorOf(uint256 freed, uint256 minKeptBps) view returns (uint256)",
  "function maxAsk(uint256 freed, uint256 maturity, uint256 minCollateralKept) view returns (uint256)",
  "function SETTLE_WINDOW() view returns (uint256)",
]);

// V4JitKeeper (bivium-core #170): the same settle, funded by a Uniswap v4 pool's flash accounting instead of the
// caller's wallet. The wrapper is the settler's keeper; the caller only signs and collects the surplus, so no
// balance and no approval are required — an unprofitable settle reverts whole instead of costing anything.
export const jitKeeperAbi = parseAbi([
  "function settleWithFlash((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params, address borrower, uint256 collateralAsk, (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, uint256 minProfit) returns (uint256)",
]);

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** A v4 pool key holds the SORTED pair; which market leg is currency0 is byte order, not a choice. */
export function poolKeyFor(collateralToken: Address, loanToken: Address, fee: number, tickSpacing: number, hooks: Address): PoolKey {
  const [currency0, currency1] = collateralToken.toLowerCase() < loanToken.toLowerCase()
    ? [collateralToken, loanToken] : [loanToken, collateralToken];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

const grantAbi = parseAbi([
  "function grantOf(address authorizer, address authorized) view returns (uint256 capabilities, uint256 expiry)",
  "function grantAuthorization(address authorized, uint256 capabilities, uint256 expiry)",
]);

/** The core grant covers the settler when the bit is present and the grant has not expired (0 = perpetual). */
export function grantCoversSettler(grant: { capabilities: bigint; expiry: bigint }, nowSec: bigint): boolean {
  if ((grant.capabilities & CAP_WITHDRAW_COLLATERAL) !== CAP_WITHDRAW_COLLATERAL) return false;
  return grant.expiry === 0n || nowSec <= grant.expiry;
}

/** The highest floor, in collateral units, at which any rational keeper exists: the position's equity. Above it,
 *  every settle pays the keeper less than the debt they front, and arming is a quiet no-op. `collateralUnits` is
 *  the LOCKED collateral — what a full repay unlocks — not anything already withdrawable. */
export function maxSettleableFloor(collateralUnits: number, debtLoanUnits: number, loanPerCollateral: number): number | null {
  if (!Number.isFinite(collateralUnits) || collateralUnits <= 0) return null;
  if (!Number.isFinite(debtLoanUnits) || debtLoanUnits < 0) return null;
  if (!Number.isFinite(loanPerCollateral) || loanPerCollateral <= 0) return null;
  return Math.max(0, collateralUnits - debtLoanUnits / loanPerCollateral);
}

/** The same bound as a share: the largest `minKeptBps` that still leaves a keeper something to be paid with. */
export function maxSettleableKeptBps(collateralUnits: number, debtLoanUnits: number, loanPerCollateral: number): number | null {
  const floor = maxSettleableFloor(collateralUnits, debtLoanUnits, loanPerCollateral);
  if (floor === null) return null;
  return Math.max(0, Math.min(BPS - 1, Math.floor((floor / collateralUnits) * BPS)));
}

/** `--keep <percent>` → basis points. Whole-number precision to 0.01%; refuses 100% (the settler does too). */
export function keepPercentToBps(percent: string): number {
  const value = Number(percent);
  if (!Number.isFinite(value) || value < 0 || value >= 100) throw new Error(`--keep must be a percentage in [0, 100): got ${percent}`);
  return Math.round(value * 100);
}

export class SettlerClient extends BiviumClient {
  constructor(profile: ConstructorParameters<typeof BiviumClient>[0], account: ConstructorParameters<typeof BiviumClient>[1], readonly settler: Address) {
    super(profile, account);
  }

  private fullParams(params: MarketParams) {
    return { chainId: BigInt(this.profile.chainId), bivium: this.profile.core, ...params };
  }

  grantOf(authorizer: Address): Promise<{ capabilities: bigint; expiry: bigint }> {
    return this.pub.readContract({ address: this.profile.core, abi: grantAbi, functionName: "grantOf", args: [authorizer, this.settler] })
      .then(([capabilities, expiry]) => ({ capabilities, expiry }));
  }

  /** The one-time core-side grant. Expiry 0 — the grant is useless without a per-market arm, and a dangling
   *  perpetual grant to an immutable, floor-checked contract is the lesser evil against a silently expired one. */
  grantSettler() {
    return this.write({ address: this.profile.core, abi: grantAbi, functionName: "grantAuthorization", args: [this.settler, CAP_WITHDRAW_COLLATERAL, 0n] });
  }

  arm(params: MarketParams, minKeptBps: number) {
    return this.write({ address: this.settler, abi: settlerAbi, functionName: "authorize", args: [this.fullParams(params), minKeptBps] });
  }

  disarm(params: MarketParams) {
    return this.write({ address: this.settler, abi: settlerAbi, functionName: "revoke", args: [this.fullParams(params)] });
  }

  authorization(marketId: Hex, borrower: Address): Promise<{ minKeptBps: number; enabled: boolean }> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "authorizations", args: [marketId, borrower] })
      .then(([minKeptBps, enabled]) => ({ minKeptBps, enabled }));
  }

  /** The floor in collateral units for a given unlocked amount — the settler's own rounding (toward the borrower). */
  floorOf(freed: bigint, minKeptBps: number): Promise<bigint> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "floorOf", args: [freed, BigInt(minKeptBps)] });
  }

  maxAsk(freed: bigint, maturity: bigint, minCollateralKept: bigint): Promise<bigint> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "maxAsk", args: [freed, maturity, minCollateralKept] });
  }

  settleWindow(): Promise<bigint> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "SETTLE_WINDOW", args: [] });
  }

  /** Keeper-side: fund and execute one settlement of `repayAssets` face. The caller must hold and approve the loan
   *  token; `repayAssets` is the most the settler will charge, whatever the debt does in the meantime. */
  settle(params: MarketParams, borrower: Address, repayAssets: bigint, collateralAsk: bigint) {
    return this.write({ address: this.settler, abi: settlerAbi, functionName: "settle", args: [this.fullParams(params), borrower, repayAssets, collateralAsk] });
  }

  /** Keeper-side, zero-capital: the V4JitKeeper takes the debt from the pool's flash accounting, settles, swaps
   *  the collateral back through the same pool and sends the surplus to the caller. No funds, no approvals. */
  settleWithFlash(jit: Address, params: MarketParams, borrower: Address, collateralAsk: bigint, key: PoolKey, minProfit: bigint) {
    return this.write({ address: jit, abi: jitKeeperAbi, functionName: "settleWithFlash", args: [this.fullParams(params), borrower, collateralAsk, key, minProfit] });
  }
}
