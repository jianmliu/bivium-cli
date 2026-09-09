import type { LineageAdapter, ChainDomain } from '../lineage.ts';
import type { Address, MarketParams } from '../types.ts';
export type BasicAction = 'fund' | 'repay' | 'withdraw_liquidity' | 'withdraw_collateral' | 'claim' | 'escrow_collateral' | 'withdraw_collateral_escrow';
/** One argument registry shared by wallet writes and unsigned preparation. */
export function basicCall(adapter:LineageAdapter, domain:ChainDomain, params:MarketParams, action:BasicAction, account:Address, receiver:Address, assets:bigint) {
 const p=adapter.chainParams(domain,params);
 const registry = {
 fund: {functionName:'fund',args:[p,assets]},
 repay:{functionName:'repay',args:[p,assets,account]},
 withdraw_liquidity:{functionName:'withdrawLiquidity',args:[p,account,assets,receiver]},
 withdraw_collateral:{functionName:'withdrawCollateral',args:[p,account,receiver]},
 claim:{functionName:'claim',args:[p,assets,account,receiver]},
 escrow_collateral:{functionName:'escrowCollateral',args:[p,assets]},
 withdraw_collateral_escrow:{functionName:'withdrawCollateralEscrow',args:[p,account,assets,receiver]},
 };
 return registry[action];
}
