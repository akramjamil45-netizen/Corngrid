'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { dbRun, dbGet } = require('../db-async');
const { createReportService, reportWindow } = require('../reports/report-service');
const registerReportApi = require('../reports/report-api');
const createUserAuth = require('../user-auth');
const createAdminAuth = require('../admin-auth');
const STAMP = Date.parse('2026-11-14T04:00:00Z');
test('report assets: IIS routes each new asset and the official logo is unchanged', () => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const config = fs.readFileSync(path.join(__dirname, '../../web.config'), 'utf8');
  const rule = config.slice(config.indexOf('<rule name="CornGrid Node backend"'));
  const pattern = new RegExp(rule.match(/<match url="([^"]+)"/)[1]);
  for (const asset of ['report-studio.js','report-renderer.js','report-studio.css','images/corngrid-report-logo.png']) assert.ok(pattern.test(asset), asset);
  assert.equal(pattern.test('report-random.js'), false);
  const logo = fs.readFileSync(path.join(__dirname, '../public/images/corngrid-report-logo.png'));
  assert.equal(crypto.createHash('sha256').update(logo).digest('hex'), '7506b1ae01aff0a3c7e25cfc2c9b06a08cb4d645e224217e32fa3e22c0dd93a0');
});
async function fixture(t) {
  const db = new sqlite3.Database(':memory:');
  t.after(() => new Promise(resolve => db.close(resolve)));
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email_verified INTEGER,created_at TEXT);
    CREATE TABLE user_auth_versions(user_id INTEGER PRIMARY KEY,version INTEGER);
    CREATE TABLE account_archives(user_id INTEGER PRIMARY KEY,archived_at INTEGER,reason TEXT,archived_by TEXT);
    CREATE TABLE mt5_accounts(id INTEGER PRIMARY KEY,user_id INTEGER,account_name TEXT,account_number TEXT,currency TEXT,balance REAL,equity REAL,floating_profit REAL,last_heartbeat INTEGER,last_sync INTEGER);
    CREATE TABLE mt5_snapshots(id INTEGER PRIMARY KEY,account_id INTEGER,captured_at INTEGER,balance REAL,equity REAL,floating_profit REAL);
    CREATE TABLE mt5_deals(id INTEGER PRIMARY KEY,account_id INTEGER,closed_at INTEGER,profit REAL,commission REAL,swap REAL);
    CREATE TABLE sandbox_instances(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,last_heartbeat_at INTEGER,cpu_percent REAL,memory_mb REAL,created_at INTEGER,deleted_at INTEGER);
    CREATE TABLE user_subscriptions(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,deleted_at INTEGER,starts_at INTEGER,expires_at INTEGER);
    CREATE TABLE partner_profiles(user_id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE partner_transactions(id INTEGER PRIMARY KEY,partner_id INTEGER,currency TEXT NOT NULL,commission_amount REAL NOT NULL,status TEXT,created_at INTEGER);
    CREATE TABLE partner_payouts(id INTEGER PRIMARY KEY,partner_id INTEGER,currency TEXT NOT NULL,amount REAL NOT NULL,status TEXT,paid_at INTEGER);
    CREATE TABLE ea_submissions(id INTEGER PRIMARY KEY,partner_id INTEGER,status TEXT,deleted_at INTEGER);
    INSERT INTO users VALUES(1,'Alice',1,'2026-11-08 20:00:00'),(2,'Bob',1,'2026-01-01 00:00:00'),(3,'Archived',1,'2026-11-12 00:00:00');
    INSERT INTO account_archives VALUES(3,1,'test','test');
  `, e => e ? reject(e) : resolve()));
  for (const [id, user, currency, balance] of [[1, 1, 'USD', 1000], [2, 2, 'USD', 9000], [3, 1, 'EUR', 500], [4, 3, 'USD', 100000]]) {
    await dbRun(db, 'INSERT INTO mt5_accounts VALUES(?,?,?,?,?,?,?,?,?,?)', [id,user,'EA','12345678' + id,currency,balance,balance + 10,10,STAMP - 1000,STAMP - 1000]);
    await dbRun(db, 'INSERT INTO mt5_snapshots VALUES(?,?,?,?,?,?)', [id,id,STAMP - 2000,balance,balance + 10,10]);
    await dbRun(db, 'INSERT INTO mt5_deals VALUES(?,?,?,?,?,?)', [id,id,STAMP - 1000,100,-4,-1]);
  }
  await dbRun(db, 'INSERT INTO sandbox_instances VALUES(1,1,?,?,?,?,?,NULL)', ['running',STAMP - 1000,12,512,STAMP - 2000]);
  await dbRun(db, 'INSERT INTO sandbox_instances VALUES(2,2,?,?,?,?,?,NULL)', ['running',STAMP - 900000,15,512,STAMP - 2000]);
  await dbRun(db, "INSERT INTO user_subscriptions VALUES(1,1,'active',NULL,?,?)", [STAMP - 1000,STAMP + 100000]);
  return { db, service: createReportService(db, { now: () => STAMP }), query: { period: 'weekly', date: '2026-11-14', timezone: 'Asia/Kuala_Lumpur' } };
}
test('reports: owner scope, masked options and privileged reports', async t => {
  const {service, query} = await fixture(t);
  const opts = await service.options('user', 1);
  assert.deepEqual(opts.accounts.map(a => a.id), [3,1]);
  assert.equal(JSON.stringify(opts).includes('123456781'), false);
  await assert.rejects(service.generate('user', 1, {...query, accountId:'2'}), {status:404});
  await assert.rejects(service.generate('user', 1, {...query, type:'growth'}), {status:403});
  await assert.rejects(service.generate('user', 1, {...query, userId:'2'}), {status:400});
  const report = await service.generate('user',1,{...query,accountId:'1'});
  assert.equal(report.metrics[0].value,95);
  assert.equal(report.metrics[3].value,1000);
  assert.equal(report.metrics[5].value,1);
  assert.equal(JSON.stringify(report).includes('Alice'),false);
  assert.equal(JSON.stringify(report).includes('12345678'),false);
});
test('partner reports: active eligibility, suspended/archived protection and session ownership', async t => {
  const {db,service,query} = await fixture(t);
  assert.deepEqual((await service.options('user',1)).types.map(t=>t.value),['account','sandbox']);
  await assert.rejects(service.generate('user',1,{...query,type:'partner'}),{status:403});
  await dbRun(db,"INSERT INTO partner_profiles VALUES(1,'active'),(2,'suspended'),(3,'active')");
  assert.deepEqual((await service.options('user',1)).types.map(t=>t.value),['account','sandbox','partner']);
  assert.deepEqual((await service.options('user',1)).partnerCurrencies,['MYR']);
  for(const userId of [2,3]) {
    assert.equal((await service.options('user',userId)).types.some(t=>t.value==='partner'),false);
    await assert.rejects(service.generate('user',userId,{...query,type:'partner'}),{status:403});
  }
  await assert.rejects(service.generate('admin',undefined,{...query,type:'partner'}),{status:403});
  await assert.rejects(service.generate('user',1,{...query,type:'partner',partnerId:'2'}),{status:400});
  await assert.rejects(service.generate('user',1,{...query,type:'partner',accountId:'1'}),{status:400});
  await dbRun(db,"UPDATE partner_profiles SET status='suspended' WHERE user_id=1");
  await assert.rejects(service.generate('user',1,{...query,type:'partner'}),{status:403});
});

test('partner reports: own ledger, creation and paid dates, currency isolation and read-only totals', async t => {
  const {db,service,query} = await fixture(t);
  await dbRun(db,"INSERT INTO partner_profiles VALUES(1,'active'),(2,'active')");
  const at=STAMP-1000, old=STAMP-40*86400000;
  for(const [id,owner,currency,amount,status,created] of [[1,1,'MYR',80.1,'approved',at],[2,1,'MYR',20.2,'paid',at],[3,1,'MYR',30,'pending',at],[4,1,'MYR',999,'rejected',at],[5,1,'MYR',888,'cancelled',at],[6,2,'MYR',9000,'approved',at],[7,1,'USD',40,'approved',at],[8,1,'MYR',100,'paid',old]]) await dbRun(db,'INSERT INTO partner_transactions VALUES(?,?,?,?,?,?)',[id,owner,currency,amount,status,created]);
  await dbRun(db,"INSERT INTO partner_payouts VALUES(1,1,'MYR',65,'paid',?),(2,2,'MYR',9999,'paid',?),(3,1,'MYR',500,'pending',NULL),(4,1,'MYR',75,'paid',?),(5,1,'USD',5,'paid',?)",[at,at,old,at]);
  await dbRun(db,"INSERT INTO ea_submissions VALUES(1,1,'published',NULL),(2,1,'pending_review',NULL),(3,2,'published',NULL),(4,1,'published',1)");
  const before=await dbGet(db,'SELECT total_changes() AS count');
  const mixed=await service.generate('user',1,{...query,type:'partner'});
  assert.equal(mixed.currency,null); assert.deepEqual(mixed.metrics.slice(0,3).map(m=>m.value),[null,null,null]);
  assert.ok(mixed.chart.points.every(p=>p.value===null));
  assert.deepEqual((await service.options('user',1)).partnerCurrencies,['MYR','USD']);
  const report=await service.generate('user',1,{...query,type:'partner',currency:'MYR'});
  assert.deepEqual(report.metrics.map(m=>m.value),[100.3,30,65,3,1,2]);
  assert.equal(report.chart.points.reduce((sum,p)=>sum+p.value,0),100.3);
  assert.equal(report.chart.points[0].value,0);
  assert.equal(report.selectedAccountId,null);
  assert.equal(JSON.stringify(report).includes('Alice'),false);
  const usd=await service.generate('user',1,{...query,type:'partner',currency:'USD'});
  assert.deepEqual(usd.metrics.slice(0,4).map(m=>m.value),[40,0,5,1]);
  const past=await service.generate('user',1,{...query,type:'partner',currency:'MYR',date:'2026-01-01'});
  assert.deepEqual(past.metrics.slice(0,4).map(m=>m.value),[0,0,0,0]);
  assert.equal(past.metrics[4].value,1); // Explicitly a current strategy snapshot.
  await assert.rejects(service.generate('user',1,{...query,type:'partner',currency:'EUR'}),{status:400});
  const after=await dbGet(db,'SELECT total_changes() AS count'); assert.equal(before.count,after.count);
});

test('reports: no mixed currency sums and no archived account inclusion', async t => {
  const {service,query} = await fixture(t);
  const mixed = await service.generate('user',1,query);
  assert.equal(mixed.currency,null); assert.equal(mixed.metrics[0].value,null); assert.equal(mixed.metrics[3].value,null);
  const funds = await service.generate('admin',undefined,{...query,type:'funds',currency:'USD'});
  assert.equal(funds.metrics[0].value,10000); assert.equal(funds.metrics[3].value,2);
  await assert.rejects(service.generate('user',1,{...query,accountId:'1',currency:'EUR'}), {status:400});
});
test('reports: missing costs and absent observations remain N/A', async t => {
  const {db,service,query} = await fixture(t);
  await dbRun(db,'UPDATE mt5_deals SET commission=NULL WHERE account_id=1');
  const report = await service.generate('user',1,{...query,accountId:'1'});
  assert.equal(report.metrics[0].value,null); assert.equal(report.metrics[2].value,null);
  assert.equal(report.chart.points.at(-1).value,null);
  const historical = await service.generate('user',1,{...query,date:'2026-10-05',accountId:'1'});
  assert.equal(historical.metrics[3].value,null); assert.equal(historical.metrics[0].value,null);
  assert.ok(historical.notes.some(n=>n.includes('snapshot')));
});
test('reports: sandbox state requires a fresh heartbeat and user ownership', async t => {
  const {service,query} = await fixture(t);
  const own = await service.generate('user',1,{...query,type:'sandbox'});
  assert.deepEqual(own.metrics.map(m=>m.value),[1,1,0,0,0,0]);
  const admin = await service.generate('admin',undefined,{...query,type:'sandbox'});
  assert.deepEqual(admin.metrics.map(m=>m.value),[2,1,0,0,0,1]);
});
test('reports: registration timezone boundaries, current counts and read-only generation', async t => {
  const {db,service,query} = await fixture(t);
  const before = await dbGet(db,'SELECT total_changes() AS count');
  const report = await service.generate('admin',undefined,{...query,type:'growth'});
  const after = await dbGet(db,'SELECT total_changes() AS count');
  assert.equal(before.count,after.count);
  assert.equal(report.metrics[0].value,2); assert.equal(report.metrics[1].value,1);
  assert.equal(report.chart.points[0].value,1); // 8 Nov UTC becomes Monday 9 Nov in MYT.
  assert.equal(report.metrics[4].value,1);
  assert.equal(report.period.partial,true);
});
test('reports: calendar periods, DST and invalid query boundaries', () => {
  const march = reportWindow({period:'daily',date:'2026-03-08',timezone:'America/New_York'},STAMP);
  assert.equal(march.until-march.startMs,23*3600000); assert.equal(march.buckets.length,23);
  const november = reportWindow({period:'daily',date:'2026-11-01',timezone:'America/New_York'},STAMP);
  assert.equal(november.buckets.length,25);
  const weekly = reportWindow({period:'weekly',date:'2026-11-08',timezone:'UTC'},STAMP);
  assert.equal(weekly.start,'2026-11-02'); assert.equal(weekly.end,'2026-11-08');
  const yearly = reportWindow({period:'yearly',date:'2025-06-02',timezone:'UTC'},STAMP);
  assert.equal(yearly.buckets.length,12); assert.equal(yearly.start,'2025-01-01'); assert.equal(yearly.end,'2025-12-31');
  for(const query of [{date:'2026-02-31'},{date:'2027-01-01'},{timezone:'Invalid/Nowhere'},{period:'decade'},{date:['2026-11-14']}]) assert.throws(()=>reportWindow(query,STAMP));
});
test('admin templates: seven choices are admin-only and existing user reports remain available', async t => {
  const {service,query}=await fixture(t);
  const admin=await service.options('admin'),user=await service.options('user',1);
  assert.deepEqual(admin.types.map(t=>t.value),['growth','sandbox','funds','performance','subscription','milestone','blank']);
  assert.ok(admin.types.every(t=>t.description));
  assert.deepEqual(user.types.map(t=>t.value),['account','sandbox']);
  for(const type of ['subscription','milestone','blank']) await assert.rejects(service.generate('user',1,{...query,type}),{status:403});
});
test('subscription template: status and period counts exclude archived/deleted records and do not invent revenue', async t => {
  const {db,service,query}=await fixture(t);
  for(const [id,user,status,deleted,start,expiry] of [
    [2,1,'active',null,STAMP-1000,STAMP+10*86400000],
    [3,2,'active',null,STAMP-86400000,STAMP-1000],
    [4,2,'suspended',null,STAMP-10000,STAMP+86400000],
    [5,3,'active',null,STAMP-1000,STAMP+86400000],
    [6,1,'active',STAMP,STAMP-1000,STAMP+86400000],
    [7,2,'active',null,STAMP+1000,STAMP+86400000]
  ]) await dbRun(db,'INSERT INTO user_subscriptions VALUES(?,?,?,?,?,?)',[id,user,status,deleted,start,expiry]);
  const before=await dbGet(db,'SELECT total_changes() AS changes');
  const report=await service.generate('admin',undefined,{...query,type:'subscription'});
  assert.deepEqual(report.metrics.map(m=>m.value),[1,2,1,1,4,1]);
  assert.equal(report.chart.points.reduce((sum,p)=>sum+p.value,0),4);
  assert.ok(report.metrics.every(m=>m.unit==='count'));
  assert.ok(report.notes.some(n=>n.includes('not proof of payment')));
  assert.equal((await dbGet(db,'SELECT total_changes() AS changes')).changes,before.changes);
});
test('milestone template: highlight uses the selected source metric without asserted achievements', async t => {
  const {service,query}=await fixture(t);
  const report=await service.generate('admin',undefined,{...query,type:'milestone',milestoneMetric:'sandboxes'});
  assert.equal(report.milestone.metricIndex,5);assert.equal(report.metrics[5].value,2);
  await assert.rejects(service.generate('admin',undefined,{...query,type:'milestone',milestoneMetric:'revenue'}),{status:400});
  await assert.rejects(service.generate('admin',undefined,{...query,type:'milestone',milestoneMetric:'__proto__'}),{status:400});
});
test('blank template: no inserted statistics, content or database access; administrator authentication still applies', async () => {
  const db={all(){throw Error('Unexpected read');},get(){throw Error('Unexpected read');},run(){throw Error('Unexpected write');}};
  const service=createReportService(db,{now:()=>STAMP});
  const blank=await service.generate('admin',undefined,{type:'blank',period:'daily',timezone:'UTC'});
  assert.equal(blank.mode,'manual');assert.equal(blank.scope,'admin');assert.equal(blank.chart,null);
  assert.deepEqual(blank.metrics,[]);assert.ok(Object.values(blank.content).every(v=>v===''));
  await assert.rejects(service.generate('user',1,{type:'blank'}),{status:403});
});
test('report API: real session middleware rejects anonymous and cross-role requests', async t => {
  const {db} = await fixture(t), secret='report-test-secret', app=express();
  const userAuth=createUserAuth({db,jwtSecret:secret});
  const adminAuth=createAdminAuth({email:'admin@example.test',passwordHash:await bcrypt.hash('test-report-password',4),jwtSecret:secret});
  registerReportApi(app,db,{verifyToken:userAuth,verifyAdminToken:adminAuth.verifyToken,rateLimit:()=> (_req,_res,next)=>next()});
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.on('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const user=jwt.sign({id:1,authVersion:0},secret), admin=await adminAuth.authenticate('admin@example.test','test-report-password');
  const get=(path,token)=>fetch(base+path,{headers:token?{Authorization:'Bearer '+token}:{}});
  assert.equal((await get('/api/reports')).status,401);
  assert.equal((await get('/api/admin/reports',user)).status,403);
  assert.equal((await get('/api/reports',admin)).status,403);
  const options=await get('/api/reports/options',user); assert.equal(options.status,200); assert.equal(options.headers.get('cache-control'),'no-store');
  assert.equal((await get('/api/reports?accountId=2',user)).status,404);
  assert.equal((await get('/api/reports?type=growth',user)).status,403);
  assert.equal((await get('/api/reports?type=partner',user)).status,403);
  await dbRun(db,"INSERT INTO partner_profiles VALUES(1,'active')");
  const partner=await get('/api/reports?type=partner',user); assert.equal(partner.status,200); assert.equal((await partner.json()).scope,'user');
  assert.equal((await get('/api/reports?type=partner&partnerId=2',user)).status,400);
  const otherUser=jwt.sign({id:2,authVersion:0},secret);
  assert.equal((await get('/api/reports?type=partner',otherUser)).status,403);
  await dbRun(db,"UPDATE partner_profiles SET status='suspended' WHERE user_id=1");
  assert.equal((await get('/api/reports?type=partner',user)).status,403);
  for(const type of ['subscription','milestone','blank']) assert.equal((await get('/api/reports?type='+type,user)).status,403);
  assert.equal((await get('/api/admin/reports?type=blank',user)).status,403);
  assert.equal((await get('/api/admin/reports?type=blank',admin)).status,200);
  assert.equal((await get('/api/admin/reports?type=sandbox',admin)).status,200);
});
