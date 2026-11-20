'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const original={id:4,name:'Original',placementPriority:100},desired={id:4,name:'New host',placementPriority:1};
const json=(body,status=200)=>({ok:status<400,status,json:async()=>body});
function client(fetch){
 const source=fs.readFileSync(path.join(__dirname,'../public/admin-sandbox.js'),'utf8').replace('window.CornGridAdminSandbox = {','window.testSaveSettings = saveNodeSettings; window.CornGridAdminSandbox = {');
 const window={setTimeout:(fn,ms)=>setTimeout(fn,ms===750?1:Math.min(ms,100)),clearTimeout};
 vm.runInNewContext(source,{window,document:{readyState:'loading',addEventListener(){}},fetch,AbortController,TypeError});
 return()=>window.testSaveSettings(original,desired.name,desired.placementPriority,()=>{});
}
test('node settings confirm a lost response before retrying and preserve the original baseline',async()=>{
 const calls=[],save=client(async(url,options)=>{
  calls.push({url,method:options.method||'GET',body:options.body&&JSON.parse(options.body)});
  if(calls.length===1)throw new TypeError('Failed to fetch');
  return json(url.endsWith('/nodes')?{nodes:[original]}:{node:desired});
 });
 assert.equal((await save()).node.name,'New host');assert.deepEqual(calls.map(c=>c.method),['PATCH','GET','PATCH']);
 assert.deepEqual(calls[0].body,{name:'New host',placementPriority:1,expectedName:'Original',expectedPlacementPriority:100});
 assert.deepEqual(calls[0].body,calls[2].body);
 let mutations=0;const committed=client(async url=>{if(url.endsWith('/settings')){mutations++;throw new TypeError('Lost reply');}return json({nodes:[desired]});});
 assert.equal((await committed()).node.placementPriority,1);assert.equal(mutations,1);
});
test('node settings do not overwrite concurrent edits or retry rejected requests',async()=>{
 let mutations=0;
 const conflict=client(async url=>{if(url.endsWith('/settings')){mutations++;throw new TypeError('Lost reply');}return json({nodes:[{...original,name:'Other admin'}]});});
 await assert.rejects(conflict(),/another administrator/);assert.equal(mutations,1);
 for(const status of [400,401,403,409]){let calls=0;await assert.rejects(client(async()=>{calls++;return json({error:'Rejected'},status);})(),/Rejected/);assert.equal(calls,1);}
});
