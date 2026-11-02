/* ============================================================
   routes/accounts.js — Staff Management › User Accounts
   ------------------------------------------------------------
     GET    /api/accounts                 list (q, status, role, limit, offset)
     GET    /api/accounts/:id             one account
     POST   /api/accounts                 { staffId, username, role, password }
     PUT    /api/accounts/:id             { status } and/or { role }
     POST   /api/accounts/:id/password    { password }  -- set a new password
     (no DELETE: an account is deactivated, never deleted)

   An account is a sign-in for ONE existing staff member -- a mechanic
   (MEC-0001) or any other employee (STF-0001) -- linked by foreign key
   and copying nothing about the person (migration 0009).

   WHO MAY CALL (0018): a caller whose role has the User Accounts
   permission for the route (users.view / create / edit / manage) -- the
   router checks it before this runs -- and, to choose an account's role,
   Roles: assign (roles.manage). On top of that, this file enforces:
     * Nobody can give an account a role with permissions they do not hold
       themselves, and only a full-access caller can give Super Admin.
     * Nobody can switch off, reset, or change the role of an account whose
       role holds permissions they do not (no acting on someone above you).

   WHAT NEVER LEAVES: password hashes, session versions, failed-attempt
   counts. A record says only whether the account is temporarily locked.

   SAFETY RULES
     * One account per staff member; usernames unique ignoring case.
     * Only an ACTIVE staff member can have an account created or
       re-activated; an account whose staff member becomes inactive can no
       longer sign in (the gate checks on every request).
     * Nobody can deactivate their own account or change their own role.
     * An account session cannot deactivate, or move off Super Admin, the
       last active Super Admin account. (The workshop passphrase still signs
       in, so its holder may -- nobody can be locked out.) The check and the
       change are one statement, so two requests at once cannot both pass it.
     * Deactivating an account or setting a new password ends that
       account's sessions everywhere (session_version + 1).
     * Password reset by e-mail does not exist: there is no e-mail
       delivery. An administrator sets a new password instead.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, conflict, unprocessable,
} from '../lib/http.js';
import { readJsonBody, nowIso, allocateId, constraintFailure } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import {
  ACCOUNT_STATUSES, ACCOUNT_ID, normaliseUsername, passwordProblem, hashPassword, normaliseEmail, usernameLooksLikeOtherIdentifier,
} from '../lib/accounts.js';
import { can } from '../lib/permissions.js';
import { findRole, loadRole, canHandleRole } from '../lib/roles.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;
const PERSON_ID = /^(MEC|STF)-\d{4,}$/;

const CREATE_KEYS = ['staffId', 'username', 'role', 'roleId', 'password', 'email', 'mobile'];
const UPDATE_KEYS = ['status', 'role', 'roleId', 'email', 'mobile'];
const PASSWORD_KEYS = ['password'];
const MOBILE = /^[0-9+\-() ]{6,20}$/;

/** Optional e-mail and mobile from a body: { email, mobile } normalised (null = clear), or field errors. */
function readContact(body, errors) {
  const out = {};
  if (body.email !== undefined) {
    if (body.email === null || body.email === '') out.email = null;
    else {
      const e = normaliseEmail(body.email);
      if (!e) errors.email = 'Enter a valid e-mail address, or leave it empty.';
      else out.email = e;
    }
  }
  if (body.mobile !== undefined) {
    if (body.mobile === null || body.mobile === '') out.mobile = null;
    else if (typeof body.mobile !== 'string' || !MOBILE.test(body.mobile.trim())) errors.mobile = 'Use 6-20 digits, spaces, + - ( ).';
    else out.mobile = body.mobile.trim();
  }
  return out;
}

const duplicateEmail = (id) => conflict('Another account already uses that e-mail address.', {
  field: 'email', fields: { email: 'Another account already uses that e-mail address.' }, ...(id ? { conflictsWith: id } : {}),
});

/* ---------- authorization ---------- */

/** May this caller do this to accounts? The router has checked already; this is the second lock. */
const allowed = (who, permission) => can(who, permission);
const forbidden = (message = 'Your role does not allow this.') => fail('forbidden', message, 403);
const ABOVE_YOU = 'This account\'s role has permissions your own role does not. You cannot change it.';

/** The role an account holds (null for none), loaded with its permissions. */
const roleOf = (env, row) => (row.role_id ? loadRole(env, row.role_id) : Promise.resolve(null));

