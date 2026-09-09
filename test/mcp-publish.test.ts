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
import { fixture, intent, maker } from './mcp-orders.test.ts';
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
