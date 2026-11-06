/* Asset History — unit tests against the REAL Worker: /api/asset-history.

   The handlers run against an in-memory SQLite database built from every
   real migration. History is made through the REAL APIs (Tools / Equipment
   Inventory, Maintenance & Repairs, Asset Assignment), then read back.
   All names and numbers are fictional test values.

   What must hold:
     A. Empty database: an empty timeline and zero counts, no error.
     B. Every activity type, from its one source, exactly once (no duplicates
        from tool_assignment_events or tool_events 'create' / 'update').
     C. Each entry: type, asset name and code, date and time, description,
        performed by, related person.
     D. Summary counts follow the same filters as the timeline.
     E. Search (asset name, code, description, person) and filters (asset,
        type, date range); bad parameters are 400; paging.
     F. Asset details: the real asset by its id, with only its activities.
     G. Read only: no row anywhere changes; 401 without a credential;
        the permission is tools.view; no write routes.
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
  console.log(`\nAsset History API unit: ${pass} passed, ${fail} failed`);
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

const h = fresh();
const api = h.api;
const H = async (qs = '') => (await api('GET', `/api/asset-history${qs ? '?' + qs : ''}`)).body;

/* ---------- A. empty ---------- */
{
  const r = await api('GET', '/api/asset-history');
  check('an empty database: 200, no activities, all counts zero', [r.status, r.body.data, r.body.summary],
    [200, [], { total: 0, purchases: 0, assigned: 0, returned: 0, maintenance: 0, repairs: 0, statusChanges: 0 }]);
  check('without a credential it is 401', (await api('GET', '/api/asset-history', undefined, 'none')).status, 401);
}

/* ---------- make real history through the real APIs ---------- */
h.DB.raw.exec(`
  INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Store', 'Workshop', '${AT}');
  INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'Lifts', '${AT}');
`);
const mk = async (b) => (await api('POST', '/api/tools', b)).body.data;
const lift = await mk({ name: 'Two Post Car Lift', category: 'Lifting Equipment', purchaseDate: dayPlus(-200), purchasePrice: 450000, supplier: 'Lift Co', condition: 'Good', status: 'Available' });
const comp = await mk({ name: 'Air Compressor', category: 'Other', condition: 'Good', status: 'Available' });
const scan = await mk({ name: 'OBD Scanner', category: 'Diagnostic Equipment', purchaseDate: dayPlus(-10), purchasePrice: 25000, condition: 'Excellent', status: 'Available' });
// An item that was already registered before 0021 (no tool_events at all): purchase still listed.
h.DB.raw.exec(`INSERT INTO tools (id, name, category, condition, status, purchase_date, created_at, updated_at) VALUES ('TOL-0090', 'Old Bench Grinder', 'Other', 'Fair', 'Available', '2025-03-01', '${AT}', '${AT}')`);

// Equipment Inventory: assign the compressor to the mechanic, then return it (status change too).
let t = (await api('GET', `/api/tools/${comp.id}`)).body.data;
await api('PUT', `/api/tools/${comp.id}`, { status: 'In Use', assignedMechanicId: 'MEC-0001', expectedUpdatedAt: t.updatedAt });
t = (await api('GET', `/api/tools/${comp.id}`)).body.data;
await api('PUT', `/api/tools/${comp.id}`, { status: 'Available', expectedUpdatedAt: t.updatedAt });
// A plain field edit: not an activity.
t = (await api('GET', `/api/tools/${comp.id}`)).body.data;
await api('PUT', `/api/tools/${comp.id}`, { location: 'Bay 1', expectedUpdatedAt: t.updatedAt });

// Asset Assignment: assign the scanner to the store keeper and return it.
const a = (await api('POST', '/api/tool-assignments', { toolId: scan.id, assigneeId: 'STF-0001', purpose: 'Diagnostics' })).body.data;
await api('POST', `/api/tool-assignments/${a.id}/return`, { returnDate: dayPlus(0), conditionAfter: 'Good', expectedUpdatedAt: a.updatedAt });

