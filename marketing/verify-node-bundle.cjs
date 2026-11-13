'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'corngrid-node-bundle-smoke-'));
try{
 const script=path.join(temp,'extract.ps1'),unpacked=path.join(temp,'package');fs.mkdirSync(unpacked);
 fs.writeFileSync(script,"param($Zip,$Output)\n$ErrorActionPreference='Stop'\nExpand-Archive -LiteralPath $Zip -DestinationPath $Output\n");
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Zip',path.join(root,'CornGrid-Node-Agent.zip'),'-Output',unpacked],{windowsHide:true,timeout:20000});
 const manifest=JSON.parse(fs.readFileSync(path.join(unpacked,'MANIFEST.json'),'utf8'));
 for(const item of manifest.files){assert.ok(!item.path.includes('..'));assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(unpacked,item.path))).digest('hex'),item.sha256);}
 const agent=path.join(unpacked,'agent');
 execFileSync(process.env.ComSpec||'cmd.exe',['/d','/s','/c','npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund'],{cwd:agent,encoding:'utf8',windowsHide:true,timeout:90000});
 for(const name of fs.readdirSync(agent).filter(n=>n.endsWith('.js')))execFileSync(process.execPath,['--check',path.join(agent,name)],{windowsHide:true,timeout:10000});
 for(const name of ['config','transport','mt5-manager','mt5-startup','ea-tester','source-compiler','broker-resolution','broker-server-cache','system-monitor','check-installation'])require(path.join(agent,name));
 const result={verified:true,archiveFiles:manifest.files.length+1,hashesMatch:true,lockedDependencyInstall:true,allJavascriptSyntax:true,allRuntimeModulesLoad:true,noAgentOrMt5Started:true,realRemoteVpsTest:false};
 fs.writeFileSync(path.join(__dirname,'node-bundle-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error('Node bundle smoke failed:',error.code||error.name);process.exitCode=1;}finally{
 const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(temp));if(!/^corngrid-node-bundle-smoke-[a-z0-9]+$/i.test(relative))throw Error('Unexpected smoke directory');fs.rmSync(path.resolve(temp),{recursive:true,force:true});
}
