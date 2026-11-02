/* POST /api/invoice-adjustments and POST /api/invoice-adjustments/:id/void
   (write-offs, 0002) — unit tests against the REAL Worker handlers.

   Part A stubs D1 and looks at what would be sent, because a write-off's
   safety lives in its SQL:

     - nothing financial comes from the client: customer, date, due_before
       and due_after are derived, and naming them is refused;
     - the checks (not Void, the due the user saw, amount <= due, cash +
       write-offs + amount <= total) are the INSERT's own WHERE clause;
     - the write-off and the invoice's new balance are one batch, and the
       recompute is conditional on the write-off having landed;
     - nothing touches a job card or a payment;
     - a refused write explains itself, and only then reads the balance.

   Part B runs the same handlers against an in-memory SQLite database built
   from the real migrations, through a minimal D1-shaped wrapper, to show
   the guards behave as the SQL says. Real D1 -- its batch transaction and
   concurrent requests -- is the integration suite's job (section 24).
   Part B needs node:sqlite (Node 22.5+) and says SKIPPED without it. */
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

const ADJ_ROW = {
  id: 'ADJ-0001', invoice_id: 'INV-0001', customer_id: 'CUS-0001', type: 'write_off',
  amount: 1000, reason: 'Customer concession', date: '2026-10-08',
  due_before: 1000, due_after: 0, status: 'Active', recorded_by: null,
  void_reason: null, voided_at: null, created_at: '2026-10-08T09:00:00.000Z', updated_at: null,
};
const BALANCE = { id: 'INV-0001', customer_id: 'CUS-0001', status: 'Partial', total: 3000, pay_sum: 2000, adj_sum: 0, due: 1000 };
const VOID_LOOKUP = { id: 'ADJ-0001', status: 'Active', invoice_id: 'INV-0001', invoice_status: 'Partial' };

/**
 * `balance`  what the refusal lookup (liveBalance) finds, or null.
 * `lookup`   what the void handler's pre-read finds, or null for a 404.
 * `changes`  meta.changes per batch statement; [0] is the primary mutation.
 */
function stubDB({ balance = BALANCE, lookup = VOID_LOOKUP, row = ADJ_ROW, changes = null, throwOnBatch = null } = {}) {
  const calls = [];
  const batches = [];
  const db = {
    calls, batches,
    get sql() { return calls.map((c) => c.sql).join('\n'); },
    find(fragment) { return calls.find((c) => c.sql.includes(fragment)); },
    prepare(sql) {
      const entry = { sql, binds: null };
      // The router logs each successful write for offline sync (0020, lib/changes.js)
      // AFTER it commits; these assertions are about the route's own statements.
      if (!/INSERT INTO change_log/.test(sql)) calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('sqlite_master')) return { n: 0 };
          if (sql.includes('id_counters')) return { last_value: 1, prefix: 'ADJ' };
          if (sql.includes('AS due')) return balance;
          if (sql.includes('LEFT JOIN invoices')) return lookup;
          if (sql.includes('count(*)')) return { n: row ? 1 : 0 };
          if (sql.includes('FROM invoice_adjustments')) return row;
          return null;
        },
        async all() {
          if (sql.includes('sqlite_master')) return { results: [{ name: 'customers' }] };
          if (sql.includes('FROM invoice_adjustments')) return { results: row ? [row] : [] };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(statements) {
      batches.push(statements);
      if (throwOnBatch) throw new Error(throwOnBatch);
      return statements.map((_, i) => ({ success: true, meta: { changes: changes?.[i] ?? 1 } }));
    },
  };
  return db;
}

const TEST_TOKEN = 'unit-test-token';
const call = (path, env, method, body) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });
const post = (body, db) => call('/api/invoice-adjustments', { DB: db ?? stubDB() }, 'POST', body);
const voidIt = (body, db, id = 'ADJ-0001') =>
  call(`/api/invoice-adjustments/${id}/void`, { DB: db ?? stubDB() }, 'POST', body);

const GOOD = { invoiceId: 'INV-0001', amount: 1000, reason: 'Customer concession', expectedDue: 1000 };

