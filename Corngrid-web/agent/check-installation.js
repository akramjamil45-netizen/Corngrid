'use strict';
// Read-only diagnostics: never start MT5, send a heartbeat, poll commands or
// attach a node WebSocket (which would take over its existing live channel).
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const RUNTIME_FILES=['agent.js','config.js','transport.js','system-monitor.js','mt5-manager.js','mt5-startup.js','broker-resolution.js','broker-server-cache.js','broker-probe.py','ipc-probe.js','operation-queue.js','command-execution.js','proxy-protocol.js','proxy-tunnel.js','proxy-network.js','proxy-bridge-worker.js','resolve-broker.ps1','discover-broker.ps1','ea-tester.js','source-compiler.js','auto-update.js','update-protocol.js'];
function checkLocal({config,agentDir=__dirname,platform=process.platform,arch=process.arch,nodeVersion=process.versions.node,testNode=false,run=execFileSync,resolveModule=(name)=>require.resolve(name,{paths:[agentDir]})}={}){
  const checks=[],add=(name,status,message)=>checks.push({name,status,message});
  const linux=platform==='linux';
  add(linux?'Linux x64':'Windows x64',(linux||platform==='win32')&&arch==='x64'?'PASS':'FAIL',linux?'Linux hosting requires x86-64, systemd, Wine and Xvfb; Linux ARM is not supported.':'Use a Windows x64 VPS with the Desktop Experience required by broker discovery.');
  const [major,minor]=nodeVersion.split('.').map(Number),supported=major>20||major===20&&minor>=17;
  add('Node.js',!supported?'FAIL':[22,24,26].includes(major)?'PASS':'WARN',supported?'Use a supported LTS; Node.js 24 LTS is the documented baseline.':'Agent requires Node.js >=20.17.0.');
  const missing=[...RUNTIME_FILES,...(linux?['linux-runtime.js']:[])].filter(name=>!fs.existsSync(path.join(agentDir,name)));
  add('Agent files',missing.length?'FAIL':'PASS',missing.length?'Missing package files: '+missing.join(', '):'All required runtime files are present.');
  try{resolveModule('ws');add('Dependencies','PASS','WebSocket dependency is available.');}catch{add('Dependencies','FAIL','Run npm ci --omit=dev in the agent directory.');}
  try{const url=new URL(config.backendUrl);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();add('Backend origin',url.protocol==='https:'?'PASS':'WARN','Use the public HTTPS origin of CornGrid. Localhost points to this VPS.');}
  catch{add('Backend origin','FAIL','backendUrl must be an HTTP(S) origin without credentials, query or path.');}
  add('Node identity',/^node_[a-f0-9]{18}$/.test(config.nodeUid||'')&&/^cgn_[a-f0-9]{64}$/.test(config.nodeToken||'')?'PASS':'FAIL','Use a newly registered Node ID and token for this VPS; values are never printed.');
  for(const [field,title] of [['mt5BaseDir','MT5 base'],['sandboxUsersDir','Sandbox users'],['agentDataDir','Agent data'],['brokerCacheDir','Broker cache'],...(linux?[['winePrefixesDir','Wine prefixes'],['wineTemplateDir','Wine template']]:[])]){
    const value=config[field];let present=false;
    try{present=typeof value==='string'&&path.isAbsolute(value)&&fs.statSync(value).isDirectory();}catch{}
    add(title,present?'PASS':'FAIL',present?'Directory exists; verify permissions for the agent account.':'Create the configured absolute directory on this VPS.');
  }
  add('MT5 terminal',Boolean(config.mt5BaseDir&&fs.existsSync(path.join(config.mt5BaseDir,'terminal64.exe')))?'PASS':'FAIL','Copy the complete clean English MT5 program directory, not only terminal64.exe.');
  if(testNode)add('MetaEditor',Boolean(config.mt5BaseDir&&fs.existsSync(path.join(config.mt5BaseDir,'metaeditor64.exe')))?'PASS':'FAIL','Test nodes require metaeditor64.exe for MQ5 compilation.');
  const roots=[config.mt5BaseDir,config.sandboxUsersDir,config.agentDataDir,config.brokerCacheDir,...(linux?[config.winePrefixesDir,config.wineTemplateDir]:[])].filter(v=>typeof v==='string').map(v=>path.resolve(v));
  const overlap=roots.some((a,i)=>roots.some((b,j)=>i!==j&&(!path.relative(a,b)||!path.relative(a,b).startsWith('..')&&!path.isAbsolute(path.relative(a,b)))));
  add('Directory isolation',overlap?'FAIL':'PASS','MT5 base, Users, AgentData and BrokerCaches must be separate directories, not nested inside one another.');
  if(config.webRequestSettingsSource)add('WebRequest template',fs.existsSync(config.webRequestSettingsSource)?'PASS':'FAIL',linux?'Prepare the allowlist using the Wine template and verify a demo EA heartbeat.':'Prepare the template under the same Windows account as the agent.');
  else add('WebRequest template','WARN','Prepare the EA WebRequest URLs on this VPS; file presence cannot verify protected settings.');
  for(const directory of Object.values(config.brokerServerDataDirs||{}))add('Broker server seed',typeof directory==='string'&&fs.existsSync(path.join(directory,'config','servers.dat'))?'PASS':'WARN',linux?'Prepare config/servers.dat for each broker; Linux has no PowerShell broker discovery.':'Optional profile seeds contain config/servers.dat; discovery can build a cache if absent.');
  if(linux){
    const validation=require('./linux-runtime').createLinuxRuntime({config,runSync:run}).validate();
    add('Wine + user services',validation.ok?'PASS':'FAIL',validation.ok?'Wine configuration and systemd user manager are available.':validation.error);
    try{run('xdpyinfo',['-display',config.wineDisplay],{timeout:10000,maxBuffer:65536,env:{...process.env,DISPLAY:config.wineDisplay,XAUTHORITY:config.xAuthority}});add('Xvfb display','PASS','Authenticated X11 display is reachable.');}catch{add('Xvfb display','FAIL','Start corngrid-display.service and check DISPLAY/XAUTHORITY.');}
    const site=path.join(path.dirname(config.mt5PythonPath||''),'Lib','site-packages','MetaTrader5');
    add('Windows Python + MetaTrader5',fs.existsSync(site)?'WARN':'FAIL',fs.existsSync(site)?'Package files exist. Run the documented Wine import check; presence does not prove broker connectivity.':'Install Windows x64 Python and its MetaTrader5 wheel through Wine. Native Linux pip does not supply this Windows extension.');
    return checks;
  }
  try{
    const code="import sys,struct,json;sys.path.insert(0,sys.argv[1]);import MetaTrader5 as m;print(json.dumps({'bits':struct.calcsize('P')*8,'version':m.__version__}))";
    const result=JSON.parse(String(run(config.mt5PythonPath||'python.exe',['-c',code,path.join(config.agentHome||agentDir,'broker-python')],{timeout:15000,windowsHide:true,maxBuffer:65536})));
    add('Python + MetaTrader5',result.bits===64?'PASS':'FAIL','Requires 64-bit Python and an importable MetaTrader5 package. No broker connection was opened.');
  }catch{add('Python + MetaTrader5','FAIL','Run setup-broker-tools.ps1 with 64-bit Python, then set mt5PythonPath to that same executable.');}
  return checks;
}
async function checkOnline(config,{fetchImpl=fetch}={}){
  const checks=[];let origin;
  try{const url=new URL(config.backendUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error();origin=url.origin;}
  catch{return [{name:'HTTPS backend',status:'FAIL',message:'Online diagnostics require a public HTTPS origin; no credentials were sent.'}];}
  try{const response=await fetchImpl(origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(15000)});const data=await response.json();checks.push({name:'HTTPS health',status:response.ok&&data.status==='ok'?'PASS':'FAIL',message:'Backend health endpoint checked.'});}
  catch{checks.push({name:'HTTPS health',status:'FAIL',message:'Cannot reach backend health. Check DNS, outbound HTTPS and reverse proxy.'});}
  if(!/^node_[a-f0-9]{18}$/.test(config.nodeUid||'')||!/^cgn_[a-f0-9]{64}$/.test(config.nodeToken||''))return [...checks,{name:'Node authentication',status:'FAIL',message:'Invalid or placeholder credentials; authentication request skipped.'}];
  try{const response=await fetchImpl(origin+'/api/sandbox/node/instances',{headers:{'X-Node-Id':config.nodeUid,'X-Node-Token':config.nodeToken},redirect:'error',signal:AbortSignal.timeout(15000)});const data=await response.json();checks.push({name:'Node authentication',status:response.ok&&Array.isArray(data.instances)?'PASS':'FAIL',message:response.ok?'Read-only authentication succeeded; no commands or heartbeat were sent.':'Authentication failed. Check token, node activation and proxy/WAF rules.'});}
  catch{checks.push({name:'Node authentication',status:'FAIL',message:'Read-only node request failed. Check network/proxy; credentials are not printed.'});}
  return checks;
}
async function main(){
  if(process.argv.includes('--help')){console.log('node check-installation.js [--online] [--test-node]\nRead-only checks. --online checks HTTPS health and node authentication. It does not test broker login, EA execution or WebSockets.');return;}
  try{
    const file=process.env.CORNGRID_AGENT_CONFIG_FILE||path.join(__dirname,'agent-config.json');if(fs.existsSync(file))JSON.parse(fs.readFileSync(file,'utf8'));
    const config=require('./config').loadConfig(),checks=checkLocal({config,testNode:process.argv.includes('--test-node')});
    if(process.argv.includes('--online'))checks.push(...await checkOnline(config));
    for(const check of checks)console.log(`[${check.status}] ${check.name}: ${check.message}`);
    const failures=checks.filter(c=>c.status==='FAIL').length;console.log(`Checks complete: ${failures} failure(s). Broker login, WebRequest and EA execution still require a demo sandbox test.`);process.exitCode=failures?1:0;
  }catch{console.error('Cannot read installation configuration. Fix agent-config.json; configuration contents are not printed.');process.exitCode=1;}
}
if(require.main===module)main();
module.exports={checkLocal,checkOnline,RUNTIME_FILES};
