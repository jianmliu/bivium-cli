import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as book from '../src/sdk/orderbook.ts';
import { WAD, STRIKE_SCALE, type Offer, type Hex } from '../src/sdk/types.ts';
const base = { loanToken:'0xa', collateralToken:'0xb', maturity:1800000000n, strike:STRIKE_SCALE, allowPartialRepay:false, gate:'0x0', maker:'0xc', buy:false, tick:4096n, maxUnits:250n, maxAssets:0n, start:0n, expiry:1790000000n, group:'0x1', ratifier:'0xd' } as Offer;
const entry = (id:number, patch:Partial<Offer> = {}) => ({...book.entryFromSignedOffer({...base,...patch}, `0x${id}` as Hex,'0x'),price:WAD});
test('shared group consumes only its cap and preserves exact consumed metadata',()=>{
 const entries=[entry(1),entry(2)];
 assert.equal(book.planSweepByFace(entries,500n).filled,250n);
 const r=book.reconcileConsumedEntries(entries,[100n,100n]);
 assert.equal(book.planSweepByFace(r.entries,500n).filled,150n);
 assert.equal(r.entries[0].consumed,100n);
 assert.equal(book.planSweepBySpend(r.entries,500n).units,150n);
 assert.equal(book.planExactSpend(r.entries,500n).kind,'insufficient-depth');
});
test('each entry applies its own cap to cumulative group consumption',()=>{
 assert.equal(book.planSweepByFace([entry(1),entry(2,{maxUnits:400n})],500n).filled,400n);
 assert.equal(book.planSweepByFace([entry(1),entry(2,{group:'0x2'})],500n).filled,500n);
 assert.equal(book.planSweepByFace([entry(1),entry(1)],500n).filled,250n);
});
test('group budget saturates and rejects ambiguous units or contradictory consumed',()=>{
 assert.equal(book.groupAvailable(250n,100n,200n),0n);
 assert.throws(()=>book.planSweepByFace([entry(1),entry(2,{maxUnits:0n,maxAssets:250n})],500n),/mixed.*cap/i);
 assert.equal(book.reconcileConsumedEntries([entry(1),entry(2)],[0n,1n]).ready,false);
 assert.throws(()=>book.planSweepByFace([{...entry(1),consumed:0n},{...entry(2),consumed:1n}],500n),/contradictory/);
 for (const planner of [book.planSweepBySpend, book.planExactSpend]) {
  assert.throws(()=>planner([entry(1),entry(2,{maxUnits:0n,maxAssets:250n})],500n),/mixed.*cap/i);
 }
});
test('assets caps use per fill rounding and exact onchain consumed',()=>{
 for (const buy of [false,true]) {
 const entries=[entry(1,{buy,maxUnits:0n,maxAssets:2n}),entry(2,{buy,maxUnits:0n,maxAssets:2n})].map(e=>({...e,price:WAD*3n/5n}));
 const r=book.reconcileConsumedEntries(entries,[1n,1n]);
 const p=book.planSweepByFace(r.entries,20n);
 assert.ok(p.cost<=1n); assert.ok(p.filled>0n);
 }
});
test('backing is shared across groups and collateral is charged for every fill',()=>{
 const entries=[entry(1,{maxUnits:1n,strike:3n*STRIKE_SCALE}),entry(2,{maxUnits:1n,strike:3n*STRIKE_SCALE,group:'0x2'})];
 const backing=new Map([[book.makerBackingKey(entries[0]),{credit:0n,escrow:1n,liquidity:0n}]]);
 assert.equal(book.planSweepByFace(entries,2n,backing).filled,1n);
 assert.throws(()=>book.planSweepByFace(entries,2n,new Map()),/backing/i);
 const bids=[entry(3,{buy:true}),entry(4,{buy:true,group:'0x2'})];
 const liquid=new Map([[book.makerBackingKey(bids[0]),{credit:0n,escrow:0n,liquidity:300n}]]);
 assert.equal(book.planSweepByFace(bids,500n,liquid).filled,300n);
});

test('spent groups do not hide independently backed depth from later offers',()=>{
 const entries=[entry(1),entry(2),entry(3,{group:'0x2'})];
 const backing=new Map([[book.makerBackingKey(entries[0]),{credit:500n,escrow:0n,liquidity:0n}]]);
 assert.equal(book.planSweepBySpend(entries,500n,backing).units,500n);
 assert.equal(book.planExactSpend(entries,500n,backing).kind,'executable');
 assert.equal(book.aggregateLevels(entries)[0].size,750n);
});
