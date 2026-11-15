'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
if(os.hostname()!=='VPS80481')throw Error('Wrong target host');
const tests={};
for(const [name,code] of Object.entries({python:'import sys;print(sys.version)',numpy:"import numpy;print(numpy.__version__)",metatrader:"import MetaTrader5;print(MetaTrader5.__version__)"})){
 const run=spawnSync('C:/Program Files/Python312/python.exe',['-c',code],{env:{...process.env,PYTHONPATH:'C:\\CornGrid\\agent\\broker-python'},encoding:'utf8',windowsHide:true,timeout:20000});
 tests[name]={status:run.status,signal:run.signal,stdout:run.stdout?.slice(0,2000),stderr:run.stderr?.slice(0,3000),errorCode:run.error?.code};
}
const result={tests,cpu:os.cpus()[0]?.model,freeRamMb:Math.round(os.freemem()/1048576),pipLog:fs.readFileSync('C:/CornGrid/python-tools-install.log','utf8').slice(-3500)};
fs.writeFileSync('\\\\tsclient\\C\\Users\\mohamad akram\\Desktop\\CornGrid EA\\CornGrid EA\\Website\\marketing\\remote-sandbox-diagnose-result.json',JSON.stringify(result));console.log('Broker tool diagnostics saved.');
