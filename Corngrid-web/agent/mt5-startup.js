'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function iniValue(value, label) {
  const text = String(value ?? '');
  if (!text || /[\r\n\0]/.test(text)) throw new Error(`Invalid ${label}.`);
  return text;
}

function iniEscape(key) {
  return String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Merge values into an existing MT5 ini. The terminal keeps its own state
// (Environment, licence, WebRequest allowlist) in common.ini, so replacing the
// file would throw away what a saved account depends on.
function mergeIni(file, updates) {
  let text = '';
  let utf16 = true;
  if (fs.existsSync(file)) {
    const bytes = fs.readFileSync(file);
    utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
    text = bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\ufeff/, '');
  }
  const lines = text.length ? text.split(/\r?\n/) : [];
  for (const [section, entries] of Object.entries(updates)) {
    let start = lines.findIndex(line => new RegExp(`^\\[${iniEscape(section)}\\]\\s*$`, 'i').test(line.trim()));
    if (start < 0) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`[${section}]`);
      start = lines.length - 1;
    }
    let end = lines.findIndex((line, index) => index > start && /^\s*\[[^\]]+\]\s*$/.test(line));
    if (end < 0) end = lines.length;
    for (const [key, value] of Object.entries(entries)) {
      const pattern = new RegExp(`^\\s*${iniEscape(key)}\\s*=`, 'i');
      const index = lines.findIndex((line, position) => position > start && position < end && pattern.test(line));
      if (index >= 0) lines[index] = `${key}=${value}`;
      else { lines.splice(end, 0, `${key}=${value}`); end += 1; }
    }
  }
  fs.writeFileSync(file, (utf16 ? '\ufeff' : '') + lines.join('\r\n'), utf16 ? 'utf16le' : 'utf8');
}

function readWebRequestSettings(dir, config) {
  const settings = require('./webrequest-settings');
  const sources = [];
  if (config.webRequestSettingsSource) sources.push(config.webRequestSettingsSource);
  sources.push(path.join(dir, 'config', 'common.ini'));
  for (const file of sources) {
    try { return settings.readEntries(file); } catch (_error) { /* try the next source */ }
  }
  try { return settings.readVerifiedSettings(dir); } catch (_error) { /* legacy receipt */ }
  return null;
}

// A restart reuses the existing sandbox-startup.ini. Refresh the [Experts]
// WebRequest keys in both files: MT5 is launched with
// /config:sandbox-startup.ini while common.ini keeps the terminal's own saved
// state. Updating only common.ini leaves a stale allowlist and blocks the EA
// with error 4014. The protected URL list is machine/build-specific and must
// come from webRequestSettingsSource on this node.
function applyWebRequest(dir, config) {
  try {
    const entries = readWebRequestSettings(dir, config);
    if (!entries) return { ok: false };
    const updates = { Experts: entries };
    mergeIni(path.join(dir, 'config', 'common.ini'), updates);
    const startupPath = path.join(dir, 'config', 'sandbox-startup.ini');
    if (fs.existsSync(startupPath)) mergeIni(startupPath, updates);
    return { ok: true };
  } catch (_error) {
    return { ok: false };
  }
}

