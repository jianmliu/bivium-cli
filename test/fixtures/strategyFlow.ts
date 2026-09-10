import { encodeAbiParameters } from 'viem';
import { StrategyFlowService, type StrategyPreviewIntent } from '../../src/sdk/actions/strategyFlow.ts';
import { ActionService } from '../../src/sdk/actions/preview.ts';
import { ActionContext } from '../../src/sdk/actions/context.ts';
import { adapterFor } from '../../src/sdk/lineage.ts';
import { entryFromSignedOffer } from '../../src/sdk/orderbook.ts';
import { RATIFIED } from '../../src/sdk/ratify.ts';
import { ZERO_ADDRESS, type Address, type DeploymentProfile, type Offer } from '../../src/sdk/types.ts';
const a=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Address;
const adapter=adapterFor('core-v2'), max=(1n<<256n)-1n;
export function strategyFixture(strategy:StrategyPreviewIntent['strategy']='lendAsset', overrides:Record<string,unknown>={}) {
 const credit=['lendQuote','leveredLong'].includes(strategy), borrow=['short','leveredLong'].includes(strategy);
 const profile:DeploymentProfile={name:'fixture',abiProfile:'core-v2',chainId:46630,core:a(1),signatureRatifier:a(2),setterRatifier:a(9),strategyRouter:a(8),v4StateView:a(10),rpcUrl:'http://127.0.0.1:1',tokens:{CAT:{address:a(3),decimals:18},USDC:{address:a(4),decimals:18}}};
 const p={loanToken:credit?a(4):a(3),collateralToken:credit?a(3):a(4),maturity:10000n,strike:credit?8n*10n**23n:8n*10n**47n,allowPartialRepay:true,gate:ZERO_ADDRESS};
 const offer:Offer={...p,maker:a(5),buy:borrow,tick:4000n,maxUnits:10n**30n,maxAssets:0n,start:0n,expiry:6000n,group:`0x${'00'.repeat(32)}`,ratifier:a(2)};
 const calls:any[]=[], market={id:adapter.computeMarketId(profile,p),params:p};
 const rpc:any={getChainId:async()=>46630,getBlock:async()=>({number:10n,hash:`0x${'11'.repeat(32)}`,timestamp:100n}),readContract:async(r:any)=>{
  calls.push(r); if(r.functionName==='computeId')return adapter.computeMarketId(profile,{loanToken:ZERO_ADDRESS,collateralToken:ZERO_ADDRESS,maturity:1n,strike:1n,allowPartialRepay:false,gate:ZERO_ADDRESS});
  if(Object.hasOwn(overrides,r.functionName)){const v=overrides[r.functionName];if(v instanceof Error)throw v;return v;}
  if(r.functionName==='decimals')return r.address===a(3)?18:6;
  if(r.functionName==='creditOf')return r.args[1]===a(6)?0n:10n**30n;
  return ({isRatifier:true,isRatified:RATIFIED,consumed:0n,collateralEscrowOf:10n**30n,liquidityOf:10n**30n,balanceOf:10n**30n,allowance:max,BIVIUM:a(1),MAX_LEGS:16n,FEE_BPS:100n,LENDER_FEE_BPS:1000n,grantOf:[4n,20000n],position:{debt:0n,collateral:0n,collateralWithdrawable:0n},routers:[a(8)],LENDER_MUST_ROUTE:true} as any)[r.functionName];
 }, call:async(r:any)=>{calls.push(r);return {data:encodeAbiParameters([{type:'uint256'}],[r.data.startsWith('0xc815641c')?(2n**96n)/1000000n:10n**30n])};},simulateContract:async(r:any)=>{calls.push({...r,simulation:true});return {};}};
 const entries=[entryFromSignedOffer(offer,adapter.offerCommitment(profile,offer),'0x')];
 const context=new ActionContext({profile,rpc,markets:async()=>[market] as any,book:async()=>({entries,source:'fixture',coverage:'complete'})});
 const actions=new ActionService(context,{test:{source:'user-policy',rules:{rejectArbitraryMint:false,rejectUnsellable:false,confirmOnUnknown:false}}});
 const options={spot:async()=>({px:10n**18n,status:'ready' as const,pair:'CAT-USDC'})};
 const flow=new StrategyFlowService(actions,options);
 const input:StrategyPreviewIntent={strategy,asset:'CAT',size:'1',maturity:'10000',bufferPct:credit?20:25,account:a(6),maxInput:'2',slippageBps:50,...(borrow?{maxPriceImpactBps:100}:{}),policyId:'test',collateralKind:'other',evidence:{}};
 return {flow,input,actions,context,profile,market,offer,entries,calls,options};
}
