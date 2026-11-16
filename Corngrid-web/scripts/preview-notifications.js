'use strict';
// Isolated loopback acceptance fixture: real notification DB/API and dashboard
// navigation, no dotenv/provider requests, agents, SMTP or production records.
const fs = require('node:fs'), path = require('node:path');
const { createFixture } = require('../test/helpers/notification-fixture');
async function main() {
  const f = await createFixture();
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
  f.app.get('/api/me', (_q, r) => r.json({ username: 'Fixture user', email: 'fixture@example.test', created_at: f.time() }));
  f.app.get('/api/mt5/accounts', (_q, r) => r.json({ accounts: [] }));
  f.app.get('/api/user/portfolio-sharing', (_q, r) => r.json({ isPublic: false, accounts: [] }));
  f.app.get('/api/chat/unread-count', (_q, r) => r.json({ unreadCount: 0 }));
  f.app.get('/fixture', (_q, r) => {
    r.cookie('corngrid_session', f.token(1), { httpOnly: true, sameSite: 'lax' });
    let html = fs.readFileSync(path.join(__dirname, '../public/dashboard.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace('</body>', '<script src="/dashboard.js"></script><script src="/notifications.js"></script></body>');
    r.type('html').send(html);
  });
  f.app.use(require('express').static(path.join(__dirname, '../public')));
  console.log(JSON.stringify({ url: f.base + '/fixture#notifications', isolated: true }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => f.close().then(() => process.exit(0)));
}
main().catch(() => { console.error('Isolated notification preview failed.'); process.exitCode = 1; });
