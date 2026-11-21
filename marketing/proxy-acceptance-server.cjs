'use strict';
// Live VPS protocol acceptance only; no production control-plane state or
// trading credentials. Removed/stopped before the real daemon is enabled.
const fs=require('node:fs'),{createProxyServer}=require('C:/CornGridProxy/proxy/server');
const config=JSON.parse(fs.readFileSync('C:/CornGridProxy/private/proxy-config.json','utf8').replace(/^\ufeff/,''));
const plan=JSON.parse(fs.readFileSync('C:/CornGridProxySetup/plan.json','utf8').replace(/^\ufeff/,''));
const state=()=>({enabled:JSON.parse(fs.readFileSync('C:/CornGridProxySetup/acceptance-control.json','utf8')).enabled,serverTime:Date.now(),endpoints:[{id:1,sourceAddress:plan.host,publicIp:plan.host,enabled:true,verified:true}],leases:plan.uids.map(instanceUid=>({instanceUid,endpointId:1}))});
const proxy=createProxyServer({config:{...config,maxConnections:32,maxConnectionsPerSandbox:8},tlsOptions:{pfx:fs.readFileSync(config.pfxPath),passphrase:config.pfxPassphrase},request:async()=>state()});
proxy.start().then(()=>console.log('Proxy protocol acceptance listener ready.')).catch(()=>{console.error('Acceptance listener failed.');process.exit(1);});
process.on('SIGTERM',()=>proxy.close().finally(()=>process.exit(0)));
