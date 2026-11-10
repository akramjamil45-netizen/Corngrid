const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyBrokerServerCache, saveBrokerServerCache } = require('../agent/broker-server-cache');

test('verified cache survives deleting its original sandbox and tolerates stale configured paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), target = path.join(dir, 'next');
  fs.mkdirSync(path.join(source, 'config'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config/servers.dat'), 'verified-directory');
  fs.writeFileSync(path.join(source, 'config/accounts.dat'), 'must-not-share');
  const config = { brokerCacheDir: path.join(dir, 'cache') };
  assert.equal(saveBrokerServerCache(source, 'JustMarkets-Demo6', config), true);
  fs.rmSync(source, { recursive: true });
  assert.equal(copyBrokerServerCache(target, 'JustMarkets-DEMO6', config), true);
  assert.equal(fs.readFileSync(path.join(target, 'config/servers.dat'), 'utf8'), 'verified-directory');
  assert.equal(fs.existsSync(path.join(target, 'config/accounts.dat')), false);
  assert.equal(copyBrokerServerCache(target, 'Unknown-Live', { brokerServerDataDirs: { 'Unknown-Live': source } }), false);
});
test('broker cache imports server directory without account or personal settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-broker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), target = path.join(dir, 'target');
  for (const folder of [source, target]) fs.mkdirSync(path.join(folder, 'config'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config/servers.dat'), 'broker-cache');
  fs.writeFileSync(path.join(source, 'config/accounts.dat'), 'private-account-data');
  fs.writeFileSync(path.join(target, 'config/servers.dat'), 'old-cache');
  const config = { brokerServerDataDirs: { 'Broker-Demo': source } };
  assert.equal(copyBrokerServerCache(target, 'Broker-Demo', config), true);
  assert.equal(fs.readFileSync(path.join(target, 'config/servers.dat'), 'utf8'), 'broker-cache');
  assert.equal(fs.readFileSync(path.join(target, 'config/servers.dat.before-broker-repair'), 'utf8'), 'old-cache');
  assert.equal(fs.existsSync(path.join(target, 'config/accounts.dat')), false);
  assert.equal(copyBrokerServerCache(target, 'Other', config), false);
});
