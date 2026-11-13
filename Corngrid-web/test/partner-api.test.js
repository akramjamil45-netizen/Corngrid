const assert = require('node:assert/strict');
const {dbGet:get}=require('../db-async');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-partner-test-'));
  const sandbox = createSandboxSystem(app, db, { verifyToken, adminAuth, subscriptionApi, rateLimit, jwtSecret, strategyStorageDir:path.join(storageDir,'_deployment') });
  await sandbox.ready;
  const partner = createPartnerSystem(app, db, {
    verifyToken, adminAuth,
    events: sandbox.events, nodes: sandbox.nodes, crypto: sandbox.crypto,
    subscriptionApi, rateLimit,
    storageDir,
    authenticateNodeRequest: sandbox.nodeApi.authenticateNodeRequest
  });
  await partner.ready;

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.on('close', () => {
    if (!path.resolve(storageDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected test storage path');
    fs.rmSync(storageDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const partnerToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const traderToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);
  const adminToken = jwt.sign({ sub: 'admin', role: 'admin' }, jwtSecret);

  const request = async (route, { token, method = 'GET', body, headers = {} } = {}) => {
    if(token===adminToken && /\/api\/admin\/ea-submissions\/\d+\/(approve|publish)$/.test(route) && !body){
      const proof=await partner.publication.inspect(Number(route.split('/')[4]));
      body={reviewDigest:proof?.reviewDigest};
    }
    if(route==='/api/partner/register'&&body&&!Object.hasOwn(body,'agreement')){
      const terms=require('../partner/partner-terms');
      body={...body,agreement:{accepted:true,authority:true,version:terms.document.version,termsHash:terms.hash,language:'en',signerName:'Test Developer'}};
    }
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

const VALID_PRESETS = [{ symbol: 'XAUUSD', name: 'GridMaster.set', contentBase64: Buffer.from('TakeProfit=100\r\n').toString('base64') }];
const EX5_BYTES=Buffer.alloc(128,1);EX5_BYTES.write('EX5',0,'ascii');EX5_BYTES[3]=2;
const EX5_FILE={name:'reviewed.ex5',contentBase64:EX5_BYTES.toString('base64')};

test('partner agreements require explicit current consent and preserve private immutable receipts',async()=>{
 const f=await createFixture();const {request,partnerToken,traderToken,adminToken,db}=f;
 try{
  const t=(await request('/api/partner/terms',{token:partnerToken})).body;
  const accepted={accepted:true,authority:true,version:t.document.version,termsHash:t.termsHash,language:'ms',signerName:'Developer Sebenar'};
  const apply=agreement=>request('/api/partner/register',{token:partnerToken,method:'POST',body:{displayName:'Agreement Developer',company:'CornGrid Test',agreement}});
  for(const agreement of [null,{...accepted,accepted:false},{...accepted,authority:false},{...accepted,signerName:' '}])assert.equal((await apply(agreement)).status,400);
  assert.equal((await apply({...accepted,version:'old'})).status,409);
  assert.equal((await apply({...accepted,termsHash:'fake'})).status,409);
  assert.equal((await get(db,'SELECT COUNT(*) AS n FROM partner_applications')).n,0);
  const replies=await Promise.all([apply(accepted),apply(accepted)]);
  assert.ok(replies.every(r=>r.status===201));
  const id=replies[0].body.agreementId;assert.equal(id,replies[1].body.agreementId);
  assert.equal((await get(db,'SELECT COUNT(*) AS n FROM partner_agreements')).n,1);
  const download=await request('/api/partner/agreements/'+id+'/file',{token:partnerToken});
  assert.equal(download.status,200);assert.equal(download.body.userId,1);assert.equal(download.body.signerName,'Developer Sebenar');assert.equal(download.body.termsHash,t.termsHash);assert.equal(download.body.terms.sections.length,19);assert.ok(download.body.acceptedAtUTC);assert.ok(download.body.ipAddress);
  assert.equal((await request('/api/partner/agreements/'+id+'/file',{token:traderToken})).status,404);
  assert.equal((await request('/api/admin/partner-agreements/'+id+'/file',{token:partnerToken})).status,403);
  assert.equal((await request('/api/admin/partner-applications/1/agreement',{token:adminToken})).status,200);
  const file=path.join(f.partner.partnerApi.SUBMISSIONS_DIR,'user-agreements','1',id+'.json');assert.ok(fs.existsSync(file));
  const original=fs.readFileSync(file,'utf8');
  await request('/api/admin/partner-applications/1/review',{token:adminToken,method:'POST',body:{status:'rejected',reviewNotes:'Update profile'}});
  const resubmit=await apply({...accepted,signerName:'Updated Signer'});assert.equal(resubmit.status,201);assert.notEqual(resubmit.body.agreementId,id);assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.equal((await request('/api/partner/agreements',{token:partnerToken})).body.agreements.length,2);
 }finally{f.server.close();await new Promise(resolve=>db.close(resolve));}
});

test('a failed agreement file write rolls back both acceptance and application',async()=>{
 const f=await createFixture();
 try{
  const dir=path.join(f.partner.partnerApi.SUBMISSIONS_DIR,'user-agreements');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'1'),'block directory creation');
  const response=await f.request('/api/partner/register',{token:f.partnerToken,method:'POST',body:{displayName:'Blocked file writer'}});
  assert.equal(response.status,500);
  assert.equal((await get(f.db,'SELECT COUNT(*) AS n FROM partner_agreements')).n,0);
  assert.equal((await get(f.db,'SELECT COUNT(*) AS n FROM partner_applications')).n,0);
 }finally{f.server.close();await new Promise(resolve=>f.db.close(resolve));}
});

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

const PAYOUT_BANK = { bankName: 'Maybank', accountHolder: 'Test Partner', accountNumber: '123456789012', confirmOwnership: true };
async function payoutFixture() {
  const f = await createFixture();
  const stamp = Date.now();
  await run(f.db, `INSERT INTO partner_profiles(user_id, display_name, status, created_at, updated_at) VALUES(1, 'Payout Partner', 'active', ?, ?)`, [stamp, stamp]);
  await run(f.db, `INSERT INTO partner_transactions(reference, idempotency_key, partner_id, gross_amount, commission_amount, currency, status, created_at, status_updated_at)
    VALUES('COM-PAYOUT-TEST', 'test:payout:1', 1, 250, 100, 'MYR', 'approved', ?, ?)`, [stamp, stamp]);
  const rule = await f.request('/api/admin/commissions', { token: f.adminToken, method: 'POST', body: { partnerId: 1, model: 'percent', percent: 40, minPayoutThreshold: 20 } });
  assert.equal(rule.status, 201);
  f.saveBank = body => f.request('/api/partner/bank-details', { token: f.partnerToken, method: 'PUT', body: body || PAYOUT_BANK });
  f.askPayout = (amount = 30, requestKey = crypto.randomUUID()) => f.request('/api/partner/payouts', { token: f.partnerToken, method: 'POST', body: { amount, requestKey } });
  f.approvePayout = (id, body = {}) => f.request(`/api/admin/payouts/${id}/status`, { token: f.adminToken, method: 'POST', body: { status: 'paid', reference: 'BANK-REF-' + id, confirmTransferred: true, ...body } });
  f.payoutSummary = async () => (await f.request('/api/partner/payout-summary', { token: f.partnerToken })).body;
  f.close = async () => { f.server.close(); await new Promise(resolve => f.db.close(resolve)); };
  return f;
}

test('partner bank details validate ownership, encrypt accounts and mask all list responses', async () => {
  const f = await payoutFixture();
  try {
    assert.equal((await f.request('/api/partner/payout-summary', { token: f.traderToken })).status, 403);
    assert.equal((await f.request('/api/partner/bank-details', { token: f.traderToken, method: 'PUT', body: PAYOUT_BANK })).status, 403);
    assert.equal((await f.askPayout()).status, 400);
    for (const body of [{ ...PAYOUT_BANK, accountNumber: 'abc123' }, { ...PAYOUT_BANK, confirmOwnership: false }, { ...PAYOUT_BANK, bankName: '' }, { ...PAYOUT_BANK, accountHolder: '' }]) {
      assert.equal((await f.saveBank(body)).status, 400);
    }
    const saved = await f.saveBank();
    assert.equal(saved.status, 200);
    assert.equal(saved.body.bankDetails.accountLast4, '9012');
    assert.ok(!JSON.stringify(saved.body).includes(PAYOUT_BANK.accountNumber));
    const stored = await get(f.db, 'SELECT payout_details_cipher FROM partner_profiles WHERE user_id=1');
    assert.ok(!stored.payout_details_cipher.includes(PAYOUT_BANK.accountNumber));
    assert.equal(JSON.parse(f.sandbox.crypto.decrypt(stored.payout_details_cipher)).accountNumber, PAYOUT_BANK.accountNumber);
    const kept = await f.saveBank({ ...PAYOUT_BANK, accountNumber: '', bankName: 'Updated bank' });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.bankDetails.accountLast4, '9012');
    assert.equal((await f.payoutSummary()).bankDetails.bankName, 'Updated bank');
    const audit = await new Promise((resolve, reject) => f.db.all('SELECT * FROM subscription_audit_logs', (error, rows) => error ? reject(error) : resolve(rows)));
    assert.ok(!JSON.stringify(audit).includes(PAYOUT_BANK.accountNumber));
  } finally { await f.close(); }
});

test('payout requests reserve funds once, freeze the bank account, and settle partial commissions exactly', async () => {
  const f = await payoutFixture();
  try {
    await f.saveBank();
    const key = crypto.randomUUID();
    const replies = await Promise.all([f.askPayout(30, key), f.askPayout(30, key)]);
    assert.deepEqual(replies.map(row => row.status).sort(), [200, 201]);
    assert.equal(replies[0].body.payoutUid, replies[1].body.payoutUid);
    assert.equal((await f.askPayout(40, key)).status, 409);
    assert.equal((await f.askPayout(30)).status, 409);
    assert.equal((await get(f.db, 'SELECT COUNT(*) AS n FROM partner_payouts')).n, 1);
    let balance = await f.payoutSummary();
    assert.equal(balance.availableBalance, 70);
    assert.equal(balance.reservedBalance, 30);
    assert.equal(await f.partner.commissionService.availableBalance(1), 70);
    const payout = await get(f.db, 'SELECT * FROM partner_payouts');
    assert.equal(payout.status, 'pending');
    assert.equal(payout.paid_at, null);
    assert.equal((await get(f.db, 'SELECT status FROM partner_transactions')).status, 'approved');
    await f.saveBank({ ...PAYOUT_BANK, bankName: 'CIMB', accountNumber: '999999991234' });
    assert.equal((await f.request(`/api/admin/payouts/${payout.id}/recipient`, { token: f.partnerToken })).status, 403);
    const recipient = await f.request(`/api/admin/payouts/${payout.id}/recipient`, { token: f.adminToken });
    assert.equal(recipient.body.recipient.bankName, PAYOUT_BANK.bankName);
    assert.equal(recipient.body.recipient.accountNumber, PAYOUT_BANK.accountNumber);
    for (const route of ['/api/admin/payouts', '/api/partner/payouts']) {
      const response = await f.request(route, { token: route.includes('/admin/') ? f.adminToken : f.partnerToken });
      assert.ok(!JSON.stringify(response.body).includes(PAYOUT_BANK.accountNumber));
      assert.equal(response.body.payouts[0].recipient.accountLast4, '9012');
    }
    assert.equal((await f.approvePayout(payout.id, { reference: '' })).status, 400);
    assert.equal((await f.approvePayout(payout.id, { confirmTransferred: false })).status, 400);
    const approvals = await Promise.all([f.approvePayout(payout.id), f.approvePayout(payout.id)]);
    assert.ok(approvals.every(row => row.status === 200));
    assert.equal((await get(f.db, "SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payout_paid'")).n, 1);
    balance = await f.payoutSummary();
    assert.equal(balance.availableBalance, 70);
    assert.equal(balance.reservedBalance, 0);
    assert.equal((await f.request('/api/partner/overview', { token: f.partnerToken })).body.earnings.paidTotal, 30);
    assert.equal((await get(f.db, 'SELECT status FROM partner_transactions')).status, 'approved');
    assert.equal((await f.request(`/api/admin/payouts/${payout.id}/status`, { token: f.adminToken, method: 'POST', body: { status: 'rejected', reason: 'Cannot undo a paid transfer' } })).status, 409);
    assert.equal((await f.approvePayout(payout.id, { reference: 'CHANGED' })).status, 409);
    assert.equal((await f.askPayout(70)).status, 201);
    const second = await get(f.db, 'SELECT * FROM partner_payouts ORDER BY id DESC LIMIT 1');
    assert.equal((await f.approvePayout(second.id)).status, 200);
    assert.equal((await f.payoutSummary()).availableBalance, 0);
    assert.equal((await get(f.db, 'SELECT status FROM partner_transactions')).status, 'paid');
    const history = await f.request('/api/partner/payouts', { token: f.partnerToken });
    assert.equal(history.body.payouts.length, 2);
    assert.ok(history.body.payouts.every(row => row.status === 'paid' && row.reference && row.paidAt));
    assert.equal((await f.request('/api/partner/overview', { token: f.partnerToken })).body.payouts.paidTotal, 100);
  } finally { await f.close(); }
});

test('minimum payouts, currency eligibility, rejection and concurrent requests preserve balances', async () => {
  const f = await payoutFixture();
  try {
    await f.saveBank();
    assert.equal((await f.askPayout(10)).status, 400);
    assert.equal((await f.askPayout(101)).status, 409);
    assert.equal((await f.askPayout(20.001)).status, 400);
    const stamp = Date.now();
    await run(f.db, `INSERT INTO partner_transactions(reference,idempotency_key,partner_id,gross_amount,commission_amount,currency,status,created_at,status_updated_at)
      VALUES('USD-TEST','test:usd',1,1000,400,'USD','approved',?,?)`, [stamp, stamp]);
    await run(f.db, `INSERT INTO partner_transactions(reference,idempotency_key,partner_id,gross_amount,commission_amount,currency,status,created_at,status_updated_at)
      VALUES('PENDING-TEST','test:pending',1,1000,400,'MYR','pending',?,?)`, [stamp, stamp]);
    assert.equal((await f.payoutSummary()).availableBalance, 100);
    const results = await Promise.all([f.askPayout(80), f.askPayout(80)]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
    const payout = await get(f.db, 'SELECT id FROM partner_payouts');
    const reject = body => f.request(`/api/admin/payouts/${payout.id}/status`, { token: f.adminToken, method: 'POST', body: { status: 'rejected', ...body } });
    assert.equal((await reject({})).status, 400);
    assert.equal((await f.request('/api/admin/payouts', { token: f.adminToken, method: 'POST', body: { partnerId: 1, amount: 20, reference: 'MANUAL' } })).status, 409);
    assert.equal((await reject({ reason: 'Please confirm the bank account.' })).status, 200);
    assert.equal((await f.payoutSummary()).availableBalance, 100);
    const history = await f.request('/api/partner/payouts', { token: f.partnerToken });
    assert.equal(history.body.payouts[0].reviewReason, 'Please confirm the bank account.');
    assert.equal((await f.approvePayout(payout.id)).status, 409);
    assert.equal((await f.askPayout(100)).status, 201);
  } finally { await f.close(); }
});

test('payout requests and payment confirmation roll back fully if allocation or audit persistence fails', async () => {
  const f = await payoutFixture();
  try {
    await f.saveBank();
    await run(f.db, "CREATE TRIGGER fail_allocation BEFORE INSERT ON partner_payout_allocations BEGIN SELECT RAISE(ABORT, 'allocation failure'); END");
    assert.equal((await f.askPayout()).status, 500);
    assert.equal((await get(f.db, 'SELECT COUNT(*) AS n FROM partner_payouts')).n, 0);
    assert.equal((await get(f.db, 'SELECT COUNT(*) AS n FROM partner_payout_details')).n, 0);
    assert.equal((await f.payoutSummary()).availableBalance, 100);
    await run(f.db, 'DROP TRIGGER fail_allocation');
    assert.equal((await f.askPayout()).status, 201);
    const payout = await get(f.db, 'SELECT id FROM partner_payouts');
    await run(f.db, "CREATE TRIGGER fail_paid_audit BEFORE INSERT ON subscription_audit_logs WHEN NEW.action='payout_paid' BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
    assert.equal((await f.approvePayout(payout.id)).status, 500);
    const unchanged = await get(f.db, 'SELECT * FROM partner_payouts');
    assert.equal(unchanged.status, 'pending');
    assert.equal(unchanged.reference, null);
    assert.equal(unchanged.paid_at, null);
    assert.equal((await get(f.db, 'SELECT status FROM partner_transactions')).status, 'approved');
    assert.equal((await f.payoutSummary()).reservedBalance, 30);
    await run(f.db, 'DROP TRIGGER fail_paid_audit');
    assert.equal((await f.approvePayout(payout.id)).status, 200);
  } finally { await f.close(); }
});

test('manual partial payouts retain the unpaid remainder and cannot overspend it', async () => {
  const f = await payoutFixture();
  try {
    const manual = (amount, reference) => f.request('/api/admin/payouts', { token: f.adminToken, method: 'POST', body: { partnerId: 1, amount, method: 'bank_transfer', reference } });
    assert.equal((await manual(30, 'MANUAL-PART-1')).status, 201);
    assert.equal((await manual(30, 'MANUAL-PART-1')).status, 200);
    assert.equal((await manual(31, 'MANUAL-PART-1')).status, 409);
    assert.equal((await f.payoutSummary()).availableBalance, 70);
    assert.equal((await get(f.db, 'SELECT status FROM partner_transactions')).status, 'approved');
    assert.equal((await manual(71, 'OVERPAY')).status, 409);
    assert.equal((await manual(70, 'MANUAL-PART-2')).status, 201);
    assert.equal((await f.payoutSummary()).availableBalance, 0);
    assert.equal((await get(f.db, 'SELECT status FROM partner_transactions')).status, 'paid');
  } finally { await f.close(); }
});

test('EA testing sources and report completion are restricted to the assigned test node', async () => {
  const { db, server, request, sandbox, partner } = await createFixture();
  try {
    const production = await sandbox.nodes.createNode({ name: 'Production', isTestNode: false });
    const assigned = await sandbox.nodes.createNode({ name: 'Assigned test', isTestNode: true });
    const other = await sandbox.nodes.createNode({ name: 'Other test', isTestNode: true });
    await run(db, "UPDATE sandbox_nodes SET status = 'active'");
    const now = Date.now();
    const submission = await run(db, `INSERT INTO ea_submissions
      (submission_uid, partner_id, name, version, status, created_at, updated_at)
      VALUES ('sub_security_fixture', 1, 'Private fixture', '1.0', 'testing', ?, ?)`, [now, now]);
    const id = submission.lastID;
    const version = await run(db, `INSERT INTO ea_versions (submission_id, version, file_path, file_count, status, created_at)
      VALUES (?, '1.0', 'sub_security_fixture', 1, 'stored', ?)`, [id, now]);
    const report = await run(db, `INSERT INTO ea_test_reports
      (submission_id, version_id, node_id, kind, status, started_at, created_at)
      VALUES (?, ?, ?, 'runtime', 'running', ?, ?)`, [id, version.lastID, assigned.id, now, now]);
    const dir = path.join(partner.partnerApi.SUBMISSIONS_DIR, 'sub_security_fixture');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'private.mq5'), '// dummy fixture only');
    const headers = node => ({ 'X-Node-Id': node.nodeUid, 'X-Node-Token': node.token });
    for (const node of [production, other]) {
      assert.ok([403, 404].includes((await request(`/api/admin/ea-testing/${id}/source`, { headers: headers(node) })).status));
      assert.ok([403, 404].includes((await request(`/api/admin/ea-testing/${id}/source/private.mq5`, { headers: headers(node) })).status));
      assert.ok([403, 404].includes((await request(`/api/admin/ea-testing/reports/${report.lastID}/complete`, {
        headers: headers(node), method: 'POST', body: { success: true }
      })).status));
    }
    assert.equal((await request(`/api/admin/ea-testing/${id}/source`, { headers: headers(assigned) })).status, 200);
    const complete = () => request(`/api/admin/ea-testing/reports/${report.lastID}/complete`, {
      headers: headers(assigned), method: 'POST', body: { success: true }
    });
    assert.equal((await complete()).status, 200);
    assert.equal((await complete()).status, 409);
    assert.equal((await request(`/api/admin/ea-testing/${id}/source`, { headers: headers(assigned) })).status, 404);
  } finally { server.close(); }
});

test('partner registration, EA submission, scanning, and review workflow', async () => {
  const { server, request, partnerToken, traderToken, adminToken } = await createFixture();
  try {
    // Non-partner cannot submit.
    const noPartner = await request('/api/partner/submissions', {
      token: traderToken, method: 'POST', body: { name: 'X', version: '1.0', description: '0123456789', presets: VALID_PRESETS, files: [{ name: 'a.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }] }
    });
    assert.equal(noPartner.status, 403);
    assert.equal(noPartner.body.code, 'NOT_A_PARTNER');

    // Register as partner.
    const registered = await request('/api/partner/register', {
      token: partnerToken, method: 'POST', body: { displayName: 'EA Wizard', company: 'Wizard Labs' }
    });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.application.status, 'pending');
    assert.equal((await request('/api/partner/profile', { token: partnerToken })).body.partner, null);
    assert.equal((await request('/api/partner/submissions', { token: partnerToken })).status, 403);
    assert.equal((await request('/api/admin/partner-applications/1/review', { token: partnerToken, method: 'POST', body: { status: 'approved' } })).status, 403);
    assert.equal((await request('/api/admin/partner-applications/1/review', { token: adminToken, method: 'POST', body: { status: 'approved' } })).status, 200);
    assert.equal((await request('/api/admin/partner-applications/1/review', { token: adminToken, method: 'POST', body: { status: 'approved' } })).status, 409);

    // Submit a clean EA.
    const submitted = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: {
        name: 'Grid Master', version: '1.0', description: 'A grid trading EA for XAUUSD.',
        symbols: 'XAUUSD', presets: VALID_PRESETS, files: [EX5_FILE, { name: 'GridMaster.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }]
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
        presets: VALID_PRESETS, files: [{ name: 'evil.mq5', contentBase64: Buffer.from(MALICIOUS_MQ5).toString('base64') }]
      }
    });
    assert.equal(malicious.status, 201);
    assert.ok(malicious.body.scanFindings.length >= 2); // DLL import + WinExec

    // Reject bad file types.
    const badType = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: { name: 'Bad', version: '1.0', description: 'bad file type test', presets: VALID_PRESETS, files: [{ name: 'virus.exe', contentBase64: Buffer.from('MZ').toString('base64') }] }
    });
    assert.equal(badType.status, 400);

    // Admin sees the submissions.
    const list = await request('/api/admin/ea-submissions', { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.submissions.length, 2);
    const target = list.body.submissions.find(s => s.submissionUid === submissionUid);
    assert.equal(target.status, 'pending_review');
    assert.equal(target.partnerName, 'EA Wizard');
    const detail = await request(`/api/admin/ea-submissions/${target.id}`, { token: adminToken });
    assert.equal(detail.body.presets[0].symbol, 'XAUUSD');
    assert.equal(detail.body.presets[0].text, 'TakeProfit=100\r\n');

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
    assert.equal((await request('/api/admin/partner-applications/1/review', { token: adminToken, method: 'POST', body: { status: 'approved' } })).status, 200);
    const submitted = await request('/api/partner/submissions', {
      token: partnerToken, method: 'POST',
      body: { name: 'Grid Master', version: '1.0', description: 'A grid trading EA.', presets: VALID_PRESETS, files: [EX5_FILE, { name: 'g.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }] }
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
      token: adminToken, method: 'POST', body: { partnerId: 1, amount: 500, reference: 'REF-OVERPAY' }
    });
    assert.equal(overpay.status, 409);

    // Partner sees the earnings.
    const overview = await request('/api/partner/overview', { token: partnerToken });
    assert.equal(overview.body.earnings.paidTotal, 40);
  } finally {
    server.close();
  }
});


test('partner rejection, resubmission and admin-only approval preserve access boundaries', async () => {
 const { server,request,partnerToken,traderToken,adminToken }=await createFixture();
 try{
  assert.equal((await request('/api/partner/register',{token:partnerToken,method:'POST',body:{displayName:'Applicant',status:'active'}})).body.application.status,'pending');
  assert.equal((await request('/api/partner/overview',{token:partnerToken})).status,403);
  const list=await request('/api/admin/partner-applications',{token:adminToken});
  assert.equal(list.body.applications[0].status,'pending');
  assert.equal((await request('/api/admin/partner-applications',{token:traderToken})).status,403);
  assert.equal((await request('/api/admin/partner-applications/1/review',{token:adminToken,method:'POST',body:{status:'rejected'}})).status,400);
  assert.equal((await request('/api/admin/partner-applications/1/review',{token:adminToken,method:'POST',body:{status:'rejected',reviewNotes:'Please provide developer details.'}})).status,200);
  assert.equal((await request('/api/partner/profile',{token:partnerToken})).body.partner,null);
  assert.equal((await request('/api/partner/application',{token:partnerToken})).body.application.reviewNotes,'Please provide developer details.');
  assert.equal((await request('/api/partner/application',{token:traderToken})).body.application,null);
  assert.equal((await request('/api/partner/register',{token:partnerToken,method:'POST',body:{displayName:'Updated Developer'}})).body.application.status,'pending');
  assert.equal((await request('/api/admin/partner-applications/1/review',{token:adminToken,method:'POST',body:{status:'approved'}})).status,200);
  assert.equal((await request('/api/partner/profile',{token:partnerToken})).body.partner.status,'active');
 }finally{server.close();}
});

test('only admins can delete rejected applications and resubmitted or approved records stay protected', async () => {
 const { db,server,request,partnerToken,traderToken,adminToken }=await createFixture();
 const get=(sql,p=[])=>new Promise((resolve,reject)=>db.get(sql,p,(e,row)=>e?reject(e):resolve(row)));
 const remove=(id,token=adminToken,body={confirm:true})=>request('/api/admin/partner-applications/'+id,{token,method:'DELETE',body});
 const apply=token=>request('/api/partner/register',{token,method:'POST',body:{displayName:'Developer'}});
 const review=(id,status)=>request('/api/admin/partner-applications/'+id+'/review',{token:adminToken,method:'POST',body:{status,reviewNotes:'Review complete.'}});
 try {
  await apply(partnerToken);
  assert.equal((await remove(1,null)).status,403);
  assert.equal((await remove(1,partnerToken)).status,403);
  assert.equal((await remove('1bad')).status,400);
  assert.equal((await remove(999999)).status,404);
  assert.equal((await remove(1)).status,409);
  await review(1,'rejected');
  assert.equal((await remove(1,adminToken,{})).status,400);
  assert.equal((await remove(1,adminToken,{confirm:'true'})).status,400);
  assert.equal((await get('SELECT status FROM partner_applications WHERE user_id=1')).status,'rejected');
  // A button from the old rejected row cannot delete a newly pending application.
  await apply(partnerToken);
  assert.equal((await remove(1)).status,409);
  await review(1,'rejected');
  await apply(traderToken); await review(2,'approved');
  assert.equal((await remove(2)).status,409);
  const deleted=await remove(1);
  assert.equal(deleted.status,200); assert.equal(deleted.body.deleted,1);
  assert.equal((await request('/api/partner/application',{token:partnerToken})).body.application,null);
  assert.ok(await get('SELECT id FROM users WHERE id=1'));
  assert.equal((await get('SELECT status FROM partner_profiles WHERE user_id=2')).status,'active');
  assert.equal((await get('SELECT status FROM partner_applications WHERE user_id=2')).status,'approved');
  assert.equal((await remove(1)).status,404);
  const audit=await get("SELECT metadata FROM subscription_audit_logs WHERE action='partner_application_deleted' AND affected_id=1");
  assert.equal(JSON.parse(audit.metadata).status,'rejected');
  assert.equal((await apply(partnerToken)).body.application.status,'pending');
 } finally { server.close(); }
});

test('partner presets remain tied to their own reviewed EA and never fall back to CornGrid', async () => {
 const { db,server,request,partnerToken,traderToken,adminToken }=await createFixture();
 const get=(sql,p=[])=>new Promise((resolve,reject)=>db.get(sql,p,(e,r)=>e?reject(e):resolve(r)));
 const {loadStrategyPreset}=require('../partner/presets');
 try{
  for(const [token,id] of [[partnerToken,1],[traderToken,2]]){
   await request('/api/partner/register',{token,method:'POST',body:{displayName:'Developer '+id}});
   await request('/api/admin/partner-applications/'+id+'/review',{token:adminToken,method:'POST',body:{status:'approved'}});
  }
  const strategies=[];
  for(const [token,value] of [[partnerToken,111],[traderToken,222]]){
   const submitted=await request('/api/partner/submissions',{token,method:'POST',body:{name:'EA '+value,version:'1.0',description:'Independent partner EA preset.',files:[EX5_FILE,{name:'ea.mq5',contentBase64:Buffer.from(VALID_MQ5).toString('base64')}],presets:[{symbol:'EURUSD',name:'ea.set',contentBase64:Buffer.from('TakeProfit='+value+'\r\n').toString('base64')}]}});
   assert.equal(submitted.status,201);
   const row=await get('SELECT * FROM ea_submissions WHERE submission_uid=?',[submitted.body.submissionUid]);
   if(value===111)assert.equal((await request('/api/partner/submissions/'+row.submission_uid,{token:traderToken})).status,404);
   await request('/api/admin/ea-submissions/'+row.id+'/review',{token:adminToken,method:'POST'});
   await request('/api/admin/ea-submissions/'+row.id+'/approve',{token:adminToken,method:'POST'});
   await request('/api/admin/ea-submissions/'+row.id+'/publish',{token:adminToken,method:'POST'});
   const strategy=await get('SELECT * FROM trading_strategies WHERE submission_id=?',[row.id]);
   strategies.push(strategy);
   const preset=await loadStrategyPreset(db,strategy,'EURUSD');
   assert.equal(preset.text,'TakeProfit='+value+'\r\n');
   assert.equal(preset.kind,'partner');
   assert.equal(await loadStrategyPreset(db,strategy,'XAUUSD'),null);
  }
  const official=await get("SELECT * FROM trading_strategies WHERE code='corngrid-ea'");
  for(const pair of ['XAUUSD','EURUSD','GBPUSD','USDJPY']){
   const preset=await loadStrategyPreset(db,official,pair);assert.equal(preset.kind,'corngrid');assert.match(preset.name,/\.set$/);
  }
  await run(db,"UPDATE partner_profiles SET status='suspended' WHERE user_id=1");
  assert.equal(await loadStrategyPreset(db,strategies[0],'EURUSD'),null);
 }finally{server.close();}
});
