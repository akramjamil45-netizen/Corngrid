'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const modules=path.resolve(__dirname,'../Corngrid-web/node_modules');
async function main(){
 const env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
 const db=new(require(path.join(modules,'pg')).Client)({connectionString:env.DATABASE_URL,connectionTimeoutMillis:5000,statement_timeout:5000});
 let rows;
 try{await db.connect();await db.query('BEGIN READ ONLY');rows=(await db.query('SELECT id,terms_version,terms_hash,receipt_json,receipt_hash FROM partner_agreements ORDER BY accepted_at DESC LIMIT 200')).rows;await db.query('ROLLBACK');}finally{await db.end();}
 const {agreementText}=require('../Corngrid-web/partner/agreement-text');
 for(const row of rows)agreementText(row);
 if(process.argv.includes('--inspect')){console.log(JSON.stringify({savedRecordsChecked:rows.length,snapshotIntegrityValid:true,databaseModified:false}));return;}
 const version=crypto.createHash('sha256').update(env.ADMIN_EMAIL.trim().toLowerCase()+'\0'+env.ADMIN_PASSWORD_HASH.trim()).digest('hex');
 const token=require(path.join(modules,'jsonwebtoken')).sign({sub:'admin',role:'admin',adminVersion:version},env.JWT_SECRET,{expiresIn:'2m'});
 const results=[];
 for(const origin of ['http://127.0.0.1:3000','https://corngrid.com']){
  const health=await fetch(origin+'/api/health/ready',{signal:AbortSignal.timeout(15000)});assert.equal(health.status,200);
  const html=await(await fetch(origin+'/admin.html',{signal:AbortSignal.timeout(15000)})).text();
  assert.ok(html.includes('admin.js?v=20261115-agreement-text1'));assert.ok(html.includes('admin.css?v=20261115-agreement-text1'));
  if(rows.length){
   const row=rows[0],base=origin+'/api/admin/partner-agreements/'+encodeURIComponent(row.id)+'/file';
   const text=await fetch(base+'?format=txt',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});
   assert.equal(text.status,200);assert.match(text.headers.get('content-type'),/^text\/plain; charset=utf-8/);
   assert.match(text.headers.get('content-disposition'),/attachment;.*\.txt/);assert.equal(text.headers.get('cache-control'),'private, no-store');
   assert.equal(await text.text(),agreementText(row));
   const json=await fetch(base,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(15000)});assert.equal(json.status,200);
   assert.equal(crypto.createHash('sha256').update(await json.text()).digest('hex'),row.receipt_hash);
  }
  results.push({origin,healthy:true,assetsCurrent:true,textMatchesSavedSnapshot:rows.length>0,originalJsonUnchanged:rows.length>0});
 }
 console.log(JSON.stringify({savedRecordsChecked:rows.length,results,databaseModified:false}));
}
main().catch(e=>{console.error('Agreement verification failed:',e.code||e.name);process.exitCode=1;});
