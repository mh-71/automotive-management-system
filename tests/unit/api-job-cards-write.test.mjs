/* POST / PUT / DELETE /api/job-cards — unit tests against the REAL Worker
   handlers with a stubbed D1 binding.

   A job card is the highest-risk write in this API: one request can move the
   parent row, two child line tables, a part's stock, the inventory ledger and
   an appointment link. So, as with C-4, the weight here is on the SQL that
   would be sent, not only on what the route answers:

     - every mutation goes in ONE env.DB.batch(), so a shortage on the third
       part undoes the first two AND the job card itself;
     - totals are recomputed from the lines and never taken from the body;
     - a create writes no stock at all, because a new job card is 'Received'
       and stock only moves when a job enters 'In Progress';
     - an edit reconciles against the LEDGER, not against the card's own
       lines, and only for the two statuses where stock has already moved;
     - prev_stock / new_stock are read from the live row inside the INSERT,
       never computed in JavaScript and never bound;
     - status, appointmentId, invoiceId, completedAt and actualDelivery are
       immutable here — changeStatus() and the invoice phase own them.

   Whether the batch really rolls back, whether two concurrent edits really
   settle correctly, and whether a repeated edit really deducts once are D1's
   behaviour: proved against a real database in the integration suite. */
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

/* ---------- the stored job card the PUT/DELETE tests edit ---------- */

const STORED = {
  id: 'JOB-0001',
  customer_id: 'CUS-0001', vehicle_id: 'VEH-0001', mechanic_id: 'MEC-0001',
  appointment_id: null, invoice_id: null,
  date: '2026-09-10', est_delivery: null, actual_delivery: null, completed_at: null,
  status: 'Received', priority: 'normal',
  mileage: 52000, mileage_out: null, fuel_level: 'half',
  complaint: 'AC cooling weak', inspection: '', diagnosis: '',
  technician_notes: '', recommendations: '', condition_notes: '', notes: '',
  inspection_checklist: '{}',
  labour_hours: null, labour_rate: null, labour_cost: 500,
  discount: 0, tax_rate: 0,
  subtotal: 1500, tax: 0, total: 1500, paid: 0, due: 1500,
  created_at: '2026-09-10T09:00:00.000Z', updated_at: null,
};
const STORED_SERVICE_ROWS = [{
  job_card_id: 'JOB-0001', service_id: 'SRV-0001', name: 'Oil Change',
  qty: 1, unit_price: 1000, total: 1000,
}];
const STORED_PART_ROWS = [{
  job_card_id: 'JOB-0001', part_id: 'PRT-0001', name: 'Oil Filter',
  part_no: 'OF-1', qty: 1, unit_price: 0, total: 0,
}];

/**
 * `job`        the stored parent row, or null for a 404.
 * `svcRows`/`partRows`  the stored child lines.
 * `precheck`   what the create's one application-rule query answers.
 * `stockRows`  what the reconciliation lookup answers: live stock + issued.
 * `deleteRow`  what the delete guard query answers.
 */
function stubDB({
  job = STORED,
  svcRows = STORED_SERVICE_ROWS,
  partRows = STORED_PART_ROWS,
  precheck = {
    vehicle_owner: 'CUS-0001',
    appt_customer: null, appt_vehicle: null, appt_job_card: null, appt_found: 0,
  },
  stockRows = [],
  deleteRow = undefined,
  owner = { customer_id: 'CUS-0001' },
  counter = { last_value: 1, prefix: 'JOB' },
  throwOnBatch = null,
  deleteChanges = [1, 1],
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
          if (sql.includes('id_counters')) {
            return sql.includes("'inventoryTransactions'") || entry.binds?.[0] === 'inventoryTransactions'
              ? { last_value: 7, prefix: 'STK' }
              : counter;
          }
          if (sql.includes('FROM job_cards j')) {
            return deleteRow === undefined
              ? (job ? { status: job.status, invoice_id: null } : null)
              : deleteRow;
          }
          if (sql.includes('FROM job_cards')) return job;
          if (sql.includes('SELECT customer_id FROM vehicles WHERE id = ?1')) return owner;
          if (sql.includes('AS vehicle_owner')) return precheck;
          return null;
        },
        async all() {
          // The health route reads schema metadata; it is used below only to
          // read back the advertised route list.
          if (sql.includes('sqlite_master')) return { results: [{ name: 'customers' }] };
          if (sql.includes('FROM job_card_services')) return { results: svcRows };
          if (sql.includes('FROM job_card_parts')) return { results: partRows };
          if (sql.includes('FROM parts p')) return { results: stockRows };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(statements) {
      batches.push(statements);
      if (throwOnBatch) throw new Error(throwOnBatch);
      // The delete batch is the only one whose meta.changes the route reads.
      return statements.map((_, i) => ({ success: true, meta: { changes: deleteChanges[i] ?? 1 } }));
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
const post = (body, db) => call('/api/job-cards', { DB: db ?? stubDB() }, 'POST', body);
const put = (body, db, id = 'JOB-0001') =>
  call(`/api/job-cards/${id}`, { DB: db ?? stubDB() }, 'PUT', body);
const del = (db, id = 'JOB-0001') =>
  call(`/api/job-cards/${id}`, { DB: db ?? stubDB() }, 'DELETE');

/** A minimally valid create body. */
const VALID = {
  customerId: 'CUS-0001', vehicleId: 'VEH-0001', mechanicId: 'MEC-0001',
  date: '2026-09-18', complaint: 'Engine noise',
  services: [{ serviceId: 'SRV-0001', name: 'Oil Change', qty: 1, unitPrice: 1000 }],
};

/** The statements a batch would send, as SQL text. */
const batchSql = (db, n = 0) => {
  const statements = db.batches[n] ?? [];
  const written = db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql));
  return written.slice(written.length - statements.length).map((c) => c.sql);
};
/** The bound arguments of the batch's statements, in order. */
const batchBinds = (db, n = 0) => {
  const statements = db.batches[n] ?? [];
  const written = db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql));
  return written.slice(written.length - statements.length).map((c) => c.binds);
};
const bodyOf = async (res) => res.json();

/* ============================================================
   1. Create — the happy path
   ============================================================ */
