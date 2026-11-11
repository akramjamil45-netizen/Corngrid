'use strict';
// Explicit production deployment. Never prints credentials or creates a charge.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..'),source=path.join(root,'Corngrid-web');
const destination='C:/Website/Website',target=path.join(destination,'Corngrid-web');
const dotenv=require(path.join(source,'node_modules/dotenv'));
const {Client}=require(path.join(source,'node_modules/pg'));
const crypto=require('node:crypto');
const files=['Corngrid-web/package.json','Corngrid-web/package-lock.json','Corngrid-web/server.js','Corngrid-web/db-router.js','Corngrid-web/subscriptions/subscription-api.js','Corngrid-web/subscriptions/stripe-payments.js','Corngrid-web/subscriptions/stripe-client.js','Corngrid-web/migrations/postgres/0008_stripe.sql','Corngrid-web/migrations/sqlite/0008_stripe.sql','Corngrid-web/public/stripe-checkout.js','Corngrid-web/public/dashboard.html','Corngrid-web/public/dashboard.js','Corngrid-web/public/dashboard.css','Corngrid-web/public/admin.html','Corngrid-web/public/admin.js'];
async function main(){
 const config=dotenv.parse(fs.readFileSync(path.join(source,'.env')));
 const existing=dotenv.parse(fs.readFileSync(path.join(target,'.env')));
 if(!/^(sk|rk)_live_/.test(config.STRIPE_SECRET_KEY||''))throw Error('A live Stripe key is required for this deployment.');
 if(!/^whsec_/.test(config.STRIPE_WEBHOOK_SECRET||''))throw Error('Webhook signing secret is missing.');
 if(config.APP_BASE_URL!=='https://corngrid.com')throw Error('Unexpected APP_BASE_URL.');
 if(!existing.DATABASE_URL)throw Error('Expected production PostgreSQL.');
 const backup=path.join(os.tmpdir(),'CornGrid-stripe-live-'+new Date().toISOString().replace(/[:.]/g,'-'));
 fs.mkdirSync(backup,{recursive:true});
 for(const name of [...files,'web.config','web.config.xml','Corngrid-web/.env']){
  const old=path.join(destination,name);if(fs.existsSync(old)){const save=path.join(backup,name);fs.mkdirSync(path.dirname(save),{recursive:true});fs.copyFileSync(old,save);}
 }
 fs.writeFileSync(path.join(__dirname,'stripe-deployment-result.json'),JSON.stringify({phase:'backed_up',backup},null,2));
 const client=new Client({connectionString:existing.DATABASE_URL});await client.connect();
 try{
  await client.query('BEGIN');
  await client.query(fs.readFileSync(path.join(source,'migrations/postgres/0008_stripe.sql'),'utf8'));
  await client.query('SELECT id FROM stripe_orders LIMIT 1');
  await client.query('SELECT id FROM stripe_events LIMIT 1');
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}
 console.log('Additive PostgreSQL Stripe migration applied.');
 for(const name of files){const from=path.join(root,name),to=path.join(destination,name);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);if(crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex')!==crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex'))throw Error('Hash mismatch: '+name);}
 for(const name of ['web.config','web.config.xml']){
  const file=path.join(destination,name);if(!fs.existsSync(file))continue;let text=fs.readFileSync(file,'utf8');
  if(!text.includes('stripe-checkout\\.js')){const updated=text.replace('feed\\.js|','feed\\.js|stripe-checkout\\.js|');if(updated===text)throw Error('Unable to find proxy allowlist in '+name);text=updated;fs.writeFileSync(file,text);}
 }
 let envText=fs.readFileSync(path.join(target,'.env'),'utf8');
 for(const name of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','APP_BASE_URL','STRIPE_PAYMENT_METHOD_CONFIGURATION']){
  const value=config[name]||'';if(/[\r\n"]/.test(value))throw Error('Invalid environment value for '+name);
  const line=name+'="'+value+'"';const pattern=new RegExp('^'+name+'=.*$','m');envText=pattern.test(envText)?envText.replace(pattern,()=>line):envText.trimEnd()+'\n'+line+'\n';
 }
 fs.writeFileSync(path.join(target,'.env'),envText);
 // Install only missing/mismatched dependencies. Preserve existing native SQLite build.
 execFileSync('cmd.exe',['/d','/s','/c','npm.cmd install --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:target,stdio:'inherit',windowsHide:true});
 execFileSync(process.execPath,['-e',"require('stripe');require('sqlite3');require('./subscriptions/stripe-payments');console.log('Production dependency imports passed.')"],{cwd:target,stdio:'inherit',windowsHide:true});
 const result={phase:'deployed',backup,files:files.length,production:target,completedAt:new Date().toISOString()};
 fs.writeFileSync(path.join(__dirname,'stripe-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(e=>{console.error('Stripe deployment failed:',String(e.message).replace(/(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+/g,'[REDACTED]'));process.exitCode=1;});
