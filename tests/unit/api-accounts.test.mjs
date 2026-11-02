/* User accounts (0009) — unit tests against the REAL Worker: /api/accounts,
   account sign-in through /api/session, and the auth gate's account sessions.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0009) through the same minimal D1-shaped wrapper the staff
   suite uses, with the real passphrase, cookie signing and PBKDF2 hashing.

   What must hold:
     A. Schema: columns, CHECKs (username shape, exactly one person), the
        foreign keys and their cascade, one account per person, usernames
        unique ignoring case, the USR counter; re-runnable.
     B. Authorization: no credential -> 401 on every route before any
        statement; the passphrase session, the machine token and an
        Administrator account may manage accounts; an account whose role is
        anything else gets 403 on every route (no self-promotion).
     C. Create: for an existing active staff member only (mechanic or other
        staff), server id, lower-case username, only the Administrator role,
        password rules, unknown properties refused (no id, hash, status or
        session field can be set), one account per person (409), duplicate
        username any case (409); nothing secret in any response.
     D. List and detail: search (name, staff id, username), status and role
        filters, bad parameters 400, never a hash / session version / counter.
     E. Sign-in: username + password -> a session the gate accepts; the
        passphrase still works; wrong password, unknown name, inactive
        account or inactive staff -> the same 401; five wrong passwords pause
        the account; last sign-in recorded.
     F. Activate / deactivate: revocation is immediate (the old cookie stops
        working, and stays dead after re-activation); nobody deactivates
        their own account; the last active administrator account can only be
        switched off by the passphrase holder; an inactive staff member's
        account cannot be re-activated.
     G. New password: rules, old password and old sessions stop working.
     H. Compatibility: existing staff, mechanics, job cards and appointments
        untouched; deleting an unused mechanic takes its account with it.
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
  console.log(`\nAccounts unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql', '0009_user_accounts.sql', '0018_roles_permissions.sql', '0019_individual_login.sql'];
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';
const SECRETS = /pbkdf2|password_hash|passwordHash|session_version|sessionVersion|failed_logins|failedLogins|locked_until/i;

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
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Rahim', '01700000001', '${AT}');
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R1', 'Toyota', 'Corolla', '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, salary, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'Engine', 25000, '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0002', 'Kamal', '01800000002', 'AC', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0003', 'Left Already', '01800000003', 'Inactive', '${AT}');
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0004', 'Unused', '01800000004', '${AT}');
    UPDATE id_counters SET last_value = 4 WHERE collection = 'mechanics';
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Accountant', 'Accounts', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0002', 'Gone Staff', '01911000002', 'Inactive', 'Helper', 'Workshop', '${AT}');
    UPDATE id_counters SET last_value = 2 WHERE collection = 'staff';
    INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, created_at) VALUES ('JOB-0001', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-10-01', 'Noise', '${AT}');
    INSERT INTO services (id, name, price, created_at) VALUES ('SRV-0001', 'Brake service', 1200, '${AT}');
    INSERT INTO appointments (id, customer_id, vehicle_id, service_id, mechanic_id, date, time, created_at) VALUES ('APT-0001', 'CUS-0001', 'VEH-0001', 'SRV-0001', 'MEC-0002', '2026-10-09', '10:00', '${AT}');`);
  const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
  /** cred: 'token' | 'none' | a cookie string. */
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
  const signIn = async (username, password = PW) => api('POST', '/api/session', { username, password }, 'none');
  const passphraseCookie = async () => (await api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie;
  return { DB, env, api, one, signIn, passphraseCookie };
}

const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();
const NEW = (extra = {}) => ({ staffId: 'MEC-0001', username: 'jamal', role: 'Super Admin', password: PW, ...extra });