console.log('\n=== POST /api/job-cards ===');
console.log('\n-- 1. A valid create --');
{
  const db = stubDB();
  const res = await post(VALID, db);
  ok_('POST -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await bodyOf(res);
  ok_('   ...returns a job card record', b.data && b.data.id === 'JOB-0001', JSON.stringify(b));
  ok_('   ...no paging metadata', !('count' in b) && !('total' in b));
  ok_('   ...with both line arrays', Array.isArray(b.data.services) && Array.isArray(b.data.partsUsed));
  ok_('   ...named partsUsed, never parts', 'partsUsed' in b.data && !('parts' in b.data));

  ok_('allocates a JOB id through id_counters', !!db.find('id_counters'), db.sql);
  check('   ...from the jobCards counter', db.find('id_counters').binds, ['jobCards']);
  check('exactly one batch', db.batches.length, 1);
  const sql = batchSql(db);
  ok_('the parent INSERT is first', /^\s*INSERT INTO job_cards/.test(sql[0]), sql[0]);
  check('   ...followed by one statement per line', sql.length, 2);
  ok_('   ...the second being the service line', /INSERT INTO job_card_services/.test(sql[1]), sql[1]);
}

console.log('\n-- 2. A create never moves stock --');
for (const [label, partsUsed] of [
  ['with no parts', []],
  ['with a manual part line', [{ name: 'Hand-cut bracket', qty: 2, unitPrice: 150 }]],
  ['with an INVENTORY part line', [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 3, unitPrice: 500 }]],
]) {
  const db = stubDB();
  const res = await post({ ...VALID, partsUsed }, db);
  ok_(`201 ${label}`, res.status === 201, `got ${res.status}`);
  ok_(`   ...no ledger row ${label}`, !db.find('INSERT INTO inventory_transactions'), db.sql);
  ok_(`   ...no stock change ${label}`, !db.find('UPDATE parts'), db.sql);
  ok_(`   ...and no stock was even read ${label}`, !db.find('FROM parts p'), db.sql);
}

