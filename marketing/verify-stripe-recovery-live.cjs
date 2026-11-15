'use strict';
// Verify deployed recovery using an already activated payment; no new charge.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web');
async function main(){
 const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
 const {Client}=require(path.join(root,'node_modules/pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  const before=(await db.query(`SELECT o.id,o.activated_at,p.user_id,s.id AS subscription_id,s.expires_at,
   COALESCE(v.version,0) AS auth_version FROM stripe_orders o JOIN subscription_payments p ON p.id=o.payment_id
   JOIN user_subscriptions s ON s.id=p.subscription_id LEFT JOIN user_auth_versions v ON v.user_id=p.user_id
   WHERE p.id=19`)).rows[0];
  assert.ok(before?.activated_at,'Payment 19 must already be activated for this no-op verification');
  const jwt=require(path.join(root,'node_modules/jsonwebtoken')),token=jwt.sign({id:Number(before.user_id),authVersion:Number(before.auth_version)},env.JWT_SECRET,{expiresIn:'60s'});
  const endpoint='http://127.0.0.1:3000/api/subscription/stripe/orders/'+before.id+'/reconcile';
  assert.equal((await fetch(endpoint,{method:'POST',signal:AbortSignal.timeout(15000)})).status,401);
  assert.equal((await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,Origin:'https://invalid.example'},signal:AbortSignal.timeout(15000)})).status,403);
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
  assert.equal(response.status,200);const state=await response.json();assert.ok(state.activated_at);assert.equal(state.subscription_status,'active');
  const after=(await db.query('SELECT expires_at FROM user_subscriptions WHERE id=$1',[before.subscription_id])).rows[0];assert.equal(String(after.expires_at),String(before.expires_at));
  await db.query('SELECT order_id,last_checked_at,last_error_code,lease_until FROM stripe_reconciliation LIMIT 0');
  const adminVersion=crypto.createHash('sha256').update(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`).digest('hex');
  const adminToken=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'60s'});
  const adminResponse=await fetch('http://127.0.0.1:3000/api/admin/stripe-orders',{headers:{Authorization:'Bearer '+adminToken},signal:AbortSignal.timeout(15000)});assert.equal(adminResponse.status,200);
  const admin=await adminResponse.json();assert.ok(admin.orders.every(order=>Object.hasOwn(order,'last_checked_at')));
  const page=await fetch('https://corngrid.com/dashboard.html',{signal:AbortSignal.timeout(15000)});assert.equal(page.status,200);assert.ok((await page.text()).includes('stripe-checkout.js?v=20261112-recovery1'));
  const script=await fetch('https://corngrid.com/stripe-checkout.js?v=20261112-recovery1',{signal:AbortSignal.timeout(15000)});assert.equal(script.status,200);assert.ok((await script.text()).includes('/reconcile'));
  const health=await fetch('https://corngrid.com/api/health/ready',{signal:AbortSignal.timeout(15000)});assert.equal(health.status,200);
  console.log(JSON.stringify({reconciliationEndpoint:true,authenticationRequired:true,originChecked:true,existingExpiryUnchanged:true,payment19:'active',migrationVerified:true,adminRecoveryFields:true,publicAssets:true,readiness:200}));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Live Stripe recovery verification failed:',error.code||error.name);process.exitCode=1;});
