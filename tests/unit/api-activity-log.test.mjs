/* Activity log (0012) — unit tests against the REAL Worker: /api/activity-log and
   the entries the Worker writes after a successful Staff Management change.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0012) through the same minimal D1-shaped wrapper the staff,
   accounts, attendance and leave suites use, with the real auth gate.

   What must hold:
     A. Schema: columns, CHECKs (the caller kinds, an account named by its id,
        the actions and modules, lengths), the indexes; re-runnable.
     B. Reading: no credential -> 401 before any statement; an administrator
        (passphrase, token, Administrator account) reads; any other role is 403.
        No create, edit or delete exists (405) and nothing is written by trying.
     C. Recording: each logged change -- staff add / edit, account create / edit /
        password, attendance record / correct, leave submit / approve / reject --
        writes exactly one entry naming the authenticated caller (never a name
        the request claims), the module, the action and the record.
     D. Never sensitive: no password, hash, cookie, phone or e-mail in any entry;
        an edit names the fields it sent, not their values.
     E. Only on success: refused requests (401, 403, 409, 422) write nothing; a
        failure to write the entry never changes the change's own answer.
     F. List: newest first, module / action / day range / search filters, paging,
        counts, bad parameters 400; detail 404 / 400.
     G. Compatibility: reads and other modules write nothing; the registry grows
        by exactly the two read routes.
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
  console.log(`\nActivity log unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql', '0009_user_accounts.sql', '0010_attendance.sql',
  '0011_leave_requests.sql', '0012_activity_log.sql', '0018_roles_permissions.sql', '0019_individual_login.sql'];
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';

// Days relative to today in the workshop's timezone, as the Worker computes it.
const DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (offset) => DHAKA.format(new Date(Date.now() + offset * 86400000));
const TODAY = day(0);

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
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', 'Engine', '${AT}');
    INSERT INTO mechanics (id, name, phone, specialization, created_at) VALUES ('MEC-0002', 'Kamal', '01800000002', 'AC', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0003', 'Left Already', '01800000003', 'Inactive', '${AT}');
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0004', 'Unused', '01800000004', '${AT}');
    UPDATE id_counters SET last_value = 4 WHERE collection = 'mechanics';
    INSERT INTO staff (id, mechanic_id, designation, department, created_at) VALUES ('MEC-0001', 'MEC-0001', 'Senior Mechanic', 'Workshop', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Accountant', 'Accounts', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0002', 'Gone Staff', '01911000002', 'Inactive', 'Helper', 'Workshop', '${AT}');
    UPDATE id_counters SET last_value = 2 WHERE collection = 'staff';
    INSERT INTO job_cards (id, customer_id, vehicle_id, mechanic_id, date, complaint, created_at) VALUES ('JOB-0001', 'CUS-0001', 'VEH-0001', 'MEC-0001', '2026-10-01', 'Noise', '${AT}');`);
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
  const passphraseCookie = async () => (await api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie;
  return { DB, env, api, one, passphraseCookie };
}

const D = (n) => day(n);
const PATH = '/api/activity-log';
const STAFF = (extra = {}) => ({ name: 'Rumana Begum', phone: '01911-555123', email: 'rumana@example.com', designation: 'Cashier',
  department: 'Accounts', employeeCode: 'TQ-201', joiningDate: '2024-03-01', ...extra });
const entries = (h) => h.DB.raw.prepare('SELECT id, actor_kind, actor_account_id, actor_name, action, module, record_id, summary FROM activity_log ORDER BY id').all();
const count = (h) => h.one('SELECT count(*) AS n FROM activity_log').n;

console.log('=== Activity log (0012) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  check('activity_log has the designed columns', h.DB.raw.prepare('PRAGMA table_info(activity_log)').all().map((c) => c.name),
    ['id', 'occurred_at', 'actor_kind', 'actor_account_id', 'actor_name', 'action', 'module', 'record_id', 'summary']);
  check('no foreign key (an entry outlives what it names)', h.DB.raw.prepare('PRAGMA foreign_key_list(activity_log)').all().length, 0);
  check('indexes: by time, and by module and time',
    h.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='activity_log' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    ['ix_activity_module_occurred', 'ix_activity_occurred']);
  const ins = (kind, acct, name, action, module, rec = 'STF-0001', summary = 's') => {
    try {
      h.DB.raw.prepare('INSERT INTO activity_log (occurred_at, actor_kind, actor_account_id, actor_name, action, module, record_id, summary) VALUES (?,?,?,?,?,?,?,?)')
        .run(AT, kind, acct, name, action, module, rec, summary);
      return 'ok';
    } catch (e) { return /CHECK/.test(e.message) ? 'check' : e.message; }
  };
  check('the schema refuses: an unknown caller kind, an account without its id, a passphrase with one, an unknown action or module, an empty name, record or summary, a summary over 300',
    [ins('admin', null, 'x', 'create', 'staff'), ins('account', null, 'nadia', 'create', 'staff'), ins('passphrase', 'USR-0001', 'x', 'create', 'staff'),
      ins('token', null, 'x', 'delete', 'staff'), ins('token', null, 'x', 'create', 'invoices'), ins('token', null, '', 'create', 'staff'),
      ins('token', null, 'x', 'create', 'staff', ''), ins('token', null, 'x', 'create', 'staff', 'STF-0001', ''), ins('token', null, 'x', 'create', 'staff', 'STF-0001', 'x'.repeat(301))],
    ['check', 'check', 'check', 'check', 'check', 'check', 'check', 'check', 'check']);
  check('...and allows a passphrase entry and an account entry',
    [ins('passphrase', null, 'Workshop passphrase', 'create', 'staff'), ins('account', 'USR-0001', 'nadia', 'approve', 'leave', 'LVR-0001')], ['ok', 'ok']);
  h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0012_activity_log.sql'), 'utf8'));
  ok_('the migration can be re-run without error or loss', count(h) === 2);
}

/* ---------- B. reading ---------- */
console.log('\n-- B. reading --');
{
  const h = fresh();
  const before = h.DB.statements.length;
  check('without a credential the list and the detail are 401', [(await h.api('GET', PATH, undefined, 'none')).status, (await h.api('GET', `${PATH}/1`, undefined, 'none')).status], [401, 401]);
  check('   ...before any statement reaches the database', h.DB.statements.length, before);
  const writes = [await h.api('POST', PATH, { action: 'create', module: 'staff', recordId: 'X', summary: 'forged' }),
    await h.api('PUT', `${PATH}/1`, { summary: 'x' }), await h.api('DELETE', `${PATH}/1`), await h.api('POST', `${PATH}/1/void`, {})];
  check('there is no create, edit, delete or action: 405 even for the machine token', writes.map((r) => r.status), [405, 405, 405, 405]);
  check('   ...and nothing was written by trying', count(h), 0);
  const owner = await h.passphraseCookie();
  check('the passphrase session and the machine token may read', [(await h.api('GET', PATH, undefined, owner)).status, (await h.api('GET', PATH)).status], [200, 200]);
  await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'nadia', role: 'Super Admin', password: PW }, owner);
  const admin = (await h.api('POST', '/api/session', { username: 'nadia', password: PW }, 'none')).cookie;
  check('an Administrator account may read', (await h.api('GET', PATH, undefined, admin)).status, 200);
  h.DB.raw.exec("UPDATE user_accounts SET role_id = 'ROL-0008' WHERE username = 'nadia'");
  const viewer = await h.api('GET', PATH, undefined, admin);
  check('an account with any other role may not: 403', [viewer.status, viewer.body?.error?.code, (await h.api('GET', `${PATH}/1`, undefined, admin)).status], [403, 'forbidden', 403]);
}

