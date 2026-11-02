/* api-session — the signed session cookie, end to end through the real Worker.

   C-12's whole claim is that a browser can hold a credential safely. That
   rests on four things, and this suite is about those four: the cookie is
   signed so it cannot be forged, it expires so it cannot be kept forever,
   it carries no identity so there is nothing in it to leak, and the flags on
   it stop script reading it and stop another site sending it. */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../src/index.js';
import { SESSION_COOKIE } from '../../src/lib/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

const stubDB = () => {
  const calls = [];
  return { calls, prepare(sql) {
    calls.push(sql);
    const st = { bind() { return st; }, async all() { return { results: [] }; },
                 async first() { return { n: 0 }; }, async run() { return { meta: { changes: 1 } }; } };
    return st;
  }, async batch() { return [{ meta: { changes: 1 } }]; } };
};

const PASSPHRASE = 'unit-test-passphrase';
const SECRET = 'unit-test-signing-secret';
const TOKEN = 'unit-test-machine-token';
const full = (extra = {}) => ({ DB: stubDB(), AUTH_PASSPHRASE: PASSPHRASE, AUTH_SECRET: SECRET, ...extra });

const call = (path, { method = 'GET', headers = {}, body, env = full() } = {}) =>
  worker.fetch(new Request('http://worker.local' + path, {
    method, headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), env);

const signIn = async (env = full(), passphrase = PASSPHRASE) => {
  const res = await call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: { passphrase }, env,
  });
  const setCookie = res.headers.get('set-cookie');
  return { res, setCookie, cookie: setCookie ? setCookie.split(';')[0] : null };
};

console.log('=== /api/session: the signed cookie ===\n');

/* ============================================================
   1. Getting one
   ============================================================ */
console.log('-- 1. signing in --');
{
  const { res, setCookie, cookie } = await signIn();
  check('the right passphrase is accepted', res.status, 204);
  ok_('   ...and sets a cookie', !!setCookie, String(setCookie));
  ok_('   ...named for this app', cookie.startsWith(`${SESSION_COOKIE}=`), cookie);
  check('   ...with no body to leak anything into', await res.text(), '');
}
{
  for (const [why, body] of [
    ['a wrong passphrase', { passphrase: 'nope' }],
    ['an empty passphrase', { passphrase: '' }],
    ['a passphrase of the wrong type', { passphrase: { toString: 1 } }],
    ['no passphrase at all', {}],
  ]) {
    const res = await call('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    check(`${why} is refused`, res.status, 401);
    ok_('   ...and sets no cookie', res.headers.get('set-cookie') === null, String(res.headers.get('set-cookie')));
  }
}
{
  const res = await call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: { passphrase: 'x' },
  });
  const body = await res.json();
  check('the refusal is the SAME one the rest of the API gives', body.error.code, 'unauthorized');
  check('   ...with the same message', body.error.message, 'Authentication required.');
  ok_('   ...so it cannot be told from "no passphrase is configured"',
    !/configur|passphrase|secret/i.test(body.error.message), body.error.message);
}

/* ============================================================
   2. The cookie's attributes
   ============================================================ */
console.log('\n-- 2. cookie flags --');
{
  const { setCookie } = await signIn();
  const flags = setCookie.toLowerCase();
  ok_('HttpOnly — script cannot read it, so an XSS cannot steal the session',
    flags.includes('httponly'), setCookie);
  ok_('Secure — never sent over plain HTTP', flags.includes('secure'), setCookie);
  ok_('SameSite=Strict — another site cannot make the browser send it (CSRF)',
    flags.includes('samesite=strict'), setCookie);
  ok_('Path=/ — the app and the API share an origin', flags.includes('path=/'), setCookie);
  ok_('Max-Age is set, so it expires on its own', /max-age=\d+/.test(flags), setCookie);
  const maxAge = Number((flags.match(/max-age=(\d+)/) || [])[1]);
  ok_('   ...after a shift rather than a fortnight',
    maxAge > 0 && maxAge <= 24 * 3600, String(maxAge));
}
{
  const { cookie } = await signIn();
  const value = cookie.slice(SESSION_COOKIE.length + 1);
  const parts = value.split('.');
  check('the value is version.expiry.signature', parts.length, 3);
  check('   ...version first', parts[0], 'v1');
  ok_('   ...then an expiry in the future', Number(parts[1]) > Math.floor(Date.now() / 1000), parts[1]);
  ok_('IT CARRIES NO IDENTITY: no user, no email, no passphrase',
    !value.includes(PASSPHRASE) && !/@/.test(value), value);
  ok_('   ...and not the signing secret either', !value.includes(SECRET), value);
}

/* ============================================================
   3. Using one
   ============================================================ */