console.log('=== User accounts (0009) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  check('user_accounts has the designed columns', h.DB.raw.prepare('PRAGMA table_info(user_accounts)').all().map((c) => c.name),
    ['id', 'mechanic_id', 'staff_id', 'username', 'role', 'status', 'password_hash', 'session_version', 'failed_logins',
      'locked_until', 'last_login_at', 'password_changed_at', 'created_at', 'updated_at', 'role_id', 'email', 'mobile', 'password_change_required']);
  check('foreign keys: mechanics and staff (ON DELETE CASCADE), and the role (0018, RESTRICT)',
    h.DB.raw.prepare('PRAGMA foreign_key_list(user_accounts)').all().map((f) => `${f.from}->${f.table}.${f.to} ${f.on_delete}`).sort(),
    ['mechanic_id->mechanics.id CASCADE', 'role_id->roles.id RESTRICT', 'staff_id->staff.id CASCADE']);
  check('indexes: username (any case), one per mechanic, one per staff member, status, role (0018)',
    h.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='user_accounts' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    ['ix_accounts_status', 'ix_user_accounts_role', 'ux_accounts_email', 'ux_accounts_mechanic', 'ux_accounts_staff', 'ux_accounts_username']);
  check('the USR counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='accounts'"), { prefix: 'USR', last_value: 0 });
  const ins = (id, m, s, u, hash = 'pbkdf2_sha256$1$a$b') => {
    try { h.DB.raw.prepare('INSERT INTO user_accounts (id, mechanic_id, staff_id, username, role, password_hash, password_changed_at, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, m, s, u, 'Administrator', hash, AT, AT); return 'ok'; }
    catch (e) { return /UNIQUE/.test(e.message) ? 'unique' : /FOREIGN/.test(e.message) ? 'fk' : /CHECK/.test(e.message) ? 'check' : e.message; }
  };
  check('the schema refuses: no person, both people, a missing staff id, a mechanic profile as staff, an upper-case or spaced username, a plain password',
    [ins('USR-9001', null, null, 'aaa'), ins('USR-9002', 'MEC-0001', 'STF-0001', 'bbb'), ins('USR-9003', null, 'STF-0999', 'ccc'),
      ins('USR-9004', null, 'MEC-0001', 'ddd'), ins('USR-9005', 'MEC-0001', null, 'Eee'), ins('USR-9006', 'MEC-0001', null, 'e e'),
      ins('USR-9007', 'MEC-0001', null, 'fff', 'plain-text')], ['check', 'check', 'fk', 'check', 'check', 'check', 'check']);
  check('...and allows one account per person, one person per username',
    [ins('USR-9010', 'MEC-0001', null, 'jamal'), ins('USR-9011', 'MEC-0001', null, 'jamal2'), ins('USR-9012', null, 'STF-0001', 'jamal')],
    ['ok', 'unique', 'unique']);
  h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0009_user_accounts.sql'), 'utf8'));
  ok_('the migration can be re-run without error or loss', h.one('SELECT count(*) AS n FROM user_accounts').n === 1);
}

/* ---------- B. authorization ---------- */
console.log('\n-- B. authorization --');
{
  const h = fresh();
  const before = h.DB.statements.length;
  const routes = [['GET', '/api/accounts'], ['POST', '/api/accounts', NEW()], ['GET', '/api/accounts/USR-0001'],
    ['PUT', '/api/accounts/USR-0001', { status: 'Inactive' }], ['POST', '/api/accounts/USR-0001/password', { password: PW }]];
  const anon = [];
  for (const [m, p, b] of routes) anon.push((await h.api(m, p, b, 'none')).status);
  check('without a credential every account route is 401', anon, [401, 401, 401, 401, 401]);
  check('   ...before any statement reaches the database', h.DB.statements.length, before);
  check('a tampered or forged account cookie is 401', [
    (await h.api('GET', '/api/accounts', undefined, 'taqwa_session=a1.9999999999.USR-0001.1.forged')).status,
    (await h.api('GET', '/api/accounts', undefined, 'taqwa_session=v1.9999999999.forged')).status], [401, 401]);

  const owner = await h.passphraseCookie();
  ok_('the workshop passphrase still signs in, as before', owner.startsWith('taqwa_session=v1.'), owner.slice(0, 20));
  check('the passphrase session may manage accounts', (await h.api('GET', '/api/accounts', undefined, owner)).status, 200);
  check('so may the machine token', (await h.api('GET', '/api/accounts')).status, 200);

  const made = await h.api('POST', '/api/accounts', NEW(), owner);
  check('the passphrase holder creates a Super Admin account', [made.status, made.body?.data?.id, made.body?.data?.role, made.body?.data?.roleId], [201, 'USR-0001', 'Super Admin', 'ROL-0001']);
  const admin = (await h.signIn('jamal')).cookie;
  check('an Administrator account may manage accounts too', (await h.api('GET', '/api/accounts', undefined, admin)).status, 200);

  // An account whose role has no User Accounts permission (Staff, 0018) is refused everything here.
  await h.api('POST', '/api/accounts', NEW({ staffId: 'STF-0001', username: 'nadia' }));
  h.DB.raw.exec("UPDATE user_accounts SET role_id = 'ROL-0008' WHERE username = 'nadia'");
  const viewer = (await h.signIn('nadia')).cookie;
  ok_('an account with a restricted role can sign in', viewer.startsWith('taqwa_session=a1.'));
  const denied = [];
  for (const [m, p, b] of [['GET', '/api/accounts'], ['GET', '/api/accounts/USR-0001'], ['POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal' })],
    ['PUT', '/api/accounts/USR-0002', { role: 'Super Admin' }], ['POST', '/api/accounts/USR-0001/password', { password: 'Another-Password-1' }]]) {
    denied.push((await h.api(m, p, b, viewer)).status);
  }
  check('...but is refused every account route (403): it cannot list, create, promote itself or reset an administrator', denied, [403, 403, 403, 403, 403]);
  check('   ...and nothing changed', [h.one("SELECT role_id FROM user_accounts WHERE username='nadia'").role_id, h.one("SELECT count(*) AS n FROM user_accounts").n], ['ROL-0008', 2]);
}

