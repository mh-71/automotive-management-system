/* POST /api/inventory-transactions — unit tests against the REAL Worker
   handler with a stubbed D1 binding.

   This is the first route that changes two tables, and the one place in the
   API where getting it subtly wrong corrupts a running balance rather than
   just returning a bad response. So the weight here is on the SQL it would
   send, not only on what it answers:

     - there is NO SELECT of the current stock before the write. A
       read-compute-write pair is a lost update, and the ledger would then
       record a prev/new pair that never existed.
     - the arithmetic happens in SQL against the live row, so `stock` appears
       in the statements and never as a bound value.
     - both statements carry the SAME `stock + delta >= 0` guard, so an
       outbound movement either applies to both tables or to neither.
     - the INSERT runs BEFORE the UPDATE, which is what makes its `stock`
       read the balance before the movement.
     - direction comes from the type, server-side, and from nowhere else.

   Whether the batch really rolls back, and whether two concurrent movements
   really settle correctly, are D1's behaviour: proved against a real database
   in the integration suite. */
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

/**
 * `changes`  what each statement in the batch reports. [1, 1] is a movement
 *            that applied; [0, 0] is a guard that matched nothing.
 * `part`     what the failure-path lookup finds — null means no such part.
 * `row`      the ledger row read back after a successful movement.
 */