/* ---------- C + D. recording, never sensitive ---------- */
console.log('\n-- C. recording --');
{
  const h = fresh();
  const owner = await h.passphraseCookie();
  const st = await h.api('POST', '/api/staff', STAFF(), owner);
  const sid = st.body?.data?.id;
  let e = entries(h);
  check('adding staff: one entry -- the passphrase caller, staff, create, the new record, a readable summary',
    [st.status, e.length, e[0]?.actor_kind, e[0]?.actor_account_id, e[0]?.actor_name, e[0]?.module, e[0]?.action, e[0]?.record_id, e[0]?.summary],
    [201, 1, 'passphrase', null, 'Workshop passphrase', 'staff', 'create', sid, `Added Rumana Begum (${sid}) as Cashier`]);
  const ed = await h.api('PUT', `/api/staff/${sid}`, { phone: '01911-555999', department: 'Front Desk' }, owner);
  e = entries(h);
  check('editing staff: one more entry naming the fields sent (not their values)',
    [ed.status, e.length, e[1]?.action, e[1]?.summary], [200, 2, 'update', `Updated Rumana Begum (${sid}): phone, department`]);
  const acct = await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'nadia', role: 'Super Admin', password: PW }, owner);
  const uid = acct.body?.data?.id;
  const pw = await h.api('POST', `/api/accounts/${uid}/password`, { password: 'Another-Password-9' }, owner);
  const au = await h.api('PUT', '/api/accounts/' + uid, { role: 'Super Admin' }, owner);
  e = entries(h);
  check('creating an account, setting its password and editing it: three entries',
    [acct.status, pw.status, au.status, e.slice(2).map((x) => [x.module, x.action, x.record_id])],
    [201, 200, 200, [['accounts', 'create', uid], ['accounts', 'password', uid], ['accounts', 'update', uid]]]);
  check('   ...with readable summaries', e.slice(2).map((x) => x.summary),
    [`Created account nadia for Nadia Akter (STF-0001), role Super Admin`, 'Set a new password for account nadia',
      'Updated account nadia for Nadia Akter (STF-0001): role (now Active, Super Admin)']);

  // Now as the account itself: the entry names the signed-in account, not the passphrase.
  const nadia = (await h.api('POST', '/api/session', { username: 'nadia', password: 'Another-Password-9' }, 'none')).cookie;
  const at = await h.api('POST', '/api/attendance', { staffId: 'MEC-0001', date: D(-1), status: 'Present', checkIn: '09:00', checkOut: '18:00' }, nadia);
  const at2 = await h.api('PUT', `/api/attendance/${at.body?.data?.id}`, { status: 'Late', checkIn: '10:00', expectedUpdatedAt: at.body?.data?.updatedAt }, nadia);
  e = entries(h);
  check('recording and correcting attendance as an account: entries name that account (username and id)',
    [at.status, at2.status, e.slice(5).map((x) => [x.actor_kind, x.actor_account_id, x.actor_name, x.module, x.action])],
    [201, 200, [['account', uid, 'nadia', 'attendance', 'create'], ['account', uid, 'nadia', 'attendance', 'update']]]);
  check('   ...with readable summaries', e.slice(5).map((x) => x.summary),
    [`Recorded Present for Jamal Uddin (MEC-0001) on ${D(-1)}`, `Corrected the attendance of Jamal Uddin (MEC-0001) on ${D(-1)}: status, checkIn (now Late)`]);
  const forged = await h.api('POST', '/api/attendance', { staffId: 'MEC-0002', date: D(-1), status: 'Absent', actorName: 'Someone Else' }, nadia);
  check('a request cannot name its own caller: the unknown property is refused and nothing is logged', [forged.status, count(h)], [422, 7]);

  const lv = await h.api('POST', '/api/leave-requests', { staffId: 'MEC-0001', leaveType: 'Casual', startDate: D(3), endDate: D(4), reason: 'Family wedding' }, owner);
  const lv2 = await h.api('POST', '/api/leave-requests', { staffId: 'STF-0001', leaveType: 'Sick', startDate: D(3), endDate: D(3), reason: 'Fever' }, owner);
  const ap = await h.api('POST', `/api/leave-requests/${lv.body?.data?.id}/approve`, { expectedUpdatedAt: lv.body?.data?.updatedAt, note: 'Enjoy' }, nadia);
  const rj = await h.api('POST', `/api/leave-requests/${lv2.body?.data?.id}/reject`, { expectedUpdatedAt: lv2.body?.data?.updatedAt, note: 'Short staffed' }, owner);
  e = entries(h);
  check('submitting, approving and rejecting leave: one entry each',
    [lv.status, lv2.status, ap.status, rj.status, e.slice(7).map((x) => [x.actor_name, x.module, x.action])],
    [201, 201, 200, 200, [['Workshop passphrase', 'leave', 'create'], ['Workshop passphrase', 'leave', 'create'], ['nadia', 'leave', 'approve'], ['Workshop passphrase', 'leave', 'reject']]]);
  check('   ...the approval summary', e[9]?.summary, `Approved Casual leave ${lv.body?.data?.id} for Jamal Uddin (MEC-0001), ${D(3)} to ${D(4)}`);
  check('the machine token is named as such', (await h.api('PUT', `/api/staff/${sid}`, { designation: 'Senior Cashier' })).status === 200 && entries(h).at(-1).actor_name, 'API token');

  console.log('\n-- D. never sensitive --');
  const all = JSON.stringify(entries(h));
  check('no password, hash, cookie, session token, phone number or e-mail address in any entry',
    [PW, 'Another-Password-9', 'pbkdf2', 'taqwa_session', '01911-555', 'rumana@example.com', 'Enjoy', 'Short staffed'].filter((t) => all.includes(t)), []);
  const api = await h.api('GET', PATH, undefined, owner);
  check('the API returns only the entry fields',
    Object.keys(api.body?.data?.[0] ?? {}), ['id', 'occurredAt', 'actorKind', 'actorAccountId', 'actorName', 'action', 'module', 'recordId', 'summary']);
}

