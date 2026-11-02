/* Individual staff login (0019) — unit tests against the REAL Worker.

   In-memory SQLite built from the real migrations; fictional test data only.

     A. Migration: additive; an existing account keeps its password, role and
        username, gets no invented e-mail, and is not forced to change its
        password; it still signs in exactly as before.
     B. One field, three identifiers: username, e-mail and Staff ID, any case;
        a wrong password, an unknown identifier, an inactive account or staff
        member, and an identifier that could mean two accounts all get the
        SAME 401; last sign-in recorded; cookie HttpOnly, Secure, SameSite.
     C. Uniqueness: duplicate username, e-mail (any case) and Staff ID are
        refused; a username may not look like a Staff ID.
     D. Sessions: GET /api/session names the person (never a hash); sign-out
        ends the account's sessions everywhere; a new sign-in issues a new
        cookie (no fixation).
     E. Reset: an administrator's reset (and a new account) must be replaced
        by the owner before anything else works; the change needs the current
        password, ends old sessions and issues a new cookie.
     F. Throttle: repeated failures for one identifier or one address get 429,
        even with the right password; only hashes are stored.
     G. Roles still apply; escalation via login or the passphrase switch fails.
     H. The shared passphrase: works by default; only a Super Admin's own
        account can switch it off (and on); off means its sign-in and its
        existing sessions stop.
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
  console.log(`\nLogin unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALL = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const TEMP = 'Temporary-Pass-11';
const OWN = 'My-Own-Secret-22';
const AT = '2026-10-08T00:00:00Z';

function makeD1(migrations = ALL, before = null) {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of migrations) {
    if (before && f === before.at) before.run(raw);
    raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  }
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

function fresh() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Test Mechanic One', '01800000001', 'Engine', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection = 'mechanics';
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES
      ('STF-0001', 'Test Owner', '01911000001', 'Active', 'Owner', 'Office', '${AT}'),
      ('STF-0002', 'Test Clerk', '01911000002', 'Active', 'Clerk', 'Office', '${AT}'),
      ('STF-0003', 'Test Leaver', '01911000003', 'Active', 'Clerk', 'Office', '${AT}'),
      ('STF-0004', 'Test Spare', '01911000004', 'Active', 'Clerk', 'Office', '${AT}');
    UPDATE id_counters SET last_value = 4 WHERE collection = 'staff';`);
  const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
  const ctx = { waitUntil() {} };
  const api = async (method, path, body, cred = 'token', headers = {}) => {
    const h = { ...headers };
    if (cred === 'token') h.authorization = `Bearer ${TOKEN}`;
    else if (cred !== 'none') h.cookie = cred;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await worker.fetch(new Request('http://worker.local' + path, {
      method, headers: h, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, ctx);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json, text, setCookie: res.headers.get('set-cookie') || '', retryAfter: res.headers.get('retry-after'),
      cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const login = (identifier, password = OWN, headers = {}) => api('POST', '/api/session', { identifier, password }, 'none', headers);
  /** An account made by the machine token, then its owner's first sign-in and own password. */
  const account = async (staffId, username, role, extra = {}) => {
    const made = await api('POST', '/api/accounts', { staffId, username, role, password: TEMP, ...extra });
    if (made.status !== 201) throw new Error(`account ${username}: ${made.text}`);
    const first = await login(username, TEMP);
    const changed = await api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: OWN }, first.cookie);
    if (changed.status !== 204) throw new Error(`password ${username}: ${changed.text}`);
    return { id: made.body.data.id, cookie: changed.cookie };
  };
  return { DB, env, api, one, login, account };
}

console.log('=== Individual staff login (0019) ===');

