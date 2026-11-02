/* ============================================================
   accounts.js — the rules every account path shares
   ------------------------------------------------------------
   Used by the auth gate (is this account session still good?), by
   POST /api/session (signing in with a username and password) and by
   the /api/accounts routes (managing accounts).

   Roles (0018): an account's role is user_accounts.role_id, and its
   permissions are that role's rows in role_permissions. Both are read
   here, from the database, every time the gate checks a session -- a
   change of role or of a role's permissions applies on the next
   request. An account with no role, or an inactive one, has no
   permissions at all (lib/permissions.js).
   ============================================================ */

import { hashPassword, verifyPassword, DECOY_HASH } from './passwords.js';

export const ACCOUNT_STATUSES = ['Active', 'Inactive'];
export const USERNAME = /^[a-z0-9._-]{3,32}$/;
export const ACCOUNT_ID = /^USR-\d{4,}$/;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** After this many wrong passwords in a row, the account cannot sign in for LOCK_MINUTES. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

/** The sign-in name as stored: trimmed and lower case. Null if it is not a valid one. */
export function normaliseUsername(value) {
  if (typeof value !== 'string') return null;
  const u = value.trim().toLowerCase();
  return USERNAME.test(u) ? u : null;
}

/** Why a new password is not acceptable, or null. Never echoes the password. */
export function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password === '') return 'A password is required.';
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password.trim() !== password) return 'The password cannot start or end with a space.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'The password cannot contain the username.';
  return null;
}

export { hashPassword };

// The person behind an account: a mechanic or another employee, and whether they are still active.
const PERSON_SQL = `
  SELECT a.id, a.username, a.role, a.status, a.session_version, a.password_hash, a.failed_logins, a.locked_until,
         a.role_id, r.name AS role_name, r.status AS role_status, r.full_access AS role_full_access,
         COALESCE(m.name, s.name) AS person_name,
         COALESCE(m.status, s.status) AS person_status
    FROM user_accounts a
    LEFT JOIN roles r ON r.id = a.role_id
    LEFT JOIN mechanics m ON m.id = a.mechanic_id
    LEFT JOIN staff s ON s.id = a.staff_id`;

/**
 * What an account may do, from its role row: full access for the system role,
 * the role's permission rows otherwise, nothing for a missing or inactive role.
 */
export async function roleGrant(env, row) {
  const active = !!row.role_id && row.role_status === 'Active';
  const fullAccess = active && Number(row.role_full_access) === 1;
  let permissions = new Set();
  if (active && !fullAccess) {
    const { results } = await env.DB.prepare('SELECT permission FROM role_permissions WHERE role_id = ?1').bind(row.role_id).all();
    permissions = new Set((results || []).map((p) => p.permission));
  }
  return { roleId: row.role_id || null, role: row.role_name || null, roleActive: active, fullAccess, permissions };
}

/**
 * The account behind a signed account session, if it may still be used:
 * active, the same session version the cookie was signed with, and its
 * person still an active member of staff. Anything else -- including a
 * database that does not have the table yet -- is "no".
 */
export async function loadSessionAccount(env, accountId, sessionVersion) {
  if (!env || !env.DB || !ACCOUNT_ID.test(accountId)) return null;
  try {
    const row = await env.DB.prepare(`${PERSON_SQL} WHERE a.id = ?1`).bind(accountId).first();
    if (!row || row.status !== 'Active' || row.person_status !== 'Active') return null;
    if (Number(row.session_version) !== Number(sessionVersion)) return null;
    return { kind: 'account', id: row.id, username: row.username, name: row.person_name, ...(await roleGrant(env, row)) };
  } catch (err) {
    console.error('Account session check failed:', err && err.message);
    return null;
  }
}

/**
 * Check a username and password. Resolves to the account to sign in, or null.
 *
 * Every "no" costs the same work (an unknown name is checked against a decoy
 * hash), and every "no" looks the same to the caller: the route answers them
 * all with one 401. Wrong passwords are counted; the fifth in a row pauses the
 * account's sign-in for LOCK_MINUTES. A correct password resets the count and
 * records the sign-in.
 */
export async function checkAccountSignIn(env, rawUsername, password, now = new Date()) {
  const username = normaliseUsername(rawUsername);
  const supplied = typeof password === 'string' ? password.slice(0, PASSWORD_MAX + 1) : '';
  if (!env || !env.DB || !username || supplied === '') {
    await verifyPassword('decoy', DECOY_HASH);
    return null;
  }
  let row;
  try {
    row = await env.DB.prepare(`${PERSON_SQL} WHERE a.username = ?1`).bind(username).first();
  } catch (err) {
    console.error('Account sign-in lookup failed:', err && err.message);
    return null;
  }
  if (!row) {
    await verifyPassword(supplied, DECOY_HASH);
    return null;
  }
  const locked = row.locked_until && row.locked_until > now.toISOString();
  const matches = await verifyPassword(supplied, row.password_hash);
  if (locked) return null;
  if (!matches) {
    const until = new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString();
    await env.DB.prepare(
      `UPDATE user_accounts
          SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= ?2 THEN ?3 ELSE locked_until END
        WHERE id = ?1`
    ).bind(row.id, MAX_FAILED_LOGINS, until).run();
    return null;
  }
  if (row.status !== 'Active' || row.person_status !== 'Active') return null;
  await env.DB.prepare(
    'UPDATE user_accounts SET failed_logins = 0, locked_until = NULL, last_login_at = ?2 WHERE id = ?1'
  ).bind(row.id, now.toISOString()).run();
  return { id: row.id, sessionVersion: Number(row.session_version) };
}
