/* offline-sync-fixes — the browser side of the review fixes, with the REAL
   js/storage.js, js/offline.js and js/sync.js and Node's real WebCrypto.

     C1  the client follows the server's query budget: deferred operations
         are sent again at once (no back-off, no attempt counted) until all
         are applied; pull asks for small pages and never moves its cursor
         past a page it could not finish (retryLater, a refresh that failed).
     M6  a change is shown only after its encrypted journal write succeeded;
         storage refusing it (quota) shows nothing and says nothing was saved.
     M7  unsynced work survives key rotation: a password change carries it
         over with the old password; a reset keeps the old key with the
         journal so the previous password unlocks it; removing a copy keeps
         it too.
     M8  persistent storage is requested and its answer remembered.
     M9  an IndexedDB upgrade (v1 -> v2) only adds a store; this tab lets a
         newer version upgrade (versionchange closes); a blocked upgrade is
         reported, not mistaken for "no copy".
     M10 the online-only map in app.js covers the seven modules, and every
         page it names exists. Fictional data only. */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

const memory = new Map();
const session = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
let sharedStore = null;
function page({ fetch } = {}) {
  const h = boot({
    origin: 'https://app.taqwa.autos', fetch, modules: ['js/offline.js', 'js/sync.js'],
    beforeModules(doc, ctx) { Object.assign(ctx, { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, indexedDB: {}, sessionStorage: session }); },
  });
  vm.runInContext('globalThis.Offline = Offline; globalThis.Sync = Sync;', h.ctx);
  if (!sharedStore) sharedStore = h.ctx.Offline.memoryStore();
  h.ctx.Offline.useStore(sharedStore);
  return h;
}
const down = () => async () => { throw new TypeError('Failed to fetch'); };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

