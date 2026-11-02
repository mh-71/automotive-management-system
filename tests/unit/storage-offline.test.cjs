/* storage-offline — Storage in offline mode (Phase 1), with the REAL
   js/storage.js and js/offline.js, Node's real WebCrypto, and an in-memory
   store in place of IndexedDB.

     1. The deployed app (API on its own origin) cannot reach the server and
        has no copy: it asks to sign in offline -- never the demo store.
     2. With a copy: a wrong password is refused; the right one opens it,
        read-only, with the role and permissions saved in it.
     3. Every write, action, settings save and on-demand read is refused with
        the "offline, read-only" answer, and no request is even attempted.
     4. The next page of the same tab opens the copy without the password;
        signing out of it ends that.
     5. A cross-origin dev setup keeps the old browser-only fallback.
     6. Online, the copy is refreshed for an enrolled personal account only. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const memory = new Map();
const session = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
let sharedStore = null;

function page({ fetch, origin = 'https://app.taqwa.autos', apiBase = null } = {}) {
  const h = boot({
    origin, fetch, modules: ['js/offline.js'],
    beforeModules(doc, ctx) {
      Object.assign(ctx, { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, indexedDB: {}, sessionStorage: session });
      if (apiBase) ctx.window.TAQWA_API_BASE = apiBase;
    },
  });
  vm.runInContext('globalThis.Offline = Offline;', h.ctx);
  if (!sharedStore) sharedStore = h.ctx.Offline.memoryStore();
  h.ctx.Offline.useStore(sharedStore);
  return h;
}
const down = (calls) => async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); throw new TypeError('Failed to fetch'); };

(async () => {
  console.log('=== storage-offline: the read-only offline copy ===\n');
  const PW = 'My-Own-Secret-22';
  const ACCOUNT = { id: 'USR-0004', username: 'acct', name: 'Test Accountant', staffId: 'STF-0004', role: 'Accountant', roleId: 'ROL-0004' };

  console.log('-- 1. no copy yet --');
  {
    const calls = [];
    const h = page({ fetch: down(calls) });
    const r = await h.ctx.Storage.hydrate();
    check('the server cannot be reached and there is no copy: sign in offline, nothing to open', [r.mode, r.offline, r.hasCopies], ['locked', true, false]);
    ok('   ...it never falls back to the demo store', h.ctx.Storage.getData('customers').length === 0 && !h.ctx.Storage.isApi(), '');
  }

  // Set up a copy, as an earlier online sign-in on this computer would have.
  {
    const h = page({ fetch: down([]) });
    await h.ctx.Offline.enroll(ACCOUNT, PW, 'acct');
    await h.ctx.Offline.saveSnapshot(ACCOUNT.id, {
      collections: { customers: [{ id: 'CUS-0001', name: 'Test Customer' }], invoices: [{ id: 'INV-0001', total: 500 }] },
      settings: { businessName: 'Test Workshop' }, permissions: ['customers.view', 'invoices.view'], fullAccess: false, denied: ['expenses'],
    });
  }

  console.log('\n-- 2. opening the copy --');
  {
    const calls = [];
    const h = page({ fetch: down(calls) });
    const r = await h.ctx.Storage.hydrate();
    check('now there is a copy to open', [r.mode, r.offline, r.hasCopies], ['locked', true, true]);
    const bad = await h.ctx.Storage.unlockOffline('acct', 'Wrong-Password-1');
    check('a wrong password does not open it', [bad.ok, h.ctx.Storage.isOffline()], [false, false]);
    const good = await h.ctx.Storage.unlockOffline('STF-0004', PW);
    check('the right password (by Staff ID) opens it, read-only', [good.ok, h.ctx.Storage.isOffline(), h.ctx.Storage.isApi()], [true, true, false]);
    check('   ...with the saved records and settings', [h.ctx.Storage.getData('customers').map(c => c.name), h.ctx.Storage.getSettings().businessName], [['Test Customer'], 'Test Workshop']);
    check('   ...as the person, with the role and permissions saved in the copy', [h.ctx.Storage.account.name, h.ctx.Storage.can('invoices.view'), h.ctx.Storage.can('expenses.view'), h.ctx.Storage.isDenied('expenses')],
      ['Test Accountant', true, false, true]);

    console.log('\n-- 3. nothing can be changed --');
    const before = calls.length;
    const tries = [
      await h.ctx.Storage.create('customers', { name: 'Offline Made' }),
      await h.ctx.Storage.update('customers', 'CUS-0001', { name: 'Changed' }),
      await h.ctx.Storage.remove('customers', 'CUS-0001'),
      await h.ctx.Storage.action('invoices', 'INV-0001', 'void', {}),
      await h.ctx.Storage.putSettings({ businessName: 'Changed' }),
      await h.ctx.Storage.load('estimates'),
    ];
    check('create, update, delete, actions, settings and on-demand reads are all refused as offline', tries.map(t => [t.ok, t.code]), Array(6).fill([false, 'offline']));
    ok('   ...with a plain message', /You are offline\. This is a read-only copy/.test(tries[0].message), tries[0].message);
    check('   ...no request was even attempted, and the copy is unchanged', [calls.length - before, h.ctx.Storage.getData('customers').map(c => c.name)], [0, ['Test Customer']]);
  }

  console.log('\n-- 4. the next page of the same tab --');
  {
    const h = page({ fetch: down([]) });
    const r = await h.ctx.Storage.hydrate();
    check('opens the copy without the password', [r.mode, h.ctx.Storage.getData('invoices').length], ['offline', 1]);
    h.ctx.Storage.lockOffline();
    const h2 = page({ fetch: down([]) });
    check('   ...until it is closed (sign out): then the password is needed again', (await h2.ctx.Storage.hydrate()).mode, 'locked');
  }

  console.log('\n-- 5. a cross-origin dev setup --');
  {
    const h = page({ fetch: down([]), origin: 'http://localhost:5500', apiBase: 'http://localhost:8787/api' });
    check('keeps the old browser-only fallback (no offline copy involved)', (await h.ctx.Storage.hydrate()).mode, 'local');
  }

  console.log('\n-- 6. online: refreshing the copy --');
  {
    const base = fakeApi({ rows: { customers: [{ id: 'CUS-0001', name: 'Fresh Customer' }] } });
    const withSession = (account) => async (url, init = {}) => {
      if (String(url).endsWith('/api/session') && (init.method || 'GET') === 'GET') {
        return { status: 200, ok: true, json: async () => ({ data: { authenticated: true, passphrase: true, accounts: true, ...(account ? { account } : {}), fullAccess: !account, permissions: ['customers.view'] } }) };
      }
      return base(url, init);
    };
    const h = page({ fetch: withSession(ACCOUNT) });
    const r = await h.ctx.Storage.hydrate();
    check('online with a personal account', [r.mode, h.ctx.Storage.account.id], ['api', 'USR-0004']);
    check('   ...the copy is refreshed with what was just read', await h.ctx.Storage.saveOfflineCopy({ force: true }), true);
    const opened = await h.ctx.Offline.unlock('acct', PW);
    check('   ...and now holds the fresh records', opened.data.collections.customers.map(c => c.name), ['Fresh Customer']);
    memory.clear();
    const p = page({ fetch: withSession(null) });
    await p.ctx.Storage.hydrate();
    check('the shared passphrase gets no copy (there is no person to protect it for)', await p.ctx.Storage.saveOfflineCopy({ force: true }), false);
  }

  process.exit(summary('storage-offline') === 0 ? 0 : 1);
})();