/* ============================================================
   A1. Validation
   ============================================================ */
console.log('\n=== A. POST /api/invoice-adjustments (stubbed D1) ===');
console.log('\n-- A1. Validation --');
{
  const db = stubDB();
  const res = await post({}, db);
  const b = await res.json();
  check('an empty body -> 422', res.status, 422);
  check('   ...naming the four required fields',
    Object.keys(b.error?.fields ?? {}).sort(), ['amount', 'expectedDue', 'invoiceId', 'reason']);
  ok_('   ...and nothing reaches the database (no id is used up)', !db.find('id_counters') && db.batches.length === 0, db.sql);
}
for (const [label, amount] of [['zero', 0], ['negative', -5], ['text', 'abc'], ['Infinity', 'Infinity']]) {
  const res = await post({ ...GOOD, amount });
  const b = await res.json();
  ok_(`amount ${label} -> 422 on amount`, res.status === 422 && !!b.error?.fields?.amount, JSON.stringify(b));
}
{
  const res = await post({ ...GOOD, reason: '   ' });
  ok_('a blank reason -> 422', res.status === 422 && !!(await res.json()).error?.fields?.reason);
}
{
  const res = await post({ ...GOOD, reason: 'x'.repeat(501) });
  ok_('a reason over 500 characters -> 422', res.status === 422);
}
{
  const res = await post({ ...GOOD, expectedDue: -1 });
  ok_('a negative expectedDue -> 422', res.status === 422 && !!(await res.json()).error?.fields?.expectedDue);
}
{
  const res = await post({ ...GOOD, type: 'discount' });
  ok_('a type other than write_off -> 422', res.status === 422 && !!(await res.json()).error?.fields?.type);
}
{
  const res = await post({ ...GOOD, recordedBy: 'x'.repeat(101) });
  ok_('recordedBy over 100 characters -> 422', res.status === 422 && !!(await res.json()).error?.fields?.recordedBy);
}
for (const field of ['id', 'customerId', 'status', 'dueBefore', 'dueAfter', 'voidReason', 'voidedAt', 'createdAt', 'updatedAt', 'date']) {
  const db = stubDB();
  const res = await post({ ...GOOD, [field]: field === 'date' ? '2026-01-01' : 'X' }, db);
  const b = await res.json();
  ok_(`\`${field}\` is server-owned and refused by name`,
    res.status === 422 && !!b.error?.fields?.[field] && db.batches.length === 0, JSON.stringify(b));
}
{
  const res = await post('{not json');
  check('a body that is not JSON -> 400', res.status, 400);
}

/* ============================================================
   A2. The write
   ============================================================ */
