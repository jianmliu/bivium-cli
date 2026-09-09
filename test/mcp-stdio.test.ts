import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PassThrough} from 'node:stream';
import {serveStdio} from '../src/mcp/server.ts';
import type {DeploymentProfile} from '../src/sdk/types.ts';
const profile = {name:'test',abiProfile:'core-v1',chainId:1,core:`0x${'1'.repeat(40)}`,signatureRatifier:`0x${'1'.repeat(40)}`,rpcUrl:'http://localhost:1',tokens:{}} as DeploymentProfile;
const ping = (id:number) => JSON.stringify({jsonrpc:'2.0',id,method:'ping'})+'\n';
const flush = () => new Promise(resolve => setTimeout(resolve,10));
test('stdio rejects oversized split chunks before newline, then recovers',async () => {
 const input=new PassThrough(), output=new PassThrough(), diagnostics=new PassThrough();
 let text='';output.on('data',chunk=>text+=chunk);
 const serving=serveStdio({profile},{input,output,diagnostics});
 input.write(' '.repeat(600_000)); input.write(' '.repeat(600_000));
 await flush();
 assert.equal(JSON.parse(text.trim()).error.code,-32600);
 input.write('\n'+ping(2).slice(0,8)); input.end(ping(2).slice(8));
 await serving;
 const responses=text.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(responses.length,2);assert.deepEqual(responses[1],{jsonrpc:'2.0',id:2,result:{}});
});
test('stdio timeout returns structured failure and accepts following requests',async () => {
 const input=new PassThrough(),output=new PassThrough(),diagnostics=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);
 const serving=serveStdio({profile,requestTimeoutMs:10,overrides:{positions:()=>new Promise(()=>{})}},{input,output,diagnostics});
 input.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'strategy_positions',arguments:{taker:`0x${'1'.repeat(40)}`}}})+'\n'+ping(2));
 await serving;
 const responses=text.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(responses[0].result.isError,true);assert.equal(responses[0].result.structuredContent.code,'TIMEOUT');assert.equal(responses[1].id,2);
});
test('stdio malformed JSON and split UTF-8 recover and final unterminated request works',async()=>{
 const input=new PassThrough(),output=new PassThrough(),diagnostics=new PassThrough();let text='';output.on('data',chunk=>text+=chunk);
 const serving=serveStdio({profile},{input,output,diagnostics});
 input.write('invalid\n');const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:3,method:'ping',params:{text:'é'}}));const index=bytes.indexOf(0xc3);input.write(bytes.subarray(0,index+1));input.end(bytes.subarray(index+1));await serving;
 const responses=text.trim().split('\n').map(line=>JSON.parse(line));assert.equal(responses[0].error.code,-32700);assert.equal(responses[1].id,3);
});

test('stdio stops dispatching while stdout applies backpressure',async()=>{
 const input=new PassThrough(), output=new PassThrough({highWaterMark:1}),diagnostics=new PassThrough();
 let handled=0;
 const serving=serveStdio({profile,tools:[{name:'count',description:'test',inputSchema:{type:'object'},handler:()=>({count:++handled})}]},{input,output,diagnostics});
 const request=(id:number)=>JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'count',arguments:{}}})+'\n';
 input.end(request(1)+request(2));
 await flush();
 assert.equal(handled,1,'dispatch must pause until the output consumer drains');
 let text=''; output.on('data',chunk=>text+=chunk);
 await serving;
 assert.equal(handled,2);assert.equal(text.trim().split('\n').length,2);
});
