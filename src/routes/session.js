/* ============================================================
   routes/session.js — signing in and out
   ------------------------------------------------------------
   Three routes, and they are the only ones besides /api/health
   that an unauthenticated caller may reach. They have to be:
   a browser with no credential cannot ask for one through a
   gate that requires one.

     POST   /api/session   { identifier, password } -> 204 + Set-Cookie
                           identifier = username, e-mail or Staff ID (0019)
                           { username, password }  (the same, older shape)
                           { passphrase }  (the shared workshop passphrase,
                           while a Super Admin has not switched it off)
     DELETE /api/session                   -> 204 + cleared cookie; an account
                           session is ended everywhere (session version + 1)
     GET    /api/session                   -> { authenticated, passphrase, accounts, account? }
     POST   /api/session/password          the signed-in account changes its own
                           password { currentPassword, newPassword } (0019)
     PUT    /api/session/passphrase        { enabled } -- a Super Admin, signed in
                           with their own account, allows or stops the passphrase

   Failed sign-ins are throttled per address and per identifier
   (lib/throttle.js): 429 once over the limit, whatever the reason.

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
import { readJsonBody, nowIso } from '../lib/write.js';
import {
  authConfig, issueSessionCookie, issueAccountSessionCookie, clearSessionCookie, passphraseMatches, currentSession,
} from '../lib/auth.js';
import { checkAccountSignIn, passphraseEnabled, passwordProblem, hashPassword, PASSWORD_MAX } from '../lib/accounts.js';
import { verifyPassword } from '../lib/passwords.js';
import { throttleKeys, isThrottled, recordFailure, clearIdentifier, WINDOW_MINUTES } from '../lib/throttle.js';
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
const tooMany = () => {
  const res = fail('too_many_attempts', `Too many sign-in attempts. Please wait ${WINDOW_MINUTES} minutes and try again.`, 429);
  res.headers.set('retry-after', String(WINDOW_MINUTES * 60));
  return res;
};
const refused = () => fail('unauthorized', 'Authentication required.', 401);

async function createSession(request, env) {
  const config = authConfig(env);
  if (!config.any) {
    console.error('Refusing a sign-in: this Worker has no credential configured.');
    return fail('auth_not_configured', 'This server is not configured for access.', 503);
  }

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  // A staff member's own account: one identifier -- username, e-mail or Staff
  // ID -- and a password. Every failure (no such account, wrong password,
  // inactive, paused after too many tries, ambiguous) is the same 401.
  const identifier = b.identifier !== undefined ? b.identifier : b.username;
  if (identifier !== undefined) {
    if (!config.sessions) return refused();
    const keys = await throttleKeys(request, env, typeof identifier === 'string' ? identifier : '');
    if (await isThrottled(env, keys)) return tooMany();
    const account = await checkAccountSignIn(env, identifier, b.password);
    if (!account) { await recordFailure(env, keys); return refused(); }
    await clearIdentifier(env, keys);
    // A brand-new signed cookie every time: nothing the browser held before
    // (another session's cookie) carries over -- no session fixation.
    return noContent(await issueAccountSessionCookie(env, account));
  }

  // The shared workshop passphrase -- only while it is still allowed. A
  // switched-off passphrase is the same 401 as a wrong one.
  const keys = await throttleKeys(request, env, '');
  if (await isThrottled(env, keys)) return tooMany();
  // Read it without trusting the type: `passphrase: {}` must not reach the
  // comparison as an object.
  const supplied = typeof b.passphrase === 'string' ? b.passphrase : '';
  if (!passphraseMatches(supplied, env) || !(await passphraseEnabled(env))) {
    await recordFailure(env, keys);
    return refused();
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
async function destroySession(request, env) {
  // An account session is ended everywhere, not only in this browser (0019):
  // its version moves on, so every cookie signed for the old one stops working.
  // The passphrase session has no record to end; its cookie is cleared here,
  // and switching the passphrase off ends all of them (lib/auth.js).
  const who = await currentSession(request, env);
  if (who && who.kind === 'account' && env.DB) {
    try {
      await env.DB.prepare('UPDATE user_accounts SET session_version = session_version + 1 WHERE id = ?1').bind(who.id).run();
    } catch (err) {
      console.error('Sign-out could not end the account\'s other sessions:', err && err.message);
    }
  }
  return noContent(clearSessionCookie());
}

/**
 * POST /api/session/password -- the signed-in account sets its own password.
 * Needs the current one (a session left open is not enough to take an account
 * over). Clears "must change password", ends every other session and hands
 * this browser a fresh one.
 */
