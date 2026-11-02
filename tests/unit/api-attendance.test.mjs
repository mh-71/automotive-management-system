/* Attendance (0010) — unit tests against the REAL Worker: /api/attendance.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0010) through the same minimal D1-shaped wrapper the staff
   and accounts suites use, with the real auth gate (token, passphrase,
   account sessions).

   What must hold:
     A. Schema: columns, CHECKs (exactly one person, the six statuses, times
        only for a worked day, check-out after check-in, HH:MM), the foreign
        keys and their cascade, ONE record per person per day, the ATT
        counter; re-runnable.
     B. Authorization: no credential -> 401 on every route before any
        statement; the machine token, the passphrase session and an account
        session may read and record attendance (nothing narrower exists).
     C. Create: for an existing ACTIVE staff member (mechanic or other staff),
        server id, never a future day (Asia/Dhaka), status / time / notes rules,
        unknown properties refused, a second record for the same person and
        day refused (409, naming the existing one) -- also for two creates at once.
     D. List and detail: one day, a range (max 62 days), staff and status
        filters, bad parameters 400, the person's name and department joined in.
     E. Update: only status, times and notes; the person and date never change;
        expectedUpdatedAt required, and a stale one refused (409) -- never a
        silent overwrite; the merged result obeys the same rules.
     F. Compatibility: staff, mechanics, job cards and accounts untouched; the
        registry grows by exactly the four attendance routes; deleting an unused
        mechanic takes its attendance with it.
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
  console.log(`\nAttendance unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AT = '2026-10-08T00:00:00Z';
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql', '0009_user_accounts.sql', '0010_attendance.sql'];
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';

// Days relative to today in the workshop's timezone, as the Worker computes it.
const DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (offset) => DHAKA.format(new Date(Date.now() + offset * 86400000));
const TODAY = day(0), D1 = day(-1), D2 = day(-2), D40 = day(-40), TOMORROW = day(1);

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
    return { status: res.status, body: json, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const passphraseCookie = async () => (await api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie;
  return { DB, env, api, one, passphraseCookie };
}

const fields = (r) => Object.keys(r.body?.error?.fields ?? {}).sort();
const NEW = (extra = {}) => ({ staffId: 'MEC-0001', date: D1, status: 'Present', checkIn: '09:00', checkOut: '18:00', ...extra });

console.log('=== Attendance (0010) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  check('attendance has the designed columns', h.DB.raw.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name),
    ['id', 'mechanic_id', 'staff_id', 'attendance_date', 'status', 'check_in', 'check_out', 'notes', 'created_at', 'updated_at']);
  check('two foreign keys: mechanics and staff, both ON DELETE CASCADE',
    h.DB.raw.prepare('PRAGMA foreign_key_list(attendance)').all().map((f) => `${f.from}->${f.table}.${f.to} ${f.on_delete}`).sort(),
    ['mechanic_id->mechanics.id CASCADE', 'staff_id->staff.id CASCADE']);
  check('indexes: one record per mechanic per day, one per staff member per day, and the date',
    h.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attendance' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    ['ix_attendance_date', 'ux_attendance_mechanic_day', 'ux_attendance_staff_day']);
  check('the ATT counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='attendance'"), { prefix: 'ATT', last_value: 0 });
  const ins = (id, m, s, d, st, ci = null, co = null) => {
    try { h.DB.raw.prepare('INSERT INTO attendance (id, mechanic_id, staff_id, attendance_date, status, check_in, check_out, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, m, s, d, st, ci, co, AT, AT); return 'ok'; }
    catch (e) { return /UNIQUE/.test(e.message) ? 'unique' : /FOREIGN/.test(e.message) ? 'fk' : /CHECK/.test(e.message) ? 'check' : e.message; }
  };
  check('the schema refuses: no person, both people, a missing staff member, a mechanic profile as staff, an unknown status, a bad date, times on an absent day, a check-out before the check-in, a malformed time',
    [ins('ATT-9001', null, null, '2026-10-01', 'Present'), ins('ATT-9002', 'MEC-0001', 'STF-0001', '2026-10-01', 'Present'),
      ins('ATT-9003', null, 'STF-0999', '2026-10-01', 'Present'), ins('ATT-9004', null, 'MEC-0001', '2026-10-01', 'Present'),
      ins('ATT-9005', 'MEC-0001', null, '2026-10-01', 'Sick'), ins('ATT-9006', 'MEC-0001', null, '01-10-2026', 'Present'),
      ins('ATT-9007', 'MEC-0001', null, '2026-10-01', 'Absent', '09:00'), ins('ATT-9008', 'MEC-0001', null, '2026-10-01', 'Present', '10:00', '09:00'),
      ins('ATT-9009', 'MEC-0001', null, '2026-10-01', 'Present', '9:00')],
    ['check', 'check', 'fk', 'check', 'check', 'check', 'check', 'check', 'check']);
  check('...and allows one record per person per day',
    [ins('ATT-9010', 'MEC-0001', null, '2026-10-01', 'Present', '09:00', '17:00'), ins('ATT-9011', 'MEC-0001', null, '2026-10-01', 'Absent'),
      ins('ATT-9012', 'MEC-0001', null, '2026-10-02', 'Absent'), ins('ATT-9013', null, 'STF-0001', '2026-10-01', 'On Leave'),
      ins('ATT-9014', null, 'STF-0001', '2026-10-01', 'Holiday')],
    ['ok', 'unique', 'ok', 'ok', 'unique']);
  h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0010_attendance.sql'), 'utf8'));
  ok_('the migration can be re-run without error or loss', h.one('SELECT count(*) AS n FROM attendance').n === 3);
}

/* ---------- B. authorization ---------- */
console.log('\n-- B. authorization --');
{
  const h = fresh();
  const before = h.DB.statements.length;
  const routes = [['GET', '/api/attendance'], ['POST', '/api/attendance', NEW()], ['GET', '/api/attendance/ATT-0001'],
    ['PUT', '/api/attendance/ATT-0001', { status: 'Absent', expectedUpdatedAt: AT }]];
  const anon = [];
  for (const [m, p, b] of routes) anon.push((await h.api(m, p, b, 'none')).status);
  check('without a credential every attendance route is 401', anon, [401, 401, 401, 401]);
  check('   ...before any statement reaches the database', h.DB.statements.length, before);
  check('a forged session cookie is 401', (await h.api('GET', '/api/attendance', undefined, 'taqwa_session=v1.9999999999.forged')).status, 401);
  check('DELETE is not a route: 405 (a record is corrected, never deleted)', (await h.api('DELETE', '/api/attendance/ATT-0001')).status, 405);
  const owner = await h.passphraseCookie();
  check('the passphrase session may read and record', [(await h.api('GET', '/api/attendance', undefined, owner)).status,
    (await h.api('POST', '/api/attendance', NEW(), owner)).status], [200, 201]);
  check('so may the machine token', (await h.api('GET', '/api/attendance/ATT-0001')).status, 200);
  const acct = await h.api('POST', '/api/accounts', { staffId: 'STF-0001', username: 'nadia', role: 'Administrator', password: PW }, owner);
  const cookie = (await h.api('POST', '/api/session', { username: 'nadia', password: PW }, 'none')).cookie;
  check('and an account session (every account is an Administrator; nothing narrower exists)',
    [acct.status, (await h.api('POST', '/api/attendance', NEW({ staffId: 'STF-0001' }), cookie)).status], [201, 201]);
}

