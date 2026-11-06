/* Leave requests (0011) — unit tests against the REAL Worker: /api/leave-requests.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0011) through the same minimal D1-shaped wrapper the staff,
   accounts and attendance suites use, with the real auth gate (token,
   passphrase, account sessions).

   What must hold:
     A. Schema: columns, CHECKs (exactly one person, the four types, the three
        statuses, end on or after start, reason 1-500, a decision complete or
        absent), the foreign keys and their cascade, the LVR counter; re-runnable.
     B. Authorization: no credential -> 401 on every route before any
        statement; anyone signed in may read and submit; approve / reject only
        for an administrator (token, passphrase, an Administrator account) --
        an account with any other role is 403 and nothing changes.
     C. Create: for an existing ACTIVE staff member, server id, Pending,
        type / dates / reason rules, unknown properties refused, an overlapping
        Pending or Approved request refused (409, naming it) -- also for two
        submissions at once; a Rejected one does not block.
     D. List and detail: newest first, status / type / staff filters, bad
        parameters 400, the person's name and department joined in, days counted.
     E. Decisions: Pending -> Approved | Rejected once, who and when kept, a
        rejection needs a reason; a decided request cannot be decided again; a
        stale expectedUpdatedAt is refused (409); no PUT, no DELETE.
     F. Compatibility: attendance, staff, mechanics and accounts untouched by
        any of it; the registry grows by exactly the five leave routes.
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
  console.log(`\nLeave requests unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql', '0009_user_accounts.sql', '0010_attendance.sql',
  '0011_leave_requests.sql', '0018_roles_permissions.sql', '0019_individual_login.sql'];
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

const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();
const D = (n) => day(n);
const NEW = (extra = {}) => ({ staffId: 'MEC-0001', leaveType: 'Casual', startDate: D(3), endDate: D(4), reason: 'Family wedding', ...extra });
const PATH = '/api/leave-requests';

console.log('=== Leave requests (0011) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  check('leave_requests has the designed columns', h.DB.raw.prepare('PRAGMA table_info(leave_requests)').all().map((c) => c.name),
    ['id', 'mechanic_id', 'staff_id', 'leave_type', 'start_date', 'end_date', 'reason', 'status', 'decided_at', 'decided_by',
      'decision_note', 'created_at', 'updated_at']);
  check('two foreign keys: mechanics and staff, both ON DELETE CASCADE',
    h.DB.raw.prepare('PRAGMA foreign_key_list(leave_requests)').all().map((f) => `${f.from}->${f.table}.${f.to} ${f.on_delete}`).sort(),
    ['mechanic_id->mechanics.id CASCADE', 'staff_id->staff.id CASCADE']);
  check('indexes: per mechanic, per staff member, by start date',
    h.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='leave_requests' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    ['ix_leave_requests_mechanic', 'ix_leave_requests_staff', 'ix_leave_requests_start']);
  check('the LVR counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='leaveRequests'"), { prefix: 'LVR', last_value: 0 });
  const ins = (id, m, s, type, a, b, st = 'Pending', reason = 'r', at = null, by = null, note = null) => {
    try {
      h.DB.raw.prepare(`INSERT INTO leave_requests (id, mechanic_id, staff_id, leave_type, start_date, end_date, reason, status,
        decided_at, decided_by, decision_note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, m, s, type, a, b, reason, st, at, by, note, AT, AT);
      return 'ok';
    } catch (e) { return /FOREIGN/.test(e.message) ? 'fk' : /CHECK/.test(e.message) ? 'check' : e.message; }
  };
  check('the schema refuses: no person, both people, a missing staff member, an unknown type, an unknown status, an end before the start, an empty reason, a decision without its time or decider, a Pending with a decision',
    [ins('LVR-9001', null, null, 'Casual', '2026-10-01', '2026-10-01'), ins('LVR-9002', 'MEC-0001', 'STF-0001', 'Casual', '2026-10-01', '2026-10-01'),
      ins('LVR-9003', null, 'STF-0999', 'Casual', '2026-10-01', '2026-10-01'), ins('LVR-9004', 'MEC-0001', null, 'Maternity', '2026-10-01', '2026-10-01'),
      ins('LVR-9005', 'MEC-0001', null, 'Casual', '2026-10-01', '2026-10-01', 'Cancelled'), ins('LVR-9006', 'MEC-0001', null, 'Casual', '2026-10-02', '2026-10-01'),
      ins('LVR-9007', 'MEC-0001', null, 'Casual', '2026-10-01', '2026-10-01', 'Pending', ''),
      ins('LVR-9008', 'MEC-0001', null, 'Casual', '2026-10-01', '2026-10-01', 'Approved'),
      ins('LVR-9009', 'MEC-0001', null, 'Casual', '2026-10-01', '2026-10-01', 'Approved', 'r', AT),
      ins('LVR-9010', 'MEC-0001', null, 'Casual', '2026-10-01', '2026-10-01', 'Pending', 'r', AT, 'x'),
      ins('LVR-9011', 'MEC-0001', null, 'Casual', '2026-10-01', '2026-10-01', 'Pending', 'r', null, null, 'note')],
    ['check', 'check', 'fk', 'check', 'check', 'check', 'check', 'check', 'check', 'check', 'check']);
  check('...and allows a Pending request and a complete decision',
    [ins('LVR-9012', 'MEC-0001', null, 'Sick', '2026-10-01', '2026-10-03'), ins('LVR-9013', null, 'STF-0001', 'Unpaid', '2026-10-01', '2026-10-01', 'Rejected', 'r', AT, 'admin', 'busy week')],
    ['ok', 'ok']);
  h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0011_leave_requests.sql'), 'utf8'));
  ok_('the migration can be re-run without error or loss', h.one('SELECT count(*) AS n FROM leave_requests').n === 2);
}

/* ---------- B. authorization ---------- */
console.log('\n-- B. authorization --');
{
  const h = fresh();
  const before = h.DB.statements.length;
  const routes = [['GET', PATH], ['POST', PATH, NEW()], ['GET', `${PATH}/LVR-0001`],
    ['POST', `${PATH}/LVR-0001/approve`, { expectedUpdatedAt: AT }], ['POST', `${PATH}/LVR-0001/reject`, { expectedUpdatedAt: AT, note: 'x' }]];
  const anon = [];
  for (const [m, p, b] of routes) anon.push((await h.api(m, p, b, 'none')).status);
  check('without a credential every leave route is 401', anon, [401, 401, 401, 401, 401]);
  check('   ...before any statement reaches the database', h.DB.statements.length, before);
  check('a forged session cookie is 401', (await h.api('GET', PATH, undefined, 'taqwa_session=v1.9999999999.forged')).status, 401);
  const owner = await h.passphraseCookie();
  const made = await h.api('POST', PATH, NEW(), owner);
  check('the passphrase session may read and submit', [(await h.api('GET', PATH, undefined, owner)).status, made.status], [200, 201]);
  check('so may the machine token', (await h.api('GET', `${PATH}/LVR-0001`)).status, 200);
  await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'nadia', role: 'Super Admin', password: PW }, owner);
  const admin = (await h.api('POST', '/api/session', { username: 'nadia', password: PW }, 'none')).cookie;
  const second = await h.api('POST', PATH, NEW({ staffId: 'STF-0001' }), admin);
  check('a Super Admin account may submit too', second.status, 201);
  // 0018: a role that may read and submit leave, but not decide it.
  h.DB.raw.exec(`INSERT INTO roles (id, name, created_at, updated_at) VALUES ('ROL-0101', 'Leave Clerk', '${AT}', '${AT}');
    INSERT INTO role_permissions (role_id, permission) VALUES ('ROL-0101', 'leave.view'), ('ROL-0101', 'leave.create');
    UPDATE user_accounts SET role_id = 'ROL-0101' WHERE username = 'nadia';`);
  const viewerApprove = await h.api('POST', `${PATH}/LVR-0001/approve`, { expectedUpdatedAt: made.body.data.updatedAt }, admin);
  const viewerReject = await h.api('POST', `${PATH}/LVR-0001/reject`, { expectedUpdatedAt: made.body.data.updatedAt, note: 'no' }, admin);
  check('a role without Leave: approve may not approve or reject: 403, the request stays Pending',
    [viewerApprove.status, viewerApprove.body?.error?.code, viewerReject.status, h.one("SELECT status FROM leave_requests WHERE id = 'LVR-0001'").status],
    [403, 'forbidden', 403, 'Pending']);
  check('   ...but may still read', (await h.api('GET', PATH, undefined, admin)).status, 200);
  h.DB.raw.exec("UPDATE user_accounts SET role_id = 'ROL-0001' WHERE username = 'nadia'");
  const yes = await h.api('POST', `${PATH}/LVR-0001/approve`, { expectedUpdatedAt: made.body.data.updatedAt }, admin);
  check('a Super Admin account may approve, and is named as the decider', [yes.status, yes.body?.data?.status, yes.body?.data?.decidedBy], [200, 'Approved', 'nadia']);
  const byOwner = await h.api('POST', `${PATH}/${second.body.data.id}/reject`, { expectedUpdatedAt: second.body.data.updatedAt, note: 'Short staffed' }, owner);
  check('the passphrase session may reject', [byOwner.status, byOwner.body?.data?.status, byOwner.body?.data?.decidedBy], [200, 'Rejected', 'Workshop passphrase']);
}

