'use strict';
const path=require('node:path');
const {atomicJson}=require('../agent/update-protocol');
if(require.main===module){
 const {publishRelease}=require('../sandbox/node-updates');
 const storageDir=process.env.SANDBOX_NODE_UPDATE_DIR;
 if(!storageDir){console.error('Set SANDBOX_NODE_UPDATE_DIR to a private directory outside the website.');process.exitCode=1;}
 else publishRelease({sourceDir:process.env.CORNGRID_RELEASE_SOURCE||path.join(__dirname,'../agent'),storageDir}).then(result=>{atomicJson(path.join(storageDir,'publisher-status.json'),{ok:true,checkedAt:new Date().toISOString(),...result});console.log(JSON.stringify(result));}).catch(()=>{try{atomicJson(path.join(storageDir,'publisher-status.json'),{ok:false,checkedAt:new Date().toISOString(),error:'Source manifest or validation failed. Previous release preserved.'});}catch{}console.error('Agent release was not published. Build RELEASE.json last and verify source files and private signing storage.');process.exitCode=1;});
}
