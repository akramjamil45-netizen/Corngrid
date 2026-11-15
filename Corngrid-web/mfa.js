'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {dbGet,dbRun,withTransaction,isPostgres}=require('./db-async');
const {createSandboxCrypto}=require('./sandbox/sandbox-crypto');
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode32(value){let bits=0,acc=0,out=[];for(const character of value){const n=alphabet.indexOf(character);if(n<0)throw Error('INVALID_TOTP_SECRET');acc=(acc<<5)|n;bits+=5;if(bits>=8){out.push((acc>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
function totp(secret,step,digits=6){const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));const digest=crypto.createHmac('sha1',decode32(secret)).update(counter).digest(),offset=digest.at(-1)&15;return String((digest.readUInt32BE(offset)&0x7fffffff)%10**digits).padStart(digits,'0');}
function matchingStep(secret,code,now,last=-1){if(!/^\d{6}$/.test(String(code)))return null;const current=Math.floor(now/30000);for(const step of [current,current-1])if(step>=0&&step>last&&crypto.timingSafeEqual(Buffer.from(totp(secret,step)),Buffer.from(String(code))))return step;return null;}
const failure=code=>Object.assign(Error(code),{code});
const recoveryHash=(subject,code)=>crypto.createHash('sha256').update(subject+'\0'+String(code).replace(/-/g,'').toLowerCase()).digest('hex');
function createMfa({db,encryptionKey,now=Date.now}={}){
 const cipher=createSandboxCrypto({encryptionKey:encryptionKey||process.env.MFA_ENCRYPTION_KEY||process.env.SANDBOX_ENCRYPTION_KEY});
 let initialization;
 function ready(){if(!initialization)initialization=isPostgres(db)?dbGet(db,'SELECT subject FROM auth_factors LIMIT 1'):new Promise((resolve,reject)=>db.exec(fs.readFileSync(path.join(__dirname,'migrations/sqlite/0019_auth_factors.sql'),'utf8'),error=>error?reject(error):resolve()));return initialization;}
 const read=(subject,lock=false)=>dbGet(db,'SELECT * FROM auth_factors WHERE subject=?'+(lock&&isPostgres(db)?' FOR UPDATE':''),[subject]);
 const audit=(subject,action)=>dbRun(db,'INSERT INTO auth_factor_events(subject,action,created_at) VALUES(?,?,?)',[subject,action,now()]);
 async function state(subject){await ready();const row=await read(subject);return {enabled:row?.enabled===1,version:Number(row?.version)||0,recoveryRemaining:row?.enabled===1?JSON.parse(row.recovery_json).length:0};}
 async function sessionValid(subject,claims){return (Number(claims?.mfaVersion)||0)===(await state(subject)).version;}
 async function setup(subject,label){
  await ready();if(cipher.ephemeral)throw failure('MFA_KEY_REQUIRED');const secret=base32(crypto.randomBytes(20));
  await withTransaction(db,async()=>{
   await dbRun(db,'INSERT INTO auth_factors(subject,updated_at) VALUES(?,?) ON CONFLICT(subject) DO NOTHING',[subject,now()]);const row=await read(subject,true);if(row.enabled===1)throw failure('MFA_ALREADY_ENABLED');
   await dbRun(db,'UPDATE auth_factors SET pending_cipher=?,pending_until=?,failures=0,blocked_until=0,updated_at=? WHERE subject=?',[cipher.encrypt(secret),now()+600000,now(),subject]);await audit(subject,'setup_started');
  });
  return {secret,uri:'otpauth://totp/'+encodeURIComponent('CornGrid:'+label)+'?secret='+secret+'&issuer=CornGrid&algorithm=SHA1&digits=6&period=30',expiresAt:now()+600000};
 }
 async function verify(subject,code,{enroll=false}={}){
  await ready();const result=await withTransaction(db,async()=>{
   const row=await read(subject,true);
   if(!enroll&&(!row||row.enabled!==1))return {version:Number(row?.version)||0};
   if(!row||enroll&&(row.enabled===1||!row.pending_cipher||row.pending_until<=now()))return {error:'MFA_SETUP_EXPIRED'};
   if(row.blocked_until>now())return {error:'MFA_RATE_LIMITED'};
   const secret=cipher.decrypt(enroll?row.pending_cipher:row.secret_cipher);if(!secret)return {error:'MFA_UNAVAILABLE'};
   const step=matchingStep(secret,code,now(),enroll?-1:Number(row.last_step));
   let recovery=JSON.parse(row.recovery_json),index=-1;
   if(!enroll&&/^[a-fA-F0-9-]{16,19}$/.test(String(code||'')))index=recovery.indexOf(recoveryHash(subject,code));
   if(step===null&&index<0){
    if(!code)return {error:'MFA_REQUIRED'};
    const failures=(Number(row.blocked_until)>0&&Number(row.blocked_until)<=now()?0:Number(row.failures))+1;
    await dbRun(db,'UPDATE auth_factors SET failures=?,blocked_until=?,updated_at=? WHERE subject=?',[failures,failures>=5?now()+300000:0,now(),subject]);return {error:failures>=5?'MFA_RATE_LIMITED':'MFA_INVALID'};
   }
   if(enroll){
    const codes=Array.from({length:8},()=>crypto.randomBytes(8).toString('hex'));
    const version=Number(row.version)+1;
    await dbRun(db,`UPDATE auth_factors SET secret_cipher=pending_cipher,pending_cipher=NULL,pending_until=0,enabled=1,version=?,last_step=?,failures=0,blocked_until=0,recovery_json=?,updated_at=? WHERE subject=?`,[version,step,JSON.stringify(codes.map(code=>recoveryHash(subject,code))),now(),subject]);await audit(subject,'enabled');return {version,recoveryCodes:codes};
   }
   if(index>=0)recovery.splice(index,1);
   await dbRun(db,'UPDATE auth_factors SET last_step=?,recovery_json=?,failures=0,blocked_until=0,updated_at=? WHERE subject=?',[step===null?row.last_step:step,JSON.stringify(recovery),now(),subject]);
   if(index>=0)await audit(subject,'recovery_used');return {version:Number(row.version)||0};
  });
  if(result.error)throw failure(result.error);return result;
 }
 async function disable(subject,code){
  const proof=await verify(subject,code);
  return withTransaction(db,async()=>{const row=await read(subject,true);if(!row||row.enabled!==1)return {version:Number(row?.version)||0};if(Number(row.version)!==proof.version)throw failure('MFA_INVALID');const version=Number(row.version)+1;await dbRun(db,`UPDATE auth_factors SET enabled=0,secret_cipher=NULL,pending_cipher=NULL,pending_until=0,recovery_json='[]',last_step=-1,version=?,updated_at=? WHERE subject=?`,[version,now(),subject]);await audit(subject,'disabled');return {version};});
 }
 return {ready,state,sessionValid,setup,authenticate:verify,confirm:(subject,code)=>verify(subject,code,{enroll:true}),disable};
}
module.exports={createMfa,base32,totp,matchingStep,recoveryHash};
