/* POST / PUT / POST :id/void / DELETE /api/invoices — unit tests against the
   REAL Worker handlers with a stubbed D1 binding.

   An invoice is the app's financial record, and two of its rules are the
   answers to audit findings, so the weight here is on the SQL that would be
   sent as much as on what the route answers:

     - an invoice is COPIED from a job card, not composed: the body names the
       job card, a date and a note, and every figure and both line sets are
       refused by name if sent;
     - the invoice, its two line tables and the job card's link go in ONE
       env.DB.batch(), and ux_invoices_live_job_card -- not a JavaScript check
       -- is what stops a second live invoice for one job card;
     - voiding cancels the DOCUMENT: paid and due are never written, every
       linked ACTIVE payment is released to an advance inheriting the
       invoice's job card, and a Void payment is left exactly as it is. That
       is audit Finding 7;
     - nothing anywhere in this module reads or writes parts or the inventory
       ledger. An invoice bills for stock the job card already issued.

   Whether the batch really rolls back, and whether two concurrent creates or
   voids really settle correctly, are D1's behaviour: proved against a real
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

/** An eligible job card: Completed, billable, with both kinds of line. */
const JOB = {
  id: 'JOB-0001', status: 'Completed',
  customer_id: 'CUS-0001', vehicle_id: 'VEH-0001',
  actual_delivery: '2026-09-14', completed_at: '2026-09-13T11:00:00.000Z',
  labour_cost: 600, discount: 100, tax_rate: 5,
  subtotal: 8000, tax: 395, total: 8295, paid: 3000,
  customer_found: 1, vehicle_found: 1, existing_invoice_id: null,
};
const JOB_SERVICES = [
  { service_id: 'SRV-0001', name: 'Full Service (as sold)', qty: 1, unit_price: 4000, total: 4000 },
  { service_id: 'SRV-0002', name: 'Brake Pads', qty: 2, unit_price: 1700, total: 3400 },
];
const JOB_PARTS = [
  { part_id: 'PRT-0001', name: 'Oil Filter (as sold)', part_no: 'OF-1', qty: 1, unit_price: 600, total: 600 },
];
const INVOICE = {
  id: 'INV-0001', job_card_id: 'JOB-0001', customer_id: 'CUS-0001', vehicle_id: 'VEH-0001',
  date: '2026-09-14', labour_cost: 600, discount: 100, tax_rate: 5,
  subtotal: 8000, tax: 395, total: 8295, paid: 3000, due: 5295,
  status: 'Unpaid', notes: '', created_at: '2026-09-14T09:00:00.000Z', updated_at: null,
};

/**
 * `job`       the eligibility row, or null for an unknown job card.
 * `invoice`   the row the void and delete guards read, or null for a 404.
 * `changes`   meta.changes per batch statement; [0] is the gate on a void.
 */
