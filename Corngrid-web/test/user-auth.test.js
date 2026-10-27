'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const createUserAuth = require('../user-auth');

const JWT_SECRET = 'user-auth-test-signing-secret';

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, error => (error ? reject(error) : resolve()));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', error => (error ? reject(error) : resolve(db)));
  });
}

async function createSchema(db, { withVerification = true } = {}) {
  const verificationColumns = withVerification
    ? 'email_verified INTEGER NOT NULL DEFAULT 1, email_verified_at BIGINT,'
    : '';
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
        ${verificationColumns}
        legacy_marker TEXT
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

async function startApp(db) {
  const verifyToken = createUserAuth({ db, jwtSecret: JWT_SECRET });
  const app = express();
  app.get('/protected', verifyToken, (req, res) => res.json({
    ok: true,
    id: req.user.id
  }));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function addUser(db, { email, verified = 1, suspendedUntil = null, includeVerification = true }) {
  const result = await new Promise((resolve, reject) => {
    const sql = includeVerification
      ? 'INSERT INTO users (username, email, password, email_verified) VALUES (?, ?, ?, ?)'
      : 'INSERT INTO users (username, email, password) VALUES (?, ?, ?)';
    const params = includeVerification
      ? [email.split('@')[0], email, 'hash', verified]
      : [email.split('@')[0], email, 'hash'];
    db.run(sql, params, function onInsert(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, email });
    });
  });
  if (suspendedUntil !== null) {
    await run(
      db,
      'INSERT INTO user_account_access (user_id, suspended_until, reason, updated_at) VALUES (?, ?, ?, ?)',
      [result.id, suspendedUntil, 'test', Date.now()]
    );
  }
  return result;
}

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.email.split('@')[0], authVersion: 0 },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

test('protected APIs reject authenticated but unverified accounts', async () => {
  const db = await openDatabase();
  await createSchema(db);
  const { server, origin } = await startApp(db);
  try {
    const user = await addUser(db, { email: 'pending@example.test', verified: 0 });
    const response = await fetch(`${origin}/protected`, {
      headers: { Authorization: `Bearer ${tokenFor(user)}` }
    });
    const data = await response.json();
    assert.equal(response.status, 403);
    assert.equal(data.code, 'EMAIL_NOT_VERIFIED');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('protected APIs allow verified accounts and still enforce suspension', async () => {
  const db = await openDatabase();
  await createSchema(db);
  const { server, origin } = await startApp(db);
  try {
    const verified = await addUser(db, { email: 'verified@example.test', verified: 1 });
    const allowed = await fetch(`${origin}/protected`, {
      headers: { Authorization: `Bearer ${tokenFor(verified)}` }
    });
    assert.equal(allowed.status, 200);

    const suspended = await addUser(db, {
      email: 'suspended@example.test',
      verified: 1,
      suspendedUntil: Date.now() + 60_000
    });
    const blocked = await fetch(`${origin}/protected`, {
      headers: { Authorization: `Bearer ${tokenFor(suspended)}` }
    });
    const data = await blocked.json();
    assert.equal(blocked.status, 403);
    assert.match(data.error, /suspended/i);
    assert.equal(data.code, undefined);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('legacy schemas without the verification column keep existing sessions working', async () => {
  const db = await openDatabase();
  await createSchema(db, { withVerification: false });
  const { server, origin } = await startApp(db);
  try {
    const user = await addUser(db, { email: 'legacy@example.test', includeVerification: false });
    const response = await fetch(`${origin}/protected`, {
      headers: { Authorization: `Bearer ${tokenFor(user)}` }
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('missing, malformed, and expired tokens are rejected', async () => {
  const db = await openDatabase();
  await createSchema(db);
  const { server, origin } = await startApp(db);
  try {
    const missing = await fetch(`${origin}/protected`);
    assert.equal(missing.status, 401);

    const malformed = await fetch(`${origin}/protected`, {
      headers: { Authorization: 'Bearer not-a-token' }
    });
    assert.equal(malformed.status, 403);

    const expired = jwt.sign({ id: 1, email: 'x@example.test', authVersion: 0 }, JWT_SECRET, {
      expiresIn: -1
    });
    const expiredResponse = await fetch(`${origin}/protected`, {
      headers: { Authorization: `Bearer ${expired}` }
    });
    assert.equal(expiredResponse.status, 403);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});
