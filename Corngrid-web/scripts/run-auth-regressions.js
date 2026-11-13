'use strict';
// Replacement for legacy smoke scripts that wrote to localhost:3000.
// These suites create their own in-memory databases and ephemeral HTTP servers.
const path=require('node:path'),{spawnSync}=require('node:child_process');
function run(){
 if(process.env.NODE_TEST_CONTEXT){console.log('Legacy auth entry point skipped during test discovery; use npm test.');return;}
 const result=spawnSync(process.execPath,['--test','test/email-verification.test.js','test/login-handler.test.js','test/user-auth.test.js','test/session-cookie.test.js'],{cwd:path.resolve(__dirname,'..'),stdio:'inherit',windowsHide:true,env:{...process.env}});
 if(result.error){console.error('Unable to start isolated authentication tests:',result.error.code||result.error.name);process.exitCode=1;return;}
 process.exitCode=result.status==null?1:result.status;
}
module.exports=run;