/* ---------- C. create ---------- */
console.log('\n-- C. create --');
{
  const h = fresh();
  const a = await h.api('POST', '/api/accounts', NEW({ username: '  Jamal.U  ' }));
  check('a mechanic gets an account: 201, server id, lower-case username, linked by MEC id', [a.status, a.body?.data?.id, a.body?.data?.username, a.body?.data?.staffId, a.body?.data?.isMechanic, a.body?.data?.staffName],
    [201, 'USR-0001', 'jamal.u', 'MEC-0001', true, 'Jamal Uddin']);
  ok_('   ...the response holds no password, hash, session version or counter', !SECRETS.test(a.text) && !a.text.includes(PW), a.text);
  const row = h.one("SELECT * FROM user_accounts WHERE id='USR-0001'");
  ok_('   ...the database holds a salted PBKDF2 hash, never the password', /^pbkdf2_sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(row.password_hash) && !row.password_hash.includes(PW), row.password_hash);
  check('   ...the mechanic itself is untouched (no copy, same id, pay and job card)', [h.one("SELECT count(*) AS n FROM mechanics").n, h.one("SELECT salary FROM mechanics WHERE id='MEC-0001'").salary, h.one("SELECT mechanic_id FROM job_cards WHERE id='JOB-0001'").mechanic_id], [4, 25000, 'MEC-0001']);
  const b = await h.api('POST', '/api/accounts', NEW({ staffId: 'STF-0001', username: 'nadia' }));
  check('another employee gets an account by STF id', [b.status, b.body?.data?.staffId, b.body?.data?.isMechanic, b.body?.data?.designation], [201, 'STF-0001', false, 'Accountant']);

  const dupPerson = await h.api('POST', '/api/accounts', NEW({ username: 'jamal2' }));
  check('a second account for the same person: 409 naming the existing one', [dupPerson.status, dupPerson.body?.error?.field, dupPerson.body?.error?.conflictsWith], [409, 'staffId', 'USR-0001']);
  const dupName = await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'NADIA' }));
  check('a username already taken, in any case: 409', [dupName.status, dupName.body?.error?.field], [409, 'username']);
  check('an inactive staff member (mechanic or other) cannot get an account', [
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0003', username: 'left' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'STF-0002', username: 'gone' })))], [['staffId'], ['staffId']]);
  check('a staff id that does not exist, or is not a staff id at all', [
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'STF-0999', username: 'ghost' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'CUS-0001', username: 'ghost' })))], [['staffId'], ['staffId']]);
  check('the role must exist: an unknown one, the retired name "Administrator", or none at all is refused', [
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', role: 'Owner' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', role: 'administrator' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', role: undefined })))], [['role'], ['role'], ['role']]);
  check('password rules: too short, containing the username, padded with spaces, missing', [
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', password: 'short' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', password: 'kamal-is-my-name' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', password: ' padded-password ' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal', password: undefined })))],
  [['password'], ['password'], ['password'], ['password']]);
  check('bad usernames: too short, spaces, symbols', [
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'ab' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'ka mal' }))),
    fields(await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal<b>' })))], [['username'], ['username'], ['username']]);
  const mass = await h.api('POST', '/api/accounts', { ...NEW({ staffId: 'MEC-0002', username: 'kamal' }), id: 'USR-9999', status: 'Inactive', passwordHash: 'x', password_hash: 'x', sessionVersion: 9, mechanicId: 'MEC-0001', lastLoginAt: AT });
  check('mass assignment refused: id, status, hashes, session version, mechanicId and lastLoginAt are each named', fields(mass),
    ['id', 'lastLoginAt', 'mechanicId', 'passwordHash', 'password_hash', 'sessionVersion', 'status']);
  check('   ...and nothing was created by any refused request', h.one('SELECT count(*) AS n FROM user_accounts').n, 2);
  ok_('no refusal echoes a password', ![mass, dupName, dupPerson].some((r) => r.text.includes(PW)));
  check('a body that is not JSON: 400', (await h.api('POST', '/api/accounts', 'not json')).status, 400);
}

