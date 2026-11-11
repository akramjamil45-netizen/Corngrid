'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const createAdminAuth = require('../admin-auth');
const createLoginHandler = require('../login-handler');
const createUserAuth = require('../user-auth');
const { createSandboxNodes } = require('../sandbox/sandbox-nodes');

test('shared administrator validation rejects rotated, disabled and expired sessions', async () => {
  const jwtSecret = 'dummy-security-regression-secret';
  const first = createAdminAuth({ email: 'admin@example.test', passwordHash: await bcrypt.hash('old-password', 4), jwtSecret });
  const second = createAdminAuth({ email: 'admin@example.test', passwordHash: await bcrypt.hash('new-password', 4), jwtSecret });
  const disabled = createAdminAuth({ jwtSecret });
  const token = await first.authenticate('admin@example.test', 'old-password');
  assert.equal(first.verifySessionToken(token).role, 'admin');
  assert.equal(second.verifySessionToken(token), null);
  assert.equal(disabled.verifySessionToken(token), null);
  const claims = jwt.verify(token, jwtSecret);
  delete claims.exp; delete claims.iat;
  assert.equal(first.verifySessionToken(jwt.sign(claims, jwtSecret, { expiresIn: -1 })), null);
});

test('old-password login never inherits a concurrent reset session version', async () => {
  const jwtSecret = 'dummy-login-race-secret';
  const hash = await bcrypt.hash('old-password', 4);
  let currentVersion = 0;
  const db = {
    exec(_sql, done) { done(null); },
    get(sql, _params, done) {
      if(sql.startsWith('SELECT user_id FROM account_archives'))return done(null,undefined);
      if (sql.includes('FROM users WHERE email')) {
        const snapshot = { id: 1, email: 'user@example.test', username: 'User', password: hash, email_verified: 1, login_auth_version: currentVersion };
        // Complete a reset after the initial SELECT snapshot, before bcrypt.
        currentVersion = 1;
        return done(null, snapshot);
      }
      if (sql.includes('AS account_id')) return done(null, { account_id: 1, auth_version: currentVersion, suspended_until: null, email_verified: 1 });
      // The vulnerable implementation's separate version read gets the new value.
      if (sql.includes('SELECT version')) return done(null, { version: currentVersion });
      throw new Error('Unexpected fixture query');
    }
  };
  let status = 200; let body;
  const response = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await createLoginHandler({ db, jwtSecret, adminAuth: { matchesEmail: () => false }, setAuthCookie() {}, isSameOriginRequest: () => false })
    ({ body: { email: 'user@example.test', password: 'old-password' } }, response);
  assert.equal(status, 200);
  assert.equal(jwt.verify(body.token, jwtSecret).authVersion, 0);
  let accepted = false;
  createUserAuth({ db, jwtSecret })({ method: 'GET', headers: { authorization: 'Bearer ' + body.token } }, response, () => { accepted = true; });
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(accepted, false);
  assert.equal(status, 403);
});

test('node rotation closes its old socket and mismatched generation never receives new commands', async () => {
  let tokenHash = 'old-generation'; let sent = 0; let closed = 0;
  const db = {
    get(sql, _params, done) { done(null, sql.includes('SELECT id, node_uid') ? { id: 1, node_uid: 'node_dummy' } : { status: 'active', auth_token_hash: tokenHash }); },
    run(sql, params, done) {
      if (sql.includes('SET auth_token_hash')) tokenHash = params[0];
      done.call({ changes: 1, lastID: 1 }, null);
    }
  };
  const nodes = createSandboxNodes({ db, events: { emit: async () => {} } });
  const socket = () => ({ close() { closed++; }, send() { sent++; } });
  nodes.attachConnection(1, socket(), tokenHash);
  await nodes.rotateNodeToken(1);
  assert.equal(closed, 1);
  assert.equal(nodes.isConnected(1), false);
  // A stale authentication completion must also fail at command delivery.
  nodes.attachConnection(1, socket(), 'old-generation');
  await nodes.queueCommand(1, 'deploy', { payload: { password: 'dummy-only' } });
  assert.equal(sent, 0);
  assert.equal(closed, 2);
  assert.equal(nodes.isConnected(1), false);
});

test('a pending command lookup cannot disconnect a replacement node session', async () => {
  let finishLookup;
  let oldClosed = 0; let replacementClosed = 0; let sent = 0;
  const db = {
    get(_sql, _params, done) { finishLookup = done; },
    run(_sql, _params, done) { done.call({ changes: 1, lastID: 1 }, null); }
  };
  const nodes = createSandboxNodes({ db, events: { emit: async () => {} } });
  nodes.attachConnection(1, { close() { oldClosed++; }, send() { sent++; } }, 'old-generation');
  const dispatch = nodes.queueCommand(1, 'deploy', { payload: { password: 'dummy-only' } });
  await Promise.resolve();
  assert.equal(typeof finishLookup, 'function');
  nodes.attachConnection(1, { close() { replacementClosed++; }, send() { sent++; } }, 'new-generation');
  finishLookup(null, { status: 'active', auth_token_hash: 'new-generation' });
  await dispatch;
  assert.equal(oldClosed, 1);
  assert.equal(replacementClosed, 0);
  assert.equal(nodes.isConnected(1), true);
  assert.equal(sent, 0);
});
