/* offline-sw — the service worker (sw.js) and the offline app shell.

   Runs the REAL sw.js in a small stand-in for the service-worker global
   (caches, fetch, clients), and checks the pages and the asset list.

     1. The asset list (js/sw-assets.js) is exactly what tools/sw-assets.mjs
        produces: every page, script, style and image -- so a page added
        later cannot be forgotten.
     2. Every page loads js/version.js and js/offline.js before storage.js.
     3. Install pre-caches every listed file into a cache named after the
        version; activate deletes older versions' caches.
     4. Business data is never touched: /api/* requests, non-GET requests and
        other origins are not intercepted at all.
     5. Online: network first; a good same-origin answer refreshes the cache,
        an error answer is never cached. Offline: the cached copy is served
        (query strings ignored); an unknown page falls back to the dashboard. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

(async () => {
  console.log('=== offline-sw: the offline app shell ===\n');

  console.log('-- 1. the asset list --');
  const gen = await import(path.join(ROOT, 'tools', 'sw-assets.mjs'));
  const list = gen.assetList();
  check('js/sw-assets.js is up to date (run: node tools/sw-assets.mjs)', fs.readFileSync(path.join(ROOT, 'js/sw-assets.js'), 'utf8'), gen.render(list));
  const pages = fs.readdirSync(path.join(ROOT, 'pages')).filter(f => f.endsWith('.html'));
  ok('it holds the dashboard, every page, script and style, and the manifest',
    ['/index.html', '/manifest.webmanifest', '/js/app.js', '/js/offline.js', '/js/version.js', '/css/style.css', '/assets/logo/logo-white.png', ...pages.map(p => `/pages/${p}`)].every(u => list.includes(u)), '');
  ok('   ...and nothing that must stay private (no src, tests, migrations, secrets)', !list.some(u => /^\/(src|tests|migrations|tools|node_modules)\/|\.sql$|dev\.vars|wrangler/.test(u)), '');

  console.log('\n-- 2. every page loads the offline scripts --');
  const missing = ['index.html', ...pages.map(p => `pages/${p}`)].filter(p => {
    const s = fs.readFileSync(path.join(ROOT, p), 'utf8');
    const v = s.indexOf('js/version.js"></script>'), o = s.indexOf('js/offline.js"></script>'), st = s.indexOf('js/storage.js"></script>');
    return !(v > -1 && o > v && st > o);
  });
  check('version.js, then offline.js, then storage.js -- on every page', missing, []);

  // ---- a stand-in service-worker global ----
  const version = (() => { const c = { self: {} }; vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/version.js'), 'utf8'), c); return c.self.TAQWA_VERSION; })();
  const ORIGIN = 'https://app.taqwa.autos';
  const stores = new Map();
  let network = 'online';
  const fetched = [];
  const mkResponse = (body, { status = 200, type = 'basic', redirected = false } = {}) => ({
    body, status, ok: status >= 200 && status < 300, type, redirected, clone() { return mkResponse(body, { status, type, redirected }); },
  });
  const keyOf = (r) => (typeof r === 'string' ? r : r.url);
  const cacheFor = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      async addAll(reqs) { for (const r of reqs) m.set(keyOf(r).startsWith('http') ? keyOf(r) : ORIGIN + keyOf(r), mkResponse(`cached:${keyOf(r)}`)); },
      async put(r, res) { m.set(keyOf(r), res); },
      async match(r) { return m.get(keyOf(r)) || undefined; },
    };
  };
  const listeners = {};
  const sw = {
    location: { origin: ORIGIN },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  const ctx = {
    self: sw, URL, Promise, setTimeout, clearTimeout, console,
    caches: { open: async (n) => cacheFor(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) },
    Request: class { constructor(url, init = {}) { this.url = url.startsWith('http') ? url : ORIGIN + url; this.method = init.method || 'GET'; this.mode = init.mode || 'cors'; } },
    fetch: async (req) => { fetched.push(req.url); if (network === 'offline') throw new TypeError('Failed to fetch'); return network === 'error' ? mkResponse('server error', { status: 500 }) : mkResponse(`fresh:${req.url}`); },
    importScripts: (...files) => { for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f.replace(/^\//, '')), 'utf8'), ctx); },
  };
  ctx.self = sw; ctx.globalThis = ctx;
  vm.createContext(ctx);
  // The scripts set `self.X`; inside this context `self` is the stand-in.
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8'), ctx);

  const event = (extra) => { let waited = null; let responded = null; return { ...extra, waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; }, get waited() { return waited; }, get responded() { return responded; } }; };
  const req = (url, init = {}) => new ctx.Request(url, init);

  console.log('\n-- 3. install and activate --');
  stores.set('taqwa-shell-0.0.0-old', new Map());
  const inst = event({});
  listeners.install(inst); await inst.waited;
  const cacheName = `taqwa-shell-${version}`;
  check('install pre-caches every listed file into the current version\'s cache', [stores.has(cacheName), stores.get(cacheName).size], [true, list.length]);
  const act = event({});
  listeners.activate(act); await act.waited;
  check('activate deletes older versions\' caches', [...stores.keys()], [cacheName]);

  console.log('\n-- 4. business data is never touched --');
  for (const [what, r] of [['an API read', req('/api/customers')], ['an API session call', req('/api/session')], ['a POST', req('/pages/customers.html', { method: 'POST' })],
    ['another origin', req('https://fonts.googleapis.com/css2?family=x')]]) {
    const e = event({ request: r }); listeners.fetch(e);
    check(`${what} is not intercepted`, e.responded, null);
  }
  ok('   ...and no /api/ address is ever in the cache', ![...stores.get(cacheName).keys()].some(k => k.includes('/api/')), '');

  console.log('\n-- 5. online and offline --');
  network = 'online';
  let e = event({ request: req('/pages/customers.html?view=CUS-0001', { mode: 'navigate' }) }); listeners.fetch(e);
  let res = await e.responded;
  check('online: the page comes from the network', res.body, `fresh:${ORIGIN}/pages/customers.html?view=CUS-0001`);
  await new Promise(r => setTimeout(r, 5));
  check('   ...and refreshes the cached copy (stored without the query)', stores.get(cacheName).get(`${ORIGIN}/pages/customers.html`).body, `fresh:${ORIGIN}/pages/customers.html?view=CUS-0001`);
  network = 'error';
  e = event({ request: req('/js/app.js') }); listeners.fetch(e); res = await e.responded;
  await new Promise(r => setTimeout(r, 5));
  check('a server error is passed on, and never cached', [res.status, stores.get(cacheName).get(`${ORIGIN}/js/app.js`).body], [500, `cached:${ORIGIN}/js/app.js`]);
  network = 'offline';
  e = event({ request: req('/pages/invoices.html?view=INV-0001', { mode: 'navigate' }) }); listeners.fetch(e); res = await e.responded;
  check('offline: the cached page is served, whatever its query', res.body, `cached:${ORIGIN}/pages/invoices.html`);
  e = event({ request: req('/pages/unknown-page.html', { mode: 'navigate' }) }); listeners.fetch(e); res = await e.responded;
  check('   ...an unknown page falls back to the dashboard page', res.body, `cached:${ORIGIN}/index.html`);
  e = event({ request: req('/') }); listeners.fetch(e);
  let threw = false; try { await e.responded; } catch (err) { threw = true; }
  ok('   ...a non-page file that was never cached fails as a network error would', threw, '');

  process.exit(summary('offline-sw') === 0 ? 0 : 1);
})();