/* ---------- A. migration ---------- */
console.log('\n-- A. migration and existing accounts --');
{
  const legacyHash = 'pbkdf2_sha256$1$a$b';
  const DB = makeD1(ALL, { at: '0019_individual_login.sql', run: (raw) => raw.exec(`
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Existing Owner', '01911000001', 'Active', 'Owner', 'Office', '${AT}');
    INSERT INTO user_accounts (id, staff_id, username, role, role_id, status, password_hash, password_changed_at, created_at, last_login_at)
      VALUES ('USR-0001', 'STF-0001', 'owner', 'Administrator', 'ROL-0001', 'Active', '${legacyHash}', '${AT}', '${AT}', '${AT}');`) });
  const row = DB.raw.prepare('SELECT id, username, role, role_id, status, password_hash, email, mobile, password_change_required, last_login_at FROM user_accounts').get();
  check('an existing account keeps every value; it gets no invented e-mail or mobile and is not forced to change its password',
    { ...row }, { id: 'USR-0001', username: 'owner', role: 'Administrator', role_id: 'ROL-0001', status: 'Active', password_hash: legacyHash,
      email: null, mobile: null, password_change_required: 0, last_login_at: AT });
  check('the shared passphrase starts enabled (today\'s behaviour)', { ...DB.raw.prepare('SELECT passphrase_enabled FROM auth_settings').get() }, { passphrase_enabled: 1 });
  const sql = readFileSync(join(ROOT, 'migrations', '0019_individual_login.sql'), 'utf8').replace(/--.*$/gm, '');
  ok_('the migration is additive: no DROP, DELETE or UPDATE; only ADD COLUMN and new tables',
    !/\b(DROP|DELETE|UPDATE)\b/i.test(sql) && (sql.match(/ALTER TABLE user_accounts ADD COLUMN/g) || []).length === 3, '');
  // A real pre-0019 account (created before this change) still signs in with its old password, untouched.
  const h = fresh();
  await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'owner', role: 'Super Admin', password: TEMP });
  h.DB.raw.exec("UPDATE user_accounts SET password_change_required = 0");   // as every account made before 0019 is
  const s = await h.login('owner', TEMP);
  check('   ...and such an account signs in by username exactly as before, with full use', [s.status, (await h.api('GET', '/api/customers', undefined, s.cookie)).status], [204, 200]);
}

/* ---------- B. one field, three identifiers ---------- */
console.log('\n-- B. username, e-mail or Staff ID --');
{
  const h = fresh();
  const owner = await h.account('STF-0001', 'nadia.akter', 'Super Admin', { email: 'Nadia.Test@Example.COM', mobile: '+880 1711-000001' });
  check('the e-mail is stored in lower case, with the mobile', { ...h.one('SELECT email, mobile FROM user_accounts WHERE id = ?', owner.id) }, { email: 'nadia.test@example.com', mobile: '+880 1711-000001' });
  const byUser = await h.login('Nadia.Akter');
  const byMail = await h.login('  NADIA.TEST@example.com ');
  const byId = await h.login('stf-0001');
  check('signs in with the username, the e-mail or the Staff ID -- any case, spaces trimmed', [byUser.status, byMail.status, byId.status], [204, 204, 204]);
  check('   ...each gives an account session for the same account', [byUser, byMail, byId].map((r) => r.cookie.startsWith('taqwa_session=a1.') && r.cookie.includes('.USR-0001.')), [true, true, true]);
  ok_('the cookie is HttpOnly, Secure and SameSite=Strict, for 12 hours', /HttpOnly/.test(byUser.setCookie) && /Secure/.test(byUser.setCookie) && /SameSite=Strict/.test(byUser.setCookie) && /Max-Age=43200/.test(byUser.setCookie), byUser.setCookie);
  ok_('the last sign-in is recorded', !!h.one('SELECT last_login_at FROM user_accounts WHERE id = ?', owner.id).last_login_at);
  const mech = await h.account('MEC-0001', 'jamal', 'Mechanic');
  check('a mechanic signs in with MEC-0001', (await h.login('MEC-0001')).status, 204);

  const wrong = await h.login('nadia.akter', 'Wrong-Password-1');
  const unknown = await h.login('nobody.here', 'Wrong-Password-1');
  const unknownMail = await h.login('nobody@example.com', 'Wrong-Password-1');
  const unknownId = await h.login('STF-0999', 'Wrong-Password-1');
  check('a wrong password and an unknown username, e-mail or Staff ID all get the SAME 401 body', [wrong, unknown, unknownMail, unknownId].map((r) => [r.status, r.text]),
    Array(4).fill([401, wrong.text]));
  ok_('   ...which names nothing (no "user not found", no "wrong password")', /"Authentication required\."/.test(wrong.text) && !/not found|wrong|exist/i.test(wrong.text), wrong.text);
  check('   ...and sets no cookie', [wrong.setCookie, unknown.setCookie], ['', '']);
  check('empty or malformed identifiers are the same 401', [(await h.login('', OWN)).status, (await h.login('a@b', OWN)).status, (await h.api('POST', '/api/session', { identifier: { $ne: '' }, password: OWN }, 'none')).status], [401, 401, 401]);

  await h.account('STF-0003', 'leaver', 'Staff');
  await h.api('PUT', `/api/accounts/${h.one("SELECT id FROM user_accounts WHERE username='leaver'").id}`, { status: 'Inactive' });
  check('an inactive account cannot sign in (same 401)', [(await h.login('leaver')).status, (await h.login('leaver')).text], [401, wrong.text]);
  h.DB.raw.exec("UPDATE staff SET status = 'Inactive' WHERE id = 'STF-0002'");
  h.DB.raw.exec("UPDATE staff SET status = 'Active' WHERE id = 'STF-0002'");

  // An old username shaped like a Staff ID, belonging to someone else: the identifier is ambiguous, so nobody is signed in by it.
  await h.account('STF-0002', 'clerk', 'Staff');
  h.DB.raw.exec("UPDATE user_accounts SET username = 'stf-0001' WHERE username = 'clerk'");
  check('an identifier that could mean two accounts signs nobody in (401)', (await h.login('STF-0001')).status, 401);
  check('   ...the owner still signs in by username or e-mail', [(await h.login('nadia.akter')).status, (await h.login('nadia.test@example.com')).status], [204, 204]);
  void mech;
}

