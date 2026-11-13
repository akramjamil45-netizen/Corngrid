'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function client(fetch) {
  // Load the real browser request/save functions without invoking DOM binding.
  const source = fs.readFileSync(path.join(__dirname, '../public/admin-sandbox.js'), 'utf8')
    .replace('window.CornGridAdminSandbox = {', 'window.testSaveCapacity = saveNodeCapacity; window.CornGridAdminSandbox = {');
  const window = { setTimeout: (fn, ms) => setTimeout(fn, ms === 750 ? 1 : Math.min(ms, 100)), clearTimeout };
  vm.runInNewContext(source, { window, document: { readyState: 'loading', addEventListener() {} }, fetch, AbortController, TypeError });
  return (limit = 5) => window.testSaveCapacity(4, limit, 2, () => {});
}
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('capacity recovers a dropped request by reading back and retrying the same absolute value once', async () => {
  const calls = [];
  const save = client(async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    if (calls.length === 1) throw new TypeError('Failed to fetch');
    if (url.endsWith('/nodes')) return json({ nodes: [{ id: 4, maxInstances: 2 }] });
    return json({ node: { id: 4, maxInstances: 5 } });
  });
  assert.equal((await save()).node.maxInstances, 5);
  assert.deepEqual(calls.map(c => c.method), ['PATCH', 'GET', 'PATCH']);
  assert.deepEqual(calls[0].body, { maxInstances: 5, expectedMaxInstances: 2 });
  assert.deepEqual(calls[0].body, calls[2].body);
});

test('a lost save response is confirmed from database state without sending another mutation', async () => {
  let mutations = 0;
  const save = client(async (url) => {
    if (url.endsWith('/capacity')) { mutations++; throw new TypeError('Failed to fetch'); }
    return json({ nodes: [{ id: 4, maxInstances: 5 }] });
  });
  assert.equal((await save()).node.maxInstances, 5);
  assert.equal(mutations, 1);
});

test('a prolonged outage or stalled connection has bounded attempts and reports an unconfirmed outcome', async () => {
  let mutations = 0;
  const save = client((url, options) => {
    if (url.endsWith('/capacity')) mutations++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  await assert.rejects(save(), /save could not be confirmed/);
  assert.equal(mutations, 2);
});

test('capacity recovery never overwrites another admin change or retries authorization and validation failures', async () => {
  let mutations = 0;
  const conflict = client(async url => {
    if (url.endsWith('/capacity')) { mutations++; throw new TypeError('Failed to fetch'); }
    return json({ nodes: [{ id: 4, maxInstances: 4 }] });
  });
  await assert.rejects(conflict(), /another administrator/); assert.equal(mutations, 1);
  for (const status of [400, 401, 403, 409]) {
    let calls = 0;
    const save = client(async () => { calls++; return json({ error: 'Rejected' }, status); });
    await assert.rejects(save(), /Rejected/); assert.equal(calls, 1);
  }
});
