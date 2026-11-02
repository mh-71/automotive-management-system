/* Offline sync on the Cloudflare Workers FREE plan -- query budget and the
   fixes from the independent review, against the REAL Worker.

   D1 allows 50 queries per Worker invocation on the Free plan (a batch counts
   as one). This suite counts EVERY query of each request at the database
   layer -- the auth gate, the sync handler, every internal route call and the
   background notification writes -- and requires each sync request to stay
   at or below 40.

     A. Worst-case cost per operation kind (customer, vehicle, job card,
        payment, parts usage, status, update) and per pulled record: each
        measured, reported, and within the server's declared OP_COST.
     B. Large batches split themselves: 25 job cards, 25 parts usages, 200
        pulled records -- every request <= 40, everything applied exactly once,
        nothing skipped.
     C. H1  two administrators resolving one conflict at once: one wins.
     D. H2  a write saved but its answer lost (server error after the commit):
            no duplicate customer, payment, or draft; uncertain ones held.
     E. H3  sync route failures come back as JSON (no table, DB error).
     F. M1  a job card / invoice with an invoice draft can still be deleted.
     G. M2  an administrator cannot apply a change its author could not make
            today (inactive account, revoked device, role without permission).
     H. M3  a pull never moves its cursor past a record it could not read; an
            expired session ends it; tombstones respect permissions.
     I. M4  parts usage never overwrites an edit made after it read the job card.
     J. M5  a mechanic added through Staff Management reaches devices.
     K. An account cannot sync through a device it never registered.
   Needs node:sqlite (Node 22.5+). Fictional data only. */

import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { OP_COST, PULL_COST, REQUEST_QUERY_TARGET } from '../../src/routes/sync.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nSync budget unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const FREE_PLAN_LIMIT = 50;
const SAFE = 40;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const TOKEN = 'unit-test-token';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42', PW2 = 'Own-Chosen-Pass-77';
const AT = '2026-10-08T00:00:00Z';