console.log('\n-- A2. The write is one guarded batch --');
{
  const db = stubDB();
  const res = await post({ ...GOOD, recordedBy: '  Rahim  ' }, db);
  const b = await res.json();
  check('a valid write-off -> 201', res.status, 201);
  check('   ...returns the record as a GET would', Object.keys(b.data ?? {}),
    ['id', 'invoiceId', 'customerId', 'type', 'amount', 'reason', 'date', 'dueBefore', 'dueAfter',
      'status', 'recordedBy', 'voidReason', 'voidedAt', 'createdAt']);
  check('allocates from the invoiceAdjustments counter', db.find('id_counters')?.binds, ['invoiceAdjustments']);
  check('exactly one batch', db.batches.length, 1);
  check('   ...of two statements: the write-off, then the balance', db.batches[0].length, 2);

  const ins = db.find('INSERT INTO invoice_adjustments');
  ok_('the insert is INSERT ... SELECT, so it writes nothing unless the guard holds',
    /INSERT INTO invoice_adjustments[\s\S]*SELECT[\s\S]*WHERE/.test(ins.sql), ins.sql);
  ok_('   ...guard: the invoice is not Void', /l\.status <> 'Void'/.test(ins.sql), ins.sql);
  ok_('   ...guard: the due the user saw is still the due', /ABS\(l\.due - \?9\) < 0\.005/.test(ins.sql), ins.sql);
  ok_('   ...guard: the amount is no more than the due', /\?4 <= l\.due/.test(ins.sql), ins.sql);
  ok_('   ...guard: cash + write-offs + this one stay within the total',
    /l\.pay_sum \+ l\.adj_sum \+ \?4 <= l\.total/.test(ins.sql), ins.sql);
  ok_('   ...the balance it checks counts only Active payments and write-offs',
    (ins.sql.match(/status <> 'Void'/g) ?? []).length >= 3, ins.sql);
  ok_('   ...customer, due_before and due_after come from the invoice row, not the body',
    /SELECT \?1, l\.id, l\.customer_id, \?3, \?4, \?5, \?6,\s*l\.due, l\.due - \?4, 'Active'/.test(ins.sql), ins.sql);
  const [id, invoiceId, type, amount, reason, date, recordedBy, createdAt, expectedDue] = ins.binds;
  check('   ...binds id, invoice, type, amount, reason', [id, invoiceId, type, amount, reason],
    ['ADJ-0001', 'INV-0001', 'write_off', 1000, 'Customer concession']);
  ok_('   ...the date is today in Dhaka, set by the server', /^\d{4}-\d{2}-\d{2}$/.test(date), String(date));
  check('   ...recordedBy is trimmed', recordedBy, 'Rahim');
  ok_('   ...createdAt is a timestamp', /T.*Z$/.test(createdAt), String(createdAt));
  check('   ...expectedDue is bound for the stale check', expectedDue, 1000);

  const rec = db.find('UPDATE invoices');
  ok_('the balance is recomputed by one UPDATE on invoices', !!rec, db.sql);
  ok_('   ...only if this write-off now exists', /EXISTS \(SELECT 1 FROM invoice_adjustments WHERE id = \?3\)/.test(rec.sql), rec.sql);
  check('   ...binding the invoice, the time and the write-off id', [rec.binds[0], rec.binds[2]], ['INV-0001', 'ADJ-0001']);
  ok_('   ...writes written_off as well as paid, due and status',
    /written_off\s*=/.test(rec.sql) && /paid\s*=/.test(rec.sql) && /due\s*=/.test(rec.sql) && /status\s*=/.test(rec.sql), rec.sql);
  ok_('   ...and never touches a Void invoice', /AND status <> 'Void'/.test(rec.sql), rec.sql);
  ok_('no statement names job_cards', !/job_cards/.test(db.sql), db.sql);
  ok_('no statement writes payments', !/(INSERT INTO|UPDATE|DELETE FROM) payments/.test(db.sql), db.sql);
  ok_('the happy path does not read the balance separately', !db.find('AS due') || db.find('AS due') === ins, db.sql);
}
{
  const db = stubDB();
  await post(GOOD, db);
  check('recordedBy left out is stored as null', db.find('INSERT INTO invoice_adjustments').binds[6], null);
}
{
  const db = stubDB();
  await post({ ...GOOD, amount: '250', expectedDue: '1000' }, db);
  check('numeric strings are read as numbers', db.find('INSERT INTO invoice_adjustments').binds.filter((x) => typeof x === 'number'), [250, 1000]);
}

/* ============================================================
   A3. Refusals explain themselves
   ============================================================ */
