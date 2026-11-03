/* Tools & Equipment (0013) — unit tests against the REAL Worker: /api/tools.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0013), through the same minimal D1-shaped wrapper the
   Staff and Accounts suites use, so the rules are exercised as SQL.

   What must hold:
     A. Schema: the table, its CHECKs, the serial index (in-service only,
        ignoring case), the TOL counter; re-runnable; nothing else changed.
     B. Create: TOL ids, required fields, validation messages by field,
        status/condition rules, dates, price, unknown fields, duplicates.
     C. List: retired hidden by default, search, filters, sort, paging,
        summary; bad parameters 400.
     D. Detail and update: 404, merge, stale edits 409, serial clash 409.
     E. Retire: administrator only, reason required, then frozen; a retired
        serial may be reused.
     F. Security: 401 before any statement, no DELETE (405), safe 500.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync } from 'node:fs';
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
  console.log(`\nTools API unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql', '0009_user_accounts.sql', '0010_attendance.sql',
  '0011_leave_requests.sql', '0012_activity_log.sql', '0013_tools.sql', '0018_roles_permissions.sql', '0019_individual_login.sql',
  // 0021 (Equipment Inventory) extends this register; the routes read its columns and write its history.
  '0021_equipment_inventory.sql'];
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';

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

function fresh() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Accountant', 'Accounts', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection IN ('mechanics', 'staff');`);
  const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
  const api = async (method, path, body, cred = 'token') => {
    const headers = {};
    if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`;
    else if (cred !== 'none') headers.cookie = cred;
    const res = await worker.fetch(new Request('http://worker.local' + path, {
      method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 204 */ }
    // 0019: an account created by an administrator must choose its own password at
    // first sign-in. This suite is about something else, so that step is taken
    // for it here; tests/unit/api-login.test.mjs covers the step itself.
    if (method === 'POST' && /^\/api\/accounts(\/USR-\d+\/password)?$/.test(path) && res.status < 300 && json?.data?.id) {
      DB.raw.prepare('UPDATE user_accounts SET password_change_required = 0 WHERE id = ?').run(json.data.id);
    }
    return { status: res.status, body: json, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  return { DB, env, api, one };
}

const TOOL = (extra = {}) => ({ name: 'OBD-II Scanner', category: 'Diagnostic Equipment', condition: 'Good', status: 'Available', ...extra });
const add = async (h, extra) => (await h.api('POST', '/api/tools', TOOL(extra))).body?.data;

