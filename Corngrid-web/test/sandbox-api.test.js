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
  const jwtSecret = 'sandbox-test-secret';
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
  await run(db, `INSERT INTO users (id, username, email, password, bio, created_at)
                 VALUES (2, 'Bob', 'bob@example.test', 'x', '', CURRENT_TIMESTAMP)`);

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

  const sandbox = createSandboxSystem(app, db, {
    verifyToken,
    adminAuth,
    subscriptionApi,
    rateLimit,
    jwtSecret
  });
  await sandbox.ready;

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const userToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const otherUserToken = jwt.sign({ id: 2, authVersion: 0 }, jwtSecret);
  const adminToken = jwt.sign({ sub: 'admin', role: 'admin' }, jwtSecret);

  const request = async (route, { token, method = 'GET', body, headers = {} } = {}) => {
    if(route==='/api/sandbox/node/heartbeat'&&body)body={osVersion:'Windows_NT fixture',ramMb:32768,memoryUsedMb:4096,diskFreeMb:20000,cpuPercent:10,...body};
    const finalHeaders = { ...headers };
    if (token) finalHeaders.Authorization = 'Bearer ' + token;
    if (body) finalHeaders['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method,
      headers: finalHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try { json = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: json };
  };

  return { db, app, server, request, userToken, otherUserToken, adminToken, sandbox, subscriptionApi };
}

async function giveActiveSubscription(db, userId) {
  const now = Date.now();
  await run(db, `INSERT INTO subscription_plans (id, name, price, currency, duration_days, max_activations, is_active, created_at, updated_at)
                 VALUES (1, 'Pro', 100, 'MYR', 30, 5, 1, ?, ?)`, [now, now]);
  await run(db, `INSERT INTO user_subscriptions
                   (id, user_id, plan_id, status, purchase_price, currency, duration_days, max_activations, starts_at, expires_at, created_at, updated_at)
                 VALUES (1, ?, 1, 'active', 100, 'MYR', 30, 5, ?, ?, ?, ?)`,
    [userId, now - 1000, now + 30 * 86400000, now, now]);
}

async function multiSandboxFixture(t, limit = 3, nodeCapacity = 10) {
  const f = await createFixture();
  t.after(async () => { await new Promise(resolve => f.server.close(resolve)); await new Promise(resolve => f.db.close(resolve)); });
  await giveActiveSubscription(f.db, 1);
  await run(f.db, 'UPDATE user_subscriptions SET max_activations = ?', [limit]);
  const node = await f.request('/api/admin/sandbox/nodes', { token: f.adminToken, method: 'POST', body: { name: 'Multiple sandbox node', maxInstances: nodeCapacity } });
  await f.request(`/api/admin/sandbox/nodes/${node.body.node.id}/status`, { token: f.adminToken, method: 'POST', body: { status: 'active' } });
  f.nodeId = node.body.node.id;
  f.nodeHeaders = { 'X-Node-Id': node.body.node.nodeUid, 'X-Node-Token': node.body.token };
  await f.request('/api/sandbox/node/heartbeat', { method: 'POST', headers: f.nodeHeaders, body: {} });
  f.activate = (number, extra = {}) => f.request('/api/sandbox/activate', { token: f.userToken, method: 'POST', body: { brokerServer: 'Multi-Demo', accountNumber: number, password: 'test-only', ...extra } });
  return f;
}

test('multiple sandboxes share activation allowance, retry safely, and isolate user/admin controls', async t => {
  const f = await multiSandboxFixture(t, 2);
  const a = await f.activate('9001'), b = await f.activate('9002');
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const uidA = a.body.sandbox.instanceUid, uidB = b.body.sandbox.instanceUid;
  assert.notEqual(uidA, uidB);
  assert.equal((await f.activate('9001')).body.sandbox.instanceUid, uidA);
  assert.equal((await f.activate('9003', { maxActivations: 100, userId: 2 })).body.code, 'SANDBOX_LIMIT_REACHED');
  let status = await f.request('/api/sandbox/status?instanceUid=' + uidB, { token: f.userToken });
  assert.equal(status.body.sandboxes.length, 2);
  assert.equal(status.body.sandbox.instanceUid, uidB);
  assert.deepEqual(status.body.capacity, { maxSandboxes: 2, sandboxCount: 2, activeActivations: 2, canAdd: false });
  assert.ok(!JSON.stringify(status.body).includes('test-only'));
  for (const action of ['stop', 'restart', 'pause', 'resume', 'reconnect']) {
    assert.equal((await f.request('/api/sandbox/' + action, { token: f.otherUserToken, method: 'POST', body: { instanceUid: uidA } })).status, 404);
  }
  assert.equal((await f.request('/api/sandbox/status?instanceUid=' + uidA, { token: f.otherUserToken })).status, 404);
  assert.equal((await f.request('/api/sandbox', { token: f.otherUserToken, method: 'DELETE', body: { instanceUid: uidA, confirm: true } })).status, 404);
  assert.equal((await f.request('/api/sandbox/stop', { token: f.userToken, method: 'POST' })).body.code, 'INSTANCE_REQUIRED');
  assert.equal((await f.request('/api/sandbox', { token: f.userToken, method: 'DELETE', body: { confirm: true } })).status, 409);
  const { dbGet } = require('../db-async');
  const rowA = await dbGet(f.db, 'SELECT id FROM sandbox_instances WHERE instance_uid = ?', [uidA]);
  const adminStop = await f.request(`/api/admin/sandbox/instances/${rowA.id}/control`, { token: f.adminToken, method: 'POST', body: { action: 'stop' } });
  assert.equal(adminStop.status, 200);
  status = await f.request('/api/sandbox/status?instanceUid=' + uidB, { token: f.userToken });
  assert.equal(status.body.sandbox.status, 'deploying', 'admin targets first instance, not newest');
  assert.equal((await f.request('/api/sandbox/status?instanceUid=' + uidA, { token: f.userToken })).body.sandbox.status, 'stopping');
  assert.equal((await f.request('/api/sandbox', { token: f.userToken, method: 'DELETE', body: { instanceUid: uidA, confirm: true } })).status, 200);
  assert.equal((await f.request('/api/sandbox/status', { token: f.userToken })).body.sandbox.instanceUid, uidB);
  assert.equal(Number((await dbGet(f.db, `SELECT COUNT(*) AS c FROM mt5_installations i JOIN mt5_accounts a ON a.id=i.account_id WHERE a.account_number='9002' AND i.revoked_at IS NULL`)).c), 1);
  assert.equal((await f.activate('9003')).body.code, 'ACTIVATION_LIMIT_REACHED', 'deleting a sandbox preserves its existing license activation');
  assert.equal((await f.activate('9001')).status, 201, 'an already licensed account can be hosted again');
});

