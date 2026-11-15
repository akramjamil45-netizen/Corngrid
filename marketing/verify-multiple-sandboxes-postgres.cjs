'use strict';
// Separate pools and an isolated, temporary schema. Never starts MT5.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../Corngrid-web');
const { Client } = require(path.join(root, 'node_modules/pg'));
const express = require(path.join(root, 'node_modules/express'));
const createDb = require(path.join(root, 'db-postgres'));
const { dbGet, dbRun } = require(path.join(root, 'db-async'));
async function main() {
  const env = require(path.join(root, 'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
  const schema = 'sandbox_multi_check_' + crypto.randomBytes(8).toString('hex');
  const url = new URL(env.DATABASE_URL); url.searchParams.set('options', '-c search_path=' + schema);
  const control = new Client({ connectionString: env.DATABASE_URL }), databases = [], servers = [];
  await control.connect();
  try {
    await control.query(`CREATE SCHEMA ${schema}`); await control.query(`SET search_path TO ${schema}`);
    for (const file of ['0001_initial.sql', '0003_subscriptions.sql', '0005_sandbox.sql', '0006_partner_applications_presets.sql', '0012_payment_request_archives.sql', '0014_multiple_sandboxes.sql']) {
      await control.query(fs.readFileSync(path.join(root, 'migrations/postgres', file), 'utf8'));
    }
    const stamp = Date.now();
    await control.query("INSERT INTO users(id,username,email,password) VALUES(1,'Test','one@example.test','test'),(2,'Other','two@example.test','test')");
    await control.query("INSERT INTO subscription_plans(id,name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES(1,'Test',1,'MYR',30,2,TRUE,0,0)");
    for (const id of [1, 2]) await control.query("INSERT INTO user_subscriptions(user_id,plan_id,status,purchase_price,currency,duration_days,max_activations,starts_at,expires_at,created_at,updated_at) VALUES($1,1,'active',1,'MYR',30,2,$2,$3,0,0)", [id, stamp - 1000, stamp + 86400000]);
    await control.query("INSERT INTO sandbox_nodes(node_uid,name,status,max_instances,last_heartbeat_at,created_at,updated_at) VALUES('node_test','Test node','active',10,$1,0,0)", [stamp]);
    const auth = (req, _res, next) => { req.user = { id: Number(req.get('X-Test-User') || 1) }; next(); };
    const admin = { verifyToken: (_req, res) => res.sendStatus(403) };
    for (let i = 0; i < 2; i++) {
      const db = createDb(url.toString()); databases.push(db);
      const app = express(); app.use(express.json());
      const sub = require(path.join(root, 'subscriptions/subscription-api'))(app, db, auth, admin, (req, _res, next) => { req.installation = { account_id: Number(req.get('X-Test-Installation')), user_id: 1 }; next(); });
      await sub.ready();
      const sandbox = require(path.join(root, 'sandbox')).createSandboxSystem(app, db, { verifyToken: auth, adminAuth: admin, subscriptionApi: sub, rateLimit: () => (_req, _res, next) => next() });
      await sandbox.ready;
      const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); servers.push(server);
    }
    const post = async (index, route, body, headers = {}) => {
      const response = await fetch('http://127.0.0.1:' + servers[index].address().port + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const activate = (index, accountNumber, headers) => post(index, '/api/sandbox/activate', { accountNumber, brokerServer: 'Test-Demo', password: 'fixture-broker-password' }, headers);
    let results = await Promise.all([activate(0, '1001'), activate(1, '1001')]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 201]);
    assert.equal(results[0].data.sandbox.instanceUid, results[1].data.sandbox.instanceUid);
    const db = databases[0];
    const desktop = await dbRun(db, "INSERT INTO mt5_accounts(user_id,account_number,broker_server,currency,account_name,linked_at) VALUES(1,'1000','Test-Demo','USD','Desktop',0)");
    results = await Promise.all([activate(0, '1002'), post(1, '/api/license/activate', {}, { 'X-Test-Installation': String(desktop.lastID) })]);
    assert.equal(results.filter(row => row.status === 201).length, 1);
    assert.equal((await dbGet(db, "SELECT COUNT(*) AS n FROM ea_license_activations WHERE user_id=1 AND license_status='active'")).n, 2);
    assert.equal((await dbGet(db, "SELECT COUNT(*) AS n FROM sandbox_deployments WHERE command='deploy'")).n, (await dbGet(db, 'SELECT COUNT(*) AS n FROM sandbox_instances')).n);
    // Distinct users contend for the last physical slot, with independent pools.
    await dbRun(db, "UPDATE sandbox_instances SET status='stopped'");
    await dbRun(db, 'UPDATE sandbox_nodes SET max_instances=1');
    await dbRun(db, 'UPDATE user_subscriptions SET max_activations=5');
    results = await Promise.all([activate(0, '1010'), activate(1, '2020', { 'X-Test-User': '2' })]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 503]);
    assert.equal((await dbGet(db, "SELECT COUNT(*) AS n FROM sandbox_instances WHERE status='deploying'")).n, 1);
    console.log(JSON.stringify({ postgresVerified: true, independentPools: true, sameAccountIdempotent: true, desktopQuotaRaceSafe: true, nodeCapacityRaceSafe: true }));
  } finally {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    for (const db of databases) await new Promise(resolve => db.close(resolve));
    if (!/^sandbox_multi_check_[a-f0-9]{16}$/.test(schema)) throw Error('Unexpected test schema');
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control.end();
  }
}
main().catch(error => { console.error('Multiple sandbox PostgreSQL check failed:', error.code || error.message); process.exitCode = 1; });
