import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSignedOfferFile } from '../src/sdk/offer.ts';
import { adapterFor } from '../src/sdk/lineage.ts';
import { ZERO_ADDRESS, type DeploymentProfile, type Offer, type MarketParams } from '../src/sdk/types.ts';
const root = new URL('..', import.meta.url).pathname;
const core = '0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4';
const cashcat = '0x34a456c0365B78c5E04b97dee228207cf9CaB35D';
test('CLI explicit new-business paths reject CASHCAT without a key, RPC or signing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bivium-policy-cli-'));
  try {
    const profile: DeploymentProfile = { name: 'policy', chainId: 46630, abiProfile: 'core-v2', core, signatureRatifier: core, setterRatifier: core, strategyRouter: core, rpcUrl: 'http://127.0.0.1:1', tokens: { CASHCAT: { address: cashcat, decimals: 18 }, bUSD: { address: core, decimals: 6 } } };
    const p = join(dir, 'profile.json'), file = join(dir, 'offer.json');
    writeFileSync(p, JSON.stringify(profile));
    const offer: Offer = { loanToken: cashcat, collateralToken: core, maturity: 4000000000n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true, maker: core, buy: true, tick: 4000n, maxUnits: 10n, maxAssets: 0n, start: 0n, expiry: 3999999999n, group: `0x${'11'.repeat(32)}`, ratifier: core };
    writeFileSync(file, JSON.stringify(buildSignedOfferFile(profile, offer, adapterFor('core-v2').offerCommitment(profile, offer), '0x')));
    const before = readFileSync(file, 'utf8');
    for (const command of [
      ['maker', 'fund', '--assets', '1'], ['maker', 'escrow', '--assets', '1'],
      ['maker', 'make-offer', '--side', 'buy', '--tick', '4000', '--max-units', '1'],
      ['maker', 'ratify-root'], ['borrow', 'quote'], ['borrow', 'execute', '--units', '1'],
      ['strategy', 'program', '--strategy', 'short', '--units', '1'], ['strategy', 'execute', '--strategy', 'short', '--units', '1'],
    ]) {
      await t.test(command.join(' '), () => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', ...command, '--profile', p, '--offer', file, '--json'], { cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, BIVIUM_PK: '', BIVIUM_PROFILE: '' } });
      assert.notEqual(result.status, 0, command.join(' '));
      assert.match(result.stderr, /PRODUCT_MARKET_POLICY.*delisted/, command.join(' '));
      assert.equal(readFileSync(file, 'utf8'), before);
      });
    }
    const off = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'maker', 'ratify-root', '--off', '--profile', p, '--offer', file], { cwd: root, encoding: 'utf8', env: { ...process.env, BIVIUM_PK: '', BIVIUM_PROFILE: '' } });
    assert.doesNotMatch(off.stderr, /PRODUCT_MARKET_POLICY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('CLI market list defaults to new business and explicit history retains both reasons', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bivium-policy-list-'));
  const profile: DeploymentProfile = { name: 'policy', chainId: 46630, abiProfile: 'core-v2', core, signatureRatifier: core, rpcUrl: '', tokens: {} };
  const params: MarketParams = { loanToken: cashcat, collateralToken: core, maturity: 100n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true };
  const id = adapterFor('core-v2').computeMarketId(profile, params);
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') { res.end(JSON.stringify({ chainId: 46630, core, markets: [{ id, params }] }, (_, v) => typeof v === 'bigint' ? String(v) : v)); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    assert.equal(rpc.method, 'eth_call');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: encodeAbiParameters([{ type: 'bool' }, ...Array.from({ length: 4 }, () => ({ type: 'uint256' } as const))], [true, 0n, 0n, 0n, 0n]) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  profile.rpcUrl = profile.relayerUrl = `http://127.0.0.1:${port}`;
  const file = join(dir, 'profile.json'); writeFileSync(file, JSON.stringify(profile));
  try {
    for (const history of [false, true]) {
      const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'market', 'list', '--source', 'relayer', '--profile', file, '--json', ...(history ? ['--include-history'] : [])], { cwd: root, env: { ...process.env, BIVIUM_PK: '', BIVIUM_PROFILE: '' } });
        let stdout = '', stderr = ''; child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; }); child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
      });
      assert.equal(r.code, 0, r.stderr); const out = JSON.parse(r.stdout); assert.equal(out.count, history ? 1 : 0);
      if (history) assert.deepEqual(out.markets[0].reasons, ['delisted', 'matured']);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
test('root activation distinguishes held-credit CASHCAT asks from new origination without signing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bivium-policy-root-'));
  let credit = 10n;
  let consumed = 0n;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const rpc = JSON.parse(body);
    assert.equal(rpc.method, 'eth_call');
    res.setHeader('content-type', 'application/json');
    const value = rpc.params[0].data.startsWith(toFunctionSelector('consumed(address,bytes32)')) ? consumed : credit;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: encodeAbiParameters([{ type: 'uint256' }], [value]) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile: DeploymentProfile = { name: 'policy', chainId: 46630, abiProfile: 'core-v2', core, signatureRatifier: core, setterRatifier: core, rpcUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  const p = join(dir, 'profile.json'), file = join(dir, 'offer.json'); writeFileSync(p, JSON.stringify(profile));
  const offer: Offer = { loanToken: cashcat, collateralToken: core, maturity: 4000000000n, strike: 10n ** 36n, gate: ZERO_ADDRESS, allowPartialRepay: true, maker: core, buy: false, tick: 4000n, maxUnits: 10n, maxAssets: 0n, start: 0n, expiry: 3999999999n, group: `0x${'11'.repeat(32)}`, ratifier: core };
  writeFileSync(file, JSON.stringify(buildSignedOfferFile(profile, offer, adapterFor('core-v2').offerCommitment(profile, offer), '0x')));
  try {
    for (const values of [[10n, 0n], [9n, 0n], [5n, 5n]]) {
      [credit, consumed] = values;
      const stderr = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/main.ts', 'maker', 'ratify-root', '--offer', file, '--profile', p], { cwd: root, env: { ...process.env, BIVIUM_PK: '', BIVIUM_PROFILE: '' } });
        let error = ''; child.stderr.on('data', d => { error += d; }); child.on('error', reject); child.on('close', () => resolve(error));
      });
      assert.match(stderr, credit >= 10n - consumed ? /signing key required/ : /PRODUCT_MARKET_POLICY/);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
test('interactive buy/sell direction precedes market selection, retaining historical exits', () => {
  const source = readFileSync(join(root, 'src/cli/main.ts'), 'utf8');
  for (const name of ['wizardLend', 'wizardTrade']) {
    const body = source.slice(source.indexOf(`async function ${name}`)).split('\nasync function ')[0];
    assert.ok(body.indexOf('rl.ask(') < body.indexOf('pickMarketInteractive('), name);
    assert.match(body, /pickMarketInteractive\(ctx, c, rl, .*=== "sell"/);
  }
  assert.match(source, /purpose === 'exit' \|\| productMarketStatus\(ctx.profile, m.params, now\).newBusiness/);
});
