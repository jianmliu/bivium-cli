import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionContext } from '../src/sdk/actions/context.ts';
import { adapterFor } from '../src/sdk/lineage.ts';
import { ZERO_ADDRESS, type Address, type DeploymentProfile } from '../src/sdk/types.ts';
import { resolveRouteAdmission, quoteRouteFill, assertRouteSwapCapability } from '../src/sdk/actions/routeAdmission.ts';
import { marketDetails } from '../src/sdk/actions/reads.ts';

const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const adapter=adapterFor('core-v2');
function fixture(overrides:Record<string,unknown>={}) {
 const profile:DeploymentProfile={name:'route',chainId:46630,abiProfile:'core-v2',core:a(1),signatureRatifier:a(2),strategyRouter:a(8),v4StateView:a(10),rpcUrl:'http://localhost:1'};
 const params={loanToken:a(3),collateralToken:a(4),maturity:10000n,strike:10n**36n,allowPartialRepay:true,gate:a(7)};
 const calls:any[]=[];
 const context=new ActionContext({profile,rpc:{getChainId:async()=>46630,getBlock:async()=>({number:10n,hash:`0x${'11'.repeat(32)}`,timestamp:100n}),getBytecode:async r=>{calls.push({...r,functionName:'code'});const v=overrides[`${r.address}:code`]??overrides.code??'0x6000';if(v instanceof Error)throw v;return v as any;},readContract:async r=>{
  calls.push(r);if(r.functionName==='computeId')return adapter.computeMarketId(profile,r.args![0] as any);
  const key=`${r.address}:${r.functionName}`;
  if(Object.hasOwn(overrides,key)||Object.hasOwn(overrides,r.functionName)){const v=overrides[key]??overrides[r.functionName];if(v instanceof Error)throw v;return v;}
  return ({BIVIUM:a(1),routers:[a(9)],LENDER_MUST_ROUTE:true,FEE_BPS:1000n,LENDER_FEE_BPS:1000n,MAX_LEGS:16n,POOL_MANAGER:a(11),poolManager:a(11),quoteFee:[20n,80n],quoteLenderFee:[20n,120n]} as any)[r.functionName];
 }}});
 return {context,params,calls};
}
test('stale profile router is replaced only by the unique compatible admitted router, with pinned evidence',async()=>{
 const {context,params,calls}=fixture();const ctx=await context.pin();
 const route=await resolveRouteAdmission(context,ctx,params,{side:'borrow'});
 assert.equal(route.router,a(9));assert.equal(route.feeBps,1000n);assert.equal(route.lenderFeeBps,null);
 assert.ok(calls.every(c=>c.blockNumber===10n));assert.ok(calls.some(c=>c.functionName==='code'));
 assert.ok(Object.keys(route.evidence).length>5);
});
test('explicit non-admitted and incompatible routers never silently change',async()=>{
 const f=fixture();await assert.rejects(resolveRouteAdmission(f.context,await f.context.pin(),f.params,{side:'borrow',router:a(8)}),/not admitted/);
 const g=fixture({[`${a(9)}:BIVIUM`]:a(20)});await assert.rejects(resolveRouteAdmission(g.context,await g.context.pin(),g.params,{side:'borrow',router:a(9)}),/Core/);
});
test('ambiguous routes reject; compatible admitted profile is preferred; duplicates are not ambiguity',async()=>{
 for(const [routers,expected] of [[[a(9),a(12)],undefined],[[a(8),a(9)],a(8)],[[a(9),a(9)],a(9)]] as const){const f=fixture({routers});const p=resolveRouteAdmission(f.context,await f.context.pin(),f.params,{side:'borrow'});if(expected)assert.equal((await p).router,expected);else await assert.rejects(p,/ambiguous|Multiple/i);}
});
test('route validation rejects malformed gate, fee, bytecode and max-leg capabilities',async()=>{
 for(const overrides of [{code:'0x'},{[`${a(7)}:BIVIUM`]:a(20)},{routers:[ZERO_ADDRESS]},{routers:Array(101).fill(a(9))},{LENDER_MUST_ROUTE:1},{FEE_BPS:2001n},{LENDER_FEE_BPS:-1n},{MAX_LEGS:0n},{MAX_LEGS:1025n}]){const f=fixture(overrides);await assert.rejects(resolveRouteAdmission(f.context,await f.context.pin(),f.params,{side:'borrow',checkBothFees:true}));}
});
test('unknown candidate RPC status fails closed while proving uniqueness; known incompatible candidate can be excluded',async()=>{
 const f=fixture({routers:[a(9),a(12)],[`${a(12)}:BIVIUM`]:new Error('transport unavailable')});await assert.rejects(resolveRouteAdmission(f.context,await f.context.pin(),f.params,{side:'borrow'}),/UPSTREAM_UNAVAILABLE/);
 const g=fixture({routers:[a(9),a(12)],[`${a(12)}:BIVIUM`]:a(20)});assert.equal((await resolveRouteAdmission(g.context,await g.context.pin(),g.params,{side:'borrow'})).router,a(9));
});
test('ungated arbitrary router is untrusted and ordinary direct buys do not require swap or router',async()=>{
 const f=fixture();f.params.gate=ZERO_ADDRESS;await assert.rejects(resolveRouteAdmission(f.context,await f.context.pin(),f.params,{side:'borrow',router:a(9)}),/trusted/);
 delete f.context.profile.strategyRouter;const route=await resolveRouteAdmission(f.context,await f.context.pin(),f.params,{side:'buy'});assert.equal(route.router,undefined);
});
test('actual per-fill quotes preserve capped and legacy economics without globally imposing a cap',async()=>{
 for(const [tuple,side,expected] of [[[20n,80n],'borrow',80n],[[90n,10n],'borrow',10n],[[20n,120n],'buy',120n]] as const){const f=fixture({[side==='buy'?'quoteLenderFee':'quoteFee']:tuple});const ctx=await f.context.pin(),route=await resolveRouteAdmission(f.context,ctx,f.params,{side});const q=await quoteRouteFill(f.context,ctx,route,side,1000n,100n);assert.equal(side==='buy'?q.total:q.net,expected);assert.equal(q.fee,tuple[0]);}
});
test('missing, reverting, malformed and inconsistent fee tuples never fall back to BPS or zero',async()=>{
 for(const value of [undefined,new Error('revert'),[1n,80n],[-1n,101n],[1,99n],[1n<<256n,0n]]){const f=fixture({quoteFee:value});const ctx=await f.context.pin(),route=await resolveRouteAdmission(f.context,ctx,f.params,{side:'borrow'});await assert.rejects(quoteRouteFill(f.context,ctx,route,'borrow',1000n,100n));}
});
test('swap capability checks pinned router, StateView and optional Quoter linkage separately from fills',async()=>{
 for(const overrides of [{POOL_MANAGER:ZERO_ADDRESS},{poolManager:a(20)},{[`${a(10)}:code`]:'0x'}]){const f=fixture(overrides);const ctx=await f.context.pin(),route=await resolveRouteAdmission(f.context,ctx,f.params,{side:'borrow'});assert.equal(route.router,a(9));await assert.rejects(assertRouteSwapCapability(f.context,ctx,route),/SWAP_UNAVAILABLE/);}
 const f=fixture();f.context.profile.v4Quoter=a(13);const ctx=await f.context.pin(),route=await resolveRouteAdmission(f.context,ctx,f.params,{side:'borrow'});await assertRouteSwapCapability(f.context,ctx,route,{useQuoter:true});assert.ok(f.calls.every(c=>c.blockNumber===10n));assert.ok(f.calls.some(c=>c.address===a(13)&&c.functionName==='poolManager'));
});
test('unused configured Quoter cannot disable an explicit-floor swap',async()=>{
 const f=fixture({[`${a(13)}:code`]:'0x'});f.context.profile.v4Quoter=a(13);const ctx=await f.context.pin(),route=await resolveRouteAdmission(f.context,ctx,f.params,{side:'borrow'});
 await assertRouteSwapCapability(f.context,ctx,route,{useQuoter:false});
 await assert.rejects(assertRouteSwapCapability(f.context,ctx,route,{useQuoter:true}),/SWAP_UNAVAILABLE/);
});
test('no-router zero fee is reserved to a verified direct buy, never borrowing',async()=>{
 const f=fixture();f.params.gate=ZERO_ADDRESS;const ctx=await f.context.pin(),route=await resolveRouteAdmission(f.context,ctx,f.params,{side:'buy'});
 assert.equal((await quoteRouteFill(f.context,ctx,route,'buy',100n,100n)).fee,0n);
 await assert.rejects(quoteRouteFill(f.context,ctx,route,'borrow',100n,100n),/router/i);
 await assert.rejects(quoteRouteFill(f.context,ctx,{...route,lenderMustRoute:true},'buy',100n,100n),/router/i);
});
test('market details expose actual admitted router, conditional DCN safety and unknown fees as partial',async()=>{
 for(const broken of [false,true]){
  const f=fixture({decimals:6,marketState:{touched:true},...(broken?{FEE_BPS:new Error('RPC unavailable')}:{})});const market={id:adapter.computeMarketId(f.context.profile,f.params),params:f.params};f.context.options.markets=async()=>[market] as any;
  const r=await marketDetails(f.context,market.id);
  if(broken){assert.equal(r.snapshot!.coverage,'partial');assert.equal(r.data.fees,null);assert.ok(r.warnings.length);}
  else assert.equal(r.data.fees!.router,a(9));
  assert.equal((r.data as any).dcnCapabilities.sellBeforeMaturity.supported,false);
  assert.match((r.data as any).dcnCapabilities.sellBeforeMaturity.reason,/NO_SECONDARY_ONLY_GUARD/);
 }
});
test('buy capability is admitted independently from borrow and respects service execution scope',async()=>{
 for(const [overrides,gate,expected] of [[{LENDER_FEE_BPS:new Error('missing lender getter')},a(7),false],[{LENDER_MUST_ROUTE:false,routers:[]},a(7),true],[{},ZERO_ADDRESS,true]] as const){
  const f=fixture({decimals:6,marketState:{touched:true},...overrides});f.params.gate=gate;
  if(gate===ZERO_ADDRESS)delete f.context.profile.strategyRouter;
  const m={id:adapter.computeMarketId(f.context.profile,f.params),params:f.params};f.context.options.markets=async()=>[m] as any;
  assert.equal((await marketDetails(f.context,m.id)).data.dcnCapabilities.buy.supported,expected);
 }
 const f=fixture({decimals:6,marketState:{touched:true}});f.params.maturity=50n;
 const m={id:adapter.computeMarketId(f.context.profile,f.params),params:f.params};f.context.options.markets=async()=>[m] as any;
 assert.equal((await marketDetails(f.context,m.id)).data.dcnCapabilities.buy.supported,false);
});
