'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cwd = path.resolve(__dirname, '../Corngrid-web');
const env = require(path.join(cwd, 'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
const result = spawnSync(process.execPath, ['--test', 'test/postgres-availability.test.js'], {
  cwd, stdio: 'inherit', env: { ...process.env, TEST_POSTGRES_URL: env.DATABASE_URL }, timeout: 25000
});
process.exitCode = result.status === 0 ? 0 : 1;
