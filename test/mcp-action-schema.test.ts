import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validator} from '../src/mcp/schema.ts';
import {actionSchema} from '../src/mcp/tools/actions.ts';
const address = `0x${'1'.repeat(40)}`, hash = `0x${'1'.repeat(64)}`;
const offer = {chainId:46630,bivium:address,loanToken:address,collateralToken:address,maturity:'2000000000',strike:'1',allowPartialRepay:true,gate:address,maker:address,buy:true,tick:'4000',maxUnits:'1',maxAssets:'0',start:'0',expiry:'1900000000',group:hash,ratifier:address};
const intent = {action:'borrow',marketId:hash,account:address,receiver:address,policyId:'p',collateralKind:'other',evidence:{},fills:[{offer,commitment:hash,ratifierData:'0x',units:'1'}],deadline:'1800000000',minProceeds:'1',maxTopUp:'1'};
test('borrow accepts required top-up bound and rejects unused buy bound',()=>{const check=validator(actionSchema);assert.equal(check(intent),true);assert.equal(check({...intent,maxCost:'1'}),false);assert.equal(check({...intent,maxTopUp:undefined}),false);});
