/* Offline sync (0020) — unit tests against the REAL Worker.

   The handlers run against an in-memory SQLite database built from the real
   migrations, through the real auth gate, with real account sessions. Every
   name is a fictional test value.

   What must hold:
     A. Migration: additive; the Admin role gains sync.view / sync.manage;
        triggers fill the change log (and a deleted record leaves a tombstone).
     B. Devices: only a personal account registers one; codes are short and
        unique; the journal escrow is per account AND device; revoking is an
        administrator's (or the owner's own); a revoked device can neither
        register, push nor pull.
     C. Push: temporary references are resolved to server ids in dependency
        order; a repeated operation UUID is answered from the record, never
        applied twice; an operation id reused by another device is refused;
        a dependency not yet received is retried, one the server refused
        becomes a dependency conflict.
     D. Payments (PENDING): applied only through the payments route; a
        possible duplicate and an overpayment become FINANCIAL conflicts and
        no money moves; only sync.manage resolves, and a note is required.
     E. Invoices (DRAFT): no invoice and no number offline; finalization is
        online, permission-checked, and stops on a pricing change.
     F. Parts usage (FLAG): applied through the job card's own stock rules;
        a shortage is flagged for review and stock is never overwritten;
        retried after stock arrives.
     G. Edits: field-level; a clash with someone else's change is a conflict
        (no last-write-wins); a change to a different field applies.
     H. Pull: a server cursor, tombstones, pages, records the role may not
        read are hidden.
     I. An interrupted operation becomes a review conflict, never a re-post.
     J. Permissions: a role that may not create is refused through the route
        and the refusal is kept as a conflict.
     K. The session tells a personal account the server time and cursor.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */

import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { deviceCode } from '../../src/routes/sync.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, Number(process.env.DETAIL || 700))}`);
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nSync unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';
const PW2 = 'Own-Chosen-Pass-77';
const AT = '2026-10-08T00:00:00Z';

function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  return {
    raw, prepare: (sql) => new Stmt(sql),
    async batch(list) { raw.exec('BEGIN'); try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
  };
}

const DB = makeD1();
const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
const count = (sql, ...a) => Number(Object.values(one(sql, ...a))[0]);
const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const api = async (method, path, body, cred = 'token') => {
  const headers = {};
  if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`;
  else if (cred !== 'none') headers.cookie = cred;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await worker.fetch(new Request('http://worker.local' + path, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, ctx);
  const text = await res.text();
  await Promise.all(pending.splice(0));
  let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};

DB.raw.exec(`
  INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES
    ('STF-0001', 'Admin Test', '01911000001', 'Active', 'Test', 'Test', '${AT}'),
    ('STF-0002', 'Advisor Test', '01911000002', 'Active', 'Test', 'Test', '${AT}'),
    ('STF-0003', 'Mechanic Test', '01911000003', 'Active', 'Test', 'Test', '${AT}'),
    ('STF-0004', 'Clerk Test', '01911000004', 'Active', 'Test', 'Test', '${AT}');
  UPDATE id_counters SET last_value = 4 WHERE collection = 'staff';
  INSERT INTO services (id, name, category, price, status, created_at) VALUES ('SRV-0001', 'Test Service', 'General', 500, 'Active', '${AT}');
  UPDATE id_counters SET last_value = 1 WHERE collection = 'services';
  INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0001', 'Bench Mechanic', '01911000099', 'Active', '${AT}');
  UPDATE id_counters SET last_value = 1 WHERE collection = 'mechanics';
  INSERT INTO parts (id, name, part_no, category, unit, purchase_price, selling_price, stock, min_stock, status, created_at)
    VALUES ('PRT-0001', 'Test Filter', 'TF-1', 'Filters', 'pcs', 100, 150, 5, 1, 'Active', '${AT}');
  UPDATE id_counters SET last_value = 1 WHERE collection = 'parts';`);

async function person(n, username, role) {
  const made = await api('POST', '/api/accounts', { staffId: `STF-000${n}`, username, role, password: PW });
  if (made.status !== 201) throw new Error(`could not create ${username}: ${made.text}`);
  const s = await api('POST', '/api/session', { username, password: PW }, 'none');
  const changed = await api('POST', '/api/session/password', { currentPassword: PW, newPassword: PW2 }, s.cookie);
  if (changed.status !== 204) throw new Error(`could not change ${username}'s password: ${changed.text}`);
  return { id: made.body.data.id, cookie: changed.cookie };
}

console.log('=== Offline sync (0020) against an in-memory database ===');