test('parallel sandbox and desktop activations cannot exceed the shared allowance', async t => {
  const f = await multiSandboxFixture(t, 2);
  const stamp = Date.now(), secret = 'a'.repeat(64);
  const account = await run(f.db, `INSERT INTO mt5_accounts(user_id,account_number,broker_server,currency,account_name,linked_at) VALUES(1,'9100','Multi-Demo','USD','Desktop test',?)`, [stamp]);
  await run(f.db, 'INSERT INTO mt5_installations(account_id,secret_hash,created_at) VALUES(?,?,?)', [account.lastID, crypto.createHash('sha256').update(secret).digest('hex'), stamp]);
  const desktop = () => f.request('/api/license/activate', { method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: {} });
  const outcomes = await Promise.all([f.activate('9101'), f.activate('9101'), f.activate('9102'), desktop()]);
  const { dbGet } = require('../db-async');
  assert.equal(Number((await dbGet(f.db, "SELECT COUNT(*) AS c FROM ea_license_activations WHERE license_status='active'")).c), 2);
  assert.equal(outcomes.filter(row => row.status === 201).length, 2);
  assert.equal(outcomes[0].body.sandbox.instanceUid, outcomes[1].body.sandbox.instanceUid);
  assert.equal(Number((await dbGet(f.db, "SELECT COUNT(*) AS c FROM sandbox_deployments WHERE command='deploy'")).c), Number((await dbGet(f.db, 'SELECT COUNT(*) AS c FROM sandbox_instances')).c));
});

test('sandbox reuses existing activation without rotating license and obeys expiry/revocation', async t => {
  const f = await multiSandboxFixture(t, 1);
  const first = await f.activate('9201');
  const { dbGet } = require('../db-async');
  const activation = await dbGet(f.db, 'SELECT * FROM ea_license_activations');
  await f.request('/api/sandbox', { token: f.userToken, method: 'DELETE', body: { confirm: true, instanceUid: first.body.sandbox.instanceUid } });
  assert.equal((await f.activate('9201')).status, 201);
  assert.equal((await dbGet(f.db, 'SELECT * FROM ea_license_activations')).activation_identifier, activation.activation_identifier);
  await run(f.db, 'UPDATE user_subscriptions SET expires_at = ?', [Date.now() - 1]);
  assert.equal((await f.activate('9201')).body.code, 'SUBSCRIPTION_REQUIRED');
  await run(f.db, "UPDATE sandbox_instances SET status='stopped' WHERE deleted_at IS NULL");
  assert.equal((await f.request('/api/sandbox/start', { token: f.userToken, method: 'POST' })).body.code, 'SUBSCRIPTION_REQUIRED');
  assert.equal((await f.request('/api/sandbox/status', { token: f.userToken })).body.capacity.canAdd, false);
  await run(f.db, 'UPDATE user_subscriptions SET expires_at = ?', [Date.now() + 86400000]);
  await f.request('/api/sandbox', { token: f.userToken, method: 'DELETE', body: { confirm: true } });
  await run(f.db, "UPDATE ea_license_activations SET license_status='revoked'");
  assert.equal((await f.activate('9201')).body.code, 'ACTIVATION_BLOCKED');
});

