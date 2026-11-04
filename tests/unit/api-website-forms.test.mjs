/* Website Forms (0016) — unit tests against the REAL Worker:
   POST /api/forms/submit (public) and /api/website-forms (staff).

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0016). All names and numbers are fictional test values.

   What must hold:
     A. Schema: the two tables, CHECKs, indexes, WEB counter; additive;
        re-runnable; the IP itself is never a column.
     B. Public submit: a valid booking is stored as New with a history row and
        answers only a reference; quote and contact forms; every field
        validated server-side with per-field messages; unknown fields refused.
     C. Anti-spam: honeypot and too-fast forms are told "received" but nothing
        is stored; the same phone + form + service within 10 minutes returns
        the first reference; a burst from one address is 429; CORS allows the
        website's origins only (and an extra one from FORMS_ALLOWED_ORIGINS);
        the preflight answers; the response never echoes stored data.
     D. Staff API: 401 without a credential (before any statement); list,
        search (name, phone digits, registration, message), status, type and
        date filters, paging, summary; detail with history; status and notes
        recorded with who and when; stale edits 409; no create or delete.
     E. Logs: one line per submission, outcome and status only -- never a
        name, phone, email or message.
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
  console.log(`\nWebsite forms unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) <= '0022').sort();
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
  let ipSeq = 0;
  const submit = async (body, { origin = SITE, ip = `203.0.113.${++ipSeq}`, raw = false, method = 'POST' } = {}) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip };
    if (origin) headers.origin = origin;
    const res = await worker.fetch(new Request('http://worker.local/api/forms/submit', {
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

const BOOKING = (extra = {}) => ({ formType: 'booking', name: 'Test Customer One', phone: '+880 1700-000001', email: 'test1@example.invalid',
  service: 'AC Service', vehicle: 'Toyota Axio', regNo: 'dhaka-metro-ga-11-0001', preferredDate: tomorrow, preferredTime: '10:30',
  message: 'AC is not cooling.', sourcePage: '/book', startedAt: Date.now() - 60000, company: '', ...extra });

/* ---------- A. schema ---------- */
{
  const h = fresh();
  check('the submissions table has the planned columns', h.all('PRAGMA table_info(website_form_submissions)').map((c) => c.name),
    ['id', 'form_type', 'name', 'phone', 'phone_digits', 'email', 'service', 'vehicle', 'reg_no', 'preferred_date', 'preferred_time', 'message',
      'source_page', 'status', 'notes', 'ip_hash', 'created_at', 'updated_at', 'updated_by',
      'assigned_to_id', 'assigned_to_name', 'assigned_at', 'assigned_by']);
  check('the events table has the planned columns', h.all('PRAGMA table_info(website_form_events)').map((c) => c.name),
    ['id', 'submission_id', 'action', 'from_status', 'to_status', 'actor', 'created_at']);
  check('a WEB counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='websiteForms'"), { prefix: 'WEB', last_value: 0 });
  ok_('no column holds a raw IP address', !h.all("SELECT name FROM pragma_table_info('website_form_submissions')").some((c) => c.name === 'ip' || c.name === 'ip_address'));
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|FOREIGN KEY|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  check('a status outside the four is refused', ins("INSERT INTO website_form_submissions (id, name, phone, phone_digits, status, created_at) VALUES ('WEB-9', 'x', '123456', '123456', 'Spam', 'x')"), 'CHECK');
  check('a valid row is accepted', ins("INSERT INTO website_form_submissions (id, name, phone, phone_digits, created_at) VALUES ('WEB-9', 'x', '123456', '123456', 'x')"), 'ok');
  check('an event must belong to a submission', ins("INSERT INTO website_form_events (submission_id, action, actor, created_at) VALUES ('WEB-404', 'notes', 'x', 'x')"), 'FOREIGN KEY');
  ins("INSERT INTO website_form_events (submission_id, action, actor, created_at) VALUES ('WEB-9', 'notes', 'x', 'x')");
  check('a submission with history cannot be deleted', ins("DELETE FROM website_form_submissions WHERE id = 'WEB-9'"), 'FOREIGN KEY');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0016_website_forms.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable', again, 'ok');
  const plain = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS.slice(0, -1)) plain.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%website_form%' AND name NOT LIKE '%_wfs_%' AND name NOT LIKE '%_wfe_%' ORDER BY name").all());
  check('0016 is additive: every other table and index is unchanged', shape(h.DB.raw) === shape(plain), true);
}

