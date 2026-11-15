// Uses a separate terminal with no EA; never changes Danny's active terminal.
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const deployed='C:/Website/Website/Corngrid-web/';
const config=JSON.parse(fs.readFileSync(deployed+'agent/agent-config.json','utf8').replace(/^\uFEFF/,''));
const source='C:/CornGrid/Sandbox/Users/sbx_4ee7c0937ec602a4a8/config/sandbox-startup.ini';
const text=fs.readFileSync(source,'utf16le').replace(/^\uFEFF/,'');const common=text.match(/\[Common\]([\s\S]*?)(?:\r?\n\[|$)/)[1];
const values=Object.fromEntries(common.split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
const validationRoot=path.resolve(config.agentDataDir,'BrokerValidation');
const dir=path.resolve(validationRoot,'sbx_'+crypto.randomBytes(9).toString('hex'));
if(!dir.startsWith(validationRoot+path.sep))throw Error('Validation path escapes root');
(async()=>{fs.mkdirSync(path.join(dir,'config'),{recursive:true});
try{
 fs.copyFileSync(path.join(config.mt5BaseDir,'terminal64.exe'),path.join(dir,'terminal64.exe'));
 for(const name of ['servers.dat','terminal.lic']){const file=path.join(config.mt5BaseDir,'config',name);if(fs.existsSync(file))fs.copyFileSync(file,path.join(dir,'config',name));}
 const result=await require(deployed+'agent/broker-resolution').resolveBroker(dir,{accountNumber:values.Login,password:values.Password,brokerServer:'JustMarkets-DEMO6',symbol:'XAUUSD'}, {...config,brokerSymbolMaps:{},brokerAccountSymbolMaps:{},brokerCacheDir:path.join(validationRoot,'cache')});
 if(result.brokerServer!=='JustMarkets-Demo6'||result.resolvedSymbol!=='XAUUSD.c')throw Error('Unexpected verified broker/symbol');
 if(fs.existsSync(path.join(dir,'MQL5/Experts/CornGrid')))throw Error('Probe unexpectedly contains a trading EA');
 console.log(JSON.stringify({success:true,server:result.brokerServer,symbol:result.resolvedSymbol,separateTerminal:true,tradingEaInstalled:false}));
}finally{
 const target=path.resolve(dir);
 if(!target.startsWith(validationRoot+path.sep)||!/^sbx_[a-f0-9]{18}$/.test(path.basename(target)))throw Error('Unsafe validation cleanup target');
 fs.rmSync(target,{recursive:true,force:true});
}})().catch(e=>{console.error(e.message);process.exitCode=1;});