/* ---------- A. migration ---------- */
console.log('\n-- A. migration --');
{
  const sql = readFileSync(join(ROOT, 'migrations', '0020_offline_sync.sql'), 'utf8').replace(/--.*$/gm, '');
  ok_('the migration is additive: no DROP, DELETE, ALTER or UPDATE of anything that existed', !/\b(DROP|ALTER)\b/i.test(sql) && !/^\s*(DELETE|UPDATE)\b/im.test(sql.replace(/BEGIN[\s\S]*?END;/g, '')));
  ok_('   ...and creates NO triggers: D1 counts trigger-written rows in meta.changes, which the write guards depend on', !/CREATE\s+TRIGGER/i.test(sql));
  ok_('   ...it applies twice without error (IF NOT EXISTS / OR IGNORE throughout)', (() => { try { DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0020_offline_sync.sql'), 'utf8')); return true; } catch (e) { return false; } })());
  check('the Admin role gains sync.view and sync.manage (owner decision: Admins resolve conflicts)',
    DB.raw.prepare("SELECT permission FROM role_permissions WHERE role_id = 'ROL-0002' AND permission LIKE 'sync.%' ORDER BY permission").all().map((r) => r.permission), ['sync.manage', 'sync.view']);
  check('   ...no other role gains them', count("SELECT COUNT(*) FROM role_permissions WHERE role_id <> 'ROL-0002' AND permission LIKE 'sync.%'"), 0);
  check('device codes: 1 A, 26 Z, 27 AA, 703 AAA', [deviceCode(1), deviceCode(26), deviceCode(27), deviceCode(703)], ['A', 'Z', 'AA', 'AAA']);
}

const admin = await person(1, 'sync.admin', 'Admin');
const advisor = await person(2, 'sync.advisor', 'Service Advisor');
const mech = await person(3, 'sync.mech', 'Mechanic');
const clerk = await person(4, 'sync.clerk', 'Staff');

{
  const before = count('SELECT COUNT(*) FROM change_log');
  const c = await api('POST', '/api/customers', { name: 'Log Test', phone: '01700009001' });
  ok_('a write through an existing route still answers as before (201) and logs one change', c.status === 201 && count("SELECT COUNT(*) FROM change_log WHERE collection = 'customers' AND record_id = ?", c.body.data.id) === 1 && count('SELECT COUNT(*) FROM change_log') > before, c.text);
  await api('DELETE', `/api/customers/${c.body.data.id}`);
  check('   ...and a delete leaves a tombstone', one("SELECT op FROM change_log WHERE record_id = ? ORDER BY seq DESC LIMIT 1", c.body.data.id).op, 'delete');
}

/* ---------- K. session ---------- */
console.log('\n-- K. session --');
{
  const s = await api('GET', '/api/session', undefined, advisor.cookie);
  ok_('a personal account is told the server time and the change-log cursor', typeof s.body.data.serverTime === 'string' && Number.isInteger(s.body.data.syncCursor) && s.body.data.syncCursor > 0, s.body.data);
  const p = await api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none');
  const ps = await api('GET', '/api/session', undefined, p.cookie);
  ok_('   ...the shared passphrase is not (it has no device or person to sync for)', ps.body.data.authenticated && ps.body.data.syncCursor === undefined, ps.body.data);
}

/* ---------- B. devices ---------- */
console.log('\n-- B. devices --');
const devA = randomUUID();
const devB = randomUUID();
let codeA, codeB, escrowA;
{
  const t = await api('POST', '/api/devices/register', { deviceId: devA });
  check('the machine token cannot register a device (a device belongs to a person)', [t.status, t.body.error.code], [403, 'account_required']);
  const bad = await api('POST', '/api/devices/register', { deviceId: 'not-a-uuid' }, advisor.cookie);
  check('a device id must be a UUID', bad.status, 422);
  const a = await api('POST', '/api/devices/register', { deviceId: devA, label: 'Front desk' }, advisor.cookie);
  ok_('Computer A registers: a short code, the server time, a 14-day window and an escrow key', a.status === 201 && /^[A-Z]+$/.test(a.body.data.code) && a.body.data.offlineDays === 14
    && Date.parse(a.body.data.offlineUntil) - Date.parse(a.body.data.serverTime) === 14 * 86400000 && typeof a.body.data.escrow === 'string', a.body);
  codeA = a.body.data.code; escrowA = a.body.data.escrow;
  const again = await api('POST', '/api/devices/register', { deviceId: devA }, advisor.cookie);
  check('   ...registering again keeps the same code and the same escrow', [again.status, again.body.data.code, again.body.data.escrow], [200, codeA, escrowA]);
  const other = await api('POST', '/api/devices/register', { deviceId: devA }, mech.cookie);
  ok_('   ...another person on the same computer gets a different escrow (it is per person AND device)', other.body.data.escrow !== escrowA && other.body.data.code === codeA);
  const b = await api('POST', '/api/devices/register', { deviceId: devB, label: 'Workshop' }, mech.cookie);
  codeB = b.body.data.code;
  ok_('Computer B gets its own code', codeB && codeB !== codeA, [codeA, codeB]);
  const listMech = await api('GET', '/api/devices', undefined, mech.cookie);
  const listAdmin = await api('GET', '/api/devices', undefined, admin.cookie);
  ok_('a person sees the devices they used; an Admin (sync.view) sees every device', listMech.body.data.length === 2 && listAdmin.body.data.length === 2
    && listMech.body.data.every((d) => d.accounts.every((x) => x.accountId === mech.id)), listMech.body.data);
}

/* ---------- C. push: temporary references, idempotency ---------- */
console.log('\n-- C. push --');
const op = (kind, fields) => ({ opId: randomUUID(), kind, createdAt: new Date().toISOString(), ...fields });
const push = (cookie, deviceId, ops) => api('POST', '/api/sync/push', { deviceId, ops }, cookie);
const T = (code, prefix, n) => `OFF-${code}-${prefix}-${String(n).padStart(4, '0')}`;
let custA, vehA, jobA;
{
  const customers0 = count('SELECT COUNT(*) FROM customers');
  const cOp = op('create', { collection: 'customers', tempId: T(codeA, 'CUS', 1), data: { name: 'Offline Customer A', phone: '01700009101' } });
  const vOp = op('create', { collection: 'vehicles', tempId: T(codeA, 'VEH', 1), data: { customerId: T(codeA, 'CUS', 1), regNo: 'DHAKA-TEST-11', brand: 'Toyota', model: 'Axio' } });
  const jOp = op('create', { collection: 'jobCards', tempId: T(codeA, 'JOB', 1), data: { customerId: T(codeA, 'CUS', 1), vehicleId: T(codeA, 'VEH', 1), mechanicId: 'MEC-0001', date: '2026-10-09',
    complaint: 'Offline test', services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 1, unitPrice: 500 }], status: 'Received' } });
  const r = await push(advisor.cookie, devA, [cOp, vOp, jOp]);
  ok_('Computer A pushes a customer, a vehicle and a job card that refer to each other by temporary reference', r.status === 200 && r.body.data.results.every((x) => x.status === 'applied'), r.body);
  [custA, vehA, jobA] = r.body.data.results.map((x) => x.serverId);
  ok_('   ...the server gave official ids, and stored no temporary reference as a key', /^CUS-\d{4}$/.test(custA) && /^VEH-\d{4}$/.test(vehA) && /^JOB-\d{4}$/.test(jobA)
    && count("SELECT COUNT(*) FROM customers WHERE id LIKE 'OFF-%'") === 0, [custA, vehA, jobA]);
  check('   ...the references were rewritten to those ids', [one('SELECT customer_id FROM vehicles WHERE id = ?', vehA).customer_id, one('SELECT customer_id, vehicle_id FROM job_cards WHERE id = ?', jobA)],
    [custA, { customer_id: custA, vehicle_id: vehA }]);
  check('   ...the temporary reference is kept for audit in the sync journal', one('SELECT temp_id, result_id, account_id, device_id FROM sync_ops WHERE op_id = ?', cOp.opId),
    { temp_id: T(codeA, 'CUS', 1), result_id: custA, account_id: advisor.id, device_id: devA });
  const again = await push(advisor.cookie, devA, [cOp, vOp, jOp]);
  ok_('the same operations pushed again (a lost answer, a retry): answered from the record, nothing applied twice',
    again.body.data.results.every((x) => x.status === 'applied' && x.replayed) && count('SELECT COUNT(*) FROM customers') === customers0 + 1, again.body);
  const reuse = await push(mech.cookie, devB, [cOp]);
  check('   ...the same operation id from another device or person is refused', [reuse.body.data.results[0].status, reuse.body.data.results[0].reason], ['rejected', 'op_id_reused']);
  const orphan = await push(advisor.cookie, devA, [op('create', { collection: 'vehicles', tempId: T(codeA, 'VEH', 9), data: { customerId: T(codeA, 'CUS', 9), regNo: 'DHAKA-TEST-19', brand: 'X', model: 'Y' } })]);
  check('a change whose dependency has not arrived yet is retried later, not applied and not lost', [orphan.body.data.results[0].status, orphan.body.data.results[0].reason], ['retry', 'dependency_pending']);
  check('   ...and leaves no claim behind', count("SELECT COUNT(*) FROM sync_ops WHERE temp_id = ?", T(codeA, 'VEH', 9)), 0);
  const badCust = op('create', { collection: 'customers', tempId: T(codeA, 'CUS', 2), data: { name: '', phone: '' } });
  const depVeh = op('create', { collection: 'vehicles', tempId: T(codeA, 'VEH', 2), data: { customerId: T(codeA, 'CUS', 2), regNo: 'DHAKA-TEST-12', brand: 'X', model: 'Y' } });
  const dep = await push(advisor.cookie, devA, [badCust, depVeh]);
  check('a refused record becomes a conflict, and what depends on it a dependency conflict', dep.body.data.results.map((x) => [x.status, x.type]), [['conflict', 'validation'], ['conflict', 'dependency']]);
  const cantShape = await push(advisor.cookie, devA, [{ opId: randomUUID(), kind: 'create', collection: 'accounts', data: { username: 'x' } }]);
  check('user accounts (and roles) cannot be created offline', [cantShape.body.data.results[0].status, cantShape.body.data.results[0].reason], ['rejected', 'invalid_op']);
}

/* ---------- J. permissions ---------- */
console.log('\n-- J. permissions --');
{
  const devC = randomUUID();
  await api('POST', '/api/devices/register', { deviceId: devC }, clerk.cookie);
  const r = await push(clerk.cookie, devC, [op('create', { collection: 'customers', tempId: 'OFF-Z-CUS-0001', data: { name: 'Not Allowed', phone: '01700009199' } })]);
  check('a role without customers.create is refused by the customers route itself; the refusal is kept as a permission conflict',
    [r.body.data.results[0].status, r.body.data.results[0].type, count("SELECT COUNT(*) FROM customers WHERE name = 'Not Allowed'")], ['conflict', 'permission', 0]);
  const res = await api('POST', `/api/sync/conflicts/${r.body.data.results[0].conflictId}/resolve`, { action: 'dismiss' }, mech.cookie);
  check('   ...a Mechanic cannot resolve conflicts (sync.manage)', res.status, 403);
  const mine = await api('GET', '/api/sync/conflicts', undefined, clerk.cookie);
  ok_('   ...a person sees their own conflicts only; an Admin sees all', mine.body.data.length === 1 && (await api('GET', '/api/sync/conflicts', undefined, admin.cookie)).body.data.length >= 3, mine.body.data.length);
}

/* ---------- D. payments ---------- */
console.log('\n-- D. payments (pending until the server accepts) --');
let invoiceId;
{
  // An invoice to pay against, made online by the advisor: total 500.
  const jp = await api('POST', '/api/job-cards', { customerId: custA, vehicleId: vehA, mechanicId: 'MEC-0001', date: '2026-10-10', complaint: 'Online job',
    services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 1, unitPrice: 500 }], status: 'Received' }, advisor.cookie);
  if (jp.status !== 201) throw new Error(jp.text);
  for (const st of ['Inspection', 'In Progress', 'Completed']) await api('POST', `/api/job-cards/${jp.body.data.id}/status`, { status: st }, advisor.cookie);
  const inv = await api('POST', '/api/invoices', { jobCardId: jp.body.data.id }, advisor.cookie);
  if (inv.status !== 201) throw new Error(inv.text);
  invoiceId = inv.body.data.id;
  const before = one('SELECT paid, due, status FROM invoices WHERE id = ?', invoiceId);
  const pay = op('payment', { tempId: T(codeB, 'PAY', 1), data: { customerId: custA, invoiceId, amount: 200, date: '2026-10-10', method: 'Cash', reference: 'RCPT-77', notes: 'Paid at the counter' } });
  check('the invoice is unpaid before the payment reaches the server', [before.paid, before.status], [0, 'Unpaid']);
  const devBAdvisor = await api('POST', '/api/devices/register', { deviceId: devB }, advisor.cookie);
  ok_('(the advisor also uses Computer B)', devBAdvisor.status === 200);
  const r = await push(advisor.cookie, devB, [pay]);
  const p = r.body.data.results[0];
  ok_('a pending payment is applied through the payments route: an official PAY id, and the invoice balance moves only now', p.status === 'applied' && /^PAY-\d{4}$/.test(p.serverId)
    && one('SELECT paid, due FROM invoices WHERE id = ?', invoiceId).paid === 200, p);
  ok_('   ...amount, method, date, reference and the device\'s temporary reference are preserved', (() => {
    const row = one('SELECT amount, method, date, notes FROM payments WHERE id = ?', p.serverId);
    return row.amount === 200 && row.method === 'Cash' && row.date === '2026-10-10' && /RCPT-77/.test(row.notes) && row.notes.includes(T(codeB, 'PAY', 1));
  })(), one('SELECT * FROM payments WHERE id = ?', p.serverId));
  const replay = await push(advisor.cookie, devB, [pay]);
  check('   ...pushed again: replayed, still ONE payment', [replay.body.data.results[0].replayed, count('SELECT COUNT(*) FROM payments WHERE invoice_id = ?', invoiceId)], [true, 1]);
  const dup = op('payment', { tempId: T(codeA, 'PAY', 1), data: { customerId: custA, invoiceId, amount: 200, date: '2026-10-10', method: 'Cash' } });
  const d = await push(advisor.cookie, devA, [dup]);
  check('the same money recorded on another device is held as a FINANCIAL duplicate conflict, not applied',
    [d.body.data.results[0].status, d.body.data.results[0].type, count('SELECT COUNT(*) FROM payments WHERE invoice_id = ?', invoiceId), one('SELECT paid FROM invoices WHERE id = ?', invoiceId).paid], ['conflict', 'duplicate', 1, 200]);
  const over = op('payment', { tempId: T(codeA, 'PAY', 2), data: { customerId: custA, invoiceId, amount: 999, date: '2026-10-11', method: 'Card' } });
  const o = await push(advisor.cookie, devA, [over]);
  check('an overpayment is refused by the payments route and kept as a payment conflict', [o.body.data.results[0].status, o.body.data.results[0].type, one('SELECT paid FROM invoices WHERE id = ?', invoiceId).paid], ['conflict', 'payment', 200]);
  const cid = d.body.data.results[0].conflictId;
  const c = await api('GET', `/api/sync/conflicts/${cid}`, undefined, admin.cookie);
  ok_('the conflict shows type, severity, device, person, the local values, the server\'s and the actions available',
    c.body.data.severity === 'financial' && c.body.data.deviceCode === codeA && c.body.data.username === 'sync.advisor' && c.body.data.details.local.amount === 200
    && c.body.data.details.server.id && JSON.stringify(c.body.data.actions) === '["apply_anyway","dismiss"]' && c.body.data.history.length === 1, c.body.data);
  const noNote = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'dismiss' }, admin.cookie);
  check('   ...a financial conflict needs a note to resolve', noNote.status, 422);
  const res = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'dismiss', note: 'Same receipt, entered twice' }, admin.cookie);
  ok_('   ...an Admin dismisses it: resolved, audited, the payment never applied, the operation kept as dismissed',
    res.status === 200 && res.body.data.status === 'Resolved' && res.body.data.resolution === 'dismiss' && count('SELECT COUNT(*) FROM payments WHERE invoice_id = ?', invoiceId) === 1
    && one('SELECT status FROM sync_ops WHERE op_id = ?', dup.opId).status === 'dismissed', res.body);
  const told = await push(advisor.cookie, devA, [dup]);
  check('   ...and the device learns it on its next sync (dismissed; kept, never silently deleted)', told.body.data.results[0].status, 'dismissed');
  const twice = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'dismiss', note: 'again' }, admin.cookie);
  check('   ...a resolved conflict cannot be resolved again', twice.status, 409);
  const hist = await api('GET', `/api/sync/conflicts/${cid}`, undefined, admin.cookie);
  check('   ...the history holds raised and dismissed', hist.body.data.history.map((h) => h.action), ['raised', 'dismiss']);
}

