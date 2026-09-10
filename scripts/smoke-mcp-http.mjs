import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const endpoint=arg('--url'),tokenFile=arg('--token-file');
if(!endpoint||!tokenFile)throw Error('Usage: --url https://host/mcp --token-file /absolute/private/token [--live] [--out report.json]');
const token=(await readFile(tokenFile,'utf8')).trim(),url=new URL(endpoint);
assert.equal(url.pathname,'/mcp');assert.ok(token.length>=32);
const report={at:new Date().toISOString(),url:endpoint,checks:[]};
const health=await fetch(new URL('/health',url));assert.equal(health.status,200);report.checks.push('health');
assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);report.checks.push('unauthenticated request rejected');
assert.equal((await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,Origin:'https://untrusted.invalid'},body:'{}'})).status,403);report.checks.push('foreign Origin rejected');
const client=new Client({name:'bivium-http-acceptance',version:'1'});
const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
try{
 await client.connect(transport);report.checks.push('official SDK initialize');
 const tools=await client.listTools();assert.equal(tools.tools.length,21);report.tools=tools.tools.map(t=>t.name);report.checks.push('21 tools');
 const info=await client.callTool({name:'server_info',arguments:{}});assert.ok(!info.isError);report.server=info.structuredContent.data;
 assert.equal(report.server.chainId,46630);assert.equal(report.server.chainSigning,false);assert.equal(report.server.chainBroadcasting,false);assert.equal(report.server.relayerWrites,false);report.checks.push('deployment identity and execution boundaries');
 const bad=await client.callTool({name:'strategy_preview',arguments:{strategy:'unsupported'}});assert.equal(bad.isError,true);assert.equal(bad.structuredContent.code,'INVALID_ARGUMENT');report.checks.push('standalone schema validation');
 if(process.argv.includes('--live')){
  const markets=await client.callTool({name:'market_list',arguments:{}});assert.ok(!markets.isError,JSON.stringify(markets.structuredContent));report.marketCount=markets.structuredContent.count;assert.ok(report.marketCount>0);report.checks.push('live relayer market discovery');
  const marketId=markets.structuredContent.markets[0].marketId??markets.structuredContent.markets[0].id;assert.ok(marketId);
  const risk=await client.callTool({name:'risk_assess',arguments:{marketId,collateralKind:'other',policyId:'conservative',evidence:{}}});assert.ok(!risk.isError);assert.equal(risk.structuredContent.data.report.decision,'require_user_confirmation');report.checks.push('conservative risk policy refuses unknown evidence');
 }
 const sessionId=transport.sessionId;await transport.terminateSession();
 const deleted=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/json, text/event-stream','Content-Type':'application/json','Mcp-Session-Id':sessionId,'MCP-Protocol-Version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:100,method:'ping'})});assert.equal(deleted.status,404);report.checks.push('session deletion and stale-id refusal');
}finally{await client.close();}
if(arg('--out'))await writeFile(arg('--out'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
