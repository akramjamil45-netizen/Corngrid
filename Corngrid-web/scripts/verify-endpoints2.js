'use strict';
// Verifies the endpoints that timed out in the browser console:
// /api/chat/unread-count, /api/chat/conversations, /api/feed, /api/feed/profile/:u
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');
const jwt = require('jsonwebtoken');

(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  const user = (await pg.query('SELECT id, email, username FROM users ORDER BY id LIMIT 1')).rows[0];
  await pg.end();
  const token = jwt.sign({ id: user.id, email: user.email, username: user.username, authVersion: 0 },
    process.env.JWT_SECRET, { expiresIn: '2m' });
  const headers = { Authorization: `Bearer ${token}` };

  const checks = [
    ['GET', '/api/chat/unread-count'],
    ['GET', '/api/chat/conversations'],
    ['GET', '/api/feed'],
    ['GET', `/api/feed/profile/${encodeURIComponent(user.username)}`],
    ['GET', '/api/me'],
    ['GET', '/api/mt5/accounts']
  ];
  for (const [method, pathName] of checks) {
    const started = Date.now();
    try {
      const response = await fetch(`http://localhost:3000${pathName}`, { method, headers });
      console.log(`${pathName}: HTTP ${response.status} in ${Date.now() - started}ms`);
    } catch (error) {
      console.log(`${pathName}: FAILED ${error.message}`);
    }
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
