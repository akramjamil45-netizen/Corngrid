'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const sqlite = require('sqlite3').verbose(), express = require('express'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { dbRun: run, dbGet: get } = require('../db-async');
const createUserAuth = require('../user-auth'), createAdminAuth = require('../admin-auth');
const registerMt5 = require('../mt5-api'), registerSubscriptions = require('../subscriptions/subscription-api');

async function fixture(t) {
  const db = new sqlite.Database(':memory:'), app = express(), secret = 'promotion-fixture-secret';
  app.use(express.json());
  await run(db, 'PRAGMA foreign_keys=ON');
  await run(db, 'CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,email_verified INTEGER DEFAULT 1,bio TEXT,created_at TEXT)');
  for (let id = 1; id <= 6; id++) await run(db, 'INSERT INTO users(id,username,email,password) VALUES(?,?,?,?)', [id,'Fixture '+id,'fixture'+id+'@example.test','fixture']);
  const auth = createUserAuth({ db, jwtSecret: secret });
  const admin = createAdminAuth({ email: 'admin@example.test', passwordHash: bcrypt.hashSync('fixture',4), jwtSecret: secret });
  const mt5 = registerMt5(app,db,auth), service = registerSubscriptions(app,db,auth,admin,mt5.authenticateInstallation);
  await service.ready();
  const adminToken = await admin.authenticate('admin@example.test','fixture');
  const tokens = Object.fromEntries(Array.from({ length: 6 }, (_,i) => [i+1,jwt.sign({id:i+1,authVersion:0},secret)]));
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); });
  async function request(route, { role = 1, method = 'GET', body, headers = {}, installation } = {}) {
    const response = await fetch('http://127.0.0.1:'+server.address().port+route, { method, headers: {
      ...(role ? {Authorization:'Bearer '+(role === 'admin' ? adminToken : tokens[role])} : {}),
      ...(installation ? { Authorization:'Bearer '+installation } : {}),
      ...(body ? {'Content-Type':'application/json'} : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  async function plan(body = {}) {
    const result = await request('/api/admin/subscription-plans', { role:'admin',method:'POST',body:{ name:'Free access',is_promotion:true,...body } });
    assert.equal(result.status,201,JSON.stringify(result.data)); return result.data.id;
  }
  const claim = (id,role=1) => request('/api/subscription/promotions/claim',{role,method:'POST',body:{planId:id,userId:6,price:0,duration_days:9999}});
  return {db,request,plan,claim,tokens};
}

test('admin creates editable seven-day free plans and paid checkout cannot bypass promotion claims',async t => {
  const f=await fixture(t), id=await f.plan();
  let plans=(await f.request('/api/admin/subscription-plans',{role:'admin'})).data.plans;
  assert.equal(plans[0].is_promotion,1); assert.equal(plans[0].duration_days,7); assert.equal(plans[0].max_activations,1); assert.equal(plans[0].price,0);
  assert.equal((await f.request('/api/subscription/plans')).data.plans[0].isPromotion,true);
  assert.equal((await f.request('/api/subscription/subscribe',{method:'POST',body:{planId:id}})).status,409);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM subscription_payments')).n,0);
  assert.equal((await f.request('/api/admin/subscription-plans/'+id,{role:'admin',method:'PUT',body:{duration_days:14,max_activations:2}})).status,200);
  const claimed=await f.claim(id); assert.equal(claimed.status,201); assert.equal(claimed.data.durationDays,14); assert.equal(claimed.data.maxActivations,2);
});

test('claim immediately grants an expiring licence without a payment and honours activation limits',async t => {
  const f=await fixture(t), id=await f.plan(), before=Date.now(), claim=await f.claim(id);
  assert.equal(claim.status,201); assert.equal(claim.data.scheduled,false);
  const subscription=await get(f.db,'SELECT * FROM user_subscriptions WHERE id=?',[claim.data.subscriptionId]);
  assert.equal(subscription.user_id,1); assert.equal(subscription.status,'active'); assert.equal(subscription.purchase_price,0);
  assert.equal(subscription.expires_at-subscription.starts_at,7*86400000); assert.ok(subscription.starts_at>=before);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM subscription_payments')).n,0);
  const keys=['a'.repeat(64),'b'.repeat(64)];
  for(let i=0;i<2;i++){
    const account=await run(f.db,"INSERT INTO mt5_accounts(user_id,account_number,broker_server,currency,linked_at) VALUES(1,?,'Fixture-Demo','USD',?)",[String(200+i),Date.now()]);
    await run(f.db,'INSERT INTO mt5_installations(account_id,secret_hash,created_at) VALUES(?,?,?)',[account.lastID,crypto.createHash('sha256').update(keys[i]).digest('hex'),Date.now()]);
  }
  assert.equal((await f.request('/api/license/activate',{method:'POST',installation:keys[0],body:{}})).data.license_status,'active');
  assert.equal((await f.request('/api/license/activate',{method:'POST',installation:keys[1],body:{}})).data.license_status,'limit_reached');
  await run(f.db,'UPDATE user_subscriptions SET starts_at=?,expires_at=? WHERE id=?',[Date.now()-900000,Date.now()-1,subscription.id]);
  assert.equal((await f.request('/api/license/verify',{method:'POST',installation:keys[0],body:{}})).data.license_status,'expired');
  assert.equal((await f.claim(id)).status,409);
});

test('concurrent clicks and different promotional plans converge on one lifetime claim',async t => {
  const f=await fixture(t), a=await f.plan(), b=await f.plan({name:'Another promotion'});
  const responses=await Promise.all([f.claim(a),f.claim(a),f.claim(b),f.claim(b)]);
  assert.equal(responses.filter(r=>r.status===201).length,1); assert.equal(responses.filter(r=>r.status===409).length,3);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM user_subscriptions WHERE user_id=1')).n,1);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM subscription_promotion_claims')).n,1);
  assert.equal((await get(f.db,"SELECT COUNT(*) n FROM subscription_audit_logs WHERE action='promotion_claimed'")).n,1);
  assert.equal((await f.claim(a,2)).status,201,'other users retain their own entitlement');
});

test('editing, disabling, recreating and removing subscription records never reset claim history',async t => {
  const f=await fixture(t), id=await f.plan(), first=await f.claim(id);
  await f.request('/api/admin/subscription-plans/'+id,{role:'admin',method:'PUT',body:{duration_days:30,max_activations:4,is_active:false}});
  assert.equal((await f.claim(id,2)).status,404);
  await f.request('/api/admin/subscription-plans/'+id,{role:'admin',method:'PUT',body:{is_active:true}});
  assert.equal((await f.claim(id)).status,409);
  assert.equal((await get(f.db,'SELECT duration_days FROM user_subscriptions WHERE id=?',[first.data.subscriptionId])).duration_days,7);
  await run(f.db,'DELETE FROM user_subscriptions WHERE id=?',[first.data.subscriptionId]);
  assert.equal((await get(f.db,'SELECT subscription_id FROM subscription_promotion_claims WHERE user_id=1')).subscription_id,null);
  assert.equal((await f.request('/api/admin/subscription-plans/'+id,{role:'admin',method:'DELETE'})).status,409);
  assert.equal((await f.claim(await f.plan({name:'Recreated offer'}))).status,409);
  const fresh=await f.claim(id,2); assert.equal(fresh.data.durationDays,30); assert.equal(fresh.data.maxActivations,4);
});

test('existing paid periods and future renewals remain intact while free access is queued afterwards',async t => {
  const f=await fixture(t), id=await f.plan(), time=Date.now(), currentEnd=time+30*86400000, futureEnd=currentEnd+30*86400000;
  await run(f.db,"INSERT INTO user_subscriptions(user_id,status,purchase_price,currency,duration_days,max_activations,starts_at,expires_at,created_at,updated_at) VALUES(1,'active',99,'MYR',30,5,?,?,?,?)",[time-1000,currentEnd,time,time]);
  await run(f.db,"INSERT INTO user_subscriptions(user_id,status,purchase_price,currency,duration_days,max_activations,starts_at,expires_at,created_at,updated_at) VALUES(1,'active',99,'MYR',30,5,?,?,?,?)",[currentEnd,futureEnd,time,time]);
  const result=await f.claim(id); assert.equal(result.status,201); assert.equal(result.data.scheduled,true); assert.equal(result.data.startsAt,futureEnd);
  const overview=(await f.request('/api/subscription/overview')).data;
  assert.equal(overview.subscription.maxActivations,5); assert.equal(overview.subscription.expiresAt,currentEnd);
});

test('authentication, admin roles, account archive/suspension and cookie CSRF remain enforced',async t => {
  const f=await fixture(t), id=await f.plan();
  assert.equal((await f.claim(id,null)).status,401);
  assert.equal((await f.request('/api/admin/subscription-plans',{method:'POST',body:{name:'Forged',is_promotion:true}})).status,403);
  assert.equal((await f.request('/api/subscription/promotions/claim',{role:null,method:'POST',body:{planId:id},headers:{Cookie:'corngrid_session='+f.tokens[1],Origin:'https://untrusted.example'}})).status,403);
  await run(f.db,"INSERT INTO user_subscriptions(user_id,status,purchase_price,currency,created_at,updated_at) VALUES(1,'suspended',0,'MYR',?,?)",[Date.now(),Date.now()]);
  assert.equal((await f.claim(id)).status,409);
  await run(f.db,"INSERT INTO user_account_access(user_id,suspended_until,updated_at) VALUES(2,?,?)",[Date.now()+60000,Date.now()]);
  assert.equal((await f.claim(id,2)).status,403);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM subscription_promotion_claims')).n,0);
});

test('claim/audit failures roll back the entitlement and leave the user eligible to retry',async t => {
  const f=await fixture(t), id=await f.plan();
  await run(f.db,"CREATE TRIGGER reject_promotion_audit BEFORE INSERT ON subscription_audit_logs WHEN NEW.action='promotion_claimed' BEGIN SELECT RAISE(ABORT,'Fixture audit failure'); END");
  assert.equal((await f.claim(id)).status,500);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM user_subscriptions')).n,0);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM subscription_promotion_claims')).n,0);
  await run(f.db,'DROP TRIGGER reject_promotion_audit'); assert.equal((await f.claim(id)).status,201);
});

