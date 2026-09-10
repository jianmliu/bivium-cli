import {createHttpMcp,authorized} from '../http.ts';
import {createStrategyMcp} from '../server.ts';
import {BiviumClient} from '../../sdk/client.ts';
import {DEFAULT_POLICY_SELECTION} from '../../sdk/strategies/risk.ts';
import type {DeploymentProfile} from '../../sdk/types.ts';
// Build-generated artifacts, never compiled with eval inside the Worker.
// @ts-ignore generated before Wrangler bundles this entrypoint
import * as validators from './generated/validators.js';
// @ts-ignore generated JSON module
import schemas from './generated/schema-map.json';
// @ts-ignore generated JSON module
import profileJson from './generated/profile.json';
interface Env {
 BIVIUM_MCP_TOKEN:string;
 ALLOWED_ORIGINS?:string;
 MCP: {idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}};
}
const profile=profileJson as DeploymentProfile;
function compile(schema:Record<string,unknown>){
 const name=(schemas as Record<string,string>)[JSON.stringify(schema)];
 const fn=(validators as Record<string,import('ajv').ValidateFunction>)[name];
 if(!fn)throw new Error('Unknown MCP schema; rebuild Worker validators');return fn;
}
/** One coordinator per deployment: sessions and global request bounds share one execution location.
 * Ephemeral sessions intentionally fail closed with 404 after eviction or deployment. */
export class McpCoordinator {
 private app;
 constructor(_state:unknown,env:Env){
  this.app=createHttpMcp({token:env.BIVIUM_MCP_TOKEN,allowedOrigins:env.ALLOWED_ORIGINS?.split(',').map(s=>s.trim()).filter(Boolean),
   createMcp:()=>createStrategyMcp({profile,client:new BiviumClient(profile),policies:{conservative:DEFAULT_POLICY_SELECTION},schemaCompiler:compile,allowRelayerWrites:false})});
 }
 fetch(request:Request){return this.app.fetch(request);}
}
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname==='/health'&&request.method==='GET')return Response.json({status:'ok',transport:'streamable-http'},{headers:{'cache-control':'no-store'}});
  if(url.pathname!=='/mcp')return new Response('Not found',{status:404});
  if(!env.BIVIUM_MCP_TOKEN||env.BIVIUM_MCP_TOKEN.length<32)return new Response('MCP authentication is not configured',{status:503});
  const origin=request.headers.get('origin');const allowed=env.ALLOWED_ORIGINS?.split(',').map(s=>s.trim())??[];
  if(origin&&origin!==url.origin&&!allowed.includes(origin))return new Response('Origin not allowed',{status:403});
  if(request.method!=='OPTIONS'&&!authorized(request,env.BIVIUM_MCP_TOKEN))return new Response('Bearer token required',{status:401,headers:{'www-authenticate':'Bearer realm="bivium-mcp"','cache-control':'no-store'}});
  return env.MCP.get(env.MCP.idFromName('bivium-mcp-v1')).fetch(request);
 }
};