/* ---------- C. create ---------- */
console.log('\n-- C. create --');
{
  const h = fresh();
  const r = await h.api('POST', PATH, NEW({ reason: '  Family wedding  ' }));
  const d = r.body?.data ?? {};
  check('a mechanic\'s request: 201, a server id, Pending, the person joined in, the reason trimmed, days counted',
    [r.status, d.id, d.staffId, d.isMechanic, d.staffName, d.department, d.designation, d.leaveType, d.startDate, d.endDate, d.days, d.reason, d.status, d.decidedAt, d.decidedBy],
    [201, 'LVR-0001', 'MEC-0001', true, 'Jamal Uddin', 'Workshop', 'Senior Mechanic', 'Casual', D(3), D(4), 2, 'Family wedding', 'Pending', '', '']);
  ok_('   ...createdAt (the submission time) and updatedAt set', d.createdAt && d.createdAt === d.updatedAt, JSON.stringify(d));
  const s = await h.api('POST', PATH, NEW({ staffId: 'STF-0001', leaveType: 'Sick', startDate: D(-2), endDate: D(-2), reason: 'Fever' }));
  check('another employee\'s one-day sick leave in the past', [s.status, s.body?.data?.staffId, s.body?.data?.isMechanic, s.body?.data?.days, s.body?.data?.department],
    [201, 'STF-0001', false, 1, 'Accounts']);

  const over = await h.api('POST', PATH, NEW({ startDate: D(4), endDate: D(6), leaveType: 'Annual' }));
  check('an overlapping request of the same person: 409, naming the existing one; nothing written',
    [over.status, over.body?.error?.reason, over.body?.error?.conflictsWith, h.one("SELECT count(*) AS n FROM leave_requests WHERE mechanic_id = 'MEC-0001'").n],
    [409, 'overlapping_request', 'LVR-0001', 1]);
  check('the same days for another person are fine', (await h.api('POST', PATH, NEW({ staffId: 'MEC-0002' }))).status, 201);
  check('the next days for the same person are fine', (await h.api('POST', PATH, NEW({ startDate: D(5), endDate: D(5) }))).status, 201);
  const race = await Promise.all([h.api('POST', PATH, NEW({ startDate: D(10), endDate: D(11) })), h.api('POST', PATH, NEW({ startDate: D(10), endDate: D(11) }))]);
  check('the same request submitted twice at once: one 201, one 409', race.map((x) => x.status).sort(), [201, 409]);

  const bad = async (body) => { const x = await h.api('POST', PATH, body); return [x.status, fields(x)]; };
  check('no staff member / a malformed one', [await bad(NEW({ staffId: '' })), await bad(NEW({ staffId: 'CUS-0001' }))], [[422, ['staffId']], [422, ['staffId']]]);
  check('an unknown or inactive staff member (mechanic or other staff)',
    [await bad(NEW({ staffId: 'STF-0099', startDate: D(30), endDate: D(30) })), await bad(NEW({ staffId: 'MEC-0003', startDate: D(30), endDate: D(30) })),
      await bad(NEW({ staffId: 'STF-0002', startDate: D(30), endDate: D(30) }))],
    [[422, ['staffId']], [422, ['staffId']], [422, ['staffId']]]);
  check('an unknown leave type (none of the four)', [await bad(NEW({ leaveType: 'Maternity' })), await bad(NEW({ leaveType: 'casual' })), await bad(NEW({ leaveType: undefined }))],
    [[422, ['leaveType']], [422, ['leaveType']], [422, ['leaveType']]]);
  check('missing or bad dates, an end before the start, more than 366 days, a start more than a year away',
    [await bad(NEW({ startDate: undefined })), await bad(NEW({ endDate: '' })), await bad(NEW({ startDate: '2026-02-30' })),
      await bad(NEW({ startDate: D(40), endDate: D(39) })), await bad(NEW({ startDate: D(40), endDate: D(410) })), await bad(NEW({ startDate: D(400), endDate: D(401) })),
      await bad(NEW({ startDate: D(-400), endDate: D(-399) }))],
    [[422, ['startDate']], [422, ['endDate']], [422, ['startDate']], [422, ['endDate']], [422, ['endDate']], [422, ['startDate']], [422, ['startDate']]]);
  check('no reason, a blank one, over 500 characters, not text',
    [await bad(NEW({ reason: undefined })), await bad(NEW({ reason: '   ' })), await bad(NEW({ reason: 'x'.repeat(501) })), await bad(NEW({ reason: 5 }))],
    [[422, ['reason']], [422, ['reason']], [422, ['reason']], [422, ['reason']]]);
  check('unknown properties are refused (no id, status, decision or timestamps can be set)',
    [await bad(NEW({ id: 'LVR-0100' })), await bad(NEW({ status: 'Approved' })), await bad(NEW({ decidedBy: 'me', createdAt: AT })), await bad(NEW({ days: 9 }))],
    [[422, ['id']], [422, ['status']], [422, ['createdAt', 'decidedBy']], [422, ['days']]]);
  check('not JSON / not an object', [(await h.api('POST', PATH, '{oops')).status, (await h.api('POST', PATH, '[1]')).status], [400, 400]);
  check('nothing was written by any refused request', h.one('SELECT count(*) AS n FROM leave_requests').n, 5);
}

