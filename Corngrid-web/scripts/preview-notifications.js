'use strict';
// Isolated loopback acceptance fixture: real notification DB/API and dashboard
// navigation, no dotenv/provider requests, agents, SMTP or production records.
const fs = require('node:fs'), path = require('node:path');
const { createFixture } = require('../test/helpers/notification-fixture');
async function main() {
  const f = await createFixture();
  let scenario = 'normal'; const calls = [], themes = new Map(), chatUnread = new Map();
  f.app.use((req, _res, next) => { if (req.path.startsWith('/api/')) calls.push({ method: req.method, path: req.path }); next(); });
  await f.service.notify(1, 'subscription_suspended', 'Subscription status updated', 'Fixture subscription status.');
  await f.run("INSERT INTO sandbox_nodes VALUES(1,'active',1)");
  await f.run("INSERT INTO sandbox_instances VALUES(1,1,1,'running',1,1,1,NULL)");
  await f.run("INSERT INTO mt5_accounts VALUES(1,1,'123456789',1,1,NULL)");
  await f.run("INSERT INTO user_subscriptions VALUES(1,1,'active',1,?,NULL)", [f.time() + 2 * 86400000]);
  await f.run("INSERT INTO subscription_payments VALUES(1,1,'pending_payment',50,'MYR','stripe',?)", [f.time()]);
  await f.service.scanUser(1);
  f.app.post('/fixture/reset', async (_q, r) => {
    await f.run('DELETE FROM user_notification_details'); await f.run('DELETE FROM user_notifications'); await f.run('DELETE FROM notification_alert_state');
    await f.service.notify(1, 'subscription_suspended', 'Subscription status updated', 'Fixture subscription status.'); await f.service.scanUser(1); r.json({ ok: true });
  });
  const account = user => ({ id: user, maskedAccount: '****6789', accountName: 'Fixture account', brokerServer: 'Fixture-Demo', currency: 'USDc', status: scenario === 'offline' ? 'Offline' : 'Online', lastHeartbeat: scenario === 'offline' ? f.time() - 600000 : f.time(), linkedAt: f.time() - 86400000, balance: 100, equity: 100, openPositions: 0, eaVersion: 'fixture' });
  function overview() {
    const active = !['new', 'review', 'rejected'].includes(scenario);
    const subscription = scenario === 'new' ? null : { id: 1, status: active ? 'active' : scenario === 'review' ? 'pending_approval' : 'rejected', planName: 'Fixture plan', expiresAt: active ? f.time() + 20 * 86400000 : null, startsAt: f.time() - 86400000, maxActivations: 2 };
    const latestPayment = ['review', 'pending', 'paid', 'rejected'].includes(scenario) ? { id: 1, amount: 50, currency: 'MYR', payment_method: scenario === 'pending' ? 'stripe' : 'duitnow', status: scenario === 'review' ? 'pending_approval' : scenario === 'paid' ? 'approved' : scenario === 'rejected' ? 'rejected' : 'pending_payment', plan_name: 'Fixture plan', rejection_reason: scenario === 'rejected' ? 'Fixture review reason' : null } : null;
    return { subscription, latestPayment, scheduledRenewal: null, payments: latestPayment ? [latestPayment] : [], activations: [], activationCount: 1, maxActivations: 2, daysRemaining: active ? 20 : null };
  }
  f.app.post('/fixture/scenario', (q, r) => { if (!['normal', 'new', 'offline', 'review', 'pending', 'paid', 'rejected', 'subscription-error'].includes(q.body?.scenario)) return r.sendStatus(400); scenario = q.body.scenario; r.json({ ok: true }); });
  f.app.get('/fixture/calls', (_q, r) => r.json({ calls }));
  f.app.get('/api/me', f.verifyToken, (q, r) => r.json({ id: q.user.id, username: 'Fixture user ' + q.user.id, email: 'fixture@example.test', created_at: f.time(), preferences: { theme: themes.get(q.user.id) || 'dark' } }));
  f.app.patch('/api/user/preferences', f.verifyToken, (q, r) => { if (!['dark','light','system'].includes(q.body?.theme)) return r.sendStatus(400); themes.set(q.user.id, q.body.theme); r.json({ preferences: { theme: q.body.theme } }); });
  f.app.get('/api/mt5/accounts', f.verifyToken, (q, r) => r.json({ accounts: scenario === 'new' ? [] : [account(q.user.id)] }));
  f.app.get('/api/subscription/overview', f.verifyToken, (_q, r) => scenario === 'subscription-error' ? r.status(503).json({ error: 'Fixture refresh unavailable' }) : r.json(overview()));
  f.app.get('/api/subscription/plans', f.verifyToken, (_q, r) => r.json({ plans: [{ id: 1, name: 'Fixture plan', price: 50, currency: 'MYR', durationDays: 30, maxActivations: 2 }] }));
  f.app.get('/api/subscription/downloads', f.verifyToken, (_q, r) => r.json({ versions: [] }));
  f.app.get('/api/subscription/payment-methods', f.verifyToken, (_q, r) => r.json({ duitnow: true, stripe: true }));
  f.app.get('/api/subscription/stripe/payment/:id', f.verifyToken, (_q, r) => r.json({ id: 'fixture-order', status: 'pending' }));
  f.app.post('/api/subscription/stripe/orders/:id/reconcile', f.verifyToken, (_q, r) => r.json({ id: 'fixture-order', status: 'pending', activated_at: null }));
  f.app.get('/api/sandbox/status', f.verifyToken, (q, r) => {
    const exists = scenario !== 'new', id = 'fixture-sandbox-' + q.user.id;
    if (q.query.instanceUid && q.query.instanceUid !== id) return r.status(404).json({ error: 'Sandbox not found.' });
    const raw = exists ? { status: 'running', last_heartbeat_at: f.time(), trading_paused: 0 } : null;
    const node = exists ? { status: 'active', last_heartbeat_at: scenario === 'offline' ? f.time() - 600000 : f.time() } : null;
    const row = exists ? { instanceUid: id, status: 'running', mt5AccountNumber: '****6789', brokerServer: 'Fixture-Demo', strategyName: 'Fixture EA', lastHeartbeatAt: f.time(), startedAt: f.time() - 3600000, cpuPercent: 4, memoryMb: 64 } : null;
    const health = require('../sandbox/sandbox-health').sandboxHealth({ instance: raw, node, account: exists ? { last_heartbeat: account(q.user.id).lastHeartbeat } : null, now: f.time() });
    r.json({ sandbox: row, sandboxes: row ? [row] : [], subscription: { status: scenario === 'new' ? 'none' : 'active' }, capacity: { maxSandboxes: scenario === 'new' ? 0 : 2, sandboxCount: exists ? 1 : 0, activeActivations: exists ? 1 : 0, canAdd: scenario !== 'new' }, node: node ? { name: 'Fixture node', online: health.host.status === 'online' } : null, mt5Connection: health.mt5.status, health });
  });
  f.app.get('/api/sandbox/strategies', f.verifyToken, (_q, r) => r.json({ strategies: [{ code: 'fixture', name: 'Fixture EA', supportedPairs: ['XAUUSD'] }] }));
  f.app.get('/mt5-brokers.json', (_q, r) => r.json({ brokers: [{ id: 'fixture', name: 'Fixture Broker', servers: ['Fixture-Demo'] }] }));
  f.app.get('/api/portfolio', f.verifyToken, (q, r) => r.json({ accounts: [account(q.user.id)], currency: 'USDc', balance: 100, balanceAvailable: true, equity: 100, equityAvailable: true, floatingProfit: 0, floatingAvailable: true, lastUpdate: f.time() }));
  f.app.get('/api/portfolio/performance', f.verifyToken, (_q, r) => r.json({ snapshots: [], snapshotUnavailableReason: 'Isolated fixture has no trade history.' }));
  f.app.get('/api/portfolio/positions', f.verifyToken, (_q, r) => r.json({ items: [], total: 0 }));
  f.app.get('/api/portfolio/trades', f.verifyToken, (_q, r) => r.json({ items: [], total: 0, symbols: [] }));
  f.app.get('/api/user/portfolio-sharing', (_q, r) => r.json({ isPublic: false, accounts: [] }));
  f.app.post('/fixture/chat-unread', f.verifyToken, (q, r) => { const count = q.body?.unreadCount; if (!Number.isSafeInteger(count) || count < 0) return r.sendStatus(400); chatUnread.set(q.user.id, count); r.json({ ok:true }); });
  f.app.get('/api/chat/unread-count', f.verifyToken, (q, r) => r.json({ unreadCount: chatUnread.get(q.user.id) || 0 }));
  f.app.get('/api/chat/conversations', f.verifyToken, (_q, r) => r.json({ conversations: [] }));
  f.app.get('/fixture', (q, r) => {
    r.cookie('corngrid_session', f.token(q.query.user === '2' ? 2 : 1), { httpOnly: true, sameSite: 'lax' });
    let html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace('</head>', '<script src="/interface.js"></script><script src="/experience-model.js"></script><script src="/corngrid-select.js" defer></script></head>');
    html = html.replace('</body>', '<script src="/stripe-checkout.js"></script><script src="/dashboard.js"></script><script src="/workplace.js"></script><script src="/notifications.js"></script><script src="/sandbox.js"></script></body>');
    r.type('html').send(html);
  });
  f.app.use(require('express').static(path.join(__dirname, '../public')));
  console.log(JSON.stringify({ url: f.base + '/fixture#notifications', isolated: true }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => f.close().then(() => process.exit(0)));
}
main().catch(() => { console.error('Isolated notification preview failed.'); process.exitCode = 1; });
