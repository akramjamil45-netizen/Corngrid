'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.join(__dirname,'..'),env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
if(!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||''))throw Error('Only test keys are allowed.');
const dir=path.join(root,'storage/stripe-test');
const child=spawn(path.join(dir,'cli/stripe.exe'),['listen','--events','checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed,charge.refunded,charge.dispute.created,charge.dispute.closed','--forward-to','http://localhost:3001/api/stripe/webhook'],{windowsHide:true,env:{...process.env,STRIPE_API_KEY:env.STRIPE_SECRET_KEY,STRIPE_CLI_TELEMETRY_OPTOUT:'1'}});
let pending='';
function output(data){pending+=data.toString();let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);const secret=/whsec_[A-Za-z0-9]+/.exec(line)?.[0];if(secret){fs.writeFileSync(path.join(dir,'local-webhook-secret'),secret,{mode:0o600});console.log('CLI signing secret saved locally (redacted). Restart the isolated test runner.');}console.log(line.replace(/whsec_[A-Za-z0-9]+/g,'[REDACTED]').replaceAll(env.STRIPE_SECRET_KEY,'[REDACTED]'));}}
child.stdout.on('data',output);child.stderr.on('data',output);
child.on('error',e=>{console.error('Stripe CLI failed:',e.code);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code||0;});
process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
