'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.join(__dirname,'..'),source=path.join(root,'Corngrid-web'),target='C:/Website/Website/Corngrid-web';
const files=['account-archive.js','admin-api.js','user-auth.js','login-handler.js','public/admin.html','public/admin.js','migrations/postgres/0010_account_archives.sql','migrations/sqlite/0010_account_archives.sql','docs/ACCOUNT_ARCHIVE.md'];
async function main(){
 const backup=path.join(os.tmpdir(),'CornGrid-account-archive-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(backup,{recursive:true});
 for(const file of files){const old=path.join(target,file);if(fs.existsSync(old)){const save=path.join(backup,file);fs.mkdirSync(path.dirname(save),{recursive:true});fs.copyFileSync(old,save);}}
 const env=require(path.join(source,'node_modules/dotenv')).parse(fs.readFileSync(path.join(target,'.env')));
 const Client=require(path.join(source,'node_modules/pg')).Client,db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{await db.query('BEGIN');await db.query(fs.readFileSync(path.join(source,'migrations/postgres/0010_account_archives.sql'),'utf8'));await db.query('SELECT user_id FROM account_archives LIMIT 0');await db.query('SELECT id FROM account_archive_events LIMIT 0');await db.query('COMMIT');}catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}
 for(const file of files){const from=path.join(source,file),to=path.join(target,file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to);if(crypto.createHash('sha256').update(fs.readFileSync(from)).digest('hex')!==crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex'))throw Error('Hash mismatch: '+file);}
 const result={backup,files:files.length,migration:'0010_account_archives',completedAt:new Date().toISOString()};fs.writeFileSync(path.join(__dirname,'account-archive-deployment-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
main().catch(error=>{console.error('Archive deployment failed:',error.code||'deployment-error');process.exitCode=1;});
