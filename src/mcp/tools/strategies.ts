import { StrategyFlowService, type StrategyPreviewIntent, type StrategyFlowOptions } from '../../sdk/actions/strategyFlow.ts';
import type { ActionService } from '../../sdk/actions/preview.ts';
import { addressSchema, decimalAmountSchema, integerStringSchema, tokenSchema } from '../schema.ts';
import { READ_ONLY_ANNOTATIONS, SIMULATION_TIMEOUT_MS, type ToolDef, type ToolDefinition } from '../registry.ts';
import { objectSchema } from './reads.ts';
import { riskProperties } from './actions.ts';
const common = {
  asset: tokenSchema,
  size: { ...decimalAmountSchema, description: 'Human face amount for lendAsset/short; loan-token face for lendQuote; collateral-asset holding used to size leveredLong. Not a USD budget.' },
  maturity: integerStringSchema,
  bufferPct: { type: 'number', minimum: 0, maximum: 1000 },
  account: addressSchema,
  maxInput: { ...decimalAmountSchema, description: 'Human maximum wallet input: loan token including fees for lending; collateral token top-up for short/leveredLong.' },
  slippageBps: { type: 'integer', minimum: 0, maximum: 1000 },
  ttlSeconds: { type: 'integer', minimum: 1, maximum: 60 },
  ...riskProperties,
};
const required = ['strategy','asset','size','maturity','bufferPct','account','maxInput','slippageBps','policyId','collateralKind','evidence'];
export const STRATEGY_TOOL_SPECS: ToolDef[] = [{
  name: 'strategy_preview',
  description: 'Resolve lendAsset/lendQuote/short/leveredLong from user parameters to a full-size signed fill, actual fees, bounded swap and risk-screened previewId. No signing, broadcasting or automatic resting-order fallback. Use action_prepare with the returned previewId; repeat this tool after prerequisites.',
  inputSchema: { type: "object", oneOf: [
    objectSchema({ ...common, strategy: { enum: ['lendAsset','lendQuote'] } }, required),
    objectSchema({ ...common, strategy: { enum: ['short','leveredLong'] }, maxPriceImpactBps: { type: 'integer', minimum: 0, maximum: 1000 } }, [...required,'maxPriceImpactBps']),
  ] },
  annotations: READ_ONLY_ANNOTATIONS,
}];
export function createStrategyTools(actions: ActionService, options?: StrategyFlowOptions): ToolDefinition[] {
  const service = new StrategyFlowService(actions, options);
  return STRATEGY_TOOL_SPECS.map(tool => ({ ...tool, concurrency: 'managed', timeoutMs: SIMULATION_TIMEOUT_MS, handler: (args, {signal}) => service.preview(args as unknown as StrategyPreviewIntent, signal) }));
}
