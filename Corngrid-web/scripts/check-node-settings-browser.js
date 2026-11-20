'use strict';
// Isolated UI fixture; no production database, credentials or trading sessions.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const express=require('express'),{WebSocketServer}=require('ws'),{chromium}=require('playwright');
async function main(){
 const app=express(),root=path.join(__dirname,'../public');app.use(express.json());
 const seed=()=>[{id:2,nodeUid:'node_second',name:'Secondary host',placementPriority:200,status:'active',maxInstances:10,usedSlots:0,online:true},
  {id:1,nodeUid:'node_first',name:'Primary host',placementPriority:100,status:'active',maxInstances:10,usedSlots:1,online:true}];
 let nodes=seed(),rejectNext=false;
 app.get('/fixture',(req,res)=>res.type('html').send(fs.readFileSync(path.join(root,'admin.html'),'utf8').replace(/<script\b[\s\S]*?<\/script>/gi,'').replace('</body>',
  '<script>document.querySelectorAll(".page").forEach(p=>{p.hidden=p.id!=="sandbox";p.classList.toggle("is-visible",p.id==="sandbox")});</script><script src="/admin-sandbox.js" defer></script></body>')));
 app.get('/api/admin/sandbox/nodes',(_req,res)=>res.json({nodes}));
 app.get('/api/admin/sandbox/overview',(_req,res)=>res.json({nodes:{total:2,online:2,offline:0},instances:{total:1,running:1,failed:0},activeUsers:1,capacity:{availableSlots:19,totalSlots:20}}));
 app.patch('/api/admin/sandbox/nodes/:id/settings',(req,res)=>{
  if(rejectNext){rejectNext=false;return res.status(409).json({error:'Node settings were changed by another administrator. Close this dialog, refresh and try again.'});}
  const node=nodes.find(n=>n.id===Number(req.params.id));assert.equal(req.body.expectedName,node.name);assert.equal(req.body.expectedPlacementPriority,node.placementPriority);
  node.name=req.body.name;node.placementPriority=req.body.placementPriority;res.json({node});
 });
 app.use(express.static(root));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),wss=new WebSocketServer({server});
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_BROWSER_CHANNEL?{channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL}:{})});
  const origin='http://127.0.0.1:'+server.address().port,results=[];
  for(const width of [1440,375,320]){
   nodes=seed();const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin+'/fixture');await page.locator('[data-node-settings="1"]').waitFor();
   assert.match(await page.locator('#sb-nodes-body tr').first().innerText(),/Primary host/);
   await page.locator('[data-node-settings="2"]').click();await page.locator('#sb-settings-dialog').waitFor();
   assert.equal(await page.locator('#sb-settings-name').inputValue(),'Secondary host');
   assert.equal(await page.locator('#sb-settings-priority').inputValue(),'200');
   await page.locator('#sb-settings-name').fill('Renamed <host>');await page.locator('#sb-settings-priority').fill('1');
   const geometry=await page.locator('#sb-settings-dialog').boundingBox();assert.ok(geometry.x>=0&&geometry.x+geometry.width<=width+1,'dialog must fit viewport');
   const screenshot=process.env.CORNGRID_UI_SCREENSHOT_DIR;
   if(screenshot){fs.mkdirSync(screenshot,{recursive:true});await page.screenshot({path:path.join(screenshot,'node-settings-'+width+'.png')});}
   rejectNext=true;await page.locator('#sb-settings-save').click();await page.locator('#sb-settings-error').waitFor();
   assert.equal(await page.locator('#sb-settings-save').isEnabled(),true);assert.equal(await page.locator('#sb-settings-name').inputValue(),'Renamed <host>');
   await page.locator('#sb-settings-save').click();await page.locator('#sb-settings-dialog').waitFor({state:'hidden'});
   await page.waitForFunction(()=>document.querySelector('#sb-nodes-body tr strong')?.textContent==='Renamed <host>');
   assert.equal(await page.locator('#sb-nodes-body host').count(),0,'names must render as escaped text');
   await page.locator('[data-node-settings="2"]').click();await page.keyboard.press('Escape');await page.locator('#sb-settings-dialog').waitFor({state:'hidden'});
   assert.deepEqual(errors,[]);results.push({width,save:true,errorRecovery:true,escapedName:true,keyboardDismiss:true});await context.close();
  }
  console.log(JSON.stringify({isolated:true,results}));
 }finally{if(browser)await browser.close();for(const client of wss.clients)client.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
