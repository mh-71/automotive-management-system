/* GET /api/expenses and /api/expenses/:id — unit tests against the REAL Worker
   handler with a stubbed D1 binding.

   Expenses is the simplest table in the schema: no foreign keys, no child
   lines, nothing referencing it. The plumbing is lib/collection.js and is
   already covered by the other factory-built suites, so the weight here is on
   the three things specific to this ledger — that Void rows come back rather
   than being filtered, that no aggregate is invented on top of the amounts,
   and that a category the frontend no longer offers still round-trips because
   the database never constrained it. */
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

function stubDB({ rows = [], total = null, throwOn = null }) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async all() {
          if (throwOn && sql.includes(throwOn)) throw new Error('D1_ERROR: simulated failure');
          return { results: rows };
        },
        async first() {
          if (throwOn && sql.includes(throwOn)) throw new Error('D1_ERROR: simulated failure');
          if (sql.includes('count(*)')) return { n: total === null ? rows.length : total };
          if (sql.includes('WHERE id =') && entry.binds) {
            return rows.find((r) => r.id === entry.binds[0]) ?? null;
          }
          return rows[0] ?? null;
        },
      };
      return stmt;
    },
  };
}
/* C-12 protects reads as well as writes, so every call here carries the same
   machine credential the write suites use. These suites are about what a route
   RETURNS, not about the gate -- the gate has its own suite (api-auth). */
const TEST_TOKEN = 'unit-test-token';
const withAuth = (init = {}) => ({
  ...init,
  headers: { authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers || {}) },
});
const call = (path, env, init) =>
  worker.fetch(new Request('http://worker.local' + path, withAuth(init)),
               { API_TOKEN: TEST_TOKEN, ...env });

/* Modelled on seed-data.js:202-205, extended to cover every case the mapper
   has to decide: a populated row, a voided one, an all-NULL-optionals row, a
   decimal amount with an updated_at, and a category the current frontend list
   no longer contains. */
const SEEDED = [
  { id: 'EXP-0001', date: '2026-09-20', category: 'Parts Purchase',
    description: 'Engine oil restock — 12 cans', amount: 26400, method: 'Bank Transfer',
    payee: 'Dhaka Auto Parts', reference: 'INV-DAP-8842', notes: 'Quarterly restock',
    status: 'Active', created_at: '2026-05-20T04:00:00.000Z', updated_at: null },
  { id: 'EXP-0002', date: '2026-09-19', category: 'Electricity',
    description: 'Monthly electricity bill', amount: 8500, method: 'Mobile Banking',
    payee: 'DESCO', reference: '', notes: '',
    status: 'Void', created_at: '2026-05-19T04:00:00.000Z', updated_at: null },
  { id: 'EXP-0003', date: '2026-09-18', category: 'Tools',
    description: 'Torque wrench replacement', amount: 4200, method: 'Cash',
    payee: null, reference: null, notes: null,
    status: 'Active', created_at: '2026-05-18T04:00:00.000Z', updated_at: null },
  { id: 'EXP-0004', date: '2026-09-17', category: 'Transport',
    description: 'Parts pickup from Motor Bhaban', amount: 612.5, method: 'Card',
    payee: 'Rickshaw', reference: '', notes: 'Split fare',
    status: 'Active', created_at: '2026-05-17T04:00:00.000Z', updated_at: '2026-09-21T10:00:00.000Z' },
  { id: 'EXP-0005', date: '2026-09-16', category: 'Legacy Category',
    description: 'Imported from the old spreadsheet', amount: 1000000, method: 'Cash',
    payee: '', reference: '', notes: '',
    status: 'Active', created_at: '2026-05-16T04:00:00.000Z', updated_at: null },
];
const byId = (body) => Object.fromEntries(body.data.map(e => [e.id, e]));

console.log('=== GET /api/expenses (unit, stubbed D1) ===\n');