/* ---------- D. list and detail ---------- */
console.log('\n-- D. list and detail --');
{
  const h = fresh();
  for (const b of [NEW(), NEW({ staffId: 'STF-0001', leaveType: 'Sick', startDate: D(-1), endDate: D(-1) }), NEW({ staffId: 'MEC-0002', leaveType: 'Annual', startDate: D(20), endDate: D(26) })]) {
    const x = await h.api('POST', PATH, b); if (x.status !== 201) console.log('setup failed', x.text);
  }
  const ids = (r) => (r.body?.data ?? []).map((a) => a.id);
  const all = await h.api('GET', PATH);
  check('all requests, newest first; meta total, types, statuses and today',
    [ids(all), all.body?.total, all.body?.types, all.body?.statuses, all.body?.today],
    [['LVR-0003', 'LVR-0002', 'LVR-0001'], 3, ['Casual', 'Sick', 'Annual', 'Unpaid'], ['Pending', 'Approved', 'Rejected'], TODAY]);
  check('one type, one staff member (mechanic or other staff)',
    [ids(await h.api('GET', `${PATH}?leaveType=Sick`)), ids(await h.api('GET', `${PATH}?staffId=MEC-0001`)), ids(await h.api('GET', `${PATH}?staffId=STF-0001`))],
    [['LVR-0002'], ['LVR-0001'], ['LVR-0002']]);
  check('one status', [ids(await h.api('GET', `${PATH}?status=Pending`)).length, ids(await h.api('GET', `${PATH}?status=Approved`))], [3, []]);
  check('paging', [ids(await h.api('GET', `${PATH}?limit=2`)), ids(await h.api('GET', `${PATH}?limit=2&offset=2`))], [['LVR-0003', 'LVR-0002'], ['LVR-0001']]);
  const code = async (q) => (await h.api('GET', `${PATH}?${q}`)).status;
  check('bad parameters are 400: a bad status, a bad type, a bad staff id, a bad limit',
    [await code('status=Cancelled'), await code('leaveType=Maternity'), await code('staffId=JOB-0001'), await code('limit=0')], [400, 400, 400, 400]);
  const one = await h.api('GET', `${PATH}/LVR-0003`);
  check('the detail of one request', [one.status, one.body?.data?.staffName, one.body?.data?.leaveType, one.body?.data?.days], [200, 'Kamal', 'Annual', 7]);
  check('an unknown request is 404, a malformed id 400', [(await h.api('GET', `${PATH}/LVR-0999`)).status, (await h.api('GET', `${PATH}/MEC-0001`)).status], [404, 400]);
}

