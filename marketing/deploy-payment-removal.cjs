'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const source=path.resolve(__dirname,'../Corngrid-web'),target='C:/Website/Website/Corngrid-web';
const files=['subscriptions/subscription-api.js','subscriptions/stripe-payments.js','subscriptions/stripe-removal.js','public/admin.html','public/admin.js','docs/STRIPE.md','migrations/postgres/0012_payment_request_archives.sql','migrations/sqlite/0012_payment_request_archives.sql'];
async function main(){
 const env=require(path.join(source,'node_modules/dotenv')).parse(fs.readFileSync(path.join(target,'.env')));
 const {Client}=require(path.join(source,'node_modules/pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try {
  if(process.argv.includes('--inspect')) {
   const result=await db.query('SELECT p.id,p.status,p.payment_method,o.status AS stripe_status,(o.paid_at IS NOT NULL) AS stripe_paid,(o.activated_at IS NOT NULL) AS stripe_activated FROM subscription_payments p LEFT JOIN stripe_orders o ON o.payment_id=p.id WHERE p.id=$1',[17]);
   console.log(JSON.stringify({payment:result.rows[0]||null}));return;
  }
  if(process.argv.includes('--verify')) {
   await db.query('SELECT payment_id,archived_at FROM subscription_payment_archives LIMIT 0');
   const jwt=require(path.join(source,'node_modules/jsonwebtoken'));
   const adminVersion=crypto.createHash('sha256').update(`${env.ADMIN_EMAIL.trim().toLowerCase()}\0${env.ADMIN_PASSWORD_HASH.trim()}`).digest('hex');
   const token=jwt.sign({sub:'admin',role:'admin',adminVersion},env.JWT_SECRET,{expiresIn:'2m'});
   const response=await fetch('http://127.0.0.1:3000/api/admin/subscription-payments',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
   if(response.status!==200)throw Error('Admin payments verification failed');
   const data=await response.json();if(!Array.isArray(data.payments))throw Error('Invalid payment list');
   console.log(JSON.stringify({migrationVerified:true,adminPaymentsVerified:true,payment17Visible:data.payments.some(p=>Number(p.id)===17)}));return;
  }
  const backup=path.join(os.tmpdir(),'CornGrid-payment-removal-'+new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup,{recursive:true});
  for(const file of files){const from=path.join(source,file),old=path.join(target,file);if(!fs.existsSync(from))throw Error('Source file missing');if(fs.existsSync(old)){const saved=path.join(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(old,saved);}}
  await db.query('BEGIN');
  try{await db.query(fs.readFileSync(path.join(source,'migrations/postgres/0012_payment_request_archives.sql'),'utf8'));await db.query('SELECT payment_id FROM subscription_payment_archives LIMIT 0');await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}
  for(const file of files){const from=path.join(source,file),to=path.join(target,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);if(crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex')!==crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex'))throw Error('Deployment hash mismatch');}
  const result={backup,files:files.length,migration:'0012_payment_request_archives',restartRequired:true,deployedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(__dirname,'payment-removal-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Payment removal deployment failed:',error.code||error.message);process.exitCode=1;});
