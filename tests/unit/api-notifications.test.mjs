/* Notifications Center (0017) — unit tests against the REAL Worker.

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0017). Every name and number is a fictional test value.

   What must hold:
     A. Schema: two additive tables; a UNIQUE event key; categories, priority
        and record type checked; read markers belong to a notification;
        re-running the migration loses nothing.
     B. Access: 401 without a credential, before any statement; a personal
        notification is visible to its account only (404 to anyone else).
     C. Real events: creating a customer, vehicle, appointment, job card,
        estimate, invoice and payment, changing an appointment and a job
        card's status, cancelling an appointment, a website enquiry, a leave
        request and its decision each raise exactly one notification with
        the right category, wording and record link. A failed request, a
        refused one, a duplicate website enquiry and an unrelated route raise
        none. The answer itself is unchanged and not delayed.
     D. Time-based: open follow-ups and tasks due today or earlier, and parts at
        or below their minimum, raise one notification each; a second sweep
        adds nothing (no duplicates); a new stock movement raises a new one.
     E. API: list newest first with total/unread/important; All/Unread/Read,
        category and search filters; paging; mark one read/unread; mark all
        read (up to an id); read state is per reader; invalid input is 400/422.
     F. Failures: a database error is a 503 with a plain message; a failing
        notification write never fails the CRM request.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */

import worker from '../../src/index.js';
import { resetSweepClock, sweepNotifications } from '../../src/lib/notifications.js';
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
  console.log(`\nNotifications unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) <= '0017').sort();
const TOKEN = 'unit-test-token';
const PASSPHRASE = 'workshop passphrase for tests';
const SECRET = 'unit-test-signing-secret-0123456789abcdef';
const PW = 'Correct-Horse-42';
const AT = '2026-10-08T00:00:00Z';
const DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (offset) => DHAKA.format(new Date(Date.now() + offset * 86400000));
const FP = 'a'.repeat(64);

function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  const statements = [];
  const db = { raw, statements, broken: null };
  const guard = (sql) => { if (db.broken && db.broken.test(sql)) throw new Error('D1_ERROR: simulated failure'); };
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      statements.push(this.sql); guard(this.sql);
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      statements.push(this.sql); guard(this.sql);
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { statements.push(this.sql); guard(this.sql); return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  db.prepare = (sql) => new Stmt(sql);
  db.batch = async (list) => {
    raw.exec('BEGIN');
    try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  };
  return db;
}

function fresh() {
  resetSweepClock();
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'Test Customer Alpha', '01700000001', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection = 'customers';
    INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'TEST-REG-01', 'Toyota', 'Axio', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection = 'vehicles';
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'Test Mechanic', '01800000001', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection = 'mechanics';
    INSERT INTO services (id, name, created_at) VALUES ('SRV-0001', 'Test Service', '${AT}');
    UPDATE id_counters SET last_value = 1 WHERE collection = 'services';
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Test Staff One', '01911000001', 'Active', 'Accountant', 'Accounts', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0002', 'Test Staff Two', '01911000002', 'Active', 'Helper', 'Workshop', '${AT}');
    UPDATE id_counters SET last_value = 2 WHERE collection = 'staff';`);
  const env = { DB, API_TOKEN: TOKEN, AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  /** cred: 'token' | 'none' | a cookie string. */
  const api = async (method, path, body, cred = 'token', extra = {}) => {
    const headers = { ...(extra.headers || {}) };
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
  const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);
  const count = () => one('SELECT count(*) AS n FROM notifications').n;
  const last = () => one('SELECT * FROM notifications ORDER BY id DESC LIMIT 1');
  const accountCookie = async (staffId, username) => {
    await api('POST', '/api/accounts', { staffId, username, role: 'Administrator', password: PW });
    return (await api('POST', '/api/session', { username, password: PW }, 'none')).cookie;
  };
  return { DB, env, ctx, pending, api, one, all, count, last, accountCookie };
}

const N = '/api/notifications';

console.log('=== Notifications (0017) against an in-memory database ===');

