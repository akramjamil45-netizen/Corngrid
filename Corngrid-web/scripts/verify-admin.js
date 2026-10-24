'use strict';
// Verifies every read-only admin endpoint against the running server using a
// short-lived admin token derived from .env (same formula as admin-auth.js).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

(async () => {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const hash = (process.env.ADMIN_PASSWORD_HASH || '').trim();
  if (!email || !hash) { console.log('Admin not configured in .env'); process.exit(1); }
  const adminVersion = crypto.createHash('sha256').update(`${email}\0${hash}`).digest('hex');
  const token = jwt.sign({ sub: 'admin', role: 'admin', adminVersion }, process.env.JWT_SECRET, { expiresIn: '2m' });
  const headers = { Authorization: `Bearer ${token}` };
  const base = 'http://localhost:3000';

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const userRow = (await pg.query('SELECT id FROM users ORDER BY id LIMIT 1')).rows[0];
  await pg.end();

  const checks = [
    '/api/admin/overview',
    '/api/admin/overview?search=a&visibility=public',
    '/api/admin/overview?visibility=private&page=1&limit=10',
    `/api/admin/users/${userRow.id}/trading`,
    '/api/admin/support/conversations'
  ];
  let failures = 0;
  for (const pathName of checks) {
    const started = Date.now();
    try {
      const response = await fetch(base + pathName, { headers });
      const body = await response.json().catch(() => null);
      let detail = '';
      if (pathName === '/api/admin/overview' && body && body.summary) {
        detail = ` totalUsers=${body.summary.totalUsers} public=${body.summary.publicPortfolios} private=${body.summary.privatePortfolios} profiles=${body.profiles.length}`;
        const p = body.profiles[0];
        if (p) detail += ` firstProfile={username:${p.username}, isPublic:${p.isPublic}, linked:${p.linkedAccounts}, visibility:${p.portfolioVisibility}, createdAt:${p.createdAt ? 'ok' : 'MISSING'}}`;
      }
      if (pathName.includes('/trading') && body && body.user) detail = ` user=${body.user.username} accounts=${body.accounts.length} createdAt=${body.user.createdAt ? 'ok' : 'MISSING'}`;
      if (pathName.includes('/support/conversations') && body) detail = ` conversations=${(body.conversations || []).length}`;
      if (response.status !== 200) failures += 1;
      console.log(`${pathName}: HTTP ${response.status} in ${Date.now() - started}ms${detail}`);
    } catch (error) {
      failures += 1;
      console.log(`${pathName}: FAILED ${error.message}`);
    }
  }
  console.log(failures ? `${failures} ADMIN CHECK(S) FAILED` : 'ALL ADMIN CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
