/* POST / PUT / DELETE / :id/void / :id/link /api/payments — unit tests against
   the REAL Worker handlers with a stubbed D1 binding.

   Payments are the source of truth for an invoice's balance, and the one
   place in this API where getting concurrency wrong loses or invents money.
   So the weight is on the SQL that would be sent:

     - the overpayment rule IS the INSERT's WHERE clause. Nothing reads the
       balance, subtracts in JavaScript and writes back, because two
       concurrent payments would both find the same room;
     - the balance is recomputed by one UPDATE whose arithmetic is
       recomputeInvoiceBalance()'s, clamps included, and which refuses to
       touch a Void invoice;
     - every operation is one batch, and the recompute is conditional on the
       payment mutation having landed;
     - an advance touches no invoice at all;
     - no statement anywhere names job_cards: a job card's paid/due are a
       frozen pre-invoice snapshot.

   Whether the batch really rolls back, and whether concurrent payments
   really settle correctly, are D1's behaviour: proved against a real
   database in the integration suite. */
import worker from '../../src/index.js';

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

const METHODS = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];

const PAYMENT = {
  id: 'PAY-0001', invoice_id: 'INV-0001', customer_id: 'CUS-0001', job_card_id: null,
  date: '2026-09-18', amount: 3000, method: 'Cash', status: 'Active',
  notes: '', created_at: '2026-09-18T09:00:00.000Z', updated_at: null,
};
const ADVANCE = { ...PAYMENT, id: 'PAY-0002', invoice_id: null, job_card_id: 'JOB-0001' };
const INVOICE_REFUSAL = { status: 'Unpaid', customer_id: 'CUS-0001', total: 8000, settled: 6000 };

/**
 * `payment`  the row the void / delete / link guards read, or null for a 404.
 * `refusal`  what the failure-path lookup finds when a guard matched nothing.
 * `changes`  meta.changes per batch statement; [0] is the primary mutation.
 */
function stubDB({
  payment = PAYMENT,
  written = PAYMENT,
  refusal = INVOICE_REFUSAL,
  changes = null,
  throwOnBatch = null,
  counter = { last_value: 1, prefix: 'PAY' },
  jobCard = { customer_id: 'CUS-0001', live_invoice: null },
} = {}) {
  const calls = [];
  const batches = [];
  const db = {
    calls, batches,
    get sql() { return calls.map((c) => c.sql).join('\n'); },
    find(fragment) { return calls.find((c) => c.sql.includes(fragment)); },
    all(fragment) { return calls.filter((c) => c.sql.includes(fragment)); },
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('sqlite_master')) return { n: 0 };
          if (sql.includes('id_counters')) return counter;
          if (sql.includes('AS settled')) return refusal;
          if (sql.includes('UPDATE payments SET notes')) return payment ? written : null;
          if (sql.includes('FROM job_cards jc WHERE jc.id = ?1')) return jobCard;
          if (sql.includes('FROM payments')) return payment;
          return null;
        },
        async all() {
          if (sql.includes('sqlite_master')) return { results: [{ name: 'customers' }] };
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

// C-9 put a bearer-token gate in front of every mutation, so this suite
// authenticates the way any caller does: the token in the header, and the
// Worker's own secret in the env it is handed. The gate itself is tested in
// api-auth.test.mjs -- here it is simply satisfied, so these assertions stay
// about the route. An env without a DB still has the token, so a missing
// binding is still answered by the route rather than by the gate.
const TEST_TOKEN = 'unit-test-token';
const call = (path, env, method, body) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { API_TOKEN: TEST_TOKEN, ...env });
const post = (body, db) => call('/api/payments', { DB: db ?? stubDB() }, 'POST', body);
const put = (body, db, id = 'PAY-0001') => call(`/api/payments/${id}`, { DB: db ?? stubDB() }, 'PUT', body);
const link = (body, db, id = 'PAY-0002') =>
  call(`/api/payments/${id}/link`, { DB: db ?? stubDB({ payment: ADVANCE }) }, 'POST', body);
const voidIt = (db, body, id = 'PAY-0001') =>
  call(`/api/payments/${id}/void`, { DB: db ?? stubDB() }, 'POST', body);
const del = (db, id = 'PAY-0001') => call(`/api/payments/${id}`, { DB: db ?? stubDB() }, 'DELETE');
const bodyOf = async (res) => res.json();

const ADVANCE_BODY = { customerId: 'CUS-0001', amount: 500 };
const LINKED_BODY = { customerId: 'CUS-0001', invoiceId: 'INV-0001', amount: 500 };