console.log('\n-- A3. A refused write-off says why --');
async function refused(balance, body = GOOD) {
  const db = stubDB({ balance, changes: [0, 0] });
  const res = await post(body, db);
  return { res, b: await res.json(), db };
}
{
  const { res, b } = await refused(null);
  ok_('invoice gone -> 409 invoice_not_found', res.status === 409 && b.error?.reason === 'invoice_not_found', JSON.stringify(b));
}
{
  const { res, b } = await refused({ ...BALANCE, status: 'Void' });
  ok_('Void invoice -> 409 invoice_void', res.status === 409 && b.error?.reason === 'invoice_void', JSON.stringify(b));
}
{
  const { res, b } = await refused({ ...BALANCE, adj_sum: 400, due: 600 });
  ok_('balance moved -> 409 stale_balance', res.status === 409 && b.error?.reason === 'stale_balance', JSON.stringify(b));
  check('   ...with the current and the expected due', [b.error?.currentDue, b.error?.expectedDue], [600, 1000]);
}
{
  const { res, b } = await refused(BALANCE, { ...GOOD, amount: 1001 });
  ok_('more than the due -> 409 over_adjustment', res.status === 409 && b.error?.reason === 'over_adjustment', JSON.stringify(b));
  check('   ...naming the outstanding due', b.error?.outstandingDue, 1000);
}
{
  const { res, b } = await refused(BALANCE);
  ok_('everything checks out yet nothing was written -> 409 concurrent_modification',
    res.status === 409 && b.error?.reason === 'concurrent_modification', JSON.stringify(b));
}
{
  const { db } = await refused(BALANCE);
  ok_('a refusal reads the live balance once', db.calls.filter((c) => c.sql.includes('AS due') && !c.sql.includes('INSERT')).length === 1, db.sql);
}
{
  const db = stubDB({ throwOnBatch: 'CHECK constraint failed: due_after >= 0' });
  const res = await post(GOOD, db);
  check('a CHECK failure from D1 -> 422, not 500', res.status, 422);
}
{
  const db = stubDB({ throwOnBatch: 'disk I/O error' });
  const res = await post(GOOD, db);
  const b = await res.json();
  ok_('any other D1 failure -> 500 database_error, detail not leaked',
    res.status === 500 && b.error?.code === 'database_error' && !JSON.stringify(b).includes('disk'), JSON.stringify(b));
}

/* ============================================================
   A4. Reversal (void)
   ============================================================ */
console.log('\n=== A4. POST /api/invoice-adjustments/:id/void ===');
{
  const db = stubDB();
  const res = await voidIt({ voidReason: 'Customer will pay after all' }, db);
  const b = await res.json();
  check('a reversal -> 200', res.status, 200);
  ok_('   ...returns the record', b.data?.id === 'ADJ-0001', JSON.stringify(b));
  check('one batch of two statements', [db.batches.length, db.batches[0]?.length], [1, 2]);
  const gate = db.find('UPDATE invoice_adjustments');
  ok_('the gate only moves an Active write-off', /AND status = 'Active'/.test(gate.sql), gate.sql);
  ok_('   ...and only on an invoice that is not Void',
    /\(SELECT status FROM invoices WHERE id = invoice_adjustments\.invoice_id\) <> 'Void'/.test(gate.sql), gate.sql);
  ok_('   ...setting status, reason and time, and nothing else',
    /SET status = 'Void', void_reason = \?2, voided_at = \?3, updated_at = \?3\s/.test(gate.sql), gate.sql);
  ok_('   ...the amount, reason and snapshots are left as recorded', !/SET[\s\S]*(amount|reason =|due_before|due_after)\s*=/.test(gate.sql.replace('void_reason', '')), gate.sql);
  const rec = db.find('UPDATE invoices');
  ok_('the invoice is recomputed only if the write-off is now Void',
    /\(SELECT status FROM invoice_adjustments WHERE id = \?3\) = 'Void'/.test(rec.sql), rec.sql);
  ok_('no DELETE anywhere', !/DELETE/i.test(db.sql), db.sql);
}
{
  const res = await voidIt({});
  ok_('no voidReason -> 422', res.status === 422 && !!(await res.json()).error?.fields?.voidReason);
}
{
  const res = await voidIt({ voidReason: '   ' });
  check('a blank voidReason -> 422', res.status, 422);
}
{
  const res = await voidIt({ voidReason: 'x', amount: 5 });
  const b = await res.json();
  ok_('any other field in the body -> 422 naming it', res.status === 422 && !!b.error?.fields?.amount, JSON.stringify(b));
}
{
  const res = await voidIt({ voidReason: 'x' }, stubDB({ lookup: null }));
  check('an unknown write-off -> 404', res.status, 404);
}
{
  const res = await voidIt({ voidReason: 'x' }, stubDB({ lookup: { ...VOID_LOOKUP, status: 'Void' } }));
  const b = await res.json();
  ok_('an already-reversed write-off -> 409 adjustment_void', res.status === 409 && b.error?.reason === 'adjustment_void', JSON.stringify(b));
}
{
  const db = stubDB({ lookup: { ...VOID_LOOKUP, invoice_status: 'Void' } });
  const res = await voidIt({ voidReason: 'x' }, db);
  const b = await res.json();
  ok_('a write-off on a Void invoice is frozen -> 409 invoice_void', res.status === 409 && b.error?.reason === 'invoice_void', JSON.stringify(b));
  check('   ...and nothing is written', db.batches.length, 0);
}
{
  const res = await voidIt({ voidReason: 'x' }, stubDB({ changes: [0, 0] }));
  const b = await res.json();
  ok_('the gate matched nothing -> 409 concurrent_modification', res.status === 409 && b.error?.reason === 'concurrent_modification', JSON.stringify(b));
}
{
  const res = await voidIt({ voidReason: 'x' }, undefined, 'not an id!');
  check('a malformed id -> 400', res.status, 400);
}

