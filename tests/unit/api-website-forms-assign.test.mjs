/* Website Forms — assignment (0022) and the taqwa.autos/contact mapping.
   Unit tests against the REAL Worker with an in-memory SQLite database built
   from every real migration. All names and numbers are fictional test values.

   What must hold:
     A. 0022 is additive: four NULLable columns and one index; existing rows
        read as "Not assigned"; nothing else in the schema changes.
     B. The /contact form's payload (formType contact, sourcePage /contact,
        honeypot, startedAt) is stored with every field mapped, status New,
        server time; a repeat within 10 minutes returns the same reference.
     C. Assignment: an active employee or mechanic can be assigned, with
        their name, who assigned and when; inactive / unknown / malformed ids
        are refused; null un-assigns; status, notes and assignment persist
        across reads; stale edits 409; the `assigned` filter works.
     D. Search finds a contact enquiry by name, phone, email and message.
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
  console.log(`\nWebsite forms assignment unit: ${pass} passed, ${fail} failed`);
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


const AT = '2026-01-01T00:00:00.000Z';
function seedStaff(h) {
  h.DB.raw.exec(`
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Front desk', 'Service', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0002', 'Gone Person', '01911000002', 'Inactive', 'Front desk', 'Service', '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'Engine', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0002', 'Left Already', '01800000003', 'Inactive', '${AT}');
  `);
}

// Exactly what the website's /contact page sends (see mh-71/taqwa src/pages/contact.astro).
const CONTACT = (extra = {}) => ({ formType: 'contact', name: 'Test Contact Person', phone: '01700-111222', email: 'contact.test@example.invalid',
  service: 'Car AC Service', message: 'My AC makes a noise.\nCan I bring it on Saturday?', sourcePage: '/contact', company: '', startedAt: Date.now() - 45000, ...extra });

/* ---------- A. 0022 is additive ---------- */
{
  const h = fresh();
  const cols = h.all('PRAGMA table_info(website_form_submissions)');
  check('0022 adds the four assignment columns, all NULLable', cols.filter((c) => c.name.startsWith('assigned_')).map((c) => [c.name, c.notnull]),
    [['assigned_to_id', 0], ['assigned_to_name', 0], ['assigned_at', 0], ['assigned_by', 0]]);
  ok_('...and the "Assigned to" filter index', h.all("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_wfs_assigned'").length === 1);
  check('the events table is unchanged', h.all('PRAGMA table_info(website_form_events)').map((c) => c.name),
    ['id', 'submission_id', 'action', 'from_status', 'to_status', 'actor', 'created_at']);
  const ALL = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const before = new DatabaseSync(':memory:');
  for (const f of ALL.filter((f) => f.slice(0, 4) < '0022')) before.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  before.exec("INSERT INTO website_form_submissions (id, name, phone, phone_digits, created_at) VALUES ('WEB-0001', 'Old Row', '01700000000', '01700000000', '2026-10-01T00:00:00.000Z')");
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT IN ('website_form_submissions', 'ix_wfs_assigned') ORDER BY name").all());
  const shapeBefore = shape(before);
  before.exec(readFileSync(join(ROOT, 'migrations', '0022_website_form_assignment.sql'), 'utf8'));
  check('applied to a database with data, every other table and index is unchanged', shape(before) === shapeBefore, true);
  check('...and an existing enquiry keeps its data and reads as not assigned', before.prepare("SELECT name, status, assigned_to_id, assigned_to_name FROM website_form_submissions").get(),
    { name: 'Old Row', status: 'New', assigned_to_id: null, assigned_to_name: null });
  const bad = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK/.exec(e.message)?.[0] || e.message; } };
  check('an over-long assignee id is refused by the schema', bad(`INSERT INTO website_form_submissions (id, name, phone, phone_digits, created_at, assigned_to_id) VALUES ('WEB-9', 'x', '123456', '123456', 'x', '${'X'.repeat(21)}')`), 'CHECK');
}

/* ---------- B. the /contact form ---------- */
let H;
{
  const h = H = fresh();
  seedStaff(h);
  const before = new Date().toISOString();
  const r = await h.submit(CONTACT());
  check('a /contact submission is accepted with a reference', [r.status, r.body.data], [201, { reference: 'WEB-0001' }]);
  const row = h.one('SELECT * FROM website_form_submissions WHERE id = ?', 'WEB-0001');
  check('Full Name, Phone, Email, Service and Message are mapped to their columns',
    [row.name, row.phone, row.phone_digits, row.email, row.service, row.message],
    ['Test Contact Person', '01700-111222', '01700111222', 'contact.test@example.invalid', 'Car AC Service', 'My AC makes a noise.\nCan I bring it on Saturday?']);
  check('form type contact, source page /contact, status New', [row.form_type, row.source_page, row.status], ['contact', '/contact', 'New']);
  ok_('submitted at is the server time, not anything the browser sent', row.created_at >= before && row.created_at <= new Date().toISOString(), row.created_at);
  const again = await h.submit(CONTACT());
  check('pressing Send again within 10 minutes gives the same reference, nothing added', [again.status, again.body.data, h.one('SELECT count(*) AS n FROM website_form_submissions').n],
    [200, { reference: 'WEB-0001', duplicate: true }, 1]);
  const bot = await h.submit(CONTACT({ phone: '01700999888', company: 'filled by a bot' }));
  check('the hidden honeypot field still stops bots', [bot.status, h.one('SELECT count(*) AS n FROM website_form_submissions').n], [201, 1]);
  const missing = await h.submit(CONTACT({ phone: '01700222333', message: '' }));
  check('an empty message is refused with a field message', [missing.status, Object.keys(missing.body.error.fields)], [422, ['message']]);
  const fromElsewhere = await h.submit(CONTACT({ phone: '01700222444' }), { origin: 'https://evil.example' });
  check('another site cannot post into the inbox', fromElsewhere.status, 403);
  const read = await h.api('GET', '/api/website-forms/WEB-0001');
  check('the CRM API returns it with source website, submitted time and not assigned',
    [read.body.data.source, read.body.data.submittedAt === row.created_at, read.body.data.assignedToId, read.body.data.formType, read.body.data.sourcePage],
    ['website', true, '', 'contact', '/contact']);
}

