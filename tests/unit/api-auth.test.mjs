/* The bearer-token gate — unit tests against the REAL Worker with a stubbed
   D1 binding.

   One rule, in one place: a request that changes data must carry
   `Authorization: Bearer <token>` matching the Worker's API_TOKEN secret.
   What matters most here is not that a few examples are protected, but that
   EVERY mutation route is -- so the central test below derives the list from
   the router's own registry rather than repeating it by hand, and a route
   added later is covered the moment it is advertised.

   The other half is failing closed. `if (!env.API_TOKEN) allow everything` is
   the shape of bug that ships an open API the first time a secret is
   forgotten, so a Worker with no secret refuses to write rather than
   accepting anything. */
import worker from '../../src/index.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

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

const TOKEN = 'the-configured-secret';

/** Records every statement the Worker prepares, so "zero writes" is provable. */
function stubDB() {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      const entry = { sql, binds: null };
      calls.push(entry);
      const stmt = {
        bind(...args) { entry.binds = args; return stmt; },
        async first() {
          if (sql.includes('sqlite_master')) return { n: 0 };
          if (sql.includes('id_counters')) return { last_value: 1, prefix: 'CUS' };
          // Enough of a row for a RETURNING, so an AUTHENTICATED write lands
          // as a clean 201 and "the gate let it through" is not confused with
          // "the route fell over". Only the INSERT answers: a lookup must
          // stay empty, or the route's own uniqueness check would 409.
          if (/^\s*INSERT/.test(sql)) {
            return {
              id: 'CUS-0001', name: 'Auth Test', phone: '01700-000000', alt_phone: null,
              email: null, address: null, notes: null, status: 'Active',
              created_at: '2026-09-19T09:00:00.000Z', updated_at: null,
            };
          }
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
    async batch(statements) { return statements.map(() => ({ meta: { changes: 1 } })); },
  };
  return db;
}

const call = (path, { method = 'GET', headers, body, env } = {}) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method,
    ...(headers ? { headers } : {}),
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env);

const authed = (db) => ({ DB: db ?? stubDB(), API_TOKEN: TOKEN });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const bodyOf = async (res) => res.json();

/* ============================================================
   1. Every way of failing looks the same
   ============================================================ */
console.log('\n=== Authentication ===');
console.log('\n-- 1. The 401, and only the 401 --');
const REFUSALS = [
  ['no Authorization header at all', undefined],
  ['an empty Authorization header', { authorization: '' }],
  ['a whitespace-only header', { authorization: '   ' }],
  ['Basic auth instead of Bearer', { authorization: 'Basic dXNlcjpwYXNz' }],
  ['a scheme with no token', { authorization: 'Bearer' }],
  ['Bearer with an empty token', { authorization: 'Bearer ' }],
  ['a token that is not the secret', bearer('not-the-secret')],
  ['a token that is a prefix of the secret', bearer(TOKEN.slice(0, -1))],
  ['a token with the secret plus more', bearer(`${TOKEN}x`)],
  ['a token that differs in the middle', bearer(TOKEN.replace('-', '_'))],
  ['the secret under the wrong scheme', { authorization: `Token ${TOKEN}` }],
  ['the secret with no scheme at all', { authorization: TOKEN }],
];
const shapes = [];
for (const [why, headers] of REFUSALS) {
  const db = stubDB();
  const res = await call('/api/customers', {
    method: 'POST', headers, body: { name: 'X', phone: '01700000000' }, env: authed(db),
  });
  check(`${why} -> 401`, res.status, 401);
  const b = await bodyOf(res);
  check('   ...code', b.error.code, 'unauthorized');
  check('   ...message', b.error.message, 'Authentication required.');
  check('   ...and it advertises the scheme', res.headers.get('www-authenticate'), 'Bearer');
  ok_('   ...ZERO statements reached the database', db.calls.length === 0, db.calls.length);
  ok_('   ...and nothing of the secret is in the response',
    !JSON.stringify(b).includes(TOKEN) && !JSON.stringify(b).includes('API_TOKEN'), JSON.stringify(b));
  shapes.push(JSON.stringify(b));
}
{
  ok_('every refusal returns a byte-identical body — none says which rule it met',
    new Set(shapes).size === 1, [...new Set(shapes)]);
}
{
  const db = stubDB();
  const res = await call('/api/customers', {
    method: 'POST', headers: bearer(TOKEN),
    body: { name: 'Auth Test', phone: '01700-000000' }, env: authed(db),
  });
  check('the right token reaches the route, which then answers normally', res.status, 201);
  ok_('   ...and the route really ran', db.calls.length > 0, db.calls.length);
  ok_('   ...with no trace of the secret in what came back',
    !JSON.stringify(await bodyOf(res)).includes(TOKEN));
}
{
  // Not a gate behaviour but worth pinning: the Headers API normalises a
  // header value, so trailing whitespace is stripped before the gate ever
  // sees it. The token is matched exactly against whatever survives that.
  const padded = await call('/api/customers', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}  ` },
    body: { name: 'X', phone: '01700000002' }, env: authed(),
  });
  ok_('trailing whitespace in the header is stripped by the platform, not by us',
    padded.status === 201, `got ${padded.status}`);
  const inner = await call('/api/customers', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN.slice(0, 3)} ${TOKEN.slice(3)}` },
    body: { name: 'X', phone: '01700000003' }, env: authed(),
  });
  check('   ...but a space INSIDE the token is a different token', inner.status, 401);
}
{
  // RFC 7235 makes the scheme case-insensitive, and more than one space is
  // legal. The TOKEN itself is matched exactly.
  for (const header of [`bearer ${TOKEN}`, `BEARER ${TOKEN}`, `Bearer  ${TOKEN}`]) {
    const res = await call('/api/customers', {
      method: 'POST', headers: { authorization: header },
      body: { name: 'X', phone: '01700000001' }, env: authed(),
    });
    ok_(`\`${header.split(' ')[0]}\` is accepted as the scheme`, res.status !== 401, `got ${res.status}`);
  }
}

