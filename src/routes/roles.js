/**
 * Roles & Permissions API (0018). Behind the auth gate; the router checks
 * the route's permission (roles.view / create / edit / delete) before any of
 * this runs, and these handlers add the rules a permission alone cannot say.
 *
 *   GET    /api/roles             every role, its permissions and how many accounts hold it,
 *                                 plus the permission catalog       ?q= ?status=Active|Inactive
 *   GET    /api/roles/:id         one role, with the accounts that hold it
 *   POST   /api/roles             { name, description?, permissions[] }
 *   PUT    /api/roles/:id         { expectedUpdatedAt, name?, description?, status?, permissions? }
 *   DELETE /api/roles/:id         only a role no account holds
 *
 * RULES (all checked here, on the server)
 *   - Super Admin (the system role) cannot be renamed, switched off, deleted
 *     or have its permissions changed -- by anyone.
 *   - Nobody hands out more than they hold: the role's permissions, before
 *     and after the change, must all be the caller's own (lib/roles.js).
 *   - Nobody edits, switches off or deletes the role they hold themselves.
 *   - A role that accounts hold cannot be switched off or deleted; move the
 *     accounts to another role first. The check and the change are one
 *     statement, so a concurrent assignment cannot slip between them.
 *   - Only permissions in the catalog are accepted; anything else is 422.
 *   - An edit names the version it was made from (expectedUpdatedAt); a
 *     stale one is 409 and changes nothing.
 */

import { ok, fail, methodNotAllowed, noDatabase, conflict, unprocessable } from '../lib/http.js';
import { readJsonBody, nowIso, allocateId } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { CATALOG, ACTIONS, isPermission, withinCaller } from '../lib/permissions.js';
import { ROLE_ID, loadRole, canHandleRole } from '../lib/roles.js';

const CREATE_KEYS = ['name', 'description', 'permissions'];
const UPDATE_KEYS = ['name', 'description', 'status', 'permissions', 'expectedUpdatedAt'];
const STATUSES = ['Active', 'Inactive'];
const NAME_MAX = 40;
const DESCRIPTION_MAX = 300;

function actorName(who) {
  if (!who) return null;
  if (who.kind === 'account') return String(who.username || who.id).slice(0, 100);
  return who.kind === 'passphrase' ? 'Workshop passphrase' : 'API token';
}

function toRole(r, counts = {}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    system: r.system,
    fullAccess: r.fullAccess,
    status: r.status,
    permissions: r.permissions,
    accounts: counts.total ?? 0,
    activeAccounts: counts.active ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by ?? '',
  };
}

const unknownKeys = (body, allowed) => Object.fromEntries(Object.keys(body).filter((k) => !allowed.includes(k)).map((k) => [k, 'This is not a role field.']));
const roleFieldsInvalid = (fields) => unprocessable('Some role fields are not valid.', fields);
const forbidden = (message) => fail('forbidden', message, 403);

/** Name, description and permissions from a body; only what is present is checked. */
function readFields(body, errors, { requireName }) {
  const out = {};
  if (body.name !== undefined || requireName) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length < 2 || name.length > NAME_MAX) errors.name = `Use 2-${NAME_MAX} characters.`;
    else out.name = name;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') errors.description = 'Must be text.';
    else {
      const d = (body.description || '').trim();
      if (d.length > DESCRIPTION_MAX) errors.description = `Use ${DESCRIPTION_MAX} characters or fewer.`;
      else out.description = d || null;
    }
  }
  if (body.permissions !== undefined || requireName) {
    if (!Array.isArray(body.permissions)) errors.permissions = 'Choose the role\'s permissions (a list).';
    else {
      const bad = body.permissions.filter((p) => !isPermission(p));
      if (bad.length) errors.permissions = `Not a permission: ${bad.slice(0, 5).map(String).join(', ')}.`;
      else out.permissions = [...new Set(body.permissions)].sort();
    }
  }
  return out;
}

