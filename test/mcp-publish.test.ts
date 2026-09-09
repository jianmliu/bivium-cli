import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublishJournal } from '../src/sdk/actions/orderJournal.ts';
test('journal is exclusive, persistent and recovers ambiguous write ahead state', () => {
 const dir=mkdtempSync(join(tmpdir(),'orders-')); const j=new PublishJournal(dir);
 try {
 assert.throws(()=>new PublishJournal(dir),/JOURNAL_LOCKED/);
 j.put({prepareId:'x',state:'publishing',offer:{maxUnits:2n}} as any);
 j.close(); const restored=new PublishJournal(dir);
 assert.equal(restored.get('x').state,'submission_unknown');
 assert.equal(restored.get('x').offer.maxUnits,2n); restored.close();
 } finally {j.close();rmSync(dir,{recursive:true,force:true});}
});
import { fixture, intent, maker } from './fixtures/orderActions.ts';
import { OrderService } from '../src/sdk/actions/orders.ts';
import { privateKeyToAccount } from 'viem/accounts';
test('publication validates external signer, persists write ahead and marks malformed success unknown',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'publish-')),journal=new PublishJournal(dir);const f=fixture();let sends=0;
 const service=new OrderService(f.context,f.actions,{allowRelayerWrites:true,journal,fetch:async (_url,init)=>{sends++;assert.equal(journal.records()[0].state,'publishing');assert.equal(journal.records()[0].signedPayload,init!.body);return new Response('{}',{status:200});}});
 try{const p=await service.prepare(intent);const wrong=privateKeyToAccount(`0x${'22'.repeat(32)}`);await assert.rejects(service.publish({prepareId:p.data.prepareId,signature:await wrong.signTypedData(p.data.typedData!)}),/INVALID_SIGNATURE/);assert.equal(sends,0);
 const signature=await maker.signTypedData(p.data.typedData!);const response=await service.publish({prepareId:p.data.prepareId,signature});assert.equal(response.data.state,'submission_unknown');assert.equal(journal.get(p.data.prepareId).signature,signature);assert.equal(sends,1);
 }finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('publication validates returned commitment and setter proof on chain',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'publish-')),journal=new PublishJournal(dir),f=fixture();let expected='';const service=new OrderService(f.context,f.actions,{allowRelayerWrites:true,journal,fetch:async()=>new Response(JSON.stringify({commitment:expected}),{status:200})});
 try{const p=await service.prepare({...intent,ratifierKind:'setter'});expected=p.data.commitment;assert.equal((await service.publish({prepareId:p.data.prepareId})).data.state,'published');assert.equal(journal.records()[0].state,'published');}finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
import { cancelMessage } from '../src/sdk/relayer.ts';
test('journal bound preserves every record and allows updates, including after persistent reload',()=>{
 const j=new PublishJournal(undefined,{maxRecords:2});j.put({prepareId:'a',state:'signed'} as any);j.put({prepareId:'b',state:'submission_unknown'} as any);assert.throws(()=>j.put({prepareId:'c'} as any),/JOURNAL_FULL/);j.put({prepareId:'a',state:'published'} as any);assert.equal(j.records().length,2);assert.equal(j.get('b').state,'submission_unknown');
 const defaults=new PublishJournal();for(let n=0;n<1000;n++)defaults.put({prepareId:String(n)} as any);assert.throws(()=>defaults.put({prepareId:'full'} as any),/JOURNAL_FULL/);
 const dir=mkdtempSync(join(tmpdir(),'bound-'));try{const disk=new PublishJournal(dir,{maxRecords:2});disk.put({prepareId:'a'} as any);disk.put({prepareId:'b'} as any);disk.close();assert.throws(()=>new PublishJournal(dir,{maxRecords:1}),/JOURNAL_FULL/);const restored=new PublishJournal(dir,{maxRecords:2});assert.equal(restored.records().length,2);restored.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
test('delist verifies maker and full domain while allowing external expiry beyond preparation window',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'delist-')),journal=new PublishJournal(dir),f=fixture();let sends=0;const service=new OrderService(f.context,f.actions,{allowRelayerWrites:true,journal,fetch:async()=>{sends++;return new Response('{}',{status:200});}});
 try{const p=await service.prepare(intent),offer={...p.data.offer,expiry:p.data.offer.maturity+1n};const commitment=f.context.adapter.offerCommitment(f.context.profile,offer);const cancelSignature=await maker.signMessage({message:cancelMessage(commitment)});const wrong=privateKeyToAccount(`0x${'22'.repeat(32)}`);await assert.rejects(service.delist({offer,commitment,cancelSignature:await wrong.signMessage({message:cancelMessage(commitment)})}),/INVALID_SIGNATURE/);await assert.rejects(service.delist({offer,commitment:f.context.adapter.offerCommitment({...f.context.profile,chainId:1},offer),cancelSignature}),/DOMAIN_MISMATCH/);assert.equal(sends,0);const r=await service.delist({offer,commitment,cancelSignature});assert.equal(r.data.onchainCancelled,'unknown');assert.equal(sends,1);}finally{journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('restart inspects relayer before reposting precisely the durable signed payload',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'retry-'));let journal=new PublishJournal(dir);const f=fixture(),events:string[]=[];const service=new OrderService(f.context,f.actions,{allowRelayerWrites:true,journal});const originalFetch=globalThis.fetch;
 try{const p=await service.prepare(intent);const signature=await maker.signTypedData(p.data.typedData!);const row=journal.get(p.data.prepareId);row.signature=signature;row.state='publishing';const {wireOffer}=await import('../src/sdk/relayer.ts');row.signedPayload=JSON.stringify({offer:wireOffer(f.context.profile,row.offer),signature,commitment:row.commitment});journal.put(row);journal.close();journal=new PublishJournal(dir);assert.equal(journal.get(row.prepareId).state,'submission_unknown');globalThis.fetch=async(_url,init)=>{assert.equal(init?.method,undefined);events.push('GET');return new Response('[]',{status:200});};const restarted=new OrderService(f.context,f.actions,{allowRelayerWrites:true,journal,fetch:async(_url,init)=>{events.push('POST');assert.equal(init?.body,row.signedPayload);return new Response(JSON.stringify({commitment:row.commitment}),{status:200});}});assert.equal((await restarted.publish({prepareId:row.prepareId})).data.state,'published');assert.deepEqual(events,['GET','POST']);}finally{globalThis.fetch=originalFetch;journal.close();rmSync(dir,{recursive:true,force:true});}
});
test('publication rechecks bound policy, backing and maker registration before HTTP',async()=>{
 for(const changed of ['policy','backing','registration']){const dir=mkdtempSync(join(tmpdir(),'recheck-')),journal=new PublishJournal(dir),f=fixture();let sends=0;const service=new OrderService(f.context,f.actions,{allowRelayerWrites:true,journal,fetch:async()=>{sends++;return new Response('{}');}});try{const p=await service.prepare(intent);const signature=await maker.signTypedData(p.data.typedData!);if(changed==='policy')f.actions.policies.test.rules.confirmOnUnknown=true;else{const read=f.context.rpc.readContract;f.context.rpc.readContract=async r=>r.functionName===(changed==='backing'?'liquidityOf':'isRatifier')?(changed==='backing'?0n:false):read(r);}await assert.rejects(service.publish({prepareId:p.data.prepareId,signature}),/POLICY_REJECTED|STATE_CHANGED|INSUFFICIENT_BALANCE|RATIFIER_NOT_REGISTERED/);assert.equal(sends,0);}finally{journal.close();rmSync(dir,{recursive:true,force:true});}}
});
