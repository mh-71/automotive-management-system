/* ============================================================
   sync.js — working offline: the local repository, the outbox
   and the sync engine (Phases 2-4)
   ------------------------------------------------------------
   Storage (js/storage.js) still answers every page. When the
   server cannot be reached and the person has opened their
   encrypted offline copy, Storage hands writes to this file
   instead of refusing them:

     - The change is kept in this person's encrypted JOURNAL
       (js/offline.js), never in localStorage, and shown at once.
     - A record made offline gets a UUID and a TEMPORARY REFERENCE
       such as OFF-A-CUS-0007 (A = this computer's code from the
       server). It is never a server id: the server gives the
       official one (CUS-0042) when it accepts the record, and the
       temporary reference is kept with it for audit.
     - Every change is an OPERATION with its own UUID in the outbox,
       sent in order. "Synced" is shown only after the server says
       it accepted it; anything it would not apply is kept, marked
       as a conflict or as failed -- never silently dropped.

   OWNER DECISIONS, AS CODE
     Payments    offline = PENDING. Kept apart from the confirmed
                 payments, so no balance, advance or report counts
                 them until the server accepts them.
     Invoices    offline = DRAFT. No invoice number; the server keeps
                 it as a draft until an authorized person finalizes it.
     Parts used  offline = movements (+ use / - return) per part,
                 applied by the server through the job card's stock
                 rules; a shortage is flagged for review.
     Deletes     need the internet (nothing is deleted offline).
     Accounts, roles, settings and money actions (void, link,
                 write-off) need the internet.

   THE ENGINE (online): push the outbox in order, in batches, with
   exponential back-off; then pull what changed on the server since
   this page's cursor (a server sequence number, never this
   computer's clock); then refresh the encrypted copy.
   ============================================================ */

