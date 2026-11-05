/* GET /api/inventory-transactions and /api/inventory-transactions/:id — unit
   tests against the REAL Worker handler with a stubbed D1 binding.

   This is the eleventh and last localStorage collection to be exposed, so
   alongside the usual factory plumbing the weight here is on the three things
   that are specific to a ledger:

     - it is history, not a balance: no quantity is summed, no per-part rollup
       is invented, and parts.stock is never consulted;
     - prev_stock / new_stock are snapshots of the moment of the move, returned
       as stored rather than recomputed from neighbouring rows;
     - unitCost distinguishes null from 0, because inventory.js:608 prints '—'
       for one and a money value for the other. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import worker from '../../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

/* Modelled on seed-data.js:212-219 (the opening-stock rows the app writes on
   first run) and on what Utils.Inventory.move() stores for each kind of
   movement, extended to cover every branch the mapper has to decide. */
const OPENING = {
  id: 'STK-0001', part_id: 'PRT-0001', type: 'initial-stock', quantity: 12,
  unit_cost: 450, reference_type: 'manual', reference_id: null,
  reason: null, notes: 'Opening stock',
  prev_stock: 0, new_stock: 12, created_at: '2026-09-01T10:00:00',
};
const JOB_USE = {
  id: 'STK-0002', part_id: 'PRT-0001', type: 'job-card-use', quantity: 2,
  unit_cost: null, reference_type: 'job-card', reference_id: 'JOB-0003',
  reason: '', notes: '',
  prev_stock: 12, new_stock: 10, created_at: '2026-09-02T10:00:00',
};
const RETURNED = {
  id: 'STK-0003', part_id: 'PRT-0001', type: 'return', quantity: 2,
  unit_cost: null, reference_type: 'job-card', reference_id: 'JOB-0003',
  reason: null, notes: 'Returned — JOB-0003 cancelled',
  prev_stock: 10, new_stock: 12, created_at: '2026-09-03T10:00:00',
};
const FREE_COST = {
  id: 'STK-0004', part_id: 'PRT-0002', type: 'purchase', quantity: 5,
  unit_cost: 0, reference_type: 'manual', reference_id: null,
  reason: 'Supplier sample', notes: '',
  prev_stock: 1, new_stock: 6, created_at: '2026-09-04T10:00:00',
};
const BARE = {
  id: 'STK-0005', part_id: 'PRT-0003', type: 'damaged', quantity: 1.5,
  unit_cost: null, reference_type: null, reference_id: null,
  reason: null, notes: null,
  prev_stock: 4.5, new_stock: 3, created_at: '2026-09-05T10:00:00',
};
const ALL = [OPENING, JOB_USE, RETURNED, FREE_COST, BARE];

console.log('\n-- 1. List --');
{
  const db = stubDB({ rows: ALL });
  const res = await call('/api/inventory-transactions', { DB: db });
  const b = await res.json();
  check('200', res.status, 200);
  check('returns every row', b.data.length, 5);
  check('count', b.count, 5);
  check('total', b.total, 5);
  check('limit defaults to 500', b.limit, 500);
  check('offset defaults to 0', b.offset, 0);
  check('first record maps exactly', b.data[0], {
    id: 'STK-0001',
    partId: 'PRT-0001',
    type: 'initial-stock',
    quantity: 12,
    unitCost: 450,
    referenceType: 'manual',
    referenceId: null,
    reason: '',
    notes: 'Opening stock',
    prevStock: 0,
    newStock: 12,
    createdAt: '2026-09-01T10:00:00',
  });
  ok_('no updatedAt key — the ledger is append-only',
    b.data.every((r) => !('updatedAt' in r)), JSON.stringify(Object.keys(b.data[0])));
  check('exactly 12 fields per record', Object.keys(b.data[0]).length, 12);
}

