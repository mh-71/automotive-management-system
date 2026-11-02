/* ============================================================
   routes/session.js — signing in and out
   ------------------------------------------------------------
   Three routes, and they are the only ones besides /api/health
   that an unauthenticated caller may reach. They have to be:
   a browser with no credential cannot ask for one through a
   gate that requires one.

     POST   /api/session   { passphrase }  -> 204 + Set-Cookie
                           { username, password }  (a staff member's account)
     DELETE /api/session                   -> 204 + cleared cookie
     GET    /api/session                   -> { authenticated, passphrase, accounts, account? }

   Being public is exactly why each is written to give nothing
   away. The POST answers a wrong passphrase with the same 401
   the rest of the API uses, after a constant-time comparison,
   and never says whether a passphrase is configured at all.
   The GET reports a boolean -- and, for an account session only,
   that account's own id, username and role, so the app can say who
   is signed in. A passphrase session has no who. A wrong username
   and a wrong password are one and the same 401.
   ============================================================ */

import { ok, fail, methodNotAllowed, SECURITY_HEADERS } from '../lib/http.js';
import { readJsonBody } from '../lib/write.js';
import {
  authConfig, issueSessionCookie, issueAccountSessionCookie, clearSessionCookie, passphraseMatches, currentSession,
} from '../lib/auth.js';
import { checkAccountSignIn } from '../lib/accounts.js';
import { hasFullAccess, permissionsOf } from '../lib/permissions.js';

/** 204: there is nothing to say, and a body would only be a place to leak. */
function noContent(cookie) {
  // The same headers every other API response carries. A Set-Cookie on a
  // cacheable response is the classic way one person's session ends up handed
  // to the next, so no-store matters most here of anywhere.
  const headers = { ...SECURITY_HEADERS };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 204, headers });
}

/**
 * POST /api/session — exchange the workshop passphrase for a session.
 *
 * The 401 here is the same one the gate gives, so a caller cannot tell "the
 * passphrase was wrong" from "this server has no passphrase". Sessions being
 * unconfigured is still reported as a 503, because that is a server fault an
 * operator has to see -- but only when there is NO credential of any kind, so
 * that a machine-token-only deployment does not advertise the difference.
 */
async function createSession(request, env) {
  const config = authConfig(env);
  if (!config.any) {
    console.error('Refusing a sign-in: this Worker has no credential configured.');
    return fail('auth_not_configured', 'This server is not configured for access.', 503);
  }

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);

  // A staff member's account: username + password. Every failure -- no such
  // user, wrong password, inactive, paused after too many tries -- is the same
  // 401 as a wrong passphrase.
  if (body.value && typeof body.value === 'object' && body.value.username !== undefined) {
    if (!config.sessions) return fail('unauthorized', 'Authentication required.', 401);
    const account = await checkAccountSignIn(env, body.value.username, body.value.password);
    if (!account) return fail('unauthorized', 'Authentication required.', 401);
    return noContent(await issueAccountSessionCookie(env, account));
  }

  // Read it without trusting the type: `passphrase: {}` must not reach the
  // comparison as an object.
  const supplied = typeof body.value.passphrase === 'string' ? body.value.passphrase : '';
  if (!passphraseMatches(supplied, env)) {
    return fail('unauthorized', 'Authentication required.', 401);
  }
  return noContent(await issueSessionCookie(env));
}

/**
 * DELETE /api/session — sign out.
 *
 * Unconditional, and deliberately so: clearing a cookie nobody holds is
 * harmless, and refusing to sign out an already-expired session would be a
 * way of confirming that the session had expired.
 *
 * This ends the session in THIS browser. It cannot end one held elsewhere --
 * the cookie is signed rather than stored, so there is no record to revoke.
 * Rotating AUTH_SECRET is what invalidates every session at once.
 */
function destroySession() {
  return noContent(clearSessionCookie());
}

/**
 * GET /api/session — "am I signed in?"
 *
 * Public so the app can ask before it has a credential, and so asking never
 * produces the 401 that would otherwise be the only way to find out.
 */
async function readSession(request, env) {
  const config = authConfig(env);
  const who = await currentSession(request, env);
  return ok(
    {
      authenticated: who !== null,
      // Whether signing in is even possible here. A deployment with only a
      // machine token has no login form to offer, and the app needs to know
      // that without guessing from a failure.
      passphrase: config.sessions,
      // Whether a staff member may sign in with their own account here.
      accounts: config.sessions && Boolean(env && env.DB),
      // Who is signed in -- only for an account session, and only the
      // account's own id, username and role.
      ...(who && who.kind === 'account' ? { account: { id: who.id, username: who.username, role: who.role, roleId: who.roleId } } : {}),
      // What the signed-in caller may do (0018), so the app can show only
      // what will work. For display only: the server checks every request
      // itself and never reads this back.
      ...(who ? { fullAccess: hasFullAccess(who), permissions: permissionsOf(who) } : {}),
    },
    {},
    200
  );
}

/** The router hands every /api/session request here. */
export async function session(request, env) {
  if (request.method === 'GET') return readSession(request, env);
  if (request.method === 'POST') return createSession(request, env);
  if (request.method === 'DELETE') return destroySession();
  return methodNotAllowed(['GET', 'POST', 'DELETE']);
}
