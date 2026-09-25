import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as policy from '../src/sdk/productMarketPolicy.ts';
import { ZERO_ADDRESS, type Address } from '../src/sdk/types.ts';
const POLICY_CORE = '0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4' as Address;
const CASHCAT = '0x34a456c0365B78c5E04b97dee228207cf9CaB35D' as Address;
const domain = { chainId: 46630, core: POLICY_CORE };
const params = { loanToken: CASHCAT, collateralToken: ZERO_ADDRESS, maturity: 2000n };
test('product status is exact-domain, either-leg, case-insensitive and independent of expiry', () => {
  for (const p of [params, { ...params, loanToken: ZERO_ADDRESS, collateralToken: CASHCAT.toUpperCase() as Address }]) {
    const status = policy.productMarketStatus({ ...domain, core: POLICY_CORE.toLowerCase() as Address }, p, 1000n);
    assert.deepEqual(status, { delisted: true, matured: false, newBusiness: false, reasons: ['delisted'] });
    assert.throws(() => policy.assertNewBusinessMarket(domain, p, 1000n), /delisted/i);
  }
  for (const d of [{ ...domain, chainId: 1 }, { ...domain, core: ZERO_ADDRESS }]) {
    assert.equal(policy.productMarketStatus(d, params, 1000n).newBusiness, true);
    assert.equal(policy.productMarketStatus(d, params, 2000n).matured, true);
  }
  assert.equal(policy.productMarketStatus(domain, { ...params, loanToken: ZERO_ADDRESS }, 1000n).newBusiness, true);
  assert.deepEqual(policy.productMarketStatus(domain, params, 2000n).reasons, ['delisted', 'matured']);
});
