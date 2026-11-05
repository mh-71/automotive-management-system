/* POST /api/job-cards/:id/status — unit tests against the REAL Worker handler
   with a stubbed D1 binding.

   A status transition is the widest business operation in this API: one
   request can move the job card's status, stamp completedAt or
   actualDelivery, issue or return stock, write ledger rows and move a linked
   appointment. So the weight here is on the SQL it would send, not only on
   what it answers:

     - the status UPDATE carries `AND status = <expected>`, which is what
       makes two concurrent requests settle rather than both transitioning;
     - every statement after it re-reads the job card's status, so an update
       that changed no rows can never be followed by a stock movement;
     - the deduction carries hasJobDeduction() itself, as a NOT EXISTS, and
       its stock UPDATE applies only if that ledger row was written;
     - a return re-verifies the outstanding balance it planned against and
       produces a NULL quantity if it moved, which rolls the batch back;
     - prev_stock / new_stock are read from the live row inside the INSERT.

   Every transition asserted valid below is one TRANSITIONS actually lists
   (job-cards.js:46-56). Nothing here invents a transition.

   Whether the batch really rolls back, and whether two concurrent
   transitions really settle correctly, are D1's behaviour: proved against a
   real database in the integration suite. */
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

/* The transition table as job-cards.js:46-56 states it. The tests below derive
   both the valid and the invalid cases from this, so a table that drifted from
   the route's own copy would fail loudly rather than silently under-test. */
const TRANSITIONS = {
  'Received': ['Inspection', 'Cancelled'],
  'Inspection': ['In Progress', 'Waiting for Approval', 'Cancelled'],
  'Waiting for Approval': ['In Progress', 'Cancelled'],
  'In Progress': ['Waiting for Parts', 'Waiting for Approval', 'Completed', 'Cancelled'],
  'Waiting for Parts': ['In Progress'],
  'Completed': ['Delivered'],
  'Delivered': [],
  'Cancelled': [],
};
const STATUSES = Object.keys(TRANSITIONS);

const PARENT = {
  id: 'JOB-0001', status: 'Received', appointment_id: null,
  completed_at: null, actual_delivery: null,
};

/**
 * `job`        the narrow parent row a transition reads, or null for a 404.
 * `partLines`  the job's inventory part lines, in line order.
 * `stockRows`  what the issue lookup answers: live stock + issued_before.
 * `outstanding` what the return lookup answers: the ledger's balance per part.
 * `changes`    meta.changes for each batch statement; [0] is the status gate.
 */
function stubDB({
  job = PARENT,
  partLines = [],
  stockRows = [],
  outstanding = [],
  changes = null,
  throwOnBatch = null,
} = {}) {
  const calls = [];
  const batches = [];
  const db = {
    calls, batches,
    callsBeforeBatch: Infinity,
    get sql() { return calls.map((c) => c.sql).join('\n'); },
    /** Only the queries made before the batch, i.e. by the transition itself. */
    planned(fragment) {
      return calls.slice(0, db.callsBeforeBatch).filter((c) => c.sql.includes(fragment));
    },
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
          if (sql.includes('id_counters')) return { last_value: 7, prefix: 'STK' };
          if (sql.includes('SELECT id, status, appointment_id')) return job;
          // The read-back the response is built from.
          if (sql.includes('FROM job_cards')) {
            return job ? { ...job, customer_id: 'CUS-0001', vehicle_id: 'VEH-0001',
              mechanic_id: 'MEC-0001', invoice_id: null, date: '2026-09-10',
              priority: 'normal', complaint: 'x', created_at: '2026-09-10T09:00:00Z',
              labour_cost: 0, discount: 0, tax_rate: 0, subtotal: 0, tax: 0,
              total: 0, paid: 0, due: 0 } : null;
          }
          return null;
        },
        async all() {
          if (sql.includes('sqlite_master')) return { results: [{ name: 'customers' }] };
          if (sql.includes('FROM job_card_parts')) return { results: partLines };
          if (sql.includes('FROM parts p')) return { results: stockRows };
          if (sql.includes('GROUP BY t.part_id')) return { results: outstanding };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(statements) {
      // Where the reads the TRANSITION made end and the response read-back
      // begins. respondWith() always re-reads the job card and both line
      // tables, so "did the transition look this up?" has to be asked of the
      // calls made before the batch, not of the whole run.
      db.callsBeforeBatch = calls.length;
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
const move = (status, db, id = 'JOB-0001') =>
  call(`/api/job-cards/${id}/status`, { DB: db ?? stubDB() }, 'POST', { status });
const bodyOf = async (res) => res.json();

/** The statements a batch would send, as SQL text, in order. */
const batchSql = (db, n = 0) => {
  const statements = db.batches[n] ?? [];
  const written = db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql));
  return written.slice(written.length - statements.length).map((c) => c.sql);
};
const batchBinds = (db, n = 0) => {
  const statements = db.batches[n] ?? [];
  const written = db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql));
  return written.slice(written.length - statements.length).map((c) => c.binds);
};
/** The SET clause of the status UPDATE, as column names. */
const statusSets = (db) => {
  const upd = db.find('UPDATE job_cards');
  return upd.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(',').map((s) => s.trim().split(' ')[0]);
};
/** The value bound to one SET column. ?1 is the id, so the SET clause starts at ?2. */
const statusBind = (db, column) =>
  db.find('UPDATE job_cards').binds[statusSets(db).indexOf(column) + 1];

