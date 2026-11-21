'use strict';
// Isolated UI fixture; no production credentials, database or trading sessions.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const express=require('express'),{WebSocketServer}=require('ws'),{chromium}=require('playwright');
async function main(){
 const app=express(),root=path.join(__dirname,'../public');app.use(express.json());
 const node={id:1,nodeUid:'node_fixture',name:'Fixture node',agentVersion:'1.4.0',placementPriority:100,status:'active',maxInstances:10,usedSlots:0,online:true};
 let enabled=true,assignments=[],creates=0,rejectAssign=false,removed=false;
 const serverRow=()=>({id:1,name:'Proxy <fixture>',host:'proxy.example.test',port:24443,enabled,online:true,certificateFingerprint:'a'.repeat(64),endpoints:[{id:1,publicIp:'8.8.8.8',sourceAddress:'10.0.0.5',verified:true,sandboxCount:2}]});
 app.get('/fixture',(_req,res)=>res.type('html').send(fs.readFileSync(path.join(root,'admin.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'').replace('</body>',
  '<script>document.querySelectorAll(".page").forEach(p=>{p.hidden=p.id!=="sandbox";p.classList.toggle("is-visible",p.id==="sandbox")});</script><script src="/admin-sandbox.js" defer></script><script src="/admin-proxy.js" defer></script></body>')));
 app.get('/api/admin/sandbox/nodes',(_req,res)=>res.json({nodes:[node]}));
 app.get('/api/admin/sandbox/overview',(_req,res)=>res.json({nodes:{total:1,online:1,offline:0},instances:{total:0,running:0,failed:0},activeUsers:0,capacity:{availableSlots:10,totalSlots:10}}));
 app.get('/api/admin/sandbox/proxies',(_req,res)=>res.json({servers:removed?[]:[serverRow()],assignments}));
 app.post('/api/admin/sandbox/proxies',(req,res)=>{assert.equal(req.body.name,'New proxy');creates++;res.status(201).json({bootstrap:{format:1,serverUid:'cgp_'+'a'.repeat(18),serverToken:'fixture-only-not-a-real-token'}});});
 app.patch('/api/admin/sandbox/nodes/:id/proxy',(req,res)=>{if(rejectAssign){rejectAssign=false;return res.status(409).json({error:'Update this node first.'});}assignments=req.body.serverId?[{nodeId:1,serverId:req.body.serverId}]:[];res.json({applies:'next_sandbox_start'});});
 app.patch('/api/admin/sandbox/proxies/:id',(req,res)=>{enabled=req.body.enabled;res.json({server:serverRow()});});
 app.delete('/api/admin/sandbox/proxies/:id',(_req,res)=>{removed=true;res.json({removed:true});});
 app.use(express.static(root));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),wss=new WebSocketServer({server});let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_BROWSER_CHANNEL?{channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL}:{})});
  const results=[];
  for(const width of [1440,375,320]){
   enabled=true;assignments=[];removed=false;const context=await browser.newContext({viewport:{width,height:1000},acceptDownloads:true,reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));await page.goto('http://127.0.0.1:'+server.address().port+'/fixture');
   await page.locator('[data-sandbox-tab=proxies]').click();await page.locator('[data-proxy-node="1"]').waitFor();
   assert.equal(await page.locator('#proxy-servers h3').innerText(),'Proxy <fixture>');assert.equal(await page.locator('#proxy-servers fixture').count(),0);
   assert.match(await page.locator('#proxy-servers').innerText(),/2 sandbox/);assert.equal(await page.locator('[data-proxy-remove-ip]').isDisabled(),true);
   assert.equal(await page.locator('#proxy-servers').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'populated proxy cards fit viewport');
   if(process.env.CORNGRID_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.CORNGRID_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.CORNGRID_UI_SCREENSHOT_DIR,'proxy-admin-'+width+'.png'),fullPage:true});}
   await page.locator('#proxy-add').click();await page.locator('#proxy-name').fill('New proxy');await page.locator('#proxy-host').fill('proxy.example.test');
   const bounds=await page.locator('#proxy-create-dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1,'dialog fits viewport');
   await page.locator('#proxy-create-form [type=submit]').click();await page.locator('#proxy-bootstrap-dialog').waitFor();
   const download=page.waitForEvent('download');await page.locator('#proxy-download-bootstrap').click();assert.match((await download).suggestedFilename(),/^CornGrid-Proxy-/);
   await page.keyboard.press('Escape');await page.locator('[data-proxy-node="1"]').click();await page.locator('#proxy-assign-server').selectOption('1');
   rejectAssign=true;await page.locator('#proxy-assign-form [type=submit]').click();await page.locator('#proxy-assign-error').waitFor();assert.equal(await page.locator('#proxy-assign-form [type=submit]').isEnabled(),true);
   await page.locator('#proxy-assign-form [type=submit]').click();await page.locator('#proxy-assign-dialog').waitFor({state:'hidden'});assert.equal(assignments[0].serverId,1);
   await page.locator('[data-proxy-toggle="1"]').click();assert.match(await page.locator('#proxy-confirm-text').innerText(),/connections will close/);await page.locator('#proxy-confirm-action').click();await page.locator('#proxy-confirm-dialog').waitFor({state:'hidden'});assert.equal(enabled,false);
   await page.locator('[data-proxy-node="1"]').click();await page.locator('#proxy-assign-server').selectOption('');await page.locator('#proxy-assign-form [type=submit]').click();await page.locator('#proxy-assign-dialog').waitFor({state:'hidden'});assert.deepEqual(assignments,[]);
   await page.locator('[data-proxy-remove-server="1"]').click();await page.locator('#proxy-confirm-action').click();await page.locator('#proxy-confirm-dialog').waitFor({state:'hidden'});
   assert.equal(await page.locator('#proxy-servers').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'proxy content has no horizontal overflow');
   assert.deepEqual(errors,[]);results.push({width,bootstrapDownload:true,sharedIp:true,assignmentRecovery:true,disable:true,remove:true});await context.close();
  }
  assert.equal(creates,3);console.log(JSON.stringify({isolated:true,results}));
 }finally{if(browser)await browser.close();for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
