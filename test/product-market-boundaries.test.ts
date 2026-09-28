import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionContext } from '../src/sdk/actions/context.ts';
import { evaluateAction } from '../src/sdk/actions/prepare.ts';
import { ActionService, type ActionIntent } from '../src/sdk/actions/preview.ts';
import { OrderService } from '../src/sdk/actions/orders.ts';
import { MarketAnalysisService } from '../src/sdk/actions/marketAnalysis.ts';
import { PublishJournal } from '../src/sdk/actions/orderJournal.ts';
import { canonicalHash } from '../src/sdk/actions/preview.ts';
import { wireOffer } from '../src/sdk/relayer.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/sdk/lineage.ts';
import { entryFromSignedOffer, fillCost } from '../src/sdk/orderbook.ts';
import { TradeClient, validateTradePlan } from '../src/sdk/trade.ts';
import { RATIFIED } from '../src/sdk/ratify.ts';
import { strategyFixture } from './fixtures/strategyFlow.ts';
import { gatherStrategyInputs, planFromGathered } from '../src/sdk/strategies/gather.ts';
import { ZERO_ADDRESS, type Address, type DeploymentProfile, type Offer } from '../src/sdk/types.ts';
const core = '0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4' as Address;
const cashcat = '0x34a456c0365B78c5E04b97dee228207cf9CaB35D' as Address;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const adapter = adapterFor('core-v2');
function fixture(delisted = true) {
  const profile: DeploymentProfile = { name: 'test', chainId: 46630, abiProfile: 'core-v2', core, signatureRatifier: a(2), rpcUrl: 'http://127.0.0.1:1' };
  const params = { loanToken: delisted ? cashcat : a(3), collateralToken: a(4), maturity: 10000n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true };
  const market = { id: adapter.computeMarketId(profile, params), params, firstSeenBlock: 0n };
  const calls: string[] = [];
  let now = 100n;
  const context = new ActionContext({ profile, now: () => Number(now) * 1000, markets: async () => [market], book: async () => ({ entries: [], source: 'test', coverage: 'complete' }), rpc: {
    getChainId: async () => profile.chainId, getBlock: async () => ({ number: 1n, timestamp: now, hash: `0x${'11'.repeat(32)}` }),
    readContract: async r => { calls.push(r.functionName); if (r.functionName === 'computeId') return adapter.computeMarketId(profile, r.args![0] as any); return ({ decimals: 0, balanceOf: 100n, allowance: 100n, creditOf: 100n, liquidityOf: 100n, collateralEscrowOf: 0n, consumed: 0n, isRatifier: true, isRatified: RATIFIED, position: { debt: 10n, collateral: 10n, collateralWithdrawable: 10n }, marketState: { touched: true, activeCredit: 100n, repaidCredit: 100n, activeCollateral: 100n, claimedCredit: 0n } } as any)[r.functionName]; },
    simulateContract: async () => { calls.push('SIMULATE'); return {}; }, getBytecode: async () => undefined,
  } });
  const actions = new ActionService(context, { test: { source: 'user-policy', rules: { rejectArbitraryMint: false, rejectUnsellable: false, confirmOnUnknown: false }, inventory: { [market.id]: { maxCredit: '2000', maxNewDebt: '0', minCash: '0', maxCommittedLoan: '1000', maxLoss: '1000', allowOrigination: false } } } as any });
  const intent: ActionIntent = { action: 'fund', marketId: market.id, account: a(6), receiver: a(6), amount: '1', policyId: 'test', collateralKind: 'other', evidence: {} };
  return { profile, params, market, calls, context, actions, intent, setNow: (n: bigint) => { now = n; } };
}
test('explicit fund/escrow and semantic trade actions reject delisted markets before economic reads or simulation', async () => {
  for (const action of ['fund', 'escrow_collateral', 'buy_dcn', 'borrow', 'strategy_program'] as const) {
    const f = fixture(); const ctx = await f.context.pin(a(6)); f.calls.length = 0;
    await assert.rejects(evaluateAction(f.context, { ...f.intent, action, deadline: '200', fills: [{} as any] }, ctx), /PRODUCT_MARKET_POLICY/);
    assert.equal(f.calls.length, 0);
  }
});
test('delisted recovery actions remain available and funding stops at expiry', async () => {
  const f = fixture();
  for (const action of ['repay', 'withdraw_liquidity', 'withdraw_collateral'] as const) {
    await evaluateAction(f.context, { ...f.intent, action, amount: action === 'withdraw_collateral' ? undefined : '1' }, await f.context.pin(a(6)));
  }
  f.setNow(10000n);
  await evaluateAction(f.context, { ...f.intent, action: 'claim' }, await f.context.pin(a(6)));
  const clean = fixture(false); clean.setNow(10000n);
  await assert.rejects(evaluateAction(clean.context, clean.intent, await clean.context.pin(a(6))), /PRODUCT_MARKET_POLICY.*matured/);
});
test('cached action prepare rechecks eligibility at the new pinned timestamp', async () => {
  const f = fixture(false);
  f.setNow(9999n);
  const preview = await f.actions.preview(f.intent);
  assert.ok(preview.data.previewId);
  f.setNow(10000n);
  await assert.rejects(f.actions.prepare(preview.data.previewId!), /PRODUCT_MARKET_POLICY/);
});
function offer(f: ReturnType<typeof fixture>, buy = false): Offer { return { ...f.params, maker: a(5), buy, tick: 4000n, maxUnits: 10n, maxAssets: 0n, start: 0n, expiry: 9000n, group: `0x${'00'.repeat(32)}`, ratifier: a(2) }; }
test('cached trade plans reject new buying and borrowing, while held-credit sell preflight survives', async () => {
  for (const side of ['buy', 'borrow', 'sell'] as const) {
    const f = fixture(); const o = offer(f, side !== 'buy'); const entry = entryFromSignedOffer(o, adapter.offerCommitment(f.profile, o), '0x');
    const plan = { side: entry.side, takes: [{ entry, units: 10n }], totalUnits: 10n, totalCost: fillCost(o, 10n, entry.price) };
    const ctx = await f.context.pin(a(6)); f.calls.length = 0;
    const check = validateTradePlan(plan, { profile: f.profile, account: a(6), block: { number: 1n, timestamp: ctx.timestamp }, mode: side === 'borrow' ? 'borrow' : 'secondary', read: r => f.context.rpc.readContract(r) });
    if (side === 'sell') await check;
    else { await assert.rejects(check, /PRODUCT_MARKET_POLICY/); assert.equal(f.calls.length, 0); }
  }
});
test('high-level buy planning rejects delisted asks before book reconciliation', async () => {
  const f = fixture(); const tc = new TradeClient(f.profile); const o = offer(f); o.maturity = 4000000000n;
  tc.reconcileBook = async () => { throw new Error('unexpected book reconciliation'); };
  await assert.rejects(tc.planBuy([entryFromSignedOffer(o, adapter.offerCommitment(f.profile, o), '0x')], { units: 1n }), /PRODUCT_MARKET_POLICY/);
});
test('new bid preparation rejects policy while credit-backed ask and cancellation remain available', async () => {
  const f = fixture(); const service = new OrderService(f.context, f.actions);
  const input = { marketId: f.market.id, account: a(6), side: 'bid' as const, maxUnits: '10', tick: '4000', expiry: '2000', group: { mode: 'independent' as const }, policyId: 'test', collateralKind: 'other' as const, evidence: {} };
  await assert.rejects(service.prepare(input), /PRODUCT_MARKET_POLICY/);
  assert.equal(service.journal.records().length, 0);
  const ask = await service.prepare({ ...input, side: 'ask' });
  assert.equal(ask.data.offer.buy, false);
  assert.equal((await service.cancelPrepare({ account: a(6), offers: [ask.data.offer], mode: 'selected_offers' })).data.transactions.length, 1);
});
test('injected gather rows are filtered and cached gathered plans recheck product policy', async () => {
  const f = fixture(); f.profile.tokens = { CASHCAT: { address: cashcat, decimals: 18 }, bUSD: { address: a(4), decimals: 18 } };
  const row = { market: f.market, loanSymbol: 'CASHCAT', collateralSymbol: 'bUSD', loanDecimals: 18, collateralDecimals: 18 };
  const req = { strategy: 'lendAsset', asset: 'CASHCAT', size: '1', maturity: 10000n, bufferPct: 0, priceWad: 10n ** 18n, now: 100n, rows: [row], spot: { px: 10n ** 18n, status: 'ready' as const, pair: 'BUSD-CASHCAT' }, parity: false as const };
  await assert.rejects(gatherStrategyInputs(f.profile, undefined, req), /no .*market|PRODUCT_MARKET_POLICY/);
  const g = await gatherStrategyInputs({ ...f.profile, chainId: 1 }, undefined, req);
  assert.throws(() => planFromGathered(f.profile, g), /PRODUCT_MARKET_POLICY/);
});
test('strategy preview excludes delisted candidates before token metadata and spot', async () => {
  const f = strategyFixture(); f.profile.core = core; f.profile.tokens!.CAT.address = cashcat;
  f.market.params.loanToken = cashcat; f.market.id = adapter.computeMarketId(f.profile, f.market.params);
  const read = f.context.rpc.readContract;
  f.context.rpc.readContract = async r => r.functionName === 'computeId' ? adapter.computeMarketId(f.profile, r.args![0] as any) : read(r);
  f.options.spot = async () => { throw new Error('unexpected spot'); };
  await assert.rejects(f.flow.preview(f.input), /MARKET_NOT_FOUND/);
  assert.equal(f.calls.some(c => c.functionName === 'decimals'), false);
});
test('MM analysis keeps historical inventory but blocks new bid/origination candidates', async () => {
  const f = fixture(); const service = new MarketAnalysisService(f.context, f.actions.policies as any);
  const candidate = { ...offer(f, true), maker: a(6) };
  const input = { account: a(6), marketIds: [f.market.id], candidateOffers: [{ ...wireOffer(f.profile, candidate), chainId: f.profile.chainId }], policyId: 'test' };
  const response = await service.mmPreview(input);
  assert.equal(response.data.markets[0].state.credit, 100n);
  assert.equal(response.data.decision, 'reject');
  assert.equal((response.data.markets[0] as any).blockedCandidates.length, 1);
  input.candidateOffers = [{ ...wireOffer(f.profile, { ...candidate, buy: false }), chainId: f.profile.chainId }];
  assert.equal((await service.mmPreview(input)).data.decision, 'incomplete');
  input.candidateOffers = [{ ...wireOffer(f.profile, { ...candidate, buy: false, maxUnits: 101n }), chainId: f.profile.chainId }];
  assert.equal(((await service.mmPreview(input)).data.markets[0] as any).blockedCandidates.length, 1);
});
test('MM candidate eligibility uses remaining shared-group cap and fails closed on unknown consumed', async () => {
  const f = fixture(); const read = f.context.rpc.readContract;
  let unknown = false;
  f.context.rpc.readContract = async r => {
    if (r.functionName === 'creditOf') return 5n;
    if (r.functionName === 'consumed') { if (unknown) throw new Error('unavailable'); return 5n; }
    return read(r);
  };
  const service = new MarketAnalysisService(f.context, f.actions.policies as any);
  const candidate = { ...offer(f, false), maker: a(6) };
  const input = { account: a(6), marketIds: [f.market.id], candidateOffers: [{ ...wireOffer(f.profile, candidate), chainId: 46630 }], policyId: 'test' };
  assert.deepEqual((await service.mmPreview(input)).data.markets[0].blockedCandidates, []);
  unknown = true;
  assert.equal((await service.mmPreview(input)).data.markets[0].blockedCandidates.length, 1);
});
test('arbitrage analysis marks historical entry blocked without losing spread estimates', async () => {
  const f = fixture(); const service = new MarketAnalysisService(f.context, f.actions.policies as any);
  const leg = (buy: boolean) => { const o = offer(f, buy); return { offer: { ...wireOffer(f.profile, o), chainId: f.profile.chainId }, commitment: adapter.offerCommitment(f.profile, o), ratifierData: '0x' as const, units: '10' }; };
  const response = await service.arbitragePreview({ account: a(6), entry: [leg(false)], exit: [leg(true)], minProfit: '0' });
  assert.equal(response.data.kind, 'estimated_spread');
  assert.equal((response.data as any).blocked, true);
  assert.deepEqual((response.data as any).productMarketStatus.reasons, ['delisted']);
});
test('persisted bid publication rechecks shared policy before ratification or remote submission', async () => {
  const f = fixture(); f.profile.relayerUrl = 'http://127.0.0.1:1';
  const dir = mkdtempSync(join(tmpdir(), 'bivium-policy-journal-'));
  let journal = new PublishJournal(dir);
  const o = { ...offer(f, true), maker: a(6) };
  const intent = { marketId: f.market.id, account: a(6), side: 'bid' as const, maxUnits: '10', tick: '4000', expiry: '2000', group: { mode: 'independent' as const }, policyId: 'test', collateralKind: 'other' as const, evidence: {} };
  journal.put({ prepareId: 'legacy', state: 'prepared', chainId: 46630, core, intent, offer: o, commitment: adapter.offerCommitment(f.profile, o), policyHash: canonicalHash(f.actions.policy('test')), evidenceHash: canonicalHash({ marketId: f.market.id, collateralKind: 'other', evidence: {} }), ratifierKind: 'signature' });
  journal.close(); journal = new PublishJournal(dir);
  let writes = 0;
  try {
    const service = new OrderService(f.context, f.actions, { allowRelayerWrites: true, journal, fetch: async () => { writes++; throw new Error('unexpected remote write'); } });
    await assert.rejects(service.publish({ prepareId: 'legacy' }), /PRODUCT_MARKET_POLICY/);
    assert.equal(writes, 0); assert.equal(journal.get('legacy').state, 'prepared');
    assert.equal(f.calls.includes('isRatified'), false);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
