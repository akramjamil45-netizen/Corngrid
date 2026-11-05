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
      token, method: 'POST', body: { brokerServer: 'Dummy-Demo', accountNumber, password: 'dummy-only' }
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
  } finally { server.close(); }
});

test('sandbox activation requires a subscription and is idempotent', async () => {
  const { db, server, request, userToken, adminToken } = await createFixture();
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

    // Credentials are encrypted at rest — the raw password never appears.
    const credential = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM sandbox_credentials', (e, row) => (e ? reject(e) : resolve(row)));
    });
    assert.ok(credential);
    assert.ok(!credential.cipher.includes('pw'));
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
    assert.equal(running.body.mt5Connection, 'connected');

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