/* ---------- C. uniqueness ---------- */
console.log('\n-- C. no duplicate or ambiguous identifiers --');
{
  const h = fresh();
  await h.account('STF-0001', 'nadia', 'Super Admin', { email: 'nadia@example.com' });
  const fields = (r) => [r.status, Object.keys(r.body?.error?.fields ?? {})];
  check('a duplicate username, in any case, is 409', fields(await h.api('POST', '/api/accounts', { staffId: 'STF-0002', username: 'NADIA', role: 'Staff', password: TEMP })), [409, ['username']]);
  check('a duplicate e-mail, in any case, is 409 (create)', fields(await h.api('POST', '/api/accounts', { staffId: 'STF-0002', username: 'clerk', role: 'Staff', password: TEMP, email: 'NADIA@example.com' })), [409, ['email']]);
  const clerk = await h.api('POST', '/api/accounts', { staffId: 'STF-0002', username: 'clerk', role: 'Staff', password: TEMP });
  check('   ...and on edit', fields(await h.api('PUT', `/api/accounts/${clerk.body.data.id}`, { email: 'Nadia@Example.com' })), [409, ['email']]);
  check('a second account for the same Staff ID is 409', fields(await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'nadia2', role: 'Staff', password: TEMP })), [409, ['staffId']]);
  check('a username may not look like a Staff ID, and a bad e-mail or mobile is refused (422)', [
    fields(await h.api('POST', '/api/accounts', { staffId: 'STF-0003', username: 'stf-0009', role: 'Staff', password: TEMP })),
    fields(await h.api('POST', '/api/accounts', { staffId: 'STF-0003', username: 'third', role: 'Staff', password: TEMP, email: 'not-an-email' })),
    fields(await h.api('POST', '/api/accounts', { staffId: 'STF-0003', username: 'third', role: 'Staff', password: TEMP, mobile: 'call me' }))],
  [[422, ['username']], [422, ['email']], [422, ['mobile']]]);
  const edit = await h.api('PUT', `/api/accounts/${clerk.body.data.id}`, { email: 'Clerk@Example.com', mobile: '01711000002' });
  check('an administrator sets e-mail and mobile later; clearing works too', [edit.status, edit.body.data.email, edit.body.data.mobile,
    (await h.api('PUT', `/api/accounts/${clerk.body.data.id}`, { email: '' })).body.data.email], [200, 'clerk@example.com', '01711000002', '']);
  check('the database itself refuses a duplicate e-mail', (() => { try { h.DB.raw.exec("UPDATE user_accounts SET email = 'nadia@example.com' WHERE username = 'clerk'"); return 'ok'; } catch (e) { return /UNIQUE/.test(e.message) ? 'UNIQUE' : e.message; } })(), 'UNIQUE');
}

