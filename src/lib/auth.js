/* ============================================================
   auth.js — the gate in front of the whole API
   ------------------------------------------------------------
   One rule, in one place: a request must carry a credential, and
   there are exactly two kinds.

     BROWSER   a signed `taqwa_session` cookie, obtained by
               POSTing to /api/session either the workshop
               passphrase, or a staff member's username and
               password (migration 0009, User Accounts).
     MACHINE   `Authorization: Bearer <API_TOKEN>`, for CI, the
               integration suite, and anything that is not a
               person at a screen.

   Either satisfies the gate, for ANY method. Reads are checked
   exactly as writes are: a customer list is the shop's book of
   names, phone numbers and addresses, and there is no version of
   "public" that is right for it.

   ---- what this deliberately is not ----

   No sessions table, no roles, no JWT library, no OAuth. A
   passphrase session is a signed expiry -- nothing about it is
   stored anywhere, so there is nothing to look up and nothing
   to leak. Rotating AUTH_SECRET invalidates every session at
   once.

   An ACCOUNT session (`a1.<expiry>.<account id>.<session
   version>.<signature>`) names its account, and is checked
   against user_accounts on every request: an account that has
   been deactivated, whose password was reset (session version
   bumped) or whose staff member is no longer active is refused
   at once. That is the per-person revocation the shared
   passphrase cannot give. Every account has full access -- the
   API has no roles to restrict it (see lib/accounts.js).

   The gate records WHO passed it (principalOf), so a route that
   must authorize -- /api/accounts -- can ask.

   ---- fail closed ----

   A Worker with no credential configured at all refuses
   EVERYTHING except /api/health and /api/session. `if (!secret)
   allow` is the shape of bug that ships an open database the
   first time a secret is forgotten, so a missing secret is a
   server configuration error (503) and never a pass.

   ---- what the client is told ----

   Missing, malformed, expired, tampered and simply wrong are all
   one answer: 401, the same message every time. A caller learns
   whether it is authenticated and nothing else -- not whether a
   token exists, not how long one should be, not whether it was
   the cookie or the header that failed. Nothing is logged,
   echoed or returned.
   ============================================================ */

import { fail } from './http.js';
import { loadSessionAccount, passphraseEnabled, ACCOUNT_ID } from './accounts.js';

/** The methods that can change data. Kept exported: routes still ask. */
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The cookie a signed-in browser carries. */
export const SESSION_COOKIE = 'taqwa_session';

/** How long one sign-in lasts. A workshop shift, not a fortnight. */
const SESSION_HOURS = 12;

/** Bumped if the cookie's shape ever changes; an old shape then fails to verify. */
const SESSION_VERSION = 'v1';

/** An account session's shape: a1.<expiry>.<account id>.<session version>.<signature>. */
const ACCOUNT_SESSION = 'a1';

// The scheme is case-insensitive per RFC 7235 and may be followed by more
// than one space; the TOKEN after it is matched exactly, and nothing about it
// is trimmed or normalised.
const BEARER = /^Bearer +(.+)$/i;

/* ---------------------------------------------------------------
   Constant-time comparison
   --------------------------------------------------------------- */

/**
 * Compare two strings without leaking, through timing, how much matched.
 *
 * crypto.subtle.timingSafeEqual is a Workers extension and is present in this
 * runtime -- verified inside workerd, where it also THROWS on inputs of
 * different byte lengths, which is why the lengths are settled first. A
 * length mismatch is decided without it and without returning early on the
 * first differing byte.
 */