const Sync = (() => {
  const PREFIX = {
    customers: 'CUS', vehicles: 'VEH', appointments: 'APT', jobCards: 'JOB', expenses: 'EXP',
    services: 'SRV', mechanics: 'MEC', payments: 'PAY', invoiceDrafts: 'DRF', inventoryTransactions: 'STK',
  };
  /** Collections a person may create and edit offline, and the permission module behind each. */
  const MODULE = {
    customers: 'customers', vehicles: 'vehicles', appointments: 'appointments', jobCards: 'job_cards',
    expenses: 'expenses', services: 'services', mechanics: 'mechanics',
  };
  const LABEL = {
    customers: 'customer', vehicles: 'vehicle', appointments: 'appointment', jobCards: 'job card', expenses: 'expense',
    services: 'service', mechanics: 'mechanic', payments: 'payment', invoiceDrafts: 'invoice draft', inventoryTransactions: 'stock movement',
  };
  const TEMP = /^OFF-[A-Z0-9]{1,8}-[A-Z]{3}-\d{4,}$/;
  const isTemp = (id) => typeof id === 'string' && TEMP.test(id);
  const BATCH = 25;
  const HISTORY_MAX = 300;
  const KEY_SESSION = 'taqwa_journal_session';
  const DEVICE_SESSION = 'taqwa_sync_device';

  let host = null;       // Storage's internals (bind())
  let session = null;    // { accountId, key }
  let journal = null;    // this tab's copy of the journal
  const memBase = {};    // collection -> id -> the server's version of a record edited offline
  let running = null;
  let state = { phase: 'idle', at: null, error: null };
  const listeners = new Set();

  const now = () => new Date().toISOString();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16; return (c === 'x' ? r : (r & 3) | 8).toString(16); }));
  const ss = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };

  const OFFLINE_ONLY = (what) => ({ ok: false, code: 'offline', message: `You are offline. ${what} needs the internet; it can be done when the connection is back.` });
  const FORBIDDEN = { ok: false, code: 'forbidden', message: 'Your role does not allow this.' };
  const NOT_OPEN = { ok: false, code: 'offline', message: 'You are offline, and changes cannot be saved on this computer right now. Connect to the internet and sign in.' };

  /* ---------- binding and opening ---------- */

  /** Storage gives this file what it needs of its internals (once, at load). */
  function bind(h) { host = h; }

  function emptyJournal(accountId) {
    return { accountId, records: {}, localOnly: { payments: [], invoiceDrafts: [], inventoryTransactions: [] }, outbox: [], history: [], bases: {}, idMap: {}, lastSync: null };
  }

  function summarize(j) {
    const s = { pending: 0, conflict: 0, failed: 0 };
    for (const o of (j && j.outbox) || []) if (s[o.state] !== undefined) s[o.state] += 1;
    return s;
  }

  /** Open this person's journal with its key. False when the key does not open it. */
  async function open({ accountId, key }) {
    try {
      const data = await Offline.readJournal(accountId, key);
      session = { accountId, key };
      journal = data || emptyJournal(accountId);
      for (const k of ['records', 'localOnly', 'bases', 'idMap']) journal[k] = journal[k] || emptyJournal(accountId)[k];
      for (const k of ['payments', 'invoiceDrafts', 'inventoryTransactions']) journal.localOnly[k] = journal.localOnly[k] || [];
      journal.outbox = journal.outbox || [];
      journal.history = journal.history || [];
      return true;
    } catch (e) {
      session = null; journal = null;
      return false;
    }
  }
  const isOpen = () => !!(session && journal);
  function close() { session = null; journal = null; Object.keys(memBase).forEach((k) => delete memBase[k]); }

  /** The tab remembers the journal key the way it remembers the copy's (sessionStorage; ends with the tab). */
  function rememberKey(accountId, key) { ss.set(KEY_SESSION, { accountId, key, at: Date.now() }); }
  function rememberedKey(accountId) { const s = ss.get(KEY_SESSION); return s && s.accountId === accountId && s.key ? s.key : null; }
  function forgetKey() { ss.del(KEY_SESSION); ss.del(DEVICE_SESSION); ss.del('taqwa_escrow_ok'); }

  /**
   * Show the journal's records over the cache: what was made or edited offline
   * appears where the pages look for it. The server's own version of an edited
   * record is remembered (memBase), so the encrypted copy keeps the server's.
   */
  function overlay() {
    if (!isOpen() || !host) return;
    for (const [c, byId] of Object.entries(journal.records)) {
      for (const rec of Object.values(byId)) {
        if (!rec || !rec._sync || ['dismissed', 'synced'].includes(rec._sync.state)) continue;
        const current = host.cacheGet(c, rec.id);
        if (current && !current._sync) (memBase[c] || (memBase[c] = {}))[rec.id] = current;
        host.cachePut(c, rec);
      }
    }
  }

  /** For the encrypted copy: the server's version of a cached record (null for one that exists only here). */
  function baseFor(collection, record) {
    if (!record || !record._sync) return record;
    if (isTemp(record.id)) return null;
    return (memBase[collection] && memBase[collection][record.id]) || (journal && journal.bases[collection] && journal.bases[collection][record.id]) || null;
  }

  /* ---------- the journal, changed safely ---------- */

  /**
   * Every change re-reads the journal first and writes it back whole, one
   * tab at a time (Web Locks), so two tabs never overwrite each other's work.
   */
  async function mutate(fn) {
    if (!isOpen()) return NOT_OPEN;
    const run = async () => {
      const fresh = (await Offline.readJournal(session.accountId, session.key)) || emptyJournal(session.accountId);
      for (const k of ['records', 'localOnly', 'bases', 'idMap']) fresh[k] = fresh[k] || emptyJournal(session.accountId)[k];
      for (const k of ['payments', 'invoiceDrafts', 'inventoryTransactions']) fresh.localOnly[k] = fresh.localOnly[k] || [];
      fresh.outbox = fresh.outbox || []; fresh.history = fresh.history || [];
      const out = await fn(fresh);
      if (fresh.history.length > HISTORY_MAX) fresh.history.splice(0, fresh.history.length - HISTORY_MAX);
      await Offline.writeJournal(session.accountId, session.key, fresh, summarize(fresh));
      journal = fresh;
      return out;
    };
    const out = (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request)
      ? await navigator.locks.request(`taqwa-journal-${session.accountId}`, run)
      : await run();
    emit();
    return out;
  }

  function newOp(kind, fields) {
    return { opId: uuid(), kind, ...fields, createdAt: now(), by: session.accountId, state: 'pending', attempts: 0 };
  }
  function note(j, text, extra = {}) { j.history.push({ at: now(), text, ...extra }); }

  async function tempRef(prefix) {
    const dev = await Offline.deviceInfo();
    const n = await Offline.nextSequence(prefix);
    return { ref: `OFF-${dev.code}-${prefix}-${String(n).padStart(4, '0')}`, device: dev };
  }

  const can = (perm) => !host || host.can(perm);

  /* ---------- offline writes (what Storage hands over) ---------- */

  async function create(collection, body, display) {
    if (collection === 'payments') return createPayment(body);
    if (collection === 'invoices') return createDraft(body);
    if (collection === 'inventoryTransactions') return createMovement(body);
    if (!MODULE[collection]) return OFFLINE_ONLY(`Adding ${collection}`);
    if (!can(`${MODULE[collection]}.create`)) return FORBIDDEN;
    const { ref, device } = await tempRef(PREFIX[collection]);
    return mutate((j) => {
      const at = now();
      const rec = {
        ...(display ? clone(display) : {}), ...clone(body), id: ref, uuid: uuid(), createdAt: at, updatedAt: at,
        _sync: { state: 'pending', tempRef: ref, by: session.accountId, device: device.code, at },
      };
      if (collection === 'jobCards') {
        rec.services = rec.services || []; rec.partsUsed = rec.partsUsed || []; rec.status = rec.status || 'Received';
      }
      (j.records[collection] || (j.records[collection] = {}))[ref] = rec;
      j.outbox.push(newOp('create', { collection, tempId: ref, data: clone(body) }));
      note(j, `${LABEL[collection]} ${ref} saved offline`, { tempId: ref });
      host.cachePut(collection, rec);
      return { ok: true, record: rec, pending: true, meta: {} };
    });
  }

  /** The parts-line movements between two versions of a job card's parts (per part; + use, - return). */
  function partsMovements(before, after) {
    const key = (l) => (l.partId ? `p:${l.partId}` : `n:${String(l.name || '').trim()}`);
    const sum = (lines) => {
      const m = new Map();
      for (const l of lines || []) {
        const k = key(l);
        const cur = m.get(k) || { partId: l.partId || null, name: l.name, partNo: l.partNo || '', qty: 0, unitPrice: Number(l.unitPrice) || 0 };
        cur.qty += Number(l.qty) || 0;
        m.set(k, cur);
      }
      return m;
    };
    const a = sum(before); const b = sum(after);
    const moves = [];
    for (const k of new Set([...a.keys(), ...b.keys()])) {
      const was = a.get(k); const is = b.get(k);
      const d = (is ? is.qty : 0) - (was ? was.qty : 0);
      if (!d) continue;
      const line = is || was;
      moves.push({ partId: line.partId, name: line.name, partNo: line.partNo, quantity: d, ...(line.partId ? {} : { unitPrice: line.unitPrice }) });
    }
    return moves;
  }

  async function update(collection, id, changes, display) {
    if (!MODULE[collection]) return OFFLINE_ONLY(`Changing ${collection}`);
    if (!can(`${MODULE[collection]}.edit`)) return FORBIDDEN;
    if (!host.cacheGet(collection, id)) return { ok: false, code: 'not_found', message: 'That record no longer exists.' };
    return mutate((j) => {
      const current = host.cacheGet(collection, id);
      const asked = clone(changes || {});
      const data = {};
      for (const [k, v] of Object.entries(asked)) if (!same(current[k], v)) data[k] = v;
      const pendingCreate = isTemp(id) && j.outbox.find((o) => o.kind === 'create' && o.tempId === id && o.state === 'pending');
      if (!Object.keys(data).length) return { ok: true, record: current, meta: {} };
      const at = now();
      if (pendingCreate) {
        // Never seen by the server yet: the change simply becomes part of the record it will receive.
        Object.assign(pendingCreate.data, data);
      } else {
        const base = (memBase[collection] && memBase[collection][id]) || (j.bases[collection] && j.bases[collection][id]) || (current._sync ? null : current) || current;
        if (!isTemp(id) && !current._sync) (j.bases[collection] || (j.bases[collection] = {}))[id] = clone(current);
        let parts;
        if (collection === 'jobCards' && data.partsUsed !== undefined) { parts = partsMovements(current.partsUsed, data.partsUsed); delete data.partsUsed; }
        if (Object.keys(data).length) {
          const open = j.outbox.find((o) => o.kind === 'update' && o.collection === collection && o.targetId === id && o.state === 'pending');
          if (open) {
            for (const k of Object.keys(data)) if (!Object.hasOwn(open.base.values, k)) open.base.values[k] = clone(base[k] ?? null);
            Object.assign(open.data, data);
          } else {
            j.outbox.push(newOp('update', { collection, targetId: id, data, base: { values: Object.fromEntries(Object.keys(data).map((k) => [k, clone(base[k] ?? null)])), updatedAt: base.updatedAt || null } }));
          }
        }
        for (const m of parts || []) j.outbox.push(newOp('parts_usage', { collection: 'jobCards', targetId: id, data: m }));
      }
      const rec = { ...current, ...(display ? clone(display) : {}), ...asked, id, updatedAt: at,
        _sync: { ...(current._sync || {}), state: 'pending', tempRef: (current._sync && current._sync.tempRef) || null, by: session.accountId, at } };
      (j.records[collection] || (j.records[collection] = {}))[id] = rec;
      note(j, `${LABEL[collection]} ${id} changed offline`, { targetId: id });
      host.cachePut(collection, rec);
      return { ok: true, record: rec, pending: true, meta: {} };
    });
  }

  async function action(collection, id, name, body = {}) {
    if (collection !== 'jobCards' || name !== 'status') return OFFLINE_ONLY('This action');
    if (!can('job_cards.manage')) return FORBIDDEN;
    const current = host.cacheGet('jobCards', id);
    if (!current) return { ok: false, code: 'not_found', message: 'That record no longer exists.' };
    const next = body && body.status;
    if (typeof next !== 'string' || !next) return { ok: false, code: 'invalid', message: 'Choose a status.' };
    return mutate((j) => {
      const cur = host.cacheGet('jobCards', id);
      const base = (memBase.jobCards && memBase.jobCards[id]) || (j.bases.jobCards && j.bases.jobCards[id]) || cur;
      if (!isTemp(id) && !cur._sync) (j.bases.jobCards || (j.bases.jobCards = {}))[id] = clone(cur);
      const prior = j.outbox.filter((o) => o.kind === 'status' && o.targetId === id && o.state === 'pending').pop();
      j.outbox.push(newOp('status', { collection: 'jobCards', targetId: id, data: { status: next }, base: { status: prior ? prior.data.status : base.status } }));
      const at = now();
      const rec = { ...cur, status: next, updatedAt: at,
        ...(next === 'Completed' && !cur.completedAt ? { completedAt: at } : {}),
        ...(next === 'Delivered' && !cur.actualDelivery ? { actualDelivery: at.slice(0, 10) } : {}),
        _sync: { ...(cur._sync || {}), state: 'pending', tempRef: (cur._sync && cur._sync.tempRef) || null, by: session.accountId, at } };
      (j.records.jobCards || (j.records.jobCards = {}))[id] = rec;
      note(j, `job card ${id} moved to ${next} offline`, { targetId: id });
      host.cachePut('jobCards', rec);
      return { ok: true, record: rec, pending: true, meta: {} };
    });
  }

  /** A payment made offline: PENDING -- kept apart from confirmed payments until the server accepts it. */
  async function createPayment(body) {
    if (!can('payments.create')) return FORBIDDEN;
    const amount = Number(body && body.amount);
    if (!(amount > 0) || !body.customerId) return { ok: false, code: 'invalid', message: 'A pending payment needs a customer and an amount above zero.' };
    const { ref, device } = await tempRef('PAY');
    return mutate((j) => {
      const at = now();
      const rec = { ...clone(body), amount, id: ref, uuid: uuid(), status: 'Pending', createdAt: at,
        _sync: { state: 'pending', tempRef: ref, by: session.accountId, device: device.code, at } };
      j.localOnly.payments.push(rec);
      j.outbox.push(newOp('payment', { collection: 'payments', tempId: ref, data: clone(body) }));
      note(j, `payment ${ref} recorded offline as PENDING (not confirmed)`, { tempId: ref });
      return { ok: true, record: rec, pending: true, meta: {} };
    });
  }

  /** An invoice made offline: a DRAFT, with no number, until it is finalized online. */
  async function createDraft(body) {
    if (!can('invoices.create')) return FORBIDDEN;
    const job = body && host.cacheGet('jobCards', body.jobCardId);
    if (!job) return { ok: false, code: 'not_found', message: 'That job card is not on this computer.' };
    const { ref, device } = await tempRef('DRF');
    return mutate((j) => {
      const at = now();
      const rec = { id: ref, uuid: uuid(), jobCardId: job.id, customerId: job.customerId, vehicleId: job.vehicleId, date: body.date || '', notes: body.notes || '',
        status: 'Draft', localTotal: Number(job.total) || 0, createdAt: at, _sync: { state: 'pending', tempRef: ref, by: session.accountId, device: device.code, at } };
      j.localOnly.invoiceDrafts.push(rec);
      j.outbox.push(newOp('invoice_draft', { collection: 'invoices', tempId: ref, data: {
        jobCardId: job.id, date: body.date || null, notes: body.notes || '', localTotal: Number(job.total) || 0,
        lines: { services: clone(job.services || []), partsUsed: clone(job.partsUsed || []), total: Number(job.total) || 0 } } }));
      note(j, `invoice draft ${ref} saved offline for ${job.id} (no invoice number until finalized online)`, { tempId: ref });
      return { ok: true, record: rec, draft: true, pending: true, meta: {} };
    });
  }

  /** A manual stock movement made offline: applied by the server's stock rules, never assumed here. */
  async function createMovement(body) {
    if (!can('inventory.manage')) return FORBIDDEN;
    const { ref, device } = await tempRef('STK');
    return mutate((j) => {
      const at = now();
      const rec = { ...clone(body), id: ref, uuid: uuid(), createdAt: at, _sync: { state: 'pending', tempRef: ref, by: session.accountId, device: device.code, at } };
      j.localOnly.inventoryTransactions.push(rec);
      j.outbox.push(newOp('stock_movement', { collection: 'inventoryTransactions', tempId: ref, data: clone(body) }));
      note(j, `stock movement ${ref} recorded offline (stock changes when the server accepts it)`, { tempId: ref });
      return { ok: true, record: rec, pending: true, meta: {} };
    });
  }

  /* ---------- reading what is waiting ---------- */

  /** Records kept apart from the confirmed ones: pending payments, invoice drafts, stock movements. */
  function pending(kind) {
    if (!isOpen()) return [];
    return clone((journal.localOnly[kind] || []).filter((r) => !r._sync || !['synced'].includes(r._sync.state)));
  }

  function outbox() { return isOpen() ? clone(journal.outbox) : []; }
  function history() { return isOpen() ? clone(journal.history).reverse() : []; }

  function counts() {
    const c = { pending: 0, syncing: 0, conflict: 0, failed: 0, dismissed: 0, synced: 0, drafts: 0, payments: 0, inventoryReview: 0 };
    if (!isOpen()) return c;
    for (const o of journal.outbox) {
      if (c[o.state] !== undefined) c[o.state] += 1;
      if (o.state === 'conflict' && (o.kind === 'parts_usage' || o.kind === 'stock_movement')) c.inventoryReview += 1;
    }
    c.synced = journal.history.filter((h) => h.synced).length;
    c.drafts = journal.localOnly.invoiceDrafts.filter((r) => r._sync && r._sync.state !== 'synced').length;
    c.payments = journal.localOnly.payments.filter((r) => r._sync && r._sync.state !== 'synced').length;
    return c;
  }

  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() { for (const fn of listeners) { try { fn({ counts: counts(), state }); } catch (e) { /* a listener's own problem */ } } }

  /* ---------- the engine ---------- */

  /** Register this computer for the signed-in person (online). Remembered for the tab. */
  async function ensureDevice({ force = false } = {}) {
    const acct = host && host.account;
    if (!acct || !host.isApi()) return { ok: false, code: 'offline' };
    const cached = ss.get(DEVICE_SESSION);
    if (!force && cached && cached.accountId === acct.id && Date.now() - cached.at < 30 * 60000) return { ok: true, ...cached };
    const deviceId = await Offline.deviceId();
    const res = await Api.post('/devices/register', { deviceId, label: deviceLabel() });
    if (!res.ok) {
      if (res.code === 'device_revoked') { await Offline.markRevoked(res.message); return { ok: false, code: 'device_revoked', message: res.message }; }
      return res;
    }
    await Offline.setDeviceCode(res.data.code);
    const info = { accountId: acct.id, deviceId, code: res.data.code, at: Date.now(), serverTime: res.data.serverTime, offlineUntil: res.data.offlineUntil };
    ss.set(DEVICE_SESSION, info);
    return { ok: true, ...info, escrow: res.data.escrow };
  }
  function deviceLabel() {
    try { return `${navigator.platform || 'Computer'} · ${(navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/) || ['browser'])[0]}`.slice(0, 80); } catch (e) { return ''; }
  }

  /**
   * Online with a session: open this person's journal without the password
   * (the server's escrow for this device), if they have one on this computer.
   * Called by Storage during hydration, before the first render.
   */
  async function attachOnline() {
    const acct = host && host.account;
    if (!acct || typeof Offline === 'undefined' || !Offline.supported()) return false;
    let key = rememberedKey(acct.id);
    if (!key) {
      const has = (await Offline.journalSummaries()).some((s) => s.accountId === acct.id);
      if (!has) return false;
      const reg = await ensureDevice({ force: true });
      if (!reg.ok || !reg.escrow) return false;
      key = await Offline.journalKeyFromEscrow(acct.id, reg.escrow);
      if (!key) return false;
      rememberKey(acct.id, key);
    }
    if (!(await open({ accountId: acct.id, key }))) return false;
    overlay();
    return true;
  }

  /** Offline, after the copy is opened: the journal key came with it. */
  async function attachOffline(accountId, key) {
    if (!key) return false;
    rememberKey(accountId, key);
    if (!(await open({ accountId, key }))) return false;
    overlay();
    return true;
  }

  /** Online: make sure the person has a journal on this computer, so going offline later can save changes. */
  async function prepare() {
    const acct = host && host.account;
    if (!acct || !host.isApi() || isOpen() || typeof Offline === 'undefined' || !Offline.supported()) return isOpen();
    const reg = await ensureDevice();
    const escrow = reg.escrow || (await ensureDevice({ force: true })).escrow;
    if (!escrow) return false;
    const key = await Offline.journalKeyFromEscrow(acct.id, escrow);
    if (!key) return false;
    rememberKey(acct.id, key);
    return open({ accountId: acct.id, key });
  }

  const backoff = (n) => Math.min(2000 * 2 ** Math.max(0, n - 1), 10 * 60000);
  const wire = (o) => ({ opId: o.opId, kind: o.kind, collection: o.collection, tempId: o.tempId || null, targetId: o.targetId || null, data: o.data, base: o.base || null, createdAt: o.createdAt });

  /** Replace a temporary reference everywhere this computer still holds it. */
  function rewrite(j, from, to) {
    const walk = (v) => {
      if (v === from) return to;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = walk(v[k]); return v; }
      return v;
    };
    for (const byId of Object.values(j.records)) for (const r of Object.values(byId)) walk(r);
    for (const list of Object.values(j.localOnly)) list.forEach(walk);
    for (const o of j.outbox) { if (o.targetId === from) o.targetId = to; walk(o.data); }
    for (const c of host.collections) for (const r of host.cacheAll(c)) if (r && r._sync) walk(r);
    if (j.records) for (const c of Object.keys(j.records)) if (j.records[c][from]) { j.records[c][to] = j.records[c][from]; delete j.records[c][from]; }
  }

  function settleRecord(j, collection, id, serverRecord) {
    const stillPending = j.outbox.some((o) => o.targetId === id && ['pending', 'conflict', 'failed'].includes(o.state));
    if (stillPending) {
      if (serverRecord) {
        (j.bases[collection] || (j.bases[collection] = {}))[id] = clone(serverRecord);
        (memBase[collection] || (memBase[collection] = {}))[id] = serverRecord;
      }
      return;
    }
    if (j.records[collection]) delete j.records[collection][id];
    if (j.bases[collection]) delete j.bases[collection][id];
    if (memBase[collection]) delete memBase[collection][id];
    if (serverRecord) host.cachePut(collection, serverRecord);
  }

  function applyResult(j, r, stale) {
    const o = j.outbox.find((x) => x.opId === r.opId);
    if (!o) return;
    const at = now();
    if (r.status === 'applied') {
      o.state = 'synced'; o.serverId = r.serverId || null; o.syncedAt = at; o.error = null;
      const rec = r.record || null;
      if (o.kind === 'create') {
        j.idMap[o.tempId] = r.serverId;
        host.cacheDrop(o.collection, o.tempId);
        rewrite(j, o.tempId, r.serverId);
        settleRecord(j, o.collection, r.serverId, rec);
      } else if (o.kind === 'update' || o.kind === 'status' || o.kind === 'parts_usage') {
        settleRecord(j, o.collection, o.targetId, rec);
        if (o.kind !== 'update') stale.add('parts').add('inventoryTransactions');
      } else if (o.kind === 'payment') {
        j.localOnly.payments = j.localOnly.payments.filter((p) => p.id !== o.tempId);
        if (rec) host.cachePut('payments', rec);
        stale.add('payments').add('invoices').add('jobCards');
      } else if (o.kind === 'invoice_draft') {
        j.localOnly.invoiceDrafts = j.localOnly.invoiceDrafts.filter((p) => p.id !== o.tempId);
      } else if (o.kind === 'stock_movement') {
        j.localOnly.inventoryTransactions = j.localOnly.inventoryTransactions.filter((p) => p.id !== o.tempId);
        stale.add('parts').add('inventoryTransactions');
      }
      note(j, `${LABEL[o.collection] || o.collection} ${o.tempId || o.targetId || ''} accepted by the server${r.serverId && r.serverId !== o.targetId ? ` as ${r.serverId}` : ''}`.replace(/\s+/g, ' '), { synced: true, opId: o.opId, tempId: o.tempId || null, serverId: r.serverId || null, kind: o.kind });
      j.outbox = j.outbox.filter((x) => x !== o);
      return;
    }
    if (r.status === 'conflict') {
      if (o.state !== 'conflict') note(j, `${LABEL[o.collection] || o.collection} ${o.tempId || o.targetId || ''}: conflict -- ${r.reason}`, { opId: o.opId, conflictId: r.conflictId });
      o.state = 'conflict'; o.conflictId = r.conflictId || o.conflictId || null; o.error = r.reason || o.error || 'Needs review.';
      markRecord(j, o, 'conflict');
      return;
    }
    if (r.status === 'dismissed') {
      o.state = 'dismissed'; o.error = (r.reason ? `Not accepted: ${r.reason}` : 'Not accepted by an administrator.');
      markRecord(j, o, 'dismissed');
      if (o.kind === 'create' && host.cacheGet(o.collection, o.tempId)) host.cacheDrop(o.collection, o.tempId);
      note(j, `${LABEL[o.collection] || o.collection} ${o.tempId || o.targetId || ''} was not accepted (decided by an administrator); kept here for the record`, { opId: o.opId });
      return;
    }
    if (r.status === 'rejected') {
      o.state = 'failed'; o.error = r.message || r.reason || 'The server refused this change.';
      markRecord(j, o, 'failed');
      note(j, `${LABEL[o.collection] || o.collection} ${o.tempId || o.targetId || ''}: failed -- ${o.error}`, { opId: o.opId });
      return;
    }
    // retry
    o.attempts = (o.attempts || 0) + 1;
    o.nextAt = new Date(Date.now() + backoff(o.attempts)).toISOString();
    o.error = r.reason || 'Will try again.';
  }

  function markRecord(j, o, s) {
    const lists = { payment: 'payments', invoice_draft: 'invoiceDrafts', stock_movement: 'inventoryTransactions' };
    if (lists[o.kind]) {
      const r = j.localOnly[lists[o.kind]].find((x) => x.id === o.tempId);
      if (r) r._sync = { ...r._sync, state: s, error: o.error, conflictId: o.conflictId || null };
      return;
    }
    const id = o.kind === 'create' ? o.tempId : o.targetId;
    const r = j.records[o.collection] && j.records[o.collection][id];
    if (r) {
      r._sync = { ...r._sync, state: s, error: o.error, conflictId: o.conflictId || null };
      if (s !== 'dismissed' && host.cacheGet(o.collection, id)) host.cachePut(o.collection, r);
    }
  }

  /**
   * Send what is waiting, then pull what changed. Only one run at a time per
   * tab; another tab's run is kept apart by a Web Lock.
   */
  function run({ reason = 'manual', pull: doPull = true } = {}) {
    if (running) return running;
    running = (async () => {
      try {
        const go = () => runOnce(reason, doPull);
        return (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request && session)
          ? await navigator.locks.request(`taqwa-sync-${session.accountId}`, go)
          : await go();
      } finally { running = null; }
    })();
    return running;
  }

  async function runOnce(reason, doPull) {
    if (!host || !host.isApi()) return { ok: false, code: 'offline' };
    // The device first: a revoked one stops here, whatever else is on this computer.
    let dev = await ensureDevice({ force: !ss.get('taqwa_escrow_ok') });
    if (!dev.ok && dev.code === 'device_revoked') {
      state = { phase: 'revoked', at: now(), error: dev.message || dev.code }; emit();
      return { ok: false, code: 'device_revoked', message: dev.message };
    }
    if (!isOpen()) { await prepare(); dev = await ensureDevice(); }
    if (!isOpen()) return { ok: false, code: 'no_journal' };
    state = { phase: 'syncing', at: now(), error: null }; emit();
    if (dev.ok && dev.escrow) {
      // The journal can now also be reopened online, without the password (a new tab, a reset password).
      try { if (await Offline.ensureEscrow(session.accountId, session.key, dev.escrow)) ss.set('taqwa_escrow_ok', session.accountId); } catch (e) { /* next run */ }
    }
    if (!dev.ok) {
      state = { phase: dev.code === 'device_revoked' ? 'revoked' : 'error', at: now(), error: dev.message || dev.code };
      emit();
      return { ok: false, code: dev.code, message: dev.message };
    }
    // Pick up anything another tab wrote since this one read the journal.
    await mutate(() => null);
    const stale = new Set();
    let sent = 0;
    for (let round = 0; round < 40; round++) {
      const due = journal.outbox.filter((o) => ['pending', 'conflict', 'syncing'].includes(o.state) && !(o.nextAt && Date.parse(o.nextAt) > Date.now()));
      if (!due.length) break;
      const batch = due.slice(0, BATCH);
      const res = await Api.post('/sync/push', { deviceId: dev.deviceId, ops: batch.map(wire) });
      if (!res.ok) {
        if (res.code === 'device_revoked') { await Offline.markRevoked(res.message); state = { phase: 'revoked', at: now(), error: res.message }; emit(); return { ok: false, code: 'device_revoked', message: res.message }; }
        if (res.status === 401 || res.code === 'unauthorized') { state = { phase: 'signin', at: now(), error: 'Sign in again to send the changes waiting on this computer.' }; emit(); return { ok: false, code: 'unauthorized' }; }
        // The network or the server: try these again later.
        await mutate((j) => { for (const b of batch) { const o = j.outbox.find((x) => x.opId === b.opId); if (o) { o.attempts = (o.attempts || 0) + 1; o.nextAt = new Date(Date.now() + backoff(o.attempts)).toISOString(); o.error = res.message || res.code; } } });
        state = { phase: 'error', at: now(), error: res.message || res.code }; emit();
        return { ok: false, code: res.code, message: res.message };
      }
      const results = (res.data && res.data.results) || [];
      await mutate((j) => { for (const r of results) applyResult(j, r, stale); });
      sent += results.filter((r) => r.status === 'applied' && !r.replayed).length;
      if (results.every((r) => r.status === 'retry' || r.replayed || r.status === 'conflict')) break;
    }
    for (const c of stale) { try { await host.reload(c); } catch (e) { /* the page says it may be stale */ } }
    let pulled = 0;
    if (doPull) pulled = await pull(dev.deviceId);
    await mutate((j) => { j.lastSync = { at: now(), sent, pulled, reason }; });
    if (sent || pulled) { try { await host.saveCopy(); } catch (e) { /* the copy is refreshed on the next page */ } }
    state = { phase: 'idle', at: now(), error: null }; emit();
    return { ok: true, sent, pulled, counts: counts() };
  }

  /** Changes since this page's cursor: applied to what is on screen; the cursor moves only after. */
  async function pull(deviceId) {
    let cursor = host.cursor;
    if (!Number.isInteger(cursor)) return 0;
    let applied = 0;
    const refresh = new Set();
    for (let page = 0; page < 20; page++) {
      const res = await Api.get(`/sync/pull?deviceId=${encodeURIComponent(deviceId)}&cursor=${cursor}&limit=200`);
      if (!res.ok) break;
      for (const ch of res.data.changes || []) {
        if (!host.collections.includes(ch.collection)) continue;
        // Another write moved this collection as a side effect (a payment, its invoice): read it again.
        if (ch.op === 'refresh') { refresh.add(ch.collection); continue; }
        const local = host.cacheGet(ch.collection, ch.id);
        if (ch.op === 'upsert' && ch.record) {
          if (local && local._sync) (memBase[ch.collection] || (memBase[ch.collection] = {}))[ch.id] = ch.record;
          else host.cachePut(ch.collection, ch.record);
          applied += 1;
        } else if (ch.op === 'delete' && local && !local._sync) {
          host.cacheDrop(ch.collection, ch.id);
          applied += 1;
        }
      }
      if (!res.data.hasMore) {
        // The cursor moves only once what it covers is on screen.
        for (const c of refresh) { try { if ((await host.reload(c)).ok) applied += 1; } catch (e) { /* stays as it was */ } }
        cursor = res.data.cursor; host.cursor = cursor;
        break;
      }
      cursor = res.data.cursor; host.cursor = cursor;
    }
    return applied;
  }

  /** Put failed operations back in the queue (the Retry Failed button). */
  async function retryFailed() {
    return mutate((j) => {
      let n = 0;
      for (const o of j.outbox) if (o.state === 'failed') { o.state = 'pending'; o.attempts = 0; o.nextAt = null; n += 1; markRecord(j, o, 'pending'); }
      if (n) note(j, `${n} failed change${n > 1 ? 's' : ''} put back in the queue`);
      return n;
    });
  }

  /** Try everything due now, ignoring the back-off (Sync Now). */
  async function syncNow() {
    if (isOpen()) await mutate((j) => { for (const o of j.outbox) if (o.state === 'pending') o.nextAt = null; });
    return run({ reason: 'manual' });
  }

  return {
    bind, open, isOpen, close, overlay, baseFor, attachOnline, attachOffline, prepare, rememberKey, forgetKey,
    create, update, action, pending, outbox, history, counts, on, run, syncNow, retryFailed, ensureDevice,
    partsMovements, isTemp,
    get bound() { return !!host; },
    get state() { return state; },
    get lastSync() { return journal ? journal.lastSync : null; },
    get accountId() { return session ? session.accountId : null; },
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Sync };