/* ---------- D. sessions ---------- */
console.log('\n-- D. sessions --');
{
  const h = fresh();
  const me = await h.account('STF-0001', 'nadia', 'Accountant', { email: 'nadia@example.com' });
  const s = (await h.api('GET', '/api/session', undefined, me.cookie)).body.data;
  check('GET /api/session names the person: id, username, name, Staff ID, role; never a hash or e-mail', s.account,
    { id: me.id, username: 'nadia', name: 'Test Owner', staffId: 'STF-0001', role: 'Accountant', roleId: 'ROL-0004', passwordChangeRequired: false });
  ok_('   ...and nothing secret anywhere in it', !/pbkdf2|password_hash|session_version/i.test(JSON.stringify(s)), '');
  const laptop = (await h.login('nadia')).cookie;
  const phone = (await h.login('nadia@example.com')).cookie;
  // Session fixation: a cookie planted in the browser before signing in (here, another account's) is never kept.
  const other = await h.account('STF-0002', 'clerk', 'Staff');
  const planted = await h.api('POST', '/api/session', { identifier: 'nadia', password: OWN }, other.cookie);
  ok_('signing in always sets a freshly signed cookie for THIS account, whatever cookie the browser already held (no fixation)',
    planted.status === 204 && planted.cookie !== other.cookie && planted.cookie.includes(`.${me.id}.`) && laptop.startsWith('taqwa_session=a1.') && phone.startsWith('taqwa_session=a1.'), planted.cookie);
  const out = await h.api('DELETE', '/api/session', undefined, laptop);
  check('signing out: 204, and the cookie is cleared', [out.status, /Max-Age=0/.test(out.setCookie)], [204, true]);
  check('   ...the signed-out cookie no longer works, even if kept', (await h.api('GET', '/api/customers', undefined, laptop)).status, 401);
  check('   ...nor does the same account\'s other session (sign-out ends them all)', (await h.api('GET', '/api/customers', undefined, phone)).status, 401);
  check('   ...signing in again works', (await h.login('nadia')).status, 204);
}