/* ---------- E. decisions ---------- */
console.log('\n-- E. decisions --');
{
  const h = fresh();
  const a = (await h.api('POST', PATH, NEW())).body.data;
  const b = (await h.api('POST', PATH, NEW({ staffId: 'STF-0001' }))).body.data;
  const act = (id, name, body) => h.api('POST', `${PATH}/${id}/${name}`, body);
  const yes = await act(a.id, 'approve', { expectedUpdatedAt: a.updatedAt, note: '  enjoy  ' });
  const y = yes.body?.data ?? {};
  check('approve with the updatedAt it was made from: Approved, who, when and the note kept; the request itself unchanged',
    [yes.status, y.status, y.decidedBy, y.decisionNote, y.leaveType, y.startDate, y.reason, y.createdAt], [200, 'Approved', 'API token', 'enjoy', 'Casual', D(3), 'Family wedding', a.createdAt]);
  ok_('   ...decidedAt = updatedAt, after the submission', y.decidedAt && y.decidedAt === y.updatedAt && y.updatedAt > a.updatedAt, JSON.stringify(y));
  const again = await act(a.id, 'reject', { expectedUpdatedAt: y.updatedAt, note: 'changed my mind' });
  check('a decided request cannot be decided again: 409 already_decided, still Approved',
    [again.status, again.body?.error?.reason, h.one('SELECT status FROM leave_requests WHERE id = ?', a.id).status], [409, 'already_decided', 'Approved']);
  check('...nor approved twice', (await act(a.id, 'approve', { expectedUpdatedAt: y.updatedAt })).body?.error?.reason, 'already_decided');
  check('a rejection needs a reason', fields(await act(b.id, 'reject', { expectedUpdatedAt: b.updatedAt })), ['note']);
  check('expectedUpdatedAt is required; unknown keys are refused',
    [fields(await act(b.id, 'approve', {})), fields(await act(b.id, 'approve', { expectedUpdatedAt: b.updatedAt, status: 'Approved' }))], [['expectedUpdatedAt'], ['status']]);
  const stale = await act(b.id, 'approve', { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  check('a decision made from an out-of-date copy is refused (409); still Pending',
    [stale.status, stale.body?.error?.reason, h.one('SELECT status FROM leave_requests WHERE id = ?', b.id).status], [409, 'concurrent_modification', 'Pending']);
  const both = await Promise.all([act(b.id, 'approve', { expectedUpdatedAt: b.updatedAt }), act(b.id, 'reject', { expectedUpdatedAt: b.updatedAt, note: 'no' })]);
  check('approve and reject at once: exactly one wins, the other is 409', both.map((x) => x.status).sort(), [200, 409]);
  check('a note over 500 characters is refused', fields(await act(a.id, 'approve', { expectedUpdatedAt: a.updatedAt, note: 'x'.repeat(501) })), ['note']);
  check('an unknown request is 404, a malformed id 400',
    [(await act('LVR-0999', 'approve', { expectedUpdatedAt: AT })).status, (await act('X-1', 'approve', { expectedUpdatedAt: AT })).status], [404, 400]);
  check('GET on an action is 405; PUT and DELETE on a request are 405 (decided once, kept)',
    [(await h.api('GET', `${PATH}/${a.id}/approve`)).status, (await h.api('PUT', `${PATH}/${a.id}`, { reason: 'x' })).status, (await h.api('DELETE', `${PATH}/${a.id}`)).status],
    [405, 405, 405]);
  const c = (await h.api('POST', PATH, NEW({ staffId: 'MEC-0002' }))).body.data;
  await act(c.id, 'reject', { expectedUpdatedAt: c.updatedAt, note: 'Busy week' });
  check('a Rejected request no longer blocks those days', (await h.api('POST', PATH, NEW({ staffId: 'MEC-0002' }))).status, 201);
  check('an Approved request does block them', (await h.api('POST', PATH, NEW())).body?.error?.reason, 'overlapping_request');
}

/* ---------- F. compatibility ---------- */
console.log('\n-- F. compatibility --');
{
  const h = fresh();
  const counts = () => ['mechanics', 'staff', 'attendance', 'user_accounts', 'job_cards'].map((t) => h.one(`SELECT count(*) AS n FROM ${t}`).n);
  const before = counts();
  const made = (await h.api('POST', PATH, NEW({ startDate: D(0), endDate: D(0) }))).body.data;
  await h.api('POST', `${PATH}/${made.id}/approve`, { expectedUpdatedAt: made.updatedAt });
  check('submitting and approving leave changes no other table -- no attendance record is made', counts(), before);
  check('the attendance of that day still reads as nothing recorded', (await h.api('GET', `/api/attendance?date=${D(0)}`)).body?.data?.length, 0);
  const routes = (await h.api('GET', '/api/health')).body?.data?.routes ?? [];
  check('the registry holds the five leave routes (190 with the two activity-log routes of 0012, the five tools routes of 0013, the eight Messenger routes of 0014 the nine WhatsApp routes of 0015 the five Notifications routes of 0017 the five Roles routes of 0018 and the two session routes of 0019 and the two equipment routes of 0021 and the seven bookings routes of 0023 and the six maintenance routes of 0024 and the six assignment routes of 0025 and the two Asset History routes and the two Asset Reports routes)',
    [routes.length, routes.filter((r) => r.includes('/api/leave-requests'))],
    [190, ['GET /api/leave-requests', 'POST /api/leave-requests', 'GET /api/leave-requests/:id',
      'POST /api/leave-requests/:id/approve', 'POST /api/leave-requests/:id/reject']]);
  await h.api('POST', PATH, NEW({ staffId: 'MEC-0004', startDate: D(50), endDate: D(50) }));
  const del = await h.api('DELETE', '/api/mechanics/MEC-0004');
  check('deleting an unused mechanic (as before) takes their requests with them', [del.status, h.one("SELECT count(*) AS n FROM leave_requests WHERE mechanic_id = 'MEC-0004'").n], [200, 0]);
}

console.log(`\nLeave requests unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
