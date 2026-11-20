'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs/promises'), path = require('node:path');
const { Client } = require('pg'), createDatabase = require('../db-postgres');
const { dbGet, dbRun, withTransaction } = require('../db-async');
const { createPromotions } = require('../subscriptions/promotions');
const url = process.env.TEST_POSTGRES_URL;

test('PostgreSQL promotions serialize cross-worker claims and preserve lifetime history through edits/deletion', { skip: !url, timeout: 30000 }, async () => {
  const control = new Client({ connectionString: url }), schema = 'promotions_test_' + crypto.randomBytes(8).toString('hex'), pools = [];
  await control.connect();
  try {
    await control.query('CREATE SCHEMA ' + schema); await control.query('SET search_path TO ' + schema);
    const folder = path.join(__dirname, '../migrations/postgres');
    for (const file of (await fs.readdir(folder)).filter(n=>n.endsWith('.sql')).sort()) await control.query(await fs.readFile(path.join(folder,file),'utf8'));
    await control.query(await fs.readFile(path.join(folder,'0021_subscription_promotions.sql'),'utf8'));
    const scoped = new URL(url); scoped.searchParams.set('options','-c search_path='+schema);
    const a = createDatabase(scoped.toString()), b = createDatabase(scoped.toString()); pools.push(a,b);
    const time = Date.now();
    const service = db => createPromotions({ run:(sql,params)=>dbRun(db,sql,params), get:(sql,params)=>dbGet(db,sql,params),
      withTransaction: task=>withTransaction(db,task), isPostgres:true, now:()=>time });
    const sa=service(a), sb=service(b);
    const user = await dbRun(a,"INSERT INTO users(username,email,password) VALUES('promotion-fixture','promo@example.test','fixture')");
    const plan = await dbRun(a,"INSERT INTO subscription_plans(name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES('Free access',0,'MYR',7,1,TRUE,?,?)",[time,time]);
    await dbRun(a,'INSERT INTO subscription_plan_promotions(plan_id,created_at) VALUES(?,?)',[plan.lastID,time]);
    const results = await Promise.all([sa.claim(user.lastID,plan.lastID),sb.claim(user.lastID,plan.lastID),sa.claim(user.lastID,plan.lastID),sb.claim(user.lastID,plan.lastID)]);
    assert.equal(results.filter(r=>r.http===201).length,1); assert.equal(results.filter(r=>r.http===409).length,3);
    assert.equal((await dbGet(a,'SELECT COUNT(*) n FROM user_subscriptions')).n,1);
    assert.equal((await dbGet(a,'SELECT COUNT(*) n FROM subscription_payments')).n,0);
    assert.equal((await dbGet(a,"SELECT COUNT(*) n FROM subscription_audit_logs WHERE action='promotion_claimed'")).n,1);
    await dbRun(a,'UPDATE subscription_plans SET duration_days=21,max_activations=3 WHERE id=?',[plan.lastID]);
    let claim = await dbGet(a,'SELECT * FROM subscription_promotion_claims WHERE user_id=?',[user.lastID]);
    assert.equal(claim.duration_days,7); assert.equal(claim.max_activations,1);
    await dbRun(a,'DELETE FROM user_subscriptions WHERE id=?',[claim.subscription_id]);
    await dbRun(a,'DELETE FROM subscription_plans WHERE id=?',[plan.lastID]);
    claim = await dbGet(a,'SELECT * FROM subscription_promotion_claims WHERE user_id=?',[user.lastID]);
    assert.equal(claim.subscription_id,null); assert.equal(claim.plan_id,null);
    assert.equal((await sb.claim(user.lastID,plan.lastID)).http,409);
  } finally {
    for (const db of pools) await new Promise(resolve=>db.close(resolve));
    try { await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); } finally { await control.end(); }
  }
});
