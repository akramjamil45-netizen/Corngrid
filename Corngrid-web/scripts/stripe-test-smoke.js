'use strict';
// Real Stripe test-mode Checkout through the local CornGrid API. No card data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sqlite=require('sqlite3'),bcrypt=require('bcryptjs'),dotenv=require('dotenv');
const {dbGet,dbRun}=require('../db-async');
async function main(){
 const root=path.join(__dirname,'..'),dir=path.join(root,'storage/stripe-test');
 const env=dotenv.parse(fs.readFileSync(path.join(root,'.env')));
 if(!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||''))throw Error('A Stripe TEST key is required.');
 const db=new sqlite.Database(path.join(dir,'database.sqlite'));
 let credentials;
 const credentialsPath=path.join(dir,'local-test-login.json');
 if(fs.existsSync(credentialsPath))credentials=JSON.parse(fs.readFileSync(credentialsPath));
 else{credentials={email:'stripe-test@example.test',password:crypto.randomBytes(24).toString('base64url')};fs.writeFileSync(credentialsPath,JSON.stringify(credentials),{mode:0o600});}
 try{
  await dbRun(db,`INSERT INTO users(username,email,password,email_verified,email_verified_at) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET password=excluded.password,email_verified=1`,['StripeTest',credentials.email,await bcrypt.hash(credentials.password,10),1,Date.now()]);
  const plan=await dbGet(db,"SELECT id FROM subscription_plans WHERE name='Stripe local test 30 days'");
  if(!plan)await dbRun(db,'INSERT INTO subscription_plans(name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',['Stripe local test 30 days',10,'MYR',30,5,1,Date.now(),Date.now()]);
 }finally{await new Promise(resolve=>db.close(resolve));}
 const origin='http://localhost:3001';
 const login=await fetch(origin+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(credentials)});
 const auth=await login.json();if(!login.ok||!auth.token)throw Error('Local test login failed.');
 async function request(url,body){const response=await fetch(origin+'/api/'+url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+auth.token,'Content-Type':'application/json',Origin:origin},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw Error('CornGrid API '+response.status+': '+data.error);return data;}
 const methods=await request('subscription/payment-methods');if(!methods.stripe)throw Error('Stripe is disabled on local test server.');
 const plans=await request('subscription/plans');
 const plan=plans.plans.find(p=>p.name==='Stripe local test 30 days');if(!plan)throw Error('Test plan missing.');
 let overview=await request('subscription/overview'),payment=overview.latestPayment;
 if(!payment||payment.status!=='pending_payment'){const purchase=await request('subscription/subscribe',{planId:plan.id});payment={id:purchase.paymentId};}
 const checkout=await request('subscription/stripe/checkout',{paymentId:payment.id});
 const stripe=require('../subscriptions/stripe-client').createStripeClient(env.STRIPE_SECRET_KEY,{timeout:10000,maxNetworkRetries:0});
 await request('subscription/stripe/orders/'+checkout.orderId);
 const inspection=new sqlite.Database(path.join(dir,'database.sqlite'));
 let sessionId;
 try{sessionId=(await dbGet(inspection,'SELECT session_id FROM stripe_orders WHERE id=?',[checkout.orderId])).session_id;}
 finally{await new Promise(resolve=>inspection.close(resolve));}
 const session=await stripe.checkout.sessions.retrieve(sessionId);
 if(session.livemode||session.amount_total!==1000||session.currency!=='myr')throw Error('Stripe test session reconciliation failed.');
 const result={mode:'test',orderId:checkout.orderId,paymentId:payment.id,sessionId:session.id,url:checkout.url,status:session.status,amountMinor:session.amount_total,currency:session.currency,createdAt:Date.now()};
 fs.writeFileSync(path.join(dir,'checkout-result.json'),JSON.stringify(result,null,2),{mode:0o600});
 console.log(JSON.stringify({mode:result.mode,sessionCreated:true,status:result.status,amount:'MYR 10.00',resultFile:'storage/stripe-test/checkout-result.json'}));
}
main().catch(e=>{console.error(JSON.stringify({error:e.type||'TestError',code:e.code||null,status:e.statusCode||null,message:e.type?'Stripe API request failed; check key permissions and sandbox configuration.':e.message}));process.exitCode=1;});
