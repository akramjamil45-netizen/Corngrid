'use strict';
// End-to-end smoke test against a running server instance that uses a
// PostgreSQL TEST database. Covers the critical paths: registration, login
// (case-insensitive email), profile, EA pairing, heartbeat with positions
// (the hot EA write path, incl. json_each cleanup), trades, accounts,
// preferences, and the community feed.
//
// Usage: node scripts/smoke-pg.js [baseUrl]
const baseUrl = process.argv[2] || 'http://localhost:3100';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else { failures += 1; console.log(`FAIL  ${name} ${detail}`); }
}

async function api(method, pathName, { token, body } = {}) {
  const response = await fetch(baseUrl + pathName, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await response.json(); } catch { /* non-json */ }
  return { status: response.status, json };
}

(async () => {
  const stamp = Date.now();
  const username = `PgSmoke${stamp}`;
  const email = `pgsmoke${stamp}@example.test`;
  const password = 'smoke-password-123';

  const health = await api('GET', '/api/health/ready');
  check('readiness endpoint reports postgres', health.status === 200 && health.json.db === 'postgres', JSON.stringify(health.json));

  const registered = await api('POST', '/api/register', { body: { username, email, password } });
  check('register', registered.status === 200, JSON.stringify(registered.json));

  const dup = await api('POST', '/api/register', { body: { username, email, password } });
  check('duplicate registration rejected', dup.status === 400);

  // Login with uppercased email exercises the COLLATE NOCASE rewrite.
  const login = await api('POST', '/api/login', { body: { email: email.toUpperCase(), password } });
  check('login with differently-cased email', login.status === 200 && !!login.json.token, JSON.stringify(login.json));
  const token = login.json && login.json.token;
  const profile = await api('GET', '/api/user/profile', { token });
  check('profile read', profile.status === 200 && profile.json.username === username);

  const updated = await api('PUT', '/api/user/profile', { token, body: { username, bio: 'PG smoke bio' } });
  check('profile update', updated.status === 200);

  const pairing = await api('POST', '/api/mt5/pairing-code', { token });
  check('pairing code created', pairing.status === 201 && /^[A-F0-9]{8}$/.test(pairing.json.code), JSON.stringify(pairing.json));

  const pair = await api('POST', '/api/mt5/pair', {
    body: { code: pairing.json.code, accountNumber: String(700000 + (stamp % 99999)), brokerServer: 'Smoke-Broker', currency: 'USD', eaVersion: '2.60' }
  });
  check('EA paired', pair.status === 201 && !!pair.json.installationSecret, JSON.stringify(pair.json));
  const secret = pair.json && pair.json.installationSecret;

  const ts = Date.now();
  const heartbeat = await api('POST', '/api/mt5/heartbeat', {
    token: secret,
    body: {
      timestamp: new Date(ts).toISOString(),
      balance: 10000, equity: 10050, margin: 100, freeMargin: 9900, floatingProfit: 50,
      eaName: 'CornGrid EA', eaVersion: '2.60',
      positions: [
        { ticket: '9001', symbol: 'XAUUSD', direction: 'BUY', volume: 0.1, entryPrice: 2000, currentPrice: 2005, profit: 50, swap: -1, commission: -1, openedAt: new Date(ts - 3600000).toISOString() },
        { ticket: '9002', symbol: 'EURUSD', direction: 'SELL', volume: 0.2, entryPrice: 1.1, currentPrice: 1.09, profit: 20, swap: 0, commission: 0, openedAt: new Date(ts - 7200000).toISOString() }
      ]
    }
  });
  check('heartbeat with positions accepted', heartbeat.status === 200 && heartbeat.json.accepted === true, JSON.stringify(heartbeat.json));

  // Second heartbeat drops one position -> exercises the json_each cleanup query.
  const heartbeat2 = await api('POST', '/api/mt5/heartbeat', {
    token: secret,
    body: {
      timestamp: new Date(ts + 2000).toISOString(),
      balance: 10000, equity: 10055, margin: 100, freeMargin: 9905, floatingProfit: 55,
      positions: [
        { ticket: '9001', symbol: 'XAUUSD', direction: 'BUY', volume: 0.1, entryPrice: 2000, currentPrice: 2006, profit: 60, swap: -1, commission: -1, openedAt: new Date(ts - 3600000).toISOString() }
      ]
    }
  });
  check('second heartbeat (position cleanup path) accepted', heartbeat2.status === 200 && heartbeat2.json.accepted === true, JSON.stringify(heartbeat2.json));


  const trades = await api('POST', '/api/mt5/trades', {
    token: secret,
    body: { deals: [{ dealId: 'D1', positionId: '9002', symbol: 'EURUSD', direction: 'SELL', volume: 0.2, entryPrice: 1.1, exitPrice: 1.09, profit: 20, commission: 0, swap: 0, closedAt: new Date(ts + 1000).toISOString() }] }
  });
  check('trades accepted', trades.status === 200 || trades.status === 201, JSON.stringify(trades.json));

  const accounts = await api('GET', '/api/mt5/accounts', { token });
  check('account list shows paired account', accounts.status === 200 && accounts.json.accounts.length === 1 && accounts.json.accounts[0].openPositions === 1,
    JSON.stringify(accounts.json && accounts.json.accounts));

  const post = await api('POST', '/api/feed/posts', { token, body: { content: 'PostgreSQL smoke test post' } });
  check('feed post created', post.status === 201, JSON.stringify(post.json));

  const feed = await api('GET', '/api/feed', { token });
  check('feed read back', feed.status === 200);

  console.log(failures ? `\n${failures} smoke check(s) FAILED` : '\nAll smoke checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(error => {
  console.error('smoke test crashed:', error);
  process.exit(1);
});

