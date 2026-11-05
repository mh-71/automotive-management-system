/* Asset Assignment (0025) — unit tests against the REAL Worker:
   /api/tool-assignments and its effect on the equipment register (tools).

   The handlers run against an in-memory SQLite database built from every
   real migration. All names and numbers are fictional test values.

   What must hold:
     A. Schema: two new tables, CHECKs, the one-Active-per-item index, the
        ASG counter; additive (every other table and index unchanged); re-runnable.
     B. Assign: only Available equipment (not In Use, Under Maintenance,
        Damaged, Retired, nor with maintenance in progress); only an ACTIVE
        employee or mechanic; every field validated; the item goes In Use
        with the person in the same batch; tool_events + history written.
     C. List: Overdue worked out from the date; summary from real data;
        search, status, assignee, equipment, date filters; paging.
     D. Edit / hand over: only Active; stale 409 with no history.
     E. Return: date rules, condition -> equipment status; received by.
     F. Cancel: reason required; equipment back to Available.
     G. Consistency with Equipment Inventory and Maintenance (reconcile).
     H. Atomicity: a race on the equipment rolls everything back.
     I. Auth and permissions.
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
  console.log(`\nAsset Assignment API unit: ${pass} passed, ${fail} failed`);
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
const AT = '2026-01-01T00:00:00.000Z';

function seed(h) {
  h.DB.raw.exec(`
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Store', 'Workshop', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0002', 'Gone Person', '01911000002', 'Inactive', 'Store', 'Workshop', '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'Lifts', '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, status, created_at) VALUES ('MEC-0002', 'Left Mechanic', '01800000002', 'Engines', 'Inactive', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0001', 'Two Post Car Lift', 'Lifting Equipment', 'Good', 'Available', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0002', 'Air Compressor', 'Other', 'Fair', 'Available', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0003', 'Old Press', 'Other', 'Poor', 'Under Maintenance', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, retired_at, retired_reason, created_at, updated_at) VALUES ('TOL-0004', 'Scrapped Jack', 'Lifting Equipment', 'Poor', 'Retired', '${AT}', 'Broken', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0005', 'Cracked Stand', 'Other', 'Damaged', 'Damaged', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0006', 'Torque Wrench', 'Workshop Hand Tools', 'Excellent', 'Available', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0007', 'Scan Tool', 'Diagnostic Equipment', 'Good', 'Available', '${AT}', '${AT}');
  `);
}

/* ---------- A. schema ---------- */
{
  const h = fresh();
  check('tool_assignments has the planned columns', h.all('PRAGMA table_info(tool_assignments)').map((c) => c.name),
    ['id', 'tool_id', 'tool_name', 'assignee_type', 'assignee_id', 'assignee_name', 'status', 'source', 'assigned_date', 'expected_return_date',
      'purpose', 'work_location', 'condition_before', 'notes', 'return_date', 'condition_after', 'damage_notes', 'return_notes',
      'received_by_id', 'received_by_name', 'cancel_reason', 'created_by', 'updated_by', 'created_at', 'updated_at', 'returned_at', 'cancelled_at']);
  check('tool_assignment_events columns', h.all('PRAGMA table_info(tool_assignment_events)').map((c) => c.name),
    ['id', 'assignment_id', 'tool_id', 'occurred_at', 'actor', 'action', 'summary']);
  check('an ASG counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='toolAssignments'"), { prefix: 'ASG', last_value: 0 });
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  const base = (id, tool = 'TOL-1', extra = '', vals = '') => `INSERT INTO tool_assignments (id, tool_id, tool_name, assignee_type, assignee_id, assignee_name, assigned_date, created_at, updated_at${extra}) VALUES ('${id}', '${tool}', 'Lift', 'staff', 'STF-0001', 'Nadia', '2026-06-01', 'x', 'x'${vals})`;
  check('a valid row is accepted', ins(base('ASG-9')), 'ok');
  check('a second Active assignment for the same item is refused by the database', ins(base('ASG-10')), 'UNIQUE');
  check('...but a Returned one is fine', ins(base('ASG-11', 'TOL-1', ', status, return_date', ", 'Returned', '2026-06-02'")), 'ok');
  check('Returned without a return date is refused', ins(base('ASG-12', 'TOL-2', ', status', ", 'Returned'")), 'CHECK');
  check('Cancelled without a reason is refused', ins(base('ASG-13', 'TOL-3', ', status', ", 'Cancelled'")), 'CHECK');
  check('an expected return before the assignment is refused', ins(base('ASG-14', 'TOL-4', ', expected_return_date', ", '2026-05-01'")), 'CHECK');
  check('a return before the assignment is refused', ins(base('ASG-15', 'TOL-5', ', status, return_date', ", 'Returned', '2026-05-01'")), 'CHECK');
  check('a receiver id without a name is refused', ins(base('ASG-16', 'TOL-6', ', received_by_id', ", 'STF-0001'")), 'CHECK');
  check('an unknown assignee type is refused', ins(base('ASG-17', 'TOL-7').replace("'staff'", "'customer'")), 'CHECK');
  check('an id that is not ASG- is refused', ins(base('JOB-1', 'TOL-8')), 'CHECK');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0025_tool_assignments.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable', again, 'ok');
  const before = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS.filter((f) => f.slice(0, 4) !== '0025')) before.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%tool_assignment%' ORDER BY name").all());
  check('0025 is additive: every other table and index is unchanged (tools, tool_maintenance included)', shape(h.DB.raw) === shape(before), true);
  check('...and it adds no permission', h.one("SELECT count(*) AS n FROM role_permissions WHERE permission LIKE '%assign%'").n, 0);
}

