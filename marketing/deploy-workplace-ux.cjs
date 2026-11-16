'use strict';
// Local operator deployment. Reports contain hashes/counts only; credentials
// stay in memory. No agent releases, payment actions or trading commands.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict'), cp = require('node:child_process');
const source = path.resolve(__dirname, '..'), target = 'C:\\Website\\Website', backend = path.join(target, 'Corngrid-web');
const modules = path.join(source, 'Corngrid-web/node_modules');
const env = require(path.join(modules, 'dotenv')).parse(fs.readFileSync(path.join(backend, '.env')));
const { Client } = require(path.join(modules, 'pg'));
const files = [
  "Corngrid-web/public/admin.html",
  "Corngrid-web/public/dashboard.html",
  "Corngrid-web/public/dashboard.js",
  "Corngrid-web/public/notifications.js",
  "Corngrid-web/public/notifications.css",
  "Corngrid-web/public/sandbox.js",
  "Corngrid-web/public/stripe-checkout.js",
  "Corngrid-web/public/interface.js",
  "Corngrid-web/public/interface.css",
  "Corngrid-web/public/experience-model.js",
  "Corngrid-web/public/workplace.js",
  "Corngrid-web/sandbox/sandbox-manager.js",
  "Corngrid-web/sandbox/sandbox-health.js",
  "Corngrid-web/subscriptions/subscription-api.js",
  "Corngrid-web/subscriptions/stripe-payments.js",
  "Corngrid-web/package.json",
  "Corngrid-web/docs/UI_UX_IMPROVEMENTS.md",
  "web.config",
  "web.config.xml",
  "sw.js"
];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function contained(root, relative) { const full = path.resolve(root, relative); assert(full.startsWith(root + path.sep), 'Unsafe deployment path'); return full; }
function backupRoot(value) {
  const resolved = path.resolve(value || '.');
  assert.equal(path.dirname(resolved), 'C:\\ProgramData\\CornGrid\\WebsiteBackups', 'Unexpected backup directory');
  assert(/^workplace-ux-\d{8}-\d{6}$/.test(path.basename(resolved)), 'Unexpected backup name');
  return resolved;
}
async function client() { const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 10000 }); await db.connect(); return db; }
async function inspect() {
  assert.equal(require('node:os').hostname().toUpperCase(), 'WINSLET', 'Wrong deployment host');
  assert(env.DATABASE_URL && env.JWT_SECRET, 'Production configuration unavailable');
  const runtime = files.map(name => {
    const from = contained(source, name), to = contained(target, name); assert(fs.existsSync(from), 'Missing source: ' + name);
    let baseline = null; try { baseline = cp.execFileSync('git', ['show', 'HEAD:' + name], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n'); } catch {}
    const exists = fs.existsSync(to);
    return { name, exists, sourceHash: hash(from), originalHash: exists ? hash(to) : null,
      changed: !exists || fs.readFileSync(from,'utf8').replace(/\r\n/g,'\n') !== fs.readFileSync(to,'utf8').replace(/\r\n/g,'\n'),
      productionDiverged: exists && (baseline === null || fs.readFileSync(to, 'utf8').replace(/\r\n/g, '\n') !== baseline) };
  });
  const db = await client(); let database;
  try {
    database = (await db.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users,
      (SELECT COUNT(*) FROM user_subscriptions)::int AS subscriptions,
      (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL)::int AS sandboxes,
      (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL AND status='running')::int AS running_sandboxes,
      (SELECT COUNT(*) FROM user_notifications)::int AS notification_history,
      to_regclass('public.notification_preferences') IS NOT NULL AS notification_schema`)).rows[0];
  } finally { await db.end(); }
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(source, 'Corngrid-web/package.json'))), installedPackage = JSON.parse(fs.readFileSync(path.join(backend, 'package.json')));
  assert.deepEqual(sourcePackage.dependencies, installedPackage.dependencies, 'Runtime dependency changes require separate review');
  assert.equal(hash(path.join(source, 'Corngrid-web/package-lock.json')), hash(path.join(backend, 'package-lock.json')), 'Dependency lockfile differs');
  return { phase: 'inspected', runtime, database, dependencyInstallRequired: false };
}
async function prepare(value) {
  const backup = backupRoot(value), state = await inspect(); assert(fs.existsSync(backup), 'Create private backup directory first');
  assert(!state.runtime.some(item => item.productionDiverged), 'Production differs from reviewed Git baseline');
  state.runtime = state.runtime.filter(item => item.changed);
  const plan = { ...state, backup, envHash: hash(path.join(backend, '.env')), appliedFiles: [], phase: 'prepared' };
  plan.backendRestartRequired = plan.runtime.some(item => /^Corngrid-web\/(?!public\/|docs\/|package\.json$)/.test(item.name));
  for (const item of plan.runtime) {
    const candidate = contained(path.join(backup, 'candidate'), item.name); fs.mkdirSync(path.dirname(candidate), { recursive: true }); fs.copyFileSync(contained(source, item.name), candidate);
    if (item.exists) { const saved = contained(path.join(backup, 'files'), item.name); fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.copyFileSync(contained(target, item.name), saved); }
  }
  if (plan.backendRestartRequired) {
  const url = new URL(env.DATABASE_URL), dump = path.join(backup, 'database-before.dump');
  const dumpEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '8' };
  if (url.searchParams.get('sslmode')) dumpEnv.PGSSLMODE = url.searchParams.get('sslmode');
  const operation = cp.spawnSync(env.PG_DUMP_BIN || 'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe', ['--format=custom', '--no-password', '--file', dump], { env: dumpEnv, windowsHide: true, timeout: 120000, encoding: 'utf8' });
  assert.equal(operation.status, 0, 'Private PostgreSQL snapshot failed'); assert(fs.statSync(dump).size > 0, 'Empty snapshot');
  }
  fs.writeFileSync(path.join(backup, 'plan.json'), JSON.stringify(plan, null, 2));
  return { phase: 'prepared', backup, files: plan.runtime.length, databaseSnapshot: plan.backendRestartRequired, backendRestartRequired: plan.backendRestartRequired, database: state.database };
}
function loadPlan(value) { const backup = backupRoot(value), plan = JSON.parse(fs.readFileSync(path.join(backup, 'plan.json'))); assert.equal(plan.backup, backup); assert(plan.runtime.every(item => files.includes(item.name)), 'Unreviewed manifest path'); return plan; }
async function apply(value) {
  const plan = loadPlan(value); assert.equal(hash(path.join(backend, '.env')), plan.envHash, 'Production configuration changed');
  for (const item of plan.runtime) {
    const to = contained(target, item.name); assert.equal(fs.existsSync(to) ? hash(to) : null, item.originalHash, 'Production changed after backup: ' + item.name);
    assert.equal(hash(contained(path.join(plan.backup, 'candidate'), item.name)), item.sourceHash, 'Candidate changed');
  }
  plan.phase = 'applying'; const save = () => fs.writeFileSync(path.join(plan.backup, 'plan.json'), JSON.stringify(plan, null, 2)); save();
  for (const item of plan.runtime) {
    plan.appliedFiles.push(item); save(); const to = contained(target, item.name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(contained(path.join(plan.backup, 'candidate'), item.name), to); assert.equal(hash(to), item.sourceHash);
  }
  assert.equal(hash(path.join(backend, '.env')), plan.envHash, 'Production secrets changed'); plan.phase = 'applied'; save();
  return { phase: 'applied', files: plan.appliedFiles.length, databaseModified: false, environmentPreserved: true, dependenciesChanged: false };
}
async function verify() {
  const db = await client(); let user, database;
  try {
    database = (await db.query(`SELECT (SELECT COUNT(*) FROM users)::int AS users,(SELECT COUNT(*) FROM user_subscriptions)::int AS subscriptions,
      (SELECT COUNT(*) FROM sandbox_instances WHERE deleted_at IS NULL AND status='running')::int AS running_sandboxes,
      (SELECT COUNT(*) FROM notification_alert_state)::int AS observed_states,(SELECT COUNT(*) FROM user_notifications)::int AS notifications,
      (SELECT COUNT(*) FROM user_notification_details)::int AS enriched_notifications`)).rows[0];
    user = (await db.query(`SELECT u.id,COALESCE(v.version,0) AS version,COALESCE(f.version,0) AS mfa_version FROM users u
      LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN auth_factors f ON f.subject='user:'||u.id::text
      LEFT JOIN account_archives a ON a.user_id=u.id WHERE u.email_verified::text IN ('1','true','t') AND a.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM user_account_access x WHERE x.user_id=u.id AND x.suspended_until>$1) ORDER BY u.id LIMIT 1`, [Date.now()])).rows[0];
  } finally { await db.end(); }
  assert(user, 'No existing eligible account for read-only smoke check');
  const token = require(path.join(modules, 'jsonwebtoken')).sign({ id: user.id, authVersion: Number(user.version), mfaVersion: Number(user.mfa_version) }, env.JWT_SECRET, { expiresIn: '2m' });
  const headers = { Authorization: 'Bearer ' + token }, base = 'http://127.0.0.1:3000', routes = [];
  for (const route of ['/api/health/ready', '/api/notifications/preferences', '/api/notifications?limit=1', '/api/notifications?limit=1&category=sandbox_offline', '/api/me', '/api/mt5/accounts', '/api/subscription/overview', '/api/sandbox/status', '/api/chat/unread-count']) {
    const response = await fetch(base + route, { headers, signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200, 'API smoke failed: ' + route);
    const data = await response.json();
    if (route.includes('/notifications')) assert.match(response.headers.get('cache-control') || '', /private.*no-store/);
    if (route.endsWith('/preferences')) { assert.equal(data.delivery, 'in_app'); for (const category of ['sandbox_offline', 'ea_disconnected', 'subscription_expiry', 'payment_status']) assert.equal(typeof data.preferences[category], 'boolean'); assert(data.preferences.expiry_days >= 1 && data.preferences.expiry_days <= 30); }
    if (route === '/api/sandbox/status') { assert(data.health && data.health.host && data.health.mt5 && data.health.ea, 'New Sandbox health signals missing'); assert.notEqual(data.mt5Connection, 'connected', 'Process status must not imply broker connectivity'); }
    if (route === '/api/subscription/overview') assert(Object.hasOwn(data, 'scheduledRenewal'), 'Subscription presentation field missing');
    if (route === '/api/notifications?limit=1') { assert(Array.isArray(data.notifications)); assert(Number.isInteger(data.unread)); }
    if (route === '/api/chat/unread-count') assert(Number.isSafeInteger(data.unreadCount) && data.unreadCount >= 0, 'Invalid unread count response');
    routes.push({ route, status: response.status });
  }
  for (const route of ['/api/notifications', '/api/notifications/preferences', '/api/chat/unread-count']) assert.equal((await fetch(base + route, { signal: AbortSignal.timeout(10000) })).status, 401);
  return { phase: 'verified', database, routes, unauthorizedRequestsRejected: true, productionTestAccountsCreated: 0, preferenceWritesPerformed: 0, productionPaymentsAttempted: 0 };
}
async function publicSmoke() {
  const checks = [];
  const assets = ['interface.js','interface.css','experience-model.js','workplace.js','notifications.js','notifications.css','dashboard.js','sandbox.js','stripe-checkout.js','dashboard.html','admin.html','sw.js'];
  for (const origin of ['http://127.0.0.1:8080','https://corngrid.com']) {
    for (const name of assets) {
      const markup = fs.readFileSync(path.join(source,'Corngrid-web/public/dashboard.html'),'utf8');
      const version = markup.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '\\?v=([^"\x27]+)'))?.[1] || hash(name === 'sw.js' ? path.join(source,name) : path.join(backend,'public',name)).slice(0,16);
      const response = await fetch(origin + '/' + name + '?v=' + encodeURIComponent(version), { headers: { 'Cache-Control':'no-cache' }, signal:AbortSignal.timeout(20000) });
      assert.equal(response.status,200,'Asset unavailable: '+name);
      const body = await response.text(), local = name === 'sw.js' ? path.join(source,name) : path.join(backend,'public',name);
      if (!name.endsWith('.html')) assert(!/text\/html/.test(response.headers.get('content-type') || ''),'Asset routed to HTML: '+name);
      if (name.endsWith('.html')) {
        const expected = fs.readFileSync(path.join(source,'Corngrid-web/public',name),'utf8').match(/(?:interface\.(?:css|js)|workplace\.js)\?v=[^"']+/g);
        assert(expected?.length && expected.every(reference => body.includes(reference)),'Stale interface markup: '+name);
        if (name === 'dashboard.html') assert(body.includes('id="checkout-progress"'),'Stale Workplace markup');
      } else assert.equal(crypto.createHash('sha256').update(body).digest('hex'),hash(local),'Stale public asset: '+name);
      checks.push({origin,name,status:response.status});
    }
  }
  return {phase:'public-smoke-passed',checks};
}
async function rollback(value) {
  const plan = loadPlan(value);
  for (const item of [...plan.appliedFiles].reverse()) { const to = contained(target, item.name); if (item.exists) fs.copyFileSync(contained(path.join(plan.backup, 'files'), item.name), to); else if (fs.existsSync(to)) fs.unlinkSync(to); }
  assert.equal(hash(path.join(backend, '.env')), plan.envHash, 'Production configuration changed');
  return { phase: 'rolled-back', databaseModified: false };
}
async function main() {
  const [mode = 'inspect', backup] = process.argv.slice(2); const operations = { inspect, prepare, apply, verify, public: publicSmoke, rollback }; assert(operations[mode], 'Unknown deployment operation');
  console.log(JSON.stringify(await operations[mode](backup)));
}
main().catch(error => { console.error(JSON.stringify({ phase: 'failed', type: error.code || error.name, reason: error instanceof assert.AssertionError ? error.message : 'Operator action failed; inspect the private deployment state.' })); process.exitCode = 1; });
