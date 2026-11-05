'use strict';
const fs = require('node:fs');
const path = require('node:path');
const presets = {
  XAUUSD: 'xauusd v2.60 set file.set', EURUSD: 'eurusd m1 v2.00 set file.set',
  GBPUSD: 'gbpusd m1 v2.00 set file.set', USDJPY: 'usdjpy m1 v2.00 set file.set'
};
function loadPreset(symbol) {
  const file = presets[symbol];
  if (!file) throw new Error('Unsupported sandbox preset pair.');
  const bytes = fs.readFileSync(path.join(__dirname, '../../files/v2.0 set file', file));
  const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\ufeff/, '');
  return { name: file, text };
}
module.exports = { loadPreset };