/* ---------- E. only on success ---------- */
console.log('\n-- E. only on success --');
{
  const h = fresh();
  const owner = await h.passphraseCookie();
  const refused = [
    await h.api('POST', '/api/staff', STAFF(), 'none'),                                           // 401
    await h.api('POST', '/api/staff', STAFF({ name: '' }), owner),                               // 422
    await h.api('PUT', '/api/staff/STF-0099', { department: 'X' }, owner),                       // 404
    await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'n', role: 'Super Admin', password: 'short' }, owner),   // 422
  ];
  await h.api('POST', '/api/attendance', { staffId: 'MEC-0001', date: D(-1), status: 'Present' }, owner);
  refused.push(await h.api('POST', '/api/attendance', { staffId: 'MEC-0001', date: D(-1), status: 'Absent' }, owner));   // 409 duplicate day
  const lv = await h.api('POST', '/api/leave-requests', { staffId: 'MEC-0001', leaveType: 'Casual', startDate: D(3), endDate: D(4), reason: 'x' }, owner);
  refused.push(await h.api('POST', '/api/leave-requests', { staffId: 'MEC-0001', leaveType: 'Annual', startDate: D(4), endDate: D(5), reason: 'y' }, owner));   // 409 overlap
  refused.push(await h.api('POST', `/api/leave-requests/${lv.body.data.id}/reject`, { expectedUpdatedAt: lv.body.data.updatedAt }, owner));   // 422 no reason
  refused.push(await h.api('POST', `/api/leave-requests/${lv.body.data.id}/approve`, { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }, owner));   // 409 stale
  check('refused requests answer as before', refused.map((r) => r.status), [401, 422, 404, 422, 409, 409, 422, 409]);
  check('   ...and wrote no entry: only the two successful changes are logged', entries(h).map((x) => [x.module, x.action]), [['attendance', 'create'], ['leave', 'create']]);

  // A failure to write the entry never changes the outcome of the change itself.
  h.DB.raw.exec('DROP TABLE activity_log');
  const errors = []; const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  const st = await h.api('POST', '/api/staff', STAFF(), owner);
  console.error = orig;
  check('with the log unwritable, adding staff still answers 201 and the staff record is saved',
    [st.status, h.one('SELECT count(*) AS n FROM staff WHERE name = ?', 'Rumana Begum').n], [201, 1]);
  ok_('   ...and the missing entry is reported in the Worker log', errors.some((x) => /activity log: entry not recorded for staff create/.test(x)), errors.join(' | '));
}

