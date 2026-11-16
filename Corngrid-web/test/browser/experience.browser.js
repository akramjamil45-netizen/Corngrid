async page => {
  const origin = new URL(page.url()).origin, browser = page.context().browser(), results = [];
  for (const width of [1440, 375, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', ...(width < 600 ? { hasTouch: true, isMobile: true } : {}) }), p = await context.newPage(), errors = [];
    p.on('pageerror', error => errors.push(error.message));
    const scenario = value => p.evaluate(async scenario => { await fetch('/fixture/scenario', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario }) }); }, value);
    const unread = count => p.evaluate(async unreadCount => { const response = await fetch('/fixture/chat-unread', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ unreadCount }) }); if (!response.ok) throw Error('Unread fixture failed'); }, count);
    const go = async value => {
      if (width < 600 && ['feed', 'chat', 'overview', 'sandbox'].includes(value)) await p.locator('.cg-mobile-nav [data-destination="' + value + '"]').click();
      else { if (width < 600 && !await p.locator('#sidebar').evaluate(node => node.classList.contains('is-open'))) await p.locator('.cg-mobile-nav [data-destination="more"]').click(); await p.locator('.main-nav .nav-item[data-page="' + value + '"]').click(); }
    };
    const noOverflow = async label => { const state = await p.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('body *')].filter(node => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(node => ({ tag: node.tagName, id: node.id, class: node.className })) })); if (state.scroll > state.width) throw Error(label + ': ' + JSON.stringify(state)); };
    try {
      await p.goto(origin + '/fixture#overview'); await scenario('normal'); await unread(2); await p.reload();
      await p.waitForFunction(() => document.getElementById('mobile-chat-unread')?.textContent === '2' && !document.getElementById('mobile-chat-unread').hidden);
      await p.getByRole('heading', { name: 'No setup issues detected', exact: true }).waitFor();
      const setupToggle = p.getByRole('button', { name: 'Setup details', exact: true });
      if (await p.locator('#overview-setup-details').isVisible() || (await p.locator('.cg-attention').boundingBox()).height > 90) throw Error('Healthy Overview status is not compact');
      await p.screenshot({ path:'../.playwright-mcp/experience-compact-overview-' + width + '.png' });
      await setupToggle.focus(); await p.keyboard.press('Enter'); await p.locator('#overview-setup-details').waitFor();
      if (await p.locator('#overview-setup-details .cg-checklist li').count() !== 4 || await setupToggle.getAttribute('aria-expanded') !== 'true') throw Error('Setup details did not expand accessibly');
      await p.waitForFunction(() => document.querySelectorAll('.cg-shortcut').length === 3);
      if (await p.locator('#sidebar .cg-shortcut,#sidebar .cg-shortcut-settings,#sidebar .cg-pinned').count()) throw Error('Pinned shortcuts must not appear in navigation');
      await noOverflow('Overview');
      const mobileLabels = await p.locator('.cg-mobile-nav .cg-mobile-label').allTextContents();
      if (JSON.stringify(mobileLabels) !== JSON.stringify(['Live Feed','Chat','Overview','Sandbox','More'])) throw Error('Mobile navigation must have five ordered destinations');
      if (width < 600) {
        await p.emulateMedia({ reducedMotion:'no-preference' });
        if (await p.locator('.cg-mobile-nav').evaluate(node => getComputedStyle(node).transitionDuration) === '0s') throw Error('Navigation slide animation is missing');
        await p.waitForTimeout(350); // Wait for navigation's post-route scroll guard.
        await p.mouse.move(width / 2, 550); await p.mouse.wheel(0, 350);
        await p.waitForFunction(() => document.querySelector('.cg-mobile-nav').getBoundingClientRect().top >= innerHeight);
        await p.screenshot({ path:'../.playwright-mcp/navigation-hidden-' + width + '.png' });
        await p.mouse.wheel(0, -120);
        await p.waitForFunction(() => document.querySelector('.cg-mobile-nav').getBoundingClientRect().top < innerHeight - 40);
        await p.mouse.wheel(0, 4); await p.waitForTimeout(100);
        if (await p.locator('.cg-mobile-nav').evaluate(node => node.classList.contains('is-scroll-hidden'))) throw Error('Tiny scroll jitter hid navigation');
        await p.mouse.wheel(0, 180); await p.waitForFunction(() => document.querySelector('.cg-mobile-nav').classList.contains('is-scroll-hidden'));
        await p.locator('.cg-mobile-nav [data-destination=feed]').focus();
        await p.waitForFunction(() => !document.querySelector('.cg-mobile-nav').classList.contains('is-scroll-hidden'));
        await go('feed'); await p.locator('#page-feed.is-visible').waitFor();
        if (await p.locator('.cg-mobile-nav [data-destination=feed]').getAttribute('aria-current') !== 'page') throw Error('Live Feed shortcut did not navigate');
        await go('chat'); await p.locator('#page-chat.is-visible').waitFor();
        if (await p.locator('.cg-mobile-nav [data-destination=chat]').getAttribute('aria-current') !== 'page' || await p.locator('.cg-mobile-nav [data-destination=feed]').getAttribute('data-active') !== 'false') throw Error('Chat did not have its own active destination');
        await p.locator('#chat-user-list .chat-empty-list').waitFor();
        await p.locator('#chat-user-list').evaluate(list => { const filler = document.createElement('div'); filler.style.height = '1800px'; list.append(filler); });
        await p.waitForTimeout(350); await p.locator('#chat-user-list').hover(); await p.mouse.wheel(0, 260);
        await p.waitForFunction(() => document.querySelector('.cg-mobile-nav').classList.contains('is-scroll-hidden'));
        await p.mouse.wheel(0, -100); await p.waitForFunction(() => !document.querySelector('.cg-mobile-nav').classList.contains('is-scroll-hidden'));
        await p.locator('.cg-mobile-nav [data-destination=more]').click(); await p.locator('#sidebar.is-open').waitFor();
        await p.locator('#sidebar .main-nav').evaluate(nav => { nav.scrollTop = 150; });
        if (await p.locator('.cg-mobile-nav').evaluate(node => node.classList.contains('is-scroll-hidden'))) throw Error('Sidebar scrolling hid the shortcut bar');
        await p.keyboard.press('Escape'); await go('overview'); await p.evaluate(() => window.scrollTo(0,0));
        await p.emulateMedia({ reducedMotion:'reduce' });
        if (await p.locator('.cg-mobile-nav').evaluate(node => getComputedStyle(node).transitionDuration) !== '0s') throw Error('Navigation ignores reduced motion');
        await noOverflow('Five mobile shortcuts'); await p.screenshot({ path:'../.playwright-mcp/navigation-five-' + width + '.png' });
      }
      await go('chat');
      const refreshChat = async () => { await p.locator('#refresh-chat-btn').click(); await p.waitForFunction(() => !document.getElementById('refresh-chat-btn').disabled); };
      await p.emulateMedia({ reducedMotion:'no-preference' });
      await p.evaluate(() => { window.chatBubblePops = 0; document.getElementById('mobile-chat-unread').addEventListener('animationstart', () => window.chatBubblePops++); });
      const expectedPops = width < 600 ? 1 : 0;
      await unread(5); await refreshChat(); await p.waitForFunction(expected => document.getElementById('mobile-chat-unread').textContent === '5' && window.chatBubblePops === expected, expectedPops);
      if (await p.locator('.cg-mobile-nav [data-destination=chat]').getAttribute('aria-label') !== 'Chat, 5 unread messages' || await p.locator('#chat-nav-badge').textContent() !== '5') throw Error('Chat unread badge or accessible label is out of sync');
      await refreshChat(); if (await p.evaluate(() => window.chatBubblePops) !== expectedPops) throw Error('An unchanged unread count repeated the animation');
      await unread(3); await refreshChat(); if (await p.locator('#mobile-chat-unread').textContent() !== '3' || await p.evaluate(() => window.chatBubblePops) !== expectedPops) throw Error('A partial read did not update quietly');
      await p.route('**/api/chat/unread-count', route => route.fulfill({ status:503,contentType:'application/json',body:JSON.stringify({ error:'Fixture unavailable' }) }));
      await refreshChat(); if (await p.locator('#mobile-chat-unread').textContent() !== '3' || await p.locator('#chat-nav-badge').evaluate(node => node.hidden)) throw Error('A transient refresh failure erased unread counts');
      await p.unroute('**/api/chat/unread-count'); await p.emulateMedia({ reducedMotion:'reduce' });
      await unread(120); await refreshChat(); await p.waitForFunction(() => document.getElementById('mobile-chat-unread').textContent === '99+');
      if (await p.locator('#mobile-chat-unread').evaluate(node => getComputedStyle(node).animationName) !== 'none') throw Error('Chat bubble ignores reduced motion');
      await noOverflow('Chat unread bubble'); if (width < 600) await p.screenshot({ path:'../.playwright-mcp/chat-unread-bubble-' + width + '.png' });
      await unread(0); await refreshChat();
      if (!await p.locator('#mobile-chat-unread').evaluate(node => node.hidden) || !await p.locator('#chat-nav-badge').evaluate(node => node.hidden) || await p.locator('.cg-mobile-nav [data-destination=chat]').getAttribute('aria-label') !== 'Chat') throw Error('Reading all messages did not clear both chat badges');
      if (width < 600) {
        const peer = { id:2,username:'Fixture trader',bio:'Isolated fixture' }, messageTime = Date.now();
        await p.route('**/api/chat/conversations', route => route.fulfill({ json:{ conversations:[{ peerId:2,username:peer.username,lastMessage:'Fixture message',lastMessageAt:Date.now(),unreadCount:0 }] } }));
        await p.route('**/api/chat/messages/2', route => route.fulfill({ json:{ peer,messages:Array.from({ length:35 },(_,index)=>({ id:index+1,message:'Fixture message ' + index,isMine:index%2===0,createdAt:messageTime,readAt:null })) } }));
        await refreshChat(); await p.locator('[data-chat-peer="2"]').click(); await p.locator('#chat-composer-form').waitFor();
        await p.waitForFunction(() => document.querySelectorAll('#chat-messages-stream .chat-row').length === 35);
        const composer = p.locator('#chat-composer-text'); await composer.fill('Fixture unsent draft');
        const nearKeyboard = () => p.waitForFunction(() => {
          const viewport = window.visualViewport, bottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight), rect = document.getElementById('chat-composer-form').getBoundingClientRect();
          return document.body.classList.contains('cg-keyboard-open') && bottom - rect.bottom >= 6 && bottom - rect.bottom <= 26;
        });
        await p.setViewportSize({ width,height:520 }); await nearKeyboard();
        if (await p.locator('.cg-mobile-nav').isVisible() || await composer.inputValue() !== 'Fixture unsent draft') throw Error('Keyboard layout lost the draft or kept the shortcut bar');
        if (await p.locator('#chat-messages-stream').evaluate(node => node.scrollHeight-node.scrollTop-node.clientHeight) > 3) throw Error('Keyboard resize hid the latest message');
        await p.screenshot({ path:'../.playwright-mcp/chat-keyboard-resized-' + width + '.png' });
        await p.setViewportSize({ width,height:1000 }); await p.waitForFunction(() => !document.body.classList.contains('cg-keyboard-open'));
        const readingPosition = await p.locator('#chat-messages-stream').evaluate(async stream => { stream.scrollTop = 200; await new Promise(requestAnimationFrame); return stream.scrollTop; });
        if (readingPosition < 100) throw Error('Keyboard test did not open a scrollable conversation');
        await p.evaluate(() => { Object.defineProperty(visualViewport,'height',{ configurable:true,value:520 }); Object.defineProperty(visualViewport,'offsetTop',{ configurable:true,value:60 }); visualViewport.dispatchEvent(new Event('resize')); });
        await nearKeyboard();
        await p.evaluate(() => { Object.defineProperty(visualViewport,'offsetTop',{ configurable:true,value:110 }); visualViewport.dispatchEvent(new Event('scroll')); }); await nearKeyboard();
        if (Math.abs(await p.locator('#chat-messages-stream').evaluate(node => node.scrollTop) - readingPosition) > 3) throw Error('Keyboard resize moved a reader away from older messages');
        await p.evaluate(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); });
        await p.waitForFunction(() => !document.body.classList.contains('cg-keyboard-open'));
        if (await composer.inputValue() !== 'Fixture unsent draft' || !await p.locator('.cg-mobile-nav').isVisible()) throw Error('Closing the keyboard lost the draft or navigation');
        await p.evaluate(() => { Object.defineProperty(visualViewport,'scale',{ configurable:true,value:2 }); Object.defineProperty(visualViewport,'height',{ configurable:true,value:520 }); visualViewport.dispatchEvent(new Event('resize')); });
        await p.waitForTimeout(50);
        if (await p.locator('body').evaluate(node => node.classList.contains('cg-keyboard-open'))) throw Error('Pinch zoom was mistaken for the keyboard');
        await p.evaluate(() => { delete visualViewport.scale; delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
        await composer.blur(); await p.unroute('**/api/chat/conversations'); await p.unroute('**/api/chat/messages/2');
      }
      await go('overview'); await p.evaluate(() => window.scrollTo(0,0));
      await p.waitForFunction(() => document.querySelector('#page-overview').dataset.loaded === 'true');
      await p.route('**/api/portfolio?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture portfolio refresh failed' }) }));
      await p.locator('#refresh-button').click(); await p.locator('#overview-refresh-feedback').getByText('Account data could not refresh', { exact: true }).waitFor();
      if (!(await p.locator('[data-stat=balance]').textContent()).includes('100')) throw Error('A same-account failed refresh removed its last balance');
      if (await setupToggle.getAttribute('aria-expanded') !== 'true' || !await p.locator('#overview-setup-details').isVisible()) throw Error('A refresh closed setup details while being read');
      await setupToggle.focus(); await p.keyboard.press('Space'); await p.locator('#overview-setup-details').waitFor({ state:'hidden' });
      await p.locator('#period-select').evaluate(select => { select.value = '7d'; select.dispatchEvent(new Event('change', { bubbles: true })); });
      await p.waitForFunction(() => document.querySelector('#live-label').textContent === 'STATUS UNKNOWN');
      if (await p.locator('[data-stat=balance]').textContent() !== 'N/A') throw Error('A different filter showed the previous balance');
      await p.unroute('**/api/portfolio?*'); await p.locator('#refresh-button').click(); await p.waitForFunction(() => document.querySelector('#page-overview').dataset.loaded === 'true');
      if ((await p.locator('.cg-mobile-nav').isVisible()) !== (width < 600)) throw Error('Incorrect mobile navigation visibility');
      await p.locator('.cg-skip-link').focus(); await p.keyboard.press('Enter'); if (await p.evaluate(() => document.activeElement.id) !== 'cg-main-content') throw Error('Skip link did not focus content');
      if (width < 600) { await p.locator('.cg-mobile-nav [data-destination=more]').click(); await p.locator('#sidebar.is-open').waitFor(); await p.keyboard.press('Escape'); await p.locator('#sidebar:not(.is-open)').waitFor(); }
      if (width < 600) await p.locator('.cg-mobile-nav [data-destination=more]').click();
      await p.locator('#sidebar .nav-item[data-page=settings]').click();
      await p.getByRole('button', { name: 'Appearance', exact: true }).click();
      await p.locator('#setting-appearance').getByRole('heading', { name: 'Pinned shortcuts', exact: true }).waitFor();
      await noOverflow('Shortcut settings');
      await p.screenshot({ path: '../.playwright-mcp/experience-shortcut-settings-' + width + '.png', fullPage: true });
      await p.locator('#setting-appearance').getByRole('button', { name: 'Edit shortcuts', exact: true }).click();
      const dialog = p.locator('.cg-dialog[open]'); await dialog.waitFor();
      const checked = dialog.locator('input:checked'); while (await checked.count()) await checked.first().uncheck();
      await dialog.locator('input[value=overview]').check(); await dialog.locator('input[value=subscription]').check(); await dialog.getByRole('button', { name: 'Save shortcuts', exact: true }).click();
      await p.reload(); await p.waitForFunction(() => document.querySelectorAll('.cg-shortcut').length === 2);
      await p.goto(origin + '/fixture?user=2#overview'); await p.waitForFunction(() => document.querySelectorAll('.cg-shortcut').length === 3);
      await p.goto(origin + '/fixture?user=1#overview'); await p.waitForFunction(() => document.querySelectorAll('.cg-shortcut').length === 2);
      await scenario('new'); await p.reload(); await p.locator('#overview-attention').getByRole('heading', { name: 'Link your first MT5 account', exact: true }).waitFor();
      if (await p.locator('.cg-checklist li[data-complete=true]').count()) throw Error('New user setup was falsely marked complete');
      await noOverflow('New user checklist');
      await scenario('normal'); await go('sandbox'); await p.locator('#sandbox-health .cg-status-card').first().waitFor();
      if (await p.locator('#sandbox-health .cg-status-card').count() !== 3) throw Error('Separate host/MT5/EA signals missing');
      await p.locator('#sandbox-health .cg-status-card').nth(1).getByText('Not verified', { exact: true }).waitFor();
      await p.locator('#sandbox-health .cg-status-card').nth(2).getByText('Reporting', { exact: true }).waitFor();
      if (await p.getByText('EA: Trading', { exact: true }).count()) throw Error('Process state falsely claims trading');
      const sandboxSpacing = await p.locator('.sandbox-picker-panel').evaluate(picker => {
        const bounds = picker.getBoundingClientRect(), checked = document.getElementById('sandbox-last-checked').getBoundingClientRect(), health = document.getElementById('sandbox-health').getBoundingClientRect();
        return { checkedInside:picker.contains(document.getElementById('sandbox-last-checked')) && checked.bottom <= bounds.bottom, gap:health.top-bounds.bottom, emptyLoadingVisible:document.getElementById('sandbox-loading').getClientRects().length > 0 };
      });
      if (!sandboxSpacing.checkedInside || sandboxSpacing.emptyLoadingVisible || sandboxSpacing.gap < 0 || sandboxSpacing.gap > 28) throw Error('Excess Sandbox spacing: ' + JSON.stringify(sandboxSpacing));
      await noOverflow('Sandbox');
      await p.screenshot({ path: '../.playwright-mcp/experience-sandbox-' + width + '.png', fullPage: true });
      await scenario('offline'); await go('sandbox'); await p.locator('#sandbox-next-action').getByText('Hosting node is offline', { exact: true }).waitFor();
      await p.route('**/api/sandbox/status*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture refresh failed' }) }));
      await go('sandbox'); await p.locator('#sandbox-refresh-feedback').getByText('Sandbox status could not refresh', { exact: true }).waitFor();
      if (await p.locator('#sandbox-health .cg-status-card').count() !== 3) throw Error('A failed refresh removed prior sandbox signals');
      await p.unroute('**/api/sandbox/status*');
      for (const [value, state, title] of [['normal', 'active', 'Access active'], ['review', 'verification', 'Awaiting administrator review'], ['pending', 'payment', 'Complete your card payment'], ['paid', 'active', 'Access active'], ['rejected', 'incomplete', 'Payment not completed']]) {
        await scenario(value); await go('subscription'); await p.locator('#checkout-progress[data-state="' + state + '"]').getByRole('heading', { name: title, exact: true }).waitFor();
        if (await p.locator('#checkout-progress ol li').count() !== 4) throw Error('Checkout step count differs'); await noOverflow('Checkout ' + value);
        const layout = await p.locator('#checkout-progress').evaluate(panel => {
          const bounds = panel.getBoundingClientRect(), style = getComputedStyle(panel), steps = [...panel.querySelectorAll('ol li')];
          return { padding:parseFloat(style.paddingLeft), columns:getComputedStyle(panel.querySelector('ol')).gridTemplateColumns.split(' ').length,
            overlaps:steps.some(step => step.querySelector('strong').getBoundingClientRect().bottom > step.querySelector('small').getBoundingClientRect().top + 1),
            outside:steps.some(step => { const r = step.getBoundingClientRect(); return r.left < bounds.left + 14 || r.right > bounds.right - 14; }),
            messageOverlaps:panel.querySelector('ol').getBoundingClientRect().bottom > panel.querySelector('.cg-checkout-message').getBoundingClientRect().top,
            checkedGap:document.getElementById('subscription-last-checked').getBoundingClientRect().top - bounds.bottom };
        });
        if (layout.padding < 14 || layout.overlaps || layout.outside || layout.messageOverlaps || layout.checkedGap < 0 || layout.checkedGap > 20 || layout.columns !== (width < 600 ? 2 : 4)) throw Error('Crowded checkout layout: ' + JSON.stringify(layout));
        if (value === 'rejected') await p.screenshot({ path:'../.playwright-mcp/experience-checkout-' + width + '.png',fullPage:true });
      }
      await scenario('normal'); await go('subscription'); await p.locator('#checkout-progress[data-state=active]').waitFor();
      await scenario('subscription-error'); await go('subscription'); await p.locator('#subscription-refresh-feedback').getByText('Could not refresh subscription', { exact: true }).waitFor();
      if (!(await p.locator('#subscription-status-content').textContent()).includes('Fixture plan')) throw Error('A failed refresh removed the previous subscription');
      await scenario('normal'); await p.locator('#subscription-refresh-feedback').getByRole('button', { name: 'Try again', exact: true }).click(); await p.locator('#subscription-refresh-feedback[hidden]').waitFor({ state: 'attached' });
      await go('notifications'); await p.getByRole('tab', { name: 'All', exact: true }).waitFor(); await p.getByRole('tab', { name: 'All', exact: true }).focus(); await p.keyboard.press('ArrowRight');
      if (await p.getByRole('tab', { name: 'Unread', exact: true }).getAttribute('aria-selected') !== 'true') throw Error('Tab keyboard navigation failed');
      await p.getByRole('button', { name: 'More notification actions', exact: true }).click(); await p.keyboard.press('Escape'); if (await p.locator('.nc-toolbar details[open]').count()) throw Error('Menu Escape did not close');
      await noOverflow('Notifications');
      if (!await p.locator('body').evaluate(node => node.classList.contains('theme-light'))) await p.locator('#theme-toggle').click();
      const contrast = await p.evaluate(() => { const c = getComputedStyle(document.body), luminance = text => { const rgb = text.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; }; const a = luminance(c.color), b = luminance(c.backgroundColor); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); });
      if (contrast < 4.5) throw Error('Light theme text contrast below 4.5');
      await p.screenshot({ path: '../.playwright-mcp/experience-light-' + width + '.png', fullPage: true });
      await p.locator('#theme-toggle').click();
      const calls = await p.evaluate(async () => (await (await fetch('/fixture/calls')).json()).calls);
      if (calls.some(call => call.method !== 'GET' && /^\/api\/sandbox\/(?:activate|start|stop|restart|pause|resume|reconnect)/.test(call.path))) throw Error('Navigation sent a trading control');
      if (errors.length) throw Error(errors.join('; '));
      await p.screenshot({ path: '../.playwright-mcp/experience-notifications-' + width + '.png', fullPage: true });
      results.push({ width, navigationAndPins: true, ownerScopedPins: true, realStatusLabels: true, checkoutStates: true, staleDataPreserved: true, keyboardAndContrast: true, noTradingActions: true });
    } catch (error) { await p.screenshot({ path: '../.playwright-mcp/experience-failure-' + width + '.png', fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  return results;
}
