'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web'),{Client}=require(path.join(root,'node_modules/pg')),{fixture}=require(path.join(root,'test/helpers/account-deletion-fixture'));
const {dbGet}=require(path.join(root,'db-async')),{changeArchive}=require(path.join(root,'account-archive'));
async function main(){
 const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
 const schema='account_request_check_'+crypto.randomBytes(8).toString('hex'),url=new URL(env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
 const control=new Client({connectionString:env.DATABASE_URL}),dbs=[],apps=[];await control.connect();
 try{
  await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
  for(const name of ['0001_initial.sql','0002_email_verification.sql','0010_account_archives.sql','0017_account_deletion_requests.sql','0017_account_deletion_requests.sql'])await control.query(fs.readFileSync(path.join(root,'migrations/postgres',name),'utf8'));
  for(let i=0;i<2;i++){const db=require(path.join(root,'db-postgres'))(url.toString());dbs.push(db);apps.push(await fixture(null,{database:db,seed:i===0}));}
  const submit=i=>apps[i].request('/api/user/account-deletion-request',{method:'POST',body:{confirm:true,confirmUsername:'Account Owner',reason:'Isolated PG request'}});
  const approve=(i,id)=>apps[i].request('/api/admin/account-deletion-requests/'+id+'/approve',{role:'admin',method:'POST',body:{confirmUsername:'Account Owner'}});
  let result=await Promise.all([submit(0),submit(1)]);assert.deepEqual(result.map(r=>r.status).sort(),[200,201]);const id=result[0].data.request.id;assert.equal(id,result[1].data.request.id);
  result=await Promise.all([approve(0,id),approve(1,id)]);assert.deepEqual(result.map(r=>r.status),[200,200]);assert.equal(result.filter(r=>r.data.alreadyReviewed).length,1);
  assert.equal((await dbGet(dbs[0],'SELECT COUNT(*) AS n FROM account_archive_events')).n,1);assert.equal((await dbGet(dbs[0],'SELECT version FROM user_auth_versions WHERE user_id=1')).version,1);
  await changeArchive(dbs[0],{userId:1,confirmUsername:'Account Owner',restore:true});await Promise.all(apps.map(a=>a.refreshTokens()));assert.equal((await approve(1,id)).data.alreadyReviewed,true);assert.equal(await dbGet(dbs[0],'SELECT * FROM account_archives'),undefined);
  const next=(await submit(0)).data.request.id;
  result=await Promise.all([apps[0].request('/api/user/account-deletion-request/'+next,{method:'DELETE'}),approve(1,next)]);
  const row=await dbGet(dbs[0],'SELECT status FROM account_deletion_requests WHERE id=?',[next]);assert.equal(Boolean(await dbGet(dbs[0],'SELECT * FROM account_archives')),row.status==='approved');assert.equal(result.filter(r=>r.status===200).length,1);
  if(row.status==='approved')await changeArchive(dbs[0],{userId:1,confirmUsername:'Account Owner',restore:true});await Promise.all(apps.map(a=>a.refreshTokens()));
  const retry=(await submit(0)).data.request.id,version=(await dbGet(dbs[0],'SELECT version FROM user_auth_versions WHERE user_id=1')).version;
  await control.query("CREATE FUNCTION fail_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='approved' THEN RAISE EXCEPTION 'Injected audit failure'; END IF; RETURN NEW; END; $$");
  await control.query('CREATE TRIGGER fail_review_audit BEFORE INSERT ON account_deletion_request_events FOR EACH ROW EXECUTE FUNCTION fail_review_audit()');
  assert.equal((await approve(0,retry)).status,500);assert.equal(await dbGet(dbs[0],'SELECT * FROM account_archives'),undefined);assert.equal((await dbGet(dbs[0],'SELECT version FROM user_auth_versions WHERE user_id=1')).version,version);assert.equal((await dbGet(dbs[0],'SELECT status FROM account_deletion_requests WHERE id=?',[retry])).status,'pending');
  await control.query('DROP TRIGGER fail_review_audit ON account_deletion_request_events');assert.equal((await approve(1,retry)).status,200);
  console.log(JSON.stringify({postgresVerified:true,twoPools:true,migrationRepeatSafe:true,onePendingRequest:true,approvalExactlyOnce:true,cancelApprovalRaceSafe:true,restoredAccountNotRearchived:true,auditRollbackAtomic:true,productionAccountsChanged:0}));
 }finally{
  for(const app of apps)await app.close();for(const db of dbs)await new Promise(resolve=>db.close(resolve));
  if(!/^account_request_check_[a-f0-9]{16}$/.test(schema))throw Error('Invalid test schema');await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await control.end();
 }
}
main().catch(error=>{console.error('Account request PostgreSQL check failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
