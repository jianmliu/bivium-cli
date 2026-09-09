import { encodeFunctionData, isAddress, type Abi } from 'viem';
import { erc20Abi } from '../abi.ts';
import type { Address, MarketState, Position } from '../types.ts';
import type { ActionContext, ReadContext, ContractRead } from './context.ts';
import type { ActionIntent, ActionEvaluation } from './preview.ts';
import { basicCall, type BasicAction } from './calls.ts';
import { amount, tokenDecimals } from './reads.ts';
import { ActionError, type UnsignedTx } from './types.ts';
const MAX = (1n << 256n)-1n;
function units(value:string|undefined,decimals:number):bigint {
 if(!value || !/^\d+(\.\d+)?$/.test(value))throw new ActionError('INVALID_ARGUMENT','Amount must be a positive decimal string');
 const [whole,fraction='']=value.split('.');
 if(fraction.length>decimals)throw new ActionError('INVALID_ARGUMENT','Amount exceeds token precision');
 const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
 if(n<=0n||n>MAX)throw new ActionError('INVALID_ARGUMENT','Amount must be positive uint256');
 return n;
}
export async function evaluateAction(context:ActionContext,intent:ActionIntent,ctx:ReadContext):Promise<ActionEvaluation>{
 context.requireExecutable();
 const actions:BasicAction[]=['fund','repay','withdraw_liquidity','withdraw_collateral','claim','escrow_collateral','withdraw_collateral_escrow'];
 if(!actions.includes(intent.action as BasicAction))throw new ActionError('UNSUPPORTED_ACTION','Action requires a supported basic operation');
 if(!isAddress(intent.account)||!isAddress(intent.receiver)||intent.account.toLowerCase()!==ctx.account.toLowerCase()||ctx.chainId!==context.profile.chainId||ctx.core.toLowerCase()!==context.profile.core.toLowerCase())throw new ActionError('DOMAIN_MISMATCH','Account or deployment mismatch');
 if(ctx.snapshot.coverage!=='complete')throw new ActionError('UPSTREAM_UNAVAILABLE','Relevant snapshot must be complete',true);
 const action=intent.action as BasicAction, market=await context.market(intent.marketId,ctx.signal), p=market.params;
 const incoming=['fund','repay','escrow_collateral'].includes(action);
 if(incoming&&intent.receiver.toLowerCase()!==intent.account.toLowerCase())throw new ActionError('INVALID_ARGUMENT','This action credits the account and has no alternate receiver');
 if(action==='withdraw_collateral'&&intent.amount!==undefined)throw new ActionError('INVALID_ARGUMENT','Collateral withdrawal withdraws all unlocked collateral and accepts no amount');
 const collateralAction=['withdraw_collateral','escrow_collateral','withdraw_collateral_escrow'].includes(action);
 const token=collateralAction?p.collateralToken:p.loanToken;
 const decimals=await tokenDecimals(context,ctx,token);
 let n=action==='withdraw_collateral'?0n:units(intent.amount,decimals);
 const keyState:Record<string,unknown>={params:p,decimals,matured:ctx.timestamp>=p.maturity};
 const before:Record<string,unknown>={},after:Record<string,unknown>={};
 const core=async<T>(name:string)=>{const v=await context.core<T>(ctx,name,[market.id,intent.account]);keyState[name]=v;return v;};
 const exact=(v:bigint)=>amount(v,decimals,token);
 const check=(available:bigint)=>{if(n>available)throw new ActionError('INSUFFICIENT_BALANCE','Amount exceeds available position or balance');};
 let allowance=MAX;
 if(incoming){
 const [balance,a]=await Promise.all([context.read<bigint>(ctx,token,erc20Abi,'balanceOf',[intent.account]),context.read<bigint>(ctx,token,erc20Abi,'allowance',[intent.account,ctx.core])]);
 keyState.balance=balance;keyState.allowance=a;allowance=a;check(balance);before.walletBalance=exact(balance);after.walletBalance=exact(balance-n);
 }
 if(action==='fund'||action==='withdraw_liquidity'){
 const v=await core<bigint>('liquidityOf');before.liquidity=exact(v);if(action==='withdraw_liquidity')check(v);after.liquidity=exact(action==='fund'?v+n:v-n);if(action==='withdraw_liquidity')after.loanReceived=exact(n);
 }
 if(action==='escrow_collateral'||action==='withdraw_collateral_escrow'){
 const v=await core<bigint>('collateralEscrowOf');before.collateralEscrow=exact(v);if(action==='withdraw_collateral_escrow')check(v);after.collateralEscrow=exact(action==='escrow_collateral'?v+n:v-n);if(action==='withdraw_collateral_escrow')after.collateralReceived=exact(n);
 }
 if(action==='repay'||action==='withdraw_collateral'){
 const v=await core<Position>('position');
 if(action==='repay'){
 if(ctx.timestamp>=p.maturity)throw new ActionError('MATURED','Repayment is unavailable at or past maturity');check(v.debt);
 if(!p.allowPartialRepay&&n!==v.debt)throw new ActionError('INVALID_ARGUMENT','Market requires full debt repayment');
 before.debt=exact(v.debt);after.debt=exact(v.debt-n);
 const cd=await tokenDecimals(context,ctx,p.collateralToken);keyState.collateralDecimals=cd;
 const released=n===v.debt?v.collateral:v.collateral*n/v.debt;
 before.lockedCollateral=amount(v.collateral,cd,p.collateralToken);before.collateralWithdrawable=amount(v.collateralWithdrawable,cd,p.collateralToken);
 after.lockedCollateral=amount(v.collateral-released,cd,p.collateralToken);after.collateralWithdrawable=amount(v.collateralWithdrawable+released,cd,p.collateralToken);
 }else{n=v.collateralWithdrawable;if(n<=0n)throw new ActionError('INSUFFICIENT_BALANCE','No withdrawable collateral');before.lockedCollateral=exact(v.collateral);after.lockedCollateral=exact(v.collateral);before.collateralWithdrawable=exact(n);after.collateralWithdrawable=exact(0n);after.collateralReceived=exact(n);}
 }
 if(action==='claim'){
 if(ctx.timestamp<p.maturity)throw new ActionError('NOT_MATURED','Claim requires maturity');
 const credit=await core<bigint>('creditOf');check(credit);
 const s=await context.core<MarketState>(ctx,'marketState',[market.id]);keyState.marketState=s;
 const total=s.activeCredit+s.repaidCredit, next=s.claimedCredit+n;
 if(total<=0n||next>total)throw new ActionError('INSUFFICIENT_BALANCE','Claim exceeds remaining market credit');
 const cd=await tokenDecimals(context,ctx,p.collateralToken);keyState.collateralDecimals=cd;
 before.credit=exact(credit);after.credit=exact(credit-n);
 after.loanReceived=exact(s.repaidCredit*next/total-s.repaidCredit*s.claimedCredit/total);
 after.collateralReceived=amount(s.activeCollateral*next/total-s.activeCollateral*s.claimedCredit/total,cd,p.collateralToken);
 }
 const call=basicCall(context.adapter,context.profile,p,action,intent.account,intent.receiver,n);
 const request:ContractRead={address:ctx.core,abi:context.adapter.coreAbi,...call};
 const tx=(r:ContractRead):UnsignedTx=>({chainId:ctx.chainId,from:intent.account,to:r.address,data:encodeFunctionData({abi:r.abi as Abi,functionName:r.functionName,args:r.args}),value:'0'});
 const approvals:ContractRead[]=incoming&&allowance<n?[{address:token,abi:erc20Abi,functionName:'approve',args:[ctx.core,n]}]:[];
 if(!ctx.rpc.simulateContract)throw new ActionError('UPSTREAM_UNAVAILABLE','Public RPC simulation unavailable',true);
 for(const r of approvals.length?approvals:[request]){
 try{await context.limited(()=>ctx.rpc.simulateContract!({...r,account:intent.account,blockNumber:ctx.blockNumber}),ctx.signal);}
 catch(e){throw new ActionError('SIMULATION_REVERTED',e instanceof Error?e.message:'Simulation failed');}
 }
 return {keyState,before,after,transaction:tx(request),prerequisites:approvals.map(tx),simulation:approvals.length?'prerequisites_required':'success',onchainConstraints:['Calldata binds market parameters, amount (or all unlocked collateral), account and ABI-supported receiver.','No calldata deadline; preview expiry is enforced only by this service.','Core authorization, balance and maturity rules are enforced when the transaction executes.'],postExecutionChecks:['Verify receipt success and expected position/token balance deltas after execution. These observations cannot roll back a mined transaction.']};
}