/** A role named in a body (roleId or role), active and within the caller's reach -- or the problem. */
async function chosenRole(env, who, body) {
  const ref = body.roleId !== undefined ? body.roleId : body.role;
  if (typeof ref !== 'string' || !ref.trim()) return { field: 'Choose a role.' };
  const role = await findRole(env, ref);
  if (!role) return { field: 'No such role.' };
  if (role.status !== 'Active') return { field: 'That role is switched off.' };
  if (!allowed(who, 'roles.manage')) return { forbidden: 'Your role cannot assign roles to accounts.' };
  if (!canHandleRole(who, role)) {
    return { forbidden: role.fullAccess ? 'Only a Super Admin can make someone a Super Admin.' : 'You cannot give a role with permissions your own role does not have.' };
  }
  return { role };
}

/* ---------- reading ---------- */

const SELECT = `
  SELECT a.id, a.mechanic_id, a.staff_id, a.username, a.role, a.role_id, a.status, a.last_login_at, a.locked_until,
         a.email, a.mobile, a.password_change_required,
         a.password_changed_at, a.created_at, a.updated_at, r.name AS role_name, r.full_access AS role_full_access,
         COALESCE(m.name, s.name) AS person_name,
         COALESCE(m.status, s.status) AS person_status,
         COALESCE(p.designation, s.designation, CASE WHEN m.id IS NOT NULL THEN 'Mechanic' END) AS designation
    FROM user_accounts a
    LEFT JOIN roles r ON r.id = a.role_id
    LEFT JOIN mechanics m ON m.id = a.mechanic_id
    LEFT JOIN staff p ON p.mechanic_id = a.mechanic_id
    LEFT JOIN staff s ON s.id = a.staff_id`;

/** One row -> what the page may see. Never a hash, a session version or a counter. */
function toRecord(row, who, now = new Date().toISOString()) {
  return {
    id: row.id,
    staffId: row.mechanic_id || row.staff_id,
    isMechanic: Boolean(row.mechanic_id),
    staffName: row.person_name ?? '',
    staffStatus: row.person_status ?? '',
    designation: row.designation ?? '',
    username: row.username,
    email: row.email ?? '',
    mobile: row.mobile ?? '',
    passwordChangeRequired: Number(row.password_change_required) === 1,
    role: row.role_name ?? '',
    roleId: row.role_id ?? null,
    status: row.status,
    locked: Boolean(row.locked_until && row.locked_until > now),
    lastLoginAt: row.last_login_at ?? '',
    passwordChangedAt: row.password_changed_at ?? '',
    createdAt: row.created_at,
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
    self: Boolean(who && who.kind === 'account' && who.id === row.id),
  };
}

const findAccount = (env, id) => env.DB.prepare(`${SELECT} WHERE a.id = ?1`).bind(id).first();

function readFilter(url, name, max) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  if (raw.length > max) return { error: `\`${name}\` must be ${max} characters or fewer.` };
  return { value: raw.trim() };
}

function readAccountId(raw) {
  return typeof raw === 'string' && ACCOUNT_ID.test(raw) ? raw : null;
}

/** Field errors for every key the route does not take (an id, a hash, a session version, ...). */
function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors[key] = 'This is not an account field.';
  }
  return errors;
}

