/* GET /api/services and /api/services/:id — unit tests against the REAL
   Worker handler with a stubbed D1 binding. Also holds the one exact
   check of the full route list, since it is the newest collection. */
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

/* Modelled on seed-data.js: one fully populated, one sparse. */
const SEEDED = [
  { id: 'SRV-0002', name: 'Engine Tune-Up', category: 'Engine',
    description: 'Spark plugs, throttle body cleaning, idle adjustment',
    est_time: 120, price: 3500, status: 'Active',
    created_at: '2026-05-17T04:00:00.000Z', updated_at: null },
  { id: 'SRV-0001', name: 'Engine Oil Change', category: null,
    description: null, est_time: null, price: 0, status: 'Inactive',
    created_at: '2026-05-14T04:00:00.000Z', updated_at: '2026-09-18T04:00:00.000Z' },
];

console.log('=== GET /api/services (unit, stubbed D1) ===\n');

/* ---------- 1. populated list ---------- */
console.log('-- 1. Populated list --');
{
  const res = await call('/api/services', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('content-type JSON', res.headers.get('content-type'), 'application/json; charset=utf-8');
  ok_('data is an array', Array.isArray(body.data), JSON.stringify(body).slice(0, 100));
  check('count', body.count, 2);
  check('total', body.total, 2);
  check('meta keys match the other collections', Object.keys(body).sort(),
    ['count', 'data', 'limit', 'offset', 'total']);
  check('newest first', body.data.map(s => s.id), ['SRV-0002', 'SRV-0001']);

  const [full, sparse] = body.data;
  check('name mapped', full.name, 'Engine Tune-Up');
  check('category mapped', full.category, 'Engine');
  check('description mapped', full.description, 'Spark plugs, throttle body cleaning, idle adjustment');
  check('est_time -> estTime', full.estTime, 120);
  check('price kept as a number', full.price, 3500);
  check('status mapped', full.status, 'Active');
  check('createdAt mapped', full.createdAt, '2026-05-17T04:00:00.000Z');
  check('updatedAt omitted when never updated', 'updatedAt' in full, false);

  check('NULL category -> empty string', sparse.category, '');
  check('NULL description -> empty string', sparse.description, '');
  check('NULL est_time -> null, not 0', sparse.estTime, null);
  check('price 0 stays 0, not null', sparse.price, 0);
  check('Inactive status preserved', sparse.status, 'Inactive');
  check('updatedAt present when set', sparse.updatedAt, '2026-09-18T04:00:00.000Z');
  check('record shape', Object.keys(full).sort(),
    ['category', 'createdAt', 'description', 'estTime', 'id', 'name', 'price', 'status']);
  ok_('no snake_case leaked', !JSON.stringify(body).includes('est_time'), JSON.stringify(full));
}

/* ---------- 2. empty ---------- */
console.log('\n-- 2. Empty table --');
{
  const res = await call('/api/services', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  check('data empty', body.data, []);
  check('count 0', body.count, 0);
  check('total 0', body.total, 0);
}

/* ---------- 3. pagination + SQL safety ---------- */
console.log('\n-- 3. Pagination and SQL safety --');
{
  const db = stubDB({ rows: [SEEDED[1]], total: 2 });
  const res = await call('/api/services?limit=1&offset=1', { DB: db });
  const body = await res.json();
  check('limit echoed', body.limit, 1);
  check('offset echoed', body.offset, 1);
  check('count is the page', body.count, 1);
  check('total is the table', body.total, 2);

  const q = db.calls.find(c => c.sql.includes('FROM services') && !c.sql.includes('count(*)'));
  ok_('limit/offset bound', JSON.stringify(q.binds) === '[1,1]', JSON.stringify(q.binds));
  ok_('numbered placeholders', q.sql.includes('?1') && q.sql.includes('?2'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('newest-first ordering', /ORDER BY created_at DESC, id DESC/.test(q.sql), q.sql);
  ok_('table name is fixed, not from the request', q.sql.includes('FROM services'), q.sql);
}
{
  const db = stubDB({ rows: [] });
  const res = await call('/api/services?limit=1;DROP TABLE services', { DB: db });
  check('injection in limit -> 400', res.status, 400);
  check('no query prepared', db.calls.length, 0);
}

/* ---------- 4. parameter validation ---------- */
console.log('\n-- 4. Parameter validation --');
for (const [q, why] of [
  ['limit=0', 'below minimum'], ['limit=1001', 'above maximum'], ['limit=-3', 'negative'],
  ['limit=abc', 'not a number'], ['limit=1.5', 'not an integer'],
  ['offset=-1', 'negative offset'], ['offset=abc', 'offset not a number'],
]) {
  const db = stubDB({ rows: [] });
  const res = await call('/api/services?' + q, { DB: db });
  const body = await res.json();
  ok_(`${q} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_parameter', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/services?limit=1000', { DB: stubDB({ rows: [] }) });
  check('limit at the maximum accepted', res.status, 200);
}

/* ---------- 5. list failure modes ---------- */
console.log('\n-- 5. List failure modes --');
{
  const res = await call('/api/services', { DB: stubDB({ rows: [], throwOn: 'FROM services' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('error code', body.error.code, 'database_error');
  check('message names the collection', body.error.message, 'Could not read services.');
  ok_('no driver detail leaked', !JSON.stringify(body).includes('D1_ERROR'), JSON.stringify(body));
}
{
  const res = await call('/api/services', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['PUT', 'DELETE', 'PATCH']) {
  const res = await call('/api/services', { DB: stubDB({ rows: [] }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/services', { DB: stubDB({ rows: [] }) }, { method: 'PATCH' });
  check('405 Allow now names POST too', res.headers.get('allow'), 'GET, POST');
}

console.log('\n=== GET /api/services/:id ===');

/* ---------- 6. detail success ---------- */
console.log('\n-- 6. Valid id --');
{
  const res = await call('/api/services/SRV-0001', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('HTTP 200', res.status, 200);
  ok_('data is a single object', body.data && !Array.isArray(body.data), JSON.stringify(body.data));
  check('the requested service is returned', body.data.id, 'SRV-0001');
  check('name correct', body.data.name, 'Engine Oil Change');
  check('only a data key', Object.keys(body).sort(), ['data']);
}
{
  const res = await call('/api/services/SRV-0002', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('a different id returns a different record', body.data.id, 'SRV-0002');
  check('and its own fields', body.data.estTime, 120);
}

/* ---------- 7. unknown / invalid ---------- */
console.log('\n-- 7. Unknown and invalid ids --');
{
  const res = await call('/api/services/SRV-9999', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('unknown id -> 404', res.status, 404);
  check('error code', body.error.code, 'not_found');
  check('message', body.error.message, 'No service with that id.');
  ok_('no table name or SQL leaked', !JSON.stringify(body).match(/SELECT|sqlite/i), JSON.stringify(body));
}
{
  const res = await call('/api/services/CUS-0001', { DB: stubDB({ rows: SEEDED }) });
  check('a well-formed id of another collection -> 404', res.status, 404);
}
for (const [path, why] of [
  ['/api/services/', 'empty'],
  ['/api/services/abc', 'no numeric part'],
  ['/api/services/SRV0001', 'missing hyphen'],
  ['/api/services/SRV-', 'no digits'],
  ['/api/services/-0001', 'no prefix'],
  ['/api/services/SRV-0001-extra', 'trailing junk'],
  ['/api/services/' + 'S'.repeat(40) + '-1', 'too long'],
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call(path, { DB: db });
  const body = await res.json();
  ok_(`${path} -> 400 (${why})`, res.status === 400 && body.error.code === 'invalid_id', `got ${res.status}`);
  ok_('   ...no query prepared', db.calls.length === 0, `prepared ${db.calls.length}`);
}

/* ---------- 8. injection-style ids ---------- */
console.log('\n-- 8. Injection-style ids --');
for (const raw of [
  "SRV-0001' OR '1'='1",
  "SRV-0001; DROP TABLE services",
  "' UNION SELECT id,name,price FROM services --",
  '../../etc/passwd',
  'SRV-0001%00',
  '<script>alert(1)</script>',
]) {
  const db = stubDB({ rows: SEEDED });
  const res = await call('/api/services/' + encodeURIComponent(raw), { DB: db });
  ok_(`rejected: ${raw.slice(0, 38)}`, res.status === 400, `got ${res.status}`);
  ok_('   ...nothing reached the database', db.calls.length === 0, `prepared ${db.calls.length}`);
}
{
  const res = await call('/api/services/%zz', { DB: stubDB({ rows: SEEDED }) });
  const body = await res.json();
  check('malformed URL encoding -> 400', res.status, 400);
  check('error code', body.error.code, 'invalid_id');
}

/* ---------- 9. detail SQL safety and failures ---------- */
console.log('\n-- 9. Detail SQL safety and failure modes --');
{
  const db = stubDB({ rows: SEEDED });
  await call('/api/services/SRV-0001', { DB: db });
  const q = db.calls[0];
  check('exactly one query', db.calls.length, 1);
  ok_('id bound', JSON.stringify(q.binds) === '["SRV-0001"]', JSON.stringify(q.binds));
  ok_('id absent from the SQL text', !q.sql.includes('SRV-0001'), q.sql);
  ok_('numbered placeholder', q.sql.includes('?1'), q.sql);
  ok_('explicit column list', !q.sql.includes('SELECT *'), q.sql);
  ok_('bounded with LIMIT 1', q.sql.includes('LIMIT 1'), q.sql);
}
{
  const res = await call('/api/services/SRV-0001', { DB: stubDB({ rows: SEEDED, throwOn: 'WHERE id' }) });
  const body = await res.json();
  check('D1 error -> 500', res.status, 500);
  check('message names the singular', body.error.message, 'Could not read service.');
}
{
  const res = await call('/api/services/SRV-0001', {});
  const body = await res.json();
  check('missing binding -> 503', res.status, 503);
  check('error code', body.error.code, 'no_database');
}
// C-2 gave this collection writes, so the methods it still refuses are
// fewer and the Allow header names the new ones. The writes themselves are
// covered in tests/unit/write-crud.test.mjs.
for (const m of ['POST', 'PATCH']) {
  const res = await call('/api/services/SRV-0001', { DB: stubDB({ rows: SEEDED }) }, { method: m });
  ok_(`${m} -> 405`, res.status === 405, `got ${res.status}`);
}
{
  const res = await call('/api/services/SRV-0001', { DB: stubDB({ rows: SEEDED }) }, { method: 'POST' });
  check('405 Allow names the write routes', res.headers.get('allow'), 'GET, PUT, DELETE');
}

/* ---------- 10. the shared abstraction keeps collections distinct ---------- */
console.log('\n-- 10. Shared factory: collections stay distinct --');
{
  // the same stub rows behind three different collections must produce three
  // different tables, messages and record shapes
  const sDb = stubDB({ rows: [] });
  await call('/api/services', { DB: sDb });
  const vDb = stubDB({ rows: [] });
  await call('/api/vehicles', { DB: vDb });
  const cDb = stubDB({ rows: [] });
  await call('/api/customers', { DB: cDb });

  ok_('services queries FROM services', sDb.calls[0].sql.includes('FROM services'), sDb.calls[0].sql);
  ok_('vehicles queries FROM vehicles', vDb.calls[0].sql.includes('FROM vehicles'), vDb.calls[0].sql);
  ok_('customers queries FROM customers', cDb.calls[0].sql.includes('FROM customers'), cDb.calls[0].sql);
  ok_('each selects its own columns',
    sDb.calls[0].sql.includes('est_time')
      && vDb.calls[0].sql.includes('reg_no')
      && cDb.calls[0].sql.includes('alt_phone'), 'column lists crossed over');
  ok_('no collection selects another\'s columns',
    !sDb.calls[0].sql.includes('reg_no') && !vDb.calls[0].sql.includes('est_time'),
    'column lists leaked between collections');
}
{
  // 404 messages must name the right singular
  const s = await (await call('/api/services/SRV-9999', { DB: stubDB({ rows: [] }) })).json();
  const v = await (await call('/api/vehicles/VEH-9999', { DB: stubDB({ rows: [] }) })).json();
  const c = await (await call('/api/customers/CUS-9999', { DB: stubDB({ rows: [] }) })).json();
  check('services 404 message', s.error.message, 'No service with that id.');
  check('vehicles 404 message', v.error.message, 'No vehicle with that id.');
  check('customers 404 message', c.error.message, 'No customer with that id.');
}

/* ---------- 11. routing ---------- */
console.log('\n-- 11. Routing --');
{
  const res = await call('/api/health', { DB: stubDB({ rows: [{ name: 'customers' }], total: 9 }) });
  const body = await res.json();
  check('health 200', res.status, 200);
  check('health lists every route, in registry order', body.data.routes, [
    'GET /api/health',
    // The six simple entities gained POST/PUT/DELETE in C-2; the rest stay
    // read-only until their own phases.
    'GET /api/customers', 'POST /api/customers',
    'GET /api/customers/:id', 'PUT /api/customers/:id', 'DELETE /api/customers/:id',
    'GET /api/vehicles', 'POST /api/vehicles',
    'GET /api/vehicles/:id', 'PUT /api/vehicles/:id', 'DELETE /api/vehicles/:id',
    'GET /api/services', 'POST /api/services',
    'GET /api/services/:id', 'PUT /api/services/:id', 'DELETE /api/services/:id',
    'GET /api/mechanics', 'POST /api/mechanics',
    'GET /api/mechanics/:id', 'PUT /api/mechanics/:id', 'DELETE /api/mechanics/:id',
    'GET /api/parts', 'POST /api/parts',
    'GET /api/parts/:id', 'PUT /api/parts/:id', 'DELETE /api/parts/:id',
    'GET /api/appointments', 'POST /api/appointments',
    'GET /api/appointments/:id', 'PUT /api/appointments/:id', 'DELETE /api/appointments/:id',
    'GET /api/job-cards', 'POST /api/job-cards',
    'GET /api/job-cards/:id', 'PUT /api/job-cards/:id', 'DELETE /api/job-cards/:id',
    // The one action route: a job card's status is a transition, not a field.
    'POST /api/job-cards/:id/status',
    'GET /api/invoices', 'POST /api/invoices',
    'GET /api/invoices/:id', 'PUT /api/invoices/:id', 'DELETE /api/invoices/:id',
    // Voiding is an action, not a field change: it releases the invoice's
    // payments as advances, which is audit Finding 7.
    'POST /api/invoices/:id/void',
    'GET /api/payments', 'POST /api/payments',
    'GET /api/payments/:id', 'PUT /api/payments/:id', 'DELETE /api/payments/:id',
    // Two actions: voiding a payment, and applying an advance to an invoice.
    // Each moves an invoice's balance, so neither is a field assignment.
    'POST /api/payments/:id/void', 'POST /api/payments/:id/link',
    // 0002: write-offs -- list, create, detail and the void action; never PUT or DELETE.
    'GET /api/invoice-adjustments', 'POST /api/invoice-adjustments',
    'GET /api/invoice-adjustments/:id', 'POST /api/invoice-adjustments/:id/void',
    'GET /api/expenses', 'POST /api/expenses',
    'GET /api/expenses/:id', 'PUT /api/expenses/:id', 'DELETE /api/expenses/:id',
    'GET /api/inventory-transactions', 'POST /api/inventory-transactions',
    'GET /api/inventory-transactions/:id',
    // 0005: follow-ups have no DELETE (cancel instead); their contact history
    // is append-only -- read or voided, never created, edited or removed here.
    'GET /api/follow-ups', 'POST /api/follow-ups', 'GET /api/follow-ups/:id', 'PUT /api/follow-ups/:id',
    'POST /api/follow-ups/:id/complete', 'POST /api/follow-ups/:id/cancel', 'POST /api/follow-ups/:id/contact',
    'GET /api/follow-up-contacts', 'GET /api/follow-up-contacts/:id', 'POST /api/follow-up-contacts/:id/void',
    // 0006: follow-up tasks have no DELETE either (cancel with a reason instead).
    'GET /api/follow-up-tasks', 'POST /api/follow-up-tasks', 'GET /api/follow-up-tasks/:id', 'PUT /api/follow-up-tasks/:id',
    'POST /api/follow-up-tasks/:id/start', 'POST /api/follow-up-tasks/:id/complete', 'POST /api/follow-up-tasks/:id/cancel',
    // 0007: estimates have no DELETE (cancel with a reason instead); sending,
    // recording a decision and converting to a job card are actions.
    'GET /api/estimates', 'POST /api/estimates', 'GET /api/estimates/:id', 'PUT /api/estimates/:id',
    'POST /api/estimates/:id/send', 'POST /api/estimates/:id/approve', 'POST /api/estimates/:id/reject',
    'POST /api/estimates/:id/cancel', 'POST /api/estimates/:id/convert',
    // 0008: staff have no DELETE (deactivate instead) and no actions.
    'GET /api/staff', 'POST /api/staff', 'GET /api/staff/:id', 'PUT /api/staff/:id',
    // 0009: accounts have no DELETE (deactivate instead); setting a new password is an action.
    'GET /api/accounts', 'POST /api/accounts', 'GET /api/accounts/:id', 'PUT /api/accounts/:id', 'POST /api/accounts/:id/password',
    // 0010: attendance has no DELETE (a record is corrected through PUT).
    'GET /api/attendance', 'POST /api/attendance', 'GET /api/attendance/:id', 'PUT /api/attendance/:id',
    // 0011: leave requests have no PUT or DELETE (decided once, kept); approving and rejecting are actions.
    'GET /api/leave-requests', 'POST /api/leave-requests', 'GET /api/leave-requests/:id',
    'POST /api/leave-requests/:id/approve', 'POST /api/leave-requests/:id/reject',
    // 0012: the activity log is read-only; the Worker writes its entries itself.
    'GET /api/activity-log', 'GET /api/activity-log/:id',
    // 0013: tools are registered and edited, and retired by an administrator; never deleted.
    'GET /api/tools', 'POST /api/tools', 'GET /api/tools/:id', 'PUT /api/tools/:id', 'POST /api/tools/:id/retire',
    // 0014: the Messenger inbox, then Meta's public webhook.
    'GET /api/messenger/conversations', 'GET /api/messenger/conversations/:id', 'GET /api/messenger/conversations/:id/messages', 'POST /api/messenger/conversations/:id/reply', 'POST /api/messenger/conversations/:id/read', 'PUT /api/messenger/conversations/:id/status',
    'GET /api/webhooks/messenger', 'POST /api/webhooks/messenger',
    // 0015: the WhatsApp inbox, then the Cloud API's public webhook.
    'GET /api/whatsapp/conversations', 'GET /api/whatsapp/conversations/:id', 'GET /api/whatsapp/conversations/:id/messages', 'POST /api/whatsapp/conversations/:id/reply', 'POST /api/whatsapp/conversations/:id/read', 'POST /api/whatsapp/conversations/:id/unread', 'PUT /api/whatsapp/conversations/:id/status',
    'GET /api/webhooks/whatsapp', 'POST /api/webhooks/whatsapp',
    // Settings is a singleton: a read and a write, and no /:id — there is
    // no create or delete for a row that is permanently id 1.
    'GET /api/settings', 'PUT /api/settings',
    'GET /api/session', 'POST /api/session', 'DELETE /api/session',
  ]);
}
{
  const res = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const body = await res.json();
  check('unknown collection -> 404', res.status, 404);
  check('404 advertises every route', body.error.available.length, 135);
}

console.log(`\nGET /api/services unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