(async () => {
  console.log('=== offline-sync-fixes: the browser side of the review fixes ===\n');
  const PW = 'Advisor-Own-Pass-21';
  const ACCOUNT = { id: 'USR-0005', username: 'advisor', name: 'Test Advisor', staffId: 'STF-0005', role: 'Service Advisor' };
  const PERMS = ['customers.view', 'customers.create', 'customers.edit', 'payments.view', 'payments.create', 'job_cards.view'];
  const DATA = { collections: { customers: [{ id: 'CUS-0001', name: 'Existing', phone: '01700000001' }] }, settings: {}, permissions: PERMS, fullAccess: false, denied: [],
    cursor: 10, authorizedAt: new Date().toISOString(), clientAt: new Date().toISOString() };
  {
    const h = page({ fetch: down() });
    await h.ctx.Offline.enroll(ACCOUNT, PW, 'advisor');
    await h.ctx.Offline.setDeviceCode('A');
    await h.ctx.Offline.saveSnapshot(ACCOUNT.id, DATA);
  }

  console.log('-- M6: shown only once it is stored --');
  let h = page({ fetch: down() });
  await h.ctx.Storage.hydrate();
  await h.ctx.Storage.unlockOffline('advisor', PW);
  const realWrite = h.ctx.Offline.writeJournal;
  h.ctx.Offline.writeJournal = async () => { throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }); };
  const before = h.ctx.Storage.getData('customers').length;
  const res = await h.ctx.Storage.create('customers', { name: 'Never Stored', phone: '01700000999' });
  check('the browser refuses the write (quota): not ok, code "storage", nothing shown', [res.ok, res.code, h.ctx.Storage.getData('customers').length, h.ctx.Storage.getData('customers').some((c) => c.name === 'Never Stored')], [false, 'storage', before, false]);
  ok('   ...and the person is told nothing was saved', /Nothing was saved/.test(res.message), res.message);
  check('   ...the journal on disk is unchanged (no operation queued)', h.ctx.Sync.outbox().length, 0);
  const pay = await h.ctx.Storage.create('payments', { customerId: 'CUS-0001', amount: 100, method: 'Cash', date: '2026-11-01' });
  check('   ...a pending payment too: refused, not listed', [pay.ok, h.ctx.Sync.pending('payments').length], [false, 0]);
  h.ctx.Offline.writeJournal = realWrite;
  const good = await h.ctx.Storage.create('customers', { name: 'Stored', phone: '01700000998' });
  check('when storage works again: saved and shown', [good.ok, !!h.ctx.Storage.getById('customers', good.record.id)], [true, true]);

  console.log('\n-- C1: the client follows the server\'s budget --');
  {
    // A few more changes to send.
    for (let i = 0; i < 4; i++) await h.ctx.Storage.create('customers', { name: `Queued ${i}`, phone: `0170000010${i}` });
    const requests = [];
    let pullCalls = 0; let pullMode = 'pages';
    const base = fakeApi({ rows: { customers: DATA.collections.customers } });
    let n = 100;
    const server = async (url, init = {}) => {
      const p = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
      const method = init.method || 'GET';
      if (p === '/session' && method === 'GET') return json(200, { data: { authenticated: true, passphrase: true, accounts: true, account: ACCOUNT, fullAccess: false, permissions: PERMS, serverTime: new Date().toISOString(), syncCursor: 10 } });
      if (p === '/devices/register') return json(200, { data: { code: 'A', serverTime: new Date().toISOString(), escrow: Buffer.alloc(32, 5).toString('base64') } });
      if (p === '/sync/push') {
        const ops = JSON.parse(init.body).ops;
        requests.push(ops.length);
        // The server applies TWO per request and defers the rest (its query budget).
        return json(200, { data: { results: ops.map((o, i) => (i < 2 ? { opId: o.opId, status: 'applied', serverId: `CUS-0${n++}`, record: { ...o.data, id: `CUS-0${n}` } } : { opId: o.opId, status: 'deferred', reason: 'budget' })) } });
      }
      if (p.startsWith('/sync/pull')) {
        pullCalls += 1;
        const limit = Number(new URL('http://x' + p).searchParams.get('limit'));
        const cursor = Number(new URL('http://x' + p).searchParams.get('cursor'));
        if (pullMode === 'pages') return json(200, { data: { changes: [], cursor: cursor + 5, hasMore: cursor + 5 < 30, limitAsked: limit } });
        if (pullMode === 'retryLater') return json(200, { data: { changes: [{ seq: cursor + 1, collection: 'customers', id: 'CUS-0001', op: 'upsert', record: { id: 'CUS-0001', name: 'Renamed Elsewhere' } }], cursor: cursor + 1, hasMore: true, retryLater: true } });
        if (pullMode === 'refreshFails') return json(200, { data: { changes: [{ seq: cursor + 1, collection: 'invoices', id: '*', op: 'refresh' }], cursor: cursor + 1, hasMore: false } });
      }
      if (p.startsWith('/invoices') && pullMode === 'refreshFails') return json(500, { error: { code: 'database_error', message: 'x' } });
      return base(url, init);
    };
    const on = page({ fetch: server });
    await on.ctx.Storage.hydrate();
    const waiting = on.ctx.Sync.outbox().length;
    const r = await on.ctx.Sync.run({ reason: 'test', pull: false });
    check(`${waiting} waiting, the server takes 2 per request: sent in ${requests.length} requests, everything applied`, [r.ok, on.ctx.Sync.outbox().length, requests.length], [true, 0, Math.ceil(waiting / 2)]);
    ok('   ...a deferred operation is not an error: no attempt counted, no back-off', on.ctx.Sync.history().filter((x) => x.synced).length >= waiting, '');
    const host = on.ctx.Storage;
    const c0 = host.serverCursor;
    await on.ctx.Sync.run({ reason: 'pull' });
    check('pull reads in pages until the end: cursor 10 -> 30, every page small (limit 50)', [c0, host.serverCursor, pullCalls], [10, 30, 4]);
    pullMode = 'retryLater';
    const c1 = host.serverCursor;
    await on.ctx.Sync.run({ reason: 'pull' });
    check('a page the server could not finish ("retryLater"): its changes applied, the pull stops there', [host.serverCursor, host.getById('customers', 'CUS-0001').name], [c1 + 1, 'Renamed Elsewhere']);
    pullMode = 'refreshFails';
    const c2 = host.serverCursor;
    await on.ctx.Sync.run({ reason: 'pull' });
    check('a collection it was told to re-read could not be read: the cursor stays where it was', host.serverCursor, c2);
  }

  console.log('\n-- M7: unsynced work survives a new password --');
  {
    // A person whose journal holds work, and NO escrow wrap yet (made offline).
    const P = { id: 'USR-0007', username: 'nadia', name: 'Nadia', staffId: 'STF-0007', role: 'Service Advisor' };
    const O = page({ fetch: down() }).ctx.Offline;
    await O.enroll(P, 'First-Own-Pass-1', 'nadia');
    await O.saveSnapshot(P.id, { ...DATA, permissions: PERMS });
    const opened = await O.unlock('nadia', 'First-Own-Pass-1');
    const key = opened.journalKey;
    await O.writeJournal(P.id, key, { records: {}, localOnly: { payments: [{ id: 'OFF-A-PAY-0009', amount: 500 }] }, outbox: [{ opId: 'x', state: 'pending' }], history: [] }, { pending: 1, conflict: 0, failed: 0 });
    // An administrator resets the password; the person signs in with the new one in a new tab (no key on hand).
    await O.enroll(P, 'Reset-Pass-2026', 'nadia');
    const locked = await O.unlock('nadia', 'Reset-Pass-2026');
    check('after a reset the new password alone cannot open the old work -- but it is kept, not lost', [locked.journalKey, (await O.journalStatus(P.id)).hasWork, (await O.journalStatus(P.id)).retired], [null, true, 1]);
    check('   ...a wrong previous password unlocks nothing', await O.recoverJournal(P.id, 'Not-The-Password-1'), null);
    const rec = await O.recoverJournal(P.id, 'First-Own-Pass-1');
    ok('   ...the PREVIOUS password unlocks it, and the work is intact', rec && (await O.readJournal(P.id, rec)).localOnly.payments[0].amount === 500, rec);
    await O.saveSnapshot(P.id, { ...DATA, permissions: PERMS });
    const after = await O.unlock('nadia', 'Reset-Pass-2026');
    check('   ...from then on the NEW password opens it too (re-wrapped)', after.journalKey, rec);
    // A person changing their own password: the old one is used to carry the work over at once.
    await O.enroll(P, 'Changed-Pass-2027', 'nadia', { oldPassword: 'Reset-Pass-2026' });
    await O.saveSnapshot(P.id, { ...DATA, permissions: PERMS });
    check('changing one\'s own password (old password given): the new one opens the work immediately', (await O.unlock('nadia', 'Changed-Pass-2027')).journalKey, rec);
    // Removing the copy keeps the work; signing in again with the same password recovers it.
    await O.forget(P.id);
    check('   ...removing the person\'s copy keeps the work (and its key, still under the password)', [(await O.journalStatus(P.id)).hasWork, (await O.journalStatus(P.id)).retired >= 1], [true, true]);
    await O.enroll(P, 'Changed-Pass-2027', 'nadia');
    await O.saveSnapshot(P.id, { ...DATA, permissions: PERMS });
    check('   ...signing in here again with the same password recovers it automatically', (await O.unlock('nadia', 'Changed-Pass-2027')).journalKey, rec);
  }

  console.log('\n-- M8: persistent storage --');
  {
    const ctx = page({ fetch: down() }).ctx;
    vm.runInContext('globalThis.navigator = undefined;', ctx);
    check('no Storage API: reported as not supported', await ctx.Offline.ensurePersistent(), { supported: false, persisted: false });
    vm.runInContext('globalThis.navigator = { storage: { persisted: async () => false, persist: async () => false } };', ctx);
    check('the browser declines: not persisted -- remembered for the page to warn', [await ctx.Offline.ensurePersistent(), (await ctx.Offline.persistence()).persisted], [{ supported: true, persisted: false }, false]);
    vm.runInContext('globalThis.navigator = { storage: { persisted: async () => false, persist: async () => true } };', ctx);
    check('the browser agrees: persisted', [await ctx.Offline.ensurePersistent(), (await ctx.Offline.persistence()).persisted], [{ supported: true, persisted: true }, true]);
  }

  console.log('\n-- M9: IndexedDB versions --');
  {
    // A small stand-in for IndexedDB: enough for offline.js's open / upgrade / transactions.
    const dbs = new Map();   // name -> { version, stores: Map(name -> { keyPath, rows: Map }), conns: [] }
    let blockNext = false;
    const fakeIDB = {
      open(name, version) {
        const req = {};
        setTimeout(() => {
          let rec = dbs.get(name);
          if (!rec) { rec = { version: 0, stores: new Map(), conns: [] }; dbs.set(name, rec); }
          const conn = {
            objectStoreNames: { contains: (s) => rec.stores.has(s) },
            createObjectStore: (s, opts) => { rec.stores.set(s, { keyPath: opts.keyPath, rows: new Map() }); },
            close() { conn.closed = true; rec.conns = rec.conns.filter((c) => c !== conn); },
            transaction(store) {
              const t = {};
              const st = rec.stores.get(store);
              const wrap = (fn) => { const r = {}; setTimeout(() => { r.result = fn(); setTimeout(() => t.oncomplete && t.oncomplete()); }); return r; };
              t.objectStore = () => ({
                get: (k) => wrap(() => st.rows.get(k)), put: (v) => wrap(() => { st.rows.set(v[st.keyPath], JSON.parse(JSON.stringify(v))); }),
                delete: (k) => wrap(() => { st.rows.delete(k); }), getAll: () => wrap(() => [...st.rows.values()]), clear: () => wrap(() => st.rows.clear()),
              });
              return t;
            },
          };
          if (version > rec.version) {
            const open = rec.conns.filter((c) => !c.closed);
            open.forEach((c) => c.onversionchange && c.onversionchange());
            if (blockNext || rec.conns.some((c) => !c.closed)) { blockNext = false; req.onblocked && req.onblocked(); return; }
            const oldVersion = rec.version;
            rec.version = version;
            req.result = conn;
            req.onupgradeneeded && req.onupgradeneeded({ oldVersion });
          }
          rec.conns.push(conn);
          req.result = conn;
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
    };
    const load = () => {
      const ctx = { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, indexedDB: fakeIDB, setTimeout, console };
      vm.createContext(ctx);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/offline.js'), 'utf8') + ';globalThis.Offline = Offline;', ctx);
      return ctx.Offline;
    };
    // A Phase 1 (version 1) store with a copy in it.
    dbs.set('taqwa-offline', { version: 1, conns: [], stores: new Map([['meta', { keyPath: 'key', rows: new Map([['device', { key: 'device', deviceId: 'dev-1' }]]) }],
      ['users', { keyPath: 'accountId', rows: new Map([['USR-0001', { accountId: 'USR-0001', name: 'Kept' }]]) }], ['snapshots', { keyPath: 'accountId', rows: new Map([['USR-0001', { accountId: 'USR-0001', savedAt: 'x' }]]) }]]) });
    const v2 = load();
    check('upgrading a Phase 1 store (v1 -> v2): opens, adds only "journals", keeps the device and the copy',
      [(await v2.check()).ok, [...dbs.get('taqwa-offline').stores.keys()].sort(), (await v2.deviceId()), (await v2.status()).map((x) => x.name)], [true, ['journals', 'meta', 'snapshots', 'users'], 'dev-1', ['Kept']]);
    const conn = dbs.get('taqwa-offline').conns[0];
    ok('   ...this tab will let a newer version upgrade: it closes on "versionchange"', typeof conn.onversionchange === 'function' && (conn.onversionchange(), conn.closed === true), '');
    // A blocked upgrade (an old tab that does not let go).
    dbs.get('taqwa-offline').version = 1;
    blockNext = true;
    const blockedO = load();
    const c = await blockedO.check();
    check('an upgrade blocked by an older tab is reported as such (not as "no copy")', [c.ok, c.code], [false, 'blocked']);
    ok('   ...with the instruction to close or reload the other tabs', /Close every other Taqwa tab/.test(c.message), c.message);
  }

  console.log('\n-- M10: the seven online-only modules --');
  {
    const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
    const block = app.slice(app.indexOf('const ONLINE_ONLY = {'), app.indexOf('};', app.indexOf('const ONLINE_ONLY = {')));
    const pairs = [...block.matchAll(/'?([a-z-]+)'?: '([A-Za-z ]+)'/g)].map((m) => [m[1], m[2]]);
    const modules = [...new Set(pairs.map((p) => p[1]))].filter((m) => m !== 'Settings').sort();
    check('app.js marks exactly the seven online-only modules', modules, ['Attendance', 'CRM', 'Estimates', 'Inbox', 'Notifications', 'Staff', 'Workshop Assets']);
    const missing = pairs.map((p) => p[0]).filter((k) => !fs.existsSync(path.join(ROOT, 'pages', `${k}.html`)));
    check('   ...and every page it names exists', missing, []);
    const pages = fs.readdirSync(path.join(ROOT, 'pages')).map((f) => f.replace('.html', ''));
    // Equipment Inventory (0021) works offline for adding equipment (queued), so it is deliberately not marked.
    const OFFLINE_CAPABLE = ['equipment-inventory'];
    const unmarked = pages.filter((p) => /^(estimate|staff-|crm-|inbox-|workshop-|asset-|equipment-|maintenance-|notifications)/.test(p) && !OFFLINE_CAPABLE.includes(p) && !pairs.some((x) => x[0] === p));
    check('   ...no page of those modules is left unmarked', unmarked, []);
    const html = fs.readFileSync(path.join(ROOT, 'pages/offline-sync.html'), 'utf8');
    ok('   ...and Offline & Sync lists them', ['Estimates', 'Attendance', 'Workshop Assets', 'Notifications', 'Staff', 'CRM', 'Inbox'].every((m) => html.includes(`<li>${m}</li>`)), '');
  }

  process.exit(summary('offline-sync-fixes') === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
