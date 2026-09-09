import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { ActionContext, type ContractRead } from '../src/sdk/actions/context.ts';
import { ActionService, type ActionIntent } from '../src/sdk/actions/preview.ts';
import { evaluateAction } from '../src/sdk/actions/prepare.ts';
import { adapterFor } from '../src/sdk/lineage.ts';
import { erc20Abi } from '../src/sdk/abi.ts';
import { ZERO_ADDRESS, type DeploymentProfile } from '../src/sdk/types.ts';
const account = `0x${'03'.repeat(20)}` as const, receiver = `0x${'04'.repeat(20)}` as const;
const profile: DeploymentProfile = { name:'fixture',chainId:46630,abiProfile:'core-v2',core:`0x${'01'.repeat(20)}`,signatureRatifier:account,rpcUrl:'http://localhost:1' };
const adapter = adapterFor('core-v2');
function fixture(partial = true) {
 const params = {loanToken:account,collateralToken:receiver,maturity:2000n,strike:10n**36n,gate:ZERO_ADDRESS,allowPartialRepay:partial};
 const marketId = adapter.computeMarketId(profile,params);
 const state = {timestamp:1000n,allowance:100000000n,balance:100000000n,liquidity:10000000n,debt:5000000n,escrow:9000000n,revert:false,escrowUnavailable:false};
 const simulations: ContractRead[] = [];
 const context = new ActionContext({profile,markets:async()=>[{id:marketId,params,firstSeenBlock:1n}],rpc:{
 getChainId:async()=>46630,getBlock:async()=>({number:10n,hash:`0x${'11'.repeat(32)}`,timestamp:state.timestamp}),
 readContract:async(r)=> { assert.equal(r.blockNumber,10n); switch(r.functionName){
 case 'computeId':return adapter.computeMarketId(profile,r.args![0] as typeof params); case 'decimals':return 6; case 'allowance':return state.allowance;
 case 'balanceOf':return state.balance; case 'liquidityOf':return state.liquidity; case 'position':return {debt:state.debt,collateral:7000000n,collateralWithdrawable:2000000n}; case 'creditOf':return 5000000n;
 case 'collateralEscrowOf':if(state.escrowUnavailable)throw Error('escrow unavailable');return state.escrow; case 'marketState':return {touched:true,activeCredit:7000000n,repaidCredit:3000000n,activeCollateral:11000000n,claimedCredit:1n}; default:throw Error(r.functionName); }},
 simulateContract:async(r)=> {assert.equal(r.account,account);assert.equal(r.blockNumber,10n); simulations.push(r);if(state.revert)throw Error('revert');return {};},
 } });
 Object.defineProperty(context,'wallet',{get(){throw Error('wallet forbidden');}});
 const intent:ActionIntent={action:'fund',marketId,account,receiver:account,amount:'1',policyId:'test',collateralKind:'other',evidence:{}};
 const evaluate = async(p:Partial<ActionIntent>={})=>evaluateAction(context,{...intent,...p},await context.pin(account));
 return {context,intent,evaluate,state,simulations};
}
for(const [action,name] of [['fund','fund'],['repay','repay'],['withdraw_liquidity','withdrawLiquidity'],['withdraw_collateral','withdrawCollateral'],['claim','claim'],['escrow_collateral','escrowCollateral'],['withdraw_collateral_escrow','withdrawCollateralEscrow']] as const) {
 test(`unsigned ${action} encodes domain, account, receiver and exact units`,async()=>{
 const f=fixture();if(action==='claim')f.state.timestamp=2000n;
 const outgoing=['withdraw_liquidity','withdraw_collateral','claim','withdraw_collateral_escrow'].includes(action);
 const e=await f.evaluate({action,receiver:outgoing?receiver:account,amount:action==='withdraw_collateral'?undefined:'1.000001'});
 assert.equal(e.transaction.chainId,46630);assert.equal(e.transaction.from,account);assert.equal(e.transaction.to,profile.core);assert.equal(e.transaction.value,'0');
 const decoded=decodeFunctionData({abi:adapter.coreAbi,data:e.transaction.data});assert.equal(decoded.functionName,name);
 const args=decoded.args as unknown[];if(outgoing)assert.equal(String(args.at(-1)).toLowerCase(),receiver);
 if(action!=='withdraw_collateral')assert.ok(args.includes(1000001n));assert.equal(e.simulation,'success');assert.equal(f.simulations.length,1);
 });
}
test('allowance yields exact approval only through prepare, repreview required',async()=>{
 const f=fixture();f.state.allowance=0n;
 const service=new ActionService(f.context,{test:{source:'user-policy',rules:{rejectArbitraryMint:true,rejectUnsellable:true,confirmOnUnknown:false}}},{evaluate:(i,c)=>evaluateAction(f.context,i,c)});
 const p=await service.preview(f.intent);const prepared=(await service.prepare(p.data.previewId!)).data;
 assert.equal(prepared.kind,'prerequisites');if(prepared.kind!=='prerequisites')throw Error('wrong kind');assert.equal(prepared.repreviewRequired,true);assert.equal('transaction' in prepared,false);
 const tx=prepared.transactions[0];assert.equal(tx.to,account);assert.deepEqual(decodeFunctionData({abi:erc20Abi,data:tx.data}).args,[profile.core,1000000n]);
 assert.ok(f.simulations.every(r=>r.functionName==='approve'));
});
test('amount, debt, maturity, locked and escrow boundaries fail closed',async()=>{
 const f=fixture();for(const amount of ['0','-1','1.0000001','1e6',String(2n**256n)])await assert.rejects(f.evaluate({amount}),/INVALID_ARGUMENT/);
 await assert.rejects(f.evaluate({receiver}),/INVALID_ARGUMENT/);
 await assert.rejects(f.evaluate({action:'repay',amount:'5.000001'}),/INSUFFICIENT/);
 await assert.rejects(fixture(false).evaluate({action:'repay'}),/INVALID_ARGUMENT/);
 await assert.rejects(f.evaluate({action:'claim'}),/NOT_MATURED/);
 f.state.timestamp=2000n;await assert.rejects(f.evaluate({action:'repay'}),/MATURED/);
 await assert.rejects(f.evaluate({action:'withdraw_collateral',amount:'1'}),/INVALID_ARGUMENT/);
 await assert.rejects(f.evaluate({action:'withdraw_collateral_escrow',amount:'9.000001'}),/INSUFFICIENT/);
});
test('claim uses cumulative floor differences; withdrawal excludes locked collateral',async()=>{
 const f=fixture();f.state.timestamp=2000n;
 const c=await f.evaluate({action:'claim',amount:'0.000003'});assert.equal((c.after as any).loanReceived.raw,'1');assert.equal((c.after as any).collateralReceived.raw,'3');
 const w=await f.evaluate({action:'withdraw_collateral',amount:undefined});assert.equal((w.after as any).collateralReceived.raw,'2000000');
});
test('state changes require repreview and simulation revert never broadcasts',async()=>{
 const f=fixture();const service=new ActionService(f.context,{test:{source:'user-policy',rules:{rejectArbitraryMint:true,rejectUnsellable:true,confirmOnUnknown:false}}},{evaluate:(i,c)=>evaluateAction(f.context,i,c)});
 const p=await service.preview(f.intent);f.state.balance--;await assert.rejects(service.prepare(p.data.previewId!),/STATE_CHANGED/);
 f.state.revert=true;await assert.rejects(f.evaluate(),/SIMULATION_REVERTED/);
});

test('irrelevant escrow outage does not block funding; outgoing amounts are explicit',async()=>{
 const f=fixture();f.state.escrowUnavailable=true;await f.evaluate();
 await assert.rejects(f.evaluate({action:'withdraw_collateral_escrow'}),/UPSTREAM_UNAVAILABLE/);
 const w=await f.evaluate({action:'withdraw_liquidity'});assert.equal((w.after as any).loanReceived.raw,'1000000');
});
test('repayment collateral release floors exactly and full repayment works',async()=>{
 const f=fixture();const r=await f.evaluate({action:'repay',amount:'0.000001'});
 assert.equal((r.after as any).debt.raw,'4999999');assert.equal((r.after as any).lockedCollateral.raw,'6999999');assert.equal((r.after as any).collateralWithdrawable.raw,'2000001');
 const full=await fixture(false).evaluate({action:'repay',amount:'5'});assert.equal((full.after as any).debt.raw,'0');
});