function stubDB({
  job = JOB,
  jobServices = JOB_SERVICES,
  jobParts = JOB_PARTS,
  invoice = INVOICE,
  invoiceServices = [],
  invoiceParts = [],
  changes = null,
  throwOnBatch = null,
  counter = { last_value: 1, prefix: 'INV' },
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
      // The router logs each successful write for offline sync (0020, lib/changes.js)
      // AFTER it commits; these assertions are about the route's own statements.
      if (!/INSERT INTO change_log/.test(sql)) calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('sqlite_master')) return { n: 0 };
          if (sql.includes('id_counters')) return counter;
          if (sql.includes('AS existing_invoice_id')) return job;
          if (sql.includes('UPDATE invoices SET notes')) return invoice ? { id: invoice.id } : null;
          if (sql.includes('FROM invoices')) return invoice;
          return null;
        },
        async all() {
          if (sql.includes('sqlite_master')) return { results: [{ name: 'customers' }] };
          if (sql.includes('FROM job_card_services')) return { results: jobServices };
          if (sql.includes('FROM job_card_parts')) return { results: jobParts };
          if (sql.includes('FROM invoice_services')) return { results: invoiceServices };
          if (sql.includes('FROM invoice_parts')) return { results: invoiceParts };
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
const post = (body, db) => call('/api/invoices', { DB: db ?? stubDB() }, 'POST', body);
const put = (body, db, id = 'INV-0001') => call(`/api/invoices/${id}`, { DB: db ?? stubDB() }, 'PUT', body);
const voidIt = (db, body, id = 'INV-0001') =>
  call(`/api/invoices/${id}/void`, { DB: db ?? stubDB() }, 'POST', body);
const del = (db, id = 'INV-0001') => call(`/api/invoices/${id}`, { DB: db ?? stubDB() }, 'DELETE');
const bodyOf = async (res) => res.json();

/** The statements a batch would send, as SQL text, in order. */
const batchSql = (db, n = 0) => {
  const statements = db.batches[n] ?? [];
  const written = db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql));
  return written.slice(written.length - statements.length).map((c) => c.sql);
};
/** The column names of the invoice INSERT, and the value bound to each. */
const insertAt = (db) => {
  const ins = db.find('INSERT INTO invoices');
  const names = ins.sql.match(/INSERT INTO invoices \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  return (col) => ins.binds[names.indexOf(col)];
};

/* ============================================================
   1. Create
   ============================================================ */
console.log('\n=== POST /api/invoices ===');
console.log('\n-- 1. A valid create --');
{
  const db = stubDB();
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  ok_('POST -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await bodyOf(res);
  ok_('   ...returns an invoice record', b.data?.id === 'INV-0001', JSON.stringify(b).slice(0, 200));
  ok_('   ...with both line arrays', Array.isArray(b.data.services) && Array.isArray(b.data.partsUsed));
  ok_('   ...named partsUsed, never parts', 'partsUsed' in b.data && !('parts' in b.data));
  ok_('   ...and no paging metadata', !('count' in b) && !('total' in b));

  ok_('allocates an INV id through id_counters', !!db.find('id_counters'), db.sql);
  check('   ...from the invoices counter', db.find('id_counters').binds, ['invoices']);
  check('exactly one batch', db.batches.length, 1);
  const sql = batchSql(db);
  ok_('the invoice INSERT is first', /^\s*INSERT INTO invoices/.test(sql[0]), sql[0]);
  check('   ...then one statement per line, then the job card link', sql.length, 1 + 2 + 1 + 1);
  ok_('   ...the service lines', /INSERT INTO invoice_services/.test(sql[1]) && /INSERT INTO invoice_services/.test(sql[2]));
  ok_('   ...the part line', /INSERT INTO invoice_parts/.test(sql[3]), sql[3]);
  ok_('   ...and the job card link LAST, in the same batch',
    /UPDATE job_cards/.test(sql[4]), sql[4]);
  check('   ...pointing the job card at the new invoice',
    db.find('UPDATE job_cards').binds.slice(0, 2), ['JOB-0001', 'INV-0001']);
  ok_('   ...and refreshing its updated_at, as Storage.updateData does',
    /updated_at = \?3/.test(db.find('UPDATE job_cards').sql));
}

console.log('\n-- 2. Every figure is copied from the job card --');
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001' }, db);
  const at = insertAt(db);
  check('job card id', at('job_card_id'), 'JOB-0001');
  check('customer and vehicle come from the job card too',
    [at('customer_id'), at('vehicle_id')], ['CUS-0001', 'VEH-0001']);
  check('labourCost', at('labour_cost'), 600);
  check('discount', at('discount'), 100);
  check('taxRate', at('tax_rate'), 5);
  check('subtotal', at('subtotal'), 8000);
  check('tax', at('tax'), 395);
  check('total', at('total'), 8295);
  // Decision (a), 0002: the job card's typed paid (3000 here) is not a recorded
  // payment, so it is NOT copied. A new invoice starts unpaid.
  check('paid starts at 0, not the job card\'s typed figure', at('paid'), 0);
  check('due is the whole total', at('due'), 8295);
  check('status starts Unpaid', at('status'), 'Unpaid');
  check('written_off is not set by the create (column default 0)', at('written_off'), undefined);
  ok_('nothing is recomputed from the lines: the job card already did that',
    at('subtotal') === 8000, at('subtotal'));
}
// Whatever the job card's typed paid says, the new invoice is the same:
// paid 0, due = total, Unpaid. Cash reaches it only as a payment.
for (const [label, over] of [
  ['job paid 0', { paid: 0 }],
  ['job paid 1', { paid: 1 }],
  ['job paid in full', { paid: 8295 }],
  ['job "overpaid"', { paid: 99999 }],
  ['job paid negative', { paid: -50 }],
]) {
  const db = stubDB({ job: { ...JOB, ...over } });
  await post({ jobCardId: 'JOB-0001' }, db);
  const at = insertAt(db);
  check(`${label} -> invoice paid 0, due 8295, Unpaid`,
    [at('paid'), at('due'), at('status')], [0, 8295, 'Unpaid']);
}
{
  const db = stubDB({ job: { ...JOB, labour_cost: null, discount: null, tax_rate: null, subtotal: null, tax: null } });
  await post({ jobCardId: 'JOB-0001' }, db);
  for (const col of ['labour_cost', 'discount', 'tax_rate', 'subtotal', 'tax']) {
    check(`a null ${col} becomes 0, never null — the column is NOT NULL`, insertAt(db)(col), 0);
  }
}

console.log('\n-- 3. The date, and the note --');
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001', date: '2026-09-20' }, db);
  check('a supplied date wins', insertAt(db)('date'), '2026-09-20');
}
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001' }, db);
  check('otherwise the day it was handed over', insertAt(db)('date'), '2026-09-14');
}
{
  const db = stubDB({ job: { ...JOB, actual_delivery: null } });
  await post({ jobCardId: 'JOB-0001' }, db);
  check('otherwise the day it was completed', insertAt(db)('date'), '2026-09-13');
}
{
  const db = stubDB({ job: { ...JOB, actual_delivery: '', completed_at: null } });
  await post({ jobCardId: 'JOB-0001' }, db);
  const dhaka = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  check('and otherwise today, in the workshop\'s calendar', insertAt(db)('date'), dhaka);
}
{
  const res = await post({ jobCardId: 'JOB-0001', date: '20/09/2026' });
  check('a non-ISO date -> 422', res.status, 422);
  const res2 = await post({ jobCardId: 'JOB-0001', date: '2026-02-31' });
  check('an impossible date -> 422', res2.status, 422);
}
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001', notes: '  settled on collection  ' }, db);
  check('the note is stored trimmed', insertAt(db)('notes'), 'settled on collection');
  const db2 = stubDB();
  await post({ jobCardId: 'JOB-0001' }, db2);
  check('   ...and absent means empty, never null', insertAt(db2)('notes'), '');
}