/* ---------- 1. list and exact field mapping ---------- */
console.log('-- 1. List and field mapping --');
{
  const res = await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 80));
  check('count', body.count, 5);
  check('total', body.total, 5);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(e => e.id),
    ['EXP-0001', 'EXP-0002', 'EXP-0003', 'EXP-0004', 'EXP-0005']);

  const e = byId(body);
  const full = e['EXP-0001'];
  check('date verbatim', full.date, '2026-09-20');
  check('category', full.category, 'Parts Purchase');
  check('description', full.description, 'Engine oil restock — 12 cans');
  check('amount', full.amount, 26400);
  check('method', full.method, 'Bank Transfer');
  check('payee', full.payee, 'Dhaka Auto Parts');
  check('reference', full.reference, 'INV-DAP-8842');
  check('notes', full.notes, 'Quarterly restock');
  check('status', full.status, 'Active');
  check('created_at -> createdAt', full.createdAt, '2026-05-20T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);
  check('record shape — exactly the eleven stored fields',
    Object.keys(full).sort(),
    ['amount', 'category', 'createdAt', 'date', 'description', 'id', 'method',
      'notes', 'payee', 'reference', 'status']);
  ok_('no snake_case leaked',
    !JSON.stringify(body).match(/created_at|updated_at/), JSON.stringify(full));

  const nulls = e['EXP-0003'];
  check('NULL payee -> ""', nulls.payee, '');
  check('NULL reference -> ""', nulls.reference, '');
  check('NULL notes -> ""', nulls.notes, '');
  ok_('a NULL optional is "" and not null',
    nulls.payee !== null && nulls.reference !== null && nulls.notes !== null,
    JSON.stringify([nulls.payee, nulls.reference, nulls.notes]));
  check('stored empty strings stay ""', [e['EXP-0005'].payee, e['EXP-0005'].reference], ['', '']);

  check('updatedAt present when set', e['EXP-0004'].updatedAt, '2026-09-21T10:00:00.000Z');
  check('a decimal amount survives', e['EXP-0004'].amount, 612.5);
  check('a large amount survives', e['EXP-0005'].amount, 1000000);
  ok_('amount is a number, not a string', typeof e['EXP-0004'].amount === 'number',
    typeof e['EXP-0004'].amount);
}

/* ---------- 2. status, category and method round-trips ---------- */
console.log('\n-- 2. Stored values round-trip verbatim --');
{
  const e = byId(await (await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) })).json());
  check('Active status round-trips', e['EXP-0001'].status, 'Active');
  check('Void status round-trips', e['EXP-0002'].status, 'Void');
  // The schema has no CHECK on category; the sixteen the UI offers live in
  // expenses.js's own array. A stored value outside that list must survive.
  check('a non-canonical category round-trips', e['EXP-0005'].category, 'Legacy Category');
  ok_('the category was not coerced to Other',
    e['EXP-0005'].category !== 'Other', e['EXP-0005'].category);
  const methods = new Set(Object.values(e).map(x => x.method));
  for (const m of ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer']) {
    ok_(`method "${m}" present and round-trips`, methods.has(m), [...methods]);
  }
}
for (const category of ['Rent', 'Salary', 'Mechanic Wages', 'Parts Purchase', '', 'ষোলো']) {
  const rows = [{ ...SEEDED[0], id: 'EXP-0100', category }];
  const body = await (await call('/api/expenses/EXP-0100', { DB: stubDB({ rows }) })).json();
  check(`category ${JSON.stringify(category)} is returned as stored`, body.data.category, category);
}
for (const amount of [0.5, 1, 99.99, 1234.567, 26400, 9999999]) {
  const rows = [{ ...SEEDED[0], id: 'EXP-0101', amount }];
  const body = await (await call('/api/expenses/EXP-0101', { DB: stubDB({ rows }) })).json();
  check(`amount ${amount} is returned exactly`, body.data.amount, amount);
}
for (const date of ['2026-01-01', '2026-12-31', '2026-06-15']) {
  const rows = [{ ...SEEDED[0], id: 'EXP-0102', date }];
  const body = await (await call('/api/expenses/EXP-0102', { DB: stubDB({ rows }) })).json();
  check(`date ${date} is returned verbatim`, body.data.date, date);
  ok_('   ...and did not become an ISO timestamp',
    !body.data.date.includes('T') && !body.data.date.endsWith('Z'), body.data.date);
}