const h = fresh();
seed(h);
const api = h.api;
const get = async (id) => (await api('GET', `/api/tool-assignments/${id}`)).body.data;
const tool = (id) => h.one('SELECT status, condition, assigned_staff_id AS s, assigned_mechanic_id AS m FROM tools WHERE id = ?', id);
const toolEvents = (id) => h.all('SELECT action FROM tool_events WHERE tool_id = ? ORDER BY id', id).map((e) => e.action);
const history = (id) => h.all('SELECT action FROM tool_assignment_events WHERE assignment_id = ? ORDER BY id', id).map((e) => e.action);
const fields = async (b) => (await api('POST', '/api/tool-assignments', b)).body?.error?.fields || {};
const ASSIGN = (extra = {}) => ({ toolId: 'TOL-0001', assigneeId: 'MEC-0001', assignedDate: dayPlus(-3), expectedReturnDate: dayPlus(4),
  purpose: 'Brake job lift', workLocation: 'Bay 2', notes: 'Handle with care', ...extra });

/* ---------- B. assign ---------- */
{
  check('without a credential the list is 401', (await api('GET', '/api/tool-assignments', undefined, 'none')).status, 401);
  const r = await api('POST', '/api/tool-assignments', ASSIGN());
  check('a valid assignment is 201 and Active', [r.status, r.body.data.id, r.body.data.status, r.body.data.state, r.body.data.assigneeName, r.body.data.assigneeType, r.body.data.conditionBefore, r.body.data.source],
    [201, 'ASG-0001', 'Active', 'Active', 'Jamal Uddin', 'mechanic', 'Good', 'Assignment']);
  check('   ...the equipment is now In Use with that mechanic', tool('TOL-0001'), { status: 'In Use', condition: 'Good', s: null, m: 'MEC-0001' });
  check('   ...an assign entry in the equipment history and a create entry in its own', [toolEvents('TOL-0001'), history('ASG-0001')], [['assign'], ['create']]);
  check('   ...detail carries the history and the equipment now', [r.body.data.history.length, r.body.data.tool.status, r.body.data.tool.holder], [1, 'In Use', 'Jamal Uddin']);

  const dup = await api('POST', '/api/tool-assignments', ASSIGN({ assigneeId: 'STF-0001' }));
  check('the same item cannot be assigned twice (409, already In Use)', [dup.status, dup.body.error.reason], [409, 'tool_not_available']);
  for (const [id, label] of [['TOL-0003', 'Under Maintenance'], ['TOL-0004', 'Retired'], ['TOL-0005', 'Damaged']]) {
    const x = await api('POST', '/api/tool-assignments', ASSIGN({ toolId: id }));
    check(`${label} equipment cannot be assigned`, [x.status, x.body.error.reason, x.body.error.status], [409, 'tool_not_available', label]);
  }
  check('missing equipment is 422', (await fields(ASSIGN({ toolId: 'TOL-0999' }))).toolId, 'No equipment with that id.');
  check('an inactive employee is refused', (await fields(ASSIGN({ toolId: 'TOL-0002', assigneeId: 'STF-0002' }))).assigneeId, 'That is not an active member of staff or mechanic.');
  check('an inactive mechanic is refused', (await fields(ASSIGN({ toolId: 'TOL-0002', assigneeId: 'MEC-0002' }))).assigneeId, 'That is not an active member of staff or mechanic.');
  check('an unknown person is refused', (await fields(ASSIGN({ toolId: 'TOL-0002', assigneeId: 'STF-0999' }))).assigneeId, 'That is not an active member of staff or mechanic.');
  check('the required fields', Object.keys(await fields({})).sort(), ['assigneeId', 'toolId']);
  check('a future assignment date, an expected return before it, bad text lengths, an unknown field',
    Object.keys(await fields({ toolId: 'TOL-0002', assigneeId: 'STF-0001', assignedDate: dayPlus(1), purpose: 'x'.repeat(201), workLocation: 'x'.repeat(81), notes: 'x'.repeat(1001), colour: 'red' })).sort(),
    ['assignedDate', 'colour', 'notes', 'purpose', 'workLocation']);
  check('an expected return before the assignment date', (await fields(ASSIGN({ toolId: 'TOL-0002', assignedDate: dayPlus(0), expectedReturnDate: dayPlus(-1) }))).expectedReturnDate,
    'The expected return cannot be before the assignment date.');
  check('an impossible date', (await fields(ASSIGN({ toolId: 'TOL-0002', assignedDate: '2026-02-31' }))).assignedDate, 'Choose a valid assignment date.');
  check('handing out in Poor condition is refused', Object.keys(await fields(ASSIGN({ toolId: 'TOL-0002', conditionBefore: 'Poor' }))), ['conditionBefore']);
  check('refused requests saved nothing', [h.one('SELECT count(*) AS n FROM tool_assignments').n, tool('TOL-0002').status], [1, 'Available']);

  // Maintenance in progress without taking the item out of service still blocks assigning.
  h.DB.raw.exec(`INSERT INTO tool_maintenance (id, tool_id, tool_name, maintenance_type, scheduled_date, status, started_at, created_at, updated_at) VALUES ('MNT-0050', 'TOL-0007', 'Scan Tool', 'Inspection', '${dayPlus(0)}', 'In Progress', '${AT}', '${AT}', '${AT}')`);
  const mx = await api('POST', '/api/tool-assignments', ASSIGN({ toolId: 'TOL-0007' }));
  check('equipment with maintenance in progress cannot be assigned', [mx.status, mx.body.error.reason], [409, 'maintenance_in_progress']);

  const s = await api('POST', '/api/tool-assignments', { toolId: 'TOL-0002', assigneeId: 'STF-0001' });
  check('the essentials only: today, no expected return, condition from the register', [s.status, s.body.data.assignedDate, s.body.data.expectedReturnDate, s.body.data.conditionBefore, tool('TOL-0002').s],
    [201, dayPlus(0), '', 'Fair', 'STF-0001']);
  await api('POST', '/api/tool-assignments', ASSIGN({ toolId: 'TOL-0006', assigneeId: 'STF-0001', assignedDate: dayPlus(-10), expectedReturnDate: dayPlus(-2), purpose: 'Engine rebuild' }));
}