// Maintenance: a completed service and a repair in progress on the lift.
const s1 = (await api('POST', '/api/tool-maintenance', { toolId: lift.id, maintenanceType: 'Preventive Service', scheduledDate: dayPlus(0), technicianId: 'MEC-0001' })).body.data;
const s1s = (await api('POST', `/api/tool-maintenance/${s1.id}/status`, { to: 'In Progress', expectedUpdatedAt: s1.updatedAt })).body.data;
await api('POST', `/api/tool-maintenance/${s1.id}/status`, { to: 'Completed', completedDate: dayPlus(0), actualCost: 3000, workDone: 'Cables greased', expectedUpdatedAt: s1s.updatedAt });
const r1 = (await api('POST', '/api/tool-maintenance', { toolId: lift.id, maintenanceType: 'Repair', scheduledDate: dayPlus(0), description: 'Arm lock sticks' })).body.data;
await api('POST', `/api/tool-maintenance/${r1.id}/status`, { to: 'In Progress', expectedUpdatedAt: r1.updatedAt });
// A scheduled job and a cancelled one are not history yet.
await api('POST', '/api/tool-maintenance', { toolId: comp.id, maintenanceType: 'Inspection', scheduledDate: dayPlus(9) });

/* ---------- B. every type, exactly once ---------- */
const all = await H('limit=200');
const types = all.data.map((r) => r.type);
const n = (ty) => types.filter((x) => x === ty).length;
check('purchases: one per item, including one registered before history existed', n('Asset Purchased'), 4);
check('assignments: Equipment Inventory + Asset Assignment, each once', [n('Asset Assigned'), n('Asset Returned')], [2, 2]);
check('maintenance completed (not Repair), and the repair in progress', [n('Maintenance Completed'), n('Repair Recorded')], [1, 1]);
const statusRows = all.data.filter((r) => r.type === 'Status Changed').map((r) => r.description);
check('status changes: the return to Available and the two times the lift went Under Maintenance and back', statusRows.length, h.one("SELECT count(*) AS n FROM tool_events WHERE action IN ('status','retire','reactivate','delete')").n);
check('no key appears twice', new Set(all.data.map((r) => r.key)).size, all.data.length);
check('field edits and "create" rows are not activities', all.data.filter((r) => /Edited location|^Added .* as (Available|In Use)/.test(r.description)).map((r) => [r.type, r.description]), []);
check('tool_assignment_events are not copied in (each hand-over is listed once)', all.data.filter((r) => r.type === 'Asset Assigned' && r.toolId === scan.id).length, 1);
check('the total is the sum of the types', all.summary.total, all.data.length);

/* ---------- C. each entry ---------- */
{
  const p = all.data.find((r) => r.type === 'Asset Purchased' && r.toolId === lift.id);
  check('purchase: date, amount, supplier', [p.toolName, p.date, p.amount, /Bought · Lifting Equipment · from Lift Co/.test(p.description)], ['Two Post Car Lift', dayPlus(-200), 450000, true]);
  const old = all.data.find((r) => r.toolId === 'TOL-0090');
  check('an item added without purchase details says so', [old.type, old.date], ['Asset Purchased', '2025-03-01']);
  const as = all.data.find((r) => r.type === 'Asset Assigned' && r.toolId === comp.id);
  check('assignment: asset, code, time, performed by, related mechanic', [as.toolName, as.toolId, /T/.test(as.at), as.performedBy, as.relatedId, as.relatedName],
    ['Air Compressor', comp.id, true, 'API token', 'MEC-0001', 'Jamal Uddin']);
  const rt = all.data.find((r) => r.type === 'Asset Returned' && r.toolId === scan.id);
  check('a return made on Asset Assignment names who had it', [rt.relatedId, rt.relatedName], ['STF-0001', 'Nadia Akter']);
  const mc = all.data.find((r) => r.type === 'Maintenance Completed');
  check('maintenance: technician as the related person, cost, work done', [mc.relatedName, mc.amount, /Preventive Service MNT-0001: Cables greased/.test(mc.description), mc.date], ['Jamal Uddin', 3000, true, dayPlus(0)]);
  const rp = all.data.find((r) => r.type === 'Repair Recorded');
  check('repair in progress', /Repair MNT-0002 \(in progress\): Arm lock sticks/.test(rp.description), true);
  check('newest first', all.data.every((r, i, x) => i === 0 || x[i - 1].date >= r.date), true);
}