/* ---------- E. invoice drafts ---------- */
console.log('\n-- E. invoices (draft offline, finalized online) --');
{
  const jOp = op('create', { collection: 'jobCards', tempId: T(codeA, 'JOB', 2), data: { customerId: custA, vehicleId: vehA, mechanicId: 'MEC-0001', date: '2026-10-12', complaint: 'Second offline job',
    services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 2, unitPrice: 500 }], status: 'Received' } });
  const dOp = op('invoice_draft', { tempId: T(codeA, 'DRF', 1), data: { jobCardId: T(codeA, 'JOB', 2), date: '2026-10-12', notes: 'Drafted offline', localTotal: 1000, lines: { services: 1 } } });
  const invoices0 = count('SELECT COUNT(*) FROM invoices');
  const r = await push(advisor.cookie, devA, [jOp, dOp]);
  const draftId = r.body.data.results[1].serverId;
  ok_('an invoice made offline arrives as a DRAFT: no invoice, no INV number, the job card not invoiced',
    r.body.data.results.every((x) => x.status === 'applied') && /^DRF-\d{4}$/.test(draftId) && count('SELECT COUNT(*) FROM invoices') === invoices0
    && one('SELECT invoice_id FROM job_cards WHERE id = ?', r.body.data.results[0].serverId).invoice_id === null, r.body);
  const jobId = r.body.data.results[0].serverId;
  check('   ...the draft keeps its temporary reference, device and author', [one('SELECT status, temp_ref, device_id, created_by FROM invoice_drafts WHERE id = ?', draftId)],
    [{ status: 'Draft', temp_ref: T(codeA, 'DRF', 1), device_id: devA, created_by: advisor.id }]);
  const mechTry = await api('POST', `/api/invoice-drafts/${draftId}/finalize`, {}, mech.cookie);
  check('a Mechanic (no invoices.create) cannot finalize it', mechTry.status, 403);
  // Pricing changes online before finalization.
  await api('PUT', `/api/job-cards/${jobId}`, { services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 3, unitPrice: 500 }] }, advisor.cookie);
  for (const st of ['Inspection', 'In Progress', 'Completed']) await api('POST', `/api/job-cards/${jobId}/status`, { status: st }, advisor.cookie);
  const stop = await api('POST', `/api/invoice-drafts/${draftId}/finalize`, {}, advisor.cookie);
  check('a pricing change since the draft stops finalization for review', [stop.status, stop.body.error.reason, stop.body.error.draftTotal, stop.body.error.currentTotal], [409, 'pricing_changed', 1000, 1500]);
  const fin = await api('POST', `/api/invoice-drafts/${draftId}/finalize`, { acceptCurrentPricing: true }, advisor.cookie);
  ok_('   ...finalized with the current pricing: the server creates the invoice with its official number',
    fin.status === 200 && /^INV-\d{4}$/.test(fin.body.data.invoice.id) && fin.body.data.invoice.total === 1500 && fin.body.data.draft.status === 'Finalized' && fin.body.data.draft.invoiceId === fin.body.data.invoice.id, fin.body);
  const again = await api('POST', `/api/invoice-drafts/${draftId}/finalize`, { acceptCurrentPricing: true }, advisor.cookie);
  check('   ...a finalized draft cannot be finalized again (no second invoice)', [again.status, count('SELECT COUNT(*) FROM invoices') - invoices0], [409, 1]);
  const mechDraft = await push(mech.cookie, devB, [op('invoice_draft', { tempId: T(codeB, 'DRF', 1), data: { jobCardId: jobA, localTotal: 500 } })]);
  check('a role that may not create invoices cannot make a draft either (kept as a conflict)', [mechDraft.body.data.results[0].status, mechDraft.body.data.results[0].type], ['conflict', 'permission']);
}