/* ---------- C. list ---------- */
{
  const L = async (qs = '') => (await api('GET', `/api/tool-assignments${qs ? '?' + qs : ''}`)).body;
  const all = await L();
  check('the list: Active ones first, overdue first', all.data.map((a) => [a.id, a.state]), [['ASG-0003', 'Overdue'], ['ASG-0001', 'Active'], ['ASG-0002', 'Active']]);
  check('summary from real data', all.summary, { total: 3, active: 3, overdue: 1, returned: 0, cancelled: 0, available: 0, assignedNow: 3, inService: 6 });
  check('status Overdue', (await L('status=Overdue')).data.map((a) => a.id), ['ASG-0003']);
  check('status Active (overdue ones are still Active)', (await L('status=Active')).total, 3);
  check('by person', (await L('assigneeId=STF-0001')).data.map((a) => a.id), ['ASG-0003', 'ASG-0002']);
  check('by equipment', (await L('toolId=TOL-0001')).data.map((a) => a.id), ['ASG-0001']);
  check('search: name, purpose, location, id', [(await L('q=compressor')).total, (await L('q=ENGINE')).total, (await L('q=bay%202')).total, (await L('q=asg-0002')).total, (await L('q=%25')).total], [1, 1, 2, 1, 0]);
  check('assigned-date range', (await L(`from=${dayPlus(-4)}&to=${dayPlus(0)}`)).data.map((a) => a.id).sort(), ['ASG-0001', 'ASG-0002']);
  check('paging', [(await L('limit=2')).data.length, (await L('limit=2&offset=2')).data.map((a) => a.id), (await L('limit=2')).total], [2, ['ASG-0002'], 3]);
  check('bad filters are 400', [(await api('GET', '/api/tool-assignments?status=Lost')).status, (await api('GET', '/api/tool-assignments?assigneeId=bob')).status,
    (await api('GET', '/api/tool-assignments?from=2026-13-01')).status, (await api('GET', `/api/tool-assignments?from=${dayPlus(0)}&to=${dayPlus(-1)}`)).status], [400, 400, 400, 400]);
  check('a bad or missing id', [(await api('GET', '/api/tool-assignments/TOL-0001')).status, (await api('GET', '/api/tool-assignments/ASG-0999')).status], [400, 404]);
  check('there is no delete', (await api('DELETE', '/api/tool-assignments/ASG-0001')).status, 405);
}

