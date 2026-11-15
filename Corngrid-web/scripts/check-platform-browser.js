'use strict';
const {spawn}=require('node:child_process'),path=require('node:path'),fs=require('node:fs'),vm=require('node:vm');
const {chromium}=require('playwright');
async function main(){
 const child=spawn(process.execPath,[path.join(__dirname,'preview-platform.js')],{stdio:['ignore','pipe','pipe'],windowsHide:true});let browser;
 try{
  const origin=await new Promise((resolve,reject)=>{let pending='';const timeout=setTimeout(()=>reject(Error('UI fixture startup timed out')),15000);child.once('exit',()=>{clearTimeout(timeout);reject(Error('UI fixture exited'));});child.stdout.on('data',chunk=>{pending+=chunk.toString();for(const line of pending.split(/\r?\n/)){try{const data=JSON.parse(line);if(data.isolated&&new URL(data.url).hostname==='127.0.0.1'){clearTimeout(timeout);resolve(data.url);}}catch{}}});});
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_BROWSER_CHANNEL?{channel:process.env.PLAYWRIGHT_BROWSER_CHANNEL}:{})});const context=await browser.newContext(),page=await context.newPage();await page.goto(origin);
  const test=vm.runInThisContext('('+fs.readFileSync(path.join(__dirname,'../test/browser/platform.browser.js'),'utf8')+')',{filename:'platform.browser.js'});console.log(JSON.stringify(await test(page)));await context.close();
 }finally{if(browser)await browser.close();if(child.exitCode==null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed;}}
}
main().catch(()=>{console.error('Isolated browser checks failed. Install Chromium with: npx playwright install chromium');process.exitCode=1;});
