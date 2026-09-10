import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData} from 'viem';
import {createStrategyMcp} from '../src/mcp/server.ts';
import {strategyFixture} from './fixtures/strategyFlow.ts';
import {adapterFor} from '../src/sdk/lineage.ts';
import {routerAbi} from '../src/sdk/strategyRouter.ts';
function setup(strategy:Parameters<typeof strategyFixture>[0],overrides:Record<string,unknown>={}){
 const f=strategyFixture(strategy,overrides);
 Object.defineProperty(f.context,'wallet',{get(){throw Error('Wallet forbidden');}});
 const mcp=createStrategyMcp({profile:f.profile,actionContext:f.context,actionService:f.actions,strategyFlowOptions:f.options});
 let id=0;const call=async(name:string,args:unknown)=>{const r=await mcp.handle({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}});return r!.result as any;};
 return {...f,call};
}
for(const strategy of ['lendAsset','lendQuote','short','leveredLong'] as const)test(`MCP ${strategy}: user inputs -> saved quote -> unsigned wallet payload`,async()=>{
 const f=setup(strategy);
 const discovery=await f.call('strategy_list',{});assert.ok(discovery.structuredContent.strategies.find((s:any)=>s.id===strategy).capabilities.highLevelPreview);
 const preview=await f.call('strategy_preview',f.input);assert.equal(preview.isError,undefined,JSON.stringify(preview));
 const p=preview.structuredContent.data;assert.ok(p.previewId);assert.ok(p.binding.sourceHash);assert.equal(p.source.requested.strategy,strategy);
 assert.equal(p.transaction,undefined);assert.equal(p.source.economics.face.decimals,strategy==='lendQuote'||strategy==='leveredLong'?6:18);
 assert.equal(p.source.indicativePayoff.feeAdjusted,false);
 const prepare=await f.call('action_prepare',{previewId:p.previewId});assert.equal(prepare.isError,undefined,JSON.stringify(prepare));
 const data=prepare.structuredContent.data;assert.equal(data.kind,'ready');assert.equal(data.source.requested.strategy,strategy);
 const borrow=strategy==='short'||strategy==='leveredLong';const decoded=decodeFunctionData({abi:borrow?routerAbi:adapterFor('core-v2').coreAbi,data:data.transaction.data});
 assert.equal(decoded.functionName,borrow?'execute':'multicall');assert.equal(data.transaction.from.toLowerCase(),f.input.account.toLowerCase());
 assert.ok(f.calls.filter(c=>c.simulation).length>=2);assert.ok(f.calls.every(c=>c.blockNumber===10n));
});
test('MCP approval requires a fresh high-level preview and consumed changes invalidate preparation',async()=>{
 const state={allowance:0n};const f=setup('lendQuote',state);
 const first=await f.call('strategy_preview',f.input);assert.equal(first.isError,undefined,JSON.stringify(first));
 const prepare=await f.call('action_prepare',{previewId:first.structuredContent.data.previewId});assert.equal(prepare.structuredContent.data.kind,'prerequisites');assert.equal(prepare.structuredContent.data.transaction,undefined);
 assert.ok(f.calls.filter(c=>c.simulation).every(c=>c.functionName==='approve'));
 state.allowance=10n**30n;
 const stale=await f.call('action_prepare',{previewId:first.structuredContent.data.previewId});assert.equal(stale.isError,true);assert.equal(stale.structuredContent.nextAction,'strategy_preview');
 const next=await f.call('strategy_preview',f.input);assert.equal(next.isError,undefined,JSON.stringify(next));
 const ready=await f.call('action_prepare',{previewId:next.structuredContent.data.previewId});assert.equal(ready.structuredContent.data.kind,'ready');
 const read=f.context.rpc.readContract;f.context.rpc.readContract=async r=>r.functionName==='consumed'?10n**30n:read(r);
 const changed=await f.call('action_prepare',{previewId:next.structuredContent.data.previewId});assert.equal(changed.isError,true);assert.equal(changed.structuredContent.data,undefined);assert.equal(changed.structuredContent.nextAction,'strategy_preview');
});
test('MCP stale data, no liquidity, rejected risk and unknown low-level arguments never yield a signing payload',async()=>{
 const f=setup('short');
 const invalid=await f.call('strategy_preview',{...f.input,fills:[]});assert.equal(invalid.structuredContent.code,'INVALID_ARGUMENT');
 f.entries.length=0;const empty=await f.call('strategy_preview',f.input);assert.equal(empty.isError,true);assert.equal(empty.structuredContent.code,'INSUFFICIENT_LIQUIDITY');
 const rejected=setup('lendAsset');rejected.actions.policies.test.rules.rejectArbitraryMint=true;
 const response=await rejected.call('strategy_preview',{...rejected.input,evidence:{mintable:{state:'observed',value:true}}});
 assert.equal(response.isError,undefined,JSON.stringify(response));assert.equal(response.structuredContent.data.previewId,null);assert.equal(response.structuredContent.data.transaction,undefined);
});