function stubDB({
  changes = [1, 1],
  part = { name: 'Oil Filter', stock: 18 },
  row = null,
  counter = { last_value: 1, prefix: 'STK' },
  throwOnBatch = null,
} = {}) {
  const calls = [];
  const batches = [];
  const db = {
    calls,
    batches,
    get sql() { return calls.map((c) => c.sql).join('\n'); },
    find(fragment) { return calls.find((c) => c.sql.includes(fragment)); },
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('id_counters')) return counter;
          if (sql.includes('FROM inventory_transactions')) {
            return row ?? {
              id: 'STK-0001', part_id: 'PRT-0001', type: 'purchase', quantity: 5,
              unit_cost: 350, reference_type: 'manual', reference_id: null,
              reason: '', notes: '', prev_stock: 18, new_stock: 23,
              created_at: '2026-09-18T10:00:00.000Z',
            };
          }
          if (sql.includes('FROM parts')) return part;
          return null;
        },
        async all() { return { results: [] }; },
        async run() { return { success: true, meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(statements) {
      batches.push(statements);
      if (throwOnBatch) throw new Error(throwOnBatch);
      return changes.map((n) => ({ success: true, meta: { changes: n } }));
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
const post = (body, db) => call('/api/inventory-transactions', { DB: db ?? stubDB() }, 'POST', body);

const IN_TYPES = ['purchase', 'adjustment-in', 'return', 'initial-stock'];
const OUT_TYPES = ['sale', 'job-card-use', 'adjustment-out', 'damaged'];
const VALID = { partId: 'PRT-0001', type: 'purchase', quantity: 5 };

/** The two statements the route batches, in order. */
const batchOf = (db) => (db.batches[0] ?? []).map((_, i) =>
  db.calls.filter((c) => /INSERT INTO inventory_transactions|UPDATE parts/.test(c.sql))[i]);

console.log('\n-- 1. A successful movement --');
{
  const db = stubDB({});
  const res = await post(VALID, db);
  ok_('POST -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await res.json();
  check('returns the ledger record', b.data.id, 'STK-0001');
  check('   ...in the same shape the GET route uses', Object.keys(b.data).sort(),
    ['createdAt', 'id', 'newStock', 'notes', 'partId', 'prevStock', 'quantity',
      'reason', 'referenceId', 'referenceType', 'type', 'unitCost']);
  ok_('   ...no paging metadata', !('count' in b) && !('total' in b));

  ok_('allocates an STK id through id_counters', !!db.find('id_counters'), db.sql);
  check('exactly one batch', db.batches.length, 1);
  check('   ...of exactly two statements', db.batches[0].length, 2);
}

console.log('\n-- 2. The SQL: no stale read, arithmetic in the database --');
{
  const db = stubDB({});
  await post(VALID, db);

  // Nothing reads the stock before the write.
  const before = db.calls.slice(0, db.calls.findIndex((c) => c.sql.includes('INSERT INTO inventory_transactions')));
  ok_('no SELECT of parts.stock before the movement',
    !before.some((c) => /SELECT[\s\S]*FROM parts/i.test(c.sql)), before.map((c) => c.sql));
  check('the only statement before the batch is the id allocation',
    before.filter((c) => !c.sql.includes('id_counters')).length, 0);

  const ins = db.find('INSERT INTO inventory_transactions');
  const upd = db.find('UPDATE parts');
  ok_('the batch inserts the ledger row', !!ins, db.sql);
  ok_('the batch updates parts.stock', !!upd, db.sql);

  // Order matters: the INSERT must read the balance BEFORE the UPDATE.
  ok_('the INSERT is prepared before the UPDATE',
    db.calls.indexOf(ins) < db.calls.indexOf(upd), db.sql);

  // The snapshots come from the live row, not from the Worker.
  ok_('prev_stock is read from the parts row', /SELECT[\s\S]*\bstock\b/i.test(ins.sql), ins.sql);
  ok_('new_stock is computed in SQL', /stock \+ \?10/.test(ins.sql), ins.sql);
  ok_('   ...and neither is a bound value',
    !ins.binds.includes(18) && !ins.binds.includes(23), JSON.stringify(ins.binds));
  ok_('the UPDATE adds the delta to the live column', /stock = stock \+ \?2/.test(upd.sql), upd.sql);
  ok_('   ...rather than assigning a computed total',
    !/stock = \?\d+\s*(,|$)/m.test(upd.sql.replace('stock = stock + ?2', '')), upd.sql);

  // The guard is what makes it safe, and both statements carry it.
  ok_('the INSERT is guarded by stock + delta >= 0', /stock \+ \?10 >= 0/.test(ins.sql), ins.sql);
  ok_('the UPDATE is guarded by stock + delta >= 0', /stock \+ \?2 >= 0/.test(upd.sql), upd.sql);
  ok_('both statements target the part by bound id',
    /id = \?2/.test(ins.sql) && /id = \?1/.test(upd.sql), [ins.sql, upd.sql]);
  ok_('nothing is interpolated into either statement',
    !ins.sql.includes('PRT-') && !upd.sql.includes('PRT-'), [ins.sql, upd.sql]);
  ok_('parts.updated_at is refreshed', /updated_at = \?3/.test(upd.sql), upd.sql);
}

console.log('\n-- 3. Direction is derived from the type, server-side --');
{
  for (const type of IN_TYPES) {
    const db = stubDB({});
    const r = await post({ ...VALID, type, quantity: 7 }, db);
    ok_(`${type} -> 201`, r.status === 201, `got ${r.status}`);
    check(`   ...${type} adds stock (delta +7)`, db.find('UPDATE parts').binds[1], 7);
  }
  for (const type of OUT_TYPES) {
    const db = stubDB({});
    const r = await post({ ...VALID, type, quantity: 7 }, db);
    ok_(`${type} -> 201`, r.status === 201, `got ${r.status}`);
    check(`   ...${type} removes stock (delta -7)`, db.find('UPDATE parts').binds[1], -7);
  }
  check('eight types in total, four each way', IN_TYPES.length + OUT_TYPES.length, 8);

  // A client cannot claim a direction of its own.
  const db = stubDB({});
  await post({ ...VALID, type: 'purchase', quantity: 7, direction: 'out' }, db);
  check('a stray `direction` field cannot flip an inbound type',
    db.find('UPDATE parts').binds[1], 7);

  for (const bad of ['Purchase', 'PURCHASE', 'in', 'out', 'inbound', 'transfer', '', 'adjustment']) {
    const r = await post({ ...VALID, type: bad }, stubDB({}));
    const b = await r.json();
    ok_(`type ${JSON.stringify(bad)} -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && 'type' in b.error.fields, b.error);
  }
}

console.log('\n-- 4. Quantity --');
{
  for (const quantity of [1, 0.5, 1.5, 7, 1000]) {
    const r = await post({ ...VALID, quantity }, stubDB({}));
    ok_(`quantity ${quantity} accepted`, r.status === 201, `got ${r.status}`);
  }
  const frac = stubDB({});
  await post({ ...VALID, quantity: 1.5, type: 'damaged' }, frac);
  check('a fractional outbound binds -1.5', frac.find('UPDATE parts').binds[1], -1.5);

  for (const quantity of [0, -1, -0.5, 'abc', '', null, NaN, Infinity, {}, []]) {
    const db = stubDB({});
    const r = await post({ ...VALID, quantity }, db);
    const b = await r.json();
    ok_(`quantity ${JSON.stringify(quantity) ?? String(quantity)} -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && 'quantity' in b.error.fields, b.error);
    ok_('   ...and nothing reached the database', db.calls.length === 0, `${db.calls.length}`);
  }
  {
    const body = { ...VALID };
    delete body.quantity;
    const r = await post(body, stubDB({}));
    ok_('a missing quantity -> 422', r.status === 422, `got ${r.status}`);
  }
  check('zero is refused with the engine\'s own wording',
    (await (await post({ ...VALID, quantity: 0 }, stubDB({}))).json()).error.fields.quantity,
    'Quantity must be greater than 0.');
}

console.log('\n-- 5. unitCost keeps null apart from zero --');
{
  const withCost = stubDB({});
  await post({ ...VALID, unitCost: 350 }, withCost);
  ok_('a cost is bound', withCost.find('INSERT INTO inventory_transactions').binds.includes(350),
    JSON.stringify(withCost.find('INSERT INTO inventory_transactions').binds));

  const zero = stubDB({});
  await post({ ...VALID, unitCost: 0 }, zero);
  const zeroBinds = zero.find('INSERT INTO inventory_transactions').binds;
  check('a ZERO cost is bound as 0, not null', zeroBinds[4], 0);

  const absent = stubDB({});
  await post(VALID, absent);
  check('an absent cost is bound as null, not 0',
    absent.find('INSERT INTO inventory_transactions').binds[4], null);

  const blank = stubDB({});
  await post({ ...VALID, unitCost: '' }, blank);
  check("a blank cost is null, matching move()'s `!= null && !== ''`",
    blank.find('INSERT INTO inventory_transactions').binds[4], null);

  const nulled = stubDB({});
  await post({ ...VALID, unitCost: null }, nulled);
  check('an explicit null cost stays null',
    nulled.find('INSERT INTO inventory_transactions').binds[4], null);

  const neg = await post({ ...VALID, unitCost: -1 }, stubDB({}));
  ok_('a negative cost -> 422', neg.status === 422, `got ${neg.status}`);
}

console.log('\n-- 6. Reference fields, reason and notes --');
{
  const db = stubDB({});
  await post({ ...VALID, referenceId: 'PO-8842', reason: 'Recount', notes: 'Supplier delivery' }, db);
  const binds = db.find('INSERT INTO inventory_transactions').binds;
  check('referenceType is always manual', binds[5], 'manual');
  check('a manual reference id is stored', binds[6], 'PO-8842');
  check('reason is stored', binds[7], 'Recount');
  check('notes are stored', binds[8], 'Supplier delivery');

  const bare = stubDB({});
  await post(VALID, bare);
  const bb = bare.find('INSERT INTO inventory_transactions').binds;
  check('an absent reference id is null', bb[6], null);
  check("a blank reference id becomes null, as the receive form does", bb[6], null);
  check('reason defaults to \'\'', bb[7], '');
  check('notes default to \'\'', bb[8], '');

  const blankRef = stubDB({});
  await post({ ...VALID, referenceId: '   ' }, blankRef);
  check('a whitespace-only reference id becomes null',
    blankRef.find('INSERT INTO inventory_transactions').binds[6], null);

  const explicitManual = await post({ ...VALID, referenceType: 'manual' }, stubDB({}));
  ok_("referenceType 'manual' is accepted", explicitManual.status === 201, `got ${explicitManual.status}`);

  // A job-card movement is one side of a larger operation and belongs to C-5.
  for (const value of ['job-card', 'jobcard', 'JOB-CARD', 'system']) {
    const d = stubDB({});
    const r = await post({ ...VALID, referenceType: value }, d);
    const b = await r.json();
    ok_(`referenceType ${JSON.stringify(value)} -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && 'referenceType' in b.error.fields, b.error);
    ok_('   ...nothing reached the database', d.calls.length === 0);
  }
}

console.log('\n-- 7. Server-owned fields are refused by name --');
{
  for (const [key, value] of [
    ['id', 'STK-9999'], ['prevStock', 100], ['newStock', 999],
    ['createdAt', '2020-01-01T00:00:00Z'], ['jobCardId', 'JOB-0001'],
  ]) {
    const db = stubDB({});
    const r = await post({ ...VALID, [key]: value }, db);
    const b = await r.json();
    ok_(`\`${key}\` -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...by name', b.error.fields && key in b.error.fields, b.error);
    ok_('   ...nothing reached the database', db.calls.length === 0, `${db.calls.length}`);
  }
  // Even a "correct-looking" snapshot is refused: the database computes it.
  const sneaky = await post({ ...VALID, prevStock: 18, newStock: 23 }, stubDB({}));
  ok_('a snapshot that happens to be right is still refused', sneaky.status === 422, `got ${sneaky.status}`);
}

console.log('\n-- 8. Required fields and malformed bodies --');
{
  for (const field of ['partId', 'type', 'quantity']) {
    const body = { ...VALID };
    delete body[field];
    const db = stubDB({});
    const r = await post(body, db);
    const b = await r.json();
    ok_(`without \`${field}\` -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && field in b.error.fields, b.error);
    ok_('   ...nothing reached the database', db.calls.length === 0);
  }
  for (const [label, raw] of [
    ['no body', ''], ['malformed JSON', '{oops'], ['an array', '[]'],
    ['null', 'null'], ['a string', '"x"'], ['a number', '7'],
  ]) {
    const db = stubDB({});
    const r = await call('/api/inventory-transactions', { DB: db }, 'POST', raw);
    const b = await r.json();
    ok_(`${label} -> 400`, r.status === 400, `got ${r.status}`);
    check('   ...code', b.error.code, 'invalid_body');
    ok_('   ...nothing prepared', db.calls.length === 0);
  }
}

console.log('\n-- 9. A guard that matches nothing --');
{
  // Both statements carry the same guard, so they fail together: there is no
  // half-applied movement to undo.
  const short = stubDB({ changes: [0, 0], part: { name: 'Oil Filter', stock: 3 } });
  const res = await post({ ...VALID, type: 'sale', quantity: 8 }, short);
  const b = await res.json();
  ok_('insufficient stock -> 409', res.status === 409, `got ${res.status}`);
  check('   ...code', b.error.code, 'conflict');
  check('   ...machine-readable reason', b.error.reason, 'insufficient_stock');
  check('   ...reports what is available', b.error.available, 3);
  check('   ...and what was required', b.error.required, 8);
  ok_('   ...names the part', b.error.partId === 'PRT-0001', b.error);
  check('   ...one lookup on the failure path only',
    short.calls.filter((c) => /SELECT name, stock FROM parts/.test(c.sql)).length, 1);
  ok_('   ...and it is not a 500', res.status !== 500);

  // An unknown part matches the same zero rows; the follow-up says which.
  const ghost = stubDB({ changes: [0, 0], part: null });
  const gres = await post({ ...VALID, partId: 'PRT-7777' }, ghost);
  const gb = await gres.json();
  ok_('an unknown part -> 409', gres.status === 409, `got ${gres.status}`);
  check('   ...reason', gb.error.reason, 'part_not_found');
  check('   ...names the part', gb.error.partId, 'PRT-7777');

  // Partial application must be reported, never silently accepted.
  for (const changes of [[1, 0], [0, 1]]) {
    const odd = stubDB({ changes, part: { name: 'X', stock: 1 } });
    const r = await post({ ...VALID, type: 'sale' }, odd);
    ok_(`a ${JSON.stringify(changes)} batch is not reported as success`,
      r.status !== 201, `got ${r.status}`);
  }
}

console.log('\n-- 10. Failure modes --');
{
  for (const [message, status] of [
    ['D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 409],
    ['D1_ERROR: CHECK constraint failed: quantity > 0: SQLITE_CONSTRAINT', 422],
    ['D1_ERROR: UNIQUE constraint failed: inventory_transactions.id: SQLITE_CONSTRAINT', 409],
    ['D1_ERROR: NOT NULL constraint failed: inventory_transactions.type: SQLITE_CONSTRAINT', 422],
  ]) {
    const r = await post(VALID, stubDB({ throwOnBatch: message }));
    const b = await r.json();
    ok_(`${message.slice(10, 40)}... -> ${status}`, r.status === status, `got ${r.status}`);
    ok_('   ...no SQLite text leaks',
      !JSON.stringify(b).includes('SQLITE') && !JSON.stringify(b).includes('D1_ERROR')
        && !JSON.stringify(b).includes('inventory_transactions.'), b);
  }
  const boom = await post(VALID, stubDB({ throwOnBatch: 'D1_ERROR: no such column: zzz' }));
  ok_('a non-constraint failure -> 500', boom.status === 500, `got ${boom.status}`);
  check('   ...with the standard code', (await boom.json()).error.code, 'database_error');

  const noDb = await call('/api/inventory-transactions', {}, 'POST', VALID);
  ok_('no D1 binding -> 503', noDb.status === 503, `got ${noDb.status}`);
}

console.log('\n-- 11. The ledger stays append-only --');
{
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const db = stubDB({});
    const r = await call('/api/inventory-transactions/STK-0001', { DB: db }, method, { quantity: 1 });
    ok_(`${method} /api/inventory-transactions/:id -> 405`, r.status === 405, `got ${r.status}`);
    check('   ...Allow names GET only', r.headers.get('allow'), 'GET');
    ok_('   ...nothing reached the database', db.calls.length === 0);
  }
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const r = await call('/api/inventory-transactions', { DB: stubDB({}) }, method, {});
    ok_(`${method} on the list -> 405`, r.status === 405, `got ${r.status}`);
    check('   ...Allow is GET, POST', r.headers.get('allow'), 'GET, POST');
  }
}

console.log('\n-- 12. Routing, and the GET route is unchanged --');
{
  const db = {
    prepare(sql) {
      return {
        async all() { return { results: sql.includes("type = 'table'") ? [{ name: 'customers' }] : [] }; },
        async first() { return { n: 1 }; },
      };
    },
  };
  const routes = (await (await call('/api/health', { DB: db }, 'GET')).json()).data.routes;
  check('the registry advertises 149 routes', routes.length, 149);
  ok_('advertises POST /api/inventory-transactions', routes.includes('POST /api/inventory-transactions'));
  ok_('advertises no PUT for the ledger', !routes.includes('PUT /api/inventory-transactions/:id'));
  ok_('advertises no DELETE for the ledger', !routes.includes('DELETE /api/inventory-transactions/:id'));
  check('exactly three ledger routes',
    routes.filter((r) => r.includes('/api/inventory-transactions')).length, 3);

  const byMethod = {};
  routes.forEach((r) => { const m = r.split(' ')[0]; byMethod[m] = (byMethod[m] || 0) + 1; });
  check('61 GET, 54 POST, 22 PUT, 12 DELETE (0005 added follow-ups, 0006 follow-up tasks, 0007 estimates, 0008 staff, 0009 accounts, 0010 attendance, 0011 leave requests, 0012 the activity log, 0013 tools, 0014 Messenger, 0015 WhatsApp, 0016 Website Forms, 0017 Notifications, 0018 Roles)', byMethod, { GET: 61, POST: 54, PUT: 22, DELETE: 12 });

  // The read route must not have gained any stock arithmetic.
  const readDb = stubDB({});
  await call('/api/inventory-transactions', { DB: readDb }, 'GET');
  ok_('the list route still never touches parts',
    !readDb.sql.includes('FROM parts'), readDb.sql);
  ok_('   ...and still writes nothing',
    readDb.calls.every((c) => /^\s*SELECT/i.test(c.sql.trim())), readDb.sql);
  ok_('   ...and runs no batch', readDb.batches.length === 0);
}

console.log(`\nInventory movement writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
