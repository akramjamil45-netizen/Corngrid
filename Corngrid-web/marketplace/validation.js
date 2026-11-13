'use strict';
const CATEGORIES = ['grid','trend','scalping','breakout','mean_reversion','multi_strategy','other'];
const SECTIONS = ['overview','features','strategy','markets','configuration','riskManagement','risks','changelog'];
function fail(message, status = 400, code = 'INVALID_INPUT') { throw Object.assign(new Error(message), { status, code }); }
function text(value, max, field, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || required && !value.trim()) fail(`Enter a valid ${field} (up to ${max} characters).`);
  return value.trim();
}
function bool(value, field) { if (typeof value !== 'boolean') fail(`${field} must be true or false.`); return value; }
function list(value, pattern, field) {
  if (!Array.isArray(value) || value.length > 20 || value.some(v => typeof v !== 'string' || !pattern.test(v))) fail(`Enter valid ${field}, up to 20 items.`);
  return JSON.stringify([...new Set(value)]);
}
function metadata(body, { admin = false, create = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid listing.');
  const allowed = ['revision','name','short_description','full_description','version','strategy_type','supported_symbols','supported_timeframes','minimum_balance','balance_currency','recommended_leverage','account_mode','platform'];
  if (admin) allowed.push('existing_strategy_id');
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('One or more listing fields cannot be changed here.');
  const out = {};
  if (create || 'name' in body) out.name = text(body.name, 100, 'EA name', true);
  for (const [key, max] of [['short_description',300],['version',40],['recommended_leverage',10],['balance_currency',3]]) {
    if (key in body) out[key] = text(body[key], max, key);
  }
  if (out.balance_currency !== undefined && !/^[A-Z]{3}$/.test(out.balance_currency)) fail('Use a three-letter balance currency.');
  if (out.recommended_leverage && !/^1:[1-9][0-9]{0,4}$/.test(out.recommended_leverage)) fail('Use leverage in the form 1:100.');
  if ('strategy_type' in body) { if (!CATEGORIES.includes(body.strategy_type)) fail('Choose a supported strategy category.'); out.strategy_type = body.strategy_type; }
  if ('account_mode' in body) { if (!['hedging','netting','both','unspecified'].includes(body.account_mode)) fail('Choose an account compatibility.'); out.account_mode = body.account_mode; }
  if ('platform' in body && body.platform !== 'MetaTrader 5') fail('Only MetaTrader 5 is supported.');
  if ('supported_symbols' in body) out.supported_symbols = list(body.supported_symbols, /^[A-Z0-9][A-Z0-9._+-]{0,23}$/, 'symbols');
  if ('supported_timeframes' in body) out.supported_timeframes = list(body.supported_timeframes, /^(M[1-9][0-9]?|H[1-9][0-9]?|D1|W1|MN1)$/, 'timeframes');
  if ('minimum_balance' in body) {
    const v = body.minimum_balance;
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e12)) fail('Enter a valid minimum balance.');
    out.minimum_balance = v;
  }
  if ('full_description' in body) {
    const d = body.full_description;
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some(k => !SECTIONS.includes(k))) fail('Use the supported description sections.');
    out.full_description = JSON.stringify(Object.fromEntries(Object.entries(d).map(([k,v]) => [k,text(v,6000,k)])));
  }
  if (admin && 'existing_strategy_id' in body) {
    if (body.existing_strategy_id !== null && (!Number.isSafeInteger(body.existing_strategy_id) || body.existing_strategy_id < 1)) fail('Choose a valid strategy.');
    out.existing_strategy_id = body.existing_strategy_id;
  }
  return out;
}
function revision(body, row) { if (!Number.isSafeInteger(body?.revision) || body.revision !== Number(row.revision)) fail('This listing changed. Reload it before saving.', 409, 'REVISION_CONFLICT'); }
module.exports = { CATEGORIES, SECTIONS, fail, text, bool, metadata, revision };