/** GET /api/accounts */
export async function listAccounts(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!allowed(who, 'users.view')) return forbidden();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const q = readFilter(url, 'q', 100);
  const status = readFilter(url, 'status', 20);
  const role = readFilter(url, 'role', 40);
  for (const f of [q, status, role]) if (f.error) return fail('invalid_parameter', f.error, 400);
  if (status.value !== null && !ACCOUNT_STATUSES.includes(status.value)) {
    return fail('invalid_parameter', '`status` must be Active or Inactive.', 400);
  }
  const needle = q.value === null ? null : q.value.toLowerCase();
  const where = `
     WHERE (?1 IS NULL OR a.status = ?1)
       AND (?2 IS NULL OR a.role_id = ?2
            OR a.role_id = (SELECT id FROM roles WHERE name = ?2 COLLATE NOCASE))
       AND (?3 IS NULL
            OR instr(lower(COALESCE(m.name, s.name, '')), ?3) > 0
            OR instr(lower(COALESCE(a.mechanic_id, a.staff_id)), ?3) > 0
            OR instr(a.username, ?3) > 0
            OR instr(COALESCE(a.email, ''), ?3) > 0
            OR instr(lower(a.id), ?3) > 0)`;
  try {
    const { results } = await env.DB.prepare(
      `${SELECT} ${where} ORDER BY person_name COLLATE NOCASE, a.id LIMIT ?4 OFFSET ?5`
    ).bind(status.value, role.value, needle, limit.value, offset.value).all();
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM user_accounts a
         LEFT JOIN roles r ON r.id = a.role_id
         LEFT JOIN mechanics m ON m.id = a.mechanic_id
         LEFT JOIN staff s ON s.id = a.staff_id ${where}`
    ).bind(status.value, role.value, needle).first();
    const rows = results ?? [];
    // Every role, for the filter; `assignable` says which this caller may give.
    const { results: roleRows } = await env.DB.prepare('SELECT id FROM roles ORDER BY is_system DESC, id').all();
    const mayAssign = allowed(who, 'roles.manage');
    const roles = [];
    for (const r of roleRows || []) {
      const role = await loadRole(env, r.id);
      roles.push({ id: role.id, name: role.name, status: role.status, system: role.system,
        assignable: mayAssign && role.status === 'Active' && canHandleRole(who, role) });
    }
    return ok(rows.map((r) => toRecord(r, who)), {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      roles,
    });
  } catch (err) {
    console.error('GET /api/accounts failed:', err && err.message);
    return fail('database_error', 'Could not read user accounts.', 500);
  }
}

/** GET /api/accounts/:id */
export async function getAccount(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!allowed(who, 'users.view')) return forbidden();
  const id = readAccountId(rawId);
  if (!id) return fail('invalid_id', 'That is not an account id.', 400);
  try {
    const row = await findAccount(env, id);
    if (!row) return fail('not_found', 'No account with that id.', 404);
    return ok(toRecord(row, who));
  } catch (err) {
    console.error('GET /api/accounts/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the account.', 500);
  }
}

/* ---------- writing ---------- */

/** The staff member an account would belong to: exists? active? already has an account? */
async function findPerson(env, staffId) {
  const isMechanic = staffId.startsWith('MEC-');
  const person = isMechanic
    ? await env.DB.prepare('SELECT id, name, status FROM mechanics WHERE id = ?1').bind(staffId).first()
    : await env.DB.prepare('SELECT id, name, status FROM staff WHERE id = ?1 AND mechanic_id IS NULL').bind(staffId).first();
  if (!person) return null;
  const existing = await env.DB.prepare(
    `SELECT id FROM user_accounts WHERE ${isMechanic ? 'mechanic_id' : 'staff_id'} = ?1`
  ).bind(staffId).first();
  return { ...person, isMechanic, accountId: existing ? existing.id : null };
}

const duplicateUsername = (id) => conflict('That username is already taken.', {
  field: 'username', fields: { username: 'That username is already taken.' }, ...(id ? { conflictsWith: id } : {}),
});
const duplicatePerson = (id) => conflict('This staff member already has an account.', {
  field: 'staffId', fields: { staffId: `This staff member already has an account${id ? ` (${id})` : ''}.` }, ...(id ? { conflictsWith: id } : {}),
});

/** A unique-constraint error from an insert, named for the form (two requests at once). */
function writeConflict(err) {
  const message = String((err && err.message) || '');
  if (/UNIQUE constraint failed/i.test(message)) {
    if (/username/i.test(message)) return duplicateUsername(null);
    if (/mechanic_id|staff_id/i.test(message)) return duplicatePerson(null);
    if (/email/i.test(message)) return duplicateEmail(null);
  }
  return constraintFailure(err);
}

/** POST /api/accounts */
export async function createAccount(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!allowed(who, 'users.create')) return forbidden();

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, CREATE_KEYS);
  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  if (!PERSON_ID.test(staffId)) errors.staffId = 'Choose a staff member.';
  const username = normaliseUsername(body.username);
  if (!username) errors.username = 'Use 3-32 lower-case letters, digits, dots, dashes or underscores.';
  else if (usernameLooksLikeOtherIdentifier(username)) errors.username = 'A username cannot look like a Staff ID (e.g. STF-0001).';
  const contact = readContact(body, errors);
  if (body.role === undefined && body.roleId === undefined) errors.role = 'Choose a role.';
  const weak = passwordProblem(body.password, username || '');
  if (weak) errors.password = weak;
  if (Object.keys(errors).length) return unprocessable('Some account fields are not valid.', errors);

  try {
    const choice = await chosenRole(env, who, body);
    if (choice.forbidden) return forbidden(choice.forbidden);
    if (choice.field) return unprocessable('Some account fields are not valid.', { role: choice.field });
    const person = await findPerson(env, staffId);
    if (!person) return unprocessable('Some account fields are not valid.', { staffId: 'No such staff member.' });
    if (person.status !== 'Active') {
      return unprocessable('Some account fields are not valid.', { staffId: 'Only an active staff member can have an account.' });
    }
    if (person.accountId) return duplicatePerson(person.accountId);
    const taken = await env.DB.prepare('SELECT id FROM user_accounts WHERE username = ?1').bind(username).first();
    if (taken) return duplicateUsername(taken.id);
    if (contact.email) {
      const used = await env.DB.prepare('SELECT id FROM user_accounts WHERE email = ?1').bind(contact.email).first();
      if (used) return duplicateEmail(used.id);
    }

    const hash = await hashPassword(body.password);
    const allocated = await allocateId(env, 'accounts');
    if (allocated.error) {
      console.error('POST /api/accounts could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the account.', 500);
    }
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO user_accounts (id, mechanic_id, staff_id, username, role, role_id, status, password_hash, password_changed_at, created_at,
                                 email, mobile, password_change_required)
       SELECT ?1, ?2, ?3, ?4, ?5, ?8, 'Active', ?6, ?7, ?7, ?9, ?10, ?11
        WHERE EXISTS (SELECT 1 FROM roles WHERE id = ?8 AND status = 'Active')`
    ).bind(allocated.id, person.isMechanic ? staffId : null, person.isMechanic ? null : staffId, username,
      choice.role.name, hash, now, choice.role.id, contact.email ?? null, contact.mobile ?? null,
      // The person did not choose this password: they must replace it at their first sign-in.
      1).run();
    const created = await findAccount(env, allocated.id);
    if (!created) return conflict('That role was switched off meanwhile. Choose another role.', { field: 'role', fields: { role: 'That role is switched off.' } });
    return ok(toRecord(created, who), {}, 201);
  } catch (err) {
    const mapped = writeConflict(err);
    if (mapped) return mapped;
    console.error('POST /api/accounts failed:', err && err.message);
    return fail('database_error', 'Could not create the account.', 500);
  }
}