/* ---------- D + E. search, filters, summary follows them ---------- */
{
  const q = async (qs) => (await H(qs));
  let r = await q('q=jamal');
  check('search by person name (mechanic)', r.data.every((x) => /Jamal/i.test(x.relatedName + x.description)) && r.data.length >= 2, true);
  check('search by asset name', (await q('q=compressor')).data.every((x) => x.toolId === comp.id), true);
  check('search by asset code', (await q(`q=${lift.id.toLowerCase()}`)).data.every((x) => x.toolId === lift.id), true);
  check('search by description', (await q('q=cables%20greased')).data.map((x) => x.type), ['Maintenance Completed']);
  r = await q(`toolId=${lift.id}`);
  check('filter by asset, and the summary follows it', [r.data.every((x) => x.toolId === lift.id), r.summary.purchases, r.summary.maintenance, r.summary.repairs, r.summary.assigned],
    [true, 1, 1, 1, 0]);
  r = await q('type=Asset%20Purchased');
  check('filter by type, and the summary follows it', [r.data.length, r.summary.total, r.summary.repairs], [4, 4, 0]);
  r = await q('range=30');
  check('last 30 days leaves out the older purchases', [r.data.some((x) => x.toolId === 'TOL-0090' || x.date === dayPlus(-200)), r.summary.purchases], [false, 2]);
  check('last 12 months keeps the lift bought 200 days ago', (await q('range=365')).data.some((x) => x.date === dayPlus(-200)), true);
  check('bad parameters are 400', [(await api('GET', '/api/asset-history?type=Sold')).status, (await api('GET', '/api/asset-history?range=7')).status,
    (await api('GET', '/api/asset-history?toolId=x')).status, (await api('GET', '/api/asset-history?limit=0')).status], [400, 400, 400, 400]);
  const p1 = await q('limit=3'), p2 = await q('limit=3&offset=3');
  check('paging: no overlap, the total stays the same', [p1.data.length, p2.data.some((x) => p1.data.some((y) => y.key === x.key)), p1.summary.total === all.summary.total], [3, false, true]);
}

/* ---------- F. asset details ---------- */
{
  const r = await api('GET', `/api/asset-history/${lift.id}`);
  check('the real asset by its id', [r.status, r.body.data.asset.id, r.body.data.asset.name, r.body.data.asset.purchasePrice, r.body.data.inRegister], [200, lift.id, 'Two Post Car Lift', 450000, true]);
  check('   ...with only its own activities', r.body.data.activities.every((x) => x.toolId === lift.id) && r.body.data.activities.length === all.data.filter((x) => x.toolId === lift.id).length, true);
  check('an unknown id is 404, a bad one 400', [(await api('GET', '/api/asset-history/TOL-0999')).status, (await api('GET', '/api/asset-history/xyz')).status], [404, 400]);
}

/* ---------- G. read only, permission ---------- */
{
  const snap = () => ['tools', 'tool_events', 'tool_maintenance', 'tool_maintenance_events', 'tool_assignments', 'tool_assignment_events', 'staff', 'mechanics']
    .map((tb) => JSON.stringify(h.all(`SELECT * FROM ${tb} ORDER BY rowid`)));
  const before = snap();
  await H('q=lift'); await H(`toolId=${lift.id}&range=90`); await api('GET', `/api/asset-history/${lift.id}`);
  check('reading changes nothing in any table', JSON.stringify(snap()) === JSON.stringify(before), true);
  check('no write routes: POST, PUT, DELETE are refused', [(await api('POST', '/api/asset-history', {})).status, (await api('PUT', `/api/asset-history/${lift.id}`, {})).status,
    (await api('DELETE', `/api/asset-history/${lift.id}`)).status], [405, 405, 405]);
  const { collectionPermission } = await import('../../src/lib/permissions.js');
  check('the permission is the existing Workshop Assets view', collectionPermission('asset-history', 'view'), 'tools.view');
  check('no migration was added for it', readdirSync(join(ROOT, 'migrations')).filter((f) => /asset.?history/i.test(f)), []);
}

console.log(`\nAsset History API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
