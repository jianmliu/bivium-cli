import { isAddress, parseAbi } from 'viem';
import { ZERO_ADDRESS, type Address, type MarketParams } from '../types.ts';
import { type ActionContext, type ReadContext, upstream } from './context.ts';
import { ActionError } from './types.ts';

const abi = parseAbi([
 'function BIVIUM() view returns (address)', 'function routers() view returns (address[])',
 'function LENDER_MUST_ROUTE() view returns (bool)', 'function FEE_BPS() view returns (uint256)',
 'function LENDER_FEE_BPS() view returns (uint256)', 'function MAX_LEGS() view returns (uint256)',
 'function quoteFee(uint256 units,uint256 cost) view returns (uint256 fee,uint256 net)',
 'function quoteLeg(uint256 units,uint256 cost) view returns (uint256 fee,uint256 net)',
 'function quoteLenderFee(uint256 units,uint256 cost) view returns (uint256 fee,uint256 total)',
 'function POOL_MANAGER() view returns (address)', 'function poolManager() view returns (address)',
]);
const MAX=(1n<<256n)-1n;
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
const address=(v:unknown):v is Address=>typeof v==='string'&&isAddress(v)&&!same(v,ZERO_ADDRESS);
const uint=(v:unknown):v is bigint=>typeof v==='bigint'&&v>=0n&&v<=MAX;
export type RouteSide='borrow'|'buy';
export interface RouteAdmission {
 router?: Address;
 routers: Address[];
 lenderMustRoute: boolean;
 feeBps: bigint | null;
 lenderFeeBps: bigint | null;
 maxLegs: bigint;
 /** Getter/code observations, not an implementation audit or proof of router behavior. */
 evidence: Record<string,unknown>;
}
class IncompatibleRoute extends ActionError {
 constructor(message:string){super('UNSUPPORTED_ACTION',message);}
}
async function observe<T>(context:ActionContext,ctx:ReadContext,evidence:Record<string,unknown>,target:Address,name:string,args:readonly unknown[]=[]):Promise<T>{
 const value=await context.read<T>(ctx,target,abi,name,args);
 evidence[`${target.toLowerCase()}:${name}:${args.map(String).join(':')}`]=value;
 return value;
}
async function code(context:ActionContext,ctx:ReadContext,evidence:Record<string,unknown>,target:Address){
 if(!ctx.rpc.getBytecode)throw new ActionError('UPSTREAM_UNAVAILABLE','Pinned bytecode lookup unavailable',true);
 let value;
 try{value=await context.limited(()=>ctx.rpc.getBytecode!({address:target,blockNumber:ctx.blockNumber}),ctx.signal);}catch(e){throw upstream(e);}
 evidence[`${target.toLowerCase()}:code`]=value??'0x';
 if(typeof value!=='string'||!/^0x(?:[0-9a-fA-F]{2})+$/.test(value))throw new IncompatibleRoute(`No valid deployed code at ${target}`);
}

