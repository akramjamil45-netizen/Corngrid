const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const register = require('../marketing-routes');
const root=path.join(__dirname,'../..');

test('public routes expose localized infrastructure and preserve the EA page before login static files',async t=>{
  const app=express();register(app,root);app.use(express.static(path.join(root,'Corngrid-web/public')));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  for(const [url,language] of [['/','ms'],['/en/','en'],['/index.html','ms']]){
    const response=await fetch(base+url);assert.equal(response.status,200);
    assert.match(response.headers.get('cache-control'),/no-transform/,'Prevent automatic edge analytics injection');
    const html=await response.text();assert.match(html,new RegExp('<html lang="'+language+'"'));
    assert.match(html,/data-public-page="infrastructure"/);assert.equal((html.match(/<h1>/g)||[]).length,1);
    assert.match(html,/cookie-consent\.js/);
    assert.match(html,/type="text\/plain" data-cg-consent="analytics"/);
    assert.doesNotMatch(html,/<script[^>]*\ssrc="https:\/\/static\.cloudflareinsights\.com/,'Beacon must remain inert before consent');
    assert.match(html,/hreflang="en"/);assert.match(html,/id="cgContactButton"/);
    assert.doesNotMatch(html,/aggregateRating|ratingCount|guaranteed returns/);
  }
  for(const [url,target] of [['/en','/en/'],['/corngrid-ea/','/corngrid-ea']]){
    const response=await fetch(base+url,{redirect:'manual'});assert.equal(response.status,301);assert.equal(response.headers.get('location'),target);
  }
  const ea=await (await fetch(base+'/corngrid-ea')).text();
  for(const url of ['/','/en/','/corngrid-ea']) {
    const html=await (await fetch(base+url)).text();
    assert.match(html,/href="\/promote\/terminal-app\/"/);
    assert.match(html,/href="\/portfolios"/);
    assert.match(html,/href="\/pwa.css"/);
    assert.equal((html.match(/id="cgContactButton"/g)||[]).length,1);
  }
  const appsResponse=await fetch(base+'/promote/terminal-app/');
  assert.equal(appsResponse.status,200);
  const apps=await appsResponse.text();
  const apkLink=apps.match(/href="(\/download\/CornGrid(?:-\d+\.\d+\.\d+)?\.apk)"/);
  assert.ok(apkLink,'Apps page links to a versioned or legacy CornGrid APK');
  assert.match(apps,/PromoI18n/);
  assert.ok(fs.statSync(path.join(root,apkLink[1].slice(1))).size>1000000);
  assert.match(ea,/id="setfiles"/);assert.match(ea,/id="setup"/);assert.match(ea,/id="cgContactButton"/);
  assert.match(ea,/canonical" href="https:\/\/corngrid.com\/corngrid-ea"/);
  assert.match(fs.readFileSync(path.join(root,'Corngrid-web/public/index.html'),'utf8'),/id="loginForm"/);
  const fallback=await fetch(base+'/api/subscription/plans');assert.equal(fallback.status,404,'marketing routes do not intercept APIs');
  const ms=await (await fetch(base+'/locales/ms.json')).json(),en=await (await fetch(base+'/locales/en.json')).json();
  assert.deepEqual(Object.keys(ms),Object.keys(en));
  for(const file of ['index.html','en/index.html','corngrid-ea.html']){
    const html=fs.readFileSync(path.join(root,file),'utf8');
    for(const match of html.matchAll(/data-site-i18n="([^"]+)"/g)){
      assert.equal(typeof ms[match[1]],'string',match[1]);assert.equal(typeof en[match[1]],'string',match[1]);
    }
  }
});