async function changeOwnPassword(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  const who = await currentSession(request, env);
  if (!who) return refused();
  if (who.kind !== 'account' || !env.DB) return fail('forbidden', 'Only a personal account has its own password.', 403);
  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const { currentPassword, newPassword } = body.value;
  const extra = Object.keys(body.value).filter((k) => k !== 'currentPassword' && k !== 'newPassword');
  if (extra.length) return fail('invalid_body', `Not a field here: ${extra.join(', ')}.`, 400);
  const keys = await throttleKeys(request, env, `password-change:${who.id}`);
  if (await isThrottled(env, keys)) return tooMany();
  const row = await env.DB.prepare('SELECT username, password_hash FROM user_accounts WHERE id = ?1').bind(who.id).first();
  const current = typeof currentPassword === 'string' ? currentPassword.slice(0, PASSWORD_MAX + 1) : '';
  if (!row || !current || !(await verifyPassword(current, row.password_hash))) {
    await recordFailure(env, keys);
    return fail('unprocessable', 'Some fields are not valid.', 422, { fields: { currentPassword: 'That is not your current password.' } });
  }
  const weak = passwordProblem(newPassword, row.username) || (newPassword === current ? 'Choose a password different from the current one.' : null);
  if (weak) return fail('unprocessable', 'Some fields are not valid.', 422, { fields: { newPassword: weak } });
  const hash = await hashPassword(newPassword);
  const now = nowIso();
  const updated = await env.DB.prepare(
    `UPDATE user_accounts
        SET password_hash = ?2, password_changed_at = ?3, updated_at = ?3, password_change_required = 0,
            session_version = session_version + 1, failed_logins = 0, locked_until = NULL
      WHERE id = ?1 AND status = 'Active'
      RETURNING session_version`
  ).bind(who.id, hash, now).first();
  if (!updated) return refused();
  await clearIdentifier(env, keys);
  return noContent(await issueAccountSessionCookie(env, { id: who.id, sessionVersion: Number(updated.session_version) }));
}

/**
 * PUT /api/session/passphrase { enabled } -- allow or stop the shared workshop
 * passphrase. Only a Super Admin signed in with their OWN account may: never
 * the passphrase itself, never the machine token. Switching it off ends every
 * passphrase session at once.
 */
async function setPassphrase(request, env) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  const who = await currentSession(request, env);
  if (!who) return refused();
  if (who.kind !== 'account' || !hasFullAccess(who) || who.passwordChangeRequired) {
    return fail('forbidden', 'Only a Super Admin signed in with their own account can change this.', 403);
  }
  if (!env.DB) return fail('no_database', 'No database.', 503);
  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  if (typeof body.value.enabled !== 'boolean' || Object.keys(body.value).length !== 1) {
    return fail('unprocessable', 'Some fields are not valid.', 422, { fields: { enabled: 'Send { "enabled": true } or { "enabled": false }.' } });
  }
  try {
    await env.DB.prepare(
      `INSERT INTO auth_settings (id, passphrase_enabled, updated_at, updated_by) VALUES (1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET passphrase_enabled = ?1, updated_at = ?2, updated_by = ?3`
    ).bind(body.value.enabled ? 1 : 0, nowIso(), String(who.username || who.id).slice(0, 100)).run();
    return ok({ passphraseEnabled: body.value.enabled });
  } catch (err) {
    console.error('PUT /api/session/passphrase failed:', err && err.message);
    return fail('database_error', 'The setting could not be saved.', 500);
  }
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
      // Whether the shared workshop passphrase may still sign in (0019).
      sharedPassphrase: config.sessions && (await passphraseEnabled(env)),
      // Who is signed in -- only for an account session, and only what is
      // safe to show: id, username, name, Staff ID and role.
      ...(who && who.kind === 'account' ? { account: { id: who.id, username: who.username, name: who.name || '', staffId: who.staffId || null,
        role: who.role, roleId: who.roleId, passwordChangeRequired: who.passwordChangeRequired === true } } : {}),
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
export async function session(request, env, rest = '') {
  if (rest === 'password') return changeOwnPassword(request, env);
  if (rest === 'passphrase') return setPassphrase(request, env);
  if (rest) return fail('not_found', 'No such route.', 404);
  if (request.method === 'GET') return readSession(request, env);
  if (request.method === 'POST') return createSession(request, env);
  if (request.method === 'DELETE') return destroySession(request, env);
  return methodNotAllowed(['GET', 'POST', 'DELETE']);
}