/* ---------- C. assignment ---------- */
{
  const h = H;
  const get = async () => (await h.api('GET', '/api/website-forms/WEB-0001')).body.data;
  const put = (body) => h.api('PUT', '/api/website-forms/WEB-0001', body);
  let cur = await get();
  let r = await put({ assignedToId: 'STF-0001', expectedUpdatedAt: cur.updatedAt });
  check('an active employee can be assigned', [r.status, r.body.data.assignedToId, r.body.data.assignedToName, r.body.data.assignedBy], [200, 'STF-0001', 'Nadia Akter', 'API token']);
  ok_('   ...with when it was assigned', typeof r.body.data.assignedAt === 'string' && r.body.data.assignedAt.length > 10);
  cur = r.body.data;
  r = await put({ assignedToId: 'MEC-0001', status: 'Contacted', notes: 'Called; will come Saturday.', expectedUpdatedAt: cur.updatedAt });
  check('a mechanic can be assigned, together with a status and a note', [r.status, r.body.data.assignedToName, r.body.data.status, r.body.data.notes], [200, 'Jamal Uddin', 'Contacted', 'Called; will come Saturday.']);
  const fresh_ = await get();
  check('status, notes and assignment persist (read again from the database)', [fresh_.status, fresh_.notes, fresh_.assignedToId, fresh_.assignedToName], ['Contacted', 'Called; will come Saturday.', 'MEC-0001', 'Jamal Uddin']);
  check('the history records the status and the note', fresh_.history.map((e) => e.action), ['submitted', 'status', 'notes']);
  for (const [what, id, reason] of [['an inactive employee', 'STF-0002', 'not an active'], ['an inactive mechanic', 'MEC-0002', 'not an active'], ['an unknown id', 'STF-0404', 'not an active'], ['a malformed id', 'robert; drop', 'Choose'], ['a number', 7, 'Choose']]) {
    const x = await put({ assignedToId: id, expectedUpdatedAt: fresh_.updatedAt });
    ok_(`${what} is refused (422)`, x.status === 422 && new RegExp(reason).test(x.body.error.fields.assignedToId), JSON.stringify(x.body));
  }
  check('...and the refused ones changed nothing', (await get()).assignedToId, 'MEC-0001');
  const stale = await put({ assignedToId: 'STF-0001', expectedUpdatedAt: cur.updatedAt });
  check('an assignment made from an old copy is refused (409)', [stale.status, (await get()).assignedToId], [409, 'MEC-0001']);
  const same = await put({ assignedToId: 'MEC-0001', expectedUpdatedAt: fresh_.updatedAt });
  check('assigning the same person again changes nothing', [same.status, same.body.data.updatedAt], [200, fresh_.updatedAt]);
  r = await put({ assignedToId: null, expectedUpdatedAt: fresh_.updatedAt });
  check('null un-assigns', [r.status, r.body.data.assignedToId, r.body.data.assignedToName], [200, '', '']);
  r = await put({ assignedToId: 'STF-0001', expectedUpdatedAt: r.body.data.updatedAt });
  await h.submit(CONTACT({ phone: '01700333444', name: 'Second Contact', email: 'second@example.invalid', message: 'Brake squeal' }));
  const list = async (qs) => (await h.api('GET', `/api/website-forms?${qs}`)).body;
  check('filter: assigned to a person', (await list('assigned=STF-0001')).data.map((x) => x.id), ['WEB-0001']);
  check('filter: not assigned', (await list('assigned=none')).data.map((x) => x.id), ['WEB-0002']);
  check('a malformed assigned filter is 400', (await h.api('GET', '/api/website-forms?assigned=x;y')).status, 400);
  check('the list carries the assignee', (await list('')).data.map((x) => [x.id, x.assignedToName]), [['WEB-0002', ''], ['WEB-0001', 'Nadia Akter']]);
  check('the New chip counts only New', (await list('status=New')).data.map((x) => x.id), ['WEB-0002']);
  check('the update refuses fields it does not own', (await put({ name: 'x', expectedUpdatedAt: r.body.data.updatedAt })).status, 422);
  check('without a credential the staff API is 401', (await h.api('GET', '/api/website-forms', undefined, 'none')).status, 401);

  /* ---------- D. search ---------- */
  const find = async (q) => (await list(`q=${encodeURIComponent(q)}`)).data.map((x) => x.id);
  check('search by name', await find('second cont'), ['WEB-0002']);
  check('search by phone (any separators)', await find('01700-333'), ['WEB-0002']);
  check('search by email', await find('contact.test@'), ['WEB-0001']);
  check('search by message', await find('brake'), ['WEB-0002']);
}

console.log(`\nWebsite forms assignment unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
