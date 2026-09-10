import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createStrategyMcp,TOOLS} from '../src/mcp/server.ts';
import {validator} from '../src/mcp/schema.ts';
import type {DeploymentProfile} from '../src/sdk/types.ts';
const address=`0x${'11'.repeat(20)}` as const;
const profile:DeploymentProfile={name:'fixture',abiProfile:'core-v2',chainId:46630,core:address,signatureRatifier:address,rpcUrl:'http://localhost:1'};
test('strategy discovery separates high-level flows from exact-fill and descriptive strategies',async()=>{
 const mcp=createStrategyMcp({profile});const list=await mcp.callTool('strategy_list',{}) as any;
 assert.equal(list.strategies.find((s:any)=>s.id==='lendAsset').capabilities.previewTool,'strategy_preview');
 assert.equal(list.strategies.find((s:any)=>s.id==='pairShort').capabilities.highLevelPreview,false);
 assert.equal(list.strategies.find((s:any)=>s.id==='collar').capabilities.quote,false);
 const info=await mcp.callTool('server_info',{}) as any;assert.deepEqual(info.data.highLevelStrategies,['lendAsset','lendQuote','short','leveredLong']);
 const mainnet=await createStrategyMcp({profile:{...profile,chainId:4663}}).callTool('strategy_list',{}) as any;
 assert.equal(mainnet.strategies.find((s:any)=>s.id==='short').capabilities.highLevelPreview,false);
});
test('strategy schema rejects low-level execution overrides and requires swap bounds',()=>{
 const tool=TOOLS.find(t=>t.name==='strategy_preview');assert.ok(tool);
 const check=validator(tool.inputSchema);
 const input={strategy:'short',asset:'mAI',size:'1',maturity:'2000000000',bufferPct:10,account:address,maxInput:'10',slippageBps:100,maxPriceImpactBps:300,policyId:'p',collateralKind:'other',evidence:{}};
 assert.equal(check(input),true);
 for(const patch of [{strategy:'pairShort'},{fills:[]},{poolKey:{}},{router:address},{privateKey:'bad'},{size:'1e3'},{maxInput:-1},{slippageBps:10000},{maxPriceImpactBps:undefined}])assert.equal(check({...input,...patch}),false);
 const lend={...input,strategy:'lendAsset'};delete (lend as any).maxPriceImpactBps;assert.equal(check(lend),true);assert.equal(check({...lend,maxPriceImpactBps:1}),false);
});
test('every advertised tool has the MCP-required root object schema',()=>{for(const tool of TOOLS)assert.equal((tool.inputSchema as any).type,'object',tool.name);});
