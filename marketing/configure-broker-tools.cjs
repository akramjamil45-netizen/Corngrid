const fs=require('node:fs');
const file='C:/Website/Website/Corngrid-web/agent/agent-config.json';
const cfg=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
cfg.mt5PythonPath='C:/Users/mohamad akram/AppData/Local/Programs/Python/Python313/python.exe';
cfg.brokerCacheDir='C:/CornGrid/Sandbox/BrokerCaches';
for(const name of ['brokerSymbolMaps','brokerServerDataDirs','brokerAccountSymbolMaps']){
 cfg[name] ||= {};
 const entries=Object.entries(cfg[name]).filter(([server])=>server.toLowerCase()==='justmarkets-demo6');
 if(entries.length){
  const value=entries.find(([server])=>server==='JustMarkets-Demo6')?.[1] || entries[0][1];
  for(const [server] of entries)delete cfg[name][server];
  cfg[name]['JustMarkets-Demo6']=value;
 }
}
if(cfg.brokerSymbolMaps['JustMarkets-Demo6'])delete cfg.brokerSymbolMaps['JustMarkets-Demo6'].XAUUSD;
cfg.brokerAccountSymbolMaps['JustMarkets-Demo6'] ||= {};
cfg.brokerAccountSymbolMaps['JustMarkets-Demo6']['1300082363']={XAUUSD:'XAUUSD.c'};
fs.writeFileSync(file,JSON.stringify(cfg,null,2));
console.log('Broker tools configured; duplicate server aliases consolidated.');
