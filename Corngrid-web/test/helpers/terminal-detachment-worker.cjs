'use strict';
// Executes the real manager's launch logic, substituting only the external MT5
// binary with a harmless Node timer process. No broker, account or EA is used.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),childProcess=require('node:child_process');
const [managerFile,root]=process.argv.slice(2),instanceUid='sbx_'+'a'.repeat(18),directory=path.join(root,instanceUid);
fs.mkdirSync(path.join(directory,'config'),{recursive:true});fs.writeFileSync(path.join(directory,'terminal64.exe'),'fixture, never executed');fs.writeFileSync(path.join(directory,'config/broker-resolution.json'),'{}');
const record={exports:{}};
const source=fs.readFileSync(managerFile,'utf8');
const wrapped=vm.runInThisContext('(function(require,module,exports,__dirname){'+source+'\n})',{filename:managerFile});
wrapped(name=>{
 if(name==='child_process')return {...childProcess,spawn:(_binary,_args,options)=>childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options)};
 if(name==='./mt5-startup')return {ensureStartup:()=>path.join(directory,'config/startup.ini')};
 if(name==='./broker-server-cache')return {copyBrokerServerCache:()=>{}};
 if(name==='./broker-resolution')return {resolveBroker:()=>{throw Error('No broker operation is allowed in this test.');}};
 return require(name);
},record,record.exports,path.dirname(managerFile));
const manager=record.exports.createMt5Manager({config:{sandboxUsersDir:root,mt5BaseDir:root},logger:{info:()=>{},warn:()=>{},error:()=>{}}});
manager.start({instanceUid}).then(result=>{process.send({terminalPid:result.pid});setTimeout(()=>process.exit(0),100);}).catch(()=>process.exit(2));
