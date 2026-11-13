'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./helpers/account-deletion-fixture'),{dbGet,dbRun}=require('../db-async'),{changeArchive}=require('../account-archive');
const userRoute='/api/user/account-deletion-request',adminRoute='/api/admin/account-deletion-requests';
const submit=(f,extra={})=>f.request(userRoute,{method:'POST',body:{confirm:true,confirmUsername:'Account Owner',reason:'I want to close my account.',...extra}});
const review=(f,id,action='approve',body={confirmUsername:'Account Owner'})=>f.request(adminRoute+'/'+id+'/'+action,{role:'admin',method:'POST',body});

test('a user request remains pending until admin approval archives the account and revokes login once',async t=>{
 const f=await fixture(t);
 await dbRun(f.db,'CREATE TABLE retained_records(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),kind TEXT,value TEXT)');
 for(const kind of ['published EA','preset','customer sandbox','subscription','commission','agreement'])await dbRun(f.db,'INSERT INTO retained_records(user_id,kind,value) VALUES(1,?,?)',[kind,'original']);
 const sent=await submit(f);assert.equal(sent.status,201);const id=sent.data.request.id;
 assert.equal(sent.data.request.status,'pending');assert.equal(await dbGet(f.db,'SELECT * FROM account_archives'),undefined);
 assert.equal((await f.request(userRoute)).status,200);assert.equal((await f.request(adminRoute,{role:'admin'})).data.pendingCount,1);
 assert.equal((await review(f,id,'approve',{confirmUsername:'wrong'})).status,400);assert.equal((await review(f,id)).status,200);
 assert.equal((await f.request(userRoute)).data.code,'ACCOUNT_ARCHIVED');assert.equal((await f.request(userRoute,{role:2})).status,200);
 const login=await f.request('/login',{role:null,method:'POST',body:{email:'account1@example.test',password:'fixture-password'}});assert.equal(login.status,403);assert.equal(login.data.code,'ACCOUNT_ARCHIVED');
 assert.equal((await dbGet(f.db,'SELECT version FROM user_auth_versions WHERE user_id=1')).version,1);
 assert.equal((await review(f,id)).data.alreadyReviewed,true);assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM account_archive_events')).n,1);
 assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM account_deletion_request_events WHERE action='approved'")).n,1);
 assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM retained_records WHERE value='original'")).n,6);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM users')).n,2);
});
test('duplicate concurrent submissions converge on one pending request and confirmation cannot be bypassed',async t=>{
 const f=await fixture(t);
 for(const extra of [{confirm:false},{confirmUsername:'wrong'},{reason:'x'.repeat(1001)}])assert.equal((await submit(f,extra)).status,400);
 const results=await Promise.all([submit(f),submit(f)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].data.request.id,results[1].data.request.id);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM account_deletion_requests')).n,1);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM account_deletion_request_events')).n,1);
 assert.equal((await f.request(userRoute)).data.canRequest,false);
});
test('ownership, admin roles and cookie CSRF checks protect requests and approval',async t=>{
 const f=await fixture(t),id=(await submit(f)).data.request.id;
 assert.equal((await f.request(userRoute,{role:null})).status,401);
 assert.equal((await f.request(adminRoute)).status,403);
 assert.equal((await f.request(adminRoute+'/'+id+'/approve',{method:'POST',body:{confirmUsername:'Account Owner'}})).status,403);
 assert.equal((await f.request(userRoute+'/'+id,{role:2,method:'DELETE'})).status,404);
 assert.equal((await f.request(userRoute,{role:2})).data.request,null);
 assert.equal((await f.request(userRoute,{role:null,method:'POST',headers:{Cookie:'corngrid_session='+f.tokens[1],Origin:'https://untrusted.example'},body:{confirm:true,confirmUsername:'Account Owner'}})).status,403);
 assert.equal((await f.request(adminRoute+'/'+id+'/approve',{role:null,method:'POST',headers:{Cookie:'corngrid_session='+f.tokens.admin,Origin:'https://untrusted.example'},body:{confirmUsername:'Account Owner'}})).status,403);
 const forged=await f.request(userRoute,{role:2,method:'POST',body:{confirm:true,confirmUsername:'Other User',userId:1,status:'approved'}});assert.equal(forged.status,201);assert.equal((await dbGet(f.db,'SELECT user_id FROM account_deletion_requests WHERE id=?',[forged.data.request.id])).user_id,2);assert.equal(await dbGet(f.db,'SELECT * FROM account_archives'),undefined);
});
test('user cancellation and admin rejection preserve access and allow a new request',async t=>{
 const f=await fixture(t);let id=(await submit(f)).data.request.id;
 assert.equal((await f.request(userRoute+'/'+id,{method:'DELETE'})).status,200);assert.equal((await f.request(userRoute+'/'+id,{method:'DELETE'})).data.alreadyCancelled,true);
 assert.equal((await review(f,id)).status,409);assert.equal((await f.request(userRoute)).data.canRequest,true);
 id=(await submit(f)).data.request.id;
 assert.equal((await review(f,id,'reject',{note:'no'})).status,400);
 assert.equal((await review(f,id,'reject',{note:'Please resolve the account details first.'})).status,200);
 assert.equal((await review(f,id)).status,409);assert.equal((await f.request(userRoute)).data.request.status,'rejected');assert.equal(await dbGet(f.db,'SELECT * FROM account_archives'),undefined);
 assert.equal((await submit(f)).status,201);assert.equal((await f.request(adminRoute+'?status=rejected',{role:'admin'})).data.total,1);
});
test('concurrent cancel and approve cannot leave a cancelled request with an archived account',async t=>{
 const f=await fixture(t),id=(await submit(f)).data.request.id;
 const results=await Promise.all([f.request(userRoute+'/'+id,{method:'DELETE'}),review(f,id)]);
 const request=await dbGet(f.db,'SELECT status FROM account_deletion_requests WHERE id=?',[id]),archive=await dbGet(f.db,'SELECT * FROM account_archives WHERE user_id=1');
 assert.ok(['approved','cancelled'].includes(request.status));assert.equal(Boolean(archive),request.status==='approved');assert.equal(results.filter(r=>r.status===200).length,1);
});
test('approval and submission audit failures roll back the request, archive marker and session revocation together',async t=>{
 const f=await fixture(t);
 await dbRun(f.db,"CREATE TRIGGER fail_request_audit BEFORE INSERT ON account_deletion_request_events BEGIN SELECT RAISE(ABORT,'Injected request audit failure'); END");
 assert.equal((await submit(f)).status,500);assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM account_deletion_requests')).n,0);await dbRun(f.db,'DROP TRIGGER fail_request_audit');
 const id=(await submit(f)).data.request.id;
 await dbRun(f.db,"CREATE TRIGGER fail_request_review BEFORE INSERT ON account_deletion_request_events WHEN NEW.action='approved' BEGIN SELECT RAISE(ABORT,'Injected review audit failure'); END");
 assert.equal((await review(f,id)).status,500);assert.equal(await dbGet(f.db,'SELECT * FROM account_archives'),undefined);assert.equal(await dbGet(f.db,'SELECT * FROM user_auth_versions WHERE user_id=1'),undefined);
 assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM account_archive_events')).n,0);assert.equal((await f.request(userRoute)).data.request.status,'pending');
 await dbRun(f.db,'DROP TRIGGER fail_request_review');assert.equal((await review(f,id)).status,200);
});
test('replaying an old approved request never re-archives a restored account',async t=>{
 const f=await fixture(t),id=(await submit(f)).data.request.id;assert.equal((await review(f,id)).status,200);
 assert.equal((await changeArchive(f.db,{userId:1,confirmUsername:'Account Owner',restore:true})).http,200);await f.refreshTokens();
 assert.equal((await review(f,id)).data.alreadyReviewed,true);assert.equal(await dbGet(f.db,'SELECT * FROM account_archives'),undefined);
 assert.equal((await f.request(userRoute)).data.canRequest,true);assert.equal((await dbGet(f.db,'SELECT version FROM user_auth_versions WHERE user_id=1')).version,2);
 assert.equal((await submit(f)).status,201);
});