/* ---------- A. schema ---------- */
{
  const h = fresh();
  const cols = h.DB.raw.prepare('PRAGMA table_info(tools)').all().map((c) => c.name);
  check('the tools table has exactly the planned columns', cols, ['id', 'name', 'category', 'brand', 'model', 'serial_no',
    'purchase_date', 'purchase_price', 'supplier', 'warranty_expiry', 'location', 'condition', 'status', 'description',
    'notes', 'retired_at', 'retired_reason', 'created_by', 'updated_by', 'created_at', 'updated_at',
    // added by 0021, all NULLable
    'assigned_staff_id', 'assigned_mechanic_id', 'last_service_date', 'next_service_due']);
  check('a TOL counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='tools'"), { prefix: 'TOL', last_value: 0 });
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  const row = (over) => {
    const v = { id: "'TOL-9001'", name: "'X'", category: "'Other'", condition: "'Good'", status: "'Available'", created_at: `'${AT}'`, ...over };
    return `INSERT INTO tools (${Object.keys(v).join(',')}) VALUES (${Object.values(v).join(',')})`;
  };
  check('the schema refuses an unknown category', ins(row({ category: "'Toys'" })), 'CHECK');
  check('the schema refuses a negative price', ins(row({ purchase_price: '-1' })), 'CHECK');
  check('the schema refuses a damaged tool that is Available', ins(row({ condition: "'Damaged'" })), 'CHECK');
  check('the schema refuses a Poor tool In Use', ins(row({ condition: "'Poor'", status: "'In Use'" })), 'CHECK');
  check('the schema refuses a warranty before purchase', ins(row({ purchase_date: "'2026-01-10'", warranty_expiry: "'2025-01-10'" })), 'CHECK');
  check('the schema refuses Retired without a date and reason', ins(row({ status: "'Retired'" })), 'CHECK');
  check('the schema refuses a blank name', ins(row({ name: "'  '" })), 'CHECK');
  check('a valid row is accepted', ins(row({ serial_no: "'SN-1'" })), 'ok');
  check('the same serial in another case is refused while in service', ins(row({ id: "'TOL-9002'", serial_no: "'sn-1'" })), 'UNIQUE');
  h.DB.raw.exec(`UPDATE tools SET status='Retired', retired_at='${AT}', retired_reason='Broken' WHERE id='TOL-9001'`);
  check('a retired serial frees the number', ins(row({ id: "'TOL-9003'", serial_no: "'SN-1'" })), 'ok');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0013_tools.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable and keeps the counter', [again, h.one("SELECT count(*) AS n FROM id_counters WHERE collection='tools'").n], ['ok', 1]);
  // 0021 builds on 0013 (it alters `tools`), so it is left out of the "without 0013" schema too.
  const before = MIGRATIONS.filter((f) => f !== '0013_tools.sql' && f !== '0021_equipment_inventory.sql');
  const plain = new DatabaseSync(':memory:');
  for (const f of before) plain.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const tables = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE '%tool%' AND sql IS NOT NULL ORDER BY name").all();
  check('0013 is additive: every other table and index is unchanged', JSON.stringify(tables(h.DB.raw)) === JSON.stringify(tables(plain)), true);
}

/* ---------- B. create ---------- */
{
  const h = fresh();
  const made = await h.api('POST', '/api/tools', TOOL({ brand: ' Launch ', model: 'X431', serialNo: 'LX-1', purchaseDate: '2026-03-14',
    purchasePrice: '85000.456', warrantyExpiry: '2027-03-14', location: 'Bay 2', description: 'Scanner', notes: 'n' }));
  check('create answers 201 with a TOL id', [made.status, made.body?.data?.id], [201, 'TOL-0001']);
  const d = made.body.data;
  check('fields are trimmed, price rounded to paisa, actor recorded', [d.brand, d.purchasePrice, d.createdBy, d.updatedBy, d.updatedAt === d.createdAt],
    ['Launch', 85000.46, 'API token', 'API token', true]);
  check('the second tool is TOL-0002', (await add(h, { name: 'Jack', category: 'Lifting Equipment' })).id, 'TOL-0002');
  const minimal = await h.api('POST', '/api/tools', { name: 'Rag', category: 'Cleaning Equipment', condition: 'Fair', status: 'Available' });
  check('optional fields stay empty', [minimal.status, minimal.body.data.serialNo, minimal.body.data.purchasePrice], [201, '', null]);

  const bad = await h.api('POST', '/api/tools', {});
  check('missing required fields are 422, named by field', [bad.status, Object.keys(bad.body.error.fields).sort()], [422, ['category', 'condition', 'name', 'status']]);
  const fields = async (extra) => (await h.api('POST', '/api/tools', TOOL(extra))).body?.error?.fields || {};
  ok_('a negative price is refused', 'purchasePrice' in await fields({ purchasePrice: -5 }));
  ok_('a non-number price is refused', 'purchasePrice' in await fields({ purchasePrice: 'abc' }));
  ok_('an impossible date is refused', 'purchaseDate' in await fields({ purchaseDate: '2026-02-31' }));
  ok_('a future purchase date is refused', 'purchaseDate' in await fields({ purchaseDate: '2999-01-01' }));
  ok_('a purchase before 1980 is refused', 'purchaseDate' in await fields({ purchaseDate: '1970-01-01' }));
  ok_('a warranty before purchase is refused', 'warrantyExpiry' in await fields({ purchaseDate: '2026-01-10', warrantyExpiry: '2025-12-31' }));
  ok_('an unknown category is refused', 'category' in await fields({ category: 'Toys' }));
  ok_('a damaged tool cannot be Available', 'status' in await fields({ condition: 'Damaged' }));
  ok_('a Poor tool cannot be In Use', 'status' in await fields({ condition: 'Poor', status: 'In Use' }));
  ok_('status Retired cannot be set on create', 'status' in await fields({ status: 'Retired' }));
  ok_('an unknown field is refused by name', 'colour' in await fields({ colour: 'red' }));
  ok_('a system field is refused', 'id' in await fields({ id: 'TOL-9999' }));
  ok_('an over-long name is refused', 'name' in await fields({ name: 'x'.repeat(121) }));
  check('a damaged tool Under Maintenance is fine', (await h.api('POST', '/api/tools', TOOL({ condition: 'Damaged', status: 'Under Maintenance' }))).status, 201);
  const notJson = await h.api('POST', '/api/tools', '{not json');
  check('a malformed body is 400', notJson.status, 400);

  const dup = await h.api('POST', '/api/tools', TOOL({ serialNo: 'lx-1' }));
  check('a duplicate serial (any case) is 409 naming the tool', [dup.status, dup.body.error.reason, dup.body.error.conflictsWith], [409, 'duplicate_serial', 'TOL-0001']);
  check('nothing was written for the refused tools', h.one('SELECT count(*) AS n FROM tools').n, 4);
}

/* ---------- C. list ---------- */
{
  const h = fresh();
  await add(h, { name: 'Torque Wrench', category: 'Workshop Hand Tools', brand: 'Bosch', purchasePrice: 3000, purchaseDate: '2025-05-01' });
  await add(h, { name: 'battery tester', category: 'Electrical Tools', model: 'BT-12', purchasePrice: 9000, purchaseDate: '2026-01-01', status: 'In Use' });
  await add(h, { name: 'Floor Jack', category: 'Lifting Equipment', serialNo: 'FJ-77', condition: 'Poor', status: 'Under Maintenance' });
  await add(h, { name: 'Old Drill', category: 'Engine Tools', condition: 'Damaged', status: 'Damaged' });
  const gone = await add(h, { name: 'Broken Gauge', category: 'Engine Tools' });
  await h.api('POST', `/api/tools/${gone.id}/retire`, { reason: 'Cracked', expectedUpdatedAt: gone.updatedAt });

  const all = await h.api('GET', '/api/tools');
  check('retired tools are left out by default', [all.status, all.body.total, all.body.data.some((t) => t.status === 'Retired')], [200, 4, false]);
  check('the summary counts the whole register', all.body.summary, { total: 4, available: 1, inUse: 1, underMaintenance: 1, damaged: 1, retired: 1 });
  check('includeRetired=1 shows them', (await h.api('GET', '/api/tools?includeRetired=1')).body.total, 5);
  check('status=Retired lists only retired', (await h.api('GET', '/api/tools?status=Retired')).body.data.map((t) => t.id), [gone.id]);
  const ids = async (qs) => (await h.api('GET', `/api/tools?${qs}`)).body.data.map((t) => t.name);
  check('search matches name ignoring case', await ids('q=BATTERY'), ['battery tester']);
  check('search matches brand, model, serial and id', [await ids('q=bosch'), await ids('q=bt-12'), await ids('q=fj-77'), await ids('q=tol-0001')],
    [['Torque Wrench'], ['battery tester'], ['Floor Jack'], ['Torque Wrench']]);
  check('LIKE wildcards in a search are literal', await ids('q=%25'), []);
  check('category filter', await ids('category=Lifting%20Equipment'), ['Floor Jack']);
  check('status filter', await ids('status=In%20Use'), ['battery tester']);
  check('condition filter', await ids('condition=Damaged'), ['Old Drill']);
  check('sort by name ascending ignores case', await ids('sort=name'), ['battery tester', 'Floor Jack', 'Old Drill', 'Torque Wrench']);
  check('sort by price descending, unpriced last', await ids('sort=purchasePrice&order=desc'), ['battery tester', 'Torque Wrench', 'Old Drill', 'Floor Jack']);
  check('sort by purchase date ascending', (await ids('sort=purchaseDate&order=asc')).slice(0, 2), ['Torque Wrench', 'battery tester']);
  const page = await h.api('GET', '/api/tools?sort=name&limit=2&offset=2');
  check('limit and offset page the list, total is the whole match', [page.body.data.map((t) => t.name), page.body.total, page.body.count], [['Old Drill', 'Torque Wrench'], 4, 2]);
  for (const [qs, label] of [['limit=0', 'limit 0'], ['limit=abc', 'limit text'], ['status=Lost', 'status'], ['sort=price;DROP', 'sort'],
    ['order=sideways', 'order'], ['category=Toys', 'category'], ['condition=New', 'condition'], [`q=${'x'.repeat(101)}`, 'long q']]) {
    check(`a bad ${label} is 400`, (await h.api('GET', `/api/tools?${qs}`)).status, 400);
  }
  ok_('no request text reaches ORDER BY', !h.DB.statements.some((s) => /DROP/.test(s)));
}

/* ---------- D. detail and update ---------- */
{
  const h = fresh();
  const t = await add(h, { serialNo: 'S-1', purchaseDate: '2026-01-10' });
  const other = await add(h, { name: 'Other', serialNo: 'S-2' });
  check('detail returns the tool', [(await h.api('GET', `/api/tools/${t.id}`)).body.data.serialNo], ['S-1']);
  check('an unknown id is 404', (await h.api('GET', '/api/tools/TOL-9999')).status, 404);
  check('a malformed id is 400', (await h.api('GET', '/api/tools/bad%20id')).status, 400);

  const up = await h.api('PUT', `/api/tools/${t.id}`, { location: 'Store room', notes: 'Calibrated', expectedUpdatedAt: t.updatedAt });
  check('an edit merges and keeps untouched fields', [up.status, up.body.data.location, up.body.data.serialNo, up.body.data.name], [200, 'Store room', 'S-1', 'OBD-II Scanner']);
  ok_('updatedAt moves forward', up.body.data.updatedAt > t.updatedAt);
  const stale = await h.api('PUT', `/api/tools/${t.id}`, { location: 'Bay 1', expectedUpdatedAt: t.updatedAt });
  check('an edit from an old copy is 409 and changes nothing', [stale.status, stale.body.error.reason, h.one('SELECT location FROM tools WHERE id=?', t.id).location],
    [409, 'concurrent_modification', 'Store room']);
  const cur = up.body.data.updatedAt;
  check('expectedUpdatedAt is required', Object.keys((await h.api('PUT', `/api/tools/${t.id}`, { location: 'x' })).body.error.fields), ['expectedUpdatedAt']);
  check('an empty edit is refused', (await h.api('PUT', `/api/tools/${t.id}`, { expectedUpdatedAt: cur })).status, 422);
  check('a blank name is refused', (await h.api('PUT', `/api/tools/${t.id}`, { name: ' ', expectedUpdatedAt: cur })).status, 422);
  check('cross-field rules check the merged record', Object.keys((await h.api('PUT', `/api/tools/${t.id}`, { condition: 'Damaged', expectedUpdatedAt: cur })).body.error.fields), ['status']);
  check('a warranty before the stored purchase date is refused', Object.keys((await h.api('PUT', `/api/tools/${t.id}`, { warrantyExpiry: '2025-01-01', expectedUpdatedAt: cur })).body.error.fields), ['warrantyExpiry']);
  const clash = await h.api('PUT', `/api/tools/${other.id}`, { serialNo: 's-1', expectedUpdatedAt: other.updatedAt });
  check('taking another tool\'s serial is 409', [clash.status, clash.body.error.conflictsWith], [409, t.id]);
  check('keeping its own serial is fine', (await h.api('PUT', `/api/tools/${t.id}`, { serialNo: 'S-1', name: 'Scanner Pro', expectedUpdatedAt: cur })).status, 200);
  check('PUT cannot retire', (await h.api('PUT', `/api/tools/${other.id}`, { status: 'Retired', expectedUpdatedAt: other.updatedAt })).status, 422);
  check('clearing an optional field stores NULL', [(await h.api('PUT', `/api/tools/${other.id}`, { serialNo: '', expectedUpdatedAt: other.updatedAt })).status,
    h.one('SELECT serial_no FROM tools WHERE id=?', other.id).serial_no], [200, null]);
  check('an edit of an unknown tool is 404', (await h.api('PUT', '/api/tools/TOL-9999', { name: 'x', expectedUpdatedAt: AT })).status, 404);
}

/* ---------- E. retire ---------- */
{
  const h = fresh();
  const owner = (await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie;
  await h.api('POST', '/api/accounts', { staffId: 'MEC-0001', username: 'jamal', role: 'Super Admin', password: PW }, owner);
  await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'nadia', role: 'Super Admin', password: PW }, owner);
  // Manager (0018): may add and edit tools, but not retire them (tools.manage).
  h.DB.raw.exec("UPDATE user_accounts SET role_id = 'ROL-0003' WHERE username = 'nadia'");
  const admin = (await h.api('POST', '/api/session', { username: 'jamal', password: PW }, 'none')).cookie;
  const viewer = (await h.api('POST', '/api/session', { username: 'nadia', password: PW }, 'none')).cookie;

  const t = await add(h, { serialNo: 'R-1' });
  const byViewer = await h.api('POST', `/api/tools/${t.id}/retire`, { reason: 'Old', expectedUpdatedAt: t.updatedAt }, viewer);
  check('an account whose role lacks Workshop Assets: retire (a Manager) cannot retire (403), nothing changes', [byViewer.status, h.one('SELECT status FROM tools WHERE id=?', t.id).status], [403, 'Available']);
  const created = await h.api('POST', '/api/tools', TOOL({ name: 'By Nadia' }), viewer);
  check('   ...but its role may still register and edit tools', [created.status, created.body.data.createdBy], [201, 'nadia']);
  check('a reason is required', Object.keys((await h.api('POST', `/api/tools/${t.id}/retire`, { reason: ' ', expectedUpdatedAt: t.updatedAt }, admin)).body.error.fields), ['reason']);
  check('a stale retire is 409', (await h.api('POST', `/api/tools/${t.id}/retire`, { reason: 'Old', expectedUpdatedAt: AT }, admin)).status, 409);
  const done = await h.api('POST', `/api/tools/${t.id}/retire`, { reason: 'Worn out', expectedUpdatedAt: t.updatedAt }, admin);
  check('a Super Admin account retires it', [done.status, done.body.data.status, done.body.data.retiredReason, done.body.data.updatedBy, Boolean(done.body.data.retiredAt)],
    [200, 'Retired', 'Worn out', 'jamal', true]);
  check('retiring twice is 409', (await h.api('POST', `/api/tools/${t.id}/retire`, { reason: 'x', expectedUpdatedAt: done.body.data.updatedAt }, admin)).body.error.reason, 'already_retired');
  check('a retired tool cannot be edited', (await h.api('PUT', `/api/tools/${t.id}`, { name: 'x', expectedUpdatedAt: done.body.data.updatedAt })).body.error.reason, 'tool_retired');
  check('its serial can be registered again', (await h.api('POST', '/api/tools', TOOL({ serialNo: 'R-1' }))).status, 201);
  const t2 = await add(h, { name: 'Second' });
  check('the passphrase holder may retire', (await h.api('POST', `/api/tools/${t2.id}/retire`, { reason: 'Lost', expectedUpdatedAt: t2.updatedAt }, owner)).status, 200);
  check('a retire of an unknown tool is 404', (await h.api('POST', '/api/tools/TOL-9999/retire', { reason: 'x', expectedUpdatedAt: AT })).status, 404);
  check('retire is POST only', (await h.api('GET', `/api/tools/${t.id}/retire`)).status, 405);
  check('the tool row survives retirement', h.one('SELECT count(*) AS n FROM tools WHERE id=?', t.id).n, 1);
}