/* ============================================================
   1. The state machine
   ============================================================ */
console.log('\n=== POST /api/job-cards/:id/status ===');
console.log('\n-- 1. Every transition TRANSITIONS lists is allowed --');
for (const [from, nexts] of Object.entries(TRANSITIONS)) {
  for (const to of nexts) {
    // In Progress issues stock, so it needs a job with no part lines here.
    const db = stubDB({ job: { ...PARENT, status: from } });
    const res = await move(to, db);
    ok_(`${from} -> ${to} -> 200`, res.status === 200,
      `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
    const upd = db.find('UPDATE job_cards');
    check(`   ...writes the new status`, upd.binds[1], to);
    ok_('   ...gated on the status it expected to find',
      /WHERE id = \?1 AND status = \?\d+/.test(upd.sql), upd.sql);
    check('   ...binding that expected status last', upd.binds[upd.binds.length - 1], from);
  }
}

console.log('\n-- 2. Every transition it does not list is refused --');
{
  let refused = 0, sameStatus = 0, terminal = 0;
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (TRANSITIONS[from].includes(to)) continue;
      const db = stubDB({ job: { ...PARENT, status: from } });
      const res = await move(to, db);
      if (res.status !== 409) { ok_(`${from} -> ${to} -> 409`, false, `got ${res.status}`); continue; }
      const b = await bodyOf(res);
      const expected = from === to ? 'same_status'
        : TRANSITIONS[from].length === 0 ? 'job_card_terminal' : 'invalid_status_transition';
      if (b.error.reason !== expected) {
        ok_(`${from} -> ${to} reason`, false, `${b.error.reason} != ${expected}`);
        continue;
      }
      if (b.error.message !== `Cannot change ${from} job card to ${to}.`) {
        ok_(`${from} -> ${to} message`, false, b.error.message);
        continue;
      }
      if (db.batches.length !== 0) { ok_(`${from} -> ${to} wrote nothing`, false, db.sql); continue; }
      refused += 1;
      if (expected === 'same_status') sameStatus += 1;
      if (expected === 'job_card_terminal') terminal += 1;
    }
  }
  // 8 statuses square, minus the 13 moves the table actually lists
  // (2 + 3 + 2 + 4 + 1 + 1 + 0 + 0).
  const listed = Object.values(TRANSITIONS).reduce((n2, xs) => n2 + xs.length, 0);
  check('the table lists 13 moves', listed, 13);
  check('every refused pair is a 409 with the right reason, wording and no write',
    refused, STATUSES.length * STATUSES.length - listed);
  check('   ...including all eight same-status requests', sameStatus, 8);
  // Delivered and Cancelled refuse all eight, but their own name is reported
  // as same_status rather than terminal, so seven each.
  check('   ...and every move out of a terminal status', terminal, 2 * (STATUSES.length - 1));
}
{
  const db = stubDB({ job: { ...PARENT, status: 'Delivered' } });
  const res = await move('Cancelled', db);
  const b = await bodyOf(res);
  check('a terminal job card reports an empty allowed list', b.error.allowed, []);
  check('   ...and where it is now', b.error.from, 'Delivered');
  check('   ...and where it was asked to go', b.error.to, 'Cancelled');
}
{
  const db = stubDB({ job: { ...PARENT, status: 'Received' } });
  const b = await bodyOf(await move('Completed', db));
  check('a skipped step reports what IS reachable', b.error.allowed, ['Inspection', 'Cancelled']);
  check('   ...as an invalid transition', b.error.reason, 'invalid_status_transition');
}

/* ============================================================
   3. Request validation
   ============================================================ */
console.log('\n-- 3. The request --');
for (const [why, body] of [
  ['a missing status', {}],
  ['a null status', { status: null }],
  ['an empty status', { status: '' }],
  ['a blank status', { status: '   ' }],
  ['a status of the wrong type', { status: 7 }],
  ['a status that is an array', { status: ['Inspection'] }],
  ['an unknown status', { status: 'Nonsense' }],
  ['a lower-case status', { status: 'inspection' }],
]) {
  const db = stubDB();
  const res = await call('/api/job-cards/JOB-0001/status', { DB: db }, 'POST', body);
  check(`${why} -> 422`, res.status, 422);
  const b = await bodyOf(res);
  ok_('   ...names the status field', !!b.error.fields?.status, JSON.stringify(b.error));
  ok_('   ...and nothing was written', db.batches.length === 0);
}
for (const [field, value] of [
  ['completedAt', '2020-01-01T00:00:00Z'], ['actualDelivery', '2020-01-01'],
  ['paid', 1], ['due', 1], ['subtotal', 1], ['tax', 1], ['total', 1],
  ['invoiceId', 'INV-0001'], ['appointmentId', 'APT-0001'],
  ['quantity', 5], ['prevStock', 1], ['newStock', 1],
]) {
  const db = stubDB();
  const res = await call('/api/job-cards/JOB-0001/status',
    { DB: db }, 'POST', { status: 'Inspection', [field]: value });
  check(`\`${field}\` -> 422`, res.status, 422);
  ok_('   ...names the field', !!(await bodyOf(res)).error.fields?.[field]);
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const db = stubDB({ job: null });
  const res = await move('Inspection', db);
  check('an unknown job card -> 404', res.status, 404);
  check('   ...code', (await bodyOf(res)).error.code, 'not_found');
  ok_('   ...and nothing was written', db.batches.length === 0);
}
{
  const res = await call('/api/job-cards/nope/status', { DB: stubDB() }, 'POST', { status: 'Inspection' });
  check('a malformed job card id -> 400', res.status, 400);
  check('   ...code', (await bodyOf(res)).error.code, 'invalid_id');
}
{
  const res = await call('/api/job-cards/JOB-0001/status', { DB: stubDB() }, 'POST', 'not json');
  check('a malformed body -> 400', res.status, 400);
  const empty = await call('/api/job-cards/JOB-0001/status', { DB: stubDB() }, 'POST');
  check('no body at all -> 400', empty.status, 400);
}
for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
  // A GET may not carry a body, so the payload is omitted for it; the route
  // rejects the method before it would ever read one either way.
  const res = await call('/api/job-cards/JOB-0001/status', { DB: stubDB() }, m,
    m === 'GET' ? undefined : { status: 'Inspection' });
  check(`${m} on the status path -> 405`, res.status, 405);
  check('   ...Allow names POST only', res.headers.get('allow'), 'POST');
}
{
  const res = await call('/api/job-cards/JOB-0001/status', {}, 'POST', { status: 'Inspection' });
  check('no binding -> 503', res.status, 503);
  check('   ...code', (await bodyOf(res)).error.code, 'no_database');
}
{
  // An undeclared action stays what it was before C-6: the id validator's 400.
  const res = await call('/api/job-cards/JOB-0001/invoice', { DB: stubDB() }, 'POST', {});
  ok_('an action the collection does not declare is not routed', res.status === 400 || res.status === 405,
    `got ${res.status}`);
  const other = await call('/api/customers/CUS-0001/status', { DB: stubDB() }, 'POST', { status: 'x' });
  ok_('   ...and no other collection gained a status action',
    other.status === 400 || other.status === 405, `got ${other.status}`);
}