/** Resolve only within a pinned, Core-bound gate (or the host's ungated router trust boundary). */
export async function resolveRouteAdmission(context:ActionContext,ctx:ReadContext,params:MarketParams,options:{side:RouteSide;router?:Address;requireRouter?:boolean;checkBothFees?:boolean}):Promise<RouteAdmission>{
 const evidence:Record<string,unknown>={};
 const route:RouteAdmission={routers:[],lenderMustRoute:false,feeBps:null,lenderFeeBps:0n,maxLegs:0n,evidence};
 const gated=!same(params.gate,ZERO_ADDRESS);
 if(gated){
  await code(context,ctx,evidence,params.gate);
  const core=await observe(context,ctx,evidence,params.gate,'BIVIUM');
  if(!address(core)||!same(core,ctx.core))throw new IncompatibleRoute('Gate BIVIUM differs from configured Core');
  const routers=await observe<unknown>(context,ctx,evidence,params.gate,'routers');
  const must=await observe<unknown>(context,ctx,evidence,params.gate,'LENDER_MUST_ROUTE');
  if(!Array.isArray(routers)||routers.length>100||routers.some(r=>!address(r))||typeof must!=='boolean')throw new IncompatibleRoute('Invalid bounded gate routing capability');
  route.routers=[...new Map(routers.map(r=>[(r as Address).toLowerCase(),r as Address])).values()];route.lenderMustRoute=must;
 }
 const required=options.side==='borrow'||route.lenderMustRoute||options.requireRouter;
 if(!required&&!options.router)return route;
 const preferred=context.profile.strategyRouter;
 if(options.router){
  if(!address(options.router))throw new IncompatibleRoute('Invalid explicit router');
  if(gated&&!route.routers.some(r=>same(r,options.router!)))throw new IncompatibleRoute('Explicit router is not admitted by market gate');
  if(!gated&&(!preferred||!same(options.router,preferred)))throw new IncompatibleRoute('Ungated router must match the trusted host-configured strategyRouter');
 }
 async function check(target:Address):Promise<RouteAdmission>{
  await code(context,ctx,evidence,target);
  const core=await observe(context,ctx,evidence,target,'BIVIUM');
  if(!address(core)||!same(core,ctx.core))throw new IncompatibleRoute('Router BIVIUM differs from configured Core');
  const feeBps=options.side==='borrow'||options.checkBothFees?await observe(context,ctx,evidence,target,'FEE_BPS'):null;
  const lenderFeeBps=options.side==='buy'||options.checkBothFees?await observe(context,ctx,evidence,target,'LENDER_FEE_BPS'):null;
  const maxLegs=await observe(context,ctx,evidence,target,'MAX_LEGS');
  if((feeBps!==null&&(!uint(feeBps)||feeBps>2000n))||(lenderFeeBps!==null&&(!uint(lenderFeeBps)||lenderFeeBps>2000n))||!uint(maxLegs)||maxLegs===0n||maxLegs>1024n)throw new IncompatibleRoute('Invalid router fee (0–2000 BPS) or bounded MAX_LEGS capability');
  if((options.side==='borrow'&&feeBps===null)||(options.side==='buy'&&lenderFeeBps===null))throw new IncompatibleRoute('Missing required fee capability');
  return {...route,router:target,feeBps,lenderFeeBps,maxLegs};
 }
 if(options.router)return check(options.router);
 if(!gated){if(!preferred||!address(preferred))throw new IncompatibleRoute('No trusted configured router');return check(preferred);}
 const candidates=route.routers;
 const preferredAdmitted=preferred&&candidates.find(r=>same(r,preferred));
 if(preferredAdmitted){try{return await check(preferredAdmitted);}catch(e){if(!(e instanceof IncompatibleRoute))throw e;}}
 const compatible:RouteAdmission[]=[];
 for(const candidate of candidates){
  if(preferredAdmitted&&same(candidate,preferredAdmitted))continue;
  try{compatible.push(await check(candidate));}catch(e){
   // A malformed successful observation proves incompatibility; a failed RPC cannot establish uniqueness.
   if(!(e instanceof IncompatibleRoute))throw e;
  }
 }
 if(compatible.length!==1)throw new IncompatibleRoute(compatible.length?'Multiple compatible admitted routers are ambiguous; specify a router':'No compatible admitted router');
 return compatible[0];
}

/** Quote every fill independently: deployment versions may cap the premium fee differently. */
export async function quoteRouteFill(context:ActionContext,ctx:ReadContext,route:RouteAdmission,side:RouteSide,units:bigint,cost:bigint){
 if(!uint(units)||!uint(cost))throw new ActionError('INVALID_ARGUMENT','Fill amounts must be uint256');
 if(!route.router){
  if(side!=='buy'||route.lenderMustRoute)throw new ActionError('UNSUPPORTED_ACTION','A compatible router is required for this fill');
  return {fee:0n,net:cost,total:cost};
 }
 let tuple:unknown;
 if(side==='buy')tuple=await observe(context,ctx,route.evidence,route.router,'quoteLenderFee',[units,cost]);
 else {
  try{tuple=await observe(context,ctx,route.evidence,route.router,'quoteFee',[units,cost]);}
  catch {tuple=await observe(context,ctx,route.evidence,route.router,'quoteLeg',[units,cost]);}
 }
 if(!Array.isArray(tuple)||tuple.length!==2||!uint(tuple[0])||!uint(tuple[1]))throw new ActionError('UPSTREAM_UNAVAILABLE','Invalid router fee quote tuple');
 const [fee,value]=tuple;
 if(side==='buy'?cost+fee!==value:fee+value!==cost)throw new ActionError('UPSTREAM_UNAVAILABLE','Router fee quote does not reconcile with fill cost');
 return {fee,net:side==='borrow'?value:cost,total:side==='buy'?value:cost};
}

/** Ordinary fills do not imply swap support. Trusted StateView establishes manager linkage, not code identity. */
export async function assertRouteSwapCapability(context:ActionContext,ctx:ReadContext,route:RouteAdmission,options:{useQuoter?:boolean}={}):Promise<void>{
 try{
  if(!route.router||!context.profile.v4StateView)throw new Error('Router and trusted configured StateView required');
  const manager=await observe(context,ctx,route.evidence,route.router,'POOL_MANAGER');
  if(!address(manager))throw new Error('Router POOL_MANAGER is missing or zero');
  await code(context,ctx,route.evidence,manager);
  if(options.useQuoter&&!context.profile.v4Quoter)throw new Error('Configured Quoter required');
  for(const target of [context.profile.v4StateView,...(options.useQuoter&&context.profile.v4Quoter?[context.profile.v4Quoter]:[])]){
   await code(context,ctx,route.evidence,target);
   const linked=await observe(context,ctx,route.evidence,target,'poolManager');
   if(!address(linked)||!same(linked,manager))throw new Error('StateView/Quoter poolManager differs from router POOL_MANAGER');
  }
 }catch(e){throw new ActionError('SWAP_UNAVAILABLE',e instanceof Error?e.message:String(e));}
}