console.log('\n-- 4. The line snapshots are copied verbatim --');
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001' }, db);
  const svc = db.all('INSERT INTO invoice_services');
  const prt = db.all('INSERT INTO invoice_parts');
  check('one invoice line per job card line', [svc.length, prt.length], [2, 1]);
  check('a service line carries the name that was SOLD, not the catalogue\'s',
    svc[0].binds.slice(0, 6), ['INV-0001', 'SRV-0001', 'Full Service (as sold)', 1, 4000, 4000]);
  check('   ...and line_no follows the job card\'s order', svc.map((c) => c.binds[6]), [1, 2]);
  check('a part line carries its part number and price too',
    prt[0].binds.slice(0, 7), ['INV-0001', 'PRT-0001', 'Oil Filter (as sold)', 'OF-1', 1, 600, 600]);
  check('   ...with its own line numbering', prt[0].binds[7], 1);
  ok_('the job card\'s lines are read in stored order',
    /ORDER BY line_no, id/.test(db.find('FROM job_card_services').sql));
  ok_('   ...and the catalogue is never consulted',
    !db.find('FROM services WHERE') && !db.find('FROM parts WHERE'), db.sql);
}
{
  const db = stubDB({ jobServices: [], jobParts: [] });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  ok_('a job card with no lines still invoices -> 201', res.status === 201, `got ${res.status}`);
  check('   ...the batch is the invoice and the link', db.batches[0].length, 2);
}
{
  const db = stubDB({ jobParts: [{ part_id: null, name: 'Hand-cut bracket', part_no: 'M-1', qty: 2, unit_price: 150, total: 300 }] });
  await post({ jobCardId: 'JOB-0001' }, db);
  check('a manual part line keeps its null partId', db.find('INSERT INTO invoice_parts').binds[1], null);
}
{
  // Custom work on a job card is a service line with service_id NULL.
  const db = stubDB({ jobServices: [
    { service_id: 'SRV-0001', name: 'Brake pad change', qty: 1, unit_price: 1500, total: 1500 },
    { service_id: null, name: 'Leather work', qty: 1, unit_price: 3000, total: 3000 },
  ] });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  ok_('a job card with custom work invoices -> 201', res.status === 201, `got ${res.status}`);
  const svc = db.all('INSERT INTO invoice_services');
  check('   ...the custom work line is copied with its null serviceId, name and figures',
    svc[1].binds.slice(0, 7), ['INV-0001', null, 'Leather work', 1, 3000, 3000, 2]);
  check('   ...beside the catalogue line, unchanged', svc[0].binds.slice(0, 7),
    ['INV-0001', 'SRV-0001', 'Brake pad change', 1, 1500, 1500, 1]);
}

