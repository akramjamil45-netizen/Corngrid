'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'Corngrid-web');
const target = 'C:/Website/Website/Corngrid-web';
const files = [
  'partner/partner-payouts.js', 'partner/commission-service.js', 'partner/partner-api.js', 'partner/partner-admin-api.js', 'partner/index.js',
  'public/partner-payouts.css', 'public/partner.js', 'public/admin-sandbox.js',
  'migrations/postgres/0011_partner_payout_requests.sql', 'migrations/sqlite/0011_partner_payout_requests.sql',
  'docs/PARTNER_PAYOUTS.md', 'docs/PARTNER_PROGRAM_DOCUMENTATION.md', 'public/dashboard.html', 'public/admin.html'
];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main() {
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) throw new Error('Source and runtime must differ.');
  for (const file of [...files, 'db-async.js', 'sandbox/sandbox-crypto.js']) if (!fs.existsSync(path.join(source, file))) throw new Error('A required source file is missing.');
  for (const file of ['db-async.js', 'partner/partner-agreements.js']) if (!fs.existsSync(path.join(target, file))) throw new Error('Runtime prerequisites are missing.');
  const backup = path.join(os.tmpdir(), 'CornGrid-partner-payouts-' + new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true });
  const originalFiles = [];
  for (const file of files) {
    const old = path.join(target, file);
    if (fs.existsSync(old)) {
      const saved = path.join(backup, file);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.copyFileSync(old, saved);
      originalFiles.push(file);
    }
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ target, files, originalFiles }, null, 2));
  // Patch the existing hosting allowlist without replacing other production rules.
  for (const config of ['web.config', 'web.config.xml']) {
    const configPath = path.join(path.dirname(target), config);
    if (!fs.existsSync(configPath)) continue;
    const original = fs.readFileSync(configPath, 'utf8');
    fs.copyFileSync(configPath, path.join(backup, config));
    if (!original.includes('partner-payouts\\.css')) {
      const updated = original.replace('partner\\.js|', 'partner\\.js|partner-payouts\\.css|');
      if (!updated.includes('partner-payouts\\.css')) throw new Error('Partner routing marker missing.');
      fs.writeFileSync(configPath, updated);
    }
  }
  if (process.argv.includes('--routing-only')) {
    const resultPath = path.join(__dirname, 'partner-payouts-deployment-result.json');
    const previous = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    Object.assign(previous, { routingBackup: backup, routingUpdatedAt: new Date().toISOString() });
    fs.writeFileSync(resultPath, JSON.stringify(previous, null, 2));
    console.log(JSON.stringify({ routingUpdated: true, backup }));
    return;
  }
  if (process.argv.includes('--frontend-only')) {
    for (const file of files.filter(file => file.startsWith('public/'))) {
      const from = path.join(source, file), to = path.join(target, file);
      fs.copyFileSync(from, to);
      if (hash(from) !== hash(to)) throw new Error('Frontend verification failed.');
    }
    const resultPath = path.join(__dirname, 'partner-payouts-deployment-result.json');
    const previous = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    Object.assign(previous, { frontendBackup: backup, frontendUpdatedAt: new Date().toISOString() });
    fs.writeFileSync(resultPath, JSON.stringify(previous, null, 2));
    console.log(JSON.stringify({ frontendUpdated: true, backup }));
    return;
  }
  const env = require(path.join(source, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(target, '.env')));
  const { Client } = require(path.join(source, 'node_modules/pg'));
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const duplicates = await client.query("SELECT partner_id FROM partner_payouts WHERE status IN ('pending','approved') GROUP BY partner_id HAVING COUNT(*) > 1");
    if (duplicates.rowCount) throw new Error('Existing partners have multiple open payouts; review them before deploying.');
    await client.query('BEGIN');
    await client.query(fs.readFileSync(path.join(source, 'migrations/postgres/0011_partner_payout_requests.sql'), 'utf8'));
    await client.query('SELECT payout_id, bank_snapshot_cipher FROM partner_payout_details LIMIT 0');
    await client.query('SELECT payout_id, transaction_id, amount_cents FROM partner_payout_allocations LIMIT 0');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await client.end(); }
  for (const file of files) {
    const from = path.join(source, file), to = path.join(target, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    if (hash(from) !== hash(to)) throw new Error('Runtime file verification failed.');
  }
  const result = { backup, files: files.length, migration: '0011_partner_payout_requests', deployedAt: new Date().toISOString(), restartRequired: true };
  fs.writeFileSync(path.join(__dirname, 'partner-payouts-deployment-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
main().catch(error => { console.error('Payout deployment failed:', error.code || error.message); process.exitCode = 1; });