/* ---------- F. parts usage ---------- */
console.log('\n-- F. parts usage (applied through the job card, flagged when short) --');
{
  for (const st of ['Inspection', 'In Progress']) await api('POST', `/api/job-cards/${jobA}/status`, { status: st }, advisor.cookie);
  check('(job card in progress, stock 5)', [one('SELECT status FROM job_cards WHERE id = ?', jobA).status, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock], ['In Progress', 5]);
  const use3 = op('parts_usage', { targetId: jobA, data: { partId: 'PRT-0001', quantity: 3 } });
  const r = await push(advisor.cookie, devA, [use3]);
  check('offline usage of 3 is applied through the job card: stock 5 -> 2, one ledger movement, the line priced from the server',
    [r.body.data.results[0].status, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock,
      count("SELECT COUNT(*) FROM inventory_transactions WHERE part_id = 'PRT-0001' AND reference_id = ?", jobA), one("SELECT qty, unit_price FROM job_card_parts WHERE job_card_id = ? AND part_id = 'PRT-0001'", jobA)],
    ['applied', 2, 1, { qty: 3, unit_price: 150 }]);
  const mv = one('SELECT * FROM offline_stock_movements WHERE op_id = ?', use3.opId);
  ok_('   ...recorded append-only: part, job card, quantity, type, person, device, local and server time, status Applied',
    mv && mv.part_id === 'PRT-0001' && mv.job_card_id === jobA && mv.quantity === 3 && mv.type === 'job-card-use' && mv.account_id === advisor.id && mv.device_id === devA
    && mv.local_created_at && mv.received_at && mv.status === 'Applied', mv);
  const use4 = op('parts_usage', { targetId: jobA, data: { partId: 'PRT-0001', quantity: 4 } });
  const short = await push(advisor.cookie, devA, [use4]);
  check('usage of 4 more with 2 in stock: flagged as an INVENTORY conflict; stock untouched, the job card unchanged, the movement under review',
    [short.body.data.results[0].status, short.body.data.results[0].type, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock,
      one("SELECT qty FROM job_card_parts WHERE job_card_id = ? AND part_id = 'PRT-0001'", jobA).qty, one('SELECT status FROM offline_stock_movements WHERE op_id = ?', use4.opId).status],
    ['conflict', 'inventory', 2, 3, 'Review']);
  const cid = short.body.data.results[0].conflictId;
  const c = await api('GET', `/api/sync/conflicts/${cid}`, undefined, admin.cookie);
  ok_('   ...the conflict carries the shortage the server reported', c.body.data.severity === 'inventory' && c.body.data.details.answer.shortages && c.body.data.details.answer.shortages[0].available === 2, c.body.data.details);
  const early = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'retry', note: 'Trying again' }, admin.cookie);
  check('   ...retried before stock arrives: still refused, still open, the attempt recorded', [early.status, one('SELECT status FROM sync_conflicts WHERE id = ?', cid).status,
    count("SELECT COUNT(*) FROM sync_conflict_events WHERE conflict_id = ? AND action = 'retry_failed'", cid)], [409, 'Open', 1]);
  await api('POST', '/api/inventory-transactions', { partId: 'PRT-0001', type: 'purchase', quantity: 10, unitCost: 100 });
  const late = await api('POST', `/api/sync/conflicts/${cid}/resolve`, { action: 'retry', note: 'Stock received from supplier' }, admin.cookie);
  check('   ...after 10 are received: retried by an Admin, applied (12 -> 8), the movement Applied',
    [late.status, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock, one("SELECT qty FROM job_card_parts WHERE job_card_id = ? AND part_id = 'PRT-0001'", jobA).qty,
      one('SELECT status FROM offline_stock_movements WHERE op_id = ?', use4.opId).status, one('SELECT status FROM sync_ops WHERE op_id = ?', use4.opId).status], [200, 8, 7, 'Applied', 'applied']);
  const ret = await push(advisor.cookie, devA, [op('parts_usage', { targetId: jobA, data: { partId: 'PRT-0001', quantity: -2 } })]);
  check('a return of 2 offline goes back through the same rules (8 -> 10)', [ret.body.data.results[0].status, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock], ['applied', 10]);
  const ledger = DB.raw.prepare("SELECT SUM(CASE WHEN type IN ('purchase','adjustment-in','return','initial-stock') THEN quantity ELSE -quantity END) AS net FROM inventory_transactions WHERE part_id = 'PRT-0001'").get().net;
  check('   ...the ledger still explains the stock exactly (5 opening + movements = 10)', 5 + ledger, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock);
  const mechUse = await push(mech.cookie, devB, [op('parts_usage', { targetId: jobA, data: { partId: 'PRT-0001', quantity: 1 } })]);
  check('a Mechanic (no job_cards.edit) cannot change parts on a job card offline either: a permission conflict, stock unchanged',
    [mechUse.body.data.results[0].status, mechUse.body.data.results[0].type, one("SELECT stock FROM parts WHERE id = 'PRT-0001'").stock], ['conflict', 'permission', 10]);
  const st = await push(mech.cookie, devB, [op('status', { targetId: jobA, base: { status: 'In Progress' }, data: { status: 'Completed' } })]);
  check('   ...but may move the job card\'s status (job_cards.manage), offline as online', [st.body.data.results[0].status, one('SELECT status FROM job_cards WHERE id = ?', jobA).status], ['applied', 'Completed']);
  const stale = await push(advisor.cookie, devA, [op('status', { targetId: jobA, base: { status: 'In Progress' }, data: { status: 'Waiting for Parts' } })]);
  check('   ...a status change made offline from a status the job has since left is a conflict (no last-write-wins)', [stale.body.data.results[0].status, stale.body.data.results[0].type], ['conflict', 'edit']);
}

