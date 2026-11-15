async (page) => {
  // Run with the Playwright browser tool after navigating to the isolated
  // marketing/preview-corngrid-select.cjs /fixture URL. No database or live API.
  const origin = new URL(page.url()).origin;
  const browser = page.context().browser(), results = [];
  const check = (condition,message) => { if (!condition) throw Error(message); };
  for (const mobile of [false,true]) {
    const context = await browser.newContext({viewport:{width:mobile?375:1440,height:mobile?812:900},isMobile:mobile,hasTouch:mobile});
    try {
      const p = await context.newPage(), errors = [];
      p.on('pageerror',error => errors.push(error.message));
      await p.goto(origin+'/fixture');
      const menu = p.locator('.cg-select-popup'), period = p.locator('#period');
      const click = element => mobile ? element.tap() : element.click();
      await click(period);await menu.waitFor({state:'visible',timeout:5000});
      check(await menu.locator('.is-selected').textContent()==='30 days\u2713','Initial selection missing');
      check(await menu.locator('h2').textContent()==='Performance period','Accessible field title missing');
      await p.keyboard.press('Escape');
      check(await period.inputValue()==='30d','Cancel changed the form');
      check(await period.evaluate(e=>e===document.activeElement),'Focus not returned after Escape');
      check(await p.evaluate(()=>selectionEvents.change)===0,'Cancel dispatched a change');
      await click(period);await click(menu.getByRole('option',{name:'90 days',exact:true}));
      check(await period.inputValue()==='90d','Tap/click did not update native value');
      check(await p.evaluate(()=>selectionEvents.input===1&&selectionEvents.change===1),'Selection must emit input/change exactly once');
      await click(period);await click(menu.getByRole('option',{name:'90 days',exact:true}));
      check(await p.evaluate(()=>selectionEvents.change)===1,'Same selection emitted duplicate change');
      await period.focus();await p.keyboard.press('ArrowDown');await p.keyboard.press('Home');await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');
      check(await period.inputValue()==='7d','Keyboard navigation/selection failed');
      await click(period);await p.evaluate(()=>document.getElementById('period').value='custom');
      await p.waitForFunction(()=>document.querySelector('.cg-select-option.is-selected')?.textContent==='Custom range\u2713');
      await p.keyboard.press('Escape');
      await p.locator('button[type="reset"]').click();check(await period.inputValue()==='30d','Native form reset failed');
      await period.focus();await p.keyboard.press('a');
      check(await menu.getByRole('option').count()===6,'Short-list typeahead must not hide other options');
      await p.keyboard.press('Enter');check(await period.inputValue()==='all','Short-list typeahead failed');
      await click(period);await p.mouse.click(2,2);check(!await menu.isVisible(),'Outside tap did not cancel');
      await click(period);await p.evaluate(()=>document.getElementById('period').disabled=true);await menu.waitFor({state:'hidden'});
      await p.evaluate(()=>document.getElementById('period').disabled=false);
      await click(p.locator('#strategy'));await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter');
      check(await p.locator('#strategy').inputValue()==='partner','Disabled option/group not skipped');
      await click(p.locator('#strategy'));
      check(await menu.getByRole('option',{name:'Hidden option',exact:true}).count()===0,'Hidden option exposed');
      await click(menu.getByRole('option',{name:'Duplicate value option',exact:true}));
      check(await p.locator('#strategy').evaluate(e=>e.selectedIndex)===5,'Duplicate values lost their option index');
      await click(p.locator('#brokers'));
      const search = menu.getByRole('combobox');
      await search.fill('server 119');check(await menu.getByRole('option').count()===1,'Long-list search failed');
      await p.keyboard.press('Enter');check(await p.locator('#brokers').inputValue()==='119','Filtered selection failed');
      await click(p.locator('#brokers'));await search.fill('missing broker');
      check(await menu.locator('.cg-select-empty').isVisible(),'Search empty state missing');
      await search.fill('');await p.keyboard.press('Escape');
      await p.evaluate(()=>{const h=document.getElementById('dynamic');h.innerHTML='<label>Dynamic field<select id="dynamic-select" class="select-control"><option value="a">First</option></select></label>';});
      await click(p.locator('#dynamic-select'));
      await p.evaluate(()=>{const s=document.getElementById('dynamic-select');s.add(new Option('Text <img src=x onerror=alert(1)>','safe'));});
      await menu.getByRole('option',{name:'Text <img src=x onerror=alert(1)>',exact:true}).waitFor();
      check(await menu.locator('img').count()===0,'Option label was treated as HTML');
      await click(menu.getByRole('option',{name:'Text <img src=x onerror=alert(1)>',exact:true}));
      check(await p.locator('#dynamic-select').inputValue()==='safe','Dynamic option failed');
      await click(p.locator('#dynamic-select'));await p.evaluate(()=>document.getElementById('dynamic').replaceChildren());
      await menu.waitFor({state:'hidden'});
      for (const id of ['disabled','multiple','inline']) {
        await p.evaluate(id=>window.CornGridSelect.open(document.getElementById(id)),id);
        check(!await menu.isVisible(),'Non-popup native control should be preserved: '+id);
      }
      check(!await p.locator('#required').evaluate(e=>e.checkValidity()),'Required validation was bypassed');
      await click(p.locator('#required'));await click(menu.getByRole('option',{name:'CornGrid plan',exact:true}));
      check(await p.locator('#required').evaluate(e=>e.checkValidity()),'Required native field did not validate after selection');
      await p.locator('#show-nested').click();await click(p.locator('#nested-select'));
      await p.keyboard.press('Escape');check(await p.locator('#nested').evaluate(e=>e.open),'Escape closed the surrounding dialog');
      await click(p.locator('#nested-select'));await click(menu.getByRole('option',{name:'Second option',exact:true}));
      check(await p.locator('#nested-select').inputValue()==='b','Nested-dialog selection failed');
      await p.locator('#close-nested').click();
      for (const width of [320,375,768,1440]) {
        await p.setViewportSize({width,height:mobile?568:900});await click(period);
        const rect = await menu.evaluate(e=>({x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,right:e.getBoundingClientRect().right,bottom:e.getBoundingClientRect().bottom,vw:innerWidth,vh:innerHeight}));
        check(rect.x>=0&&rect.y>=0&&rect.right<=rect.vw&&rect.bottom<=rect.vh,'Menu outside viewport '+width);
        await p.keyboard.press('Tab');check(await menu.evaluate(e=>e.contains(document.activeElement)),'Focus escaped modal');
        await p.keyboard.press('Escape');
      }
      await p.setViewportSize({width:375,height:812});
      await p.evaluate(()=>document.body.classList.add('theme-light'));await click(period);
      const light = await menu.evaluate(e=>getComputedStyle(e).backgroundColor);
      check(light==='rgb(255, 255, 255)','Light theme did not use CornGrid theme tokens');
      await p.keyboard.press('Escape');
      if (mobile) {
        await click(p.locator('#brokers'));
        await p.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,value:400});window.visualViewport.dispatchEvent(new Event('resize'));});
        const keyboardBottom=await menu.evaluate(e=>e.getBoundingClientRect().bottom);
        check(keyboardBottom<=400,'Search menu would be obscured by the virtual keyboard');
        await p.keyboard.press('Escape');
      }
      check(errors.length===0,'Browser errors: '+errors.join('; '));
      results.push({mobile,pointerAndKeyboard:true,eventsOnce:true,cancelAndFocus:true,searchAndDynamicOptions:true,disabledAndRequired:true,nestedDialogs:true,themesAndBounds:true});
    } finally { await context.close(); }
  }
  const fallback=await browser.newContext();
  try{
    await fallback.addInitScript(()=>{HTMLDialogElement.prototype.showModal=undefined;});
    const p=await fallback.newPage();await p.goto(origin+'/fixture');
    check(await p.evaluate(()=>!window.CornGridSelect),'Unsupported browser did not retain native fallback');
    await p.locator('#period').selectOption('today');check(await p.locator('#period').inputValue()==='today','Native fallback unusable');
    results.push({nativeFallback:true});
  }finally{await fallback.close();}
  return results;
}
