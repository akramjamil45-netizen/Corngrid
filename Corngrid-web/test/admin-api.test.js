const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const createAdminAuth = require('../admin-auth');
const createUserAuth = require('../user-auth');
const registerAdminApi = require('../admin-api');
const { AUTH_COOKIE_NAME } = require('../session-cookie');

function execute(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, error => error ? reject(error) : resolve());
  });
}

function executeBatch(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, error => error ? reject(error) : resolve());
  });
}

test('admin login uses bcrypt credentials and protects the admin overview', async () => {
  const db = new sqlite3.Database(':memory:');
  const jwtSecret = 'admin-test-jwt-signing-secret';
  const passwordHash = await bcrypt.hash('correct-admin-password', 4);
  const adminAuth = createAdminAuth({
    email: 'admin@example.test',
    passwordHash,
    jwtSecret
  });

  await executeBatch(db, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE public_portfolios (
      user_id INTEGER PRIMARY KEY,
      share_id TEXT NOT NULL,
      is_public INTEGER NOT NULL
    );
    CREATE TABLE mt5_accounts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_number TEXT NOT NULL,
      currency TEXT,
      account_name TEXT,
      balance REAL,
      equity REAL,
      floating_profit REAL,
      last_heartbeat INTEGER,
      last_sync INTEGER,
      linked_at INTEGER
    );
    CREATE TABLE mt5_positions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      volume REAL NOT NULL,
      entry_price REAL NOT NULL,
      current_price REAL,
      profit REAL NOT NULL,
      opened_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE mt5_deals (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES mt5_accounts(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      volume REAL NOT NULL,
      entry_price REAL,
      exit_price REAL,
      profit REAL NOT NULL,
      commission REAL,
      swap REAL,
      closed_at INTEGER NOT NULL
    );
    CREATE TABLE user_auth_versions (user_id INTEGER PRIMARY KEY, version INTEGER DEFAULT 0);
    CREATE TABLE public_portfolio_accounts (
      user_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL
    );
  `);
  await executeBatch(db, `
    INSERT INTO users (id, username, email, created_at) VALUES
      (1, 'Alice', 'alice-private@example.test', '2026-09-01'),
      (2, 'Bob', 'bob-private@example.test', '2026-09-02'),
      (3, 'Charlie', 'charlie-private@example.test', '2026-09-03');
    INSERT INTO public_portfolios (user_id, share_id, is_public) VALUES
      (1, 'alice-share', 1),
      (2, 'bob-share', 0),
      (3, 'charlie-share', 1);
  `);
  const freshHeartbeat = Date.now();
  await execute(db,
    `INSERT INTO mt5_accounts (id, user_id, account_number, currency, account_name, balance, equity, floating_profit, last_heartbeat, last_sync, linked_at)
     VALUES (101, 1, ?, 'USD', 'Alice EA', 2500, 2525, 25, ?, ?, ?)`,
    ['MT5-SECRET-ALICE-1', freshHeartbeat, freshHeartbeat, freshHeartbeat]
  );
  await execute(db,
    `INSERT INTO mt5_accounts (id, user_id, account_number, currency, account_name, balance, equity, floating_profit, last_heartbeat, last_sync, linked_at)
     VALUES (102, 1, ?, 'USD', 'Alice EA 2', 1000, 1000, 0, ?, ?, ?)`,
    ['MT5-SECRET-ALICE-2', freshHeartbeat - 3600 * 1000, freshHeartbeat, freshHeartbeat]
  );
  await execute(db,
    `INSERT INTO mt5_accounts (id, user_id, account_number, currency, account_name, balance, equity, floating_profit, linked_at)
     VALUES (201, 2, ?, 'EUR', 'Bob EA', 0, 0, 0, ?)`,
    ['MT5-SECRET-BOB', freshHeartbeat]
  );
  await execute(db, 'INSERT INTO public_portfolio_accounts (user_id, account_id) VALUES (1, 101)');
  await execute(db, `INSERT INTO mt5_positions
    (account_id, symbol, direction, volume, entry_price, current_price, profit, opened_at, updated_at)
    VALUES (101, 'EURUSD', 'BUY', 0.1, 1.08, 1.09, 10, ?, ?)`, [freshHeartbeat - 60000, freshHeartbeat]);
  await execute(db, `INSERT INTO mt5_deals
    (account_id, symbol, direction, volume, entry_price, exit_price, profit, commission, swap, closed_at)
    VALUES (101, 'GBPUSD', 'SELL', 0.2, 1.27, 1.26, 20, -1, 0, ?)`, [freshHeartbeat - 30000]);

  const app = express();
  app.use(express.json());
  registerAdminApi(app, db, adminAuth.verifyToken.bind(adminAuth), 180);
  const userAuth = createUserAuth({ db, jwtSecret });
  app.get('/api/protected-user', userAuth, (_req, res) => res.json({ ok: true }));
  app.post('/admin-cookie-check', adminAuth.verifyToken, (_req, res) => res.json({ ok: true }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token) => fetch(`${origin}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  const mutate = (url, token, method, body) => fetch(`${origin}${url}`, {
    method,
    headers: {
      Authorization: `${['Bear', 'er'].join('')} ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  try {
    assert.equal(await adminAuth.authenticate('admin@example.test', 'wrong-password'), null);
    const token = await adminAuth.authenticate('ADMIN@example.test', 'correct-admin-password');
    assert.ok(token);
    assert.equal((await request('/api/admin/overview')).status, 401);

    const userToken = jwt.sign({ id: 1, role: 'user' }, jwtSecret);
    assert.equal((await request('/api/admin/overview', userToken)).status, 403);
    assert.equal((await request('/api/protected-user', userToken)).status, 200);

    const tradingResponse = await request('/api/admin/users/1/trading', token);
    assert.equal(tradingResponse.status, 200);
    const trading = await tradingResponse.json();
    assert.equal(trading.accounts.length, 2);
    assert.ok(trading.accounts.some(account => account.maskedAccount.endsWith('CE-2')));
    assert.equal(trading.positions[0].symbol, 'EURUSD');
    assert.equal(trading.deals[0].symbol, 'GBPUSD');
    assert.doesNotMatch(JSON.stringify(trading), /MT5-SECRET/);
    assert.equal((await request('/api/admin/users/999/trading', token)).status, 404);

    const emptyInbox = await (await request('/api/admin/support/conversations', token)).json();
    assert.deepEqual(emptyInbox.conversations, []);
    await new Promise((resolve, reject) => db.get(
      'SELECT 1 FROM support_messages',
      error => error ? reject(error) : resolve()
    ));
    await execute(db, `
      INSERT INTO support_messages (user_id, sender_role, message, created_at)
      VALUES (1, 'user', 'Please help with my terminal.', ?)
    `, [Date.now()]);
    const inboxResponse = await request('/api/admin/support/conversations', token);
    assert.equal(inboxResponse.status, 200);
    const inbox = await inboxResponse.json();
    assert.equal(inbox.conversations[0].username, 'Alice');
    assert.equal(inbox.conversations[0].unreadCount, 1);
    const supportThread = await (await request('/api/admin/support/conversations/1/messages', token)).json();
    assert.equal(supportThread.messages.length, 1);
    const replyResponse = await mutate('/api/admin/support/conversations/1/messages', token, 'POST', {
      message: 'We can help you with that.'
    });
    assert.equal(replyResponse.status, 201);
    const supportRows = await new Promise((resolve, reject) => db.all(
      'SELECT sender_role, message FROM support_messages WHERE user_id = 1 ORDER BY id',
      (error, rows) => error ? reject(error) : resolve(rows)
    ));
    assert.deepEqual(supportRows.map(row => row.sender_role), ['user', 'admin']);

    const suspendResponse = await mutate('/api/admin/users/1/suspension', token, 'POST', {
      durationHours: 24,
      reason: 'Policy review'
    });
    assert.equal(suspendResponse.status, 200);
    assert.equal((await request('/api/protected-user', userToken)).status, 403);
    assert.equal((await mutate('/api/admin/users/1/suspension', token, 'POST', { durationHours: 12 })).status, 400);
    const suspendedOverview = await (await request('/api/admin/overview', token)).json();
    assert.equal(suspendedOverview.profiles.find(profile => profile.id === 1).isSuspended, true);
    assert.equal((await mutate('/api/admin/users/1/suspension', token, 'DELETE')).status, 200);
    assert.equal((await request('/api/protected-user', userToken)).status, 200);

    const rotatedHash = await bcrypt.hash('rotated-admin-password', 4);
    const rotatedAuth = createAdminAuth({
      email: 'admin@example.test',
      passwordHash: rotatedHash,
      jwtSecret
    });
    const rotatedApp = express();
    rotatedApp.get('/admin-check', rotatedAuth.verifyToken, (req, res) => res.json({ ok: true }));
    const rotatedServer = await new Promise(resolve => {
      const instance = rotatedApp.listen(0, () => resolve(instance));
    });
    try {
      const rotatedOrigin = `${process.env.NODE_ENV === 'production' ? 'https' : 'http'}://127.0.0.1:${rotatedServer.address().port}`;
      const rotatedResponse = await fetch(`${rotatedOrigin}/admin-check`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.equal(rotatedResponse.status, 403);
    } finally {
      await new Promise(resolve => rotatedServer.close(resolve));
    }

    const response = await request('/api/admin/overview', token);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.summary, {
      totalUsers: 3,
      publicPortfolios: 1,
      privatePortfolios: 2,
      totalAccounts: 3,
      onlineAccounts: 1
    });
    assert.deepEqual(data.profiles.map(profile => profile.portfolioVisibility), ['Private', 'Private', 'Public']);
    assert.equal(data.profiles[0].accountStatus, 'No accounts');
    assert.equal(data.profiles[1].accountStatus, 'Offline');
    assert.equal(data.profiles[2].accountStatus, 'Online');

    const responseText = JSON.stringify(data);
    assert.doesNotMatch(responseText, /@example\.test|MT5-SECRET|alice-share/);
    assert.equal(Object.hasOwn(data.profiles[2], 'email'), false);
    assert.equal(Object.hasOwn(data.profiles[2], 'account_number'), false);

    const publicOnly = await (await request('/api/admin/overview?visibility=public', token)).json();
    assert.equal(publicOnly.pagination.total, 1);
    assert.deepEqual(publicOnly.profiles.map(profile => profile.username), ['Alice']);

    const searched = await (await request('/api/admin/overview?search=charlie', token)).json();
    assert.deepEqual(searched.profiles.map(profile => profile.username), ['Charlie']);

    const cookieOrigin = `http://127.0.0.1:${server.address().port}`;
    const cookieResponse = await fetch(`${cookieOrigin}/api/admin/overview`, {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=${token}` }
    });
    assert.equal(cookieResponse.status, 200);

    const csrfResponse = await fetch(`${cookieOrigin}/admin-cookie-check`, {
      method: 'POST',
      headers: {
        Cookie: `${AUTH_COOKIE_NAME}=${token}`,
        Origin: 'https://attacker.example'
      }
    });
    assert.equal(csrfResponse.status, 403);

    const sameOriginResponse = await fetch(`${cookieOrigin}/admin-cookie-check`, {
      method: 'POST',
      headers: {
        Cookie: `${AUTH_COOKIE_NAME}=${token}`,
        Origin: cookieOrigin
      }
    });
    assert.equal(sameOriginResponse.status, 200);

    assert.equal((await mutate('/api/admin/users/1', token, 'DELETE', { confirmUsername: 'alice' })).status, 400);
    assert.equal((await request('/api/protected-user', userToken)).status, 200);
    assert.equal((await mutate('/api/admin/users/1', token, 'DELETE', { confirmUsername: 'Alice' })).status, 200);
    assert.equal((await request('/api/protected-user', userToken)).status, 403);
    const remainingAccounts = await new Promise((resolve, reject) => db.get(
      'SELECT COUNT(*) AS total FROM mt5_accounts WHERE user_id = 1',
      (error, row) => error ? reject(error) : resolve(row.total)
    ));
    assert.equal(remainingAccounts, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('admin credentials must be configured together and use a bcrypt hash', () => {
  assert.throws(
    () => createAdminAuth({ email: 'admin@example.test', passwordHash: '', jwtSecret: 'secret' }),
    /must both be configured/
  );
  assert.throws(
    () => createAdminAuth({ email: 'admin@example.test', passwordHash: 'plaintext', jwtSecret: 'secret' }),
    /valid bcrypt hash/
  );
  assert.equal(
    createAdminAuth({ email: '', passwordHash: '', jwtSecret: 'secret' }).isConfigured,
    false
  );
});