/* ---------- 3. Void rows are returned, not filtered ---------- */
console.log('\n-- 3. The API returns Void rows; filtering is the consumer\'s job --');
{
  const body = await (await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) })).json();
  const e = byId(body);
  ok_('the Void expense is present in the list', 'EXP-0002' in e, body.data.map(x => x.id));
  check('the list count includes it', body.count, 5);
  check('a Void expense keeps its amount', e['EXP-0002'].amount, 8500);
  check('a Void expense keeps every other field',
    [e['EXP-0002'].date, e['EXP-0002'].category, e['EXP-0002'].method, e['EXP-0002'].payee],
    ['2026-09-19', 'Electricity', 'Mobile Banking', 'DESCO']);
  // What a consumer does with it is the consumer's decision, and both
  // reports.js and dashboard.js already make it.
  const active = body.data.filter(x => x.status !== 'Void');
  check('a consumer can still exclude Void rows itself', active.length, 4);
  check('and sum only the active ones',
    active.reduce((s, x) => s + x.amount, 0), 26400 + 4200 + 612.5 + 1000000);
}
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/expenses', { DB: db });
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('no status filter is applied in SQL', !/WHERE[^)]*status/i.test(sql), sql);
  ok_("the word 'Void' never appears in the SQL", !/Void/.test(sql), sql);
}
{
  // A page of nothing but Void rows still returns them all.
  const allVoid = SEEDED.map((r, i) => ({ ...r, id: `EXP-020${i}`, status: 'Void' }));
  const body = await (await call('/api/expenses', { DB: stubDB({ rows: allVoid }) })).json();
  check('an all-Void table returns every row', body.count, 5);
  ok_('and every one reports status Void',
    body.data.every(x => x.status === 'Void'), body.data.map(x => x.status));
}

/* ---------- 4. no aggregates, no joins, no other tables ---------- */
console.log('\n-- 4. Rows only: no aggregates, no joins --');
{
  const body = await (await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) })).json();
  const keys = new Set(body.data.flatMap(Object.keys));
  for (const derived of ['total', 'expenseTotal', 'byCategory', 'byMethod', 'byDay',
    'netResult', 'net', 'isVoid', 'isActive', 'count']) {
    ok_(`no ${derived} field invented`, !keys.has(derived), [...keys]);
  }
  ok_('no aggregate key at the top level either',
    !['total_amount', 'sum', 'byCategory', 'netResult'].some(k => k in body), Object.keys(body));
  ok_('the meta block carries only paging figures',
    JSON.stringify(Object.keys(body).sort()) ===
      JSON.stringify(['count', 'data', 'limit', 'offset', 'total']), Object.keys(body));
}
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/expenses', { DB: db });
  await call('/api/expenses/EXP-0001', { DB: db });
  const sql = db.calls.map(c => c.sql).join('\n');
  ok_('nothing is joined', !/\bJOIN\b/i.test(sql), sql);
  ok_('nothing is summed', !/\bSUM\s*\(/i.test(sql), sql);
  ok_('nothing is grouped', !/\bGROUP\s+BY\b/i.test(sql), sql);
  ok_('payments are never queried', !/\bpayments\b/i.test(sql), sql);
  ok_('invoices are never queried', !/\binvoices\b/i.test(sql), sql);
  ok_('job_cards are never queried', !/\bjob_cards\b/i.test(sql), sql);
  ok_('only the expenses table is read',
    db.calls.every(c => /FROM\s+expenses\b/.test(c.sql)), sql);
  ok_('every statement is a SELECT',
    db.calls.every(c => /^\s*SELECT/i.test(c.sql.trim())), db.calls.map(c => c.sql.slice(0, 30)));
  ok_('no statement writes',
    !db.calls.some(c => /\b(UPDATE|INSERT|DELETE)\b/i.test(c.sql)), 'write statement issued');
}

