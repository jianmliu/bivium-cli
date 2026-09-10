import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import type {JsonRpcResponse} from './server.ts';

export const HTTP_PROTOCOL_VERSION='2025-06-18';
export interface HttpMcpCore {handle(message:unknown,context?:{signal?:AbortSignal}):Promise<JsonRpcResponse|null>}
export interface HttpMcpOptions {
 token:string; createMcp:()=>HttpMcpCore;
 allowedOrigins?:string[]; allowedHosts?:string[];
 now?:()=>number; maxSessions?:number; idleMs?:number; maxInFlight?:number; requestsPerMinute?:number;
}
type Session={core:HttpMcpCore;ready:boolean;lastUsed:number;windowStart:number;requests:number;active:Map<string,AbortController>};
const BODY_LIMIT=1024*1024;
const digest=(value:string)=>createHash('sha256').update(value).digest();
export function authorized(request:Request,token:string):boolean {
 const header=request.headers.get('authorization');
 return token.length>=32&&!!header&&header.length<=512&&timingSafeEqual(digest(header),digest(`Bearer ${token}`));
}
class HttpError extends Error {constructor(readonly status:number,message:string){super(message);}}
async function readJson(request:Request):Promise<unknown>{
 const declared=request.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>BODY_LIMIT))throw new HttpError(413,'Request body exceeds 1 MiB');
 if(!request.body)throw new HttpError(400,'Missing request body');
 const reader=request.body.getReader();let size=0;const chunks:Uint8Array[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>{});reject(new HttpError(408,'Request body timeout'));},10000);});
 try{
  for(;;){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>BODY_LIMIT){void reader.cancel().catch(()=>{});throw new HttpError(413,'Request body exceeds 1 MiB');}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HttpError(400,'Invalid JSON');}
 }finally{clearTimeout(timer);reader.releaseLock();}
}
/** Stateful Streamable HTTP, JSON response mode. Stores are isolated per client session. */
export function createHttpMcp(options:HttpMcpOptions){
 if(typeof options.token!=='string'||options.token.length<32)throw new Error('HTTP requires an authentication token of at least 32 characters');
 const now=options.now??Date.now,maxSessions=options.maxSessions??32,idleMs=options.idleMs??15*60000,maxInFlight=options.maxInFlight??8,rate=options.requestsPerMinute??120;
 for(const n of [maxSessions,idleMs,maxInFlight,rate])if(!Number.isSafeInteger(n)||n<1)throw new Error('HTTP limits must be positive integers');
 const sessions=new Map<string,Session>();let active=0,initStart=now(),initCount=0;
 const drop=(id:string)=>{const s=sessions.get(id);sessions.delete(id);for(const controller of s?.active.values()??[])controller.abort(new Error('Session closed'));};
 function response(status:number,value?:unknown,headers:HeadersInit={}){return new Response(value===undefined?null:JSON.stringify(value),{status,headers:{'cache-control':'no-store',...(value===undefined?{}:{'content-type':'application/json'}),...headers}});}
 const error=(status:number,message:string,headers:HeadersInit={})=>response(status,{jsonrpc:'2.0',id:null,error:{code:-32000,message}},headers);
 async function fetch(request:Request):Promise<Response>{
  const url=new URL(request.url),origin=request.headers.get('origin');
  if(options.allowedHosts&&!options.allowedHosts.includes(url.hostname))return error(403,'Host not allowed');
  if(origin&&origin!==url.origin&&!options.allowedOrigins?.includes(origin))return error(403,'Origin not allowed');
  const cors:Record<string,string>=origin?{'access-control-allow-origin':origin,'access-control-expose-headers':'Mcp-Session-Id, MCP-Protocol-Version','vary':'Origin'}:{};
  const fail=(status:number,message:string,headers:Record<string,string>={})=>error(status,message,{...cors,...headers});
  if(url.pathname==='/health'&&request.method==='GET')return response(200,{status:'ok',transport:'streamable-http'},cors);
  if(url.pathname!=='/mcp')return fail(404,'Not found');
  if(request.method==='OPTIONS')return response(204,undefined,{...cors,'access-control-allow-methods':'POST, GET, DELETE, OPTIONS','access-control-allow-headers':'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version'});
  if(!authorized(request,options.token))return fail(401,'Bearer token required',{'www-authenticate':'Bearer realm="bivium-mcp"'});
  for(const [id,s] of sessions)if(!s.active.size&&now()-s.lastUsed>=idleMs)drop(id);
  const version=request.headers.get('mcp-protocol-version');if(version&&version!==HTTP_PROTOCOL_VERSION)return fail(400,'Unsupported MCP protocol version');
  const sessionId=request.headers.get('mcp-session-id');
  let session=sessionId?sessions.get(sessionId):undefined;
  if(sessionId&&!session)return fail(404,'Session expired; initialize again and create fresh previews');
  if(request.method==='GET')return fail(405,'Standalone SSE is not supported',{allow:'POST, DELETE, OPTIONS'});
  if(request.method==='DELETE'){if(!sessionId)return fail(400,'Mcp-Session-Id required');drop(sessionId);return response(204,undefined,cors);}
  if(request.method!=='POST')return fail(405,'Method not allowed',{allow:'POST, GET, DELETE, OPTIONS'});
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return fail(415,'Content-Type must be application/json');
  const accept=(request.headers.get('accept')??'').toLowerCase().split(',').map(s=>s.split(';')[0].trim());
  if(!accept.includes('application/json')||!accept.includes('text/event-stream'))return fail(406,'Accept must include application/json and text/event-stream');
  let message:any;try{message=await readJson(request);}catch(e){return fail(e instanceof HttpError?e.status:400,e instanceof HttpError?e.message:'Invalid request body');}
  if(!message||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(Object.hasOwn(message,'id')&&!(typeof message.id==='string'||(typeof message.id==='number'&&Number.isSafeInteger(message.id)))))return fail(400,'Invalid JSON-RPC request');
  if(sessionId&&sessions.get(sessionId)!==session)return fail(404,'Session closed while receiving request');
  const notification=!Object.hasOwn(message,'id');
  if(message.method==='initialize'){
   if(sessionId||notification||typeof message.params?.protocolVersion!=='string')return fail(400,'Invalid initialize request');
   if(now()-initStart>=60000){initStart=now();initCount=0;}
   if(sessions.size>=maxSessions||initCount>=60)return fail(429,'Session capacity exceeded',{'retry-after':'60'});
   initCount++;
   const id=randomUUID();
   try{const core=options.createMcp();session={core,ready:false,lastUsed:now(),windowStart:now(),requests:0,active:new Map()};sessions.set(id,session);const result=await core.handle(message);return response(200,result,{...cors,'mcp-session-id':id,'mcp-protocol-version':HTTP_PROTOCOL_VERSION});}
   catch{drop(id);return fail(500,'Session initialization failed');}
  }
  if(!session)return fail(400,'Mcp-Session-Id required');
  if(now()-session.windowStart>=60000){session.windowStart=now();session.requests=0;}
  if(++session.requests>rate)return fail(429,'Session request rate exceeded',{'retry-after':'60'});
  session.lastUsed=now();
  if(notification){
   if(message.method==='notifications/initialized')session.ready=true;
   else if(message.method==='notifications/cancelled')session.active.get(JSON.stringify(message.params?.requestId))?.abort(new Error('Client cancelled request'));
   else if(!message.method.startsWith('notifications/'))return fail(400,'Requests require an id');
   return response(202,undefined,cors);
  }
  if(!session.ready&&message.method!=='ping')return fail(400,'Send notifications/initialized first');
  const key=JSON.stringify(message.id);if(session.active.has(key))return fail(409,'Request id is already in flight');
  if(active>=maxInFlight)return fail(429,'Too many in-flight requests',{'retry-after':'1'});
  const controller=new AbortController();session.active.set(key,controller);active++;
  try{return response(200,await session.core.handle(message,{signal:controller.signal}),cors);}
  catch{return fail(500,controller.signal.aborted?'Request cancelled':'Request failed');}
  finally{active--;session.active.delete(key);session.lastUsed=now();}
 }
 return{fetch,close:()=>{for(const id of sessions.keys())drop(id);}};
}
