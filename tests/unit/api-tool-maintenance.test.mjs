/* Maintenance & Repairs (0024) — unit tests against the REAL Worker:
   /api/tool-maintenance and its effect on the equipment register (tools).

   The handlers run against an in-memory SQLite database built from every
   real migration. All names and numbers are fictional test values.

   What must hold:
     A. Schema: two new tables, CHECKs, indexes, the MNT counter; additive
        (every other table and index unchanged); re-runnable.
     B. Schedule: a valid job is stored as Scheduled with a history row; every
        field validated; retired or missing equipment and inactive people
        refused; unknown fields refused.
     C. List: Overdue / Due Soon worked out from the date; summary and panels;
        search, status (incl. Due Soon / Overdue), type, equipment and date
        filters; paging.
     D. Edit: only open jobs; stale edits 409 with no history; the equipment
        cannot change once work has started.
     E. Status: Scheduled -> In Progress -> Completed / Cancelled only; the
        equipment goes Under Maintenance (assignment ended) when work starts,
        gets its service dates and goes back to Available when completed --
        unless another job is still running or its condition does not allow
        it; every equipment change lands in tool_events; a change that races
        another edit of the equipment rolls back entirely.
     F. Delete: only Scheduled / Cancelled; history kept; no other table touched.
     G. Auth: 401 without a credential; the permissions are the Workshop
        Assets ones.
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
  console.log(`\nMaintenance & Repairs API unit: ${pass} passed, ${fail} failed`);
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
    INSERT INTO tools (id, name, category, condition, status, assigned_mechanic_id, created_at, updated_at) VALUES ('TOL-0001', 'Two Post Car Lift', 'Lifting Equipment', 'Good', 'In Use', 'MEC-0001', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0002', 'Air Compressor', 'Other', 'Fair', 'Available', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, created_at, updated_at) VALUES ('TOL-0003', 'Old Press', 'Other', 'Poor', 'Under Maintenance', '${AT}', '${AT}');
    INSERT INTO tools (id, name, category, condition, status, retired_at, retired_reason, created_at, updated_at) VALUES ('TOL-0004', 'Scrapped Jack', 'Lifting Equipment', 'Poor', 'Retired', '${AT}', 'Broken', '${AT}', '${AT}');
  `);
}
const JOB = (extra = {}) => ({ toolId: 'TOL-0001', maintenanceType: 'Preventive Service', priority: 'High', scheduledDate: dayPlus(5),
  technicianId: 'MEC-0001', vendor: 'Lift Service Co', estimatedCost: 6500, description: 'Check cables and arm locks.', ...extra });

/* ---------- A. schema ---------- */
{
  const h = fresh();
  check('tool_maintenance has the planned columns', h.all('PRAGMA table_info(tool_maintenance)').map((c) => c.name),
    ['id', 'tool_id', 'tool_name', 'maintenance_type', 'priority', 'status', 'scheduled_date', 'technician_id', 'technician_name', 'vendor',
      'estimated_cost', 'actual_cost', 'description', 'work_done', 'started_at', 'completed_date', 'next_service_due', 'cancel_reason',
      'created_by', 'updated_by', 'created_at', 'updated_at', 'completed_at', 'cancelled_at']);
  check('tool_maintenance_events columns', h.all('PRAGMA table_info(tool_maintenance_events)').map((c) => c.name),
    ['id', 'maintenance_id', 'tool_id', 'occurred_at', 'actor', 'action', 'summary']);
  check('an MNT counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='toolMaintenance'"), { prefix: 'MNT', last_value: 0 });
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  const base = (id, extra = '', vals = '') => `INSERT INTO tool_maintenance (id, tool_id, tool_name, maintenance_type, scheduled_date, created_at, updated_at${extra}) VALUES ('${id}', 'TOL-1', 'Lift', 'Repair', '2026-12-01', 'x', 'x'${vals})`;
  check('a valid row is accepted', ins(base('MNT-9')), 'ok');
  check('an unknown type is refused', ins(base('MNT-10').replace("'Repair'", "'Painting'")), 'CHECK');
  check('Completed without a completion date is refused', ins(base('MNT-11', ', status', ", 'Completed'")), 'CHECK');
  check('Cancelled without a reason is refused', ins(base('MNT-12', ', status', ", 'Cancelled'")), 'CHECK');
  check('a technician id without a name is refused', ins(base('MNT-13', ', technician_id', ", 'STF-0001'")), 'CHECK');
  check('a negative cost is refused', ins(base('MNT-14', ', estimated_cost', ', -5')), 'CHECK');
  check('an id that is not MNT- is refused', ins(base('JOB-1')), 'CHECK');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0024_tool_maintenance.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable', again, 'ok');
  const before = new DatabaseSync(':memory:');
  // Every migration except 0024 itself, so a later one is on both sides.
  for (const f of MIGRATIONS.filter((f) => f.slice(0, 4) !== '0024')) before.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%tool_maintenance%' ORDER BY name").all());
  check('0024 is additive: every other table and index is unchanged (tools included)', shape(h.DB.raw) === shape(before), true);
  check('...and it adds no permission', h.one("SELECT count(*) AS n FROM role_permissions WHERE permission LIKE '%maint%'").n, 0);
}

/* ---------- B. schedule ---------- */
const h = fresh();
seed(h);
const api = h.api;
const get = async (id) => (await api('GET', `/api/tool-maintenance/${id}`)).body.data;
const status = (id, body) => api('POST', `/api/tool-maintenance/${id}/status`, body);
const tool = (id) => h.one('SELECT status, condition, assigned_staff_id, assigned_mechanic_id, last_service_date, next_service_due, updated_at FROM tools WHERE id = ?', id);
{
  check('without a credential the list is 401', (await api('GET', '/api/tool-maintenance', undefined, 'none')).status, 401);
  const r = await api('POST', '/api/tool-maintenance', JOB());
  check('a valid job is scheduled as MNT-0001', [r.status, r.body.data.id, r.body.data.status, r.body.data.toolName, r.body.data.technicianName, r.body.data.dueState],
    [201, 'MNT-0001', 'Scheduled', 'Two Post Car Lift', 'Jamal Uddin', 'Due Soon']);
  check('   ...with a "create" history row', r.body.data.history.map((e) => e.action), ['create']);
  check('   ...and the allowed next statuses', r.body.data.allowedStatuses, ['In Progress', 'Completed', 'Cancelled']);
  check('   ...and the equipment is not touched by scheduling', tool('TOL-0001').status, 'In Use');
  const fields = async (b) => (await api('POST', '/api/tool-maintenance', b)).body?.error?.fields || {};
  check('the required fields', Object.keys(await fields({})).sort(), ['maintenanceType', 'scheduledDate', 'toolId']);
  check('unknown, retired and missing equipment', [(await fields(JOB({ toolId: 'TOL-0404' }))).toolId, (await fields(JOB({ toolId: 'TOL-0004' }))).toolId],
    ['No equipment with that id.', 'That equipment is retired. Reactivate it first.']);
  check('an inactive or unknown technician is refused', [(await fields(JOB({ technicianId: 'STF-0002' }))).technicianId, (await fields(JOB({ technicianId: 'robert' }))).technicianId],
    ['That is not an active member of staff or mechanic.', 'Choose a member of staff or a mechanic.']);
  const merged = Object.assign({}, await fields(JOB({ maintenanceType: 'Painting' })), await fields(JOB({ priority: 'Asap' })),
    await fields(JOB({ estimatedCost: -1 })), await fields(JOB({ scheduledDate: dayPlus(2000) })));
  ok_('a bad type, priority, cost and a far-future date are refused', ['maintenanceType', 'priority', 'estimatedCost', 'scheduledDate'].every((k) => k in merged), JSON.stringify(merged));
  ok_('an unknown field (status) is refused by name', 'status' in await fields(JOB({ status: 'Completed' })));
  check('a job with only the essentials (no technician, no cost)', (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Inspection', scheduledDate: dayPlus(-3) })).body.data.priority, 'Normal');
  await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Repair', scheduledDate: dayPlus(60), vendor: 'Compressor Works', estimatedCost: 18500 });
}

/* ---------- C. list ---------- */
{
  const L = async (qs = '') => (await api('GET', `/api/tool-maintenance${qs ? '?' + qs : ''}`)).body;
  const all = await L();
  check('list: open jobs soonest first', all.data.map((r) => [r.id, r.dueState]), [['MNT-0002', 'Overdue'], ['MNT-0001', 'Due Soon'], ['MNT-0003', 'Scheduled']]);
  check('summary', [all.summary.total, all.summary.scheduled, all.summary.dueSoon, all.summary.overdue, all.summary.inProgress, all.summary.estimatedOpenCost], [3, 3, 1, 1, 0, 25000]);
  check('panels: upcoming (30 days) and overdue', [all.panels.upcoming.map((r) => r.id), all.panels.overdue.map((r) => r.id)], [['MNT-0001'], ['MNT-0002']]);
  const ids = async (qs) => (await L(qs)).data.map((r) => r.id);
  check('filter: Overdue, Due Soon, Scheduled', [await ids('status=Overdue'), await ids('status=Due%20Soon'), await ids('status=Scheduled')], [['MNT-0002'], ['MNT-0001'], ['MNT-0002', 'MNT-0001', 'MNT-0003']]);
  check('filter: type and equipment', [await ids('type=Repair'), await ids('toolId=TOL-0001')], [['MNT-0003'], ['MNT-0001']]);
  check('filter: scheduled date range', await ids(`from=${dayPlus(0)}&to=${dayPlus(30)}`), ['MNT-0001']);
  check('search: equipment, technician, vendor, id', [await ids('q=car%20lift'), await ids('q=jamal'), await ids('q=compressor%20works'), await ids('q=mnt-0002')], [['MNT-0001'], ['MNT-0001'], ['MNT-0003'], ['MNT-0002']]);
  check('paging', [await ids('limit=1'), await ids('limit=1&offset=1')], [['MNT-0002'], ['MNT-0001']]);
  check('bad filters are 400', [(await api('GET', '/api/tool-maintenance?status=Done')).status, (await api('GET', '/api/tool-maintenance?type=x')).status, (await api('GET', '/api/tool-maintenance?from=2026-13-01')).status], [400, 400, 400]);
  check('a bad or missing id', [(await api('GET', '/api/tool-maintenance/TOL-0001')).status, (await api('GET', '/api/tool-maintenance/MNT-0999')).status], [400, 404]);
}

/* ---------- D. edit ---------- */
{
  let j = await get('MNT-0001');
  let r = await api('PUT', '/api/tool-maintenance/MNT-0001', { priority: 'Urgent', estimatedCost: 7000, technicianId: 'STF-0001', expectedUpdatedAt: j.updatedAt });
  check('edit: priority, cost and technician change, history says what', [r.status, r.body.data.priority, r.body.data.estimatedCost, r.body.data.technicianName, r.body.data.history[0].summary],
    [200, 'Urgent', 7000, 'Nadia Akter', 'Edited: priority, technician, estimated cost']);
  check('an edit from an old copy is 409 and writes no history', [(await api('PUT', '/api/tool-maintenance/MNT-0001', { priority: 'Normal', expectedUpdatedAt: j.updatedAt })).status,
    h.one("SELECT count(*) AS n FROM tool_maintenance_events WHERE maintenance_id='MNT-0001' AND action='update'").n], [409, 1]);
  check('expectedUpdatedAt is required', Object.keys((await api('PUT', '/api/tool-maintenance/MNT-0001', { priority: 'Normal' })).body.error.fields), ['expectedUpdatedAt']);
  j = await get('MNT-0001');
  r = await api('PUT', '/api/tool-maintenance/MNT-0001', { technicianId: null, expectedUpdatedAt: j.updatedAt });
  check('null removes the technician', [r.body.data.technicianId, r.body.data.technicianName], ['', '']);
}

/* ---------- E. status and the equipment ---------- */
{
  let j = await get('MNT-0001');
  check('Completed / Cancelled details are refused on other moves; illegal moves 409', [
    Object.keys((await status('MNT-0001', { to: 'In Progress', reason: 'x', expectedUpdatedAt: j.updatedAt })).body.error.fields),
    (await status('MNT-0001', { to: 'Scheduled', expectedUpdatedAt: j.updatedAt })).status], [['reason'], 422]);
  const before = tool('TOL-0001');
  let r = await status('MNT-0001', { to: 'In Progress', expectedUpdatedAt: j.updatedAt });
  check('start: In Progress, startedAt set', [r.status, r.body.data.status, Boolean(r.body.data.startedAt)], [200, 'In Progress', true]);
  const t1 = tool('TOL-0001');
  check('   ...the equipment goes Under Maintenance and its assignment ends', [t1.status, t1.assigned_mechanic_id, t1.updated_at > before.updated_at], ['Under Maintenance', null, true]);
  check('   ...recorded in the equipment\'s own history', h.all("SELECT action, summary FROM tool_events WHERE tool_id='TOL-0001'").map((e) => e.action), ['status']);
  ok_('   ...naming the job', /In Use → Under Maintenance \(MNT-0001, Preventive Service\); assignment ended/.test(h.one("SELECT summary FROM tool_events WHERE tool_id='TOL-0001'").summary));
  check('the equipment cannot be changed once started', (await api('PUT', '/api/tool-maintenance/MNT-0001', { toolId: 'TOL-0002', expectedUpdatedAt: r.body.data.updatedAt })).body.error.fields.toolId,
    'The equipment cannot be changed once the work has started.');
  j = r.body.data;
  const bad = async (b) => Object.keys((await status('MNT-0001', { to: 'Completed', expectedUpdatedAt: j.updatedAt, ...b })).body.error.fields).sort();
  check('complete needs a date, not in the future; the next service must come after it', [await bad({}), await bad({ completedDate: dayPlus(1) }), await bad({ completedDate: dayPlus(0), nextServiceDue: dayPlus(0) })],
    [['completedDate'], ['completedDate'], ['nextServiceDue']]);
  r = await status('MNT-0001', { to: 'Completed', completedDate: dayPlus(0), actualCost: 6800, workDone: 'Cables replaced, locks greased.', nextServiceDue: dayPlus(180), expectedUpdatedAt: j.updatedAt });
  check('complete: Completed with cost, work done and next service', [r.status, r.body.data.status, r.body.data.actualCost, r.body.data.completedDate, r.body.data.allowedStatuses], [200, 'Completed', 6800, dayPlus(0), []]);
  const t2 = tool('TOL-0001');
  check('   ...the equipment gets its service dates and is Available again', [t2.status, t2.last_service_date, t2.next_service_due], ['Available', dayPlus(0), dayPlus(180)]);
  check('   ...and its history says so', h.all("SELECT action FROM tool_events WHERE tool_id='TOL-0001' ORDER BY id").map((e) => e.action), ['status', 'update', 'status']);
  check('a completed job is final: no edit, no status change, no delete', [(await api('PUT', '/api/tool-maintenance/MNT-0001', { priority: 'Normal', expectedUpdatedAt: r.body.data.updatedAt })).status,
    (await status('MNT-0001', { to: 'Cancelled', reason: 'x', expectedUpdatedAt: r.body.data.updatedAt })).status,
    (await api('DELETE', '/api/tool-maintenance/MNT-0001')).status], [409, 409, 409]);

  // Two jobs on one item: the item stays Under Maintenance until the last one ends.
  const a = (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Inspection', scheduledDate: dayPlus(1) })).body.data;
  const b = (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Calibration', scheduledDate: dayPlus(1) })).body.data;
  const as = (await status(a.id, { to: 'In Progress', expectedUpdatedAt: a.updatedAt })).body.data;
  const bs = (await status(b.id, { to: 'In Progress', expectedUpdatedAt: b.updatedAt })).body.data;
  check('two jobs started on the same equipment', tool('TOL-0002').status, 'Under Maintenance');
  await status(a.id, { to: 'Completed', completedDate: dayPlus(0), expectedUpdatedAt: as.updatedAt });
  check('   ...the first completed: it stays Under Maintenance (the other is still running)', tool('TOL-0002').status, 'Under Maintenance');
  const bc = await status(b.id, { to: 'Cancelled', reason: 'Calibration kit not available', expectedUpdatedAt: bs.updatedAt });
  check('   ...the second cancelled: back to Available, reason kept', [tool('TOL-0002').status, bc.body.data.cancelReason, bc.body.data.status], ['Available', 'Calibration kit not available', 'Cancelled']);
  check('cancelling needs a reason', (await status('MNT-0002', { to: 'Cancelled', expectedUpdatedAt: (await get('MNT-0002')).updatedAt })).body.error.fields.reason, 'Please give a reason for cancelling.');

  // Poor condition: completing does not make it Available.
  const p = (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0003', maintenanceType: 'Repair', scheduledDate: dayPlus(0) })).body.data;
  const ps = (await status(p.id, { to: 'In Progress', expectedUpdatedAt: p.updatedAt })).body.data;
  await status(p.id, { to: 'Completed', completedDate: dayPlus(0), expectedUpdatedAt: ps.updatedAt });
  check('equipment in Poor condition stays Under Maintenance after the job (staff decide)', [tool('TOL-0003').status, tool('TOL-0003').last_service_date], ['Under Maintenance', dayPlus(0)]);

  // takeOutOfService: false leaves the equipment as it is.
  const k = (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Inspection', scheduledDate: dayPlus(0) })).body.data;
  await status(k.id, { to: 'In Progress', takeOutOfService: false, expectedUpdatedAt: k.updatedAt });
  check('a job started without taking the equipment out of service', tool('TOL-0002').status, 'Available');

  // Retired equipment cannot be started on.
  h.DB.raw.exec("INSERT INTO tool_maintenance (id, tool_id, tool_name, maintenance_type, scheduled_date, created_at, updated_at) VALUES ('MNT-0090', 'TOL-0004', 'Scrapped Jack', 'Repair', '2026-12-01', 'a', 'a')");
  check('work cannot start on retired equipment', (await status('MNT-0090', { to: 'In Progress', expectedUpdatedAt: 'a' })).body.error.reason, 'tool_retired');

  // A race: the equipment is edited between the read and the write -> nothing is saved.
  const race = (await api('POST', '/api/tool-maintenance', { toolId: 'TOL-0002', maintenanceType: 'Repair', scheduledDate: dayPlus(2) })).body.data;
  const realBatch = h.DB.batch;
  h.DB.batch = async (list) => { h.DB.raw.exec("UPDATE tools SET updated_at = '2099-01-01T00:00:00.000Z' WHERE id = 'TOL-0002'"); h.DB.batch = realBatch; return realBatch(list); };
  const raced = await status(race.id, { to: 'In Progress', expectedUpdatedAt: race.updatedAt });
  check('if the equipment changed meanwhile: 409 and NOTHING saved (job, equipment, histories)', [raced.status,
    h.one('SELECT status FROM tool_maintenance WHERE id = ?', race.id).status, tool('TOL-0002').status,
    h.one("SELECT count(*) AS n FROM tool_maintenance_events WHERE maintenance_id = ? AND action = 'start'", race.id).n], [409, 'Scheduled', 'Available', 0]);
  const after = (await api('GET', '/api/tool-maintenance')).body;
  check('summary after the work', [after.summary.completed, after.summary.cancelled, after.summary.totalCost], [3, 1, 6800]);
  check('recent repairs panel', after.panels.recentRepairs.map((r) => r.toolName), ['Old Press']);
}

/* ---------- F. delete ---------- */
{
  const j = await get('MNT-0003');
  check('a stale delete is 409', (await api('DELETE', '/api/tool-maintenance/MNT-0003?expectedUpdatedAt=2020-01-01T00:00:00.000Z')).status, 409);
  const counts = () => ['tools', 'tool_events', 'staff', 'mechanics'].map((t) => h.one(`SELECT count(*) AS n FROM ${t}`).n);
  const before = counts();
  const r = await api('DELETE', `/api/tool-maintenance/MNT-0003?expectedUpdatedAt=${encodeURIComponent(j.updatedAt)}`);
  check('a Scheduled job entered by mistake can be deleted', [r.status, r.body.data, h.one("SELECT count(*) AS n FROM tool_maintenance WHERE id='MNT-0003'").n], [200, { id: 'MNT-0003', deleted: true }, 0]);
  check('   ...its history stays, with a delete entry', h.all("SELECT action FROM tool_maintenance_events WHERE maintenance_id='MNT-0003' ORDER BY id").map((e) => e.action), ['create', 'delete']);
  check('   ...and nothing else changed', counts(), before);
  check('an In Progress job cannot be deleted', [h.one("SELECT status FROM tool_maintenance WHERE id='MNT-0007'").status, (await api('DELETE', '/api/tool-maintenance/MNT-0007')).status], ['In Progress', 409]);
}

/* ---------- G. permissions ---------- */
{
  const { collectionPermission } = await import('../../src/lib/permissions.js');
  check('each request needs a Workshop Assets permission', ['view', 'create', 'update', 'status', 'remove'].map((op) => collectionPermission('tool-maintenance', op)),
    ['tools.view', 'tools.edit', 'tools.edit', 'tools.edit', 'tools.delete']);
}

console.log(`\nMaintenance & Repairs API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
