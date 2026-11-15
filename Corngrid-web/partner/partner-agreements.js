'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {dbGet,dbAll,dbRun,isPostgres}=require('../db-async');
const terms=require('./partner-terms');
const {agreementText}=require('./agreement-text');
function createPartnerAgreements(app,db,verifyUser,verifyAdmin,options={}) {
 const directory=options.directory||path.join(__dirname,'../storage/user-agreements');
 const ready=(async()=>{
  if(isPostgres(db)){await dbGet(db,'SELECT agreement_id FROM partner_applications LIMIT 1');await dbGet(db,'SELECT id FROM partner_agreements LIMIT 1');return;}
  await new Promise((resolve,reject)=>db.exec(fs.readFileSync(path.join(__dirname,'../migrations/sqlite/0009_partner_agreements.sql'),'utf8'),e=>e?reject(e):resolve()));
  const cols=await dbAll(db,'PRAGMA table_info(partner_applications)');
  if(!cols.some(c=>c.name==='agreement_id'))await dbRun(db,'ALTER TABLE partner_applications ADD COLUMN agreement_id TEXT REFERENCES partner_agreements(id)');
 })();ready.catch(()=>console.error('Partner agreement schema unavailable; apply migration 0009_partner_agreements.'));
 const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
 function fileFor(row){return path.join(directory,String(row.user_id),row.id+'.json');}
 function materialize(row){
  if(digest(row.receipt_json)!==row.receipt_hash)throw Error('Agreement receipt integrity check failed');
  const file=fileFor(row);fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file)&&digest(fs.readFileSync(file))===row.receipt_hash)return file;
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,row.receipt_json,{encoding:'utf8',flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return file;
 }
 function validate(input){
  if(input?.accepted!==true||input?.authority!==true||!['ms','en'].includes(input?.language)||typeof input?.signerName!=='string'||input.signerName.trim().length<2||input.signerName.trim().length>160||/[\x00-\x1f]/.test(input.signerName))throw Object.assign(Error('Read and explicitly accept the Partner terms, enter your full name and confirm your authority.'),{status:400});
  if(input.version!==terms.document.version||input.termsHash!==terms.hash)throw Object.assign(Error('The Partner terms have changed. Reopen and review the latest version.'),{status:409,code:'AGREEMENT_VERSION_CHANGED'});
 }
 async function accept(req,application){
  await ready;
  const input=req.body?.agreement;validate(input);
  const user=await dbGet(db,'SELECT email,username FROM users WHERE id=?',[req.user.id]);
  const id=crypto.randomUUID(),stamp=Date.now();
  const receipt={schemaVersion:1,agreementId:id,type:'corngrid_partner_programme',operator:'CornGrid',userId:req.user.id,accountEmail:user?.email||null,accountUsername:user?.username||null,signerName:input.signerName.trim(),company:application.company||null,applicationDisplayName:application.displayName,website:application.website||null,language:input.language,termsVersion:terms.document.version,termsHash:terms.hash,accepted:true,authorityConfirmed:true,acceptedAt:stamp,acceptedAtUTC:new Date(stamp).toISOString(),ipAddress:String(req.ip||req.socket?.remoteAddress||'').slice(0,128),userAgent:String(req.get('user-agent')||'').slice(0,500),acceptanceMethod:'authenticated_explicit_checkbox_typed_name_submit',terms:terms.document};
  const json=JSON.stringify(receipt,null,2)+'\n',hash=digest(json);
  await dbRun(db,'INSERT INTO partner_agreements(id,user_id,terms_version,terms_hash,language,signer_name,accepted_at,receipt_json,receipt_hash) VALUES(?,?,?,?,?,?,?,?,?)',[id,req.user.id,terms.document.version,terms.hash,input.language,receipt.signerName,stamp,json,hash]);
  materialize({id,user_id:req.user.id,receipt_json:json,receipt_hash:hash});return id;
 }
 app.get('/api/partner/terms',verifyUser,(_q,res)=>res.set('Cache-Control','no-store').json({document:terms.document,termsHash:terms.hash}));
 app.get('/api/partner/agreements',verifyUser,async(req,res)=>{try{await ready;const rows=await dbAll(db,'SELECT id,terms_version,language,signer_name,accepted_at FROM partner_agreements WHERE user_id=? ORDER BY accepted_at DESC',[req.user.id]);res.set('Cache-Control','no-store').json({agreements:rows});}catch{res.status(503).json({error:'Agreement records unavailable.'});}});
 app.get('/api/admin/partner-agreements',verifyAdmin,async(req,res)=>{try{await ready;const user=String(req.query.userId||'');if(user&&!/^[1-9][0-9]*$/.test(user))return res.status(400).json({error:'Invalid user ID.'});const rows=await dbAll(db,'SELECT g.id,g.user_id,g.terms_version,g.language,g.signer_name,g.accepted_at,u.username,u.email FROM partner_agreements g LEFT JOIN users u ON u.id=g.user_id'+(user?' WHERE g.user_id=?':'')+' ORDER BY g.accepted_at DESC LIMIT 200',user?[Number(user)]:[]);res.set('Cache-Control','private, no-store').json({agreements:rows});}catch{res.status(503).json({error:'Agreement records unavailable.'});}});
 async function download(req,res,admin=false,latest=false){
  try{await ready;
   const format=req.query.format||'json';
   if(!['json','txt'].includes(format))return res.status(400).json({error:'Choose JSON or TXT agreement format.'});
   let row;
   if(latest)row=await dbGet(db,'SELECT g.* FROM partner_agreements g JOIN partner_applications a ON a.agreement_id=g.id WHERE a.user_id=?',[req.params.userId]);
   else row=await dbGet(db,'SELECT * FROM partner_agreements WHERE id=?'+(admin?'':' AND user_id=?'),admin?[req.params.id]:[req.params.id,req.user.id]);
   if(!row)return res.status(404).json({error:'No digital agreement recorded. Legacy applications are not treated as accepted.'});
   if(format==='txt'){
    const text=agreementText(row);
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Type':'text/plain; charset=utf-8'});
    res.attachment('CornGrid-Partner-Agreement-'+row.id+'.txt');
    return res.send(text);
   }
   const file=materialize(row);res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.download(file,'CornGrid-Partner-Agreement-'+row.id+'.json');
  }catch(error){console.error('Agreement export failed:',error.code||'integrity-or-storage');res.status(503).json({error:'Agreement copy is temporarily unavailable.'});}
 }
 app.get('/api/partner/agreements/:id/file',verifyUser,(q,r)=>download(q,r));
 app.get('/api/admin/partner-agreements/:id/file',verifyAdmin,(q,r)=>download(q,r,true));
 app.get('/api/admin/partner-applications/:userId/agreement',verifyAdmin,(q,r)=>download(q,r,true,true));
 return {ready,accept,validate,directory};
}
module.exports={createPartnerAgreements};
