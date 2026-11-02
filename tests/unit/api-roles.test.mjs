/* Roles & Permissions (0018) — unit tests against the REAL Worker.

   The handlers run against an in-memory SQLite database built from the real
   migrations. Every name is a fictional test value.

   What must hold:
     A. Migration: additive; the eight built-in roles and their permissions
        are exactly lib/permissions.js DEFAULT_ROLES; existing Administrator
        accounts become Super Admin (nobody loses or gains access).
     B. Coverage: every protected route the Worker serves needs a named
        permission from the catalog -- none falls through to "full access"
        by accident -- and every permission the pages ask for exists.
     C. Roles API: create, read, edit (with expectedUpdatedAt), switch off,
        delete; validation; duplicate names; Super Admin cannot be changed,
        switched off or deleted; a role accounts hold cannot be switched off
        or deleted.
     D. Enforcement, per role (account sessions): 401 before anything
        without a credential; Admin, Mechanic and Accountant each get exactly
        their role's access, on reads and writes (403 otherwise); settings
        stay readable by everyone signed in.
     E. Escalation: nobody grants a permission they lack, assigns a role
        beyond their own, assigns Super Admin without full access, edits or
        deletes the role they hold, changes their own role, or acts on an
        account above them; nothing sent by the browser counts.
     F. Effects: a role change applies on the next request and signs the
        account out; an account with no role has no access (fail closed);
        notifications are filtered by what the role may see; existing
        passphrase and token behaviour is unchanged.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */

import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_PERMISSIONS, DEFAULT_ROLES, COLLECTION_PERMISSIONS, collectionPermission, routePermission, FULL, AUTHENTICATED, isPermission,
} from '../../src/lib/permissions.js';

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
  console.log(`\nRoles unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL_MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';
const PW2 = 'Own-Chosen-Pass-77';
const AT = '2026-10-08T00:00:00Z';

function makeD1(migrations = ALL_MIGRATIONS, before = null) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of migrations) {
    if (before && f === before.at) before.run(raw);
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
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
    raw, statements, prepare: (sql) => new Stmt(sql),
    async batch(list) { raw.exec('BEGIN'); try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; } },
  };
}

const PEOPLE = ['Admin Test', 'Mechanic Test', 'Accountant Test', 'Manager Test', 'Clerk Test', 'Spare Test', 'Second Super'];
function fresh() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Test Customer', '01700000001', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection = 'customers';
    ${PEOPLE.map((n, i) => `INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-000${i + 1}', '${n}', '0191100000${i}', 'Active', 'Test', 'Test', '${AT}');`).join('\n')}
    UPDATE id_counters SET last_value = ${PEOPLE.length} WHERE collection = 'staff';`);
  const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  /** cred: 'token' | 'none' | a cookie string. */
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
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  /** Create an account for STF-000n with a role (by the machine token), and sign it in. */
  const person = async (n, username, role) => {
    const made = await api('POST', '/api/accounts', { staffId: `STF-000${n}`, username, role, password: PW });
    if (made.status !== 201) throw new Error(`could not create ${username}: ${made.text}`);
    const s = await api('POST', '/api/session', { username, password: PW }, 'none');
    // 0019: an account an administrator created must choose its own password first.
    const changed = await api('POST', '/api/session/password', { currentPassword: PW, newPassword: PW2 }, s.cookie);
    if (changed.status !== 204) throw new Error(`could not change ${username}'s password: ${changed.text}`);
    return { id: made.body.data.id, cookie: changed.cookie };
  };
  return { DB, env, api, one, person };
}

console.log('=== Roles & Permissions (0018) against an in-memory database ===');

