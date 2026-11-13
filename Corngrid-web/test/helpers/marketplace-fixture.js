'use strict';
const express=require('express'),sqlite=require('sqlite3'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {dbRun,dbGet}=require('../../db-async');
async function fixture(t) {
  const db=new sqlite.Database(':memory:'),app=express(),secret='marketplace-isolated-test-secret';
  app.use(express.json({limit:'30mb'}));
  await dbRun(db,'PRAGMA foreign_keys=ON');
  await dbRun(db,'CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,email TEXT,password TEXT,bio TEXT,created_at TEXT)');
  for(const id of [1,2,3,4])await dbRun(db,'INSERT INTO users VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)',[id,'User '+id,`user${id}@example.test`,'test','']);
  const auth=require('../../user-auth')({db,jwtSecret:secret});
  const mt5=require('../../mt5-api')(app,db,auth);
  const admin=require('../../admin-auth')({email:'admin@example.test',passwordHash:bcrypt.hashSync('test-only',4),jwtSecret:secret});
  const sub=require('../../subscriptions/subscription-api')(app,db,auth,admin,mt5.authenticateInstallation);await sub.ready();
  const rateLimit=()=> (_req,_res,next)=>next();
  const binaryDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-marketplace-binary-test-'));
  const sourceDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-marketplace-source-test-'));
  const sandbox=require('../../sandbox').createSandboxSystem(app,db,{verifyToken:auth,adminAuth:admin,subscriptionApi:sub,rateLimit,jwtSecret:secret,strategyStorageDir:binaryDirectory});await sandbox.ready;
  for(const id of [2,3])await dbRun(db,"INSERT INTO partner_profiles(user_id,display_name,status,created_at,updated_at) VALUES(?,?,'active',0,0)",[id,'Partner '+id]);
  await dbRun(db,"INSERT INTO partner_profiles(user_id,display_name,status,created_at,updated_at) VALUES(4,'Suspended partner','suspended',0,0)");
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-marketplace-test-'));
  await fs.writeFile(path.join(binaryDirectory,'test.ex5'),'Isolated artifact fixture. Never executed.');
  await dbRun(db,"UPDATE trading_strategies SET ea_file_path='test.ex5',ea_file_name='test.ex5' WHERE code='corngrid-ea'");
  const marketplace=require('../../marketplace').createMarketplace(app,db,{verifyToken:auth,adminAuth:admin,subscriptions:sub,sandbox,rateLimit,storageDir:directory,strategyStorageDir:binaryDirectory});await marketplace.ready;
  const partner=require('../../partner').createPartnerSystem(app,db,{verifyToken:auth,adminAuth:admin,events:sandbox.events,nodes:sandbox.nodes,crypto:sandbox.crypto,subscriptionApi:sub,rateLimit,authenticateNodeRequest:sandbox.nodeApi.authenticateNodeRequest,storageDir:sourceDirectory,strategyStorageDir:binaryDirectory});
  marketplace.setPublicationSystem(partner.publication);await partner.ready;
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.type==='entity.too.large'?'Request too large.':'Invalid request.'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const tokens=Object.fromEntries([1,2,3,4].map(id=>[id,jwt.sign({id,authVersion:0},secret)]));
  tokens.admin=await admin.authenticate('admin@example.test','test-only');
  const request=async(route,{user=1,method='GET',body,bytes,headers={}}={})=>{
    const h={...(user?{Authorization:'Bearer '+tokens[user]}:{}),...(bytes?{'Content-Type':'application/octet-stream'}:body?{'Content-Type':'application/json'}:{}),...headers};
    const response=await fetch(base+route,{method,headers:h,body:bytes|| (body?JSON.stringify(body):undefined)});
    const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());
    return {status:response.status,data,headers:response.headers};
  };
  const close=async()=>{
    await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>db.close(resolve));
    for(const temp of [directory,binaryDirectory,sourceDirectory]){
      const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(temp));
      if(!/^corngrid-marketplace-(?:test|binary-test|source-test)-[a-z0-9]+$/i.test(relative))throw Error('Unexpected temporary directory');
      await fs.rm(path.resolve(temp),{recursive:true,force:true});
    }
  };
  if(t)t.after(close);
  const enable=()=>request('/api/admin/marketplace/settings',{user:'admin',method:'PATCH',body:{marketplace_enabled:true}});
  const details=async(id,user='admin')=>(await request(`/api/${user==='admin'?'admin/':user===1?'':'partner/'}marketplace/eas/${id}`,{user})).data.listing;
  const data={name:'Partner Strategy',version:'1.2',short_description:'A strategy for testing.',supported_symbols:['XAUUSD','EURUSD'],supported_timeframes:['M15','H1'],strategy_type:'trend',full_description:{overview:'A reviewed overview.',features:'- Clear rules\n- **Risk controls**',risks:'Trading can result in loss of capital.',changelog:'1.2: Revised metadata.'}};
  const create=async(user=2,extra={})=>{const result=await request(`/api/${user==='admin'?'admin':'partner'}/marketplace/eas`,{user,method:'POST',body:{...data,...extra}});if(result.status!==201)throw Error('Fixture create failed: '+JSON.stringify(result.data));return result.data.id;};
  const ex5=Buffer.alloc(128,1);ex5.write('EX5',0,'ascii');ex5[3]=2;
  const releaseFiles=symbols=>({files:[{name:'test.ex5',contentBase64:ex5.toString('base64')}],presets:symbols.map(symbol=>({symbol,name:symbol+'.set',contentBase64:Buffer.from('TakeProfit=123\n').toString('base64')}))});
  const action=async(id,name,body={},user='admin')=>{const ea=await details(id,user);return request(`/api/${user==='admin'?'admin':'partner'}/marketplace/eas/${id}/${name}`,{user,method:['publication','infrastructure','featured'].includes(name)?'PATCH':'POST',body:{revision:ea.revision,...(name==='submit'?releaseFiles(ea.supported_symbols):{}),...(name==='approve'?{reviewDigest:ea.release?.reviewDigest}:{}),...body}});};
  const grant=async(user=1,limit=2)=>{
    const stamp=Date.now();let plan=await dbGet(db,'SELECT id FROM subscription_plans WHERE id=100');
    if(!plan)await dbRun(db,"INSERT INTO subscription_plans(id,name,price,currency,duration_days,max_activations,is_active,created_at,updated_at) VALUES(100,'Test',1,'MYR',30,2,TRUE,0,0)");
    await dbRun(db,"INSERT INTO user_subscriptions(user_id,plan_id,status,purchase_price,currency,duration_days,max_activations,starts_at,expires_at,created_at,updated_at) VALUES(?,100,'active',1,'MYR',30,?,?,?,0,0)",[user,limit,stamp-1000,stamp+86400000]);
  };
  return {db,app,server,base,directory,binaryDirectory,sourceDirectory,request,enable,details,create,action,grant,close,marketplace,sandbox,partner,releaseFiles,ex5,data,tokens};
}
module.exports={fixture};
