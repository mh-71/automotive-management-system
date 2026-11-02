/* GET /api/settings — unit tests against the REAL Worker handler with a
   stubbed D1 binding.

   Settings is the first endpoint in this API that is not a collection, so the
   weight here is on the things that follow from being a singleton: that the
   payload is a bare object rather than a one-element array, that none of the
   paging metadata comes along, that a trailing path segment is a clean 404
   rather than an exception from a detail handler that does not exist, and
   that a missing row is reported rather than defaulted into existence.

   The other half is coercion. Two of this table's columns can legitimately
   hold a falsy value -- tax_rate 0 and an empty currency -- and both would be
   silently rewritten by a `||` fallback, so each has its own assertion. */
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
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(expected === undefined ? actual : actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

/* The settings query binds nothing -- there is no path segment, filter or
   query string to bind -- so unlike the collection stubs this one answers
   first() straight from the row it was given. `row: null` is the
   missing-settings case. */
function stubDB({ row = null, throwOnRead = false }) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async all() {
          if (throwOnRead) throw new Error('D1_ERROR: simulated failure');
          return { results: row ? [row] : [] };
        },
        async first() {
          if (throwOnRead) throw new Error('D1_ERROR: simulated failure');
          return row;
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

/** Runs fn with console.warn captured, returning [result, warnings]. */
async function capturingWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return [await fn(), warnings];
  } finally {
    console.warn = original;
  }
}

/* A fully populated row, modelled on the shape storage.js:106-125 describes
   and on what the Settings form actually writes. */
const FULL = {
  business_name: 'Taqwa Automobile Service Center',
  phone: '+880 1712-345678',
  email: 'info@taqwaauto.com',
  website: 'https://taqwaauto.com',
  tax_id: 'BIN-004471928',
  address: 'Sector #15, Block #C, Road #3/A, Plot #40, Diabari, Uttara, Dhaka',
  business_description: 'Full-service automobile workshop.',
  invoice_footer: 'Thank you for servicing with Taqwa Automobile Service Center.',
  payment_terms: 'Payment due within 7 days.',
  tax_rate: 5,
  currency: '৳',
  default_appointment_duration: 60,
  opening_time: '09:00',
  closing_time: '20:00',
  working_days: '["Sat","Sun","Mon","Tue","Wed","Thu"]',
  updated_at: '2026-09-26T09:00:00',
};

/* Every optional column null, to exercise the '' and [] fallbacks. */
const SPARSE = {
  business_name: 'Corner Garage',
  phone: '+880 1999-000111',
  email: null,
  website: null,
  tax_id: null,
  address: 'Road 2, Mirpur, Dhaka',
  business_description: null,
  invoice_footer: null,
  payment_terms: null,
  tax_rate: 0,
  currency: '',
  default_appointment_duration: null,
  opening_time: null,
  closing_time: null,
  working_days: null,
  updated_at: null,
};

const body = (res) => res.json();

console.log('\n-- 1. Successful singleton read --');
{
  const db = stubDB({ row: FULL });
  const res = await call('/api/settings', { DB: db });
  const b = await body(res);
  ok_('GET /api/settings -> 200', res.status === 200, `got ${res.status}`);
  ok_('content-type is JSON', (res.headers.get('content-type') || '').includes('application/json'));
  check('every field maps exactly', b.data, {
    businessName: 'Taqwa Automobile Service Center',
    phone: '+880 1712-345678',
    email: 'info@taqwaauto.com',
    website: 'https://taqwaauto.com',
    taxId: 'BIN-004471928',
    address: 'Sector #15, Block #C, Road #3/A, Plot #40, Diabari, Uttara, Dhaka',
    businessDescription: 'Full-service automobile workshop.',
    invoiceFooter: 'Thank you for servicing with Taqwa Automobile Service Center.',
    paymentTerms: 'Payment due within 7 days.',
    taxRate: 5,
    currency: '৳',
    defaultAppointmentDuration: 60,
    openingTime: '09:00',
    closingTime: '20:00',
    workingDays: ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'],
    updatedAt: '2026-09-26T09:00:00',
  });
}