/** The statements a batch would send, as SQL text, in order. */
const batchSql = (db, n = 0) => {
  const statements = db.batches[n] ?? [];
  const written = db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql));
  return written.slice(written.length - statements.length).map((c) => c.sql);
};
/** The column names of the payment INSERT, and the value bound to each. */
const insertAt = (db) => {
  const ins = db.find('INSERT INTO payments');
  const names = ins.sql.match(/INSERT INTO payments\s*\(([^)]+)\)/)[1]
    .split(',').map((s) => s.trim());
  return (col) => {
    const i = names.indexOf(col);
    // status is a literal in the statement, not a bound value.
    if (col === 'status') return /'Active'/.test(ins.sql) ? 'Active' : null;
    // ?1..?9 map to binds[0..8], with status occupying no placeholder.
    const before = names.slice(0, i).filter((n) => n !== 'status').length;
    return ins.binds[before];
  };
};

/* ============================================================
   1. Create — an advance
   ============================================================ */
console.log('\n=== POST /api/payments ===');
console.log('\n-- 1. An advance touches no invoice --');
{
  const db = stubDB();
  const res = await post(ADVANCE_BODY, db);
  ok_('POST -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await bodyOf(res);
  ok_('   ...returns a payment record', b.data?.id === 'PAY-0001', JSON.stringify(b).slice(0, 200));
  ok_('   ...with no paging metadata', !('count' in b) && !('total' in b));

  ok_('allocates a PAY id through id_counters', !!db.find('id_counters'), db.sql);
  check('   ...from the payments counter', db.find('id_counters').binds, ['payments']);
  check('exactly one batch', db.batches.length, 1);
  check('   ...of one statement — nothing else to write', db.batches[0].length, 1);
  const advIns = db.find('INSERT INTO payments').sql;
  ok_('the insert has no balance guard -- only the job card guard',
    /INSERT INTO payments[\s\S]*SELECT[\s\S]*WHERE \(\?4 IS NULL OR EXISTS/.test(advIns) && !/SUM\(/.test(advIns),
    advIns);
  ok_('   ...which checks the job card is this customer\'s and not yet invoiced',
    /jc\.id = \?4 AND jc\.customer_id = \?3/.test(advIns) && /iv\.job_card_id = jc\.id AND iv\.status <> 'Void'/.test(advIns),
    advIns);
  ok_('   ...and no invoice is touched at all', !db.find('UPDATE invoices'), db.sql);
  ok_('   ...nor any balance read', !/SUM\(amount\)/.test(db.sql), db.sql);
  const at = insertAt(db);
  check('invoice_id is null, not an empty string', at('invoice_id'), null);
  check('status is Active', at('status'), 'Active');
}
{
  const db = stubDB();
  await post({ ...ADVANCE_BODY, invoiceId: '', jobCardId: '' }, db);
  const at = insertAt(db);
  check('a blank invoiceId is null', at('invoice_id'), null);
  check('a blank jobCardId is null', at('job_card_id'), null);
}
{
  const db = stubDB();
  await post({ ...ADVANCE_BODY, jobCardId: 'JOB-0001' }, db);
  check('an advance may carry a job card for context', insertAt(db)('job_card_id'), 'JOB-0001');
  ok_('   ...and still writes no invoice statement', !db.find('UPDATE invoices'), db.sql);
}
{
  // The form makes invoice and job card mutually exclusive; recordPayment()
  // does not, and a released advance that is later linked really has both.
  const db = stubDB();
  const res = await post({ ...LINKED_BODY, jobCardId: 'JOB-0001' }, db);
  ok_('a payment may carry BOTH an invoice and a job card', res.status === 201, `got ${res.status}`);
}

console.log('\n-- 2. A linked payment carries the overpayment guard --');
{
  const db = stubDB();
  const res = await post(LINKED_BODY, db);
  ok_('POST -> 201', res.status === 201, `got ${res.status}`);
  check('exactly one batch', db.batches.length, 1);
  const sql = batchSql(db);
  check('   ...of two statements', sql.length, 2);
  ok_('the payment INSERT is first', /^\s*INSERT INTO payments/.test(sql[0]), sql[0]);
  ok_('   ...and it is an INSERT ... SELECT ... WHERE, not a VALUES',
    /SELECT[\s\S]*WHERE EXISTS/.test(sql[0]), sql[0]);
  ok_('   ...guarded on the invoice existing and not being Void',
    /i\.id\s*= \?2/.test(sql[0]) && /i\.status\s*<> 'Void'/.test(sql[0]), sql[0]);
  ok_('   ...and belonging to this customer', /i\.customer_id = \?3/.test(sql[0]), sql[0]);
  ok_('   ...and on the live sum plus this amount fitting the total',
    /SUM\(amount\)[\s\S]*?\+ \?6 <= i\.total/.test(sql[0]), sql[0]);
  ok_('   ...counting only non-Void payments', /status <> 'Void'\) \+ \?6/.test(sql[0]), sql[0]);

  ok_('NOTHING reads the balance before deciding',
    !db.calls.some((c) => /^\s*SELECT/.test(c.sql) && /SUM\(amount\)/.test(c.sql)), db.sql);
  ok_('   ...so no balance is subtracted in JavaScript', !db.find('AS settled'), db.sql);
}

console.log('\n-- 3. The recompute is arithmetic in SQL --');
{
  const db = stubDB();
  await post(LINKED_BODY, db);
  const rec = db.find('UPDATE invoices');
  ok_('one UPDATE rewrites paid, due and status', !!rec, db.sql);
  ok_('   ...paid is the live sum, floored at zero and capped at the total',
    /paid\s*= MIN\(total, MAX\(0, \(SELECT COALESCE\(SUM\(amount\), 0\)/.test(rec.sql), rec.sql);
  ok_('   ...counting only this invoice\'s non-Void payments',
    /WHERE invoice_id = \?1 AND status <> 'Void'/.test(rec.sql), rec.sql);
  ok_('   ...due is total minus paid, floored at zero',
    /due\s*= MAX\(total - MIN\(total/.test(rec.sql), rec.sql);
  ok_('   ...status is Paid when a positive total is covered',
    /WHEN total > 0 AND MIN\(total[\s\S]*?>= total THEN 'Paid'/.test(rec.sql), rec.sql);
  ok_('   ...Partial when anything is paid', /> 0\s*THEN 'Partial'/.test(rec.sql), rec.sql);
  ok_('   ...and Unpaid otherwise', /ELSE 'Unpaid'/.test(rec.sql), rec.sql);
  ok_('A VOID INVOICE IS NEVER RECOMPUTED — its figures are frozen',
    /AND status <> 'Void'/.test(rec.sql.split('SET')[1]), rec.sql);
  ok_('   ...and the recompute only runs if the payment really landed',
    /EXISTS \(SELECT 1 FROM payments WHERE id = \?3\)/.test(rec.sql), rec.sql);
  check('   ...naming the payment just inserted', rec.binds[2], 'PAY-0001');
  check('   ...and the invoice it belongs to', rec.binds[0], 'INV-0001');
  const sql = batchSql(db);
  ok_('the insert runs before the recompute, so the sum includes it',
    sql.findIndex((s) => /INSERT INTO payments/.test(s))
      < sql.findIndex((s) => /UPDATE invoices/.test(s)), sql);
}

console.log('\n-- 4. Why a guarded insert was refused --');
for (const [label, refusal, reason, message] of [
  ['an invoice that is gone', null, 'invoice_not_found', 'That invoice no longer exists.'],
  ['a Void invoice', { ...INVOICE_REFUSAL, status: 'Void' }, 'invoice_void',
    'Cannot record a payment against a Void invoice.'],
  ['another customer\'s invoice', { ...INVOICE_REFUSAL, customer_id: 'CUS-0009' }, 'customer_mismatch',
    'This invoice belongs to a different customer.'],
  ['an amount larger than the due', INVOICE_REFUSAL, 'overpayment',
    'This would overpay the invoice. Outstanding due is 2000.'],
]) {
  const db = stubDB({ changes: [0, 0], refusal });
  const res = await post({ ...LINKED_BODY, amount: 5000 }, db);
  check(`${label} -> 409`, res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, reason);
  check('   ...with the client\'s wording', b.error.message, message);
  check('   ...and the explanation cost exactly one query', db.all('AS settled').length, 1);
}
{
  const db = stubDB({ changes: [0, 0] });
  const b = await bodyOf(await post({ ...LINKED_BODY, amount: 5000 }, db));
  check('an overpayment reports the live outstanding due', b.error.outstandingDue, 2000);
  check('   ...and what was asked for', b.error.amount, 5000);
}
{
  const db = stubDB();
  await post(LINKED_BODY, db);
  ok_('a successful create never runs the explanation query', !db.find('AS settled'), db.sql);
}

console.log('\n-- 5. Fields --');
for (const [why, body] of [
  ['a missing customerId', { amount: 500 }],
  ['a blank customerId', { customerId: '  ', amount: 500 }],
  ['a missing amount', { customerId: 'CUS-0001' }],
  ['a zero amount', { customerId: 'CUS-0001', amount: 0 }],
  ['a negative amount', { customerId: 'CUS-0001', amount: -5 }],
  ['an amount that is not a number', { customerId: 'CUS-0001', amount: 'lots' }],
  ['a non-ISO date', { ...ADVANCE_BODY, date: '18/09/2026' }],
  ['an impossible date', { ...ADVANCE_BODY, date: '2026-02-31' }],
]) {
  const db = stubDB();
  const res = await post(body, db);
  check(`${why} -> 422`, res.status, 422);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const b = await bodyOf(await post({ customerId: 'CUS-0001', amount: 0 }));
  check('a zero amount uses the client\'s wording', b.error.fields.amount,
    'Amount must be greater than 0.');
}
for (const method of METHODS) {
  const db = stubDB();
  const res = await post({ ...ADVANCE_BODY, method }, db);
  ok_(`method ${method} is accepted`, res.status === 201, `got ${res.status}`);
  check('   ...and stored as given', insertAt(db)('method'), method);
}
{
  const db = stubDB();
  await post(ADVANCE_BODY, db);
  check('an absent method falls back to Cash', insertAt(db)('method'), 'Cash');
  const db2 = stubDB();
  await post({ ...ADVANCE_BODY, method: '' }, db2);
  check('   ...and so does a blank one', insertAt(db2)('method'), 'Cash');
}
{
  const res = await post({ ...ADVANCE_BODY, method: 'Cheque' });
  check('an unknown method -> 422, never silently filed as Cash', res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...listing the four that exist',
    METHODS.every((m) => b.error.fields.method.includes(m)), b.error.fields.method);
}
{
  const db = stubDB();
  await post({ ...ADVANCE_BODY, date: '2026-09-20' }, db);
  check('a supplied date is stored verbatim', insertAt(db)('date'), '2026-09-20');
  const db2 = stubDB();
  await post(ADVANCE_BODY, db2);
  const dhaka = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  check('   ...and an absent one is today in the workshop\'s calendar',
    insertAt(db2)('date'), dhaka);
}
{
  const db = stubDB();
  await post({ ...ADVANCE_BODY, notes: '  counter cash  ' }, db);
  check('the note is stored trimmed', insertAt(db)('notes'), 'counter cash');
  const db2 = stubDB();
  await post(ADVANCE_BODY, db2);
  check('   ...and absent means empty, never null', insertAt(db2)('notes'), '');
}
for (const [field, value] of [
  ['id', 'PAY-0009'], ['createdAt', '2020-01-01T00:00:00Z'], ['updatedAt', '2020-01-01T00:00:00Z'],
  ['status', 'Void'], ['paid', 1], ['due', 1],
]) {
  const db = stubDB();
  const res = await post({ ...ADVANCE_BODY, [field]: value }, db);
  check(`\`${field}\` -> 422`, res.status, 422);
  ok_('   ...names the field', !!(await bodyOf(res)).error.fields?.[field]);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await post('not json');
  check('a malformed body -> 400', res.status, 400);
}
{
  const db = stubDB({ throwOnBatch: 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT' });
  const res = await post({ customerId: 'CUS-7777', amount: 500 }, db);
  check('an unknown customer -> 409, from the schema\'s own foreign key', res.status, 409);
  ok_('   ...with no SQL leaked', !JSON.stringify(await bodyOf(res)).includes('SQLITE'));
  ok_('   ...and no reference was pre-checked one at a time',
    !db.find('FROM customers'), db.sql);
}

/* ============================================================
   6. Update
   ============================================================ */
console.log('\n=== PUT /api/payments/:id ===');
console.log('\n-- 6. Notes, and nothing else --');
{
  const db = stubDB({ written: { ...PAYMENT, notes: 'corrected', updated_at: 'x' } });
  const res = await put({ notes: '  corrected  ' }, db);
  ok_('PUT -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const upd = db.find('UPDATE payments SET notes');
  ok_('writes one column, plus updated_at',
    /SET notes = \?2, updated_at = \?3\s+WHERE id = \?1/.test(upd.sql), upd.sql);
  check('   ...trimmed', upd.binds[1], 'corrected');
  ok_('   ...and nothing financial is in the statement',
    !/\b(amount|method|status|invoice_id|job_card_id|customer_id)\s*=/.test(upd.sql.split('WHERE')[0]),
    upd.sql);
  ok_('   ...no batch is needed for one row', db.batches.length === 0);
  ok_('   ...and no invoice is recomputed: notes move no money',
    !db.find('UPDATE invoices'), db.sql);
}
for (const [field, value] of [
  ['amount', 1], ['date', '2026-01-01'], ['method', 'Card'], ['customerId', 'CUS-2'],
  ['jobCardId', 'JOB-2'], ['invoiceId', 'INV-2'], ['status', 'Void'],
  ['id', 'PAY-2'], ['createdAt', 'x'], ['updatedAt', 'x'],
]) {
  const db = stubDB();
  const res = await put({ [field]: value }, db);
  check(`editing \`${field}\` -> 422`, res.status, 422);
  ok_('   ...names the field', !!(await bodyOf(res)).error.fields?.[field]);
  ok_('   ...and nothing was written', !db.find('UPDATE payments SET notes'), db.sql);
}
{
  const b = await bodyOf(await put({ invoiceId: 'INV-2' }));
  ok_('editing invoiceId points at the link operation',
    /link operation/.test(b.error.fields.invoiceId), b.error.fields.invoiceId);
  const b2 = await bodyOf(await put({ status: 'Void' }));
  ok_('   ...and editing status points at the void operation',
    /void operation/.test(b2.error.fields.status), b2.error.fields.status);
  const b3 = await bodyOf(await put({ amount: 1 }));
  ok_('   ...while amount says to void the payment instead',
    /Void the payment instead/.test(b3.error.fields.amount), b3.error.fields.amount);
}
{
  const db = stubDB();
  const res = await put({}, db);
  check('an empty body -> 422', res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...and says what CAN be edited',
    /Only `notes` can be edited/.test(b.error.message), b.error.message);
}
{
  const db = stubDB({ payment: null });
  check('an unknown payment -> 404', (await put({ notes: 'x' }, db)).status, 404);
}
{
  const db = stubDB({ payment: { ...PAYMENT, status: 'Void' }, written: { ...PAYMENT, status: 'Void' } });
  ok_('a Void payment\'s notes are still editable', (await put({ notes: 'x' }, db)).status === 200);
}
{
  check('a malformed id -> 400', (await put({ notes: 'x' }, stubDB(), 'nope')).status, 400);
}

/* ============================================================
   7. Link
   ============================================================ */
console.log('\n=== POST /api/payments/:id/link ===');
console.log('\n-- 7. Applying an advance to an invoice --');
{
  const db = stubDB({ payment: ADVANCE });
  const res = await link({ invoiceId: 'INV-0001' }, db);
  ok_('link -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  check('exactly one batch', db.batches.length, 1);
  const sql = batchSql(db);
  check('   ...of two statements', sql.length, 2);
  const upd = db.calls.find((c) => /UPDATE payments[\s\S]*SET invoice_id/.test(c.sql));
  ok_('the link is a guarded UPDATE', !!upd, db.sql);
  ok_('   ...refusing a voided payment', /status\s*<> 'Void'/.test(upd.sql), upd.sql);
  ok_('   ...refusing one that is already linked', /invoice_id IS NULL/.test(upd.sql), upd.sql);
  ok_('   ...requiring a live invoice of the same customer',
    /i\.status\s*<> 'Void'/.test(upd.sql) && /i\.customer_id = payments\.customer_id/.test(upd.sql),
    upd.sql);
  ok_('   ...and room for the payment\'s OWN amount, read from the row',
    /\+ payments\.amount <= i\.total/.test(upd.sql), upd.sql);
  ok_('   ...so a request cannot smuggle in a different figure',
    !upd.binds.includes(500) && upd.binds.length === 3, upd.binds);
  ok_('no balance is read before deciding',
    !db.calls.some((c) => /^\s*SELECT/.test(c.sql) && /SUM\(amount\)/.test(c.sql)), db.sql);

  const rec = db.find('UPDATE invoices');
  ok_('the invoice is recomputed in the same batch', !!rec, db.sql);
  ok_('   ...only if the link really landed',
    /\(SELECT invoice_id FROM payments WHERE id = \?3\) = \?1/.test(rec.sql), rec.sql);
}
for (const [label, payment, status, reason, message] of [
  ['an unknown payment', null, 404, undefined, 'Payment not found.'],
  ['a voided payment', { ...ADVANCE, status: 'Void' }, 409, 'payment_void',
    'Cannot link a voided payment.'],
  ['one already linked', { ...ADVANCE, invoice_id: 'INV-0009' }, 409, 'payment_already_linked',
    'This payment is already linked to an invoice.'],
]) {
  const db = stubDB({ payment });
  const res = await link({ invoiceId: 'INV-0001' }, db);
  check(`${label} -> ${status}`, res.status, status);
  const b = await bodyOf(res);
  check('   ...with the client\'s wording', b.error.message, message);
  if (reason) check('   ...reason', b.error.reason, reason);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ payment: ADVANCE, changes: [0, 0] });
  const res = await link({ invoiceId: 'INV-0001' }, db);
  check('a guard that matched nothing -> 409', res.status, 409);
  check('   ...explained by the same one query', db.all('AS settled').length, 1);
  check('   ...as an overpayment here', (await bodyOf(res)).error.reason, 'overpayment');
}
for (const [why, body] of [
  ['a missing invoiceId', {}],
  ['a blank invoiceId', { invoiceId: '  ' }],
  ['an amount', { invoiceId: 'INV-0001', amount: 500 }],
  ['a customerId', { invoiceId: 'INV-0001', customerId: 'CUS-0002' }],
  ['a status', { invoiceId: 'INV-0001', status: 'Void' }],
  ['a date', { invoiceId: 'INV-0001', date: '2026-01-01' }],
]) {
  const db = stubDB({ payment: ADVANCE });
  const res = await link(body, db);
  check(`link with ${why} -> 422`, res.status, 422);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  check('a malformed link body -> 400', (await link('not json', stubDB({ payment: ADVANCE }))).status, 400);
  check('a malformed id -> 400', (await link({ invoiceId: 'INV-0001' }, stubDB(), 'nope')).status, 400);
}

/* ============================================================
   8. Void
   ============================================================ */
console.log('\n=== POST /api/payments/:id/void ===');
console.log('\n-- 8. The money stays, the invoice stops counting it --');
{
  const db = stubDB();
  const res = await voidIt(db);
  ok_('void -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const sql = batchSql(db);
  check('one batch of two statements', sql.length, 2);
  ok_('the status UPDATE is first, and is the gate',
    /^\s*UPDATE payments/.test(sql[0]) && /WHERE id = \?1 AND status <> 'Void'/.test(sql[0]), sql[0]);
  ok_('   ...and it writes nothing but the status and updated_at',
    /SET status = 'Void', updated_at = \?2/.test(sql[0]), sql[0]);
  ok_('   ...so amount, date, method, customer and links all survive',
    !/\b(amount|date|method|customer_id|invoice_id|job_card_id|notes)\s*=/.test(sql[0].split('WHERE')[0]),
    sql[0]);
  const rec = db.find('UPDATE invoices');
  ok_('the linked invoice is recomputed without it', !!rec, db.sql);
  ok_('   ...only once the payment really is Void',
    /\(SELECT status FROM payments WHERE id = \?3\) = 'Void'/.test(rec.sql), rec.sql);
  check('   ...against the invoice it was linked to', rec.binds[0], 'INV-0001');
}
{
  const db = stubDB({ payment: ADVANCE });
  const res = await voidIt(db, undefined, 'PAY-0002');
  ok_('voiding an advance -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...recomputes no invoice, because there is none',
    !db.find('UPDATE invoices'), db.sql);
  check('   ...so the batch is the status update alone', db.batches[0].length, 1);
}
{
  const db = stubDB({ payment: { ...PAYMENT, status: 'Void' } });
  const res = await voidIt(db);
  check('a payment that is already void -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...with the client\'s wording', b.error.message, 'Payment is already void.');
  check('   ...reason', b.error.reason, 'payment_void');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ payment: null });
  const res = await voidIt(db);
  check('an unknown payment -> 404', res.status, 404);
  check('   ...with the client\'s wording', (await bodyOf(res)).error.message, 'Payment not found.');
}
{
  const db = stubDB({ changes: [0, 0] });
  const res = await voidIt(db);
  check('a gate that matched nothing -> 409', res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'concurrent_modification');
}
{
  ok_('void takes no body at all', (await voidIt(stubDB(), undefined)).status === 200);
  ok_('   ...and an empty object is fine too', (await voidIt(stubDB(), {})).status === 200);
  check('void with a field -> 422', (await voidIt(stubDB(), { status: 'Void' })).status, 422);
  check('a malformed void body -> 400', (await voidIt(stubDB(), 'not json')).status, 400);
}
for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/payments/PAY-0001/void', { DB: stubDB() }, m,
    m === 'GET' ? undefined : {});
  check(`${m} on the void path -> 405`, res.status, 405);
  check('   ...Allow names POST only', res.headers.get('allow'), 'POST');
}

/* ============================================================
   9. Delete
   ============================================================ */
console.log('\n=== DELETE /api/payments/:id ===');
console.log('\n-- 9. Only once a payment is already Void --');
{
  const db = stubDB();
  const res = await del(db);
  check('deleting an Active payment -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'payment_active');
  ok_('   ...telling the caller to void it first',
    /Void it first/.test(b.error.message), b.error.message);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ payment: { ...PAYMENT, status: 'Void' } });
  const res = await del(db);
  check('deleting a Void payment -> 200', res.status, 200);
  check('   ...reporting what went', (await bodyOf(res)).data, { id: 'PAY-0001', deleted: true });
  const sql = batchSql(db);
  check('   ...in one batch of two statements', sql.length, 2);
  ok_('   ...the DELETE carries the rule itself',
    /DELETE FROM payments WHERE id = \?1 AND status = 'Void'/.test(sql[0]), sql[0]);
  ok_('   ...and the invoice is recomputed afterwards, defensively',
    /UPDATE invoices/.test(sql[1]) && /NOT EXISTS \(SELECT 1 FROM payments WHERE id = \?3\)/.test(sql[1]),
    sql[1]);
}
{
  const db = stubDB({ payment: { ...ADVANCE, status: 'Void' } });
  const res = await del(db, 'PAY-0002');
  check('deleting a Void advance -> 200', res.status, 200);
  check('   ...with no invoice to recompute', db.batches[0].length, 1);
}
{
  const db = stubDB({ payment: null });
  check('an unknown payment -> 404', (await del(db)).status, 404);
}
{
  const db = stubDB({ payment: { ...PAYMENT, status: 'Void' }, changes: [0, 0] });
  check('a row that vanished between the guard and the delete -> 404', (await del(db)).status, 404);
}
{
  check('a malformed id -> 400', (await del(stubDB(), 'nope')).status, 400);
}

/* ============================================================
   9b. Job card guards (Job Card Advance)
   ============================================================ */
console.log('\n-- 9b. A payment naming a job card: same customer; an advance only before invoicing --');
for (const [label, body, jobCard, reason] of [
  ['an advance for another customer\'s job card', { ...ADVANCE_BODY, jobCardId: 'JOB-0001' },
    { customer_id: 'CUS-0009', live_invoice: null }, 'job_card_customer_mismatch'],
  ['an advance for an invoiced job card', { ...ADVANCE_BODY, jobCardId: 'JOB-0001' },
    { customer_id: 'CUS-0001', live_invoice: 'INV-0004' }, 'job_card_invoiced'],
  ['an advance for a job card that no longer exists', { ...ADVANCE_BODY, jobCardId: 'JOB-0404' },
    null, 'job_card_not_found'],
  ['an invoice payment naming another customer\'s job card', { ...LINKED_BODY, jobCardId: 'JOB-0001' },
    { customer_id: 'CUS-0009', live_invoice: 'INV-0001' }, 'job_card_customer_mismatch'],
]) {
  const db = stubDB({ jobCard, changes: [0, 0] });
  const res = await post(body, db);
  check(`${label} -> 409`, res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, reason);
  ok_('   ...refused by the insert\'s own guard, in one batch', db.batches.length === 1);
}
{
  // An invoice payment for an invoiced job card is fine: only an ADVANCE must
  // precede the invoice. The guard then falls through to the balance reason.
  const db = stubDB({ jobCard: { customer_id: 'CUS-0001', live_invoice: 'INV-0001' }, changes: [0, 0] });
  const res = await post({ ...LINKED_BODY, jobCardId: 'JOB-0001' }, db);
  check('an invoice payment on an invoiced job card is refused only for balance', (await bodyOf(res)).error.reason, 'overpayment');
  const ins = db.find('INSERT INTO payments').sql;
  ok_('   ...its insert checks job card ownership', /jc\.id = \?4 AND jc\.customer_id = \?3/.test(ins), ins);
}
{
  const db = stubDB({ payment: ADVANCE, jobCard: { customer_id: 'CUS-0009', live_invoice: null }, changes: [0, 0] });
  const res = await link({ invoiceId: 'INV-0001' }, db);
  check('linking an advance whose job card is another customer\'s -> 409', res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'job_card_customer_mismatch');
  const upd = db.find('UPDATE payments');
  ok_('   ...the link guard checks the job card\'s customer against the invoice\'s',
    /jc\.id = payments\.job_card_id AND jc\.customer_id = i\.customer_id/.test(upd.sql), upd.sql);
}
{
  const db = stubDB({ changes: [0] });
  const res = await post(ADVANCE_BODY, db);
  check('an advance with no job card whose insert matched nothing -> 409 concurrent_modification',
    (await bodyOf(res)).error.reason, 'concurrent_modification');
}

/* ============================================================
   10. What a payment write never does
   ============================================================ */
console.log('\n-- 10. A job card\'s money is never touched --');
// Each case builds the stub the operation actually needs and then asserts on
// THAT stub, so none of these can pass against a database nothing ran against.
for (const [label, run] of [
  ['creating an advance', () => { const db = stubDB(); return [db, post(ADVANCE_BODY, db)]; }],
  ['creating a linked payment', () => { const db = stubDB(); return [db, post(LINKED_BODY, db)]; }],
  ['editing notes', () => { const db = stubDB(); return [db, put({ notes: 'x' }, db)]; }],
  ['linking', () => {
    const db = stubDB({ payment: ADVANCE });
    return [db, link({ invoiceId: 'INV-0001' }, db)];
  }],
  ['voiding', () => { const db = stubDB(); return [db, voidIt(db)]; }],
  ['deleting', () => {
    const db = stubDB({ payment: { ...PAYMENT, status: 'Void' } });
    return [db, del(db)];
  }],
]) {
  const [db, pending] = run();
  const res = await pending;
  ok_(`${label} succeeded, so the statements below are real`, res.status < 400, `got ${res.status}`);
  ok_(`   ...and never writes a job card`,
    !db.calls.some((c) => /(UPDATE|INSERT INTO|DELETE FROM)\s+job_cards/.test(c.sql)), db.sql);
  ok_(`   ...nor reads a job card's money`,
    !db.calls.some((c) => /\b(jc|job_cards)\.(paid|due)\b/.test(c.sql)), db.sql);
  ok_(`   ...and touches no inventory`,
    !db.find('inventory_transactions') && !db.find('UPDATE parts'), db.sql);
  ok_(`   ...having actually issued statements`, db.calls.length > 0, db.calls.length);
}

console.log('\n-- 11. Methods and bindings --');
for (const [path, method, body] of [
  ['/api/payments', 'POST', ADVANCE_BODY],
  ['/api/payments/PAY-0001', 'PUT', { notes: 'x' }],
  ['/api/payments/PAY-0001', 'DELETE', undefined],
  ['/api/payments/PAY-0001/void', 'POST', {}],
  ['/api/payments/PAY-0001/link', 'POST', { invoiceId: 'INV-0001' }],
]) {
  const res = await call(path, {}, method, body);
  check(`${method} ${path} without a binding -> 503`, res.status, 503);
  check('   ...code', (await bodyOf(res)).error.code, 'no_database');
}
{
  const routes = (await (await call('/api/health', { DB: stubDB() }, 'GET')).json()).data.routes;
  ok_('health advertises all five new routes',
    ['POST /api/payments', 'PUT /api/payments/:id', 'DELETE /api/payments/:id',
      'POST /api/payments/:id/void', 'POST /api/payments/:id/link'].every((r) => routes.includes(r)),
    routes);
  check('   ...and the registry is 144 routes', routes.length, 144);
  ok_('   ...with no PUT or DELETE on either action path',
    !routes.some((r) => /\/(void|link)$/.test(r) && !r.startsWith('POST ')), routes);
  check('   ...twenty-one action routes in all (0002 added reversing a write-off; 0005 four follow-up actions; 0006 three task actions; 0007 five estimate actions; 0009 setting an account password; 0011 approving and rejecting leave; 0013 retiring a tool; 0014 four per-conversation Messenger routes; 0015 five per-conversation WhatsApp routes; 0017 marking a notification read or unread)',
    routes.filter((r) => /\/:id\/[a-z-]+$/.test(r)).length, 32);
}
{
  const res = await call('/api/payments/PAY-0001/unlink', { DB: stubDB() }, 'POST', {});
  ok_('an action the collection does not declare is not routed',
    res.status === 400 || res.status === 405, `got ${res.status}`);
}

console.log(`\nPayment writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