/* ============================================================
   A5. Routing and reads
   ============================================================ */
console.log('\n=== A5. Routing and reads ===');
{
  const put = await call('/api/invoice-adjustments/ADJ-0001', { DB: stubDB() }, 'PUT', { amount: 1 });
  const del = await call('/api/invoice-adjustments/ADJ-0001', { DB: stubDB() }, 'DELETE');
  check('a write-off cannot be edited (PUT -> 405)', put.status, 405);
  check('   ...or deleted (DELETE -> 405)', del.status, 405);
  const getVoid = await call('/api/invoice-adjustments/ADJ-0001/void', { DB: stubDB() }, 'GET');
  check('the void action is POST only', getVoid.status, 405);
}
{
  const res = await call('/api/invoice-adjustments/ADJ-0001', { DB: stubDB() }, 'GET');
  const b = await res.json();
  check('GET /:id -> 200', res.status, 200);
  check('   ...null recorded_by and void_reason read as empty strings', [b.data?.recordedBy, b.data?.voidReason, b.data?.voidedAt], ['', '', null]);
  ok_('   ...and no updatedAt until it changes', !('updatedAt' in (b.data ?? {})), JSON.stringify(b));
}
{
  const res = await call('/api/invoice-adjustments', { DB: stubDB() }, 'GET');
  const b = await res.json();
  ok_('GET list -> 200 with paging metadata', res.status === 200 && b.data?.length === 1 && b.total === 1, JSON.stringify(b));
}
{
  const res = await call('/api/invoice-adjustments', {}, 'POST', GOOD);
  check('no database binding -> 503', res.status, 503);
}

/* ============================================================
   B. Against SQLite
   ============================================================ */
console.log('\n=== B. Behaviour against an in-memory database (0001 + 0002) ===');
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }

