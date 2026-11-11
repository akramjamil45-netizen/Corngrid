'use strict';
// Isolated browser QA: in-memory database, fake earnings, no production credentials.
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), crypto = require('node:crypto');
const source = path.resolve(__dirname, '../Corngrid-web');
const express = require(path.join(source, 'node_modules/express'));
const sqlite3 = require(path.join(source, 'node_modules/sqlite3'));
const { dbRun, dbAll } = require(path.join(source, 'db-async'));
const { ensureSchema } = require(path.join(source, 'sandbox/sandbox-schema'));
const { createSandboxCrypto } = require(path.join(source, 'sandbox/sandbox-crypto'));
const { createSandboxEvents } = require(path.join(source, 'sandbox/sandbox-events'));
const { createPartnerPayouts } = require(path.join(source, 'partner/partner-payouts'));
const { createPartnerApi } = require(path.join(source, 'partner/partner-api'));

async function main() {
  const db = new sqlite3.Database(':memory:');
  await dbRun(db, 'CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, email TEXT)');
  await dbRun(db, "INSERT INTO users VALUES(1,'Preview Partner','preview@example.test')");
  await dbRun(db, `CREATE TABLE subscription_audit_logs(id INTEGER PRIMARY KEY,actor_id INTEGER,actor_role TEXT,action TEXT,affected_type TEXT,affected_id INTEGER,metadata TEXT,reason TEXT,ip_address TEXT,created_at BIGINT)`);
  await ensureSchema(db);
  const stamp = Date.now();
  await dbRun(db, "INSERT INTO partner_profiles(user_id,display_name,status,created_at,updated_at) VALUES(1,'Preview Partner','active',?,?)", [stamp, stamp]);
  await dbRun(db, `INSERT INTO partner_transactions(reference,idempotency_key,partner_id,gross_amount,commission_amount,currency,status,created_at,status_updated_at)
    VALUES('COM-PREVIEW','preview:1',1,250,100,'MYR','approved',?,?)`, [stamp, stamp]);
  await dbRun(db, `INSERT INTO partner_commissions(partner_id,model,percent,currency,applies_to,min_payout_threshold,effective_from,created_at,updated_at)
    VALUES(1,'percent',40,'MYR','both',20,?,?,?)`, [stamp, stamp, stamp]);
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-payout-preview-'));
  const app = express();
  app.use(express.json());
  const verifyPartner = (req, _res, next) => { req.user = { id: 1 }; next(); };
  const verifyAdmin = (req, _res, next) => { req.admin = { id: 99 }; next(); };
  const rateLimit = () => (_req, _res, next) => next();
  const events = createSandboxEvents({ db });
  const bankCrypto = createSandboxCrypto({ encryptionKey: crypto.randomBytes(32).toString('hex') });
  const payouts = createPartnerPayouts({ db, crypto: bankCrypto, events });
  payouts.registerRoutes(app, verifyPartner, verifyAdmin, rateLimit);
  createPartnerApi({ db, events, crypto: bankCrypto, rateLimit, storageDir }).registerRoutes(app, verifyPartner);
  app.get('/api/partner/application', (_req, res) => res.json({ application: null }));
  app.get('/api/partner/agreements', (_req, res) => res.json({ agreements: [] }));
  app.get('/api/admin/commissions', (_req, res) => res.json({ commissions: [] }));
  app.get('/api/admin/ea-submissions', (_req, res) => res.json({ submissions: [] }));
  app.get('/api/admin/partners', (_req, res) => res.json({ partners: [{ userId: 1, displayName: 'Preview Partner', email: 'preview@example.test' }] }));
  app.get('/api/admin/commissions/transactions', async (_req, res) => res.json({ transactions: (await dbAll(db, 'SELECT * FROM partner_transactions')).map(row => ({ id: row.id, reference: row.reference, partnerId: row.partner_id, partnerName: 'Preview Partner', commissionAmount: row.commission_amount, grossAmount: row.gross_amount, currency: row.currency, status: row.status, createdAt: row.created_at })) }));
  function previewHtml(admin) {
    let html = fs.readFileSync(path.join(source, 'public', admin ? 'admin.html' : 'dashboard.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const boot = admin ? `document.querySelectorAll('.page').forEach(el=>{el.hidden=el.id!=='commissions';el.classList.toggle('is-visible',!el.hidden)}); window.CornGridAdminSandbox.loadCommissions(); document.querySelector('[data-commission-tab="payouts"]').click();`
      : `document.querySelectorAll('.page').forEach(el=>{el.hidden=el.id!=='page-partner';el.classList.toggle('is-visible',!el.hidden)}); document.getElementById('page-title').textContent='Partner Program'; window.CornGridPartner.onOpen();`;
    return html.replace('</body>', `<script src="${admin ? 'admin-sandbox.js' : 'partner.js'}"></script><script>${boot}</script></body>`);
  }
  app.get('/preview-partner', (_req, res) => res.type('html').send(previewHtml(false)));
  app.get('/preview-admin', (_req, res) => res.type('html').send(previewHtml(true)));
  app.use(express.static(path.join(source, 'public')));
  const server = app.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ partnerUrl: `http://127.0.0.1:${server.address().port}/preview-partner`, adminUrl: `http://127.0.0.1:${server.address().port}/preview-admin` })));
  process.on('SIGINT', () => server.close(() => {
    db.close();
    if (!path.resolve(storageDir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected preview storage path');
    fs.rmSync(storageDir, { recursive: true, force: true });
    process.exit(0);
  }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
