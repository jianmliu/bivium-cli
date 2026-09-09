import { encodeFunctionData, isAddress, type Abi } from 'viem';
import { erc20Abi } from '../abi.ts';
import { entryFromSignedOffer, fillCost } from '../orderbook.ts';
import { validateTradePlan } from '../trade.ts';
import { buildOpenProgram, fillAskLeg, fillBidLeg, originationFee, type Leg } from '../strategies/program.ts';
import { getStrategy } from '../strategies/catalog.ts';
import { gateAbi, routerAbi, grantAbi, CAP_FILL } from '../strategyRouter.ts';
import { collateralForDebt } from '../math.ts';
import { ZERO_ADDRESS, type Address, type Position } from '../types.ts';
import type { ActionContext, ReadContext, ContractRead } from './context.ts';
import type { ActionIntent, ActionEvaluation } from './preview.ts';
import { ActionError, type UnsignedTx } from './types.ts';
const raw=(s:string|undefined,label:string,positive=false)=>{if(s===undefined||!/^\d+$/.test(s))throw new ActionError('INVALID_ARGUMENT',`${label} must be a raw integer string`);const n=BigInt(s);if(n>=(1n<<256n)||(positive&&n===0n))throw new ActionError('INVALID_ARGUMENT',`${label} out of range`);return n;};
export async function evaluateTradeAction(context:ActionContext,intent:ActionIntent,ctx:ReadContext):Promise<ActionEvaluation>{
 context.requireExecutable();
 if(!['buy_dcn','sell_dcn','borrow','strategy_program'].includes(intent.action))throw new ActionError('UNSUPPORTED_ACTION','Unknown trade action');
 if(!isAddress(intent.account)||!isAddress(intent.receiver)||intent.account.toLowerCase()!==ctx.account.toLowerCase()||ctx.chainId!==context.profile.chainId||ctx.core.toLowerCase()!==context.profile.core.toLowerCase())throw new ActionError('DOMAIN_MISMATCH','Account or deployment mismatch');
 if(ctx.snapshot.coverage!=='complete')throw new ActionError('UPSTREAM_UNAVAILABLE','Complete snapshot required',true);
 if(intent.receiver.toLowerCase()!==intent.account.toLowerCase())throw new ActionError('UNSUPPORTED_ACTION','Trade receiver must be the represented account');
 const deadline=raw(intent.deadline,'deadline',true);if(deadline<=ctx.timestamp)throw new ActionError('INVALID_ARGUMENT','deadline has passed');
 if(!intent.fills?.length||intent.fills.length>64)throw new ActionError('INVALID_ARGUMENT','Provide 1–64 exact signed fills');
 const market=await context.market(intent.marketId,ctx.signal),p=market.params;
 if(intent.action==='sell_dcn'&&ctx.timestamp<p.maturity)throw new ActionError('UNSUPPORTED_ACTION','Core has no secondary-only origination guard before maturity; unsigned sell could create debt if credit changes before mining');
 let strategy;
 if(intent.action==='strategy_program'){try{strategy=getStrategy(intent.strategyId??'');}catch(e){throw new ActionError('INVALID_ARGUMENT',e instanceof Error?e.message:'Unknown strategy');}}
 if(strategy&&!strategy.quotable)throw new ActionError('UNSUPPORTED_ACTION','Multi-leg catalog strategy is not supported by this atomic builder');
 const buying=intent.action==='buy_dcn'||strategy?.side==='lend';
 const borrowing=intent.action==='borrow'||(intent.action==='strategy_program'&&!buying);
 const accepted = new Set(['fills','deadline', buying?'maxCost':'minProceeds', ...(intent.action!=='sell_dcn'?['router']:[]), ...(borrowing?['maxTopUp']:[]), ...(strategy?['strategyId']:[]), ...(strategy?.requires.includes('swap')?['poolKey','minOut']:[])]);
 for(const name of ['amount','fills','deadline','maxCost','minProceeds','maxTopUp','router','strategyId','poolKey','minOut'] as const)if(intent[name]!==undefined&&!accepted.has(name))throw new ActionError('INVALID_ARGUMENT',`${name} is not used by this action`);
 const bound=raw(buying?intent.maxCost:intent.minProceeds,buying?'maxCost':'minProceeds');
 const keyState:Record<string,unknown>={params:p,deadline,matured:ctx.timestamp>=p.maturity};
 const read=async<T>(address:Address,abi:readonly unknown[],name:string,args:readonly unknown[]=[]):Promise<T>=>{const v=await context.read<T>(ctx,address,abi,name,args);keyState[`${address}:${name}:${args.map(String).join(':')}`]=v;return v;};
 let router=intent.router??(borrowing||strategy?context.profile.strategyRouter:undefined);
 if(p.gate.toLowerCase()===ZERO_ADDRESS&&router&&router.toLowerCase()!==context.profile.strategyRouter?.toLowerCase())throw new ActionError('UNSUPPORTED_ACTION','Ungated router must match the trusted host-configured strategyRouter');
 if(p.gate.toLowerCase()!==ZERO_ADDRESS){
  const routers=await read<Address[]>(p.gate,gateAbi,'routers');
  const lenderMustRoute=await read<boolean>(p.gate,gateAbi,'LENDER_MUST_ROUTE');
  if(typeof lenderMustRoute!=='boolean'||!Array.isArray(routers))throw new ActionError('UPSTREAM_UNAVAILABLE','Invalid gate routing response',true);
  if(borrowing||(buying&&lenderMustRoute)){router??=context.profile.strategyRouter??routers[0];if(!router)throw new ActionError('UNSUPPORTED_ACTION','Gate requires a compatible approved router');}
  if(router&&!routers.some(r=>r.toLowerCase()===router!.toLowerCase()))throw new ActionError('UNSUPPORTED_ACTION','Router is not approved by market gate');
 }
 if((borrowing||strategy)&&!router)throw new ActionError('UNSUPPORTED_ACTION','Atomic strategy requires a compatible router');
 if(router&&!buying&&!borrowing)throw new ActionError('UNSUPPORTED_ACTION','Router secondary sell cannot guarantee no origination');
 let feeBps=0n,lenderFeeBps=0n,maxLegs=0n;
 if(router){
  const core=await read<Address>(router,routerAbi,'BIVIUM');if(!isAddress(core)||core.toLowerCase()!==ctx.core.toLowerCase())throw new ActionError('DOMAIN_MISMATCH','Router BIVIUM differs from configured Core');
  maxLegs=await read<bigint>(router,routerAbi,'MAX_LEGS');
  if(buying)lenderFeeBps=await read<bigint>(router,routerAbi,'LENDER_FEE_BPS');else feeBps=await read<bigint>(router,routerAbi,'FEE_BPS');
 }
 const takes=intent.fills.map(f=>({entry:entryFromSignedOffer(f.offer,f.commitment,f.ratifierData),units:raw(f.units,'fill units',true)}));
 const totalUnits=takes.reduce((n,t)=>n+t.units,0n),totalCost=takes.reduce((n,t)=>n+fillCost(t.entry.offer,t.units,t.entry.price),0n);
 let validated;
 try{validated=await validateTradePlan({side:buying?'ask':'bid',takes,totalUnits,totalCost},{profile:context.profile,account:intent.account,taker:buying&&router?router:intent.account,block:{number:ctx.blockNumber,timestamp:ctx.timestamp},mode:borrowing?'borrow':'secondary',read:r=>read(r.address,r.abi,r.functionName,r.args)});}catch(e){if(e instanceof ActionError)throw e;throw new ActionError('INVALID_ARGUMENT',e instanceof Error?e.message:String(e));}
 if(validated.marketId.toLowerCase()!==market.id.toLowerCase())throw new ActionError('DOMAIN_MISMATCH','Fill market differs from requested market');
 keyState.preflight=validated.keyState;
 let fees=0n,collateral=0n;const legs:Leg[]=[];
 for(const t of takes){const cost=fillCost(t.entry.offer,t.units,t.entry.price),fee=buying?(t.units>cost?(t.units-cost)*lenderFeeBps/10000n:0n):originationFee(t.units,cost,feeBps);fees+=fee;collateral+=collateralForDebt(t.units,p.strike);
  if(router&&!strategy)legs.push(buying?fillAskLeg({domain:context.profile,ask:t.entry.offer,ratifierData:t.entry.signature,units:t.units,maxCost:cost+fee}):fillBidLeg({domain:context.profile,offer:t.entry.offer,ratifierData:t.entry.signature,units:t.units,maxTopUp:collateralForDebt(t.units,p.strike),minPrincipal:cost-fee,inner:[]}));
 }
 const paid=totalCost+fees,proceeds=totalCost-fees;
 if(buying&&paid>bound)throw new ActionError('INVALID_ARGUMENT','maxCost below total cost including fees');
 if(!buying&&proceeds<bound)throw new ActionError('INVALID_ARGUMENT','minProceeds exceeds proceeds after fees');
 let topUp=collateral;
 if(borrowing&&!strategy&&raw(intent.maxTopUp,'maxTopUp')<collateral)throw new ActionError('INVALID_ARGUMENT','maxTopUp below required collateral');
 if(strategy){
  if(takes.length!==1)throw new ActionError('UNSUPPORTED_ACTION','Strategy program requires exactly one fill');
  const minOut=strategy.requires.includes('swap')?raw(intent.minOut,'minOut',true):undefined;
  if(strategy.requires.includes('swap')){const key=intent.poolKey;if(!key||![key.currency0.toLowerCase(),key.currency1.toLowerCase()].includes(p.loanToken.toLowerCase())||![key.currency0.toLowerCase(),key.currency1.toLowerCase()].includes(p.collateralToken.toLowerCase())||BigInt(key.currency0)>=BigInt(key.currency1))throw new ActionError('INVALID_ARGUMENT','Pool key must match sorted market token pair');}
  topUp=buying?0n:raw(intent.maxTopUp,'maxTopUp');
  const creditLine=strategy.line==='credit';
  const program=buildOpenProgram({strategy,strike:p.strike,asset:creditLine?p.collateralToken:p.loanToken,numeraire:creditLine?p.loanToken:p.collateralToken,line:strategy.line},{domain:context.profile,offer:takes[0].entry.offer,ratifierData:takes[0].entry.signature,units:totalUnits,poolKey:intent.poolKey,minOut,maxTopUp:topUp,minPrincipal:bound,feeBps,lenderFeeBps});legs.push(...program.legs);keyState.program=program.derived;
 }
 if(router&&BigInt(legs.length+(strategy?.requires.includes('swap')?1:0))>maxLegs)throw new ActionError('INVALID_ARGUMENT','Program exceeds MAX_LEGS');
 const before:Record<string,unknown>={credit:validated.credit},after:Record<string,unknown>=buying?{credit:validated.credit+totalUnits,loanPaid:paid}:borrowing?{newDebt:totalUnits,principalAfterFee:proceeds,collateralTopUpCeiling:topUp}:{credit:validated.credit-totalUnits,loanReceived:proceeds};
 if(borrowing){const position=await read<Position>(ctx.core,context.adapter.coreAbi,'position',[market.id,intent.account]);keyState.position=position;before.position=position;after.debt=position.debt+totalUnits;if(strategy?.requires.includes('swap')){delete after.principalAfterFee;after.principalAllocatedToSwap=proceeds;after.minimumCollateralFromSwap=raw(intent.minOut,'minOut',true);}}
 const prerequisites:ContractRead[]=[];
 const token=buying?p.loanToken:p.collateralToken,needed=buying?paid:borrowing?topUp:0n,spender=router??ctx.core;
 if(needed>0n){const balance=await read<bigint>(token,erc20Abi,'balanceOf',[intent.account]),allowance=await read<bigint>(token,erc20Abi,'allowance',[intent.account,spender]);if(balance<needed)throw new ActionError('INSUFFICIENT_BALANCE','Wallet balance below required funds');if(allowance<needed)prerequisites.push({address:token,abi:erc20Abi,functionName:'approve',args:[spender,needed]});}
 if(router&&borrowing){const [caps,expiry]=await read<readonly[bigint,bigint]>(ctx.core,grantAbi,'grantOf',[intent.account,router]);if((caps&CAP_FILL)!==CAP_FILL||(expiry!==0n&&expiry<deadline))prerequisites.push({address:ctx.core,abi:grantAbi,functionName:'grantAuthorization',args:[router,CAP_FILL,deadline]});}
 const request:ContractRead=router?{address:router,abi:routerAbi,functionName:'execute',args:[legs,deadline]}:{address:ctx.core,abi:context.adapter.coreAbi,functionName:'multicall',args:[takes.map(t=>encodeFunctionData({abi:context.adapter.coreAbi,functionName:'fill',args:[context.adapter.chainOffer(context.profile,t.entry.offer),t.entry.signature,t.units,intent.account,intent.receiver]} as never))]};
 const tx=(r:ContractRead):UnsignedTx=>({chainId:ctx.chainId,from:intent.account,to:r.address,data:encodeFunctionData({abi:r.abi as Abi,functionName:r.functionName,args:r.args}),value:'0'});
 if(!ctx.rpc.simulateContract)throw new ActionError('UPSTREAM_UNAVAILABLE','Public simulation unavailable',true);
 for(const r of prerequisites.length?prerequisites:[request]){try{await context.limited(()=>ctx.rpc.simulateContract!({...r,account:intent.account,blockNumber:ctx.blockNumber}),ctx.signal);}catch(e){throw new ActionError('SIMULATION_REVERTED',e instanceof Error?e.message:String(e));}}
 return{keyState,before,after,transaction:tx(request),prerequisites:prerequisites.map(tx),simulation:prerequisites.length?'prerequisites_required':'success',onchainConstraints:router?['Router enforces deadline and encoded leg cost, principal, swap and top-up bounds.','Core enforces signed offer price, units, group capacity and authorization.']:['Core multicall executes exact signed fills atomically; signed ticks fix prices and exact units fix costs.','Core enforces offer windows, capacity and authorization. The requested deadline is a service check; direct calldata does not encode it. For secondary sells, the market is already mature so Core prohibits new debt if credit becomes insufficient.'],postExecutionChecks:['Verify receipt and actual credit/debt, collateral and loan-token deltas. Post-execution checks cannot roll back a mined transaction.']};
}