function constantTimeEqual(supplied, expected) {
  const encoder = new TextEncoder();
  const a = encoder.encode(supplied);
  const b = encoder.encode(expected);

  if (a.length !== b.length) return false;
  if (a.length === 0) return false;

  if (typeof crypto?.subtle?.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------------------------------------------------------------
   The signed session cookie
   --------------------------------------------------------------- */

/** base64url, so the value needs no cookie escaping. */
function base64url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(payload, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return base64url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * The cookie value: `v1.<expiry seconds>.<signature>`.
 *
 * The expiry is IN the signed payload, so a client that edits it invalidates
 * the signature. Nothing else is carried: there is no user to name, and a
 * cookie that says nothing cannot say anything wrong.
 */
async function mintSession(secret, nowSeconds) {
  const expires = nowSeconds + SESSION_HOURS * 3600;
  const payload = `${SESSION_VERSION}.${expires}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/** An account session: the account and its session version are inside the signature. */
async function mintAccountSession(secret, nowSeconds, accountId, sessionVersion) {
  const expires = nowSeconds + SESSION_HOURS * 3600;
  const payload = `${ACCOUNT_SESSION}.${expires}.${accountId}.${sessionVersion}`;
  return `${payload}.${await sign(payload, secret)}`;
}

/**
 * The account an account session claims, once its shape, signature and expiry
 * check out -- or null. Whether that account may still sign in is the
 * database's answer (loadSessionAccount), asked separately.
 */
async function accountSessionClaim(value, secret, nowSeconds) {
  if (typeof value !== 'string') return null;
  const parts = value.split('.');
  if (parts.length !== 5) return null;
  const [kind, expires, accountId, version, signature] = parts;
  if (kind !== ACCOUNT_SESSION || !/^\d{1,15}$/.test(expires) || !ACCOUNT_ID.test(accountId) || !/^\d{1,9}$/.test(version)) return null;
  const expected = await sign(`${kind}.${expires}.${accountId}.${version}`, secret);
  if (!constantTimeEqual(signature, expected)) return null;
  if (Number(expires) <= nowSeconds) return null;
  return { accountId, sessionVersion: Number(version) };
}

/** Verify shape, then signature, then expiry -- in that order. */
async function sessionIsValid(value, secret, nowSeconds) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [version, expires, signature] = parts;
  if (version !== SESSION_VERSION) return false;
  if (!/^\d{1,15}$/.test(expires)) return false;

  const expected = await sign(`${version}.${expires}`, secret);
  if (!constantTimeEqual(signature, expected)) return false;

  // Signature first, expiry second: an unsigned value never gets as far as
  // having its claimed expiry believed.
  return Number(expires) > nowSeconds;
}

/**
 * Read one cookie out of a Cookie header without trusting its shape.
 *
 * The NAME is trimmed because `a=1; b=2` puts a space before every name after
 * the first, which is the separator's doing rather than the name's. The VALUE
 * is not: a cookie value containing spaces is malformed per RFC 6265, browsers
 * never send one, and accepting `  v1.123.sig  ` as if it were `v1.123.sig`
 * means this parser and any intermediary could disagree about what the cookie
 * says. Nothing is gained by being generous here, so it is not.
 */
function readCookie(request, name) {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    return pair.slice(eq + 1);
  }
  return null;
}

/**
 * Attributes, and why each one.
 *
 *   HttpOnly          script cannot read it, so an XSS cannot steal the session
 *   Secure            never sent over plain HTTP. http://localhost counts as a
 *                     secure context, so development needs no exception
 *   SameSite=Strict   the browser will not attach it to a request another site
 *                     caused, which is what makes CSRF a non-event here
 *   Path=/            the app and the API share an origin, by design
 */
function cookieAttributes(maxAgeSeconds) {
  return `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export async function issueSessionCookie(env, now = Date.now()) {
  const value = await mintSession(env.AUTH_SECRET, Math.floor(now / 1000));
  return `${SESSION_COOKIE}=${value}; ${cookieAttributes(SESSION_HOURS * 3600)}`;
}

/** The cookie for an account that has just signed in. */
export async function issueAccountSessionCookie(env, account, now = Date.now()) {
  const value = await mintAccountSession(env.AUTH_SECRET, Math.floor(now / 1000), account.id, account.sessionVersion);
  return `${SESSION_COOKIE}=${value}; ${cookieAttributes(SESSION_HOURS * 3600)}`;
}

/** The same cookie, already expired: the browser drops it. */
export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

/* ---------------------------------------------------------------
   Configuration
   --------------------------------------------------------------- */

const configured = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * What this Worker is able to accept. Both credentials are optional
 * individually; having neither is what fails closed.
 */
export function authConfig(env) {
  const token = env && configured(env.API_TOKEN) ? env.API_TOKEN.trim() : '';
  // A passphrase without a signing secret cannot mint a session, and a secret
  // without a passphrase can never be reached, so neither counts alone.
  const passphrase = env && configured(env.AUTH_PASSPHRASE) ? env.AUTH_PASSPHRASE.trim() : '';
  const secret = env && configured(env.AUTH_SECRET) ? env.AUTH_SECRET : '';
  const sessions = passphrase !== '' && secret !== '';
  return { token, passphrase, secret, sessions, any: token !== '' || sessions };
}

/* ---------------------------------------------------------------
   Responses
   --------------------------------------------------------------- */

/**
 * 401 — the one answer to every authentication failure.
 *
 * Deliberately identical whether the cookie was absent, expired, tampered
 * with, or the header's token simply did not match: telling those apart
 * would tell a caller something about the secret.
 */
function unauthorized() {
  const res = fail('unauthorized', 'Authentication required.', 401);
  const headers = new Headers(res.headers);
  headers.set('www-authenticate', 'Bearer');
  return new Response(res.body, { status: 401, headers });
}

function notConfigured() {
  // The log names the bindings so an operator can fix it; the response says
  // only that the server is not set up.
  console.error(
    'Refusing every request: this Worker has no credential configured. '
    + 'Set AUTH_PASSPHRASE and AUTH_SECRET, or API_TOKEN.'
  );
  return fail('auth_not_configured', 'This server is not configured for access.', 503);
}

/* ---------------------------------------------------------------
   Who passed the gate
   --------------------------------------------------------------- */

// One entry per authenticated request, dropped with the request.
const principals = new WeakMap();

/**
 * Who this request was authenticated as, once checkAuth has let it through:
 *   { kind: 'token' }                         the machine token
 *   { kind: 'passphrase' }                    a workshop-passphrase session
 *   { kind: 'account', id, username, role }   a staff member's account session
 * null if the request has not passed the gate.
 */
export function principalOf(request) {
  return principals.get(request) || null;
}

/** The principal behind this request's session cookie, or null. */
async function sessionPrincipal(request, env, config, nowSeconds) {
  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  // A passphrase session counts only while the passphrase is still allowed
  // (0019): switching it off ends the sessions it already gave out, too.
  if (await sessionIsValid(cookie, config.secret, nowSeconds)) {
    return (await passphraseEnabled(env)) ? { kind: 'passphrase' } : null;
  }
  const claim = await accountSessionClaim(cookie, config.secret, nowSeconds);
  if (!claim) return null;
  // Offline sync (0020) applies a batch of operations by calling this Worker
  // again, once per operation, inside ONE request. Its environment carries a
  // per-request memo, so the account is read from the database once per
  // request instead of once per internal call (D1 limits queries per
  // invocation). The cookie's signature and expiry are still checked above on
  // every call; only the database read is reused, and only within the request.
  const memo = env && env.__principalMemo;
  const key = `${claim.accountId}.${claim.sessionVersion}`;
  if (memo && memo.has(key)) return memo.get(key);
  const who = await loadSessionAccount(env, claim.accountId, claim.sessionVersion);
  if (memo) memo.set(key, who);
  return who;
}

/* ---------------------------------------------------------------
   The gate
   --------------------------------------------------------------- */

/**
 * Check a request's credentials.
 *
 * Returns a Response to REFUSE the request, or null to let it through. A
 * caller that gets null has been authenticated; a caller that gets a Response
 * must return it without touching the database.
 *
 * Every method is checked, reads included. The two public routes --
 * /api/health and /api/session -- are dispatched before this is reached,
 * because one is how an operator sees the Worker is up and the other is how
 * a browser gets a credential in the first place.
 */
export async function checkAuth(request, env, now = Date.now()) {
  const config = authConfig(env);
  if (!config.any) return notConfigured();

  if (config.token !== '') {
    const header = request.headers.get('authorization');
    const match = header ? BEARER.exec(header) : null;
    if (match && constantTimeEqual(match[1], config.token)) {
      principals.set(request, { kind: 'token' });
      return null;
    }
  }

  if (config.sessions) {
    const who = await sessionPrincipal(request, env, config, Math.floor(now / 1000));
    if (who) {
      principals.set(request, who);
      return null;
    }
  }

  return unauthorized();
}

/** Is this the workshop's passphrase? Used only by POST /api/session. */
export function passphraseMatches(supplied, env) {
  const config = authConfig(env);
  if (!config.sessions) return false;
  if (typeof supplied !== 'string' || supplied === '') return false;
  return constantTimeEqual(supplied, config.passphrase);
}

/** Does this request already carry a valid session? Used by GET /api/session. */
export async function hasValidSession(request, env, now = Date.now()) {
  return (await currentSession(request, env, now)) !== null;
}

/** The session this request carries (passphrase or account), or null. Used by GET /api/session. */
export async function currentSession(request, env, now = Date.now()) {
  const config = authConfig(env);
  if (!config.sessions) return null;
  return sessionPrincipal(request, env, config, Math.floor(now / 1000));
}