console.log('\n-- 2. Singleton shape, not a collection --');
{
  const res = await call('/api/settings', { DB: stubDB({ row: FULL }) });
  const b = await body(res);
  ok_('data is an object', typeof b.data === 'object' && b.data !== null);
  ok_('data is NOT an array', Array.isArray(b.data) === false, JSON.stringify(b.data).slice(0, 60));
  for (const key of ['count', 'total', 'limit', 'offset']) {
    ok_(`no \`${key}\` in the envelope`, !(key in b), `found ${key}`);
  }
  check('the envelope has exactly one key', Object.keys(b), ['data']);
}

console.log('\n-- 3. The fifteen fields the frontend actually has --');
{
  // Read DEFAULT_SETTINGS straight out of the shipped storage.js so this
  // cannot drift: if a field is ever added there, this fails until the API
  // carries it too.
  const src = readFileSync(join(ROOT, 'js/storage.js'), 'utf8');
  const block = src.slice(src.indexOf('const DEFAULT_SETTINGS = {'));
  const frontendKeys = block
    .slice(0, block.indexOf('\n  };'))
    .split('\n')
    .map((l) => (l.match(/^\s{4}([A-Za-z]+):/) || [])[1])
    .filter(Boolean);

  ok_('storage.js exposes 15 settings fields', frontendKeys.length === 15, `got ${frontendKeys.length}: ${frontendKeys}`);

  const res = await call('/api/settings', { DB: stubDB({ row: FULL }) });
  const b = await body(res);
  const missing = frontendKeys.filter((k) => !(k in b.data));
  check('every frontend field is present in the API record', missing, []);

  // updatedAt is the only key the API adds; id is deliberately not returned.
  const extra = Object.keys(b.data).filter((k) => !frontendKeys.includes(k));
  check('the API adds only updatedAt', extra, ['updatedAt']);
  ok_('id is not returned', !('id' in b.data));
  ok_('theme is not returned', !('theme' in b.data));
}

console.log('\n-- 4. Null handling --');
{
  const res = await call('/api/settings', { DB: stubDB({ row: SPARSE }) });
  const b = await body(res);
  for (const key of ['email', 'website', 'taxId', 'businessDescription',
    'invoiceFooter', 'paymentTerms', 'openingTime', 'closingTime']) {
    check(`${key}: NULL -> ''`, b.data[key], '');
  }
  check('defaultAppointmentDuration: NULL -> \'\'', b.data.defaultAppointmentDuration, '');
  check('workingDays: NULL -> []', b.data.workingDays, []);
  ok_('no field is null', Object.values(b.data).every((v) => v !== null));
}

console.log('\n-- 5. Falsy values survive --');
{
  const res = await call('/api/settings', { DB: stubDB({ row: SPARSE }) });
  const b = await body(res);
  check('taxRate 0 stays 0, never the frontend default', b.data.taxRate, 0);
  ok_('taxRate is a number, not a string', typeof b.data.taxRate === 'number');
  check("currency '' stays '', never '৳'", b.data.currency, '');

  const zeroDuration = await call('/api/settings', {
    DB: stubDB({ row: { ...SPARSE, default_appointment_duration: 0 } }),
  });
  // The column's CHECK forbids 0 today; the mapper still must not collapse it.
  check('defaultAppointmentDuration 0 stays 0', (await body(zeroDuration)).data.defaultAppointmentDuration, 0);
}

console.log('\n-- 6. updatedAt --');
{
  const withTs = await call('/api/settings', { DB: stubDB({ row: FULL }) });
  const b1 = await body(withTs);
  ok_('present when updated_at is set', b1.data.updatedAt === '2026-09-26T09:00:00');

  const noTs = await call('/api/settings', { DB: stubDB({ row: SPARSE }) });
  const b2 = await body(noTs);
  ok_('key omitted entirely when updated_at is NULL', !('updatedAt' in b2.data));
  ok_('and not present as null', b2.data.updatedAt === undefined);
}

