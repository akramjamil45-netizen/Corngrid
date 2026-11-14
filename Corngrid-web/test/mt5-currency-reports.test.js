'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),sqlite=require('sqlite3');
const {dbRun}=require('../db-async');
const {createReportService}=require('../reports/report-service');

test('MT5 reports group legacy cent aliases without changing amounts, USD totals or partner USDC',async t=>{
 const db=new sqlite.Database(':memory:');t.after(()=>new Promise(resolve=>db.close(resolve)));
 const stamp=Date.parse('2026-11-14T08:00:00Z');
 await new Promise((resolve,reject)=>db.exec(`
  CREATE TABLE users(id INTEGER PRIMARY KEY,created_at TEXT);
  CREATE TABLE account_archives(user_id INTEGER PRIMARY KEY);
  CREATE TABLE mt5_accounts(id INTEGER PRIMARY KEY,user_id INTEGER,account_name TEXT,account_number TEXT,currency TEXT,balance REAL,equity REAL,floating_profit REAL,last_heartbeat INTEGER,last_sync INTEGER);
  CREATE TABLE mt5_snapshots(id INTEGER PRIMARY KEY,account_id INTEGER,captured_at INTEGER,balance REAL,equity REAL,floating_profit REAL);
  CREATE TABLE mt5_deals(id INTEGER PRIMARY KEY,account_id INTEGER,closed_at INTEGER,profit REAL,commission REAL,swap REAL);
  CREATE TABLE partner_profiles(user_id INTEGER PRIMARY KEY,status TEXT);
  CREATE TABLE partner_transactions(id INTEGER PRIMARY KEY,partner_id INTEGER,currency TEXT,commission_amount REAL,status TEXT,created_at INTEGER);
  CREATE TABLE partner_payouts(id INTEGER PRIMARY KEY,partner_id INTEGER,currency TEXT,amount REAL,status TEXT,paid_at INTEGER);
  CREATE TABLE ea_submissions(id INTEGER PRIMARY KEY,partner_id INTEGER,status TEXT,deleted_at INTEGER);
  INSERT INTO users VALUES(1,'2026-11-01'),(2,'2026-11-01'),(3,'2026-11-01');
  INSERT INTO account_archives VALUES(3);
 `,error=>error?reject(error):resolve()));
 for(const [id,owner,currency,balance] of [[1,1,'USC',1000],[2,2,'USD',9000],[3,1,'USDC',500],[4,3,'USD',100000]]){
  await dbRun(db,'INSERT INTO mt5_accounts VALUES(?,?,?,?,?,?,?,?,?,?)',[id,owner,'EA','fixture-'+id,currency,balance,balance,0,stamp-1000,stamp-1000]);
 }
 const service=createReportService(db,{now:()=>stamp}),query={period:'weekly',date:'2026-11-14',timezone:'UTC'};
 const options=await service.options('user',1);assert.deepEqual(options.currencies,['USDc']);
 assert.ok(options.accounts.every(a=>a.currency==='USDc'&&a.label.endsWith('USDc')));
 const report=await service.generate('user',1,{...query,currency:'USC'});
 assert.equal(report.currency,'USDc');assert.equal(report.metrics[3].value,1500);
 const usd=await service.generate('admin',undefined,{...query,type:'funds',currency:'USD'});
 assert.equal(usd.metrics[0].value,9000);
 await dbRun(db,"UPDATE mt5_accounts SET currency='USD' WHERE id=3");
 const mixed=await service.generate('user',1,query);assert.equal(mixed.currency,null);assert.equal(mixed.metrics[3].value,null);
 await dbRun(db,"INSERT INTO partner_profiles VALUES(1,'active')");
 await dbRun(db,"INSERT INTO partner_transactions VALUES(1,1,'USDC',25,'approved',?)",[stamp-1000]);
 const ledger=await service.generate('user',1,{...query,type:'partner',currency:'USDC'});
 assert.equal(ledger.currency,'USDC');assert.equal(ledger.metrics[0].value,25);
});
