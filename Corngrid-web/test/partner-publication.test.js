'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./helpers/marketplace-fixture');
const {dbGet,dbAll,dbRun}=require('../db-async');
const draft=f=>({name:'Automatic Partner EA',version:'1.1',description:'A complete partner EA submission for review.',symbols:'XAUUSD',riskDescription:'Capital can be lost.',...f.releaseFiles(['XAUUSD'])});
async function submit(f,extra={}){const result=await f.request('/api/partner/submissions',{user:2,method:'POST',body:{...draft(f),...extra}});assert.equal(result.status,201,JSON.stringify(result.data));return result.data;}
async function inspect(f,id){return(await f.request('/api/admin/ea-submissions/'+id,{user:'admin'})).data;}
async function approve(f,id,digest){return f.request('/api/admin/ea-submissions/'+id+'/approve',{user:'admin',method:'POST',body:{reviewDigest:digest}});}

test('EA + set submission stays private until one admin approval publishes a working strategy and Marketplace listing',async t=>{
  const f=await fixture(t);await f.enable();const created=await submit(f),id=created.submissionId;
  assert.equal((await f.details(created.listingId,2)).listing_status,'pending_review');
  assert.equal((await f.request('/api/marketplace/eas/'+created.listingId)).status,404);
  assert.equal((await f.request('/api/sandbox/strategies')).data.strategies.some(s=>s.code.startsWith('partner-')),false);
  const detail=await inspect(f,id);assert.equal(detail.publication.artifactReady,true);assert.equal(detail.publication.canApprove,true);
  assert.equal((await f.request('/api/admin/ea-submissions/'+id+'/approve',{user:2,method:'POST',body:{reviewDigest:detail.publication.reviewDigest}})).status,403);
  assert.equal((await approve(f,id,'wrong')).status,409);
  const replies=await Promise.all([approve(f,id,detail.publication.reviewDigest),approve(f,id,detail.publication.reviewDigest)]);
  assert.deepEqual(replies.map(r=>r.status),[200,200]);assert.equal(replies.filter(r=>r.data.alreadyPublished).length,1);
  const strategy=(await dbAll(f.db,'SELECT * FROM trading_strategies WHERE submission_id=?',[id]))[0];assert.ok(strategy.ea_file_path);
  assert.deepEqual(await fs.readFile(path.join(f.binaryDirectory,strategy.ea_file_path)),f.ex5);
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM ea_release_approvals')).n,1);
  assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM marketplace_audit WHERE action='ea_release_published'")).n,1);
  const publicListing=(await f.request('/api/marketplace/eas/'+created.listingId)).data.listing;
  assert.equal(publicListing.infrastructure_status,'available');assert.equal(publicListing.deployment.supported,true);
  const catalog=(await f.request('/api/sandbox/strategies')).data.strategies.find(s=>s.code===strategy.code);assert.deepEqual(catalog.supportedPairs,['XAUUSD']);
  const body={strategyCode:strategy.code,symbol:'XAUUSD',brokerServer:'Test-Demo',accountNumber:'12345',password:'test-only'};
  assert.equal((await f.request('/api/sandbox/activate',{method:'POST',body})).status,403,'subscription checks still apply');
  await f.grant(1,1);
  const node=await f.sandbox.nodes.createNode({name:'Isolated hosting node',maxInstances:10});
  await dbRun(f.db,"UPDATE sandbox_nodes SET status='active',last_heartbeat_at=?,os_version='Windows_NT fixture',ram_mb=8192,memory_used_mb=1024,disk_free_mb=20000,cpu_percent=10 WHERE id=?",[Date.now(),node.id]);
  const download=await f.request(`/api/sandbox/node/strategies/${strategy.code}/ea`,{user:null,headers:{'X-Node-Id':node.nodeUid,'X-Node-Token':node.token}});assert.equal(download.status,200);assert.deepEqual(download.data,f.ex5);
  assert.equal((await f.request('/api/sandbox/activate',{method:'POST',body})).status,201);
  assert.equal((await f.request('/api/sandbox/activate',{method:'POST',body:{...body,accountNumber:'12346'}})).status,403);
  const command=await dbGet(f.db,"SELECT payload_json FROM sandbox_deployments WHERE command='deploy'");assert.equal(JSON.parse(command.payload_json).preset.text,'TakeProfit=123\n');
});

