'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  try { require('dotenv').config({ path: envPath, quiet: true }); } catch { /* dotenv is optional at runtime */ }
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const schemaDir = path.join(__dirname, '..', 'migrations', 'postgres');

async function main() {
  const files = fs.readdirSync(schemaDir).filter(name => name.endsWith('.sql')).sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      console.log(`Applying ${file}...`);
      await client.query(fs.readFileSync(path.join(schemaDir, file), 'utf8'));
    }
    console.log('PostgreSQL schema migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('Migration failed:', error.message);
  process.exit(1);
});