console.log('\n-- 2. unitCost keeps null apart from zero --');
{
  const b = await (await call('/api/inventory-transactions', { DB: stubDB({ rows: ALL }) })).json();
  const byId = Object.fromEntries(b.data.map((r) => [r.id, r]));
  check('a recorded cost survives', byId['STK-0001'].unitCost, 450);
  check('no cost recorded stays null', byId['STK-0002'].unitCost, null);
  check('a genuine zero cost stays 0, not null and not \'\'', byId['STK-0004'].unitCost, 0);
  ok_('zero is a number, not a string', typeof byId['STK-0004'].unitCost === 'number');
  ok_('null is null, not 0', byId['STK-0002'].unitCost !== 0);
  ok_('null is null, not \'\'', byId['STK-0002'].unitCost !== '');
  // inventory.js:608 branches on `!= null`, so this is the distinction that
  // decides whether the screen shows '—' or a money value.
  ok_("the '—' branch and the money branch stay distinguishable",
    (byId['STK-0002'].unitCost == null) && (byId['STK-0004'].unitCost != null));
}

console.log('\n-- 3. References keep null; free text falls back to \'\' --');
{
  const b = await (await call('/api/inventory-transactions', { DB: stubDB({ rows: ALL }) })).json();
  const byId = Object.fromEntries(b.data.map((r) => [r.id, r]));
  check('manual movement has a null referenceId', byId['STK-0001'].referenceId, null);
  check('job movement carries its job id', byId['STK-0002'].referenceId, 'JOB-0003');
  check('job movement carries its reference type', byId['STK-0002'].referenceType, 'job-card');
  check('a NULL reference type stays null', byId['STK-0005'].referenceType, null);
  check('NULL reason -> \'\'', byId['STK-0001'].reason, '');
  check('NULL notes -> \'\'', byId['STK-0005'].notes, '');
  check('a real reason survives', byId['STK-0004'].reason, 'Supplier sample');
  check('a real note survives', byId['STK-0003'].notes, 'Returned — JOB-0003 cancelled');
}

console.log('\n-- 4. Snapshots are returned, never recomputed --');
{
  const b = await (await call('/api/inventory-transactions', { DB: stubDB({ rows: ALL }) })).json();
  const byId = Object.fromEntries(b.data.map((r) => [r.id, r]));
  check('prevStock as stored', byId['STK-0002'].prevStock, 12);
  check('newStock as stored', byId['STK-0002'].newStock, 10);
  check('a zero prevStock survives', byId['STK-0001'].prevStock, 0);
  check('fractional quantities survive', byId['STK-0005'].quantity, 1.5);
  check('fractional stock survives', byId['STK-0005'].prevStock, 4.5);

  // A row whose snapshot disagrees with its own arithmetic is still returned
  // verbatim: the API reports what the ledger holds, it does not correct it.
  const odd = { ...JOB_USE, id: 'STK-0099', prev_stock: 100, new_stock: 7 };
  const one = await (await call('/api/inventory-transactions', { DB: stubDB({ rows: [odd] }) })).json();
  check('an inconsistent snapshot is reported, not fixed',
    [one.data[0].prevStock, one.data[0].newStock, one.data[0].quantity], [100, 7, 2]);
}

console.log('\n-- 5. All eight movement types round-trip verbatim --');
{
  const types = ['purchase', 'adjustment-in', 'return', 'initial-stock',
    'sale', 'job-card-use', 'adjustment-out', 'damaged'];
  const rows = types.map((t, i) => ({ ...OPENING, id: `STK-9${i}`, type: t }));
  const b = await (await call('/api/inventory-transactions', { DB: stubDB({ rows }) })).json();
  check('every type survives unchanged', b.data.map((r) => r.type), types);
  ok_('no type is normalised, relabelled or grouped',
    b.data.every((r, i) => r.type === types[i]));
  // The frontend's own IN/OUT split (reports.js:213-214) is not applied here.
  ok_('no direction or sign is added', b.data.every((r) => !('direction' in r) && !('sign' in r)));
  ok_('quantities stay positive for outbound types too',
    b.data.every((r) => r.quantity > 0), JSON.stringify(b.data.map((r) => r.quantity)));
}

