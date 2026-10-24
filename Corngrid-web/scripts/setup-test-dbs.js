'use strict';
// Creates the local test databases (corngrid_test, corngrid_loadtest) owned by
// the application user. Uses the local postgres superuser credentials from
// .pg-secrets.tmp (never printed). Safe to re-run.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const secrets = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.pg-secrets.tmp'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([a-z_]+)=(.+)$/i);
  if (match) secrets[match[1].trim().toLowerCase()] = match[2].trim();
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const appUrl = new URL(process.env.DATABASE_URL);
const appUser = decodeURIComponent(appUrl.username);

(async () => {
  const admin = new Client({
    host: 'localhost', port: 5432, user: 'postgres', password: secrets.postgres, database: 'postgres'
  });
  await admin.connect();
  for (const name of ['corngrid_test', 'corngrid_loadtest']) {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rows.length) {
      await admin.query(`ALTER DATABASE ${name} OWNER TO ${appUser}`);
      console.log(`${name}: already exists (ownership set to ${appUser})`);
    } else {
      await admin.query(`CREATE DATABASE ${name} OWNER ${appUser}`);
      console.log(`${name}: created (owner ${appUser})`);
    }
  }
  await admin.end();
})().catch(error => { console.error('setup failed:', error.message); process.exit(1); });