/* ---------- A. schema ---------- */
console.log('\n-- A. schema --');
{
  const h = fresh();
  check('notifications has the designed columns', h.all('PRAGMA table_info(notifications)').map((c) => c.name),
    ['id', 'event_key', 'event_type', 'category', 'priority', 'title', 'message', 'record_type', 'record_id',
      'recipient_account_id', 'actor_name', 'created_at']);
  check('notification_reads has the designed columns', h.all('PRAGMA table_info(notification_reads)').map((c) => c.name),
    ['notification_id', 'reader', 'read_at']);
  check('indexes', h.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('notifications','notification_reads') AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name),
    ['ix_notification_reads_reader', 'ix_notifications_category', 'ix_notifications_created', 'ix_notifications_recipient']);
  check('foreign keys: a read marker to its notification, a recipient to a user account',
    [h.all('PRAGMA foreign_key_list(notification_reads)').map((f) => f.table), h.all('PRAGMA foreign_key_list(notifications)').map((f) => f.table)],
    [['notifications'], ['user_accounts']]);
  const ins = (vals) => {
    try {
      h.DB.raw.exec(`INSERT INTO notifications (event_key, event_type, category, priority, title, message, record_type, record_id, recipient_account_id, created_at) VALUES (${vals})`);
      return 'ok';
    } catch (e) { return /CHECK|UNIQUE|FOREIGN KEY|NOT NULL/.exec(e.message)?.[0] || e.message; }
  };
  check('the schema refuses: an unknown category, priority or record type, a record type without its id, a blank title, an unknown recipient',
    [ins("'key1','t.x','Marketing','normal','T','m',NULL,NULL,NULL,'x'"), ins("'key2','t.x','Customer','urgent','T','m',NULL,NULL,NULL,'x'"),
      ins("'key3','t.x','Customer','normal','T','m','planet','P-1',NULL,'x'"), ins("'key4','t.x','Customer','normal','T','m','customer',NULL,NULL,'x'"),
      ins("'key5','t.x','Customer','normal','  ','m',NULL,NULL,NULL,'x'"), ins("'key6','t.x','Customer','normal','T','m',NULL,NULL,'USR-9999','x'")],
    ['CHECK', 'CHECK', 'CHECK', 'CHECK', 'CHECK', 'FOREIGN KEY']);
  check('a valid row is accepted', ins("'key7','t.x','Customer','normal','T','m','customer','CUS-0001',NULL,'x'"), 'ok');
  check('the same event key twice is refused (duplicates impossible)', ins("'key7','t.x','Customer','normal','T2','m',NULL,NULL,NULL,'x'"), 'UNIQUE');
  let refused = 'ok';
  try { h.DB.raw.exec("INSERT INTO notification_reads (notification_id, reader, read_at) VALUES (999, 'token', 'x')"); } catch (e) { refused = /FOREIGN KEY/.test(e.message) ? 'FOREIGN KEY' : e.message; }
  check('a read marker must belong to a notification', refused, 'FOREIGN KEY');
  h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0017_notifications.sql'), 'utf8'));
  check('the migration can be re-run without error or loss', h.count(), 1);
  const sql = readFileSync(join(ROOT, 'migrations', '0017_notifications.sql'), 'utf8').replace(/--.*$/gm, '');
  ok_('the migration is additive: only CREATE ... IF NOT EXISTS, no ALTER, DROP, DELETE or UPDATE',
    !/\b(ALTER|DROP|UPDATE)\b/i.test(sql) && !/\bDELETE\b/i.test(sql.replace(/ON DELETE CASCADE/g, '')) && (sql.match(/CREATE (TABLE|INDEX)/g) || []).length === (sql.match(/IF NOT EXISTS/g) || []).length);
}

