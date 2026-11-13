'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const fs=require('node:fs/promises');
const {fixture}=require('./helpers/marketplace-fixture');
const {dbGet,dbAll,dbRun}=require('../db-async');
const sample=()=>sharp({create:{width:160,height:100,channels:3,background:'#ffd400'}}).png().toBuffer();

test('Marketplace is off by default; global and individual permissions are enforced on the backend',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/marketplace/settings')).data.enabled,false);
  assert.equal((await f.request('/api/marketplace/eas')).status,403);
  assert.equal((await f.request('/api/marketplace/eas',{user:null})).status,401);
  for(const user of [1,2,4])assert.equal((await f.request('/api/admin/marketplace/eas',{user})).status,403);
  assert.equal((await f.request('/api/admin/marketplace/eas',{user:'admin'})).status,200);
  assert.equal((await f.enable()).status,200);
  assert.equal((await f.request('/api/marketplace/eas')).status,200);
  assert.equal((await f.request('/api/admin/marketplace/access/1',{user:'admin',method:'PATCH',body:{enabled:false}})).status,200);
  assert.equal((await f.request('/api/marketplace/eas')).status,403);
  await f.request('/api/admin/marketplace/access/1',{user:'admin',method:'PATCH',body:{enabled:true}});
  await f.request('/api/admin/marketplace/settings',{user:'admin',method:'PATCH',body:{marketplace_enabled:false}});
  assert.equal((await f.request('/api/marketplace/eas')).status,403,'global OFF overrides explicit allow');
  assert.equal((await f.request('/api/partner/marketplace/eas',{user:2})).status,403,'global OFF also restricts partner Marketplace APIs');
  assert.equal((await f.request('/api/partner/marketplace/eas',{user:4})).status,403);
  assert.equal((await f.request('/api/partner/marketplace/eas',{user:1})).status,403);
  await f.enable();assert.equal((await f.request('/api/marketplace/eas')).status,200,'toggle takes effect without restart');
  await f.request('/api/admin/marketplace/access/1',{user:'admin',method:'PATCH',body:{enabled:null}});
  assert.equal(await dbGet(f.db,'SELECT * FROM marketplace_user_access WHERE user_id=1'),undefined);
});

test('partner workflow preserves exact file review revision and publishes deployment only through admin approval',async t=>{
  const f=await fixture(t);await f.enable();const id=await f.create();
  assert.equal((await f.details(id,2)).listing_status,'draft');
  for(const user of [1,3,4]){
    assert.equal((await f.request('/api/partner/marketplace/eas/'+id,{user})).status,user===1||user===4?403:404);
    assert.equal((await f.request('/api/partner/marketplace/eas/'+id,{user,method:'PATCH',body:{name:'Stolen',revision:1}})).status,user===1||user===4?403:404);
  }
  assert.equal((await f.request('/api/partner/marketplace/eas/corngrid-official',{user:2,method:'PATCH',body:{name:'Stolen',revision:1}})).status,404);
  for(const forbidden of [{provider_type:'official'},{provider_id:3},{infrastructure_status:'available'},{featured:true},{listing_status:'published'},{existing_strategy_id:1}]){
    assert.equal((await f.request('/api/partner/marketplace/eas/'+id,{user:2,method:'PATCH',body:{revision:1,...forbidden}})).status,400);
  }
  assert.equal((await f.request('/api/marketplace/eas/'+id)).status,404);
  assert.equal((await f.action(id,'publication',{status:'published'})).status,409);
  assert.equal((await f.action(id,'submit',{},2)).status,201);
  assert.equal((await f.details(id,2)).listing_status,'pending_review');
  assert.equal((await f.action(id,'approve')).status,200);
  assert.equal((await f.details(id)).listing_status,'published');
  assert.equal((await f.request('/api/marketplace/eas/'+id)).status,200);
  assert.equal((await f.action(id,'infrastructure',{status:'available'})).status,200,'reviewed executable is required for deployment approval');
  assert.equal((await f.action(id,'publication',{status:'published'})).status,200);
  let publicData=(await f.request('/api/marketplace/eas/'+id)).data.listing;
  assert.equal(publicData.infrastructure_status,'available');assert.equal(publicData.deployment.supported,true);
  assert.equal((await f.action(id,'publication',{status:'draft'})).status,200);
  assert.equal((await f.details(id)).approved_revision,true,'unchanged, approved listing can be republished');
  assert.equal((await f.action(id,'publication',{status:'published'})).status,200);
  const old=await f.details(id,2);
  assert.equal((await f.request('/api/partner/marketplace/eas/'+id,{user:2,method:'PATCH',body:{revision:old.revision,name:'Updated Strategy'}})).status,200);
  assert.equal((await f.details(id,2)).listing_status,'draft');assert.equal((await f.request('/api/marketplace/eas/'+id)).status,404);
  assert.equal((await f.action(id,'publication',{status:'published'})).status,409,'old approval cannot publish edited metadata');
  await f.action(id,'submit',{},2);
  assert.equal((await f.action(id,'reject',{reason:''})).status,400);
  assert.equal((await f.action(id,'reject',{reason:'Please clarify the risks.'})).status,200);
  assert.equal((await f.details(id,2)).review_notes,'Please clarify the risks.');
  const reviews=await dbAll(f.db,'SELECT * FROM marketplace_reviews WHERE ea_id=?',[id]);
  assert.equal(reviews.length,2);assert.ok(JSON.parse(reviews[0].snapshot_json).listing.name==='Partner Strategy');
  await f.action(id,'publication',{status:'archived'});
  assert.equal((await f.request('/api/partner/marketplace/eas/'+id,{user:2,method:'PATCH',body:{revision:(await f.details(id,2)).revision,name:'Cannot edit'}})).status,409);
});