/* ---------- F. list ---------- */
console.log('\n-- F. list and detail --');
{
  const h = fresh();
  const insert = (at, module, action, rec, summary, name = 'Workshop passphrase') => h.DB.raw.prepare(
    "INSERT INTO activity_log (occurred_at, actor_kind, actor_name, action, module, record_id, summary) VALUES (?, 'passphrase', ?, ?, ?, ?, ?)").run(at, name, action, module, rec, summary);
  const dhakaStart = (d) => new Date(Date.parse(`${d}T00:00:00+06:00`)).toISOString();
  const T0 = dhakaStart(D(0)), Y0 = dhakaStart(D(-1));
  insert(new Date(Date.parse(Y0) + 3600e3).toISOString(), 'staff', 'create', 'STF-0005', 'Added Rumana Begum (STF-0005)');
  insert(new Date(Date.parse(Y0) + 7200e3).toISOString(), 'attendance', 'create', 'ATT-0001', 'Recorded Present for Jamal Uddin (MEC-0001)');
  insert(new Date(Date.parse(T0) + 60e3).toISOString(), 'leave', 'approve', 'LVR-0001', 'Approved Casual leave 100% sure_ok');
  insert(new Date(Date.parse(T0) - 60e3).toISOString(), 'accounts', 'password', 'USR-0001', 'Set a new password for account nadia');
  const ids = (r) => (r.body?.data ?? []).map((x) => x.recordId);
  const all = await h.api('GET', PATH);
  check('newest first; total, today and the module counts; the modules and actions',
    [ids(all), all.body?.total, all.body?.counts, all.body?.today, all.body?.modules, all.body?.actions],
    [['LVR-0001', 'USR-0001', 'ATT-0001', 'STF-0005'], 4, { today: 1, staffAccounts: 2, attendanceLeave: 2 }, TODAY,
      ['staff', 'accounts', 'attendance', 'leave'], ['create', 'update', 'password', 'approve', 'reject']]);
  check('a workshop day is Asia/Dhaka: the entry one minute before local midnight belongs to the day before',
    [ids(await h.api('GET', `${PATH}?from=${D(0)}&to=${D(0)}`)), ids(await h.api('GET', `${PATH}?to=${D(-1)}`))], [['LVR-0001'], ['USR-0001', 'ATT-0001', 'STF-0005']]);
  check('module, action and search filters (search is literal: % and _ match themselves)',
    [ids(await h.api('GET', `${PATH}?module=staff`)), ids(await h.api('GET', `${PATH}?action=password`)), ids(await h.api('GET', `${PATH}?q=jamal`)),
      ids(await h.api('GET', `${PATH}?q=${encodeURIComponent('100%')}`)), ids(await h.api('GET', `${PATH}?q=${encodeURIComponent('Set_a')}`)), ids(await h.api('GET', `${PATH}?q=USR-0001`))],
    [['STF-0005'], ['USR-0001'], ['ATT-0001'], ['LVR-0001'], [], ['USR-0001']]);
  check('paging is server-side', [ids(await h.api('GET', `${PATH}?limit=2`)), ids(await h.api('GET', `${PATH}?limit=2&offset=2`)), (await h.api('GET', `${PATH}?limit=2`)).body?.total],
    [['LVR-0001', 'USR-0001'], ['ATT-0001', 'STF-0005'], 4]);
  const code = async (q) => (await h.api('GET', `${PATH}?${q}`)).status;
  check('bad parameters are 400: a bad date, a reversed range, an unknown module or action, a search over 100, a limit over 200',
    [await code('from=2026-02-30'), await code(`from=${D(0)}&to=${D(-1)}`), await code('module=invoices'), await code('action=delete'),
      await code(`q=${'x'.repeat(101)}`), await code('limit=201')], [400, 400, 400, 400, 400, 400]);
  const one = await h.api('GET', `${PATH}/1`);
  check('the detail of one entry', [one.status, one.body?.data?.recordId, one.body?.data?.module], [200, 'STF-0005', 'staff']);
  check('an unknown entry is 404, a malformed id 400', [(await h.api('GET', `${PATH}/999`)).status, (await h.api('GET', `${PATH}/abc`)).status, (await h.api('GET', `${PATH}/0`)).status], [404, 400, 400]);
}

