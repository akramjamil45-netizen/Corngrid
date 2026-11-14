'use strict';

// MT5 account denominations only. Do not apply these aliases to payment or
// crypto ledgers: USDC in those contexts can mean a different asset.
const CENT_ALIASES = new Set(['USDC', 'USC', 'USCENT', 'USCENTS', 'USD CENT', 'USD CENTS']);
function normalizeMt5Currency(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (CENT_ALIASES.has(code)) return 'USDc';
  return /^[A-Z]{3,8}$/.test(code) ? code : null;
}
function normalizeCurrencyRow(row) {
  return row && Object.hasOwn(row, 'currency')
    ? { ...row, currency: normalizeMt5Currency(row.currency) } : row;
}
// This expression keeps legacy aliases in the same SQL group without rewriting
// stored account history. The column is code-owned, never a request parameter.
function mt5CurrencySql(column) {
  if (!/^(?:[a-z][a-z0-9_]*\.)?currency$/.test(column)) throw new Error('Invalid currency column.');
  const normalized = `UPPER(TRIM(${column}))`;
  return `(CASE WHEN ${normalized} IN (${[...CENT_ALIASES].map(code => `'${code}'`).join(', ')}) THEN 'USDc' ELSE NULLIF(${normalized}, '') END)`;
}
module.exports = { normalizeMt5Currency, normalizeCurrencyRow, mt5CurrencySql };
