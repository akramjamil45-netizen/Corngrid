'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const sqlite = require('sqlite3');
const { dbGet, dbRun } = require('../db-async');

async function fixture(t) {
  const db = new sqlite.Database(':memory:');
  const exec = sql => new Promise((resolve,reject) => db.exec(sql,error=>error?reject(error):resolve()));
  await exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, email TEXT); INSERT INTO users VALUES(1,\'Preview\',\'preview@example.test\')');
  const app = express(); app.use(express.json());
  const admin = { verifyToken(req,res,next) { if(req.get('X-Admin')!=='1')return res.sendStatus(req.get('X-User')?403:401);req.admin={id:99};next(); } };
  const user = (req,_res,next) => { req.user={id:1}; next(); };
  const subscriptions = require('../subscriptions/subscription-api')(app,db,user,admin,user);
  await subscriptions.ready();
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));});
  const request = (route,method='GET',headers={'X-Admin':'1'}) => fetch('http://127.0.0.1:'+server.address().port+route,{method,headers});
  const add = async(status='cancelled') => (await dbRun(db,'INSERT INTO subscription_payments(user_id,amount,currency,status,created_at,updated_at) VALUES(1,50,\'MYR\',?,0,0)',[status])).lastID;
  const remove = (id,headers) => request('/api/admin/subscription-payments/'+id,'DELETE',headers);
  return {db,exec,request,add,remove};
}

test('closed payment requests can be removed once, with history and auth boundaries preserved',async t=>{
  const {db,request,add,remove} = await fixture(t);
  const cancelled=await add(), rejected=await add('rejected');
  assert.equal((await remove(cancelled,{})).status,401);
  assert.equal((await remove(cancelled,{'X-User':'1'})).status,403);
  assert.equal((await remove(cancelled+'bad')).status,400);
  assert.ok((await Promise.all([remove(cancelled),remove(cancelled)])).every(r=>r.status===200));
  assert.equal((await remove(rejected)).status,200);
  assert.deepEqual((await (await request('/api/admin/subscription-payments')).json()).payments,[]);
  assert.deepEqual((await (await request('/api/admin/subscription-payments?status=cancelled')).json()).payments,[]);
  assert.equal((await dbGet(db,'SELECT COUNT(*) AS n FROM subscription_payments')).n,2);
  assert.equal((await dbGet(db,'SELECT archived_by FROM subscription_payment_archives WHERE payment_id=?',[cancelled])).archived_by,99);
  assert.equal((await dbGet(db,"SELECT COUNT(*) AS n FROM subscription_audit_logs WHERE action='payment_deleted' AND affected_id=?",[cancelled])).n,1);
  for(const status of ['pending_payment','pending_approval','approved']) {
    const id=await add(status);assert.equal((await remove(id)).status,409);
    assert.equal(await dbGet(db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[id]),undefined);
  }
  assert.equal((await remove(99999)).status,404);
});

test('paid or unresolved Stripe orders block removal even when the payment method says DuitNow',async t=>{
  const {db,exec,add,remove} = await fixture(t);
  await exec(fs.readFileSync(path.join(__dirname,'../migrations/sqlite/0008_stripe.sql'),'utf8'));
  for(const [status,paidAt,activatedAt,expected] of [['pending',null,null,409],['paid',null,null,409],['expired',1,null,409],['failed',null,1,409],['expired',null,null,200],['failed',null,null,200]]) {
    const id=await add();
    await dbRun(db,'INSERT INTO stripe_orders(id,payment_id,user_id,amount_minor,currency,status,paid_at,activated_at,created_at) VALUES(?,?,1,5000,\'myr\',?,?,?,0)',[String(id),id,status,paidAt,activatedAt]);
    assert.equal((await remove(id)).status,expected);
    assert.ok(await dbGet(db,'SELECT id FROM stripe_orders WHERE payment_id=?',[id]));
  }
});

test('payment queue removal rolls back when its audit record cannot be stored',async t=>{
  const {db,exec,add,remove,request}=await fixture(t);
  const id=await add();
  await exec("CREATE TRIGGER reject_removal_audit BEFORE INSERT ON subscription_audit_logs WHEN NEW.action='payment_deleted' BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END;");
  assert.equal((await remove(id)).status,500);
  assert.equal(await dbGet(db,'SELECT * FROM subscription_payment_archives WHERE payment_id=?',[id]),undefined);
  assert.ok((await (await request('/api/admin/subscription-payments')).json()).payments.some(p=>p.id===id));
});