test('concurrent creation and restart reserve node capacity and failed queue rolls back license', async t => {
  const f = await multiSandboxFixture(t, 4, 1);
  const result = await Promise.all([f.activate('9301'), f.activate('9302')]);
  assert.deepEqual(result.map(row => row.status).sort(), [201, 503]);
  const uid = result.find(row => row.status === 201).body.sandbox.instanceUid;
  await run(f.db, "UPDATE sandbox_instances SET status='stopped'");
  const second = await f.activate('9303'); assert.equal(second.status, 201);
  assert.equal((await f.request('/api/sandbox/start', { token: f.userToken, method: 'POST', body: { instanceUid: uid } })).body.code, 'NO_CAPACITY');
  await run(f.db, "UPDATE sandbox_instances SET status='stopped'");
  const queue = f.sandbox.nodes.queueCommand;
  f.sandbox.nodes.queueCommand = async () => { throw new Error('Test queue failure'); };
  assert.equal((await f.activate('9304')).status, 500);
  f.sandbox.nodes.queueCommand = queue;
  const { dbGet } = require('../db-async');
  assert.equal(await dbGet(f.db, "SELECT id FROM ea_license_activations WHERE mt5_account_number='9304'"), undefined);
  assert.equal(await dbGet(f.db, "SELECT id FROM sandbox_instances WHERE mt5_account_number='9304'"), undefined);
});

test('multiple sandbox migration preserves a legacy instance and its encrypted credentials', async t => {
  const f = await multiSandboxFixture(t, 2);
  const original = await f.activate('9401');
  const { dbGet } = require('../db-async');
  const credential = await dbGet(f.db, 'SELECT * FROM sandbox_credentials');
  await run(f.db, 'DROP INDEX idx_sandbox_instances_active_account');
  await run(f.db, 'CREATE UNIQUE INDEX idx_sandbox_instances_active_user ON sandbox_instances(user_id) WHERE deleted_at IS NULL');
  await require('../sandbox/sandbox-schema').ensureSchema(f.db);
  await require('../sandbox/sandbox-schema').ensureSchema(f.db);
  assert.equal((await dbGet(f.db, 'SELECT * FROM sandbox_credentials')).cipher, credential.cipher);
  assert.equal((await f.request('/api/sandbox/status', { token: f.userToken })).body.sandbox.instanceUid, original.body.sandbox.instanceUid);
  assert.equal((await f.activate('9402')).status, 201);
});

test('sandbox credential encryption round-trips and rejects tampering', () => {
  const { createSandboxCrypto, maskAccountNumber } = require('../sandbox/sandbox-crypto');
  const key = crypto.randomBytes(32).toString('hex');
  const box = createSandboxCrypto({ encryptionKey: key });
  const payload = box.encryptJson({ accountNumber: '12345', password: 's3cret' });
  assert.deepEqual(box.decryptJson(payload), { accountNumber: '12345', password: 's3cret' });
  assert.equal(box.decryptJson(payload.slice(0, -4) + 'AAAA'), null);
  assert.equal(box.decryptJson('garbage'), null);
  const other = createSandboxCrypto({ encryptionKey: crypto.randomBytes(32).toString('hex') });
  assert.equal(other.decryptJson(payload), null);
  assert.equal(maskAccountNumber('12345678'), '******78');
});

test('node recovery returns only assigned running instances and excludes manual stops', async () => {
  const { db, server, request, adminToken } = await createFixture();
  try {
    const created = await request('/api/admin/sandbox/nodes', {
      token: adminToken, method: 'POST', body: { name: 'Recovery node' }
    });
    const headers = { 'X-Node-Id': created.body.node.nodeUid, 'X-Node-Token': created.body.token };
    assert.equal((await request('/api/sandbox/node/instances')).status, 401);
    const now = Date.now();
    await run(db, `INSERT INTO sandbox_instances (instance_uid,user_id,node_id,status,created_at,updated_at)
      VALUES ('sbx_0123456789abcdef01',1,?,'running',?,?)`, [created.body.node.id, now, now]);
    const result = await request('/api/sandbox/node/instances', { headers });
    assert.deepEqual(result.body.instances, [{ instanceUid: 'sbx_0123456789abcdef01' }]);
    for (const status of ['stopped','suspended','failed','deploying']) {
      await run(db, 'UPDATE sandbox_instances SET status = ?', [status]);
      assert.deepEqual((await request('/api/sandbox/node/instances', { headers })).body.instances, []);
    }
    await run(db, "UPDATE sandbox_instances SET status='running',deleted_at=?", [now]);
    assert.deepEqual((await request('/api/sandbox/node/instances', { headers })).body.instances, []);
    await run(db, 'UPDATE sandbox_instances SET deleted_at=NULL,node_id=NULL');
    assert.deepEqual((await request('/api/sandbox/node/instances', { headers })).body.instances, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(resolve));
  }
});

