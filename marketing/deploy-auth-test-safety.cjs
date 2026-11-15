'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'..'),target=path.resolve('C:/Website/Website'),files=['Corngrid-web/verify-test.js','Corngrid-web/test-auth-flows.js','Corngrid-web/scripts/run-auth-regressions.js'];
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function resolveFile(root,file){const absolute=path.resolve(root,file),relative=path.relative(root,absolute);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));return absolute;}
async function main(){
 if(!process.argv.includes('--verify')){const backup=fs.mkdtempSync(path.join(os.tmpdir(),'CornGrid-auth-test-safety-before-'));for(const file of files){const destination=resolveFile(target,file);if(fs.existsSync(destination)){const saved=resolveFile(backup,file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.copyFileSync(destination,saved);}fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(resolveFile(source,file),destination);}console.log(JSON.stringify({backup,copiedFiles:files.length,restartRequired:false}));return;}
 for(const file of files)assert.equal(hash(fs.readFileSync(resolveFile(source,file))),hash(fs.readFileSync(resolveFile(target,file))),file);
 const modules=path.join(source,'Corngrid-web/node_modules'),env=require(path.join(modules,'dotenv')).parse(fs.readFileSync(path.join(target,'Corngrid-web/.env'))),{Client}=require(path.join(modules,'pg')),jwt=require(path.join(modules,'jsonwebtoken')),db=new Client({connectionString:env.DATABASE_URL});await db.connect();
 try{
  await db.query('BEGIN READ ONLY');const fixtures=(await db.query('SELECT COUNT(*)::integer AS n FROM users WHERE username=ANY($1::text[])',[['v1794514182530','autotest_user']])).rows[0].n;assert.equal(fixtures,0);
  const user=(await db.query('SELECT u.id,COALESCE(v.version,0) AS auth_version FROM users u LEFT JOIN user_auth_versions v ON v.user_id=u.id LEFT JOIN account_archives a ON a.user_id=u.id WHERE a.user_id IS NULL AND u.email_verified=TRUE ORDER BY u.id LIMIT 1')).rows[0];assert.ok(user);
  const token=jwt.sign({id:user.id,authVersion:Number(user.auth_version)},env.JWT_SECRET,{expiresIn:'2m'});
  const response=await fetch('https://corngrid.com/api/chat/users?search=v1794514182530',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});assert.equal(response.status,200);assert.equal((await response.json()).users.length,0);
  const health=await fetch('http://127.0.0.1:3000/api/health/ready',{signal:AbortSignal.timeout(10000)});assert.equal(health.status,200);
  await db.query('ROLLBACK');console.log(JSON.stringify({verified:true,matchingFiles:files.length,knownFixtureAccountsRemaining:0,liveChatSearchReturnsFixture:false,readiness:200,productionWritesDuringVerification:0}));
 }finally{await db.end();}
}
main().catch(error=>{console.error('Auth test safety deployment failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