async function counts(env, id) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS total, coalesce(sum(CASE WHEN status = 'Active' THEN 1 ELSE 0 END), 0) AS active
       FROM user_accounts WHERE role_id = ?1`
  ).bind(id).first();
  return { total: row ? row.total : 0, active: row ? row.active : 0 };
}

/** The statements that replace a role's permissions, each guarded on the role still having `stamp`. */
function replacePermissions(env, id, permissions, stamp) {
  const guard = 'EXISTS (SELECT 1 FROM roles WHERE id = ?1 AND updated_at = ?2)';
  return [
    env.DB.prepare(`DELETE FROM role_permissions WHERE role_id = ?1 AND ${guard}`).bind(id, stamp),
    ...permissions.map((p) => env.DB.prepare(
      `INSERT INTO role_permissions (role_id, permission) SELECT ?1, ?3 WHERE ${guard}`
    ).bind(id, stamp, p)),
  ];
}

const nameTaken = () => conflict('Another role already has that name.', { field: 'name', fields: { name: 'Another role already has that name.' } });

/* ---------- GET ---------- */

export async function listRoles(request, env, url) {
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 100) return fail('invalid_parameter', '`q` must be 100 characters or fewer.', 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !STATUSES.includes(status)) return fail('invalid_parameter', '`status` must be Active or Inactive.', 400);
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  try {
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.name, r.description, r.is_system, r.full_access, r.status, r.created_at, r.updated_at, r.updated_by,
              (SELECT count(*) FROM user_accounts a WHERE a.role_id = r.id) AS total,
              (SELECT count(*) FROM user_accounts a WHERE a.role_id = r.id AND a.status = 'Active') AS active
         FROM roles r
        WHERE (?1 IS NULL OR r.status = ?1)
          AND (?2 IS NULL OR lower(r.name) LIKE ?2 ESCAPE '\\' OR lower(coalesce(r.description, '')) LIKE ?2 ESCAPE '\\')
        ORDER BY r.is_system DESC, r.id`
    ).bind(status, needle).all();
    const { results: grants } = await env.DB.prepare('SELECT role_id, permission FROM role_permissions ORDER BY permission').all();
    const byRole = new Map();
    for (const g of grants || []) {
      if (!byRole.has(g.role_id)) byRole.set(g.role_id, []);
      byRole.get(g.role_id).push(g.permission);
    }
    const all = CATALOG.flatMap((m) => Object.keys(m.actions).map((a) => `${m.key}.${a}`));
    const roles = (results || []).map((r) => {
      const full = Number(r.full_access) === 1;
      const role = { ...r, system: Number(r.is_system) === 1, fullAccess: full, permissions: full ? all : (byRole.get(r.id) || []) };
      return { ...toRole(role, { total: r.total, active: r.active }), canManage: canHandleRole(who, role) };
    });
    return ok(roles, { count: roles.length, total: roles.length, catalog: CATALOG, actions: ACTIONS });
  } catch (err) {
    console.error('GET /api/roles failed:', err && err.message);
    return fail('database_error', 'Could not read the roles.', 500);
  }
}

export async function getRole(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  if (!env.DB) return noDatabase();
  if (!ROLE_ID.test(rawId)) return fail('invalid_id', 'That is not a role id.', 400);
  try {
    const role = await loadRole(env, rawId);
    if (!role) return fail('not_found', 'No role with that id.', 404);
    const { results } = await env.DB.prepare(
      `SELECT a.id, a.username, a.status, COALESCE(m.name, s.name) AS person_name
         FROM user_accounts a
         LEFT JOIN mechanics m ON m.id = a.mechanic_id
         LEFT JOIN staff s ON s.id = a.staff_id
        WHERE a.role_id = ?1 ORDER BY a.username`
    ).bind(role.id).all();
    const holders = (results || []).map((a) => ({ id: a.id, username: a.username, status: a.status, staffName: a.person_name ?? '' }));
    const c = { total: holders.length, active: holders.filter((h) => h.status === 'Active').length };
    return ok({ ...toRole(role, c), holders, canManage: canHandleRole(principalOf(request), role) });
  } catch (err) {
    console.error('GET /api/roles/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the role.', 500);
  }
}

/* ---------- POST ---------- */

