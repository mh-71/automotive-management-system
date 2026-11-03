/* Equipment Inventory (0021) — unit tests against the REAL Worker: /api/tools.

   The Equipment Inventory page is a second view of the Tools & Equipment
   register (0013); 0021 extends that register. The handlers run against an
   in-memory SQLite database built from EVERY real migration, through the real
   auth gate, with real role accounts. Every name is a fictional test value.

   What must hold:
     A. Migration: additive only; existing rows untouched; tools.delete only
        for the built-in roles that still hold tools.manage.
     B. Create: every field, assignment (employee OR mechanic, Active, In Use
        only), history written with the row.
     C. Update: assign / return / status / edit history; leaving In Use ends
        an assignment (the Tools & Equipment form keeps working); stale 409
        writes nothing.
     D. List: search by name / ID / serial, category, status, purchase-date
        range, paging, summary, purchase value, service due.
     E. Deactivate (retire) and reactivate: tools.manage; serial clash.
     F. Delete: tools.delete; refused while assigned; history kept.
     G. Permissions: every write refused for a role without it (403), and
        nothing changes.
     H. Invalid input: named field errors, nothing written.
     I. Offline sync: create and edit through /api/sync/push; a repeated
        operation is never applied twice; a duplicate serial and a clashing
        edit become conflicts; a role without the right gets a permission
        conflict; retire/delete are not offline operations.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ALL_PERMISSIONS, DEFAULT_ROLES } from '../../src/lib/permissions.js';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nEquipment API unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const UP_TO_0020 = ALL.filter((f) => f < '0021');
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';
const PW2 = 'Own-Chosen-Pass-77';
const AT = '2026-10-08T00:00:00Z';

function makeD1(migrations = ALL) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of migrations) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
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

/* ---------- A. migration ---------- */
console.log('=== Equipment Inventory (0021) against an in-memory database ===\n\n-- A. migration --');
{
  const sql = readFileSync(join(ROOT, 'migrations', '0021_equipment_inventory.sql'), 'utf8').replace(/--.*$/gm, '');
  ok_('0021 never drops, renames, updates or deletes anything', !/\bDROP\b|\bRENAME\b/i.test(sql) && !/^\s*(DELETE|UPDATE)\b/im.test(sql));
  const alters = sql.match(/ALTER\s+TABLE\s+\w+\s+\w+/gi) || [];
  ok_('   ...its ALTERs only ADD COLUMNs to tools', alters.length === 4 && alters.every((a) => /^ALTER\s+TABLE\s+tools\s+ADD$/i.test(a)), alters);
  ok_('   ...and creates no triggers', !/CREATE\s+TRIGGER/i.test(sql));

  // A register as it is in production before 0021, then 0021 on top of it.
  const db = makeD1(UP_TO_0020);
  db.raw.exec(`INSERT INTO tools (id, name, category, serial_no, purchase_price, condition, status, created_at, updated_at)
               VALUES ('TOL-0001', 'Existing Lift', 'Lifting Equipment', 'EX-1', 50000, 'Good', 'In Use', '${AT}', '${AT}')`);
  const before = db.raw.prepare('SELECT * FROM tools').get();
  const roles = (d) => d.raw.prepare("SELECT role_id FROM role_permissions WHERE permission = 'tools.delete' ORDER BY role_id").all().map((r) => r.role_id);
  // An owner who narrowed Store Manager (removed retire) before 0021: it must not gain delete.
  db.raw.exec("DELETE FROM role_permissions WHERE role_id = 'ROL-0006' AND permission = 'tools.manage'");
  db.raw.exec(readFileSync(join(ROOT, 'migrations', '0021_equipment_inventory.sql'), 'utf8'));
  const after = db.raw.prepare('SELECT * FROM tools').get();
  ok_('an existing tool keeps every value; the four new columns are NULL', Object.keys(before).every((k) => before[k] === after[k])
    && after.assigned_staff_id === null && after.assigned_mechanic_id === null && after.last_service_date === null && after.next_service_due === null, after);
  check('tools.delete goes only to a built-in role that still holds tools.manage', roles(db), ['ROL-0002']);
  const fresh = makeD1();
  check('   ...on a fresh database: Admin and Store Manager', roles(fresh), ['ROL-0002', 'ROL-0006']);
  ok_('the permission catalogue knows tools.delete', ALL_PERMISSIONS.includes('tools.delete'));
  check('   ...and the built-in defaults agree with the migration', DEFAULT_ROLES.filter((r) => r.permissions.includes('tools.delete')).map((r) => r.id), ['ROL-0002', 'ROL-0006']);
  const cnt = (d, t) => d.raw.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  ok_('no other table changes size', ['customers', 'vehicles', 'job_cards', 'invoices', 'payments', 'parts', 'staff', 'mechanics'].every((t) => cnt(db, t) === cnt(makeD1(UP_TO_0020), t)));
}

