import { getAddress, isAddress } from 'viem';
import { type Address, type MarketParams, ZERO_ADDRESS } from '../types.ts';
import { type SpotRef, spotPxFor } from '../strategies/gather.ts';
import { getStrategy } from '../strategies/catalog.ts';
import { classifyLine } from '../strategies/lines.ts';
import { resolveStrategy } from '../strategies/resolve.ts';
import { quoteStrategy } from '../strategies/quote.ts';
import type { MarketRiskInput, PoolRow } from '../strategies/types.ts';
import { collateralForDebt, debtForCollateral } from '../math.ts';
import { originationFee, type PoolKey } from '../strategies/program.ts';
import { swapFloor, readSqrtPriceX96, outAtPoolPrice, type SwapFloor } from '../strategies/pools.ts';
import { gateAbi, routerAbi } from '../strategyRouter.ts';
import { entryFromSignedOffer, fillCost, offerActiveAt, sortSide, validateGroups, planSweepByFace, makerBackingKey, type BookEntry, type MakerBacking } from '../orderbook.ts';
import { fetchRelayerBook } from '../relayer.ts';
import { MAX_TICK, TICK_SPACING } from '../tick.ts';
import { RATIFIED } from '../ratify.ts';
import { ActionService, type ActionIntent } from './preview.ts';
import type { ReadContext } from './context.ts';
import { amount, tokenDecimals } from './reads.ts';
import { ActionError } from './types.ts';

