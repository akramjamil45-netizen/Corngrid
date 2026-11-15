'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Client}=require('pg'),createDatabase=require('../db-postgres'),{createMfa,totp}=require('../mfa'),{createSystemHealth}=require('../system-health'),{createBackup,verifyBackup}=require('../ops/backup');
const {dbRun,withTransaction}=require('../db-async'),{createSandboxNodes}=require('../sandbox/sandbox-nodes');
const url=process.env.TEST_POSTGRES_URL;
test('PostgreSQL migrations, health queries and concurrent MFA verification work across independent pools',{skip:!url,timeout:30000},async()=>{
 const control=new Client({connectionString:url}),schema='platform_test_'+crypto.randomBytes(8).toString('hex'),databases=[];await control.connect();
 try{
  await control.query('CREATE SCHEMA '+schema);await control.query('SET search_path TO '+schema);
  const folder=path.join(__dirname,'../migrations/postgres');for(const name of (await fs.readdir(folder)).filter(n=>n.endsWith('.sql')).sort())await control.query(await fs.readFile(path.join(folder,name),'utf8'));
  const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema);const a=createDatabase(scoped.toString()),b=createDatabase(scoped.toString());databases.push(a,b);
  const stamp=1800000000000,key='e'.repeat(64),first=createMfa({db:a,encryptionKey:key,now:()=>stamp}),second=createMfa({db:b,encryptionKey:key,now:()=>stamp+30000});
  const setup=await first.setup('user:1','Fixture');await first.confirm('user:1',totp(setup.secret,stamp/30000));const code=totp(setup.secret,stamp/30000+1),other=createMfa({db:a,encryptionKey:key,now:()=>stamp+30000});
  const results=await Promise.allSettled([other.authenticate('user:1',code),second.authenticate('user:1',code)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const health=await createSystemHealth({db:a,stripeEnabled:true,stripeWebhookConfigured:true}).snapshot();assert.ok(health.checks.every(c=>c.status!=='unknown'),JSON.stringify(health.checks.filter(c=>c.status==='unknown')));assert.equal(health.checks.find(c=>c.id==='database').values.engine,'postgresql');
  const nodes=createSandboxNodes({db:a,events:{emit:async()=>{}},now:()=>stamp}),registered=await nodes.createNode({name:'Isolated fixture node',maxInstances:10});await dbRun(a,"UPDATE sandbox_nodes SET status='active' WHERE id=?",[registered.id]);const node={id:registered.id,last_heartbeat_at:stamp};
  await nodes.recordHeartbeat(node,{osVersion:'Windows_NT fixture',ramMb:1024,memoryUsedMb:1000,diskFreeMb:20000,cpuPercent:10,runningInstances:0});assert.equal(await withTransaction(a,()=>nodes.allocateNode()),null,'PostgreSQL row-lock path enforces RAM admission');
  await nodes.recordHeartbeat(node,{osVersion:'Windows_NT fixture',ramMb:8192,memoryUsedMb:1024,diskFreeMb:20000,cpuPercent:10,runningInstances:0});assert.equal((await withTransaction(a,()=>nodes.allocateNode())).id,registered.id);
 }finally{for(const db of databases)await new Promise(resolve=>db.close(resolve));try{await control.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}finally{await control.end();}}
});
test('PostgreSQL encrypted backup actually restores into a new disposable database and leaves the source intact',{skip:!url,timeout:120000},async()=>{
 const control=new Client({connectionString:url}),name='corngrid_backup_test_'+crypto.randomBytes(8).toString('hex'),root=await fs.mkdtemp(path.join(os.tmpdir(),'corngrid-pg-backup-test-'));let created=false;await control.connect();
 try{
  await control.query('CREATE DATABASE "'+name+'"');created=true;const source=new URL(url);source.pathname='/'+name;source.searchParams.delete('options');const db=new Client({connectionString:source.toString()});await db.connect();try{await db.query("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO users VALUES(1,'Fixture')");}finally{await db.end();}
  const website=path.join(root,'Website');await fs.mkdir(path.join(website,'Corngrid-web'),{recursive:true});await fs.writeFile(path.join(website,'Corngrid-web/.env'),'FIXTURE=private-test-only');const output=path.join(root,'backup.cgb'),key='e'.repeat(64);
  await createBackup({sourceRoot:website,databaseUrl:source.toString(),output,key,temporaryRoot:root});const result=await verifyBackup({input:output,key,restoreControlUrl:url,temporaryRoot:root});assert.equal(result.verified,true);assert.equal(result.counts.users,1);assert.equal(result.engine,'postgresql');assert.equal((await control.query('SELECT datname FROM pg_database WHERE datname=$1',[name])).rowCount,1);
 }finally{try{if(created&&/^corngrid_backup_test_[a-f0-9]{16}$/.test(name))await control.query('DROP DATABASE "'+name+'" WITH (FORCE)');}finally{await control.end();const rel=path.relative(os.tmpdir(),root);assert.match(rel,/^corngrid-pg-backup-test-[a-z0-9]+$/i);await fs.rm(root,{recursive:true,force:true});}}
});
