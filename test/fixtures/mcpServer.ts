import { serveStdio } from '../../src/mcp/server.ts';
import { ActionContext } from '../../src/sdk/actions/context.ts';
import { adapterFor } from '../../src/sdk/lineage.ts';
import { ZERO_ADDRESS, type DeploymentProfile } from '../../src/sdk/types.ts';
const account = `0x${'03'.repeat(20)}` as const;
const profile: DeploymentProfile = {name:'stdio-fixture',chainId:46630,abiProfile:'core-v2',core:`0x${'01'.repeat(20)}`,signatureRatifier:account,rpcUrl:'http://localhost:1'};
const params = {loanToken:account,collateralToken:profile.core,maturity:2000000000n,strike:10n**36n,gate:ZERO_ADDRESS,allowPartialRepay:true};
const adapter=adapterFor('core-v2'), marketId=adapter.computeMarketId(profile,params);
const context=new ActionContext({profile,markets:async()=>[{id:marketId,params,firstSeenBlock:1n}],rpc:{
 getChainId:async()=>46630,getBlock:async()=>({number:10n,hash:`0x${'11'.repeat(32)}`,timestamp:1000n}),
 readContract:async r=>{if(r.blockNumber!==10n)throw Error('Unpinned read');switch(r.functionName){
 case 'computeId':return adapter.computeMarketId(profile,r.args![0] as typeof params);
 case 'decimals':return 6;case 'allowance':case 'balanceOf':return 100000000n;case 'liquidityOf':return 10000000n;
 case 'marketState':return {touched:true,activeCredit:10000000n,repaidCredit:0n,activeCollateral:10000000n,claimedCredit:0n};
 default:throw Error(`Unexpected read ${r.functionName}`);}},
 simulateContract:async r=>{if(r.functionName!=='fund'||r.account!==account||r.blockNumber!==10n)throw Error('Unexpected simulation');return{};},
}});
Object.defineProperty(context,'wallet',{get(){throw Error('Wallet access forbidden');}});
globalThis.fetch=async()=>{throw Error('Network access forbidden in stdio fixture');};
await serveStdio({profile,actionContext:context,policies:{test:{source:'user-policy',rules:{rejectArbitraryMint:true,rejectUnsellable:true,confirmOnUnknown:false}}}});
