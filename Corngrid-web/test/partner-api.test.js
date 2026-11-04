const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const registerMt5Api = require('../mt5-api');
const createUserAuth = require('../user-auth');
const createSubscriptionApi = require('../subscriptions/subscription-api');
const { createSandboxSystem } = require('../sandbox');
const { createPartnerSystem } = require('../partner');

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

function rateLimit() {
  return (_req, _res, next) => next();
}

async function createFixture() {
  const db = await openDatabase();
  const app = express();
  const jwtSecret = 'partner-test-secret';
  app.use(express.json({ limit: '30mb' }));

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
                 VALUES (1, 'Partner', 'partner@example.test', 'x', '', CURRENT_TIMESTAMP)`);
  await run(db, `INSERT INTO users (id, username, email, password, bio, created_at)
                 VALUES (2, 'Trader', 'trader@example.test', 'x', '', CURRENT_TIMESTAMP)`);

  const verifyToken = createUserAuth({ db, jwtSecret });
  const mt5 = registerMt5Api(app, db, verifyToken);
  const adminAuth = {
    verifyToken: (req, res, next) => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      jwt.verify(token, jwtSecret, (error, claims) => {
        if (error || !claims || claims.sub !== 'admin' || claims.role !== 'admin') {
          return res.status(403).json({ error: 'Administrator session is invalid or has expired.' });
        }
        req.admin = { id: 99, role: 'admin' };
        next();
      });
    }
  };
  const subscriptionApi = createSubscriptionApi(app, db, verifyToken, adminAuth, mt5.authenticateInstallation);
  await subscriptionApi.ready();

  const sandbox = createSandboxSystem(app, db, { verifyToken, adminAuth, subscriptionApi, rateLimit, jwtSecret });
  await sandbox.ready;
  const partner = createPartnerSystem(app, db, {
    verifyToken, adminAuth,
    events: sandbox.events, nodes: sandbox.nodes, crypto: sandbox.crypto,
    subscriptionApi, rateLimit,
    authenticateNodeRequest: sandbox.nodeApi.authenticateNodeRequest
  });

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const partnerToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const traderToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);
  const adminToken = jwt.sign({ sub: 'admin', role: 'admin' }, jwtSecret);

  const request = async (route, { token, method = 'GET', body, headers = {} } = {}) => {
    const finalHeaders = { ...headers };
    if (token) finalHeaders.Authorization = 'Bearer ' + token;
    if (body) finalHeaders['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method,
      headers: finalHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, body: json };
  };

  return { db, server, request, partnerToken, traderToken, adminToken, sandbox, partner, subscriptionApi };
}

const VALID_MQ5 = `//+------------------------------------------------------------------+
//| Sample EA                                                        |
//+------------------------------------------------------------------+
input int TakeProfit = 100;
int OnInit() { return INIT_SUCCEEDED; }
void OnTick() { }
`;

const MALICIOUS_MQ5 = `// evil
#import "evil_custom.dll"
void OnTick() { WinExec("calc.exe", 1); }
`;

test('partner registration, EA submission, scanning, and review workflow', async () => {
  const { server, request, partnerToken, traderToken, adminToken } = await createFixture();
  try {
    // Non-partner cannot submit.
    const noPartner = await request('/api/partner/submissions', {
      token: traderToken, method: 'POST', body: { name: 'X', version: '1.0', description: '0123456789', files: [{ name: 'a.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }] }
    });
    assert.equal(noPartner.status, 403);
    assert.equal(noPartner.body.code, 'NOT_A_PARTNER');

    // Register as partner.
    const registered = await request('/api/partner/register', {
      token: partnerToken, method: 'POST', body: { displayName: 'EA Wizard', company: 'Wizard Labs' }
    });
    assert.equal(registered.status, 201);

    // Submit a clean EA.
    const submitted = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: {
        name: 'Grid Master', version: '1.0', description: 'A grid trading EA for XAUUSD.',
        symbols: 'XAUUSD', files: [{ name: 'GridMaster.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }]
      }
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.scanFindings.length, 0);
    const submissionUid = submitted.body.submissionUid;

    // Submit a malicious EA — the scanner flags it.
    const malicious = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: {
        name: 'Evil EA', version: '1.0', description: 'Does bad things.',
        files: [{ name: 'evil.mq5', contentBase64: Buffer.from(MALICIOUS_MQ5).toString('base64') }]
      }
    });
    assert.equal(malicious.status, 201);
    assert.ok(malicious.body.scanFindings.length >= 2); // DLL import + WinExec

    // Reject bad file types.
    const badType = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: { name: 'Bad', version: '1.0', description: 'bad file type test', files: [{ name: 'virus.exe', contentBase64: Buffer.from('MZ').toString('base64') }] }
    });
    assert.equal(badType.status, 400);

    // Admin sees the submissions.
    const list = await request('/api/admin/ea-submissions', { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.submissions.length, 2);
    const target = list.body.submissions.find(s => s.submissionUid === submissionUid);
    assert.equal(target.status, 'pending_review');
    assert.equal(target.partnerName, 'EA Wizard');

    // Review workflow: review -> approve -> publish.
    await request(`/api/admin/ea-submissions/${target.id}/review`, { token: adminToken, method: 'POST' });
    const approved = await request(`/api/admin/ea-submissions/${target.id}/approve`, { token: adminToken, method: 'POST' });
    assert.equal(approved.status, 200);
    const published = await request(`/api/admin/ea-submissions/${target.id}/publish`, { token: adminToken, method: 'POST' });
    assert.equal(published.status, 200);
    assert.ok(published.body.strategyCode.startsWith('partner-'));

    // The published strategy is now selectable by users.
    const strategies = await request('/api/sandbox/strategies', { token: traderToken });
    assert.ok(strategies.body.strategies.some(s => s.code === published.body.strategyCode));

    // Rejection requires a reason.
    const rejected = await request(`/api/admin/ea-submissions/${target.id}/reject`, { token: adminToken, method: 'POST', body: { reason: '' } });
    assert.equal(rejected.status, 400);
  } finally {
    server.close();
  }
});

test('commission generation, idempotency, approval, and payout settlement', async () => {
  const { db, server, request, partnerToken, traderToken, adminToken, subscriptionApi } = await createFixture();
  try {
    // Partner registers and publishes an EA.
    await request('/api/partner/register', { token: partnerToken, method: 'POST', body: { displayName: 'EA Wizard' } });
    const submitted = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: { name: 'Grid Master', version: '1.0', description: 'A grid trading EA.', files: [{ name: 'g.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }] }
    });
    const list = await request('/api/admin/ea-submissions', { token: adminToken });
    const sub = list.body.submissions.find(s => s.submissionUid === submitted.body.submissionUid);
    await request(`/api/admin/ea-submissions/${sub.id}/review`, { token: adminToken, method: 'POST' });
    await request(`/api/admin/ea-submissions/${sub.id}/approve`, { token: adminToken, method: 'POST' });
    const published = await request(`/api/admin/ea-submissions/${sub.id}/publish`, { token: adminToken, method: 'POST' });
    const strategyCode = published.body.strategyCode;

    // Admin configures a 40% commission rule for the partner.
    const rule = await request('/api/admin/commissions', {
      token: adminToken, method: 'POST',
      body: { partnerId: 1, model: 'percent', percent: 40, appliesTo: 'both', minPayoutThreshold: 50 }
    });
    assert.equal(rule.status, 201);

    // Trader gets a subscription and runs the partner strategy in a sandbox.
    const now = Date.now();
    await run(db, `INSERT INTO subscription_plans (id, name, price, currency, duration_days, max_activations, is_active, created_at, updated_at)
                   VALUES (1, 'Pro', 100, 'MYR', 30, 5, 1, ?, ?)`, [now, now]);
    await run(db, `INSERT INTO user_subscriptions (id, user_id, plan_id, status, purchase_price, currency, starts_at, expires_at, created_at, updated_at)
                   VALUES (1, 2, 1, 'active', 100, 'MYR', ?, ?, ?, ?)`, [now - 1000, now + 86400000, now, now]);
    const strategy = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM trading_strategies WHERE code = ?', [strategyCode], (e, row) => (e ? reject(e) : resolve(row)));
    });
    await run(db, `INSERT INTO sandbox_instances (instance_uid, user_id, strategy_id, status, created_at, updated_at)
                   VALUES ('sbx_aaaaaaaaaaaaaaaaaa', 2, ?, 'running', ?, ?)`, [strategy.id, now, now]);

    // Simulate an approved payment through the hook.
    await run(db, `INSERT INTO subscription_payments (id, user_id, subscription_id, plan_id, amount, currency, status, created_at, updated_at)
                   VALUES (1, 2, 1, 1, 100, 'MYR', 'approved', ?, ?)`, [now, now]);
    const payment = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM subscription_payments WHERE id = 1', (e, row) => (e ? reject(e) : resolve(row)));
    });
    const { createCommissionService } = require('../partner/commission-service');
    const service = createCommissionService({ db, events: { emit: async () => {} } });
    await service.handlePaymentApproved(payment);

    // Commission: 40% of RM100 = RM40.
    let tx = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM partner_transactions WHERE partner_id = 1', (e, row) => (e ? reject(e) : resolve(row)));
    });
    assert.ok(tx);
    assert.equal(tx.commission_amount, 40);
    assert.equal(tx.gross_amount, 100);
    assert.equal(tx.status, 'pending');

    // Idempotent: replaying the same payment does not create a duplicate.
    await service.handlePaymentApproved(payment);
    const count = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS c FROM partner_transactions WHERE partner_id = 1', (e, row) => (e ? reject(e) : resolve(row.c)));
    });
    assert.equal(count, 1);

    // Admin approves the commission.
    const approve = await request(`/api/admin/commissions/transactions/${tx.id}/status`, {
      token: adminToken, method: 'POST', body: { status: 'approved' }
    });
    assert.equal(approve.status, 200);

    // Record a payout of RM40 — settles the approved transaction.
    const payout = await request('/api/admin/payouts', {
      token: adminToken, method: 'POST', body: { partnerId: 1, amount: 40, method: 'duitnow', reference: 'REF123' }
    });
    assert.equal(payout.status, 201);
    assert.equal(payout.body.settledTransactions, 1);

    // The transaction is now paid; the balance is zero.
    tx = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM partner_transactions WHERE id = ?', [tx.id], (e, row) => (e ? reject(e) : resolve(row)));
    });
    assert.equal(tx.status, 'paid');
    const balance = await service.availableBalance(1);
    assert.equal(balance, 0);

    // Over-payout is refused.
    const overpay = await request('/api/admin/payouts', {
      token: adminToken, method: 'POST', body: { partnerId: 1, amount: 500 }
    });
    assert.equal(overpay.status, 409);

    // Partner sees the earnings.
    const overview = await request('/api/partner/overview', { token: partnerToken });
    assert.equal(overview.body.earnings.paidTotal, 40);
  } finally {
    server.close();
  }
});
