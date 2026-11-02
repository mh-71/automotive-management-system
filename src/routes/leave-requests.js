/* ============================================================
   routes/leave-requests.js — Staff Management › Leave Management
   ------------------------------------------------------------
     GET    /api/leave-requests              list (status, leaveType, staffId, limit, offset)
     GET    /api/leave-requests/:id          one request
     POST   /api/leave-requests              { staffId, leaveType, startDate, endDate, reason }
     POST   /api/leave-requests/:id/approve  { expectedUpdatedAt, note? }
     POST   /api/leave-requests/:id/reject   { expectedUpdatedAt, note }
     (no PUT and no DELETE: a request is decided once and kept)

   One request belongs to one staff member -- a mechanic (MEC-0001) or
   any other employee (STF-0001) -- linked by foreign key and copying
   nothing about the person (migration 0011).

   WHO MAY CALL: anyone signed in may read and submit, as for every other
   business route; the router's gate has already checked that. Approving
   and rejecting is for an administrator -- the workshop passphrase
   session, the machine token, or an account whose role is Administrator
   -- the same rule /api/accounts applies. Every account is an
   Administrator today, so in practice that is everyone signed in; no
   narrower role exists, and none is claimed.

   SAFETY RULES
     * Only an ACTIVE staff member gets a new request. The end date is on
       or after the start date; a request covers at most 366 days and
       starts within a year of today (Asia/Dhaka) either way.
     * A request may not overlap another Pending or Approved request of
       the same person. The check and the insert are ONE statement, so a
       double submission -- two clicks, two tabs -- cannot both land.
     * Pending -> Approved | Rejected, once. A decision sends the updatedAt
       value it was made from; the change is one conditional UPDATE, so a
       request decided or changed meanwhile is refused (409), never
       overwritten. A decided request never changes again.
     * Approving changes nothing else: no attendance record, balance or
       pay is touched.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, conflict, unprocessable,
} from '../lib/http.js';
import { readJsonBody, readDate, nowIso, todayInDhaka, allocateId, constraintFailure } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { can } from '../lib/permissions.js';

export const LEAVE_TYPES = ['Casual', 'Sick', 'Annual', 'Unpaid'];
export const LEAVE_STATUSES = ['Pending', 'Approved', 'Rejected'];
const LEAVE_ID = /^LVR-\d{4,}$/;
const PERSON_ID = /^(MEC|STF)-\d{4,}$/;
const TEXT_MAX = 500;
const MAX_DAYS = 366;
const WINDOW_DAYS = 366;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

const CREATE_KEYS = ['staffId', 'leaveType', 'startDate', 'endDate', 'reason'];
const DECISION_KEYS = ['expectedUpdatedAt', 'note'];
const SERVER_KEYS = ['id', 'status', 'decidedAt', 'decidedBy', 'decisionNote', 'createdAt', 'updatedAt'];

/* ---------- authorization ---------- */

/** May this caller decide a request? A role with Leave: approve (0018); the router checks it first. */
const isAdmin = (who) => can(who, 'leave.approve');

/** Who made a decision, as the request keeps it. */
function deciderName(who) {
  if (who.kind === 'account') return String(who.username || who.id || 'Account').slice(0, 100);
  return who.kind === 'passphrase' ? 'Workshop passphrase' : 'API token';
}

const forbidden = () => fail('forbidden', 'Your role cannot approve or reject leave requests.', 403);

/* ---------- reading ---------- */

const SELECT = `
  SELECT l.id, l.mechanic_id, l.staff_id, l.leave_type, l.start_date, l.end_date, l.reason, l.status,
         l.decided_at, l.decided_by, l.decision_note, l.created_at, l.updated_at,
         COALESCE(m.name, s.name) AS person_name,
         COALESCE(p.department, s.department) AS department,
         COALESCE(p.designation, s.designation, CASE WHEN m.id IS NOT NULL THEN 'Mechanic' END) AS designation
    FROM leave_requests l
    LEFT JOIN mechanics m ON m.id = l.mechanic_id
    LEFT JOIN staff p ON p.mechanic_id = l.mechanic_id
    LEFT JOIN staff s ON s.id = l.staff_id`;

const dayNumber = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

/** Calendar days a request covers, both ends included. */
export const leaveDays = (start, end) => dayNumber(end) - dayNumber(start) + 1;

/** One row -> the request the page reads. */
function toRequest(row) {
  return {
    id: row.id,
    staffId: row.mechanic_id || row.staff_id,
    isMechanic: Boolean(row.mechanic_id),
    staffName: row.person_name ?? '',
    department: row.department ?? '',
    designation: row.designation ?? '',
    leaveType: row.leave_type,
    startDate: row.start_date,
    endDate: row.end_date,
    days: leaveDays(row.start_date, row.end_date),
    reason: row.reason,
    status: row.status,
    decidedAt: row.decided_at ?? '',
    decidedBy: row.decided_by ?? '',
    decisionNote: row.decision_note ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const findRequest = (env, id) => env.DB.prepare(`${SELECT} WHERE l.id = ?1`).bind(id).first();
const readId = (raw) => (typeof raw === 'string' && LEAVE_ID.test(raw) ? raw : null);

/** An optional query parameter that must be one of `allowed`. */
function readChoiceParam(url, name, allowed) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === '') return { value: null };
  const v = raw.trim();
  return allowed.includes(v) ? { value: v } : { error: `\`${name}\` must be one of: ${allowed.join(', ')}.` };
}