test('file, preset and metadata changes invalidate review; rejection and supersession stay synchronized',async t=>{
  const f=await fixture(t);await f.enable();let release=await submit(f);let proof=(await inspect(f,release.submissionId)).publication;
  const artifact=await dbGet(f.db,'SELECT * FROM ea_submission_artifacts');await fs.writeFile(path.join(f.sourceDirectory,artifact.file_path),Buffer.from('tampered'));
  assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,409);
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM ea_release_approvals')).n,0);
  await fs.writeFile(path.join(f.sourceDirectory,artifact.file_path),f.ex5);
  await dbRun(f.db,"UPDATE ea_submission_presets SET content_text='TakeProfit=999' WHERE submission_id=?",[release.submissionId]);
  assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,409);
  const listing=await f.details(release.listingId,2);
  assert.equal((await f.request('/api/partner/marketplace/eas/'+release.listingId,{user:2,method:'PATCH',body:{revision:listing.revision,name:'Revised EA'}})).status,200);
  assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,409);
  const latest=await f.details(release.listingId,2);
  const second=await f.request('/api/partner/submissions',{user:2,method:'POST',body:{...draft(f),marketplaceId:latest.id,marketplaceRevision:latest.revision}});assert.equal(second.status,201);
  assert.equal((await f.partner.publication.inspect(release.submissionId)).current,false);
  const reject=await f.request(`/api/admin/ea-submissions/${second.data.submissionId}/reject`,{user:'admin',method:'POST',body:{reason:'Please improve the preset risk limits.'}});assert.equal(reject.status,200);
  assert.equal((await f.details(release.listingId,2)).listing_status,'rejected');
  assert.equal((await dbGet(f.db,'SELECT status FROM ea_submissions WHERE id=?',[second.data.submissionId])).status,'rejected');
});

test('submission retries are idempotent and require real EA/set files with matching instruments',async t=>{
  const f=await fixture(t);await f.enable();const key=crypto.randomUUID(),body={...draft(f),requestKey:key};
  const results=await Promise.all([f.request('/api/partner/submissions',{user:2,method:'POST',body}),f.request('/api/partner/submissions',{user:2,method:'POST',body})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].data.submissionId,results[1].data.submissionId);
  assert.equal((await f.request('/api/partner/submissions',{user:2,method:'POST',body:{...body,version:'1.2'}})).status,409);
  for(const extra of [{files:[]},{presets:[]},{symbols:'EURUSD'}, {files:[{name:'../bad.ex5',contentBase64:f.ex5.toString('base64')}]},{files:[{name:'fake.ex5',contentBase64:Buffer.from('not an EA').toString('base64')}] }]){
    assert.equal((await f.request('/api/partner/submissions',{user:2,method:'POST',body:{...draft(f),...extra}})).status,400);
  }
  const id=await f.create();assert.equal((await f.request(`/api/partner/marketplace/eas/${id}/submit`,{user:2,method:'POST',body:{revision:1}})).status,400,'an advertisement alone cannot enter the release approval flow');
  assert.equal((await f.request(`/api/admin/marketplace/eas/${id}/approve`,{user:'admin',method:'POST',body:{revision:1}})).status,409);
});

test('source-only submissions wait for an authenticated compiled artifact and failed audit rolls back the whole publication',async t=>{
  const f=await fixture(t);await f.enable();const source=[{name:'main.mq5',contentBase64:Buffer.from('void OnTick(){}').toString('base64')}];
  const release=await submit(f,{files:source});let proof=(await inspect(f,release.submissionId)).publication;assert.equal(proof.artifactReady,false);
  assert.equal((await approve(f,release.submissionId,null)).data.code,'ARTIFACT_REQUIRED');
  assert.equal((await f.request(`/api/admin/ea-submissions/${release.submissionId}/artifact`,{user:2,method:'POST',bytes:f.ex5})).status,403);
  assert.equal((await f.request(`/api/admin/ea-submissions/${release.submissionId}/artifact`,{user:'admin',method:'POST',bytes:f.ex5})).status,201);
  proof=(await inspect(f,release.submissionId)).publication;
  await dbRun(f.db,"CREATE TRIGGER fail_release_audit BEFORE INSERT ON marketplace_audit WHEN NEW.action='ea_release_published' BEGIN SELECT RAISE(ABORT,'Injected release audit failure'); END");
  assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,500);
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM ea_release_approvals')).n,0);
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM trading_strategies WHERE submission_id=?',[release.submissionId])).n,0);
  assert.equal((await f.details(release.listingId,2)).listing_status,'pending_review');
  await dbRun(f.db,'DROP TRIGGER fail_release_audit');assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,200);
});

