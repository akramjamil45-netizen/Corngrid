'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net');
const sqlite=require('sqlite3').verbose(),{dbRun:run,dbGet:get}=require('../db-async'),{ensureSchema}=require('../sandbox/sandbox-schema'),{ensureProxySchema}=require('../sandbox/proxy-schema'),{createProxyService}=require('../sandbox/proxy-service'),{createSandboxCrypto}=require('../sandbox/sandbox-crypto');
const protocol=require('../agent/proxy-protocol');
async function fixture(t){
 const db=new sqlite.Database(':memory:');t.after(()=>new Promise(resolve=>db.close(resolve)));
 await run(db,'CREATE TABLE users(id INTEGER PRIMARY KEY)');await run(db,'INSERT INTO users VALUES(1)');await ensureSchema(db);await ensureProxySchema(db);
 const now=1800000000000,audits=[],service=createProxyService({db,crypto:createSandboxCrypto({encryptionKey:'1'.repeat(64)}),now:()=>now,audit:async(...args)=>audits.push(args)});
 const node={id:1,node_uid:'node_fixture',agent_version:'1.4.0'};
 await run(db,"INSERT INTO sandbox_nodes(id,node_uid,name,created_at,updated_at,agent_version) VALUES(1,'node_fixture','Fixture',?,?,?)",[now,now,node.agent_version]);
 for(let i=1;i<=2;i++)await run(db,"INSERT INTO sandbox_instances(id,instance_uid,user_id,node_id,status,created_at,updated_at) VALUES(?,?,1,1,'stopped',?,?)",[i,'sbx_'+String(i).padStart(18,'0'),now,now]);
 const created=await service.create({name:'Proxy fixture',host:'proxy.example.test'},'fixture'),server=await service.authenticate(created.bootstrap.serverUid,created.bootstrap.serverToken);
 return {db,service,node,server,created,now,audits,uids:['sbx_'+String(1).padStart(18,'0'),'sbx_'+String(2).padStart(18,'0')]};
}
test('direct is default; two sandboxes share one verified VPS egress with private credentials',async t=>{
 const f=await fixture(t);assert.deepEqual(await f.service.route(f.node,f.uids[0],{prepare:true}),{mode:'direct'});
 assert.equal(await f.service.authenticate(f.created.bootstrap.serverUid,'incorrect'),null);
 await assert.rejects(f.service.update(f.server.id,{enabled:true}),/heartbeat/);
 const e=await f.service.addEndpoint(f.server.id,{publicIp:'8.8.8.8',sourceAddress:'10.0.0.5'});
 await f.service.heartbeat(f.server,{certificateFingerprint:'a'.repeat(64)});
 assert.equal((await f.service.verifyEgress(f.server,e.id,'8.8.4.4')).verified,false);
 await assert.rejects(f.service.update(f.server.id,{enabled:true}),/verify/);
 assert.equal((await f.service.verifyEgress(f.server,e.id,'::ffff:8.8.8.8')).verified,true);
 await f.service.update(f.server.id,{enabled:true});await f.service.assign(f.node.id,f.server.id);
 const routes=await Promise.all(f.uids.map(uid=>f.service.route(f.node,uid,{prepare:true})));
 assert.equal(routes[0].endpointId,routes[1].endpointId);assert.equal(routes[0].publicIp,'8.8.8.8');
 assert.notEqual(routes[0].ticket,routes[1].ticket);assert.equal(protocol.verifyTicket(f.created.bootstrap.serverToken,routes[0].ticket,f.server.server_uid,f.now).instanceUid,f.uids[0]);
 const listed=await f.service.list();assert.equal(listed.servers[0].endpoints.length,1);assert.equal(listed.servers[0].endpoints[0].sandboxCount,2);
 assert.ok(!JSON.stringify(listed).includes(f.created.bootstrap.serverToken));assert.ok(!JSON.stringify(f.audits).includes(f.created.bootstrap.serverToken));
 await assert.rejects(f.service.removeEndpoint(f.server.id,e.id),/still reserved/);
 await assert.rejects(f.service.route({...f.node,id:2},f.uids[0]),/not found/);
 await assert.rejects(f.service.route({...f.node,agent_version:'1.3.3'},f.uids[0]),/Update this node/);
 await f.service.update(f.server.id,{enabled:false});await assert.rejects(f.service.route(f.node,f.uids[0]),/Direct fallback is not allowed/);
 await f.service.assign(f.node.id,null);await assert.rejects(f.service.route(f.node,f.uids[0]),/restarted/);
 assert.deepEqual(await f.service.route(f.node,f.uids[0],{prepare:true}),{mode:'direct'});
 await f.service.release(f.node,f.uids[1]);await f.service.removeEndpoint(f.server.id,e.id);
 assert.equal((await get(f.db,'SELECT COUNT(*) AS count FROM sandbox_proxy_leases')).count,0);
 await f.service.removeServer(f.server.id);assert.equal((await f.service.list()).servers.length,0);
});
test('proxy validates inputs, certificate changes, expiry and private destination ranges',async t=>{
 const f=await fixture(t);
 for(const publicIp of ['127.0.0.1','169.254.169.254','10.0.0.1','192.168.1.1','198.51.100.1','::1'])await assert.rejects(f.service.addEndpoint(f.server.id,{publicIp,sourceAddress:'10.0.0.1'}),/public IPv4/);
 await assert.rejects(f.service.create({name:'x',host:'http://bad/'}),/Name/);
 await f.service.heartbeat(f.server,{certificateFingerprint:'a'.repeat(64)});await assert.rejects(f.service.heartbeat(f.server,{certificateFingerprint:'b'.repeat(64)}),/certificate changed/);
 const token=protocol.signTicket('fixture',{serverUid:'server',endpointId:1,instanceUid:f.uids[0]},f.now);
 assert.throws(()=>protocol.verifyTicket('wrong',token,'server',f.now),/AUTH/);assert.throws(()=>protocol.verifyTicket('fixture',token,'other',f.now),/AUTH/);assert.throws(()=>protocol.verifyTicket('fixture',token,'server',f.now+300001),/AUTH/);
 assert.throws(()=>protocol.proxyCommon({ProxyEnable:1,ProxyType:1,ProxyAddress:'8.8.8.8:443',ProxyLogin:'u',ProxyPassword:'p'}),/LOCAL_ADDRESS/);
 assert.equal(protocol.proxyCommon(null).ProxyEnable,0);
});
async function certificate(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-proxy-test-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^corngrid-proxy-test-/);fs.rmSync(root,{recursive:true,force:true});});
 const exe=process.env.OPENSSL_BIN||(process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl');
 const key=path.join(root,'key.pem'),cert=path.join(root,'cert.pem'),conf=path.join(root,'openssl.cnf');fs.writeFileSync(conf,'[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n');
 try{cp.execFileSync(exe,['req','-x509','-newkey','rsa:2048','-nodes','-config',conf,'-keyout',key,'-out',cert,'-subj','/CN=localhost','-days','1'],{stdio:['ignore','ignore','pipe'],windowsHide:true});}catch(error){throw Error('Test certificate generation failed: '+String(error.stderr||error.code).slice(-1200));}
 const certBytes=fs.readFileSync(cert),x509=new crypto.X509Certificate(certBytes);return {key:fs.readFileSync(key),cert:certBytes,fingerprint:crypto.createHash('sha256').update(x509.raw).digest('hex')};
}