export interface StrategyPreviewIntent {
 strategy: 'lendAsset' | 'lendQuote' | 'short' | 'leveredLong';
 asset: string; size: string; maturity: string; bufferPct: number; account: Address;
 maxInput: string; slippageBps: number; maxPriceImpactBps?: number;
 policyId: string; collateralKind: MarketRiskInput['collateralKind']; evidence: MarketRiskInput['evidence']; ttlSeconds?: number;
}
export interface StrategyFlowOptions {
 /** Trusted host injection; no spot, book, router or pool is accepted in a user intent. */
 spot?: (relayerUrl: string | undefined, line: 'options' | 'credit' | 'exchange', loanSymbol: string | undefined, collateralSymbol: string | undefined, ctx: ReadContext) => Promise<SpotRef>;
 pools?: Array<{ fee: number; tickSpacing: number; hooks: Address }>;
}
const MAX=(1n<<256n)-1n;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function uint(n:bigint,label:string,positive=false):bigint {if(n<0n||n>MAX||(positive&&n===0n))throw new ActionError('INVALID_ARGUMENT',`${label} must be ${positive?'positive ':''}uint256`);return n;}
function decimal(s:string,decimals:number,label:string,positive=false):bigint {
 if(typeof s!=='string'||s.length>120||!/^\d+(\.\d+)?$/.test(s))throw new ActionError('INVALID_ARGUMENT',`${label} must be a human decimal string`);
 const [whole,fraction='']=s.split('.');if(fraction.length>decimals)throw new ActionError('INVALID_ARGUMENT',`${label} exceeds chain token precision`);
 return uint(BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0'),label,positive);
}
function validate(input:StrategyPreviewIntent) {
 const allowed=new Set(['strategy','asset','size','maturity','bufferPct','account','maxInput','slippageBps','maxPriceImpactBps','policyId','collateralKind','evidence','ttlSeconds']);
 for(const k of Object.keys(input))if(!allowed.has(k))throw new ActionError('INVALID_ARGUMENT',`Unused strategy field: ${k}`);
 if(!['lendAsset','lendQuote','short','leveredLong'].includes(input.strategy))throw new ActionError('UNSUPPORTED_ACTION','Only the four first-release strategies are executable');
 if(!isAddress(input.account)||typeof input.asset!=='string'||!input.asset.length||input.asset.length>100||typeof input.maturity!=='string'||!/^\d{1,78}$/.test(input.maturity)||!Number.isFinite(input.bufferPct)||input.bufferPct<0||input.bufferPct>1000)throw new ActionError('INVALID_ARGUMENT','Invalid account, asset, maturity or buffer');
 uint(BigInt(input.maturity),'maturity',true);
 const swap=['short','leveredLong'].includes(input.strategy);
 for(const [name,value] of [['slippageBps',input.slippageBps],...(swap?[['maxPriceImpactBps',input.maxPriceImpactBps]]:[])] as const)if(!Number.isInteger(value)||Number(value)<0||Number(value)>1000)throw new ActionError('INVALID_ARGUMENT',`${name} must be an integer in 0–1000`);
 if(!swap&&input.maxPriceImpactBps!==undefined)throw new ActionError('INVALID_ARGUMENT','maxPriceImpactBps is unused for a lending strategy');
 if(input.ttlSeconds!==undefined&&(!Number.isInteger(input.ttlSeconds)||input.ttlSeconds<1||input.ttlSeconds>60))throw new ActionError('INVALID_ARGUMENT','TTL must be 1–60 seconds');
}

/** Resolve a bounded high-level intent, then use the existing evaluator/store and unsigned preparation path. */
export class StrategyFlowService {
 constructor(readonly actions:ActionService,readonly options:StrategyFlowOptions={}) {}
 async preview(callerInput:StrategyPreviewIntent,signal?:AbortSignal) {
  const input=structuredClone(callerInput);
  validate(input);const requested=structuredClone(input),context=this.actions.context,profile=context.profile;
  this.actions.policy(input.policyId);context.requireExecutable();
  const ctx=await context.pin(getAddress(input.account),signal),strategy=getStrategy(input.strategy);
  const tokens=Object.entries(profile.tokens??{});
  const token=tokens.find(([symbol,t])=>symbol.toLowerCase()===input.asset.toLowerCase()||same(t.address,input.asset));
  if(!token)throw new ActionError('INVALID_ARGUMENT','Asset must be a trusted profile token');
  const symbols=new Map(tokens.map(([s,t])=>[t.address.toLowerCase(),s]));
  const discovered=await context.markets(signal);if(discovered.length>1000)throw new ActionError('DISCOVERY_LIMIT','Market index exceeds bounded discovery limit');
  const decimals=new Map<string,Promise<number>>();const dec=(address:Address)=>{const key=address.toLowerCase();let value=decimals.get(key);if(!value){value=tokenDecimals(context,ctx,address);decimals.set(key,value);}return value;};
  const rows:PoolRow[]=[];
  for(const market of discovered){
   const p=market.params,loanSymbol=symbols.get(p.loanToken.toLowerCase()),collateralSymbol=symbols.get(p.collateralToken.toLowerCase());
   if(!loanSymbol||!collateralSymbol||p.maturity!==BigInt(input.maturity)||p.maturity<=ctx.timestamp||classifyLine(loanSymbol,collateralSymbol)!==strategy.line||!same(strategy.line==='credit'?p.collateralToken:p.loanToken,token[1].address))continue;
   uint(p.strike,'strike',true);rows.push({market,loanSymbol,collateralSymbol,loanDecimals:await dec(p.loanToken),collateralDecimals:await dec(p.collateralToken)});
  }
  if(!rows.length)throw new ActionError('MARKET_NOT_FOUND','No live canonical market for the requested asset and maturity');
  // A spot reference is pair-specific. Do not apply a quote for one numeraire to another.
  const pairs=new Set(rows.map(r=>`${r.loanSymbol}:${r.collateralSymbol}`));if(pairs.size!==1)throw new ActionError('MARKET_SELECTION_REQUIRED','Multiple quote-token pairs require an explicit supported market family');
  const probe=rows[0],spot=await (this.options.spot??spotPxFor)(profile.relayerUrl,strategy.line,probe.loanSymbol,probe.collateralSymbol,ctx);
  signal?.throwIfAborted();if(spot.status!=='ready'||spot.px<=0n)throw new ActionError('STALE_SPOT','Fresh positive spot is required');
  const sizeDecimals=input.strategy==='leveredLong'?probe.collateralDecimals:probe.loanDecimals;
  const size=decimal(input.size,sizeDecimals,'size',true);
  const resolution=resolveStrategy({strategyId:input.strategy,asset:token[1].address,size,maturity:BigInt(input.maturity),bufferPct:input.bufferPct},rows,spot.px);
  if(resolution.alternatives.length)throw new ActionError('MARKET_SELECTION_REQUIRED','No rung matches the requested buffer; re-quote with a supported buffer');
  const market=resolution.row.market,p=market.params,lending=strategy.side==='lend';
  const units=uint(input.strategy==='leveredLong'?debtForCollateral(size,p.strike):size,'face',true);
  const maxInput=decimal(input.maxInput,lending?resolution.row.loanDecimals:resolution.row.collateralDecimals,'maxInput');
  let router:Address|undefined,lenderMustRoute=false;
  if(!same(p.gate,ZERO_ADDRESS)){
   const [routers,must]=await Promise.all([context.read<Address[]>(ctx,p.gate,gateAbi,'routers'),context.read<boolean>(ctx,p.gate,gateAbi,'LENDER_MUST_ROUTE')]);
   if(!Array.isArray(routers)||routers.length>100||routers.some(r=>!isAddress(r)||same(r,ZERO_ADDRESS))||typeof must!=='boolean')throw new ActionError('UPSTREAM_UNAVAILABLE','Invalid gate routing');
   lenderMustRoute=must;if(!lending||must)router=routers.find(r=>same(r,profile.strategyRouter??ZERO_ADDRESS))??routers[0];
  }else if(!lending)router=profile.strategyRouter;
  if((!lending||lenderMustRoute)&&!router)throw new ActionError('UNSUPPORTED_ACTION','No approved strategy router');
  let feeBps=0n;
  if(router){const core=await context.read<Address>(ctx,router,routerAbi,'BIVIUM');if(!isAddress(core)||!same(core,profile.core))throw new ActionError('DOMAIN_MISMATCH','Router points to another Core');feeBps=await context.read<bigint>(ctx,router,routerAbi,lending?'LENDER_FEE_BPS':'FEE_BPS');if(typeof feeBps!=='bigint'||feeBps<0n||feeBps>10000n)throw new ActionError('UPSTREAM_UNAVAILABLE','Invalid router fee');}
  const entries=await this.book(p,ctx);
  const backing=new Map<string,MakerBacking>();
  for(const e of entries){e.consumed=await context.core<bigint>(ctx,'consumed',[e.offer.maker,e.offer.group]);}
  try{validateGroups(entries);}catch(e){throw new ActionError('INVALID_BOOK',String(e));}
  let selected:BookEntry|undefined,cost=0n;
  for(const e of sortSide(entries,lending?'ask':'bid')){
   if(!offerActiveAt(e.offer,ctx.timestamp)||same(e.offer.maker,input.account))continue;
   const key=makerBackingKey(e);let funds=backing.get(key);
   if(!funds){funds={liquidity:lending?0n:await context.core<bigint>(ctx,'liquidityOf',[market.id,e.offer.maker]),credit:lending?await context.core<bigint>(ctx,'creditOf',[market.id,e.offer.maker]):0n,escrow:lending?await context.core<bigint>(ctx,'collateralEscrowOf',[market.id,e.offer.maker]):0n};backing.set(key,funds);}
   const plan=planSweepByFace([e],units,backing);
   if(plan.filled!==units)continue;
   // Definitive revocation is an unavailable order, not a reason to hide later executable liquidity.
   // Transport failures still propagate through context.read and never become an empty-book result.
   const registered=await context.core<boolean>(ctx,'isRatifier',[e.offer.maker,e.offer.ratifier]);
   if(typeof registered!=='boolean')throw new ActionError('UPSTREAM_UNAVAILABLE','Invalid ratifier registration response');
   if(!registered)continue;
   const ratifierArgs=[...context.adapter.ratifierArgs(e.offer.maker,units,e.commitment,e.signature)];
   if(profile.abiProfile==='core-v2')ratifierArgs[1]=lending&&router?router:input.account;
   const ratified=await context.read<string>(ctx,e.offer.ratifier,context.adapter.ratifierAbi,'isRatified',ratifierArgs);
   if(typeof ratified!=='string'||!/^0x[0-9a-fA-F]{8}$/.test(ratified))throw new ActionError('UPSTREAM_UNAVAILABLE','Invalid ratifier response');
   if(ratified!==RATIFIED)continue;
   selected=e;cost=uint(fillCost(e.offer,units,e.price),'cost',true);break;
  }
  if(!selected)throw new ActionError('INSUFFICIENT_LIQUIDITY','No single live order can fill the complete requested size; reduce size or use the separate order workflow');
  const fee=uint(lending?(units>cost?(units-cost)*feeBps/10000n:0n):originationFee(units,cost,feeBps),'fee');
  const principal=lending?0n:uint(cost-fee,'principal',true),paid=uint(cost+fee,'loanPaid'),collateral=uint(collateralForDebt(units,p.strike),'collateral');
  if(lending&&paid>maxInput)throw new ActionError('MAX_INPUT_EXCEEDED','Loan cost including fees exceeds maxInput');
  let swap: (SwapFloor & {poolKey:PoolKey;amountIn:ReturnType<typeof amount>})|undefined,topUp=0n;
  if(!lending){
   if(!ctx.rpc.call||!profile.v4StateView)throw new ActionError('SWAP_UNAVAILABLE','Pinned StateView price and depth/quoter are required');
   const call=async(to:Address,data:`0x${string}`)=>(await context.limited(()=>ctx.rpc.call!({to,data,blockNumber:ctx.blockNumber}),signal)).data??'0x';
   const pools=this.options.pools??[{fee:3000,tickSpacing:60,hooks:ZERO_ADDRESS}];if(!pools.length||pools.length>8)throw new ActionError('SWAP_UNAVAILABLE','Host pool candidate count must be 1–8');
   for(const candidate of pools){
    if(!Number.isInteger(candidate.fee)||candidate.fee<0||candidate.fee>=1000000||!Number.isInteger(candidate.tickSpacing)||candidate.tickSpacing<=0||candidate.tickSpacing>32767||!isAddress(candidate.hooks))throw new ActionError('SWAP_UNAVAILABLE','Invalid host pool');
    const currencies=[p.loanToken,p.collateralToken].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1),key:PoolKey={...candidate,currency0:currencies[0],currency1:currencies[1]};
    const sqrt=await readSqrtPriceX96(call,profile.v4StateView,key);if(!sqrt)continue;
    const floor=await swapFloor({call,key,tokenIn:p.loanToken,amountIn:principal,slippageBps:input.slippageBps,quoter:profile.v4Quoter,stateView:profile.v4StateView});
    if(floor.source!=='quoter'&&floor.source!=='pool-depth')continue;
    const marginal=outAtPoolPrice(key,sqrt,p.loanToken,principal);if(marginal<=0n)continue;
    const loss=marginal>floor.estimate?marginal-floor.estimate:0n;
    if(loss*10000n>marginal*BigInt(input.maxPriceImpactBps!))continue;
    uint(floor.minOut,'swap minimum',true);uint(floor.estimate,'swap estimate',true);
    const impactBps=Number((loss*10000n+marginal-1n)/marginal);
    if(!swap||floor.minOut>swap.minOut)swap={...floor,impactBps,poolKey:key,amountIn:amount(principal,resolution.row.loanDecimals,p.loanToken)};
   }
   if(!swap)throw new ActionError('SWAP_UNAVAILABLE','No validated depth-aware pool within maxPriceImpactBps');
   topUp=collateral>swap.minOut?collateral-swap.minOut:0n;if(topUp>maxInput)throw new ActionError('MAX_INPUT_EXCEEDED','Required collateral top-up exceeds maxInput');
  }
  const intent:ActionIntent={action:router?'strategy_program':'buy_dcn',marketId:market.id,account:getAddress(input.account),receiver:getAddress(input.account),policyId:input.policyId,collateralKind:input.collateralKind,evidence:input.evidence,ttlSeconds:input.ttlSeconds,deadline:String(ctx.timestamp+BigInt(input.ttlSeconds??60)),fills:[{offer:selected.offer,commitment:selected.commitment,ratifierData:selected.signature,units:String(units)}],...(router?{router,strategyId:input.strategy}:{}),...(lending?{maxCost:String(maxInput)}:{minProceeds:String(principal),maxTopUp:String(topUp),poolKey:swap!.poolKey,minOut:String(swap!.minOut)})};
  const source={requested,market,selectedOrder:{commitment:selected.commitment,ratifier:selected.offer.ratifier,maker:selected.offer.maker,units:String(units)},spot,realizedBufferPct:resolution.realizedBufferPct,route:{router:router??null,lenderMustRoute,feeBps:String(feeBps)},economics:{face:amount(units,resolution.row.loanDecimals,p.loanToken),cost:amount(cost,resolution.row.loanDecimals,p.loanToken),fee:amount(fee,resolution.row.loanDecimals,p.loanToken),...(lending?{loanPaid:amount(paid,resolution.row.loanDecimals,p.loanToken)}:{principal:amount(principal,resolution.row.loanDecimals,p.loanToken),collateral:amount(collateral,resolution.row.collateralDecimals,p.collateralToken),topUp:amount(topUp,resolution.row.collateralDecimals,p.collateralToken)}),maxInput:amount(maxInput,lending?resolution.row.loanDecimals:resolution.row.collateralDecimals,lending?p.loanToken:p.collateralToken)},swap:swap?{...swap,minOut:amount(swap.minOut,resolution.row.collateralDecimals,p.collateralToken),estimate:amount(swap.estimate,resolution.row.collateralDecimals,p.collateralToken)}:null,indicativePayoff:{feeAdjusted:false,executionGuarantee:false,description:'Indicative spot-based payoff; excludes router fees and actual swap execution effects.',quote:quoteStrategy({resolution,priceWad:selected.price,spot:spot.px,now:ctx.timestamp,sigmaAnnual:spot.sigmaAnnual,marketId:market.id},size)}};
  return this.actions.preview(intent,signal,{ctx,source});
 }
 private async book(params:MarketParams,ctx:ReadContext):Promise<BookEntry[]> {
  const context=this.actions.context,profile=context.profile;let entries:BookEntry[];
  if(context.options.book){const book=await context.options.book(params,ctx.signal);if(book.coverage&&book.coverage!=='complete')throw new ActionError('UPSTREAM_UNAVAILABLE','Complete order book required');entries=book.entries;}
  else{
   if(!profile.relayerUrl)throw new ActionError('UPSTREAM_UNAVAILABLE','No relayer configured');
   const ratifiers=[...new Set([profile.signatureRatifier,profile.setterRatifier].filter((x):x is Address=>!!x))];entries=[];
   for(const ratifier of ratifiers){const book=await fetchRelayerBook({...profile,ratifier,relayerUrl:profile.relayerUrl},params,{signal:ctx.signal,nowSec:ctx.timestamp});if(!book.ok)throw new ActionError('UPSTREAM_UNAVAILABLE',book.reason,true);entries.push(...book.entries);}
  }
  if(entries.length>1000)throw new ActionError('DISCOVERY_LIMIT','Order book exceeds bounded limit');
  const seen=new Set<string>(),canonical:BookEntry[]=[];
  for(const entry of entries){const o=entry.offer;
   if(!same(context.adapter.computeMarketId(profile,o),context.adapter.computeMarketId(profile,params))||!same(context.adapter.offerCommitment(profile,o),entry.commitment)||![profile.signatureRatifier,profile.setterRatifier].some(r=>r&&same(r,o.ratifier)))throw new ActionError('DOMAIN_MISMATCH','Order identity differs from canonical market or ratifier');
   const embedded=o as typeof o&{chainId?:bigint;bivium?:Address};if((embedded.chainId!==undefined&&BigInt(embedded.chainId)!==BigInt(profile.chainId))||(embedded.bivium!==undefined&&!same(embedded.bivium,profile.core)))throw new ActionError('DOMAIN_MISMATCH','Foreign embedded offer domain');
   if((o.maxUnits===0n)===(o.maxAssets===0n)||o.tick<0n||o.tick>MAX_TICK||o.tick%TICK_SPACING!==0n||o.start>o.expiry||o.expiry>o.maturity-3600n)throw new ActionError('INVALID_BOOK','Invalid offer limits or lifetime');
   for(const value of [o.maxUnits,o.maxAssets,o.start,o.expiry])uint(value,'offer field');
   if(!seen.has(entry.commitment.toLowerCase())){seen.add(entry.commitment.toLowerCase());canonical.push(entryFromSignedOffer(o,entry.commitment,entry.signature));}
  }
  return canonical;
 }
}
