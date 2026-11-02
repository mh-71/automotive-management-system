/* POST / PUT / DELETE for the six simple entities — unit tests against the
   REAL Worker handlers with a stubbed D1 binding.

   These assert the decisions the route makes: which fields it accepts, what
   it refuses and with which status, the exact SQL and bindings it would send,
   and that a rejected request never reaches the database. Whether the row
   actually lands, whether a foreign key really fires, and whether a
   multi-statement delete really rolls back are D1's behaviour and are proved
   in the integration suite instead.

   Four rules get disproportionate weight, because each is a place where a
   plausible-looking implementation would quietly lose data:

     - PUT MERGES. A field absent from the body must not be written, or every
       edit form that sends one field would blank the rest of the record.
     - `stock` is not writable on parts, in either direction.
     - An active expense cannot be deleted, only voided first.
     - zero and '' survive every validator. */
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
 * A D1 stub that answers the four statement shapes a write route produces.
 *
 * `conflict`  a row returned by a beforeWrite/beforeDelete lookup (a duplicate,
 *             or a part's usage counts) — null means "nothing in the way".
 * `returning` the row an INSERT/UPDATE ... RETURNING hands back; null makes an
 *             UPDATE report "no such id", which is how the route 404s.
 * `changes`   what DELETE reports.
 */
function stubDB({ conflict = null, returning = { id: 'X-0001' }, changes = 1, throwOn = null, counter = { last_value: 1, prefix: 'CUS' } } = {}) {
  const calls = [];
  const batches = [];
  const db = {
    calls,
    batches,
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
          if (throwOn && sql.includes(throwOn)) throw new Error(throwOn === 'UNIQUE' ? 'D1_ERROR: UNIQUE constraint failed: x.y: SQLITE_CONSTRAINT' : throwOn);
          if (sql.includes('id_counters')) return counter;
          if (/^\s*(INSERT|UPDATE)/i.test(sql)) return returning;
          return conflict;                       // a guard lookup
        },
        async all() { return { results: conflict ? [conflict] : [] }; },
        async run() {
          if (throwOn && sql.includes(throwOn)) throw new Error(throwOn);
          return { success: true, meta: { changes } };
        },
      };
      return stmt;
    },
    async batch(statements) {
      batches.push(statements);
      if (throwOn === 'BATCH') throw new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT');
      return statements.map(() => ({ success: true, meta: { changes } }));
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

const post = (path, body, db) => call(path, { DB: db ?? stubDB() }, 'POST', body);
const put = (path, body, db) => call(path, { DB: db ?? stubDB() }, 'PUT', body);
const del = (path, db) => call(path, { DB: db ?? stubDB() }, 'DELETE');

const VALID = {
  customers: { name: 'Rahim Uddin', phone: '01711-223344' },
  vehicles: { customerId: 'CUS-0001', regNo: 'DHA-1234', brand: 'Toyota', model: 'Axio' },
  services: { name: 'Oil Change', category: 'Engine', price: 1200 },
  mechanics: { name: 'Karim', phone: '01811-223344', specialization: 'Engine' },
  parts: { name: 'Oil Filter', partNo: 'of-1', category: 'Filters', unit: 'pc', purchasePrice: 350, sellingPrice: 500, minStock: 5 },
  expenses: { date: '2026-09-18', category: 'Tools', description: 'Wrench', amount: 1200, method: 'Cash' },
};
const ID = {
  customers: 'CUS-0001', vehicles: 'VEH-0001', services: 'SRV-0001',
  mechanics: 'MEC-0001', parts: 'PRT-0001', expenses: 'EXP-0001',
};
const ENTITIES = Object.keys(VALID);

console.log('\n-- 1. POST: the happy path, for all six --');
for (const e of ENTITIES) {
  const db = stubDB({ returning: { id: ID[e], name: 'x', status: 'Active' } });
  const res = await post(`/api/${e}`, VALID[e], db);
  ok_(`POST /api/${e} -> 201`, res.status === 201, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  const b = await res.json();
  ok_(`   ...returns the created ${e} record`, b.data && b.data.id === ID[e], b);
  ok_('   ...no paging metadata on a single record', !('count' in b) && !('total' in b));

  // The id comes from id_counters, never from the body or a local counter.
  const alloc = db.find('id_counters');
  ok_('   ...allocates through id_counters', !!alloc, db.sql);
  ok_('   ...with UPDATE ... RETURNING', /UPDATE[\s\S]*RETURNING/i.test(alloc.sql), alloc.sql);

  const insert = db.find('INSERT INTO');
  ok_('   ...issues one INSERT', !!insert, db.sql);
  ok_('   ...which RETURNINGs the row rather than re-SELECTing it',
    /RETURNING/i.test(insert.sql) && !/^\s*SELECT/i.test(insert.sql), insert.sql);
  const insertedColumns = insert.sql.slice(insert.sql.indexOf('('), insert.sql.indexOf(')'));
  ok_('   ...sets created_at', insertedColumns.includes('created_at'), insertedColumns);
  ok_('   ...does not set updated_at on create',
    !insertedColumns.includes('updated_at'), insertedColumns);
  ok_('   ...every value is bound, none interpolated',
    insert.binds.length > 0 && /\?\d/.test(insert.sql) && !insert.sql.includes("'"), insert.sql);
  ok_('   ...binds the allocated id', insert.binds.includes(`${ID[e].split('-')[0]}-0001`) || insert.binds.includes('CUS-0001'),
    JSON.stringify(insert.binds));
}

console.log('\n-- 2. POST: required fields --');
{
  const required = {
    customers: ['name', 'phone'],
    vehicles: ['customerId', 'regNo', 'brand', 'model'],
    services: ['name', 'category', 'price'],
    mechanics: ['name', 'phone', 'specialization'],
    parts: ['name', 'partNo', 'category', 'unit', 'purchasePrice', 'sellingPrice', 'minStock'],
    expenses: ['date', 'category', 'description', 'amount', 'method'],
  };
  for (const e of ENTITIES) {
    for (const field of required[e]) {
      const body = { ...VALID[e] };
      delete body[field];
      const db = stubDB();
      const res = await post(`/api/${e}`, body, db);
      const b = await res.json();
      ok_(`${e} without \`${field}\` -> 422`, res.status === 422, `got ${res.status}`);
      ok_(`   ...names the field`, b.error.fields && field in b.error.fields, b.error);
      ok_('   ...and never reaches the database', db.calls.length === 0, `${db.calls.length} statements`);
    }
  }
}

console.log('\n-- 3. POST: malformed bodies --');
for (const e of ENTITIES) {
  for (const [label, raw] of [
    ['no body', ''], ['malformed JSON', '{oops'], ['a JSON array', '[]'],
    ['JSON null', 'null'], ['a JSON string', '"x"'],
  ]) {
    const db = stubDB();
    const res = await call(`/api/${e}`, { DB: db }, 'POST', raw);
    const b = await res.json();
    ok_(`${e} POST with ${label} -> 400`, res.status === 400, `got ${res.status}`);
    ok_('   ...code is invalid_body', b.error.code === 'invalid_body', b.error);
    ok_('   ...no statement prepared', db.calls.length === 0);
  }
}

console.log('\n-- 4. PUT merges, it does not replace --');
for (const e of ENTITIES) {
  // Expenses only accepts notes; every other entity takes its own first field.
  // services is the one table here with no `notes` column, so it edits the
  // optional text field it does have.
  const textField = e === 'services' ? 'description' : 'notes';
  const oneField = { [textField]: 'a note' };
  const db = stubDB({ returning: { id: ID[e] } });
  const res = await put(`/api/${e}/${ID[e]}`, oneField, db);
  ok_(`PUT /api/${e}/:id with one field -> 200`, res.status === 200,
    `got ${res.status} ${JSON.stringify(await res.clone().json())}`);

  const stmt = db.calls.find((c) => /^\s*UPDATE/i.test(c.sql) && !c.sql.includes('id_counters'));
  ok_('   ...issues an UPDATE', !!stmt, db.sql);
  const setClause = stmt.sql.slice(stmt.sql.indexOf('SET'), stmt.sql.indexOf('WHERE'));
  ok_('   ...sets exactly the supplied column plus updated_at',
    (setClause.match(/=\s*\?\d+/g) || []).length === 2, setClause);
  ok_(`   ...touches ${textField}`, setClause.includes(`${textField} =`), setClause);
  ok_('   ...refreshes updated_at', setClause.includes('updated_at ='), setClause);
  ok_('   ...does NOT write any other column',
    !/\b(name|phone|brand|model|category|amount|price|purchase_price)\s*=/.test(setClause), setClause);
  ok_('   ...returns the merged row without a second SELECT',
    /RETURNING/i.test(stmt.sql) && db.calls.filter((c) => /^\s*SELECT/i.test(c.sql)).length === 0,
    db.sql);
  ok_('   ...no id is allocated on an update', !db.find('id_counters'), db.sql);
}

console.log('\n-- 5. PUT: ids, empty bodies and unknown rows --');
for (const e of ENTITIES) {
  const bad = await put(`/api/${e}/not-an-id`, e === 'services' ? { description: 'x' } : { notes: 'x' });
  ok_(`${e} PUT with a malformed id -> 400`, bad.status === 400, `got ${bad.status}`);

  const db = stubDB();
  const empty = await put(`/api/${e}/${ID[e]}`, {}, db);
  ok_(`${e} PUT with an empty body -> 422`, empty.status === 422, `got ${empty.status}`);
  ok_('   ...and prepares nothing', db.calls.length === 0, `${db.calls.length}`);

  const editable = e === 'services' ? { description: 'x' } : { notes: 'x' };
  const missing = await put(`/api/${e}/${ID[e]}`, editable, stubDB({ returning: null }));
  ok_(`${e} PUT on an unknown id -> 404`, missing.status === 404, `got ${missing.status}`);
  const mb = await missing.json();
  ok_('   ...code is not_found', mb.error.code === 'not_found', mb.error);
}

console.log('\n-- 6. DELETE --');
for (const e of ENTITIES) {
  const db = stubDB({ changes: 1, conflict: e === 'expenses' ? { status: 'Void' } : e === 'parts' ? { stock: 0, movements: 0, usage_count: 0 } : null });
  const res = await del(`/api/${e}/${ID[e]}`, db);
  ok_(`DELETE /api/${e}/:id -> 200`, res.status === 200, `got ${res.status} ${JSON.stringify(await res.clone().json())}`);
  check(`   ...reports what was removed`, await res.json(), { data: { id: ID[e], deleted: true } });

  const gone = await del(`/api/${e}/${ID[e]}`, stubDB({
    changes: 0,
    conflict: e === 'expenses' ? { status: 'Void' } : e === 'parts' ? { stock: 0, movements: 0, usage_count: 0 } : null,
  }));
  ok_(`   ...an unknown id -> 404`, gone.status === 404, `got ${gone.status}`);

  const bad = await del(`/api/${e}/nope`);
  ok_(`   ...a malformed id -> 400`, bad.status === 400, `got ${bad.status}`);
}

console.log('\n-- 7. A referenced row is a 409, from the database itself --');
for (const e of ['customers', 'vehicles', 'services', 'mechanics']) {
  const db = stubDB({ throwOn: 'DELETE FROM' });
  db.prepare = ((orig) => (sql) => {
    const stmt = orig(sql);
    if (/^\s*DELETE FROM/i.test(sql)) {
      stmt.run = async () => { throw new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'); };
    }
    return stmt;
  })(db.prepare.bind(db));

  const res = await del(`/api/${e}/${ID[e]}`, db);
  const b = await res.json();
  ok_(`${e} still referenced -> 409`, res.status === 409, `got ${res.status}`);
  ok_('   ...code is conflict', b.error.code === 'conflict', b.error);
  ok_('   ...no SQLite text leaks', !JSON.stringify(b).includes('SQLITE') && !JSON.stringify(b).includes('D1_ERROR'), b);
  // The foreign keys are NOT re-checked in JS before the attempt.
  ok_('   ...no pre-flight SELECT counted references',
    !db.calls.some((c) => /SELECT[\s\S]*count\(\*\)[\s\S]*FROM (vehicles|job_cards|invoices|appointments)/i.test(c.sql)),
    db.sql);
}

console.log('\n-- 8. Application-level uniqueness -> 409 --');
{
  const cases = [
    ['customers', { ...VALID.customers }, { id: 'CUS-0009', name: 'Someone' }, 'phone'],
    ['vehicles', { ...VALID.vehicles }, { id: 'VEH-0009', reg_no: 'DHA 1234' }, 'regNo'],
    ['services', { ...VALID.services }, { id: 'SRV-0009' }, 'name'],
    ['mechanics', { ...VALID.mechanics }, { id: 'MEC-0009', name: 'Other' }, 'phone'],
    ['parts', { ...VALID.parts }, { id: 'PRT-0009', name: 'Other Filter' }, 'partNo'],
  ];
  for (const [e, body, clash, field] of cases) {
    const db = stubDB({ conflict: clash });
    const res = await post(`/api/${e}`, body, db);
    const b = await res.json();
    ok_(`${e}: a duplicate -> 409`, res.status === 409, `got ${res.status} ${JSON.stringify(b)}`);
    ok_('   ...names the clashing record', b.error.conflictsWith === clash.id, b.error);
    ok_(`   ...and the field (${field})`, b.error.field === field, b.error);
    ok_('   ...nothing was inserted', !db.find('INSERT INTO'), db.sql);
    ok_('   ...and no id was burned', !db.find('id_counters'), db.sql);
  }
}

console.log('\n-- 9. parts: stock is not writable, in either direction --');
{
  for (const [label, body] of [
    ['stock on create', { ...VALID.parts, stock: 99 }],
    ['stock: 0 on create', { ...VALID.parts, stock: 0 }],
    ['openingStock on create', { ...VALID.parts, openingStock: 12 }],
  ]) {
    const db = stubDB();
    const res = await post('/api/parts', body, db);
    const b = await res.json();
    ok_(`${label} -> 422`, res.status === 422, `got ${res.status}`);
    ok_('   ...names stock or openingStock',
      !!(b.error.fields && (b.error.fields.stock || b.error.fields.openingStock)), b.error);
    ok_('   ...nothing reached the database', db.calls.length === 0, `${db.calls.length}`);
  }
  for (const [label, body] of [
    ['stock on update', { stock: 50 }],
    ['stock: 0 on update', { stock: 0 }],
    ['stock alongside a legal field', { notes: 'ok', stock: 5 }],
  ]) {
    const db = stubDB();
    const res = await put('/api/parts/PRT-0001', body, db);
    ok_(`${label} -> 422`, res.status === 422, `got ${res.status}`);
    ok_('   ...nothing reached the database', db.calls.length === 0, `${db.calls.length}`);
  }
  // A legal create must not mention stock at all: the column's DEFAULT 0 is
  // what sets the opening balance, exactly as inventory.js:342 does.
  const okDb = stubDB({ returning: { id: 'PRT-0001' } });
  await post('/api/parts', VALID.parts, okDb);
  const insert = okDb.find('INSERT INTO parts');
  // Only the column list — the RETURNING clause legitimately reads stock back.
  const written = insert.sql.slice(insert.sql.indexOf('('), insert.sql.indexOf(')'));
  ok_('a valid create never writes the stock column', !/\bstock\b/.test(written), written);
  ok_('   ...though it still returns it', /\bstock\b/.test(insert.sql), insert.sql);
  ok_('   ...and writes no inventory transaction', !okDb.sql.includes('inventory_transactions'), okDb.sql);

  // Normalisation matches inventory.js:281-282.
  ok_('partNo is upper-cased', insert.binds.includes('OF-1'), JSON.stringify(insert.binds));
  const spaced = stubDB({ returning: { id: 'PRT-0002' } });
  await post('/api/parts', { ...VALID.parts, name: 'Oil   Filter  X' }, spaced);
  ok_('runs of whitespace in the name collapse',
    spaced.find('INSERT INTO parts').binds.includes('Oil Filter X'),
    JSON.stringify(spaced.find('INSERT INTO parts').binds));
}

console.log('\n-- 10. parts: the delete guard and its batch --');
{
  for (const [label, state] of [
    ['stock left', { stock: 4, movements: 0, usage_count: 0 }],
    ['fractional stock left', { stock: 0.5, movements: 0, usage_count: 0 }],
    ['stock movements', { stock: 0, movements: 3, usage_count: 0 }],
    ['job card usage', { stock: 0, movements: 0, usage_count: 2 }],
    ['all three', { stock: 9, movements: 3, usage_count: 2 }],
  ]) {
    const db = stubDB({ conflict: state });
    const res = await del('/api/parts/PRT-0001', db);
    const b = await res.json();
    ok_(`a part with ${label} -> 409`, res.status === 409, `got ${res.status}`);
    ok_('   ...reason is machine-readable', b.error.reason === 'part_in_use', b.error);
    ok_('   ...carries the counts', b.error.stock === state.stock && b.error.movements === state.movements, b.error);
    ok_('   ...nothing was deleted', db.batches.length === 0, JSON.stringify(db.batches.length));
  }

  // Clear to delete: the opening-stock rows and the part go together.
  const db = stubDB({ conflict: { stock: 0, movements: 0, usage_count: 0 }, changes: 1 });
  const res = await del('/api/parts/PRT-0001', db);
  ok_('a clear part deletes -> 200', res.status === 200, `got ${res.status}`);
  ok_('   ...in ONE batch', db.batches.length === 1, `${db.batches.length}`);
  check('   ...of exactly two statements', db.batches[0].length, 2);
  const batchSql = db.calls.filter((c) => /^\s*DELETE/i.test(c.sql)).map((c) => c.sql);
  ok_('   ...ledger rows first, then the part',
    batchSql[0].includes('inventory_transactions') && batchSql[1].includes('FROM parts'), batchSql);
  ok_('   ...the guard was one query, not three',
    db.calls.filter((c) => /^\s*SELECT/i.test(c.sql)).length === 1, db.sql);

  // A batch that fails maps like any other constraint error.
  const boom = await del('/api/parts/PRT-0001', stubDB({
    conflict: { stock: 0, movements: 0, usage_count: 0 }, throwOn: 'BATCH',
  }));
  ok_('a failing batch -> 409, not 500', boom.status === 409, `got ${boom.status}`);
}

console.log('\n-- 11. expenses: void is the only edit, and delete needs it --');
{
  const rejected = ['amount', 'date', 'category', 'description', 'method', 'payee', 'reference'];
  for (const field of rejected) {
    const db = stubDB();
    const res = await put('/api/expenses/EXP-0001', { [field]: 'x' }, db);
    const b = await res.json();
    ok_(`PUT expenses.${field} -> 422`, res.status === 422, `got ${res.status}`);
    ok_('   ...names the field', b.error.fields && field in b.error.fields, b.error);
    ok_('   ...nothing reached the database', db.calls.length === 0);
  }
  const okNotes = await put('/api/expenses/EXP-0001', { notes: 'fine' }, stubDB({ returning: { id: 'EXP-0001' } }));
  ok_('PUT expenses.notes -> 200', okNotes.status === 200, `got ${okNotes.status}`);

  const voided = await put('/api/expenses/EXP-0001', { status: 'Void' }, stubDB({ returning: { id: 'EXP-0001' } }));
  ok_('PUT status Void -> 200', voided.status === 200, `got ${voided.status}`);

  const unvoid = await put('/api/expenses/EXP-0001', { status: 'Active' }, stubDB());
  ok_('un-voiding -> 422', unvoid.status === 422, `got ${unvoid.status}`);

  // Void keeps the amount: the UPDATE must not touch it.
  const db = stubDB({ returning: { id: 'EXP-0001' } });
  await put('/api/expenses/EXP-0001', { status: 'Void' }, db);
  const stmt = db.calls.find((c) => /^\s*UPDATE/i.test(c.sql));
  ok_('voiding writes status and updated_at only', !/\bamount\s*=/.test(stmt.sql), stmt.sql);

  // Delete needs Void first.
  const active = await del('/api/expenses/EXP-0001', stubDB({ conflict: { status: 'Active' } }));
  const ab = await active.json();
  ok_('deleting an Active expense -> 409', active.status === 409, `got ${active.status}`);
  ok_('   ...reason is machine-readable', ab.error.reason === 'expense_is_active', ab.error);
  const voidDel = await del('/api/expenses/EXP-0001', stubDB({ conflict: { status: 'Void' }, changes: 1 }));
  ok_('deleting a Void expense -> 200', voidDel.status === 200, `got ${voidDel.status}`);

  // Amount must be positive — the column's CHECK, mirrored in validation.
  for (const amount of [0, -1, '', 'abc']) {
    const res = await post('/api/expenses', { ...VALID.expenses, amount }, stubDB());
    ok_(`amount ${JSON.stringify(amount)} -> 422`, res.status === 422, `got ${res.status}`);
  }
  const methodBad = await post('/api/expenses', { ...VALID.expenses, method: 'Crypto' }, stubDB());
  ok_('an unknown payment method -> 422', methodBad.status === 422, `got ${methodBad.status}`);
}

console.log('\n-- 12. Field values: zero and empty survive --');
{
  // A free service is a real service.
  const db = stubDB({ returning: { id: 'SRV-0001' } });
  const res = await post('/api/services', { ...VALID.services, price: 0 }, db);
  ok_('price 0 is accepted', res.status === 201, `got ${res.status}`);
  ok_('   ...and 0 is what gets bound', db.find('INSERT INTO services').binds.includes(0),
    JSON.stringify(db.find('INSERT INTO services').binds));

  const zeroes = stubDB({ returning: { id: 'MEC-0001' } });
  await post('/api/mechanics', { ...VALID.mechanics, experience: 0, salary: 0, commissionRate: 0 }, zeroes);
  const binds = zeroes.find('INSERT INTO mechanics').binds;
  check('a mechanic with three zeroes binds three zeroes',
    binds.filter((x) => x === 0).length, 3);

  // Absent nullable numerics stay null, never 0.
  const sparse = stubDB({ returning: { id: 'MEC-0002' } });
  await post('/api/mechanics', VALID.mechanics, sparse);
  const sb = sparse.find('INSERT INTO mechanics').binds;
  ok_('absent nullable numerics bind null, not 0', sb.includes(null), JSON.stringify(sb));

  // Out-of-range values are refused.
  for (const [entity, body, field] of [
    ['services', { ...VALID.services, price: -1 }, 'price'],
    ['mechanics', { ...VALID.mechanics, commissionRate: 101 }, 'commissionRate'],
    ['mechanics', { ...VALID.mechanics, experience: -1 }, 'experience'],
    ['vehicles', { ...VALID.vehicles, year: 2201 }, 'year'],
    ['vehicles', { ...VALID.vehicles, mileage: -5 }, 'mileage'],
    ['parts', { ...VALID.parts, purchasePrice: -1 }, 'purchasePrice'],
  ]) {
    const r = await post(`/api/${entity}`, body, stubDB());
    const b = await r.json();
    ok_(`${entity}.${field} out of range -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && field in b.error.fields, b.error);
  }

  // Format rules carried over from the frontend forms.
  for (const [entity, body, field] of [
    ['customers', { ...VALID.customers, phone: 'call me' }, 'phone'],
    ['customers', { ...VALID.customers, email: 'not-an-email' }, 'email'],
    ['mechanics', { ...VALID.mechanics, phone: '12' }, 'phone'],
    ['mechanics', { ...VALID.mechanics, joiningDate: '2099-01-01' }, 'joiningDate'],
    ['mechanics', { ...VALID.mechanics, joiningDate: '1970-01-01' }, 'joiningDate'],
    ['expenses', { ...VALID.expenses, date: '18-09-2026' }, 'date'],
  ]) {
    const r = await post(`/api/${entity}`, body, stubDB());
    const b = await r.json();
    ok_(`${entity}.${field} invalid -> 422`, r.status === 422, `got ${r.status}`);
    ok_('   ...names the field', b.error.fields && field in b.error.fields, b.error);
  }

  // Vehicle year: optional; when given, exactly 4 digits and 1900-2200.
  for (const year of ['0000', '0024', 1899, 2201, 24, '123', '12345', '20A4', '2024abc', -2024, '+2024', '20 24', '2 024', 2024.5]) {
    const db = stubDB();
    const r = await post('/api/vehicles', { ...VALID.vehicles, year }, db);
    const b = await r.json();
    ok_(`vehicles.year ${JSON.stringify(year)} -> 422`, r.status === 422 && b.error.fields && 'year' in b.error.fields, `got ${r.status}`);
    ok_('   ...and never reaches the database', !db.find('INSERT INTO vehicles'));
  }
  for (const year of [1900, 1950, 2024, 2200, '1998', '', null]) {
    const db = stubDB({ returning: { id: 'VEH-0001' } });
    const r = await post('/api/vehicles', { ...VALID.vehicles, year }, db);
    ok_(`vehicles.year ${JSON.stringify(year)} -> 201`, r.status === 201, `got ${r.status}`);
    const want = year === '' || year === null ? null : Number(year);
    ok_('   ...binds ' + JSON.stringify(want), db.find('INSERT INTO vehicles').binds.includes(want), JSON.stringify(db.find('INSERT INTO vehicles').binds));
  }
  const yearPut = await put('/api/vehicles/VEH-0001', { year: '0024' }, stubDB({ returning: { id: 'VEH-0001' } }));
  ok_('PUT vehicles.year "0024" -> 422', yearPut.status === 422, `got ${yearPut.status}`);
}

console.log('\n-- 13. Constraint errors from the database --');
for (const [label, message, status] of [
  ['a UNIQUE violation', 'D1_ERROR: UNIQUE constraint failed: vehicles.reg_no: SQLITE_CONSTRAINT', 409],
  ['a FOREIGN KEY violation', 'D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 409],
  ['a CHECK violation', 'D1_ERROR: CHECK constraint failed: price >= 0: SQLITE_CONSTRAINT', 422],
  ['a NOT NULL violation', 'D1_ERROR: NOT NULL constraint failed: vehicles.brand: SQLITE_CONSTRAINT', 422],
]) {
  const db = stubDB({ throwOn: 'INSERT INTO' });
  db.prepare = ((orig) => (sql) => {
    const stmt = orig(sql);
    if (/INSERT INTO/i.test(sql)) stmt.first = async () => { throw new Error(message); };
    return stmt;
  })(db.prepare.bind(db));

  const res = await post('/api/vehicles', VALID.vehicles, db);
  const b = await res.json();
  ok_(`${label} -> ${status}`, res.status === status, `got ${res.status}`);
  ok_('   ...no SQLite text leaks',
    !JSON.stringify(b).includes('SQLITE') && !JSON.stringify(b).includes('D1_ERROR')
      && !JSON.stringify(b).includes('reg_no'), b);
}
{
  // Anything that is not a constraint failure is still a 500.
  const db = stubDB();
  db.prepare = ((orig) => (sql) => {
    const stmt = orig(sql);
    if (/INSERT INTO/i.test(sql)) stmt.first = async () => { throw new Error('D1_ERROR: no such column: zzz'); };
    return stmt;
  })(db.prepare.bind(db));
  const res = await post('/api/vehicles', VALID.vehicles, db);
  ok_('a non-constraint failure is still a 500', res.status === 500, `got ${res.status}`);
  const b = await res.json();
  ok_('   ...with the standard database_error code', b.error.code === 'database_error', b.error);
}

console.log('\n-- 14. No D1 binding --');
for (const e of ENTITIES) {
  for (const [method, path, body] of [
    ['POST', `/api/${e}`, VALID[e]],
    ['PUT', `/api/${e}/${ID[e]}`, e === 'services' ? { description: 'x' } : { notes: 'x' }],
    ['DELETE', `/api/${e}/${ID[e]}`, undefined],
  ]) {
    const res = await call(path, {}, method, body);
    ok_(`${method} /api/${e} without a binding -> 503`, res.status === 503, `got ${res.status}`);
  }
}

console.log('\n-- 15. The read-only collections are still read-only --');
// Appointments left this list in C-3, job cards in C-5, invoices in C-7 and
// payments in C-8, so nothing is read-only any more. The ledger left the POST
// half of it in C-4 -- it accepts a movement but is still append-only, so it
// is asserted separately below.
for (const e of []) {
  const db = stubDB();
  const res = await post(`/api/${e}`, { anything: 1 }, db);
  ok_(`POST /api/${e} -> 405`, res.status === 405, `got ${res.status}`);
  check(`   ...Allow names GET only`, res.headers.get('allow'), 'GET');
  ok_('   ...nothing reached the database', db.calls.length === 0);

  for (const m of ['PUT', 'DELETE']) {
    const r = await call(`/api/${e}/ABC-0001`, { DB: stubDB() }, m, { x: 1 });
    ok_(`${m} /api/${e}/:id -> 405`, r.status === 405, `got ${r.status}`);
    check(`   ...Allow names GET only`, r.headers.get('allow'), 'GET');
  }
}
{
  // The ledger accepts POST as of C-4 but remains append-only: a recorded
  // movement is never edited or removed.
  const db = stubDB();
  const created = await post('/api/inventory-transactions', { partId: 'PRT-0001' }, db);
  ok_('POST /api/inventory-transactions is a real route', created.status !== 405, `got ${created.status}`);
  for (const m of ['PUT', 'DELETE']) {
    const r = await call('/api/inventory-transactions/STK-0001', { DB: stubDB() }, m, { x: 1 });
    ok_(`${m} /api/inventory-transactions/:id -> 405`, r.status === 405, `got ${r.status}`);
    check('   ...Allow names GET only', r.headers.get('allow'), 'GET');
  }
}
{
  // C-9 gave the singleton its one write. It is still a singleton: there is
  // no create and no delete for a row that is permanently id 1, and the Allow
  // header says exactly that.
  for (const m of ['POST', 'PATCH', 'DELETE']) {
    const r = await call('/api/settings', { DB: stubDB() }, m, { taxRate: 99 });
    ok_(`${m} /api/settings -> 405`, r.status === 405, `got ${r.status}`);
    check('   ...Allow is GET, PUT', r.headers.get('allow'), 'GET, PUT');
  }
  const put = await call('/api/settings', { DB: stubDB() }, 'PUT', { taxRate: 99 });
  ok_('PUT /api/settings is a real route', put.status !== 405, `got ${put.status}`);
}

console.log('\n-- 16. PATCH is not a method this API offers --');
for (const e of ENTITIES) {
  const listRes = await call(`/api/${e}`, { DB: stubDB() }, 'PATCH', { x: 1 });
  ok_(`PATCH /api/${e} -> 405`, listRes.status === 405, `got ${listRes.status}`);
  check('   ...Allow is GET, POST', listRes.headers.get('allow'), 'GET, POST');

  const detailRes = await call(`/api/${e}/${ID[e]}`, { DB: stubDB() }, 'PATCH', { x: 1 });
  ok_(`PATCH /api/${e}/:id -> 405`, detailRes.status === 405, `got ${detailRes.status}`);
  check('   ...Allow is GET, PUT, DELETE', detailRes.headers.get('allow'), 'GET, PUT, DELETE');
}

console.log(`\nSimple CRUD writes unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
