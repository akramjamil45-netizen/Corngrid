'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {dbGet,dbRun,withTransaction,isPostgres}=require('./db-async');
const initializations=new WeakMap();
function ensureArchiveSchema(db){
 if(!initializations.has(db)){
  const task=isPostgres(db)?dbGet(db,'SELECT user_id FROM account_archives LIMIT 0'):new Promise((resolve,reject)=>db.exec(fs.readFileSync(path.join(__dirname,'migrations/sqlite/0010_account_archives.sql'),'utf8'),e=>e?reject(e):resolve()));
  task.catch(()=>console.error('Account archive schema missing; apply migration 0010_account_archives.'));
  initializations.set(db,task);
 }
 return initializations.get(db);
}
async function accountArchived(db,userId){await ensureArchiveSchema(db);return !!await dbGet(db,'SELECT user_id FROM account_archives WHERE user_id=?',[userId]);}
// Internal transaction body, shared by direct admin archive and approval of a
// user request. Its caller must own the surrounding database transaction.
async function changeArchiveInTransaction(db,{userId,confirmUsername,reason,actor='admin',restore=false}){
 await ensureArchiveSchema(db);
  await dbRun(db,'UPDATE users SET id=id WHERE id=?',[userId]);
  const user=await dbGet(db,'SELECT id,username FROM users WHERE id=?',[userId]);
  if(!user)return {http:404,error:'User not found.'};
  if(user.username!==confirmUsername)return {http:400,error:'The username confirmation does not match.'};
  const existing=await dbGet(db,'SELECT archived_at FROM account_archives WHERE user_id=?',[userId]);
  if(restore&&!existing)return {http:409,error:'This account is not archived.'};
  if(!restore&&existing)return {http:200,archived:true,alreadyArchived:true,message:'This account is already archived. All linked data is preserved.'};
  const stamp=Date.now();
  if(restore)await dbRun(db,'DELETE FROM account_archives WHERE user_id=?',[userId]);
  else await dbRun(db,'INSERT INTO account_archives(user_id,archived_at,archived_by,reason) VALUES(?,?,?,?)',[userId,stamp,actor,reason]);
  await dbRun(db,'INSERT INTO user_auth_versions(user_id,version) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET version=user_auth_versions.version+1',[userId]);
  await dbRun(db,'INSERT INTO account_archive_events(id,user_id,username,action,actor,reason,created_at) VALUES(?,?,?,?,?,?,?)',[crypto.randomUUID(),userId,user.username,restore?'restored':'archived',actor,reason,stamp]);
  return {http:200,archived:!restore,message:restore?'Account restored. The user must sign in again. Existing suspension rules still apply.':'Account archived. Login is blocked; EA, presets, customer sandboxes, subscriptions and financial records are preserved.'};
}
async function changeArchive(db,options){
 await ensureArchiveSchema(db);
 return withTransaction(db,()=>changeArchiveInTransaction(db,options));
}
module.exports={ensureArchiveSchema,accountArchived,changeArchive,changeArchiveInTransaction};
