'use strict';
// UI acceptance only, with deterministic API responses. The separate SQLite
// and PostgreSQL tests exercise the real grants, authentication and ledger.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const express = require('express');
async function main() {
  const app = express(), publicDir = path.resolve(__dirname, '../public');
  for (const kind of ['admin', 'dashboard']) app.get('/fixture/' + kind, (_req, res) => {
    let html = fs.readFileSync(path.join(publicDir, kind + '.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace('<head>', '<head><base href="/">').replace('</body>', `<script src="/interface.js"></script><script src="/experience-model.js"></script><script src="/${kind}.js"></script></body>`);
    res.type('html').send(html);
  });
  app.use(express.static(publicDir));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await require('playwright').chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });
    const context = await browser.newContext(); let saved = null, claimed = false, claimCalls = 0, paidDownloads = false;
    const starts = Date.now(), expires = starts + 14 * 86400000;
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      let data = {};
      if (p === '/api/admin/subscription-plans') {
        if (req.method() === 'POST') { saved = req.postDataJSON(); data = { id: 9 }; }
        else data = { plans: saved ? [{ id: 9, ...saved, is_active: 1, promotion_claim_count: 0 }] : [] };
      } else if (p === '/api/subscription/plans') data = {
        plans: [{ id:9,name:'Free trial',price:0,currency:'MYR',durationDays:14,maxActivations:2,isPromotion:true,promotionClaimed:claimed },
          { id:10,name:'Monthly plan',price:59,currency:'MYR',durationDays:30,maxActivations:5 }],
        promotionClaim: claimed ? {planName:'Free trial',startsAt:starts,expiresAt:expires} : null
      };
      else if (p === '/api/subscription/promotions/claim') { claimCalls++; claimed = true; data = { message:'Promotion claimed. Your free subscription is now active.' }; }
      else if (p === '/api/subscription/overview') data = { subscription:claimed ? {id:1,status:'active',planName:'Free trial',startsAt:starts,expiresAt:expires,maxActivations:2} : null, activations:[],payments:[],activationCount:0,maxActivations:claimed?2:0,daysRemaining:claimed?14:null };
      else if (p === '/api/me') data = {id:1,username:'UI fixture',email:'fixture@example.test',preferences:{theme:'dark'}};
      else if (p === '/api/mt5/accounts') data = {accounts:[]};
      else if (p === '/api/subscription/downloads') data = claimed && !paidDownloads ? {canDownload:false,reason:'promotion',versions:[]} : {canDownload:true,versions:[{id:77,version:'fixture',filename:'UI-fixture.ex5',releasedAt:starts}]};
      else if (p.includes('notifications')) data = {notifications:[],items:[],unreadCount:0};
      else if (p.includes('conversations')) data = {conversations:[]};
      else if (p.includes('unread')) data = {unreadCount:0};
      else if (p.includes('subscription-payments')) data = {payments:[]};
      else if (p.includes('subscriptions')) data = {subscriptions:[]};
      else if (p.includes('ea-downloads')) data = {versions:[]};
      else if (p.includes('users')) data = {users:[],total:0};
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
    });
    await context.route('https://**', route => route.abort());
    const admin = await context.newPage(); await admin.setViewportSize({width:375,height:812});
    await admin.goto(origin + '/fixture/admin#subscriptions');
    await admin.locator('#admin-plan-add').click();
    await admin.locator('#plan-promotion').check();
    assert.equal(await admin.locator('#plan-duration').inputValue(), '7');
    assert.equal(await admin.locator('#plan-max-act').inputValue(), '1');
    assert.equal(await admin.locator('#plan-price').isDisabled(), true);
    await admin.locator('#plan-name').fill('Free trial');
    await admin.locator('#plan-duration').fill('14'); await admin.locator('#plan-max-act').fill('2');
    await admin.locator('#admin-plan-create').click();
    await admin.locator('#admin-plans-table [data-sub-action="edit-plan"]').waitFor();
    assert.equal(saved.is_promotion,true); assert.equal(saved.price,0); assert.equal(saved.duration_days,14); assert.equal(saved.max_activations,2);
    await admin.locator('#admin-plans-table [data-sub-action="edit-plan"]').click();
    assert.equal(await admin.locator('#plan-duration').inputValue(), '14');
    assert.equal(await admin.locator('#plan-promotion').isChecked(), true);
    for (const width of [320,375,1280]) {
      await admin.setViewportSize({width,height:900});
      assert.equal(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,'admin overflow at '+width);
    }
    const user = await context.newPage(); await user.setViewportSize({width:375,height:812});
    await user.goto(origin + '/fixture/dashboard#subscription');
    const claim = user.locator('[data-claim-promotion="9"]'); await claim.waitFor();
    await user.locator('[data-ea-download="77"]').waitFor();
    assert.match(await claim.textContent(),/Claim free access/);
    await claim.click(); await user.waitForFunction(() => document.querySelector('[data-claim-promotion]')?.textContent === 'Promotion already claimed');
    assert.equal(claimCalls,1); assert.equal(await claim.isDisabled(),true);
    await user.waitForFunction(() => document.getElementById('subscription-downloads-section').hidden && !document.querySelector('[data-ea-download]'));
    assert.equal(await user.locator('[data-subscribe-plan="10"]').isEnabled(),true);
    await user.reload(); await user.locator('[data-claim-promotion="9"]').waitFor();
    assert.equal(await user.locator('[data-claim-promotion="9"]').isDisabled(),true);
    assert.equal(await user.locator('#subscription-downloads-section').isVisible(),false);
    for (const width of [320,375,1280]) {
      await user.setViewportSize({width,height:900});
      assert.equal(await user.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,'user overflow at '+width);
    }
    const out = path.resolve(__dirname,'../../marketing/promotion-review'); fs.mkdirSync(out,{recursive:true});
    await admin.setViewportSize({width:375,height:812}); await admin.locator('#plan-form').scrollIntoViewIfNeeded();
    await admin.screenshot({path:path.join(out,'admin-mobile.png')});
    await user.setViewportSize({width:375,height:812}); await claim.scrollIntoViewIfNeeded();
    await user.screenshot({path:path.join(out,'user-mobile.png')});
    paidDownloads = true; await user.reload(); await user.locator('[data-ea-download="77"]').waitFor();
    assert.equal(await user.locator('#subscription-downloads-section').isVisible(),true);
    console.log(JSON.stringify({passed:true,widths:[320,375,1280],adminDefaults:true,editableDuration:true,claimPersistsOnReload:true,paidButtonPreserved:true,promotionDownloadsHidden:true,paidDownloadsPreserved:true,screenshots:out}));
    await context.close();
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
