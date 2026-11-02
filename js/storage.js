/* ============================================================
   storage.js — Centralized data layer for Taqwa Automobile SC
   ------------------------------------------------------------
   ALL persistence goes through this file. UI code never touches
   localStorage and never touches fetch(); it calls the same
   getData / getById / addData / updateData / deleteData it always
   has.

   ---- two sources, one interface ----

   MODE 'api'     the Worker + D1 are answering and this browser is
                  signed in. D1 is the source of truth for every
                  business record.
   MODE 'locked'  the Worker is answering but this browser has no
                  session. Nothing is read and nothing is cached;
                  the app shows a sign-in form.
   MODE 'local'   no backend is reachable at all. localStorage is
                  the source of truth, exactly as before this file
                  learned about the API.

   'locked' is deliberately NOT 'local'. Falling back to browser
   storage because the user has not signed in yet would hand them
   a private copy of an empty workshop and quietly accept writes
   into it -- which is the one thing this layer exists to prevent.

   The mode is decided once, by asking GET /api/health, and never
   flips underneath a running page. A page opened from disk, or
   with no Worker running, behaves precisely as it did before --
   that is the point: adding a backend must not take the app away
   from someone who does not have one.

   ---- why reads stayed synchronous ----

   256 call sites read through getData/getById, many of them inside
   .filter() and .map() callbacks that run per table row. Making
   them async would mean rewriting every UI module. So hydration
   pulls each collection ONCE into an in-memory cache before the
   first render, and the readers keep their signatures and read the
   cache. The network is crossed at startup, not per row.

   ---- why writes could not stay synchronous ----

   A write has to be told whether the server accepted it, and the
   server owns what the record becomes: its id, its totals, its
   balance, its stock. Guessing locally and reconciling later would
   mean showing the user a number the database never agreed to. So
   create/update/remove return promises, and the cache is updated
   from the RESPONSE -- never from what we sent.

   The old synchronous addData/updateData/deleteData remain, and in
   'local' mode they behave exactly as they always did. In 'api'
   mode they refuse rather than lie, because there is no honest
   synchronous answer to "did the server take this?".
   ============================================================ */