/* ---------- G. compatibility ---------- */
console.log('\n-- G. compatibility --');
{
  const h = fresh();
  for (const p of ['/api/staff', '/api/accounts', '/api/attendance', '/api/leave-requests', '/api/staff/MEC-0001']) await h.api('GET', p);
  check('reads write nothing', count(h), 0);
  h.DB.raw.exec("UPDATE id_counters SET last_value = 1 WHERE collection = 'customers'");   // the seed holds CUS-0001
  const cus = await h.api('POST', '/api/customers', { name: 'Walk-in', phone: '01555123456' });
  const mec = await h.api('PUT', '/api/mechanics/MEC-0002', { name: 'Kamal Hossain', phone: '01800000002' });
  check('changes outside the logged Staff Management writes are not logged (customers, mechanics)', [cus.status, mec.status, count(h)], [201, 200, 0]);
  const routes = (await h.api('GET', '/api/health')).body?.data?.routes ?? [];
  check('the registry is 165 routes: the 111 before, the two read routes, the five tools routes of 0013 and the eight Messenger routes of 0014 the nine WhatsApp routes of 0015 the five Notifications routes of 0017 the five Roles routes of 0018 and the two session routes of 0019',
    [routes.length, routes.filter((r) => r.includes('/api/activity-log'))], [165, ['GET /api/activity-log', 'GET /api/activity-log/:id']]);
}

console.log(`\nActivity log unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
