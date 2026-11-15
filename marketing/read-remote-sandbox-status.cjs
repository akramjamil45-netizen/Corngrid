const fs=require('node:fs'),path=require('node:path');
const names=['stage','runtime','configure','configure2','hosting-test','diagnose','postflight','recovery','start','access','acl','task','ipc'];
const name=process.argv[2];if(!names.includes(name))throw Error('Unknown report');
const file=path.join(__dirname,'remote-sandbox-'+name+'-result.json');let data;
try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{console.log(JSON.stringify({report:name,status:'not-ready-or-writing'}));process.exit(0);}
if(data.installationChecks)data.installationChecks=data.installationChecks.map(item=>typeof item==='string'?item:item.value||'').slice(0,40);
console.log(JSON.stringify(data));