test('archiving/restoring retains eligibility history and unlimited subscriptions do not consume a claim',async t => {
  const f=await fixture(t), id=await f.plan(), time=Date.now();
  await run(f.db,"INSERT INTO account_archives(user_id,archived_at,archived_by) VALUES(1,?,'fixture admin')",[time]);
  assert.equal((await f.claim(id)).status,403);
  assert.equal((await get(f.db,'SELECT COUNT(*) n FROM subscription_promotion_claims')).n,0);
  await run(f.db,'DELETE FROM account_archives WHERE user_id=1');
  assert.equal((await f.claim(id)).status,201);
  await run(f.db,"INSERT INTO account_archives(user_id,archived_at,archived_by) VALUES(1,?,'fixture admin')",[time]);
  await run(f.db,'DELETE FROM account_archives WHERE user_id=1');
  assert.equal((await f.claim(id)).status,409);
  const unlimited=await run(f.db,"INSERT INTO user_subscriptions(user_id,status,purchase_price,currency,starts_at,created_at,updated_at) VALUES(2,'active',0,'MYR',?,?,?)",[time,time,time]);
  assert.equal((await f.claim(id,2)).status,409);
  assert.equal(await get(f.db,'SELECT user_id FROM subscription_promotion_claims WHERE user_id=2'),undefined);
  await run(f.db,'DELETE FROM user_subscriptions WHERE id=?',[unlimited.lastID]);
  assert.equal((await f.claim(id,2)).status,201);
});

test('invalid promotions and ordinary paid plans cannot grant free access',async t => {
  const f=await fixture(t), paid=await f.plan({is_promotion:false,price:50,duration_days:30});
  assert.equal((await f.claim(paid)).status,404);
  for(const body of [{is_promotion:'true'},{price:2},{duration_days:0},{duration_days:7.5},{duration_days:3651},{max_activations:0}]){
    assert.equal((await f.request('/api/admin/subscription-plans',{role:'admin',method:'POST',body:{name:'Invalid',is_promotion:true,...body}})).status,400);
  }
  const free=await f.plan();
  assert.equal((await f.request('/api/admin/subscription-plans/'+free,{role:'admin',method:'PUT',body:{price:1}})).status,400);
  assert.equal((await f.request('/api/subscription/subscribe',{method:'POST',body:{planId:paid}})).status,201);
});
