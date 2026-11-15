/* Isolated browser QA server. In-memory database and temporary feed uploads only. */
'use strict';
const express = require('express'), sqlite3 = require('sqlite3').verbose();
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
const { dbRun, dbGet } = require('../db-async');
const registerReports = require('../reports/report-api'), registerFeed = require('../feed-api');
async function main() {
  const app = express(), db = new sqlite3.Database(':memory:'), stamp = Date.now();
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corngrid-report-preview-'));
  await new Promise((resolve, reject) => db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,bio TEXT,email_verified INTEGER,created_at TEXT);
    CREATE TABLE account_archives(user_id INTEGER PRIMARY KEY,archived_at INTEGER);
    CREATE TABLE mt5_accounts(id INTEGER PRIMARY KEY,user_id INTEGER,account_name TEXT,account_number TEXT,currency TEXT,balance REAL,equity REAL,floating_profit REAL,last_heartbeat INTEGER,last_sync INTEGER);
    CREATE TABLE mt5_snapshots(id INTEGER PRIMARY KEY,account_id INTEGER,captured_at INTEGER,balance REAL,equity REAL,floating_profit REAL);
    CREATE TABLE mt5_deals(id INTEGER PRIMARY KEY,account_id INTEGER,closed_at INTEGER,profit REAL,commission REAL,swap REAL);
    CREATE TABLE sandbox_instances(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,last_heartbeat_at INTEGER,cpu_percent REAL,memory_mb REAL,created_at INTEGER,deleted_at INTEGER);
    CREATE TABLE user_subscriptions(id INTEGER PRIMARY KEY,user_id INTEGER,status TEXT,deleted_at INTEGER,starts_at INTEGER,expires_at INTEGER);
    CREATE TABLE partner_profiles(user_id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE partner_transactions(id INTEGER PRIMARY KEY,partner_id INTEGER,currency TEXT NOT NULL,commission_amount REAL NOT NULL,status TEXT,created_at INTEGER);
    CREATE TABLE partner_payouts(id INTEGER PRIMARY KEY,partner_id INTEGER,currency TEXT NOT NULL,amount REAL NOT NULL,status TEXT,paid_at INTEGER);
    CREATE TABLE ea_submissions(id INTEGER PRIMARY KEY,partner_id INTEGER,status TEXT,deleted_at INTEGER);
    INSERT INTO partner_profiles VALUES(1,'active');
    INSERT INTO ea_submissions VALUES(1,1,'published',NULL),(2,1,'pending_review',NULL),(3,2,'published',NULL);
    INSERT INTO users VALUES(1,'PreviewAlice','alice@example.test','x','',1,CURRENT_TIMESTAMP),(2,'PreviewBob','bob@example.test','x','',1,CURRENT_TIMESTAMP);
  `, e => e ? reject(e) : resolve()));
  for (const [aid, uid, balance] of [[1,1,1200], [2,2,8000], [3,1,600]]) {
    await dbRun(db,'INSERT INTO mt5_accounts VALUES(?,?,?,?,?,?,?,?,?,?)',[aid,uid,'Preview EA','1234567'+aid,'USD',balance,balance+25,25,stamp,stamp]);
    for(let i=0;i<6;i++) {
      await dbRun(db,'INSERT INTO mt5_snapshots(account_id,captured_at,balance,equity,floating_profit) VALUES(?,?,?,?,?)',[aid,stamp-i*86400000,balance-i*20,balance-i*20+25,25]);
      await dbRun(db,'INSERT INTO mt5_deals(account_id,closed_at,profit,commission,swap) VALUES(?,?,?,?,?)',[aid,stamp-i*86400000,(i%3===0?-20:40),-2,-1]);
    }
  }
  await dbRun(db,"INSERT INTO sandbox_instances VALUES(1,1,'running',?,12,512,?,NULL),(2,2,'stopped',?,0,0,?,NULL)",[stamp,stamp-86400000,stamp-86400000,stamp-86400000]);
  await dbRun(db,"INSERT INTO user_subscriptions VALUES(1,1,'active',NULL,?,?)",[stamp-10000,stamp+86400000]);
  for (let i=0;i<6;i++) await dbRun(db,'INSERT INTO partner_transactions(partner_id,currency,commission_amount,status,created_at) VALUES(?,?,?,?,?)',[1,'MYR',i*12.5+25,i===0?'pending':'approved',stamp-i*86400000]);
  await dbRun(db,"INSERT INTO partner_payouts VALUES(1,1,'MYR',125,'paid',?)",[stamp-1000]);
  const role = req => /report_preview_role=admin/.test(req.headers.cookie || '') ? 'admin' : 'user';
  const userAuth = (req,res,next) => { if(role(req)!=='user') return res.sendStatus(403); req.user={id:/report_preview_user=2/.test(req.headers.cookie || '') ? 2 : 1}; next(); };
  const adminAuth = (req,res,next) => { if(role(req)!=='admin') return res.sendStatus(403); req.admin=true; next(); };
  app.use(express.json());
  app.use('/api', (req,res,next) => { const original=res.json.bind(res); res.json=body=>original(body?.version===1 && body.mode !== 'manual' ? {...body,mode:'sample'} : body); next(); });
  registerReports(app,db,{verifyToken:userAuth,verifyAdminToken:adminAuth,rateLimit:()=> (_req,_res,next)=>next()});
  const feed = registerFeed(app,db,userAuth,adminAuth,{uploadDir}); await feed.ready;
  app.get('/api/preview/count',async(_req,res)=>res.json(await dbGet(db,'SELECT COUNT(*) AS posts FROM feed_posts')));
  app.get('/preview/:role',(req,res)=> {
    const selected=req.params.role==='admin'?'admin':'user'; res.cookie('report_preview_role',selected,{httpOnly:true,sameSite:'strict'});
    res.cookie('report_preview_user',req.query.partner==='no'?'2':'1',{httpOnly:true,sameSite:'strict'});
    res.send(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>CornGrid Report Studio · Synthetic preview</title><link rel="stylesheet" href="/dashboard.css"><link rel="stylesheet" href="/report-studio.css"><script src="/report-renderer.js" defer></script><script src="/report-studio.js" defer></script></head><body><main style="max-width:1260px;margin:auto;padding:20px"><p style="color:#ffeb00">LOCAL TEST PREVIEW · SYNTHETIC DATA · <a href="/preview/admin">Admin</a> / <a href="/preview/user">User</a></p><section data-report-role="${selected}"></section></main></body></html>`);
  });
  app.use(express.static(path.join(__dirname,'../public')));
  const server=app.listen(8792,'127.0.0.1',()=>console.log('Report Studio QA: http://127.0.0.1:8792/preview/user · synthetic data only'));
  const close=()=>server.close(()=>db.close(()=>process.exit(0)));process.once('SIGINT',close);process.once('SIGTERM',close);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