test('bridge exposes authenticated stop control while backend startup is still pending',{timeout:10000},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-bridge-test-')),uid='sbx_'+'3'.repeat(18),stateFile=path.join(root,'proxy-bridges',uid+'.json');
 fs.mkdirSync(path.dirname(stateFile));const state={instanceUid:uid,serverUid:'server',endpointId:1,username:'fixture-user',password:'fixture-password',controlToken:crypto.randomBytes(32).toString('hex'),ready:false};fs.writeFileSync(stateFile,JSON.stringify(state));
 const sockets=new Set();let requested=false;
 const backend=require('node:http').createServer((req,res)=>{assert.equal(req.headers['x-node-id'],'node_fixture');requested=true;/* Deliberately pending until the worker is stopped. */});
 backend.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
 const child=cp.spawn(process.execPath,[path.join(__dirname,'../agent/proxy-bridge-worker.js'),stateFile],{windowsHide:true,stdio:'ignore',env:{...process.env,CORNGRID_AGENT_DATA_DIR:root,CORNGRID_BACKEND_URL:'http://127.0.0.1:'+backend.address().port,CORNGRID_NODE_UID:'node_fixture',CORNGRID_NODE_TOKEN:'fixture-only'}});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 t.after(async()=>{if(child.exitCode===null){child.kill();await exited;}for(const socket of sockets)socket.destroy();await new Promise(resolve=>backend.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
 let published;const deadline=Date.now()+5000;
 while(Date.now()<deadline){published=JSON.parse(fs.readFileSync(stateFile));if(published.controlPort&&requested)break;await new Promise(resolve=>setTimeout(resolve,25));}
 assert.ok(requested&&published.controlPort,'control channel is ready before backend response');assert.equal(published.ready,false);assert.equal(published.pid,child.pid);
 await assert.rejects(require('../agent/proxy-network').control({...published,controlToken:'wrong'},'status'),/CLOSED/);
 await require('../agent/proxy-network').control(published,'stop');assert.equal(await exited,0);
});
test('real TLS tunnel forwards broker bytes, shares egress, and rejects wrong pins and disabled routes',{timeout:20000},async t=>{
 const cert=await certificate(t),echoSockets=new Set(),echo=net.createServer(socket=>{echoSockets.add(socket);socket.on('close',()=>echoSockets.delete(socket));socket.pipe(socket);});await new Promise(resolve=>echo.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const socket of echoSockets)socket.destroy();return new Promise(resolve=>echo.close(resolve));});
 const uid='sbx_'+'1'.repeat(18),config={serverUid:'server',serverToken:'fixture-secret',certificateFingerprint:cert.fingerprint,listenHost:'127.0.0.1',port:0};
 // The remote Windows clock can drift; authenticated control time anchors
 // ticket validation, while the elapsed duration comes from a monotonic clock.
 const backendTime=Date.now()+600000;
 let enabled=true;const state=()=>({enabled,serverTime:backendTime,endpoints:[{id:1,sourceAddress:'127.0.0.1',publicIp:'8.8.8.8',enabled:true,verified:true}],leases:[{instanceUid:uid,endpointId:1}]});
 let controlFailure=null;
 const proxy=require('../proxy/server').createProxyServer({config,tlsOptions:{key:cert.key,cert:cert.cert},allowPrivateTargetsForTests:true,request:async()=>{if(controlFailure)throw Error(controlFailure);return state();}});await proxy.start();t.after(()=>proxy.close());
 const route={mode:'proxy',host:'127.0.0.1',port:proxy.server.address().port,certificateFingerprint:cert.fingerprint,ticket:protocol.signTicket(config.serverToken,{serverUid:config.serverUid,instanceUid:uid,endpointId:1},backendTime)};
 await assert.rejects(require('../agent/proxy-tunnel').openTunnel({...route,certificateFingerprint:'0'.repeat(64)},'127.0.0.1',echo.address().port),/CERT_MISMATCH/);
 for(let i=0;i<2;i++){const tunnel=await require('../agent/proxy-tunnel').openTunnel(route,'127.0.0.1',echo.address().port);const received=new Promise(resolve=>tunnel.once('data',resolve));tunnel.write('broker-'+i);tunnel.resume();assert.equal((await received).toString(),'broker-'+i);tunnel.destroy();}
 // Exercise the actual MT5-facing SOCKS5 layer, including fragmented input,
 // required local credentials and payload coalesced with the CONNECT request.
 const socksSockets=new Set(),socks=net.createServer(socket=>{socksSockets.add(socket);socket.on('close',()=>socksSockets.delete(socket));void require('../agent/proxy-tunnel').socksSession(socket,{username:'local',password:'private-fixture',getRoute:async()=>route});});
 await new Promise(resolve=>socks.listen(0,'127.0.0.1',resolve));t.after(()=>{for(const s of socksSockets)s.destroy();return new Promise(resolve=>socks.close(resolve));});
 async function local(){const s=net.connect(socks.address().port,'127.0.0.1');await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('error',reject);});t.after(()=>s.destroy());return {s,input:protocol.reader(s)};}
 const denied=await local();denied.s.write(Buffer.from([5,1,0]));assert.deepEqual(await denied.input.read(2),Buffer.from([5,255]));denied.s.destroy();
 const rejected=await local();rejected.s.write(Buffer.from([5,1,2]));assert.deepEqual(await rejected.input.read(2),Buffer.from([5,2]));rejected.s.write(Buffer.from([1,1,120,1,121]));assert.deepEqual(await rejected.input.read(2),Buffer.from([1,1]));rejected.s.destroy();
 const good=await local();good.s.write(Buffer.from([5]));good.s.write(Buffer.from([1,2]));assert.deepEqual(await good.input.read(2),Buffer.from([5,2]));
 good.s.write(Buffer.concat([Buffer.from([1,5]),Buffer.from('local'),Buffer.from([15]),Buffer.from('private-fixture')]));assert.deepEqual(await good.input.read(2),Buffer.from([1,0]));
 const destination=Buffer.alloc(10);Buffer.from([5,1,0,1,127,0,0,1]).copy(destination);destination.writeUInt16BE(echo.address().port,8);good.s.write(Buffer.concat([destination,Buffer.from('coalesced-broker')]));
 assert.equal((await good.input.read(10))[1],0);assert.equal((await good.input.read(16)).toString(),'coalesced-broker');
 const closed=new Promise(resolve=>good.s.once('close',resolve));enabled=false;await proxy.refresh();await closed;
 await assert.rejects(require('../agent/proxy-tunnel').openTunnel(route,'127.0.0.1',echo.address().port),/REJECTED/);
 enabled=true;await proxy.refresh();const established=await require('../agent/proxy-tunnel').openTunnel(route,'127.0.0.1',echo.address().port);
 controlFailure='PROXY_CONTROL_UNAVAILABLE';await assert.rejects(proxy.refresh(),/UNAVAILABLE/);
 const reply=new Promise(resolve=>established.once('data',resolve));established.write('survives-backend-outage');established.resume();assert.equal((await reply).toString(),'survives-backend-outage');
 const revoked=new Promise(resolve=>established.once('close',resolve));controlFailure='PROXY_CONTROL_HTTP_401';await assert.rejects(proxy.refresh(),/401/);await revoked;
 // Production DNS validation rejects even one private result, before any TCP
 // connection can be made. Test mode is deliberately absent on this daemon.
 enabled=true;const blocked=require('../proxy/server').createProxyServer({config,tlsOptions:{key:cert.key,cert:cert.cert},request:async()=>state(),lookup:async()=>[{address:'8.8.8.8',family:4},{address:'169.254.169.254',family:4}]});
 await blocked.start();t.after(()=>blocked.close());await assert.rejects(require('../agent/proxy-tunnel').openTunnel({...route,port:blocked.server.address().port},'mixed.example',443),/REJECTED/);
});
