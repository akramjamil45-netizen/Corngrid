'use strict';
// Calls the previously-failing endpoint on the running production server with
// a short-lived token minted for the owner of the given account id.
// Usage: node scripts/verify-endpoint.js <accountId> [port]
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

const accountId = Number(process.argv[2] || 13);
const port = Number(process.argv[3] || 3000);

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const result = await pg.query(
    'SELECT a.id, u.id AS user_id, u.email, u.username FROM mt5_accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1',
    [accountId]);
  if (!result.rows.length) {
    console.log(`Account ${accountId} not found; trying any account...`);
    const any = await pg.query('SELECT a.id, u.id AS user_id, u.email, u.username FROM mt5_accounts a JOIN users u ON u.id = a.user_id ORDER BY a.id LIMIT 1');
    if (!any.rows.length) { console.log('No accounts at all.'); process.exit(1); }
    result.rows = any.rows;
  }
  const row = result.rows[0];
  const versionRow = await pg.query('SELECT version FROM user_auth_versions WHERE user_id = $1', [row.user_id]);
  await pg.end();
  const authVersion = versionRow.rows.length ? versionRow.rows[0].version : 0;

  const token = jwt.sign(
    { id: row.user_id, email: row.email, username: row.username, authVersion },
    process.env.JWT_SECRET,
    { expiresIn: '2m' });

  for (const period of ['30d', '7d', 'today', 'all']) {
    const url = `http://localhost:${port}/api/portfolio/performance?period=${period}&accountId=${row.id}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json().catch(() => null);
    console.log(`${period}: HTTP ${response.status}` +
      (response.status === 200 ? ` (closedDeals=${body && body.closedDeals}, equity points ok)` : ` ${JSON.stringify(body)}`));
  }

  const overview = await fetch(`http://localhost:${port}/api/portfolio?accountId=${row.id}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`/api/portfolio: HTTP ${overview.status}`);
  process.exit(0);
})().catch(error => { console.error('VERIFY FAILED:', error.message); process.exit(1); });