/* ---------- B. access ---------- */
console.log('\n-- B. access --');
{
  const h = fresh();
  const before = h.DB.statements.length;
  const paths = [['GET', N], ['GET', `${N}/unread-count`], ['POST', `${N}/read-all`], ['POST', `${N}/1/read`], ['POST', `${N}/1/unread`]];
  const res = [];
  for (const [m, p] of paths) res.push((await h.api(m, p, undefined, 'none')).status);
  check('every notifications route is 401 without a credential', res, [401, 401, 401, 401, 401]);
  check('   ...before any statement reaches the database', h.DB.statements.length, before);
  check('a forged credential is 401 too', (await h.api('GET', N, undefined, 'taqwa_session=forged')).status, 401);

  const nadia = await h.accountCookie('STF-0001', 'testnadia');
  const rafi = await h.accountCookie('STF-0002', 'testrafi');
  const nadiaId = h.one("SELECT id FROM user_accounts WHERE username = 'testnadia'").id;
  h.DB.raw.exec(`INSERT INTO notifications (event_key, event_type, category, title, message, recipient_account_id, created_at)
    VALUES ('personal:1', 'leave.decided', 'Staff', 'Only for Nadia', 'Personal test', '${nadiaId}', '${AT}'),
           ('shared:1', 'customer.created', 'Customer', 'For everyone', 'Shared test', NULL, '${AT}')`);
  const personalId = h.one("SELECT id FROM notifications WHERE event_key = 'personal:1'").id;
  const titles = async (cred) => ((await h.api('GET', N, undefined, cred)).body?.data || []).map((n) => n.title);
  check('the recipient sees the personal notification and the shared one', await titles(nadia), ['For everyone', 'Only for Nadia']);
  check('another account sees only the shared one', await titles(rafi), ['For everyone']);
  check('the passphrase and the machine token see only the shared one',
    [await titles(await (async () => (await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie)()), await titles('token')],
    [['For everyone'], ['For everyone']]);
  check('another account cannot mark it read or unread: 404, as if it did not exist',
    [(await h.api('POST', `${N}/${personalId}/read`, undefined, rafi)).status, (await h.api('POST', `${N}/${personalId}/unread`, undefined, rafi)).status], [404, 404]);
  check('   ...and nothing was written for them', h.one("SELECT count(*) AS n FROM notification_reads WHERE reader LIKE 'account:%' AND notification_id = ?", personalId).n, 0);
  await h.api('POST', `${N}/read-all`, undefined, rafi);
  check('mark-all by another account does not touch the personal one', h.one('SELECT count(*) AS n FROM notification_reads WHERE notification_id = ?', personalId).n, 0);
  check('   ...the recipient still has it unread', (await h.api('GET', `${N}/unread-count`, undefined, nadia)).body.data.unread, 2);
}

/* ---------- C. real events ---------- */
console.log('\n-- C. real events --');
{
  const h = fresh();
  const n0 = h.count();
  const listedOnly = await h.api('GET', '/api/customers');
  check('reading the CRM raises nothing', [listedOnly.status, h.count()], [200, n0]);

  const cust = await h.api('POST', '/api/customers', { name: 'Test Customer Beta', phone: '01700000002' });
  check('creating a customer: 201', cust.status, 201);
  let n = h.last();
  check('   ...one notification: Customer, "New customer registered", linked to the customer',
    [h.count(), n.category, n.title, n.record_type, n.record_id, n.event_key], [1, 'Customer', 'New customer registered', 'customer', cust.body.data.id, `customer.created:${cust.body.data.id}`]);
  ok_('   ...naming the customer and who did it', /Test Customer Beta/.test(n.message) && n.actor_name === 'API token', JSON.stringify(n));

  const veh = await h.api('POST', '/api/vehicles', { customerId: 'CUS-0001', regNo: 'TEST-REG-02', brand: 'Honda', model: 'Fit' });
  n = h.last();
  check('creating a vehicle: Customer, "New vehicle registered", with owner',
    [veh.status, n.title, n.record_type, n.record_id, /TEST-REG-02 \(Honda Fit\) for Test Customer Alpha/.test(n.message)], [201, 'New vehicle registered', 'vehicle', veh.body.data.id, true]);

  const apt = await h.api('POST', '/api/appointments', { customerId: 'CUS-0001', vehicleId: 'VEH-0001', serviceId: 'SRV-0001', mechanicId: 'MEC-0001', date: day(3), time: '10:00', duration: 60, source: 'Phone' });
  n = h.last();
  check('creating an appointment: Appointment, "New appointment"', [apt.status, n.category, n.title, n.record_id], [201, 'Appointment', 'New appointment', apt.body.data.id]);
  ok_('   ...with customer, vehicle, date and time', n.message.includes('Test Customer Alpha — TEST-REG-01 (Toyota Axio)') && n.message.includes(`${day(3)} at 10:00`), n.message);

  const upd = await h.api('PUT', `/api/appointments/${apt.body.data.id}`, { time: '11:30', expectedUpdatedAt: apt.body.data.updatedAt ?? null });
  n = h.last();
  check('changing an appointment: "Appointment updated"', [upd.status, n.title, n.event_type], [200, 'Appointment updated', 'appointment.updated']);
  const cancelled = await h.api('PUT', `/api/appointments/${apt.body.data.id}`, { status: 'Cancelled', expectedUpdatedAt: upd.body.data.updatedAt });
  n = h.last();
  check('cancelling it: "Appointment cancelled", important', [cancelled.status, n.title, n.priority], [200, 'Appointment cancelled', 'important']);
  const before = h.count();
  await h.api('PUT', `/api/appointments/${apt.body.data.id}`, { notes: 'Called back', expectedUpdatedAt: cancelled.body.data.updatedAt });
  check('   ...editing the cancelled appointment again is not a second cancellation', h.count(), before);

  const missing = await h.api('PUT', '/api/appointments/APT-9999', { time: '09:00' });
  check('a refused change (404) raises nothing', [missing.status, h.count()], [404, before]);
  const bad = await h.api('POST', '/api/customers', { name: '' });
  check('an invalid create (422) raises nothing', [bad.status, h.count()], [422, before]);

  const job = await h.api('POST', '/api/job-cards', { customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: day(0), complaint: 'Test complaint',
    services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 1, unitPrice: 1000 }] });
  n = h.last();
  check('creating a job card: Workshop, "Job card created"', [job.status, n.category, n.title, n.record_type, n.record_id], [201, 'Workshop', 'Job card created', 'job_card', job.body.data.id]);
  const insp = await h.api('POST', `/api/job-cards/${job.body.data.id}/status`, { status: 'Inspection' });
  check('a job card status change: "Job card: Inspection"', [insp.status, h.last().title, h.last().event_type], [200, 'Job card: Inspection', 'job_card.status']);
  const wrong = await h.api('POST', `/api/job-cards/${job.body.data.id}/status`, { status: 'Delivered' });
  check('   ...a refused transition (409) raises nothing', [wrong.status, h.last().title], [409, 'Job card: Inspection']);
  const st = await h.api('POST', `/api/job-cards/${job.body.data.id}/status`, { status: 'In Progress' });
  n = h.last();
  check('   ...and the next one: "Job card: In Progress"', [st.status, n.title, n.event_type], [200, 'Job card: In Progress', 'job_card.status']);
  const done = await h.api('POST', `/api/job-cards/${job.body.data.id}/status`, { status: 'Completed' });
  n = h.last();
  check('completing it: "Job card completed"', [done.status, n.title], [200, 'Job card completed']);

  const inv = await h.api('POST', '/api/invoices', { jobCardId: job.body.data.id });
  n = h.last();
  check('creating an invoice with a balance: Finance, "Invoice created — payment due"', [inv.status, n.category, n.title, n.record_type], [201, 'Finance', 'Invoice created — payment due', 'invoice']);
  ok_('   ...stating the total and balance due', /total ৳ 1,000, balance due ৳ 1,000\./.test(n.message), n.message);
  const pay = await h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId: inv.body.data.id, amount: 400, method: 'Cash' });
  n = h.last();
  check('recording a payment: Finance, "Payment received"', [pay.status, n.title, n.record_type, n.record_id], [201, 'Payment received', 'payment', pay.body.data.id]);
  ok_('   ...with amount, method, customer and invoice', n.message === `৳ 400 (Cash) from Test Customer Alpha for ${inv.body.data.id}.`, n.message);

  const est = await h.api('POST', '/api/estimates', { customerId: 'CUS-0001', vehicleId: 'VEH-0001', complaint: 'Test estimate',
    services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 1, unitPrice: 1500 }], createdBy: 'Desk', idempotencyKey: 'test-notify-estimate-0001' });
  n = h.last();
  check('creating an estimate: Finance, "Estimate created"', [est.status, n.title, n.record_type, n.record_id], [201, 'Estimate created', 'estimate', est.body.data?.id]);
  const estAgain = await h.api('POST', '/api/estimates', { customerId: 'CUS-0001', vehicleId: 'VEH-0001', complaint: 'Test estimate',
    services: [{ serviceId: 'SRV-0001', name: 'Test Service', qty: 1, unitPrice: 1500 }], createdBy: 'Desk', idempotencyKey: 'test-notify-estimate-0001' });
  check('   ...a retried create (same idempotency key) adds no second notification',
    [estAgain.body.data?.id, h.all("SELECT count(*) AS n FROM notifications WHERE event_type = 'estimate.created'")[0].n], [est.body.data?.id, 1]);

  const leave = await h.api('POST', '/api/leave-requests', { staffId: 'STF-0001', leaveType: 'Casual', startDate: day(5), endDate: day(6), reason: 'Test reason' });
  n = h.last();
  check('a leave request: Staff, "Leave request submitted", for everyone', [leave.status, n.category, n.title, n.recipient_account_id], [201, 'Staff', 'Leave request submitted', null]);
  const nadia = await h.accountCookie('STF-0001', 'testnadia');
  const nadiaId = h.one("SELECT id FROM user_accounts WHERE username = 'testnadia'").id;
  const dec = await h.api('POST', `/api/leave-requests/${leave.body.data.id}/approve`, { expectedUpdatedAt: leave.body.data.updatedAt });
  n = h.last();
  check('approving it: a personal notification for the staff member\'s own account',
    [dec.status, n.title, n.recipient_account_id, n.record_id], [200, 'Your leave request was approved', nadiaId, leave.body.data.id]);
  const leave2 = await h.api('POST', '/api/leave-requests', { staffId: 'STF-0002', leaveType: 'Casual', startDate: day(5), endDate: day(5), reason: 'Test reason' });
  const c2 = h.count();
  await h.api('POST', `/api/leave-requests/${leave2.body.data.id}/reject`, { expectedUpdatedAt: leave2.body.data.updatedAt, note: 'Busy week' });
  check('   ...a decision for staff without an account raises nothing (no one to tell)', h.count(), c2);
  h.DB.raw.exec(`INSERT INTO staff (id, mechanic_id, designation, department, created_at) VALUES ('MEC-0001', 'MEC-0001', 'Mechanic', 'Workshop', '${AT}')`);
  await h.api('POST', '/api/accounts', { staffId: 'MEC-0001', username: 'testmech', role: 'Administrator', password: PW });
  const mechId = h.one("SELECT id FROM user_accounts WHERE username = 'testmech'").id;
  const leave3 = await h.api('POST', '/api/leave-requests', { staffId: 'MEC-0001', leaveType: 'Sick', startDate: day(7), endDate: day(7), reason: 'Test reason' });
  await h.api('POST', `/api/leave-requests/${leave3.body.data.id}/reject`, { expectedUpdatedAt: leave3.body.data.updatedAt, note: 'Test note' });
  check('   ...a mechanic\'s decision reaches the account linked to that mechanic',
    [leave3.status, h.last().title, h.last().recipient_account_id], [201, 'Your leave request was rejected', mechId]);
  ok_('   ...the recipient sees it', ((await h.api('GET', N, undefined, nadia)).body.data || []).some((x) => x.title === 'Your leave request was approved'));

  // Website enquiry: the public form, through the real (unchanged) handler.
  const site = (body) => h.api('POST', '/api/forms/submit', body, 'none', { headers: { origin: 'https://taqwa.autos', 'cf-connecting-ip': '203.0.113.7' } });
  const form = { formType: 'booking', name: 'Test Visitor', phone: '+880 1700-000009', service: 'AC Service', preferredDate: day(2), preferredTime: '10:30',
    startedAt: Date.now() - 60000, company: '' };
  const sub = await site(form);
  n = h.last();
  check('a website enquiry: Enquiry, "New website enquiry", linked to it', [sub.status, n.category, n.title, n.record_type, n.record_id], [201, 'Enquiry', 'New website enquiry', 'website_form', sub.body.data.reference]);
  ok_('   ...naming the visitor, service and preferred time; no actor (it is public)', /Test Visitor sent a booking for AC Service, preferred .* at 10:30/.test(n.message) && n.actor_name === null, n.message);
  const c3 = h.count();
  const dup = await site(form);
  check('   ...the same enquiry sent again (the form answers "duplicate") raises nothing', [dup.status, dup.body.data.duplicate, h.count()], [200, true, c3]);
  const spam = await site({ ...form, phone: '+880 1700-000010', company: 'bot' });
  check('   ...a honeypot submission raises nothing', [spam.status, h.count()], [201, c3]);

  const unrelated = await h.api('POST', '/api/expenses', { date: day(0), category: 'Utilities', amount: 100, description: 'Test expense', method: 'Cash' });
  check('a route with no event (an expense) raises nothing', [unrelated.status < 300, h.count()], [true, c3]);

  const types = h.all('SELECT event_key, count(*) AS n FROM notifications GROUP BY event_key HAVING n > 1');
  check('no event key appears twice', types, []);
}