console.log('\n-- 3. what a session unlocks --');
{
  const env = full();
  const { cookie } = await signIn(env);
  for (const [method, path] of [['GET', '/api/customers'], ['GET', '/api/customers/CUS-0001'],
                                ['GET', '/api/settings'], ['GET', '/api/invoices']]) {
    const res = await call(path, { method, headers: { cookie }, env });
    ok_(`${method} ${path} is allowed with a session`, res.status !== 401 && res.status !== 503,
      `got ${res.status}`);
  }
  const wrote = await call('/api/customers', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: { name: 'A', phone: '01711-000000' }, env,
  });
  ok_('   ...and so is a write', wrote.status !== 401, `got ${wrote.status}`);
}
{
  const env = full();
  const { cookie } = await signIn(env);
  const res = await call('/api/session', { headers: { cookie }, env });
  const body = await res.json();
  check('GET /api/session reports the session', body.data.authenticated, true);
  check('   ...and says signing in is possible here', body.data.passphrase, true);
  // A passphrase session names nobody: no `account` key (only an account session has one, 0009).
  check('   ...and nothing else at all (no account: a passphrase session names nobody)', Object.keys(body.data).sort(), ['accounts', 'authenticated', 'fullAccess', 'passphrase', 'permissions']);
  // 0018: the passphrase keeps the full access it always had, and says so (for display only).
  check('   ...the passphrase has full access, every permission listed', [body.data.fullAccess, body.data.permissions.length > 50, body.data.permissions.includes('roles.edit')], [true, true, true]);
}

/* ============================================================
   4. Forging one
   ============================================================ */