console.log('\n-- 3. Totals are computed, never taken from the body --');
{
  const db = stubDB();
  await post({
    ...VALID,
    services: [{ serviceId: 'SRV-0001', name: 'Oil Change', qty: 2, unitPrice: 1000 }],
    partsUsed: [{ partId: 'PRT-0001', name: 'Filter', qty: 3, unitPrice: 200 }],
    labourHours: 2, labourRate: 500, labourCost: 99999,
    discount: 100, taxRate: 10, paid: 500,
  }, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  const at = (col) => insert.binds[names.indexOf(col)];
  // services 2000 + parts 600 + labour (2 x 500, which beats the 99999 sent)
  check('labour_cost is hours x rate, not the value sent', at('labour_cost'), 1000);
  check('subtotal = services + parts + labour', at('subtotal'), 3600);
  check('discount is stored as given when within the subtotal', at('discount'), 100);
  check('tax = round((subtotal - discount) x rate / 100)', at('tax'), 350);
  check('total = subtotal - discount + tax', at('total'), 3850);
  check('paid is stored as sent — it is an input, not a derived figure', at('paid'), 500);
  check('due = total - paid', at('due'), 3350);
  check('status is always Received on create', at('status'), 'Received');
  check('invoice_id starts null', at('invoice_id'), null);
  check('completed_at starts null', at('completed_at'), null);
  check('actual_delivery starts null', at('actual_delivery'), null);
}
{
  // A line's own `total` is ignored: qty x unitPrice is the only arithmetic.
  const db = stubDB();
  await post({
    ...VALID,
    services: [{ serviceId: 'SRV-0001', name: 'Oil Change', qty: 2, unitPrice: 1000, total: 1 }],
  }, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  check('a lying line total cannot change the bill', insert.binds[names.indexOf('subtotal')], 2000);
  const line = db.find('INSERT INTO job_card_services');
  check('   ...and the stored line total is recomputed too', line.binds[5], 2000);
}
{
  // computeTotals() rounds the tax and nothing else.
  const db = stubDB();
  await post({ ...VALID, services: [{ serviceId: 'SRV-0001', name: 'X', qty: 1, unitPrice: 333 }], taxRate: 7.5 }, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  check('tax is rounded to whole taka', insert.binds[names.indexOf('tax')], 25);
  check('   ...and the total carries the rounded tax', insert.binds[names.indexOf('total')], 358);
}

console.log('\n-- 4. Server-owned fields are refused by name --');
for (const [field, value] of [
  ['id', 'JOB-0009'], ['createdAt', '2020-01-01T00:00:00Z'], ['updatedAt', '2020-01-01T00:00:00Z'],
  ['subtotal', 1], ['tax', 1], ['total', 1], ['due', 1],
  ['prevStock', 1], ['newStock', 1],
]) {
  const db = stubDB();
  const res = await post({ ...VALID, [field]: value }, db);
  check(`\`${field}\` -> 422`, res.status, 422);
  const b = await bodyOf(res);
  ok_(`   ...names the field`, !!b.error.fields?.[field], JSON.stringify(b.error));
  ok_(`   ...and nothing was written`, db.batches.length === 0);
}
{
  const db = stubDB();
  const res = await post({ ...VALID, paid: 0 }, db);
  ok_('`paid` is NOT server-owned — it is a form input', res.status === 201, `got ${res.status}`);
}

console.log('\n-- 5. The lifecycle fields are not set here --');
{
  const res = await post({ ...VALID, status: 'Received' });
  ok_("status 'Received' is accepted (it is what a create stores)", res.status === 201, `got ${res.status}`);
}
for (const status of ['In Progress', 'Completed', 'Cancelled', 'Delivered']) {
  const db = stubDB();
  const res = await post({ ...VALID, status }, db);
  check(`status '${status}' on create -> 422`, res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...and says a new job card starts as Received',
    /starts as Received/.test(b.error.fields?.status ?? ''), JSON.stringify(b.error));
}
{
  const res = await post({ ...VALID, status: 'Nonsense' });
  check('an unknown status -> 422', res.status, 422);
}
for (const [field, value] of [
  ['invoiceId', 'INV-0001'], ['completedAt', '2026-01-01T00:00:00Z'], ['actualDelivery', '2026-01-01'],
]) {
  const res = await post({ ...VALID, [field]: value });
  check(`\`${field}\` on create -> 422`, res.status, 422);
}
for (const [field, value] of [
  ['invoiceId', null], ['completedAt', null], ['actualDelivery', null], ['actualDelivery', ''],
]) {
  const res = await post({ ...VALID, [field]: value });
  ok_(`\`${field}\`: ${JSON.stringify(value)} is accepted as the value it gets anyway`,
    res.status === 201, `got ${res.status}`);
}

/* ============================================================
   6. Create — validation
   ============================================================ */
console.log('\n-- 6. Required fields --');
for (const field of ['customerId', 'vehicleId', 'mechanicId', 'date', 'complaint']) {
  const body = { ...VALID };
  delete body[field];
  const db = stubDB();
  const res = await post(body, db);
  check(`missing \`${field}\` -> 422`, res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...names the field', !!b.error.fields?.[field], JSON.stringify(b.error));
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await post({ ...VALID, complaint: '   ' });
  check('a blank complaint -> 422', res.status, 422);
}
{
  const res = await post({ ...VALID, date: '2026-02-31' });
  check('an impossible date -> 422', res.status, 422);
  const res2 = await post({ ...VALID, date: '18/09/2026' });
  check('a non-ISO date -> 422', res2.status, 422);
}

console.log('\n-- 7. The rules the schema cannot express --');
{
  const db = stubDB({ precheck: { vehicle_owner: 'CUS-0002', appt_found: 0, appt_customer: null, appt_vehicle: null, appt_job_card: null } });
  const res = await post(VALID, db);
  check('a vehicle owned by someone else -> 422', res.status, 422);
  const b = await bodyOf(res);
  check('   ...with the form\'s own wording', b.error.fields.vehicleId,
    'Selected vehicle does not belong to this customer.');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB();
  await post(VALID, db);
  const q = db.find('AS vehicle_owner');
  ok_('the ownership and appointment rules are ONE query', !!q, db.sql);
  ok_('   ...and there is no lookup per reference',
    !db.find('FROM customers WHERE') && !db.find('FROM mechanics WHERE'), db.sql);
}
{
  const db = stubDB({ precheck: { vehicle_owner: 'CUS-0001', appt_found: 0, appt_customer: null, appt_vehicle: null, appt_job_card: null } });
  const res = await post({ ...VALID, appointmentId: 'APT-0001' }, db);
  check('an appointment that does not exist -> 422', res.status, 422);
  const b = await bodyOf(res);
  check('   ...with the form\'s wording', b.error.fields.appointmentId, 'Selected appointment no longer exists.');
}
{
  const db = stubDB({ precheck: { vehicle_owner: 'CUS-0001', appt_found: 1, appt_customer: 'CUS-0002', appt_vehicle: 'VEH-0001', appt_job_card: null } });
  const res = await post({ ...VALID, appointmentId: 'APT-0001' }, db);
  check('an appointment for another customer -> 422', res.status, 422);
  check('   ...wording', (await bodyOf(res)).error.fields.appointmentId,
    'Appointment belongs to a different customer.');
}
{
  const db = stubDB({ precheck: { vehicle_owner: 'CUS-0001', appt_found: 1, appt_customer: 'CUS-0001', appt_vehicle: 'VEH-0002', appt_job_card: null } });
  const res = await post({ ...VALID, appointmentId: 'APT-0001' }, db);
  check('an appointment for another vehicle -> 422', res.status, 422);
  check('   ...wording', (await bodyOf(res)).error.fields.appointmentId,
    'Appointment is for a different vehicle.');
}
{
  const db = stubDB({ precheck: { vehicle_owner: 'CUS-0001', appt_found: 1, appt_customer: 'CUS-0001', appt_vehicle: 'VEH-0001', appt_job_card: 'JOB-0007' } });
  const res = await post({ ...VALID, appointmentId: 'APT-0001' }, db);
  check('an appointment that already has a job card -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'appointment_already_claimed');
  check('   ...and names it', b.error.conflictsWith, 'JOB-0007');
  ok_('   ...nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ precheck: { vehicle_owner: 'CUS-0001', appt_found: 1, appt_customer: 'CUS-0001', appt_vehicle: 'VEH-0001', appt_job_card: null } });
  const res = await post({ ...VALID, appointmentId: 'APT-0001' }, db);
  ok_('a free, matching appointment -> 201', res.status === 201, `got ${res.status}`);
  const link = db.find('UPDATE appointments');
  ok_('   ...and the back-link is in the same batch', !!link && db.batches[0].length === 3, db.sql);
  ok_('   ...guarded so it can only claim an unlinked appointment',
    /job_card_id IS NULL/.test(link.sql), link.sql);
  check('   ...binding the appointment and the new job card', link.binds.slice(0, 2), ['APT-0001', 'JOB-0001']);
  ok_("   ...and it does NOT touch the appointment's status", !/status/.test(link.sql), link.sql);
}
{
  const db = stubDB();
  await post(VALID, db);
  ok_('no appointment, no appointments statement', !db.find('UPDATE appointments'), db.sql);
}

console.log('\n-- 8. A job card has to record something --');
{
  const db = stubDB();
  const res = await post({ ...VALID, services: [], partsUsed: [] }, db);
  check('nothing at all -> 422', res.status, 422);
  check('   ...with the form\'s wording', (await bodyOf(res)).error.fields.services,
    'Add at least one service, part, or labour entry.');
}
for (const [label, extra] of [
  ['a part line alone', { services: [], partsUsed: [{ name: 'Bracket', qty: 1, unitPrice: 10 }] }],
  ['labour alone', { services: [], partsUsed: [], labourCost: 500 }],
  ['hours x rate alone', { services: [], partsUsed: [], labourHours: 2, labourRate: 250 }],
]) {
  const res = await post({ ...VALID, ...extra });
  ok_(`${label} is enough -> 201`, res.status === 201, `got ${res.status}`);
}
{
  // :101 — hours alone, with no rate, is not labour.
  const res = await post({ ...VALID, services: [], partsUsed: [], labourHours: 2 });
  check('hours with no rate is not an entry -> 422', res.status, 422);
}

console.log('\n-- 9. Line items --');
{
  const db = stubDB();
  await post({
    ...VALID,
    services: [
      { serviceId: 'SRV-0001', name: 'A', qty: 1, unitPrice: 100 },
      { serviceId: '', name: '— Select service —', qty: 1, unitPrice: 5 },
      { serviceId: 'SRV-0002', name: 'B', qty: 2, unitPrice: 50 },
    ],
    partsUsed: [
      { partId: 'PRT-0001', name: 'P1', partNo: 'X1', qty: 1, unitPrice: 10 },
      { name: '', qty: 1, unitPrice: 9 },
      { name: 'manual', qty: 1, unitPrice: 20 },
    ],
  }, db);
  const svc = db.all('INSERT INTO job_card_services');
  const prt = db.all('INSERT INTO job_card_parts');
  check('a catalogue row left unpicked (serviceId \'\') is dropped, not rejected -- even with a name', svc.length, 2);
  check('a part line with no name and no partId is dropped too', prt.length, 2);
  check('line_no is 1-based over the surviving service lines',
    svc.map((c) => c.binds[6]), [1, 2]);
  check('   ...and over the surviving part lines', prt.map((c) => c.binds[7]), [1, 2]);
  check('a service line stores its snapshot name and price',
    svc[0].binds.slice(0, 6), ['JOB-0001', 'SRV-0001', 'A', 1, 100, 100]);
  check('a part line stores partId, name, partNo and its snapshot price',
    prt[0].binds.slice(0, 7), ['JOB-0001', 'PRT-0001', 'P1', 'X1', 1, 10, 10]);
  check('a manual part line stores a null partId', prt[1].binds[1], null);
}
for (const [label, lines] of [
  ['qty 0', { services: [{ serviceId: 'SRV-0001', name: 'A', qty: 0, unitPrice: 10 }] }],
  ['a missing qty', { services: [{ serviceId: 'SRV-0001', name: 'A', unitPrice: 10 }] }],
  ['a negative qty', { services: [{ serviceId: 'SRV-0001', name: 'A', qty: -1, unitPrice: 10 }] }],
  ['a negative price', { services: [{ serviceId: 'SRV-0001', name: 'A', qty: 1, unitPrice: -1 }] }],
]) {
  const db = stubDB();
  const res = await post({ ...VALID, ...lines }, db);
  check(`a service line with ${label} -> 422`, res.status, 422);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await post({ ...VALID, partsUsed: [{ name: 'P', qty: 0, unitPrice: 10 }] });
  check('a part line with qty 0 -> 422', res.status, 422);
}
{
  const res = await post({ ...VALID, partsUsed: [{ partId: 'PRT-0001', qty: 1, unitPrice: 10 }] });
  check('a part line with a partId but no name -> 422, never a silent drop', res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...and says why', /required for an inventory part line/.test(b.error.fields.partsUsed), JSON.stringify(b.error));
}
{
  const res = await post({ ...VALID, services: 'nope' });
  check('services that is not an array -> 422', res.status, 422);
  const res2 = await post({ ...VALID, partsUsed: [1, 2] });
  check('a line that is not an object -> 422', res2.status, 422);
  const res3 = await post({ ...VALID, services: Array.from({ length: 201 }, () => ({ serviceId: 'S', name: 'x', qty: 1, unitPrice: 1 })) });
  check('more than 200 lines -> 422', res3.status, 422);
}
{
  // Fractional quantities are real: the column is REAL and the form allows them.
  const db = stubDB();
  const res = await post({ ...VALID, services: [{ serviceId: 'SRV-0001', name: 'A', qty: 1.5, unitPrice: 200 }] }, db);
  ok_('a fractional qty is accepted', res.status === 201, `got ${res.status}`);
  check('   ...and multiplies out', db.find('INSERT INTO job_card_services').binds[5], 300);
}

console.log('\n-- 9b. Custom work: a service line with serviceId null --');
const CUSTOM = { serviceId: null, name: 'Leather work', qty: 1, unitPrice: 3000 };
const jobInsert = (db) => {
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  return (col) => insert.binds[names.indexOf(col)];
};
{
  const db = stubDB();
  const res = await post({ ...VALID, services: [{ ...CUSTOM, total: 1 }] }, db);
  check('custom work alone is a valid job card -> 201', res.status, 201);
  const line = db.find('INSERT INTO job_card_services');
  check('   ...stored with service_id NULL, its own name, qty, price and a recomputed total',
    line.binds.slice(0, 7), ['JOB-0001', null, 'Leather work', 1, 3000, 3000, 1]);
  check('   ...and the bill is built from it', jobInsert(db)('subtotal'), 3000);
  ok_('   ...without any catalogue lookup', !/FROM services/.test(db.sql), db.sql);
  ok_('   ...and without creating a catalogue service', !/INSERT INTO services/.test(db.sql), db.sql);
}
{
  const db = stubDB();
  const { serviceId, ...noKey } = CUSTOM;
  await post({ ...VALID, services: [{ ...noKey, name: '  Denting  ', qty: 2, unitPrice: 750 }] }, db);
  const line = db.find('INSERT INTO job_card_services');
  check('an absent serviceId with a name is custom work too, name trimmed, qty x price',
    [line.binds[1], line.binds[2], line.binds[3], line.binds[5]], [null, 'Denting', 2, 1500]);
}
{
  const db = stubDB();
  const res = await post({ ...VALID, services: [{ ...CUSTOM, unitPrice: 0 }] }, db);
  check('a custom work price of 0 is accepted, as for a catalogue line', res.status, 201);
  check('   ...and stored as 0', db.find('INSERT INTO job_card_services').binds[5], 0);
}
for (const [label, line] of [
  ['qty 0', { ...CUSTOM, qty: 0 }],
  ['a negative qty', { ...CUSTOM, qty: -2 }],
  ['a missing qty', { serviceId: null, name: 'Painting', unitPrice: 10 }],
  ['a negative price', { ...CUSTOM, unitPrice: -1 }],
  ['a price that is not finite', { ...CUSTOM, unitPrice: 'Infinity' }],
  ['a name over 200 characters', { ...CUSTOM, name: 'x'.repeat(201) }],
]) {
  const db = stubDB();
  const res = await post({ ...VALID, services: [line] }, db);
  check(`custom work with ${label} -> 422`, res.status, 422);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await post({ ...VALID, services: [{ ...CUSTOM, name: 'x'.repeat(200) }] });
  check('a 200-character custom work name is accepted', res.status, 201);
}
for (const [label, name] of [['a blank name', ''], ['a whitespace-only name', '   \t ']]) {
  const db = stubDB();
  const res = await post({ ...VALID, services: [{ ...CUSTOM, name }] }, db);
  check(`custom work with ${label} is never stored -- alone it leaves nothing -> 422`, res.status, 422);
  check('   ...with the "record something" wording', (await bodyOf(res)).error.fields.services,
    'Add at least one service, part, or labour entry.');
  const db2 = stubDB();
  await post({ ...VALID, services: [VALID.services[0], { ...CUSTOM, name }] }, db2);
  check(`   ...and beside a catalogue line, ${label} row is dropped`, db2.all('INSERT INTO job_card_services').length, 1);
}
{
  const db = stubDB();
  await post({ ...VALID, services: [{ serviceId: '   ', name: 'Leather work', qty: 1, unitPrice: 3000 }] }, db);
  check('a blank-string serviceId never becomes custom work', db.all('INSERT INTO job_card_services').length, 0);
}
{
  const res = await post({ ...VALID, services: [{ ...CUSTOM, serviceId: 12 }] });
  check('a serviceId that is not a string is still 422', res.status, 422);
}
{
  // catalogue + custom, several customs, parts, labour, discount and tax together
  const db = stubDB();
  const res = await post({
    ...VALID,
    services: [
      { serviceId: 'SRV-0001', name: 'Brake pad change', qty: 1, unitPrice: 1500 },
      { serviceId: 'SRV-0002', name: 'Engine oil change', qty: 1, unitPrice: 500 },
      { serviceId: 'SRV-0003', name: 'Suspension open and fitting', qty: 1, unitPrice: 5000 },
      { ...CUSTOM },
      { serviceId: null, name: 'Welding', qty: 2, unitPrice: 250 },
    ],
    partsUsed: [{ partId: 'PRT-0001', name: 'Filter', qty: 2, unitPrice: 300 }],
    labourHours: 2, labourRate: 400, discount: 1000, taxRate: 5,
  }, db);
  check('a mixed job card -> 201', res.status, 201);
  const svc = db.all('INSERT INTO job_card_services');
  check('every line is kept, in the order sent', svc.map((c) => [c.binds[1], c.binds[2], c.binds[6]]), [
    ['SRV-0001', 'Brake pad change', 1], ['SRV-0002', 'Engine oil change', 2],
    ['SRV-0003', 'Suspension open and fitting', 3], [null, 'Leather work', 4], [null, 'Welding', 5],
  ]);
  const at = jobInsert(db);
  // services 7000 + custom 3000 + 500, parts 600, labour 800 = 11900
  check('custom work counts in the subtotal like any service', at('subtotal'), 11900);
  check('   ...the discount applies to it', at('discount'), 1000);
  check('   ...and the tax: round((11900 - 1000) x 5%)', at('tax'), 545);
  check('   ...giving the total', at('total'), 11445);
}
{
  const db = stubDB();
  await put({ services: [VALID.services[0], { ...CUSTOM, name: 'Leather work (edited)', qty: 2 }] }, db);
  const svc = db.all('INSERT INTO job_card_services');
  ok_('an edit rewrites the set with the custom line in it', !!db.find('DELETE FROM job_card_services'), db.sql);
  check('   ...custom line kept with service_id NULL and its new values',
    svc.map((c) => c.binds.slice(1, 7)), [['SRV-0001', 'Oil Change', 1, 1000, 1000, 1], [null, 'Leather work (edited)', 2, 3000, 6000, 2]]);
  const db2 = stubDB({ svcRows: [...STORED_SERVICE_ROWS, { job_card_id: 'JOB-0001', service_id: null, name: 'Leather work', qty: 1, unit_price: 3000, total: 3000 }] });
  await put({ services: [VALID.services[0]] }, db2);
  check('   ...and removing it leaves only the catalogue line', db2.all('INSERT INTO job_card_services').length, 1);
}

console.log('\n-- 10. The inspection checklist --');
{
  const db = stubDB();
  await post({ ...VALID, inspectionChecklist: { Brakes: { state: 'Attention', note: 'pads at 20%' } } }, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  check('stored as JSON text', insert.binds[names.indexOf('inspection_checklist')],
    '{"Brakes":{"state":"Attention","note":"pads at 20%"}}');
}
{
  const db = stubDB();
  await post(VALID, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  check('absent means no checklist, not an empty one',
    insert.binds[names.indexOf('inspection_checklist')], null);
}
for (const [label, value] of [
  ['an array', ['Brakes']],
  ['a string', 'Brakes: ok'],
  ['a value that is not an object', { Brakes: 'ok' }],
  ['an unknown state', { Brakes: { state: 'Broken' } }],
  ['an extra field', { Brakes: { state: 'OK', severity: 9 } }],
  ['a blank item name', { '  ': { state: 'OK' } }],
]) {
  const res = await post({ ...VALID, inspectionChecklist: value });
  check(`a checklist with ${label} -> 422`, res.status, 422);
}
{
  const res = await post({ ...VALID, inspectionChecklist: { Brakes: { state: '' } } });
  ok_("state '' is a real state — the form's blank option", res.status === 201, `got ${res.status}`);
}

console.log('\n-- 11. Nullable numbers keep null apart from zero --');
{
  const db = stubDB();
  await post({ ...VALID, mileage: 0, mileageOut: 0, labourRate: 0 }, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  check('mileage 0 is a reading, not "unrecorded"', insert.binds[names.indexOf('mileage')], 0);
  check('   ...and so is mileage_out 0', insert.binds[names.indexOf('mileage_out')], 0);
  check('   ...and labour_rate 0', insert.binds[names.indexOf('labour_rate')], 0);
}
{
  const db = stubDB();
  await post(VALID, db);
  const insert = db.find('INSERT INTO job_cards');
  const names = insert.sql.match(/INSERT INTO job_cards \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
  for (const col of ['mileage', 'mileage_out', 'labour_hours', 'labour_rate', 'est_delivery', 'fuel_level']) {
    check(`${col} absent -> NULL, never 0 or ''`, insert.binds[names.indexOf(col)], null);
  }
}
for (const [field, value] of [
  ['mileage', -1], ['mileageOut', -1], ['labourHours', -1], ['labourRate', -1],
  ['labourCost', -1], ['discount', -1], ['paid', -1], ['taxRate', -1], ['taxRate', 101],
]) {
  const res = await post({ ...VALID, [field]: value });
  check(`${field} ${value} -> 422`, res.status, 422);
}

console.log('\n-- 12. The cross-field rules --');
{
  const res = await post({ ...VALID, mileage: 100, mileageOut: 50 });
  check('mileage out below mileage in -> 422', res.status, 422);
  check('   ...wording', (await bodyOf(res)).error.fields.mileageOut,
    'Mileage Out cannot be lower than Mileage In.');
}
{
  const res = await post({ ...VALID, date: '2026-09-18', estDelivery: '2026-09-17' });
  check('estimated delivery before the job date -> 422', res.status, 422);
}
{
  const res = await post({ ...VALID, discount: 5000 });
  check('a discount above the subtotal -> 422', res.status, 422);
  check('   ...wording', (await bodyOf(res)).error.fields.discount, 'Discount cannot exceed the subtotal.');
}
{
  const res = await post({ ...VALID, paid: 5000 });
  check('paid above the grand total -> 422', res.status, 422);
  check('   ...wording', (await bodyOf(res)).error.fields.paid, 'Paid amount cannot exceed the grand total.');
}
{
  const res = await post({ ...VALID, paid: 1000 });
  ok_('paid equal to the total is fine', res.status === 201, `got ${res.status}`);
}

/* ============================================================
   13. Update
   ============================================================ */
console.log('\n=== PUT /api/job-cards/:id ===');
console.log('\n-- 13. Not found, read-only and the immutable fields --');
{
  const db = stubDB({ job: null });
  const res = await put({ notes: 'x' }, db);
  check('an unknown job card -> 404', res.status, 404);
  check('   ...code', (await bodyOf(res)).error.code, 'not_found');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await put({ notes: 'x' }, stubDB(), 'not-an-id');
  check('a malformed id -> 400', res.status, 400);
}
for (const status of ['Completed', 'Delivered', 'Cancelled']) {
  const db = stubDB({ job: { ...STORED, status } });
  const res = await put({ notes: 'x' }, db);
  check(`editing a ${status} job card -> 409`, res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'job_card_read_only');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
for (const status of ['Received', 'Inspection', 'Waiting for Approval', 'In Progress', 'Waiting for Parts']) {
  const db = stubDB({ job: { ...STORED, status }, stockRows: [{ part_id: 'PRT-0001', name: 'Oil Filter', stock: 10, issued: 1 }] });
  const res = await put({ notes: 'x' }, db);
  ok_(`a ${status} job card can be edited`, res.status === 200, `got ${res.status}`);
}
for (const [field, value, reason] of [
  ['status', 'In Progress', 'status_change_not_supported'],
  ['appointmentId', 'APT-0009', 'appointment_link_immutable'],
  ['invoiceId', 'INV-0001', 'invoice_link_immutable'],
  ['completedAt', '2026-01-01T00:00:00Z', 'completed_at_immutable'],
  ['actualDelivery', '2026-01-01', 'actual_delivery_immutable'],
]) {
  const db = stubDB();
  const res = await put({ [field]: value }, db);
  check(`changing \`${field}\` -> 409`, res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, reason);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  // A full-record PUT that echoes the stored values back is not a change.
  const db = stubDB();
  const res = await put({
    status: 'Received', appointmentId: null, invoiceId: null,
    completedAt: null, actualDelivery: null, notes: 'x',
  }, db);
  ok_('echoing the stored lifecycle values back is accepted', res.status === 200, `got ${res.status}`);
}

console.log('\n-- 14. Merge semantics --');
{
  const db = stubDB();
  await put({ notes: 'new note' }, db);
  const upd = db.find('UPDATE job_cards');
  const sets = upd.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(',').map((s) => s.trim().split(' ')[0]);
  const at = (col) => upd.binds[sets.indexOf(col)];
  check('the supplied field is written', at('notes'), 'new note');
  check('an absent field keeps its stored value', at('complaint'), 'AC cooling weak');
  check('   ...including nullable numbers', at('mileage'), 52000);
  check('   ...and the date', at('date'), '2026-09-10');
  ok_('updated_at is refreshed', typeof at('updated_at') === 'string' && at('updated_at').endsWith('Z'), at('updated_at'));
  ok_('every column of the merged record is written',
    ['customer_id', 'vehicle_id', 'mechanic_id', 'status'].filter((c) => sets.includes(c)).length === 3
      && !sets.includes('status'), sets);
}
{
  const db = stubDB();
  await put({ mileage: null, labourHours: null }, db);
  const upd = db.find('UPDATE job_cards');
  const sets = upd.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(',').map((s) => s.trim().split(' ')[0]);
  check('an explicit null clears a nullable number', upd.binds[sets.indexOf('mileage')], null);
  check('   ...and does not become 0', upd.binds[sets.indexOf('labour_hours')], null);
}
{
  const db = stubDB();
  const res = await put({}, db);
  check('an empty body -> 422', res.status, 422);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB();
  const res = await put('not json', db);
  check('a malformed body -> 400', res.status, 400);
}
{
  // Totals follow the merged record, not the patch: changing only the discount
  // has to be priced against the STORED lines.
  const db = stubDB();
  await put({ discount: 200 }, db);
  const upd = db.find('UPDATE job_cards');
  const sets = upd.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(',').map((s) => s.trim().split(' ')[0]);
  const at = (col) => upd.binds[sets.indexOf(col)];
  // stored: one service line 1 x 1000, one part line 1 x 0, labour_cost 500
  check('subtotal comes from the stored lines', at('subtotal'), 1500);
  check('   ...with the new discount applied', at('discount'), 200);
  check('   ...and the total recomputed', at('total'), 1300);
  check('   ...and due with it', at('due'), 1300);
}

console.log('\n-- 15. Child lines are rewritten only when supplied --');
{
  const db = stubDB();
  await put({ notes: 'x' }, db);
  ok_('neither line table is touched when neither array is sent',
    !db.find('DELETE FROM job_card_services') && !db.find('DELETE FROM job_card_parts'), db.sql);
  check('   ...so the batch is the parent UPDATE alone', db.batches[0].length, 1);
}
{
  const db = stubDB();
  await put({ services: [{ serviceId: 'SRV-0002', name: 'New', qty: 1, unitPrice: 300 }] }, db);
  ok_('supplying services replaces that set', !!db.find('DELETE FROM job_card_services'), db.sql);
  ok_('   ...and leaves the part lines alone', !db.find('DELETE FROM job_card_parts'), db.sql);
  const sql = batchSql(db);
  check('   ...parent UPDATE, then the delete, then the new line', sql.length, 3);
  ok_('   ...in that order',
    /UPDATE job_cards/.test(sql[0]) && /DELETE FROM job_card_services/.test(sql[1])
      && /INSERT INTO job_card_services/.test(sql[2]), sql);
}
{
  const db = stubDB();
  await put({ services: [] , partsUsed: [{ name: 'manual', qty: 1, unitPrice: 50 }] }, db);
  ok_('an empty array really does clear that line table',
    !!db.find('DELETE FROM job_card_services') && !db.all('INSERT INTO job_card_services').length, db.sql);
}

/* ============================================================
   16. Update — inventory reconciliation
   ============================================================ */
console.log('\n-- 16. Reconciliation happens only where stock has moved --');
const TRACKED_PARTS = [{
  job_card_id: 'JOB-0001', part_id: 'PRT-0001', name: 'Oil Filter',
  part_no: 'OF-1', qty: 3, unit_price: 100, total: 300,
}];
const trackedDB = (over = {}) => stubDB({
  job: { ...STORED, status: 'In Progress' },
  partRows: TRACKED_PARTS,
  stockRows: [{ part_id: 'PRT-0001', name: 'Oil Filter', stock: 20, issued: 3 }],
  ...over,
});
for (const status of ['Received', 'Inspection', 'Waiting for Approval']) {
  const db = stubDB({ job: { ...STORED, status }, partRows: TRACKED_PARTS });
  await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 99, unitPrice: 100 }] }, db);
  ok_(`a ${status} job card reconciles nothing`,
    !db.find('FROM parts p') && !db.find('INSERT INTO inventory_transactions'), db.sql);
}
for (const status of ['In Progress', 'Waiting for Parts']) {
  const db = trackedDB({ job: { ...STORED, status } });
  await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 5, unitPrice: 100 }] }, db);
  ok_(`a ${status} job card does reconcile`, !!db.find('INSERT INTO inventory_transactions'), db.sql);
}
{
  const db = trackedDB();
  await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 5, unitPrice: 100 }] }, db);
  const ledger = db.find('INSERT INTO inventory_transactions');
  check('3 issued, 5 required -> a 2-unit deduction', ledger.binds[5], 2);
  check('   ...recorded as job-card-use', ledger.binds[2], 'job-card-use');
  check('   ...against this job card', ledger.binds[3], 'JOB-0001');
  check('   ...with the engine\'s own note', ledger.binds[6], 'Adjusted on JOB-0001 (qty change)');
  check('   ...and a STOCK delta of -2: issuing takes units out', ledger.binds[7], -2);
  const move = db.find('UPDATE parts');
  check('the stock statement applies the same signed delta', move.binds.slice(0, 2), ['PRT-0001', -2]);
}
{
  const db = trackedDB();
  await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 1, unitPrice: 100 }] }, db);
  const ledger = db.find('INSERT INTO inventory_transactions');
  check('3 issued, 1 required -> a 2-unit return', ledger.binds[5], 2);
  check('   ...recorded as a return', ledger.binds[2], 'return');
  check('   ...and a STOCK delta of +2: returning puts units back', ledger.binds[7], 2);
}
{
  const db = trackedDB();
  await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 3, unitPrice: 100 }] }, db);
  ok_('3 issued, 3 required -> no movement at all',
    !db.find('INSERT INTO inventory_transactions') && !db.find('UPDATE parts'), db.sql);
  ok_('   ...and no ledger id was burned', !db.calls.some((c) => c.binds?.[0] === 'inventoryTransactions'), db.sql);
}
{
  const db = trackedDB();
  await put({ partsUsed: [] }, db);
  const ledger = db.find('INSERT INTO inventory_transactions');
  check('removing the part returns everything issued', ledger.binds[5], 3);
  check('   ...as a return', ledger.binds[2], 'return');
}
{
  const db = trackedDB();
  await put({ partsUsed: [{ name: 'a manual line', qty: 9, unitPrice: 1 }] }, db);
  const ledger = db.find('INSERT INTO inventory_transactions');
  check('a manual line never enters the calculation', ledger.binds[5], 3);
  check('   ...so the inventory part is returned in full', ledger.binds[2], 'return');
}
{
  const db = trackedDB();
  await put({
    partsUsed: [
      { partId: 'PRT-0001', name: 'Oil Filter', qty: 2, unitPrice: 100 },
      { partId: 'PRT-0001', name: 'Oil Filter', qty: 3, unitPrice: 100 },
    ],
  }, db);
  const ledger = db.all('INSERT INTO inventory_transactions');
  check('two lines for the same part are summed into one requirement', ledger.length, 1);
  check('   ...2 + 3 against 3 issued is a 2-unit deduction', ledger[0].binds[5], 2);
}
{
  const db = trackedDB({
    stockRows: [
      { part_id: 'PRT-0001', name: 'Oil Filter', stock: 20, issued: 3 },
      { part_id: 'PRT-0002', name: 'Air Filter', stock: 20, issued: 0 },
    ],
  });
  await put({
    partsUsed: [
      { partId: 'PRT-0001', name: 'Oil Filter', qty: 1, unitPrice: 100 },
      { partId: 'PRT-0002', name: 'Air Filter', qty: 4, unitPrice: 100 },
    ],
  }, db);
  const ledger = db.all('INSERT INTO inventory_transactions');
  check('a swap moves both parts', ledger.length, 2);
  check('   ...the old one down', [ledger[0].binds[2], ledger[0].binds[5]], ['return', 2]);
  check('   ...and the new one up', [ledger[1].binds[2], ledger[1].binds[5]], ['job-card-use', 4]);
  check('   ...all in ONE batch', db.batches.length, 1);
}
{
  const db = trackedDB({ stockRows: [{ part_id: 'PRT-0001', name: 'Oil Filter', stock: 1, issued: 3 }] });
  const res = await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 9, unitPrice: 100 }] }, db);
  check('a shortage -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'insufficient_stock');
  check('   ...naming the part, what is there and what more is needed',
    [b.error.shortages[0].name, b.error.shortages[0].available, b.error.shortages[0].required],
    ['Oil Filter', 1, 6]);
  ok_('   ...and NOTHING was written, not even the job card', db.batches.length === 0, db.sql);
}
{
  const db = trackedDB({
    stockRows: [
      { part_id: 'PRT-0001', name: 'Oil Filter', stock: 20, issued: 3 },
      { part_id: 'PRT-0002', name: 'Air Filter', stock: 1, issued: 0 },
    ],
  });
  const res = await put({
    partsUsed: [
      { partId: 'PRT-0001', name: 'Oil Filter', qty: 8, unitPrice: 100 },
      { partId: 'PRT-0002', name: 'Air Filter', stock: 1, qty: 9, unitPrice: 100 },
    ],
  }, db);
  check('one short part fails the whole edit -> 409', res.status, 409);
  ok_('   ...and the part that WAS available did not move either',
    db.batches.length === 0 && !db.find('UPDATE parts'), db.sql);
}

