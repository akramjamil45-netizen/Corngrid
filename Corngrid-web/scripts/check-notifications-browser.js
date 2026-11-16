'use strict';
const { spawn } = require('node:child_process'), path = require('node:path'), fs = require('node:fs'), vm = require('node:vm');
async function main() {
  const child = spawn(process.execPath, [path.join(__dirname, 'preview-notifications.js')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let browser;
  try {
    const origin = await new Promise((resolve, reject) => { let pending = ''; const timeout = setTimeout(() => reject(Error('Notification fixture startup timeout')), 15000); child.once('exit', () => { clearTimeout(timeout); reject(Error('Notification fixture exited')); }); child.stdout.on('data', chunk => { pending += chunk.toString(); for (const line of pending.split(/\r?\n/)) { try { const data = JSON.parse(line); if (data.isolated && new URL(data.url).hostname === '127.0.0.1') { clearTimeout(timeout); resolve(data.url); } } catch {} } }); });
    browser = await require('playwright').chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_BROWSER_CHANNEL ? { channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL } : {}) });
    const context = await browser.newContext(), page = await context.newPage(); await page.goto(origin);
    const check = vm.runInThisContext('(' + fs.readFileSync(path.join(__dirname, '../test/browser/notifications.browser.js'), 'utf8') + ')'); console.log(JSON.stringify(await check(page))); await context.close();
  } finally { if (browser) await browser.close(); if (child.exitCode == null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; } }
}
main().catch(error => { console.error('Notification browser acceptance failed:', error.message); process.exitCode = 1; });
