import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPairRatio } from '../src/sdk/spot.ts';
import { spotPxFor } from '../src/sdk/strategies/gather.ts';
import type { DeploymentProfile } from '../src/sdk/types.ts';
import { runCli } from '../src/cli/main.ts';
import { BiviumClient } from '../src/sdk/client.ts';
import { adapterFor } from '../src/sdk/lineage.ts';
import { strikeFromFloor } from '../src/sdk/math.ts';
import { strategyFixture } from './fixtures/strategyFlow.ts';
import { createStrategyMcp } from '../src/mcp/server.ts';

const asset='0xb0F5bb3028A46Ab101b29A540E304aE3a5bBE877' as const;
const usd='0x628626de13dd4b5b1cb80d468c261c15df00d717' as const;
const profile:DeploymentProfile={name:'mock',chainId:46630,abiProfile:'core-v2',core:'0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4',signatureRatifier:'0x0000000000000000000000000000000000000002',rpcUrl:'https://rpc.invalid',relayerUrl:'https://relayer.invalid/api/',tokens:{mNVDA:{address:asset,decimals:18},bUSD:{address:usd,decimals:6}}};
const payload={version:1,pair:'MNVDA-BUSD',mock:true,mnvdaBusdWad:'225000000000000000001',observedAt:10000};
const direct={loanToken:usd,collateralToken:asset};
const reverse={loanToken:asset,collateralToken:usd};

test('Mock reference preserves canonical WAD, reciprocal, observation metadata and no sigma in both directions',async(t)=>{
 t.mock.method(Date,'now',()=>10001_000);
 const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json(payload);});
 const a=await (fetchPairRatio as any)(profile,'MNVDA-BUSD',direct);
 const b=await (fetchPairRatio as any)(profile,'BUSD-MNVDA',reverse);
 assert.equal(a?.loanPerCollateralWad,BigInt(payload.mnvdaBusdWad));
 assert.equal(b?.loanPerCollateralWad,10n**36n/BigInt(payload.mnvdaBusdWad));
 assert.equal(a.mock,true);assert.equal(a.observedAt,10000);assert.equal(a.expiresAt,11800);assert.equal(a.source,'https://relayer.invalid/api/mock-refill-spot');assert.equal(a.sigma21d,undefined);
 assert.deepEqual(urls,['https://relayer.invalid/api/mock-refill-spot','https://relayer.invalid/api/mock-refill-spot']);
 const credit=await (spotPxFor as any)(profile,'credit','bUSD','mNVDA',direct);
 const options=await (spotPxFor as any)(profile,'options','mNVDA','bUSD',reverse);
 assert.equal(credit.px,BigInt(payload.mnvdaBusdWad));assert.equal(options.px,credit.px,'do not re-invert a rounded reciprocal');
 assert.equal(options.mock,true);assert.equal(options.observedAt,10000);assert.equal(options.sigmaAnnual,undefined);
});

