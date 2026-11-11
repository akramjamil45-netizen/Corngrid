'use strict';
// Verify the deployed database adapter in a temporary, isolated schema.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const source = path.resolve(__dirname, '../Corngrid-web');
const { Client } = require(path.join(source, 'node_modules/pg'));
const express = require(path.join(source, 'node_modules/express'));
const createPostgresDatabase = require(path.join(source, 'db-postgres'));
const { dbRun, dbGet } = require(path.join(source, 'db-async'));
const { createSandboxCrypto } = require(path.join(source, 'sandbox/sandbox-crypto'));
const { createPartnerPayouts } = require(path.join(source, 'partner/partner-payouts'));

async function main() {
  const env = require(path.join(source, 'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
  const schema = 'payout_check_' + crypto.randomBytes(8).toString('hex');
  const control = new Client({ connectionString: env.DATABASE_URL });
  const scoped = new URL(env.DATABASE_URL);
  scoped.searchParams.set('options', '-c search_path=' + schema);
  let db, other, server, otherServer;
  await control.connect();
  try {
    await control.query(`CREATE SCHEMA ${schema}`);
    await control.query(`SET search_path TO ${schema}`);
    await control.query('CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE trading_strategies(id INTEGER PRIMARY KEY)');
    const base = fs.readFileSync(path.join(source, 'migrations/postgres/0005_sandbox.sql'), 'utf8');
    const tables = base.match(/CREATE TABLE IF NOT EXISTS (?:partner_profiles|partner_commissions|partner_transactions|partner_payouts|partner_payout_transactions) \([\s\S]*?\n\);/g);
    assert.equal(tables.length, 5);
    for (const sql of tables) await control.query(sql);
    await control.query('CREATE TABLE subscription_audit_logs(id SERIAL PRIMARY KEY, actor_id INTEGER, actor_role TEXT, action TEXT, affected_type TEXT, affected_id INTEGER, metadata TEXT, reason TEXT, ip_address TEXT, created_at BIGINT)');
    await control.query(fs.readFileSync(path.join(source, 'migrations/postgres/0011_partner_payout_requests.sql'), 'utf8'));
    db = createPostgresDatabase(scoped.toString());
    other = createPostgresDatabase(scoped.toString());
    const stamp = Date.now();
    await dbRun(db, 'INSERT INTO users(id) VALUES(1)');
    await dbRun(db, "INSERT INTO partner_profiles(user_id,display_name,status,created_at,updated_at) VALUES(1,'Isolated Test','active',?,?)", [stamp, stamp]);
    await dbRun(db, `INSERT INTO partner_transactions(reference,idempotency_key,partner_id,gross_amount,commission_amount,currency,status,created_at,status_updated_at)
      VALUES('PG-TEST','pg:1',1,250,100,'MYR','approved',?,?)`, [stamp, stamp]);
    const bankCrypto = createSandboxCrypto({ encryptionKey: crypto.randomBytes(32).toString('hex') });
    async function start(database) {
      const app = express(); app.use(express.json());
      const payout = createPartnerPayouts({ db: database, crypto: bankCrypto, events: { emit: async () => {} } });
      payout.registerRoutes(app, (req, _res, next) => { req.user = { id: 1 }; next(); }, (req, _res, next) => { req.admin = { id: 99 }; next(); }, () => (_req, _res, next) => next());
      return new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    }
    server = await start(db); otherServer = await start(other);
    async function request(route, body, instance = server, method = 'POST') {
      const response = await fetch(`http://127.0.0.1:${instance.address().port}` + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await request('/api/partner/bank-details', { bankName: 'Test Bank', accountHolder: 'Isolated Test', accountNumber: '1234567890', confirmOwnership: true }, server, 'PUT')).status, 200);
    const replies = await Promise.all([request('/api/partner/payouts', { amount: 30, requestKey: crypto.randomUUID() }), request('/api/partner/payouts', { amount: 30, requestKey: crypto.randomUUID() }, otherServer)]);
    assert.deepEqual(replies.map(row => row.status).sort(), [201, 409]);
    const payout = await dbGet(db, 'SELECT id FROM partner_payouts');
    assert.equal((await request(`/api/admin/payouts/${payout.id}/status`, { status: 'paid', reference: 'PG-PARTIAL-1', confirmTransferred: true })).status, 200);
    assert.equal((await request('/api/partner/payout-summary', null, server, 'GET')).body.availableBalance, 70);
    assert.equal((await dbGet(db, 'SELECT status FROM partner_transactions')).status, 'approved');
    assert.equal((await request('/api/partner/payouts', { amount: 70, requestKey: crypto.randomUUID() })).status, 201);
    const second = await dbGet(db, 'SELECT id FROM partner_payouts ORDER BY id DESC LIMIT 1');
    assert.equal((await request(`/api/admin/payouts/${second.id}/status`, { status: 'paid', reference: 'PG-FINAL-2', confirmTransferred: true })).status, 200);
    assert.equal((await dbGet(db, 'SELECT status FROM partner_transactions')).status, 'paid');
    assert.equal((await request('/api/partner/payout-summary', null, server, 'GET')).body.availableBalance, 0);
    console.log(JSON.stringify({ postgresVerified: true, separateConnectionRace: true, partialPayment: true, fullSettlement: true }));
  } finally {
    for (const instance of [server, otherServer]) if (instance) await new Promise(resolve => instance.close(resolve));
    for (const database of [db, other]) if (database) await new Promise(resolve => database.close(resolve));
    if (!/^payout_check_[a-f0-9]{16}$/.test(schema)) throw new Error('Unexpected test schema');
    await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await control.end();
  }
}
main().catch(error => { console.error('Isolated payout verification failed:', error.code || error.message); process.exitCode = 1; });