/* ============================================================
   2. Fail closed
   ============================================================ */
console.log('\n-- 2. A Worker with no secret refuses to write --');
for (const [why, env] of [
  ['no API_TOKEN at all', { DB: null }],
  ['an empty API_TOKEN', { DB: null, API_TOKEN: '' }],
  ['a whitespace API_TOKEN', { DB: null, API_TOKEN: '   ' }],
  ['a non-string API_TOKEN', { DB: null, API_TOKEN: 12345 }],
  ['API_TOKEN explicitly null', { DB: null, API_TOKEN: null }],
]) {
  const db = stubDB();
  const res = await call('/api/customers', {
    method: 'POST', headers: bearer(TOKEN), body: { name: 'X' }, env: { ...env, DB: db },
  });
  check(`${why} -> 503, never a pass`, res.status, 503);
  const b = await bodyOf(res);
  check('   ...code', b.error.code, 'auth_not_configured');
  ok_('   ...and ZERO statements reached the database', db.calls.length === 0, db.calls.length);
  ok_('   ...the response names no secret and no binding',
    !JSON.stringify(b).includes('API_TOKEN'), JSON.stringify(b));
}
{
  // The critical one: an unconfigured Worker must not become open.
  const db = stubDB();
  const res = await call('/api/customers', {
    method: 'POST', body: { name: 'X' }, env: { DB: db },
  });
  ok_('an unconfigured Worker refuses an UNAUTHENTICATED write too',
    res.status === 503, `got ${res.status}`);
  ok_('   ...and still writes nothing', db.calls.length === 0, db.calls.length);
}
{
  // C-12 protects reads as well, so failing closed now covers them. The
  // original intent -- an unconfigured Worker must never be an OPEN one --
  // is the same assertion, strengthened: it used to hold for writes only.
  const res = await call('/api/customers', { env: { DB: stubDB() } });
  ok_('a GET is refused on an unconfigured Worker too', res.status === 503, `got ${res.status}`);
  const db = stubDB();
  await call('/api/customers', { env: { DB: db } });
  check('   ...without reaching the database', db.calls.length, 0);
}

/* ============================================================
   3. Every mutation route in the registry is protected
   ============================================================ */