/* ---------- D. edit / hand over ---------- */
{
  const a = await get('ASG-0001');
  let r = await api('PUT', '/api/tool-assignments/ASG-0001', { expectedReturnDate: dayPlus(6), workLocation: 'Bay 3', expectedUpdatedAt: a.updatedAt });
  check('an edit saves only what changed, with an update entry', [r.status, r.body.data.expectedReturnDate, r.body.data.workLocation, r.body.data.purpose, history('ASG-0001')],
    [200, dayPlus(6), 'Bay 3', 'Brake job lift', ['create', 'update']]);
  check('an edit from an old copy is 409 and writes no history', [(await api('PUT', '/api/tool-assignments/ASG-0001', { notes: 'x', expectedUpdatedAt: a.updatedAt })).status, history('ASG-0001').length], [409, 2]);
  check('expectedUpdatedAt is required', Object.keys((await api('PUT', '/api/tool-assignments/ASG-0001', { notes: 'x' })).body.error.fields), ['expectedUpdatedAt']);
  check('the equipment and assignment date cannot be changed', Object.keys((await api('PUT', '/api/tool-assignments/ASG-0001', { toolId: 'TOL-0002', assignedDate: dayPlus(0), expectedUpdatedAt: r.body.data.updatedAt })).body.error.fields).sort(), ['assignedDate', 'toolId']);
  check('expected return before the assignment date', (await api('PUT', '/api/tool-assignments/ASG-0001', { expectedReturnDate: dayPlus(-30), expectedUpdatedAt: r.body.data.updatedAt })).body.error.fields.expectedReturnDate,
    'The expected return cannot be before the assignment date.');
  check('handing over to an inactive person is refused', (await api('PUT', '/api/tool-assignments/ASG-0001', { assigneeId: 'STF-0002', expectedUpdatedAt: r.body.data.updatedAt })).body.error.fields.assigneeId,
    'That is not an active member of staff or mechanic.');
  r = await api('PUT', '/api/tool-assignments/ASG-0001', { assigneeId: 'STF-0001', expectedUpdatedAt: r.body.data.updatedAt });
  check('handing over moves the equipment to the new person in the same change', [r.status, r.body.data.assigneeId, r.body.data.assigneeType, tool('TOL-0001'), toolEvents('TOL-0001')],
    [200, 'STF-0001', 'staff', { status: 'In Use', condition: 'Good', s: 'STF-0001', m: null }, ['assign', 'assign']]);
  check('nothing changed: 200 and no new history', [(await api('PUT', '/api/tool-assignments/ASG-0001', { workLocation: 'Bay 3', expectedUpdatedAt: r.body.data.updatedAt })).status, history('ASG-0001').length], [200, 3]);
}

