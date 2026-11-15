'use strict';
// Admin-only, read-only diagnostics. No provider calls, commands, credentials or
// raw database/process errors leave this module. Cache and single-flight keep
// dashboard polling from competing with trading/payment work.
const os=require('node:os'),fs=require('node:fs/promises');
const {dbGet,isPostgres}=require('./db-async');
function bounded(work,ms){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CHECK_TIMEOUT')),ms);Promise.resolve().then(work).then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);reject(Error('CHECK_UNAVAILABLE'));});});}
const number=value=>Number.isFinite(Number(value))?Number(value):null;
function createSystemHealth({db,now=Date.now,statePath=__dirname,nodeOfflineMs=60000,heartbeatTimeoutMs=120000,stripeEnabled=false,stripeWebhookConfigured=false,updateStatus=()=>null,host=os,files=fs,processInfo=process,cacheMs=15000,timeoutMs=1500}={}){
 let cached=null,pending=null;
 function check(id,status,values={},message=null){return {id,status,values,...(message?{message}:{})};}
 async function snapshot(){
  if(cached&&now()-cached.checkedAt<cacheMs)return cached;
  if(pending)return pending;
  pending=collect().then(result=>(cached=result)).finally(()=>{pending=null;});return pending;
 }
 async function collect(){
  const checkedAt=now(),checks=[];
  const memory=processInfo.memoryUsage(),total=host.totalmem(),free=host.freemem();
  const usedPercent=total>0?Math.round((total-free)/total*100):null;
  checks.push(check('backend','ok',{uptimeSeconds:Math.floor(processInfo.uptime()),processMemoryMb:Math.round(memory.rss/1048576)}));
  checks.push(check('memory',usedPercent==null?'unknown':usedPercent>=95?'critical':usedPercent>=90?'warning':'ok',{usedPercent,totalMb:Math.round(total/1048576)}));
  const disk=bounded(()=>files.statfs(statePath),timeoutMs).then(stat=>{const freeMb=Math.floor(Number(stat.bavail)*Number(stat.bsize)/1048576);return check('storage',!Number.isFinite(freeMb)?'unknown':freeMb<512?'critical':freeMb<2048?'warning':'ok',{freeMb:Number.isFinite(freeMb)?freeMb:null});},()=>check('storage','unknown',{},'CHECK_UNAVAILABLE'));
  const started=now();let databaseReady=false;
  try{const row=await bounded(()=>dbGet(db,'SELECT 1 AS ok'),timeoutMs);databaseReady=Number(row?.ok)===1;checks.push(check('database',databaseReady?'ok':'critical',{engine:isPostgres(db)?'postgresql':'sqlite',latencyMs:Math.max(0,now()-started)}));}
  catch{checks.push(check('database','critical',{engine:isPostgres(db)?'postgresql':'sqlite'},'CHECK_UNAVAILABLE'));}
  const source=async(id,work)=>{if(!databaseReady)return check(id,'unknown',{},'DATABASE_UNAVAILABLE');try{return await bounded(work,timeoutMs);}catch{return check(id,'unknown',{},'CHECK_UNAVAILABLE');}};
  const [storage,nodes,sandboxes,mt5,payments,commands]=await Promise.all([disk,
   source('nodes',async()=>{
    const fresh=checkedAt-nodeOfflineMs,latest=checkedAt+60000;
    const row=await dbGet(db,`SELECT COUNT(*) AS total,
     SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
     SUM(CASE WHEN status='active' AND last_heartbeat_at>=? AND last_heartbeat_at<=? THEN 1 ELSE 0 END) AS online,
     SUM(CASE WHEN status='active' AND (last_heartbeat_at IS NULL OR last_heartbeat_at<? OR last_heartbeat_at>?) THEN 1 ELSE 0 END) AS offline,
     SUM(CASE WHEN status='active' AND last_heartbeat_at>=? AND last_heartbeat_at<=? AND (disk_free_mb IS NULL OR ram_mb IS NULL OR ram_mb<=0 OR memory_used_mb IS NULL OR cpu_percent IS NULL OR disk_free_mb<2048 OR (ram_mb>0 AND memory_used_mb*100.0/ram_mb>=90) OR cpu_percent>=90) THEN 1 ELSE 0 END) AS "resourceWarnings"
     FROM sandbox_nodes`,[fresh,latest,fresh,latest,fresh,latest]);
    const values=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,number(v)||0]));return check('nodes',values.offline>0||values.resourceWarnings>0?'warning':'ok',values);
   }),
   source('sandboxes',async()=>{
    const row=await dbGet(db,`SELECT COUNT(*) AS total, SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
     SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
     SUM(CASE WHEN status IN ('deploying','starting','stopping','allocating','requested') AND updated_at<? THEN 1 ELSE 0 END) AS delayed
     FROM sandbox_instances WHERE deleted_at IS NULL`,[checkedAt-10*60000]);
    const values={total:number(row.total)||0,running:number(row.running)||0,failed:number(row.failed)||0,delayed:number(row.delayed)||0};return check('sandboxes',values.failed||values.delayed?'warning':'ok',values);
   }),
   source('mt5',async()=>{
    const row=await dbGet(db,`SELECT COUNT(*) AS linked, SUM(CASE WHEN last_heartbeat>=? AND last_heartbeat<=? THEN 1 ELSE 0 END) AS reporting, MAX(last_heartbeat) AS latest FROM mt5_accounts`,[checkedAt-heartbeatTimeoutMs,checkedAt+60000]);
    // Linked accounts need not be trading: absence of a heartbeat alone is not
    // proof that a running EA failed. Show observed data without guessing.
    return check('mt5','ok',{linked:number(row.linked)||0,reporting:number(row.reporting)||0,lastHeartbeatAt:number(row.latest)});
   }),
   source('payments',async()=>{
    if(!stripeEnabled)return check('payments','disabled',{configured:false});
    const row=await dbGet(db,`SELECT COUNT(*) AS open,
     SUM(CASE WHEN o.status='paid' THEN 1 ELSE 0 END) AS paid,
     SUM(CASE WHEN r.last_error_code IS NOT NULL THEN 1 ELSE 0 END) AS retries,
     MAX(r.last_checked_at) AS latest
     FROM stripe_orders o LEFT JOIN stripe_reconciliation r ON r.order_id=o.id
     JOIN subscription_payments p ON p.id=o.payment_id JOIN user_subscriptions s ON s.id=p.subscription_id
     WHERE o.activated_at IS NULL AND o.status IN ('pending','paid') AND p.status IN ('pending_payment','pending_approval')
     AND s.deleted_at IS NULL AND s.status IN ('pending_payment','pending_approval')
     AND NOT EXISTS(SELECT 1 FROM subscription_payment_archives a WHERE a.payment_id=p.id)`);
    const events=await dbGet(db,'SELECT MAX(processed_at) AS latest FROM stripe_events');
    const values={configured:true,webhookConfigured:stripeWebhookConfigured,openCheckouts:number(row.open)||0,paidAwaitingActivation:number(row.paid)||0,retryOrders:number(row.retries)||0,lastCheckedAt:number(row.latest),lastWebhookAt:number(events.latest)};
    return check('payments',values.paidAwaitingActivation?'critical':!stripeWebhookConfigured||values.retryOrders?'warning':'ok',values);
   }),
   source('commands',async()=>{
    const row=await dbGet(db,`SELECT COUNT(*) AS delayed FROM sandbox_deployments WHERE status IN ('queued','sent','acknowledged') AND created_at<?`,[checkedAt-10*60000]);
    return check('commands',Number(row.delayed)>0?'warning':'ok',{delayed:number(row.delayed)||0});
   })]);
  checks.push(storage,nodes,sandboxes,mt5,payments,commands);
  try{const update=updateStatus();checks.push(check('updates',!update?.configured?'disabled':update.publisher?.error?'warning':'ok',{configured:Boolean(update?.configured),enabled:Boolean(update?.enabled),version:typeof update?.release?.version==='string'?update.release.version.slice(0,32):null}));}catch{checks.push(check('updates','unknown',{},'CHECK_UNAVAILABLE'));}
  const status=checks.some(c=>c.status==='critical')?'critical':checks.some(c=>['warning','unknown'].includes(c.status))?'warning':'ok';
  return {status,checkedAt,refreshAfterMs:cacheMs,checks};
 }
 return {snapshot};
}
function registerSystemHealth(app,{verifyAdminToken,rateLimit,...options}){
 const service=createSystemHealth(options),limit=rateLimit?rateLimit({limit:30,windowMs:60000}):(_req,_res,next)=>next();
 app.get('/api/admin/system-health',verifyAdminToken,limit,async(_req,res)=>{res.set('Cache-Control','private, no-store');try{res.json(await service.snapshot());}catch{res.status(503).json({error:'System diagnostics are temporarily unavailable.'});}});
 return service;
}
module.exports={createSystemHealth,registerSystemHealth};
