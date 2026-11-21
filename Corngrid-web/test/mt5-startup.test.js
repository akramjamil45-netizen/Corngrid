const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareStartup } = require('../agent/mt5-startup');

test('MT5 startup applies authenticated local SOCKS5 and explicitly resets direct mode', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proxy-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = { symbol:'XAUUSD', accountNumber:'123', brokerServer:'Broker-Demo', password:'fixture', installationSecret:'a'.repeat(64), strategy:{eaFileName:'CornGrid.ex5'},
    proxyCommon:{ProxyEnable:1,ProxyType:1,ProxyAddress:'127.0.0.1:32123',ProxyLogin:'bridge',ProxyPassword:'private-fixture'} };
  const file = prepareStartup(dir, payload, {backendUrl:'https://example.test'});
  let ini = fs.readFileSync(file, 'utf16le');
  assert.match(ini, /\[Common\][\s\S]*ProxyEnable=1\r\n/);assert.match(ini, /ProxyType=1\r\n/);
  assert.match(ini, /ProxyAddress=127\.0\.0\.1:32123\r\n/);assert.match(ini, /ProxyPassword=private-fixture\r\n/);
  delete payload.proxyCommon;prepareStartup(dir, payload, {backendUrl:'https://example.test'});ini=fs.readFileSync(file,'utf16le');
  assert.match(ini,/ProxyEnable=0\r\n/);assert.match(ini,/ProxyAddress=\r\n/);assert.ok(!ini.includes('private-fixture'));
});

test('restart validates the configured partner EA even when the base contains another executable', t => {
  const { loadStartupPayload } = require('../agent/mt5-startup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-partner-restart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = { symbol: 'GOLD', accountNumber: '123', brokerServer: 'Broker-Demo', password: 'fixture', installationSecret: 'a'.repeat(64), strategy: { code: 'partner-1', eaFileName: 'Partner.ex5' } };
  prepareStartup(dir, payload, { backendUrl: 'https://example.test' });
  fs.mkdirSync(path.join(dir, 'MQL5/Experts/CornGrid'), { recursive: true });
  for (const name of ['CornGrid.ex5', 'Partner.ex5']) fs.writeFileSync(path.join(dir, 'MQL5/Experts/CornGrid', name), 'fixture');
  fs.writeFileSync(path.join(dir, 'MQL5/Files/corngrid_sandbox.ini'), '[License]\nAccount=123\nServer=Broker-Demo\nSecret=' + payload.installationSecret);
  assert.equal(loadStartupPayload(dir).strategy.eaFileName, 'Partner.ex5');
  fs.unlinkSync(path.join(dir, 'MQL5/Experts/CornGrid/Partner.ex5'));
  assert.throws(() => loadStartupPayload(dir), /executable is missing/);
});

test('WebRequest startup updates preserve MT5 account environment and unrelated settings', t => {
  const { mergeIni } = require('../agent/mt5-startup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ini-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const encoding of ['utf8', 'utf16le']) {
    const file = path.join(dir, encoding + '.ini');
    fs.writeFileSync(file, (encoding === 'utf16le' ? '\ufeff' : '') + '[Common]\r\nEnvironment=preserved\r\nLogin=123\r\n[Experts]\r\nEnabled=1\r\nWebRequestUrl=https://old.example\r\n', encoding);
    mergeIni(file, { Experts: { WebRequestUrl: 'https://example.test', WebRequest: '1' } });
    const ini = fs.readFileSync(file, encoding);
    assert.match(ini, /Environment=preserved/); assert.match(ini, /Login=123/); assert.match(ini, /Enabled=1/);
    assert.match(ini, /WebRequestUrl=https:\/\/example.test/); assert.equal((ini.match(/WebRequestUrl=/g) || []).length, 1);
  }
});

test('verified broker identity seeds matching credentials and takes priority over a stale symbol map', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-canonical-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = { symbol: 'XAUUSD', resolvedSymbol: 'XAUUSD.c', accountNumber: '123', brokerServer: 'JustMarkets-Demo6', password: 'example', installationSecret: 'a'.repeat(64), strategy: { code: 'corngrid-ea', eaFileName: 'CornGrid.ex5' } };
  const file = prepareStartup(dir, payload, { backendUrl: 'https://example.test', brokerSymbolMaps: { 'JustMarkets-DEMO6': { XAUUSD: 'wrong' } } });
  assert.match(fs.readFileSync(file, 'utf16le'), /Server=JustMarkets-Demo6/);
  assert.match(fs.readFileSync(file, 'utf16le'), /Symbol=XAUUSD.c/);
  const settings = JSON.stringify({ accountNumber: '123', brokerServer: 'JustMarkets-Demo6', apiBaseUrl: 'https://example.test', pairingCode: '' });
  const hash = require('node:crypto').createHash('sha256').update(settings).digest('hex').toUpperCase();
  assert.ok(fs.readFileSync(path.join(dir, 'MQL5/Files/CGDash_123_JustMarketsD.settings'), 'ascii').startsWith(hash));
});