/** PUT /api/accounts/:id -- activate / deactivate, or set the role. */
export async function updateAccount(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!allowed(who, 'users.edit')) return forbidden();
  const id = readAccountId(rawId);
  if (!id) return fail('invalid_id', 'That is not an account id.', 400);

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, UPDATE_KEYS);
  if (body.status !== undefined && !ACCOUNT_STATUSES.includes(body.status)) errors.status = 'Choose Active or Inactive.';
  const changingRole = body.role !== undefined || body.roleId !== undefined;
  const contact = readContact(body, errors);
  if (!Object.keys(errors).length && body.status === undefined && !changingRole && !Object.keys(contact).length) {
    errors.status = 'Nothing to change.';
  }
  if (Object.keys(errors).length) return unprocessable('Some account fields are not valid.', errors);

  try {
    const row = await findAccount(env, id);
    if (!row) return fail('not_found', 'No account with that id.', 404);
    const self = who.kind === 'account' && who.id === id;
    // Nobody acts on an account whose role reaches further than their own.
    // (An account with no role has no permissions; giving it one needs Roles: assign.)
    const current = await roleOf(env, row);
    if (!self && !(current ? canHandleRole(who, current) : allowed(who, 'roles.manage'))) return forbidden(ABOVE_YOU);
    let next = current;
    if (changingRole) {
      const choice = await chosenRole(env, who, body);
      if (choice.forbidden) return forbidden(choice.forbidden);
      if (choice.field) return unprocessable('Some account fields are not valid.', { role: choice.field });
      next = choice.role;
      if (self && next.id !== row.role_id) {
        return conflict('You cannot change your own role.', { field: 'role', fields: { role: 'You cannot change your own role.' } });
      }
    }
    if (self && body.status === 'Inactive') {
      return conflict('You cannot deactivate your own account.', { field: 'status', fields: { status: 'You cannot deactivate your own account.' } });
    }
    if (body.status === 'Active' && row.status !== 'Active' && row.person_status !== 'Active') {
      return conflict('This staff member is inactive. Activate them in the Staff List first.', {
        field: 'status', fields: { status: 'This staff member is inactive. Activate them in the Staff List first.' },
      });
    }

    if (contact.email) {
      const used = await env.DB.prepare('SELECT id FROM user_accounts WHERE email = ?1 AND id <> ?2').bind(contact.email, id).first();
      if (used) return duplicateEmail(used.id);
    }
    const status = body.status ?? row.status;
    const deactivating = row.status === 'Active' && status === 'Inactive';
    const wasSuper = Number(row.role_full_access) === 1;
    const leavingSuper = wasSuper && !!next && !next.fullAccess;
    const roleChanged = !!next && next.id !== row.role_id;
    // An account session may not leave the workshop without an active Super Admin account.
    const guardLastSuper = who.kind === 'account' && row.status === 'Active' && wasSuper && (deactivating || leavingSuper);
    const now = nowIso();
    const res = await env.DB.prepare(
      `UPDATE user_accounts
          SET status = ?2, role_id = ?3, role = ?4, updated_at = ?5,
              session_version = session_version + ?6,
              email = CASE WHEN ?9 = 1 THEN ?10 ELSE email END,
              mobile = CASE WHEN ?11 = 1 THEN ?12 ELSE mobile END
        WHERE id = ?1
          AND (?3 IS NULL OR EXISTS (SELECT 1 FROM roles WHERE id = ?3 AND (status = 'Active' OR ?3 IS ?8)))
          AND (?7 = 0 OR (SELECT count(*) FROM user_accounts u JOIN roles r ON r.id = u.role_id
                           WHERE u.status = 'Active' AND r.full_access = 1 AND u.id <> ?1) > 0)`
    ).bind(id, status, next ? next.id : null, next ? next.name : row.role, now,
      deactivating || roleChanged ? 1 : 0, guardLastSuper ? 1 : 0, row.role_id,
      'email' in contact ? 1 : 0, contact.email ?? null, 'mobile' in contact ? 1 : 0, contact.mobile ?? null).run();
    if (!res.meta || res.meta.changes !== 1) {
      if (guardLastSuper) {
        return conflict('This is the last active Super Admin account. Make another account Super Admin first.', {
          field: deactivating ? 'status' : 'role', fields: { [deactivating ? 'status' : 'role']: 'This is the last active Super Admin account.' },
        });
      }
      return conflict('That role was switched off meanwhile. Choose another role.', { field: 'role', fields: { role: 'That role is switched off.' } });
    }
    return ok(toRecord(await findAccount(env, id), who));
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err && err.message)) && /email/i.test(String(err && err.message))) return duplicateEmail(null);
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/accounts/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the account.', 500);
  }
}