/* ---------- A. migration ---------- */
console.log('\n-- A. migration --');
{
  const h = fresh();
  const roles = h.DB.raw.prepare('SELECT id, name, is_system, full_access, status FROM roles ORDER BY id').all();
  check('the eight built-in roles', roles.map((r) => [r.id, r.name, r.is_system, r.full_access, r.status]), DEFAULT_ROLES.map((r) => [r.id, r.name, r.system ? 1 : 0, r.system ? 1 : 0, 'Active']));
  const seeded = (id) => h.DB.raw.prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission').all(id).map((r) => r.permission);
  ok_('each role starts with exactly the permissions lib/permissions.js lists', DEFAULT_ROLES.every((r) => JSON.stringify(seeded(r.id)) === JSON.stringify([...r.permissions].sort())), '');
  ok_('   ...all of them real permissions from the catalog', DEFAULT_ROLES.every((r) => r.permissions.every(isPermission)), '');
  check('Super Admin holds every permission by being the system role (no rows needed)', seeded('ROL-0001'), []);
  check('the ROL counter continues after the built-in roles', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='roles'"), { prefix: 'ROL', last_value: 8 });
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|FOREIGN KEY|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  check('the schema refuses: full access on a non-system role, a switched-off system role, a duplicate name in any case, a malformed id, a permission for no role', [
    ins(`INSERT INTO roles (id, name, full_access, created_at, updated_at) VALUES ('ROL-0100', 'X1', 1, '${AT}', '${AT}')`),
    ins(`INSERT INTO roles (id, name, is_system, status, created_at, updated_at) VALUES ('ROL-0101', 'X2', 1, 'Inactive', '${AT}', '${AT}')`),
    ins(`INSERT INTO roles (id, name, created_at, updated_at) VALUES ('ROL-0102', 'mechanic', '${AT}', '${AT}')`),
    ins(`INSERT INTO roles (id, name, created_at, updated_at) VALUES ('R-1', 'X3', '${AT}', '${AT}')`),
    ins("INSERT INTO role_permissions (role_id, permission) VALUES ('ROL-0999', 'customers.view')"),
  ], ['CHECK', 'CHECK', 'UNIQUE', 'CHECK', 'FOREIGN KEY']);
  let blocked = 'ok';
  try { h.DB.raw.exec("UPDATE user_accounts SET role_id = 'ROL-0999'"); h.DB.raw.exec(`INSERT INTO user_accounts (id, staff_id, username, role, role_id, password_hash, password_changed_at, created_at) VALUES ('USR-0099', 'STF-0001', 'zzz', 'x', 'ROL-0999', 'pbkdf2_sha256$1$a$b', '${AT}', '${AT}')`); }
  catch (e) { blocked = /FOREIGN KEY/.test(e.message) ? 'FOREIGN KEY' : e.message; }
  check('an account can only point at a role that exists', blocked, 'FOREIGN KEY');

  // Existing data: an Administrator account made before 0018 becomes Super Admin.
  const DB = makeD1(ALL_MIGRATIONS, { at: '0018_roles_permissions.sql', run: (raw) => raw.exec(`
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Existing Owner', '01911000001', 'Active', 'Owner', 'Office', '${AT}');
    INSERT INTO user_accounts (id, staff_id, username, role, status, password_hash, password_changed_at, created_at)
      VALUES ('USR-0001', 'STF-0001', 'owner', 'Administrator', 'Active', 'pbkdf2_sha256$1$a$b', '${AT}', '${AT}');`) });
  check('an existing Administrator account is linked to Super Admin; nothing else about it changes',
    DB.raw.prepare('SELECT id, username, role, role_id, status FROM user_accounts').all().map((r) => ({ ...r })),
    [{ id: 'USR-0001', username: 'owner', role: 'Administrator', role_id: 'ROL-0001', status: 'Active' }]);
  const sql = readFileSync(join(ROOT, 'migrations', '0018_roles_permissions.sql'), 'utf8').replace(/--.*$/gm, '');
  ok_('the migration is additive: no DROP, no DELETE, no existing column altered; the only UPDATE fills the new role_id',
    !/\bDROP\b/i.test(sql) && !/\bDELETE\s+FROM\b/i.test(sql) && (sql.match(/\bUPDATE\b/gi) || []).length === 1 && /UPDATE user_accounts SET role_id = 'ROL-0001' WHERE role_id IS NULL AND role = 'Administrator'/.test(sql)
      && (sql.match(/ALTER TABLE/g) || []).length === 1 && /ALTER TABLE user_accounts ADD COLUMN role_id/.test(sql), '');
}

/* ---------- B. coverage ---------- */
console.log('\n-- B. every route has a permission --');
{
  const r = await worker.fetch(new Request('http://x/api/__nope__'), { DB: makeD1(), API_TOKEN: TOKEN }, { waitUntil() {} });
  const routes = (await r.json()).error.available;
  const PUBLIC = ['GET /api/health', 'GET /api/session', 'POST /api/session', 'DELETE /api/session', 'GET /api/webhooks/messenger', 'POST /api/webhooks/messenger',
    'GET /api/webhooks/whatsapp', 'POST /api/webhooks/whatsapp', 'POST /api/forms/submit',
    // 0019: dispatched before the gate; each checks the person's own session itself.
    'POST /api/session/password', 'PUT /api/session/passphrase'];
  const needOf = (route) => {
    const [method, path] = route.split(' ');
    const m = /^\/api\/([a-z-]+)(?:\/:id(?:\/([a-z-]+))?)?$/.exec(path);
    if (m && COLLECTION_PERMISSIONS[m[1]] !== undefined) {
      const [, name, action] = m;
      if (action) return collectionPermission(name, action);
      if (method === 'GET') return collectionPermission(name, 'view');
      if (method === 'POST') return collectionPermission(name, 'create');
      if (method === 'PUT') return collectionPermission(name, 'update');
      return collectionPermission(name, 'remove');
    }
    return routePermission(method, path.replace(/:id/g, 'X-1'));
  };
  const protectedRoutes = routes.filter((x) => !PUBLIC.includes(x));
  const unnamed = protectedRoutes.filter((x) => needOf(x) === FULL);
  check('no protected route falls through to "full access only"', unnamed, []);
  const bad = protectedRoutes.filter((x) => { const n = needOf(x); return n !== AUTHENTICATED && ![].concat(n).every(isPermission); });
  check('   ...each names permissions that exist in the catalog', bad, []);
  check('   ...the only routes open to anyone signed in are reading settings', protectedRoutes.filter((x) => needOf(x) === AUTHENTICATED), ['GET /api/settings']);
  const app = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const pagePerms = [...app.slice(app.indexOf('const PAGE_PERMISSIONS'), app.indexOf('};', app.indexOf('const PAGE_PERMISSIONS'))).matchAll(/'([a-z_]+\.[a-z]+)'/g)].map((m) => m[1]);
  const requires = readdirSync(join(ROOT, 'pages')).flatMap((f) => [...readFileSync(join(ROOT, 'pages', f), 'utf8').matchAll(/data-requires="([^"]+)"/g)].map((m) => m[1]));
  check('every permission a page or control asks for exists', [...pagePerms, ...requires].filter((p) => !isPermission(p)), []);
  ok_('   ...and pages ask for some of each kind', pagePerms.length > 30 && requires.length >= 15, `${pagePerms.length} pages, ${requires.length} controls`);
  check('the catalog has no duplicates', ALL_PERMISSIONS.length, new Set(ALL_PERMISSIONS).size);
}

/* ---------- C. roles API ---------- */
console.log('\n-- C. roles API --');
{
  const h = fresh();
  const list = await h.api('GET', '/api/roles');
  check('GET /api/roles: every role, with permissions, account counts and the catalog', [list.status, list.body.data.length, Array.isArray(list.body.catalog), list.body.data[0].name, list.body.data[0].fullAccess, list.body.data[0].permissions.length],
    [200, 8, true, 'Super Admin', true, ALL_PERMISSIONS.length]);
  check('   ...search and status filters', [(await h.api('GET', '/api/roles?q=ACCOUNTANT')).body.data.map((r) => r.name), (await h.api('GET', '/api/roles?status=Inactive')).body.data.length], [['Accountant'], 0]);
  check('   ...a bad filter is 400', (await h.api('GET', '/api/roles?status=Gone')).status, 400);

  const made = await h.api('POST', '/api/roles', { name: '  Night   Desk ', description: 'Evening front desk', permissions: ['customers.view', 'appointments.view', 'appointments.view'] });
  check('create: 201, a ROL id, name tidied, permissions de-duplicated', [made.status, made.body.data.id, made.body.data.name, made.body.data.permissions], [201, 'ROL-0009', 'Night Desk', ['appointments.view', 'customers.view']]);
  const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();
  check('create refuses: a short name, an unknown permission, a missing list, unknown fields', [
    fields(await h.api('POST', '/api/roles', { name: 'X', permissions: [] })),
    fields(await h.api('POST', '/api/roles', { name: 'Fine', permissions: ['customers.fly', 'admin.*'] })),
    fields(await h.api('POST', '/api/roles', { name: 'Fine' })),
    fields(await h.api('POST', '/api/roles', { name: 'Fine', permissions: [], fullAccess: true, is_system: 1 })),
  ], [['name'], ['permissions'], ['permissions'], ['fullAccess', 'is_system']]);
  check('a duplicate name in any case is 409', (await h.api('POST', '/api/roles', { name: 'night desk', permissions: [] })).status, 409);

  const id = made.body.data.id;
  const stamp = made.body.data.updatedAt;
  const ed = await h.api('PUT', `/api/roles/${id}`, { expectedUpdatedAt: stamp, permissions: ['customers.view', 'customers.create'], description: 'Changed' });
  check('edit: 200, the new permissions and description', [ed.status, ed.body.data.permissions, ed.body.data.description], [200, ['customers.create', 'customers.view'], 'Changed']);
  check('   ...an edit from the old version is 409 and changes nothing', [(await h.api('PUT', `/api/roles/${id}`, { expectedUpdatedAt: stamp, name: 'Overwrite' })).status, h.one('SELECT name FROM roles WHERE id = ?', id).name], [409, 'Night Desk']);
  check('   ...without expectedUpdatedAt is 422', (await h.api('PUT', `/api/roles/${id}`, { name: 'Again' })).status, 422);
  check('   ...renaming to another role\'s name is 409', (await h.api('PUT', `/api/roles/${id}`, { expectedUpdatedAt: ed.body.data.updatedAt, name: 'MECHANIC' })).status, 409);

  const sa = (await h.api('GET', '/api/roles/ROL-0001')).body.data;
  check('Super Admin cannot be renamed, narrowed, switched off or deleted -- not even with the machine token', [
    (await h.api('PUT', '/api/roles/ROL-0001', { expectedUpdatedAt: sa.updatedAt, name: 'Owner' })).status,
    (await h.api('PUT', '/api/roles/ROL-0001', { expectedUpdatedAt: sa.updatedAt, permissions: [] })).status,
    (await h.api('PUT', '/api/roles/ROL-0001', { expectedUpdatedAt: sa.updatedAt, status: 'Inactive' })).status,
    (await h.api('DELETE', '/api/roles/ROL-0001')).status,
  ], [403, 403, 403, 403]);
  check('   ...and it is unchanged', h.one("SELECT name, status, full_access FROM roles WHERE id='ROL-0001'"), { name: 'Super Admin', status: 'Active', full_access: 1 });

  await h.person(5, 'clerk', 'Night Desk');
  const cur = (await h.api('GET', `/api/roles/${id}`)).body.data;
  check('detail lists the accounts that hold it', [cur.accounts, cur.holders.map((x) => x.username)], [1, ['clerk']]);
  const off = await h.api('PUT', `/api/roles/${id}`, { expectedUpdatedAt: cur.updatedAt, status: 'Inactive' });
  check('a role an account holds cannot be switched off (409, how many) ...', [off.status, off.body.error.reason, off.body.error.accounts], [409, 'role_in_use', 1]);
  const del = await h.api('DELETE', `/api/roles/${id}`);
  check('   ...or deleted (409)', [del.status, del.body.error.reason, h.one('SELECT count(*) AS n FROM roles WHERE id = ?', id).n], [409, 'role_in_use', 1]);
  const spare = await h.api('POST', '/api/roles', { name: 'Spare', permissions: ['customers.view'] });
  const spareOff = await h.api('PUT', `/api/roles/${spare.body.data.id}`, { expectedUpdatedAt: spare.body.data.updatedAt, status: 'Inactive' });
  check('an unused role can be switched off', [spareOff.status, spareOff.body.data.status], [200, 'Inactive']);
  check('   ...and is then refused when giving an account a role (422)', (await h.api('POST', '/api/accounts', { staffId: 'STF-0006', username: 'spare', role: 'Spare', password: PW })).status, 422);
  const gone = await h.api('DELETE', `/api/roles/${spare.body.data.id}`);
  check('   ...and deleted, with its permissions', [gone.status, h.one('SELECT count(*) AS n FROM role_permissions WHERE role_id = ?', spare.body.data.id).n], [200, 0]);
  check('unknown role 404, malformed id 400', [(await h.api('GET', '/api/roles/ROL-0404')).status, (await h.api('GET', '/api/roles/admin')).status], [404, 400]);
}

/* ---------- D. enforcement ---------- */
console.log('\n-- D. enforcement per role --');
{
  const h = fresh();
  const before = h.DB.statements.length;
  const anon = [];
  for (const [m, p] of [['GET', '/api/roles'], ['POST', '/api/roles'], ['GET', '/api/invoices'], ['PUT', '/api/accounts/USR-0001'], ['GET', '/api/customers']]) anon.push((await h.api(m, p, m === 'GET' ? undefined : {}, 'none')).status);
  check('without a credential everything is 401', anon, [401, 401, 401, 401, 401]);
  check('   ...before any statement reaches the database', h.DB.statements.length, before);

  const admin = await h.person(1, 'admin', 'Admin');
  const mech = await h.person(2, 'mech', 'Mechanic');
  const acc = await h.person(3, 'acct', 'Accountant');
  const st = async (cred, list) => { const out = []; for (const [m, p, b] of list) out.push((await h.api(m, p, b, cred)).status); return out; };

  check('Admin: customers, invoices, payments, settings, user accounts, tools and roles may be read', await st(admin.cookie, [
    ['GET', '/api/customers'], ['GET', '/api/invoices'], ['GET', '/api/payments'], ['GET', '/api/accounts'], ['GET', '/api/tools'], ['GET', '/api/roles']]),
  [200, 200, 200, 200, 200, 200]);
  check('   ...and may add a customer and change settings, but not create or edit role definitions', await st(admin.cookie, [
    ['POST', '/api/customers', { name: 'Admin Made', phone: '01700000010' }], ['PUT', '/api/settings', { businessName: 'Test Workshop', phone: '01700000000', address: 'Test Road' }],
    ['POST', '/api/roles', { name: 'Sneaky', permissions: [] }], ['PUT', '/api/roles/ROL-0007', { expectedUpdatedAt: 'x', name: 'Mech' }], ['DELETE', '/api/roles/ROL-0008']]),
  [201, 200, 403, 403, 403]);

  check('Mechanic: may read customers, vehicles, appointments, job cards, parts and tools', await st(mech.cookie, [
    ['GET', '/api/customers'], ['GET', '/api/vehicles'], ['GET', '/api/appointments'], ['GET', '/api/job-cards'], ['GET', '/api/parts'], ['GET', '/api/tools']]),
  [200, 200, 200, 200, 200, 200]);
  check('   ...but no money records: invoices, payments, expenses, estimates, write-offs are 403', await st(mech.cookie, [
    ['GET', '/api/invoices'], ['GET', '/api/invoices/INV-0001'], ['GET', '/api/payments'], ['GET', '/api/expenses'], ['GET', '/api/estimates'], ['GET', '/api/invoice-adjustments']]),
  [403, 403, 403, 403, 403, 403]);
  check('   ...nor any write it was not given: new customer, invoice, payment, part, retire a tool, settings', await st(mech.cookie, [
    ['POST', '/api/customers', { name: 'Mech Made', phone: '01700000011' }], ['POST', '/api/invoices', { jobCardId: 'JOB-0001' }], ['POST', '/api/payments', { customerId: 'CUS-0001', amount: 10 }],
    ['POST', '/api/parts', { name: 'X' }], ['POST', '/api/tools/TOL-0001/retire', { reason: 'x' }], ['PUT', '/api/settings', { businessName: 'Hacked' }]]),
  [403, 403, 403, 403, 403, 403]);
  check('   ...nor staff, user accounts, roles, the activity log or the inbox', await st(mech.cookie, [
    ['GET', '/api/staff'], ['GET', '/api/accounts'], ['GET', '/api/roles'], ['GET', '/api/activity-log'], ['GET', '/api/website-forms'], ['GET', '/api/messenger/conversations']]),
  [403, 403, 403, 403, 403, 403]);
  check('   ...settings stay readable (every page shows the business name)', (await h.api('GET', '/api/settings', undefined, mech.cookie)).status !== 403, true);
  const refused = await h.api('GET', '/api/invoices', undefined, mech.cookie);
  check('   ...a refusal is a plain 403 that names nothing', [refused.body.error.code, refused.body.error.message], ['forbidden', 'Your role does not allow this.']);
  check('   ...and nothing was written by any refused request', h.one("SELECT count(*) AS n FROM customers WHERE name = 'Mech Made'").n, 0);

  check('Accountant: invoices, payments and expenses, read and write; job cards to read', await st(acc.cookie, [
    ['GET', '/api/invoices'], ['GET', '/api/payments'], ['GET', '/api/expenses'], ['GET', '/api/job-cards'],
    ['POST', '/api/expenses', { date: '2026-10-01', category: 'Utilities', description: 'Test bill', amount: 50, method: 'Cash' }]]),
  [200, 200, 200, 200, 201]);
  check('   ...but not workshop assets, opening job cards, editing customers, or staff', await st(acc.cookie, [
    ['GET', '/api/tools'], ['POST', '/api/tools', { name: 'Jack' }], ['POST', '/api/job-cards', { customerId: 'CUS-0001' }], ['PUT', '/api/customers/CUS-0001', { name: 'X' }], ['GET', '/api/staff']]),
  [403, 403, 403, 403, 403]);

  // The session tells the app what to show -- and only what the database says.
  const s = (await h.api('GET', '/api/session', undefined, mech.cookie)).body.data;
  check('GET /api/session reports the Mechanic role and its permissions (for display)', [s.account.role, s.account.roleId, s.fullAccess, s.permissions.includes('job_cards.manage'), s.permissions.includes('invoices.view')],
    ['Mechanic', 'ROL-0007', false, true, false]);
}

/* ---------- E. escalation ---------- */
console.log('\n-- E. privilege escalation --');
{
  const h = fresh();
  // A role that may manage some roles and accounts, but holds little else.
  const rm = await h.api('POST', '/api/roles', { name: 'Role Keeper', permissions: ['roles.view', 'roles.create', 'roles.edit', 'roles.manage', 'users.view', 'users.edit', 'users.manage', 'users.create', 'customers.view'] });
  const keeper = await h.person(1, 'keeper', 'Role Keeper');
  const clerk = await h.person(5, 'clerk', 'Staff');
  const sup = await h.person(7, 'boss', 'Super Admin');
  const acctRole = (await h.api('GET', '/api/roles/ROL-0004')).body.data;

  check('it cannot create a role with a permission it lacks (403), or with more than it has', [
    (await h.api('POST', '/api/roles', { name: 'Money', permissions: ['invoices.view'] }, keeper.cookie)).status,
    (await h.api('POST', '/api/roles', { name: 'Money', permissions: ['customers.view', 'payments.manage'] }, keeper.cookie)).status], [403, 403]);
  const small = await h.api('POST', '/api/roles', { name: 'Lookup', permissions: ['customers.view'] }, keeper.cookie);
  check('   ...but may create one within its own permissions', small.status, 201);
  check('it cannot edit a role that has more than it has (Accountant), nor add what it lacks to its own creation', [
    (await h.api('PUT', '/api/roles/ROL-0004', { expectedUpdatedAt: acctRole.updatedAt, description: 'x' }, keeper.cookie)).status,
    (await h.api('PUT', `/api/roles/${small.body.data.id}`, { expectedUpdatedAt: small.body.data.updatedAt, permissions: ['customers.view', 'invoices.view'] }, keeper.cookie)).status], [403, 403]);
  check('it cannot edit or delete the role it holds itself', [
    (await h.api('PUT', `/api/roles/${rm.body.data.id}`, { expectedUpdatedAt: rm.body.data.updatedAt, permissions: [] }, keeper.cookie)).status,
    (await h.api('DELETE', `/api/roles/${rm.body.data.id}`, undefined, keeper.cookie)).status], [403, 403]);
  check('it cannot give an account a role beyond its own (Accountant), nor Super Admin', [
    (await h.api('PUT', `/api/accounts/${clerk.id}`, { role: 'Accountant' }, keeper.cookie)).status,
    (await h.api('PUT', `/api/accounts/${clerk.id}`, { roleId: 'ROL-0001' }, keeper.cookie)).status,
    (await h.api('POST', '/api/accounts', { staffId: 'STF-0006', username: 'newboss', role: 'Super Admin', password: PW }, keeper.cookie)).status], [403, 403, 403]);
  check('   ...and the clerk still has Staff', h.one('SELECT role_id FROM user_accounts WHERE id = ?', clerk.id).role_id, 'ROL-0008');
  const above = await h.api('PUT', `/api/accounts/${clerk.id}`, { roleId: small.body.data.id }, keeper.cookie);
  check('it cannot even move the clerk down: Staff holds a permission it lacks (dashboard), so that account is above it', [above.status, h.one('SELECT role_id FROM user_accounts WHERE id = ?', clerk.id).role_id], [403, 'ROL-0008']);
  await h.api('PUT', `/api/accounts/${clerk.id}`, { roleId: small.body.data.id });   // the machine token moves the clerk within reach
  const small2 = await h.api('POST', '/api/roles', { name: 'Lookup Two', permissions: ['customers.view'] }, keeper.cookie);
  const moved = await h.api('PUT', `/api/accounts/${clerk.id}`, { roleId: small2.body.data.id }, keeper.cookie);
  check('it may move an account between roles within its reach', [moved.status, moved.body.data?.role ?? moved.text], [200, 'Lookup Two']);
  check('it cannot change its own role, not even to a smaller one', (await h.api('PUT', `/api/accounts/${keeper.id}`, { roleId: small.body.data.id }, keeper.cookie)).status, 409);
  check('it cannot switch off, reset or demote an account above it (the Super Admin)', [
    (await h.api('PUT', `/api/accounts/${sup.id}`, { status: 'Inactive' }, keeper.cookie)).status,
    (await h.api('POST', `/api/accounts/${sup.id}/password`, { password: 'Another-Password-1' }, keeper.cookie)).status,
    (await h.api('PUT', `/api/accounts/${sup.id}`, { roleId: small.body.data.id }, keeper.cookie)).status], [403, 403, 403]);
  check('   ...and the Super Admin is untouched', h.one('SELECT status, role_id FROM user_accounts WHERE id = ?', sup.id), { status: 'Active', role_id: 'ROL-0001' });

  const clerk2 = (await h.api('POST', '/api/session', { username: 'clerk', password: PW2 }, 'none')).cookie;
  check('a role without Roles: assign cannot assign roles at all', (await h.api('PUT', `/api/accounts/${clerk.id}`, { roleId: 'ROL-0008' }, clerk2)).status, 403);
  check('nothing the browser sends counts: role, permissions or fullAccess in a body are refused or ignored', [
    (await h.api('POST', '/api/customers', { name: 'X', phone: '01700000012', role: 'Super Admin', permissions: ['*'] }, clerk2)).status,
    (await h.api('GET', '/api/invoices?role=Super%20Admin&fullAccess=true', undefined, clerk2)).status], [403, 403]);

  // The Super Admin may assign Super Admin.
  const up = await h.api('PUT', `/api/accounts/${clerk.id}`, { roleId: 'ROL-0001' }, sup.cookie);
  check('a Super Admin may make another account Super Admin', [up.status, up.body.data.role], [200, 'Super Admin']);
}

/* ---------- F. effects ---------- */
console.log('\n-- F. effects --');
{
  const h = fresh();
  const mech = await h.person(2, 'mech', 'Mechanic');
  check('a Mechanic cannot read invoices', (await h.api('GET', '/api/invoices', undefined, mech.cookie)).status, 403);
  const m = (await h.api('GET', '/api/roles/ROL-0007')).body.data;
  await h.api('PUT', '/api/roles/ROL-0007', { expectedUpdatedAt: m.updatedAt, permissions: [...m.permissions, 'invoices.view'] });
  check('   ...a role change applies on the very next request, without signing in again', (await h.api('GET', '/api/invoices', undefined, mech.cookie)).status, 200);
  await h.api('PUT', `/api/accounts/${mech.id}`, { role: 'Accountant' });
  check('moving an account to another role signs it out (its next request is 401)', (await h.api('GET', '/api/customers', undefined, mech.cookie)).status, 401);
  const again = (await h.api('POST', '/api/session', { username: 'mech', password: PW2 }, 'none')).cookie;
  check('   ...and after signing in it has the new role', (await h.api('GET', '/api/session', undefined, again)).body.data.account.role, 'Accountant');

  const clerk = await h.person(5, 'clerk', 'Staff');
  h.DB.raw.exec(`UPDATE user_accounts SET role_id = NULL WHERE id = '${clerk.id}'`);
  check('an account with no role has no access at all (fail closed), but may still sign in and read settings', [
    (await h.api('GET', '/api/customers', undefined, clerk.cookie)).status, (await h.api('GET', '/api/notifications', undefined, clerk.cookie)).status,
    (await h.api('GET', '/api/session', undefined, clerk.cookie)).body.data.permissions.length, (await h.api('GET', '/api/settings', undefined, clerk.cookie)).status !== 403], [403, 403, 0, true]);
  h.DB.raw.exec(`UPDATE user_accounts SET role_id = 'ROL-0008' WHERE id = '${clerk.id}'; UPDATE roles SET status = 'Inactive' WHERE id = 'ROL-0008';`);
  check('   ...nor does an account whose role is switched off', (await h.api('GET', '/api/customers', undefined, clerk.cookie)).status, 403);
  h.DB.raw.exec("UPDATE roles SET status = 'Active' WHERE id = 'ROL-0008'");

  // Notifications follow the role.
  h.DB.raw.exec(`INSERT INTO notifications (event_key, event_type, category, title, message, record_type, record_id, created_at) VALUES
    ('t:1', 'payment.received', 'Finance', 'Payment received', 'x', 'payment', 'PAY-0001', '${AT}'),
    ('t:2', 'customer.created', 'Customer', 'New customer registered', 'x', 'customer', 'CUS-0001', '${AT}'),
    ('t:3', 'job_card.created', 'Workshop', 'Job card created', 'x', 'job_card', 'JOB-0001', '${AT}')`);
  const titles = async (cred) => ((await h.api('GET', '/api/notifications', undefined, cred)).body?.data || []).map((n) => n.title).sort();
  const mech2 = await h.person(4, 'mech2', 'Mechanic');
  check('a Mechanic sees job card and customer notifications, not payments', await titles(mech2.cookie), ['Job card created', 'New customer registered']);
  check('   ...its unread count agrees', (await h.api('GET', '/api/notifications/unread-count', undefined, mech2.cookie)).body.data.total, 2);
  check('   ...and it cannot mark the payment one read (404, as if it did not exist)', (await h.api('POST', '/api/notifications/1/read', undefined, mech2.cookie)).status, 404);
  check('the Staff role sees only the customer one', await titles(clerk.cookie), ['New customer registered']);
  check('the passphrase and the token still see everything, as before', [await titles((await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie), await titles('token')],
    [['Job card created', 'New customer registered', 'Payment received'], ['Job card created', 'New customer registered', 'Payment received']]);
}

console.log(`\nRoles unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
