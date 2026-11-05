/* Bookings (0023) — unit tests against the REAL Worker:
   POST /api/bookings/submit (public) and /api/bookings (staff).

   The handlers run against an in-memory SQLite database built from every
   real migration. All names and numbers are fictional test values.

   What must hold:
     A. Schema: three new tables, CHECKs, indexes, the BKG counter and the
        permissions; additive (nothing else changes); re-runnable.
     B. Public submit: the website's Book Now fields are stored as a New
        Website booking with a history row; every field validated
        server-side; consent required; phone normalised (+880 -> 0); date
        not past, within 90 days, on a working day and within opening hours
        when the workshop's settings say so; unknown fields refused.
     C. Anti-spam: honeypot and too-fast forms stored nowhere; idempotency
        key and the same phone + date + service return the first
        reference; a burst from one address is 429; CORS to the website
        only; the answer never echoes stored data; logs carry no PII.
     D. Staff API: 401 / 403; list, search (name, phone in any form,
        reference, registration, vehicle), status, source, date and assigned
        filters, paging, summary; detail with history, notes and matches;
        staff create; assign; link customer and vehicle; status workflow
        (legal moves only, reasons, reschedule, timestamps); notes; stale
        edits 409 with no history; no delete; the snapshot cannot be edited.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nBookings API unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f) && true).sort();
const TOKEN = 'unit-test-token';
const SITE = 'https://taqwa.autos';
const tomorrow = (() => { const d = new Date(Date.now() + 2 * 86400000); return d.toISOString().slice(0, 10); })();

function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  const statements = [];
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      statements.push(this.sql);
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      statements.push(this.sql);
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { statements.push(this.sql); return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  return {
    raw, statements,
    prepare: (sql) => new Stmt(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}



function fresh(envExtra = {}) {
  const DB = makeD1();
  const env = { DB, API_TOKEN: TOKEN, AUTH_SECRET: 'unit-test-secret', ...envExtra };
  const logs = [];
  let ipSeq = 0;
  const submit = async (body, { origin = SITE, ip = `203.0.113.${++ipSeq}`, raw = false, method = 'POST' } = {}) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
    if (origin) headers.origin = origin;
    const res = await worker.fetch(new Request('http://worker.local/api/bookings/submit', {
      method, headers, ...(method === 'POST' ? { body: raw ? body : JSON.stringify(body) } : {}),
    }), env, {});
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const api = async (method, path, body, cred = 'token') => {
    const headers = {};
    if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`;
    const res = await worker.fetch(new Request('http://worker.local' + path, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, {});
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);
  return { DB, env, submit, api, one, all };
}


const DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });
const dayPlus = (n) => { const d = new Date(`${DHAKA.format(new Date())}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (iso) => DAY[new Date(`${iso}T12:00:00Z`).getUTCDay()];
/** The next date (from n days ahead) that is not a Friday. */
const workday = (n = 2) => { let d = dayPlus(n); while (weekday(d) === 'Fri') d = dayPlus(++n); return d; };
const friday = () => { let n = 1; while (weekday(dayPlus(n)) !== 'Fri') n++; return dayPlus(n); };
const AT = '2026-01-01T00:00:00.000Z';

// Exactly what the website's Book Now form will send (mh-71/taqwa BookingForm.astro).
const BOOK = (extra = {}) => ({ name: 'Test Booker One', phone: '01711-000001', email: 'booker.one@example.invalid',
  vehicleMake: 'Toyota', vehicleModel: 'Axio', registrationNumber: 'metro-ga 11-0001', serviceType: 'car-ac',
  preferredDate: workday(), preferredTime: '10:30', message: 'AC is not cooling.\nPlease check.', consent: true,
  company: '', startedAt: Date.now() - 60000, ...extra });

function seed(h) {
  h.DB.raw.exec(`
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Front desk', 'Service', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0002', 'Gone Person', '01911000002', 'Inactive', 'Front desk', 'Service', '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'AC', '${AT}');
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Booker In CRM', '+8801711000001', '${AT}');
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0002', 'Somebody Else', '01722000002', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'METRO-GA-11-0001', 'Toyota', 'Axio', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0002', 'CUS-0002', 'DHAKA-KHA-22-0002', 'Honda', 'Grace', '${AT}');
  `);
}

