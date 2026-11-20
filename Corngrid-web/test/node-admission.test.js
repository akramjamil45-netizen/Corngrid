'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),sqlite=require('sqlite3').verbose();
const {nodeAdmission,loadPolicy}=require('../sandbox/node-admission'),{createSandboxNodes}=require('../sandbox/sandbox-nodes'),{ensureSchema}=require('../sandbox/sandbox-schema'),{dbRun,dbGet,withTransaction}=require('../db-async');
const policy=loadPolicy({}),healthy={os_version:'Windows_NT 10',ram_mb:8192,memory_used_mb:2048,disk_free_mb:20000,cpu_percent:10,running_instances:0};

test('priority beats free slots, falls back safely, and equal priorities keep deterministic load balancing',async t=>{
 const f=await fixture(t),large=await f.add('Large default host',50),preferred=await f.add('Preferred small host',1);
 await dbRun(f.db,'UPDATE sandbox_nodes SET placement_priority=1 WHERE id=?',[preferred.id]);
 const pick=()=>withTransaction(f.db,()=>f.nodes.allocateNode());
 assert.equal((await pick()).id,preferred.id);
 await dbRun(f.db,"INSERT INTO sandbox_instances(instance_uid,user_id,node_id,status,created_at,updated_at) VALUES('priority-fixture',1,?,'running',?,?)",[preferred.id,f.stamp,f.stamp]);
 assert.equal((await pick()).id,large.id,'full preferred node is skipped');
 assert.equal((await dbGet(f.db,"SELECT node_id FROM sandbox_instances WHERE instance_uid='priority-fixture'")).node_id,preferred.id,'existing sandbox stays assigned');
 await dbRun(f.db,"UPDATE sandbox_instances SET status='stopped'");
 for(const[sql,params]of [["UPDATE sandbox_nodes SET status='disabled' WHERE id=?",[preferred.id]],["UPDATE sandbox_nodes SET status='active',is_test_node=1 WHERE id=?",[preferred.id]],["UPDATE sandbox_nodes SET is_test_node=0,last_heartbeat_at=? WHERE id=?",[f.stamp-120000,preferred.id]],["UPDATE sandbox_nodes SET last_heartbeat_at=?,memory_used_mb=8100 WHERE id=?",[f.stamp,preferred.id]]]){
  await dbRun(f.db,sql,params);assert.equal((await pick()).id,large.id);
 }
 await dbRun(f.db,'UPDATE sandbox_nodes SET memory_used_mb=2048,placement_priority=100 WHERE id=?',[preferred.id]);
 assert.equal((await pick()).id,large.id,'equal priorities choose more free slots');
 await dbRun(f.db,'UPDATE sandbox_nodes SET max_instances=50,cpu_percent=5 WHERE id=?',[preferred.id]);assert.equal((await pick()).id,preferred.id,'CPU breaks equal-capacity ties');
 await dbRun(f.db,'UPDATE sandbox_nodes SET cpu_percent=10 WHERE id=?',[preferred.id]);assert.equal((await pick()).id,large.id,'id is the final stable tie-break');
 assert.equal((await withTransaction(f.db,()=>f.nodes.allocateNode({preferredNodeId:preferred.id}))).id,preferred.id,'explicit assignment remains supported');
});