/* ---------- B. public submit ---------- */
{
  const h = fresh();
  const r = await h.submit(BOOKING());
  check('a valid booking is stored and answers only a reference', [r.status, r.body.data, r.body.message], [201, { reference: 'WEB-0001' }, 'Thank you. Your request has been received.']);
  const row = h.one('SELECT * FROM website_form_submissions');
  check('   ...stored as New with the fields cleaned', [row.status, row.name, row.phone_digits, row.reg_no, row.service, row.preferred_time, row.form_type],
    ['New', 'Test Customer One', '8801700000001', 'DHAKA-METRO-GA-11-0001', 'AC Service', '10:30', 'booking']);
  ok_('   ...with a hashed address, never the IP', row.ip_hash && row.ip_hash.length === 64 && !JSON.stringify(row).includes('203.0.113'));
  check('   ...and a "submitted" history row from the Website', h.one('SELECT action, to_status, actor FROM website_form_events'), { action: 'submitted', to_status: 'New', actor: 'Website' });
  ok_('the answer carries no stored data', !/Test Customer|8801700000001|test1@|Axio/.test(r.text), r.text);
  check('a quote form with only name and phone is accepted', (await h.submit({ formType: 'quote', name: 'Q Test', phone: '01700000002' })).status, 201);
  check('a form with no type is a booking', (await h.submit({ name: 'Default Type', phone: '01700000009' })).status, 201);
  check('...stored as booking', h.one("SELECT form_type FROM website_form_submissions WHERE name = 'Default Type'").form_type, 'booking');
  const fields = async (b) => (await h.submit(b)).body?.error?.fields || {};
  check('name and phone are required', Object.keys(await fields({})).sort(), ['name', 'phone']);
  ok_('a phone with letters is refused', 'phone' in await fields(BOOKING({ phone: 'call me' })));
  ok_('a phone too short is refused', 'phone' in await fields(BOOKING({ phone: '123' })));
  ok_('a bad email is refused', 'email' in await fields(BOOKING({ email: 'not-an-email' })));
  ok_('a past date is refused', 'preferredDate' in await fields(BOOKING({ preferredDate: '2020-01-01' })));
  ok_('an impossible date is refused', 'preferredDate' in await fields(BOOKING({ preferredDate: '2026-02-31' })));
  ok_('a bad time is refused', 'preferredTime' in await fields(BOOKING({ preferredTime: '25:00' })));
  ok_('an unknown form type is refused', 'formType' in await fields(BOOKING({ formType: 'job' })));
  ok_('a contact form needs a message', 'message' in await fields({ formType: 'contact', name: 'C', phone: '01700000003' }));
  ok_('an over-long message is refused', 'message' in await fields(BOOKING({ message: 'x'.repeat(2001) })));
  ok_('an unknown field is refused by name', 'status' in await fields(BOOKING({ status: 'Confirmed' })));
  ok_('a number where text belongs is refused', 'name' in await fields(BOOKING({ name: 12345 })));
  check('a body that is not JSON is 400', (await h.submit('{oops', { raw: true })).status, 400);
  check('GET on the endpoint is 405', (await h.submit(null, { method: 'GET' })).status, 405);
  const xss = await h.submit(BOOKING({ name: '<script>alert(1)</script>', phone: '01700000004' }));
  check('markup is stored as text (escaped when shown), never interpreted here', [xss.status, h.one("SELECT name FROM website_form_submissions WHERE phone_digits = '01700000004'").name], [201, '<script>alert(1)</script>']);
}

