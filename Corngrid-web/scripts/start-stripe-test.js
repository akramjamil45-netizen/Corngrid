'use strict';
// Local test runner: never inherit the production database or a live Stripe key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');

const root = path.join(__dirname, '..');
const config = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
if (!/^(sk|rk)_test_/.test(config.STRIPE_SECRET_KEY || '')) {
  console.error('Stripe test startup refused: configure sk_test_ or rk_test_ in .env. Live keys are not allowed by this runner.');
  process.exit(1);
}
if (!/^whsec_/.test(config.STRIPE_WEBHOOK_SECRET || '')) {
  console.error('Stripe test startup refused: configure a Stripe test/CLI webhook signing secret.');
  process.exit(1);
}
const testDir = path.join(root, 'storage', 'stripe-test');
fs.mkdirSync(testDir, { recursive: true });
const cliSecretPath=path.join(testDir,'local-webhook-secret');
const webhookSecret=fs.existsSync(cliSecretPath)?fs.readFileSync(cliSecretPath,'utf8').trim():config.STRIPE_WEBHOOK_SECRET;
// Prevent server.js dotenv loading from restoring production settings.
for (const name of Object.keys(config)) process.env[name] = '';
Object.assign(process.env, {
  NODE_ENV: 'development', PORT: '3001', HOST: '127.0.0.1',
  DATABASE_URL: '', DATABASE_PATH: path.join(testDir, 'database.sqlite'),
  SQLITE_PATH: path.join(testDir, 'database.sqlite'), DB_READ_POOL_SIZE: '0',
  MT5_HEARTBEAT_TIMEOUT_SECONDS: '180', BACKUP_INTERVAL_HOURS: '0',
  JWT_SECRET: crypto.randomBytes(48).toString('hex'),
  APP_BASE_URL: 'http://localhost:3001', TRUST_PROXY: 'false',
  STRIPE_SECRET_KEY: config.STRIPE_SECRET_KEY,
  STRIPE_PAYMENT_METHOD_CONFIGURATION: config.STRIPE_PAYMENT_METHOD_CONFIGURATION || '',
  STRIPE_WEBHOOK_SECRET: webhookSecret
});
process.chdir(root);
console.log('Starting CornGrid Stripe TEST on http://localhost:3001 with an isolated SQLite database.');
require('../server');
