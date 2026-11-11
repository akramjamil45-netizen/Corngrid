'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.join(__dirname,'..'),target='C:/Website/Website';
const source=path.join(root,'Corngrid-web');
const files=['partner/index.js','partner/partner-applications.js','partner/partner-agreements.js','partner/partner-terms.js','public/partner.js','public/dashboard.html','public/dashboard.css','public/admin.html','public/admin.js','public/admin-sandbox.js','migrations/postgres/0009_partner_agreements.sql','migrations/sqlite/0009_partner_agreements.sql','docs/PARTNER_AGREEMENTS.md'];
async function main(){
 const backup=path.join(os.tmpdir(),'CornGrid-partner-agreements-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
 for(const file of files){const old=path.join(target,'Corngrid-web',file);if(fs.existsSync(old)){const to=path.join(backup,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(old,to);}}
 const env=require(path.join(source,'node_modules/dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env')));
 const {Client}=require(path.join(source,'node_modules/pg'));const db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{await db.query('BEGIN');await db.query(fs.readFileSync(path.join(source,'migrations/postgres/0009_partner_agreements.sql'),'utf8'));await db.query('SELECT agreement_id FROM partner_applications LIMIT 1');await db.query('SELECT id,receipt_hash FROM partner_agreements LIMIT 1');await db.query('COMMIT');}
 catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
 for(const file of files){const from=path.join(source,file),to=path.join(target,'Corngrid-web',file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);if(crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex')!==crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex'))throw Error('Hash mismatch: '+file);}
 const result={backup,files:files.length,migration:'0009_partner_agreements',completedAt:new Date().toISOString()};fs.writeFileSync(path.join(__dirname,'partner-agreements-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Agreement deployment failed:',error.code||'deployment-error');process.exitCode=1;});