/* ---------- D. list and detail ---------- */
console.log('\n-- D. list and detail --');
{
  const h = fresh();
  await h.api('POST', '/api/accounts', NEW());
  await h.api('POST', '/api/accounts', NEW({ staffId: 'STF-0001', username: 'nadia' }));
  await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0002', username: 'kamal' }));
  await h.api('PUT', '/api/accounts/USR-0003', { status: 'Inactive' });
  const all = await h.api('GET', '/api/accounts');
  check('the list: every account, sorted by name, with its staff member', all.body.data.map((a) => [a.id, a.staffName, a.username, a.status]),
    [['USR-0001', 'Jamal Uddin', 'jamal', 'Active'], ['USR-0003', 'Kamal', 'kamal', 'Inactive'], ['USR-0002', 'Nadia Akter', 'nadia', 'Active']]);
  check('   ...in one shape, with nothing secret', Object.keys(all.body.data[0]).sort(), ['createdAt', 'designation', 'email', 'id', 'isMechanic', 'lastLoginAt', 'locked', 'mobile', 'passwordChangeRequired', 'passwordChangedAt', 'role', 'roleId', 'self', 'staffId', 'staffName', 'staffStatus', 'status', 'username']);
  ok_('   ...no hash, session version or counter anywhere in the list', !SECRETS.test(all.text), all.text.slice(0, 200));
  const q = async (s) => (await h.api('GET', `/api/accounts?${s}`)).body.data.map((a) => a.id);
  check('search by name, staff id and username', [await q('q=nadia'), await q('q=mec-0002'), await q('q=JAM')], [['USR-0002'], ['USR-0003'], ['USR-0001']]);
  check('filters: status and role (by name, any case, or id)', [await q('status=Inactive'), (await q('role=super%20admin')).length, (await q('role=ROL-0001')).length, (await q('role=Mechanic')).length], [['USR-0003'], 3, 3, 0]);
  check('bad parameters: 400', [(await h.api('GET', '/api/accounts?status=Gone')).status, (await h.api('GET', `/api/accounts?role=${'x'.repeat(41)}`)).status, (await h.api('GET', '/api/accounts?limit=0')).status], [400, 400, 400]);
  const one = await h.api('GET', '/api/accounts/USR-0002');
  check('detail: the account, nothing secret', [one.status, one.body.data.username, SECRETS.test(one.text)], [200, 'nadia', false]);
  check('detail: unknown 404, malformed id 400', [(await h.api('GET', '/api/accounts/USR-0404')).status, (await h.api('GET', '/api/accounts/STF-0001')).status], [404, 400]);
  check('no DELETE: accounts are deactivated, never deleted (405)', (await h.api('DELETE', '/api/accounts/USR-0001')).status, 405);
}

