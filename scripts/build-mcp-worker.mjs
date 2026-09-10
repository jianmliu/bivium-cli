import {Ajv} from 'ajv';
import standalone from 'ajv/dist/standalone/index.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {TOOLS} from '../src/mcp/server.ts';
import {loadProfile} from '../src/sdk/profile.ts';
const out=new URL('../src/mcp/cloudflare/generated/',import.meta.url);await mkdir(out,{recursive:true});
async function writeChanged(url,contents){
 try{if(await readFile(url,'utf8')===contents)return;}catch(error){if(error.code!=='ENOENT')throw error;}
 await writeFile(url,contents);
}
const ajv=new Ajv({allErrors:true,coerceTypes:false,removeAdditional:false,useDefaults:false,strictNumbers:true,code:{source:true,esm:true}});
const names={},keys={};
TOOLS.forEach((tool,i)=>{const name=`mcpSchema${i}`,key=`urn:bivium:mcp:${tool.name}`;ajv.addSchema(tool.inputSchema,key);names[name]=key;keys[JSON.stringify(tool.inputSchema)]=name;});
// Ajv emits a CommonJS runtime helper even with esm:true. Import that helper
// explicitly so the output works in native ESM as well as the Worker bundler.
const code=standalone(ajv,names).replaceAll('require("ajv/dist/runtime/ucs2length")','ucs2Runtime');
if(/\brequire\(/.test(code))throw new Error('Unexpected CommonJS dependency in standalone schemas');
await writeChanged(new URL('validators.js',out),'import ucs2Runtime from "ajv/dist/runtime/ucs2length.js";\n'+code);
await writeChanged(new URL('schema-map.json',out),JSON.stringify(keys));
await writeChanged(new URL('profile.json',out),JSON.stringify(loadProfile(new URL('../profiles/robinhood-testnet.json',import.meta.url).pathname)));
console.log(`Compiled ${TOOLS.length} MCP schemas and normalized testnet profile`);
