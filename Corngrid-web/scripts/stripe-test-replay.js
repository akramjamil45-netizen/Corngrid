'use strict';
const fs=require('node:fs'),path=require('node:path'),sqlite=require('sqlite3');
const {dbGet}=require('../db-async');
async function main(){
 const root=path.join(__dirname,'..'),dir=path.join(root,'storage/stripe-test');
 const config=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
 if(!/^(sk|rk)_test_/.test(config.STRIPE_SECRET_KEY||''))throw Error('Test key required');
 const db=new sqlite.Database(path.join(dir,'database.sqlite'),sqlite.OPEN_READONLY);
 try{
  const before=await dbGet(db,"SELECT o.id,o.session_id,o.activated_at,s.expires_at,p.status AS payment_status FROM stripe_orders o JOIN subscription_payments p ON p.id=o.payment_id JOIN user_subscriptions s ON s.id=p.subscription_id WHERE o.status='paid' ORDER BY o.created_at DESC LIMIT 1");
  if(!before?.activated_at)throw Error('No fulfilled test order');
  const recorded=await dbGet(db,"SELECT id FROM stripe_events WHERE type='checkout.session.completed' ORDER BY processed_at DESC LIMIT 1");
  const stripe=require('../subscriptions/stripe-client').createStripeClient(config.STRIPE_SECRET_KEY,{maxNetworkRetries:0});
  const event=await stripe.events.retrieve(recorded.id);
  if(event.livemode||event.data.object.id!==before.session_id)throw Error('Test event does not match test order');
  const payload=JSON.stringify(event),secret=fs.readFileSync(path.join(dir,'local-webhook-secret'),'utf8').trim();
  const post=signature=>fetch('http://localhost:3001/api/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});
  const signature=stripe.webhooks.generateTestHeaderString({payload,secret});
  const invalid=await post('invalid');
  const replies=await Promise.all([post(signature),post(signature),post(signature)]);
  const after=await dbGet(db,'SELECT o.activated_at,s.expires_at FROM stripe_orders o JOIN subscription_payments p ON p.id=o.payment_id JOIN user_subscriptions s ON s.id=p.subscription_id WHERE o.id=?',[before.id]);
  const result={mode:'test',invalidSignatureStatus:invalid.status,replayStatuses:replies.map(r=>r.status),activationUnchanged:before.activated_at===after.activated_at,expiryUnchanged:before.expires_at===after.expires_at,paymentStatus:before.payment_status};
  if(invalid.status!==400||replies.some(r=>r.status!==200)||!result.activationUnchanged||!result.expiryUnchanged)throw Error('Replay safety check failed');
  fs.writeFileSync(path.join(dir,'replay-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await new Promise(resolve=>db.close(resolve));}
}
main().catch(e=>{console.error(JSON.stringify({error:e.type||'ReplayTestError',code:e.code||null,status:e.statusCode||null}));process.exitCode=1;});
