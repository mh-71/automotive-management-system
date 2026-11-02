/* offline-sync-client — working offline (Phases 2-4) in the browser code:
   the REAL js/storage.js, js/offline.js and js/sync.js, Node's real
   WebCrypto, and an in-memory store in place of IndexedDB. Fictional data.

     1. Offline with the copy open: records are created and edited on this
        computer with temporary references (OFF-<code>-CUS-0001) and UUIDs,
        shown at once, and queued as operations; deletes, money actions,
        accounts and roles stay online-only; the role's permissions apply.
     2. Payments are PENDING and invoices DRAFTS: kept apart from the
        confirmed records, so no balance or list counts them.
     3. Parts changes on a job card become per-part movements (+ use /
        - return); a status change is its own operation.
     4. Everything survives a refresh (a new page of the same tab), and the
        journal is encrypted: nothing in clear, a wrong key opens nothing.
     5. The 14-day window runs from the SERVER's time; a clock turned back
        refuses; a revoked device refuses.
     6. Online: the engine pushes in order, replaces temporary references
        with the server's ids everywhere, keeps conflicts and failures,
        backs off on errors, stops on sign-out and on revocation; the copy
        saved online holds only server-confirmed records.
     7. The escrow: online, a fresh tab reopens the journal without the
        password -- another person's escrow does not. Two tabs never
        overwrite each other's changes. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const memory = new Map();
const session = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
let sharedStore = null;

function page({ fetch, origin = 'https://app.taqwa.autos' } = {}) {
  const h = boot({
    origin, fetch, modules: ['js/offline.js', 'js/sync.js'],
    beforeModules(doc, ctx) {
      Object.assign(ctx, { crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, Uint8Array, indexedDB: {}, sessionStorage: session });
    },
  });
  vm.runInContext('globalThis.Offline = Offline; globalThis.Sync = Sync;', h.ctx);
  if (!sharedStore) sharedStore = h.ctx.Offline.memoryStore();
  h.ctx.Offline.useStore(sharedStore);
  return h;
}
const down = (calls = []) => async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); throw new TypeError('Failed to fetch'); };
const DAY = 86400000;

(async () => {
  console.log('=== offline-sync-client: working offline, then syncing ===\n');
  const PW = 'Advisor-Own-Pass-21';
  const ACCOUNT = { id: 'USR-0005', username: 'advisor', name: 'Test Advisor', staffId: 'STF-0005', role: 'Service Advisor', roleId: 'ROL-0005' };
  const PERMS = ['customers.view', 'customers.create', 'customers.edit', 'vehicles.view', 'vehicles.create', 'vehicles.edit', 'job_cards.view', 'job_cards.create',
    'job_cards.edit', 'job_cards.manage', 'invoices.view', 'invoices.create', 'payments.view', 'payments.create', 'inventory.view', 'appointments.view', 'appointments.create'];
  const SERVER_NOW = new Date().toISOString();
  const DATA = {
    collections: {
      customers: [{ id: 'CUS-0001', name: 'Existing Customer', phone: '01700000001', notes: '', updatedAt: '2026-10-01T00:00:00Z' }],
      vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'DHAKA-1', brand: 'Toyota', model: 'Axio' }],
      jobCards: [{ id: 'JOB-0001', customerId: 'CUS-0001', vehicleId: 'VEH-0001', status: 'In Progress', total: 800, services: [], partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', partNo: 'OF-1', qty: 1, unitPrice: 150 }] }],
      parts: [{ id: 'PRT-0001', name: 'Oil Filter', stock: 4, sellingPrice: 150 }],
      payments: [{ id: 'PAY-0001', customerId: 'CUS-0001', jobCardId: 'JOB-0001', amount: 100, status: 'Active' }],
      invoices: [],
    },
    settings: { businessName: 'Test Workshop' }, permissions: PERMS, fullAccess: false, denied: [],
    cursor: 40, authorizedAt: SERVER_NOW, clientAt: new Date().toISOString(),
  };

  // An earlier online sign-in on this computer: enrolled, a copy saved.
  {
    const h = page({ fetch: down() });
    await h.ctx.Offline.enroll(ACCOUNT, PW, 'advisor');
    await h.ctx.Offline.setDeviceCode('A');
    await h.ctx.Offline.saveSnapshot(ACCOUNT.id, DATA);
  }

  console.log('-- 1. offline: records made and changed on this computer --');
  let h = page({ fetch: down() });
  await h.ctx.Storage.hydrate();
  const opened = await h.ctx.Storage.unlockOffline('advisor', PW);
  check('the copy opens, and changes can be saved here', [opened.ok, opened.writable, h.ctx.Storage.isOffline(), h.ctx.Storage.offlineWritable()], [true, true, true, true]);
  const S = h.ctx.Storage;
  const cust = await S.create('customers', { name: 'Offline Customer', phone: '01700000555' });
  check('a customer made offline gets a temporary reference with this computer\'s code, and a UUID', [cust.ok, cust.pending, cust.record.id, /^[0-9a-f-]{36}$/.test(cust.record.uuid)], [true, true, 'OFF-A-CUS-0001', true]);
  ok('   ...and is shown at once, marked as waiting', S.getById('customers', 'OFF-A-CUS-0001') && S.getById('customers', 'OFF-A-CUS-0001')._sync.state === 'pending', '');
  const veh = await S.create('vehicles', { customerId: cust.record.id, regNo: 'DHAKA-55', brand: 'Honda', model: 'Fit' });
  const job = await S.create('jobCards', { customerId: cust.record.id, vehicleId: veh.record.id, mechanicId: 'MEC-0001', complaint: 'Noise', services: [{ name: 'Check', qty: 1, unitPrice: 500 }], status: 'Received' },
    { display: { subtotal: 500, total: 500 } });
  check('a vehicle and a job card refer to it by its temporary reference', [veh.record.id, veh.record.customerId, job.record.id, job.record.vehicleId, job.record.total], ['OFF-A-VEH-0001', 'OFF-A-CUS-0001', 'OFF-A-JOB-0001', 'OFF-A-VEH-0001', 500]);
  const edited = await S.update('customers', 'OFF-A-CUS-0001', { notes: 'Calls after 5pm' });
  const ops = () => h.ctx.Sync.outbox();
  check('editing a record not yet sent changes what will be sent (no second operation)', [edited.ok, ops().filter((o) => o.kind === 'create' && o.tempId === 'OFF-A-CUS-0001')[0].data.notes, ops().length], [true, 'Calls after 5pm', 3]);
  const e2 = await S.update('customers', 'CUS-0001', { notes: 'VIP', phone: '01700000001' });
  const upd = ops().find((o) => o.kind === 'update');
  check('editing a server record queues only the changed fields, with what this computer last saw of them', [e2.ok, upd.targetId, upd.data, upd.base.values], [true, 'CUS-0001', { notes: 'VIP' }, { notes: '' }]);
  const forbidden = await S.create('expenses', { amount: 5, category: 'Tea' });
  check('a role without that permission is refused offline as online', [forbidden.ok, forbidden.code], [false, 'forbidden']);
  const tries = [await S.remove('customers', 'CUS-0001'), await S.action('payments', 'PAY-0001', 'void', {}), await S.create('accounts', { username: 'x' }), await S.create('roles', { name: 'x' }), await S.create('parts', { name: 'x' })];
  check('deleting, voiding a payment, creating accounts, roles or parts: refused offline (the internet is needed)', tries.map((t) => [t.ok, t.code]), Array(5).fill([false, 'offline']));

  console.log('\n-- 2. payments PENDING, invoices DRAFT --');
  const payments0 = S.getData('payments').length;
  const pay = await S.create('payments', { customerId: 'CUS-0001', jobCardId: 'JOB-0001', amount: 300, method: 'Cash', date: '2026-11-01', notes: '' });
  check('a payment made offline is PENDING, with a temporary reference', [pay.ok, pay.pending, pay.record.status, pay.record.id], [true, true, 'Pending', 'OFF-A-PAY-0001']);
  check('   ...and is NOT among the payments any balance or advance reads', [S.getData('payments').length, S.getData('payments').some((p) => p.id === pay.record.id)], [payments0, false]);
  check('   ...it is listed apart, as pending', h.ctx.Sync.pending('payments').map((p) => [p.id, p.amount, p._sync.state]), [['OFF-A-PAY-0001', 300, 'pending']]);
  ok('   ...so the job card\'s advances still count only the confirmed payment', typeof h.ctx.Utils.jobAdvances !== 'function' || h.ctx.Utils.jobAdvances('JOB-0001').reduce((s, p) => s + Number(p.amount), 0) === 100, '');
  const inv = await S.create('invoices', { jobCardId: 'JOB-0001', date: '2026-11-01' });
  check('an invoice made offline is a DRAFT: no invoice, no number', [inv.ok, inv.draft, inv.record.status, inv.record.id, S.getData('invoices').length, inv.record.localTotal], [true, true, 'Draft', 'OFF-A-DRF-0001', 0, 800]);

  console.log('\n-- 3. parts used, status --');
  const parts = await S.update('jobCards', 'JOB-0001', { partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', partNo: 'OF-1', qty: 3, unitPrice: 150 }, { partId: null, name: 'Rag', qty: 2, unitPrice: 10 }] });
  check('two more filters and a manual line: two movements, nothing else', [parts.ok, ops().filter((o) => o.kind === 'parts_usage').map((o) => [o.targetId, o.data.partId, o.data.quantity])],
    [true, [['JOB-0001', 'PRT-0001', 2], ['JOB-0001', null, 2]]]);
  ok('   ...the part\'s stock on this computer is not touched (the server decides)', S.getById('parts', 'PRT-0001').stock === 4, '');
  await S.update('jobCards', 'JOB-0001', { partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', partNo: 'OF-1', qty: 2, unitPrice: 150 }, { partId: null, name: 'Rag', qty: 2, unitPrice: 10 }] });
  check('   ...taking one back is a return of 1', ops().filter((o) => o.kind === 'parts_usage').map((o) => o.data.quantity), [2, 2, -1]);
  const st = await S.action('jobCards', 'JOB-0001', 'status', { status: 'Completed' });
  const so = ops().find((o) => o.kind === 'status');
  check('a status change is its own operation, with the status it started from', [st.ok, so.data.status, so.base.status, S.getById('jobCards', 'JOB-0001').status], [true, 'Completed', 'In Progress', 'Completed']);

  console.log('\n-- 4. it survives a refresh, encrypted --');
  {
    const p2 = page({ fetch: down() });
    const r = await p2.ctx.Storage.hydrate();
    check('the next page of the same tab opens the copy AND the changes', [r.mode, !!p2.ctx.Storage.getById('customers', 'OFF-A-CUS-0001'), p2.ctx.Sync.outbox().length, p2.ctx.Sync.pending('payments').length],
      ['offline', true, ops().length, 1]);
    check('   ...and keeps numbering after the last reference', (await p2.ctx.Storage.create('customers', { name: 'Second', phone: '01700000556' })).record.id, 'OFF-A-CUS-0002');
    h = p2;
  }
  const raw = JSON.stringify(await sharedStore.all('journals'));
  ok('the journal holds nothing in clear (no names, amounts or references)', !/Offline Customer|DHAKA-55|OFF-A-CUS|Calls after/.test(raw) && /"pending":/.test(raw), raw.slice(0, 160));
  check('   ...a wrong key opens nothing', await h.ctx.Sync.open({ accountId: ACCOUNT.id, key: btoa('k'.repeat(32)) }), false);
  {
    const p3 = page({ fetch: down() });
    await p3.ctx.Storage.hydrate();
    h = p3;
  }

  console.log('\n-- 5. 14 days, the clock, revocation --');
  {
    const O = h.ctx.Offline;
    const base = { authorizedAt: '2026-11-01T00:00:00.000Z', clientAt: '2026-11-01T02:00:00.000Z' };  // this computer's clock 2h ahead
    const t = (iso, seen = 0) => O.accessWindow(base, { lastSeenAt: seen }, Date.parse(iso));
    check('the window is 14 days from the SERVER\'s time, read through this computer\'s clock offset', [t('2026-11-15T01:00:00Z').ok, t('2026-11-15T02:30:00Z').code], [true, 'expired']);
    check('a clock turned back before the authorization refuses', t('2026-10-31T00:00:00Z').code, 'clock');
    check('a clock turned back before the latest time seen refuses', t('2026-11-03T00:00:00Z', Date.parse('2026-11-05T00:00:00Z')).code, 'clock');
    const later = await O.unlock('advisor', PW, Date.now() + 15 * DAY);
    check('   ...the real copy: 15 days later it will not open', later.code, 'expired');
    const now = await O.unlock('advisor', PW);
    ok('   ...today it opens, and remembers when it was last seen', now.ok && Number((await sharedStore.get('users', ACCOUNT.id)).lastSeenAt) > 0, now.code);
    const back = await O.unlock('advisor', PW, Date.now() - 2 * DAY);
    check('   ...then the clock set two days back: refused', back.code, 'clock');
    await O.markRevoked('Laptop lost');
    check('a device an administrator revoked opens nothing offline', [(await O.unlock('advisor', PW)).code, (await O.openWithSession(ACCOUNT.id, 'x')).code], ['revoked', 'revoked']);
    await sharedStore.del('meta', 'revoked');
  }

  console.log('\n-- 6. online: the sync engine --');
  const pushed = [];
  let mode = 'ok';
  let serverSeq = 0;
  const ids = {};
  const base = fakeApi({ rows: { customers: DATA.collections.customers, vehicles: DATA.collections.vehicles, 'job-cards': DATA.collections.jobCards, parts: DATA.collections.parts, payments: DATA.collections.payments } });
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const server = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    if (path === '/session' && method === 'GET') {
      return json(200, { data: { authenticated: true, passphrase: true, accounts: true, account: ACCOUNT, fullAccess: false, permissions: PERMS, serverTime: new Date().toISOString(), syncCursor: 40 } });
    }
    if (path === '/devices/register') {
      if (mode === 'revoked') return json(403, { error: { code: 'device_revoked', message: 'Revoked by an administrator.' } });
      return json(200, { data: { code: 'A', serverTime: new Date().toISOString(), offlineUntil: '', escrow: Buffer.alloc(32, 7).toString('base64') } });
    }
    if (path === '/sync/push') {
      const body = JSON.parse(init.body);
      pushed.push(body.ops.map((o) => o.kind + ':' + (o.tempId || o.targetId)));
      if (mode === 'down') throw new TypeError('Failed to fetch');
      if (mode === 'signin') return json(401, { error: { code: 'unauthorized', message: 'Authentication required.' } });
      const resolve = (v) => (typeof v === 'string' && ids[v] ? ids[v] : Array.isArray(v) ? v.map(resolve) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)])) : v);
      const results = [];
      for (const o of body.ops) {
        if (o.kind === 'create' || o.kind === 'payment') {
          // Applied the way the server does: through the collection's own create, references resolved.
          const pathOf = { customers: 'customers', vehicles: 'vehicles', jobCards: 'job-cards', payments: 'payments' }[o.collection];
          const made = await (await base(`https://app.taqwa.autos/api/${pathOf}`, { method: 'POST', body: JSON.stringify(resolve(o.data)) })).json();
          ids[o.tempId] = made.data.id;
          results.push({ opId: o.opId, status: 'applied', serverId: made.data.id, record: made.data });
        } else if (o.kind === 'invoice_draft') results.push({ opId: o.opId, status: 'applied', serverId: 'DRF-0001', record: { id: 'DRF-0001', status: 'Draft' } });
        else if (o.kind === 'parts_usage' && o.data.quantity === 2 && o.data.partId) results.push({ opId: o.opId, status: 'conflict', conflictId: 'CNF-0007', type: 'inventory', reason: 'Insufficient stock for Oil Filter.' });
        else if (o.kind === 'update') results.push({ opId: o.opId, status: 'rejected', reason: 'invalid_op', message: 'Not valid.' });
        else if (o.kind === 'status') results.push({ opId: o.opId, status: 'retry', reason: 'dependency_pending' });
        else results.push({ opId: o.opId, status: 'applied', serverId: o.targetId, record: null });
      }
      return json(200, { data: { results } });
    }
    if (path.startsWith('/sync/pull')) {
      serverSeq += 1;
      return json(200, { data: { changes: serverSeq === 1 ? [{ seq: 41, collection: 'customers', id: 'CUS-0009', op: 'upsert', record: { id: 'CUS-0009', name: 'Made on Computer B' } }] : [], cursor: 41, hasMore: false } });
    }
    return base(url, init);
  };
  const on = page({ fetch: server });
  const r = await on.ctx.Storage.hydrate();
  check('online, this tab reopens the journal (its key stayed with the tab) and shows what is waiting', [r.mode, on.ctx.Sync.isOpen(), !!on.ctx.Storage.getById('customers', 'OFF-A-CUS-0001')], ['api', true, true]);
  const res = await on.ctx.Sync.run({ reason: 'test' });
  check('the engine pushes in the order the changes were made', pushed[0].slice(0, 4), ['create:OFF-A-CUS-0001', 'create:OFF-A-VEH-0001', 'create:OFF-A-JOB-0001', 'update:CUS-0001']);
  const SS = on.ctx.Storage;
  const C = ids['OFF-A-CUS-0001'], V = ids['OFF-A-VEH-0001'], J = ids['OFF-A-JOB-0001'];
  check('accepted records take the server\'s ids, and the references follow', [res.ok, /^CUS-\d{4}$/.test(C), !!SS.getById('customers', C), SS.getById('customers', 'OFF-A-CUS-0001'), SS.getById('vehicles', V) && SS.getById('vehicles', V).customerId,
    SS.getById('jobCards', J) && SS.getById('jobCards', J).vehicleId], [true, true, true, null, C, V]);
  check('the pending payment, once accepted, becomes a confirmed payment (and leaves the pending list)', [on.ctx.Sync.pending('payments').length, !!SS.getById('payments', ids['OFF-A-PAY-0001'])], [0, true]);
  const left = on.ctx.Sync.outbox().map((o) => [o.kind, o.state]);
  check('a refused change is kept as failed, a conflict as conflict, one to retry stays waiting', left,
    [['update', 'failed'], ['parts_usage', 'conflict'], ['status', 'pending']]);
  const c = on.ctx.Sync.counts();
  check('   ...and the counts say so', [c.pending, c.conflict, c.failed, c.inventoryReview, c.payments, c.drafts], [1, 1, 1, 1, 0, 0]);
  ok('the pull brought another computer\'s customer', !!SS.getById('customers', 'CUS-0009'), '');
  ok('the history records what synced, with the server ids', on.ctx.Sync.history().some((x) => x.synced && x.tempId === 'OFF-A-CUS-0001' && x.serverId === C), JSON.stringify(on.ctx.Sync.history().slice(0, 3)));
  const st2 = on.ctx.Sync.outbox().find((o) => o.kind === 'status');
  ok('the one to retry waits (exponential back-off)', st2.attempts === 1 && Date.parse(st2.nextAt) > Date.now(), st2);
  await SS.saveOfflineCopy({ force: true });
  const reopened = await on.ctx.Offline.unlock('advisor', PW);
  ok('the copy saved online holds only what the server confirmed: no temporary references, the server\'s version of edited records',
    reopened.ok && !JSON.stringify(reopened.data.collections).includes('OFF-A-') && reopened.data.collections.customers.find((x) => x.id === 'CUS-0001').notes === '' && reopened.data.cursor === 41, reopened.code);
  mode = 'down';
  const failed = await on.ctx.Sync.syncNow();
  check('the network drops mid-sync: nothing is lost, the change waits for later', [failed.ok, on.ctx.Sync.outbox().length], [false, 3]);
  mode = 'signin';
  const signin = await on.ctx.Sync.syncNow();
  check('the session expired: the engine stops and asks for a sign-in', [signin.code, on.ctx.Sync.state.phase], ['unauthorized', 'signin']);
  const n = await on.ctx.Sync.retryFailed();
  check('Retry failed puts failed changes back in the queue', [n, on.ctx.Sync.outbox().filter((o) => o.state === 'failed').length], [1, 0]);

  console.log('\n-- 7. the escrow, two tabs --');
  {
    memory.clear();   // a fresh tab: no keys in sessionStorage
    mode = 'ok';
    const fresh = page({ fetch: server });
    await fresh.ctx.Storage.hydrate();
    ok('a fresh tab online reopens the journal with the server\'s escrow (no password)', fresh.ctx.Sync.isOpen() && fresh.ctx.Sync.outbox().length === 3, fresh.ctx.Sync.outbox().length);
    const other = await fresh.ctx.Offline.journalKeyFromEscrow(ACCOUNT.id, Buffer.alloc(32, 9).toString('base64'));
    check('   ...another person\'s escrow opens nothing', other, null);
    // Two tabs, each with its own view of the journal.
    const tabA = page({ fetch: server }); await tabA.ctx.Storage.hydrate();
    const tabB = page({ fetch: server }); await tabB.ctx.Storage.hydrate();
    await tabA.ctx.Sync.update('customers', 'CUS-0001', { phone: '01700000002' });
    await tabB.ctx.Sync.update('customers', ids['OFF-A-CUS-0001'], { name: 'Renamed' });
    const third = page({ fetch: server }); await third.ctx.Storage.hydrate();
    check('two tabs changing the journal: both changes are kept (each re-reads it before writing)', third.ctx.Sync.outbox().filter((o) => o.kind === 'update').map((o) => o.targetId).sort(), ['CUS-0001', ids['OFF-A-CUS-0001']].sort());
    // Found by the two-computer browser run: saving the copy while the journal key
    // is being set up must not lose it (the wraps live on the journal's own row).
    const P2 = { id: 'USR-0006', username: 'second', name: 'Second Person', staffId: 'STF-0006', role: 'Service Advisor' };
    await fresh.ctx.Offline.enroll(P2, 'Second-Own-Pass-1', 'second');
    await Promise.all([fresh.ctx.Offline.journalKeyFromEscrow(P2.id, Buffer.alloc(32, 3).toString('base64')), fresh.ctx.Offline.saveSnapshot(P2.id, DATA)]);
    const u2 = await fresh.ctx.Offline.unlock('second', 'Second-Own-Pass-1');
    ok('saving the copy while the journal key is set up does not lose it: the password still opens the journal', u2.ok && typeof u2.journalKey === 'string', u2.code);
    mode = 'revoked';
    memory.clear();
    const rv = page({ fetch: server });
    await rv.ctx.Storage.hydrate();
    const out = await rv.ctx.Sync.run({ reason: 'test' });
    check('a device revoked by an administrator: the engine stops, offline access closes, the changes are kept', [out.code, (await rv.ctx.Offline.revoked()) !== null, (await sharedStore.all('journals')).some((j) => j.accountId === ACCOUNT.id && j.ciphertext && j.summary.pending + j.summary.failed > 0)], ['device_revoked', true, true]);
  }

  process.exit(summary('offline-sync-client') === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