/* ---------- the shared database for B–I ---------- */
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
    method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env, ctx);
  const text = await res.text();
  await Promise.all(pending.splice(0));
  let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
};

DB.raw.exec(`
  INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES
    ('STF-0001', 'Store Test', '01911000001', 'Active', 'Store', 'Store', '${AT}'),
    ('STF-0002', 'Manager Test', '01911000002', 'Active', 'Manager', 'Office', '${AT}'),
    ('STF-0003', 'Mech Account Test', '01911000003', 'Active', 'Mechanic', 'Workshop', '${AT}'),
    ('STF-0004', 'Helper Test', '01911000004', 'Active', 'Helper', 'Workshop', '${AT}'),
    ('STF-0005', 'Former Test', '01911000005', 'Inactive', 'Helper', 'Workshop', '${AT}');
  UPDATE id_counters SET last_value = 5 WHERE collection = 'staff';
  INSERT INTO mechanics (id, name, phone, status, created_at) VALUES
    ('MEC-0001', 'Bench Mechanic', '01911000099', 'Active', '${AT}'),
    ('MEC-0002', 'Left Mechanic', '01911000098', 'Inactive', '${AT}');
  UPDATE id_counters SET last_value = 2 WHERE collection = 'mechanics';`);

async function person(n, username, role) {
  const made = await api('POST', '/api/accounts', { staffId: `STF-000${n}`, username, role, password: PW });
  if (made.status !== 201) throw new Error(`could not create ${username}: ${made.text}`);
  const s = await api('POST', '/api/session', { username, password: PW }, 'none');
  const changed = await api('POST', '/api/session/password', { currentPassword: PW, newPassword: PW2 }, s.cookie);
  if (changed.status !== 204) throw new Error(`could not change ${username}'s password: ${changed.text}`);
  return { id: made.body.data.id, cookie: changed.cookie };
}
const store = await person(1, 'eq.store', 'Store Manager');
const manager = await person(2, 'eq.manager', 'Manager');
const mech = await person(3, 'eq.mech', 'Mechanic');

const ITEM = (extra = {}) => ({ name: 'Wheel Balancer', category: 'Workshop Hand Tools', condition: 'Good', status: 'Available', ...extra });
const events = (id) => DB.raw.prepare('SELECT action, summary, actor FROM tool_events WHERE tool_id = ? ORDER BY id').all(id);

