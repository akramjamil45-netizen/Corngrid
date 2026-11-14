# MT5 account currency standard

MT5 account denominations come from the broker/EA, not from the account name,
server name, lot size, balance size or the labels micro/standard/cent.

| Reported account currency | CornGrid display/API currency |
| --- | --- |
| USD, usd | USD |
| USDc, USDC, USC, USCENT, USCENTS, USD CENT, USD CENTS | USDc |
| Other supported alphabetic broker codes | Trimmed uppercase code |
| Missing or invalid currency on pairing | Rejected; no assumed USD |

These are **MT5 account aliases**, not a universal currency/crypto mapping. Stripe,
DuitNow, subscription prices and partner ledgers keep their separate conventions.
USDC in a partner ledger is not renamed to USDc.

Balances, equity, margin, profits and historical points stay in their received
units. For example, `10,000 USC` displays as `10,000 USDc`; it is not divided by
100 or silently converted into USD. USD and USDc never share a monetary total or
profit sort. Accounts with mixed denominations require selecting an account or
currency. Legacy USC/USDC aliases are normalized on reads and in SQL grouping,
without rewriting stored account history or requiring a database migration.

Pairing stores the canonical code. An authenticated, current heartbeat may provide
an optional `currency` field using the same rules; omission keeps the existing
denomination. Invalid or out-of-order heartbeats cannot change it. Existing EAs
that only send currency during pairing remain supported.

Dashboard, account lists, positions/deals, public portfolio cards/details and
Report Studio consume the same canonical MT5 currency. Report filters compare
legacy aliases through the shared SQL expression, including PostgreSQL/SQLite.

If a broker reports USD even though an account is described as cent, CornGrid
cannot safely infer the unit. Confirm the broker's account denomination and the
EA's `ACCOUNT_CURRENCY` data before correcting that account. There is no manual
UI relabeling or automatic amount conversion based on the word “micro”.

Checks: `node --test test/mt5-currency.test.js test/mt5-currency-reports.test.js test/mt5-api.test.js`.
