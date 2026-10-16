const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const createAdminAuth = require('../admin-auth');
const registerAdminApi = require('../admin-api');

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
      user_id INTEGER NOT NULL,
      account_number TEXT NOT NULL,
      last_heartbeat INTEGER
    );
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
    'INSERT INTO mt5_accounts (id, user_id, account_number, last_heartbeat) VALUES (101, 1, ?, ?)',
    ['MT5-SECRET-ALICE-1', freshHeartbeat]
  );
  await execute(db,
    'INSERT INTO mt5_accounts (id, user_id, account_number, last_heartbeat) VALUES (102, 1, ?, ?)',
    ['MT5-SECRET-ALICE-2', freshHeartbeat - 3600 * 1000]
  );
  await execute(db,
    'INSERT INTO mt5_accounts (id, user_id, account_number) VALUES (201, 2, ?)',
    ['MT5-SECRET-BOB']
  );
  await execute(db, 'INSERT INTO public_portfolio_accounts (user_id, account_id) VALUES (1, 101)');

  const app = express();
  registerAdminApi(app, db, adminAuth.verifyToken.bind(adminAuth), 180);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token) => fetch(`${origin}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });

  try {
    assert.equal(await adminAuth.authenticate('admin@example.test', 'wrong-password'), null);
    const token = await adminAuth.authenticate('ADMIN@example.test', 'correct-admin-password');
    assert.ok(token);
    assert.equal((await request('/api/admin/overview')).status, 401);

    const userToken = jwt.sign({ id: 1, role: 'user' }, jwtSecret);
    assert.equal((await request('/api/admin/overview', userToken)).status, 403);
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
      const rotatedResponse = await fetch(`http://127.0.0.1:${rotatedServer.address().port}/admin-check`, {
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
