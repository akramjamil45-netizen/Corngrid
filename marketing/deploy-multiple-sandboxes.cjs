'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const source = path.resolve(__dirname, '../Corngrid-web'), target = 'C:/Website/Website/Corngrid-web';
const files = ['sandbox/index.js', 'sandbox/sandbox-api.js', 'sandbox/sandbox-admin-api.js', 'sandbox/sandbox-manager.js', 'sandbox/sandbox-nodes.js', 'sandbox/sandbox-schema.js', 'subscriptions/subscription-api.js', 'public/sandbox.js', 'public/dashboard.html', 'public/dashboard.css', 'migrations/postgres/0014_multiple_sandboxes.sql', 'migrations/sqlite/0014_multiple_sandboxes.sql', 'docs/SANDBOX_API_DOCUMENTATION.md', 'docs/SANDBOX_ARCHITECTURE.md'];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function main() {
  const env = require(path.join(source, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(target, '.env')));
  const { Client } = require(path.join(source, 'node_modules/pg')), db = new Client({ connectionString: env.DATABASE_URL }); await db.connect();
  try {
    if (process.argv.includes('--inspect')) {
      const counts = (await db.query("SELECT (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL) AS sandboxes,(SELECT COUNT(*) FROM sandbox_credentials) AS credentials,(SELECT COUNT(*) FROM ea_license_activations WHERE license_status='active') AS activations")).rows[0];
      const nodes = (await db.query("SELECT name,max_instances,status,(last_heartbeat_at>$1) AS online FROM sandbox_nodes ORDER BY id", [Date.now() - 90000])).rows;
      console.log(JSON.stringify({ counts, nodes })); return;
    }
    if (process.argv.includes('--verify')) {
      const user = (await db.query('SELECT u.id,COALESCE(v.version,0) AS auth_version FROM users u JOIN sandbox_instances i ON i.user_id=u.id LEFT JOIN user_auth_versions v ON v.user_id=u.id WHERE i.deleted_at IS NULL ORDER BY i.id LIMIT 1')).rows[0];
      assert.ok(user, 'Existing sandbox user required for read-only verification');
      const jwt = require(path.join(source, 'node_modules/jsonwebtoken'));
      const token = jwt.sign({ id: user.id, authVersion: user.auth_version || 0 }, env.JWT_SECRET, { expiresIn: '2m' });
      const response = await fetch('http://127.0.0.1:3000/api/sandbox/status', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200); const data = await response.json();
      assert.ok(Array.isArray(data.sandboxes)); assert.ok(Number.isInteger(data.capacity.maxSandboxes)); assert.ok(data.sandboxes.length > 0);
      for (const instance of data.sandboxes) {
        const selected = await fetch('http://127.0.0.1:3000/api/sandbox/status?instanceUid=' + instance.instanceUid, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
        assert.equal(selected.status, 200); assert.equal((await selected.json()).sandbox.instanceUid, instance.instanceUid);
      }
      assert.equal((await fetch('http://127.0.0.1:3000/api/sandbox/status')).status, 401);
      const html = await (await fetch('https://corngrid.com/dashboard.html', { signal: AbortSignal.timeout(20000) })).text();
      assert.ok(html.includes('sandbox-instance-select') && html.includes('20261112-multi-sandbox1'));
      const script = await (await fetch('https://corngrid.com/sandbox.js?v=20261112-multi-sandbox1', { signal: AbortSignal.timeout(20000) })).text();
      assert.ok(script.includes('selectedUid') && script.includes('instanceUid'));
      const readiness = await fetch('http://127.0.0.1:3000/api/health/ready'); assert.equal(readiness.status, 200);
      console.log(JSON.stringify({ deployedVerified: true, ownedSelectionVerified: true, unauthenticatedRejected: true, publicAssetsUpdated: true, readiness: readiness.status, capacity: data.capacity, existingStatuses: data.sandboxes.map(row => row.status) })); return;
    }
    for (const file of files) assert.ok(fs.existsSync(path.join(source, file)), 'Required source file missing');
    assert.ok(fs.existsSync(path.join(target, 'subscriptions/stripe-reconciliation.js')), 'Stripe recovery prerequisite missing');
    const backup = path.join(os.tmpdir(), 'CornGrid-multiple-sandboxes-' + new Date().toISOString().replace(/[:.]/g, '-')); fs.mkdirSync(backup, { recursive: true });
    for (const file of files) {
      const old = path.join(target, file); if (!fs.existsSync(old)) continue;
      const saved = path.join(backup, file); fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.copyFileSync(old, saved);
    }
    // Verify the index-only migration cannot alter existing terminals, credentials or licenses.
    const snapshot = async () => hash(JSON.stringify((await db.query(`SELECT 'instances' AS kind, row_to_json(i)::text AS value FROM sandbox_instances i
      UNION ALL SELECT 'credentials', row_to_json(c)::text FROM sandbox_credentials c
      UNION ALL SELECT 'licenses', row_to_json(a)::text FROM ea_license_activations a ORDER BY kind,value`)).rows));
    await db.query('BEGIN');
    try {
      await db.query('SET LOCAL lock_timeout = \'10s\'');
      await db.query('LOCK TABLE sandbox_instances, sandbox_credentials, ea_license_activations IN SHARE ROW EXCLUSIVE MODE');
      const before = await snapshot();
      await db.query(fs.readFileSync(path.join(source, 'migrations/postgres/0014_multiple_sandboxes.sql'), 'utf8'));
      assert.equal(await snapshot(), before);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    for (const file of files) {
      const from = path.join(source, file), to = path.join(target, file); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
      assert.equal(hash(fs.readFileSync(to)), hash(fs.readFileSync(from)));
    }
    const result = { backup, files: files.length, migration: '0014_multiple_sandboxes', existingDataPreserved: true, restartRequired: true, deployedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'multiple-sandbox-deployment-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await db.end(); }
}
main().catch(error => { console.error('Multiple sandbox deployment failed:', error.code === 'ERR_ASSERTION' ? error.message : error.code || error.name); process.exitCode = 1; });
