// MaturitySettler client — last-window Dutch settlement (bivium-core #166/#167). The borrower's side is two
// signatures: a one-time GLOBAL core grant of CAP_WITHDRAW_COLLATERAL to the settler (expiry 0 = until revoked),
// then a per-market arm carrying the floor. The floor is the borrower's protection AND the keeper's budget:
// settlement is reachable only while floor < collateral − debt/R, because the keeper fronts the whole debt and
// is paid at most (freed − floor), Dutch-released from zero at window open to everything above the floor at
// maturity. Anyone may settle; the caller is the keeper and funds the repay.
import { parseAbi, type Address, type Hex } from "viem";
import { BiviumClient } from "./client.ts";
import type { MarketParams } from "./types.ts";

export const CAP_WITHDRAW_COLLATERAL = 1n << 3n;

export const settlerAbi = parseAbi([
  "function authorize((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params, uint128 minCollateralKept)",
  "function revoke((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params)",
  "function settle((uint256 chainId,address bivium,address loanToken,address collateralToken,uint256 maturity,uint256 strike,bool allowPartialRepay,address gate) params, address borrower, uint256 collateralAsk) returns (uint256)",
  "function authorizations(bytes32 id, address borrower) view returns (uint128 minCollateralKept, bool enabled)",
  "function maxAsk(uint256 freed, uint256 maturity, uint256 minCollateralKept) view returns (uint256)",
  "function SETTLE_WINDOW() view returns (uint256)",
]);

const grantAbi = parseAbi([
  "function grantOf(address authorizer, address authorized) view returns (uint256 capabilities, uint256 expiry)",
  "function grantAuthorization(address authorized, uint256 capabilities, uint256 expiry)",
]);

/** The core grant covers the settler when the bit is present and the grant has not expired (0 = perpetual). */
export function grantCoversSettler(grant: { capabilities: bigint; expiry: bigint }, nowSec: bigint): boolean {
  if ((grant.capabilities & CAP_WITHDRAW_COLLATERAL) !== CAP_WITHDRAW_COLLATERAL) return false;
  return grant.expiry === 0n || nowSec <= grant.expiry;
}

/** The highest floor at which any rational keeper exists: the position's equity in collateral units. Above it,
 *  every settle pays the keeper less than the debt they front, and arming is a quiet no-op. */
export function maxSettleableFloor(collateralUnits: number, debtLoanUnits: number, loanPerCollateral: number): number | null {
  if (!Number.isFinite(collateralUnits) || collateralUnits <= 0) return null;
  if (!Number.isFinite(debtLoanUnits) || debtLoanUnits < 0) return null;
  if (!Number.isFinite(loanPerCollateral) || loanPerCollateral <= 0) return null;
  return Math.max(0, collateralUnits - debtLoanUnits / loanPerCollateral);
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

  arm(params: MarketParams, minCollateralKept: bigint) {
    return this.write({ address: this.settler, abi: settlerAbi, functionName: "authorize", args: [this.fullParams(params), minCollateralKept] });
  }

  disarm(params: MarketParams) {
    return this.write({ address: this.settler, abi: settlerAbi, functionName: "revoke", args: [this.fullParams(params)] });
  }

  authorization(marketId: Hex, borrower: Address): Promise<{ minCollateralKept: bigint; enabled: boolean }> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "authorizations", args: [marketId, borrower] })
      .then(([minCollateralKept, enabled]) => ({ minCollateralKept, enabled }));
  }

  maxAsk(freed: bigint, maturity: bigint, minCollateralKept: bigint): Promise<bigint> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "maxAsk", args: [freed, maturity, minCollateralKept] });
  }

  settleWindow(): Promise<bigint> {
    return this.pub.readContract({ address: this.settler, abi: settlerAbi, functionName: "SETTLE_WINDOW", args: [] });
  }

  /** Keeper-side: fund and execute one settlement. The caller must hold and approve the loan token. */
  settle(params: MarketParams, borrower: Address, collateralAsk: bigint) {
    return this.write({ address: this.settler, abi: settlerAbi, functionName: "settle", args: [this.fullParams(params), borrower, collateralAsk] });
  }
}
