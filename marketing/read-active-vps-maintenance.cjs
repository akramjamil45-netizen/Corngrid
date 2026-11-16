'use strict';
const fs=require('node:fs'),path=require('node:path');
const kind=process.argv[2]||'audit';if(!['audit','cleanup','verify','details'].includes(kind))throw Error('Unknown report');
let r;try{r=JSON.parse(fs.readFileSync(path.join(__dirname,'second-vps-maintenance-'+(kind==='details'?'audit':kind)+'-result.json'),'utf8').replace(/^\uFEFF/,''));}catch{console.log(JSON.stringify({status:'not-ready-or-writing'}));process.exit(0);}
if(kind==='audit')console.log(JSON.stringify({hostname:r.hostname,at:r.at,phase:r.phase,error:r.error,ramMb:r.ramMb,freeRamMb:r.freeRamMb,disks:r.disks,folders:r.folders,programFolders:r.programFolders,rootFiles:r.rootFiles,programs:r.programs?.map(({name,version,sizeKb})=>({name,version,sizeKb})),downloads:r.downloads,startup:r.startup,tasks:r.tasks}));
else if(kind==='details')console.log(JSON.stringify({phase:r.phase,services:r.services,processes:r.processes,terminals:r.terminals,pageFiles:r.pageFiles}));
else console.log(JSON.stringify(r));