for(const [name,body] of Object.entries({expired:{...payload,observedAt:8200},boundary:{...payload,observedAt:8201},future:{...payload,observedAt:10002},missingTime:{...payload,observedAt:undefined},fractionalTime:{...payload,observedAt:10000.5},unsafeTime:{...payload,observedAt:Number.MAX_SAFE_INTEGER+1},zeroTime:{...payload,observedAt:0},wrongVersion:{...payload,version:2},wrongPair:{...payload,pair:'BUSD-MNVDA'},notMock:{...payload,mock:false},zero:{...payload,mnvdaBusdWad:'0'},negative:{...payload,mnvdaBusdWad:'-1'},number:{...payload,mnvdaBusdWad:225},decimal:{...payload,mnvdaBusdWad:'225.0'},exponent:{...payload,mnvdaBusdWad:'2e18'},overflow:{...payload,mnvdaBusdWad:String(1n<<256n)}})){
 test(`Mock ${name} fails closed without legacy fallback`,async(t)=>{
  t.mock.method(Date,'now',()=>10001_000);const urls:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json(body);});
  assert.equal(await (fetchPairRatio as any)(profile,'MNVDA-BUSD',direct),null);
  assert.deepEqual(urls,['https://relayer.invalid/api/mock-refill-spot']);
 });
}
test('Mock accepts age 1799 but HTTP and network errors never fall back',async(t)=>{
 t.mock.method(Date,'now',()=>11799_000);
 t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
 assert.ok(await (fetchPairRatio as any)(profile,'MNVDA-BUSD',direct));
 for(const fail of [async()=>new Response('',{status:503}),async()=>{throw Error('network');}]){
  const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return fail();});
  assert.equal(await (fetchPairRatio as any)(profile,'MNVDA-BUSD',direct),null);assert.equal(urls.length,1);assert.match(urls[0],/mock-refill-spot$/);
 }
});
test('Mock selection requires exact chain, Core and actual token addresses; unrelated domains retain legacy feed',async(t)=>{
 const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json({loanPerCollateral:3,status:'ready',assumed:[]});});
 for(const [p,tokens] of [[{...profile,chainId:1},direct],[{...profile,core:usd},direct],[profile,{...direct,collateralToken:profile.core}],[profile,{}]] as const){
  const value=await (fetchPairRatio as any)(p,'MNVDA-BUSD',tokens);assert.equal(value?.loanPerCollateral,3);
 }
 assert.ok(urls.every(u=>u==='https://relayer.invalid/api/spot?pair=MNVDA-BUSD'));
});
test('Mock reciprocal underflow fails closed rather than returning a ready zero ratio',async(t)=>{
 t.mock.method(Date,'now',()=>10001_000);t.mock.method(globalThis,'fetch',async()=>Response.json({...payload,mnvdaBusdWad:String((1n<<256n)-1n)}));
 assert.equal(await fetchPairRatio(profile,'BUSD-MNVDA',reverse),null);
});
test('CLI market and strategy JSON/human outputs identify the Mock source and source times',async(t)=>{
 t.mock.method(Date,'now',()=>10001_000);
 const params={...direct,maturity:20000n,strike:strikeFromFloor('180',6,18),allowPartialRepay:true,gate:'0x0000000000000000000000000000000000000000' as const};
 const market={id:adapterFor('core-v2').computeMarketId(profile,params),params};
 const json=(value:unknown)=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v));
 const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json(String(url).endsWith('/markets')?json({chainId:profile.chainId,core:profile.core,markets:[market]}):payload);});
 t.mock.method(BiviumClient.prototype,'marketState',async()=>({activeCredit:0n,repaidCredit:0n} as any));
 const logs:string[]=[];t.mock.method(console,'log',(...args:unknown[])=>logs.push(args.join(' ')));
 const args=['--profile',new URL('../profiles/robinhood-testnet.json',import.meta.url).pathname,'--source','relayer'];
 await runCli(['market','list',...args,'--json']);
 const rows=JSON.parse(logs.pop()!).markets;assert.equal(rows[0].spotReference?.mock,true);assert.equal(rows[0].spotReference.observedAt,10000);
 await runCli(['market','list',...args]);assert.match(logs.pop()!,/Mock.*observedAt=10000.*expiresAt=11800/);
 const quote=['strategy','quote','--strategy','lendQuote','--asset','mNVDA','--size','1','--maturity','20000','--buffer','20','--price','990000000000000000',...args];
 await runCli([...quote,'--json']);const g=JSON.parse(logs.pop()!);assert.equal(g.spotReference.mock,true);assert.equal(g.spotReference.observedAt,10000);assert.equal(g.spotReference.expiresAt,11800);assert.equal(g.spot,payload.mnvdaBusdWad);assert.equal(g.sigmaSource,'none');
 await runCli(quote);assert.match(logs.pop()!,/Mock.*observedAt=10000.*expiresAt=11800/);
 assert.ok(urls.every(u=>u.endsWith('/markets')||u.endsWith('/mock-refill-spot')));
});
test('MCP default strategy source uses deployment-bound Mock HTTP and preserves metadata through prepare',async(t)=>{
 let now=2000_000;t.mock.method(Date,'now',()=>now);
 const f=strategyFixture('lendAsset');Object.assign(f.profile,profile);
 Object.assign(f.market.params,reverse);Object.assign(f.offer,reverse);
 f.market.id=adapterFor('core-v2').computeMarketId(f.profile,f.market.params);
 f.entries[0].commitment=adapterFor('core-v2').offerCommitment(f.profile,f.offer);f.input.asset='mNVDA';
 const read=f.context.rpc.readContract.bind(f.context.rpc);f.context.rpc.readContract=async r=>r.functionName==='decimals'?(r.address.toLowerCase()===asset.toLowerCase()?18:6):read(r);
 const urls:string[]=[];t.mock.method(globalThis,'fetch',async(url:unknown)=>{urls.push(String(url));return Response.json({...payload,mnvdaBusdWad:'1000000000000000000',observedAt:210});});
 const mcp=createStrategyMcp({profile:f.profile,actionContext:f.context,actionService:f.actions});
 let id=0;const call=async(name:string,args:unknown)=>(await mcp.handle({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}}))!.result as any;
 const preview=await call('strategy_preview',f.input);assert.equal(preview.isError,undefined,JSON.stringify(preview));
 const p=preview.structuredContent.data;assert.equal(p.source.spot.mock,true);assert.equal(p.source.spot.px,'1000000000000000000');assert.equal(p.source.spot.observedAt,210);assert.equal(p.source.spot.expiresAt,2010);assert.equal(p.source.spot.source,'https://relayer.invalid/api/mock-refill-spot');assert.equal(p.source.spot.sigmaAnnual,undefined);
 const ready=await call('action_prepare',{previewId:p.previewId});assert.equal(ready.structuredContent.data.kind,'ready');assert.deepEqual(ready.structuredContent.data.source.spot,p.source.spot);
 now=2010_000;const expired=await call('action_prepare',{previewId:p.previewId});assert.equal(expired.isError,true);assert.equal(expired.structuredContent.nextAction,'strategy_preview');
 assert.deepEqual(urls,['https://relayer.invalid/api/mock-refill-spot']);
});