console.log('\n-- 5. An invoice never touches inventory --');
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001' }, db);
  ok_('no stock is read', !db.find('FROM parts '), db.sql);
  ok_('no stock is written', !db.find('UPDATE parts'), db.sql);
  ok_('no ledger row is written', !db.find('inventory_transactions'), db.sql);
  ok_('and the job card\'s status is never changed',
    !/status/.test(db.find('UPDATE job_cards').sql), db.find('UPDATE job_cards').sql);
}

console.log('\n-- 6. Eligibility, in the client\'s own order --');
{
  const db = stubDB({ job: null });
  const res = await post({ jobCardId: 'JOB-7777' }, db);
  check('an unknown job card -> 404', res.status, 404);
  check('   ...with the client\'s wording', (await bodyOf(res)).error.message, 'Job Card not found.');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ job: { ...JOB, existing_invoice_id: 'INV-0009' } });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  check('a job card that already has an invoice -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...wording', b.error.message, 'This Job Card already has an invoice.');
  check('   ...reason', b.error.reason, 'invoice_exists');
  check('   ...naming it', b.error.conflictsWith, 'INV-0009');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ job: { ...JOB, customer_found: null } });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  check('a job card whose customer is gone -> 409', res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'customer_missing');
}
{
  const db = stubDB({ job: { ...JOB, vehicle_found: null } });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  check('a job card whose vehicle is gone -> 409', res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'vehicle_missing');
}
for (const status of ['Received', 'Inspection', 'Waiting for Approval', 'In Progress', 'Waiting for Parts', 'Cancelled']) {
  const db = stubDB({ job: { ...JOB, status } });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  check(`a ${status} job card -> 409`, res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'job_card_not_invoiceable');
  check('   ...with the client\'s wording', b.error.message,
    `Job Card must be Completed or Delivered before invoicing (currently ${status}).`);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
for (const status of ['Completed', 'Delivered']) {
  const db = stubDB({ job: { ...JOB, status } });
  ok_(`a ${status} job card can be invoiced`, (await post({ jobCardId: 'JOB-0001' }, db)).status === 201);
}
for (const total of [0, -5, null]) {
  const db = stubDB({ job: { ...JOB, total, paid: 0 } });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  check(`a job card whose total is ${total} -> 409`, res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'nothing_to_invoice');
  check('   ...wording', b.error.message, 'This Job Card has no billable amount.');
}
{
  const db = stubDB();
  await post({ jobCardId: 'JOB-0001' }, db);
  ok_('the whole eligibility check is ONE query', !!db.find('AS existing_invoice_id'), db.sql);
  check('   ...and only one', db.all('AS existing_invoice_id').length, 1);
  ok_('   ...which reads the forward link and the reverse lookup together',
    /WHERE i\.id = j\.invoice_id/.test(db.find('AS existing_invoice_id').sql)
      && /i\.job_card_id = j\.id AND i\.status <> 'Void'/.test(db.find('AS existing_invoice_id').sql),
    db.find('AS existing_invoice_id').sql);
}
{
  const db = stubDB({ throwOnBatch: 'D1_ERROR: UNIQUE constraint failed: index \'ux_invoices_live_job_card\': SQLITE_CONSTRAINT' });
  const res = await post({ jobCardId: 'JOB-0001' }, db);
  check('a duplicate the check could not see -> 409, from the unique index', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'invoice_exists');
  ok_('   ...with no SQL leaked', !JSON.stringify(b).includes('SQLITE'), JSON.stringify(b));
}

console.log('\n-- 7. Server-owned fields are refused by name --');
for (const [field, value] of [
  ['id', 'INV-0009'], ['createdAt', '2020-01-01T00:00:00Z'], ['updatedAt', '2020-01-01T00:00:00Z'],
  ['customerId', 'CUS-0002'], ['vehicleId', 'VEH-0002'],
  ['services', []], ['partsUsed', []],
  ['labourCost', 1], ['discount', 1], ['taxRate', 1], ['subtotal', 1], ['tax', 1],
  ['total', 1], ['paid', 1], ['due', 1], ['status', 'Paid'],
]) {
  const db = stubDB();
  const res = await post({ jobCardId: 'JOB-0001', [field]: value }, db);
  check(`\`${field}\` -> 422`, res.status, 422);
  ok_('   ...names the field', !!(await bodyOf(res)).error.fields?.[field]);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await post({ jobCardId: 'JOB-0001', status: 'Void' });
  check('`status: Void` is refused too — voiding is its own operation', res.status, 422);
}
for (const [why, body] of [
  ['a missing jobCardId', {}],
  ['a null jobCardId', { jobCardId: null }],
  ['a blank jobCardId', { jobCardId: '   ' }],
  ['a jobCardId of the wrong type', { jobCardId: 7 }],
]) {
  const res = await post(body);
  check(`${why} -> 422`, res.status, 422);
}
{
  const res = await post('not json');
  check('a malformed body -> 400', res.status, 400);
  const res2 = await call('/api/invoices', { DB: stubDB() }, 'POST');
  check('no body at all -> 400', res2.status, 400);
}

/* ============================================================
   8. Update
   ============================================================ */
console.log('\n=== PUT /api/invoices/:id ===');
console.log('\n-- 8. Notes, and nothing else --');
{
  const db = stubDB();
  const res = await put({ notes: 'corrected reference' }, db);
  ok_('PUT -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const upd = db.find('UPDATE invoices SET notes');
  ok_('writes exactly one column, plus updated_at',
    /SET notes = \?2, updated_at = \?3\s+WHERE id = \?1/.test(upd.sql), upd.sql);
  check('   ...the note, trimmed', upd.binds[1], 'corrected reference');
  ok_('   ...and nothing financial is in the statement',
    !/(paid|due|total|subtotal|tax|discount|status)/.test(upd.sql.split('WHERE')[0]), upd.sql);
  ok_('   ...no batch is needed for one row', db.batches.length === 0);
}
for (const [field, value] of [
  ['paid', 1], ['due', 1], ['total', 1], ['subtotal', 1], ['tax', 1],
  ['discount', 1], ['taxRate', 1], ['labourCost', 1], ['status', 'Paid'],
  ['services', []], ['partsUsed', []], ['customerId', 'CUS-2'], ['vehicleId', 'VEH-2'],
  ['jobCardId', 'JOB-2'], ['date', '2026-01-01'], ['id', 'INV-2'], ['createdAt', 'x'],
]) {
  const db = stubDB();
  const res = await put({ [field]: value }, db);
  check(`editing \`${field}\` -> 422`, res.status, 422);
  ok_('   ...names the field', !!(await bodyOf(res)).error.fields?.[field]);
  ok_('   ...and nothing was written', !db.find('UPDATE invoices SET notes'), db.sql);
}
{
  const db = stubDB();
  const res = await put({}, db);
  check('an empty body -> 422', res.status, 422);
  const emptyBody = await bodyOf(res);
  ok_('   ...and says what CAN be edited',
    /Only `notes` can be edited/.test(emptyBody.error.message), emptyBody.error.message);
}
{
  const db = stubDB({ invoice: null });
  const res = await put({ notes: 'x' }, db);
  check('an unknown invoice -> 404', res.status, 404);
}
{
  const db = stubDB({ invoice: { ...INVOICE, status: 'Void' } });
  const res = await put({ notes: 'voided in error' }, db);
  ok_('a Void invoice\'s notes are still editable', res.status === 200, `got ${res.status}`);
}
{
  const res = await put({ notes: 'x' }, stubDB(), 'nope');
  check('a malformed id -> 400', res.status, 400);
  const bad = await put('not json', stubDB());
  check('a malformed body -> 400', bad.status, 400);
}

/* ============================================================
   9. Void — audit Finding 7
   ============================================================ */
console.log('\n=== POST /api/invoices/:id/void ===');
console.log('\n-- 9. The document is cancelled, the money is not --');
{
  const db = stubDB();
  const res = await voidIt(db);
  ok_('void -> 200', res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  check('exactly one batch', db.batches.length, 1);
  const sql = batchSql(db);
  check('   ...of three statements', sql.length, 3);

  ok_('the status UPDATE is first, and is the gate',
    /^\s*UPDATE invoices/.test(sql[0]) && /WHERE id = \?1 AND status <> 'Void'/.test(sql[0]), sql[0]);
  ok_('   ...and it writes NOTHING but the status and updated_at',
    /SET status = 'Void', updated_at = \?2/.test(sql[0]), sql[0]);
  ok_('   ...so paid and due stay frozen as the historical figures',
    !/paid/.test(sql[0]) && !/due/.test(sql[0]), sql[0]);

  const rel = db.find('UPDATE payments');
  ok_('one statement releases every linked payment', !!rel, db.sql);
  ok_('   ...clearing only the invoice link', /SET invoice_id  = NULL/.test(rel.sql), rel.sql);
  ok_('   ...inheriting the invoice\'s job card only where the payment has none',
    /job_card_id = COALESCE\(job_card_id, \?2\)/.test(rel.sql), rel.sql);
  check('   ...that job card', rel.binds[1], 'JOB-0001');
  ok_('   ...scoped to this invoice\'s ACTIVE payments',
    /WHERE invoice_id = \?1/.test(rel.sql) && /AND status <> 'Void'/.test(rel.sql), rel.sql);
  ok_('   ...leaving a Void payment exactly as it is, link included',
    /status <> 'Void'/.test(rel.sql), rel.sql);
  // Assignments only: `updated_at` contains the letters of `date`, and it is
  // the one column beyond the two links that a release is allowed to write.
  ok_('   ...and assigning no amount, date, method or note',
    !/\b(amount|date|method|notes)\s*=/.test(rel.sql.split('WHERE')[0]), rel.sql);
  ok_('   ...nor the payment\'s status or customer',
    !/\b(status|customer_id)\s*=/.test(rel.sql.split('WHERE')[0]), rel.sql);
  ok_('   ...conditional on the gate having landed',
    /\(SELECT status FROM invoices WHERE id = \?1\) = 'Void'/.test(rel.sql), rel.sql);

  const unlink = db.find('UPDATE job_cards');
  ok_('the job card is unlinked', !!unlink, db.sql);
  ok_('   ...only if it still points at THIS invoice',
    /WHERE id = \?2 AND invoice_id = \?1/.test(unlink.sql), unlink.sql);
  ok_('   ...and only if the gate landed',
    /\(SELECT status FROM invoices WHERE id = \?1\) = 'Void'/.test(unlink.sql), unlink.sql);
}
{
  const db = stubDB();
  const b = await bodyOf(await voidIt(db));
  check('the response reports how many payments were released', b.released, 1);
  ok_('   ...alongside the invoice record', b.data?.id === 'INV-0001', JSON.stringify(b).slice(0, 160));
}
{
  const db = stubDB({ invoice: { ...INVOICE, job_card_id: null } });
  const res = await voidIt(db);
  ok_('an invoice with no job card still voids', res.status === 200, `got ${res.status}`);
  check('   ...and skips the unlink entirely', db.batches[0].length, 2);
  check('   ...so a payment with no job card inherits nothing',
    db.find('UPDATE payments').binds[1], null);
}
{
  const db = stubDB({ invoice: { ...INVOICE, status: 'Void' } });
  const res = await voidIt(db);
  check('an invoice that is already void -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...wording', b.error.message, 'Invoice is already void.');
  check('   ...reason', b.error.reason, 'invoice_void');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ invoice: null });
  const res = await voidIt(db);
  check('an unknown invoice -> 404', res.status, 404);
  check('   ...with the client\'s wording', (await bodyOf(res)).error.message, 'Invoice not found.');
}
{
  const db = stubDB({ changes: [0, 0, 0] });
  const res = await voidIt(db);
  check('a gate that matched nothing -> 409', res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'concurrent_modification');
}
{
  const db = stubDB();
  const res = await voidIt(db, undefined);
  ok_('void takes no body at all', res.status === 200, `got ${res.status}`);
  const db2 = stubDB();
  ok_('   ...and an empty object is fine too', (await voidIt(db2, {})).status === 200);
}
for (const [field, value] of [['status', 'Void'], ['paid', 0], ['due', 0], ['releasePayments', true]]) {
  const res = await voidIt(stubDB(), { [field]: value });
  check(`void with a \`${field}\` field -> 422`, res.status, 422);
}
{
  const res = await voidIt(stubDB(), 'not json');
  check('a malformed void body -> 400', res.status, 400);
  const badId = await voidIt(stubDB(), undefined, 'nope');
  check('a malformed id -> 400', badId.status, 400);
}
for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/invoices/INV-0001/void', { DB: stubDB() }, m,
    m === 'GET' ? undefined : {});
  check(`${m} on the void path -> 405`, res.status, 405);
  check('   ...Allow names POST only', res.headers.get('allow'), 'POST');
}

