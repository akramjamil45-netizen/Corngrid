'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),privateDir=path.join(root,'.proxy-install-private');
if(!fs.existsSync(privateDir))throw Error('Create and protect the private setup directory first.');
const file=path.join(privateDir,'bootstrap-test.json');
if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({format:1,serverUid:'cgp_'+crypto.randomBytes(9).toString('hex'),serverToken:'cgpx_'+crypto.randomBytes(32).toString('hex'),host:'188.42.230.32',port:24443,backendUrl:'https://corngrid.com'},null,2),{mode:0o600});
const bootstrap=JSON.parse(fs.readFileSync(file)),archive=path.join(root,'CornGrid-Proxy-Server.zip');
fs.writeFileSync(path.join(__dirname,'proxy-acceptance-plan.json'),JSON.stringify({hostname:'VPS80481',host:bootstrap.host,port:bootstrap.port,serverUid:bootstrap.serverUid,packageHash:crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),uids:['sbx_'+'a'.repeat(18),'sbx_'+'b'.repeat(18)]},null,2));
console.log(JSON.stringify({privateBootstrapPrepared:true,hostname:'VPS80481',productionChanged:false}));
