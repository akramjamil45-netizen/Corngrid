async (page) => {
  const origin = new URL(page.url()).origin, browser = page.context().browser(), results = [];
  for (const width of [1440, 375]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } }), p = await context.newPage(), errors = [];
    p.on('pageerror', error => errors.push(error.message));
    try {
      await p.goto(origin + '/fixture#notifications');
      await p.locator('#page-notifications.is-visible .nc-item').first().waitFor();
      if (await p.locator('.nc-item').count() !== 5) throw Error('Expected sandbox, EA, expiry, payment and legacy alerts');
      if (await p.locator('.nc-badge').textContent() !== '5') throw Error('Unread badge not synchronized');
      const overflow = await p.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('body *')].filter(e => e.getClientRects().length && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(e => ({ tag: e.tagName, id: e.id, class: e.className, width: e.getBoundingClientRect().width, right: e.getBoundingClientRect().right })) }));
      if (overflow.scroll > width) { await p.screenshot({ path: '../.playwright-mcp/notification-overflow-' + width + '.png', fullPage: true }); throw Error('Notification page overflows: ' + JSON.stringify(overflow)); }
      const bell = await p.locator('.nc-bell').boundingBox(); if (bell.x < 0 || bell.x + bell.width > width) throw Error('Bell exceeds viewport');
      await p.getByRole('button', { name: 'Alert settings', exact: true }).click();
      await p.locator('#notification-settings input[name="payment_status"]:enabled').waitFor();
      await p.locator('#notification-settings input[name="payment_status"]').uncheck();
      await p.locator('#notification-settings input[name="expiry_days"]').fill('14');
      await p.getByRole('button', { name: 'Save preferences', exact: true }).click();
      await p.getByText('Alert preferences saved.', { exact: true }).waitFor();
      const stored = await p.evaluate(async () => (await (await fetch('/api/notifications/preferences')).json()).preferences);
      if (stored.payment_status || stored.expiry_days !== 14) throw Error('Preferences did not persist');
      await p.reload(); await p.locator('.nc-bell').click();
      await p.getByRole('button', { name: 'Alert settings', exact: true }).click();
      await p.locator('#notification-settings input[name="payment_status"]:enabled').waitFor();
      if (await p.locator('#notification-settings input[name="payment_status"]').isChecked()) throw Error('Saved preference lost on reload');
      if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Settings page overflows');
      await p.locator('.nc-bell').click(); await p.locator('.nc-item').first().waitFor();
      await p.getByRole('button', { name: 'Mark all read', exact: true }).click(); await p.locator('.nc-badge[hidden]').waitFor({ state: 'attached' });
      await p.getByRole('button', { name: 'Clear all', exact: true }).click(); await p.locator('.nc-dialog[open]').waitFor();
      await p.getByRole('button', { name: 'Cancel', exact: true }).click(); if (await p.locator('.nc-item').count() !== 5) throw Error('Cancel removed history');
      await p.getByRole('button', { name: 'Clear all', exact: true }).click(); await p.getByRole('button', { name: 'Clear notifications', exact: true }).click();
      await p.getByText('No notifications to show.', { exact: true }).waitFor();
      if (errors.length) throw Error(errors.join('; '));
      results.push({ width, preferencesPersisted: true, badgeAndHistorySynchronized: true, horizontalOverflow: false });
      // Restore only isolated fixture preferences and history for the next width.
      await p.evaluate(async () => { await fetch('/api/notifications/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_status: true, expiry_days: 7 }) }); await fetch('/fixture/reset', { method: 'POST' }); });
    } finally { await context.close(); }
  }
  const ms = await browser.newContext({ viewport: { width: 375, height: 1000 } }), p = await ms.newPage();
  try { await p.addInitScript(() => localStorage.setItem('selectedLang', 'bm')); await p.goto(origin + '/fixture#notifications'); await p.getByRole('heading', { name: 'Notifikasi', exact: true }).waitFor(); await p.getByRole('button', { name: 'Tetapan amaran', exact: true }).click(); await p.getByRole('button', { name: 'Simpan tetapan', exact: true }).waitFor(); results.push({ language: 'ms', translatedSettings: true }); } finally { await ms.close(); }
  return results;
}