/* ---------- C. create ---------- */
console.log('\n-- C. create --');
{
  const h = fresh();
  const r = await h.api('POST', '/api/attendance', NEW({ notes: '  came early  ' }));
  check('a mechanic\'s day: 201, a server id, the person\'s name and department joined in, notes trimmed',
    [r.status, r.body?.data?.id, r.body?.data?.staffId, r.body?.data?.isMechanic, r.body?.data?.staffName, r.body?.data?.department,
      r.body?.data?.designation, r.body?.data?.date, r.body?.data?.status, r.body?.data?.checkIn, r.body?.data?.checkOut, r.body?.data?.notes],
    [201, 'ATT-0001', 'MEC-0001', true, 'Jamal Uddin', 'Workshop', 'Senior Mechanic', D1, 'Present', '09:00', '18:00', 'came early']);
  ok_('   ...createdAt and updatedAt set (the same instant)', r.body?.data?.createdAt && r.body.data.createdAt === r.body.data.updatedAt, JSON.stringify(r.body?.data));
  const s = await h.api('POST', '/api/attendance', { staffId: 'STF-0001', date: TODAY, status: 'On Leave' });
  check('another employee\'s day, today, no times', [s.status, s.body?.data?.staffId, s.body?.data?.isMechanic, s.body?.data?.checkIn, s.body?.data?.department],
    [201, 'STF-0001', false, '', 'Accounts']);
  check('a mechanic without a profile row: department empty, designation Mechanic',
    [(await h.api('POST', '/api/attendance', NEW({ staffId: 'MEC-0002', status: 'Late', checkIn: '10:15', checkOut: '' }))).body?.data?.designation], ['Mechanic']);

  const dup = await h.api('POST', '/api/attendance', NEW({ status: 'Absent', checkIn: '', checkOut: '' }));
  check('a second record for the same person and day: 409, naming the existing one; nothing written',
    [dup.status, dup.body?.error?.reason, dup.body?.error?.conflictsWith, h.one("SELECT count(*) AS n FROM attendance WHERE mechanic_id = 'MEC-0001'").n],
    [409, 'already_recorded', 'ATT-0001', 1]);
  const race = await Promise.all([h.api('POST', '/api/attendance', NEW({ date: D2 })), h.api('POST', '/api/attendance', NEW({ date: D2, status: 'Late' }))]);
  check('two creates for the same person and day at once: one 201, one 409', race.map((x) => x.status).sort(), [201, 409]);
  // The unique index is the last word even if the check before the insert is skipped.
  let indexSays = '';
  try { h.DB.raw.prepare("INSERT INTO attendance (id, mechanic_id, attendance_date, status, created_at, updated_at) VALUES ('ATT-9999', 'MEC-0001', ?, 'Absent', ?, ?)").run(D2, AT, AT); } catch (e) { indexSays = /UNIQUE/.test(e.message) ? 'unique' : e.message; }
  check('   ...and the database itself refuses a third', indexSays, 'unique');

  const bad = async (body) => { const x = await h.api('POST', '/api/attendance', body); return [x.status, fields(x)]; };
  check('no staff member / a malformed one', [await bad(NEW({ staffId: '' })), await bad(NEW({ staffId: 'CUS-0001' }))],
    [[422, ['staffId']], [422, ['staffId']]]);
  check('an unknown or inactive staff member (mechanic or other staff)',
    [await bad(NEW({ staffId: 'STF-0099' })), await bad(NEW({ staffId: 'MEC-0003' })), await bad(NEW({ staffId: 'STF-0002' }))],
    [[422, ['staffId']], [422, ['staffId']], [422, ['staffId']]]);
  check('no date, not a real date, a future day', [await bad(NEW({ date: undefined })), await bad(NEW({ date: '2026-02-30' })), await bad(NEW({ date: TOMORROW }))],
    [[422, ['date']], [422, ['date']], [422, ['date']]]);
  check('an unknown status (none of the six)', [await bad(NEW({ status: 'Sick' })), await bad(NEW({ status: 'present' })), await bad(NEW({ status: undefined }))],
    [[422, ['status']], [422, ['status']], [422, ['status']]]);
  check('times on a day not worked', [await bad(NEW({ date: day(-3), status: 'Absent' })), await bad(NEW({ date: day(-3), status: 'Holiday', checkIn: '', checkOut: '17:00' }))],
    [[422, ['checkIn', 'checkOut']], [422, ['checkOut']]]);
  check('a malformed time, a check-out before / equal to the check-in, a check-out alone',
    [await bad(NEW({ date: day(-3), checkIn: '9:00' })), await bad(NEW({ date: day(-3), checkIn: '24:00', checkOut: '' })),
      await bad(NEW({ date: day(-3), checkIn: '18:00', checkOut: '09:00' })), await bad(NEW({ date: day(-3), checkIn: '09:00', checkOut: '09:00' })),
      await bad(NEW({ date: day(-3), checkIn: '', checkOut: '17:00' })), await bad(NEW({ date: day(-3), checkIn: 900 }))],
    [[422, ['checkIn']], [422, ['checkIn']], [422, ['checkOut']], [422, ['checkOut']], [422, ['checkOut']], [422, ['checkIn']]]);
  check('notes over 500 characters, or not text', [await bad(NEW({ date: day(-3), notes: 'x'.repeat(501) })), await bad(NEW({ date: day(-3), notes: 5 }))],
    [[422, ['notes']], [422, ['notes']]]);
  check('unknown properties are refused (no id, timestamps or anything else can be set)',
    [await bad(NEW({ date: day(-3), id: 'ATT-0100' })), await bad(NEW({ date: day(-3), createdAt: AT, updatedAt: AT })), await bad(NEW({ date: day(-3), hours: 9 }))],
    [[422, ['id']], [422, ['createdAt', 'updatedAt']], [422, ['hours']]]);
  check('not JSON / not an object', [(await h.api('POST', '/api/attendance', '{oops')).status, (await h.api('POST', '/api/attendance', '[1]')).status], [400, 400]);
  check('nothing was written by any refused request', h.one('SELECT count(*) AS n FROM attendance').n, 4);
}

