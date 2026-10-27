const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const registerMt5Api = require('../mt5-api');
const createUserAuth = require('../user-auth');
const createSubscriptionApi = require('../subscriptions/subscription-api');
const { dbGet, dbRun } = require('../db-async');

const DOWNLOAD_DIR = path.join(__dirname, '..', 'storage', 'ea-downloads');

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', error => (error ? reject(error) : resolve(db)));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this);
    });
  });
}

function insertAccount(db, { id, userId, accountNumber, secret }) {
  return run(db, `
    INSERT INTO mt5_accounts (id, user_id, account_number, broker_server, currency, linked_at)
    VALUES (?, ?, ?, 'TestBroker-Live', 'USD', ?)`,
  [id, userId, accountNumber, Date.now()]).then(() => run(db, `
    INSERT INTO mt5_installations (account_id, secret_hash, created_at)
    VALUES (?, ?, ?)`,
  [id, crypto.createHash('sha256').update(secret).digest('hex'), Date.now()]));
}

test('subscription purchase, approval, license activation, limits, suspension, and download', async () => {
  const db = await openDatabase();
  const app = express();
  const jwtSecret = 'subscription-test-secret';
  app.use(express.json());

  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      email TEXT,
      password TEXT,
      bio TEXT,
      created_at TEXT
    );
  `, error => (error ? reject(error) : resolve())));
  await run(db, `INSERT INTO users (id, username, email, password, bio, created_at)
                 VALUES (1, 'Alice', 'alice@example.test', 'x', '', CURRENT_TIMESTAMP)`);

  const verifyToken = createUserAuth({ db, jwtSecret });
  const mt5 = registerMt5Api(app, db, verifyToken);
  const adminAuth = { verifyToken: (req, _res, next) => { req.admin = { id: 99, role: 'admin' }; next(); } };
  const subscriptions = createSubscriptionApi(app, db, verifyToken, adminAuth, mt5.authenticateInstallation);
  await subscriptions.ready();

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const userToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);

  const request = async (route, { token, secret, method = 'GET', body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  };

  const secrets = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)];
  try {
    await insertAccount(db, { id: 1, userId: 1, accountNumber: '1001', secret: secrets[0] });
    for (let index = 1; index < 6; index += 1) {
      await insertAccount(db, { id: index + 1, userId: 1, accountNumber: String(1001 + index), secret: secrets[index] });
    }

    let response = await request('/api/admin/subscription-plans', {
      method: 'POST',
      body: { name: 'Monthly', price: 99, duration_days: 30, max_activations: 5, currency: 'MYR' }
    });
    assert.equal(response.status, 201);

    response = await request('/api/license/verify', { method: 'POST', secret: '0'.repeat(64), body: {} });
    assert.equal(response.status, 401, 'unknown installation secrets are rejected');

    response = await request('/api/subscription/subscribe', { token: userToken, method: 'POST', body: { planId: 1 } });
    assert.equal(response.status, 201);
    const paymentId = response.data.paymentId;

    response = await request('/api/license/verify', { method: 'POST', secret: secrets[0], body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.data.license_status, 'no_subscription', 'the license stays blocked before approval');

    response = await request('/api/subscription/payment-proof', {
      token: userToken,
      method: 'POST',
      body: { paymentId, paymentReference: 'DUITNOW-TEST-1' }
    });
    assert.equal(response.status, 200);

    response = await request(`/api/admin/subscription-payments/${paymentId}/approve`, { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    const expiresAt = response.data.expiresAt;

    response = await request('/api/license/verify', { method: 'POST', secret: secrets[0], body: {} });
    assert.equal(response.data.license_status, 'not_activated');

    response = await request('/api/license/activate', { method: 'POST', secret: secrets[0], body: {} });
    assert.equal(response.status, 201);
    assert.equal(response.data.license_status, 'active');
    assert.equal(response.data.activation_count, 1);

    response = await request('/api/license/activate', { method: 'POST', secret: secrets[0], body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.data.activation_count, 1, 're-activating the same account is idempotent');

    const parallel = await Promise.all(secrets.slice(1).map(secret =>
      request('/api/license/activate', { method: 'POST', secret, body: {} })));
    const activeCount = parallel.filter(item => item.data.license_status === 'active').length;
    assert.equal(activeCount, 4, 'only the remaining activation slots are granted');
    assert.equal(parallel.filter(item => item.data.license_status === 'limit_reached').length, 1);

    const activationRows = await dbGet(db, `SELECT COUNT(*) AS total FROM ea_license_activations
      WHERE user_id = 1 AND license_status = 'active'`);
    assert.equal(Number(activationRows.total), 5);

    response = await request('/api/subscription/overview', { token: userToken });
    assert.equal(response.data.activationCount, 5);
    assert.equal(response.data.maxActivations, 5);
    assert.equal(response.data.daysRemaining > 0, true);

    response = await request('/api/admin/subscriptions/1/suspend', { method: 'POST', body: { reason: 'Test suspension' } });
    assert.equal(response.status, 200);

    response = await request('/api/license/verify', { method: 'POST', secret: secrets[0], body: {} });
    assert.equal(response.data.license_status, 'suspended', 'suspension is authoritative');

    response = await request('/api/subscription/downloads', { token: userToken });
    assert.equal(response.status, 403, 'suspended subscriptions cannot download');

    response = await request('/api/admin/subscriptions/1/reinstate', { method: 'POST', body: {} });
    assert.equal(response.status, 200);

    response = await request('/api/license/verify', { method: 'POST', secret: secrets[0], body: {} });
    assert.equal(response.data.license_status, 'active');
    assert.equal(response.data.expires_at, expiresAt);

    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const eaFile = path.join(DOWNLOAD_DIR, 'test-build.ex5');
    fs.writeFileSync(eaFile, 'compiled-ea-placeholder');
    await run(db, `INSERT INTO ea_downloads (version, filename, file_path, is_active, created_at, updated_at)
                   VALUES ('9.9.9', 'CornGrid-test.ex5', 'test-build.ex5', 1, ?, ?)`, [Date.now(), Date.now()]);

    response = await request('/api/subscription/downloads', { token: userToken });
    assert.equal(response.status, 200);
    assert.equal(response.data.versions.length, 1);

    const download = await fetch(`${base}/api/subscription/download/1`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'compiled-ea-placeholder');

    response = await request('/api/notifications', { token: userToken });
    assert.equal(response.status, 200);
    assert.ok(response.data.notifications.length >= 2, 'payment and activation notifications are recorded');

    const notificationId = response.data.notifications[0].id;
    response = await request(`/api/notifications/${notificationId}`, { token: userToken, method: 'DELETE' });
    assert.equal(response.status, 200, 'a user can delete their own notification');
    response = await request('/api/notifications', { token: userToken });
    assert.equal(response.data.notifications.some(item => item.id === notificationId), false,
      'deleted notifications no longer appear');

    response = await request('/api/subscription/subscribe', { token: userToken, method: 'POST', body: { planId: 1 } });
    assert.equal(response.status, 201, 'an active subscriber can start a renewal');
    const renewalPaymentId = response.data.paymentId;

    response = await request('/api/subscription/overview', { token: userToken });
    assert.equal(response.data.subscription.status, 'active', 'the active license stays visible while a renewal is pending');
    assert.equal(response.data.subscription.expiresAt, Number(expiresAt), 'a pending renewal does not hide the current expiry');
    assert.equal(response.data.latestPayment.status, 'pending_payment');

    response = await request('/api/subscription/cancel', {
      token: userToken,
      method: 'POST',
      body: { paymentId: renewalPaymentId }
    });
    assert.equal(response.status, 200, 'an unpaid renewal can be cancelled');
    response = await request('/api/subscription/overview', { token: userToken });
    assert.equal(response.data.latestPayment.status, 'cancelled');
    assert.equal(response.data.subscription.status, 'active', 'cancelling a renewal keeps the current license active');
    assert.equal(response.data.subscription.expiresAt, Number(expiresAt));
    response = await request('/api/subscription/cancel', {
      token: userToken,
      method: 'POST',
      body: { paymentId: renewalPaymentId }
    });
    assert.equal(response.status, 409, 'an already cancelled purchase cannot be cancelled again');

    response = await request('/api/subscription/subscribe', { token: userToken, method: 'POST', body: { planId: 1 } });
    assert.equal(response.status, 201);
    const secondRenewalPaymentId = response.data.paymentId;

    await request('/api/subscription/payment-proof', {
      token: userToken,
      method: 'POST',
      body: { paymentId: secondRenewalPaymentId, paymentReference: 'DUITNOW-RENEWAL' }
    });
    response = await request(`/api/admin/subscription-payments/${secondRenewalPaymentId}/approve`, { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    assert.ok(response.data.startsAt >= Number(expiresAt), 'renewal extends from the current expiry');

    response = await request('/api/notifications', { token: userToken, method: 'DELETE' });
    assert.equal(response.status, 200, 'a user can clear all notifications');
    response = await request('/api/notifications', { token: userToken });
    assert.equal(response.data.notifications.length, 0);

    response = await request('/api/subscription/subscribe', { token: userToken, method: 'POST', body: { planId: 1 } });
    assert.equal(response.status, 201);
    const inactiveSubscriptionId = response.data.subscriptionId;
    response = await request(`/api/admin/subscriptions/${inactiveSubscriptionId}`, { method: 'DELETE' });
    assert.equal(response.status, 200, 'an inactive subscription can be deleted');
    response = await request(`/api/admin/subscriptions/${inactiveSubscriptionId}`, { method: 'DELETE' });
    assert.equal(response.status, 404, 'a deleted subscription is no longer listed');
    response = await request('/api/admin/subscriptions/1', { method: 'DELETE' });
    assert.equal(response.status, 409, 'active subscriptions must be revoked instead of deleted');
  } finally {
    const eaFile = path.join(DOWNLOAD_DIR, 'test-build.ex5');
    if (fs.existsSync(eaFile)) fs.unlinkSync(eaFile);
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});