console.log('\n-- 3. The whole route surface, derived from the registry --');
{
  const health = await (await call('/api/health', { env: authed() })).json();
  const routes = health.data.routes;
  ok_('health advertises the route list to enumerate', routes.length > 0, routes.length);

  const ID = {
    customers: 'CUS-0001', vehicles: 'VEH-0001', services: 'SRV-0001',
    mechanics: 'MEC-0001', parts: 'PRT-0001', appointments: 'APT-0001',
    'job-cards': 'JOB-0001', invoices: 'INV-0001', payments: 'PAY-0001',
    expenses: 'EXP-0001', 'inventory-transactions': 'STK-0001',
  };
  const concrete = (path) => path.replace(/:id/, (m, i) => {
    const name = path.split('/')[2];
    return ID[name] ?? 'REC-0001';
  });

  // /api/session is how a browser OBTAINS a credential, so requiring one
  // there would be a closed loop. Those two are asserted separately, below,
  // as deliberately public -- everything else must be gated.
  // The Messenger webhook (0014) is public too, by necessity -- Meta cannot hold
  // a session -- and is protected by Meta's own verify token and App Secret
  // signature instead; tests/unit/api-messenger.test.mjs proves it refuses an
  // unsigned delivery before reading anything.
  const PUBLIC = new Set(['POST /api/session', 'DELETE /api/session', 'GET /api/session',
                          'GET /api/health', 'GET /api/webhooks/messenger', 'POST /api/webhooks/messenger',
                          'GET /api/webhooks/whatsapp', 'POST /api/webhooks/whatsapp',
                          'POST /api/forms/submit', 'POST /api/bookings/submit']);
  const mutations = routes.filter(
    (r) => /^(POST|PUT|PATCH|DELETE) /.test(r) && !PUBLIC.has(r));
  ok_('the registry really does advertise mutations', mutations.length >= 30, mutations.length);

  const unprotected = [];
  const wrote = [];
  for (const route of mutations) {
    const [method, path] = route.split(' ');
    const db = stubDB();
    const res = await call(concrete(path), {
      method, body: { probe: true }, env: authed(db),
    });
    if (res.status !== 401) unprotected.push({ route, status: res.status });
    if (db.calls.length !== 0) wrote.push({ route, calls: db.calls.length });
  }
  check('EVERY advertised mutation refuses an unauthenticated caller', unprotected, []);
  check('   ...and none of them reached the database', wrote, []);
  check('   ...which is all of them', mutations.length - unprotected.length, mutations.length);

  // And the same routes DO work once authenticated, so the gate is what is
  // refusing them rather than the route being broken.
  const stillRefused = [];
  // 0019: two routes belong to a PERSON's own session, so the machine token is
  // refused there by design: changing your own password, and a Super Admin
  // switching the shared passphrase on or off (tests/unit/api-login.test.mjs).
  const PERSONAL = new Set(['POST /api/session/password', 'PUT /api/session/passphrase']);
  for (const route of mutations) {
    if (PERSONAL.has(route)) continue;
    const [method, path] = route.split(' ');
    const res = await call(concrete(path), {
      method, headers: bearer(TOKEN), body: { probe: true }, env: authed(),
    });
    if (res.status === 401) stillRefused.push(route);
  }
  check('   ...and every one of them lets a valid token through (except the two that need a person\'s own session)', stillRefused, []);

  // C-12 inverted this. Reads were public; they are business data, so now
  // they are not. The assertion keeps its shape and its purpose -- enumerate
  // EVERY advertised GET from the registry rather than spot-checking -- and
  // asserts the opposite outcome.
  const reads = routes.filter((r) => r.startsWith('GET ') && !PUBLIC.has(r));
  const openReads = [];
  const readTouchedDb = [];
  for (const route of reads) {
    const [, path] = route.split(' ');
    const db = stubDB();
    const res = await call(concrete(path), { env: authed(db) });
    if (res.status !== 401) openReads.push({ route, status: res.status });
    if (db.calls.length !== 0) readTouchedDb.push({ route, calls: db.calls.length });
  }
  check('EVERY advertised GET refuses an unauthenticated caller', openReads, []);
  check('   ...and none of them reached the database', readTouchedDb, []);
  check('   ...which is all of them', reads.length - openReads.length, reads.length);

  const stillRefusedReads = [];
  for (const route of reads) {
    const [, path] = route.split(' ');
    const res = await call(concrete(path), { headers: bearer(TOKEN), env: authed() });
    if (res.status === 401) stillRefusedReads.push(route);
  }
  check('   ...and every one lets a valid token through', stillRefusedReads, []);

  // The two that must stay open, and why: health is how an operator sees the
  // Worker is up, and session is how a browser gets a credential at all.
  ok_('health stays public', (await call('/api/health', { env: authed() })).status === 200);
  const sess = await call('/api/session', { env: authed() });
  ok_('GET /api/session stays public', sess.status === 200, `got ${sess.status}`);
  // `accounts` (0009): whether a staff member may sign in with their own
  // account here. Still nothing about who is signed in for a caller without one.
  check('   ...and says only whether this caller is signed in, and how signing in works here',
    Object.keys((await sess.json()).data).sort(), ['accounts', 'authenticated', 'passphrase', 'sharedPassphrase']);
}
{
  // Health is a GET; the gate never sees it, and a wrong method there is
  // still a method error rather than an authentication one.
  const res = await call('/api/health', { method: 'POST', env: authed() });
  check('POST /api/health -> 405, not 401', res.status, 405);
  check('   ...Allow names GET', res.headers.get('allow'), 'GET');
  const noSecret = await call('/api/health', { env: { DB: stubDB() } });
  check('GET /api/health works with no secret configured', noSecret.status, 200);
}
{
  // OPTIONS is a preflight, not a business mutation, and is not gated.
  const res = await call('/api/customers', { method: 'OPTIONS', env: authed() });
  ok_('OPTIONS is not treated as a mutation', res.status !== 401 && res.status !== 503,
    `got ${res.status}`);
  const head = await call('/api/customers', { method: 'HEAD', env: authed() });
  ok_('   ...and neither is HEAD', head.status !== 401, `got ${head.status}`);
}
{
  // An unknown path with a mutating method is refused before it is resolved,
  // so nothing about what exists is revealed.
  for (const path of ['/api/widgets', '/api/customers/CUS-0001', '/api/nope/deep/path']) {
    const db = stubDB();
    const res = await call(path, { method: 'DELETE', env: authed(db) });
    ok_(`DELETE ${path} without a token never reaches the database`,
      db.calls.length === 0, db.calls.length);
  }
  const ghost = await call('/api/customers/CUS-9999', { method: 'DELETE', env: authed() });
  check('a DELETE of a record that does not exist is 401, not 404',
    ghost.status, 401);
}

