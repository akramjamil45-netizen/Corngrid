'use strict';
const fs=require('node:fs'),path=require('node:path');
const allowed=['audit','cleanup','verify','components'],kind=process.argv[2];
if(!allowed.includes(kind))throw Error('Unknown report');
const file=path.join(__dirname,'remote-vps-storage-'+kind+'-result.json');
let data;try{data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{console.log(JSON.stringify({report:kind,status:'not-ready-or-writing'}));process.exit(0);}
if(kind==='audit'&&process.argv.includes('--storage')){
 const {hostname,phase,freeDiskMb,totalDiskMb,freeRamMb,programs,firefox,rootFiles,folderSizes,programFolderSizes,downloads}=data;
 data={hostname,phase,freeDiskMb,totalDiskMb,freeRamMb,programs,firefox,rootFiles,folderSizes,programFolderSizes,downloads};
}else if(kind==='audit'&&process.argv.includes('--startup')){
 const {hostname,phase,startup,startupFolders,thirdPartyTasks,services,processes}=data;
 data={hostname,phase,startup:startup?.map(({command,...r})=>({...r,executable:command.match(/^"([^"]+)"|^([^\s]+)/)?.slice(1).find(Boolean)||'unparsed'})),startupFolders,thirdPartyTasks,services,processes};
}
console.log(JSON.stringify(data));
