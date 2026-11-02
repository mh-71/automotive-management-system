/* ============================================================
   routes/activity-log.js — Staff Management › Activity Log
   ------------------------------------------------------------
     GET  /api/activity-log       list (from, to, module, action, q, limit, offset)
     GET  /api/activity-log/:id   one entry
     (no create, edit or delete: entries are written by the Worker itself,
      src/lib/activity.js, after a change succeeds -- never by a request)

   WHO MAY CALL: an administrator -- the workshop passphrase session, the
   machine token, or an account whose role is Administrator -- the same
   rule /api/accounts applies. Every account is an Administrator today, so
   in practice that is everyone signed in; no narrower role exists, and
   none is claimed.

   Filtering and paging happen HERE, so the page never has to download the
   whole history: `from` / `to` are workshop days (Asia/Dhaka, UTC+6, no
   daylight saving), `module` and `action` are exact, `q` searches the
   caller, the record id and the summary. Newest first.
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam } from '../lib/http.js';
import { readDate, todayInDhaka } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { can } from '../lib/permissions.js';

export const ACTIVITY_MODULES = ['staff', 'accounts', 'attendance', 'leave'];
export const ACTIVITY_ACTIONS = ['create', 'update', 'password', 'approve', 'reject'];
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const Q_MAX = 100;

/** May this caller read the log? A role with Activity Log: view (0018); the router checks it first. */
const isAdmin = (who) => can(who, 'activity_log.view');
const forbidden = () => fail('forbidden', 'Your role cannot read the activity log.', 403);

function toEntry(row) {
  return {
    id: String(row.id),
    occurredAt: row.occurred_at,
    actorKind: row.actor_kind,
    actorAccountId: row.actor_account_id ?? '',
    actorName: row.actor_name,
    action: row.action,
    module: row.module,
    recordId: row.record_id,
    summary: row.summary,
  };
}

/** The UTC instant a workshop day (Asia/Dhaka, UTC+6) starts at. */
const dayStartUtc = (day) => new Date(Date.parse(`${day}T00:00:00+06:00`)).toISOString();
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

function readDateParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  const d = readDate({ [name]: raw.trim() }, name);
  return d.error ? { error: d.error } : { value: d.value };
}

function readChoiceParam(url, name, allowed) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  const v = raw.trim();
  return allowed.includes(v) ? { value: v } : { error: `\`${name}\` must be one of: ${allowed.join(', ')}.` };
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** GET /api/activity-log */
export async function listActivity(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  if (!isAdmin(principalOf(request))) return forbidden();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const from = readDateParam(url, 'from');
  const to = readDateParam(url, 'to');
  for (const p of [from, to]) if (p.error) return fail('invalid_parameter', p.error, 400);
  if (from.value && to.value && to.value < from.value) return fail('invalid_parameter', '`from` must be on or before `to`.', 400);
  const module = readChoiceParam(url, 'module', ACTIVITY_MODULES);
  if (module.error) return fail('invalid_parameter', module.error, 400);
  const action = readChoiceParam(url, 'action', ACTIVITY_ACTIONS);
  if (action.error) return fail('invalid_parameter', action.error, 400);
  const rawQ = url.searchParams.get('q');
  const q = rawQ === null ? '' : rawQ.trim();
  if (q.length > Q_MAX) return fail('invalid_parameter', `\`q\` may be at most ${Q_MAX} characters.`, 400);

  const lo = from.value ? dayStartUtc(from.value) : null;
  const hi = to.value ? dayStartUtc(nextDay(to.value)) : null;   // exclusive
  const like = q ? `%${likeEscape(q)}%` : null;
  const where = `
     WHERE (?1 IS NULL OR occurred_at >= ?1)
       AND (?2 IS NULL OR occurred_at <  ?2)
       AND (?3 IS NULL OR module = ?3)
       AND (?4 IS NULL OR action = ?4)
       AND (?5 IS NULL OR actor_name LIKE ?5 ESCAPE '\\' OR record_id LIKE ?5 ESCAPE '\\' OR summary LIKE ?5 ESCAPE '\\')`;
  const binds = [lo, hi, module.value, action.value, like];
  const today = todayInDhaka();
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, occurred_at, actor_kind, actor_account_id, actor_name, action, module, record_id, summary
         FROM activity_log ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?6 OFFSET ?7`
    ).bind(...binds, limit.value, offset.value).all();
    const counts = await env.DB.prepare(
      `SELECT count(*) AS total,
              COALESCE(SUM(CASE WHEN occurred_at >= ?6 THEN 1 ELSE 0 END), 0) AS today,
              COALESCE(SUM(CASE WHEN module IN ('staff', 'accounts') THEN 1 ELSE 0 END), 0) AS staff_accounts,
              COALESCE(SUM(CASE WHEN module IN ('attendance', 'leave') THEN 1 ELSE 0 END), 0) AS attendance_leave
         FROM activity_log ${where}`
    ).bind(...binds, dayStartUtc(today)).first();
    const rows = results ?? [];
    return ok(rows.map(toEntry), {
      count: rows.length, total: counts ? counts.total : rows.length, limit: limit.value, offset: offset.value,
      today, counts: {
        today: counts ? counts.today : 0,
        staffAccounts: counts ? counts.staff_accounts : 0,
        attendanceLeave: counts ? counts.attendance_leave : 0,
      },
      modules: ACTIVITY_MODULES, actions: ACTIVITY_ACTIONS,
    });
  } catch (err) {
    console.error('GET /api/activity-log failed:', err && err.message);
    return fail('database_error', 'Could not read the activity log.', 500);
  }
}

/** GET /api/activity-log/:id */
export async function getActivity(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  if (!isAdmin(principalOf(request))) return forbidden();
  if (typeof rawId !== 'string' || !/^[1-9]\d{0,15}$/.test(rawId)) return fail('invalid_id', 'That is not an activity log id.', 400);
  try {
    const row = await env.DB.prepare(
      `SELECT id, occurred_at, actor_kind, actor_account_id, actor_name, action, module, record_id, summary
         FROM activity_log WHERE id = ?1`
    ).bind(Number(rawId)).first();
    if (!row) return fail('not_found', 'No activity log entry with that id.', 404);
    return ok(toEntry(row));
  } catch (err) {
    console.error('GET /api/activity-log/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the activity log entry.', 500);
  }
}
