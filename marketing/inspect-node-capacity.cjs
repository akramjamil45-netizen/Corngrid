'use strict';
// Operational checks: no credentials or customer records are printed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const modules = path.resolve(__dirname, '../Corngrid-web/node_modules');
const env = require(path.join(modules, 'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
const adminVersion = crypto.createHash('sha256').update(env.ADMIN_EMAIL.trim().toLowerCase() + '\0' + env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
const token = require(path.join(modules, 'jsonwebtoken')).sign({ sub: 'admin', role: 'admin', adminVersion }, env.JWT_SECRET, { expiresIn: '5m' });
async function api(origin, route, method = 'GET', body) {
  const started = Date.now();
  try {
    const response = await fetch(origin + route, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) });
    const data = await response.json();
    return { origin, route, status: response.status, ms: Date.now() - started, data };
  } catch (error) { return { origin, route, ms: Date.now() - started, error: error.code || error.name }; }
}
async function database() {
  const { Client } = require(path.join(modules, 'pg'));
  const db = new Client({ connectionString: env.DATABASE_URL, application_name: 'corngrid-incident-readonly', connectionTimeoutMillis: 3000, statement_timeout: 3000 });
  await db.connect();
  try {
    const activity = (await db.query(`SELECT pid, state, wait_event_type, wait_event, EXTRACT(EPOCH FROM (clock_timestamp()-xact_start))::int AS transaction_age_seconds, pg_blocking_pids(pid) AS blockers, LEFT(query, POSITION(' ' IN query || ' ')-1) AS operation FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows;
    const nodes = (await db.query('SELECT id,name,max_instances,last_heartbeat_at FROM sandbox_nodes ORDER BY id')).rows;
    console.log(JSON.stringify({ activity, nodes }));
  } finally { await db.end(); }
}
async function main() {
  if (['capacity', 'capacity-public'].includes(process.argv[2])) {
    const result = await api(process.argv[2] === 'capacity-public' ? 'https://corngrid.com' : 'http://127.0.0.1:3000', '/api/admin/sandbox/nodes/3/capacity', 'PATCH', { maxInstances: 10 });
    console.log(JSON.stringify({ ...result, data: result.data && { message: result.data.message, error: result.data.error, node: result.data.node && { id: result.data.node.id, maxInstances: result.data.node.maxInstances, usedSlots: result.data.node.usedSlots } } }));
    if (result.status !== 200) process.exitCode = 1;
    return;
  }
  await database();
  const results = await Promise.all(['http://127.0.0.1:3000','https://corngrid.com'].map(origin => api(origin, '/api/admin/sandbox/nodes')));
  for (const result of results) console.log(JSON.stringify({ ...result, data: result.data && { error: result.data.error, nodes: result.data.nodes?.map(n => ({ id: n.id, maxInstances: n.maxInstances, usedSlots: n.usedSlots, online: n.online, version: n.agentVersion })) } }));
}
main().catch(error => { console.error('Capacity inspection failed:', error.code || error.name); process.exitCode = 1; });