console.log('\n-- 7. workingDays JSON --');
{
  const cases = [
    ['a valid JSON array', '["Sat","Mon"]', ['Sat', 'Mon'], false],
    ['an empty JSON array', '[]', [], false],
    ['invalid JSON', '{not json', [], true],
    ['a JSON object, not an array', '{"Sat":true}', [], true],
    ['a bare JSON string', '"Sat"', [], true],
    ['a JSON number', '7', [], true],
    ['JSON null', 'null', [], true],
    ['an empty string', '', [], false],
  ];
  for (const [label, stored, expected, shouldWarn] of cases) {
    const [res, warnings] = await capturingWarnings(() =>
      call('/api/settings', { DB: stubDB({ row: { ...FULL, working_days: stored } }) })
    );
    const b = await body(res);
    check(`${label} -> ${JSON.stringify(expected)}`, b.data.workingDays, expected);
    ok_(`${label}: status stays 200`, res.status === 200, `got ${res.status}`);
    ok_(
      `${label}: ${shouldWarn ? 'warns' : 'no warning'}`,
      shouldWarn ? warnings.length === 1 : warnings.length === 0,
      JSON.stringify(warnings)
    );
  }
  ok_('a malformed column never produces a 500',
    (await call('/api/settings', { DB: stubDB({ row: { ...FULL, working_days: '{[' } }) })).status === 200);
}

console.log('\n-- 8. Missing settings row --');
{
  const db = stubDB({ row: null });
  const res = await call('/api/settings', { DB: db });
  const b = await body(res);
  ok_('-> 404', res.status === 404, `got ${res.status}`);
  check('error code', b.error.code, 'not_found');
  check('error message', b.error.message, 'No settings have been saved.');
  ok_('no data key', !('data' in b));
  // A GET that defaults a row into place would be a write. Nothing but the
  // one SELECT may reach the database.
  ok_('still exactly one query', db.calls.length === 1, `${db.calls.length}`);
  ok_('and it is a SELECT', /^\s*SELECT\b/.test(db.calls[0].sql));
  ok_('no INSERT was attempted', !db.calls.some((c) => /INSERT/i.test(c.sql)));
}

console.log('\n-- 9. Query strategy --');
{
  const db = stubDB({ row: FULL });
  await call('/api/settings', { DB: db });
  ok_('exactly one query on success', db.calls.length === 1, `${db.calls.length}`);

  const sql = db.calls[0].sql;
  ok_('no SELECT *', !/SELECT\s+\*/i.test(sql), sql);
  ok_('targets the settings table', /FROM\s+settings/i.test(sql));
  ok_('selects the singleton by id = 1', /WHERE\s+id\s*=\s*1/i.test(sql));
  ok_('no JOIN', !/\bJOIN\b/i.test(sql));
  ok_('no count query', !/count\s*\(/i.test(sql));
  ok_('nothing is bound (no request input reaches the SQL)', db.calls[0].binds === null);

  for (const col of ['business_name', 'phone', 'email', 'website', 'tax_id', 'address',
    'business_description', 'invoice_footer', 'payment_terms', 'tax_rate', 'currency',
    'default_appointment_duration', 'opening_time', 'closing_time', 'working_days', 'updated_at']) {
    ok_(`selects ${col} explicitly`, sql.includes(col), sql);
  }
  ok_('does not select id', !/\bid\s*,/.test(sql.split('FROM')[0]), sql);
}

console.log('\n-- 10. Read-only --');
{
  const db = stubDB({ row: FULL });
  await call('/api/settings', { DB: db });
  ok_('every statement issued is a SELECT', db.calls.every((c) => /^\s*SELECT\b/.test(c.sql)));
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER']) {
    ok_(`no ${verb} issued at runtime`, !db.calls.some((c) => new RegExp(`\\b${verb}\\b`, 'i').test(c.sql)));
  }

  // Static check on the shipped module, with comments stripped first: this
  // file's own header discusses INSERT-time defaults in prose, and a naive
  // grep would match that rather than any code.
  //
  // C-9 gave the module a write half, so these are now scoped to the READ
  // half -- which is what they were always about. The split is made on the
  // RAW source at the section marker and comments stripped afterwards, the
  // pattern the ledger and payment suites already use.
  const raw = readFileSync(join(ROOT, 'src/routes/settings.js'), 'utf8');
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const code = strip(raw);
  const writeAt = raw.indexOf('   C-9 \u2014 the write half');
  ok_('the module marks where its write half begins', writeAt > 0, writeAt);
  const readHalf = strip(raw.slice(0, writeAt));
  const writeHalf = strip(raw.slice(writeAt));

  for (const pattern of [/INSERT\s+INTO/i, /UPDATE\s+\w+\s+SET/i, /DELETE\s+FROM/i, /REPLACE\s+INTO/i]) {
    ok_(`the read half contains no ${pattern.source}`, !pattern.test(readHalf));
  }
  ok_('the read half mentions no write verb at all outside comments',
    !/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i.test(readHalf), readHalf.slice(-200));
  // Proves the strip above is doing real work rather than the file simply
  // being free of the word.
  ok_('the header prose does discuss INSERT, so the strip matters',
    /INSERT/i.test(raw) && !/INSERT/i.test(readHalf));
  ok_('every write the module does contain is in the write half',
    /INSERT\s+INTO settings/i.test(writeHalf), 'no write found where the writes belong');
  ok_('and it touches no table but settings',
    !/\b(customers|vehicles|job_cards|invoices|payments|parts|appointments|expenses|inventory_transactions)\b/
      .test(writeHalf), 'another table referenced');
  ok_('source never touches localStorage', !/localStorage/.test(code));
  ok_('source does not import collectionRoutes', !/collectionRoutes/.test(code));
}