export async function createRole(request, env) {
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, CREATE_KEYS);
  const fields = readFields(body, errors, { requireName: true });
  if (Object.keys(errors).length) return roleFieldsInvalid(errors);
  if (!withinCaller(who, fields.permissions)) {
    return forbidden('You can only give a role permissions that your own role has.');
  }
  try {
    const clash = await env.DB.prepare('SELECT id FROM roles WHERE name = ?1 COLLATE NOCASE').bind(fields.name).first();
    if (clash) return nameTaken();
    const allocated = await allocateId(env, 'roles');
    if (allocated.error) {
      console.error('POST /api/roles could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the role.', 500);
    }
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO roles (id, name, description, is_system, full_access, status, created_at, updated_at, updated_by)
         VALUES (?1, ?2, ?3, 0, 0, 'Active', ?4, ?4, ?5)`
      ).bind(allocated.id, fields.name, fields.description ?? null, now, actorName(who)),
      ...replacePermissions(env, allocated.id, fields.permissions, now),
    ]);
    const role = await loadRole(env, allocated.id);
    return ok({ ...toRole(role), holders: [], canManage: true }, {}, 201);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err && err.message))) return nameTaken();
    console.error('POST /api/roles failed:', err && err.message);
    return fail('database_error', 'Could not create the role.', 500);
  }
}

/* ---------- PUT ---------- */

export async function updateRole(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!ROLE_ID.test(rawId)) return fail('invalid_id', 'That is not a role id.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, UPDATE_KEYS);
  const fields = readFields(body, errors, { requireName: false });
  if (body.status !== undefined && !STATUSES.includes(body.status)) errors.status = 'Choose Active or Inactive.';
  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
    errors.expectedUpdatedAt = 'Send the updatedAt of the role you edited.';
  }
  if (!Object.keys(errors).length && ['name', 'description', 'status', 'permissions'].every((k) => body[k] === undefined)) {
    errors.name = 'Nothing to change.';
  }
  if (Object.keys(errors).length) return roleFieldsInvalid(errors);

  try {
    const role = await loadRole(env, rawId);
    if (!role) return fail('not_found', 'No role with that id.', 404);
    if (role.system) return forbidden('Super Admin is the protected system role. It cannot be changed.');
    if (who && who.kind === 'account' && who.roleId === role.id) {
      return forbidden('You cannot change the role you hold. Ask someone with another role to change it.');
    }
    if (!canHandleRole(who, role)) return forbidden('This role has permissions your own role does not. You cannot change it.');
    if (fields.permissions && !withinCaller(who, fields.permissions)) {
      return forbidden('You can only give a role permissions that your own role has.');
    }
    if (body.expectedUpdatedAt !== role.updated_at) {
      return conflict('This role was changed by someone else after you opened it. Reload it and try again.', {
        reason: 'concurrent_modification', current: role.updated_at,
      });
    }
    if (fields.name && fields.name.toLowerCase() !== role.name.toLowerCase()) {
      const clash = await env.DB.prepare('SELECT id FROM roles WHERE name = ?1 COLLATE NOCASE AND id <> ?2').bind(fields.name, role.id).first();
      if (clash) return nameTaken();
    }
    const status = body.status ?? role.status;
    const deactivating = role.status === 'Active' && status === 'Inactive';
    const now = nowIso();
    const name = fields.name ?? role.name;
    const statements = [
      // Switching a role off only while no account holds it -- checked in the same statement.
      env.DB.prepare(
        `UPDATE roles SET name = ?3, description = ?4, status = ?5, updated_at = ?6, updated_by = ?7
          WHERE id = ?1 AND updated_at = ?2 AND is_system = 0
            AND (?8 = 0 OR NOT EXISTS (SELECT 1 FROM user_accounts WHERE role_id = ?1))`
      ).bind(role.id, role.updated_at, name, fields.description !== undefined ? fields.description : role.description,
        status, now, actorName(who), deactivating ? 1 : 0),
      ...(fields.permissions ? replacePermissions(env, role.id, fields.permissions, now) : []),
      // The legacy text column follows the name, for the accounts that hold the role.
      ...(name !== role.name ? [env.DB.prepare(
        'UPDATE user_accounts SET role = ?2 WHERE role_id = ?1 AND EXISTS (SELECT 1 FROM roles WHERE id = ?1 AND updated_at = ?3)'
      ).bind(role.id, name, now)] : []),
    ];
    const results = await env.DB.batch(statements);
    if (!results[0].meta || results[0].meta.changes !== 1) {
      const held = await counts(env, role.id);
      if (deactivating && held.total > 0) {
        return conflict(`${held.total} account${held.total === 1 ? ' holds' : 's hold'} this role. Move ${held.total === 1 ? 'it' : 'them'} to another role before switching it off.`, {
          reason: 'role_in_use', accounts: held.total, field: 'status', fields: { status: 'Accounts still hold this role.' },
        });
      }
      return conflict('This role was changed by someone else after you opened it. Reload it and try again.', { reason: 'concurrent_modification' });
    }
    const after = await loadRole(env, role.id);
    return ok({ ...toRole(after, await counts(env, role.id)), canManage: canHandleRole(who, after) });
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err && err.message))) return nameTaken();
    console.error('PUT /api/roles/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the role.', 500);
  }
}

/* ---------- DELETE ---------- */

export async function deleteRole(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!ROLE_ID.test(rawId)) return fail('invalid_id', 'That is not a role id.', 400);
  try {
    const role = await loadRole(env, rawId);
    if (!role) return fail('not_found', 'No role with that id.', 404);
    if (role.system) return forbidden('Super Admin is the protected system role. It cannot be deleted.');
    if (who && who.kind === 'account' && who.roleId === role.id) return forbidden('You cannot delete the role you hold.');
    if (!canHandleRole(who, role)) return forbidden('This role has permissions your own role does not. You cannot delete it.');
    // Only while no account holds it -- checked in the same statement as the delete.
    const res = await env.DB.prepare(
      'DELETE FROM roles WHERE id = ?1 AND is_system = 0 AND NOT EXISTS (SELECT 1 FROM user_accounts WHERE role_id = ?1)'
    ).bind(role.id).run();
    if (!res.meta || res.meta.changes !== 1) {
      const held = await counts(env, role.id);
      return conflict(`${held.total} account${held.total === 1 ? ' holds' : 's hold'} this role. Move ${held.total === 1 ? 'it' : 'them'} to another role before deleting it.`, {
        reason: 'role_in_use', accounts: held.total,
      });
    }
    return ok({ id: role.id, deleted: true });
  } catch (err) {
    console.error('DELETE /api/roles/:id failed:', err && err.message);
    return fail('database_error', 'Could not delete the role.', 500);
  }
}