/* ---------- 5. query counts ---------- */
console.log('\n-- 5. Query counts --');
for (const [limit, label] of [[undefined, 'default'], [40, '40'], [500, '500'], [1000, '1000']]) {
  const many = Array.from({ length: Math.min(limit ?? 5, 60) }, (_, i) =>
    ({ ...SEEDED[0], id: `EXP-${3000 + i}` }));
  const db = stubDB({ rows: many });
  await call('/api/expenses' + (limit ? `?limit=${limit}` : ''), { DB: db });
  check(`list at limit ${label} costs exactly 2 queries`, db.calls.length, 2);
}
{
  const db = stubDB({ rows: [] });
  await call('/api/expenses', { DB: db });
  check('an empty list still costs exactly 2 queries', db.calls.length, 2);
}
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/expenses/EXP-0001', { DB: db });
  check('detail costs exactly 1 query', db.calls.length, 1);
}
{
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/expenses/EXP-8888', { DB: db });
  check('unknown id -> 404', res.status, 404);
  check('a 404 also costs exactly 1 query', db.calls.length, 1);
}
{
  const many = Array.from({ length: 300 }, (_, i) => ({ ...SEEDED[0], id: `EXP-${4000 + i}` }));
  const db = stubDB({ rows: many });
  const body = await (await call('/api/expenses?limit=300', { DB: db })).json();
  check('300 rows returned', body.count, 300);
  check('still 2 queries — no N+1', db.calls.length, 2);
  ok_('no chunked child query appeared', !db.calls.some(c => /IN \(/.test(c.sql)), 'IN-list found');
}

/* ---------- 6. pagination and parameter validation ---------- */
console.log('\n-- 6. Pagination and parameter validation --');
{
  const db = stubDB({ rows: [SEEDED[1]], total: 5 });
  const body = await (await call('/api/expenses?limit=1&offset=1', { DB: db })).json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 5);
  const q = db.calls.find(c => !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('ordering is newest first with an id tie-break',
    /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
  ok_('all twelve columns selected explicitly',
    ['id', 'date', 'category', 'description', 'amount', 'method', 'payee',
      'reference', 'notes', 'status', 'created_at', 'updated_at'].every(c => q.sql.includes(c)), q.sql);
}
{
  const body = await (await call('/api/expenses', { DB: stubDB({ rows: [] }) })).json();
  check('default limit', body.limit, 500);
  check('default offset', body.offset, 0);
}
{
  check('limit at the maximum accepted',
    (await call('/api/expenses?limit=1000', { DB: stubDB({ rows: [] }) })).status, 200);
  check('limit 500 accepted',
    (await call('/api/expenses?limit=500', { DB: stubDB({ rows: [] }) })).status, 200);
}
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/expenses?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 7. failure modes ---------- */
console.log('\n-- 7. Failure modes --');
{
  const res = await call('/api/expenses', { DB: stubDB({ rows: [], throwOn: 'FROM expenses' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read expenses.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/expenses/EXP-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('detail D1 error -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read expense.');
}
{
  const res = await call('/api/expenses', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
{
  const res = await call('/api/expenses/EXP-0001', {});
  const body = await res.json();
  check('detail missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave expenses POST on the list and PUT/DELETE on the detail, so only
// the genuinely unsupported methods are asserted here. The writes themselves
// are covered in tests/unit/write-crud.test.mjs.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const rl = await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} list -> 405`, rl.status === 405, `got ${rl.status}`);
}
for (const m of ['POST', 'PATCH']) {
  const rd = await call('/api/expenses/EXP-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} detail -> 405`, rd.status === 405, `got ${rd.status}`);
}
{
  const rl = await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) }, { method: 'PATCH' });
  check('405 Allow on the list now names POST', rl.headers.get('allow'), 'GET, POST');
  const rd = await call('/api/expenses/EXP-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'PATCH' });
  check('405 Allow on the detail names PUT and DELETE', rd.headers.get('allow'), 'GET, PUT, DELETE');
  const db = stubDB({ rows: SEEDED });
  await call('/api/expenses', { DB: db }, { method: 'PATCH' });
  check('a rejected method prepares no statement', db.calls.length, 0);
}

console.log('\n=== GET /api/expenses/:id ===');

/* ---------- 8. detail and id handling ---------- */
console.log('\n-- 8. Valid, unknown and invalid ids --');
{
  const res = await call('/api/expenses/EXP-0003', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested expense is returned', body.data.id, 'EXP-0003');
  check('only a data key', Object.keys(body).sort(), ['data']);
  check('the NULL optionals map to "" on detail too',
    [body.data.payee, body.data.reference, body.data.notes], ['', '', '']);
}
{
  const res = await call('/api/expenses/EXP-0002', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a Void expense is retrievable by id', res.status, 200);
  check('and reports status Void', body.data.status, 'Void');
  check('with its amount intact', body.data.amount, 8500);
}
{
  const listBody = await (await call('/api/expenses', { DB: stubDB({ rows: SEEDED }) })).json();
  const detail = await (await call('/api/expenses/EXP-0004', { DB: stubDB({ rows: SEEDED }) })).json();
  check('detail record matches the list record',
    JSON.stringify(detail.data), JSON.stringify(listBody.data.find(e => e.id === 'EXP-0004')));
}
{
  const res = await call('/api/expenses/EXP-8888', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No expense with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
for (const other of ['PAY-0001', 'INV-0001', 'JOB-0001', 'CUS-0001', 'VEH-0001', 'PRT-0001', 'APT-0001', 'MEC-0001']) {
  const res = await call('/api/expenses/' + other, { DB: stubDB({ rows: SEEDED }) });
  ok_(`${other} on the expenses route -> 404, not 400`, res.status === 404, `got ${res.status}`);
}
for (const [path, why] of [
  ['/api/expenses/', 'empty / trailing slash'],
  ['/api/expenses/abc', 'no numeric part'],
  ['/api/expenses/EXP0001', 'missing hyphen'],
  ['/api/expenses/EXP-', 'no digits'],
  ['/api/expenses/-0001', 'no prefix'],
  ['/api/expenses/EXP-0001-extra', 'trailing junk'],
  ['/api/expenses/EXPENSES-1', 'prefix too long'],
  ['/api/expenses/E-1', 'prefix too short'],
  ['/api/expenses/' + 'E'.repeat(40) + '-1', 'too long'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 9. injection ---------- */
console.log('\n-- 9. Injection-style ids --');
for (const raw of [
  "EXP-0001' OR '1'='1",
  "EXP-0001; DROP TABLE expenses",
  "EXP-0001'; UPDATE expenses SET status='Void' --",
  "EXP-0001'; UPDATE expenses SET amount=0 --",
  "' UNION SELECT id,category,amount FROM expenses --",
  '../../etc/passwd',
  'EXP-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/expenses/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 40)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/expenses/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 10. SQL safety ---------- */
console.log('\n-- 10. SQL safety --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/expenses/EXP-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["EXP-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('EXP-0001'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
  ok_('the amount column is selected explicitly', q.sql.includes('amount'), q.sql);
}

/* ---------- 11. the factory contract is preserved ---------- */
console.log('\n-- 11. Factory contract shared with the other collections --');
{
  const expDb = stubDB({ rows: [] });
  const expBody = await (await call('/api/expenses', { DB: expDb })).json();
  const payDb = stubDB({ rows: [] });
  const payBody = await (await call('/api/payments', { DB: payDb })).json();
  const custDb = stubDB({ rows: [] });
  const custBody = await (await call('/api/customers', { DB: custDb })).json();

  check('the meta shape is identical to payments',
    Object.keys(expBody).sort(), Object.keys(payBody).sort());
  check('and to customers', Object.keys(expBody).sort(), Object.keys(custBody).sort());
  check('the same default limit and offset',
    [expBody.limit, expBody.offset], [payBody.limit, payBody.offset]);
  check('the same query count as another flat collection',
    expDb.calls.length, payDb.calls.length);

  ok_('expenses queries FROM expenses', expDb.calls[0].sql.includes('FROM expenses'), expDb.calls[0].sql);
  ok_('expenses selects its own columns',
    expDb.calls[0].sql.includes('category') && expDb.calls[0].sql.includes('payee'),
    expDb.calls[0].sql);
  ok_('expenses does not select another collection\'s columns',
    !expDb.calls[0].sql.includes('invoice_id') && !expDb.calls[0].sql.includes('alt_phone'),
    expDb.calls[0].sql);
  ok_('no other collection selects expense columns',
    !payDb.calls[0].sql.includes('payee') && !custDb.calls[0].sql.includes('category'),
    'column lists leaked between collections');
}
{
  const exp = await (await call('/api/expenses/EXP-9999', { DB: stubDB({ rows: [] }) })).json();
  const pay = await (await call('/api/payments/PAY-9999', { DB: stubDB({ rows: [] }) })).json();
  const inv = await (await call('/api/invoices/INV-9999', { DB: stubDB({ rows: [] }) })).json();
  check('expenses 404 message', exp.error.message, 'No expense with that id.');
  check('payments 404 message', pay.error.message, 'No payment with that id.');
  check('invoices 404 message', inv.error.message, 'No invoice with that id.');
  check('the error envelope shape is shared',
    Object.keys(exp.error).sort(), Object.keys(pay.error).sort());
}

/* ---------- 12. routing ---------- */
console.log('\n-- 12. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 17 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  ok_('health advertises the expenses routes',
    body.data.routes.includes('GET /api/expenses')
      && body.data.routes.includes('GET /api/expenses/:id'),
    JSON.stringify(body.data.routes));
  check('the registry now advertises 139 routes', body.data.routes.length, 139);
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  ok_('404 advertises the expenses routes',
    body.error.available.includes('GET /api/expenses')
      && body.error.available.includes('GET /api/expenses/:id'),
    JSON.stringify(body.error.available));
}
{
  // Derived from what health advertises, not hardcoded.
  const advertised = (await (await call('/api/health',
    { DB: stubDB({ rows: [{ name: 'customers' }] }) })).json()).data.routes;
  const unregistered = ['settings', 'expense', 'reports', 'suppliers']
    .filter(name => !advertised.includes(`GET /api/${name}`));
  ok_('at least one unregistered collection was found to probe',
    unregistered.length > 0, JSON.stringify(advertised));
  for (const name of unregistered) {
    const r = await call(`/api/${name}`, { DB: stubDB({ rows: [] }) });
    ok_(`/api/${name} is not a route -> 404`, r.status === 404, `got ${r.status}`);
  }
}

console.log(`\nGET /api/expenses unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