/* ---------- G. edits ---------- */
console.log('\n-- G. edits (field by field) --');
{
  const cur = (await api('GET', `/api/customers/${custA}`)).body.data;
  await api('PUT', `/api/customers/${custA}`, { address: 'Changed online' }, admin.cookie);
  const other = await push(advisor.cookie, devA, [op('update', { collection: 'customers', targetId: custA, base: { values: { notes: cur.notes } }, data: { notes: 'Prefers morning calls' } })]);
  check('a device changed notes while someone else changed the address: no clash, applied, both kept',
    [other.body.data.results[0].status, one('SELECT notes, address FROM customers WHERE id = ?', custA)], ['applied', { notes: 'Prefers morning calls', address: 'Changed online' }]);
  await api('PUT', `/api/customers/${custA}`, { email: 'online@example.test' }, admin.cookie);
  const clash = await push(mech.cookie, devB, [op('update', { collection: 'customers', targetId: custA, base: { values: { email: cur.email } }, data: { email: 'offline@example.test' } })]);
  const cl = clash.body.data.results[0];
  check('a Mechanic (no customers.edit) changing an e-mail offline: a permission conflict, nothing applied',
    [cl.status, cl.type, one('SELECT email FROM customers WHERE id = ?', custA).email], ['conflict', 'permission', 'online@example.test']);
  const clash2 = await push(advisor.cookie, devA, [op('update', { collection: 'customers', targetId: custA, base: { values: { email: cur.email } }, data: { email: 'offline@example.test' } })]);
  const c2 = clash2.body.data.results[0];
  check('both changed the e-mail: a conflict (no last-write-wins); the server keeps its value until an Admin decides', [c2.status, one('SELECT email FROM customers WHERE id = ?', custA).email], ['conflict', 'online@example.test']);
  const detail = (await api('GET', `/api/sync/conflicts/${c2.conflictId}`, undefined, admin.cookie)).body.data;
  check('   ...the conflict shows the device\'s value, the server\'s, and what both started from',
    [c2.type, detail.details.local, detail.details.server, detail.details.base, detail.actions], ['edit', { email: 'offline@example.test' }, { email: 'online@example.test' }, { email: '' }, ['apply_local', 'keep_server', 'retry']]);
  const res = await api('POST', `/api/sync/conflicts/${c2.conflictId}/resolve`, { action: 'apply_local', note: 'Customer confirmed the new address' }, admin.cookie);
  check('   ...an Admin applies the device\'s value', [res.status, one('SELECT email FROM customers WHERE id = ?', custA).email, res.body.data.resolution], [200, 'offline@example.test', 'apply_local']);
}