/* ---------- A. schema ---------- */
{
  const h = fresh();
  check('bookings has the planned columns', h.all('PRAGMA table_info(bookings)').map((c) => c.name),
    ['id', 'source', 'source_reference', 'idempotency_key', 'customer_name', 'phone', 'phone_digits', 'email', 'vehicle_make', 'vehicle_model',
      'registration_number', 'service_type', 'service_label', 'preferred_date', 'preferred_time', 'customer_message', 'consent', 'consent_at',
      'status', 'customer_id', 'vehicle_id', 'appointment_id', 'assigned_staff_id', 'assigned_staff_name', 'assigned_at', 'assigned_by',
      'ip_hash', 'created_at', 'updated_at', 'updated_by', 'confirmed_at', 'cancelled_at']);
  check('booking_history columns', h.all('PRAGMA table_info(booking_history)').map((c) => c.name),
    ['id', 'booking_id', 'action', 'from_status', 'to_status', 'detail', 'reason', 'actor', 'created_at']);
  check('booking_notes columns', h.all('PRAGMA table_info(booking_notes)').map((c) => c.name), ['id', 'booking_id', 'note', 'created_by', 'created_at']);
  check('a BKG counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='bookings'"), { prefix: 'BKG', last_value: 0 });
  ok_('no column holds a raw IP address', !h.all("SELECT name FROM pragma_table_info('bookings')").some((c) => /^ip$|ip_address/.test(c.name)));
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|FOREIGN KEY|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  const base = (id, extra = '') => `INSERT INTO bookings (id, source, customer_name, phone, phone_digits, vehicle_make, vehicle_model, service_type, service_label, preferred_date, preferred_time, created_at, updated_at${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ('${id}', 'Website', 'x', '01711000000', '01711000000', 'Toyota', 'Axio', 'car-ac', 'Car AC Service', '2026-12-01', '10:00', 'x', 'x'${extra ? ', ' + extra.split('=')[1] : ''})`;
  check('a valid row is accepted', ins(base('BKG-9')), 'ok');
  check('a status outside the seven is refused', ins(base('BKG-10', "status='Booked'")), 'CHECK');
  check('a source outside the six is refused', ins(base('BKG-11').replace("'Website'", "'Email'")), 'CHECK');
  check('an id that is not BKG- is refused', ins(base('WEB-1')), 'CHECK');
  check('consent without its time is refused', ins(base('BKG-12', 'consent=1')), 'CHECK');
  check('a link to a missing customer is refused', ins(base('BKG-13', "customer_id='CUS-404'")), 'FOREIGN KEY');
  check('history must belong to a booking', ins("INSERT INTO booking_history (booking_id, action, actor, created_at) VALUES ('BKG-404', 'note', 'x', 'x')"), 'FOREIGN KEY');
  ins("INSERT INTO booking_history (booking_id, action, actor, created_at) VALUES ('BKG-9', 'note', 'x', 'x')");
  check('a booking with history cannot be deleted', ins("DELETE FROM bookings WHERE id = 'BKG-9'"), 'FOREIGN KEY');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0023_bookings.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable', again, 'ok');
  const before = new DatabaseSync(':memory:');
  // Every migration except 0023 itself, so a later one (0024 ...) is on both sides.
  for (const f of MIGRATIONS.filter((f) => f.slice(0, 4) !== '0023')) before.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%booking%' ORDER BY name").all());
  check('0023 is additive: every other table and index is unchanged', shape(h.DB.raw) === shape(before), true);
  const perms = (role) => h.all('SELECT permission FROM role_permissions WHERE role_id = ? AND permission LIKE \'bookings.%\' ORDER BY permission', role).map((r) => r.permission);
  const ALL4 = ['bookings.create', 'bookings.edit', 'bookings.manage', 'bookings.view'];
  check('Admin, Manager and Service Advisor get all four booking permissions', [perms('ROL-0002'), perms('ROL-0003'), perms('ROL-0005')], [ALL4, ALL4, ALL4]);
  check('Staff can see bookings; Accountant, Store Manager and Mechanic get none', [perms('ROL-0008'), perms('ROL-0004'), perms('ROL-0006'), perms('ROL-0007')], [['bookings.view'], [], [], []]);
}

/* ---------- B. public submit ---------- */
{
  const h = fresh();
  const r = await h.submit(BOOK());
  check('a valid Book Now request is stored and answers only a reference', [r.status, r.body.data, r.body.message], [201, { reference: 'BKG-0001' }, 'Thank you. Your booking request has been received.']);
  const row = h.one('SELECT * FROM bookings');
  check('   ...every field mapped to its column', [row.customer_name, row.phone, row.phone_digits, row.email, row.vehicle_make, row.vehicle_model, row.registration_number,
    row.service_type, row.service_label, row.preferred_date, row.preferred_time, row.customer_message],
    ['Test Booker One', '01711-000001', '01711000001', 'booker.one@example.invalid', 'Toyota', 'Axio', 'METRO-GA 11-0001',
      'car-ac', 'Car AC Service', workday(), '10:30', 'AC is not cooling.\nPlease check.']);
  check('   ...as a New Website booking, consent recorded, no links, unassigned', [row.status, row.source, row.consent, Boolean(row.consent_at), row.customer_id, row.appointment_id, row.assigned_staff_id, row.updated_by],
    ['New', 'Website', 1, true, null, null, null, null]);
  ok_('   ...with a hashed address, never the IP', row.ip_hash && row.ip_hash.length === 64 && !JSON.stringify(row).includes('203.0.113'));
  check('   ...and a "submitted" history row from the Website', h.one('SELECT action, to_status, detail, actor FROM booking_history'), { action: 'submitted', to_status: 'New', detail: 'Source: Website', actor: 'Website' });
  ok_('the answer carries no stored data', !/Test Booker|01711|booker\.one|Axio/.test(r.text), r.text);
  check('an international number is normalised for search and duplicates', [(await h.submit(BOOK({ phone: '+880 1711-000099', serviceType: 'hybrid' }))).status, h.one("SELECT phone_digits FROM bookings WHERE service_type = 'hybrid'").phone_digits], [201, '01711000099']);
  const fields = async (b) => (await h.submit(b)).body?.error?.fields || {};
  check('the required fields', Object.keys(await fields({ consent: true })).sort(),
    ['name', 'phone', 'preferredDate', 'preferredTime', 'serviceType', 'vehicleMake', 'vehicleModel']);
  ok_('consent is required', 'consent' in await fields(BOOK({ consent: false })) && 'consent' in await fields(BOOK({ consent: 'yes' })));
  ok_('a phone that is not a Bangladeshi mobile is refused', 'phone' in await fields(BOOK({ phone: '12345' })) && 'phone' in await fields(BOOK({ phone: 'call me' })));
  ok_('a bad email is refused', 'email' in await fields(BOOK({ email: 'nope' })));
  ok_('a service that is not on the form is refused', 'serviceType' in await fields(BOOK({ serviceType: 'free-car' })));
  ok_('a past date is refused', 'preferredDate' in await fields(BOOK({ preferredDate: dayPlus(-1) })));
  ok_('an impossible date is refused', 'preferredDate' in await fields(BOOK({ preferredDate: '2026-02-31' })));
  ok_('a date more than 90 days ahead is refused', /90 days/.test((await fields(BOOK({ preferredDate: dayPlus(95) }))).preferredDate || ''));
  ok_('a bad time is refused', 'preferredTime' in await fields(BOOK({ preferredTime: '25:00' })));
  ok_('an over-long message is refused', 'message' in await fields(BOOK({ message: 'x'.repeat(1001) })));
  ok_('an unknown field is refused by name', 'status' in await fields(BOOK({ status: 'Confirmed' })) && 'source' in await fields(BOOK({ source: 'Phone' })));
  ok_('a number where text belongs is refused', 'name' in await fields(BOOK({ name: 12345 })));
  check('a body that is not JSON is 400', (await h.submit('{oops', { raw: true })).status, 400);
  check('GET on the endpoint is 405', (await h.submit(null, { method: 'GET' })).status, 405);
  h.DB.raw.exec(`INSERT INTO settings (id, business_name, phone, address, opening_time, closing_time, working_days) VALUES (1, 'T', '1', 'A', '09:00', '20:00', '["Sat","Sun","Mon","Tue","Wed","Thu"]')`);
  ok_('with working days set: a Friday is refused, naming the open days', /closed on Fri/.test((await fields(BOOK({ preferredDate: friday() }))).preferredDate || ''));
  ok_('with opening hours set: a time outside them is refused', /between 09:00 and 20:00/.test((await fields(BOOK({ preferredTime: '21:30' }))).preferredTime || ''));
  check('   ...and one inside them is accepted', (await h.submit(BOOK({ phone: '01711000050', preferredTime: '19:59' }))).status, 201);
}

/* ---------- C. anti-spam, duplicates, CORS ---------- */
{
  const h = fresh();
  const bot = await h.submit(BOOK({ company: 'Acme Ltd' }));
  check('a filled honeypot is told "received" but nothing is stored', [bot.status, bot.body.data.reference, h.one('SELECT count(*) AS n FROM bookings').n], [201, 'BKG-0000', 0]);
  const fast = await h.submit(BOOK({ startedAt: Date.now() - 500 }));
  check('a form sent within 3 seconds is treated the same way', [fast.status, h.one('SELECT count(*) AS n FROM bookings').n], [201, 0]);
  const key = 'k-1234567890abcdef';
  const first = await h.submit(BOOK({ idempotencyKey: key }));
  const retry = await h.submit(BOOK({ idempotencyKey: key, preferredTime: '11:00' }));
  check('a retry with the same idempotency key returns the first reference, adds nothing', [first.status, retry.status, retry.body.data, h.one('SELECT count(*) AS n FROM bookings').n],
    [201, 200, { reference: 'BKG-0001', duplicate: true }, 1]);
  const same = await h.submit(BOOK());
  check('the same phone + date + service while it is open returns the first reference', [same.status, same.body.data, h.one('SELECT count(*) AS n FROM bookings').n], [200, { reference: 'BKG-0001', duplicate: true }, 1]);
  check('a different service from the same phone is a new booking', (await h.submit(BOOK({ serviceType: 'car-wash' }))).body.data.reference, 'BKG-0002');
  check('a different date is a new booking', (await h.submit(BOOK({ preferredDate: workday(4) }))).body.data.reference, 'BKG-0003');
  h.DB.raw.exec("UPDATE bookings SET status = 'Rejected' WHERE id = 'BKG-0001'");
  check('once the first is closed (Rejected), the same request is a new booking', (await h.submit(BOOK())).body.data.reference, 'BKG-0004');
  ok_('a malformed idempotency key is refused', 'idempotencyKey' in ((await h.submit(BOOK({ idempotencyKey: 'bad key!' }))).body.error.fields || {}));
  const burst = [];
  for (let i = 0; i < 7; i++) burst.push((await h.submit(BOOK({ phone: `0171200000${i}` }), { ip: '198.51.100.7' })).status);
  check('one address: five accepted in 10 minutes, then 429', burst, [201, 201, 201, 201, 201, 429, 429]);
  check('...and the refused ones were not stored', h.one("SELECT count(*) AS n FROM bookings WHERE phone_digits LIKE '0171200000%'").n, 5);
  check('another website cannot post a booking (403), and nothing is stored', [(await h.submit(BOOK({ phone: '01713000000' }), { origin: 'https://evil.example' })).status, h.one("SELECT count(*) AS n FROM bookings WHERE phone_digits = '01713000000'").n], [403, 0]);
  const ok = await h.submit(BOOK({ phone: '01713000001' }));
  check('the website origin is answered with CORS for itself only', [ok.headers.get('access-control-allow-origin'), ok.headers.get('vary')], ['https://taqwa.autos', 'Origin']);
  const pre = await worker.fetch(new Request('http://worker.local/api/bookings/submit', { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST' } }), h.env);
  const preBad = await worker.fetch(new Request('http://worker.local/api/bookings/submit', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), h.env);
  check('the CORS preflight answers the website (204) and refuses others (403)', [pre.status, pre.headers.get('access-control-allow-methods'), preBad.status], [204, 'POST, OPTIONS', 403]);
  const big = await h.submit(BOOK({ message: 'x'.repeat(20000) }));
  ok_('an over-size body is refused', big.status === 413 || big.status === 422, big.status);
}
{
  // Logs: one line per submission, outcome and status only.
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const h = fresh();
    await h.submit(BOOK()); await h.submit(BOOK()); await h.submit(BOOK({ company: 'x' }));
  } finally { console.log = orig; }
  const mine = lines.filter((l) => l.includes('booking_submit'));
  check('logs: stored, duplicate, spam_suspected -- nothing else', mine.map((l) => JSON.parse(l).outcome), ['stored', 'duplicate', 'spam_suspected']);
  ok_('...and no name, phone, email or message in any log line', !lines.some((l) => /Test Booker|01711|booker\.one|cooling/.test(l)), lines.join('\n'));
}

/* ---------- D. staff API ---------- */
{
  const h = fresh();
  seed(h);
  await h.submit(BOOK());                                                                           // BKG-0001
  await h.submit(BOOK({ name: 'Second Person', phone: '01722-555666', email: '', registrationNumber: '', vehicleMake: 'Honda', vehicleModel: 'Vezel', serviceType: 'hybrid', message: 'Hybrid warning light' })); // BKG-0002

  check('without a credential the list is 401', (await h.api('GET', '/api/bookings', undefined, 'none')).status, 401);
  const list = async (qs = '') => (await h.api('GET', `/api/bookings${qs ? '?' + qs : ''}`)).body;
  const all = await list();
  check('list: newest first, with total and summary', [all.data.map((b) => b.id), all.total, all.summary.total, all.summary.new], [['BKG-0002', 'BKG-0001'], 2, 2, 2]);
  ok_('   ...the summary has a count for every status', ['new', 'pending', 'confirmed', 'rescheduled', 'cancelled', 'rejected', 'completed'].every((k) => k in all.summary), JSON.stringify(all.summary));
  const find = async (q) => (await list(`q=${encodeURIComponent(q)}`)).data.map((b) => b.id);
  check('search: name', await find('second per'), ['BKG-0002']);
  check('search: phone in any form, even a partial +880 one', [await find('01722555666'), await find('+880 1722-555666'), await find('555-666'), await find('+880 1722')], [['BKG-0002'], ['BKG-0002'], ['BKG-0002'], ['BKG-0002']]);
  check('search: reference', await find('bkg-0001'), ['BKG-0001']);
  check('search: registration and vehicle', [await find('metro-ga'), await find('honda vezel')], [['BKG-0001'], ['BKG-0002']]);
  check('filter: source and date', [(await list('source=Phone')).total, (await list(`from=${workday()}&to=${workday()}`)).total], [0, 2]);
  check('bad filters are 400', [(await h.api('GET', '/api/bookings?status=Booked')).status, (await h.api('GET', '/api/bookings?source=Email')).status, (await h.api('GET', '/api/bookings?assigned=x;y')).status], [400, 400, 400]);
  check('paging', [(await list('limit=1')).data.map((b) => b.id), (await list('limit=1&offset=1')).data.map((b) => b.id)], [['BKG-0002'], ['BKG-0001']]);

  let one = (await h.api('GET', '/api/bookings/BKG-0001')).body.data;
  check('detail: the record, allowed next statuses, history', [one.reference, one.status, one.allowedStatuses, one.history.map((e) => e.action)],
    ['BKG-0001', 'New', ['Pending', 'Confirmed', 'Rejected', 'Cancelled'], ['submitted']]);
  check('   ...possible matches: the customer by phone (+880 form in the CRM) and the vehicle by registration', [one.matches.customers.map((c) => c.id), one.matches.vehicles.map((v) => v.id)], [['CUS-0001'], ['VEH-0001']]);
  check('a bad or missing id', [(await h.api('GET', '/api/bookings/WEB-0001')).status, (await h.api('GET', '/api/bookings/BKG-9999')).status], [400, 404]);
  check('there is no delete', (await h.api('DELETE', '/api/bookings/BKG-0001')).status, 405);

  const put = (id, body) => h.api('PUT', `/api/bookings/${id}`, body);
  check('the submitted details cannot be edited', [(await put('BKG-0001', { customerName: 'X', expectedUpdatedAt: one.updatedAt })).status, h.one("SELECT customer_name FROM bookings WHERE id='BKG-0001'").customer_name], [422, 'Test Booker One']);
  let r = await put('BKG-0001', { assignedStaffId: 'STF-0001', expectedUpdatedAt: one.updatedAt });
  check('assign an active employee', [r.status, r.body.data.assignedStaffName, r.body.data.assignedBy, r.body.data.history.slice(-1)[0].detail], [200, 'Nadia Akter', 'API token', 'Assigned to Nadia Akter (STF-0001)']);
  one = r.body.data;
  check('an inactive or unknown person is refused', [(await put('BKG-0001', { assignedStaffId: 'STF-0002', expectedUpdatedAt: one.updatedAt })).status, (await put('BKG-0001', { assignedStaffId: 'STF-0404', expectedUpdatedAt: one.updatedAt })).status], [422, 422]);
  check('a vehicle cannot be linked before the customer', (await put('BKG-0001', { vehicleId: 'VEH-0001', expectedUpdatedAt: one.updatedAt })).body.error.fields.vehicleId, 'Link the customer first.');
  r = await put('BKG-0001', { customerId: 'CUS-0001', vehicleId: 'VEH-0002', expectedUpdatedAt: one.updatedAt });
  check('a vehicle of a different customer is refused', [r.status, r.body.error.fields.vehicleId], [422, 'That vehicle belongs to a different customer.']);
  r = await put('BKG-0001', { customerId: 'CUS-0001', vehicleId: 'VEH-0001', expectedUpdatedAt: one.updatedAt });
  check('link customer and vehicle', [r.status, r.body.data.customerId, r.body.data.vehicleId], [200, 'CUS-0001', 'VEH-0001']);
  one = r.body.data;
  r = await put('BKG-0001', { customerId: 'CUS-0002', expectedUpdatedAt: one.updatedAt });
  check('changing the customer drops a vehicle that no longer fits', [r.body.data.customerId, r.body.data.vehicleId], ['CUS-0002', '']);
  one = r.body.data;
  check('an edit from an old copy is 409 and writes no history', [(await put('BKG-0001', { assignedStaffId: null, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' })).status,
    h.one("SELECT count(*) AS n FROM booking_history WHERE booking_id='BKG-0001' AND detail = 'Unassigned'").n], [409, 0]);

  const status = (id, body) => h.api('POST', `/api/bookings/${id}/status`, body);
  check('Rejected and Cancelled need a reason', [(await status('BKG-0001', { to: 'Rejected', expectedUpdatedAt: one.updatedAt })).body.error.fields.reason,
    (await status('BKG-0001', { to: 'Cancelled', reason: '  ', expectedUpdatedAt: one.updatedAt })).status], ['Please give a reason for marking it Rejected.', 422]);
  check('an illegal move is 409 (New -> Completed)', [(await status('BKG-0001', { to: 'Completed', expectedUpdatedAt: one.updatedAt })).status], [409]);
  r = await status('BKG-0001', { to: 'Pending', expectedUpdatedAt: one.updatedAt });
  check('New -> Pending', [r.status, r.body.data.status, r.body.data.allowedStatuses], [200, 'Pending', ['Confirmed', 'Rejected', 'Cancelled']]);
  r = await status('BKG-0001', { to: 'Confirmed', expectedUpdatedAt: r.body.data.updatedAt });
  check('Pending -> Confirmed sets confirmedAt', [r.status, r.body.data.status, Boolean(r.body.data.confirmedAt)], [200, 'Confirmed', true]);
  check('Rescheduled needs the new date and time', Object.keys((await status('BKG-0001', { to: 'Rescheduled', expectedUpdatedAt: r.body.data.updatedAt })).body.error.fields).sort(), ['date', 'time']);
  const newDate = workday(6);
  r = await status('BKG-0001', { to: 'Rescheduled', date: newDate, time: '14:00', reason: 'Customer asked', expectedUpdatedAt: r.body.data.updatedAt });
  check('Confirmed -> Rescheduled moves the date and time and records old -> new', [r.status, r.body.data.preferredDate, r.body.data.preferredTime, r.body.data.history.slice(-1)[0].detail],
    [200, newDate, '14:00', `${workday()} 10:30 → ${newDate} 14:00`]);
  r = await status('BKG-0001', { to: 'Confirmed', expectedUpdatedAt: r.body.data.updatedAt });
  r = await status('BKG-0001', { to: 'Completed', expectedUpdatedAt: r.body.data.updatedAt });
  check('Rescheduled -> Confirmed -> Completed, which is final', [r.body.data.status, r.body.data.allowedStatuses], ['Completed', []]);
  check('the history keeps every step, who and when', r.body.data.history.filter((e) => e.action === 'status').map((e) => `${e.fromStatus}>${e.toStatus}`),
    ['New>Pending', 'Pending>Confirmed', 'Confirmed>Rescheduled', 'Rescheduled>Confirmed', 'Confirmed>Completed']);
  ok_('   ...each with its actor and time', r.body.data.history.every((e) => e.actor && e.at), JSON.stringify(r.body.data.history));
  const two = (await h.api('GET', '/api/bookings/BKG-0002')).body.data;
  r = await status('BKG-0002', { to: 'Cancelled', reason: 'Customer sold the car', expectedUpdatedAt: two.updatedAt });
  check('Cancelled keeps the reason and sets cancelledAt', [r.body.data.status, r.body.data.history.slice(-1)[0].reason, Boolean(r.body.data.cancelledAt)], ['Cancelled', 'Customer sold the car', true]);

  const note = (id, body) => h.api('POST', `/api/bookings/${id}/notes`, body);
  const before = h.one("SELECT updated_at FROM bookings WHERE id='BKG-0002'").updated_at;
  r = await note('BKG-0002', { note: '  Called back, no answer.  ' });
  check('add a note: trimmed, newest first, history says a note was added (not its text)', [r.status, r.body.data.notes[0].note, r.body.data.notes[0].by, r.body.data.history.slice(-1)[0].action, r.body.data.history.slice(-1)[0].detail],
    [201, 'Called back, no answer.', 'API token', 'note', '']);
  check('   ...and it does not move updatedAt (no one else\'s edit is made stale)', h.one("SELECT updated_at FROM bookings WHERE id='BKG-0002'").updated_at, before);
  check('an empty note and an unknown field are refused', [(await note('BKG-0002', { note: ' ' })).status, (await note('BKG-0002', { note: 'x', by: 'me' })).status], [422, 422]);

  r = await h.api('POST', '/api/bookings', { name: 'Walk In Person', phone: '01733-000003', vehicleMake: 'Nissan', vehicleModel: 'X-Trail', serviceType: 'periodic-maintenance', preferredDate: workday(), preferredTime: '12:00', source: 'Walk-in' });
  check('staff create: a Walk-in booking, New, created by the caller', [r.status, r.body.data.id, r.body.data.source, r.body.data.status, r.body.data.consent, r.body.data.history[0].actor], [201, 'BKG-0003', 'Walk-in', 'New', false, 'API token']);
  check('staff cannot create a "Website" booking or use public fields', [(await h.api('POST', '/api/bookings', { ...BOOK(), company: undefined, startedAt: undefined, source: 'Website' })).status,
    Object.keys((await h.api('POST', '/api/bookings', { name: 'x' + 'y', phone: '01733000004', vehicleMake: 'Nissan', vehicleModel: 'X', serviceType: 'other', preferredDate: workday(), preferredTime: '12:00', idempotencyKey: 'abcdefgh123' })).body.error.fields)], [422, ['idempotencyKey']]);
  check('assigned filter', [(await list('assigned=STF-0001')).data.map((b) => b.id), (await list('assigned=none')).total], [['BKG-0001'], 2]);
}

/* ---------- D2. permissions with a real role ---------- */
{
  const h = fresh();
  ok_('the bookings module is in the permission catalogue (view, create, edit, manage)',
    (await import('../../src/lib/permissions.js')).CATALOG.some((m) => m.key === 'bookings' && Object.keys(m.actions).join() === 'view,create,edit,manage'));
  const { collectionPermission } = await import('../../src/lib/permissions.js');
  check('each request needs its permission', ['view', 'create', 'update', 'status', 'notes', 'remove'].map((op) => collectionPermission('bookings', op)),
    ['bookings.view', 'bookings.create', 'bookings.edit', 'bookings.manage', 'bookings.edit', 'full']);
  void h;
}

console.log(`\nBookings API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