test('official EA administration, filtering, promotions and infrastructure handoff reuse actual strategy and entitlements',async t=>{
  const f=await fixture(t);await f.enable();const id='corngrid-official',original=await f.details(id);
  const strategyId=(await dbGet(f.db,"SELECT id FROM trading_strategies WHERE code='corngrid-ea'")).id;
  assert.equal((await f.request('/api/admin/marketplace/eas/'+id,{user:'admin',method:'PATCH',body:{...f.data,name:'CornGrid Official Test',revision:original.revision,existing_strategy_id:strategyId}})).status,200);
  await f.action(id,'publication',{status:'published'});
  assert.equal((await f.action(id,'featured',{featured:true})).status,200);
  assert.equal((await f.action(id,'infrastructure',{status:'available'})).status,200);
  let item=(await f.request('/api/marketplace/eas/'+id)).data.listing;
  assert.equal(item.deployment.strategyCode,'corngrid-ea');assert.deepEqual(item.deployment.symbols,['XAUUSD','EURUSD']);
  assert.equal((await f.request('/api/marketplace/eas/'+id+'/deployment',{method:'POST',body:{}})).data.code,'SUBSCRIPTION_REQUIRED');
  await f.grant(1,1);
  const handoff=await f.request('/api/marketplace/eas/'+id+'/deployment',{method:'POST',body:{}});
  assert.equal(handoff.status,200);assert.equal(handoff.data.destination,'/dashboard.html#sandbox');
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM sandbox_instances')).n,0,'handoff never fabricates a deployment');
  assert.equal((await f.request('/api/marketplace/eas?search=official&provider=official&strategy=trend')).data.total,1);
  assert.equal((await f.request('/api/marketplace/eas?search=%25')).data.total,0,'LIKE wildcards are escaped');
  assert.equal((await f.request('/api/marketplace/eas?provider=partner')).data.total,0);
  assert.equal((await f.request('/api/marketplace/eas?page=-1')).status,400);
  const partnerId=await f.create();
  assert.equal((await f.request('/api/admin/marketplace/eas/'+partnerId,{user:'admin',method:'PATCH',body:{revision:1,existing_strategy_id:strategyId}})).status,400,'official operational strategy cannot be assigned to partner advertisement');
  await f.request('/api/admin/marketplace/settings',{user:'admin',method:'PATCH',body:{promo_visible:true,promo_title:'Explore CornGrid',promo_description:'Discover the strategy.',promo_ea_id:id}});
  assert.equal((await f.request('/api/marketplace/settings')).data.promotion.eaId,id);
  await dbRun(f.db,"INSERT INTO sandbox_instances(instance_uid,user_id,strategy_id,status,created_at,updated_at) VALUES('sbx_test',1,?,'running',0,0)",[strategyId]);
  assert.equal((await f.request('/api/marketplace/eas/'+id+'/deployment',{method:'POST',body:{}})).data.code,'SANDBOX_LIMIT_REACHED');
  const before=await dbGet(f.db,"SELECT * FROM sandbox_instances WHERE instance_uid='sbx_test'");
  await f.request('/api/admin/marketplace/settings',{user:'admin',method:'PATCH',body:{marketplace_enabled:false}});
  assert.deepEqual(await dbGet(f.db,"SELECT * FROM sandbox_instances WHERE instance_uid='sbx_test'"),before);
  assert.equal((await f.request('/api/sandbox/status')).status,200);
  assert.equal((await f.request('/api/subscription/overview')).data.subscription.status,'active');
  assert.equal((await f.request('/api/mt5/accounts')).status,200);
  await f.enable();await dbRun(f.db,'UPDATE trading_strategies SET is_published=FALSE WHERE id=?',[strategyId]);
  item=(await f.request('/api/marketplace/eas/'+id)).data.listing;assert.equal(item.deployment.supported,false);assert.equal(item.infrastructure_status,'unavailable');
  assert.equal((await f.request('/api/marketplace/eas/'+id+'/deployment',{method:'POST',body:{}})).status,409);
});