/* ---------- H. pull ---------- */
console.log('\n-- H. pull (server cursor, tombstones, pages) --');
{
  const start = (await api('GET', '/api/session', undefined, mech.cookie)).body.data.syncCursor;
  const made = await api('POST', '/api/customers', { name: 'Pulled Customer', phone: '01700009301' }, admin.cookie);
  const gone = await api('POST', '/api/customers', { name: 'Deleted Customer', phone: '01700009302' }, admin.cookie);
  await api('DELETE', `/api/customers/${gone.body.data.id}`, undefined, admin.cookie);
  await api('POST', '/api/payments', { customerId: custA, jobCardId: jobA, amount: 50, method: 'Cash' }, admin.cookie);
  const p = await api('GET', `/api/sync/pull?deviceId=${devB}&cursor=${start}`, undefined, mech.cookie);
  const byId = Object.fromEntries(p.body.data.changes.map((c) => [`${c.collection}:${c.id}`, c]));
  ok_('Computer B pulls from its cursor: the new customer with its record', byId[`customers:${made.body.data.id}`] && byId[`customers:${made.body.data.id}`].record.name === 'Pulled Customer', p.body);
  check('   ...the deleted one as a tombstone', byId[`customers:${gone.body.data.id}`] && byId[`customers:${gone.body.data.id}`].op, 'delete');
  ok_('   ...a payment the Mechanic may not read is hidden (no record)', p.body.data.changes.filter((c) => c.collection === 'payments').every((c) => c.op === 'hidden' && !c.record), p.body.data.changes.filter((c) => c.collection === 'payments'));
  check('   ...and what the payment also moved is a "refresh" -- the job card, which the Mechanic may read; the invoices, which it may not, hidden',
    ['jobCards', 'invoices'].map((col) => (p.body.data.changes.find((c) => c.collection === col && c.id === '*') || {}).op), ['refresh', 'hidden']);
  ok_('   ...the cursor is a server sequence number and only moves forward', p.body.data.cursor > start && !p.body.data.hasMore);
  const empty = await api('GET', `/api/sync/pull?deviceId=${devB}&cursor=${p.body.data.cursor}`, undefined, mech.cookie);
  check('   ...pulling from the new cursor returns nothing new', [empty.body.data.changes.length, empty.body.data.cursor], [0, p.body.data.cursor]);
  const page1 = await api('GET', `/api/sync/pull?deviceId=${devB}&cursor=0&limit=5`, undefined, mech.cookie);
  const page2 = await api('GET', `/api/sync/pull?deviceId=${devB}&cursor=${page1.body.data.cursor}&limit=5`, undefined, mech.cookie);
  ok_('   ...in pages: hasMore, and the next page starts after the last', page1.body.data.hasMore && page2.body.data.changes.every((c) => c.seq > page1.body.data.cursor), [page1.body.data.cursor, page2.body.data.changes.map((c) => c.seq)]);
  const noDev = await api('GET', '/api/sync/pull?cursor=0', undefined, mech.cookie);
  check('   ...a pull names its device', noDev.status, 422);
}

