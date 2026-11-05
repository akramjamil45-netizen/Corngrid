const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
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

test('end-to-end: node connects over WebSocket, receives deploy, reports running', async t => {
  const sockets = [];
  const openSocket = url => { const socket = new WebSocket(url); sockets.push(socket); return socket; };
  const db = await openDatabase();
  const app = express();
  const jwtSecret = 'realtime-test-secret';
  app.use(express.json());

  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, email TEXT, password TEXT, bio TEXT, created_at TEXT);
  `, error => (error ? reject(error) : resolve())));
  await run(db, `INSERT INTO users (id, username, email, password, bio, created_at) VALUES (1, 'Alice', 'alice@example.test', 'x', '', CURRENT_TIMESTAMP)`);

  const verifyToken = createUserAuth({ db, jwtSecret });
  const mt5 = registerMt5Api(app, db, verifyToken);
  const adminAuth = {
    verifySessionToken(token) {
      try { const claims = jwt.verify(token, jwtSecret); return claims.sub === 'admin' && claims.role === 'admin' ? claims : null; }
      catch (_error) { return null; }
    },
    verifyToken: (req, res, next) => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      jwt.verify(token, jwtSecret, (error, claims) => {
        if (error || !claims || claims.sub !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
        req.admin = { id: 99, role: 'admin' };
        next();
      });
    }
  };
  const subscriptionApi = createSubscriptionApi(app, db, verifyToken, adminAuth, mt5.authenticateInstallation);
  await subscriptionApi.ready();
  const sandbox = createSandboxSystem(app, db, { verifyToken, adminAuth, subscriptionApi, rateLimit, jwtSecret });
  await sandbox.ready;

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => { for (const socket of sockets) socket.terminate(); server.close(); });
  sandbox.realtime.attach(server);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;
  const userToken = jwt.sign({ id: 1, authVersion: 0 }, jwtSecret);
  const adminToken = jwt.sign({ sub: 'admin', role: 'admin' }, jwtSecret);

  const request = async (route, { token, method = 'GET', body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await response.json(); } catch { /* empty */ }
    return { status: response.status, body: json };
  };

  // Give the user an active subscription.
  const now = Date.now();
  await run(db, `INSERT INTO subscription_plans (id, name, price, currency, duration_days, max_activations, is_active, created_at, updated_at) VALUES (1, 'Pro', 100, 'MYR', 30, 5, 1, ?, ?)`, [now, now]);
  await run(db, `INSERT INTO user_subscriptions (id, user_id, plan_id, status, purchase_price, currency, starts_at, expires_at, created_at, updated_at) VALUES (1, 1, 1, 'active', 100, 'MYR', ?, ?, ?, ?)`, [now - 1000, now + 86400000, now, now]);

  // Admin creates + activates a node.
  const created = await request('/api/admin/sandbox/nodes', { token: adminToken, method: 'POST', body: { name: 'WS Node' } });
  assert.equal(created.status, 201);
  const { nodeUid } = created.body.node;
  const nodeToken = created.body.token;
  await request(`/api/admin/sandbox/nodes/${created.body.node.id}/status`, { token: adminToken, method: 'POST', body: { status: 'active' } });

  // Connect a mock agent over WebSocket.
  const agent = openSocket(`${wsBase}/ws/sandbox/node`);
  const agentMessages = [];
  const waitFor = (predicate, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const found = agentMessages.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for agent message.'));
      setTimeout(check, 25);
    };
    check();
  });
  agent.on('message', raw => {
    try { agentMessages.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
  });

  await new Promise((resolve, reject) => {
    agent.on('open', resolve);
    agent.on('error', reject);
  });
  agent.send(JSON.stringify({ type: 'auth', nodeUid, token: nodeToken }));
  const authAck = await waitFor(message => message.type === 'authenticated');
  assert.equal(authAck.nodeUid, nodeUid);

  // Agent heartbeats over the socket so the node is online.
  agent.send(JSON.stringify({ type: 'heartbeat', machineName: 'WIN-WS', cpuCount: 4, ramMb: 16384, runningInstances: 0, instances: [] }));
  await waitFor(message => message.type === 'heartbeat_ack');

  // User activates a sandbox — the deploy command must arrive over the socket.
  const activated = await request('/api/sandbox/activate', {
    token: userToken, method: 'POST',
    body: { strategyCode: 'corngrid-ea', brokerServer: 'Broker-Live', accountNumber: '998877', password: 'secret' }
  });
  assert.equal(activated.status, 201);

  const deployCommand = await waitFor(message => message.type === 'command' && message.command === 'deploy');
  assert.equal(deployCommand.payload.accountNumber, '998877');
  assert.ok(deployCommand.payload.installationSecret);

  // Agent acknowledges the deploy and reports the instance running.
  agent.send(JSON.stringify({ type: 'command_result', commandUid: deployCommand.commandUid, success: true, result: { sandboxPath: 'C:\\CornGrid\\Sandbox\\Users\\x' } }));
  agent.send(JSON.stringify({
    type: 'heartbeat', runningInstances: 1,
    instances: [{ instanceUid: deployCommand.payload.instanceUid, status: 'running', processId: 7777, cpuPercent: 5, memoryMb: 300 }]
  }));
  await waitFor(message => message.type === 'heartbeat_ack');

  // Give the backend a moment to persist the heartbeat report.
  await new Promise(resolve => setTimeout(resolve, 200));

  const status = await request('/api/sandbox/status', { token: userToken });
  assert.equal(status.body.sandbox.status, 'running');
  assert.equal(status.body.mt5Connection, 'connected');

  // Admin WS receives the event stream (cookie-less: use the token fallback).
  const adminWs = openSocket(`${wsBase}/ws/admin/sandbox?token=${encodeURIComponent(adminToken)}`);
  const adminMessages = [];
  adminWs.on('message', raw => { try { adminMessages.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => { adminWs.on('open', resolve); adminWs.on('error', reject); });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(adminMessages.some(message => message.type === 'snapshot'), 'admin received a snapshot');

  // A bad node token is rejected.
  const impostor = openSocket(`${wsBase}/ws/sandbox/node`);
  await new Promise((resolve, reject) => { impostor.on('open', resolve); impostor.on('error', reject); });
  impostor.send(JSON.stringify({ type: 'auth', nodeUid, token: 'cgn_wrong' }));
  await new Promise(resolve => impostor.on('close', resolve));

  // Rotation must revoke the existing transport as well as fresh HTTP calls.
  const revoked = new Promise(resolve => agent.once('close', resolve));
  const rotated = await request(`/api/admin/sandbox/nodes/${created.body.node.id}/rotate-token`, {
    token: adminToken, method: 'POST', body: {}
  });
  assert.equal(rotated.status, 200);
  await revoked;
  const oldCredential = await fetch(`${base}/api/sandbox/node/commands`, {
    headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': nodeToken }
  });
  assert.equal(oldCredential.status, 403);
  const currentCredential = await fetch(`${base}/api/sandbox/node/commands`, {
    headers: { 'X-Node-Id': nodeUid, 'X-Node-Token': rotated.body.token }
  });
  assert.equal(currentCredential.status, 200);
  assert.equal(sandbox.nodes.isConnected(created.body.node.id), false);
  agent.close();
  adminWs.close();
  server.close();
});