/* ============================================================
   4. The module itself
   ============================================================ */
console.log('\n-- 4. What the source must not contain --');
{
  const auth = readFileSync(join(ROOT, 'src/lib/auth.js'), 'utf8');
  const code = auth.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  ok_('the helper never logs the supplied token',
    !/console\.(log|warn|error|info)[\s\S]{0,120}(match\[1\]|supplied|header)/.test(code),
    'a log mentions the credential');
  ok_('   ...nor the expected one',
    !/console\.(log|warn|error|info)[\s\S]{0,120}(expected|API_TOKEN\b\s*\))/.test(code),
    'a log mentions the secret');
  ok_('it uses a constant-time comparison where the runtime offers one',
    /timingSafeEqual/.test(code), 'no constant-time comparison');
  ok_('   ...and settles the lengths first, because that call throws on a mismatch',
    code.indexOf('a.length !== b.length') < code.indexOf('timingSafeEqual'), 'order is wrong');
  // The real risk is a literal standing in for the secret: a fallback value,
  // or a comparison against one. Header names and error codes are literals
  // too, so the check is about how a literal is USED.
  ok_('the secret has no hard-coded fallback',
    !/API_TOKEN\s*(\|\||\?\?)\s*['"]/.test(code), 'a fallback value was found');
  // `typeof x === 'string'` is a type guard, not a credential comparison, so
  // those are removed before the check -- otherwise the guard on the binding
  // itself would trip it.
  const noTypeof = code.replace(/typeof\s+[\w?.]+\s*(===|!==|==|!=)\s*'[a-z]+'/g, ' ');
  ok_('   ...and no credential is compared against a literal',
    !/(supplied|expected|token|secret)\w*\s*(===|==|!==|!=)\s*['"][^'"]{4,}['"]/i.test(noTypeof),
    'a credential is compared against a literal');
  ok_('   ...and the strip is doing real work, not hiding the check',
    /typeof/.test(code) && code !== noTypeof);
  // C-12 made a signed cookie the browser's credential, so "no cookie" is no
  // longer the rule. What the rule was FOR still holds, and is now stated
  // directly: no auth framework, and no session state anywhere to be stolen
  // or to drift -- the cookie is signed, not stored.
  ok_('it introduces no JWT or OAuth library',
    !/(jsonwebtoken|\bjwt\b|oauth|openid|passport)/i.test(code), 'an auth framework crept in');
  ok_('   ...and no session is stored anywhere',
    !/(sessions?\s*\[|INSERT|SELECT|kv\.|KV|DurableObject|localStorage)/i.test(code),
    'session state is being kept somewhere');
  const mint = (code.match(/function mintSession[\s\S]*?\n\}/) || [''])[0];
  ok_('   ...the cookie carries only a version and an expiry',
    mint.length > 0 && /SESSION_VERSION/.test(mint) && /expires/.test(mint)
      && !/user|email|\bname\b|role|passphrase/i.test(mint), mint.slice(0, 200));
  ok_('   ...and is signed with HMAC over that payload',
    /crypto\.subtle\.(importKey|sign)/.test(code) && /HMAC/.test(code),
    'the cookie is not signed');
  ok_('it reads the secret from the env binding, not from a file or a table',
    /env\.API_TOKEN/.test(code) && !/D1|prepare\(|readFile/.test(code), code.slice(0, 200));

  const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  ok_('wrangler.jsonc contains no API_TOKEN value',
    !/API_TOKEN\s*"?\s*:\s*"[^"]+"/.test(wrangler), 'a token value is committed');

  const index = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  const indexCode = index.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  check('the router imports the gate once', (indexCode.match(/checkAuth/g) ?? []).length, 2);
  ok_('   ...and every handler is dispatched through the guarded runner',
    !/return (collection|action)\.?\w*\(request, env/.test(indexCode),
    'a handler is called without the gate');
}

console.log(`\nAuthentication unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
