import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, existsSync, fsyncSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hex, Offer } from '../types.ts';
import type { OrderIntent } from './orders.ts';
import { ActionError } from './types.ts';
export type PublishState='prepared'|'signed'|'publishing'|'published'|'submission_unknown'|'rejected';
export interface OrderRecord {prepareId:string; state:PublishState; chainId:number; core:Hex; intent:OrderIntent; offer:Offer; commitment:Hex; policyHash:Hex; evidenceHash:Hex; ratifierKind:'setter'|'signature'; root?:Hex; proof?:Hex[]; signature?:Hex; signedPayload?:string; reason?:string;}
/** One host process owns this bounded journal. No automatic eviction, including expired offers.
 * A stale lock requires explicit host recovery. Increasing the host-only bound preserves history;
 * manually archiving records requires retaining signed/unknown exposure for reconciliation. */
export class PublishJournal {
 readonly maxRecords:number;
 readonly persistent:boolean; private rows=new Map<string,OrderRecord>(); private lock?:number; private closed=false;
 constructor(readonly directory?:string, options:{maxRecords?:number}={}){
 this.maxRecords=options.maxRecords??1000;
 if(!Number.isSafeInteger(this.maxRecords)||this.maxRecords<1)throw new ActionError('INVALID_ARGUMENT','Journal record bound must be a positive safe integer');
 this.persistent=!!directory;
 if(!directory)return;
 if(!isAbsolute(directory))throw new ActionError('INVALID_ARGUMENT','Journal directory must be a host absolute path');
 mkdirSync(directory,{recursive:true});
 try{this.lock=openSync(join(directory,'writer.lock'),'wx',0o600);}catch{throw new ActionError('JOURNAL_LOCKED','Journal already has a writer; inspect stale locks manually');}
 try {const file=join(directory,'orders.json');if(existsSync(file)){
 const rows=JSON.parse(readFileSync(file,'utf8'),(_k,v)=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.$bigint==='string'?BigInt(v.$bigint):v);
 if(!Array.isArray(rows))throw new Error('Invalid journal');
 if(rows.length>this.maxRecords)throw new ActionError('JOURNAL_FULL','Existing journal exceeds configured record bound; history has not been changed');
 for(const row of rows){if(row.state==='publishing')row.state='submission_unknown';this.rows.set(row.prepareId,row);}this.persist();
 }}catch(e){this.close();throw e;}
 }
 records():OrderRecord[]{return structuredClone([...this.rows.values()]);}
 get(id:string):OrderRecord{const row=this.rows.get(id);if(!row)throw new ActionError('UNKNOWN_PREPARE','Unknown server prepareId');return structuredClone(row);}
 put(row:OrderRecord):void{if(this.closed)throw new ActionError('JOURNAL_CLOSED','Journal is closed');const old=this.rows.get(row.prepareId);if(!old&&this.rows.size>=this.maxRecords)throw new ActionError('JOURNAL_FULL','Journal record limit reached; existing exposure history is preserved. Host must explicitly archive or increase the bound.');this.rows.set(row.prepareId,structuredClone(row));try{this.persist();}catch(e){if(old)this.rows.set(row.prepareId,old);else this.rows.delete(row.prepareId);throw e;}}
 private persist(){if(!this.directory)return;const temp=join(this.directory,`orders.${randomUUID()}.tmp`);const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify([...this.rows.values()],(_k,v)=>typeof v==='bigint'?{$bigint:String(v)}:v));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,join(this.directory,'orders.json'));const dir=openSync(this.directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 close(){if(this.closed)return;this.closed=true;if(this.lock!==undefined){closeSync(this.lock);unlinkSync(join(this.directory!,'writer.lock'));this.lock=undefined;}}
}