test('node registration, authentication, heartbeat and command queue', async () => {
  const { db, server, request, adminToken, sandbox } = await createFixture();
  try {
    // Admin creates a node; the plaintext token is returned once.
    const created = await request('/api/admin/sandbox/nodes', {
      token: adminToken, method: 'POST', body: { name: 'Node A', maxInstances: 5 }
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.token.startsWith('cgn_'));
    const nodeUid = created.body.node.nodeUid;
    const token = created.body.token;

    // Node must be activated before it can host sandboxes.
    const nodeId = created.body.node.id;
    const activated = await request(`/api/admin/sandbox/nodes/${nodeId}/status`, {
      token: adminToken, method: 'POST', body: { status: 'active' }
    });
    assert.equal(activated.status, 200);

    // Bad credentials are rejected.
    const badAuth = await request('/api/sandbox/node/heartbeat', {
      method: 'POST', headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': 'cgn_wrong' }, body: {}
    });
    assert.equal(badAuth.status, 403);

    // Heartbeat with resource report.
    const heartbeat = await request('/api/sandbox/node/heartbeat', {
      method: 'POST',
      headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': token },
      body: { machineName: 'WIN-NODE-A', cpuCount: 8, ramMb: 32768, cpuPercent: 12.5, memoryUsedMb: 4096, runningInstances: 0, instances: [] }
    });
    assert.equal(heartbeat.status, 200);
    assert.deepEqual(heartbeat.body.commands, []);

    const nodeRow = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM sandbox_nodes WHERE node_uid = ?', [nodeUid], (e, row) => (e ? reject(e) : resolve(row)));
    });
    assert.equal(nodeRow.machine_name, 'WIN-NODE-A');
    assert.equal(nodeRow.cpu_count, 8);
    assert.ok(nodeRow.last_heartbeat_at > 0);

    // Queue a command and verify the node picks it up on the next poll.
    await sandbox.nodes.queueCommand(nodeId, 'restart_agent', { payload: {} });
    const polled = await request('/api/sandbox/node/commands', {
      headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': token }
    });
    assert.equal(polled.status, 200);
    assert.equal(polled.body.commands.length, 1);
    assert.equal(polled.body.commands[0].command, 'restart_agent');

    // Report the result.
    const commandUid = polled.body.commands[0].commandUid;
    const result = await request(`/api/sandbox/node/commands/${commandUid}/result`, {
      method: 'POST',
      headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': token },
      body: { success: true, result: { restarted: true } }
    });
    assert.equal(result.status, 200);
  } finally {
    server.close();
  }
});