console.log('\n-- 4. what a session cannot be talked into --');
{
  const env = full();
  const { cookie } = await signIn(env);
  const value = cookie.slice(SESSION_COOKIE.length + 1);
  const [v, exp, sig] = value.split('.');

  const forged = {
    'a flipped signature byte': `${v}.${exp}.${sig.slice(0, -1)}${sig.slice(-1) === 'A' ? 'B' : 'A'}`,
    'no signature': `${v}.${exp}.`,
    'a later expiry, same signature': `${v}.${Number(exp) + 99999}.${sig}`,
    'a different version': `v2.${exp}.${sig}`,
    'an unsigned value': `${v}.${exp}`,
    'nonsense': 'not-a-session',
    'an empty value': '',
    'a signature from another secret': `${v}.${exp}.AAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  };
  for (const [why, bad] of Object.entries(forged)) {
    const res = await call('/api/customers', {
      headers: { cookie: `${SESSION_COOKIE}=${bad}` }, env,
    });
    check(`${why} -> 401`, res.status, 401);
  }
}
{
  // The expiry is checked, and it is checked AFTER the signature so an
  // unsigned value never gets its claimed expiry believed.
  const env = full();
  const past = Date.now() - 1000;
  const { cookie } = await signIn(env);
  const res = await call('/api/customers', {
    headers: { cookie }, env,
  });
  ok_('a fresh session works', res.status !== 401, `got ${res.status}`);

  // Mint one in the past by asking the module directly.
  const { issueSessionCookie } = await import('../../src/lib/auth.js');
  const old = await issueSessionCookie(env, past - 13 * 3600 * 1000);
  const expired = await call('/api/customers', {
    headers: { cookie: old.split(';')[0] }, env,
  });
  check('an expired session -> 401', expired.status, 401);
}
{
  const env = full();
  const { cookie } = await signIn(env);
  const db = env.DB;
  const before = db.calls.length;
  await call('/api/customers', { headers: { cookie: `${SESSION_COOKIE}=forged.1.2` }, env });
  check('a refused request never reaches the database', db.calls.length, before);
}

/* ============================================================
   5. Giving one up
   ============================================================ */
console.log('\n-- 5. signing out --');
{
  const env = full();
  const { cookie } = await signIn(env);
  const res = await call('/api/session', { method: 'DELETE', headers: { cookie }, env });
  check('sign out succeeds', res.status, 204);
  const cleared = res.headers.get('set-cookie');
  ok_('   ...by clearing the cookie', cleared.startsWith(`${SESSION_COOKIE}=;`), cleared);
  ok_('   ...with Max-Age=0, so the browser drops it', cleared.includes('Max-Age=0'), cleared);
  ok_('   ...keeping HttpOnly and Secure, or the clear could be intercepted',
    /HttpOnly/i.test(cleared) && /Secure/i.test(cleared), cleared);
}
{
  const res = await call('/api/session', { method: 'DELETE' });
  check('signing out without a session is not an error', res.status, 204);
  ok_('   ...so it cannot be used to detect whether one existed',
    res.headers.get('set-cookie').startsWith(`${SESSION_COOKIE}=;`), '');
}

/* ============================================================
   6. Configuration
   ============================================================ */
console.log('\n-- 6. what an unconfigured Worker does --');
{
  for (const [why, env] of [
    ['nothing configured', { DB: stubDB() }],
    ['a passphrase but no signing secret', { DB: stubDB(), AUTH_PASSPHRASE: PASSPHRASE }],
    ['a signing secret but no passphrase', { DB: stubDB(), AUTH_SECRET: SECRET }],
    ['blank values', { DB: stubDB(), AUTH_PASSPHRASE: '   ', AUTH_SECRET: '  ' }],
  ]) {
    const read = await call('/api/customers', { env });
    check(`${why}: a READ is refused`, read.status, 503);
    const write = await call('/api/customers', { method: 'POST', body: {}, env });
    check(`${why}: a WRITE is refused`, write.status, 503);
  }
}
{
  const env = { DB: stubDB(), API_TOKEN: TOKEN };
  const res = await call('/api/customers', { headers: { authorization: `Bearer ${TOKEN}` }, env });
  ok_('a machine token alone still works, for CI and the integration suite',
    res.status !== 401 && res.status !== 503, `got ${res.status}`);
  const sess = await call('/api/session', { env });
  check('   ...and the app is told there is no passphrase to offer',
    (await sess.json()).data.passphrase, false);
  const tryLogin = await call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: { passphrase: 'anything' }, env,
  });
  check('   ...and signing in is refused rather than invented', tryLogin.status, 401);
}
{
  const env = full({ API_TOKEN: TOKEN });
  const { cookie } = await signIn(env);
  const byCookie = await call('/api/customers', { headers: { cookie }, env });
  const byToken = await call('/api/customers', { headers: { authorization: `Bearer ${TOKEN}` }, env });
  ok_('with both configured, either credential is accepted',
    byCookie.status === byToken.status && byCookie.status !== 401, `${byCookie.status}/${byToken.status}`);
  const neither = await call('/api/customers', { env });
  check('   ...and neither one means 401', neither.status, 401);
}

/* ============================================================
   7. The source
   ============================================================ */
console.log('\n-- 7. what the source must not contain --');
{
  const src = readFileSync(join(ROOT, 'src/lib/auth.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const routes = readFileSync(join(ROOT, 'src/routes/session.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  // Naming a BINDING in a log is deliberate -- an operator has to know what
  // to set. Logging a VALUE is the thing that must never happen, so that is
  // what is asserted: no interpolation, and no credential-bearing variable
  // passed to a logger.
  const logs = (code + routes).match(/console\.[a-z]+\([\s\S]*?\);/g) || [];
  ok_('every log is a fixed string -- nothing is interpolated into one',
    logs.every((l) => !l.includes('${')), logs.join(' || ').slice(0, 200));
  ok_('   ...and no credential-bearing variable is passed to a logger',
    logs.every((l) => !/\b(config\.(passphrase|secret|token)|supplied|cookie|env\.AUTH_|env\.API_TOKEN)\b/.test(l)),
    logs.join(' || ').slice(0, 200));
  ok_('   ...while still naming the bindings, so the fault is actionable',
    logs.some((l) => /AUTH_PASSPHRASE/.test(l)), 'the operator is told nothing useful');
  ok_('the passphrase has no hard-coded fallback',
    !/AUTH_PASSPHRASE\s*(\|\||\?\?)\s*['"]/.test(code), 'a fallback value was found');
  ok_('   ...and neither does the signing secret',
    !/AUTH_SECRET\s*(\|\||\?\?)\s*['"]/.test(code), 'a fallback value was found');
  ok_('the comparison is constant-time',
    /timingSafeEqual/.test(code), 'no constant-time comparison');
  ok_('   ...with the lengths settled first, because that call throws otherwise',
    code.indexOf('a.length !== b.length') < code.indexOf('timingSafeEqual'), 'order is wrong');
  ok_('no session is stored anywhere — the cookie is signed, not kept',
    !/INSERT INTO sessions|CREATE TABLE|kv\.put|DurableObject/i.test(code + routes), 'session state is kept');
  ok_('the secrets come from the env binding, not a file or a table',
    /env\.AUTH_SECRET/.test(code) && !/readFile|prepare\(/.test(code), code.slice(0, 160));

  const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  for (const name of ['API_TOKEN', 'AUTH_PASSPHRASE', 'AUTH_SECRET']) {
    ok_(`wrangler.jsonc contains no ${name} value`,
      !new RegExp(`${name}\\s*"?\\s*:\\s*"[^"]+"`).test(wrangler), 'a secret is committed');
  }

  const migrations = readFileSync(join(ROOT, 'migrations/0001_initial_schema.sql'), 'utf8');
  ok_('no users, sessions or password table was added to the schema',
    !/CREATE TABLE\s+(IF NOT EXISTS\s+)?(users|sessions|passwords|roles)\b/i.test(migrations),
    'the schema grew an identity table');
}

console.log(`\nSession unit: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
