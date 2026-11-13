'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {dbGet,dbAll,dbRun,withTransaction,isPostgres}=require('./db-async');
const {ensureArchiveSchema,changeArchiveInTransaction}=require('./account-archive');
const fail=(message,status=400,code='INVALID_REQUEST')=>{throw Object.assign(Error(message),{status,code});};
function text(value,field,max=1000){if(value==null)return '';if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`Enter a valid ${field}, up to ${max} characters.`);return value.trim();}
function shape(row){return row?{id:row.id,status:row.status,reason:row.reason,requestedUsername:row.requested_username,requestedAt:Number(row.requested_at),reviewedAt:row.reviewed_at==null?null:Number(row.reviewed_at),reviewNote:row.review_note}:null;}
function registerAccountDeletion(app,db,{verifyToken,verifyAdminToken,rateLimit}){
 const get=(s,p)=>dbGet(db,s,p),all=(s,p)=>dbAll(db,s,p),run=(s,p)=>dbRun(db,s,p),lock=isPostgres(db)?' FOR UPDATE':'';
 const ready=(async()=>{await ensureArchiveSchema(db);if(isPostgres(db))await get('SELECT id FROM account_deletion_requests LIMIT 0');else{const sql=await fs.readFile(path.join(__dirname,'migrations/sqlite/0017_account_deletion_requests.sql'),'utf8');await new Promise((resolve,reject)=>db.exec(sql,e=>e?reject(e):resolve()));}})();ready.catch(()=>{});
 const mutation=rateLimit({limit:12,windowMs:3600000}),reviewLimit=rateLimit({limit:120,windowMs:60000});
 const wrap=handler=>async(req,res)=>{try{await ready;await handler(req,res);}catch(error){if(error.status)return res.status(error.status).json({error:error.message,code:error.code});console.error('Account request operation failed:',error.code||error.name);res.status(500).json({error:'Unable to update the account request. Please retry.'});}};
 async function userLock(userId){const user=await get('SELECT id,username FROM users WHERE id=?'+lock,[userId]);if(!user)fail('Account not found.',404);return user;}
 async function event(requestId,role,actorId,action,note=''){await run('INSERT INTO account_deletion_request_events(id,request_id,actor_role,actor_id,action,note,created_at) VALUES(?,?,?,?,?,?,?)',[crypto.randomUUID(),requestId,role,String(actorId),action,note,Date.now()]);}
 function validId(id){if(!/^[a-f0-9-]{36}$/i.test(id||''))fail('Invalid account request.',400);return id;}
 app.get('/api/user/account-deletion-request',verifyToken,wrap(async(req,res)=>{
  const user=await get('SELECT username FROM users WHERE id=?',[req.user.id]);
  const request=await get('SELECT * FROM account_deletion_requests WHERE user_id=? ORDER BY requested_at DESC,id DESC LIMIT 1',[req.user.id]);
  res.json({username:user.username,request:shape(request),canRequest:request?.status!=='pending'});
 }));
 app.post('/api/user/account-deletion-request',verifyToken,mutation,wrap(async(req,res)=>{
  if(req.body?.confirm!==true)fail('Confirm that administrator approval will archive your account.');
  const reason=text(req.body?.reason,'reason');
  const result=await withTransaction(db,async()=>{
   const user=await userLock(req.user.id);
   if(await get('SELECT user_id FROM account_archives WHERE user_id=?',[user.id]))fail('This account is already archived.',403,'ACCOUNT_ARCHIVED');
   if(req.body?.confirmUsername!==user.username)fail('Type your current display name exactly to confirm the request.');
   const previous=await get("SELECT * FROM account_deletion_requests WHERE user_id=? AND status='pending'",[user.id]);
   if(previous)return {request:shape(previous),alreadyRequested:true};
   const id=crypto.randomUUID(),stamp=Date.now();
   await run("INSERT INTO account_deletion_requests(id,user_id,requested_username,reason,requested_at) VALUES(?,?,?,?,?)",[id,user.id,user.username,reason,stamp]);
   await event(id,'user',user.id,'submitted',reason);
   return {request:shape(await get('SELECT * FROM account_deletion_requests WHERE id=?',[id])),alreadyRequested:false};
  });
  res.status(result.alreadyRequested?200:201).json({...result,message:'Request sent. Your account remains active until administrator approval.'});
 }));
 app.delete('/api/user/account-deletion-request/:id',verifyToken,mutation,wrap(async(req,res)=>{
  const id=validId(req.params.id);
  const result=await withTransaction(db,async()=>{
   await userLock(req.user.id);
   const request=await get('SELECT * FROM account_deletion_requests WHERE id=? AND user_id=?'+lock,[id,req.user.id]);
   if(!request)fail('Account request not found.',404);
   if(request.status==='cancelled')return {alreadyCancelled:true};
   if(request.status!=='pending')fail('This request has already been reviewed and cannot be cancelled.',409);
   await run("UPDATE account_deletion_requests SET status='cancelled',reviewed_at=?,reviewed_by=? WHERE id=?",[Date.now(),'user:'+req.user.id,id]);
   await event(id,'user',req.user.id,'cancelled');return {alreadyCancelled:false};
  });res.json({...result,message:'Your account deletion request was cancelled.'});
 }));
 app.get('/api/admin/account-deletion-requests',verifyAdminToken,wrap(async(req,res)=>{
  const status=req.query.status||'pending';if(!['pending','approved','rejected','cancelled','all'].includes(status))fail('Choose a valid request status.');
  const page=Number(req.query.page||1);if(!Number.isSafeInteger(page)||page<1||page>100000)fail('Invalid page.');
  const where=status==='all'?'':'WHERE r.status=?',params=status==='all'?[]:[status],limit=20;
  const count=await get(`SELECT COUNT(*) AS total FROM account_deletion_requests r ${where}`,params);
  const pending=await get("SELECT COUNT(*) AS total FROM account_deletion_requests WHERE status='pending'");
  const rows=await all(`SELECT r.*,u.username,u.email,a.archived_at FROM account_deletion_requests r JOIN users u ON u.id=r.user_id LEFT JOIN account_archives a ON a.user_id=r.user_id ${where} ORDER BY r.requested_at DESC,r.id DESC LIMIT ? OFFSET ?`,[...params,limit,(page-1)*limit]);
  res.json({requests:rows.map(row=>({...shape(row),userId:row.user_id,username:row.username,email:row.email,isArchived:row.archived_at!=null})),pendingCount:Number(pending.total),page,total:Number(count.total),pages:Math.ceil(Number(count.total)/limit)});
 }));
 async function review(req,res,decision){
  const id=validId(req.params.id),note=text(req.body?.note,'review note');
  if(decision==='rejected'&&note.length<5)fail('Add a rejection reason of at least 5 characters.');
  const target=await get('SELECT user_id FROM account_deletion_requests WHERE id=?',[id]);if(!target)fail('Account request not found.',404);
  const result=await withTransaction(db,async()=>{
   const user=await userLock(target.user_id);
   const request=await get('SELECT * FROM account_deletion_requests WHERE id=?'+lock,[id]);
   if(decision==='approved'&&req.body?.confirmUsername!==user.username)fail('The username confirmation does not match. Refresh the request and try again.');
   if(request.status===decision)return {alreadyReviewed:true};
   if(request.status!=='pending')fail('This request was cancelled or reviewed. Refresh the list.',409);
   const actor=String(req.admin?.id||'admin');
   if(decision==='approved'){
    const archived=await changeArchiveInTransaction(db,{userId:user.id,confirmUsername:user.username,actor,reason:('User-requested account closure ('+id+'). '+note).slice(0,500)});
    if(archived.http!==200)fail(archived.error,archived.http);
   }
   await run('UPDATE account_deletion_requests SET status=?,reviewed_at=?,reviewed_by=?,review_note=? WHERE id=?',[decision,Date.now(),actor,note,id]);
   await event(id,'admin',actor,decision,note);return {alreadyReviewed:false};
  });res.json({...result,status:decision,message:decision==='approved'?'Request approved. The account is archived; existing trading and records are preserved.':'Request rejected. The account remains accessible.'});
 }
 app.post('/api/admin/account-deletion-requests/:id/approve',verifyAdminToken,reviewLimit,wrap((req,res)=>review(req,res,'approved')));
 app.post('/api/admin/account-deletion-requests/:id/reject',verifyAdminToken,reviewLimit,wrap((req,res)=>review(req,res,'rejected')));
 return {ready};
}
module.exports=registerAccountDeletion;
