/* Asset Reports — unit tests against the REAL Worker: /api/asset-reports.

   The handlers run against an in-memory SQLite database built from every
   real migration. Equipment and jobs are made through the REAL APIs (Tools /
   Equipment Inventory, Maintenance & Repairs, Asset Assignment); every figure
   is then checked against plain SQL on the same tables. Fictional values.

   What must hold:
     A. Empty database: zeros, empty lists, no error.
     B. Asset summary (in service, Available, In Use, Under Maintenance,
        Damaged, Retired) and asset value: match the database; Retired kept
        out of value and utilisation; no price or date is invented.
     C. Category distribution and utilisation (formula In Use / in service).
     D. Expenses: spent = actual cost of Completed jobs only, each job once;
        maintenance vs repairs; In Progress / Scheduled / Cancelled estimates
        apart; monthly, yearly, category and equipment totals add up.
     E. Filters: search (name, code), category, status, purchase dates,
        cost dates -- figures follow; bad parameters 400; paging.
     F. One asset's cost breakdown by its id.
     G. Read only: nothing changes; no write routes; 401; tools.view;
        no technician or staff names in the answer.
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
  console.log(`\nAsset Reports API unit: ${pass} passed, ${fail} failed`);
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
const R = async (qs = '') => (await api('GET', `/api/asset-reports${qs ? '?' + qs : ''}`)).body;

/* ---------- A. empty ---------- */
{
  const r = await api('GET', '/api/asset-reports');
  check('an empty database: 200, no assets, zero figures', [r.status, r.body.data, r.body.summary.inService, r.body.summary.value, r.body.expenses.spent, r.body.categories],
    [200, [], 0, 0, 0, []]);
  check('   ...the monthly axis is the last 12 months, all zero', [r.body.expenses.monthly.length, r.body.expenses.monthly.every((m) => m.spent === 0), r.body.expenses.monthly.at(-1).month], [12, true, dayPlus(0).slice(0, 7)]);
  check('without a credential it is 401', (await api('GET', '/api/asset-reports', undefined, 'none')).status, 401);
}

/* ---------- real data through the real APIs ---------- */
h.DB.raw.exec(`
  INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Store', 'Workshop', '${AT}');
  INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'Lifts', '${AT}');
`);
const mk = async (b) => (await api('POST', '/api/tools', b)).body.data;
const lift = await mk({ name: 'Two Post Car Lift', category: 'Lifting Equipment', purchaseDate: dayPlus(-400), purchasePrice: 450000, condition: 'Good', status: 'Available' });
const jack = await mk({ name: 'Floor Jack', category: 'Lifting Equipment', purchaseDate: dayPlus(-20), purchasePrice: 14000, condition: 'Good', status: 'Available' });
const scan = await mk({ name: 'OBD Scanner', category: 'Diagnostic Equipment', purchaseDate: dayPlus(-60), purchasePrice: 25000, condition: 'Excellent', status: 'Available' });
const comp = await mk({ name: 'Air Compressor', category: 'Other', condition: 'Fair', status: 'Available' });           // no price, no date
const old = await mk({ name: 'Old Press', category: 'Other', purchaseDate: dayPlus(-900), purchasePrice: 30000, condition: 'Poor', status: 'Damaged' });
const gone = await mk({ name: 'Scrapped Grinder', category: 'Workshop Hand Tools', purchaseDate: dayPlus(-1000), purchasePrice: 9000, condition: 'Poor', status: 'Under Maintenance' });
let gt = (await api('GET', `/api/tools/${gone.id}`)).body.data;
check('(setup) retire one item', (await api('POST', `/api/tools/${gone.id}/retire`, { reason: 'Worn out', expectedUpdatedAt: gt.updatedAt })).status, 200);
// The scanner goes out on Asset Assignment.
await api('POST', '/api/tool-assignments', { toolId: scan.id, assigneeId: 'STF-0001' });
// Maintenance: lift service completed (cost 3000, 40 days ago), lift repair completed (8000, today),
// a jack repair in progress (estimate 5000), a scheduled inspection (estimate 1200), a cancelled job (estimate 900),
// a completed job with no cost recorded.
const job = async (b) => (await api('POST', '/api/tool-maintenance', b)).body.data;
const status = async (j, b) => (await api('POST', `/api/tool-maintenance/${j.id}/status`, { expectedUpdatedAt: j.updatedAt, ...b })).body.data;
let j1 = await job({ toolId: lift.id, maintenanceType: 'Preventive Service', scheduledDate: dayPlus(-41), estimatedCost: 2500, technicianId: 'MEC-0001' });
j1 = await status(j1, { to: 'In Progress' }); await status(j1, { to: 'Completed', completedDate: dayPlus(-40), actualCost: 3000 });
let j2 = await job({ toolId: lift.id, maintenanceType: 'Repair', scheduledDate: dayPlus(0), estimatedCost: 7000 });
j2 = await status(j2, { to: 'In Progress' }); await status(j2, { to: 'Completed', completedDate: dayPlus(0), actualCost: 8000 });
let j3 = await job({ toolId: jack.id, maintenanceType: 'Repair', scheduledDate: dayPlus(0), estimatedCost: 5000 });
await status(j3, { to: 'In Progress' });
await job({ toolId: comp.id, maintenanceType: 'Inspection', scheduledDate: dayPlus(10), estimatedCost: 1200 });
let j5 = await job({ toolId: comp.id, maintenanceType: 'Calibration', scheduledDate: dayPlus(5), estimatedCost: 900 });
await status(j5, { to: 'Cancelled', reason: 'Not needed' });
let j6 = await job({ toolId: old.id, maintenanceType: 'Inspection', scheduledDate: dayPlus(-3) });
j6 = await status(j6, { to: 'In Progress', takeOutOfService: false }); await status(j6, { to: 'Completed', completedDate: dayPlus(-2) });

