import { getStrategy } from './catalog.ts';
import type { DeploymentProfile } from '../types.ts';
export const HIGH_LEVEL_STRATEGIES = ['lendAsset', 'lendQuote', 'short', 'leveredLong'] as const;
export function strategyCapabilities(id: string, profile: DeploymentProfile) {
  const strategy = getStrategy(id);
  const executable = profile.chainId === 46630 && profile.abiProfile === 'core-v2';
  const highLevelPreview = executable && HIGH_LEVEL_STRATEGIES.some(s => s === strategy.id);
  const exactFill = executable && ['lendAsset', 'lendQuote', 'short', 'leveredLong', 'protectivePut'].includes(strategy.id);
  return {
    quote: strategy.quotable,
    descriptivePlan: strategy.quotable,
    highLevelPreview,
    previewTool: highLevelPreview ? 'strategy_preview' : null,
    unsignedPreparation: highLevelPreview ? 'resolved_strategy' : exactFill ? 'exact_fill_only' : 'unavailable',
    prepareTool: exactFill ? 'action_prepare' : null,
    restingOrder: executable && ['lendAsset', 'lendQuote'].includes(strategy.id) ? 'separate_order_prepare_flow' : null,
    sizeUnit: strategy.id === 'lendQuote' ? 'human loan-token face' : strategy.id === 'leveredLong' ? 'human asset holding (sizing basis, not automatic leverage multiplier)' : 'human asset face',
    maxInputUnit: strategy.side === 'lend' ? 'human loan-token total spend including fees' : 'human collateral-token wallet top-up',
    execution: 'external_wallet',
    lifecycle: { transactionStatus: 'transaction_status', accountState: 'account_snapshot', settlement: strategy.side === 'lend' ? ['claim'] : ['repay', 'withdraw_collateral'], automaticUnwind: false },
    limitations: ['One market and one full-size fill per high-level preview.', 'Availability still depends on live liquidity, risk policy, routing, approvals and simulation.', 'A descriptive quote or plan is not a signing payload.'],
  };
}
