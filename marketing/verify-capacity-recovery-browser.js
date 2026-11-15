async (page) => {
  const results = [];
  for (const scenario of ['request-lost', 'response-lost', 'offline', 'conflict', 'forbidden']) {
    const context = await page.context().browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const mobile = await context.newPage();
      const errors = [];
      mobile.on('pageerror', error => errors.push(error.message));
      await mobile.addInitScript(() => { window.WebSocket = class { addEventListener() {} close() {} }; });
      const node = { id: 4, name: 'CornGrid VPS80481', status: 'active', maxInstances: 2, usedSlots: 0, runningInstances: 0, online: true };
      let mutations = 0;
      await mobile.route('**/api/admin/sandbox/nodes', route => {
        if (scenario === 'offline' && mutations > 0) return route.abort('connectionreset');
        return route.fulfill({ json: { nodes: [node] } });
      });
      await mobile.route('**/api/admin/sandbox/overview', route => route.fulfill({ json: { nodes: { total: 1, online: 1, offline: 0 }, instances: { total: 0, running: 0, failed: 0 }, activeUsers: 0, capacity: { availableSlots: node.maxInstances, totalSlots: node.maxInstances } } }));
      await mobile.route('**/api/admin/sandbox/nodes/4/capacity', route => {
        mutations++;
        const body = route.request().postDataJSON();
        if (body.expectedMaxInstances !== 2 || body.maxInstances !== 5) throw Error('Unexpected save payload');
        if (scenario === 'forbidden') return route.fulfill({ status: 403, json: { error: 'Administrator session is invalid or has expired.' } });
        if (scenario === 'offline') return route.abort('connectionreset');
        if (scenario === 'conflict') { node.maxInstances = 4; return route.abort('connectionreset'); }
        if (scenario === 'response-lost') { node.maxInstances = 5; return route.abort('connectionreset'); }
        if (mutations === 1) return route.abort('connectionreset');
        node.maxInstances = 5;
        return route.fulfill({ json: { node } });
      });
      await mobile.goto('http://127.0.0.1:4319/', { waitUntil: 'domcontentloaded' });
      await mobile.evaluate(() => { window.CornGridAdminSandbox.openSandbox(); });
      await mobile.locator('[data-node-capacity="4"]').waitFor({ state: 'attached' });
      await mobile.evaluate(() => document.querySelector('[data-node-capacity="4"]').click());
      await mobile.locator('#sb-capacity-max').fill('5');
      await mobile.locator('#sb-capacity-save').click();
      const succeeds = ['request-lost', 'response-lost'].includes(scenario);
      if (succeeds) await mobile.waitForFunction(() => !document.querySelector('#sb-capacity-dialog').open);
      else await mobile.waitForFunction(() => !document.querySelector('#sb-capacity-error').hidden && !document.querySelector('#sb-capacity-save').disabled);
      const state = await mobile.evaluate(() => ({ open: document.querySelector('#sb-capacity-dialog').open, disabled: document.querySelector('#sb-capacity-save').disabled, cancelDisabled: document.querySelector('#sb-capacity-cancel').disabled, value: document.querySelector('#sb-capacity-max').value, error: document.querySelector('#sb-capacity-error').textContent, overflow: document.documentElement.scrollWidth > innerWidth }));
      const expected = scenario === 'request-lost' || scenario === 'offline' ? 2 : 1;
      if (mutations !== expected || state.disabled || state.cancelDisabled || state.overflow || state.open === succeeds || errors.length) throw Error('Capacity recovery failed: ' + scenario + ' ' + JSON.stringify({ state, mutations, errors }));
      if (scenario === 'offline' && !state.error.includes('could not be confirmed')) throw Error('Missing unconfirmed-outcome message');
      if (scenario === 'conflict' && !state.error.includes('another administrator')) throw Error('Missing conflict protection');
      results.push({ scenario, mutations, ...state, passed: true });
    } finally { await context.close(); }
  }
  return results;
}