/* ---------- B. create ---------- */
console.log('\n-- B. create --');
let lift;
{
  const r = await api('POST', '/api/tools', ITEM({
    name: 'Two Post Car Lift', category: 'Lifting Equipment', brand: 'LiftCo', model: 'TP-4', serialNo: 'LIFT-001',
    purchaseDate: '2025-01-10', purchasePrice: 385000, supplier: 'Lift Supplier Test', warrantyExpiry: '2027-01-10',
    location: 'Bay 1', description: '4 ton', notes: 'Annual check', lastServiceDate: '2026-01-05', nextServiceDue: '2099-01-05',
  }), store.cookie);
  lift = r.body && r.body.data;
  check('a Store Manager adds equipment with every field (201, TOL id)', [r.status, /^TOL-\d{4}$/.test(lift.id)], [201, true]);
  check('   ...stored as sent', [lift.supplier, lift.warrantyExpiry, lift.lastServiceDate, lift.nextServiceDue, lift.maintenanceStatus, lift.assignedTo, lift.createdBy],
    ['Lift Supplier Test', '2027-01-10', '2026-01-05', '2099-01-05', 'Scheduled', null, 'eq.store']);
  check('   ...and its history entry is written with it', events(lift.id).map((e) => [e.action, e.actor]), [['create', 'eq.store']]);

  const toMech = await api('POST', '/api/tools', ITEM({ name: 'Torque Wrench', status: 'In Use', assignedMechanicId: 'MEC-0001' }), store.cookie);
  check('created already assigned to a mechanic: In Use, holder named', [toMech.status, toMech.body.data.status, toMech.body.data.assignedTo],
    [201, 'In Use', { kind: 'mechanic', id: 'MEC-0001', name: 'Bench Mechanic' }]);
  check('   ...history: added, then assigned', events(toMech.body.data.id).map((e) => e.action), ['create', 'assign']);

  const notInUse = await api('POST', '/api/tools', ITEM({ assignedStaffId: 'STF-0004' }), store.cookie);
  check('assigned but Available is refused, naming status', [notInUse.status, Object.keys(notInUse.body.error.fields)], [422, ['status']]);
  const both = await api('POST', '/api/tools', ITEM({ status: 'In Use', assignedStaffId: 'STF-0004', assignedMechanicId: 'MEC-0001' }), store.cookie);
  check('assigned to two people is refused', [both.status, Object.keys(both.body.error.fields)], [422, ['assignedStaffId']]);
  const inactive = await api('POST', '/api/tools', ITEM({ status: 'In Use', assignedStaffId: 'STF-0005' }), store.cookie);
  check('an inactive employee is refused', [inactive.status, Object.keys(inactive.body.error.fields)], [422, ['assignedStaffId']]);
  const goneMech = await api('POST', '/api/tools', ITEM({ status: 'In Use', assignedMechanicId: 'MEC-0002' }), store.cookie);
  check('an inactive mechanic is refused', [goneMech.status, Object.keys(goneMech.body.error.fields)], [422, ['assignedMechanicId']]);
  const unknown = await api('POST', '/api/tools', ITEM({ status: 'In Use', assignedStaffId: 'STF-0999' }), store.cookie);
  check('an unknown person is refused', [unknown.status, unknown.body.error.fields.assignedStaffId], [422, 'No employee with that id.']);
  check('nothing was written for the four refusals', count("SELECT count(*) FROM tools WHERE name = 'Wheel Balancer'"), 0);
}

/* ---------- C. update ---------- */
console.log('\n-- C. update --');
{
  const assign = await api('PUT', `/api/tools/${lift.id}`, { assignedStaffId: 'STF-0004', status: 'In Use', expectedUpdatedAt: lift.updatedAt }, store.cookie);
  check('assign to an employee', [assign.status, assign.body.data.status, assign.body.data.assignedTo && assign.body.data.assignedTo.name], [200, 'In Use', 'Helper Test']);
  const a = assign.body.data;
  const stale = await api('PUT', `/api/tools/${lift.id}`, { location: 'Bay 9', expectedUpdatedAt: lift.updatedAt }, store.cookie);
  const evBefore = events(lift.id).length;
  check('a stale edit is 409 and writes no history', [stale.status, stale.body.error.reason, events(lift.id).length], [409, 'concurrent_modification', evBefore]);
  const statusOnly = await api('PUT', `/api/tools/${lift.id}`, { status: 'Under Maintenance', expectedUpdatedAt: a.updatedAt }, store.cookie);
  check('moving it out of In Use without naming a holder (the Tools & Equipment form) ends the assignment',
    [statusOnly.status, statusOnly.body.data.status, statusOnly.body.data.assignedTo, statusOnly.body.data.maintenanceStatus],
    [200, 'Under Maintenance', null, 'Under maintenance']);
  check('   ...history: assign, then return + status', events(lift.id).map((e) => e.action), ['create', 'assign', 'return', 'status']);
  const edit = await api('PUT', `/api/tools/${lift.id}`, { location: 'Bay 2', notes: 'Moved', expectedUpdatedAt: statusOnly.body.data.updatedAt }, store.cookie);
  check('a plain edit is recorded by field name', [edit.status, events(lift.id).pop().summary], [200, 'Edited location, notes']);
  lift = edit.body.data;
  const badAssign = await api('PUT', `/api/tools/${lift.id}`, { assignedMechanicId: 'MEC-0001', expectedUpdatedAt: lift.updatedAt }, store.cookie);
  check('assigning without In Use is refused', [badAssign.status, Object.keys(badAssign.body.error.fields)], [422, ['status']]);
  const back = await api('PUT', `/api/tools/${lift.id}`, { status: 'Available', expectedUpdatedAt: lift.updatedAt }, store.cookie);
  lift = back.body.data;
  check('back to Available', [back.status, lift.status], [200, 'Available']);
}

