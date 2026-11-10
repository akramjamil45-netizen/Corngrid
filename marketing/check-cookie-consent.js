async (page) => {
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};
  await page.route('https://static.cloudflareinsights.com/**',route=>route.fulfill({contentType:'text/javascript',body:'window.__cookieTestBeacon=(window.__cookieTestBeacon||0)+1;'}));
  await page.goto('http://127.0.0.1:4328/en/');
  await page.evaluate(()=>{localStorage.removeItem('cg_cookie_consent_v1');localStorage.removeItem('selectedLang');});
  await page.reload();
  assert(await page.locator('#cg-cookie-banner').isVisible(),'Fresh visitor sees banner');
  assert(!await page.evaluate(()=>CornGridConsent.allowed('analytics')),'Analytics defaults off');
  assert(!await page.evaluate(()=>[...document.scripts].some(s=>s.src.includes('cloudflareinsights'))),'No pre-consent beacon');
  await page.locator('#cg-cookie-banner [data-cookie-action="reject"]').click();
  await page.reload();
  assert(!await page.locator('#cg-cookie-banner').isVisible(),'Rejection persists');
  assert(!await page.evaluate(()=>CornGridConsent.allowed('analytics')),'Rejection prevents tracking');
  await page.locator('.cg-cookie-settings').click();
  assert(!await page.locator('#cg-cookie-analytics').isChecked(),'Analytics is not preselected');
  assert(await page.locator('#cg-cookie-marketing').isDisabled(),'Unused marketing category is disabled');
  await page.evaluate(()=>{document.cookie='_ga=cookie-test; Path=/';document.cookie='cg_cookie_test_essential=keep; Path=/';});
  await page.locator('#cg-cookie-analytics').check();
  await page.locator('#cg-cookie-dialog [data-cookie-action="save"]').click();
  await page.waitForFunction(()=>window.__cookieTestBeacon===1);
  assert(await page.evaluate(()=>document.cookie.includes('_ga=cookie-test')),'Allowed analytics cookie is preserved');
  assert(!await page.evaluate(()=>CornGridConsent.allowed('marketing')),'No consent is manufactured for unused pixels');
  await page.locator('.cg-cookie-settings').click();
  await page.locator('#cg-cookie-analytics').uncheck();
  await Promise.all([page.waitForEvent('load'),page.locator('#cg-cookie-dialog [data-cookie-action="save"]').click()]);
  assert(!await page.evaluate(()=>CornGridConsent.allowed('analytics')),'Withdrawal persists');
  assert(!await page.evaluate(()=>document.cookie.includes('_ga=')),'Withdrawal removes analytics cookies');
  assert(await page.evaluate(()=>document.cookie.includes('cg_cookie_test_essential=keep')),'Essential cookie survives');
  await page.evaluate(()=>localStorage.setItem('cg_cookie_consent_v1',JSON.stringify({version:1,analytics:true,marketing:false,updatedAt:Date.now()-181*86400000})));
  await page.reload();
  assert(await page.locator('#cg-cookie-banner').isVisible(),'Expired choice requires a new decision');
  assert(!await page.evaluate(()=>CornGridConsent.allowed('analytics')),'Expired choice never starts a tracker');
  const widths=[];
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:844});
    widths.push(await page.locator('#cg-cookie-banner').evaluate(e=>({width:innerWidth,withinViewport:e.getBoundingClientRect().right<=innerWidth&&e.getBoundingClientRect().left>=0,overflow:e.scrollWidth>e.clientWidth})));
  }
  assert(widths.every(item=>item.withinViewport&&!item.overflow),'Banner fits all tested screens');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'marketing/cookie-banner-mobile.png'});
  await page.locator('#cg-cookie-banner [data-cookie-action="manage"]').click();
  await page.screenshot({path:'marketing/cookie-settings-mobile.png'});
  await page.keyboard.press('Escape');
  assert(!await page.locator('#cg-cookie-dialog').evaluate(e=>e.open),'Escape closes settings');
  return {defaults:true,rejectPersists:true,analyticsLoadsAfterOptIn:true,withdrawal:true,essentialPreserved:true,expiry:true,widths};
}
