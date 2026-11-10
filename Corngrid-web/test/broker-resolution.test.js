const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSymbol, validateProbe, resolveBroker } = require('../agent/broker-resolution');
const symbol = (name, tradeMode = 4, custom = false) => ({ name, tradeMode, custom });
test('account symbols resolve suffixes, prefixes and gold aliases without guessing ambiguous contracts', () => {
  for (const name of ['XAUUSD.c', 'XAUUSDm', 'GOLD', '#XAUUSD']) assert.equal(resolveSymbol('XAUUSD', [symbol(name)]), name);
  assert.equal(resolveSymbol('EURUSD', [symbol('EURUSD.c')]), 'EURUSD.c');
  assert.equal(resolveSymbol('XAUUSD', [symbol('XAUUSD'), symbol('XAUUSD.c')]), 'XAUUSD');
  assert.throws(() => resolveSymbol('XAUUSD', [symbol('XAUUSD.c'), symbol('XAUUSDm')]), /ambiguous/);
  assert.throws(() => resolveSymbol('XAUUSD', [symbol('XAUUSD', 0), symbol('XAUGBP'), symbol('XAUUSDx', 4, true)]), /No tradable/);
  assert.throws(() => resolveSymbol('XAUUSD', [symbol('XAUUSD', 3)]), /No tradable/);
  assert.throws(() => resolveSymbol('XAUUSD', [symbol('XAUUSD.c')], 'XAUUSDm'), /Configured symbol/);
  assert.equal(resolveSymbol('XAUUSD', [symbol('XAUUSD.c'), symbol('XAUUSDm')], 'XAUUSD.c'), 'XAUUSD.c');
});
test('only verified account identity can supply the canonical server and symbol', () => {
  const payload = { accountNumber: '123456', brokerServer: 'JustMarkets-DEMO6', symbol: 'XAUUSD' };
  const probe = { ok: true, connected: true, tradeAllowed: true, accountNumber: '123456', server: 'JustMarkets-Demo6', symbols: [symbol('XAUUSD.c')] };
  assert.deepEqual(validateProbe(probe, payload, {}), { brokerServer: 'JustMarkets-Demo6', resolvedSymbol: 'XAUUSD.c' });
  assert.throws(() => validateProbe({ ...probe, accountNumber: '999' }, payload, {}), /different account/);
  assert.throws(() => validateProbe({ ...probe, server: 'JustMarkets-Demo2' }, payload, {}), /different account/);
  assert.throws(() => validateProbe({ ...probe, connected: false }, payload, {}), /disconnected/);
  assert.throws(() => validateProbe({ ...probe, tradeAllowed: false }, payload, {}), /trading is not allowed/);
  assert.throws(() => validateProbe({ ok: false, error: 'Broker login failed' }, payload, {}), /Broker login failed/);
  const ambiguous = { ...probe, symbols: [symbol('XAUUSD.c'), symbol('XAUUSDm')] };
  assert.equal(validateProbe(ambiguous, payload, { brokerSymbolMaps: { 'JustMarkets-Demo6': { XAUUSD: 'XAUUSDm' } }, brokerAccountSymbolMaps: { 'JustMarkets-DEMO6': { '123456': { XAUUSD: 'XAUUSD.c' } } } }).resolvedSymbol, 'XAUUSD.c');
});
test('preflight passes no credentials on the command line and rejects stale success files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-preflight-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = { accountNumber: '123456', brokerServer: 'JustMarkets-DEMO6', password: 'private-test-password', symbol: 'XAUUSD' };
  const run = (_exe, args, opts, done) => {
    assert.ok(!args.join(' ').includes(payload.password));
    assert.ok(!args.join(' ').includes(payload.accountNumber));
    assert.equal(opts.windowsHide, true);
    const nonce = args[args.indexOf('-RequestId') + 1];
    fs.writeFileSync(path.join(dir, 'config/broker-preflight-result.json'), JSON.stringify({ requestId: nonce, ok: true, connected: true, tradeAllowed: true, accountNumber: payload.accountNumber, server: 'JustMarkets-Demo6', symbols: [symbol('XAUUSD.c')] }));
    done(null);
  };
  const resolved = await resolveBroker(dir, payload, {}, run);
  assert.equal(resolved.resolvedSymbol, 'XAUUSD.c');
  assert.equal(resolved.brokerServer, 'JustMarkets-Demo6');
  assert.match(fs.readFileSync(path.join(dir, 'config/broker-preflight.ini'), 'utf16le'), /Enabled=0/);
  assert.ok(!fs.readFileSync(path.join(dir, 'config/broker-resolution.json'), 'utf8').includes(payload.password));
  await assert.rejects(resolveBroker(dir, payload, {}, (_exe, _args, _opts, done) => {
    fs.writeFileSync(path.join(dir, 'config/broker-preflight-result.json'), JSON.stringify({ requestId: 'old', ok: true })); done(null);
  }), /stale/);
});
