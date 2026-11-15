'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),bcrypt=require('bcryptjs'),fs=require('node:fs'),path=require('node:path');
const {validateConfig}=require('../scripts/start-staging');
const config={JWT_SECRET:'fixture-staging-jwt-secret-at-least-32-characters',SANDBOX_ENCRYPTION_KEY:'e'.repeat(64),ADMIN_EMAIL:'admin@example.test',ADMIN_PASSWORD_HASH:bcrypt.hashSync('fixture-password',4),DATABASE_PATH:'platform.staging.sqlite'};
test('staging is loopback-only and clears live payment, email and update settings',()=>{
 const values=validateConfig(config);assert.equal(values.HOST,'127.0.0.1');assert.equal(values.PORT,'3100');assert.equal(values.APP_BASE_URL,'http://127.0.0.1:3100');for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SMTP_HOST','SMTP_PASS','SANDBOX_NODE_UPDATE_DIR','STAGING_DEMO_NODE_UID'])assert.equal(values[key],'');assert.equal(values.SANDBOX_NODE_AUTO_UPDATE,'false');assert.equal(values.DATABASE_URL,'');assert.equal(values.CORNGRID_STAGING,'true');
});
test('staging rejects live keys, shared database/credentials, SMTP and ambiguous database names',()=>{
 for(const change of [{STRIPE_SECRET_KEY:'sk_live_not-a-real-fixture'},{DATABASE_PATH:'database.sqlite'},{DATABASE_URL:'postgresql://localhost/production'},{SMTP_HOST:'smtp.example.test'},{PORT:'3000'},{STAGING_DEMO_NODE_UID:'production-node'}])assert.throws(()=>validateConfig({...config,...change}));
 assert.throws(()=>validateConfig(config,{live:{JWT_SECRET:config.JWT_SECRET}}));assert.throws(()=>validateConfig(config,{live:{SANDBOX_ENCRYPTION_KEY:config.SANDBOX_ENCRYPTION_KEY}}));assert.throws(()=>validateConfig({...config,DATABASE_URL:'postgresql://fixture@localhost/corngrid_test'},{live:{DATABASE_URL:'postgresql://other@localhost/corngrid_test'}}));
 assert.equal(validateConfig({...config,DATABASE_URL:'postgresql://fixture@localhost/corngrid_staging'}).DATABASE_URL,'postgresql://fixture@localhost/corngrid_staging');
});
test('CI has separate Windows and PostgreSQL/Linux jobs and never runs production deployment commands',()=>{
 const workflow=fs.readFileSync(path.join(__dirname,'../../.github/workflows/platform-checks.yml'),'utf8');assert.match(workflow,/windows-latest/);assert.match(workflow,/postgres:16/);assert.match(workflow,/test\/platform-postgres.test.js/);assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/publish-node-update|stripe-live|deploy-.*\.ps1|secrets\./);assert.match(workflow,/node-candidates-/);
});