if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; part B checked nothing.');
} else {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const AT = '2026-10-08T00:00:00Z';

  /** The smallest D1-shaped wrapper the handlers need: prepare/bind/first/all/run/batch. */
  function makeD1() {
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON;');
    for (const f of ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql', '0004_job_card_discount_rate.sql']) {
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
      async first(col) { const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r; }
      async all() { return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
      async run() { return this.exec(); }
    }
    return {
      raw,
      prepare: (sql) => new Stmt(sql),
      async batch(statements) {
        raw.exec('BEGIN');
        try { const out = statements.map((s) => s.exec()); raw.exec('COMMIT'); return out; }
        catch (e) { raw.exec('ROLLBACK'); throw e; }
      },
    };
  }

  function fresh() {
    const DB = makeD1();
    DB.raw.exec(`INSERT INTO customers (id, name, phone, created_at) VALUES ('CUS-0001', 'C', '01700000001', '${AT}');
      INSERT INTO vehicles (id, customer_id, reg_no, brand, model, created_at) VALUES ('VEH-0001', 'CUS-0001', 'R', 'B', 'M', '${AT}');
      INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'M', '017', '${AT}');`);
    const env = { DB };
    const api = async (method, path, body) => {
      const res = await call(path, env, method, body);
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const inv = (id) => ({ ...DB.raw.prepare('SELECT total, paid, written_off AS writtenOff, due, status FROM invoices WHERE id = ?').get(id) });
    return { DB, api, inv };
  }
  async function invoice(h, total, jobPaid = 0) {
    const j = await h.api('POST', '/api/job-cards', {
      customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001', date: '2026-10-01', complaint: 'x',
      services: [{ serviceId: null, name: 'Work', qty: 1, unitPrice: total }], partsUsed: [], paid: jobPaid,
    });
    for (const s of ['Inspection', 'In Progress', 'Completed']) await h.api('POST', `/api/job-cards/${j.body.data.id}/status`, { status: s });
    return { invoiceId: (await h.api('POST', '/api/invoices', { jobCardId: j.body.data.id })).body.data.id, jobCardId: j.body.data.id };
  }
  const pay = (h, invoiceId, amount) => h.api('POST', '/api/payments', { customerId: 'CUS-0001', invoiceId, amount });
  const writeOff = (h, invoiceId, amount, expectedDue, extra = {}) =>
    h.api('POST', '/api/invoice-adjustments', { invoiceId, amount, reason: 'Customer concession', expectedDue, ...extra });
  const reverse = (h, id, voidReason = 'Customer will pay') => h.api('POST', `/api/invoice-adjustments/${id}/void`, { voidReason });
  const fig = (o) => [o.paid, o.writtenOff, o.due, o.status];

  console.log('\n-- B1. The business case --');
  {
    const h = fresh();
    const { invoiceId: i, jobCardId } = await invoice(h, 3000, 500);
    check('a new invoice starts with nothing paid, whatever the job card said', fig(h.inv(i)), [0, 0, 3000, 'Unpaid']);
    check('   ...and the job card keeps its Paid/Advance figure',
      h.DB.raw.prepare('SELECT paid FROM job_cards WHERE id = ?').get(jobCardId).paid, 500);
    await pay(h, i, 2000);
    check('2,000 paid -> Partial, due 1,000', fig(h.inv(i)), [2000, 0, 1000, 'Partial']);
    const r = await writeOff(h, i, 1000, 1000, { recordedBy: 'Manager' });
    check('write off 1,000 -> 201', r.status, 201);
    check('   ...the record snapshots the due', [r.body.data.dueBefore, r.body.data.dueAfter, r.body.data.customerId, r.body.data.recordedBy],
      [1000, 0, 'CUS-0001', 'Manager']);
    check('   ...the invoice: paid 2,000, written off 1,000, due 0, Paid', fig(h.inv(i)), [2000, 1000, 0, 'Paid']);
    check('   ...the total is untouched', h.inv(i).total, 3000);
    check('   ...and no payment row was created', h.DB.raw.prepare('SELECT count(*) AS n FROM payments').get().n, 1);

    const dup = await writeOff(h, i, 1000, 1000);
    check('the same request again -> 409 stale_balance', [dup.status, dup.body.error?.reason, dup.body.error?.currentDue], [409, 'stale_balance', 0]);
    const p = await pay(h, i, 1);
    check('a payment on the settled invoice is refused', p.status, 409);

    const v = await reverse(h, r.body.data.id);
    check('reverse it -> 200, Void', [v.status, v.body.data.status, v.body.data.voidReason], [200, 'Void', 'Customer will pay']);
    check('   ...the due comes back', fig(h.inv(i)), [2000, 0, 1000, 'Partial']);
    check('   ...the row is kept', h.DB.raw.prepare('SELECT count(*) AS n FROM invoice_adjustments').get().n, 1);
    const v2 = await reverse(h, r.body.data.id);
    check('reverse it again -> 409 adjustment_void', [v2.status, v2.body.error?.reason], [409, 'adjustment_void']);
    await pay(h, i, 1000);
    check('the customer then pays in full -> Paid on cash alone', fig(h.inv(i)), [3000, 0, 0, 'Paid']);
  }

  console.log('\n-- B2. Guards --');
  {
    const h = fresh();
    const { invoiceId: i } = await invoice(h, 1000);
    const over = await writeOff(h, i, 1001, 1000);
    check('more than the due -> 409 over_adjustment', [over.status, over.body.error?.reason], [409, 'over_adjustment']);
    const stale = await writeOff(h, i, 100, 900);
    check('an expectedDue that is not the due -> 409 stale_balance', [stale.status, stale.body.error?.reason], [409, 'stale_balance']);
    const close = await writeOff(h, i, 100, 1000.004);
    check('   ...a difference under half a paisa is the same due', close.status, 201);
    check('a write-off before any payment: Unpaid, due reduced', fig(h.inv(i)), [0, 100, 900, 'Unpaid']);
    await pay(h, i, 800);
    check('then a payment: Partial', fig(h.inv(i)), [800, 100, 100, 'Partial']);
    const tooMuch = await pay(h, i, 101);
    check('a payment cannot use room a write-off took', tooMuch.status, 409);
    await pay(h, i, 100);
    check('the exact remainder settles it', fig(h.inv(i)), [900, 100, 0, 'Paid']);
    check('none of the refused writes left a row', h.DB.raw.prepare('SELECT count(*) AS n FROM invoice_adjustments').get().n, 1);
    const counter = h.DB.raw.prepare("SELECT last_value FROM id_counters WHERE collection = 'invoiceAdjustments'").get().last_value;
    ok_('   ...ids are allocated before the guard, so a refusal may use one up (gaps are expected)', counter >= 1, String(counter));
  }
  {
    const h = fresh();
    const { invoiceId: i } = await invoice(h, 1000);
    await writeOff(h, i, 100, 1000);
    await writeOff(h, i, 150, 900);
    check('several write-offs add up', fig(h.inv(i)), [0, 250, 750, 'Unpaid']);
    const full = await writeOff(h, i, 750, 750);
    check('writing off the rest with no cash -> Paid (shown as Written Off)', fig(h.inv(i)), [0, 1000, 0, 'Paid']);

    const vi = await h.api('POST', `/api/invoices/${i}/void`);
    check('the invoice can be voided', vi.status, 200);
    const frozen = h.inv(i);
    check('   ...and keeps its figures', fig(frozen), [0, 1000, 0, 'Void']);
    const onVoid = await writeOff(h, i, 1, 0);
    check('no write-off on a Void invoice', [onVoid.status, onVoid.body.error?.reason], [409, 'invoice_void']);
    const revVoid = await reverse(h, full.body.data.id);
    check('no reversal on a Void invoice', [revVoid.status, revVoid.body.error?.reason], [409, 'invoice_void']);
    check('   ...its figures did not move', fig(h.inv(i)), fig(frozen));
    const del = await h.api('DELETE', `/api/invoices/${i}`);
    check('a Void invoice with write-offs cannot be deleted', [del.status, del.body.error?.reason], [409, 'invoice_has_adjustments']);
    const rec = await h.api('GET', `/api/invoices/${i}`);
    check('the invoice record carries writtenOff', rec.body.data.writtenOff, 1000);
    const list = await h.api('GET', '/api/invoice-adjustments');
    check('the list returns all three write-offs', list.body.total, 3);
  }
  {
    const h = fresh();
    const { invoiceId: i } = await invoice(h, 1000);
    const before = h.DB.raw.prepare('SELECT * FROM invoices WHERE id = ?').get(i);
    await writeOff(h, i, 0.001, 1000);
    const tiny = h.inv(i);
    ok_('a tiny write-off is still exact', Math.abs(tiny.due - 999.999) < 1e-9 && tiny.status === 'Unpaid', JSON.stringify(tiny));
    ok_('   ...and only paid/written_off/due/status/updated_at moved',
      Object.keys(before).filter((k) => !['paid', 'written_off', 'due', 'status', 'updated_at'].includes(k))
        .every((k) => before[k] === h.DB.raw.prepare('SELECT * FROM invoices WHERE id = ?').get(i)[k]));
  }
}

console.log(`\nInvoice adjustment writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