/* ============================================================
   4. Entering In Progress — the deduction
   ============================================================ */
console.log('\n-- 4. Entering In Progress issues the job\'s parts --');
const LINE = (partId, name, qty) => ({ part_id: partId, name, qty });
const STOCK = (partId, stock, issued_before = 0) => ({ part_id: partId, stock, issued_before });
const startDB = (over = {}) => stubDB({ job: { ...PARENT, status: 'Inspection' }, ...over });

{
  const db = startDB();
  const res = await move('In Progress', db);
  ok_('a job card with no parts -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...writes no ledger row', !db.find('INSERT INTO inventory_transactions'), db.sql);
  ok_('   ...moves no stock', !db.find('UPDATE parts'), db.sql);
  ok_('   ...and does not even look stock up', !db.find('FROM parts p'), db.sql);
  check('   ...the batch is the status update alone', db.batches[0].length, 1);
}
{
  const db = startDB({ partLines: [LINE('PRT-0001', 'Oil Filter', 5)], stockRows: [STOCK('PRT-0001', 20)] });
  const res = await move('In Progress', db);
  ok_('one part -> 200', res.status === 200, `got ${res.status}`);
  const ledger = db.find('INSERT INTO inventory_transactions');
  check('   ...issues the line\'s FULL quantity', ledger.binds[2], 5);
  check('   ...as job-card-use', /'job-card-use'/.test(ledger.sql), true);
  check('   ...against this job card', ledger.binds[3], 'JOB-0001');
  check('   ...with the engine\'s own note', ledger.binds[4], 'Used on JOB-0001');
  const stock = db.find('UPDATE parts');
  ok_('   ...and takes the units OUT of stock', /SET stock = stock - \?2/.test(stock.sql), stock.sql);
  check('   ...the same quantity', stock.binds.slice(0, 2), ['PRT-0001', 5]);
  check('   ...all in one batch', db.batches.length, 1);
  check('   ...of three statements', db.batches[0].length, 3);
}
{
  const db = startDB({
    partLines: [LINE('PRT-0001', 'A', 5), LINE('PRT-0002', 'B', 3), LINE('PRT-0003', 'C', 2)],
    stockRows: [STOCK('PRT-0001', 20), STOCK('PRT-0002', 20), STOCK('PRT-0003', 20)],
  });
  const res = await move('In Progress', db);
  ok_('three parts -> 200', res.status === 200, `got ${res.status}`);
  check('   ...three ledger rows', db.all('INSERT INTO inventory_transactions').length, 3);
  check('   ...three stock updates', db.all('UPDATE parts').length, 3);
  check('   ...in ONE batch', db.batches.length, 1);
  check('   ...of seven statements', db.batches[0].length, 7);
  check('   ...each issuing its own line\'s quantity',
    db.all('INSERT INTO inventory_transactions').map((c) => c.binds[2]), [5, 3, 2]);
  check('   ...and one stock lookup for all three', db.all('FROM parts p').length, 1);
}
{
  const db = startDB({
    partLines: [LINE('PRT-0001', 'A', 5), LINE('PRT-0002', 'B', 9)],
    stockRows: [STOCK('PRT-0001', 20), STOCK('PRT-0002', 4)],
  });
  const res = await move('In Progress', db);
  check('one short part -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'insufficient_stock');
  check('   ...with the client\'s own wording',
    b.error.message, 'Insufficient stock for B. Available: 4, Required: 9.');
  check('   ...naming the line, not the catalogue part', b.error.shortages[0].name, 'B');
  ok_('   ...and NOTHING was written, not even the status', db.batches.length === 0, db.sql);
}
{
  const db = startDB({
    partLines: [LINE('PRT-0001', 'A', 5)],
    stockRows: [STOCK('PRT-0001', 20, 1)],
  });
  const res = await move('In Progress', db);
  ok_('a part this job has already been issued -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...is skipped entirely — hasJobDeduction is a yes/no, not a delta',
    !db.find('INSERT INTO inventory_transactions'), db.sql);
  check('   ...so the batch is the status update alone', db.batches[0].length, 1);
}
{
  const db = startDB({
    partLines: [LINE('PRT-0001', 'A', 5)],
    stockRows: [STOCK('PRT-0001', 2, 1)],
  });
  const res = await move('In Progress', db);
  ok_('   ...and is not stock-checked either, however short it looks',
    res.status === 200, `got ${res.status}`);
}
{
  const db = startDB({
    partLines: [LINE('PRT-0001', 'A', 5), LINE('PRT-0001', 'A again', 3)],
    stockRows: [STOCK('PRT-0001', 20)],
  });
  const res = await move('In Progress', db);
  ok_('two lines naming the same part -> 200', res.status === 200, `got ${res.status}`);
  check('   ...issue ONCE', db.all('INSERT INTO inventory_transactions').length, 1);
  check('   ...for the first line\'s quantity', db.find('INSERT INTO inventory_transactions').binds[2], 5);
}
{
  const db = startDB({ partLines: [LINE('PRT-0001', 'A', 5)], stockRows: [] });
  const res = await move('In Progress', db);
  check('a part line whose part is gone -> 409', res.status, 409);
  check('   ...reported as no stock at all', (await bodyOf(res)).error.shortages[0].available, 0);
}
{
  const db = startDB({ partLines: [LINE('PRT-0001', 'A', 5)], stockRows: [STOCK('PRT-0001', 5)] });
  ok_('stock exactly equal to the requirement is enough',
    (await move('In Progress', db)).status === 200);
}
{
  const db = startDB({ partLines: [], stockRows: [] });
  await move('In Progress', db);
  ok_('the part lines read exclude manual lines in SQL',
    /part_id IS NOT NULL/.test(db.find('FROM job_card_parts').sql), db.find('FROM job_card_parts').sql);
  ok_('   ...and are read in line order',
    /ORDER BY line_no, id/.test(db.find('FROM job_card_parts').sql));
}
for (const from of ['Received', 'Inspection', 'Waiting for Approval', 'In Progress', 'Completed']) {
  const db = stubDB({ job: { ...PARENT, status: from }, partLines: [LINE('PRT-0001', 'A', 5)] });
  const to = TRANSITIONS[from].find((s) => s !== 'In Progress' && s !== 'Cancelled');
  if (!to) continue;
  await move(to, db);
  ok_(`${from} -> ${to} reads no part lines at all`, db.planned('FROM job_card_parts').length === 0, db.sql);
  ok_('   ...and moves no stock', !db.find('INSERT INTO inventory_transactions'), db.sql);
}

/* ============================================================
   5. Waiting for Parts
   ============================================================ */
console.log('\n-- 5. Waiting for Parts moves nothing on its own --');
{
  const db = stubDB({ job: { ...PARENT, status: 'In Progress' }, partLines: [LINE('PRT-0001', 'A', 5)] });
  const res = await move('Waiting for Parts', db);
  ok_('In Progress -> Waiting for Parts -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...returns nothing — what was issued stays issued',
    !db.find('INSERT INTO inventory_transactions') && !db.find('UPDATE parts'), db.sql);
  check('   ...so the batch is the status update alone', db.batches[0].length, 1);
}
{
  const db = stubDB({
    job: { ...PARENT, status: 'Waiting for Parts' },
    partLines: [LINE('PRT-0001', 'A', 5)],
    stockRows: [STOCK('PRT-0001', 20, 1)],
  });
  const res = await move('In Progress', db);
  ok_('Waiting for Parts -> In Progress -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...deducts nothing, because the part is already issued',
    !db.find('INSERT INTO inventory_transactions'), db.sql);
}
{
  const db = stubDB({
    job: { ...PARENT, status: 'Waiting for Parts' },
    partLines: [LINE('PRT-0001', 'A', 5), LINE('PRT-0002', 'B', 2)],
    stockRows: [STOCK('PRT-0001', 20, 1), STOCK('PRT-0002', 20, 0)],
  });
  await move('In Progress', db);
  check('   ...but a part it has never been issued still is',
    db.all('INSERT INTO inventory_transactions').length, 1);
  check('   ...and it is the new one', db.find('INSERT INTO inventory_transactions').binds[1], 'PRT-0002');
}

/* ============================================================
   6. Cancelled — the return
   ============================================================ */
console.log('\n-- 6. Cancelling returns what is still outstanding --');
const cancelDB = (over = {}) => stubDB({ job: { ...PARENT, status: 'In Progress' }, ...over });
{
  const db = cancelDB({ outstanding: [{ part_id: 'PRT-0001', outstanding: 5 }] });
  const res = await move('Cancelled', db);
  ok_('a cancelled job card -> 200', res.status === 200, `got ${res.status}`);
  const ledger = db.find('INSERT INTO inventory_transactions');
  check('   ...returns the outstanding balance', ledger.binds[2], 5);
  ok_('   ...as a return', /'return'/.test(ledger.sql), ledger.sql);
  check('   ...with the engine\'s own note', ledger.binds[4], 'Returned — JOB-0001 cancelled');
  const stock = db.find('UPDATE parts');
  ok_('   ...and puts the units BACK', /SET stock = stock \+ \?2/.test(stock.sql), stock.sql);
  check('   ...the same quantity', stock.binds.slice(0, 2), ['PRT-0001', 5]);
}
{
  const db = cancelDB({ outstanding: [] });
  const res = await move('Cancelled', db);
  ok_('a job card that was never issued anything -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...returns nothing', !db.find('INSERT INTO inventory_transactions'), db.sql);
  check('   ...so the batch is the status update alone', db.batches[0].length, 1);
}
{
  const db = cancelDB({ outstanding: [{ part_id: 'PRT-0001', outstanding: 3 }] });
  await move('Cancelled', db);
  check('a part issued 5 and reduced to 3 returns THREE, not five',
    db.find('INSERT INTO inventory_transactions').binds[2], 3);
}
{
  const db = cancelDB({
    outstanding: [
      { part_id: 'PRT-0001', outstanding: 5 },
      { part_id: 'PRT-0002', outstanding: 0 },
      { part_id: 'PRT-0003', outstanding: 2 },
    ],
  });
  await move('Cancelled', db);
  const rows = db.all('INSERT INTO inventory_transactions');
  check('a part with nothing outstanding is skipped', rows.length, 2);
  check('   ...and the rest return their own balances',
    rows.map((c) => [c.binds[1], c.binds[2]]), [['PRT-0001', 5], ['PRT-0003', 2]]);
  check('   ...in ONE batch', db.batches.length, 1);
}
{
  const db = cancelDB({ outstanding: [{ part_id: 'PRT-0001', outstanding: -2 }] });
  await move('Cancelled', db);
  ok_('a negative balance is never "returned"', !db.find('INSERT INTO inventory_transactions'), db.sql);
}
{
  const db = cancelDB({ outstanding: [{ part_id: 'PRT-0001', outstanding: 5 }] });
  await move('Cancelled', db);
  const q = db.find('GROUP BY t.part_id');
  ok_('the outstanding balance comes from the LEDGER', !!q, db.sql);
  ok_('   ...scoped to this job card', /t\.reference_id = \?1/.test(q.sql), q.sql);
  ok_('   ...counting job-card-use minus return',
    /'job-card-use'\s+THEN t\.quantity/.test(q.sql) && /'return'\s+THEN -t\.quantity/.test(q.sql), q.sql);
  check('   ...in one query for every part', db.all('GROUP BY t.part_id').length, 1);
  ok_('   ...and the job card\'s own lines are never read for a cancellation',
    db.planned('FROM job_card_parts').length === 0, db.sql);
}
for (const from of ['Received', 'Inspection', 'Waiting for Approval']) {
  const db = stubDB({ job: { ...PARENT, status: from }, outstanding: [] });
  const res = await move('Cancelled', db);
  ok_(`${from} -> Cancelled -> 200`, res.status === 200, `got ${res.status}`);
  ok_('   ...and still consults the ledger rather than assuming', !!db.find('GROUP BY t.part_id'));
}

/* ============================================================
   7. The SQL that makes it safe
   ============================================================ */
console.log('\n-- 7. The batch guards --');
{
  const db = startDB({ partLines: [LINE('PRT-0001', 'A', 5)], stockRows: [STOCK('PRT-0001', 20)] });
  await move('In Progress', db);
  const sql = batchSql(db);
  ok_('the status UPDATE is the first statement', /^\s*UPDATE job_cards/.test(sql[0]), sql[0]);
  ok_('   ...and it is the gate', /WHERE id = \?1 AND status = \?\d+/.test(sql[0]), sql[0]);

  const ledger = db.find('INSERT INTO inventory_transactions');
  ok_('the ledger INSERT is conditional on the transition landing',
    /WHERE \(SELECT status FROM job_cards WHERE id = \?4\) = \?7/.test(ledger.sql), ledger.sql);
  check('   ...on the status it is moving TO', ledger.binds[6], 'In Progress');
  ok_('   ...and carries hasJobDeduction itself',
    /NOT EXISTS \(SELECT 1 FROM inventory_transactions/.test(ledger.sql)
      && /AND part_id\s+= \?2/.test(ledger.sql), ledger.sql);
  ok_('prev_stock is read from the live row in SQL',
    /\(SELECT stock FROM parts WHERE id = \?2\)/.test(ledger.sql), ledger.sql);
  ok_('   ...and new_stock is that same read minus the quantity',
    /\(SELECT stock FROM parts WHERE id = \?2\) - \?3/.test(ledger.sql), ledger.sql);
  ok_('   ...so neither is ever a bound value',
    !ledger.binds.includes(20) && !ledger.binds.includes(15), ledger.binds);

  const stock = db.find('UPDATE parts');
  ok_('the stock UPDATE applies only if its own ledger row was written',
    /EXISTS \(SELECT 1 FROM inventory_transactions WHERE id = \?4\)/.test(stock.sql), stock.sql);
  check('   ...pointing at that exact row', stock.binds[3], db.find('INSERT INTO inventory_transactions').binds[0]);
  const ledgerAt = sql.findIndex((s) => /INSERT INTO inventory_transactions/.test(s));
  const stockAt = sql.findIndex((s) => /UPDATE parts/.test(s));
  ok_('   ...and runs after it, so prev_stock means what it says',
    ledgerAt !== -1 && ledgerAt < stockAt, { ledgerAt, stockAt });

  ok_('no stock is read then written back from JavaScript',
    !/SELECT stock FROM parts WHERE id = \?1\s*$/.test(db.sql), db.sql);
}
{
  const db = cancelDB({ outstanding: [{ part_id: 'PRT-0001', outstanding: 5 }] });
  await move('Cancelled', db);
  const ledger = db.find('INSERT INTO inventory_transactions');
  ok_('a return re-verifies the balance it planned against',
    /CASE WHEN \(SELECT COALESCE\(SUM/.test(ledger.sql), ledger.sql);
  check('   ...against that exact balance', ledger.binds[2], 5);
  ok_('   ...and is conditional on the transition landing',
    /WHERE \(SELECT status FROM job_cards WHERE id = \?4\) = \?7/.test(ledger.sql), ledger.sql);
  check('   ...on Cancelled', ledger.binds[6], 'Cancelled');
  ok_('new_stock is the live balance PLUS what comes back',
    /\(SELECT stock FROM parts WHERE id = \?2\) \+ \?3/.test(ledger.sql), ledger.sql);
}
{
  const db = startDB({
    partLines: [LINE('PRT-0001', 'A', 5)], stockRows: [STOCK('PRT-0001', 20)],
    changes: [0],
  });
  const res = await move('In Progress', db);
  check('a status update that matched nothing -> 409', res.status, 409);
  const b = await bodyOf(res);
  check('   ...reason', b.error.reason, 'concurrent_modification');
  check('   ...naming the status it expected', b.error.expected, 'Inspection');
}
{
  for (const [message, reason] of [
    ['D1_ERROR: CHECK constraint failed: new_stock >= 0: SQLITE_CONSTRAINT', 'insufficient_stock'],
    ['D1_ERROR: CHECK constraint failed: stock >= 0: SQLITE_CONSTRAINT', 'insufficient_stock'],
    ['D1_ERROR: NOT NULL constraint failed: inventory_transactions.quantity: SQLITE_CONSTRAINT', 'concurrent_modification'],
    ['D1_ERROR: NOT NULL constraint failed: inventory_transactions.prev_stock: SQLITE_CONSTRAINT', 'part_not_found'],
  ]) {
    const db = startDB({
      partLines: [LINE('PRT-0001', 'A', 5)], stockRows: [STOCK('PRT-0001', 20)],
      throwOnBatch: message,
    });
    const res = await move('In Progress', db);
    check(`"${message.split(': ')[1]}" -> 409`, res.status, 409);
    const b = await bodyOf(res);
    check('   ...reason', b.error.reason, reason);
    ok_('   ...with no SQL leaked', !JSON.stringify(b).includes('SQLITE'), JSON.stringify(b));
  }
}
{
  const db = stubDB({ throwOnBatch: 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT' });
  const res = await move('Inspection', db);
  check('a foreign key failure -> 409', res.status, 409);
}
{
  const db = stubDB({ throwOnBatch: 'kaboom' });
  const res = await move('Inspection', db);
  check('anything else -> 500 without detail', res.status, 500);
  ok_('   ...and says nothing about the error',
    !JSON.stringify(await bodyOf(res)).includes('kaboom'));
}

/* ============================================================
   8. Timestamps
   ============================================================ */
console.log('\n-- 8. completedAt and actualDelivery --');
{
  const db = stubDB({ job: { ...PARENT, status: 'In Progress' } });
  await move('Completed', db);
  const sets = statusSets(db);
  ok_('entering Completed stamps completed_at', sets.includes('completed_at'), sets);
  ok_('   ...and not actual_delivery', !sets.includes('actual_delivery'), sets);
  const stamp = statusBind(db, 'completed_at');
  ok_('   ...as a full ISO-8601 instant in UTC',
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(stamp), stamp);
  check('   ...the same instant as updated_at', stamp, statusBind(db, 'updated_at'));
}
{
  const db = stubDB({ job: { ...PARENT, status: 'In Progress', completed_at: '2020-01-01T00:00:00.000Z' } });
  await move('Completed', db);
  ok_('a job card already stamped keeps its original completedAt',
    !statusSets(db).includes('completed_at'), statusSets(db));
}
{
  const db = stubDB({ job: { ...PARENT, status: 'In Progress', completed_at: '' } });
  await move('Completed', db);
  ok_('   ...but a blank one is stamped, exactly as `!j.completedAt` decides',
    statusSets(db).includes('completed_at'), statusSets(db));
}
{
  const db = stubDB({ job: { ...PARENT, status: 'Completed' } });
  await move('Delivered', db);
  const sets = statusSets(db);
  ok_('entering Delivered stamps actual_delivery', sets.includes('actual_delivery'), sets);
  ok_('   ...and not completed_at', !sets.includes('completed_at'), sets);
  const day = statusBind(db, 'actual_delivery');
  ok_('   ...as a calendar DAY, not an instant', /^\d{4}-\d{2}-\d{2}$/.test(day), day);
  const dhaka = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  check("   ...the workshop's day, not the Worker's UTC one — audit Finding 2", day, dhaka);
}
{
  const db = stubDB({ job: { ...PARENT, status: 'Completed', actual_delivery: '2020-01-01' } });
  await move('Delivered', db);
  ok_('a job card already delivered keeps its original actualDelivery',
    !statusSets(db).includes('actual_delivery'), statusSets(db));
}
for (const [from, to] of [
  ['Received', 'Inspection'], ['Inspection', 'In Progress'], ['In Progress', 'Waiting for Parts'],
  ['In Progress', 'Cancelled'], ['Waiting for Approval', 'In Progress'],
]) {
  const db = stubDB({ job: { ...PARENT, status: from } });
  await move(to, db);
  const sets = statusSets(db);
  ok_(`${from} -> ${to} stamps neither timestamp`,
    !sets.includes('completed_at') && !sets.includes('actual_delivery'), sets);
  check('   ...and writes only status and updated_at', sets, ['status', 'updated_at']);
}

/* ============================================================
   9. Appointment synchronisation
   ============================================================ */
console.log('\n-- 9. The appointment follows, one way only --');
const linked = (status) => ({ ...PARENT, status, appointment_id: 'APT-0001' });
{
  const db = stubDB({ job: linked('Inspection') });
  await move('In Progress', db);
  const appt = db.find('UPDATE appointments');
  ok_('a job card starting work moves its appointment to In Progress', !!appt, db.sql);
  check('   ...that appointment', appt.binds[0], 'APT-0001');
  check('   ...to In Progress', appt.binds[1], 'In Progress');
  ok_('   ...never if the appointment has finished',
    /status NOT IN \('Completed', 'Cancelled', 'No Show'\)/.test(appt.sql), appt.sql);
  ok_('   ...nor if it is already there', /AND status <> \?2/.test(appt.sql), appt.sql);
  ok_('   ...and only if the job card really moved',
    /\(SELECT status FROM job_cards WHERE id = \?4\) = \?2/.test(appt.sql), appt.sql);
  ok_('   ...its source is never written', !/source/.test(appt.sql), appt.sql);
  ok_('   ...and neither is its job card link', !/job_card_id/.test(appt.sql), appt.sql);
  check('   ...all in the same batch', db.batches[0].length, 2);
}
{
  const db = stubDB({ job: linked('In Progress') });
  await move('Completed', db);
  const appt = db.find('UPDATE appointments');
  ok_('a completed job card completes its appointment', !!appt, db.sql);
  check('   ...to Completed', appt.binds[1], 'Completed');
}
for (const [from, to] of [
  ['Received', 'Inspection'], ['Received', 'Cancelled'], ['Inspection', 'Waiting for Approval'],
  ['In Progress', 'Waiting for Parts'], ['In Progress', 'Cancelled'],
  ['Waiting for Parts', 'In Progress'], ['Completed', 'Delivered'],
]) {
  const db = stubDB({ job: linked(from) });
  await move(to, db);
  const touched = !!db.find('UPDATE appointments');
  const shouldTouch = to === 'In Progress' || to === 'Completed';
  ok_(`${from} -> ${to} ${shouldTouch ? 'moves' : 'leaves'} the appointment`,
    touched === shouldTouch, db.sql);
}
{
  const db = stubDB({ job: { ...PARENT, status: 'Inspection', appointment_id: null } });
  await move('In Progress', db);
  ok_('a job card with no appointment writes no appointment statement',
    !db.find('UPDATE appointments'), db.sql);
  check('   ...so the batch is the status update alone', db.batches[0].length, 1);
}
{
  const db = stubDB({ job: linked('Inspection') });
  await move('In Progress', db);
  ok_('the appointment is never read first — the guard is in the statement',
    db.planned('FROM appointments').length === 0, db.sql);
}

/* ============================================================
   10. What a transition does not do
   ============================================================ */
console.log('\n-- 10. The money and the links are left alone --');
{
  const db = stubDB({ job: { ...PARENT, status: 'In Progress' } });
  await move('Completed', db);
  const sets = statusSets(db);
  for (const col of ['paid', 'due', 'subtotal', 'tax', 'total', 'invoice_id',
    'appointment_id', 'customer_id', 'vehicle_id', 'mechanic_id', 'discount', 'tax_rate']) {
    ok_(`${col} is not written by a status change`, !sets.includes(col), sets);
  }
  ok_('no invoice is read or written', !db.find('invoices'), db.sql);
  ok_('no payment is read or written', !db.find('payments'), db.sql);
  ok_('and no job card line is rewritten',
    !db.find('DELETE FROM job_card_services') && !db.find('DELETE FROM job_card_parts'), db.sql);
}
{
  // An invoiced job card's status moves like any other: changeStatus() has no
  // invoice guard, and inventing one here would be a new business rule.
  const db = stubDB({ job: { ...PARENT, status: 'In Progress' } });
  ok_('an invoiced job card can still be completed', (await move('Completed', db)).status === 200);
}
{
  const db = stubDB({ job: { ...PARENT, status: 'Received' } });
  const res = await move('Inspection', db);
  const b = await bodyOf(res);
  ok_('the response is a full job card record', b.data?.id === 'JOB-0001', JSON.stringify(b).slice(0, 200));
  ok_('   ...in the same shape a GET returns',
    'partsUsed' in b.data && 'services' in b.data && !('parts' in b.data), Object.keys(b.data ?? {}));
  ok_('   ...with no paging metadata', !('count' in b) && !('total' in b));
}
{
  const routes = (await (await call('/api/health', { DB: stubDB() }, 'GET')).json()).data.routes;
  check('health advertises the status route', routes.includes('POST /api/job-cards/:id/status'), true);
  check('   ...and the registry is 174 routes', routes.length, 174);
  // C-7 added voiding an invoice and C-8 voiding and linking a payment.
  // Every action route is a POST under a record, and no collection has more
  // than the ones it declares.
  check('   ...alongside the other action routes',
    routes.filter((r) => /\/:id\/[a-z-]+$/.test(r)),
    ['POST /api/job-cards/:id/status', 'POST /api/invoices/:id/void',
      'POST /api/payments/:id/void', 'POST /api/payments/:id/link',
      'POST /api/invoice-adjustments/:id/void',
      // 0005: closing a follow-up, recording a contact, voiding a contact.
      'POST /api/follow-ups/:id/complete', 'POST /api/follow-ups/:id/cancel',
      'POST /api/follow-ups/:id/contact', 'POST /api/follow-up-contacts/:id/void',
      // 0006: starting, completing and cancelling a follow-up task.
      'POST /api/follow-up-tasks/:id/start', 'POST /api/follow-up-tasks/:id/complete',
      'POST /api/follow-up-tasks/:id/cancel',
      // 0007: sending, recording a decision, cancelling and converting an estimate.
      'POST /api/estimates/:id/send', 'POST /api/estimates/:id/approve',
      'POST /api/estimates/:id/reject', 'POST /api/estimates/:id/cancel',
      'POST /api/estimates/:id/convert',
      // 0009: an administrator setting an account's password.
      'POST /api/accounts/:id/password',
      // 0011: approving and rejecting a leave request.
      'POST /api/leave-requests/:id/approve', 'POST /api/leave-requests/:id/reject',
      // 0023: changing a booking's status, adding a note.
      'POST /api/bookings/:id/status', 'POST /api/bookings/:id/notes',
      // 0013: an administrator retiring a tool.
      'POST /api/tools/:id/retire',
      'POST /api/tools/:id/reactivate',
      // 0014: the Messenger inbox's per-conversation routes.
      'GET /api/messenger/conversations/:id/messages', 'POST /api/messenger/conversations/:id/reply',
      'POST /api/messenger/conversations/:id/read', 'PUT /api/messenger/conversations/:id/status',
      // 0015: the WhatsApp inbox's per-conversation routes.
      'GET /api/whatsapp/conversations/:id/messages', 'POST /api/whatsapp/conversations/:id/reply',
      'POST /api/whatsapp/conversations/:id/read', 'POST /api/whatsapp/conversations/:id/unread',
      'PUT /api/whatsapp/conversations/:id/status',
      // 0017: marking one notification read or unread.
      'POST /api/notifications/:id/read', 'POST /api/notifications/:id/unread',
      // 0020: deciding a sync conflict, finalizing or discarding an invoice draft.
      'POST /api/sync/conflicts/:id/resolve', 'POST /api/invoice-drafts/:id/finalize', 'POST /api/invoice-drafts/:id/discard']);
  ok_('   ...and no PUT or DELETE on it',
    !routes.includes('PUT /api/job-cards/:id/status')
      && !routes.includes('DELETE /api/job-cards/:id/status'), routes);
}

console.log(`\nJob card status unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
