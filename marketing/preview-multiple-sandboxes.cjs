'use strict';
// In-memory UI fixture; fake node has no connection and cannot launch MT5.
const path = require('node:path'), fs = require('node:fs');
const root = path.resolve(__dirname, '../Corngrid-web');
const express = require(path.join(root, 'node_modules/express')), sqlite = require(path.join(root, 'node_modules/sqlite3'));
const { dbRun } = require(path.join(root, 'db-async'));
async function main() {
  const db = new sqlite.Database(':memory:'), app = express(); app.use(express.json());
  await dbRun(db, 'CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT)');
  await dbRun(db, "INSERT INTO users VALUES(1,'Preview','preview@example.test','test')");
  const auth = (req, _res, next) => { req.user = { id: 1 }; next(); }, admin = { verifyToken: (_req, res) => res.sendStatus(403) };
  const mt5 = require(path.join(root, 'mt5-api'))(app, db, auth);
  const sub = require(path.join(root, 'subscriptions/subscription-api'))(app, db, auth, admin, mt5.authenticateInstallation); await sub.ready();
  const sandbox = require(path.join(root, 'sandbox')).createSandboxSystem(app, db, { verifyToken: auth, adminAuth: admin, subscriptionApi: sub, rateLimit: () => (_req, _res, next) => next() }); await sandbox.ready;
  const stamp = Date.now();
  await dbRun(db, "INSERT INTO subscription_plans(id,name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES(1,'Preview',1,'MYR',30,3,1,0,0)");
  await dbRun(db, "INSERT INTO user_subscriptions(user_id,plan_id,status,purchase_price,currency,max_activations,starts_at,expires_at,created_at,updated_at) VALUES(1,1,'active',1,'MYR',3,?,?,0,0)", [stamp - 1000, stamp + 86400000]);
  await dbRun(db, "INSERT INTO sandbox_nodes(node_uid,name,status,max_instances,last_heartbeat_at,created_at,updated_at) VALUES('node_preview','Preview node','active',5,?,0,0)", [stamp]);
  for (const accountNumber of ['12345679', '12345688']) await sandbox.manager.activateSandbox(1, { accountNumber, brokerServer: 'LiteFinance-MT5-Demo', password: 'fixture-broker-password' });
  await dbRun(db, "UPDATE sandbox_instances SET status='running',started_at=?,memory_mb=128,last_heartbeat_at=?", [stamp, stamp]);
  const heartbeat = setInterval(() => require(path.join(root, 'db-write')).exclusive(db, () => dbRun(db, 'UPDATE sandbox_nodes SET last_heartbeat_at=?', [Date.now()])).catch(() => {}), 30000);
  heartbeat.unref();
  app.get('/preview', (_req, res) => {
    let html = fs.readFileSync(path.join(root, 'public/dashboard.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace('</body>', '<script src="sandbox.js"></script><script>document.getElementById("page-overview").classList.remove("is-visible");document.getElementById("page-sandbox").classList.add("is-visible");document.title="Multiple sandbox preview";CornGridSandbox.onOpen();</script></body>');
    res.type('html').send(html);
  });
  app.post('/preview-limit', async (_req, res) => { await dbRun(db, 'UPDATE user_subscriptions SET max_activations=2'); res.json({ ok: true }); });
  app.use(express.static(path.join(root, 'public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  console.log(JSON.stringify({ url: 'http://127.0.0.1:' + server.address().port + '/preview' }));
  process.on('SIGINT', () => { clearInterval(heartbeat); server.close(() => db.close(() => process.exit(0))); });
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
