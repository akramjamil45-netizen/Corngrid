'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Client}=require('pg'),createDatabase=require('../db-postgres'),{dbRun:run,dbGet:get}=require('../db-async'),{createProxyService}=require('../sandbox/proxy-service'),{createSandboxCrypto}=require('../sandbox/sandbox-crypto');
const url=process.env.TEST_POSTGRES_URL;
test('PostgreSQL proxy migration shares one IP across parallel starts, preserves leases and isolates node ownership',{skip:!url,timeout:30000},async()=>{
 const control=new Client({connectionString:url}),schema='proxy_test_'+crypto.randomBytes(8).toString('hex'),databases=[];await control.connect();
 try{
  await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
  const folder=path.join(__dirname,'../migrations/postgres');for(const name of (await fs.readdir(folder)).filter(n=>n.endsWith('.sql')).sort())await control.query(await fs.readFile(path.join(folder,name),'utf8'));
  await control.query(await fs.readFile(path.join(folder,'0023_sandbox_proxy.sql'),'utf8'));
  const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema);const a=createDatabase(scoped.toString()),b=createDatabase(scoped.toString());databases.push(a,b);
  const now=Date.now(),secrets=createSandboxCrypto({encryptionKey:'2'.repeat(64)}),first=createProxyService({db:a,crypto:secrets}),second=createProxyService({db:b,crypto:secrets});
  const owner=await run(a,"INSERT INTO users(username,email,password) VALUES('proxy-fixture','proxy-fixture@example.test','fixture-only')");
  const node=(await run(a,"INSERT INTO sandbox_nodes(node_uid,name,agent_version,created_at,updated_at) VALUES('node_proxy_fixture','Proxy fixture','1.4.0',?,?)",[now,now])).lastID;
  const uids=['sbx_'+'1'.repeat(18),'sbx_'+'2'.repeat(18)];
  for(const uid of uids)await run(a,"INSERT INTO sandbox_instances(instance_uid,user_id,node_id,status,created_at,updated_at) VALUES(?,?,?,'starting',?,?)",[uid,owner.lastID,node,now,now]);
  const created=await first.create({name:'PG proxy',host:'proxy.example.test'}),server=await first.authenticate(created.bootstrap.serverUid,created.bootstrap.serverToken);
  const ip=await first.addEndpoint(server.id,{publicIp:'8.8.8.8',sourceAddress:'10.0.0.1'});await first.heartbeat(server,{certificateFingerprint:'a'.repeat(64)});await first.verifyEgress(server,ip.id,'8.8.8.8');await first.update(server.id,{enabled:true});await first.assign(node,server.id);
  const registered={id:node,node_uid:'node_proxy_fixture',agent_version:'1.4.0'},routes=await Promise.all([first.route(registered,uids[0],{prepare:true}),second.route(registered,uids[1],{prepare:true})]);
  assert.equal(routes[0].endpointId,routes[1].endpointId);assert.equal(Number((await get(a,'SELECT COUNT(*) AS count FROM sandbox_proxy_leases')).count),2);
  const retry=await second.route(registered,uids[0],{prepare:true});assert.equal(retry.endpointId,routes[0].endpointId);assert.equal(Number((await get(a,'SELECT COUNT(*) AS count FROM sandbox_proxy_leases')).count),2);
  await assert.rejects(second.route({...registered,id:node+100},uids[0]),/not found/);assert.equal((await first.heartbeat(server,{certificateFingerprint:'a'.repeat(64)})).leases.length,2);
  await first.update(server.id,{enabled:false});await assert.rejects(second.route(registered,uids[0]),/Direct fallback/);
 }finally{for(const db of databases)await new Promise(resolve=>db.close(resolve));try{await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{await control.end();}}
});