console.log('\n-- 11. Method handling --');
{
  // C-9 added PUT; the rule under test is unchanged, and the Allow header now
  // names both methods the singleton really takes. There is still no create
  // and no delete for a row that is permanently id 1.
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    const db = stubDB({ row: FULL });
    const res = await call('/api/settings', { DB: db }, { method });
    const b = await body(res);
    ok_(`${method} -> 405`, res.status === 405, `got ${res.status}`);
    check(`${method} error code`, b.error.code, 'method_not_allowed');
    check(`${method} Allow header`, res.headers.get('allow'), 'GET, PUT');
    ok_(`${method} never reaches the database`, db.calls.length === 0, `${db.calls.length} queries`);
  }
  ok_('HEAD -> 405 as well', (await call('/api/settings', { DB: stubDB({ row: FULL }) }, { method: 'HEAD' })).status === 405);
}

console.log('\n-- 12. Trailing segments are a clean 404 --');
{
  for (const path of ['/api/settings/1', '/api/settings/anything', '/api/settings/SET-0001',
    '/api/settings/', '/api/settings/1/extra']) {
    const db = stubDB({ row: FULL });
    let res, threw = false;
    try { res = await call(path, { DB: db }); } catch { threw = true; }
    ok_(`${path} does not throw`, !threw);
    ok_(`${path} -> 404`, res && res.status === 404, res ? `got ${res.status}` : 'threw');
    if (res) {
      const b = await res.json();
      check(`${path} uses the standard not-found shape`, b.error.code, 'not_found');
      ok_(`${path} advertises the route list`, Array.isArray(b.error.available));
    }
    ok_(`${path} issues no query`, db.calls.length === 0, `${db.calls.length}`);
  }
}

console.log('\n-- 13. Failure modes --');
{
  const db = stubDB({ row: FULL, throwOnRead: true });
  const res = await call('/api/settings', { DB: db });
  const b = await body(res);
  ok_('database error -> 500', res.status === 500, `got ${res.status}`);
  check('error code', b.error.code, 'database_error');
  check('error message', b.error.message, 'Could not read settings.');
  ok_('no SQL leaks to the client', !JSON.stringify(b).includes('SELECT'));
  ok_('no stack trace leaks', !JSON.stringify(b).toLowerCase().includes('d1_error'));

  const noDb = await call('/api/settings', {});
  const b2 = await noDb.json();
  ok_('missing D1 binding -> 503', noDb.status === 503, `got ${noDb.status}`);
  check('no_database code', b2.error.code, 'no_database');

  // The binding check must come first: without it the handler would throw.
  const noDbPost = await call('/api/settings', {}, { method: 'POST' });
  ok_('method check precedes the binding check', noDbPost.status === 405, `got ${noDbPost.status}`);
}