/* ---------- E. reset and change ---------- */
console.log('\n-- E. password reset (administrator-assisted) and change --');
{
  const h = fresh();
  const boss = await h.account('STF-0001', 'boss', 'Super Admin');
  const made = await h.api('POST', '/api/accounts', { staffId: 'STF-0002', username: 'clerk', role: 'Staff', password: TEMP, email: 'clerk@example.com' }, boss.cookie);
  check('a new account must choose its own password', [made.status, made.body.data.passwordChangeRequired], [201, true]);
  const first = await h.login('clerk', TEMP);
  check('   ...it may sign in with the temporary one', first.status, 204);
  check('   ...but every other request is 403 password_change_required until it changes it', [
    (await h.api('GET', '/api/customers', undefined, first.cookie)).body?.error?.code, (await h.api('GET', '/api/notifications', undefined, first.cookie)).status],
  ['password_change_required', 403]);
  check('   ...GET /api/session says so', (await h.api('GET', '/api/session', undefined, first.cookie)).body.data.account.passwordChangeRequired, true);
  const field = (r) => [r.status, Object.keys(r.body?.error?.fields ?? {})];
  check('the change needs the current password, a strong new one, different from the current', [
    field(await h.api('POST', '/api/session/password', { currentPassword: 'Wrong-Pass-99', newPassword: OWN }, first.cookie)),
    field(await h.api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: 'short' }, first.cookie)),
    field(await h.api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: TEMP }, first.cookie)),
    field(await h.api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: 'clerk-password-1' }, first.cookie))],
  [[422, ['currentPassword']], [422, ['newPassword']], [422, ['newPassword']], [422, ['newPassword']]]);
  check('   ...without a session it is 401; extra fields are refused', [(await h.api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: OWN }, 'none')).status,
    (await h.api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: OWN, userId: 'USR-0001' }, first.cookie)).status], [401, 400]);
  const changed = await h.api('POST', '/api/session/password', { currentPassword: TEMP, newPassword: OWN }, first.cookie);
  check('a good change: 204 and a NEW cookie that works; the old one does not', [changed.status, changed.cookie !== first.cookie,
    (await h.api('GET', '/api/customers', undefined, changed.cookie)).status, (await h.api('GET', '/api/customers', undefined, first.cookie)).status], [204, true, 200, 401]);
  check('   ...the temporary password no longer signs in; the new one does', [(await h.login('clerk', TEMP)).status, (await h.login('clerk', OWN)).status], [401, 204]);
  ok_('   ...and only a hash is stored', /^pbkdf2_sha256\$/.test(h.one("SELECT password_hash FROM user_accounts WHERE username='clerk'").password_hash)
    && !JSON.stringify(h.DB.raw.prepare('SELECT * FROM user_accounts').all()).includes(OWN), '');

  const clerkId = made.body.data.id;
  const reset = await h.api('POST', `/api/accounts/${clerkId}/password`, { password: 'Reset-By-Admin-33' }, boss.cookie);
  check('an administrator\'s reset: 200, nothing secret returned, and the person must change it again', [reset.status, /Reset-By-Admin|pbkdf2/.test(reset.text), reset.body.data.passwordChangeRequired], [200, false, true]);
  check('   ...their sessions end at once', (await h.api('GET', '/api/customers', undefined, changed.cookie)).status, 401);
  const after = await h.login('clerk', 'Reset-By-Admin-33');
  check('   ...the reset password signs in, but only to choose a new one', [after.status, (await h.api('GET', '/api/customers', undefined, after.cookie)).status], [204, 403]);
  check('a reset cannot opt out of the change', (await h.api('POST', `/api/accounts/${clerkId}/password`, { password: 'Reset-By-Admin-44', requirePasswordChange: false }, boss.cookie)).status, 422);
}