/* ---------- D. list ---------- */
console.log('\n-- D. list --');
{
  for (const [name, extra] of [['Diagnostic Scanner', { category: 'Diagnostic Equipment', serialNo: 'SCAN-77', purchaseDate: '2024-03-01', purchasePrice: 25000 }],
    ['AC Gauge Set', { category: 'AC Service Equipment', purchaseDate: '2026-02-01', purchasePrice: 8000.5, nextServiceDue: '2020-01-01' }],
    ['Broken Jack', { category: 'Lifting Equipment', condition: 'Damaged', status: 'Damaged', purchasePrice: 3000 }]]) {
    const r = await api('POST', '/api/tools', ITEM({ name, ...extra }), store.cookie);
    if (r.status !== 201) throw new Error(r.text);
  }
  const L = async (q) => (await api('GET', `/api/tools?${q}`, undefined, manager.cookie)).body;
  check('search by name', (await L('q=scanner')).data.map((t) => t.name), ['Diagnostic Scanner']);
  check('search by Equipment ID', (await L(`q=${lift.id.toLowerCase()}`)).data.map((t) => t.id), [lift.id]);
  check('search by serial number', (await L('q=scan-77')).data.map((t) => t.name), ['Diagnostic Scanner']);
  check('filter by category', (await L('category=Lifting%20Equipment&sort=name&order=asc')).data.map((t) => t.name), ['Broken Jack', 'Two Post Car Lift']);
  check('filter by status (In Use = Assigned)', (await L('status=In%20Use')).data.map((t) => t.name), ['Torque Wrench']);
  check('purchase date range', (await L('purchasedFrom=2024-01-01&purchasedTo=2025-12-31&sort=purchaseDate&order=asc')).data.map((t) => t.name), ['Diagnostic Scanner', 'Two Post Car Lift']);
  check('a bad date filter is 400', (await api('GET', '/api/tools?purchasedFrom=2025-13-01', undefined, manager.cookie)).status, 400);
  const p1 = await L('limit=2&offset=0&sort=name&order=asc');
  const p2 = await L('limit=2&offset=2&sort=name&order=asc');
  check('paging: two pages of two, no overlap, total 5', [p1.data.length, p2.data.length, p1.total, p1.data.some((t) => p2.data.find((u) => u.id === t.id))], [2, 2, 5, false]);
  const all = await L('limit=1');
  check('the summary counts the register, not the page', all.summary, { total: 5, available: 3, inUse: 1, underMaintenance: 0, damaged: 1, retired: 0 });
  check('purchase value of everything in service', all.purchaseValue, 385000 + 25000 + 8000.5 + 3000);
  check('service due counts the overdue item', all.serviceDue, 1);
  check('an overdue item says so', (await L('q=gauge')).data[0].maintenanceStatus, 'Overdue');
}