/* ---------- C. anti-spam and CORS ---------- */
{
  const h = fresh();
  const bot = await h.submit(BOOKING({ company: 'Acme Ltd' }));
  check('a filled honeypot is told "received" but nothing is stored', [bot.status, bot.body.data.reference, h.one('SELECT count(*) AS n FROM website_form_submissions').n], [201, 'WEB-0000', 0]);
  const fast = await h.submit(BOOKING({ startedAt: Date.now() - 500 }));
  check('a form sent within 3 seconds of opening is treated the same way', [fast.status, h.one('SELECT count(*) AS n FROM website_form_submissions').n], [201, 0]);
  const first = await h.submit(BOOKING());
  const again = await h.submit(BOOKING());
  check('the same phone, form and service within 10 minutes is one enquiry', [first.body.data.reference, again.status, again.body.data, h.one('SELECT count(*) AS n FROM website_form_submissions').n],
    ['WEB-0001', 200, { reference: 'WEB-0001', duplicate: true }, 1]);
  check('a different service from the same phone is a new enquiry', (await h.submit(BOOKING({ service: 'Car Wash' }))).body.data.reference, 'WEB-0002');
  const burst = [];
  for (let i = 0; i < 7; i++) burst.push((await h.submit(BOOKING({ phone: `0171100000${i}` }), { ip: '198.51.100.7' })).status);
  check('one address: five accepted in 10 minutes, then 429', burst, [201, 201, 201, 201, 201, 429, 429]);
  check('...and the refused ones were not stored', h.one("SELECT count(*) AS n FROM website_form_submissions WHERE phone_digits LIKE '0171100000%'").n, 5);
  check('another address is not affected', (await h.submit(BOOKING({ phone: '01722000001' }), { ip: '198.51.100.8' })).status, 201);

  const cors = await h.submit(BOOKING({ phone: '01733000001' }));
  check('the website origin gets CORS headers', [cors.headers.get('access-control-allow-origin'), cors.headers.get('vary')], [SITE, 'Origin']);
  check('www.taqwa.autos is allowed too', (await h.submit(BOOKING({ phone: '01733000002' }), { origin: 'https://www.taqwa.autos' })).status, 201);
  const evil = await h.submit(BOOKING({ phone: '01733000003' }), { origin: 'https://evil.example' });
  check('another origin is refused and nothing stored', [evil.status, evil.headers.get('access-control-allow-origin'), h.one("SELECT count(*) AS n FROM website_form_submissions WHERE phone_digits = '01733000003'").n], [403, null, 0]);
  const extra = fresh({ FORMS_ALLOWED_ORIGINS: 'http://localhost:4321, not a url' });
  check('FORMS_ALLOWED_ORIGINS adds an origin (and ignores junk)', (await extra.submit(BOOKING(), { origin: 'http://localhost:4321' })).status, 201);
  const pre = await worker.fetch(new Request('http://worker.local/api/forms/submit', { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST' } }), h.env);
  check('the preflight answers 204 for the website', [pre.status, pre.headers.get('access-control-allow-methods')], [204, 'POST, OPTIONS']);
  const preBad = await worker.fetch(new Request('http://worker.local/api/forms/submit', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), h.env);
  check('...and refuses another origin', preBad.status, 403);
  check('no session is needed to submit (it is public by design)', (await h.submit(BOOKING({ phone: '01744000001' }), { origin: null })).status, 201);
  const broken = { ...h.env, DB: { prepare() { throw new Error('D1_ERROR: detail'); }, batch() { throw new Error('D1_ERROR'); } } };
  const res = await worker.fetch(new Request('http://worker.local/api/forms/submit', { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: JSON.stringify(BOOKING()) }), broken);
  const txt = await res.text();
  check('a database failure is a plain 500 with CORS, revealing nothing', [res.status, res.headers.get('access-control-allow-origin'), /D1_ERROR|detail/.test(txt)], [500, SITE, false]);
}

/* ---------- D. staff API ---------- */
{
  const h = fresh();
  const people = [['Rahim Test', '01700000101', 'AC Service', 'DHAKA-GA-1', 'booking', 'AC noise'], ['Karim Test', '01700000102', 'LPG Conversion', 'DHAKA-KA-2', 'quote', ''],
    ['Nadia Test', '01700000103', 'Car Wash', '', 'contact', 'Do you open on Friday?'], ['Salma Test', '01700000104', 'Engine Repair', 'CTG-GA-3', 'booking', '']];
  for (const [name, phone, service, regNo, formType, message] of people) await h.submit({ name, phone, service, regNo, formType, message });
  h.DB.raw.exec("UPDATE website_form_submissions SET created_at = '2026-10-01T05:00:00.000Z', updated_at = '2026-10-01T05:00:00.000Z' WHERE id = 'WEB-0001'");
  h.DB.statements.length = 0;
  const denied = [];
  for (const [m, p, b] of [['GET', '/api/website-forms'], ['GET', '/api/website-forms/WEB-0001'], ['PUT', '/api/website-forms/WEB-0001', { status: 'Contacted' }]]) denied.push((await h.api(m, p, b, 'none')).status);
  check('every staff route is 401 without a credential', denied, [401, 401, 401]);
  check('...and no statement ran', h.DB.statements.length, 0);
  const list = await h.api('GET', '/api/website-forms');
  check('the list is newest first, with a summary', [list.status, list.body.data.map((r) => r.id), list.body.summary],
    [200, ['WEB-0004', 'WEB-0003', 'WEB-0002', 'WEB-0001'], { total: 4, new: 4, contacted: 0, confirmed: 0, rejected: 0 }]);
  ok_('the list never carries the address hash', !/ip_hash|ipHash/.test(list.text));
  const ids = async (qs) => (await h.api('GET', `/api/website-forms?${qs}`)).body.data.map((r) => r.id);
  check('search: name, any case', await ids('q=KARIM'), ['WEB-0002']);
  check('search: phone digits, separators ignored', await ids(`q=${encodeURIComponent('0170-0000 103')}`), ['WEB-0003']);
  check('search: registration number', await ids('q=ctg-ga'), ['WEB-0004']);
  check('search: message text', await ids('q=friday'), ['WEB-0003']);
  check('LIKE wildcards are literal', await ids('q=%25'), []);
  check('type filter', await ids('type=quote'), ['WEB-0002']);
  check('date filter: from (Dhaka days)', (await ids(`from=${new Date().toISOString().slice(0, 10)}`)).length, 3);
  check('date filter: to', await ids('to=2026-10-01'), ['WEB-0001']);
  check('paging', [(await h.api('GET', '/api/website-forms?limit=2&offset=1')).body.data.map((r) => r.id), (await h.api('GET', '/api/website-forms?limit=2&offset=1')).body.total], [['WEB-0003', 'WEB-0002'], 4]);
  for (const [qs, label] of [['status=Spam', 'status'], ['type=job', 'type'], ['from=yesterday', 'from'], ['from=2026-10-05&to=2026-10-01', 'range'], ['limit=0', 'limit'], [`q=${'x'.repeat(101)}`, 'q']]) {
    check(`a bad ${label} is 400`, (await h.api('GET', `/api/website-forms?${qs}`)).status, 400);
  }

  const one = await h.api('GET', '/api/website-forms/WEB-0002');
  check('detail: the full enquiry with its history', [one.status, one.body.data.service, one.body.data.history.map((e) => e.action)], [200, 'LPG Conversion', ['submitted']]);
  check('an unknown enquiry is 404, a malformed id 400', [(await h.api('GET', '/api/website-forms/WEB-0999')).status, (await h.api('GET', '/api/website-forms/WAC-0001')).status], [404, 400]);
  const up = await h.api('PUT', '/api/website-forms/WEB-0002', { status: 'Contacted', notes: '  Called, sending a quote  ', expectedUpdatedAt: one.body.data.updatedAt });
  check('status and notes are saved, with who', [up.status, up.body.data.status, up.body.data.notes, up.body.data.updatedBy], [200, 'Contacted', 'Called, sending a quote', 'API token']);
  check('...and both are recorded in the history', up.body.data.history.map((e) => [e.action, e.fromStatus, e.toStatus, e.actor]),
    [['submitted', '', 'New', 'Website'], ['status', 'New', 'Contacted', 'API token'], ['notes', '', '', 'API token']]);
  const stale = await h.api('PUT', '/api/website-forms/WEB-0002', { status: 'Rejected', expectedUpdatedAt: one.body.data.updatedAt });
  check('an edit from an old copy is 409 and changes nothing', [stale.status, h.one("SELECT status FROM website_form_submissions WHERE id='WEB-0002'").status, h.one("SELECT count(*) AS n FROM website_form_events WHERE submission_id='WEB-0002'").n], [409, 'Contacted', 3]);
  const conf = await h.api('PUT', '/api/website-forms/WEB-0002', { status: 'Confirmed', expectedUpdatedAt: up.body.data.updatedAt });
  check('Confirmed', [conf.status, conf.body.data.status], [200, 'Confirmed']);
  check('the status filter and summary follow', [await ids('status=Confirmed'), (await h.api('GET', '/api/website-forms')).body.summary.confirmed], [['WEB-0002'], 1]);
  const same = await h.api('PUT', '/api/website-forms/WEB-0002', { status: 'Confirmed', expectedUpdatedAt: conf.body.data.updatedAt });
  check('setting the same status again records nothing new', [same.status, same.body.data.history.length], [200, 4]);
  check('a status outside the four is 422', (await h.api('PUT', '/api/website-forms/WEB-0002', { status: 'Spam', expectedUpdatedAt: conf.body.data.updatedAt })).status, 422);
  check('expectedUpdatedAt is required', Object.keys((await h.api('PUT', '/api/website-forms/WEB-0002', { status: 'New' })).body.error.fields), ['expectedUpdatedAt']);
  check('customer fields cannot be edited here', Object.keys((await h.api('PUT', '/api/website-forms/WEB-0002', { name: 'x', expectedUpdatedAt: conf.body.data.updatedAt })).body.error.fields), ['name']);
  check('there is no create through the staff API (405)', (await h.api('POST', '/api/website-forms', { name: 'x' })).status, 405);
  check('there is no delete (405) and the enquiry remains', [(await h.api('DELETE', '/api/website-forms/WEB-0001')).status, h.one('SELECT count(*) AS n FROM website_form_submissions').n], [405, 4]);
}

/* ---------- E. logs ---------- */
{
  const h = fresh();
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    await h.submit(BOOKING({ name: 'Private Person', phone: '01799999999', email: 'private@example.invalid', message: 'Private message' }));
    await h.submit(BOOKING({ name: 'Private Person', phone: '01799999999' }));
    await h.submit(BOOKING({ company: 'bot' }));
  } finally { console.log = real; }
  const logs = lines.filter((l) => l.includes('website_form')).map((l) => JSON.parse(l));
  check('one line per submission: stored, duplicate, spam', logs.map((l) => l.outcome), ['stored', 'duplicate', 'spam_suspected']);
  check('each line has only event, outcome and status', Object.keys(logs[0]), ['event', 'outcome', 'status']);
  ok_('no log line holds a name, phone, email, message or address', !/Private|01799999999|example\.invalid|203\.0\.113/.test(lines.join('\n')), lines.join('\n'));
}

console.log(`\nWebsite forms unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