/* ---------- I. interrupted ---------- */
console.log('\n-- I. an operation cut off mid-way --');
{
  const lost = op('payment', { tempId: T(codeA, 'PAY', 7), data: { customerId: custA, jobCardId: jobA, amount: 75, date: '2026-10-13', method: 'Cash' } });
  DB.raw.prepare(`INSERT INTO sync_ops (op_id, device_id, account_id, kind, collection, temp_id, payload, status, received_at, updated_at)
    VALUES (?, ?, ?, 'payment', 'payments', ?, ?, 'processing', '2026-10-13T00:00:00Z', '2026-10-13T00:00:00Z')`).run(lost.opId, devA, advisor.id, lost.tempId, JSON.stringify({ data: lost.data }));
  const payments0 = count('SELECT COUNT(*) FROM payments');
  const r = await push(advisor.cookie, devA, [lost]);
  check('pushed again after its first attempt was cut off: NOT re-posted; an "interrupted" conflict for review',
    [r.body.data.results[0].status, r.body.data.results[0].type, count('SELECT COUNT(*) FROM payments')], ['conflict', 'interrupted', payments0]);
  const bad = await api('POST', `/api/sync/conflicts/${r.body.data.results[0].conflictId}/resolve`, { action: 'mark_applied', note: 'Checked the ledger' }, admin.cookie);
  check('   ...marking it applied must name the record', bad.status, 422);
  const res = await api('POST', `/api/sync/conflicts/${r.body.data.results[0].conflictId}/resolve`, { action: 'dismiss', note: 'Never reached the ledger; customer will pay again' }, admin.cookie);
  check('   ...an Admin dismisses it with a note', [res.status, one('SELECT status FROM sync_ops WHERE op_id = ?', lost.opId).status], [200, 'dismissed']);
  const inProgress = op('create', { collection: 'customers', tempId: T(codeA, 'CUS', 8), data: { name: 'Busy', phone: '01700009801' } });
  DB.raw.prepare(`INSERT INTO sync_ops (op_id, device_id, account_id, kind, collection, temp_id, payload, status, received_at, updated_at)
    VALUES (?, ?, ?, 'create', 'customers', ?, '{}', 'processing', ?, ?)`).run(inProgress.opId, devA, advisor.id, inProgress.tempId, new Date().toISOString(), new Date().toISOString());
  const busy = await push(advisor.cookie, devA, [inProgress]);
  check('   ...one still being applied by another request is answered "retry", not applied twice', [busy.body.data.results[0].status, busy.body.data.results[0].reason], ['retry', 'in_progress']);
}