const all = await R('limit=100');
const q1 = (sql, ...a) => h.one(sql, ...a);

/* ---------- B. summary and value ---------- */
{
  const db = q1(`SELECT count(*) a, sum(status<>'Retired') s, sum(status='Available') av, sum(status='In Use') iu, sum(status='Under Maintenance') um,
    sum(status='Damaged') dm, sum(status='Retired') rt, sum(CASE WHEN status<>'Retired' THEN purchase_price END) v FROM tools`);
  const s = all.summary;
  check('asset counts match the database', [s.allItems, s.inService, s.available, s.inUse, s.underMaintenance, s.damaged, s.retired], [db.a, db.s, db.av, db.iu, db.um, db.dm, db.rt]);
  check('   ...the jack under repair is Under Maintenance, the scanner In Use', [s.underMaintenance, s.inUse], [1, 1]);
  check('asset value: purchase prices of items in service only (retired kept apart)', [s.value, s.retiredValue], [450000 + 14000 + 25000 + 30000, 9000]);
  check('   ...no price is invented for the compressor: counted as unpriced', [s.unpriced, s.undated], [1, 1]);
  check('utilisation = In Use / in service', s.utilisation, Math.round((1 / 5) * 1000) / 10);
  const row = all.data.find((r) => r.id === comp.id);
  check('purchase table: missing date and price stay empty', [row.purchaseDate, row.purchasePrice], ['', null]);
  check('purchase table: newest purchase first, undated last', [all.data[0].id, all.data.at(-1).id], [jack.id, comp.id]);
}

/* ---------- C. categories ---------- */
{
  const c = Object.fromEntries(all.categories.map((x) => [x.category, x]));
  check('Lifting: 2 in service, value, share of items', [c['Lifting Equipment'].inService, c['Lifting Equipment'].value, c['Lifting Equipment'].share], [2, 464000, 40]);
  check('Diagnostic: utilisation 100 % (the scanner is out)', c['Diagnostic Equipment'].utilisation, 100);
  check('a retired-only category: 0 in service, 1 retired', [c['Workshop Hand Tools'].inService, c['Workshop Hand Tools'].retired], [0, 1]);
  check('shares add up to 100 %', Math.round(all.categories.reduce((n, x) => n + x.share, 0)), 100);
  check('category counts add up to in service', all.categories.reduce((n, x) => n + x.inService, 0), all.summary.inService);
}

/* ---------- D. expenses ---------- */
{
  const x = all.expenses;
  const db = q1(`SELECT sum(CASE WHEN status='Completed' THEN actual_cost END) s, count(*) n FROM tool_maintenance`);
  check('spent = actual cost of Completed jobs, each once (= SQL)', [x.spent, x.spent], [db.s, 11000]);
  check('maintenance vs repairs', [x.spentMaintenance, x.spentRepairs], [3000, 8000]);
  check('completed jobs, one without a cost recorded', [x.completed, x.completedWithoutCost], [3, 1]);
  check('open estimates apart: in progress, scheduled', [x.inProgress, x.inProgressEstimate, x.scheduled, x.scheduledEstimate], [1, 5000, 1, 1200]);
  check('cancelled apart, never in spent', [x.cancelled, x.cancelledEstimate], [1, 900]);
  check('monthly bars add up to spent', x.monthly.reduce((n, m) => n + m.spent, 0), 11000);
  check('yearly adds up to spent', x.yearly.reduce((n, y) => n + y.spent, 0), 11000);
  check('category-wise adds up to spent', x.byCategory.reduce((n, y) => n + y.spent, 0), 11000);
  check('equipment-wise: the lift first, 11000 with 8000 of repairs', [x.byEquipment[0].toolId, x.byEquipment[0].spent, x.byEquipment[0].repairs], [lift.id, 11000, 8000]);
  check('equipment-wise adds up to spent, every job counted once', [x.byEquipment.reduce((n, y) => n + y.spent, 0), x.byEquipment.reduce((n, y) => n + y.jobs, 0)], [11000, db.n]);
  check('the asset row carries its own spending', all.data.find((r) => r.id === lift.id).maintenanceSpent, 11000);
}

