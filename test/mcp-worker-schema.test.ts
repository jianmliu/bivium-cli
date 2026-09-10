import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {TOOLS} from '../src/mcp/server.ts';
import {validator} from '../src/mcp/schema.ts';

test('Worker standalone schemas match strict Node validation without runtime code generation',async()=>{
 execFileSync(process.execPath,['--import','tsx','scripts/build-mcp-worker.mjs'],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
 const location=new URL('../src/mcp/cloudflare/generated/',import.meta.url);
 const map=JSON.parse(readFileSync(new URL('schema-map.json',location),'utf8'));
 const code=readFileSync(new URL('validators.js',location),'utf8');assert.doesNotMatch(code,/new Function\(/);
 const compiled=await import(new URL('validators.js',location).href);
 for(const tool of TOOLS){const standalone=compiled[map[JSON.stringify(tool.inputSchema)]];assert.equal(typeof standalone,'function');
  const original=validator(tool.inputSchema);
  for(const args of [{},{unexpected:true},null,[],{account:'invalid',limit:-1}])assert.equal(standalone(args),original(args),tool.name);
 }
 const profile=JSON.parse(readFileSync(new URL('profile.json',location),'utf8'));assert.equal(profile.chainId,46630);assert.equal(profile.abiProfile,'core-v2');
});
