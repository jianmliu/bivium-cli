import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('ordinary SIGTERM and SIGINT release journal lock for restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'bivium-shutdown-'));
 try{for(const signal of ['SIGTERM','SIGINT'] as const){
 const child=spawn(process.execPath,['bin/bivium-mcp.mjs','--profile','profiles/robinhood-testnet.json','--journal-dir',dir]);
 let error='';child.stderr.on('data',c=>error+=c);
 const exited=once(child,'exit');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
 try{const output=once(child.stdout,'data');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'})+'\n');await Promise.race([output,exited.then(()=>{throw Error(error);})]);
 assert.ok(existsSync(join(dir,'writer.lock')));child.kill(signal);await exited;assert.equal(existsSync(join(dir,'writer.lock')),false,error);
 }finally{clearTimeout(timer);child.kill();}
 }}finally{rmSync(dir,{recursive:true,force:true});}
});
