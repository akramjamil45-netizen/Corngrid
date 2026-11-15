'use strict';
const jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const {dbGet}=require('./db-async');
const {readAuthCredential,setAuthCookie}=require('./session-cookie');
const messages={MFA_REQUIRED:'Enter your authenticator code or an unused recovery code.',MFA_INVALID:'Invalid or previously used code. Wait for the next authenticator code or use an unused recovery code.',MFA_RATE_LIMITED:'Too many attempts. Wait five minutes before trying again.',MFA_SETUP_EXPIRED:'Setup expired. Start setup again.',MFA_ALREADY_ENABLED:'Two-factor authentication is already enabled.',MFA_KEY_REQUIRED:'Persistent MFA encryption must be configured before enrollment.'};
function registerMfaApi(app,{db,mfa,adminAuth,verifyToken,jwtSecret,rateLimit}){
 const limiter=rateLimit({limit:20,windowMs:300000});
 const subject=req=>req.admin?adminAuth.mfaSubject:'user:'+req.user.id;
 function authorized(req,res,next){if(req.path.startsWith('/api/admin/'))return adminAuth.verifyToken(req,res,next);return verifyToken(req,res,next);}
 async function eligible(req){if(req.admin)return true;return (await dbGet(db,"SELECT status FROM partner_profiles WHERE user_id=?",[req.user.id]))?.status==='active';}
 async function passwordValid(req,password){if(typeof password!=='string'||Buffer.byteLength(password)>72)return false;if(req.admin)return adminAuth.checkPassword(password);const row=await dbGet(db,'SELECT password FROM users WHERE id=?',[req.user.id]);return !!row&&await bcrypt.compare(password,row.password);}
 function renew(req,res,version){const credential=readAuthCredential(req),claims=jwt.verify(credential.token,jwtSecret),expiry=claims.exp;delete claims.iat;delete claims.exp;delete claims.nbf;const seconds=Number.isFinite(expiry)?Math.max(1,Math.min(86400,expiry-Math.floor(Date.now()/1000))):86400;const token=jwt.sign({...claims,mfaVersion:version},jwtSecret,{expiresIn:seconds});setAuthCookie(res,token,req,seconds*1000);return token;}
 const endpoint=handler=>async(req,res)=>{res.set('Cache-Control','private, no-store');try{await handler(req,res);}catch(error){const known=messages[error.code];res.status(error.code==='MFA_RATE_LIMITED'?429:known?400:503).json({error:known||'Security settings are temporarily unavailable.',code:known?error.code:'MFA_UNAVAILABLE'});}};
 for(const prefix of ['/api/admin/security/mfa','/api/security/mfa']){
  app.get(prefix,authorized,endpoint(async(req,res)=>res.json({...await mfa.state(subject(req)),eligible:await eligible(req)})));
  app.post(prefix+'/setup',authorized,limiter,endpoint(async(req,res)=>{
   if(!await eligible(req))return res.status(403).json({error:'An active partner account is required.'});
   if(!await passwordValid(req,req.body?.password))return res.status(403).json({error:'Password verification failed.'});
   res.json(await mfa.setup(subject(req),req.admin?'Administrator':req.user.email||req.user.username));
  }));
  app.post(prefix+'/confirm',authorized,limiter,endpoint(async(req,res)=>{if(!await eligible(req))return res.sendStatus(403);const result=await mfa.confirm(subject(req),req.body?.code);res.json({...result,token:renew(req,res,result.version)});}));
  app.post(prefix+'/disable',authorized,limiter,endpoint(async(req,res)=>{
   if(!await passwordValid(req,req.body?.password))return res.status(403).json({error:'Password verification failed.'});
   const result=await mfa.disable(subject(req),req.body?.code);res.json({...result,token:renew(req,res,result.version)});
  }));
 }
 // Mounted before payout routes: proof is consumed before any money/bank
 // mutation. Existing auth, same-origin, ownership and financial checks remain.
 app.use((req,res,next)=>{
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  if(!/^\/api\/admin\/payouts(?:\/|$)/.test(req.path)&&!/^\/api\/partner\/(?:bank-details|payouts)(?:\/|$)/.test(req.path))return next();
  authorized(req,res,()=>endpoint(async()=>{
   const state=await mfa.state(subject(req));if(!state.enabled)return next();
   if(!req.get('X-MFA-Code'))return res.status(403).json({error:'Verify this sensitive action with your authenticator or a recovery code.',code:'MFA_STEP_UP_REQUIRED'});
   await mfa.authenticate(subject(req),req.get('X-MFA-Code'));next();
  })(req,res));
 });
}
module.exports=registerMfaApi;