/* ---------- D. list and detail ---------- */
console.log('\n-- D. list and detail --');
{
  const h = fresh();
  for (const b of [NEW(), NEW({ staffId: 'STF-0001', status: 'Absent', checkIn: '', checkOut: '' }), NEW({ staffId: 'MEC-0002', date: D2, status: 'Half-day', checkIn: '09:00', checkOut: '13:00' }),
    NEW({ date: D40, status: 'Holiday', checkIn: '', checkOut: '' })]) {
    const x = await h.api('POST', '/api/attendance', b); if (x.status !== 201) console.log('setup failed', x.text);
  }
  const ids = (r) => (r.body?.data ?? []).map((a) => a.id);
  const all = await h.api('GET', '/api/attendance');
  check('all records, ordered by day then name; meta total and the six statuses',
    [ids(all), all.body?.total, all.body?.statuses, all.body?.today], [['ATT-0004', 'ATT-0003', 'ATT-0001', 'ATT-0002'], 4,
      ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday'], TODAY]);
  check('one day', ids(await h.api('GET', `/api/attendance?date=${D1}`)), ['ATT-0001', 'ATT-0002']);
  check('a range', ids(await h.api('GET', `/api/attendance?from=${D2}&to=${D1}`)), ['ATT-0003', 'ATT-0001', 'ATT-0002']);
  check('one staff member (mechanic or other staff)', [ids(await h.api('GET', '/api/attendance?staffId=MEC-0001')), ids(await h.api('GET', '/api/attendance?staffId=STF-0001'))],
    [['ATT-0004', 'ATT-0001'], ['ATT-0002']]);
  check('one status', ids(await h.api('GET', '/api/attendance?status=Half-day')), ['ATT-0003']);
  check('paging', [ids(await h.api('GET', '/api/attendance?limit=2')), ids(await h.api('GET', '/api/attendance?limit=2&offset=2'))],
    [['ATT-0004', 'ATT-0003'], ['ATT-0001', 'ATT-0002']]);
  const code = async (q) => (await h.api('GET', `/api/attendance?${q}`)).status;
  check('bad parameters are 400: a bad date, date with a range, half a range, a reversed range, a range over 62 days, a bad staff id, a bad status, a bad limit',
    [await code('date=2026-13-01'), await code(`date=${D1}&from=${D2}&to=${D1}`), await code(`from=${D2}`), await code(`from=${D1}&to=${D2}`),
      await code('from=2026-01-01&to=2026-03-05'), await code('staffId=JOB-0001'), await code('status=Sick'), await code('limit=0')],
    [400, 400, 400, 400, 400, 400, 400, 400]);
  const one = await h.api('GET', '/api/attendance/ATT-0003');
  check('the detail of one record', [one.status, one.body?.data?.staffName, one.body?.data?.status, one.body?.data?.checkOut], [200, 'Kamal', 'Half-day', '13:00']);
  check('an unknown record is 404, a malformed id 400', [(await h.api('GET', '/api/attendance/ATT-0999')).status, (await h.api('GET', '/api/attendance/MEC-0001')).status], [404, 400]);
}

/* ---------- E. update ---------- */
console.log('\n-- E. update --');
{
  const h = fresh();
  const made = (await h.api('POST', '/api/attendance', NEW())).body.data;
  const put = (body, id = made.id) => h.api('PUT', `/api/attendance/${id}`, body);
  const fixed = await put({ status: 'Late', checkIn: '10:05', expectedUpdatedAt: made.updatedAt, notes: 'traffic' });
  check('a correction with the updatedAt it was made from: status, time and notes change; person and date do not',
    [fixed.status, fixed.body?.data?.status, fixed.body?.data?.checkIn, fixed.body?.data?.checkOut, fixed.body?.data?.notes, fixed.body?.data?.staffId, fixed.body?.data?.date],
    [200, 'Late', '10:05', '18:00', 'traffic', 'MEC-0001', D1]);
  ok_('   ...updatedAt moves on (createdAt does not)', fixed.body?.data?.updatedAt > made.updatedAt && fixed.body?.data?.createdAt === made.createdAt, JSON.stringify(fixed.body?.data));
  const stale = await put({ status: 'Absent', checkIn: '', checkOut: '', expectedUpdatedAt: made.updatedAt });
  check('a second edit made from the OLD record is refused (409) -- the first correction is not overwritten',
    [stale.status, stale.body?.error?.reason, h.one('SELECT status FROM attendance WHERE id = ?', made.id).status], [409, 'concurrent_modification', 'Late']);
  const cur = fixed.body.data;
  check('expectedUpdatedAt is required', [(await put({ status: 'Absent' })).status, fields(await put({ status: 'Absent' }))], [422, ['expectedUpdatedAt']]);
  check('the person and the date cannot be changed; other keys are refused',
    [fields(await put({ staffId: 'MEC-0002', expectedUpdatedAt: cur.updatedAt })), fields(await put({ date: D2, expectedUpdatedAt: cur.updatedAt })),
      fields(await put({ id: 'ATT-0100', expectedUpdatedAt: cur.updatedAt }))], [['staffId'], ['date'], ['id']]);
  check('nothing to change is 422', fields(await put({ expectedUpdatedAt: cur.updatedAt })), ['status']);
  check('the merged record obeys the rules: Absent with the times still there is refused, check-out before check-in too',
    [fields(await put({ status: 'Absent', expectedUpdatedAt: cur.updatedAt })), fields(await put({ checkOut: '08:00', expectedUpdatedAt: cur.updatedAt }))],
    [['checkIn', 'checkOut'], ['checkOut']]);
  const absent = await put({ status: 'Absent', checkIn: '', checkOut: '', expectedUpdatedAt: cur.updatedAt });
  check('...Absent with the times cleared is accepted', [absent.status, absent.body?.data?.status, absent.body?.data?.checkIn, absent.body?.data?.checkOut], [200, 'Absent', '', '']);
  check('an unknown record is 404, a malformed id 400, not JSON 400',
    [(await put({ status: 'Absent', expectedUpdatedAt: AT }, 'ATT-0999')).status, (await put({ status: 'Absent', expectedUpdatedAt: AT }, 'X-1')).status,
      (await h.api('PUT', `/api/attendance/${made.id}`, '{oops')).status], [404, 400, 400]);
  check('exactly one record exists after every edit', h.one('SELECT count(*) AS n FROM attendance').n, 1);
}

/* ---------- F. compatibility ---------- */
console.log('\n-- F. compatibility --');
{
  const h = fresh();
  const counts = () => ['mechanics', 'staff', 'job_cards', 'user_accounts', 'customers'].map((t) => h.one(`SELECT count(*) AS n FROM ${t}`).n);
  const before = counts();
  await h.api('POST', '/api/attendance', NEW());
  await h.api('POST', '/api/attendance', NEW({ staffId: 'MEC-0004' }));
  check('recording attendance changes no other table', counts(), before);
  check('the staff roster still lists everyone', (await h.api('GET', '/api/staff')).body?.data?.length, 6);
  const routes = (await h.api('GET', '/api/health')).body?.data?.routes ?? [];
  check('the registry holds the four attendance routes (139 with the leave routes of 0011, the activity log of 0012, the tools routes of 0013, the Messenger routes of 0014 and the WhatsApp routes of 0015)',
    [routes.length, routes.filter((r) => r.includes('/api/attendance'))],
    [139, ['GET /api/attendance', 'POST /api/attendance', 'GET /api/attendance/:id', 'PUT /api/attendance/:id']]);
  const del = await h.api('DELETE', '/api/mechanics/MEC-0004');
  check('deleting an unused mechanic (as before) takes its attendance with it', [del.status, h.one("SELECT count(*) AS n FROM attendance WHERE mechanic_id = 'MEC-0004'").n], [200, 0]);
  check('a mechanic with job cards still cannot be deleted, so their attendance stays', [(await h.api('DELETE', '/api/mechanics/MEC-0001')).status, h.one('SELECT count(*) AS n FROM attendance').n], [409, 1]);
}

console.log(`\nAttendance unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