console.log('\n-- 6. No aggregates, no rollups, no stock lookup --');
{
  const db = stubDB({ rows: ALL });
  const b = await (await call('/api/inventory-transactions', { DB: db })).json();
  for (const key of ['movementIn', 'movementOut', 'usageByPart', 'stockValue',
    'issued', 'netQuantity', 'balance', 'stock', 'history']) {
    ok_(`no invented \`${key}\` on a record`, b.data.every((r) => !(key in r)));
    ok_(`no invented \`${key}\` in the envelope`, !(key in b));
  }
  ok_('never queries the parts table', !db.calls.some((c) => /\bFROM\s+parts\b/i.test(c.sql)),
    db.calls.map((c) => c.sql).join(' | '));
  ok_('no SUM over quantity', !db.calls.some((c) => /sum\s*\(/i.test(c.sql)));
  ok_('no GROUP BY', !db.calls.some((c) => /GROUP\s+BY/i.test(c.sql)));
}

console.log('\n-- 7. Ordering, paging and validation --');
{
  const db = stubDB({ rows: ALL });
  await call('/api/inventory-transactions', { DB: db });
  const listSql = db.calls[0].sql;
  ok_('newest first with id as tie-breaker', /ORDER BY created_at DESC, id DESC/.test(listSql), listSql);
  ok_('no SELECT *', !/SELECT\s+\*/i.test(listSql), listSql);
  ok_('reads the inventory_transactions table', /FROM\s+inventory_transactions/i.test(listSql));
  check('list costs exactly 2 queries', db.calls.length, 2);

  const paged = stubDB({ rows: [OPENING], total: 40 });
  const b = await (await call('/api/inventory-transactions?limit=1&offset=3', { DB: paged })).json();
  check('limit echoed', b.limit, 1);
  check('offset echoed', b.offset, 3);
  check('total is the table count, not the page size', b.total, 40);
  check('limit and offset are bound, never interpolated', paged.calls[0].binds, [1, 3]);

  for (const [qs, label] of [['limit=0', 'limit=0'], ['limit=1001', 'limit above max'],
    ['limit=abc', 'non-numeric limit'], ['offset=-1', 'negative offset']]) {
    const r = await call(`/api/inventory-transactions?${qs}`, { DB: stubDB({ rows: [] }) });
    const eb = await r.json();
    ok_(`${label} -> 400`, r.status === 400, `got ${r.status}`);
    check(`${label} error code`, eb.error.code, 'invalid_parameter');
  }
}

console.log('\n-- 8. Detail --');
{
  const db = stubDB({ rows: ALL });
  const res = await call('/api/inventory-transactions/STK-0002', { DB: db });
  const b = await res.json();
  check('200', res.status, 200);
  check('returns the right row', b.data.id, 'STK-0002');
  ok_('data is an object, not an array', !Array.isArray(b.data));
  ok_('no paging metadata on a detail', !('count' in b) && !('total' in b));
  check('detail costs exactly 1 query', db.calls.length, 1);
  check('the id is bound', db.calls[0].binds, ['STK-0002']);

  const miss = await call('/api/inventory-transactions/STK-7777', { DB: stubDB({ rows: ALL }) });
  const mb = await miss.json();
  check('unknown id -> 404', miss.status, 404);
  check('404 code', mb.error.code, 'not_found');
  check('404 message names the singular', mb.error.message, 'No inventory transaction with that id.');

  // Shape-only id validation: a well-formed id from another collection is a
  // 404 here, not a 400.
  const other = await call('/api/inventory-transactions/PRT-0001', { DB: stubDB({ rows: ALL }) });
  check('a well-formed id from another collection -> 404', other.status, 404);

  for (const bad of ['%20', 'STK', '1', 'STK-', 'stk-0001;DROP', '../../etc']) {
    const r = await call(`/api/inventory-transactions/${bad}`, { DB: stubDB({ rows: [] }) });
    ok_(`malformed id "${bad}" -> 400 or 404, never 500`, r.status === 400 || r.status === 404, `got ${r.status}`);
  }
}

console.log('\n-- 9. Read-only --');
{
  const db = stubDB({ rows: ALL });
  await call('/api/inventory-transactions', { DB: db });
  await call('/api/inventory-transactions/STK-0001', { DB: db });
  ok_('every statement issued is a SELECT', db.calls.every((c) => /^\s*SELECT\b/.test(c.sql)));
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER']) {
    ok_(`no ${verb} issued at runtime`, !db.calls.some((c) => new RegExp(`\\b${verb}\\b`, 'i').test(c.sql)));
  }

  // C-4 added POST to this module, so the statics below are scoped to what
  // they were always protecting: the READ path. The module-wide "no write
  // verb" claim is replaced by a runtime one that says strictly more --
  // a GET issues only SELECTs and never runs a batch -- because the module
  // now legitimately contains an INSERT and an UPDATE inside its POST handler.
  ok_('a GET runs no batch at all', (db.batches ?? []).length === 0);
  ok_('a GET never queries parts', !db.calls.some((c) => /\bFROM parts\b/i.test(c.sql)), db.sql);
  ok_('a GET never touches inventory arithmetic',
    !db.calls.some((c) => /stock \+|stock -/.test(c.sql)), db.sql);

  const raw = readFileSync(join(ROOT, 'src/routes/inventory-transactions.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  // Whatever writes the module does contain must be confined to the POST
  // section: the read half is the header, COLUMNS and toRecord(). The split
  // is made on the RAW source at the section marker, then comments stripped --
  // splitting the stripped text would put readFields() (which contains a
  // `delete` statement) on the wrong side of the line.
  const postAt = raw.indexOf('/* ---------- POST:');
  ok_('the module marks where its write half begins', postAt > 0, postAt);
  const beforePost = raw.slice(0, postAt)
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok_('the read half of the module contains no write verb',
    !/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i.test(beforePost), beforePost.slice(-200));
  ok_('the header prose does discuss writes, so the strip matters',
    /write/i.test(raw) && !/\bINSERT\b/i.test(beforePost));
  // The export names legitimately contain "Inventory", so check the imports
  // themselves: only shared libraries, never the frontend engine.
  const imports = [...code.matchAll(/^\s*import\s+[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  check('the module imports only shared libraries', imports.sort(),
    ['../lib/collection.js', '../lib/http.js', '../lib/write.js']);
  ok_('source never imports the inventory engine or utils', !/utils|Utils/.test(code));
  ok_('source never calls a move()/reconcile()/deduct() helper',
    !/\b(move|reconcileJobInventory|deductForJob|returnForJob)\s*\(/.test(code));
  ok_('source never touches localStorage', !/localStorage/.test(code));
  ok_('the read half never reads parts',
    !/\bparts\b/.test(beforePost.replace(/part_id|partId/g, '')), beforePost.slice(-200));
  // And it still invents no aggregate, on either half.
  ok_('nothing sums or groups the ledger', !/\b(SUM|GROUP BY)\b/i.test(code));
}

console.log('\n-- 10. Failure modes --');
{
  // C-4 made POST a real route; PUT and DELETE are what the append-only
  // ledger still refuses, and the Allow header now names POST.
  const r405 = await call('/api/inventory-transactions', { DB: stubDB({ rows: [] }) }, { method: 'PATCH' });
  check('PATCH -> 405', r405.status, 405);
  check('Allow header now names POST', r405.headers.get('allow'), 'GET, POST');
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await call('/api/inventory-transactions', { DB: stubDB({ rows: [] }) }, { method });
    ok_(`${method} -> 405`, r.status === 405, `got ${r.status}`);
  }
  const rDetail = await call('/api/inventory-transactions/STK-0001', { DB: stubDB({ rows: ALL }) }, { method: 'DELETE' });
  check('DELETE on a detail -> 405', rDetail.status, 405);

  const boom = await call('/api/inventory-transactions', { DB: stubDB({ rows: [], throwOn: 'FROM inventory_transactions' }) });
  const bb = await boom.json();
  check('database error -> 500', boom.status, 500);
  check('500 code', bb.error.code, 'database_error');
  check('500 message', bb.error.message, 'Could not read inventory transactions.');
  ok_('no SQL leaks to the client', !JSON.stringify(bb).includes('SELECT'));

  const noDb = await call('/api/inventory-transactions', {});
  check('missing D1 binding -> 503', noDb.status, 503);
  check('503 code', (await noDb.json()).error.code, 'no_database');
}

console.log('\n-- 11. Route registration --');
{
  const db = {
    prepare(sql) {
      return {
        async all() {
          return { results: sql.includes("type = 'table'") ? [{ name: 'customers' }] : [] };
        },
        async first() { return { n: 1 }; },
      };
    },
  };
  const routes = (await (await call('/api/health', { DB: db })).json()).data.routes;
  check('health advertises 174 routes', routes.length, 174);
  ok_('advertises the ledger list', routes.includes('GET /api/inventory-transactions'));
  ok_('advertises the ledger detail', routes.includes('GET /api/inventory-transactions/:id'));
  // C-4 gave the ledger POST and nothing else: a movement is recorded and
  // then never edited or removed.
  ok_('advertises POST', routes.includes('POST /api/inventory-transactions'));
  ok_('advertises no PUT', !routes.includes('PUT /api/inventory-transactions/:id'));
  ok_('advertises no DELETE', !routes.includes('DELETE /api/inventory-transactions/:id'));
  check('exactly three ledger routes',
    routes.filter((r) => r.includes('/api/inventory-transactions')).length, 3);
  // C-9 gave the singleton a write, so the pair is last rather than the one --
  // and C-12 put the three public session routes after it.
  ok_('the settings pair still precedes the session routes',
    routes.slice(-5, -3).join(' | ') === 'GET /api/settings | PUT /api/settings',
    routes.slice(-5));
  ok_('   ...and the session trio is last',
    routes.slice(-3).join(' | ')
      === 'GET /api/session | POST /api/session | DELETE /api/session',
    routes.slice(-3));

  // /api/inventory (the page's own name) is NOT a route — only the ledger is.
  for (const path of ['/api/inventory', '/api/inventory-transaction', '/api/stock']) {
    const r = await call(path, { DB: stubDB({ rows: [] }) });
    ok_(`${path} is still not a route -> 404`, r.status === 404, `got ${r.status}`);
  }

  const miss = await call('/api/nope', { DB: stubDB({ rows: [] }) });
  const mb = await miss.json();
  check('404 advertises exactly what health advertises', mb.error.available, routes);
}

console.log('\n-- 12. The eleven collections are all now reachable --');
{
  const db = {
    prepare(sql) {
      return {
        async all() { return { results: sql.includes("type = 'table'") ? [{ name: 'customers' }] : [] }; },
        async first() { return { n: 1 }; },
      };
    },
  };
  const routes = (await (await call('/api/health', { DB: db })).json()).data.routes;
  for (const name of ['customers', 'vehicles', 'services', 'mechanics', 'parts',
    'appointments', 'job-cards', 'invoices', 'payments', 'invoice-adjustments', 'expenses',
    'inventory-transactions', 'follow-ups', 'follow-up-contacts', 'follow-up-tasks', 'estimates', 'staff', 'accounts', 'attendance', 'leave-requests', 'activity-log']) {
    ok_(`${name} has both routes`,
      routes.includes(`GET /api/${name}`) && routes.includes(`GET /api/${name}/:id`));
  }
  ok_('23 collections x 2 GET, plus health, settings, session, three Messenger and three WhatsApp reads, the two webhooks, website forms, the two Notifications reads and the eight offline-sync reads of 0020, is 71 GETs (24 collections with the bookings of 0023)',
    routes.filter((r) => r.startsWith('GET ')).length === 24 * 2 + 3 + 3 + 1 + 3 + 1 + 2 + 2 + 8,
    `${routes.filter((r) => r.startsWith('GET ')).length}`);
}

console.log(`\nGET /api/inventory-transactions unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