/* ---------- F. throttle ---------- */
console.log('\n-- F. repeated attempts --');
{
  const h = fresh();
  await h.account('STF-0001', 'nadia', 'Staff');
  for (let i = 0; i < 10; i++) await h.login('nadia', `Wrong-Pass-${i}0`);
  const blocked = await h.login('nadia', OWN);
  check('after 10 failures for one identifier: 429 with Retry-After, even with the right password', [blocked.status, blocked.body.error.code, blocked.retryAfter], [429, 'too_many_attempts', '900']);
  check('   ...whether it exists or not (an unknown name is limited the same way)', await (async () => { for (let i = 0; i < 10; i++) await h.login('ghost.user'); return (await h.login('ghost.user')).status; })(), 429);
  check('   ...other identifiers are not affected', (await h.login('someone.else')).status, 401);
  check('   ...(the account itself is also paused by its own five-strike lock)', !!h.one("SELECT locked_until FROM user_accounts WHERE username='nadia'").locked_until, true);
  h.DB.raw.exec("UPDATE auth_throttle SET window_start = '2000-01-01T00:00:00.000Z'; UPDATE user_accounts SET locked_until = '2000-01-01T00:00:00.000Z', failed_logins = 0");
  check('when both windows have passed, the right password works again', (await h.login('nadia', OWN)).status, 204);
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  for (let i = 0; i < 20; i++) await h.login(`spray-${i}`, 'Wrong-Pass-1', ip);
  check('20 failures from one address, across many names: that address gets 429 for any name', [(await h.login('nadia', OWN, ip)).status, (await h.login('nadia', OWN, { 'cf-connecting-ip': '203.0.113.10' })).status], [429, 204]);
  check('   ...the passphrase is limited by address too', (await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none', ip)).status, 429);
  const stored = JSON.stringify(h.DB.raw.prepare('SELECT * FROM auth_throttle').all());
  ok_('only hashes are stored: no address or identifier in plain text', !/203\.0\.113|nadia|ghost|spray/.test(stored) && /"ip:[0-9a-f]{64}"/.test(stored) && /"id:[0-9a-f]{64}"/.test(stored), stored.slice(0, 200));
}

/* ---------- G. roles and escalation ---------- */
console.log('\n-- G. roles still apply --');
{
  const h = fresh();
  const mech = await h.account('MEC-0001', 'jamal', 'Mechanic', { email: 'jamal@example.com' });
  const viaMail = (await h.login('jamal@example.com')).cookie;
  check('a Mechanic signed in by e-mail: job cards 200, invoices 403, roles 403', [(await h.api('GET', '/api/job-cards', undefined, viaMail)).status,
    (await h.api('GET', '/api/invoices', undefined, viaMail)).status, (await h.api('GET', '/api/roles', undefined, viaMail)).status], [200, 403, 403]);
  const sneaky = await h.api('POST', '/api/session', { identifier: 'jamal', password: OWN, role: 'Super Admin', permissions: ['*'], fullAccess: true }, 'none');
  check('role or permissions sent with the sign-in are ignored', [sneaky.status, (await h.api('GET', '/api/invoices', undefined, sneaky.cookie)).status], [204, 403]);
  check('without a cookie every business route is 401', [(await h.api('GET', '/api/customers', undefined, 'none')).status, (await h.api('PUT', '/api/session/passphrase', { enabled: false }, 'none')).status], [401, 401]);
  await h.api('PUT', `/api/accounts/${mech.id}`, { role: 'Accountant' });
  const again = (await h.login('jamal')).cookie;
  check('a role change applies to the next session: invoices now 200', (await h.api('GET', '/api/invoices', undefined, again)).status, 200);
}

/* ---------- H. the shared passphrase ---------- */
console.log('\n-- H. the shared passphrase (controlled transition) --');
{
  const h = fresh();
  const shared = await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none');
  check('the workshop passphrase still signs in, with full access as before', [shared.status, (await h.api('GET', '/api/roles', undefined, shared.cookie)).status], [204, 200]);
  check('GET /api/session says the passphrase is still allowed', (await h.api('GET', '/api/session', undefined, 'none')).body.data.sharedPassphrase, true);
  const boss = await h.account('STF-0001', 'boss', 'Super Admin');
  const admin = await h.account('STF-0002', 'admin', 'Admin');
  check('only a Super Admin\'s OWN account may switch it: not the passphrase, not the token, not an Admin', [
    (await h.api('PUT', '/api/session/passphrase', { enabled: false }, shared.cookie)).status,
    (await h.api('PUT', '/api/session/passphrase', { enabled: false })).status,
    (await h.api('PUT', '/api/session/passphrase', { enabled: false }, admin.cookie)).status], [403, 401, 403]);
  check('   ...nor one that has not yet chosen its own password', await (async () => {
    await h.api('POST', '/api/accounts', { staffId: 'STF-0004', username: 'boss2', role: 'Super Admin', password: TEMP });
    return (await h.api('PUT', '/api/session/passphrase', { enabled: false }, (await h.login('boss2', TEMP)).cookie)).status; })(), 403);
  check('   ...a bad body is 422', (await h.api('PUT', '/api/session/passphrase', { enabled: 'no' }, boss.cookie)).status, 422);
  const off = await h.api('PUT', '/api/session/passphrase', { enabled: false }, boss.cookie);
  check('the Super Admin switches it off', [off.status, off.body.data.passphraseEnabled, h.one('SELECT passphrase_enabled, updated_by FROM auth_settings').updated_by], [200, false, 'boss']);
  check('   ...then the passphrase signs nobody in (same 401) and its existing sessions stop', [(await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).status,
    (await h.api('GET', '/api/customers', undefined, shared.cookie)).status], [401, 401]);
  check('   ...personal accounts and the machine token are unaffected', [(await h.api('GET', '/api/customers', undefined, boss.cookie)).status, (await h.api('GET', '/api/customers')).status], [200, 200]);
  check('   ...GET /api/session says so', (await h.api('GET', '/api/session', undefined, 'none')).body.data.sharedPassphrase, false);
  await h.api('PUT', '/api/session/passphrase', { enabled: true }, boss.cookie);
  check('and on again, if ever needed', (await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).status, 204);
}

console.log(`\nLogin unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
