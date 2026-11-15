'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../Corngrid-web'),runtime='C:/Website/Website/Corngrid-web';
const files=['server.js','subscriptions/stripe-payments.js','subscriptions/stripe-reconciliation.js','subscriptions/subscription-api.js','public/stripe-checkout.js','public/dashboard.html','docs/STRIPE.md','migrations/postgres/0013_stripe_reconciliation.sql','migrations/sqlite/0013_stripe_reconciliation.sql'];
async function main(){
 for(const file of files)if(!fs.existsSync(path.join(root,file)))throw Error('Required source file missing');
 if(!fs.existsSync(path.join(runtime,'subscriptions/stripe-removal.js')))throw Error('Payment-removal prerequisite is missing');
 const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync(path.join(runtime,'.env')));
 const {Client}=require(path.join(root,'node_modules/pg')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 const backup=path.join(os.tmpdir(),'CornGrid-stripe-recovery-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
 try{
  for(const file of files){const old=path.join(runtime,file);if(fs.existsSync(old)){const saved=path.join(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(old,saved);}}
  await db.query('BEGIN');
  try{await db.query(fs.readFileSync(path.join(root,'migrations/postgres/0013_stripe_reconciliation.sql'),'utf8'));await db.query('SELECT order_id,lease_until,last_error_code FROM stripe_reconciliation LIMIT 0');await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}
  for(const file of files){const from=path.join(root,file),to=path.join(runtime,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);if(crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex')!==crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex'))throw Error('Deployment checksum mismatch');}
  const result={backup,files:files.length,migration:'0013_stripe_reconciliation',restartRequired:true,deployedAt:new Date().toISOString()};
  fs.writeFileSync(path.join(__dirname,'stripe-recovery-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Stripe recovery deployment failed:',error.code||error.name);process.exitCode=1;});
