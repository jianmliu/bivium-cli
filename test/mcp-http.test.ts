import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHttpMcp} from '../src/mcp/http.ts';
const token='test-only-'.repeat(8), origin='http://localhost:8787';
function setup(extra:Record<string,unknown>={}){
 let created=0;
 const app=createHttpMcp({token,allowedHosts:['localhost'],createMcp:()=>{const n=++created;return{handle:async(message:any)=>({jsonrpc:'2.0' as const,id:message.id,result:message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{session:n}})};},...extra});
 const request=(body:unknown,session?:string,headers:Record<string,string>={},method='POST')=>app.fetch(new Request(origin+'/mcp',{method,headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json',...(session?{'mcp-session-id':session,'mcp-protocol-version':'2025-06-18'}:{}),...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}));
 const initialize=async()=>{const r=await request({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}});assert.equal(r.status,200);const session=r.headers.get('mcp-session-id')!;assert.ok(session);assert.equal((await request({jsonrpc:'2.0',method:'notifications/initialized'},session)).status,202);return session;};
 return{app,request,initialize};
}
test('HTTP requires token, validates origin/host and fails closed on missing configuration',async()=>{
 assert.throws(()=>setup({token:''}),/token/i);
 const f=setup();const init={jsonrpc:'2.0',id:1,method:'initialize'};
 assert.equal((await f.request(init,undefined,{authorization:'Bearer wrong'})).status,401);
 assert.equal((await f.request(init,undefined,{origin:'https://evil.example'})).status,403);
 assert.equal((await f.app.fetch(new Request('http://evil.example/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`},body:'{}'}))).status,403);
 assert.equal((await f.app.fetch(new Request(origin+'/health'))).status,200);
});
test('HTTP lifecycle negotiates version, isolates sessions and terminates stale IDs',async()=>{
 const f=setup(),a=await f.initialize(),b=await f.initialize();assert.notEqual(a,b);
 const call={jsonrpc:'2.0',id:2,method:'tools/list'};
 assert.notDeepEqual((await (await f.request(call,a)).json()).result,(await (await f.request(call,b)).json()).result);
 assert.equal((await f.request(call)).status,400);
 assert.equal((await f.request(call,a,{'mcp-protocol-version':'invalid'})).status,400);
 assert.equal((await f.request(undefined,a,{},'GET')).status,405);
 assert.equal((await f.request(undefined,a,{},'DELETE')).status,204);
 assert.equal((await f.request(call,a)).status,404);
 assert.equal((await f.request(call,b)).status,200);
});
test('HTTP rejects unsupported media, malformed JSON, batches, oversized bodies and uninitialized calls',async()=>{
 const f=setup(),id=await f.initialize(),call={jsonrpc:'2.0',id:2,method:'tools/list'};
 assert.equal((await f.request(call,id,{'content-type':'text/plain'})).status,415);
 assert.equal((await f.request(call,id,{accept:'application/json'})).status,406);
 assert.equal((await f.request('{',id)).status,400);
 assert.equal((await f.request([call],id)).status,400);
 assert.equal((await f.request('x'.repeat(1024*1024+1),id)).status,413);
 assert.equal((await f.request({jsonrpc:'2.0',id:null,method:'ping'},id)).status,400);
 const r=await f.request({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
 assert.equal((await f.request(call,r.headers.get('mcp-session-id')!)).status,400);
});
test('HTTP session limits and idle expiry do not reuse preview state',async()=>{
 let now=0;const f=setup({now:()=>now,maxSessions:1,idleMs:100});const id=await f.initialize();
 const init={jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'2025-06-18'}};
 assert.equal((await f.request(init)).status,429);
 now=101;assert.equal((await f.request({jsonrpc:'2.0',id:2,method:'ping'},id)).status,404);
 assert.equal((await f.request(init)).status,200);
});
test('HTTP cancellation aborts only the matching session request and releases concurrency',async()=>{
 let started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const f=setup({maxInFlight:1,createMcp:()=>({handle:async(m:any,ctx:any)=>{
  if(m.method==='tools/call'){started();await new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));}
  return {jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18'}};
 }})});
 const session=await f.initialize();const pending=f.request({jsonrpc:'2.0',id:10,method:'tools/call'},session);await ready;
 assert.equal((await f.request({jsonrpc:'2.0',id:11,method:'tools/call'},session)).status,429);
 assert.equal((await f.request({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:10}},session)).status,202);
 await pending;assert.equal((await f.request({jsonrpc:'2.0',id:12,method:'ping'},session)).status,200);
});

test('official MCP HTTP client discovers existing tools and executes a read without RPC',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const {listenHttp}=await import('../src/mcp/http-node.ts');
 const {createStrategyMcp}=await import('../src/mcp/server.ts');
 const {strategyFixture}=await import('./fixtures/strategyFlow.ts');
 const f=strategyFixture();
 const listener=await listenHttp({token,port:0,createMcp:()=>createStrategyMcp({profile:f.profile})});
 const client=new Client({name:'bivium-http-test',version:'1'});
 const transport=new StreamableHTTPClientTransport(new URL(listener.url),{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
 try{await client.connect(transport);assert.equal((await client.listTools()).tools.length,21);const info=await client.callTool({name:'server_info',arguments:{}});assert.equal((info.structuredContent as any).data.chainId,46630);await transport.terminateSession();}
 finally{await client.close();await listener.close();}
});
test('real strategy preview cannot be prepared by another HTTP session',async()=>{
 const {createStrategyMcp}=await import('../src/mcp/server.ts');const {strategyFixture}=await import('./fixtures/strategyFlow.ts');
 const f=setup({createMcp:()=>{const fixture=strategyFixture();return createStrategyMcp({profile:fixture.profile,actionService:fixture.actions,actionContext:fixture.context,strategyFlowOptions:fixture.options});}});
 const input=strategyFixture().input,a=await f.initialize(),b=await f.initialize();
 const preview:any=await(await f.request({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'strategy_preview',arguments:input}},a)).json();
 const previewId=preview.result.structuredContent.data.previewId;assert.ok(previewId);
 const prepare={jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'action_prepare',arguments:{previewId}}};
 const denied:any=await(await f.request(prepare,b)).json();assert.equal(denied.result.isError,true);
 const own:any=await(await f.request(prepare,a)).json();assert.equal(own.result.structuredContent.data.kind,'ready');
});

test('a session deleted while a POST body arrives cannot execute another tool',async()=>{
 const f=setup(),id=await f.initialize();let stream!:ReadableStreamDefaultController<Uint8Array>;
 const pending=f.app.fetch(new Request(origin+'/mcp',{method:'POST',headers:{authorization:`Bearer ${token}`,accept:'application/json, text/event-stream','content-type':'application/json','mcp-session-id':id},body:new ReadableStream({start(c){stream=c;}}),duplex:'half'} as RequestInit));
 await Promise.resolve();assert.equal((await f.request(undefined,id,{},'DELETE')).status,204);
 stream.enqueue(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/list'})));stream.close();
 assert.equal((await pending).status,404);
});
test('explicit browser origins and rate limits remain bounded',async()=>{
 const f=setup({allowedOrigins:['https://agent.example'],requestsPerMinute:2});
 const preflight=await f.request(undefined,undefined,{origin:'https://agent.example'},'OPTIONS');assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://agent.example');
 const id=await f.initialize();
 assert.equal((await f.request({jsonrpc:'2.0',id:2,method:'ping'},id)).status,200);
 assert.equal((await f.request({jsonrpc:'2.0',id:3,method:'ping'},id)).status,429);
});

 test('Node IPv6 loopback accepts its advertised endpoint',async()=>{
  const {listenHttp}=await import('../src/mcp/http-node.ts');
  const listener=await listenHttp({host:'::1',port:0,token,createMcp:()=>({handle:async(m:any)=>({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18'}})})});
  try{
   const response=await fetch(listener.url,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})});
   assert.equal(response.status,200);assert.ok(response.headers.get('mcp-session-id'));
  }finally{await listener.close();}
 });