/* ---------- a D1 stand-in that counts every query, with fault injection ---------- */
const raw = new DatabaseSync(':memory:');
raw.exec('PRAGMA foreign_keys = ON;');
for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
let queries = 0;
const faults = [];   // { match: RegExp, times, error, before?, after? }
// `after: true` = the statement RUNS (D1 committed it) and then the answer is
// lost -- the "saved, but the response failed" case of the review (H2).
const fault = (sql, phase = 'before') => {
  const f = faults.find((x) => x.times > 0 && !x.committed && x.match.test(sql) && (!!x.after === (phase === 'after')));
  if (f) { f.times -= 1; if (f.before) f.before(); if (f.error) throw new Error(f.error); }
};
const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
class Stmt {
  constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
  bind(...a) { return new Stmt(this.sql, a.map((x) => (x === undefined ? null : x))); }
  exec() {
    fault(this.sql);
    const s = raw.prepare(this.sql);
    if (returnsRows(this.sql)) { const r = s.all(...this.binds); fault(this.sql, 'after'); return { results: r, meta: { changes: r.length } }; }
    const r = s.run(...this.binds);
    fault(this.sql, 'after');
    return { results: [], meta: { changes: Number(r.changes) } };
  }
  async first(col) { queries++; await null; if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
    fault(this.sql); const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r; }
  async all() { queries++; await null; fault(this.sql); return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
  async run() { queries++; await null; return this.exec(); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  async batch(list) {
    queries++; await null;
    raw.exec('BEGIN');
    let out;
    try { out = list.map((s) => s.exec()); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
    // `committed: true` = the batch is COMMITTED, then its answer is lost (H2).
    const f = faults.find((x) => x.times > 0 && x.committed && list.some((st) => x.match.test(st.sql)));
    if (f) { f.times -= 1; throw new Error(f.error); }
    return out;
  },
};
const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: 'workshop passphrase', AUTH_SECRET: SECRET };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const one = (sql, ...a) => raw.prepare(sql).get(...a);
const count = (sql, ...a) => Number(Object.values(one(sql, ...a))[0]);

/** One request; `q` is EVERY query it made, background notification writes included. */
async function api(method, path, body, cred = 'token') {
  const headers = {};
  if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`; else if (cred !== 'none') headers.cookie = cred;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const before = queries;
  const res = await worker.fetch(new Request('http://worker.local' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, ctx);
  const text = await res.text();
  await Promise.all(pending.splice(0));
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, q: queries - before, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

raw.exec(`
  INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES
    ('STF-0001', 'Admin Test', '01911000001', 'Active', 'T', 'T', '${AT}'), ('STF-0002', 'Advisor Test', '01911000002', 'Active', 'T', 'T', '${AT}'),
    ('STF-0003', 'Second Admin', '01911000003', 'Active', 'T', 'T', '${AT}'), ('STF-0004', 'Clerk Test', '01911000004', 'Active', 'T', 'T', '${AT}'),
    ('STF-0005', 'Leaver Test', '01911000005', 'Active', 'T', 'T', '${AT}');
  UPDATE id_counters SET last_value = 5 WHERE collection = 'staff';
  INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0001', 'Bench Mechanic', '01911000099', 'Active', '${AT}');
  UPDATE id_counters SET last_value = 1 WHERE collection = 'mechanics';
  INSERT INTO services (id, name, category, price, status, created_at) VALUES ('SRV-0001', 'Test Service', 'General', 500, 'Active', '${AT}');
  UPDATE id_counters SET last_value = 1 WHERE collection = 'services';
  INSERT INTO parts (id, name, part_no, category, unit, purchase_price, selling_price, stock, min_stock, status, created_at)
    VALUES ('PRT-0001', 'Brake Pad', 'BP-1', 'Brakes', 'pcs', 100, 150, 1000, 1, 'Active', '${AT}'),
           ('PRT-0002', 'Oil Filter', 'OF-1', 'Filters', 'pcs', 50, 80, 1000, 1, 'Active', '${AT}');
  UPDATE id_counters SET last_value = 2 WHERE collection = 'parts';`);

async function person(n, username, role) {
  const made = await api('POST', '/api/accounts', { staffId: `STF-000${n}`, username, role, password: PW });
  if (made.status !== 201) throw new Error(made.text);
  const s = await api('POST', '/api/session', { username, password: PW }, 'none');
  const changed = await api('POST', '/api/session/password', { currentPassword: PW, newPassword: PW2 }, s.cookie);
  return { id: made.body.data.id, cookie: changed.cookie };
}
const admin = await person(1, 'budget.admin', 'Admin');
const advisor = await person(2, 'budget.advisor', 'Service Advisor');
const admin2 = await person(3, 'budget.admin2', 'Admin');
const clerk = await person(4, 'budget.clerk', 'Staff');
const leaver = await person(5, 'budget.leaver', 'Service Advisor');

const devA = randomUUID();
const devL = randomUUID();
const codeA = (await api('POST', '/api/devices/register', { deviceId: devA }, advisor.cookie)).body.data.code;
await api('POST', '/api/devices/register', { deviceId: devA }, admin.cookie);
await api('POST', '/api/devices/register', { deviceId: devL }, leaver.cookie);
let seq = 0;
const T = (prefix) => `OFF-${codeA}-${prefix}-${String(++seq).padStart(4, '0')}`;
const op = (kind, fields) => ({ opId: randomUUID(), kind, createdAt: new Date().toISOString(), ...fields });
const push = (ops, cookie = advisor.cookie, deviceId = devA) => api('POST', '/api/sync/push', { deviceId, ops }, cookie);
const jobBody = (customerId, vehicleId) => ({ customerId, vehicleId, mechanicId: 'MEC-0001', date: '2026-10-09', complaint: 'Budget job',
  services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 1, unitPrice: 500 }, { serviceId: null, name: 'Extra work', qty: 2, unitPrice: 100 }],
  partsUsed: [{ partId: 'PRT-0002', name: 'Oil Filter', partNo: 'OF-1', qty: 1, unitPrice: 80 }], status: 'Received' });

/** Push everything the way the client does: send, take the answers, send what was deferred again. */
async function pushAll(ops, cookie = advisor.cookie, deviceId = devA) {
  const requests = [];
  let left = ops;
  const answers = new Map();
  for (let round = 0; round < 200 && left.length; round++) {
    const r = await push(left, cookie, deviceId);
    requests.push(r.q);
    if (r.status !== 200) return { requests, answers, error: r };
    for (const a of r.body.data.results) if (a.status !== 'deferred') answers.set(a.opId, a);
    left = left.filter((o) => !answers.has(o.opId));
  }
  return { requests, answers };
}

console.log('=== Offline sync on the Workers Free plan (50 queries / request) ===');

/* ---------- A. worst-case cost of one operation of each kind ---------- */
console.log(`\n-- A. queries per operation (whole request, auth gate and background writes included; target <= ${SAFE}, Free-plan limit ${FREE_PLAN_LIMIT}) --`);
const report = [];
// The fixed part of every push: the auth gate, the device check and the device's last-seen batch.
const baseline = (await push([{ opId: 'not-a-uuid', kind: 'create', data: {} }])).q;
console.log(`   (baseline push, no operation applied: ${baseline} queries)`);
const measure = async (label, kind, mkOps) => {
  const single = await push(mkOps(1));
  const cost = single.q - baseline;
  report.push({ label, total: single.q, cost, declared: OP_COST[kind] });
  ok_(`${label}: ${single.q} queries for the request, ${cost} for the operation itself (declared worst case ${OP_COST[kind]})`,
    single.status === 200 && single.q <= SAFE && cost <= OP_COST[kind] && single.body.data.results.every((x) => x.status === 'applied'), single.body);
  return { single };
};
const cust = await measure('customer create', 'create', (n) => Array.from({ length: n }, () => op('create', { collection: 'customers', tempId: T('CUS'), data: { name: 'Budget Customer', phone: `0170${String(++seq).padStart(7, '0')}`, email: 'b@example.test', address: 'Dhaka' } })));
const custId = cust.single.body.data.results[0].serverId;
// A vehicle referring to a customer made offline in the same request (a temporary reference to resolve).
{
  // A vehicle whose customer was also made offline: its temporary reference is resolved on the server.
  const c = T('CUS');
  await push([op('create', { collection: 'customers', tempId: c, data: { name: 'Owner', phone: `0171${String(++seq).padStart(7, '0')}` } })]);
  await measure('vehicle create (customer by temporary reference)', 'create', () => [op('create', { collection: 'vehicles', tempId: T('VEH'), data: { customerId: c, regNo: `BUDGET-${++seq}`, brand: 'Toyota', model: 'Axio' } })]);
}
const vehId = (await push([op('create', { collection: 'vehicles', tempId: T('VEH'), data: { customerId: custId, regNo: `BUDGET-V-${++seq}`, brand: 'Honda', model: 'Fit' } })])).body.data.results[0].serverId;
await measure('vehicle create', 'create', (n) => Array.from({ length: n }, () => op('create', { collection: 'vehicles', tempId: T('VEH'), data: { customerId: custId, regNo: `BUDGET-${++seq}`, brand: 'Honda', model: 'Fit' } })));
await measure('job card create (services + parts lines)', 'create', (n) => Array.from({ length: n }, () => op('create', { collection: 'jobCards', tempId: T('JOB'), data: jobBody(custId, vehId) })));
// Job cards in progress, for parts usage, and a completed one with an invoice to pay against.
const mkJob = async (statuses) => {
  const j = await api('POST', '/api/job-cards', jobBody(custId, vehId), advisor.cookie);
  for (const s of statuses) await api('POST', `/api/job-cards/${j.body.data.id}/status`, { status: s }, advisor.cookie);
  return j.body.data.id;
};
const inProgress = await mkJob(['Inspection', 'In Progress']);
const invoiceJob = await mkJob(['Inspection', 'In Progress', 'Completed']);
const invoice = (await api('POST', '/api/invoices', { jobCardId: invoiceJob }, advisor.cookie)).body.data;
await measure('payment (against an invoice: duplicate check, lock, balance)', 'payment', (n) => Array.from({ length: n }, (_, i) => op('payment', { tempId: T('PAY'), data: { customerId: custId, invoiceId: invoice.id, amount: 1 + i + seq, date: '2026-10-10', method: 'Cash', reference: `R-${seq}` } })));
await measure('parts usage (new line, stock reconciled)', 'parts_usage', (n) => Array.from({ length: n }, () => op('parts_usage', { targetId: inProgress, data: { partId: 'PRT-0001', quantity: 1 } })));
await measure('update (field-level clash check)', 'update', (n) => Array.from({ length: n }, (_, i) => op('update', { collection: 'customers', targetId: custId, base: { values: { notes: null } }, data: { notes: `Note ${seq}-${i}` } })));
const statusJobs = [];
for (let i = 0; i < 3; i++) statusJobs.push(await mkJob(['Inspection']));
let si = 0;
await measure('job card status (In Progress: stock deducted)', 'status', (n) => Array.from({ length: n }, () => op('status', { targetId: statusJobs[si++], base: { status: 'Inspection' }, data: { status: 'In Progress' } })));
const draftJob = await mkJob(['Inspection', 'In Progress', 'Completed']);
const draftJob2 = await mkJob(['Inspection', 'In Progress', 'Completed']);
const dj = [draftJob, draftJob2, await mkJob(['Inspection', 'In Progress', 'Completed'])];
let di = 0;
await measure('invoice draft', 'invoice_draft', (n) => Array.from({ length: n }, () => op('invoice_draft', { tempId: T('DRF'), data: { jobCardId: dj[di++], localTotal: 860 } })));
{
  // Recording stock movements needs inventory.manage: measured as the Admin, through the Admin's own device link.
  const r = await push([op('stock_movement', { tempId: T('STK'), data: { partId: 'PRT-0002', type: 'purchase', quantity: 5, unitCost: 50 } })], admin.cookie);
  report.push({ label: 'stock movement (receive stock)', total: r.q, cost: r.q - baseline, declared: OP_COST.stock_movement });
  ok_(`stock movement (receive stock): ${r.q} queries for the request, ${r.q - baseline} for the operation itself (declared worst case ${OP_COST.stock_movement})`,
    r.status === 200 && r.q <= SAFE && r.q - baseline <= OP_COST.stock_movement && r.body.data.results[0].status === 'applied', r.body);
}
console.log('\n   Measured D1 queries (one operation per request; whole request incl. auth gate and background writes):');
for (const r of report) console.log(`     ${r.label.padEnd(62)} request ${String(r.total).padStart(2)}   operation ${String(r.cost).padStart(2)}   declared ${r.declared}`);

/* ---------- B. big batches split themselves ---------- */
console.log('\n-- B. large batches split into requests that fit --');
{
  const jobs = Array.from({ length: 25 }, () => op('create', { collection: 'jobCards', tempId: T('JOB'), data: jobBody(custId, vehId) }));
  const before = count('SELECT COUNT(*) FROM job_cards');
  const r = await pushAll(jobs);
  ok_(`25 job cards: ${r.requests.length} requests, the largest ${Math.max(...r.requests)} queries -- every one <= ${SAFE}; all 25 applied once`,
    !r.error && Math.max(...r.requests) <= SAFE && r.answers.size === 25 && [...r.answers.values()].every((a) => a.status === 'applied') && count('SELECT COUNT(*) FROM job_cards') === before + 25, r.requests);
  const stockBefore = one("SELECT stock FROM parts WHERE id = 'PRT-0002'").stock;
  const uses = Array.from({ length: 25 }, () => op('parts_usage', { targetId: inProgress, data: { partId: 'PRT-0002', quantity: 1 } }));
  const u = await pushAll(uses);
  ok_(`25 parts usages: ${u.requests.length} requests, the largest ${Math.max(...u.requests)} -- every one <= ${SAFE}; stock moved by exactly 25`,
    !u.error && Math.max(...u.requests) <= SAFE && [...u.answers.values()].every((a) => a.status === 'applied') && one("SELECT stock FROM parts WHERE id = 'PRT-0002'").stock === stockBefore - 25, u.requests);
  const mixed = [];
  for (let i = 0; i < 10; i++) {
    const c = T('CUS');
    mixed.push(op('create', { collection: 'customers', tempId: c, data: { name: `Mixed ${i}`, phone: `0172${String(++seq).padStart(7, '0')}` } }));
    mixed.push(op('payment', { tempId: T('PAY'), data: { customerId: c, amount: 10 + i, date: '2026-10-11', method: 'Card' } }));
  }
  const m = await pushAll(mixed);
  ok_(`10 customers each with a payment by temporary reference (20 ops): every request <= ${SAFE}, dependency order kept`,
    !m.error && Math.max(...m.requests) <= SAFE && [...m.answers.values()].every((a) => a.status === 'applied'), m.requests);
  // Pull: 200 changed job cards.
  const start = (await api('GET', '/api/session', undefined, advisor.cookie)).body.data.syncCursor;
  for (let i = 0; i < 200; i++) raw.prepare("INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', ?, 'upsert', ?)").run(jobs[i % 25] && [...r.answers.values()][i % 25].serverId, AT);
  let cursor = start; const seen = new Set(); const pulls = [];
  for (let i = 0; i < 100; i++) {
    const p = await api('GET', `/api/sync/pull?deviceId=${devA}&cursor=${cursor}&limit=100`, undefined, advisor.cookie);
    pulls.push(p.q);
    for (const ch of p.body.data.changes) seen.add(ch.seq);
    cursor = p.body.data.cursor;
    if (!p.body.data.hasMore) break;
  }
  const last = count('SELECT MAX(seq) FROM change_log');
  ok_(`pulling 200 changed job cards: ${pulls.length} requests, the largest ${Math.max(...pulls)} queries -- every one <= ${SAFE}; the cursor reaches the end`,
    Math.max(...pulls) <= SAFE && cursor === last, { pulls, cursor, last });
  const empty = await api('GET', `/api/sync/pull?deviceId=${devA}&cursor=${last}&limit=1`, undefined, advisor.cookie);
  const single = await api('GET', `/api/sync/pull?deviceId=${devA}&cursor=${last - 1}&limit=1`, undefined, advisor.cookie);
  ok_(`pull of one job card: ${single.q} queries for the request, ${single.q - empty.q} for the record (declared ${PULL_COST})`, single.q - empty.q <= PULL_COST && single.q <= SAFE);
}

/* ---------- C. H1: two administrators at once ---------- */
console.log('\n-- C. H1: one conflict, two administrators at the same moment --');
{
  const p1 = op('payment', { tempId: T('PAY'), data: { customerId: custId, jobCardId: inProgress, amount: 777, date: '2026-10-12', method: 'Cash' } });
  await push([p1]);
  const dup = op('payment', { tempId: T('PAY'), data: { customerId: custId, jobCardId: inProgress, amount: 777, date: '2026-10-12', method: 'Cash' } });
  const r = await push([dup]);
  const cid = r.body.data.results[0].conflictId;
  check('(a duplicate payment is held as a conflict)', r.body.data.results[0].type, 'duplicate');
  const both = await Promise.all([
    api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'apply_anyway', note: 'Two separate receipts' }, admin.cookie),
    api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'apply_anyway', note: 'Two separate receipts' }, admin2.cookie),
  ]);
  check('both press "Record it anyway": exactly one succeeds, the other is told it is being decided', both.map((x) => x.status).sort(), [200, 409]);
  check('   ...and exactly ONE more payment exists (not two)', count("SELECT COUNT(*) FROM payments WHERE amount = 777 AND status <> 'Void'"), 2);
  ok_('   ...each request within budget', both.every((x) => x.q <= SAFE), both.map((x) => x.q));
}

/* ---------- D. H2: saved, but the answer was lost ---------- */
console.log('\n-- D. H2: a write saved, then an error before the answer --');
{
  // D1 commits the customer, then the answer is lost on the way back.
  const c1 = op('create', { collection: 'customers', tempId: T('CUS'), data: { name: 'Lost Answer', phone: '01733000001' } });
  faults.push({ match: /INSERT INTO customers/, times: 1, after: true, error: 'D1_ERROR: network connection lost' });
  const r1 = await push([c1]);
  check('a customer saved, then its read-back failed: held as "interrupted" for review -- NOT released for a blind re-post',
    [r1.body.data.results[0].status, r1.body.data.results[0].type, count("SELECT COUNT(*) FROM customers WHERE phone = '01733000001'")], ['conflict', 'interrupted', 1]);
  const r2 = await push([c1]);
  check('   ...the device sends it again: answered from the record, still ONE customer', [r2.body.data.results[0].status, count("SELECT COUNT(*) FROM customers WHERE phone = '01733000001'")], ['conflict', 1]);
  // A payment: its own record proves it.
  const p = op('payment', { tempId: T('PAY'), data: { customerId: custId, jobCardId: inProgress, amount: 4321, date: '2026-10-13', method: 'Card' } });
  faults.push({ match: /INSERT INTO payments/, times: 1, committed: true, error: 'D1_ERROR: network connection lost' });
  const pr = await push([p]);
  check('a payment committed, then its answer lost: the server finds it by its offline reference -- applied, ONE payment',
    [pr.body.data.results[0].status, count('SELECT COUNT(*) FROM payments WHERE amount = 4321')], ['applied', 1]);
  const pr2 = await push([p]);
  check('   ...sent again: replayed, still one', [pr2.body.data.results[0].replayed, count('SELECT COUNT(*) FROM payments WHERE amount = 4321')], [true, 1]);
  // Even if the claim had been lost entirely, the payment itself prevents a second one.
  raw.prepare('DELETE FROM sync_ops WHERE op_id = ?').run(p.opId);
  const pr3 = await push([p]);
  check('   ...even with its sync record gone, the payment carrying its reference is the answer: still one', [pr3.body.data.results[0].status, count('SELECT COUNT(*) FROM payments WHERE amount = 4321')], ['applied', 1]);
  // A server error before the write was sent (reading the current record): certainly not applied.
  const u = op('update', { collection: 'customers', targetId: custId, base: { values: {} }, data: { address: 'Uttara, Dhaka' } });
  faults.push({ match: /FROM customers\s+WHERE id = \?1/, times: 1, error: 'D1_ERROR: overloaded' });
  const u1 = await push([u]);
  const u2 = await push([u]);
  check('an error before any write was sent: released and retried, then applied once', [u1.body.data.results[0].status, u2.body.data.results[0].status, one('SELECT address FROM customers WHERE id = ?', custId).address], ['retry', 'applied', 'Uttara, Dhaka']);
  // An update whose answer was lost after saving: repeating it is harmless (same values), so it is retried.
  const u3 = op('update', { collection: 'customers', targetId: custId, base: { values: {} }, data: { address: 'Mirpur, Dhaka' } });
  faults.push({ match: /UPDATE customers/, times: 1, after: true, error: 'D1_ERROR: network connection lost' });
  const v1 = await push([u3]);
  const v2 = await push([u3]);
  check('an update saved but its answer lost: retried (repeating it is harmless), applied, one value', [v1.body.data.results[0].status, v2.body.data.results[0].status, one('SELECT address FROM customers WHERE id = ?', custId).address], ['retry', 'applied', 'Mirpur, Dhaka']);
  // Parts usage is NOT safe to repeat: saved-but-lost is held, the stock moved exactly once.
  const pj = await mkJob(['Inspection', 'In Progress']);
  const stock0 = one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock;
  const pu = op('parts_usage', { targetId: pj, data: { partId: 'PRT-0001', quantity: 3 } });
  faults.push({ match: /DELETE FROM job_card_parts/, times: 1, committed: true, error: 'D1_ERROR: network connection lost' });
  const pr4 = await push([pu]);
  const pr5 = await push([pu]);
  check('parts usage saved but its answer lost: held for review, NOT repeated -- stock moved by exactly 3',
    [pr4.body.data.results[0].type, pr5.body.data.results[0].status, stock0 - one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock], ['interrupted', 'conflict', 3]);
}

/* ---------- E. H3: errors come back as JSON ---------- */
console.log('\n-- E. H3: failures inside sync routes are JSON answers --');
{
  faults.push({ match: /FROM sync_conflicts/, times: 1, error: 'no such table: sync_conflicts' });
  const r = await api('GET', '/api/sync/conflicts', undefined, admin.cookie);
  check('a missing table (0020 not applied): 503 not_migrated, as JSON', [r.status, r.body && r.body.error.code], [503, 'not_migrated']);
  faults.push({ match: /FROM sync_ops WHERE account_id/, times: 1, error: 'D1_ERROR: internal error' });
  const s = await api('GET', `/api/sync/status?deviceId=${devA}`, undefined, advisor.cookie);
  check('a database error: 500 database_error, as JSON (not an uncaught exception)', [s.status, s.body && s.body.error.code], [500, 'database_error']);
}

/* ---------- F. M1: deletes still work ---------- */
console.log('\n-- F. M1: an invoice draft never blocks a delete --');
{
  const received = (await api('POST', '/api/job-cards', jobBody(custId, vehId), advisor.cookie)).body.data.id;
  const d = await push([op('invoice_draft', { tempId: T('DRF'), data: { jobCardId: received, localTotal: 860 } })]);
  const draftId = d.body.data.results[0].serverId;
  const del = await api('DELETE', `/api/job-cards/${received}`, undefined, admin.cookie);
  ok_('a Received job card with a draft is deleted as before; the draft is kept, its link cleared',
    [200, 204].includes(del.status) && JSON.stringify(one('SELECT job_card_id, status FROM invoice_drafts WHERE id = ?', draftId)) === JSON.stringify({ job_card_id: null, status: 'Draft' }), [del.status, del.text]);
  const done = await mkJob(['Inspection', 'In Progress', 'Completed']);
  const nd = (await push([op('invoice_draft', { tempId: T('DRF'), data: { jobCardId: done, localTotal: 780 } })])).body.data.results[0].serverId;
  const fin = await api('POST', `/api/invoice-drafts/${nd}/finalize`, { acceptCurrentPricing: true }, advisor.cookie);
  const inv = fin.body.data.invoice.id;
  await api('POST', `/api/invoices/${inv}/void`, {}, admin.cookie);
  const delInv = await api('DELETE', `/api/invoices/${inv}`, undefined, admin.cookie);
  ok_('an invoice made from a draft can be voided and deleted as before; the draft keeps its history', [200, 204].includes(delInv.status)
    && one('SELECT invoice_id, status FROM invoice_drafts WHERE invoice_id IS NULL AND status = ?', 'Finalized'), delInv.text);
}

/* ---------- G. M2: an Admin cannot exceed the author ---------- */
console.log('\n-- G. M2: an administrator\'s retry is held to what the author may do today --');
{
  const lp = op('payment', { tempId: T('PAY'), data: { customerId: custId, invoiceId: invoice.id, amount: 999999, date: '2026-10-14', method: 'Cash' } });
  const held = await push([lp], leaver.cookie, devL);
  const cid = held.body.data.results[0].conflictId;
  ok_('(a refused payment from another advisor is held)', !!cid, held.body);
  raw.prepare("UPDATE user_accounts SET status = 'Inactive' WHERE id = ?").run(leaver.id);
  const r = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'retry', note: 'Try again for them' }, admin.cookie);
  check('the author was deactivated: an Admin cannot apply it on their behalf', [r.status, r.body.error.reason], [409, 'author_inactive']);
  raw.prepare("UPDATE user_accounts SET status = 'Active' WHERE id = ?").run(leaver.id);
  await api('DELETE', `/api/devices/${devL}`, { reason: 'Lost' }, admin.cookie);
  const r2 = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'retry', note: 'Try again for them' }, admin.cookie);
  check('the author\'s device was revoked: refused', [r2.status, r2.body.error.reason], [409, 'device_revoked']);
  const devC = randomUUID();
  await api('POST', '/api/devices/register', { deviceId: devC }, clerk.cookie);
  const cp = await push([op('create', { collection: 'customers', tempId: 'OFF-ZZ-CUS-0001', data: { name: 'Clerk Made', phone: '01744000001' } })], clerk.cookie, devC);
  const r3 = await api('POST', `/api/sync/conflicts/${cp.body.data.results[0].conflictId}/resolve`, { action: 'retry' }, admin.cookie);
  check('the author\'s role may not create customers: an Admin\'s retry does not create one for them', [r3.status, r3.body.error.reason, count("SELECT COUNT(*) FROM customers WHERE phone = '01744000001'")], [409, 'author_not_permitted', 0]);
  const d = await api('POST', `/api/sync/conflicts/${cp.body.data.results[0].conflictId}/resolve`, { action: 'dismiss' }, admin.cookie);
  check('   ...dismissing it is still possible', d.status, 200);
  const bad = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'dismiss', note: 'x' }, admin.cookie);
  check('   ...and a financial dismissal still needs a reason', bad.status, 422);
}

/* ---------- H. M3: the pull cursor ---------- */
console.log('\n-- H. M3: a pull never skips what it could not read --');
{
  const start = count('SELECT MAX(seq) FROM change_log');
  const a = await api('POST', '/api/customers', { name: 'Pull A', phone: '01755000001' }, admin.cookie);
  const b = await api('POST', '/api/customers', { name: 'Pull B', phone: '01755000002' }, admin.cookie);
  faults.push({ match: /FROM customers\s+WHERE id = \?1/, times: 1, error: 'D1_ERROR: overloaded' });
  const p1 = await api('GET', `/api/sync/pull?deviceId=${devA}&cursor=${start}`, undefined, advisor.cookie);
  ok_('a record that fails to read stops the page: no change for it, the cursor stays before it, "retry later"',
    p1.status === 200 && p1.body.data.retryLater && p1.body.data.cursor < count('SELECT MIN(seq) FROM change_log WHERE seq > ? AND record_id = ?', start, a.body.data.id) + 1
      && !p1.body.data.changes.some((x) => x.id === a.body.data.id), p1.body);
  const p2 = await api('GET', `/api/sync/pull?deviceId=${devA}&cursor=${p1.body.data.cursor}`, undefined, advisor.cookie);
  ok_('   ...the next pull brings both records', p2.body.data.changes.some((x) => x.id === a.body.data.id) && p2.body.data.changes.some((x) => x.id === b.body.data.id), p2.body.data.changes);
  raw.prepare("UPDATE user_accounts SET session_version = session_version + 1 WHERE id = ?").run(clerk.id);
  const expired = await api('GET', `/api/sync/pull?deviceId=${devA}&cursor=0`, undefined, clerk.cookie);
  check('an expired session: 401, nothing returned', expired.status, 401);
  const gone = await api('POST', '/api/payments', { customerId: custId, jobCardId: inProgress, amount: 5, method: 'Cash' }, admin.cookie);
  const s2 = count('SELECT MAX(seq) FROM change_log');
  await api('POST', `/api/payments/${gone.body.data.id}/void`, {}, admin.cookie);
  const devM = randomUUID();
  const mech = { cookie: null };
  raw.exec(`INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0006', 'Mech Test', '01911000006', 'Active', 'T', 'T', '${AT}'); UPDATE id_counters SET last_value = 6 WHERE collection = 'staff';`);
  mech.cookie = (await person(6, 'budget.mech', 'Mechanic')).cookie;
  await api('POST', '/api/devices/register', { deviceId: devM }, mech.cookie);
  raw.prepare("INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('payments', ?, 'delete', ?)").run(gone.body.data.id, AT);
  const t = await api('GET', `/api/sync/pull?deviceId=${devM}&cursor=${s2}`, undefined, mech.cookie);
  ok_('a tombstone for a payment is hidden from a Mechanic (no payments.view)', t.body.data.changes.filter((x) => x.collection === 'payments').every((x) => x.op === 'hidden'), t.body.data.changes);
}

/* ---------- I. M4: parts usage vs an edit made in between ---------- */
console.log('\n-- I. M4: parts usage never overwrites a change made after it read the job card --');
{
  const job = await mkJob(['Inspection', 'In Progress']);
  const stale = await api('PUT', `/api/job-cards/${job}`, { notes: 'x', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }, advisor.cookie);
  check('PUT with an older expectedUpdatedAt: 409 stale_edit, nothing saved', [stale.status, stale.body.error.reason, one('SELECT notes FROM job_cards WHERE id = ?', job).notes || ''], [409, 'stale_edit', '']);
  const plain = await api('PUT', `/api/job-cards/${job}`, { notes: 'unchanged behaviour' }, advisor.cookie);
  check('   ...without it, an edit works exactly as before', plain.status, 200);
  // Someone saves the job card online between the sync's read and its write.
  faults.push({ match: /SELECT[\s\S]*FROM job_card_parts/, times: 1, before: () => raw.prepare("UPDATE job_cards SET notes = 'Edited online meanwhile', updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(job) });
  const use = op('parts_usage', { targetId: job, data: { partId: 'PRT-0001', quantity: 2 } });
  const r1 = await push([use]);
  check('the job card changed in between: the movement waits (retry), nothing overwritten', [r1.body.data.results[0].status, one('SELECT notes FROM job_cards WHERE id = ?', job).notes], ['retry', 'Edited online meanwhile']);
  const r2 = await push([use]);
  check('   ...next time it applies on the fresh lines: both the online edit and the parts are there',
    [r2.body.data.results[0].status, one('SELECT notes FROM job_cards WHERE id = ?', job).notes, one("SELECT qty FROM job_card_parts WHERE job_card_id = ? AND part_id = 'PRT-0001'", job).qty], ['applied', 'Edited online meanwhile', 2]);
}

/* ---------- J. M5 ---------- */
console.log('\n-- J. M5: mechanics added through Staff Management --');
{
  const before = count('SELECT MAX(seq) FROM change_log');
  const m = await api('POST', '/api/staff', { name: 'New Mechanic', phone: '01766000001', designation: 'Mechanic', department: 'Workshop', joiningDate: '2025-01-15', isMechanic: true, specialization: 'Engines' });
  ok_('a mechanic created through Staff is in the change log, so devices re-read mechanics', m.status === 201 && count("SELECT COUNT(*) FROM change_log WHERE seq > ? AND collection = 'mechanics'", before) >= 1, m.text);
}

/* ---------- K ---------- */
console.log('\n-- K. a device someone else registered --');
{
  const r = await push([op('create', { collection: 'customers', tempId: 'OFF-Q-CUS-0001', data: { name: 'Borrowed', phone: '01777000001' } })], advisor.cookie, devL);
  check('pushing through a device this person never registered: refused, nothing created', [r.status, r.body.error.reason, count("SELECT COUNT(*) FROM customers WHERE phone = '01777000001'")], [409, 'device_not_registered', 0]);
}

console.log(`\n(D1 Free plan: ${FREE_PLAN_LIMIT} queries per request; server target ${REQUEST_QUERY_TARGET}; this suite's ceiling ${SAFE}.)`);
console.log(`\nSync budget unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