function prepareStartup(dir, payload, config) {
  const selectedPair = payload.symbol || config.startupSymbol || 'XAUUSD';
  const symbol = iniValue(payload.resolvedSymbol || require('./broker-resolution').lookup(config.brokerSymbolMaps, payload.brokerServer)?.[selectedPair] || selectedPair, 'sandbox chart symbol');
  const server = iniValue(payload.brokerServer, 'broker server');
  const account = iniValue(payload.accountNumber, 'account number');
  const password = iniValue(payload.password, 'MT5 password');
  const baseUrl = iniValue(payload.apiBaseUrl || config.backendUrl, 'API URL').replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL.');
  const fileName = payload.strategy?.eaFileName;
  if (!fileName || /[\\/\r\n]/.test(fileName) || !fileName.endsWith('.ex5')) throw new Error('Invalid EA file name.');
  if (!/^[a-f0-9]{64}$/i.test(payload.installationSecret || '')) throw new Error('Invalid installation credential.');
  const isCornGrid = payload.strategy?.code === 'corngrid-ea' || (!payload.strategy?.code && /^corngrid(?:[_ .-]|\.ex5$)/i.test(fileName));
  const filesDir = path.join(dir, 'MQL5', 'Files');
  const presetsDir = path.join(dir, 'MQL5', 'Presets');
  const configDir = path.join(dir, 'config');
  for (const folder of [filesDir, presetsDir, configDir]) fs.mkdirSync(folder, { recursive: true });
  // Match DashboardSafeToken and DashboardResetCredentialIfSettingsChanged in the EA.
  if (isCornGrid) {
  const safe = value => value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const keyName = `CGDash_${account}_${safe(server)}_${safe(baseUrl)}.key`;
  const settings = JSON.stringify({ accountNumber: account, brokerServer: server, apiBaseUrl: baseUrl, pairingCode: '' });
  const fingerprint = crypto.createHash('sha256').update(settings).digest('hex').toUpperCase();
  fs.writeFileSync(path.join(filesDir, keyName), payload.installationSecret, 'ascii');
  fs.writeFileSync(path.join(filesDir, `CGDash_${account}_${safe(server)}.settings`), `${fingerprint}\r\n${keyName}`, 'ascii');
  }
  const presetLines = String(payload.preset?.text || '').replace(/^\ufeff/, '').split(/\r?\n/)
    .filter(line => !isCornGrid || !/^\s*(InpEnableDashboardSync|InpDashboardApiBaseURL|InpDashboardPairingCode)\s*=/.test(line));
  const syncInputs = isCornGrid ? ['InpEnableDashboardSync=true', `InpDashboardApiBaseURL=${baseUrl}`, 'InpDashboardPairingCode='] : [];
  const preset = [...presetLines, ...syncInputs, ''].join('\r\n');
  fs.writeFileSync(path.join(presetsDir, 'corngrid-sandbox.set'), '\ufeff' + preset, 'utf16le');
  let webRequest = [];
  const verifiedWebRequest = require('./webrequest-settings').readVerifiedSettings(dir);
  if (verifiedWebRequest) {
    webRequest = Object.entries(verifiedWebRequest).map(([key, value]) => `${key}=${value}`);
  } else if (config.webRequestSettingsSource) {
    const bytes = fs.readFileSync(config.webRequestSettingsSource);
    const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
    const section = text.match(/\[Experts\]([^]*?)(?=\r?\n\[|$)/);
    webRequest = (section?.[1] || '').split(/\r?\n/).filter(line => /^WebRequest(?:Url)?=/.test(line));
    if (!webRequest.some(line => line.startsWith('WebRequestUrl='))) throw new Error('Configured WebRequest source has no allowed URL list.');
  }
  const startup = [
    '[Common]', `Login=${account}`, `Password=${password}`, `Server=${server}`, 'KeepPrivate=1', ...require('./proxy-protocol').proxyLines(payload.proxyCommon), '',
    '[Experts]', 'Enabled=1', 'AllowLiveTrading=1', 'AllowDllImport=0', 'Account=0', 'Profile=0', ...webRequest, '',
    '[StartUp]', `Expert=CornGrid\\${fileName.slice(0, -4)}`, 'ExpertParameters=corngrid-sandbox.set',
    `Symbol=${symbol}`, 'Period=M1', ''
  ].join('\r\n');
  const startupPath = path.join(configDir, 'sandbox-startup.ini');
  fs.writeFileSync(startupPath, '\ufeff' + startup, 'utf16le');
  // MT5 persists its WebRequest allowlist in common.ini too. Merge only those
  // keys so the terminal keeps the rest of its own configuration.
  if (webRequest.length) {
    const entries = {};
    for (const line of webRequest) {
      const equals = line.indexOf('=');
      entries[line.slice(0, equals)] = line.slice(equals + 1);
    }
    mergeIni(path.join(configDir, 'common.ini'), { Experts: entries });
  }
  return startupPath;
}
function loadStartupPayload(dir) {
  function readIni(file, section) {
    const bytes = fs.readFileSync(file);
    const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8');
    let current = '';
    const values = {};
    for (const line of text.replace(/^\ufeff/, '').split(/\r?\n/)) {
      const heading = line.match(/^\[([^\]]+)\]\s*$/);
      if (heading) { current = heading[1]; continue; }
      const equals = line.indexOf('=');
      if (current === section && equals > 0) values[line.slice(0, equals).trim()] = line.slice(equals + 1);
    }
    return values;
  }
  const startup = path.join(dir, 'config', 'sandbox-startup.ini');
  const source = fs.existsSync(startup) ? startup : path.join(dir, 'config', 'common.ini');
  if (!fs.existsSync(source)) throw new Error('Sandbox startup configuration is missing; redeploy the sandbox.');
  const licensePath = path.join(dir, 'MQL5', 'Files', 'corngrid_sandbox.ini');
  if (!fs.existsSync(licensePath)) throw new Error('Sandbox licence bundle is missing; redeploy the sandbox.');
  const common = readIni(source, 'Common');
  const license = readIni(licensePath, 'License');
  if (String(common.Login) !== String(license.Account) || String(common.Server).toLowerCase() !== String(license.Server).toLowerCase()) {
    throw new Error('Legacy sandbox login does not match its installation credential.');
  }
  const binaries = fs.readdirSync(path.join(dir, 'MQL5', 'Experts', 'CornGrid')).filter(name => /\.ex5$/i.test(name));
  const configuredExpert = readIni(source, 'StartUp').Expert;
  let binary;
  if (configuredExpert) {
    const match = /^CornGrid[\\/]([A-Za-z0-9._ -]+)$/.exec(configuredExpert);
    if (!match) throw new Error('Sandbox EA startup path is invalid; redeploy the sandbox.');
    const expected = /\.ex5$/i.test(match[1]) ? match[1] : match[1] + '.ex5';
    binary = binaries.find(name => name.toLowerCase() === expected.toLowerCase());
    if (!binary) throw new Error('Sandbox EA executable is missing; redeploy the sandbox.');
  } else {
    if (binaries.length !== 1) throw new Error('Cannot determine the legacy sandbox EA binary.');
    binary = binaries[0];
  }
  const presetFile = path.join(dir, 'MQL5', 'Presets', 'corngrid-sandbox.set');
  let preset;
  if (fs.existsSync(presetFile)) {
    const bytes = fs.readFileSync(presetFile);
    preset = { text: bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8') };
  }
  return {
    accountNumber: common.Login, brokerServer: common.Server, password: common.Password,
    installationSecret: license.Secret, apiBaseUrl: license.ApiBaseUrl,
    symbol: readIni(source, 'StartUp').Symbol || 'XAUUSD', preset,
    strategy: { eaFileName: binary }
  };
}
function ensureStartup(dir, config) {
  const startupPath = path.join(dir, 'config', 'sandbox-startup.ini');
  if (fs.existsSync(startupPath)) {
    applyWebRequest(dir, config);
    return startupPath;
  }
  return prepareStartup(dir, loadStartupPayload(dir), config);
}
module.exports = { prepareStartup, ensureStartup, loadStartupPayload, mergeIni, readWebRequestSettings, applyWebRequest };