test('startup attaches EA, enables sync and seeds its authenticated credential', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-startup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const payload = { symbol: 'XAUUSDm', accountNumber: '12345678', brokerServer: 'Broker-Demo', password: 'example-password', installationSecret: 'a'.repeat(64), strategy: { eaFileName: 'CornGrid.ex5' } };
  const file = prepareStartup(dir, payload, { backendUrl: 'https://example.test/' });
  const ini = fs.readFileSync(file, 'utf16le');
  assert.match(ini, /Expert=CornGrid\\CornGrid\r\n/);
  assert.match(ini, /Symbol=XAUUSDm/);
  assert.match(ini, /Login=12345678/);
  assert.match(ini, /AllowLiveTrading=1/);
  const preset = fs.readFileSync(path.join(dir, 'MQL5/Presets/corngrid-sandbox.set'), 'utf16le');
  assert.match(preset, /InpEnableDashboardSync=true/);
  const files = path.join(dir, 'MQL5/Files');
  const key = fs.readdirSync(files).find(name => name.endsWith('.key'));
  assert.equal(fs.readFileSync(path.join(files, key), 'ascii'), payload.installationSecret);
  const settings = fs.readFileSync(path.join(files, 'CGDash_12345678_BrokerDemo.settings'), 'ascii');
  assert.match(settings, /^[A-F0-9]{64}\r\nCGDash_/);
  assert.ok(settings.endsWith(key));
  assert.ok(!ini.includes(payload.installationSecret));
  assert.ok(!preset.includes(payload.installationSecret));
});

test('startup rejects missing credentials and injected INI fields before writing', () => {
  assert.throws(() => prepareStartup('unused', {}, {}), /broker server/);
  assert.throws(() => prepareStartup('unused', { symbol: 'XAUUSD\nExpert=other' }, {}), /chart symbol/);
});
for (const symbol of [undefined, 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']) {
  test(`startup uses ${symbol || 'default XAUUSD'} on its EA chart`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-pair-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = prepareStartup(dir, { symbol, accountNumber: '12345678', brokerServer: 'Broker-Demo', password: 'example', installationSecret: 'a'.repeat(64), strategy: { eaFileName: 'CornGrid.ex5' } }, { backendUrl: 'https://example.test' });
    assert.ok(fs.readFileSync(file, 'utf16le').includes(`Symbol=${symbol || 'XAUUSD'}\r\n`));
  });
}
test('legacy sandbox startup is recovered without redeploying or rotating credentials', t => {
  const { ensureStartup } = require('../agent/mt5-startup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const folder of ['config', 'MQL5/Files', 'MQL5/Experts/CornGrid']) fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config/common.ini'), '[Common]\r\nLogin=12345678\r\nPassword=example\r\nServer=Broker-Demo\r\n');
  fs.writeFileSync(path.join(dir, 'MQL5/Files/corngrid_sandbox.ini'), `[License]\r\nAccount=12345678\r\nServer=Broker-Demo\r\nSecret=${'a'.repeat(64)}\r\nApiBaseUrl=https://example.test\r\n`);
  const binary = path.join(dir, 'MQL5/Experts/CornGrid/CornGrid.ex5');
  fs.writeFileSync(binary, 'original-binary');
  const file = ensureStartup(dir, { backendUrl: 'https://example.test' });
  assert.match(fs.readFileSync(file, 'utf16le'), /Symbol=XAUUSD/);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'original-binary');
  assert.equal(ensureStartup(dir, {}), file, 'existing pair and startup remain unchanged');
});
test('official Downloads preset is loaded with broker symbol and WebRequest settings', t => {
  const { loadPreset } = require('../sandbox/sandbox-presets');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-preset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'webrequest.ini');
  fs.writeFileSync(source, '[Experts]\r\nWebRequest=1\r\nWebRequestUrl=2 TEST-ALLOWLIST\r\n[Common]\r\nPassword=DO-NOT-COPY\r\n');
  const preset = loadPreset('XAUUSD');
  const startup = prepareStartup(dir, { symbol: 'XAUUSD', accountNumber: '12345678', brokerServer: 'Broker-Demo', password: 'example', installationSecret: 'a'.repeat(64), strategy: { eaFileName: 'CornGrid.ex5' }, preset }, {
    backendUrl: 'https://example.test', brokerSymbolMaps: { 'Broker-Demo': { XAUUSD: 'XAUUSD_l' } }, webRequestSettingsSource: source
  });
  const settings = fs.readFileSync(path.join(dir, 'MQL5/Presets/corngrid-sandbox.set'), 'utf16le');
  for (const line of preset.text.split(/\r?\n/).filter(line => /^Inp/.test(line) && !/^Inp(?:EnableDashboardSync|DashboardApiBaseURL|DashboardPairingCode)=/.test(line))) {
    assert.ok(settings.includes(line), `original preset input preserved: ${line.split('=')[0]}`);
  }
  assert.match(settings, /InpEnableDashboardSync=true/);
  const ini = fs.readFileSync(startup, 'utf16le');
  assert.match(ini, /Symbol=XAUUSD_l/);
  assert.match(ini, /WebRequest=1/);
  assert.match(ini, /WebRequestUrl=2 TEST-ALLOWLIST/);
  assert.ok(!ini.includes('DO-NOT-COPY'));
  assert.match(fs.readFileSync(path.join(dir, 'config/common.ini'), 'utf16le'), /WebRequestUrl=2 TEST-ALLOWLIST/);
});

test('partner EA startup preserves its own inputs without adding CornGrid-only sync settings', t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cg-partner-startup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 prepareStartup(dir,{symbol:'EURUSD',accountNumber:'12345678',brokerServer:'Broker-Demo',password:'example',installationSecret:'a'.repeat(64),strategy:{code:'partner-123',eaFileName:'OtherEA.ex5'},preset:{kind:'partner',text:'TakeProfit=123\r\nInpDashboardApiBaseURL=https://partner.example\r\n'}},{backendUrl:'https://example.test'});
 const preset=fs.readFileSync(path.join(dir,'MQL5/Presets/corngrid-sandbox.set'),'utf16le');
 assert.match(preset,/TakeProfit=123/);assert.match(preset,/InpDashboardApiBaseURL=https:\/\/partner.example/);assert.ok(!preset.includes('InpEnableDashboardSync=true'));
 assert.ok(!fs.readdirSync(path.join(dir,'MQL5/Files')).some(name=>name.startsWith('CGDash_')));
});