const Storage = (() => {
  const PREFIX = 'taqwa_';

  const COLLECTIONS = [
    'customers', 'vehicles', 'appointments', 'jobCards', 'services',
    'mechanics', 'parts', 'invoices', 'payments', 'expenses',
    'inventoryTransactions',  // stock movement audit trail (added with Inventory module)
    'invoiceAdjustments'      // invoice write-offs (0002); read-only here, written through action()/create()
  ];

  /**
   * Frontend collection name -> API path segment. The two differ only in
   * spelling (jobCards / job-cards), never in meaning, and this is the only
   * place that knows about the difference.
   */
  const API_PATHS = {
    customers: 'customers', vehicles: 'vehicles', appointments: 'appointments',
    jobCards: 'job-cards', services: 'services', mechanics: 'mechanics',
    parts: 'parts', invoices: 'invoices', payments: 'payments',
    expenses: 'expenses', inventoryTransactions: 'inventory-transactions',
    invoiceAdjustments: 'invoice-adjustments',
    followUps: 'follow-ups', followUpContacts: 'follow-up-contacts',
    followUpTasks: 'follow-up-tasks',
    estimates: 'estimates',
    staff: 'staff',
    accounts: 'accounts',
    attendance: 'attendance',
    leaveRequests: 'leave-requests',
    activityLog: 'activity-log',
    tools: 'tools',
    roles: 'roles'
  };

  /**
   * Collections that exist ONLY in the database and are read on demand by the
   * one page that needs them (Customer Follow-up; Follow-up Tasks;
   * Estimates; Staff List; User Accounts; Attendance; Leave Management; Activity
   * Log; Tools & Equipment), never during hydration.
   *
   * Deliberately not in COLLECTIONS: hydration reads every entry there and
   * falls back to browser storage if any one fails, so a missing table here
   * (code deployed before its migration) would take every other page with
   * it. Loaded with load(), they can fail on their own page alone.
   *
   * Outside 'api' mode they read as empty and refuse every write: there is no
   * browser-storage copy of them, demo or otherwise, to show or to change.
   */
  // The account this browser is signed in with (id, username, role), or null
  // for a workshop-passphrase session. Set by hydrate(); display only -- the
  // Worker decides what any caller may do.
  let signedInAccount = null;
  let sharedPassphrase = true;

  /* What the signed-in caller may do (0018), from GET /api/session. Used to
     show only what will work -- every request is still checked by the
     server, which never reads any of this back. `null` = not known yet (no
     session, or no API): then nothing is hidden, because nothing can be
     fetched either. */
  let grant = null;
  // Core collections the caller's role may not read (403 at hydration):
  // empty here, and the pages say so instead of showing zeros as facts.
  const denied = new Set();
  /** May the signed-in caller do this? (`perm` like 'invoices.view'.) */
  function can(perm) {
    if (!grant) return true;
    return grant.fullAccess || grant.permissions.has(perm);
  }
  /** Did hydration find this collection off-limits to the caller's role? */
  const isDenied = collection => denied.has(collection);
  /** The shell found this page off-limits: run no more ready callbacks (the module's). */
  let pageBlocked = false;
  const blockPage = () => { pageBlocked = true; };

  const API_ONLY = ['followUps', 'followUpContacts', 'followUpTasks', 'estimates', 'staff', 'accounts', 'attendance', 'leaveRequests', 'activityLog', 'tools', 'roles'];
  const isApiOnly = c => API_ONLY.includes(c);
  const apiOnlyRefusal = () => ({
    ok: false, code: 'no_api', message: 'This needs the workshop database, which this page is not connected to.',
  });

  /* ---------- mode ---------- */

  let mode = 'local';            // until hydrate() proves otherwise
  const isLocked = () => mode === 'locked';
  /**
   * Only 'local' reads and writes the browser store. 'locked' must not:
   * showing whatever this browser happened to have cached -- or seeded --
   * while refusing to talk to the database would be inventing a workshop.
   */
  const usesBrowserStore = () => mode === 'local';
  const cache = {};              // collection -> array, populated in 'api' mode
  let cachedSettings = null;     // the stored settings row in 'api' mode
  let hydration = null;          // the in-flight hydrate() promise

  const isApi = () => mode === 'api';

  /* ---------- low-level helpers ---------- */

  function read(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error('Storage read failed:', key, e);
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Storage write failed:', key, e);
      return false;
    }
  }

  /* ---------- public CRUD API (reads) ---------- */

  /** Get all records of a collection (always returns an array). */
  function getData(collection) {
    if (isApi()) return cache[collection] || [];
    if (isApiOnly(collection)) return [];
    if (usesBrowserStore()) return read(collection) || [];
    return [];                      // locked: nothing has been read, so nothing is shown
  }

  /** Overwrite an entire collection. localStorage only -- see seedIfEmpty. */
  function saveData(collection, records) {
    if (!usesBrowserStore() || isApiOnly(collection)) return false;
    return write(collection, records);
  }

  /** Get one record by id. */
  function getById(collection, id) {
    return getData(collection).find(r => r.id === id) || null;
  }

  /* ---------- public CRUD API (legacy synchronous writes) ---------- */

  /**
   * The three synchronous writers the UI used before there was a backend.
   *
   * In 'local' mode they are unchanged, down to the returned value. In 'api'
   * mode there is no synchronous truth to return, so they refuse loudly
   * instead of writing to a localStorage nobody is reading -- a silent
   * success there is exactly the "localStorage and D1 silently diverge"
   * failure this layer exists to prevent.
   */
  /** A write attempted before signing in. Not a failure of the write. */
  const lockedRefusal = () => ({
    ok: false, code: 'unauthorized', message: 'Sign in to make changes.',
  });

  function refuseSync(name) {
    const message =
      `Storage.${name}() is synchronous and cannot be used against the API. ` +
      `Use Storage.${{ addData: 'create', updateData: 'update', deleteData: 'remove' }[name]}() instead.`;
    console.error(message);
    throw new Error(message);
  }

  /** Insert a new record. Assigns id + createdAt if missing. Returns the record. */
  function addData(collection, record) {
    if (!usesBrowserStore()) return refuseSync('addData');
    const records = getData(collection);
    if (!record.id) record.id = generateId(collection);
    if (!record.createdAt) record.createdAt = new Date().toISOString();
    records.push(record);
    saveData(collection, records);
    return record;
  }

  /** Merge changes into an existing record by id. Returns updated record or null. */
  function updateData(collection, id, changes) {
    if (!usesBrowserStore()) return refuseSync('updateData');
    const records = getData(collection);
    const idx = records.findIndex(r => r.id === id);
    if (idx === -1) return null;
    records[idx] = { ...records[idx], ...changes, updatedAt: new Date().toISOString() };
    saveData(collection, records);
    return records[idx];
  }

  /** Delete a record by id. Returns true if something was removed. */
  function deleteData(collection, id) {
    if (!usesBrowserStore()) return refuseSync('deleteData');
    const records = getData(collection);
    const next = records.filter(r => r.id !== id);
    if (next.length === records.length) return false;
    saveData(collection, next);
    return true;
  }

  /* ---------- cache maintenance ----------

     Every one of these takes the record the SERVER returned. Nothing here
     computes a total, a balance or a stock level: if the server changed
     something we did not send, the response is what says so.            */

  function cachePut(collection, record) {
    if (!record || !record.id) return record;
    const list = cache[collection] || (cache[collection] = []);
    const idx = list.findIndex(r => r.id === record.id);
    if (idx === -1) list.unshift(record); else list[idx] = record;
    return record;
  }

  function cacheDrop(collection, id) {
    const list = cache[collection];
    if (!list) return false;
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }

  /* ---------- public CRUD API (asynchronous writes) ---------- */

  /**
   * The three writers that can talk to a server.
   *
   * Each resolves to { ok: true, record } or { ok: false, code, message,
   * fields? } -- never throws, never rejects. In 'local' mode they wrap the
   * synchronous writers so a caller can use one shape everywhere.
   */
  async function create(collection, record) {
    if (isLocked()) return lockedRefusal();
    if (!isApi() && isApiOnly(collection)) return apiOnlyRefusal();
    if (!isApi()) {
      const saved = addData(collection, record);
      return { ok: true, record: saved };
    }
    const res = await Api.post(`/${API_PATHS[collection]}`, record);
    if (!res.ok) return res;
    // meta carries what the write did beyond the record itself -- an invoice
    // create reports the job card advances it applied (appliedAdvances).
    return { ok: true, record: cachePut(collection, res.data), meta: res.meta || {} };
  }

  async function update(collection, id, changes) {
    if (isLocked()) return lockedRefusal();
    if (!isApi() && isApiOnly(collection)) return apiOnlyRefusal();
    if (!isApi()) {
      const saved = updateData(collection, id, changes);
      return saved
        ? { ok: true, record: saved }
        : { ok: false, code: 'not_found', message: 'That record no longer exists.' };
    }
    const res = await Api.put(`/${API_PATHS[collection]}/${id}`, changes);
    if (!res.ok) return res;
    return { ok: true, record: cachePut(collection, res.data) };
  }

  async function remove(collection, id) {
    if (isLocked()) return lockedRefusal();
    if (!isApi() && isApiOnly(collection)) return apiOnlyRefusal();
    if (!isApi()) {
      const gone = deleteData(collection, id);
      return gone
        ? { ok: true }
        : { ok: false, code: 'not_found', message: 'That record no longer exists.' };
    }
    const res = await Api.delete(`/${API_PATHS[collection]}/${id}`);
    if (!res.ok) return res;
    cacheDrop(collection, id);
    return { ok: true };
  }

  /**
   * POST /api/<collection>/<id>/<action> -- a business operation rather than
   * a field change: a job card's status, voiding an invoice, voiding or
   * linking a payment. These move several tables in one transaction, so the
   * server's answer is the only thing that knows what changed; `refresh`
   * names the collections to re-read afterwards.
   *
   * `meta` carries whatever else the response held beside `data` (e.g. the
   * contact a follow-up's contact action created, or `replayed`), exactly as
   * create() already passes it on. Callers that do not read it are unaffected.
   */
  async function action(collection, id, name, body = {}, refresh = []) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      return { ok: false, code: 'no_api', message: 'This action needs the backend.' };
    }
    const res = await Api.post(`/${API_PATHS[collection]}/${id}/${name}`, body);
    if (!res.ok) return res;
    if (res.data && res.data.id) cachePut(collection, res.data);
    const stale = await refreshAll(...refresh);
    return { ok: true, record: res.data, meta: res.meta || {}, ...(stale.length ? { stale } : {}) };
  }

  /* ---------- id generation ---------- */

  const ID_PREFIXES = {
    customers: 'CUS', vehicles: 'VEH', appointments: 'APT', jobCards: 'JOB',
    services: 'SRV', mechanics: 'MEC', parts: 'PRT', invoices: 'INV',
    payments: 'PAY', expenses: 'EXP', inventoryTransactions: 'STK'
  };

  /**
   * Sequential, human-readable ids like JOB-0007.
   *
   * 'local' mode only. In 'api' mode the server allocates from its own
   * id_counters table inside the same transaction as the insert, and the id
   * it chose comes back on the created record -- two counters handing out
   * the same number is precisely what that avoids.
   */
  function generateId(collection) {
    const prefix = ID_PREFIXES[collection] || 'REC';
    const counters = read('counters') || {};
    counters[collection] = (counters[collection] || 0) + 1;
    write('counters', counters);
    return `${prefix}-${String(counters[collection]).padStart(4, '0')}`;
  }

  /* ---------- settings ---------- */

  const DEFAULT_SETTINGS = {
    businessName: 'Taqwa Automobile Service Center',
    phone: '+880 1XXX-XXXXXX',
    email: 'info@taqwaauto.com',
    website: '',
    taxId: '',
    address: 'Sector #15, Block #C, Road #3/A, Plot #40, Diabari, Uttara, Dhaka',
    businessDescription: '',
    invoiceFooter: 'Thank you for servicing with Taqwa Automobile Service Center.',
    paymentTerms: '',
    taxRate: 5,
    currency: '৳',
    // Workshop-profile reference info only -- not read or enforced by
    // Appointments or Job Cards. Stored here so it can be recorded and
    // shown, without touching those modules' logic (see settings.js).
    defaultAppointmentDuration: 60,
    openingTime: '',
    closingTime: '',
    workingDays: []
  };

  /**
   * These are the BROWSER's display defaults, applied on top of whatever is
   * stored so a field the shop has never filled in still renders something.
   * They are not the database's defaults and are never sent to it: a PUT
   * carries only the fields the form actually holds.
   */
  function getSettings() {
    const stored = isApi() ? cachedSettings
      : usesBrowserStore() ? read('settings')
      : null;                       // locked: the browser's display defaults only
    return { ...DEFAULT_SETTINGS, ...(stored || {}) };
  }

  /** Synchronous save -- 'local' mode only, kept for the offline path. */
  function saveSettings(settings) {
    if (!usesBrowserStore()) return refuseSync('saveSettings');
    return write('settings', { ...getSettings(), ...settings });
  }

  /**
   * PUT /api/settings merges: only the keys sent are changed. That is the
   * same contract saveSettings() has always had, so the form can keep
   * submitting exactly the fields it renders.
   */
  async function putSettings(settings) {
    if (isLocked()) return lockedRefusal();
    if (!isApi()) {
      return saveSettings(settings)
        ? { ok: true, record: getSettings() }
        : { ok: false, code: 'write_failed', message: 'Could not save settings.' };
    }
    const res = await Api.put('/settings', settings);
    if (!res.ok) return res;
    cachedSettings = res.data;
    return { ok: true, record: getSettings() };
  }

  /* ---------- theme ----------

     Browser-local on purpose, in both modes. A theme is a preference of the
     device looking at the data, not a property of the workshop: putting it
     in D1 would make one person's dark mode everybody's. The <head> of every
     page reads this same key directly to set the theme before first paint. */

  function getTheme() { return read('theme') || 'light'; }
  function saveTheme(theme) { write('theme', theme); }

  /* ---------- seed data (first run only) ---------- */

  function isSeeded() { return read('seeded') === true; }

  /**
   * Demo data, for a browser that has never run this app. Never in 'api'
   * mode: the database is the source of truth, an empty one is a legitimate
   * state (a new workshop), and POSTing fifty invented records into it
   * because it looked empty would be the worst kind of helpful.
   */
  function seedIfEmpty() {
    if (!usesBrowserStore()) return;
    if (isSeeded()) return;
    SeedData.load({ addData, saveData });
    write('seeded', true);
  }

  /**
   * Wipes every business collection and counter, then reloads the original
   * demo dataset -- the symmetric opposite of seedIfEmpty(). Settings and
   * theme are deliberately left untouched: this resets DEMO DATA, not the
   * shop's own configured Settings. Used only by Settings' "Reset to Seed
   * Data" action, which gates this behind a strong typed confirmation.
   *
   * Refused in 'api' mode. The API has no seed or reset endpoint, and
   * emptying a real database from a browser button is not something this
   * layer will improvise.
   */
  function resetToSeedData() {
    if (!usesBrowserStore()) return false;
    COLLECTIONS.forEach(c => write(c, []));
    write('counters', {});
    write('seeded', false);
    SeedData.load({ addData, saveData });
    write('seeded', true);
    return true;
  }

  /* ---------- hydration ---------- */

  /**
   * Read one collection completely.
   *
   * The list endpoint caps a page at 1000 rows. Its envelope carries two
   * numbers: `count`, the rows in THIS page, and `total`, the rows in the
   * whole table. The loop follows the offset until it holds `total` rows, so
   * the first page is never rendered as if it were the whole table.
   *
   * A failed page fails the whole read (hydrate() then refuses to start on a
   * partial table). If `total` is missing, a full page means there may be
   * more, so the loop keeps going until a short or empty page; MAX_PAGES
   * bounds it either way.
   */
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 1000;
  async function fetchAll(collection, query = null) {
    // Optional filters the route understands (e.g. attendance's from / to),
    // sent ahead of the paging parameters.
    const filters = query ? new URLSearchParams(query).toString() : '';
    const path = `/${API_PATHS[collection]}${filters ? `?${filters}&` : '?'}`;
    const rows = [];
    let offset = 0;
    for (let pages = 0; ; pages++) {
      if (pages === MAX_PAGES) {
        return { ok: false, status: 0, code: 'too_many_pages',
                 message: `Stopped reading ${collection} after ${MAX_PAGES} pages.` };
      }
      const res = await Api.get(`${path}limit=${PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) return res;
      const page = Array.isArray(res.data) ? res.data : [];
      rows.push(...page);
      const total = res.meta && res.meta.total;
      const known = typeof total === 'number' && Number.isFinite(total) && total >= 0;
      const done = known ? rows.length >= total : page.length < PAGE_SIZE;
      if (!page.length || done) break;
      offset += page.length;
    }
    return { ok: true, rows };
  }

  /**
   * Fetch website bookings from the website API and convert them to dashboard format.
   * Website bookings are merged with local appointments for a unified view.
   */
  async function fetchWebsiteBookings() {
    try {
      // Use local proxy endpoint (no CORS/CSP issues)
      const response = await fetch('/api/website-bookings');
      if (!response.ok) return { ok: false, rows: [] };

      const data = await response.json();
      const bookings = Array.isArray(data.bookings) ? data.bookings : [];

      // Convert website bookings to dashboard appointment format
      return {
        ok: true,
        rows: bookings.map(b => ({
          id: `web_${b.id}`,              // Prefix to avoid collision with local IDs
          customerId: b.customer_name,     // Fallback: name instead of ID
          vehicleId: b.vehicle_type,       // Fallback: type instead of ID
          serviceId: b.service_type,       // Fallback: service name instead of ID
          mechanicId: null,                // No mechanic assigned yet
          jobCardId: null,                 // No job card linked
          date: b.preferred_date,
          time: b.preferred_time || '09:00',
          duration: 60,                    // Default duration
          status: 'Scheduled',             // Map website status to dashboard status
          source: 'Website',               // Source identifier
          complaint: `Email: ${b.customer_email}\nPhone: ${b.customer_phone}`,
          notes: `Website booking #${b.id}`,
          reminderSent: false,
          createdAt: b.created_at,
        }))
      };
    } catch (error) {
      console.error('Error fetching website bookings:', error);
      return { ok: false, rows: [] };
    }
  }

  /**
   * Re-read several collections the server also changed, and return the names
   * of any that could NOT be re-read.
   *
   * A failure here is not a failed write -- the write already succeeded. It
   * means the screen may now be showing a figure the database has moved on
   * from, which is worth saying out loud: silently keeping the old rows is
   * how a paid invoice goes on displaying its old balance.
   */
  async function refreshAll(...names) {
    const stale = [];
    for (const name of names) {
      const res = await reload(name);
      if (!res.ok) stale.push(name);
    }
    return stale;
  }

  /**
   * Read one API_ONLY collection, on demand, into the cache. Never part of
   * hydration, and refused outside 'api' mode -- so a failure here is this
   * page's to report and cannot change the mode any other page runs in.
   * `query` (optional) narrows what is read -- e.g. { from, to } -- and the
   * cache then holds exactly that slice.
   */
  async function load(collection, query = null) {
    if (!isApiOnly(collection)) {
      return { ok: false, code: 'not_on_demand', message: `${collection} is loaded with the other collections.` };
    }
    if (!isApi()) return apiOnlyRefusal();
    return reload(collection, query);
  }

  /**
   * Read ONE record of an API_ONLY collection, on demand -- the detail shape,
   * which may carry more than the list does (an estimate's lines and history).
   * Refused outside 'api' mode, like load(); the cache keeps the newer copy.
   */
  async function loadOne(collection, id) {
    if (!isApiOnly(collection)) {
      return { ok: false, code: 'not_on_demand', message: `${collection} is loaded with the other collections.` };
    }
    if (!isApi()) return apiOnlyRefusal();
    const res = await Api.get(`/${API_PATHS[collection]}/${encodeURIComponent(id)}`);
    if (!res.ok) return res;
    return { ok: true, record: cachePut(collection, res.data) };
  }

  /**
   * Read ONE page of an API_ONLY collection, on demand -- for a list the server
   * filters and pages itself (the activity log), so the browser never downloads
   * the whole history. `query` is the route's own filters plus limit / offset.
   * Returns { ok, rows, meta }; the cache then holds exactly that page.
   * Refused outside 'api' mode, like load().
   */
  async function loadPage(collection, query = {}) {
    if (!isApiOnly(collection)) {
      return { ok: false, code: 'not_on_demand', message: `${collection} is loaded with the other collections.` };
    }
    if (!isApi()) return apiOnlyRefusal();
    const qs = new URLSearchParams(query).toString();
    const res = await Api.get(`/${API_PATHS[collection]}${qs ? `?${qs}` : ''}`);
    if (!res.ok) return res;
    const rows = Array.isArray(res.data) ? res.data : [];
    cache[collection] = rows;
    return { ok: true, rows, meta: res.meta || {} };
  }

  /** Re-read one collection from the server. Used after a transaction. */
  async function reload(collection, query = null) {
    if (!isApi()) return { ok: false, code: 'no_api' };
    const res = await fetchAll(collection, query);
    if (!res.ok) return res;
    cache[collection] = res.rows;
    return { ok: true };
  }

  /**
   * Decide the mode and, if there is a backend, fill the cache before the
   * first render.
   *
   * A failure at any point leaves the mode at 'local'. That is the
   * conservative direction: a half-filled cache rendered as if it were the
   * database would show the user records that do not exist and hide records
   * that do.
   */
  let settled = false;   // the mode is decided and the cache, if any, is filled
  let outcome = null;    // what hydrate() decided, once it has

  function hydrate() {
    if (hydration) return hydration;

    // No API to ask means the answer is already known, and knowing it
    // WITHOUT a promise is what keeps a browser with no backend rendering in
    // a single tick -- exactly as it did when this file only knew about
    // localStorage. A page opened from disk must not wait on a microtask to
    // draw its first table.
    if (!Api.baseUrl) {
      settled = true;
      outcome = { mode: 'local', reason: 'no_api' };
      hydration = Promise.resolve(outcome);
      return hydration;
    }

    // Every page load runs this, before anything can be shown, so the number
    // of round trips IS the wait on every navigation. The decisions below are
    // made in the same order as ever; what changed is that requests which do
    // not depend on each other's answers are sent together. Two rounds
    // instead of five: (health + session), then (collections + website
    // bookings + settings). Api.* and fetchWebsiteBookings() never reject,
    // so a request whose answer turns out not to be needed simply goes unread.
    hydration = (async () => {
      // Asked alongside the probe, read only once the probe says the Worker
      // is up -- so a server that is down still fails at the probe's shorter
      // timeout, and the session answer is never acted on without it.
      const asking = Api.session();
      const probe = await Api.probe();
      if (!probe.ok) return { mode: 'local', reason: probe.code };

      // The Worker is up. Are we allowed to read it? Asking /api/session is
      // how that is answered without firing eleven requests that would all
      // come back 401.
      const who = await asking;
      if (!who.ok) return { mode: 'local', reason: who.code || 'network_error' };
      if (!who.authenticated) {
        mode = 'locked';
        return { mode: 'locked', canSignIn: who.passphrase, accountSignIn: who.accounts, sharedPassphrase: who.sharedPassphrase !== false };
      }
      // Who is signed in: a staff member's account, or null for the workshop passphrase.
      signedInAccount = who.account || null;
      sharedPassphrase = who.sharedPassphrase !== false;
      // A password someone else set must be replaced first (0019): nothing else
      // is readable until then, so do not try -- the app asks for a new one.
      if (signedInAccount && signedInAccount.passwordChangeRequired) {
        mode = 'locked';
        return { mode: 'locked', passwordChange: true, canSignIn: who.passphrase, accountSignIn: who.accounts };
      }
      grant = Array.isArray(who.permissions) ? { fullAccess: who.fullAccess === true, permissions: new Set(who.permissions) } : null;
      denied.clear();

      const [results, websiteBookings, settings] = await Promise.all([
        Promise.all(COLLECTIONS.map(fetchAll)),
        fetchWebsiteBookings(),
        Api.get('/settings'),
      ]);
      // A collection the caller's role may not read (403) is not a failure of
      // the app: it is simply not theirs to see. It reads as empty and is
      // remembered, so its pages can say so. Anything else still falls back.
      results.forEach((r, i) => {
        if (!r.ok && r.code === 'forbidden') { denied.add(COLLECTIONS[i]); results[i] = { ok: true, rows: [] }; }
      });
      const failed = results.findIndex(r => !r.ok);
      if (failed !== -1) {
        const why = results[failed].code;
        // A session that expired between the check above and the read is an
        // authentication problem, not an offline one: locking is honest,
        // falling back to browser storage would not be.
        if (why === 'unauthorized') {
          mode = 'locked';
          return { mode: 'locked', canSignIn: true, accountSignIn: who.accounts };
        }
        return { mode: 'local', reason: why, collection: COLLECTIONS[failed] };
      }
      COLLECTIONS.forEach((c, i) => { cache[c] = results[i].rows; });

      // Merge website bookings with local appointments
      if (websiteBookings.ok && websiteBookings.rows.length) {
        cache.appointments = [...cache.appointments, ...websiteBookings.rows];
      }

      // A settings row need not exist yet; 404 is a legitimate answer that
      // leaves the browser's own display defaults showing.
      cachedSettings = settings.ok ? settings.data : null;

      mode = 'api';
      return { mode: 'api', counts: Object.fromEntries(COLLECTIONS.map(c => [c, cache[c].length])) };
    })().then(result => { settled = true; outcome = result; return result; });
    return hydration;
  }

  /* ---------- signing in and out ---------- */

  /**
   * Sign in, then fill the cache.
   *
   * The hydration promise is reset first: the previous one resolved to
   * 'locked', and a caller asking whether the app is ready must not be
   * handed that stale answer once the session exists.
   */
  async function signIn(passphrase) {
    return finishSignIn(await Api.login(passphrase));
  }

  /** Sign in with a username, e-mail or Staff ID and a password (0019); otherwise exactly signIn(). */
  async function signInWithIdentifier(identifier, password) {
    return finishSignIn(await Api.loginIdentifier(identifier, password));
  }

  /** Sign in with a staff member's own account (username + password); otherwise exactly signIn(). */
  async function signInWithAccount(username, password) {
    return finishSignIn(await Api.loginAccount(username, password));
  }

  async function finishSignIn(res) {
    if (!res.ok) return res;
    hydration = null;
    settled = false;
    outcome = null;
    readiness = null;
    const result = await hydrate();
    // Signed in, but a new password must be chosen first (0019): the app asks for it.
    if (result.passwordChange) return { ok: true, result, passwordChange: true };
    return result.mode === 'api'
      ? { ok: true, result }
      : { ok: false, code: 'hydrate_failed',
          message: 'Signed in, but the workshop data could not be loaded.' };
  }

  /**
   * Sign out and forget everything read while signed in.
   *
   * Emptying the cache matters: the next person at this screen must not be
   * able to read the last one's customer list out of a stale render.
   *
   * Success is claimed only once the server agrees the session is gone: the
   * cookie is HttpOnly, so asking GET /api/session is the only way to know
   * the DELETE's cleared cookie really took. Until then nothing is touched
   * -- a sign-out that did not happen must not look as if it had, and the
   * session it left behind still holds the data on screen anyway.
   */
  async function signOut() {
    const res = await Api.logout();
    if (!res.ok) return res;
    const who = await Api.session();
    if (!who.ok || who.authenticated) {
      return who.ok
        ? { ok: false, code: 'still_signed_in', message: 'The server still reports this browser as signed in.' }
        : { ok: false, code: who.code || 'network_error', message: 'The sign-out could not be confirmed with the server.' };
    }
    COLLECTIONS.forEach(c => { delete cache[c]; });
    API_ONLY.forEach(c => { delete cache[c]; });
    cachedSettings = null;
    signedInAccount = null;
    grant = null;
    denied.clear();
    mode = 'locked';
    hydration = null;
    settled = false;
    outcome = null;
    readiness = null;
    return res;
  }

  /* ---------- readiness ----------

     Page modules used to render on DOMContentLoaded. Hydration cannot
     finish by then, so they wait on this instead: it resolves once the DOM
     is parsed AND the mode is settled, in either mode.                    */

  function domReady() {
    if (typeof document === 'undefined') return Promise.resolve();
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(res => document.addEventListener('DOMContentLoaded', res, { once: true }));
  }

  let readiness = null;
  function whenReady() {
    if (!readiness) readiness = Promise.all([domReady(), hydrate()]).then(([, h]) => h);
    return readiness;
  }

  /**
   * The page-module entry point, in place of a DOMContentLoaded listener:
   *
   *     Storage.ready(() => { bindEvents(); renderList(); });
   *
   * It runs `fn` once the DOM is parsed AND the data source is settled. When
   * there is no backend, settling needs no network and `fn` runs inside the
   * DOMContentLoaded handler itself -- the same tick a listener would have
   * had. When there is one, `fn` waits for the cache to be filled, so no
   * module ever renders an empty table it would then have to re-render.
   */
  function ready(fn) {
    const hydrated = hydrate();

    // `fn` receives what hydrate() decided -- which source is live and, when
    // it is not the expected one, why. Callers that do not care simply
    // ignore the argument.
    // A page the caller's role may not open (app.js blockPage()) runs none of
    // its module's ready callbacks: the shell's own runs first and decides.
    const run = () => {
      if (settled) {
        if (pageBlocked) return;
        try { fn(outcome); } catch (e) { console.error('Page initialisation failed:', e); }
        return;
      }
      hydrated.then(result => { if (!pageBlocked) fn(result); })
        .catch(e => console.error('Page initialisation failed:', e));
    };

    if (typeof document === 'undefined' || document.readyState !== 'loading') { run(); return; }
    document.addEventListener('DOMContentLoaded', run, { once: true });
  }

  return {
    COLLECTIONS,
    getData, saveData, getById, addData, updateData, deleteData,
    create, update, remove, action, reload, refreshAll, load, loadOne, loadPage,
    generateId, getSettings, saveSettings, putSettings, getTheme, saveTheme,
    seedIfEmpty, resetToSeedData,
    hydrate, whenReady, ready, signIn, signInWithAccount, signInWithIdentifier, signOut,
    get mode() { return mode; },
    get account() { return signedInAccount; },
    get sharedPassphrase() { return sharedPassphrase; },
    get fullAccess() { return !!(grant && grant.fullAccess); },
    get permissions() { return grant ? [...grant.permissions] : null; },
    can, isDenied, blockPage,
    isApi, isLocked
  };
})();

/* Node's test harness loads this file as a script; the browser does not. */
if (typeof module !== 'undefined' && module.exports) module.exports = { Storage };
