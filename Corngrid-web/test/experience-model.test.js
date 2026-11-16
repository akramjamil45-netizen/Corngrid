'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { checkoutState, attentionItems } = require('../public/experience-model');
const { sandboxHealth } = require('../sandbox/sandbox-health');
const time = 1800000000000;
test('checkout progresses from actual payment and entitlement states; a success URL is not evidence', () => {
  assert.equal(checkoutState().step, 0);
  const pending = { latestPayment: { id: 1, status: 'pending_payment', payment_method: 'stripe' } };
  assert.equal(checkoutState({ ...pending, success: true }).state, 'payment');
  assert.equal(checkoutState({ ...pending, order: { status: 'paid' } }).state, 'verification');
  assert.equal(checkoutState({ ...pending, order: { status: 'pending' } }).complete, false);
  assert.equal(checkoutState({ latestPayment: { status: 'pending_approval', payment_method: 'duitnow' } }).title, 'Awaiting administrator review');
  assert.equal(checkoutState({ latestPayment: { status: 'approved' }, subscription: { status: 'active' } }).complete, true);
  assert.equal(checkoutState({ latestPayment: { status: 'approved' }, subscription: { status: 'suspended' } }).complete, false);
  assert.equal(checkoutState({ latestPayment: { status: 'approved' }, order: { activated_at: time }, subscription: { status: 'suspended' } }).complete, false);
  for (const status of ['failed', 'expired']) assert.equal(checkoutState({ ...pending, order: { status } }).state, 'incomplete');
});
test('pending renewals retain current access and an abandoned checkout cannot override confirmed payment', () => {
  const subscription = { status: 'active' };
  const renewal = checkoutState({ subscription, latestPayment: { status: 'pending_payment' } });
  assert.equal(renewal.state, 'payment'); assert.match(renewal.detail, /current subscription remains active/);
  assert.equal(checkoutState({ subscription, latestPayment: { status: 'approved' }, order: { status: 'expired' } }).state, 'active');
  assert.equal(checkoutState({ subscription, latestPayment: { status: 'cancelled' }, order: { status: 'paid', activated_at: time } }).state, 'active');
  assert.match(checkoutState({ subscription, latestPayment: { status: 'approved' }, scheduledRenewal: { startsAt: time } }).detail, /renewal is confirmed/);
});
test('Overview attention is driven by real setup status and does not warn about a paid scheduled renewal', () => {
  assert.deepEqual(attentionItems(), []);
  const first = attentionItems({ accounts: [], subscription: { subscription: null }, sandbox: { sandboxes: [] } }, time);
  assert.deepEqual(first.map(item => item.key), ['access', 'account']);
  const data = { accounts: [{ status: 'Offline' }], subscription: { subscription: { status: 'active', expiresAt: time + 86400000 }, latestPayment: { status: 'pending_payment' } }, sandbox: { sandboxes: [{}] } };
  assert.deepEqual(attentionItems(data, time).map(item => item.key), ['payment', 'expiry', 'ea']);
  data.subscription.scheduledRenewal = { startsAt: time + 86400000 }; assert(!attentionItems(data, time).some(item => item.key === 'expiry'));
});
test('a running process never claims broker connectivity or trade execution', () => {
  const instance = { status: 'running', last_heartbeat_at: time }, node = { status: 'active', last_heartbeat_at: time };
  const waiting = sandboxHealth({ instance, node, account: null, now: time });
  assert.equal(waiting.host.status, 'online'); assert.equal(waiting.terminal.status, 'running'); assert.equal(waiting.mt5.status, 'unverified'); assert.equal(waiting.ea.status, 'waiting');
  const reporting = sandboxHealth({ instance, node, account: { last_heartbeat: time }, now: time }); assert.equal(reporting.ea.status, 'reporting'); assert.equal(reporting.mt5.status, 'unverified'); assert.match(reporting.ea.detail, /does not prove/);
});
test('stale, future, disabled-node, paused and authentication-error telemetry is represented honestly', () => {
  const instance = { status: 'running', last_heartbeat_at: time, trading_paused: 1 }, node = { status: 'active', last_heartbeat_at: time };
  assert.match(sandboxHealth({ instance, node, account: { last_heartbeat: time }, now: time }).ea.detail, /paused/);
  for (const nodeStamp of [time - 1000000, time + 120000]) { const health = sandboxHealth({ instance, node: { ...node, last_heartbeat_at: nodeStamp }, now: time }); assert.equal(health.host.status, 'offline'); assert.equal(health.terminal.status, 'stale'); assert.equal(health.nextAction.page, 'chat'); }
  assert.equal(sandboxHealth({ instance, node: { ...node, status: 'disabled' }, now: time }).host.status, 'offline');
  const bad = sandboxHealth({ instance, node, account: { last_heartbeat: time - 1000000, auth_error_at: time }, now: time }); assert.equal(bad.mt5.status, 'authentication_error'); assert.equal(bad.ea.status, 'authentication_error');
  assert.equal(sandboxHealth({ instance: null, node: null, account: null, now: time }).host.status, 'unassigned');
});
