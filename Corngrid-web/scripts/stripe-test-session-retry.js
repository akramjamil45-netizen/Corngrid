'use strict';
// Reconcile the SAME local test order with the SAME Stripe idempotency key.
const fs=require('fs'),path=require('path'),dotenv=require('dotenv'),sqlite=require('sqlite3');
const {dbGet,dbRun}=require('../db-async');
async function main(){
 const root=path.join(__dirname,'..'),env=dotenv.parse(fs.readFileSync(path.join(root,'.env')));
 if(!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||''))throw Error('Test key required.');
 const dir=path.join(root,'storage/stripe-test'),db=new sqlite.Database(path.join(dir,'database.sqlite'));
 try{
  const o=await dbGet(db,'SELECT * FROM stripe_orders ORDER BY created_at DESC LIMIT 1');
  if(!o||o.status!=='pending'||Date.now()-o.created_at>23*3600000)throw Error('No recent pending test order.');
  const stripe=require('../subscriptions/stripe-client').createStripeClient(env.STRIPE_SECRET_KEY,{maxNetworkRetries:0});
  if(process.argv.includes('--reset-confirmed-empty')){
   if(o.session_id)throw Error('Order has a Session; reconcile it instead of resetting.');
   for await(const s of stripe.checkout.sessions.list({limit:100,created:{gte:Math.floor(o.created_at/1000)-60}})){
    if(s.client_reference_id===o.id||s.metadata?.order_id===o.id)throw Error('A Stripe Session exists for this order; reset refused.');
   }
   await dbRun(db,'BEGIN IMMEDIATE');
   try{
    await dbRun(db,"UPDATE stripe_orders SET status='failed',review_status='api_parameter_migration' WHERE id=?",[o.id]);
    await dbRun(db,"UPDATE user_subscriptions SET status='cancelled',deleted_at=?,updated_at=? WHERE id=(SELECT subscription_id FROM subscription_payments WHERE id=?) AND status='pending_payment'",[Date.now(),Date.now(),o.payment_id]);
    await dbRun(db,"UPDATE subscription_payments SET status='cancelled',updated_at=? WHERE id=? AND status='pending_payment'",[Date.now(),o.payment_id]);
    await dbRun(db,'COMMIT');
   }catch(e){await dbRun(db,'ROLLBACK');throw e;}
   console.log('Confirmed no Stripe Session exists. Failed test order preserved and closed for a fresh API-version test.');return;
  }
  const session=o.session_id?await stripe.checkout.sessions.retrieve(o.session_id):await stripe.checkout.sessions.create({mode:'payment',client_reference_id:o.id,
   metadata:{order_id:o.id,user_id:String(o.user_id),payment_id:String(o.payment_id)},payment_intent_data:{metadata:{order_id:o.id}},line_items:[{quantity:1,price_data:{currency:o.currency,unit_amount:o.amount_minor,product_data:{name:'CornGrid EA subscription'}}}],success_url:'http://localhost:3001/dashboard.html?stripe=success&order='+o.id+'#subscription',cancel_url:'http://localhost:3001/dashboard.html?stripe=cancel&order='+o.id+'#subscription'}, {idempotencyKey:'corngrid-checkout-'+o.id});
  if(session.livemode)throw Error('Unexpected live Session.');
  await dbRun(db,'UPDATE stripe_orders SET session_id=?,checkout_url=? WHERE id=?',[session.id,session.url,o.id]);
  fs.writeFileSync(path.join(dir,'checkout-result.json'),JSON.stringify({mode:'test',orderId:o.id,paymentId:o.payment_id,sessionId:session.id,url:session.url,status:session.status,amountMinor:session.amount_total,currency:session.currency,createdAt:Date.now()},null,2),{mode:0o600});
  console.log(JSON.stringify({mode:'test',sessionCreated:true,status:session.status,amountMinor:session.amount_total,currency:session.currency,paymentMethods:session.payment_method_types,resultFile:'storage/stripe-test/checkout-result.json'}));
 }finally{await new Promise(resolve=>db.close(resolve));}
}
main().catch(e=>{console.error(JSON.stringify({type:e.type||'TestError',code:e.code||null,status:e.statusCode||null,param:e.param||null,message:String(e.message||'').replace(/(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g,'[REDACTED]')}));process.exitCode=1;});
