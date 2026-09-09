import {MarketAnalysisService,type ConfiguredRiskPolicy,type MMPreviewIntent,type ArbitragePreviewIntent} from '../../sdk/actions/marketAnalysis.ts';
import type {ActionContext} from '../../sdk/actions/context.ts';
import type {PublishJournal} from '../../sdk/actions/orderJournal.ts';
import {addressSchema,integerStringSchema} from '../schema.ts';
import {READ_ONLY_ANNOTATIONS,SIMULATION_TIMEOUT_MS,type ToolDef,type ToolDefinition} from '../registry.ts';
import {hashSchema,bytesSchema,objectSchema,offerSchema} from './reads.ts';
const fill=objectSchema({offer:offerSchema,commitment:hashSchema,ratifierData:bytesSchema,units:integerStringSchema});
export const MM_TOOL_SPECS:ToolDef[]=[
 {name:'mm_preview',description:'Analyze trusted per-market inventory limits against current balances, journal, relayer and candidate orders. Known exposure only; never a whole-account safety guarantee.',inputSchema:objectSchema({account:addressSchema,marketIds:{type:'array',items:hashSchema,minItems:1,maxItems:20,uniqueItems:true},candidateOffers:{type:'array',items:offerSchema,maxItems:100},policyId:{type:'string',minLength:1,maxLength:100}})},
 {name:'arbitrage_preview',description:'Estimate a bounded same-market round trip from explicit signed-offer ticks. Fees, executable depth and gas remain unverified; no executable or guaranteed-profit claim.',inputSchema:objectSchema({account:addressSchema,entry:{type:'array',items:fill,minItems:1,maxItems:20},exit:{type:'array',items:fill,minItems:1,maxItems:20},minProfit:integerStringSchema,gasBudget:integerStringSchema},['account','entry','exit','minProfit'])},
].map(t=>({...t,annotations:READ_ONLY_ANNOTATIONS}));
export function createMarketAnalysisTools(context:ActionContext,policies:Record<string,ConfiguredRiskPolicy>,journal?:PublishJournal):ToolDefinition[]{const service=new MarketAnalysisService(context,policies,journal);return MM_TOOL_SPECS.map(tool=>({...tool,concurrency:'managed',timeoutMs:SIMULATION_TIMEOUT_MS,handler:async(args,{signal})=>tool.name==='mm_preview'?service.mmPreview(args as unknown as MMPreviewIntent,signal):service.arbitragePreview(args as unknown as ArbitragePreviewIntent,signal)}));}