test('secure screenshots normalize to WebP, enforce ownership, order and deletion and never expose drafts',async t=>{
  const f=await fixture(t);await f.enable();const id=await f.create(),bytes=await sample();
  const upload=(user=2,body=bytes,kind='screenshots')=>f.request(`/api/partner/marketplace/eas/${id}/${kind}`,{user,method:'POST',bytes:body});
  assert.equal((await upload(3)).status,404);assert.equal((await upload(1)).status,403);
  assert.equal((await upload(2,Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>'))).status,400);
  assert.equal((await upload(2,Buffer.from('MZ executable'))).status,400);
  assert.equal((await upload(2,Buffer.alloc(4*1024*1024+1))).status,413);
  const first=await upload(),second=await upload(),logo=await upload(2,bytes,'logo');
  assert.equal(first.status,201);assert.equal(second.status,201);assert.equal(logo.status,201);
  const served=await f.request(first.data.url,{user:2});assert.equal(served.status,200);assert.equal(served.headers.get('content-type'),'image/webp');
  assert.equal((await sharp(served.data).metadata()).format,'webp');
  assert.equal((await f.request(first.data.url,{user:3})).status,404);
  assert.equal((await f.request('/api/marketplace/media/'+first.data.id)).status,404);
  assert.equal((await f.action(id,'screenshots/order',{ids:[second.data.id,first.data.id]},2)).status,200);
  let ea=await f.details(id,2);assert.deepEqual(ea.screenshots.map(i=>i.id),[second.data.id,first.data.id]);
  assert.equal((await f.action(id,'screenshots/order',{ids:[first.data.id,first.data.id]},2)).status,400);
  await f.action(id,'submit',{},2);await f.action(id,'approve');await f.action(id,'publication',{status:'published'});
  assert.equal((await f.request('/api/marketplace/media/'+first.data.id)).status,200);
  const afterPublication=await upload();assert.equal(afterPublication.status,201);
  assert.equal((await f.details(id,2)).listing_status,'draft','media edits also invalidate advertisement approval');
  assert.equal((await f.request('/api/marketplace/media/'+first.data.id)).status,404);
  ea=await f.details(id,2);
  assert.equal((await f.request(`/api/partner/marketplace/eas/${id}/screenshots/${second.data.id}`,{user:2,method:'DELETE',body:{revision:ea.revision}})).status,200);
  assert.equal((await f.request(second.data.url,{user:2})).status,404);
  assert.ok((await f.details(id,2)).logo,'screenshot deletion does not remove logo');
  const attempts=await Promise.all(Array.from({length:10},()=>upload()));
  assert.ok(attempts.some(r=>r.status===409));assert.equal((await f.details(id,2)).screenshots.length,10);
  const files=await fs.readdir(f.directory);assert.ok(files.every(name=>/^[a-f0-9-]{36}\.webp$/.test(name)));
});

test('listing updates are optimistic and transactional, including audit rollback and stale pending reviews',async t=>{
  const f=await fixture(t);await f.enable();const id=await f.create();
  const edits=await Promise.all(['Strategy A','Strategy B'].map(name=>f.request('/api/partner/marketplace/eas/'+id,{user:2,method:'PATCH',body:{name,revision:1}})));
  assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
  await f.action(id,'submit',{},2);const pending=await f.details(id,2);
  await f.request('/api/partner/marketplace/eas/'+id,{user:2,method:'PATCH',body:{revision:pending.revision,short_description:'Changed after submission'}});
  assert.equal((await f.action(id,'approve')).status,409);
  assert.equal((await dbGet(f.db,'SELECT decision FROM marketplace_reviews WHERE ea_id=?',[id])).decision,'superseded');
  await dbRun(f.db,"CREATE TRIGGER fail_marketplace_audit BEFORE INSERT ON marketplace_audit BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END");
  assert.equal((await f.request('/api/admin/marketplace/settings',{user:'admin',method:'PATCH',body:{marketplace_enabled:false}})).status,500);assert.equal((await dbGet(f.db,'SELECT marketplace_enabled FROM marketplace_settings')).marketplace_enabled,1);
  const ea=await f.details(id,2);
  assert.equal((await f.request('/api/partner/marketplace/eas/'+id,{user:2,method:'PATCH',body:{revision:ea.revision,name:'Should roll back'}})).status,500);
  assert.equal((await f.details(id,2)).name,ea.name);
});

test('Marketplace honors existing cookie CSRF checks, account archives and safe validation',async t=>{
  const f=await fixture(t);
  const cookie=(user)=>({Cookie:'corngrid_session='+f.tokens[user]});
  assert.equal((await f.request('/api/partner/marketplace/eas',{user:null,method:'POST',body:f.data,headers:{...cookie(2),Origin:'https://other.example'}})).status,403);
  assert.equal((await f.request('/api/admin/marketplace/settings',{user:null,method:'PATCH',body:{marketplace_enabled:true},headers:{...cookie('admin'),Origin:'https://other.example'}})).status,403);
  assert.equal((await f.request('/api/admin/marketplace/settings',{user:null,method:'PATCH',body:{marketplace_enabled:true},headers:{...cookie('admin'),Origin:f.base}})).status,200);
  for(const change of [{minimum_balance:-1},{balance_currency:'<x>'},{recommended_leverage:'javascript:x'},{platform:'MT4'},{supported_symbols:['<img>']},{full_description:{html:'<script>'}}]){
    assert.equal((await f.request('/api/partner/marketplace/eas',{user:2,method:'POST',body:{...f.data,...change}})).status,400);
  }
  const id=await f.create(2,{name:'<img src=x onerror=alert(1)>',full_description:{overview:'<script>alert(1)</script>',risks:'No guarantee of future results.'}});
  await f.action(id,'submit',{},2);await f.action(id,'approve');await f.action(id,'publication',{status:'published'});
  const result=await f.request('/api/marketplace/eas/'+id);assert.equal(result.status,200);assert.equal(result.data.listing.name,'<img src=x onerror=alert(1)>');
  await dbRun(f.db,"INSERT INTO account_archives(user_id,archived_at,archived_by,reason) VALUES(1,?,'test-admin','test')",[Date.now()]);
  assert.equal((await f.request('/api/marketplace/settings')).status,403);
});

test('pagination, advertising media and partner availability use database state',async t=>{
  const f=await fixture(t);await f.enable();
  for(let i=0;i<26;i++){const id=await f.create('admin',{name:'Official '+String(i).padStart(2,'0')});await f.action(id,'publication',{status:'published'});}
  const first=(await f.request('/api/marketplace/eas')).data,second=(await f.request('/api/marketplace/eas?page=2')).data;
  assert.equal(first.total,26);assert.equal(first.listings.length,24);assert.equal(second.listings.length,2);
  assert.equal(new Set([...first.listings,...second.listings].map(e=>e.id)).size,26);
  const id=first.listings[0].id,bytes=await sample();
  const banner=await f.request('/api/admin/marketplace/promotion/image',{user:'admin',method:'POST',bytes});assert.equal(banner.status,201);
  assert.equal((await f.request('/api/marketplace/media/'+banner.data.id)).status,404);
  await f.request('/api/admin/marketplace/settings',{user:'admin',method:'PATCH',body:{promo_visible:true,promo_title:'Discover',promo_description:'Reviewed promotion.',promo_ea_id:id}});
  assert.equal((await f.request('/api/marketplace/media/'+banner.data.id)).status,200);
  await f.action(id,'publication',{status:'archived'});
  assert.equal((await f.request('/api/marketplace/settings')).data.promotion,null);
  assert.equal((await f.request('/api/marketplace/media/'+banner.data.id)).status,404);
});
