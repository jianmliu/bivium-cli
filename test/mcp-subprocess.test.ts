import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {decodeFunctionData} from 'viem';
import {adapterFor} from '../src/sdk/lineage.ts';
import {ZERO_ADDRESS,type DeploymentProfile} from '../src/sdk/types.ts';
test('real stdio subprocess reads, previews and prepares with no wallet or network',async()=>{
 const child=spawn(process.execPath,['--import','tsx','test/fixtures/mcpServer.ts'],{stdio:['pipe','pipe','pipe']});
 let diagnostics='';child.stderr.on('data',c=>diagnostics+=c);const pending=new Map<number,(r:any)=>void>();
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);pending.delete(r.id);});
 let id=0;const request=(method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>reject(Error(`Subprocess timeout: ${diagnostics}`)),10000);pending.set(n,r=>{clearTimeout(timer);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
 const call=async(name:string,args:unknown)=>{const r=await request('tools/call',{name,arguments:args});assert.equal(r.result.isError,undefined,JSON.stringify(r));return r.result.structuredContent;};
 try{
 assert.equal((await request('initialize')).result.protocolVersion,'2025-06-18');
 assert.equal((await request('tools/list')).result.tools.length,20);
 const account=`0x${'03'.repeat(20)}` as const;
 const profile={chainId:46630,abiProfile:'core-v2',core:`0x${'01'.repeat(20)}`} as DeploymentProfile;
 const params={loanToken:account,collateralToken:profile.core,maturity:2000000000n,strike:10n**36n,gate:ZERO_ADDRESS,allowPartialRepay:true};
 const marketId=adapterFor('core-v2').computeMarketId(profile,params);
 const market=await call('market_details',{marketId});assert.equal(market.snapshot.blockNumber,'10');
 const preview=await call('action_preview',{action:'fund',marketId,account,receiver:account,amount:'1',policyId:'test',collateralKind:'other',evidence:{}});
 assert.ok(preview.data.previewId);assert.equal(preview.data.transaction,undefined);
 const prepared=await call('action_prepare',{previewId:preview.data.previewId});assert.equal(prepared.data.kind,'ready');
 const tx=prepared.data.transaction;assert.equal(tx.chainId,46630);assert.equal(tx.from,account);assert.equal(tx.value,'0');
 const decoded=decodeFunctionData({abi:adapterFor('core-v2').coreAbi,data:tx.data});assert.equal(decoded.functionName,'fund');assert.ok((decoded.args as unknown[]).includes(1000000n));
 child.stdin.end();const [code]=await once(child,'exit');assert.equal(code,0,diagnostics);
 }finally{child.kill();lines.close();}
});