/* ============================================================
   10. Delete
   ============================================================ */
console.log('\n=== DELETE /api/invoices/:id ===');
console.log('\n-- 10. Only a Void invoice that collected nothing --');
for (const status of ['Unpaid', 'Partial', 'Paid']) {
  const db = stubDB({ invoice: { ...INVOICE, status, paid: 0 } });
  const res = await del(db);
  check(`deleting a ${status} invoice -> 409`, res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'invoice_not_void');
  ok_('   ...telling the caller to void it first',
    /Void it first/.test(b.error.message), b.error.message);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ invoice: { ...INVOICE, status: 'Void', paid: 3000 } });
  const res = await del(db);
  check('deleting a Void invoice that collected money -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'invoice_has_payments');
  check('   ...reporting the frozen figure the guard turns on', b.error.paid, 3000);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ invoice: { ...INVOICE, status: 'Void', paid: 0 } });
  const res = await del(db);
  check('deleting a Void invoice that collected nothing -> 200', res.status, 200);
  check('   ...reporting what went', (await bodyOf(res)).data, { id: 'INV-0001', deleted: true });
  const sql = batchSql(db);
  check('   ...in one batch of two statements', sql.length, 2);
  ok_('   ...unlinking the job card first', /UPDATE job_cards/.test(sql[0]), sql[0]);
  ok_('   ...only where it points at THIS invoice', /WHERE invoice_id = \?1/.test(sql[0]), sql[0]);
  ok_('   ...then deleting the invoice', /DELETE FROM invoices/.test(sql[1]), sql[1]);
  ok_('   ...with no statement for the cascading line tables',
    !sql.some((s) => /invoice_services|invoice_parts/.test(s)), sql);
  ok_('   ...and no inventory touched', !db.find('UPDATE parts') && !db.find('inventory_transactions'));
}
{
  const db = stubDB({ invoice: null });
  check('an unknown invoice -> 404', (await del(db)).status, 404);
}
{
  const db = stubDB({
    invoice: { ...INVOICE, status: 'Void', paid: 0 },
    throwOnBatch: 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT',
  });
  const res = await del(db);
  check('a payment still pointing at it -> 409, from the RESTRICT foreign key', res.status, 409);
  ok_('   ...with no SQL leaked', !JSON.stringify(await bodyOf(res)).includes('SQLITE'));
}
{
  const db = stubDB({ invoice: { ...INVOICE, status: 'Void', paid: 0 }, changes: [1, 0] });
  check('a row that vanished between the guard and the delete -> 404', (await del(db)).status, 404);
}
{
  check('a malformed id -> 400', (await del(stubDB(), 'nope')).status, 400);
}