/* ---------- E. return ---------- */
{
  const ret = (id, b) => api('POST', `/api/tool-assignments/${id}/return`, b);
  const a = await get('ASG-0001');
  const f = async (b) => (await ret('ASG-0001', { expectedUpdatedAt: a.updatedAt, ...b })).body.error.fields;
  check('return date and condition are required', Object.keys(await f({})).sort(), ['conditionAfter', 'returnDate']);
  check('a future return date', (await f({ returnDate: dayPlus(1), conditionAfter: 'Good' })).returnDate, 'The return date cannot be in the future.');
  check('a return before the assignment date', (await f({ returnDate: dayPlus(-20), conditionAfter: 'Good' })).returnDate, 'The return date cannot be before the assignment date.');
  check('Damaged equipment cannot go back as Available', Object.keys(await f({ returnDate: dayPlus(0), conditionAfter: 'Damaged', statusAfter: 'Available' })), ['statusAfter']);
  check('an inactive receiver is refused', (await f({ returnDate: dayPlus(0), conditionAfter: 'Good', receivedById: 'STF-0002' })).receivedById, 'That is not an active member of staff or mechanic.');
  const r = await ret('ASG-0001', { returnDate: dayPlus(0), conditionAfter: 'Fair', returnNotes: 'Fine', receivedById: 'STF-0001', expectedUpdatedAt: a.updatedAt });
  check('a good return: Returned, the equipment Available, unassigned, condition updated', [r.status, r.body.data.status, r.body.data.receivedByName, tool('TOL-0001')],
    [200, 'Returned', 'Nadia Akter', { status: 'Available', condition: 'Fair', s: null, m: null }]);
  check('   ...a return in both histories', [toolEvents('TOL-0001').at(-1), history('ASG-0001').at(-1)], ['return', 'return']);
  check('a returned assignment cannot be returned again, edited or cancelled', [(await ret('ASG-0001', { returnDate: dayPlus(0), conditionAfter: 'Good', expectedUpdatedAt: r.body.data.updatedAt })).status,
    (await api('PUT', '/api/tool-assignments/ASG-0001', { notes: 'x', expectedUpdatedAt: r.body.data.updatedAt })).status,
    (await api('POST', '/api/tool-assignments/ASG-0001/cancel', { reason: 'x', expectedUpdatedAt: r.body.data.updatedAt })).status], [409, 409, 409]);

  const b = await get('ASG-0003');
  const d = await ret('ASG-0003', { returnDate: dayPlus(0), conditionAfter: 'Damaged', damageNotes: 'Ratchet head cracked', expectedUpdatedAt: b.updatedAt });
  check('damaged on return: the equipment is Damaged, notes kept', [d.status, tool('TOL-0006').status, tool('TOL-0006').condition, d.body.data.damageNotes], [200, 'Damaged', 'Damaged', 'Ratchet head cracked']);
  const again = await api('POST', '/api/tool-assignments', ASSIGN({ toolId: 'TOL-0006' }));
  check('   ...and it can no longer be assigned', again.status, 409);
  const re = await api('POST', '/api/tool-assignments', ASSIGN({ toolId: 'TOL-0001', assigneeId: 'MEC-0001' }));
  check('returned equipment can be assigned again (a new record, the old one kept)', [re.status, re.body.data.id, h.one("SELECT count(*) AS n FROM tool_assignments WHERE tool_id='TOL-0001'").n], [201, 'ASG-0004', 2]);
  const p = await ret('ASG-0004', { returnDate: dayPlus(0), conditionAfter: 'Poor', expectedUpdatedAt: re.body.data.updatedAt });
  check('Poor on return: Under Maintenance by default', [p.status, tool('TOL-0001').status], [200, 'Under Maintenance']);
}

