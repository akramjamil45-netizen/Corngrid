'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const modules=path.resolve(__dirname,'../Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env')),{Client}=require(path.join(modules,'pg')),bcrypt=require(path.join(modules,'bcryptjs'));
const username='v1794514182530',email=username+'@t.com';
async function main(){const db=new Client({connectionString:env.DATABASE_URL});await db.connect();try{
 await db.query('BEGIN');
 const rows=(await db.query('SELECT id,password,email_verified,created_at FROM users WHERE username=$1 AND email=$2 FOR UPDATE',[username,email])).rows;
 if(!rows.length){await db.query('ROLLBACK');console.log(JSON.stringify({fixtureAlreadyAbsent:true}));return;}
 assert.equal(rows.length,1);const row=rows[0];assert.equal(row.id,64);assert.equal(row.email_verified,false);assert.ok(Math.abs(Date.parse(row.created_at)-Number(username.slice(1)))<60000);assert.ok(bcrypt.compareSync('TestPass123!',row.password));
 const fks=(await db.query("SELECT c.conrelid::regclass::text AS table_name,a.attname AS column_name FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE c.contype='f' AND c.confrelid='users'::regclass")).rows;
 for(const fk of fks){assert.match(fk.table_name,/^[a-z_][a-z0-9_]*$/);assert.match(fk.column_name,/^[a-z_][a-z0-9_]*$/);const count=(await db.query('SELECT COUNT(*)::integer AS n FROM '+fk.table_name+' WHERE '+fk.column_name+'=$1',[row.id])).rows[0].n;if(!['email_verification_codes','password_reset_tokens','user_auth_versions'].includes(fk.table_name))assert.equal(count,0,'Fixture has linked activity in '+fk.table_name);}
 const removed=await db.query('DELETE FROM users WHERE id=$1 AND username=$2 AND email=$3 AND email_verified=FALSE',[row.id,username,email]);assert.equal(removed.rowCount,1);
 await db.query('DELETE FROM email_verification_requests WHERE email=$1 AND created_at BETWEEN $2 AND $3',[email,Number(username.slice(1))-60000,Number(username.slice(1))+60000]);
 await db.query('COMMIT');console.log(JSON.stringify({removedUsername:username,fixtureAccountRemoved:true,realUserAccountsChanged:0,linkedBusinessActivity:0}));
 }catch(error){await db.query('ROLLBACK');throw error;}finally{await db.end();}}
main().catch(error=>{console.error('Verification fixture cleanup failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
