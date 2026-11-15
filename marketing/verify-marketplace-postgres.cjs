'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../Corngrid-web'),{Client}=require(path.join(root,'node_modules/pg')),express=require(path.join(root,'node_modules/express')),sharp=require(path.join(root,'node_modules/sharp'));
const createDb=require(path.join(root,'db-postgres')),{dbGet}=require(path.join(root,'db-async'));
async function main(){
  const env=require(path.join(root,'node_modules/dotenv')).parse(fs.readFileSync('C:/Website/Website/Corngrid-web/.env'));
  const schema='marketplace_check_'+crypto.randomBytes(8).toString('hex'),url=new URL(env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);
  const control=new Client({connectionString:env.DATABASE_URL}),dbs=[],servers=[],directory=await fsp.mkdtemp(path.join(os.tmpdir(),'corngrid-marketplace-pg-'));
  await control.connect();
  try{
    await control.query(`CREATE SCHEMA ${schema}`);await control.query(`SET search_path TO ${schema}`);
    for(const file of ['0001_initial.sql','0003_subscriptions.sql','0005_sandbox.sql','0006_partner_applications_presets.sql','0009_partner_agreements.sql','0012_payment_request_archives.sql','0014_multiple_sandboxes.sql','0015_marketplace.sql','0016_partner_publication.sql'])await control.query(fs.readFileSync(path.join(root,'migrations/postgres',file),'utf8'));
    // Additive migration is safe to rerun.
    await control.query(fs.readFileSync(path.join(root,'migrations/postgres/0015_marketplace.sql'),'utf8'));
    await control.query(fs.readFileSync(path.join(root,'migrations/postgres/0016_partner_publication.sql'),'utf8'));
    await control.query("INSERT INTO users(id,username,email,password) VALUES(1,'Regular','one@example.test','test'),(2,'Partner','two@example.test','test')");
    await control.query("INSERT INTO partner_profiles(user_id,display_name,status,created_at,updated_at) VALUES(2,'Test partner','active',0,0)");
    const auth=(req,res,next)=>{if(!req.get('X-Test-User'))return res.sendStatus(401);req.user={id:Number(req.get('X-Test-User'))};next();};
    const admin={verifyToken:(req,res,next)=>{if(req.get('X-Test-Admin')!=='1')return res.sendStatus(403);req.admin={id:'admin-test'};next();}};
    for(let i=0;i<2;i++){
      const db=createDb(url.toString());dbs.push(db);const app=express();app.use(express.json({limit:'30mb'}));
      const rateLimit=()=> (_req,_res,next)=>next();
      const sub=require(path.join(root,'subscriptions/subscription-api'))(app,db,auth,admin,auth);await sub.ready();
      const strategyStorageDir=path.join(directory,'binaries');
      const sandbox=require(path.join(root,'sandbox')).createSandboxSystem(app,db,{verifyToken:auth,adminAuth:admin,subscriptionApi:sub,rateLimit,strategyStorageDir});await sandbox.ready;
      const marketplace=require(path.join(root,'marketplace')).createMarketplace(app,db,{verifyToken:auth,adminAuth:admin,subscriptions:sub,sandbox,rateLimit,storageDir:path.join(directory,'media'),strategyStorageDir});await marketplace.ready;
      const partner=require(path.join(root,'partner')).createPartnerSystem(app,db,{verifyToken:auth,adminAuth:admin,events:sandbox.events,nodes:sandbox.nodes,crypto:sandbox.crypto,subscriptionApi:sub,rateLimit,authenticateNodeRequest:sandbox.nodeApi.authenticateNodeRequest,storageDir:path.join(directory,'sources'),strategyStorageDir});await partner.ready;marketplace.setPublicationSystem(partner.publication);
      const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));servers.push(server);
    }
    const request=async(index,route,{method='GET',body,admin=false,bytes}={})=>{
      const response=await fetch('http://127.0.0.1:'+servers[index].address().port+route,{method,headers:{'X-Test-User':'2',...(admin?{'X-Test-Admin':'1'}:{}),...(bytes?{'Content-Type':'application/octet-stream'}:body?{'Content-Type':'application/json'}:{})},body:bytes||(body?JSON.stringify(body):undefined)});
      return {status:response.status,data:await response.json()};
    };
    const draft={name:'Postgres test EA',version:'1.0',short_description:'Isolated PostgreSQL fixture.',supported_symbols:['XAUUSD'],full_description:{overview:'Isolated review.',risks:'Capital can be lost.'}};
    await request(0,'/api/admin/marketplace/settings',{admin:true,method:'PATCH',body:{marketplace_enabled:true}});
    const created=await request(0,'/api/partner/marketplace/eas',{method:'POST',body:draft});assert.equal(created.status,201);const id=created.data.id,endpoint='/api/partner/marketplace/eas/'+id;
    let responses=await Promise.all([request(0,endpoint,{method:'PATCH',body:{revision:1,name:'Strategy A'}}),request(1,endpoint,{method:'PATCH',body:{revision:1,name:'Strategy B'}})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const image=await sharp({create:{width:100,height:100,channels:3,background:'#ffd400'}}).png().toBuffer();
    for(let i=0;i<9;i++)assert.equal((await request(0,endpoint+'/screenshots',{method:'POST',bytes:image})).status,201);
    responses=await Promise.all([request(0,endpoint+'/screenshots',{method:'POST',bytes:image}),request(1,endpoint+'/screenshots',{method:'POST',bytes:image})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);
    const row=()=>dbGet(dbs[0],'SELECT * FROM marketplace_eas WHERE id=?',[id]);
    let revision=(await row()).revision;
    const ex5=Buffer.alloc(128,1);ex5.write('EX5',0,'ascii');
    const files={files:[{name:'test.ex5',contentBase64:ex5.toString('base64')}],presets:[{symbol:'XAUUSD',name:'test.set',contentBase64:Buffer.from('TakeProfit=123\n').toString('base64')}]};
    const submitBody={revision,requestKey:crypto.randomUUID(),...files};
    responses=await Promise.all([request(0,endpoint+'/submit',{method:'POST',body:submitBody}),request(1,endpoint+'/submit',{method:'POST',body:submitBody})]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);assert.equal(responses[0].data.submissionId,responses[1].data.submissionId);
    let detail=(await request(0,'/api/admin/marketplace/eas/'+id,{admin:true})).data.listing;revision=detail.revision;
    const logo=()=>request(1,endpoint+'/logo',{method:'POST',bytes:image});
    responses=await Promise.all([request(0,'/api/admin/marketplace/eas/'+id+'/approve',{admin:true,method:'POST',body:{revision,reviewDigest:detail.release.reviewDigest}}),logo()]);
    assert.equal(responses[1].status,201);assert.ok([200,409].includes(responses[0].status));
    assert.equal((await row()).listing_status,'draft');
    assert.equal((await request(0,'/api/admin/marketplace/eas/'+id+'/publication',{admin:true,method:'PATCH',body:{revision:(await row()).revision,status:'published'}})).status,409,'racing media edit cannot reuse an older approval');
    revision=(await row()).revision;
    await request(0,endpoint+'/submit',{method:'POST',body:{revision,requestKey:crypto.randomUUID(),...files}});
    detail=(await request(0,'/api/admin/marketplace/eas/'+id,{admin:true})).data.listing;revision=detail.revision;
    const approveBody={revision,reviewDigest:detail.release.reviewDigest};
    // Separate admin entrypoints/pools must converge on the same release record.
    responses=await Promise.all([request(0,'/api/admin/marketplace/eas/'+id+'/approve',{admin:true,method:'POST',body:approveBody}),request(1,'/api/admin/ea-submissions/'+detail.release.submissionId+'/approve',{admin:true,method:'POST',body:approveBody})]);
    assert.deepEqual(responses.map(r=>r.status),[200,200]);assert.equal(responses.filter(r=>r.data.alreadyPublished).length,1);
    const releaseCount=await dbGet(dbs[0],'SELECT COUNT(*) AS n FROM ea_release_approvals WHERE submission_id=?',[detail.release.submissionId]);assert.equal(Number(releaseCount.n),1);
    const strategy=await dbGet(dbs[0],'SELECT s.* FROM trading_strategies s JOIN marketplace_eas e ON e.existing_strategy_id=s.id WHERE e.id=?',[id]);assert.deepEqual(await fsp.readFile(path.join(directory,'binaries',strategy.ea_file_path)),ex5);
    assert.equal((await request(0,'/api/admin/marketplace/eas/'+id+'/publication',{admin:true,method:'PATCH',body:{revision,status:'published'}})).status,200);
    const toggle=enabled=>request(0,'/api/admin/marketplace/settings',{admin:true,method:'PATCH',body:{marketplace_enabled:enabled}});
    await toggle(true);assert.equal((await request(1,'/api/marketplace/eas')).data.total,1);
    await toggle(false);assert.equal((await request(1,'/api/marketplace/eas')).status,403);
    assert.equal((await dbGet(dbs[0],'SELECT COUNT(*) AS n FROM sandbox_instances')).n,0);
    assert.equal((await dbGet(dbs[0],'SELECT COUNT(*) AS n FROM user_subscriptions')).n,0);
    console.log(JSON.stringify({postgresVerified:true,twoPools:true,metadataConflictSafe:true,mediaLimitRaceSafe:true,reviewEditRaceSafe:true,submissionRetriesIdempotent:true,concurrentReleaseApprovalExactlyOnce:true,realArtifactPublished:true,globalToggleImmediate:true,operationalDataUnchanged:true}));
  }finally{
    for(const server of servers)await new Promise(resolve=>server.close(resolve));for(const db of dbs)await new Promise(resolve=>db.close(resolve));
    if(!/^marketplace_check_[a-f0-9]{16}$/.test(schema))throw Error('Unexpected test schema');await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await control.end();
    if(!/^corngrid-marketplace-pg-[a-z0-9]+$/i.test(path.relative(path.resolve(os.tmpdir()),path.resolve(directory))))throw Error('Unexpected temporary directory');
    await fsp.rm(path.resolve(directory),{recursive:true,force:true});
  }
}
main().catch(error=>{console.error('Marketplace PostgreSQL check failed:',error.code==='ERR_ASSERTION'?error.message:error.code||error.name);process.exitCode=1;});
