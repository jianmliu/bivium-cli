import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStrategyMcp, TOOLS } from '../src/mcp/server.ts';
import type { DeploymentProfile } from '../src/sdk/types.ts';
const addr = `0x${'1'.repeat(40)}`;
const profile = { name: 'test', abiProfile: 'core-v1', chainId: 1, core: addr, signatureRatifier: addr, rpcUrl: 'http://localhost:1', tokens: {} } as DeploymentProfile;
const mcp = createStrategyMcp({profile, overrides: { rows: [], positions: async () => ({ok: true, taker: addr, at: 1, marketsScanned: 0, positions: []}) }});
const valid: Record<string, Record<string, unknown>> = { strategy_list: {}, market_list: {}, strategy_quote: {strategy:'short',asset:'mAI',size:'1',maturity:'1800000000',bufferPct:1}, strategy_plan: {strategy:'short',asset:'mAI',size:'1',maturity:'1800000000',bufferPct:1}, strategy_positions: {taker:addr} };
async function failure(name: string, args: unknown) {
 const response = await mcp.handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
 const result = response!.result as any;
 assert.equal(result.isError,true);
 assert.deepEqual(result.structuredContent,JSON.parse(result.content[0].text));
 assert.equal(result.structuredContent.code,'INVALID_ARGUMENT');
 assert.equal(result.structuredContent.retryable,false);
}
for (const name of Object.keys(valid)) {
 test(`${name}: rejects unknown and sensitive fields and array arguments`, async () => {
  for (const field of ['unknown','path','url','privateKey','keyFile','calldata']) await failure(name,{...valid[name],[field]:'unused'});
  await failure(name,[]);
 });
}
for (const name of ['strategy_quote','strategy_plan']) {
 test(`${name}: rejects invalid amounts, addresses and numbers`, async () => {
  for (const patch of [{size:1},{size:'1e3'},{size:'-1'},{size:'01'},{size:'9'.repeat(101)},{asset:'0x123'},{maturity:1.5},{bufferPct:Infinity},{sigma:NaN},{aprBps:1200},{priceWad:'1.1'}]) await failure(name,{...valid[name],...patch});
 });
}
test('addresses are validated before loading', async () => { await failure('strategy_positions',{taker:'0x123'}); await failure('strategy_plan',{...valid.strategy_plan,router:'bad'}); });
test('all advertised tools explicitly describe safe read-only behavior', () => { for (const tool of TOOLS) assert.deepEqual((tool as any).annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true}); });

import {validator, decimalAmountSchema, listLimitSchema, listLimit, marketArraySchema} from '../src/mcp/schema.ts';
import {ToolRegistry,createConcurrencyLimiter,withDeadline} from '../src/mcp/registry.ts';
import {success,toolFailure} from '../src/mcp/result.ts';
test('decimal amount validator rejects numeric/exponent/negative/oversized strings and never coerces',()=>{
 const check=validator(decimalAmountSchema);
 for (const value of ['0','1','0.001','1000000000000000000.123']) assert.equal(check(value),true);
 for (const value of [1,'1e3','-1','.1','01','1.','9'.repeat(101),Infinity]) assert.equal(check(value),false);
 const limits=validator({type:'object',properties:{limit:listLimitSchema},additionalProperties:false});const args={};assert.equal(limits(args),true);assert.deepEqual(args,{});assert.equal(listLimit(undefined),20);assert.equal(limits({limit:101}),false);
 const markets=validator(marketArraySchema());assert.equal(markets(Array(21).fill('1')),false);
});
test('positive chunkBlocks rejects zero preventing an endless chain scan',async()=>{for (const value of [0,'0',-1,1.5,Infinity]) await failure('market_list',{chunkBlocks:value});});
test('registry passes abort signal, times out and remains usable with extensible tools',async()=>{
 let signal:AbortSignal|undefined;
 const registry=new ToolRegistry([{name:'slow',description:'test',inputSchema:{type:'object'},timeoutMs:5,handler:(_,context)=>{signal=context.signal;return new Promise(()=>{});}}, {name:'ready',description:'test',inputSchema:{type:'object'},handler:()=>success({value:1n})}]);
 await assert.rejects(registry.call('slow',{}),/deadline/);assert.equal(signal!.aborted,true);assert.deepEqual(await registry.call('ready',{}),{ok:true,data:{value:1n}});
 assert.equal('handler' in registry.list()[0],false);
 assert.equal(toolFailure({code:'SDK_ERROR',message:'error',retryable:true,field:'marketId'}).code,'SDK_ERROR');
});
test('concurrency stays bounded for uncancellable work and aborts queued calls',async()=>{
 const limit=createConcurrencyLimiter(2);let active=0,peak=0;const release:Array<()=>void>=[];
 const work=()=>limit(async()=>{active++;peak=Math.max(peak,active);await new Promise<void>(resolve=>release.push(resolve));active--;});
 const first=work(),second=work();let ran=false;
 await assert.rejects(withDeadline(signal=>limit(()=>{ran=true;},signal),5),/deadline/);
 assert.equal(ran,false);assert.equal(peak,2);release.forEach(fn=>fn());await Promise.all([first,second]);await limit(()=>{ran=true;});assert.equal(ran,true);
});