/* ---------- C2. without an execution context ---------- */
{
  const h = fresh();
  const res = await worker.fetch(new Request('http://worker.local/api/customers', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test No Ctx', phone: '01700000003' }),
  }), h.env);
  check('a direct router call with no ctx saves the record and records nothing (the runtime always passes ctx)', [res.status, h.count()], [201, 0]);
}

/* ---------- D. time-based ---------- */
console.log('\n-- D. time-based --');
{
  const h = fresh();
  h.DB.raw.exec(`
    INSERT INTO follow_ups (id, customer_id, reason, priority, due_date, status, idempotency_key, idempotency_fingerprint, created_at, updated_at) VALUES
      ('FUP-0001', 'CUS-0001', 'Test overdue follow-up', 'normal', '${day(-2)}', 'Open', 'k-notify-test-0001', '${FP}', '${AT}', '${AT}'),
      ('FUP-0002', 'CUS-0001', 'Test due today', 'normal', '${day(0)}', 'Open', 'k-notify-test-0002', '${FP}', '${AT}', '${AT}'),
      ('FUP-0003', 'CUS-0001', 'Test future', 'normal', '${day(3)}', 'Open', 'k-notify-test-0003', '${FP}', '${AT}', '${AT}');
    INSERT INTO follow_ups (id, customer_id, reason, priority, due_date, status, closed_at, close_note, idempotency_key, idempotency_fingerprint, created_at, updated_at) VALUES
      ('FUP-0004', 'CUS-0001', 'Test closed', 'normal', '${day(-5)}', 'Completed', '${AT}', NULL, 'k-notify-test-0004', '${FP}', '${AT}', '${AT}');
    INSERT INTO follow_up_tasks (id, title, priority, due_date, status, idempotency_key, idempotency_fingerprint, created_at, updated_at) VALUES
      ('TSK-0001', 'Test call back', 'urgent', '${day(0)}', 'Pending', 'k-notify-task-0001', '${FP}', '${AT}', '${AT}'),
      ('TSK-0002', 'Test later task', 'low', '${day(4)}', 'Pending', 'k-notify-task-0002', '${FP}', '${AT}', '${AT}');
    INSERT INTO parts (id, name, stock, min_stock, status, created_at) VALUES
      ('PRT-0001', 'Test Oil Filter', 2, 5, 'Active', '${AT}'),
      ('PRT-0002', 'Test Brake Pad', 0, 2, 'Active', '${AT}'),
      ('PRT-0003', 'Test Plenty', 50, 5, 'Active', '${AT}'),
      ('PRT-0004', 'Test No Minimum', 0, 0, 'Active', '${AT}'),
      ('PRT-0005', 'Test Inactive Low', 0, 5, 'Inactive', '${AT}');
    UPDATE id_counters SET last_value = 5 WHERE collection = 'parts';`);
  const res = await h.api('GET', `${N}?refresh=1&limit=100`);
  const keys = h.all('SELECT event_key, title, priority FROM notifications ORDER BY event_key');
  check('one notification per condition: overdue + due-today follow-ups, the due task, low and out-of-stock parts', keys.map((k) => [k.event_key.split(':').slice(0, 2).join(':'), k.title, k.priority]), [
    ['follow_up.due:FUP-0001', 'Follow-up overdue', 'important'],
    ['follow_up.due:FUP-0002', 'Follow-up due today', 'normal'],
    ['follow_up_task.due:TSK-0001', 'Task due today', 'important'],
    ['part.low_stock:PRT-0001', 'Low stock', 'important'],
    ['part.low_stock:PRT-0002', 'Out of stock', 'important'],
  ]);
  check('   ...and the list shows them', res.body.total, 5);
  ok_('   ...a future follow-up, a closed one, a later task, a well-stocked part, one with no minimum and an inactive one raise nothing',
    !keys.some((k) => /FUP-0003|FUP-0004|TSK-0002|PRT-0003|PRT-0004|PRT-0005/.test(k.event_key)));
  const again = await sweepNotifications(h.env, { force: true });
  check('a second sweep adds nothing (no duplicates)', [again, h.count()], [0, 5]);
  check('a sweep within a minute is skipped', await sweepNotifications(h.env), null);
  const move = await h.api('POST', '/api/inventory-transactions', { partId: 'PRT-0001', type: 'adjustment-out', quantity: 1, reason: 'Test adjustment' });
  await h.api('GET', `${N}?refresh=1`);
  check('a new stock movement on a part that is still low raises a new low-stock notification',
    [move.status, h.one("SELECT count(*) AS n FROM notifications WHERE event_type = 'part.low_stock' AND record_id = 'PRT-0001'").n], [201, 2]);
  h.DB.raw.exec(`UPDATE follow_ups SET due_date = '${day(0)}' WHERE id = 'FUP-0003'`);
  await h.api('GET', `${N}?refresh=1`);
  check('a follow-up that falls due raises its own', h.one("SELECT count(*) AS n FROM notifications WHERE record_id = 'FUP-0003'").n, 1);
}