/* ============================================================
   11. The routing surface
   ============================================================ */
console.log('\n-- 11. Methods and bindings --');
for (const [path, method, body] of [
  ['/api/invoices', 'POST', { jobCardId: 'JOB-0001' }],
  ['/api/invoices/INV-0001', 'PUT', { notes: 'x' }],
  ['/api/invoices/INV-0001', 'DELETE', undefined],
  ['/api/invoices/INV-0001/void', 'POST', {}],
]) {
  const res = await call(path, {}, method, body);
  check(`${method} ${path} without a binding -> 503`, res.status, 503);
  check('   ...code', (await bodyOf(res)).error.code, 'no_database');
}
{
  const routes = (await (await call('/api/health', { DB: stubDB() }, 'GET')).json()).data.routes;
  ok_('health advertises all four new routes',
    ['POST /api/invoices', 'PUT /api/invoices/:id', 'DELETE /api/invoices/:id',
      'POST /api/invoices/:id/void'].every((r) => routes.includes(r)), routes);
  check('   ...and the registry is 188 routes', routes.length, 188);
  ok_('   ...with no PUT or DELETE on the void path',
    !routes.includes('PUT /api/invoices/:id/void')
      && !routes.includes('DELETE /api/invoices/:id/void'), routes);
  // Payments gained their own writes in C-8; what matters here is that the
  // invoice routes did not quietly acquire any of them.
  ok_('   ...and no invoice route was added beyond these four',
    routes.filter((r) => r.includes('/api/invoices')).length === 6, routes);
}
{
  const res = await call('/api/invoices/INV-0001/release', { DB: stubDB() }, 'POST', {});
  ok_('an action the collection does not declare is not routed',
    res.status === 400 || res.status === 405, `got ${res.status}`);
}

console.log(`\nInvoice writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