/* ---------- E. sign-in ---------- */
console.log('\n-- E. sign-in --');
{
  const h = fresh();
  await h.api('POST', '/api/accounts', NEW());
  const s = await h.signIn('JAMAL');
  check('username (any case) + password -> 204 with an account session cookie', [s.status, s.cookie.startsWith('taqwa_session=a1.')], [204, true]);
  check('   ...which the gate accepts for business data', (await h.api('GET', '/api/customers', undefined, s.cookie)).status, 200);
  const who = await h.api('GET', '/api/session', undefined, s.cookie);
  check('   ...and GET /api/session says whose session it is (id, username, role only)', who.body.data.account, { id: 'USR-0001', username: 'jamal', name: 'Jamal Uddin', staffId: 'MEC-0001', role: 'Super Admin', roleId: 'ROL-0001', passwordChangeRequired: false });
  check('   ...and what it may do (0018, for display): full access', [who.body.data.fullAccess, who.body.data.permissions.includes('roles.edit')], [true, true]);
  ok_('   ...the last sign-in is recorded', !!h.one("SELECT last_login_at FROM user_accounts WHERE id='USR-0001'").last_login_at);
  const ownerWho = await h.api('GET', '/api/session', undefined, await h.passphraseCookie());
  ok_('a passphrase session names nobody', ownerWho.body.data.authenticated === true && !('account' in ownerWho.body.data));
  const wrong = await h.signIn('jamal', 'Wrong-Password-1');
  const unknown = await h.signIn('nobody', PW);
  check('a wrong password and an unknown username give the same 401, and no cookie', [wrong.status, unknown.status, wrong.text === unknown.text, wrong.cookie, unknown.cookie], [401, 401, true, '', '']);
  check('malformed sign-ins are the same 401', [(await h.signIn('', PW)).status, (await h.signIn('jamal', '')).status, (await h.api('POST', '/api/session', { username: {}, password: [] }, 'none')).status], [401, 401, 401]);
  for (let i = 0; i < 4; i++) await h.signIn('jamal', 'Wrong-Password-1');
  check('after five wrong passwords in a row the account is paused: even the right password is refused', (await h.signIn('jamal', PW)).status, 401);
  check('   ...the list says it is paused (and nothing more)', (await h.api('GET', '/api/accounts/USR-0001')).body.data.locked, true);
  h.DB.raw.exec("UPDATE user_accounts SET locked_until = '2000-01-01T00:00:00.000Z'");
  check('   ...once the pause is over, the right password works and the count resets', [(await h.signIn('jamal', PW)).status, h.one("SELECT failed_logins FROM user_accounts").failed_logins], [204, 0]);
  check('the passphrase still signs in with an account present', (await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).status, 204);
  check('a wrong passphrase is still 401', (await h.api('POST', '/api/session', { passphrase: 'nope' }, 'none')).status, 401);
  check('sign-out still clears the cookie', (await h.api('DELETE', '/api/session', undefined, s.cookie)).status, 204);
  const noSecret = { DB: h.DB, API_TOKEN: TOKEN };
  const res = await worker.fetch(new Request('http://worker.local/api/session', { method: 'POST', body: JSON.stringify({ username: 'jamal', password: PW }) }), noSecret);
  check('without a signing secret no account can sign in (401)', res.status, 401);
}