/* ---------- E. deactivate / reactivate ---------- */
console.log('\n-- E. deactivate and reactivate --');
{
  const wrench = one("SELECT id, updated_at FROM tools WHERE name = 'Torque Wrench'");
  const byManager = await api('POST', `/api/tools/${wrench.id}/retire`, { reason: 'Old', expectedUpdatedAt: wrench.updated_at }, manager.cookie);
  check('a Manager (no tools.manage) cannot deactivate', [byManager.status, one('SELECT status FROM tools WHERE id = ?', wrench.id).status], [403, 'In Use']);
  const ret = await api('POST', `/api/tools/${wrench.id}/retire`, { reason: 'Worn out', expectedUpdatedAt: wrench.updated_at }, store.cookie);
  check('a Store Manager deactivates it; the assignment ends with it', [ret.status, ret.body.data.status, ret.body.data.assignedTo], [200, 'Retired', null]);
  check('   ...history: return, then retire', events(wrench.id).slice(-2).map((e) => e.action), ['return', 'retire']);
  const all = (await api('GET', '/api/tools?limit=1', undefined, manager.cookie)).body;
  check('   ...it leaves the totals', [all.summary.total, all.summary.retired], [4, 1]);
  const react = (body, cred = store.cookie) => api('POST', `/api/tools/${wrench.id}/reactivate`, body, cred);
  check('a Manager cannot reactivate', (await react({ expectedUpdatedAt: ret.body.data.updatedAt }, manager.cookie)).status, 403);
  check('reactivate needs expectedUpdatedAt', (await react({})).status, 422);
  check('In Use is not a reactivation status', Object.keys((await react({ status: 'In Use', expectedUpdatedAt: ret.body.data.updatedAt })).body.error.fields), ['status']);
  const back = await react({ status: 'Available', expectedUpdatedAt: ret.body.data.updatedAt });
  check('reactivated as Available, retirement fields cleared', [back.status, back.body.data.status, back.body.data.retiredAt, back.body.data.retiredReason], [200, 'Available', null, '']);
  check('reactivating something in service is 409', (await react({ expectedUpdatedAt: back.body.data.updatedAt })).body.error.reason, 'not_retired');

  // A retired serial reused, then the old one reactivated: refused.
  const scan = one("SELECT id, updated_at FROM tools WHERE name = 'Diagnostic Scanner'");
  const r2 = await api('POST', `/api/tools/${scan.id}/retire`, { reason: 'Replaced', expectedUpdatedAt: scan.updated_at }, store.cookie);
  await api('POST', '/api/tools', ITEM({ name: 'New Scanner', serialNo: 'SCAN-77' }), store.cookie);
  const clash = await api('POST', `/api/tools/${scan.id}/reactivate`, { expectedUpdatedAt: r2.body.data.updatedAt }, store.cookie);
  check('reactivating while its serial is back in service is 409', [clash.status, clash.body.error.reason], [409, 'duplicate_serial']);
}

/* ---------- F. delete ---------- */
console.log('\n-- F. delete --');
{
  const jack = one("SELECT id, updated_at FROM tools WHERE name = 'Broken Jack'");
  const byManager = await api('DELETE', `/api/tools/${jack.id}`, undefined, manager.cookie);
  check('a Manager (no tools.delete) cannot delete; the row remains', [byManager.status, count('SELECT count(*) FROM tools WHERE id = ?', jack.id)], [403, 1]);
  const stale = await api('DELETE', `/api/tools/${jack.id}?expectedUpdatedAt=${encodeURIComponent(AT)}`, undefined, store.cookie);
  check('a stale delete is 409', [stale.status, count('SELECT count(*) FROM tools WHERE id = ?', jack.id)], [409, 1]);
  const del = await api('DELETE', `/api/tools/${jack.id}?expectedUpdatedAt=${encodeURIComponent(jack.updated_at)}`, undefined, store.cookie);
  check('a Store Manager deletes it', [del.status, del.body.data, count('SELECT count(*) FROM tools WHERE id = ?', jack.id)], [200, { id: jack.id, deleted: true }, 0]);
  check('   ...its history stays, with the deletion', events(jack.id).map((e) => e.action), ['create', 'delete']);
  check('   ...and it is gone from the API', (await api('GET', `/api/tools/${jack.id}`, undefined, manager.cookie)).status, 404);
  const held = await api('POST', '/api/tools', ITEM({ name: 'Held Item', status: 'In Use', assignedMechanicId: 'MEC-0001' }), store.cookie);
  const delHeld = await api('DELETE', `/api/tools/${held.body.data.id}`, undefined, store.cookie);
  check('an assigned item cannot be deleted (return it first)', [delHeld.status, delHeld.body.error.reason], [409, 'tool_in_use']);
  check('deleting an unknown id is 404', (await api('DELETE', '/api/tools/TOL-9999', undefined, store.cookie)).status, 404);
  check('a mechanic deleted from the system leaves the item, unassigned (ON DELETE SET NULL)', (() => {
    DB.raw.exec("INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0003', 'Temp Mechanic', '01911000097', 'Active', '2026-10-08T00:00:00Z')");
    DB.raw.exec(`UPDATE tools SET assigned_mechanic_id = 'MEC-0003' WHERE id = '${held.body.data.id}'`);
    DB.raw.exec("DELETE FROM mechanics WHERE id = 'MEC-0003'");
    return one('SELECT assigned_mechanic_id AS m FROM tools WHERE id = ?', held.body.data.id).m;
  })(), null);
}

