'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const modules=path.resolve(__dirname,'../Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env')),{Client}=require(path.join(modules,'pg'));
async function main(){const db=new Client({connectionString:env.DATABASE_URL});await db.connect();try{
 await db.query('BEGIN READ ONLY');
 const rows=(await db.query("SELECT id,username,email,email_verified,created_at FROM users WHERE username=$1 OR username~'^v[0-9]{13}$' OR username IN ('autotest_user','StripeTest') ORDER BY id",['v1794514182530'])).rows;
 const fks=(await db.query("SELECT c.conrelid::regclass::text AS table_name,a.attname AS column_name FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE c.contype='f' AND c.confrelid='users'::regclass")).rows;
 const result=[];for(const row of rows){const activity=[];for(const fk of fks){assert.match(fk.table_name,/^[a-z_][a-z0-9_]*$/);assert.match(fk.column_name,/^[a-z_][a-z0-9_]*$/);const count=(await db.query('SELECT COUNT(*)::integer AS n FROM '+fk.table_name+' WHERE '+fk.column_name+'=$1',[row.id])).rows[0].n;if(count)activity.push({table:fk.table_name,column:fk.column_name,count});}result.push({id:row.id,username:row.username,emailDomain:row.email.split('@')[1],emailLocalMatchesUsername:row.email.split('@')[0]===row.username,emailVerified:row.email_verified,createdAt:row.created_at,activity});}
 await db.query('ROLLBACK');console.log(JSON.stringify({accounts:result,readOnly:true}));
 }finally{await db.end();}}
main().catch(error=>{console.error('Test account inspection failed:',error.code||error.name);process.exitCode=1;});
