'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const createLoginHandler = require('../login-handler');
const { defaultIsEmailVerified } = require('../login-handler');
const { maskEmail } = require('../email-verification');

const JWT_SECRET = 'login-handler-test-signing-secret';

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', error => (error ? reject(error) : resolve(db)));
  });
}

async function createSchema(db) {
  await new Promise((resolve, reject) => {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        bio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_verified INTEGER NOT NULL DEFAULT 1,
        email_verified_at BIGINT
      );
      CREATE TABLE user_auth_versions (
        user_id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE user_account_access (
        user_id INTEGER PRIMARY KEY,
        suspended_until INTEGER NOT NULL,
        reason TEXT,
        updated_at INTEGER NOT NULL
      );
    `, error => (error ? reject(error) : resolve()));
  });
}

async function createHarness({ adminAuth, sameOrigin = true } = {}) {
  const db = await openDatabase();
  await createSchema(db);
  const cookies = [];
  const admin = adminAuth || {
    matchesEmail: () => false,
    authenticate: async () => null
  };
  const handler = createLoginHandler({
    db,
    jwtSecret: JWT_SECRET,
    adminAuth: admin,
    setAuthCookie: (res, token) => { cookies.push(token); },
    isSameOriginRequest: () => sameOrigin,
    maskEmail
  });

  const app = express();
  app.use(express.json());
  app.post('/api/login', handler);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function login(body, headers = {}) {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async function close() {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }

  return { db, cookies, login, close, run: (sql, params) => run(db, sql, params) };
}

async function addUser(db, { email, password = 'correct-password', verified = 0, username = 'user' }) {
  const hash = await bcrypt.hash(password, 4);
  const result = await run(
    db,
    'INSERT INTO users (username, email, password, bio, email_verified) VALUES (?, ?, ?, ?, ?)',
    [username, email, hash, 'test user', verified]
  );
  return { id: result.lastID, hash };
}

test('an unverified account is rejected only after the correct password', async () => {
  const harness = await createHarness();
  try {
    await addUser(harness.db, { email: 'pending@example.test', verified: 0 });

    const wrongPassword = await harness.login({
      email: 'pending@example.test',
      password: 'wrong-password'
    });
    assert.equal(wrongPassword.response.status, 400);
    assert.equal(wrongPassword.data.error, 'Email or password is incorrect.');
    assert.equal(wrongPassword.data.code, undefined);

    const correctPassword = await harness.login({
      email: 'PENDING@example.test',
      password: 'correct-password'
    });
    assert.equal(correctPassword.response.status, 403);
    assert.equal(correctPassword.data.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(correctPassword.data.emailMasked, maskEmail('pending@example.test'));
    assert.equal(Object.prototype.hasOwnProperty.call(correctPassword.data, 'token'), false);
    assert.equal(harness.cookies.length, 0);
  } finally {
    await harness.close();
  }
});

test('a verified account receives a signed session token and cookie', async () => {
  const harness = await createHarness();
  try {
    const user = await addUser(harness.db, {
      email: 'verified@example.test',
      verified: 1,
      username: 'verified'
    });
    const result = await harness.login({
      email: 'verified@example.test',
      password: 'correct-password',
      rememberMe: false
    });

    assert.equal(result.response.status, 200);
    assert.ok(result.data.token);
    assert.equal(result.data.user.email, 'verified@example.test');
    assert.equal(result.data.user.username, 'verified');
    assert.equal(harness.cookies.length, 1);
    assert.equal(harness.cookies[0], result.data.token);

    const decoded = jwt.verify(result.data.token, JWT_SECRET);
    assert.equal(decoded.id, user.id);
    assert.equal(decoded.email, 'verified@example.test');
    assert.equal(decoded.authVersion, 0);
  } finally {
    await harness.close();
  }
});

test('unknown accounts and oversized passwords return the generic login error', async () => {
  const harness = await createHarness();
  try {
    const unknown = await harness.login({
      email: 'missing@example.test',
      password: 'correct-password'
    });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.data.error, 'Email or password is incorrect.');

    await addUser(harness.db, { email: 'long@example.test', verified: 1 });
    const oversized = await harness.login({
      email: 'long@example.test',
      password: 'x'.repeat(73)
    });
    assert.equal(oversized.response.status, 400);
    assert.equal(oversized.data.error, 'Email or password is incorrect.');

    const empty = await harness.login({ email: '', password: '' });
    assert.equal(empty.response.status, 400);
    assert.equal(empty.data.error, 'Please enter your email and password.');
  } finally {
    await harness.close();
  }
});

test('legacy users without the email_verified column remain authorised', async () => {
  assert.equal(defaultIsEmailVerified({}), true);
  assert.equal(defaultIsEmailVerified({ email_verified: undefined }), true);
  assert.equal(defaultIsEmailVerified({ email_verified: null }), true);
  assert.equal(defaultIsEmailVerified({ email_verified: 1 }), true);
  assert.equal(defaultIsEmailVerified({ email_verified: true }), true);
  assert.equal(defaultIsEmailVerified({ email_verified: 't' }), true);
  assert.equal(defaultIsEmailVerified({ email_verified: 0 }), false);
  assert.equal(defaultIsEmailVerified({ email_verified: false }), false);
});

test('administrator login is not affected by the email-verification gate', async () => {
  const adminAuth = {
    matchesEmail: email => email === 'admin@example.test',
    authenticate: async (email, password) => (
      email === 'admin@example.test' && password === 'admin-password'
        ? jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '1h' })
        : null
    )
  };
  const harness = await createHarness({ adminAuth });
  try {
    const result = await harness.login({
      email: 'admin@example.test',
      password: 'admin-password'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.user.role, 'admin');
    assert.equal(harness.cookies.length, 1);
  } finally {
    await harness.close();
  }
});

test('cross-origin login does not set an authentication cookie', async () => {
  const harness = await createHarness({ sameOrigin: false });
  try {
    await addUser(harness.db, { email: 'verified@example.test', verified: 1 });
    const result = await harness.login({
      email: 'verified@example.test',
      password: 'correct-password'
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.token !== undefined, true);
    assert.equal(harness.cookies.length, 0);
  } finally {
    await harness.close();
  }
});