test('admin node capacity validates limits, protects occupied slots and enables allocation', async () => {
  const { db, server, request, userToken, otherUserToken, adminToken } = await createFixture();
  try {
    const created = await request('/api/admin/sandbox/nodes', {
      token: adminToken, method: 'POST', body: { name: 'Capacity node', maxInstances: 1 }
    });
    const nodeId = created.body.node.id;
    const route = `/api/admin/sandbox/nodes/${nodeId}/capacity`;
    const update = (maxInstances, token = adminToken) => request(route, { token, method: 'PATCH', body: { maxInstances } });
    assert.equal((await update(3, userToken)).status, 403);
    assert.ok([401, 403].includes((await update(3, '')).status));
    for (const value of [0, -1, 201, 1.5, '3', null, true]) assert.equal((await update(value)).status, 400);
    assert.equal((await request('/api/admin/sandbox/nodes/999999/capacity', { token: adminToken, method: 'PATCH', body: { maxInstances: 2 } })).status, 404);
    await request(`/api/admin/sandbox/nodes/${nodeId}/status`, { token: adminToken, method: 'POST', body: { status: 'active' } });
    await request('/api/sandbox/node/heartbeat', {
      method: 'POST', headers: { 'X-Node-Id': created.body.node.nodeUid, 'X-Node-Token': created.body.token }, body: { runningInstances: 0 }
    });
    await giveActiveSubscription(db, 1);
    const now = Date.now();
    await run(db, `INSERT INTO user_subscriptions
      (user_id,plan_id,status,purchase_price,currency,starts_at,expires_at,created_at,updated_at)
      VALUES (2,1,'active',100,'MYR',?,?,?,?)`, [now - 1000, now + 86400000, now, now]);
    const activate = (token, accountNumber) => request('/api/sandbox/activate', {
      token, method: 'POST', body: { brokerServer: 'Dummy-Demo', accountNumber, password: 'fixture-broker-password' }
    });
    assert.equal((await activate(userToken, '11111')).status, 201);
    assert.equal((await activate(otherUserToken, '22222')).status, 503, 'node starts full');
    const increased = await update(3);
    assert.equal(increased.status, 200);
    assert.equal(increased.body.node.maxInstances, 3);
    assert.equal(increased.body.node.usedSlots, 1);
    const overview = await request('/api/admin/sandbox/overview', { token: adminToken });
    assert.deepEqual(overview.body.capacity, { totalSlots: 3, usedSlots: 1, availableSlots: 2 });
    assert.equal((await activate(otherUserToken, '22222')).status, 201, 'allocator uses the new limit');
    const tooSmall = await update(1);
    assert.equal(tooSmall.status, 409);
    assert.equal(tooSmall.body.usedSlots, 2, 'deploying slots count even before agent reports running');
    assert.equal((await request('/api/admin/sandbox/nodes', { token: adminToken })).body.nodes[0].maxInstances, 3);
    await run(db, "UPDATE sandbox_instances SET status='stopped' WHERE user_id=1");
    assert.equal((await update(1)).status, 200, 'stopped instances release capacity');
    const audit = await new Promise((resolve, reject) => db.get("SELECT * FROM subscription_audit_logs WHERE action='sandbox_node_capacity_updated' ORDER BY id DESC LIMIT 1", (error, row) => error ? reject(error) : resolve(row)));
    assert.ok(audit, 'capacity edits are audited');
    const auditCount = async () => (await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM subscription_audit_logs WHERE action='sandbox_node_capacity_updated'", [], (error, row) => error ? reject(error) : resolve(row)))).count;
    const beforeRetry = await auditCount();
    const retry = await request(route, { token: adminToken, method: 'PATCH', body: { maxInstances: 1, expectedMaxInstances: 3 } });
    assert.equal(retry.status, 200, 'a lost reply may be retried safely after the first edit committed');
    assert.equal(await auditCount(), beforeRetry, 'idempotent retries do not duplicate the audit');
    const stale = await request(route, { token: adminToken, method: 'PATCH', body: { maxInstances: 5, expectedMaxInstances: 3 } });
    assert.equal(stale.status, 409, 'an old dialog cannot overwrite another administrator');
    assert.equal((await request('/api/admin/sandbox/nodes', { token: adminToken })).body.nodes[0].maxInstances, 1);
  } finally { server.close(); }
});

test('admin can rename and prioritize nodes without changing identity, tokens or running sandboxes', async t => {
  const f = await createFixture();
  t.after(async () => { await new Promise(resolve => f.server.close(resolve)); await new Promise(resolve => f.db.close(resolve)); });
  const created = await f.request('/api/admin/sandbox/nodes', { token: f.adminToken, method: 'POST', body: { name: 'Original node', placementPriority: 200 } });
  const id = created.body.node.id, route = `/api/admin/sandbox/nodes/${id}/settings`;
  const { dbGet } = require('../db-async');
  const before = await dbGet(f.db, 'SELECT * FROM sandbox_nodes WHERE id=?', [id]);
  await run(f.db, "INSERT INTO sandbox_instances(instance_uid,user_id,node_id,status,created_at,updated_at) VALUES('rename-fixture',1,?,'running',1,1)", [id]);
  const desired = { name: '  Preferred host  ', placementPriority: 1, expectedName: 'Original node', expectedPlacementPriority: 200 };
  assert.equal((await f.request(route, { token: f.userToken, method: 'PATCH', body: desired })).status, 403);
  assert.equal((await f.request(route, { method: 'PATCH', body: desired })).status, 403);
  for (const patch of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'bad\nname' }, { placementPriority: 0 }, { placementPriority: 1001 }, { placementPriority: 1.5 }, { placementPriority: '1' }, { status: 'active' }, { maxInstances: 200 }, { expectedName: null }]) {
    assert.equal((await f.request(route, { token: f.adminToken, method: 'PATCH', body: { ...desired, ...patch } })).status, 400, JSON.stringify(patch));
  }
  assert.equal((await f.request('/api/admin/sandbox/nodes/999999/settings', { token: f.adminToken, method: 'PATCH', body: desired })).status, 404);
  const result = await f.request(route, { token: f.adminToken, method: 'PATCH', body: desired });
  assert.equal(result.status, 200); assert.equal(result.body.node.name, 'Preferred host'); assert.equal(result.body.node.placementPriority, 1);
  assert.equal(result.body.node.usedSlots, 1); assert.equal(result.body.node.nodeUid, before.node_uid);
  assert.equal((await dbGet(f.db, 'SELECT auth_token_hash FROM sandbox_nodes WHERE id=?', [id])).auth_token_hash, before.auth_token_hash);
  assert.equal((await dbGet(f.db, "SELECT status FROM sandbox_instances WHERE instance_uid='rename-fixture'")).status, 'running');
  assert.equal((await dbGet(f.db, 'SELECT COUNT(*) AS count FROM sandbox_deployments')).count, 0);
  assert.equal((await f.request(route, { token: f.adminToken, method: 'PATCH', body: desired })).status, 200, 'lost response retry is idempotent');
  assert.equal((await dbGet(f.db, "SELECT COUNT(*) AS count FROM subscription_audit_logs WHERE action='sandbox_node_settings_updated'")).count, 1);
  assert.equal((await f.request(route, { token: f.adminToken, method: 'PATCH', body: { ...desired, name: 'Stale overwrite' } })).status, 409);
  await f.request('/api/admin/sandbox/nodes', { token: f.adminToken, method: 'POST', body: { name: 'Later priority', placementPriority: 300 } });
  const list = await f.request('/api/admin/sandbox/nodes', { token: f.adminToken });
  assert.deepEqual(list.body.nodes.map(node => node.placementPriority), [1, 300]);
  assert.ok(!JSON.stringify(list.body).includes('auth_token_hash'));
  assert.equal((await f.request('/api/admin/sandbox/nodes', { token: f.adminToken, method: 'POST', body: { name: 'Invalid priority', placementPriority: -1 } })).status, 400);
});