/* ---------- G. permissions ---------- */
console.log('\n-- G. permissions --');
{
  const t = one("SELECT id, updated_at FROM tools WHERE name = 'AC Gauge Set'");
  const tries = [
    ['view list', 'GET', '/api/tools'], ['view one', 'GET', `/api/tools/${t.id}`],
    ['create', 'POST', '/api/tools', ITEM({ name: 'Mech Try' })],
    ['edit', 'PUT', `/api/tools/${t.id}`, { location: 'Mech', expectedUpdatedAt: t.updated_at }],
    ['retire', 'POST', `/api/tools/${t.id}/retire`, { reason: 'x', expectedUpdatedAt: t.updated_at }],
    ['delete', 'DELETE', `/api/tools/${t.id}`],
  ];
  const got = [];
  for (const [, m, p, b] of tries) got.push((await api(m, p, b, mech.cookie)).status);
  check('a Mechanic (tools.view only) may read but every write is 403', got, [200, 200, 403, 403, 403, 403]);
  check('   ...and nothing changed', [count("SELECT count(*) FROM tools WHERE name = 'Mech Try'"), one('SELECT location, status FROM tools WHERE id = ?', t.id)], [0, { location: null, status: 'Available' }]);
  check('no credential: 401', (await api('GET', '/api/tools', undefined, 'none')).status, 401);
  const delByToken = await api('POST', '/api/tools', ITEM({ name: 'Token Item' }));
  check('the full-access machine token may delete (as before for full access)', (await api('DELETE', `/api/tools/${delByToken.body.data.id}`)).status, 200);
}

/* ---------- H. invalid input ---------- */
console.log('\n-- H. invalid input --');
{
  const bad = await api('POST', '/api/tools', { name: ' ', category: 'Toys', condition: 'Good', status: 'Available', purchasePrice: -5,
    lastServiceDate: '2999-01-01', nextServiceDue: 'soon', assignedStaffId: 'robert', colour: 'red' }, store.cookie);
  check('every bad field is named and nothing is written', [bad.status, Object.keys(bad.body.error.fields).sort(), count("SELECT count(*) FROM tools WHERE category = 'Toys'")],
    [422, ['assignedStaffId', 'category', 'colour', 'name', 'nextServiceDue', 'purchasePrice'], 0]);
  const future = await api('POST', '/api/tools', ITEM({ lastServiceDate: '2999-01-01' }), store.cookie);
  check('a last service in the future is refused', Object.keys(future.body.error.fields), ['lastServiceDate']);
  const order = await api('POST', '/api/tools', ITEM({ lastServiceDate: '2026-01-10', nextServiceDue: '2026-01-01' }), store.cookie);
  check('a next service before the last is refused', Object.keys(order.body.error.fields), ['nextServiceDue']);
  check('a body that is not JSON is 400', (await api('POST', '/api/tools', '{not json', store.cookie)).status, 400);
  const xss = await api('POST', '/api/tools', ITEM({ name: '<img src=x onerror=alert(1)>' }), store.cookie);
  check('markup is stored as text (escaping is the page’s job) and never executed server-side', [xss.status, xss.body.data.name], [201, '<img src=x onerror=alert(1)>']);
}

