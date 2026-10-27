'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const createEmailVerification = require('../email-verification');

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows || [])));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', error => (error ? reject(error) : resolve(db)));
  });
}

async function createBaseUsersTable(db) {
  await new Promise((resolve, reject) => {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        bio TEXT DEFAULT 'CornGrid EA Terminal user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `, error => (error ? reject(error) : resolve()));
  });
}

function extractPin(message) {
  const match = String(message.text || '').match(/\b(\d{6})\b/);
  assert.ok(match, 'verification email should contain a 6-digit PIN');
  return match[1];
}

async function createHarness(overrides = {}) {
  const db = await openDatabase();
  await createBaseUsersTable(db);

  const mails = [];
  const logs = [];
  const logger = {
    error(...args) { logs.push(args.map(String).join(' ')); },
    warn(...args) { logs.push(args.map(String).join(' ')); },
    info() {}
  };
  const sendMail = typeof overrides.sendMail === 'function'
    ? overrides.sendMail
    : async message => { mails.push(message); };

  const options = {
    db,
    logger,
    sendMail,
    smtpFrom: 'CornGrid <security@corngrid.test>',
    otpPepper: 'test-otp-pepper-that-is-not-the-jwt-secret',
    bcryptRounds: 4,
    otpTtlSeconds: 600,
    maxAttempts: 5,
    resendCooldownSeconds: 60,
    hourlyLimitPerEmail: 100,
    hourlyLimitPerIp: 100,
    isReservedEmail: email => email === 'admin@example.test',
    ...overrides,
    db,
    logger: overrides.logger || logger,
    sendMail
  };

  const emailVerification = createEmailVerification(options);
  await emailVerification.ready();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  emailVerification.registerRoutes(app);

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function request(pathname, body, extraHeaders = {}) {
    const response = await fetch(`${origin}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async function close() {
    emailVerification.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }

  return {
    db, emailVerification, mails, logs, origin, request,
    run: (sql, params) => run(db, sql, params),
    get: (sql, params) => get(db, sql, params),
    all: (sql, params) => all(db, sql, params),
    close
  };
}

async function register(harness, overrides = {}) {
  const payload = {
    username: 'alice',
    email: 'alice@example.test',
    password: 'correct-horse-battery',
    ...overrides
  };
  const result = await harness.request('/api/register', payload);
  return { ...result, payload };
}

test('registration stores a hashed password and a hashed, single-use PIN', async () => {
  const harness = await createHarness();
  try {
    const { response, data, payload } = await register(harness);
    assert.equal(response.status, 201);
    assert.match(data.emailMasked, /^al\*\*\*@example\.test$/);
    assert.equal(data.emailSent, true);
    assert.ok(data.expiresAt > Date.now());
    assert.equal(Object.prototype.hasOwnProperty.call(data, 'pin'), false);
    assert.equal(JSON.stringify(data).includes('correct-horse-battery'), false);

    const user = await harness.get(
      'SELECT id, username, email, password, email_verified, email_verified_at FROM users WHERE email = ?',
      [payload.email]
    );
    assert.ok(user);
    assert.equal(user.email, payload.email);
    assert.equal(user.email_verified, 0);
    assert.equal(user.email_verified_at, null);
    assert.notEqual(user.password, payload.password);
    assert.equal(await bcrypt.compare(payload.password, user.password), true);

    const code = await harness.get(
      'SELECT * FROM email_verification_codes WHERE user_id = ?',
      [user.id]
    );
    assert.ok(code);
    assert.equal(code.attempts, 0);
    assert.equal(code.consumed_at, null);
    assert.equal(code.sent_at !== null, true);
    assert.equal(code.otp_hash.length, 64);
    assert.equal(/^[0-9a-f]{64}$/.test(code.otp_hash), true);
    assert.equal(code.otp_salt.length, 32);

    assert.equal(harness.mails.length, 1);
    const pin = extractPin(harness.mails[0]);
    assert.notEqual(code.otp_hash, pin);
    assert.notEqual(code.otp_hash, `${code.otp_salt}:${pin}`);
    assert.equal(harness.mails[0].to, payload.email);
    assert.match(harness.mails[0].subject, /verify/i);
    assert.equal(harness.logs.some(entry => entry.includes(pin)), false);
  } finally {
    await harness.close();
  }
});

test('existing accounts are migrated as verified without changing their password', async () => {
  const db = await openDatabase();
  await createBaseUsersTable(db);
  const passwordHash = await bcrypt.hash('legacy-password', 4);
  const inserted = await run(
    db,
    'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
    ['legacy', 'legacy@example.test', passwordHash]
  );

  const emailVerification = createEmailVerification({
    db,
    logger: { error() {}, warn() {} },
    sendMail: async () => {},
    otpPepper: 'legacy-test-pepper',
    bcryptRounds: 4
  });

  try {
    await emailVerification.ready();
    const user = await get(db, 'SELECT * FROM users WHERE id = ?', [inserted.lastID]);
    assert.equal(user.email_verified, 1);

    const registration = await run(
      db,
      'INSERT INTO users (username, email, password, email_verified) VALUES (?, ?, ?, ?)',
      ['new-user', 'new@example.test', passwordHash, 0]
    );
    const newUser = await get(db, 'SELECT email_verified FROM users WHERE id = ?', [registration.lastID]);
    assert.equal(newUser.email_verified, 0);
  } finally {
    emailVerification.close();
    await new Promise(resolve => db.close(resolve));
  }
});

test('a correct PIN verifies the account, consumes the code, and cannot be reused', async () => {
  const harness = await createHarness();
  try {
    await register(harness);
    const user = await harness.get('SELECT id, email_verified FROM users WHERE email = ?', ['alice@example.test']);
    const pin = extractPin(harness.mails[0]);

    const verified = await harness.request('/api/verify-email', { email: 'ALICE@example.test', pin });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.data.verified, true);

    const updatedUser = await harness.get(
      'SELECT email_verified, email_verified_at FROM users WHERE id = ?',
      [user.id]
    );
    assert.equal(updatedUser.email_verified, 1);
    assert.equal(Number.isSafeInteger(updatedUser.email_verified_at) || updatedUser.email_verified_at > 0, true);

    const code = await harness.get('SELECT * FROM email_verification_codes WHERE user_id = ?', [user.id]);
    assert.equal(code.consumed_at !== null, true);
    assert.equal(code.otp_hash, '');

    const replay = await harness.request('/api/verify-email', { email: 'alice@example.test', pin });
    assert.equal(replay.response.status, 400);
    assert.equal(replay.data.error, 'The verification code is invalid or has expired.');
  } finally {
    await harness.close();
  }
});

test('a wrong PIN increments attempts and a later correct PIN still works', async () => {
  const harness = await createHarness();
  try {
    await register(harness);
    const pin = extractPin(harness.mails[0]);
    const wrongPin = pin === '000000' ? '000001' : '000000';

    const wrong = await harness.request('/api/verify-email', { email: 'alice@example.test', pin: wrongPin });
    assert.equal(wrong.response.status, 400);
    assert.equal(wrong.data.error, 'The verification code is invalid or has expired.');
    const code = await harness.get('SELECT attempts, consumed_at FROM email_verification_codes WHERE user_id = 1');
    assert.equal(code.attempts, 1);
    assert.equal(code.consumed_at, null);

    const correct = await harness.request('/api/verify-email', { email: 'alice@example.test', pin });
    assert.equal(correct.response.status, 200);
  } finally {
    await harness.close();
  }
});

test('the PIN is exhausted after the configured number of wrong attempts', async () => {
  const harness = await createHarness({ maxAttempts: 3 });
  try {
    await register(harness);
    const pin = extractPin(harness.mails[0]);
    const wrongPin = pin === '111111' ? '111112' : '111111';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await harness.request('/api/verify-email', { email: 'alice@example.test', pin: wrongPin });
      assert.equal(response.response.status, 400);
    }

    const code = await harness.get('SELECT attempts, consumed_at, otp_hash FROM email_verification_codes WHERE user_id = 1');
    assert.equal(code.attempts, 3);
    assert.equal(code.consumed_at !== null, true);
    assert.equal(code.otp_hash, '');

    const correct = await harness.request('/api/verify-email', { email: 'alice@example.test', pin });
    assert.equal(correct.response.status, 400);
    const user = await harness.get('SELECT email_verified FROM users WHERE id = 1');
    assert.equal(user.email_verified, 0);
  } finally {
    await harness.close();
  }
});

test('expired PINs are rejected and do not verify the account', async () => {
  const harness = await createHarness();
  try {
    await register(harness);
    const pin = extractPin(harness.mails[0]);
    await harness.run(
      'UPDATE email_verification_codes SET expires_at = ? WHERE user_id = 1',
      [Date.now() - 1]
    );

    const response = await harness.request('/api/verify-email', { email: 'alice@example.test', pin });
    assert.equal(response.response.status, 400);
    assert.equal(response.data.error, 'The verification code is invalid or has expired.');
    const user = await harness.get('SELECT email_verified FROM users WHERE id = 1');
    assert.equal(user.email_verified, 0);
  } finally {
    await harness.close();
  }
});

test('resending invalidates the previous PIN and respects the cooldown', async () => {
  const harness = await createHarness({ resendCooldownSeconds: 60 });
  try {
    await register(harness);
    const firstPin = extractPin(harness.mails[0]);

    const immediate = await harness.request('/api/resend-verification', { email: 'alice@example.test' });
    assert.equal(immediate.response.status, 429);
    assert.ok(Number(immediate.response.headers.get('retry-after')) >= 1);
    assert.equal(harness.mails.length, 1);

    await harness.run(
      'UPDATE email_verification_requests SET created_at = created_at - 61000 WHERE email = ?',
      ['alice@example.test']
    );

    const resent = await harness.request('/api/resend-verification', { email: 'alice@example.test' });
    assert.equal(resent.response.status, 200);
    assert.equal(
      resent.data.message,
      'If this email needs verification, a new PIN has been sent.'
    );
    assert.equal(harness.mails.length, 2);
    const secondPin = extractPin(harness.mails[1]);
    assert.notEqual(firstPin, secondPin);

    const oldCode = await harness.request('/api/verify-email', { email: 'alice@example.test', pin: firstPin });
    assert.equal(oldCode.response.status, 400);

    const newCode = await harness.request('/api/verify-email', { email: 'alice@example.test', pin: secondPin });
    assert.equal(newCode.response.status, 200);
  } finally {
    await harness.close();
  }
});

test('resend responses are generic for unknown and already-verified addresses', async () => {
  const harness = await createHarness();
  try {
    const unknown = await harness.request('/api/resend-verification', { email: 'nobody@example.test' });
    assert.equal(unknown.response.status, 200);
    assert.equal(unknown.data.message, 'If this email needs verification, a new PIN has been sent.');
    assert.equal(Object.prototype.hasOwnProperty.call(unknown.data, 'emailMasked'), false);
    assert.equal(harness.mails.length, 0);

    await register(harness);
    const pin = extractPin(harness.mails[0]);
    const verified = await harness.request('/api/verify-email', { email: 'alice@example.test', pin });
    assert.equal(verified.response.status, 200);
    const mailsBefore = harness.mails.length;

    await harness.run(
      'UPDATE email_verification_requests SET created_at = created_at - 61000 WHERE email = ?',
      ['alice@example.test']
    );
    const verifiedResend = await harness.request('/api/resend-verification', { email: 'alice@example.test' });
    assert.equal(verifiedResend.response.status, 200);
    assert.equal(verifiedResend.data.message, 'If this email needs verification, a new PIN has been sent.');
    assert.equal(harness.mails.length, mailsBefore);
  } finally {
    await harness.close();
  }
});

test('registration and verification input is validated and reserved emails are rejected', async () => {
  const harness = await createHarness();
  try {
    const invalidUsername = await register(harness, { username: 'a!' });
    assert.equal(invalidUsername.response.status, 400);
    const invalidEmail = await register(harness, { email: 'not-an-email' });
    assert.equal(invalidEmail.response.status, 400);
    const shortPassword = await register(harness, { password: 'short' });
    assert.equal(shortPassword.response.status, 400);
    const longPassword = await register(harness, { password: 'x'.repeat(73) });
    assert.equal(longPassword.response.status, 400);
    const reserved = await register(harness, { email: 'admin@example.test' });
    assert.equal(reserved.response.status, 400);
    assert.equal(harness.mails.length, 0);

    const malformed = await harness.request('/api/verify-email', { email: 'alice@example.test', pin: '12345' });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.data.error, 'The verification code is invalid or has expired.');
  } finally {
    await harness.close();
  }
});

test('registration enforces the in-memory per-IP request limit', async () => {
  const harness = await createHarness({
    registerRateLimit: { limit: 1, windowMs: 60_000 },
    hourlyLimitPerIp: 100
  });
  try {
    const first = await register(harness);
    assert.equal(first.response.status, 201);
    assert.equal(first.data.emailSent, true);

    const second = await register(harness, {
      username: 'bob',
      email: 'bob@example.test'
    });
    assert.equal(second.response.status, 429);
    assert.ok(Number(second.response.headers.get('retry-after')) >= 1);
    const users = await harness.all('SELECT id FROM users');
    assert.equal(users.length, 1);
  } finally {
    await harness.close();
  }
});

test('registration enforces the database per-IP hourly limit', async () => {
  const harness = await createHarness({
    registerRateLimit: { limit: 100, windowMs: 60_000 },
    hourlyLimitPerIp: 1
  });
  try {
    const first = await register(harness);
    assert.equal(first.response.status, 201);

    const second = await register(harness, {
      username: 'bob',
      email: 'bob@example.test'
    });
    assert.equal(second.response.status, 429);
    assert.match(second.data.error, /too many verification emails/i);
    const users = await harness.all('SELECT id FROM users');
    assert.equal(users.length, 1);
  } finally {
    await harness.close();
  }
});

test('resending enforces the per-email hourly limit', async () => {
  const harness = await createHarness({ hourlyLimitPerEmail: 1 });
  try {
    await register(harness);
    assert.equal(harness.mails.length, 1);
    await harness.run(
      'UPDATE email_verification_requests SET created_at = created_at - 61000 WHERE email = ?',
      ['alice@example.test']
    );

    const limited = await harness.request('/api/resend-verification', { email: 'alice@example.test' });
    assert.equal(limited.response.status, 429);
    assert.match(limited.data.error, /wait before requesting/i);
    assert.equal(harness.mails.length, 1);
  } finally {
    await harness.close();
  }
});

test('verification and resend endpoints have their own rate limits', async () => {
  const harness = await createHarness({
    verifyRateLimit: { limit: 1, windowMs: 60_000 },
    resendRateLimit: { limit: 1, windowMs: 60_000 },
    resendCooldownSeconds: 1
  });
  try {
    const firstVerify = await harness.request('/api/verify-email', {
      email: 'alice@example.test',
      pin: '123456'
    });
    assert.equal(firstVerify.response.status, 400);
    const secondVerify = await harness.request('/api/verify-email', {
      email: 'alice@example.test',
      pin: '123456'
    });
    assert.equal(secondVerify.response.status, 429);

    const firstResend = await harness.request('/api/resend-verification', {
      email: 'nobody@example.test'
    });
    assert.equal(firstResend.response.status, 200);
    const secondResend = await harness.request('/api/resend-verification', {
      email: 'nobody2@example.test'
    });
    assert.equal(secondResend.response.status, 429);
  } finally {
    await harness.close();
  }
});

test('requests from an untrusted browser origin are rejected', async () => {
  const harness = await createHarness();
  try {
    const rejected = await harness.request(
      '/api/register',
      { username: 'mallory', email: 'mallory@example.test', password: 'long-enough-password' },
      { Origin: 'https://attacker.example' }
    );
    assert.equal(rejected.response.status, 403);
    const users = await harness.all('SELECT id FROM users');
    assert.equal(users.length, 0);

    const trusted = await harness.request(
      '/api/register',
      { username: 'alice', email: 'alice@example.test', password: 'long-enough-password' },
      { Origin: harness.origin }
    );
    assert.equal(trusted.response.status, 201);
  } finally {
    await harness.close();
  }
});

test('an undeliverable verification email does not leave an active PIN', async () => {
  let attempts = 0;
  const harness = await createHarness({
    sendMail: async () => {
      attempts += 1;
      throw new Error('SMTP unavailable for test');
    }
  });
  try {
    const { response, data } = await register(harness);
    assert.equal(response.status, 201);
    assert.equal(data.emailSent, false);
    assert.equal(data.expiresAt, null);
    assert.equal(attempts, 1);
    const user = await harness.get('SELECT id, email_verified FROM users WHERE email = ?', ['alice@example.test']);
    assert.ok(user);
    assert.equal(user.email_verified, 0);
    const code = await harness.get('SELECT user_id FROM email_verification_codes WHERE user_id = ?', [user.id]);
    assert.equal(code, undefined);
    assert.equal(harness.logs.some(entry => entry.includes('SMTP unavailable for test')), false);
  } finally {
    await harness.close();
  }
});

test('registration is unavailable when no mail transport is configured', async () => {
  const db = await openDatabase();
  await createBaseUsersTable(db);
  const emailVerification = createEmailVerification({
    db,
    logger: { error() {}, warn() {} },
    sendMail: null,
    otpPepper: 'no-mail-test-pepper',
    bcryptRounds: 4
  });
  const app = express();
  app.use(express.json());
  emailVerification.registerRoutes(app);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await emailVerification.ready();
    const response = await fetch(`${origin}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'alice',
        email: 'alice@example.test',
        password: 'long-enough-password'
      })
    });
    assert.equal(response.status, 503);
    const users = await get(db, 'SELECT COUNT(*) AS count FROM users');
    assert.equal(users.count, 0);
  } finally {
    emailVerification.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});