/* ---------- status, history ---------- */
console.log('\n-- status and history --');
{
  const s = await api('GET', `/api/sync/status?deviceId=${devA}`, undefined, advisor.cookie);
  ok_('status: server time, cursor, the device, the renewed 14-day window, and real counts',
    s.status === 200 && s.body.data.cursor > 0 && s.body.data.device.id === devA && s.body.data.offlineDays === 14 && s.body.data.ops.applied > 0 && s.body.data.ops.conflict > 0
    && typeof s.body.data.openConflicts === 'number' && s.body.data.inventoryReview === 0, s.body.data);
  const h = await api('GET', `/api/sync/history?deviceId=${devA}`, undefined, advisor.cookie);
  ok_('history: the operations this person pushed from this device, newest first', h.body.data.length > 5 && h.body.data.every((x) => x.accountId === advisor.id && x.deviceId === devA), h.body.data.length);
  const drafts = await api('GET', '/api/invoice-drafts?status=all', undefined, advisor.cookie);
  check('invoice drafts are listed for invoices.view, and refused to a role without it', [drafts.status, drafts.body.data.length >= 1, (await api('GET', '/api/invoice-drafts', undefined, mech.cookie)).status], [200, true, 403]);
}

/* ---------- B (cont.). revocation ---------- */
console.log('\n-- device revocation --');
{
  const mine = await api('DELETE', `/api/devices/${devA}`, { reason: 'Not mine' }, mech.cookie);
  check('a Mechanic cannot revoke someone else\'s device', mine.status, 403);
  const rv = await api('DELETE', `/api/devices/${devB}`, { reason: 'Laptop lost' }, admin.cookie);
  check('an Admin revokes Computer B', [rv.status, rv.body.data.revoked, rv.body.data.revokeReason], [200, true, 'Laptop lost']);
  const after = await Promise.all([
    push(mech.cookie, devB, [op('create', { collection: 'customers', tempId: T(codeB, 'CUS', 5), data: { name: 'After Revoke', phone: '01700009901' } })]),
    api('GET', `/api/sync/pull?deviceId=${devB}&cursor=0`, undefined, mech.cookie),
    api('POST', '/api/devices/register', { deviceId: devB }, mech.cookie),
    api('GET', `/api/sync/status?deviceId=${devB}`, undefined, mech.cookie),
  ]);
  check('   ...a revoked device can no longer push, pull, register or renew its window', after.map((x) => [x.status, x.body.error.code]), Array(4).fill([403, 'device_revoked']));
  check('   ...the device row is kept (revoked, not deleted)', count('SELECT COUNT(*) FROM devices WHERE id = ?', devB), 1);
}

console.log(`\nSync unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
