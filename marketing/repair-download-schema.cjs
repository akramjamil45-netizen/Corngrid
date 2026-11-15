// Apply the additive downloads migration and verify the live DB through its adapter.
const path = require('node:path');
const fs = require('node:fs');
const root = 'C:/Website/Website/Corngrid-web';
require(path.join(root,'node_modules/dotenv')).config({path:path.join(root,'.env'),quiet:true});
const {Client}=require(path.join(root,'node_modules/pg'));
async function main(){
 const client=new Client({connectionString:process.env.DATABASE_URL});
 await client.connect();
 try {
  await client.query('BEGIN');
  await client.query(fs.readFileSync(path.join(__dirname,'../Corngrid-web/migrations/postgres/0007_download_updates.sql'),'utf8'));
  await client.query('COMMIT');
  const row=await client.query('SELECT count(*) AS count FROM download_updates');
  console.log('Downloads migration applied; table readable.');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{await client.end();}
 const db=require(path.join(root,'db-postgres'))(process.env.DATABASE_URL);
 try {
  await new Promise((resolve,reject)=>db.get('SELECT filename,version,length(data) AS size,updated_at,sha256 FROM download_updates WHERE resource_id=?',['setup-guide'],e=>e?reject(e):resolve()));
  console.log('Live PostgreSQL adapter query passed.');
  const express=require(path.join(root,'node_modules/express'));
  const app=express();
  const resources={
   'setup-guide':{file:'Corngrid Setup Guide v1.1.pdf',downloadName:'guide.pdf'},
   'xauusd-v260':{file:'v2.0 set file/xauusd v2.60 set file.set',downloadName:'gold.set'},
   'xauusd-v25':{file:'v2.0 set file/xauusd v2.5 set file.set',downloadName:'gold-legacy.set'},
   'eurusd-m1-v200':{file:'v2.0 set file/eurusd m1 v2.00 set file.set',downloadName:'euro.set'},
   'gbpusd-m1-v200':{file:'v2.0 set file/gbpusd m1 v2.00 set file.set',downloadName:'gbp.set'},
   'usdjpy-m1-v200':{file:'v2.0 set file/usdjpy m1 v2.00 set file.set',downloadName:'yen.set'}
  };
  require('../Corngrid-web/downloads-api')(app,db,(q,s,n)=>n(),(q,s,n)=>n(),resources,path.join(root,'../files'));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  try {
   const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/admin/downloads');
   const data=await response.json();
   if(response.status!==200||data.resources?.length!==6)throw Error('Live database directory check failed');
   console.log('Downloads API with live PostgreSQL: HTTP 200; '+data.resources.length+' resources; '+data.resources.filter(r=>r.available).length+' files available.');
  }finally{await new Promise(resolve=>server.close(resolve));}
 }finally{await new Promise(resolve=>db.close(resolve));}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
