'use strict';
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {dbGet,dbAll,dbRun,withTransaction,isPostgres}=require('../db-async');
function createStripePayments(app,db,verifyUser,adminAuth,subscriptions,options={}) {
 const config=options.env||process.env;
 const stripe=options.stripe || (config.STRIPE_SECRET_KEY ? require('./stripe-client').createStripeClient(config.STRIPE_SECRET_KEY) : null);
 const enabled=!!(stripe&&config.STRIPE_WEBHOOK_SECRET&&config.APP_BASE_URL);
 let base;
 if(enabled){base=new URL(config.APP_BASE_URL);if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||!(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname))))throw Error('APP_BASE_URL must be a trusted HTTPS origin (HTTP localhost allowed).');}
 const get=(s,p)=>dbGet(db,s,p),run=(s,p)=>dbRun(db,s,p);
 const ready=async()=>{await subscriptions.ready();if(!isPostgres(db))await new Promise((resolve,reject)=>db.exec(['0008_stripe.sql','0013_stripe_reconciliation.sql'].map(file=>fs.readFileSync(path.join(__dirname,'../migrations/sqlite',file),'utf8')).join('\n'),e=>e?reject(e):resolve()));else {await get('SELECT id FROM stripe_orders LIMIT 1');await get('SELECT order_id FROM stripe_reconciliation LIMIT 1');}};
 const init=ready();init.catch(()=>console.error('Stripe schema unavailable; apply 0008 and 0013 migrations.'));
 subscriptions.setPaymentRemovalReconciler(require('./stripe-removal').createStripeRemovalReconciler({
  get,stripe,ready:()=>init,liveMode:/^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY||'')
 }));
 const buckets=new Map();
 const reconciliationBuckets=new Map();
 function guard(req,res,next){
  if(!enabled)return res.status(503).json({error:'Card payments are not configured. Please use DuitNow.'});
  if(req.get('Origin')&&req.get('Origin')!==base.origin)return res.status(403).json({error:'Invalid request origin.'});
  const key=req.user.id,now=Date.now();for(const[k,v]of buckets)if(v.until<now)buckets.delete(k);
  const b=buckets.get(key)||{n:0,until:now+60000};buckets.set(key,b);
  if(++b.n>10)return res.status(429).json({error:'Please wait before trying checkout again.'});next();
 }
 app.get('/api/subscription/payment-methods',verifyUser,async(_q,r)=>{try{await init;r.json({duitnow:true,stripe:enabled});}catch{r.json({duitnow:true,stripe:false});}});
 app.post('/api/subscription/stripe/checkout',verifyUser,guard,async(req,res)=>{
  try{await init;
   const order=await withTransaction(db,async()=>{
    // Serialize all purchases for a user across workers, including different orders.
    await run('UPDATE users SET id=id WHERE id=?',[req.user.id]);
    await run('UPDATE subscription_payments SET id=id WHERE id=? AND user_id=?',[req.body?.paymentId,req.user.id]);
    const payment=await get('SELECT * FROM subscription_payments WHERE id=? AND user_id=?',[req.body?.paymentId,req.user.id]);
    if(!payment||payment.status!=='pending_payment')throw Error('Select an unpaid subscription first.');
    const sub=await get('SELECT * FROM user_subscriptions WHERE id=?',[payment.subscription_id]);
    if(!sub||sub.deleted_at||sub.status!=='pending_payment')throw Error('Subscription is not payable.');
    const old=await get('SELECT * FROM stripe_orders WHERE payment_id=?',[payment.id]);
    if(old)return old;
    // Existing plan currencies with two decimal places only; no conversion or guessing.
    if(!['MYR','USD','EUR','GBP','SGD','AUD','CAD'].includes(payment.currency.toUpperCase()))throw Error('This currency is not configured for card payments.');
    const amount=Math.round(Number(payment.amount)*100);if(!Number.isSafeInteger(amount)||amount<=0)throw Error('Invalid package price.');
    const id=crypto.randomUUID();
    await run('INSERT INTO stripe_orders(id,payment_id,user_id,amount_minor,currency,created_at) VALUES(?,?,?,?,?,?)',[id,payment.id,req.user.id,amount,payment.currency.toLowerCase(),Date.now()]);
    await run("UPDATE subscription_payments SET payment_method='stripe' WHERE id=?",[payment.id]);
    return get('SELECT * FROM stripe_orders WHERE id=?',[id]);
   });
   if(order.status!=='pending')return res.status(409).json({error:'Checkout has ended. Select DuitNow or create a new purchase.'});
   if(order.session_id){const session=await stripe.checkout.sessions.retrieve(order.session_id);return res.json({orderId:order.id,url:session.url,status:session.status});}
   if(Date.now()-Number(order.created_at)>23*3600000)return res.status(409).json({error:'Checkout retry window ended. Contact support before creating another payment.'});
   const session=await stripe.checkout.sessions.create({mode:'payment',...(config.STRIPE_PAYMENT_METHOD_CONFIGURATION?{payment_method_configuration:config.STRIPE_PAYMENT_METHOD_CONFIGURATION}:{}),client_reference_id:order.id,
    metadata:{order_id:order.id,user_id:String(order.user_id),payment_id:String(order.payment_id)},
    payment_intent_data:{metadata:{order_id:order.id}},line_items:[{quantity:1,price_data:{currency:order.currency,unit_amount:order.amount_minor,product_data:{name:'CornGrid EA subscription'}}}],
    success_url:base.origin+'/dashboard.html?stripe=success&order='+order.id+'#subscription',cancel_url:base.origin+'/dashboard.html?stripe=cancel&order='+order.id+'#subscription'}, {idempotencyKey:'corngrid-checkout-'+order.id});
   await run('UPDATE stripe_orders SET session_id=?,checkout_url=? WHERE id=?',[session.id,session.url,order.id]);res.json({orderId:order.id,url:session.url});
  }catch(e){console.error('Stripe checkout failed:',{type:e.type||'CheckoutError',code:e.code||null,status:e.statusCode||null});res.status(409).json({error:'Unable to open card checkout. Retry the same purchase or contact support.'});}
 });
 app.get('/api/subscription/stripe/orders/:id',verifyUser,async(req,res)=>{
  try{await init;const o=await get('SELECT o.id,o.status,o.review_status,o.amount_minor,o.currency,o.paid_at,o.activated_at,s.status AS subscription_status,s.expires_at FROM stripe_orders o JOIN subscription_payments p ON p.id=o.payment_id JOIN user_subscriptions s ON s.id=p.subscription_id WHERE o.id=? AND o.user_id=?',[req.params.id,req.user.id]);res.status(o?200:404).json(o||{error:'Order not found.'});}catch{res.status(503).json({error:'Payment status unavailable.'});}
 });
 app.get('/api/subscription/stripe/payment/:id',verifyUser,async(req,res)=>{try{await init;const o=await get('SELECT id,status FROM stripe_orders WHERE payment_id=? AND user_id=?',[req.params.id,req.user.id]);res.status(o?200:404).json(o||{error:'Order not found.'});}catch{res.sendStatus(503);}});
 app.post('/api/subscription/stripe/orders/:id/reconcile',verifyUser,async(req,res)=>{
  if(!enabled)return res.status(503).json({error:'Card payment verification is unavailable.'});
  if(req.get('Origin')&&req.get('Origin')!==base.origin)return res.status(403).json({error:'Invalid request origin.'});
  const now=Date.now();for(const [key,value]of reconciliationBuckets)if(value.until<now)reconciliationBuckets.delete(key);
  const bucket=reconciliationBuckets.get(req.user.id)||{count:0,until:now+60000};reconciliationBuckets.set(req.user.id,bucket);
  if(++bucket.count>30)return res.status(429).json({error:'Please wait before checking payment again.'});
  try{
   await init;
   const result=await recovery.reconcile(req.params.id,{userId:req.user.id,force:true});
   if(result.missing)return res.status(404).json({error:'Order not found.'});
   const order=await get('SELECT o.id,o.status,o.review_status,o.paid_at,o.activated_at,s.status AS subscription_status,s.expires_at FROM stripe_orders o JOIN subscription_payments p ON p.id=o.payment_id JOIN user_subscriptions s ON s.id=p.subscription_id WHERE o.id=? AND o.user_id=?',[req.params.id,req.user.id]);
   res.json({...order,reconciliationPending:Boolean(result.errorCode)});
  }catch{res.status(503).json({error:'Payment verification is temporarily unavailable. The server will retry automatically.'});}
 });
 app.post('/api/subscription/stripe/orders/:id/duitnow',verifyUser,guard,async(req,res)=>{
  try{await init;const o=await get('SELECT * FROM stripe_orders WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!o||o.status==='paid')return res.status(409).json({error:'Order cannot be changed.'});
   if(!o.session_id)return res.status(409).json({error:'Retry card checkout first to reconcile its session.'});
   let session=await stripe.checkout.sessions.retrieve(o.session_id);if(session.status==='open')session=await stripe.checkout.sessions.expire(o.session_id);
   if(session.status!=='expired')return res.status(409).json({error:'Payment is processing or complete. Wait for confirmation.'});
   await withTransaction(db,async()=>{await run("UPDATE stripe_orders SET status='expired' WHERE id=? AND activated_at IS NULL",[o.id]);await run("UPDATE subscription_payments SET payment_method='duitnow' WHERE id=? AND status='pending_payment'",[o.payment_id]);});res.json({success:true});
  }catch{res.status(409).json({error:'Unable to switch payment method safely. Please retry.'});}
 });
 // Prevent manual approval, proof submission or local cancellation from racing a live card session.
 const protect=async(req,res,next)=>{try{const id=req.body?.paymentId||req.params.id;const p=await get('SELECT payment_method FROM subscription_payments WHERE id=?',[id]);if(p?.payment_method==='stripe')return res.status(409).json({error:'Stripe payments are confirmed automatically. Return to card checkout or switch to DuitNow first.'});next();}catch{res.status(503).json({error:'Payment unavailable.'});}};
 // Installed by server before subscription routes via mountProtection().
 function mountProtection(){for(const p of ['/api/subscription/payment-proof','/api/subscription/cancel'])app.post(p,verifyUser,protect);for(const action of ['approve','reject'])app.post('/api/admin/subscription-payments/:id/'+action,adminAuth.verifyToken,protect);}
 function invalid(code){return Object.assign(new Error(code),{code});}
 async function applySession(session,{event=null,paidAt=null,reconciliation=false,expectedOrderId=null}={}){
  await init;
  let approved=null;
  await withTransaction(db,async()=>{
   // Only real, signature-verified events enter stripe_events. API recovery uses
   // the same order/user locks and activation marker, with its own audit action.
   if(event){const inserted=await run('INSERT INTO stripe_events(id,type,processed_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',[event.id,event.type,Date.now()]);if(!inserted.changes)return;}
   let o=await get('SELECT * FROM stripe_orders WHERE id=?',[expectedOrderId||session.metadata?.order_id||'']);
   if(!o){if(expectedOrderId||session.metadata?.order_id)throw invalid('STRIPE_ORDER_MISSING');return;}
   await run('UPDATE users SET id=id WHERE id=?',[o.user_id]);
   o=await get('SELECT * FROM stripe_orders WHERE id=?',[o.id]);
   await run('UPDATE subscription_payments SET id=id WHERE id=?',[o.payment_id]);
   const payment=await get('SELECT * FROM subscription_payments WHERE id=?',[o.payment_id]);
   if((o.session_id&&session.id!==o.session_id)||session.client_reference_id!==o.id||session.metadata?.order_id!==o.id||session.metadata?.user_id!==String(o.user_id)||session.metadata?.payment_id!==String(o.payment_id)||session.amount_total!==Number(o.amount_minor)||session.currency!==o.currency||session.mode!=='payment'||session.livemode!==/^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY||'')||!payment||payment.user_id!==o.user_id||Math.round(Number(payment.amount)*100)!==Number(o.amount_minor)||String(payment.currency).toLowerCase()!==o.currency)throw invalid('STRIPE_RECONCILIATION_MISMATCH');
   if(o.activated_at)return;
   if(session.payment_status==='paid'&&session.status==='complete'){
    if(payment.payment_method!=='stripe')throw invalid('STRIPE_PAYMENT_PROVIDER_CHANGED');
    if(event)paidAt=event.created*1000;
    if(!Number.isSafeInteger(paidAt)||paidAt<=0||paidAt>Date.now()+300000)throw invalid('STRIPE_PAYMENT_TIME_INVALID');
    await run('UPDATE stripe_orders SET session_id=?,payment_intent_id=?,status=?,paid_at=? WHERE id=?',[session.id,typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id,'paid',paidAt,o.id]);
    await run("UPDATE subscription_payments SET status='pending_approval',payment_reference=?,updated_at=? WHERE id=? AND payment_method='stripe' AND status='pending_payment'",[session.id,Date.now(),o.payment_id]);
    const result=await subscriptions.activatePayment(o.payment_id,null,reconciliation?'Stripe verified payment (automatic API recovery)':'Stripe verified payment',null,paidAt);
    if(result.http!==200)throw invalid('STRIPE_SUBSCRIPTION_ACTIVATION_BLOCKED');
    await run('UPDATE stripe_orders SET activated_at=? WHERE id=?',[Date.now(),o.id]);approved=await get('SELECT * FROM subscription_payments WHERE id=?',[o.payment_id]);
    if(reconciliation)await run("INSERT INTO subscription_audit_logs(actor_role,action,affected_type,affected_id,metadata,created_at) VALUES('system','stripe_payment_reconciled','payment',?,?,?)",[o.payment_id,JSON.stringify({orderId:o.id,sessionId:session.id,paidAt,source:'stripe_api'}),Date.now()]);
   }else if(session.status==='expired'||event?.type.endsWith('async_payment_failed')){
    const outcome=session.status==='expired'?'expired':'failed';
    await run('UPDATE stripe_orders SET status=? WHERE id=?',[outcome,o.id]);
    await subscriptions.notificationCenter?.stripeOutcome(o.user_id,o.id,outcome);
   }
  });
  if(approved)for(const listener of subscriptions.paymentApprovedListeners){try{await listener(approved);}catch{console.error('Stripe post-approval listener failed.');}}
 }
 async function processEvent(event){
  await init;
  const supported=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','payment_intent.payment_failed','charge.refunded','charge.dispute.created','charge.dispute.closed'];
  if(!supported.includes(event.type))return;
  const object=event.data.object;
  if(event.type.startsWith('checkout.session.'))return applySession(await stripe.checkout.sessions.retrieve(object.id),{event});
  await withTransaction(db,async()=>{
   const inserted=await run('INSERT INTO stripe_events(id,type,processed_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',[event.id,event.type,Date.now()]);if(!inserted.changes)return;
   const order=await get('SELECT * FROM stripe_orders WHERE payment_intent_id=? OR id=?',[object.payment_intent||object.id,object.metadata?.order_id||'']);
   if(order){await run('UPDATE users SET id=id WHERE id=?',[order.user_id]);await run('UPDATE stripe_orders SET review_status=? WHERE id=?',[event.type,order.id]);}
  });
 }
 const recovery=require('./stripe-reconciliation').createStripeReconciliation({db,stripe,ready:()=>init,applySession,enabled,now:options.now,intervalMs:options.recoveryIntervalMs,startupMs:options.recoveryStartupMs});
 async function webhook(req,res){if(!enabled)return res.sendStatus(503);let event;
  try{event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),config.STRIPE_WEBHOOK_SECRET);}catch{return res.status(400).json({error:'Invalid Stripe signature.'});}
  if(event.livemode!==/^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY))return res.sendStatus(400);
  try{await processEvent(event);res.json({received:true});}catch{console.error('Stripe event requires retry/reconciliation:',event.id);res.sendStatus(500);}
 }
 app.get('/api/admin/stripe-orders',adminAuth.verifyToken,async(_q,res)=>{try{await init;res.json({orders:await dbAll(db,'SELECT o.id,o.payment_id,o.user_id,o.amount_minor,o.currency,o.status,o.review_status,o.session_id,o.payment_intent_id,o.paid_at,o.activated_at,r.last_checked_at,r.last_error_code,r.next_check_at FROM stripe_orders o LEFT JOIN stripe_reconciliation r ON r.order_id=o.id ORDER BY o.created_at DESC LIMIT 200')});}catch{res.status(503).json({error:'Stripe orders unavailable.'});}});
 return {webhook,processEvent,ready:()=>init,mountProtection,start:recovery.start,stop:recovery.stop,runRecoveryBatch:recovery.runBatch};
}
module.exports=createStripePayments;
