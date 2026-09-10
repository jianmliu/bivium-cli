import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { strategyFixture } from './fixtures/strategyFlow.ts';
import { StrategyFlowService } from '../src/sdk/actions/strategyFlow.ts';
import { adapterFor } from '../src/sdk/lineage.ts';
import { routerAbi } from '../src/sdk/strategyRouter.ts';
const adapter=adapterFor('core-v2'),max=(1n<<256n)-1n;
for(const strategy of ['lendAsset','lendQuote','short','leveredLong'] as const)test(`${strategy} resolves mixed chain decimals and prepares actual unsigned ABI`,async()=>{
 const f=strategyFixture(strategy);const preview=await f.flow.preview(f.input);assert.ok(preview.data.previewId);
 const ready=await f.actions.prepare(preview.data.previewId!);assert.equal(ready.data.kind,'ready');
 if(ready.data.kind==='ready')assert.equal(decodeFunctionData({abi:strategy==='short'||strategy==='leveredLong'?routerAbi:adapter.coreAbi,data:ready.data.transaction.data}).functionName,strategy==='short'||strategy==='leveredLong'?'execute':'multicall');
 assert.ok(f.calls.filter(c=>c.blockNumber!==undefined).every(c=>c.blockNumber===10n));
});
test('unknown fields and unsupported strategies reject before RPC',async()=>{const f=strategyFixture();await assert.rejects(f.flow.preview({...f.input,fills:[]} as any),/INVALID_ARGUMENT/);await assert.rejects(f.flow.preview({...f.input,strategy:'collar'} as any),/UNSUPPORTED|INVALID/);assert.equal(f.calls.length,0);});
test('empty book and full-size shortage refuse without partial execution',async()=>{const f=strategyFixture();f.entries.length=0;await assert.rejects(f.flow.preview(f.input),/LIQUIDITY/);});
test('stale spot and unmatched rung refuse',async()=>{const f=strategyFixture();const stale=new StrategyFlowService(f.actions,{spot:async()=>({px:10n**18n,status:'stale',pair:'CAT-USDC'})});await assert.rejects(stale.preview(f.input),/STALE/);await assert.rejects(f.flow.preview({...f.input,bufferPct:99}),/MARKET_SELECTION_REQUIRED/);});
test('spoofed entry metadata cannot lower cost and wallet limit is hard',async()=>{const f=strategyFixture();f.entries[0].price=1n;f.entries[0].size=max;await assert.rejects(f.flow.preview({...f.input,maxInput:'0.000001'}),/MAX_INPUT/);});
test('approvals are prerequisites and prepare returns no trade',async()=>{const f=strategyFixture('short',{allowance:0n,grantOf:[0n,0n]});const p=await f.flow.preview(f.input);const ready=await f.actions.prepare(p.data.previewId!);assert.equal(ready.data.kind,'prerequisites');assert.ok(f.calls.filter(c=>c.simulation).every(c=>c.functionName!=='execute'));});
test('gated lender selects gate-approved router and reads only actual lender fee',async()=>{
 const f=strategyFixture('lendAsset',{FEE_BPS:new Error('must not read borrower fee')});
 const gate='0x0000000000000000000000000000000000000007' as const;f.market.params.gate=gate;f.offer.gate=gate;f.market.id=adapter.computeMarketId(f.profile,f.market.params);f.entries[0].commitment=adapter.offerCommitment(f.profile,f.offer);
 const p=await f.flow.preview(f.input);const src=(p.data as any).source;assert.equal(src.route.router,f.profile.strategyRouter);assert.ok(BigInt(src.economics.fee.raw)>0n);
 const r=await f.actions.prepare(p.data.previewId!);assert.equal(r.data.kind,'ready');if(r.data.kind==='ready')assert.equal(r.data.transaction.to,f.profile.strategyRouter);
});
test('direct lender never reads unused router fee',async()=>{const f=strategyFixture('lendAsset',{FEE_BPS:new Error('unused'),LENDER_FEE_BPS:new Error('unused')});assert.ok((await f.flow.preview(f.input)).data.previewId);});
test('borrower fee failure is fail closed',async()=>{const f=strategyFixture('short',{FEE_BPS:new Error('fee unavailable')});await assert.rejects(f.flow.preview(f.input),/fee unavailable/);});
test('wrong-market or expired offer cannot create a preview',async()=>{
 const f=strategyFixture();f.offer.strike++;f.entries[0].commitment=adapter.offerCommitment(f.profile,f.offer);await assert.rejects(f.flow.preview(f.input),/DOMAIN_MISMATCH/);
 const g=strategyFixture();g.offer.expiry=99n;g.entries[0].commitment=adapter.offerCommitment(g.profile,g.offer);await assert.rejects(g.flow.preview(g.input),/LIQUIDITY/);
});
test('consumed backing shortage skips smaller order in favor of full-size order',async()=>{
 const f=strategyFixture();const small={...f.offer,maxUnits:1n};f.entries.unshift({...f.entries[0],offer:small,commitment:adapter.offerCommitment(f.profile,small)});assert.ok((await f.flow.preview(f.input)).data.previewId);
 f.entries.pop();await assert.rejects(f.flow.preview(f.input),/LIQUIDITY/);
});
test('swap rejects marginal-only data, max topup and missing impact budget',async()=>{
 const f=strategyFixture('short');await assert.rejects(f.flow.preview({...f.input,maxInput:'0'}),/MAX_INPUT/);await assert.rejects(f.flow.preview({...f.input,maxPriceImpactBps:undefined}),/maxPriceImpact/);
 const old=f.context.rpc.call!;f.context.rpc.call=async(r)=>r.data.startsWith('0xfa6793d5')?{data:'0x'}:old(r);await assert.rejects(f.flow.preview(f.input),/SWAP_UNAVAILABLE/);
});
test('precise source shows chain decimals, binding and actual minimum topup',async()=>{
 const f=strategyFixture('leveredLong');const p=await f.flow.preview(f.input);const src=(p.data as any).source;
 assert.equal(src.economics.face.raw,'800000');assert.equal(src.economics.face.decimals,6);assert.equal(src.economics.topUp.decimals,18);assert.equal(src.indicativePayoff.feeAdjusted,false);assert.ok((p.data as any).binding?.sourceHash);
 const needed=BigInt(src.economics.collateral.raw)-BigInt(src.swap.minOut.raw);assert.equal(src.economics.topUp.raw,String(needed>0n?needed:0n));
});
test('rejects fractional raw precision and human uint overflow',async()=>{const f=strategyFixture('lendQuote');await assert.rejects(f.flow.preview({...f.input,size:'0.0000001'}),/precision/);await assert.rejects(f.flow.preview({...f.input,size:'9'.repeat(90)}),/uint256/);});
test('lender discount fee can exceed discounted cost without becoming negative borrower principal',async()=>{
 const f=strategyFixture('lendAsset');f.market.params.gate='0x0000000000000000000000000000000000000007';f.offer.gate=f.market.params.gate;f.offer.tick=0n;f.market.id=adapter.computeMarketId(f.profile,f.market.params);f.entries[0].commitment=adapter.offerCommitment(f.profile,f.offer);assert.ok((await f.flow.preview(f.input)).data.previewId);
});
test('quoter output must independently meet price-impact budget at pinned block',async()=>{
 const f=strategyFixture('short');f.profile.v4Quoter='0x000000000000000000000000000000000000000b';
 const old=f.context.rpc.call!;f.context.rpc.call=async(r)=>r.to===f.profile.v4Quoter?{data:(await import('viem')).encodeAbiParameters([{type:'uint256'},{type:'uint256'}],[1n,100n])}:old(r);
 await assert.rejects(f.flow.preview(f.input),/SWAP_UNAVAILABLE/);
});
test('discovery reads each token decimal once per snapshot and bounds market scan',async()=>{
 const f=strategyFixture();await f.flow.preview(f.input);assert.equal(f.calls.filter(c=>c.functionName==='decimals').length,2);
 f.context.options.markets=async()=>Array(1001).fill(f.market);await assert.rejects(f.flow.preview(f.input),/DISCOVERY_LIMIT/);
});
test('source identifies the exact chosen commitment and ratifier',async()=>{
 const f=strategyFixture();const p=await f.flow.preview(f.input);assert.equal((p.data as any).source.selectedOrder.commitment,f.entries[0].commitment);assert.equal((p.data as any).source.selectedOrder.ratifier,f.profile.signatureRatifier);
});
test('caller mutation during asynchronous resolution cannot alter the captured intent',async()=>{
 const f=strategyFixture();
 const pending=f.flow.preview(f.input);
 f.input.size='2';f.input.maxInput='0';f.input.evidence.mintable={state:'observed',value:true};
 const p=await pending,source=(p.data as any).source;
 assert.equal(source.requested.size,'1');assert.equal(source.requested.maxInput,'2');assert.deepEqual(source.requested.evidence,{});
 assert.equal(source.economics.face.raw,String(10n**18n));
 assert.ok(p.data.previewId);
});
test('revoked best order is skipped for a ratified full-size order, but RPC failures remain fatal',async()=>{
 const f=strategyFixture();
 const worse={...f.offer,tick:f.offer.tick+4n,group:`0x${'22'.repeat(32)}` as const};
 const commitment=adapter.offerCommitment(f.profile,worse);
 f.entries.push({...f.entries[0],offer:worse,commitment});
 const read=f.context.rpc.readContract.bind(f.context.rpc);
 f.context.rpc.readContract=async(r)=>r.functionName==='isRatified'&&r.args?.[3]===f.entries[0].commitment?`0x${'00'.repeat(32)}`:read(r);
 const p=await f.flow.preview(f.input);
 assert.equal((p.data as any).source.selectedOrder.commitment,commitment);
 f.context.rpc.readContract=async(r)=>{if(r.functionName==='isRatified')throw new Error('ratifier RPC unavailable');return read(r);};
 await assert.rejects(f.flow.preview(f.input),/ratifier RPC unavailable/);
});