/* ---------- F. security and compatibility ---------- */
{
  const h = fresh();
  const t = await add(h);
  h.DB.statements.length = 0;
  const denied = [];
  for (const [m, p, b] of [['GET', '/api/tools'], ['GET', `/api/tools/${t.id}`], ['POST', '/api/tools', TOOL()],
    ['PUT', `/api/tools/${t.id}`, { name: 'x' }], ['POST', `/api/tools/${t.id}/retire`, { reason: 'x' }]]) {
    denied.push((await h.api(m, p, b, 'none')).status);
  }
  check('every tools route is 401 without a credential', denied, [401, 401, 401, 401, 401]);
  check('no statement ran for a refused caller', h.DB.statements.length, 0);
  check('a forged cookie is 401', (await h.api('GET', '/api/tools', undefined, 'taqwa_session=v1.9999999999.forged')).status, 401);
  // 0021: DELETE exists (tools.delete; the token has full access). Covered in depth by api-equipment.
  const del = await h.api('DELETE', `/api/tools/${t.id}`);
  check('DELETE (0021) removes the tool and keeps its history', [del.status, h.one('SELECT count(*) AS n FROM tools').n,
    h.one("SELECT count(*) AS n FROM tool_events WHERE tool_id = ? AND action = 'delete'", t.id).n], [200, 0, 1]);
  const route = await h.api('GET', '/api/nope');
  check('the route list advertises the seven tools routes', (route.body?.error?.available || []).filter((r) => r.includes('/api/tools')),
    ['GET /api/tools', 'POST /api/tools', 'GET /api/tools/:id', 'PUT /api/tools/:id', 'DELETE /api/tools/:id', 'POST /api/tools/:id/retire', 'POST /api/tools/:id/reactivate']);
  const broken = { ...h.env, DB: { prepare() { throw new Error('D1_ERROR: secret table detail'); } } };
  const res = await worker.fetch(new Request('http://worker.local/api/tools', { headers: { authorization: `Bearer ${TOKEN}` } }), broken);
  const text = await res.text();
  check('a database failure is a plain 500 that reveals nothing', [res.status, /secret table detail|D1_ERROR/.test(text)], [500, false]);
  check('other collections still answer', [(await h.api('GET', '/api/mechanics')).status, (await h.api('GET', '/api/parts')).status, (await h.api('GET', '/api/customers')).status], [200, 200, 200]);
}

console.log(`\nTools API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
