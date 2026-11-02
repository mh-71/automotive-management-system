/**
 * Roles (0018): reading a role and the one escalation rule every role
 * operation shares.
 *
 * THE RULE: nobody can hand out more than they hold. A caller may create,
 * edit, delete or assign a role only when every permission that role has
 * (before and after the change) is one the caller holds too. The Super Admin
 * role holds everything, so only a full-access caller (Super Admin, or the
 * workshop passphrase / machine token) can assign it or act on its holders.
 */

import { ALL_PERMISSIONS, hasFullAccess, withinCaller } from './permissions.js';

export const ROLE_ID = /^ROL-\d{4,}$/;

/** A role row with its permissions (every permission for the full-access role). */
export async function loadRole(env, id) {
  const row = await env.DB.prepare(
    'SELECT id, name, description, is_system, full_access, status, created_at, updated_at, updated_by FROM roles WHERE id = ?1'
  ).bind(id).first();
  if (!row) return null;
  return withPermissions(env, row);
}

/** A role by id ('ROL-0004') or by name ('Accountant', any case). */
export async function findRole(env, ref) {
  if (typeof ref !== 'string' || !ref.trim()) return null;
  const value = ref.trim();
  if (ROLE_ID.test(value)) return loadRole(env, value);
  const row = await env.DB.prepare('SELECT id FROM roles WHERE name = ?1 COLLATE NOCASE').bind(value).first();
  return row ? loadRole(env, row.id) : null;
}

async function withPermissions(env, row) {
  let permissions;
  if (Number(row.full_access) === 1) permissions = [...ALL_PERMISSIONS];
  else {
    const { results } = await env.DB.prepare('SELECT permission FROM role_permissions WHERE role_id = ?1 ORDER BY permission').bind(row.id).all();
    permissions = (results || []).map((r) => r.permission);
  }
  return { ...row, system: Number(row.is_system) === 1, fullAccess: Number(row.full_access) === 1, permissions };
}

/** May `who` act on (assign, edit, delete, or manage a holder of) this role? */
export function canHandleRole(who, role) {
  if (!role) return false;
  if (role.fullAccess) return hasFullAccess(who);
  return withinCaller(who, role.permissions);
}

/**
 * The active accounts whose active role grants `permission` (Super Admin
 * included), with their role -- for addressing a notification to the people
 * responsible for something (notifications.recipient_account_id), e.g. every
 * account that may approve leave. Not used by any route yet.
 */
export async function accountsWithPermission(env, permission) {
  const { results } = await env.DB.prepare(
    `SELECT a.id AS account_id, a.username, a.role_id, r.name AS role_name, COALESCE(a.mechanic_id, a.staff_id) AS person_id
       FROM user_accounts a JOIN roles r ON r.id = a.role_id
      WHERE a.status = 'Active' AND r.status = 'Active'
        AND (r.full_access = 1 OR EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission = ?1))
      ORDER BY a.id`
  ).bind(permission).all();
  return (results || []).map((r) => ({ accountId: r.account_id, username: r.username, roleId: r.role_id, role: r.role_name, personId: r.person_id }));
}