console.log('\n-- 17. The reconciliation SQL --');
{
  const db = trackedDB();
  await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 5, unitPrice: 100 }] }, db);
  const lookup = db.find('FROM parts p');
  ok_('stock and issued come from ONE query', !!lookup, db.sql);
  ok_('   ...which reads the LEDGER for the issued balance',
    /FROM inventory_transactions t/.test(lookup.sql), lookup.sql);
  ok_('   ...counting job-card-use minus return',
    /'job-card-use'\s+THEN t\.quantity/.test(lookup.sql) && /'return'\s+THEN -t\.quantity/.test(lookup.sql), lookup.sql);
  ok_('   ...scoped to this job card only',
    /t\.reference_type = 'job-card'/.test(lookup.sql) && /t\.reference_id\s+= \?1/.test(lookup.sql), lookup.sql);
  check('   ...and it is the only stock read', db.all('FROM parts p').length, 1);

  const ledger = db.find('INSERT INTO inventory_transactions');
  ok_('prev_stock is read from the live row in SQL',
    /\(SELECT stock FROM parts WHERE id = \?2\)/.test(ledger.sql), ledger.sql);
  ok_('   ...and new_stock is that same read plus the delta',
    /\(SELECT stock FROM parts WHERE id = \?2\) \+ \?8/.test(ledger.sql), ledger.sql);
  ok_('   ...so neither is ever a bound value',
    !ledger.binds.includes(20) && !ledger.binds.includes(22), ledger.binds);
  ok_('the reconciliation guard re-reads the issued balance at write time',
    /CASE WHEN \(SELECT COALESCE\(SUM/.test(ledger.sql), ledger.sql);
  check('   ...against the balance this plan was made from', ledger.binds[4], 3);

  const move = db.find('UPDATE parts');
  ok_('the stock change is arithmetic in SQL, never a computed value',
    /SET stock = stock \+ \?2/.test(move.sql), move.sql);
  const sql = batchSql(db);
  const ledgerAt = sql.findIndex((s) => /INSERT INTO inventory_transactions/.test(s));
  const moveAt = sql.findIndex((s) => /UPDATE parts/.test(s));
  ok_('the ledger row is written BEFORE the stock moves, so prev_stock means what it says',
    ledgerAt < moveAt && ledgerAt !== -1, { ledgerAt, moveAt });
  ok_('a ledger id is allocated for each movement',
    db.calls.some((c) => c.binds?.[0] === 'inventoryTransactions'), db.sql);
}
{
  // The failures the batch is expected to raise, each mapped to its rule.
  for (const [message, reason] of [
    ['D1_ERROR: CHECK constraint failed: new_stock >= 0: SQLITE_CONSTRAINT', 'insufficient_stock'],
    ['D1_ERROR: CHECK constraint failed: stock >= 0: SQLITE_CONSTRAINT', 'insufficient_stock'],
    ['D1_ERROR: NOT NULL constraint failed: inventory_transactions.quantity: SQLITE_CONSTRAINT', 'concurrent_modification'],
    ['D1_ERROR: NOT NULL constraint failed: inventory_transactions.prev_stock: SQLITE_CONSTRAINT', 'part_not_found'],
  ]) {
    const db = trackedDB({ throwOnBatch: message });
    const res = await put({ partsUsed: [{ partId: 'PRT-0001', name: 'Oil Filter', qty: 5, unitPrice: 100 }] }, db);
    check(`"${message.split(': ')[1]}" -> 409`, res.status, 409);
    check('   ...reason', (await bodyOf(res)).error.reason, reason);
  }
}
{
  const db = stubDB({ throwOnBatch: 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT' });
  const res = await post(VALID, db);
  check('a bad reference on create -> 409, from the schema\'s own foreign key', res.status, 409);
  ok_('   ...and no reference was pre-checked one at a time',
    !db.find('FROM customers WHERE') && !db.find('FROM mechanics WHERE'), db.sql);
}

/* ============================================================
   18. Delete
   ============================================================ */
console.log('\n=== DELETE /api/job-cards/:id ===');
console.log('\n-- 18. The three delete guards, in the client\'s order --');
{
  const db = stubDB({ deleteRow: null });
  const res = await del(db);
  check('an unknown job card -> 404', res.status, 404);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ deleteRow: { status: 'Received', invoice_id: 'INV-0001' } });
  const res = await del(db);
  check('an invoiced job card -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'job_card_invoiced');
  check('   ...naming the invoice', b.error.invoiceId, 'INV-0001');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
for (const status of ['Completed', 'Delivered']) {
  const db = stubDB({ deleteRow: { status, invoice_id: null } });
  const res = await del(db);
  check(`a ${status} job card -> 409`, res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'job_card_completed');
}
for (const status of ['Inspection', 'Waiting for Approval', 'In Progress', 'Waiting for Parts']) {
  const db = stubDB({ deleteRow: { status, invoice_id: null } });
  const res = await del(db);
  check(`a ${status} job card -> 409`, res.status, 409);
  check('   ...reason', (await bodyOf(res)).error.reason, 'work_started');
}
{
  // The invoice guard runs first, so an invoiced Completed card reports the
  // invoice — exactly the order openDeleteModal() checks in.
  const db = stubDB({ deleteRow: { status: 'Completed', invoice_id: 'INV-0002' } });
  check('the invoice guard wins over the status guard',
    (await bodyOf(await del(db))).error.reason, 'job_card_invoiced');
}
for (const status of ['Received', 'Cancelled']) {
  const db = stubDB({ deleteRow: { status, invoice_id: null } });
  const res = await del(db);
  check(`a ${status} job card is deleted -> 200`, res.status, 200);
  check('   ...reporting what went', (await bodyOf(res)).data, { id: 'JOB-0001', deleted: true });
  const sql = batchSql(db);
  check('   ...in one batch of two statements', sql.length, 2);
  ok_('   ...unlinking the appointment first', /UPDATE appointments/.test(sql[0]), sql[0]);
  ok_('   ...only where it points at THIS job card', /WHERE job_card_id = \?1/.test(sql[0]), sql[0]);
  ok_('   ...refreshing its updated_at, as Storage.updateData does', /updated_at = \?2/.test(sql[0]), sql[0]);
  ok_('   ...then deleting the job card', /DELETE FROM job_cards/.test(sql[1]), sql[1]);
  ok_('   ...with no statement for the cascading line tables',
    !sql.some((s) => /job_card_services|job_card_parts/.test(s)), sql);
  ok_('   ...and no stock returned', !db.find('UPDATE parts') && !db.find('INSERT INTO inventory_transactions'), db.sql);
}
{
  const db = stubDB({ deleteRow: { status: 'Received', invoice_id: null }, deleteChanges: [0, 0] });
  const res = await del(db);
  check('a row that vanished between the guard and the delete -> 404', res.status, 404);
}
{
  const db = stubDB({
    deleteRow: { status: 'Received', invoice_id: null },
    throwOnBatch: 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT',
  });
  const res = await del(db);
  check('a payment still pointing at it -> 409, from the RESTRICT foreign key', res.status, 409);
}
{
  const res = await del(stubDB(), 'nope');
  check('a malformed id -> 400', res.status, 400);
}

/* ============================================================
   19. The routing surface
   ============================================================ */
console.log('\n-- 19. Methods and bindings --');
for (const [path, method] of [
  ['/api/job-cards', 'POST'], ['/api/job-cards/JOB-0001', 'PUT'], ['/api/job-cards/JOB-0001', 'DELETE'],
]) {
  const res = await call(path, {}, method, method === 'DELETE' ? undefined : { x: 1 });
  check(`${method} ${path} without a binding -> 503`, res.status, 503);
  check('   ...code', (await bodyOf(res)).error.code, 'no_database');
}
{
  const routes = (await (await call('/api/health', { DB: stubDB() }, 'GET')).json()).data.routes;
  ok_('health advertises the three new routes',
    ['POST /api/job-cards', 'PUT /api/job-cards/:id', 'DELETE /api/job-cards/:id']
      .every((r) => routes.includes(r)), routes);
  check('   ...and the registry is 180 routes', routes.length, 180);
}

console.log(`\nJob card writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
