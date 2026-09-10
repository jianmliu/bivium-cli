import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {createHttpMcp,type HttpMcpOptions} from './http.ts';

/** Node bridge; authentication and framing are shared with the Cloudflare adapter. */
export async function listenHttp(options:HttpMcpOptions&{host?:string;port?:number}){
 const host=options.host??'127.0.0.1',port=options.port??8787;
 if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid HTTP port');
 const app=createHttpMcp({...options,allowedHosts:options.allowedHosts??[host.includes(':')?`[${host}]`:host,'localhost']});
 const server=createServer(async(req,res)=>{
  try{
   const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(', '):value);
   const authority=req.headers.host;if(!authority){res.writeHead(400).end();return;}
   const url=new URL(req.url??'/',`http://${authority}`);
   if(url.host!==authority){res.writeHead(400).end();return;}
   const request=new Request(url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method??'GET')?{}:{body:Readable.toWeb(req) as unknown as BodyInit,duplex:'half'})} as RequestInit);
   const response=await app.fetch(request);
   res.writeHead(response.status,Object.fromEntries(response.headers));
   res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent)res.writeHead(400);res.end();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw new Error('No HTTP listener');
 return{server,url:`http://${host.includes(':')?`[${host}]`:host}:${address.port}/mcp`,close:async()=>{app.close();await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});}};
}