/** POST /api/accounts/:id/password -- an administrator sets a new password; every session of that account ends. */
export async function setAccountPassword(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!allowed(who, 'users.manage')) return forbidden();
  const id = readAccountId(rawId);
  if (!id) return fail('invalid_id', 'That is not an account id.', 400);

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, PASSWORD_KEYS);
  try {
    const row = await findAccount(env, id);
    if (!row) return fail('not_found', 'No account with that id.', 404);
    // Setting someone's password is taking over their account: never above your own reach.
    const self = who.kind === 'account' && who.id === id;
    const target = await roleOf(env, row);
    if (!self && target && !canHandleRole(who, target)) return forbidden(ABOVE_YOU);
    const weak = passwordProblem(body.password, row.username);
    if (weak) errors.password = weak;
    if (Object.keys(errors).length) return unprocessable('Some account fields are not valid.', errors);
    const hash = await hashPassword(body.password);
    const now = nowIso();
    await env.DB.prepare(
      `UPDATE user_accounts
          SET password_hash = ?2, password_changed_at = ?3, updated_at = ?3,
              session_version = session_version + 1, failed_logins = 0, locked_until = NULL,
              password_change_required = ?4
        WHERE id = ?1`
    ).bind(id, hash, now,
      // Someone else chose this password: unless the person is resetting their
      // own, they must replace it at their next sign-in (0019), so nobody else
      // ever knows the password they end up with.
      who.kind === 'account' && who.id === id ? 0 : 1).run();
    return ok(toRecord(await findAccount(env, id), who));
  } catch (err) {
    console.error('POST /api/accounts/:id/password failed:', err && err.message);
    return fail('database_error', 'Could not set the password.', 500);
  }
}