test('existing SQLite nodes receive default priority once without losing metadata',async t=>{
 const db=new sqlite.Database(':memory:');t.after(()=>new Promise(r=>db.close(r)));
 const {SCHEMA}=require('../sandbox/sandbox-schema');
 await new Promise((resolve,reject)=>db.exec(SCHEMA.replace('    placement_priority INTEGER NOT NULL DEFAULT 100 CHECK(placement_priority BETWEEN 1 AND 1000),\n',''),error=>error?reject(error):resolve()));
 await dbRun(db,"INSERT INTO sandbox_nodes(node_uid,name,created_at,updated_at) VALUES('migration-fixture','Original name',1,1)");
 await ensureSchema(db);await ensureSchema(db);
 assert.equal((await dbGet(db,"SELECT placement_priority FROM sandbox_nodes WHERE node_uid='migration-fixture'")).placement_priority,100);
 assert.equal((await dbGet(db,"SELECT name FROM sandbox_nodes WHERE node_uid='migration-fixture'")).name,'Original name');
});
test('admission rejects unknown/malformed metrics, unsupported platforms and exhausted resources',()=>{
 assert.equal(nodeAdmission(healthy,0,policy).eligible,true);for(const change of [{ram_mb:null},{memory_used_mb:9000},{cpu_percent:Infinity},{disk_free_mb:-1},{running_instances:null}])assert.equal(nodeAdmission({...healthy,...change},0,policy).eligible,false);
 for(const[change,reason]of [[{ram_mb:1024,memory_used_mb:800},'RAM_LOW'],[{disk_free_mb:100},'DISK_LOW'],[{cpu_percent:95},'CPU_BUSY'],[{os_version:'Darwin 24'},'PLATFORM_UNSUPPORTED']])assert.ok(nodeAdmission({...healthy,...change},0,policy).reasons.includes(reason));
 assert.equal(nodeAdmission({...healthy,os_version:'Linux 6.8'},0,policy).eligible,true);assert.equal(nodeAdmission({...healthy,os_version:'Linux 6.8'},0,{...policy,allowedPlatforms:['windows']}).eligible,false);assert.throws(()=>loadPolicy({SANDBOX_MIN_FREE_RAM_MB:'-1'}));assert.throws(()=>loadPolicy({SANDBOX_MAX_CPU_PERCENT:'101'}));
});
async function fixture(t){const db=new sqlite.Database(':memory:');t.after(()=>new Promise(r=>db.close(r)));await dbRun(db,'CREATE TABLE users(id INTEGER PRIMARY KEY)');await dbRun(db,'INSERT INTO users VALUES(1)');await ensureSchema(db);const stamp=1800000000000,nodes=createSandboxNodes({db,events:{emit:async()=>{}},now:()=>stamp,resourcePolicy:policy});async function add(name,max=10,report={}){const created=await nodes.createNode({name,maxInstances:max});await dbRun(db,"UPDATE sandbox_nodes SET status='active' WHERE id=?",[created.id]);const node=await dbGet(db,'SELECT * FROM sandbox_nodes WHERE id=?',[created.id]);await nodes.recordHeartbeat(node,{osVersion:'Windows_NT fixture',ramMb:8192,memoryUsedMb:2048,diskFreeMb:20000,cpuPercent:10,runningInstances:0,...report});return node;}return {db,nodes,stamp,add};}
test('resource admission is checked after node locking and manual assignment cannot bypass it',async t=>{
 const f=await fixture(t),low=await f.add('Many unsafe slots',200,{memoryUsedMb:8100}),safe=await f.add('One safe slot',1);const selected=await withTransaction(f.db,()=>f.nodes.allocateNode());assert.equal(selected.id,safe.id);assert.equal(await withTransaction(f.db,()=>f.nodes.allocateNode({preferredNodeId:low.id})),null);await f.nodes.recordHeartbeat(safe,{osVersion:'Windows_NT fixture',ramMb:8192,memoryUsedMb:2048,diskFreeMb:20000,cpuPercent:95,runningInstances:0});assert.equal(await withTransaction(f.db,()=>f.nodes.allocateNode()),null);
});
test('pending placements reserve estimated RAM/disk before the next heartbeat without stopping existing terminals',async t=>{
 const f=await fixture(t),node=await f.add('Small node',10,{ramMb:1024,memoryUsedMb:256});let count=0;
 async function reserve(){return withTransaction(f.db,async()=>{const chosen=await f.nodes.allocateNode();if(!chosen)return null;count++;await dbRun(f.db,"INSERT INTO sandbox_instances(instance_uid,user_id,node_id,status,created_at,updated_at) VALUES(?,1,?,'allocating',?,?)",['sbx_'+count.toString(16).padStart(18,'0'),node.id,f.stamp,f.stamp]);return chosen.id;});}
 assert.equal(await reserve(),node.id);assert.equal(await reserve(),node.id);assert.equal(await reserve(),null);assert.equal((await dbGet(f.db,'SELECT COUNT(*) AS count FROM sandbox_instances')).count,2);
 await dbRun(f.db,"UPDATE sandbox_instances SET status='running'");await f.nodes.recordHeartbeat(node,{osVersion:'Windows_NT fixture',ramMb:1024,memoryUsedMb:1000,diskFreeMb:20000,cpuPercent:99,runningInstances:2});assert.equal((await dbGet(f.db,"SELECT COUNT(*) AS count FROM sandbox_instances WHERE status='running'")).count,2);
});
test('zero disk updates replace old telemetry, future/stale heartbeats and missing resources cannot grant placement',async t=>{
 const f=await fixture(t),node=await f.add('Node');await f.nodes.recordHeartbeat(node,{diskFreeMb:0});assert.equal((await dbGet(f.db,'SELECT disk_free_mb FROM sandbox_nodes WHERE id=?',[node.id])).disk_free_mb,0);assert.equal(await withTransaction(f.db,()=>f.nodes.allocateNode()),null);
 await f.nodes.recordHeartbeat(node,{osVersion:'Windows_NT fixture',ramMb:8192,memoryUsedMb:2048,diskFreeMb:20000,cpuPercent:10,runningInstances:0});await f.nodes.recordHeartbeat(node,{memoryUsedMb:2048,cpuPercent:10,runningInstances:0});assert.equal((await dbGet(f.db,'SELECT disk_free_mb FROM sandbox_nodes WHERE id=?',[node.id])).disk_free_mb,null);assert.equal(await withTransaction(f.db,()=>f.nodes.allocateNode()),null,'missing disk readings must not reuse stale free-space data');
 await f.nodes.recordHeartbeat(node,{osVersion:'Windows_NT fixture',ramMb:8192,memoryUsedMb:2048,diskFreeMb:20000,cpuPercent:10,runningInstances:0});for(const stamp of [f.stamp+120000,f.stamp-120000]){await dbRun(f.db,'UPDATE sandbox_nodes SET last_heartbeat_at=? WHERE id=?',[stamp,node.id]);assert.equal(await withTransaction(f.db,()=>f.nodes.allocateNode()),null);}
});