/* ---------- E. API ---------- */
console.log('\n-- E. API --');
{
  const h = fresh();
  const rows = [
    ['customer.created:T1', 'customer.created', 'Customer', 'normal', 'Alpha customer added', 'Test alpha', 'customer', 'CUS-0001'],
    ['invoice.created:T2', 'invoice.created', 'Finance', 'normal', 'Invoice created', 'INV-TEST 50% due', 'invoice', 'INV-0042'],
    ['part.low_stock:T3', 'part.low_stock', 'Inventory', 'important', 'Low stock', 'Test filter', 'part', 'PRT-0007'],
    ['appointment.created:T4', 'appointment.created', 'Appointment', 'normal', 'New appointment', 'Test beta', 'appointment', 'APT-0003'],
  ];
  for (const r of rows) {
    h.DB.raw.prepare('INSERT INTO notifications (event_key, event_type, category, priority, title, message, record_type, record_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(...r, AT);
  }
  const list = await h.api('GET', N);
  check('list: 200, newest first, the agreed shape', [list.status, list.body.data.map((n) => n.title), Object.keys(list.body.data[0])], [200,
    ['New appointment', 'Low stock', 'Invoice created', 'Alpha customer added'],
    ['id', 'type', 'category', 'priority', 'title', 'message', 'recordType', 'recordId', 'personal', 'actorName', 'createdAt', 'read', 'readAt']]);
  check('   ...with paging and a summary', [list.body.total, list.body.limit, list.body.offset, list.body.summary],
    [4, 25, 0, { total: 4, unread: 4, important: 1, latestId: 4 }]);
  check('unread-count: for polling', (await h.api('GET', `${N}/unread-count`)).body.data, { total: 4, unread: 4, important: 1, latestId: 4 });

  const r1 = await h.api('POST', `${N}/2/read`);
  check('mark one read: the notification comes back read, the summary drops', [r1.status, r1.body.data.read, typeof r1.body.data.readAt, r1.body.summary.unread], [200, true, 'string', 3]);
  check('   ...marking it read again changes nothing', [(await h.api('POST', `${N}/2/read`)).status, h.one('SELECT count(*) AS n FROM notification_reads').n], [200, 1]);
  const titles = async (q) => ((await h.api('GET', `${N}${q}`)).body.data || []).map((n) => n.title);
  check('Unread filter', await titles('?status=unread'), ['New appointment', 'Low stock', 'Alpha customer added']);
  check('Read filter', await titles('?status=read'), ['Invoice created']);
  check('category filter', await titles('?category=Inventory'), ['Low stock']);
  check('search: title, message and record id, case-insensitive', [await titles('?q=ALPHA'), await titles('?q=apt-0003'), await titles('?q=50%25')],
    [['Alpha customer added'], ['New appointment'], ['Invoice created']]);
  check('search treats % and _ literally', await titles('?q=_'), []);
  check('filters combine', await titles('?status=unread&category=Customer&q=alpha'), ['Alpha customer added']);
  const p1 = await h.api('GET', `${N}?limit=2`);
  const p2 = await h.api('GET', `${N}?limit=2&offset=2`);
  check('paging: two pages of two, nothing repeated or missed', [p1.body.data.map((n) => n.id), p2.body.data.map((n) => n.id), p1.body.total], [[4, 3], [2, 1], 4]);
  const u = await h.api('POST', `${N}/2/unread`);
  check('mark unread', [u.status, u.body.data.read, u.body.summary.unread], [200, false, 4]);

  const pass = (await h.api('POST', '/api/session', { passphrase: PASSPHRASE }, 'none')).cookie;
  await h.api('POST', `${N}/1/read`, undefined, pass);
  check('read state is per reader: the passphrase reading one does not change the token\'s count',
    [(await h.api('GET', `${N}/unread-count`, undefined, pass)).body.data.unread, (await h.api('GET', `${N}/unread-count`)).body.data.unread], [3, 4]);

  h.DB.raw.prepare('INSERT INTO notifications (event_key, event_type, category, title, message, created_at) VALUES (?,?,?,?,?,?)').run('late:5', 'customer.created', 'Customer', 'Arrived later', 'x', AT);
  const all = await h.api('POST', `${N}/read-all`, { upToId: 4 });
  check('mark all read up to the newest one seen: the later arrival stays unread', [all.status, all.body.data.marked, all.body.summary.unread], [200, 4, 1]);
  const all2 = await h.api('POST', `${N}/read-all`);
  check('mark all read with no body: everything', [all2.status, all2.body.data.marked, all2.body.summary.unread], [200, 1, 0]);

  const bad = [
    await h.api('GET', `${N}?status=new`), await h.api('GET', `${N}?category=Spam`), await h.api('GET', `${N}?limit=0`),
    await h.api('GET', `${N}?limit=101`), await h.api('GET', `${N}?offset=-1`), await h.api('GET', `${N}?q=${'x'.repeat(101)}`),
    await h.api('GET', `${N}?refresh=yes`), await h.api('POST', `${N}/abc/read`), await h.api('POST', `${N}/0/read`),
    await h.api('POST', `${N}/read-all`, '{oops'), await h.api('POST', `${N}/read-all`, '[1]'),
  ];
  check('invalid input is 400 with a plain message', bad.map((r) => r.status), [400, 400, 400, 400, 400, 400, 400, 400, 400, 400, 400]);
  check('   ...an invalid upToId is 422 naming the field', [(await h.api('POST', `${N}/read-all`, { upToId: -3 })).status, (await h.api('POST', `${N}/read-all`, { upToId: 'x' })).body.error.fields], [422, { upToId: '`upToId` must be a positive whole number.' }]);
  check('an unknown notification is 404', (await h.api('POST', `${N}/999/read`)).status, 404);
  check('wrong methods are 405', [(await h.api('POST', N)).status, (await h.api('DELETE', `${N}/1/read`)).status, (await h.api('GET', `${N}/read-all`)).status, (await h.api('PUT', `${N}/unread-count`)).status], [405, 405, 405, 405]);
  check('an unknown path is 404', (await h.api('GET', `${N}/1/2/3`)).status, 404);
  check('there is no create, edit or delete of a notification through the API: no rows were added or removed', h.count(), 5);
}

/* ---------- F. failures ---------- */
console.log('\n-- F. failures --');
{
  const h = fresh();
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    h.DB.broken = /FROM notifications n/;
    const list = await h.api('GET', N);
    check('a database failure on the list is a 503 with a plain message', [list.status, list.body.error.code, list.body.error.message],
      [503, 'notifications_unavailable', 'Notifications could not be loaded right now.']);
    check('   ...as is the unread count', (await h.api('GET', `${N}/unread-count`)).status, 503);
    h.DB.broken = /INSERT OR IGNORE INTO notifications/;
    const cust = await h.api('POST', '/api/customers', { name: 'Test Customer Gamma', phone: '01700000004' });
    check('a failing notification write never fails the CRM request: the customer is saved (201)',
      [cust.status, !!h.one('SELECT id FROM customers WHERE id = ?', cust.body.data.id), h.count()], [201, true, 0]);
    ok_('   ...and the failure is logged without any customer detail', errors.some((e) => /notifications: not recorded for customers create/.test(e)) && !errors.some((e) => /Gamma|01700000004/.test(e)), errors.join(' | '));
    h.DB.broken = /follow_ups f/;
    const swept = await h.api('GET', `${N}?refresh=1`);
    check('a failing sweep does not stop the list from loading', swept.status, 200);
  } finally {
    console.error = orig;
    h.DB.broken = null;
  }
}

console.log(`\nNotifications unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
