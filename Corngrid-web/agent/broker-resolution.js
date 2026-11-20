'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const enqueueProbe = require('./operation-queue').createOperationQueue();

function lookup(object, key) {
  const found = Object.keys(object || {}).find(name => name.toLowerCase() === String(key).toLowerCase());
  return found ? object[found] : undefined;
}

function resolveSymbol(requested, symbols, override) {
  if (typeof requested !== 'string' || !/^[A-Za-z0-9#._-]{1,64}$/.test(requested)) throw new Error('Invalid requested trading symbol.');
  const available = symbols.filter(item => item && typeof item.name === 'string' && /^[A-Za-z0-9#._-]{1,64}$/.test(item.name) && item.tradeMode === 4 && !item.custom);
  if (override) {
    const match = available.find(item => item.name === override);
    if (!match) throw new Error(`Configured symbol ${override} is unavailable or does not allow both buy and sell on this account.`);
    return match.name;
  }
  const exact = available.find(item => item.name === requested);
  if (exact) return exact.name;
  const aliases = requested.toUpperCase() === 'XAUUSD' ? ['XAUUSD', 'GOLD'] : [requested.toUpperCase()];
  // Prefer a complete contract name over prefix matches such as GoldmSachs
  // or GOLD24-7. Explicit account/server mappings still take precedence.
  const alias = available.find(item => aliases.includes(item.name.toUpperCase()));
  if (alias) return alias.name;
  const matches = available.filter(item => aliases.some(base => {
    const name = item.name.toUpperCase();
    return name === base || (name.startsWith(base) && /^[A-Z0-9._-]{1,12}$/.test(name.slice(base.length))) ||
      (/^[#._-]{1,3}/.test(name) && name.replace(/^[#._-]{1,3}/, '') === base);
  }));
  const names = [...new Set(matches.map(item => item.name))];
  if (names.length === 1) return names[0];
  if (names.length > 1) throw new Error(`Symbol ${requested} is ambiguous (${names.slice(0, 8).join(', ')}). Configure brokerSymbolMaps for this server.`);
  throw new Error(`No tradable symbol matches ${requested} on this broker account.`);
}

function brokerSearch(server) {
  const groups = [
    [/^LiteFinance/i, 'LiteFinance'], [/^HFMarkets/i, 'HF Markets'], [/^JustMarkets/i, 'JustMarkets'],
    [/^Tickmill/i, 'Tickmill'], [/^RoboForex/i, 'RoboForex'], [/^XM(?:Global|\.COM)/i, 'XM'],
    [/^FBS/i, 'FBS'], [/^Exness/i, 'Exness'], [/^Headway/i, 'Headway'], [/^Elev8/i, 'Elev8']
  ];
  return groups.find(([pattern]) => pattern.test(server))?.[1] || server;
}

function validateProbe(result, payload, config) {
  if (!result || !result.ok) throw new Error(result?.error || 'MT5 broker verification did not finish.');
  if (String(result.accountNumber) !== String(payload.accountNumber) ||
      typeof result.server !== 'string' || result.server.toLowerCase() !== payload.brokerServer.toLowerCase()) {
    throw new Error('MT5 connected to a different account or server; EA was not started.');
  }
  if (!result.connected || !result.tradeAllowed) throw new Error('MT5 is disconnected or trading is not allowed. Check the trading password and account permissions.');
  if (!Array.isArray(result.symbols) || !result.symbols.length) throw new Error('MT5 returned no broker symbols.');
  const requested = payload.symbol || config.startupSymbol || 'XAUUSD';
  const mappings = lookup(config.brokerSymbolMaps, result.server);
  const accountMappings = lookup(config.brokerAccountSymbolMaps, result.server)?.[String(payload.accountNumber)];
  return { brokerServer: result.server, resolvedSymbol: resolveSymbol(requested, result.symbols, accountMappings?.[requested] || mappings?.[requested]) };
}

function resolveBroker(dir, payload, config, run = execFile, ipcProbe = null) {
  // Include cache refresh, keeper restart, login and symbol validation in one
  // lock. Serializing initialize() alone still lets another login change the
  // shared terminal before the first account_info()/symbols_get() completes.
  return enqueueProbe('broker-preflight', () => verifyBroker(dir, payload, config, run, ipcProbe));
}

async function verifyBroker(dir, payload, config, run, ipcProbe) {
  for (const field of ['brokerServer', 'accountNumber', 'password']) {
    if (typeof payload[field] !== 'string' || !payload[field] || /[\r\n\0]/.test(payload[field])) throw new Error(`Invalid ${field} for broker preflight.`);
  }
  if (!/^\d{1,32}$/.test(payload.accountNumber)) throw new Error('Invalid broker account number.');
  // The preflight terminal has no EA and cannot place trades. Do not inherit a base account.
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.rmSync(path.join(dir, 'config', 'accounts.dat'), { force: true });
  fs.writeFileSync(path.join(dir, 'config', 'broker-preflight.ini'), '\ufeff' + [
    '[Common]', `Login=${payload.accountNumber}`, `Password=${payload.password}`, `Server=${payload.brokerServer}`, 'KeepPrivate=1',
    '', '[Experts]', 'Enabled=0', 'AllowLiveTrading=0', '', '[StartUp]', ''
  ].join('\r\n'), 'utf16le');
  let probeTerminal = null;
  if (ipcProbe) {
    const ensured = await ipcProbe.ensure({ allowTakeover: false });
    if (!ensured.ok) throw new Error(ensured.error || 'The MT5 IPC probe terminal is not available.');
    await ipcProbe.prepareForServer(payload.brokerServer, config);
    const ready = await ipcProbe.ensure({ allowTakeover: false });
    if (!ready.ok) throw new Error(ready.error || 'The MT5 IPC probe terminal is not available.');
    probeTerminal = ipcProbe.dir;
  }
  const requestId = require('node:crypto').randomUUID();
  const resultPath = path.join(dir, 'config', 'broker-preflight-result.json');
  fs.rmSync(resultPath, { force: true });
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'resolve-broker.ps1'),
    '-InstanceDir', path.resolve(dir), '-Search', brokerSearch(payload.brokerServer), '-PythonPath', config.mt5PythonPath || 'python.exe', '-RequestId', requestId];
  if (probeTerminal) args.push('-ProbeTerminal', path.resolve(probeTerminal));
  if(process.platform==='linux'){
    if(!fs.existsSync(path.join(dir,'config','servers.dat')))throw new Error('Linux broker preflight requires a prepared broker servers.dat seed. See the Linux installation guide.');
    fs.writeFileSync(path.join(dir,'config','common.ini'),fs.readFileSync(path.join(dir,'config','broker-preflight.ini')),{mode:0o600});
    const runtime=require('./linux-runtime').createLinuxRuntime({config});
    await runtime.runProgram(dir,config.mt5PythonPath,[runtime.toWinePath(path.join(__dirname,'broker-probe.py')),runtime.toWinePath(path.resolve(dir)),requestId],{kind:'probe',timeout:600000});
  }else await new Promise((resolve, reject) => run('powershell.exe', args,
    { timeout: 600000, windowsHide: true, maxBuffer: 64 * 1024 }, error => {
      if (error) return reject(new Error('MT5 broker preflight could not run. Check the node Python/MetaTrader5 installation and broker discovery log.'));
      resolve();
    }));
  let result;
  try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('MT5 broker preflight returned no valid result. EA was not started.'); }
  if (result.requestId !== requestId) throw new Error('MT5 broker preflight result is stale.');
  const resolved = validateProbe(result, payload, config);
  require('./broker-server-cache').saveBrokerServerCache(dir, resolved.brokerServer, config);
  fs.writeFileSync(path.join(dir, 'config', 'broker-resolution.json'), JSON.stringify({
    ...resolved, requestedSymbol: payload.symbol || config.startupSymbol || 'XAUUSD', verifiedAt: Date.now()
  }, null, 2));
  return { ...payload, ...resolved };
}

module.exports = { lookup, resolveSymbol, brokerSearch, validateProbe, resolveBroker };
