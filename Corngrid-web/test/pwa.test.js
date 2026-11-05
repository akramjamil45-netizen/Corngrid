const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/pwa.js'), 'utf8');

function browser({ standalone = false, ios = false } = {}) {
  const events = {}, storage = new Map(), notices = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.events = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(name, fn) { this.events[name] = fn; }
    remove() { notices.splice(notices.indexOf(this), 1); }
    querySelector(selector) {
      const all = this.children.flatMap(c => [c, ...c.children]);
      return all.find(c => selector.includes('span') ? c.tag === 'span' : selector === 'strong' ? c.tag === 'strong' : selector === '.pwa-dismiss' ? c.className === 'pwa-dismiss' : c.tag === 'button');
    }
  }
  const localStorage = { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  const context = { console, Date, localStorage, sessionStorage: localStorage,
    navigator: { standalone, userAgent: ios ? 'iPhone Safari' : 'Chrome', platform: '', maxTouchPoints: 0 },
    matchMedia: () => ({ matches: standalone }), MutationObserver: class { observe() {} },
    document: { readyState: 'complete', documentElement: { lang: 'ms' }, createElement: tag => new Element(tag), body: { append: node => notices.push(node) }, querySelectorAll: () => [...notices] }
  };
  context.window = context;
  context.addEventListener = (name, fn) => events[name] = fn;
  vm.createContext(context); vm.runInContext(source, context);
  const prompt = outcome => {
    let calls = 0;
    events.beforeinstallprompt({ preventDefault() {}, prompt: async () => { calls++; }, userChoice: Promise.resolve({ outcome }) });
    return () => calls;
  };
  return { context, events, notices, storage, prompt };
}

test('PWA eligibility, duplicate prevention, click-only prompt, and browser-confirmed installation', async () => {
  const b = browser(); assert.equal(b.notices.length, 0);
  const calls = b.prompt('accepted'); assert.equal(b.notices.length, 1); assert.equal(calls(), 0);
  assert.equal(b.notices[0].querySelector('strong').textContent, 'Pasang Aplikasi CornGrid');
  vm.runInContext(source, b.context); assert.equal(b.notices.length, 1);
  await b.notices[0].querySelector('button').events.click(); assert.equal(calls(), 1);
  b.events.appinstalled(); assert.equal(b.notices.length, 0);
  b.prompt('accepted'); assert.equal(b.notices.length, 0);
});
test('PWA dismissal persists across eligible events and installed apps stay quiet', () => {
  const b = browser(); b.prompt('dismissed');
  b.notices[0].querySelector('.pwa-dismiss').events.click();
  assert.ok(Number(b.storage.get('corngrid_install_dismissed_until')) > Date.now());
  b.prompt('accepted'); assert.equal(b.notices.length, 0);
  const installed = browser({ standalone: true }); installed.prompt('accepted'); assert.equal(installed.notices.length, 0);
});
test('iOS Safari offers manual instructions without invoking a native prompt', async () => {
  const b = browser({ ios: true }); assert.equal(b.notices.length, 1);
  await b.notices[0].querySelector('button').events.click();
  assert.match(b.notices[0].querySelector('.pwa-notice-copy span').textContent, /Safari/);
  assert.equal(b.notices[0].querySelector('button').hidden, true);
});

test('service worker never intercepts API responses, private uploads or mutations', () => {
  const handlers = {};
  const context = { self: { location: { origin: 'https://corngrid.com' }, addEventListener: (name, fn) => handlers[name] = fn }, URL, Set };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../sw.js'), 'utf8'), context);
  for(const [method, route] of [['GET','/api/public/portfolios'],['GET','/api/me'],['GET','/api'],['GET','/uploads/private.png'],['POST','/api/login']]) {
    let intercepted = false;
    handlers.fetch({ request: { method, url: 'https://corngrid.com'+route }, respondWith() { intercepted = true; } });
    assert.equal(intercepted,false,route);
  }
});