console.log('\n-- 14. Route registration --');
{
  const db = {
    prepare(sql) {
      return {
        async all() {
          return {
            results: sql.includes('type = \'table\'')
              ? [{ name: 'customers' }, { name: 'settings' }]
              : [],
          };
        },
        async first() { return { n: 42 }; },
      };
    },
  };
  const res = await call('/api/health', { DB: db });
  const b = await res.json();
  const routes = b.data.routes;

  check('health advertises 144 routes', routes.length, 144);
  ok_('advertises GET /api/settings', routes.includes('GET /api/settings'));
  ok_('does NOT advertise a settings detail route', !routes.includes('GET /api/settings/:id'));
  // Was "every route is a GET" through Phase B. C-2 made that false by
  // design, so the assertion is now the exact method distribution -- which
  // says strictly more than the old one did.
  {
    const byMethod = {};
    routes.forEach((r) => { const m = r.split(' ')[0]; byMethod[m] = (byMethod[m] || 0) + 1; });
    check('59 GET, 53 POST, 21 PUT, 11 DELETE', byMethod,
      { GET: 59, POST: 53, PUT: 21, DELETE: 11 });
    ok_('no other method is advertised',
      routes.every((r) => ['GET', 'POST', 'PUT', 'DELETE'].includes(r.split(' ')[0])));
    check('settings offers a read and a write, and nothing else',
      routes.filter((r) => r.endsWith('/api/settings')).sort(),
      ['GET /api/settings', 'PUT /api/settings']);
  }
  check('the settings pair is advertised before the session routes', routes.slice(-5, -3),
    ['GET /api/settings', 'PUT /api/settings']);
  check('   ...and the session trio is last', routes.slice(-3),
    ['GET /api/session', 'POST /api/session', 'DELETE /api/session']);
  ok_('exactly two settings entries, and no /:id',
    routes.filter((r) => r.includes('/api/settings')).length === 2
      && !routes.some((r) => r.includes('/api/settings/')), routes);

  // The 404 list and the health list must not drift apart.
  const miss = await call('/api/nope', { DB: stubDB({ row: null }) });
  const mb = await miss.json();
  check('404 advertises exactly what health advertises', mb.error.available, routes);
}

console.log('\n-- 15. The existing ten collections are untouched --');
{
  const res = await call('/api/health', {
    DB: {
      prepare(sql) {
        return {
          async all() { return { results: sql.includes('type = \'table\'') ? [{ name: 'customers' }] : [] }; },
          async first() { return { n: 1 }; },
        };
      },
    },
  });
  const routes = (await res.json()).data.routes;
  for (const name of ['customers', 'vehicles', 'services', 'mechanics', 'parts',
    'appointments', 'job-cards', 'invoices', 'payments', 'expenses']) {
    ok_(`${name} still has both routes`,
      routes.includes(`GET /api/${name}`) && routes.includes(`GET /api/${name}/:id`));
  }
  check('health is still first', routes[0], 'GET /api/health');
  // Every GET route Phase B shipped is still advertised, in the same relative
  // order. C-2 interleaved write routes between them but removed none.
  {
    const gets = routes.filter((r) => r.startsWith('GET '));
    check('all 59 GET routes survive, in order', gets, [
      'GET /api/health',
      ...['customers', 'vehicles', 'services', 'mechanics', 'parts', 'appointments',
        'job-cards', 'invoices', 'payments', 'invoice-adjustments', 'expenses', 'inventory-transactions',
        'follow-ups', 'follow-up-contacts', 'follow-up-tasks', 'estimates', 'staff', 'accounts', 'attendance', 'leave-requests', 'activity-log', 'website-forms', 'tools']
        .flatMap((n) => [`GET /api/${n}`, `GET /api/${n}/:id`]),
      'GET /api/messenger/conversations', 'GET /api/messenger/conversations/:id', 'GET /api/messenger/conversations/:id/messages',
      'GET /api/webhooks/messenger',
      'GET /api/whatsapp/conversations', 'GET /api/whatsapp/conversations/:id', 'GET /api/whatsapp/conversations/:id/messages',
      'GET /api/webhooks/whatsapp',
      'GET /api/notifications', 'GET /api/notifications/unread-count',
      'GET /api/settings',
      'GET /api/session',
    ]);
  }

  // Settings must not have leaked into the collection registry.
  const listShaped = await call('/api/settings?limit=5&offset=2', { DB: stubDB({ row: FULL }) });
  const lb = await listShaped.json();
  ok_('query params are ignored, not treated as paging', listShaped.status === 200 && !('limit' in lb));
  ok_('and the payload is still a bare object', !Array.isArray(lb.data));
}

console.log(`\nGET /api/settings unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