/* ---------- E. filters ---------- */
{
  let r = await R('q=lift');
  check('search by name: only the lift, figures follow', [r.data.map((x) => x.id), r.summary.inService, r.summary.value, r.expenses.spent], [[lift.id], 1, 450000, 11000]);
  r = await R(`q=${scan.id.toLowerCase()}`);
  check('search by code', r.data.map((x) => x.id), [scan.id]);
  r = await R('category=Lifting%20Equipment');
  check('category filter: assets and spending of that category only', [r.summary.inService, r.expenses.spent, r.expenses.inProgressEstimate, r.categories.map((c) => c.category)], [2, 11000, 5000, ['Lifting Equipment']]);
  r = await R('status=Retired');
  check('status filter: Retired only', [r.summary.allItems, r.summary.inService, r.summary.retired, r.summary.utilisation], [1, 0, 1, 0]);
  r = await R(`from=${dayPlus(-100)}&to=${dayPlus(0)}`);
  check('purchase date range: only items bought in it (undated left out, not guessed)', r.data.map((x) => x.id).sort(), [jack.id, scan.id].sort());
  r = await R(`costFrom=${dayPlus(-7)}&costTo=${dayPlus(0)}`);
  check('cost date range: only the repair completed today', [r.expenses.spent, r.expenses.spentRepairs, r.expenses.spentMaintenance], [8000, 8000, 0]);
  check('   ...the month axis covers the period', r.expenses.monthly.at(-1).month, dayPlus(0).slice(0, 7));
  check('   ...the asset filters still cover the whole register', r.summary.allItems, all.summary.allItems);
  check('bad parameters are 400', [(await api('GET', '/api/asset-reports?status=Lost')).status, (await api('GET', '/api/asset-reports?category=Toys')).status,
    (await api('GET', '/api/asset-reports?from=2026-13-01')).status, (await api('GET', `/api/asset-reports?costFrom=${dayPlus(0)}&costTo=${dayPlus(-1)}`)).status], [400, 400, 400, 400]);
  const p1 = await R('limit=2'), p2 = await R('limit=2&offset=2');
  check('paging only pages the table; figures stay the same', [p1.data.length, p2.data.some((a) => p1.data.some((b) => b.id === a.id)), p1.summary.value === all.summary.value, p1.total], [2, false, true, 6]);
}

/* ---------- F. one asset ---------- */
{
  const r = await api('GET', `/api/asset-reports/${lift.id}`);
  check('one asset by its id: jobs and totals', [r.status, r.body.data.asset.id, r.body.data.jobs.length, r.body.data.totals.spent, r.body.data.totals.repairs], [200, lift.id, 2, 11000, 8000]);
  const c = await api('GET', `/api/asset-reports/${comp.id}`);
  check('   ...open and cancelled estimates apart', [c.body.data.totals.openEstimate, c.body.data.totals.cancelledEstimate, c.body.data.totals.spent], [1200, 900, 0]);
  check('unknown id 404, bad id 400', [(await api('GET', '/api/asset-reports/TOL-0999')).status, (await api('GET', '/api/asset-reports/xyz')).status], [404, 400]);
}

/* ---------- G. read only ---------- */
{
  const snap = () => ['tools', 'tool_events', 'tool_maintenance', 'tool_maintenance_events', 'tool_assignments', 'tool_assignment_events']
    .map((tb) => JSON.stringify(h.all(`SELECT * FROM ${tb} ORDER BY rowid`))).join('|');
  const before = snap();
  await R('q=lift&category=Lifting%20Equipment'); await R(`costFrom=${dayPlus(-30)}`); await api('GET', `/api/asset-reports/${lift.id}`);
  check('reading changes nothing in any table', snap() === before, true);
  check('no write routes', [(await api('POST', '/api/asset-reports', {})).status, (await api('PUT', `/api/asset-reports/${lift.id}`, {})).status,
    (await api('DELETE', `/api/asset-reports/${lift.id}`)).status], [405, 405, 405]);
  const text = JSON.stringify(all) + JSON.stringify((await api('GET', `/api/asset-reports/${lift.id}`)).body);
  check('no staff, mechanic or technician names in the answer', /Jamal|Nadia|MEC-0001|STF-0001/.test(text), false);
  const { collectionPermission } = await import('../../src/lib/permissions.js');
  check('the permission is the existing Workshop Assets view', collectionPermission('asset-reports', 'view'), 'tools.view');
  check('no migration was added for it', readdirSync(join(ROOT, 'migrations')).filter((f) => /report/i.test(f)), []);
}

console.log(`\nAsset Reports API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