/* ---------- F. cancel ---------- */
{
  const a = await get('ASG-0002');
  check('cancelling needs a reason', (await api('POST', '/api/tool-assignments/ASG-0002/cancel', { expectedUpdatedAt: a.updatedAt })).body.error.fields.reason, 'Please give a reason for cancelling.');
  const r = await api('POST', '/api/tool-assignments/ASG-0002/cancel', { reason: 'Wrong item picked', expectedUpdatedAt: a.updatedAt });
  check('cancel: Cancelled, reason kept, the equipment back to Available', [r.status, r.body.data.status, r.body.data.cancelReason, tool('TOL-0002')],
    [200, 'Cancelled', 'Wrong item picked', { status: 'Available', condition: 'Fair', s: null, m: null }]);
  check('   ...history: create then cancel; nothing deleted', history('ASG-0002'), ['create', 'cancel']);
}

/* ---------- G. Equipment Inventory and Maintenance ---------- */
{
  // Assigned in Equipment Inventory (PUT /api/tools) -> recorded here.
  const t = (await api('GET', '/api/tools/TOL-0002')).body.data;
  const r = await api('PUT', '/api/tools/TOL-0002', { status: 'In Use', assignedMechanicId: 'MEC-0001', expectedUpdatedAt: t.updatedAt });
  check('Equipment Inventory still assigns as before', [r.status, tool('TOL-0002').m], [200, 'MEC-0001']);
  const L = (await api('GET', '/api/tool-assignments?toolId=TOL-0002')).body;
  const rec = L.data.find((a) => a.status === 'Active');
  check('   ...the assignment is recorded here, marked as from Equipment Inventory', [rec && rec.source, rec && rec.assigneeId, rec && rec.assigneeName, history(rec && rec.id)],
    ['Equipment Inventory', 'MEC-0001', 'Jamal Uddin', ['sync']]);
  check('   ...listing again records nothing twice', [(await api('GET', '/api/tool-assignments')).status, h.one("SELECT count(*) AS n FROM tool_assignments WHERE tool_id='TOL-0002' AND status='Active'").n], [200, 1]);

  // Taken for maintenance -> the assignment here is closed.
  const job = (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Repair', scheduledDate: dayPlus(0) })).body.data;
  const st = await api('POST', `/api/tool-maintenance/${job.id}/status`, { to: 'In Progress', expectedUpdatedAt: job.updatedAt });
  check('Maintenance still starts as before (the equipment Under Maintenance, unassigned)', [st.status, tool('TOL-0002')], [200, { status: 'Under Maintenance', condition: 'Fair', s: null, m: null }]);
  const closed = await get(rec.id);
  check('   ...and the assignment here is closed, saying why', [closed.status, closed.returnNotes, closed.history[0].action],
    ['Returned', 'Ended outside Asset Assignment: the equipment was taken for maintenance.', 'sync']);
  check('   ...Under Maintenance is never counted as Available', (await api('GET', '/api/tool-assignments')).body.summary.available, 0);
  const no = await api('POST', '/api/tool-assignments', ASSIGN({ toolId: 'TOL-0002' }));
  check('   ...nor can it be assigned', [no.status, no.body.error.status], [409, 'Under Maintenance']);

  // Returned in Equipment Inventory -> closed here.
  const x = (await api('POST', '/api/tool-assignments', { toolId: 'TOL-0007', assigneeId: 'STF-0001' }));
  check('(maintenance in progress still blocks TOL-0007)', x.status, 409);
  h.DB.raw.exec("UPDATE tool_maintenance SET status = 'Cancelled', cancel_reason = 'n/a', cancelled_at = 'x' WHERE id = 'MNT-0050'");
  const y = (await api('POST', '/api/tool-assignments', { toolId: 'TOL-0007', assigneeId: 'STF-0001' })).body.data;
  const tt = (await api('GET', '/api/tools/TOL-0007')).body.data;
  const back = await api('PUT', '/api/tools/TOL-0007', { status: 'Available', expectedUpdatedAt: tt.updatedAt });
  check('returning in Equipment Inventory still works', [back.status, tool('TOL-0007').s], [200, null]);
  const yc = await get(y.id);
  check('   ...and closes the assignment here', [yc.status, yc.returnDate, yc.returnNotes], ['Returned', dayPlus(0), 'Ended outside Asset Assignment: it was marked Available in Equipment Inventory.']);
}

/* ---------- H. atomicity ---------- */
{
  const a = (await api('POST', '/api/tool-assignments', { toolId: 'TOL-0007', assigneeId: 'MEC-0001' })).body.data;
  // The equipment is edited (not its holder) between our read and write: the tripwire must roll everything back.
  const realBatch = h.DB.batch.bind(h.DB);
  let once = true;
  h.DB.batch = async (list) => {
    if (once) { once = false; h.DB.raw.exec("UPDATE tools SET notes = 'touched', updated_at = '2030-01-01T00:00:00.000Z' WHERE id = 'TOL-0007'"); }
    return realBatch(list);
  };
  const r = await api('POST', `/api/tool-assignments/${a.id}/return`, { returnDate: dayPlus(0), conditionAfter: 'Good', expectedUpdatedAt: a.updatedAt });
  h.DB.batch = realBatch;
  check('if the equipment changed meanwhile: 409 and NOTHING saved', [r.status, (await get(a.id)).status, tool('TOL-0007').status, tool('TOL-0007').m, history(a.id)],
    [409, 'Active', 'In Use', 'MEC-0001', ['create']]);
  const ok2 = await api('POST', `/api/tool-assignments/${a.id}/cancel`, { reason: 'Test of atomicity done', expectedUpdatedAt: a.updatedAt });
  check('   ...after reloading the same change goes through', [ok2.status, tool('TOL-0007').status], [200, 'Available']);
}

/* ---------- I. permissions ---------- */
{
  const { collectionPermission } = await import('../../src/lib/permissions.js');
  check('each request needs a Workshop Assets permission', ['view', 'create', 'update', 'return', 'cancel'].map((op) => collectionPermission('tool-assignments', op)),
    ['tools.view', 'tools.edit', 'tools.edit', 'tools.edit', 'tools.edit']);
  check('there is no remove permission (no delete)', collectionPermission('tool-assignments', 'remove'), 'full');
}

console.log(`\nAsset Assignment API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