/* ---------- I. offline sync ---------- */
console.log('\n-- I. offline sync --');
const op = (kind, fields) => ({ opId: randomUUID(), kind, createdAt: new Date().toISOString(), ...fields });
async function push(cookie, deviceId, ops) {
  let left = ops; const answers = new Map(); let last;
  for (let round = 0; round < 100 && left.length; round++) {
    last = await api('POST', '/api/sync/push', { deviceId, ops: left }, cookie);
    if (last.status !== 200) return last;
    for (const a of last.body.data.results) if (a.status !== 'deferred') answers.set(a.opId, a);
    left = left.filter((o) => !answers.has(o.opId));
  }
  return { ...last, body: { ...last.body, data: { results: ops.map((o) => answers.get(o.opId) || { opId: o.opId, status: 'deferred' }) } } };
}
{
  const dev = randomUUID();
  const reg = await api('POST', '/api/devices/register', { deviceId: dev, label: 'Store PC' }, store.cookie);
  const code = reg.body.data.code;
  const T = (n) => `OFF-${code}-TOL-${String(n).padStart(4, '0')}`;
  const create = op('create', { collection: 'tools', tempId: T(1), data: ITEM({ name: 'Offline Compressor', serialNo: 'OFF-COMP-1', location: 'Yard' }) });
  const r = await push(store.cookie, dev, [create]);
  const res = r.body.data.results[0];
  check('an equipment item added offline is applied through the route', [r.status, res.status, /^TOL-\d{4}$/.test(res.serverId || res.id || '')], [200, 'applied', true]);
  const serverId = res.serverId || res.id;
  check('   ...the row exists once, created by the person who made it', [count("SELECT count(*) FROM tools WHERE serial_no = 'OFF-COMP-1'"), one('SELECT created_by FROM tools WHERE id = ?', serverId).created_by], [1, 'eq.store']);
  const again = await push(store.cookie, dev, [create]);
  check('the same operation sent again is answered, never applied twice', [again.body.data.results[0].status, count("SELECT count(*) FROM tools WHERE serial_no = 'OFF-COMP-1'")], ['applied', 1]);
  const dup = await push(store.cookie, dev, [op('create', { collection: 'tools', tempId: T(2), data: ITEM({ name: 'Second Compressor', serialNo: 'off-comp-1' }) })]);
  check('a second item with the same serial becomes a conflict, nothing created', [dup.body.data.results[0].status, count("SELECT count(*) FROM tools WHERE lower(serial_no) = 'off-comp-1'")], ['conflict', 1]);
  ok_('   ...and the conflict is in the Conflict Center', count("SELECT count(*) FROM sync_conflicts WHERE status = 'Open' AND collection = 'tools'") >= 1);

  const cur = (await api('GET', `/api/tools/${serverId}`, undefined, store.cookie)).body.data;
  const edit = await push(store.cookie, dev, [op('update', { collection: 'tools', targetId: serverId, data: { location: 'Bay 4' }, base: { values: { location: 'Yard' }, updatedAt: cur.updatedAt } })]);
  check('an offline edit is applied (the route’s stale-edit guard is satisfied by sync)', [edit.body.data.results[0].status, one('SELECT location FROM tools WHERE id = ?', serverId).location], ['applied', 'Bay 4']);
  // Someone online changes the location; the device, which last saw Bay 4, changes it too.
  const now = (await api('GET', `/api/tools/${serverId}`, undefined, store.cookie)).body.data;
  await api('PUT', `/api/tools/${serverId}`, { location: 'Bay 7', expectedUpdatedAt: now.updatedAt }, store.cookie);
  const clash = await push(store.cookie, dev, [op('update', { collection: 'tools', targetId: serverId, data: { location: 'Bay 5' }, base: { values: { location: 'Bay 4' }, updatedAt: now.updatedAt } })]);
  check('a clashing offline edit becomes a conflict; the server value stays', [clash.body.data.results[0].status, one('SELECT location FROM tools WHERE id = ?', serverId).location], ['conflict', 'Bay 7']);

  const mdev = randomUUID();
  await api('POST', '/api/devices/register', { deviceId: mdev }, mech.cookie);
  const mcode = (await api('GET', '/api/devices', undefined, mech.cookie)).body.data.find((d) => d.deviceId === mdev || d.id === mdev);
  const mref = `OFF-${(mcode && mcode.code) || 'B'}-TOL-0001`;
  const denied = await push(mech.cookie, mdev, [op('create', { collection: 'tools', tempId: mref, data: ITEM({ name: 'Mechanic Offline Item' }) })]);
  check('a role without tools.create gets a permission conflict, nothing created', [denied.body.data.results[0].status, count("SELECT count(*) FROM tools WHERE name = 'Mechanic Offline Item'")], ['conflict', 0]);

  const many = Array.from({ length: 12 }, (_, i) => op('create', { collection: 'tools', tempId: T(10 + i), data: ITEM({ name: `Batch Item ${i}` }) }));
  const batch = await push(store.cookie, dev, many);
  check('twelve offline items are all applied within the per-request query budget (deferred and resent)', batch.body.data.results.every((x) => x.status === 'applied'), true);
  const notOffline = await api('POST', '/api/sync/push', { deviceId: dev, ops: [op('status', { collection: 'tools', targetId: serverId, data: { status: 'Retired' } })] }, store.cookie);
  ok_('deactivating or deleting is not an offline operation', notOffline.status !== 200 || notOffline.body.data.results[0].status !== 'applied' || one('SELECT status FROM tools WHERE id = ?', serverId).status !== 'Retired', notOffline.body);
  check('   ...the item is untouched', one('SELECT status FROM tools WHERE id = ?', serverId).status, 'Available');
}

console.log(`\nEquipment API unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