test('file-only updates require a new approval, reuse the strategy, and leave running terminals and quotas untouched',async t=>{
  const f=await fixture(t);await f.enable();const first=await submit(f),proof=(await inspect(f,first.submissionId)).publication;
  const published=await approve(f,first.submissionId,proof.reviewDigest);assert.equal(published.status,200);
  await dbRun(f.db,"INSERT INTO sandbox_instances(instance_uid,user_id,strategy_id,status,created_at,updated_at) VALUES('sbx_stable',1,?,'running',1,1)",[published.data.strategyId]);
  const before=await dbGet(f.db,"SELECT * FROM sandbox_instances WHERE instance_uid='sbx_stable'"),listing=await f.details(first.listingId,2);
  const bytes=Buffer.from(f.ex5);bytes[64]=4;
  const second=await submit(f,{marketplaceId:first.listingId,marketplaceRevision:listing.revision,files:[{name:'new.ex5',contentBase64:bytes.toString('base64')}]});
  assert.equal((await f.details(first.listingId,2)).revision,listing.revision+1);
  assert.equal((await f.action(first.listingId,'publication',{status:'published'})).status,409,'prior approval cannot publish changed files');
  assert.equal((await approve(f,second.submissionId,proof.reviewDigest)).status,409);
  const next=await approve(f,second.submissionId,(await inspect(f,second.submissionId)).publication.reviewDigest);assert.equal(next.status,200);
  assert.equal(next.data.strategyId,published.data.strategyId);assert.equal(next.data.strategyCode,published.data.strategyCode);
  assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS n FROM trading_strategies WHERE code LIKE 'partner-%'")).n,1);
  assert.deepEqual(await dbGet(f.db,"SELECT * FROM sandbox_instances WHERE instance_uid='sbx_stable'"),before);
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM sandbox_deployments')).n,0);
  assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS n FROM ea_license_activations')).n,0);
});

test('only the active assigned compile node can store an immutable artifact, and success requires its transfer',async t=>{
  const f=await fixture(t);const release=await submit(f,{files:[{name:'main.mq5',contentBase64:Buffer.from('void OnTick(){}').toString('base64')}]});
  const nodes=[];for(const isTestNode of [true,true,false]){const node=await f.sandbox.nodes.createNode({name:'Isolated node',isTestNode,maxInstances:1});await dbRun(f.db,"UPDATE sandbox_nodes SET status='active',last_heartbeat_at=? WHERE id=?",[Date.now(),node.id]);nodes.push(node);}
  await f.request(`/api/admin/ea-submissions/${release.submissionId}/review`,{user:'admin',method:'POST',body:{}});
  const started=await f.request(`/api/admin/ea-submissions/${release.submissionId}/test`,{user:'admin',method:'POST',body:{}});assert.equal(started.status,200,JSON.stringify(started.data));
  const report=await dbGet(f.db,'SELECT * FROM ea_test_reports WHERE id=?',[started.data.reportId]),assigned=nodes.find(n=>n.id===report.node_id),other=nodes.find(n=>n.id!==report.node_id);
  const send=(node,suffix,body,bytes)=>f.request(`/api/admin/ea-testing/reports/${report.id}/${suffix}`,{user:null,method:'POST',body,bytes,headers:{'X-Node-Id':node.nodeUid,'X-Node-Token':node.token}});
  assert.equal((await send(other,'artifact',undefined,f.ex5)).status,404);
  assert.equal((await send(nodes[2],'artifact',undefined,f.ex5)).status,403);
  assert.equal((await send(assigned,'complete',{success:true,kind:'compile'})).status,409);
  assert.equal((await send(assigned,'artifact',undefined,Buffer.from('invalid'))).status,400);
  assert.equal((await send(assigned,'artifact',undefined,f.ex5)).status,201);
  assert.equal((await send(assigned,'artifact',undefined,f.ex5)).data.alreadyStored,true);
  const different=Buffer.from(f.ex5);different[90]=4;
  assert.equal((await send(assigned,'artifact',undefined,different)).status,409);
  assert.equal((await send(assigned,'complete',{success:true,kind:'compile',runtimeLog:'Runtime not tested.'})).status,200);
  assert.equal((await send(assigned,'artifact',undefined,f.ex5)).status,403);
  assert.equal((await dbGet(f.db,'SELECT status FROM ea_submissions WHERE id=?',[release.submissionId])).status,'testing_passed');
  assert.equal((await approve(f,release.submissionId,(await inspect(f,release.submissionId)).publication.reviewDigest)).status,200);
});

test('a failed compile remains recorded while an admin can explicitly resume review of a manually compiled EX5',async t=>{
  const f=await fixture(t),release=await submit(f,{files:[{name:'manual.mq5',contentBase64:Buffer.from('void OnTick(){}').toString('base64')}]});
  await dbRun(f.db,"UPDATE ea_submissions SET status='testing_failed' WHERE id=?",[release.submissionId]);
  assert.equal((await f.request(`/api/admin/ea-submissions/${release.submissionId}/artifact`,{user:'admin',method:'POST',bytes:f.ex5})).status,201);
  let proof=(await inspect(f,release.submissionId)).publication;assert.equal(proof.canApprove,false);
  assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,409);
  assert.equal((await f.request(`/api/admin/ea-submissions/${release.submissionId}/review`,{user:2,method:'POST',body:{}})).status,403);
  assert.equal((await f.request(`/api/admin/ea-submissions/${release.submissionId}/review`,{user:'admin',method:'POST',body:{}})).status,200);
  proof=(await inspect(f,release.submissionId)).publication;assert.equal(proof.canApprove,true);assert.equal((await approve(f,release.submissionId,proof.reviewDigest)).status,200);
});
