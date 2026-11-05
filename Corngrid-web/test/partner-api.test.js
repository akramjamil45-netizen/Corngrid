const assert = require('node:assert/strict');
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

  const sandbox = createSandboxSystem(app, db, { verifyToken, adminAuth, subscriptionApi, rateLimit, jwtSecret });
  await sandbox.ready;
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-partner-test-'));
  const partner = createPartnerSystem(app, db, {
    verifyToken, adminAuth,
    events: sandbox.events, nodes: sandbox.nodes, crypto: sandbox.crypto,
    subscriptionApi, rateLimit,
    storageDir,
    authenticateNodeRequest: sandbox.nodeApi.authenticateNodeRequest
  });

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
        symbols: 'XAUUSD', presets: VALID_PRESETS, files: [{ name: 'GridMaster.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }]
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
      body: { name: 'Grid Master', version: '1.0', description: 'A grid trading EA.', presets: VALID_PRESETS, files: [{ name: 'g.mq5', contentBase64: Buffer.from(VALID_MQ5).toString('base64') }] }
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
   const submitted=await request('/api/partner/submissions',{token,method:'POST',body:{name:'EA '+value,version:'1.0',description:'Independent partner EA preset.',files:[{name:'ea.mq5',contentBase64:Buffer.from(VALID_MQ5).toString('base64')}],presets:[{symbol:'EURUSD',name:'ea.set',contentBase64:Buffer.from('TakeProfit='+value+'\r\n').toString('base64')}]}});
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
