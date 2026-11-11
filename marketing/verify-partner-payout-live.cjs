'use strict';
// Read-only verification. Tokens remain in memory and are sent only to localhost.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), source = path.join(root, 'Corngrid-web');
const runtime = 'C:/Website/Website/Corngrid-web';
async function main() {
  const env = require(path.join(source, 'node_modules/dotenv')).parse(fs.readFileSync(path.join(runtime, '.env')));
  const jwt = require(path.join(source, 'node_modules/jsonwebtoken'));
  const adminVersion = crypto.createHash('sha256').update(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`).digest('hex');
  const token = jwt.sign({ sub: 'admin', role: 'admin', adminVersion }, env.JWT_SECRET, { expiresIn: '2m' });
  async function json(route, authorized = true) {
    const response = await fetch('http://127.0.0.1:3000' + route, { headers: authorized ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, route + ' failed');
    return response.json();
  }
  assert.equal((await json('/api/health', false)).status, 'ok');
  assert.ok(Array.isArray((await json('/api/admin/payouts')).payouts));
  const partners = await json('/api/admin/partners');
  const active = partners.partners.find(row => row.status === 'active');
  if (active) {
    const summary = await json(`/api/admin/partners/${active.userId}/payout-summary`);
    assert.equal(summary.currency, 'MYR');
    assert.equal(typeof summary.availableBalance, 'number');
  }
  const checks = [];
  for (const base of ['http://127.0.0.1:3000', 'https://corngrid.com']) {
    for (const [route, marker] of [['/dashboard.html', 'id="partner-bank-form"'], ['/admin.html', 'id="cm-payout-review-form"'], ['/partner-payouts.css?v=20261111-payout2', '.partner-payout-balances'], ['/partner.js?v=20261111-payout1', '/partner/bank-details'], ['/admin-sandbox.js?v=20261111-payout1', 'confirmTransferred']]) {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(20000) });
      assert.equal(response.status, 200, base + route + ' failed');
      assert.ok((await response.text()).includes(marker), route + ' is stale');
    }
    checks.push({ base, assetsVerified: true });
  }
  const resultFile = path.join(__dirname, 'partner-payouts-deployment-result.json');
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  Object.assign(result, { restartRequired: false, verifiedAt: new Date().toISOString(), liveApiVerified: true, publicAssetsVerified: true });
  fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ health: 'ok', liveApiVerified: true, partnerSummaryVerified: Boolean(active), checks }));
}
main().catch(error => { console.error('Live payout verification failed:', error.code === 'ERR_ASSERTION' ? error.message : error.code || error.message); process.exitCode = 1; });