/** GET /api/leave-requests */
export async function listLeaveRequests(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = readChoiceParam(url, 'status', LEAVE_STATUSES);
  if (status.error) return fail('invalid_parameter', status.error, 400);
  const type = readChoiceParam(url, 'leaveType', LEAVE_TYPES);
  if (type.error) return fail('invalid_parameter', type.error, 400);
  const rawStaff = url.searchParams.get('staffId');
  const staffId = rawStaff === null || rawStaff.trim() === '' ? null : rawStaff.trim();
  if (staffId !== null && !PERSON_ID.test(staffId)) return fail('invalid_parameter', '`staffId` is not a staff id.', 400);

  const where = `
     WHERE (?1 IS NULL OR l.status = ?1)
       AND (?2 IS NULL OR l.leave_type = ?2)
       AND (?3 IS NULL OR l.mechanic_id = ?3 OR l.staff_id = ?3)`;
  try {
    const { results } = await env.DB.prepare(
      `${SELECT} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT ?4 OFFSET ?5`
    ).bind(status.value, type.value, staffId, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM leave_requests l ${where}`)
      .bind(status.value, type.value, staffId).first();
    const rows = results ?? [];
    return ok(rows.map(toRequest), {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      types: LEAVE_TYPES, statuses: LEAVE_STATUSES, today: todayInDhaka(),
    });
  } catch (err) {
    console.error('GET /api/leave-requests failed:', err && err.message);
    return fail('database_error', 'Could not read leave requests.', 500);
  }
}

/** GET /api/leave-requests/:id */
export async function getLeaveRequest(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not a leave request id.', 400);
  try {
    const row = await findRequest(env, id);
    if (!row) return fail('not_found', 'No leave request with that id.', 404);
    return ok(toRequest(row));
  } catch (err) {
    console.error('GET /api/leave-requests/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the leave request.', 500);
  }
}

/* ---------- writing ---------- */

/** Field errors for every key the route does not take (an id, a status, a timestamp, ...). */
function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    errors[key] = SERVER_KEYS.includes(key)
      ? 'This is set by the server, not by a request.'
      : 'This is not a leave request field.';
  }
  return errors;
}

/** A required or optional trimmed text of at most TEXT_MAX characters. */
function readText(body, key, { required, label }) {
  const raw = body[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return required ? { error: `Enter the ${label}.` } : { value: null };
  }
  if (typeof raw !== 'string') return { error: `The ${label} must be text.` };
  const t = raw.trim();
  return t.length > TEXT_MAX ? { error: `Use at most ${TEXT_MAX} characters.` } : { value: t };
}

/** The person a new request would belong to: exists? active? */
function findPerson(env, staffId) {
  return staffId.startsWith('MEC-')
    ? env.DB.prepare('SELECT id, status FROM mechanics WHERE id = ?1').bind(staffId).first()
    : env.DB.prepare('SELECT id, status FROM staff WHERE id = ?1 AND mechanic_id IS NULL').bind(staffId).first();
}

// A Pending or Approved request of the same person that shares at least one day.
const OVERLAP = (column) => `
  SELECT id FROM leave_requests
   WHERE ${column} = ?1 AND status IN ('Pending', 'Approved') AND start_date <= ?3 AND end_date >= ?2`;

const overlapConflict = (id) => conflict('This staff member already has a pending or approved leave request for some of these days.', {
  reason: 'overlapping_request', field: 'startDate',
  fields: { startDate: 'These dates overlap another pending or approved request.' }, ...(id ? { conflictsWith: id } : {}),
});

/** POST /api/leave-requests */
export async function createLeaveRequest(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, CREATE_KEYS);
  const staffId = typeof body.staffId === 'string' ? body.staffId.trim() : '';
  if (!PERSON_ID.test(staffId)) errors.staffId = 'Choose a staff member.';
  if (!LEAVE_TYPES.includes(body.leaveType)) errors.leaveType = `Choose one of: ${LEAVE_TYPES.join(', ')}.`;
  const start = readDate(body, 'startDate', { required: true });
  const end = readDate(body, 'endDate', { required: true });
  if (start.error) errors.startDate = start.error;
  if (end.error) errors.endDate = end.error;
  if (!start.error && !end.error) {
    const today = dayNumber(todayInDhaka());
    if (end.value < start.value) errors.endDate = 'The end date cannot be before the start date.';
    else if (leaveDays(start.value, end.value) > MAX_DAYS) errors.endDate = `A request covers at most ${MAX_DAYS} days.`;
    if (Math.abs(dayNumber(start.value) - today) > WINDOW_DAYS) errors.startDate = 'The start date must be within a year of today.';
  }
  const reason = readText(body, 'reason', { required: true, label: 'reason' });
  if (reason.error) errors.reason = reason.error;
  if (Object.keys(errors).length) return unprocessable('Some leave request fields are not valid.', errors);

  const column = staffId.startsWith('MEC-') ? 'mechanic_id' : 'staff_id';
  try {
    const person = await findPerson(env, staffId);
    if (!person) return unprocessable('Some leave request fields are not valid.', { staffId: 'No such staff member.' });
    if (person.status !== 'Active') {
      return unprocessable('Some leave request fields are not valid.', { staffId: 'Leave can only be requested for an active staff member.' });
    }
    const existing = await env.DB.prepare(OVERLAP(column)).bind(staffId, start.value, end.value).first();
    if (existing) return overlapConflict(existing.id);

    const allocated = await allocateId(env, 'leaveRequests');
    if (allocated.error) {
      console.error('POST /api/leave-requests could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not submit the leave request.', 500);
    }
    const now = nowIso();
    const isMechanic = column === 'mechanic_id';
    // The overlap check and the insert are one statement: a request submitted
    // twice at the same moment inserts once, and the second finds the first.
    const res = await env.DB.prepare(
      `INSERT INTO leave_requests (id, mechanic_id, staff_id, leave_type, start_date, end_date, reason, status, created_at, updated_at)
       SELECT ?4, ?5, ?6, ?7, ?2, ?3, ?8, 'Pending', ?9, ?9
        WHERE NOT EXISTS (${OVERLAP(column)})`
    ).bind(staffId, start.value, end.value, allocated.id, isMechanic ? staffId : null, isMechanic ? null : staffId,
      body.leaveType, reason.value, now).run();
    if (!res.meta || res.meta.changes !== 1) {
      const winner = await env.DB.prepare(OVERLAP(column)).bind(staffId, start.value, end.value).first().catch(() => null);
      return overlapConflict(winner ? winner.id : null);
    }
    return ok(toRequest(await findRequest(env, allocated.id)), {}, 201);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/leave-requests failed:', err && err.message);
    return fail('database_error', 'Could not submit the leave request.', 500);
  }
}

/** Pending -> Approved | Rejected, once, by an administrator. */
async function decide(request, env, rawId, to) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();
  const who = principalOf(request);
  if (!isAdmin(who)) return forbidden();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not a leave request id.', 400);

  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, DECISION_KEYS);
  const expected = body.expectedUpdatedAt;
  if (typeof expected !== 'string' || expected === '' || expected.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the decision was made from.';
  }
  // A rejection says why; an approval may.
  const note = readText(body, 'note', { required: to === 'Rejected', label: 'reason for the rejection' });
  if (note.error) errors.note = note.error;
  if (Object.keys(errors).length) return unprocessable('Some decision fields are not valid.', errors);

  try {
    let now = nowIso();
    const row = await findRequest(env, id);
    if (!row) return fail('not_found', 'No leave request with that id.', 404);
    if (row.status !== 'Pending') return alreadyDecided(row.status);
    if (row.updated_at !== expected) return staleConflict();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();   // always a new value
    // The check and the change are one statement: a request decided meanwhile cannot be decided again.
    const res = await env.DB.prepare(
      `UPDATE leave_requests
          SET status = ?3, decided_at = ?4, decided_by = ?5, decision_note = ?6, updated_at = ?4
        WHERE id = ?1 AND status = 'Pending' AND updated_at = ?2`
    ).bind(id, expected, to, now, deciderName(who), note.value).run();
    if (!res.meta || res.meta.changes !== 1) {
      const after = await findRequest(env, id);
      if (!after) return fail('not_found', 'No leave request with that id.', 404);
      return after.status !== 'Pending' ? alreadyDecided(after.status) : staleConflict();
    }
    return ok(toRequest(await findRequest(env, id)));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error(`POST /api/leave-requests/:id/${to === 'Approved' ? 'approve' : 'reject'} failed:`, err && err.message);
    return fail('database_error', 'Could not record the decision.', 500);
  }
}

const alreadyDecided = (status) => conflict(`This leave request was already ${status.toLowerCase()}. A decision cannot be changed.`, {
  reason: 'already_decided', status,
});
const staleConflict = () => conflict('This leave request was changed after you opened it. Reload and try again.', {
  reason: 'concurrent_modification',
});

/** POST /api/leave-requests/:id/approve */
export const approveLeaveRequest = (request, env, rawId) => decide(request, env, rawId, 'Approved');

/** POST /api/leave-requests/:id/reject */
export const rejectLeaveRequest = (request, env, rawId) => decide(request, env, rawId, 'Rejected');