test('proxy administration and node routes enforce existing roles and ownership', async t => {
  const f=await createFixture();t.after(async()=>{await new Promise(r=>f.server.close(r));await new Promise(r=>f.db.close(r));});
  assert.equal((await f.request('/api/admin/sandbox/proxies',{token:f.userToken})).status,403);
  assert.equal((await f.request('/api/admin/sandbox/proxies')).status,403);
  const created=await f.request('/api/admin/sandbox/proxies',{token:f.adminToken,method:'POST',body:{name:'Proxy fixture',host:'proxy.example.test'}});
  assert.equal(created.status,201);assert.equal(created.body.server.enabled,false);assert.ok(created.body.bootstrap.serverToken);
  const list=await f.request('/api/admin/sandbox/proxies',{token:f.adminToken});assert.equal(list.status,200);assert.equal(list.body.servers.length,1);assert.ok(!JSON.stringify(list.body).includes(created.body.bootstrap.serverToken));
  const registration=await f.request('/api/admin/sandbox/nodes',{token:f.adminToken,method:'POST',body:{name:'Proxy node'}}),nodeId=registration.body.node.id;
  await f.request(`/api/admin/sandbox/nodes/${nodeId}/status`,{token:f.adminToken,method:'POST',body:{status:'active'}});
  const headers={'X-Node-Id':registration.body.node.nodeUid,'X-Node-Token':registration.body.token};
  await run(f.db,"INSERT INTO sandbox_instances(instance_uid,user_id,node_id,status,created_at,updated_at) VALUES('sbx_111111111111111111',1,?,'stopped',1,1)",[nodeId]);
  const route='/api/sandbox/node/network/sbx_111111111111111111';
  assert.equal((await f.request(route,{token:f.userToken})).status,401);
  assert.deepEqual((await f.request(route+'/prepare',{headers,method:'POST',body:{}})).body,{mode:'direct'});
  assert.equal((await f.request('/api/sandbox/node/network/sbx_222222222222222222',{headers})).status,404);
  assert.equal((await f.request(`/api/admin/sandbox/nodes/${nodeId}/proxy`,{token:f.userToken,method:'PATCH',body:{serverId:created.body.server.id}})).status,403);
  assert.equal((await f.request(`/api/admin/sandbox/nodes/${nodeId}/proxy`,{token:f.adminToken,method:'PATCH',body:{serverId:created.body.server.id}})).status,409,'older agents cannot be assigned a proxy');
  await run(f.db,'UPDATE sandbox_nodes SET agent_version=? WHERE id=?',['1.4.0',nodeId]);
  assert.equal((await f.request(`/api/admin/sandbox/nodes/${nodeId}/proxy`,{token:f.adminToken,method:'PATCH',body:{serverId:created.body.server.id}})).status,200);
  const blocked=await f.request(route+'/prepare',{headers,method:'POST',body:{}});assert.equal(blocked.status,503);assert.equal(blocked.body.code,'PROXY_UNAVAILABLE');
  assert.equal((await f.request('/api/sandbox/proxy/heartbeat',{method:'POST',body:{certificateFingerprint:'a'.repeat(64)}})).status,401);
});

test('capacity lock contention returns a retryable error and a later edit succeeds', async t => {
  const f = await createFixture();
  t.after(async () => { await new Promise(resolve => f.server.close(resolve)); await new Promise(resolve => f.db.close(resolve)); });
  const created = await f.request('/api/admin/sandbox/nodes', {
    token: f.adminToken, method: 'POST', body: { name: 'Busy capacity node', maxInstances: 20 }
  });
  const route = `/api/admin/sandbox/nodes/${created.body.node.id}/capacity`;
  const originalGet = f.db.get.bind(f.db);
  f.db.get = (sql, params, callback) => {
    if (sql.startsWith('SELECT * FROM sandbox_nodes WHERE id =')) {
      queueMicrotask(() => callback(Object.assign(new Error('lock timeout'), { code: '55P03' })));
      return;
    }
    return originalGet(sql, params, callback);
  };
  const response = await f.request(route, { token: f.adminToken, method: 'PATCH', body: { maxInstances: 10 } });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /Refresh.*try again/);
  f.db.get = originalGet;
  assert.equal((await f.request('/api/admin/sandbox/nodes', { token: f.adminToken })).body.nodes[0].maxInstances, 20);
  assert.equal((await f.request(route, { token: f.adminToken, method: 'PATCH', body: { maxInstances: 10 } })).status, 200);
});

test('sandbox activation requires a subscription and is idempotent', async () => {
  const { db, server, request, userToken, adminToken, sandbox } = await createFixture();
  try {
    // Create + activate a node so capacity exists.
    const created = await request('/api/admin/sandbox/nodes', {
      token: adminToken, method: 'POST', body: { name: 'Node B' }
    });
    const nodeUid = created.body.node.nodeUid;
    const nodeToken = created.body.token;
    await request(`/api/admin/sandbox/nodes/${created.body.node.id}/status`, {
      token: adminToken, method: 'POST', body: { status: 'active' }
    });
    await request('/api/sandbox/node/heartbeat', {
      method: 'POST', headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': nodeToken }, body: { runningInstances: 0 }
    });

    // Without a subscription, activation is refused.
    const noSub = await request('/api/sandbox/activate', {
      token: userToken, method: 'POST',
      body: { strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '12345678', password: 'pw' }
    });
    assert.equal(noSub.status, 403);
    assert.equal(noSub.body.code, 'SUBSCRIPTION_REQUIRED');

    await giveActiveSubscription(db, 1);

    // With a subscription, the selected pair is sent to deployment.
    const activated = await request('/api/sandbox/activate', {
      token: userToken, method: 'POST',
      body: { symbol: 'EURUSD', strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '12345678', password: 'pw' }
    });
    assert.equal(activated.status, 201);
    assert.equal(activated.body.sandbox.status, 'deploying');
    assert.equal(activated.body.sandbox.mt5AccountNumber, '******78');

    // Repeated activation returns the existing sandbox (no duplicates).
    const again = await request('/api/sandbox/activate', {
      token: userToken, method: 'POST',
      body: { strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '12345678', password: 'pw' }
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyExists, true);

    const instanceCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS c FROM sandbox_instances WHERE deleted_at IS NULL', (e, row) => (e ? reject(e) : resolve(row.c)));
    });
    assert.equal(instanceCount, 1);

    // The licence activation was created automatically (no key entry).
    const activation = await new Promise((resolve, reject) => {
      db.get(`SELECT * FROM ea_license_activations WHERE user_id = 1 AND mt5_account_number = '12345678'`,
        (e, row) => (e ? reject(e) : resolve(row)));
    });
    assert.ok(activation);
    assert.equal(activation.license_status, 'active');

    // Encryption is authenticated and reversible only with the sandbox key.
    const credential = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM sandbox_credentials', (e, row) => (e ? reject(e) : resolve(row)));
    });
    assert.ok(credential);
    assert.notEqual(credential.cipher, 'pw');
    assert.equal(sandbox.crypto.decryptJson(credential.cipher).password, 'pw');
    assert.ok(credential.cipher.startsWith('v1.'));

    // The deploy command reaches the node with the installation secret.
    const polled = await request('/api/sandbox/node/commands', {
      headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': nodeToken }
    });
    const deploy = polled.body.commands.find(c => c.command === 'deploy');
    assert.ok(deploy);
    assert.equal(deploy.payload.accountNumber, '12345678');
    assert.ok(deploy.payload.installationSecret);
    assert.equal(deploy.payload.symbol, 'EURUSD');

    // Status endpoint reflects the deploying sandbox.
    const status = await request('/api/sandbox/status', { token: userToken });
    assert.equal(status.status, 200);
    assert.equal(status.body.sandbox.status, 'deploying');
    assert.equal(status.body.subscription.status, 'active');
  } finally {
    server.close();
  }
});

