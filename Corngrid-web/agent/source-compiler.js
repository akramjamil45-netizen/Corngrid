'use strict';
// Compile on an assigned test node; upload the exact artifact before cleanup.
// This is compile validation. It never reports an unexecuted EA as runtime-tested.
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
function createEaTester({config,logger,mt5,transport,execFileImpl=execFile}){
  const linux=process.platform==='linux'?require('./linux-runtime').createLinuxRuntime({config}):null;
  const root=path.resolve(config.agentDataDir,'tests');
  async function runTest(payload){
    const {testInstanceUid,submissionId,reportId}=payload||{};
    if(!mt5.isValidInstanceUid(testInstanceUid)||!testInstanceUid.startsWith('eatest_')||!Number.isSafeInteger(submissionId)||!Number.isSafeInteger(reportId))throw Error('Invalid compile test assignment.');
    const dir=path.resolve(root,testInstanceUid),relative=path.relative(root,dir);
    if(relative!==testInstanceUid||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Unsafe compile directory.');
    const source=path.join(dir,'source');let success=false,compileLog='',runtimeLog='Runtime trading was not tested. This report validates compilation and artifact transfer only.';
    try{
      const manifest=await transport.httpRequest('GET',`/api/admin/ea-testing/${submissionId}/source`),files=manifest?.files;
      if(!Array.isArray(files)||!files.length||files.length>20)throw Error('No valid source manifest was returned.');
      let total=0;const seen=new Set();
      for(const file of files){
        if(typeof file.name!=='string'||!/^[A-Za-z0-9._ -]{1,120}$/.test(file.name)||path.basename(file.name)!==file.name||seen.has(file.name.toLowerCase())||!Number.isFinite(file.size)||file.size<=0||file.size>10*1024*1024)throw Error('Invalid source file manifest.');
        seen.add(file.name.toLowerCase());total+=file.size;
      }
      if(total>20*1024*1024)throw Error('Source project is too large.');
      const main=manifest.publication?.entryFile||files.find(f=>/\.mq5$/i.test(f.name))?.name;
      if(!main||!files.some(f=>f.name===main)||!/\.mq5$/i.test(main))throw Error('Automatic compilation requires a main MQ5 source file. For ZIP projects, upload the reviewed compiled EX5 executable.');
      const metaeditor=path.join(config.mt5BaseDir,'metaeditor64.exe');if(!fs.existsSync(metaeditor))throw Error('metaeditor64.exe is missing on this test node.');
      fs.mkdirSync(source,{recursive:true});
      for(const file of files)await transport.downloadFile(`/api/admin/ea-testing/${submissionId}/source/${encodeURIComponent(file.name)}`,path.join(source,file.name));
      const output=path.join(source,main.replace(/\.mq5$/i,'.ex5')),logFile=path.join(dir,'compile.log');
      if(fs.existsSync(output))fs.unlinkSync(output);
      if(linux)await linux.runProgram(dir,metaeditor,[`/compile:${linux.toWinePath(path.join(source,main))}`,`/log:${linux.toWinePath(logFile)}`],{kind:'compile',timeout:180000});
      else await new Promise((resolve,reject)=>execFileImpl(metaeditor,[`/compile:${path.join(source,main)}`,`/log:${logFile}`],{timeout:180000,windowsHide:true},error=>error?reject(Error('MetaEditor compilation failed or timed out.')):resolve()));
      if(fs.existsSync(logFile)){const bytes=fs.readFileSync(logFile);compileLog=bytes.toString(bytes[0]===0xff&&bytes[1]===0xfe?'utf16le':'utf8').replace(/^\ufeff/,'');}
      if(!fs.existsSync(output))throw Error('MetaEditor did not produce an EX5 artifact.');
      const bytes=fs.readFileSync(output);
      if(bytes.length<64||bytes.length>10*1024*1024||bytes.subarray(0,3).toString('ascii')!=='EX5')throw Error('The compiled EX5 artifact is invalid.');
      let sent=false;
      for(let attempt=0;attempt<3&&!sent;attempt++){
        try{await transport.httpRequest('POST',`/api/admin/ea-testing/reports/${reportId}/artifact`,bytes);sent=true;}
        catch(error){if(attempt===2)throw error;}
      }
      success=true;logger.info(testInstanceUid,'Compilation complete; the EX5 artifact is stored for administrator review.');
    }catch(error){compileLog+='\n'+error.message;}
    finally{
      try{await transport.httpRequest('POST',`/api/admin/ea-testing/reports/${reportId}/complete`,{success,kind:'compile',compileLog:compileLog.slice(0,18000),runtimeLog,errorCount:success?0:1});}
      catch(error){logger.error(testInstanceUid,'Compile report could not be stored: '+error.message);}
      const checked=path.relative(root,path.resolve(dir));if(checked!==testInstanceUid||checked.startsWith('..')||path.isAbsolute(checked))throw Error('Unsafe compile cleanup path.');
      if(linux){await linux.stopDirectory(dir);linux.removePrefix(dir);}
      fs.rmSync(path.resolve(dir),{recursive:true,force:true});
    }
    return {reportId,success};
  }
  return {runTest};
}
module.exports={createEaTester};
