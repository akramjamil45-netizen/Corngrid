const fs=require('node:fs');const path=require('node:path');
const root='C:/Website/Website/Corngrid-web/';
require(root+'node_modules/dotenv').config({path:root+'.env',quiet:true});
const {Client}=require(root+'node_modules/pg');
const dir='C:/CornGrid/Sandbox/Users/sbx_4ee7c0937ec602a4a8';
function ini(file,section){const bytes=fs.readFileSync(file);const text=bytes.toString(bytes[0]===255&&bytes[1]===254?'utf16le':'utf8').replace(/^\uFEFF/,'');let active=false;const values={};for(const line of text.split(/\r?\n/)){if(line.startsWith('[')){active=line===`[${section}]`;continue;}const i=line.indexOf('=');if(active&&i>0)values[line.slice(0,i)]=line.slice(i+1);}return values;}
(async()=>{const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();try{
const row=(await db.query("SELECT i.id,i.user_id,i.broker_server,c.cipher FROM sandbox_instances i JOIN sandbox_credentials c ON c.instance_id=i.id JOIN users u ON u.id=i.user_id WHERE i.instance_uid=$1 AND i.deleted_at IS NULL AND lower(u.username)='danny dan'",[path.basename(dir)])).rows[0];
if(!row)throw Error('Danny sandbox identity mismatch');
if(process.argv.includes('--repair')){
 const {createSandboxCrypto}=require(root+'sandbox/sandbox-crypto');const crypto=createSandboxCrypto();const credentials=crypto.decryptJson(row.cipher);
 if(!credentials||credentials.accountNumber!=='1300082363')throw Error('Credential identity mismatch');
 const server='JustMarkets-Demo6';const common=ini(path.join(dir,'config/sandbox-startup.ini'),'Common');const licensePath=path.join(dir,'MQL5/Files/corngrid_sandbox.ini');const license=ini(licensePath,'License');
 if(common.Login!==credentials.accountNumber||license.Account!==credentials.accountNumber)throw Error('Local identity mismatch');
 const backup=path.join(dir,'canonical-repair-'+Date.now());fs.mkdirSync(backup);
 for(const relative of ['config/sandbox-startup.ini','config/common.ini','MQL5/Files/corngrid_sandbox.ini','MQL5/Presets/corngrid-sandbox.set'])fs.copyFileSync(path.join(dir,relative),path.join(backup,path.basename(relative)));
 const cfgPath=root+'agent/agent-config.json';fs.copyFileSync(cfgPath,path.join(backup,'agent-config.json'));const cfg=JSON.parse(fs.readFileSync(cfgPath,'utf8').replace(/^\uFEFF/,''));
 const cache='C:/CornGrid/Sandbox/BrokerCaches/JustMarkets';fs.mkdirSync(path.join(cache,'config'),{recursive:true});fs.copyFileSync(path.join(dir,'config/servers.dat'),path.join(cache,'config/servers.dat'));
 for(const name of ['JustMarkets-DEMO6',server]){cfg.brokerServerDataDirs[name]=cache;cfg.brokerSymbolMaps[name]={...(cfg.brokerSymbolMaps[name]||{}),XAUUSD:'XAUUSD.c'};}
 fs.writeFileSync(cfgPath,JSON.stringify(cfg,null,2));
 const presetBytes=fs.readFileSync(path.join(dir,'MQL5/Presets/corngrid-sandbox.set'));const preset=presetBytes.toString('utf16le');
 const ea=fs.readdirSync(path.join(dir,'MQL5/Experts/CornGrid')).find(n=>n.endsWith('.ex5'));if(!ea)throw Error('EA missing');
 require(root+'agent/mt5-startup').prepareStartup(dir,{accountNumber:credentials.accountNumber,password:credentials.password,brokerServer:server,symbol:'XAUUSD',apiBaseUrl:license.ApiBaseUrl,installationSecret:license.Secret,strategy:{code:'corngrid-ea',eaFileName:ea},preset:{text:preset}},cfg);
 const licenseBytes=fs.readFileSync(licensePath);const encoding=licenseBytes[0]===255&&licenseBytes[1]===254?'utf16le':'utf8';fs.writeFileSync(licensePath,licenseBytes.toString(encoding).replace(/^Server=.*$/m,'Server='+server),encoding);
 await db.query('BEGIN');try{
 credentials.brokerServer=server;
 await db.query('UPDATE sandbox_instances SET broker_server=$1,updated_at=$2 WHERE id=$3',[server,Date.now(),row.id]);
 await db.query('UPDATE sandbox_credentials SET cipher=$1,updated_at=$2 WHERE instance_id=$3',[crypto.encryptJson(credentials),Date.now(),row.id]);
 await db.query('UPDATE mt5_accounts SET broker_server=$1 WHERE user_id=$2 AND account_number=$3',[server,row.user_id,credentials.accountNumber]);
 await db.query('UPDATE ea_license_activations SET broker_server=$1,updated_at=$2 WHERE user_id=$3 AND mt5_account_number=$4',[server,Date.now(),row.user_id,credentials.accountNumber]);
 await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
 console.log(JSON.stringify({repaired:true,server,symbol:'XAUUSD.c',backup}));
}
console.log(JSON.stringify({now:new Date().toISOString(),accounts:(await db.query('SELECT account_number,broker_server,ea_name,ea_version,last_heartbeat,last_sync,balance,equity,auth_error_at FROM mt5_accounts WHERE user_id=$1',[row.user_id])).rows,instance:(await db.query('SELECT status,trading_paused,last_heartbeat_at,last_error,process_id FROM sandbox_instances WHERE id=$1',[row.id])).rows[0]}));
}finally{await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