test('sandbox controls, deletion, and user isolation', async () => {
  const { db, server, request, userToken, otherUserToken, adminToken } = await createFixture();
  try {
    const created = await request('/api/admin/sandbox/nodes', {
      token: adminToken, method: 'POST', body: { name: 'Node C' }
    });
    const nodeUid = created.body.node.nodeUid;
    const nodeToken = created.body.token;
    await request(`/api/admin/sandbox/nodes/${created.body.node.id}/status`, {
      token: adminToken, method: 'POST', body: { status: 'active' }
    });
    await request('/api/sandbox/node/heartbeat', {
      method: 'POST', headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': nodeToken }, body: {}
    });
    await giveActiveSubscription(db, 1);
    await request('/api/sandbox/activate', {
      token: userToken, method: 'POST',
      body: { strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '555777', password: 'pw' }
    });

    // Another user cannot see or control the sandbox.
    const foreignStatus = await request('/api/sandbox/status', { token: otherUserToken });
    assert.equal(foreignStatus.body.sandbox, null);
    const foreignStop = await request('/api/sandbox/stop', { token: otherUserToken, method: 'POST' });
    assert.equal(foreignStop.status, 404);

    // Invalid transitions are rejected (cannot start a deploying sandbox).
    const badStart = await request('/api/sandbox/start', { token: userToken, method: 'POST' });
    assert.equal(badStart.status, 409);

    // Simulate the agent reporting the sandbox running.
    const instance = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM sandbox_instances WHERE user_id = 1', (e, row) => (e ? reject(e) : resolve(row)));
    });
    await request('/api/sandbox/node/heartbeat', {
      method: 'POST', headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': nodeToken },
      body: { runningInstances: 1, instances: [{ instanceUid: instance.instance_uid, status: 'running', processId: 4321, cpuPercent: 3.2, memoryMb: 210 }] }
    });
    const running = await request('/api/sandbox/status', { token: userToken });
    assert.equal(running.body.sandbox.status, 'running');
    assert.equal(running.body.mt5Connection, 'unverified', 'process state alone does not establish a broker connection');
    assert.equal(running.body.health.host.status, 'online');
    assert.equal(running.body.health.ea.status, 'waiting', 'the node process report is separate from an authenticated EA heartbeat');

    // Pause / resume trading.
    const paused = await request('/api/sandbox/pause', { token: userToken, method: 'POST' });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.sandbox.tradingPaused, true);
    const resumed = await request('/api/sandbox/resume', { token: userToken, method: 'POST' });
    assert.equal(resumed.body.sandbox.tradingPaused, false);

    // Stop keeps configuration; delete requires confirmation.
    const stopped = await request('/api/sandbox/stop', { token: userToken, method: 'POST' });
    assert.equal(stopped.status, 200);
    const noConfirm = await request('/api/sandbox', { token: userToken, method: 'DELETE', body: {} });
    assert.equal(noConfirm.status, 400);
    const deleted = await request('/api/sandbox', { token: userToken, method: 'DELETE', body: { confirm: true } });
    assert.equal(deleted.status, 200);

    // Credentials are purged and the installation secret revoked on delete.
    const credCount = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS c FROM sandbox_credentials', (e, row) => (e ? reject(e) : resolve(row.c)));
    });
    assert.equal(credCount, 0);
    const installations = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM mt5_installations WHERE revoked_at IS NULL', (e, rows) => (e ? reject(e) : resolve(rows)));
    });
    assert.equal(installations.length, 0);

    // After deletion the user can activate again.
    const reactivated = await request('/api/sandbox/activate', {
      token: userToken, method: 'POST',
      body: { strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '555777', password: 'pw' }
    });
    assert.equal(reactivated.status, 201);
  } finally {
    server.close();
  }
});

