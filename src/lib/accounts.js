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
/** A Staff ID: the person an account belongs to, MEC-0001 (mechanic) or STF-0001 (other staff). */
export const STAFF_ID = /^(MEC|STF)-\d{4,}$/;
/** A login e-mail: lower case, one @, a dot after it, no spaces, at most 160. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An e-mail as stored and compared: trimmed and lower case, or null if it is not one. */
export function normaliseEmail(value) {
  if (typeof value !== 'string') return null;
  const e = value.trim().toLowerCase();
  return e.length >= 6 && e.length <= 160 && EMAIL.test(e) ? e : null;
}

/**
 * What a sign-in identifier is. One field takes all three:
 *   contains '@'           -> an e-mail address
 *   MEC-0001 / STF-0001    -> a Staff ID (any case)
 *   anything else          -> a username (any case)
 * Returns { kind, value } with the value normalised, or null for nothing usable.
 */
export function classifyIdentifier(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > 160) return null;
  if (v.includes('@')) { const e = normaliseEmail(v); return e ? { kind: 'email', value: e } : null; }
  if (STAFF_ID.test(v.toUpperCase())) return { kind: 'staffId', value: v.toUpperCase() };
  const u = normaliseUsername(v);
  return u ? { kind: 'username', value: u } : null;
}

/** A username may not look like a Staff ID or an e-mail, so no sign-in identifier can mean two accounts. */
export const usernameLooksLikeOtherIdentifier = (u) => STAFF_ID.test(String(u || '').toUpperCase());

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
         a.role_id, a.email, a.mechanic_id, a.staff_id, a.password_change_required, r.name AS role_name, r.status AS role_status, r.full_access AS role_full_access,
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
    return { kind: 'account', id: row.id, username: row.username, name: row.person_name,
      staffId: row.mechanic_id || row.staff_id || null,
      passwordChangeRequired: Number(row.password_change_required) === 1, ...(await roleGrant(env, row)) };
  } catch (err) {
    console.error('Account session check failed:', err && err.message);
    return null;
  }
}

/**
 * Another account's CURRENT standing, for a decision taken on its behalf (an
 * administrator resolving that person's offline change, 0020): whether it may
 * still sign in, and what its role allows now. null if there is no such account.
 */
export async function accountStanding(env, accountId) {
  if (!env || !env.DB || !ACCOUNT_ID.test(String(accountId || ''))) return null;
  const row = await env.DB.prepare(`${PERSON_SQL} WHERE a.id = ?1`).bind(accountId).first();
  if (!row) return null;
  return { kind: 'account', id: row.id, username: row.username, active: row.status === 'Active' && row.person_status === 'Active', ...(await roleGrant(env, row)) };
}

/**
 * The one account a sign-in identifier names, or null. A Staff ID is also a
 * valid username shape (e.g. "stf-0002"); new usernames may not look like one,
 * and if an old one does and the two point at DIFFERENT accounts, the answer is
 * null -- an identifier must never be able to mean two people.
 */
async function findSignInAccount(env, id) {
  if (id.kind === 'email') return env.DB.prepare(`${PERSON_SQL} WHERE a.email = ?1`).bind(id.value).first();
  if (id.kind === 'username') return env.DB.prepare(`${PERSON_SQL} WHERE a.username = ?1`).bind(id.value).first();
  const { results } = await env.DB.prepare(
    `${PERSON_SQL} WHERE a.mechanic_id = ?1 OR a.staff_id = ?1 OR a.username = ?2`
  ).bind(id.value, id.value.toLowerCase()).all();
  const rows = results || [];
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Check an identifier (username, e-mail or Staff ID) and password. Resolves to
 * the account to sign in, or null.
 *
 * Every "no" costs the same work (an unknown identifier is checked against a
 * decoy hash), and every "no" looks the same to the caller: the route answers
 * them all with one 401. Wrong passwords are counted; the fifth in a row pauses
 * the account's sign-in for LOCK_MINUTES. A correct password resets the count
 * and records the sign-in.
 */
export async function checkAccountSignIn(env, rawIdentifier, password, now = new Date()) {
  const id = classifyIdentifier(rawIdentifier);
  const supplied = typeof password === 'string' ? password.slice(0, PASSWORD_MAX + 1) : '';
  if (!env || !env.DB || !id || supplied === '') {
    await verifyPassword('decoy', DECOY_HASH);
    return null;
  }
  let row;
  try {
    row = await findSignInAccount(env, id);
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
  return { id: row.id, sessionVersion: Number(row.session_version), passwordChangeRequired: Number(row.password_change_required) === 1 };
}

/**
 * May the shared workshop passphrase still sign in (0019 auth_settings)?
 * Before the migration the table does not exist: that is today's behaviour,
 * so the answer is yes.
 */
export async function passphraseEnabled(env) {
  if (!env || !env.DB || typeof env.DB.prepare !== 'function') return true;
  try {
    const row = await env.DB.prepare('SELECT passphrase_enabled FROM auth_settings WHERE id = 1').first();
    // Only an explicit 0 switches it off (the column holds 0 or 1).
    return !row || Number(row.passphrase_enabled) !== 0;
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return true;
    console.error('Passphrase setting could not be read:', err && err.message);
    return false;
  }
}