/* ---------- F. activate / deactivate ---------- */
console.log('\n-- F. activate / deactivate --');
{
  const h = fresh();
  const owner = await h.passphraseCookie();
  await h.api('POST', '/api/accounts', NEW(), owner);
  await h.api('POST', '/api/accounts', NEW({ staffId: 'STF-0001', username: 'nadia' }), owner);
  const jamal = (await h.signIn('jamal')).cookie;
  const nadia = (await h.signIn('nadia')).cookie;

  const self = await h.api('PUT', '/api/accounts/USR-0001', { status: 'Inactive' }, jamal);
  check('nobody can deactivate their own account (409)', [self.status, self.body?.error?.field], [409, 'status']);
  const off = await h.api('PUT', '/api/accounts/USR-0002', { status: 'Inactive' }, jamal);
  check('an administrator deactivates another account', [off.status, off.body?.data?.status], [200, 'Inactive']);
  check('   ...whose session stops working at once', (await h.api('GET', '/api/customers', undefined, nadia)).status, 401);
  check('   ...and who cannot sign in', (await h.signIn('nadia')).status, 401);
  const on = await h.api('PUT', '/api/accounts/USR-0002', { status: 'Active' }, jamal);
  check('re-activated: a new sign-in works, the old session stays dead', [on.status, (await h.api('GET', '/api/customers', undefined, nadia)).status, (await h.signIn('nadia')).status], [200, 401, 204]);

  // Jamal is now the only account it could be left to; he cannot switch himself off.
  await h.api('PUT', '/api/accounts/USR-0002', { status: 'Inactive' }, jamal);
  check('the last active administrator account cannot switch itself off', (await h.api('PUT', '/api/accounts/USR-0001', { status: 'Inactive' }, jamal)).status, 409);
  const byOwner = await h.api('PUT', '/api/accounts/USR-0001', { status: 'Inactive' }, owner);
  check('...the passphrase holder can (the passphrase still signs in, so nobody is locked out)', [byOwner.status, (await h.api('GET', '/api/customers', undefined, jamal)).status, (await h.api('GET', '/api/customers', undefined, owner)).status], [200, 401, 200]);
  check('own role cannot be changed; unknown or empty updates are refused', [
    (await h.api('PUT', '/api/accounts/USR-0001', { status: 'Active' }, owner)).status,
    fields(await h.api('PUT', '/api/accounts/USR-0001', { role: 'Owner' }, owner)),
    fields(await h.api('PUT', '/api/accounts/USR-0001', { username: 'other', passwordHash: 'x' }, owner)),
    fields(await h.api('PUT', '/api/accounts/USR-0001', {}, owner)),
    fields(await h.api('PUT', '/api/accounts/USR-0001', { status: 'Deleted' }, owner))],
  [200, ['role'], ['passwordHash', 'username'], ['status'], ['status']]);

  // The staff member leaves: the account can no longer sign in or be re-activated.
  const jamal2 = (await h.signIn('jamal')).cookie;
  h.DB.raw.exec("UPDATE mechanics SET status = 'Inactive' WHERE id = 'MEC-0001'");
  check('when the staff member becomes inactive, the account session stops and sign-in fails', [(await h.api('GET', '/api/customers', undefined, jamal2)).status, (await h.signIn('jamal')).status], [401, 401]);
  await h.api('PUT', '/api/accounts/USR-0001', { status: 'Inactive' }, owner);
  const back = await h.api('PUT', '/api/accounts/USR-0001', { status: 'Active' }, owner);
  check('   ...and its account cannot be re-activated (409)', [back.status, back.body?.error?.field], [409, 'status']);
  check('   ...the list shows the staff member as inactive', (await h.api('GET', '/api/accounts/USR-0001', undefined, owner)).body.data.staffStatus, 'Inactive');
}