test('admin overview, events and audit logging', async () => {
  const { server, request, userToken, adminToken } = await createFixture();
  try {
    const created = await request('/api/admin/sandbox/nodes', {
      token: adminToken, method: 'POST', body: { name: 'Node D' }
    });
    assert.equal(created.status, 201);

    const overview = await request('/api/admin/sandbox/overview', { token: adminToken });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.nodes.total, 1);
    assert.equal(overview.body.nodes.online, 0);

    const events = await request('/api/admin/sandbox/events', { token: adminToken });
    assert.equal(events.status, 200);
    assert.ok(events.body.events.some(e => e.event_type === 'NODE_REGISTERED'));

    // Non-admin tokens are rejected by the admin routes.
    const forbidden = await request('/api/admin/sandbox/overview', { token: userToken });
    assert.equal(forbidden.status, 403);
  } finally {
    server.close();
  }
});

test('sandbox activation without node capacity returns a useful JSON error', async () => {
  const { db, server, request, userToken } = await createFixture();
  try {
    await giveActiveSubscription(db, 1);
    const response = await request('/api/sandbox/activate', {
      token: userToken, method: 'POST',
      body: { strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '12345678', password: 'pw' }
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'NO_CAPACITY');
    assert.match(response.body.error, /No sandbox server capacity/);
    const status = await request('/api/sandbox/status', { token: userToken });
    assert.equal(status.body.sandbox, null);
  } finally {
    server.close();
  }
});
test('activation rejects unsupported pairs and accepts supported pairs', async () => {
  const { server, request, userToken } = await createFixture();
  try {
    for (const symbol of ['USDGPY', 'BTCUSD', '', null, 'XAUUSD\nExpert=other']) {
      const response = await request('/api/sandbox/activate', {
        token: userToken, method: 'POST',
        body: { symbol, brokerServer: 'Broker-Live', accountNumber: '12345678', password: 'pw' }
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'INVALID_SYMBOL');
    }
    for (const symbol of ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY']) {
      const response = await request('/api/sandbox/activate', {
        token: userToken, method: 'POST',
        body: { symbol, brokerServer: 'Broker-Live', accountNumber: '12345678', password: 'pw' }
      });
      assert.equal(response.status, 403, 'valid pairs reach the subscription gate');
    }
  } finally { server.close(); }
});
test('admin bulk deletion requires confirmation, protects access and preserves other resources', async () => {
  const { db, server, request, userToken, adminToken } = await createFixture();
  try {
    for (const resource of ['logs', 'events']) {
      const sql = resource === 'logs' ? 'INSERT INTO sandbox_logs (message, created_at) VALUES (?, ?)' : 'INSERT INTO sandbox_events (event_type, created_at) VALUES (?, ?)';
      for(let i=0;i<25;i++) await run(db,sql,['bulk-test',Date.now()]);
    }
    for (const resource of ['logs', 'events']) {
      const url='/api/admin/sandbox/'+resource;
      const before=await request(url,{token:adminToken});
      assert.ok(before.body.total>=25);
      for(const token of [undefined,userToken]) assert.equal((await request(url,{token,method:'DELETE',body:{confirm:true}})).status,403);
      assert.equal((await request(url,{token:adminToken,method:'DELETE',body:{}})).status,400);
      assert.equal((await request(url,{token:adminToken,method:'DELETE',body:{confirm:'true'}})).status,400);
      assert.equal((await request(url,{token:adminToken})).body.total,before.body.total);
      const cleared=await request(url+'?level=error&page=2',{token:adminToken,method:'DELETE',body:{confirm:true}});
      assert.equal(cleared.status,200);assert.equal(cleared.body.deleted,before.body.total);
      assert.equal((await request(url,{token:adminToken})).body.total,0);
      assert.equal((await request(url,{token:adminToken,method:'DELETE',body:{confirm:true}})).body.deleted,0);
      if(resource==='logs') assert.ok((await request('/api/admin/sandbox/events',{token:adminToken})).body.total>=25);
    }
    const audit=await new Promise((resolve,reject)=>db.all("SELECT * FROM subscription_audit_logs WHERE action IN ('sandbox_logs_cleared','sandbox_events_cleared')",(error,rows)=>error?reject(error):resolve(rows)));
    assert.equal(audit.length,4);
  } finally { server.close(); }
});

test('admin deletes logs and events without granting user access', async () => {
  const { db, server, request, userToken, adminToken } = await createFixture();
  try {
    for (const resource of ['logs', 'events']) {
      const sql = resource === 'logs' ? 'INSERT INTO sandbox_logs (message, created_at) VALUES (?, ?)' : 'INSERT INTO sandbox_events (event_type, created_at) VALUES (?, ?)';
      const row = await run(db, sql, ['test', Date.now()]);
      const url = '/api/admin/sandbox/' + resource + '/' + row.lastID;
      assert.equal((await request(url, { token: userToken, method: 'DELETE' })).status, 403);
      assert.equal((await request(url, { token: adminToken, method: 'DELETE' })).status, 200);
      assert.equal((await request(url, { token: adminToken, method: 'DELETE' })).status, 404);
      assert.equal((await request('/api/admin/sandbox/' + resource + '/1bad', { token: adminToken, method: 'DELETE' })).status, 400);
    }
  } finally { server.close(); }
});