/* ---------- G. new password ---------- */
console.log('\n-- G. new password --');
{
  const h = fresh();
  await h.api('POST', '/api/accounts', NEW());
  const old = (await h.signIn('jamal')).cookie;
  check('a weak or unknown-field new password is refused', [
    fields(await h.api('POST', '/api/accounts/USR-0001/password', { password: 'short' })),
    fields(await h.api('POST', '/api/accounts/USR-0001/password', { password: 'my-name-is-jamal' })),
    fields(await h.api('POST', '/api/accounts/USR-0001/password', { password: 'Another-Password-1', role: 'Owner' }))],
  [['password'], ['password'], ['role']]);
  check('only POST: a GET on the action is 405', (await h.api('GET', '/api/accounts/USR-0001/password')).status, 405);
  for (let i = 0; i < 5; i++) await h.signIn('jamal', 'Wrong-Password-1');
  const set = await h.api('POST', '/api/accounts/USR-0001/password', { password: 'Another-Password-1' });
  check('an administrator sets a new password: 200, nothing secret returned', [set.status, SECRETS.test(set.text), set.text.includes('Another-Password-1')], [200, false, false]);
  check('   ...the old password stops working and the new one works (the pause is lifted)', [(await h.signIn('jamal', PW)).status, (await h.signIn('jamal', 'Another-Password-1')).status], [401, 204]);
  check('   ...and every session from before is ended', (await h.api('GET', '/api/customers', undefined, old)).status, 401);
  check('unknown account: 404', (await h.api('POST', '/api/accounts/USR-0404/password', { password: 'Another-Password-1' })).status, 404);
}

/* ---------- H. compatibility ---------- */
console.log('\n-- H. compatibility --');
{
  const h = fresh();
  await h.api('POST', '/api/accounts', NEW({ staffId: 'MEC-0004', username: 'unused' }));
  await h.api('POST', '/api/accounts', NEW());
  const staff = await h.api('GET', '/api/staff');
  check('the Staff List is unchanged by accounts (same people, no account fields)', [staff.status, staff.body.data.length, staff.body.data.some((s) => 'username' in s)], [200, 6, false]);
  const mech = await h.api('GET', '/api/mechanics/MEC-0001');
  check('the Mechanics API is unchanged (pay still there for the Mechanics page)', [mech.status, mech.body.data.salary], [200, 25000]);
  const used = await h.api('DELETE', '/api/mechanics/MEC-0001');
  check('a mechanic with job cards still cannot be deleted; its account stays', [used.status, h.one("SELECT count(*) AS n FROM user_accounts WHERE mechanic_id='MEC-0001'").n], [409, 1]);
  const gone = await h.api('DELETE', '/api/mechanics/MEC-0004');
  check('deleting an unused mechanic on the Mechanics page takes its account with it', [gone.status, h.one("SELECT count(*) AS n FROM user_accounts WHERE mechanic_id='MEC-0004'").n], [200, 0]);
  check('job cards and appointments keep their mechanics', [h.one("SELECT mechanic_id FROM job_cards WHERE id='JOB-0001'").mechanic_id, h.one("SELECT mechanic_id FROM appointments WHERE id='APT-0001'").mechanic_id], ['MEC-0001', 'MEC-0002']);
  const route = await h.api('GET', '/api/nope');
  check('the route list advertises the five account routes', (route.body?.error?.available || []).filter((r) => r.includes('/api/accounts')),
    ['GET /api/accounts', 'POST /api/accounts', 'GET /api/accounts/:id', 'PUT /api/accounts/:id', 'POST /api/accounts/:id/password']);
  const broken = { ...h.env, DB: { prepare() { throw new Error('D1_ERROR: secret table detail'); } } };
  const res = await worker.fetch(new Request('http://worker.local/api/accounts', { headers: { authorization: `Bearer ${TOKEN}` } }), broken);
  const text = await res.text();
  check('a database failure is a plain 500 that reveals nothing', [res.status, /secret table detail|D1_ERROR/.test(text)], [500, false]);
}

console.log(`\nAccounts unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
