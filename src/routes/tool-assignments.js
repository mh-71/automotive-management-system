/* ============================================================
   routes/tool-assignments.js — /api/tool-assignments   (migration 0025)
   ------------------------------------------------------------
   Workshop Assets › Asset Assignment: one row per time a piece of
   equipment from the `tools` register is handed to a member of staff or
   a mechanic.

     GET  /api/tool-assignments              list -- q, status (Active |
                                             Overdue | Returned | Cancelled),
                                             assigneeId, toolId, from, to
                                             (assigned date), limit, offset;
                                             meta.summary counts
     GET  /api/tool-assignments/:id          one assignment, its history and
                                             the equipment as it is now
     POST /api/tool-assignments              assign an Available item
     PUT  /api/tool-assignments/:id          edit an Active one (expected
                                             return, purpose, location, notes,
                                             or hand it to someone else);
                                             `expectedUpdatedAt` is required
     POST /api/tool-assignments/:id/return   { returnDate, conditionAfter,
                                               statusAfter?, damageNotes?,
                                               returnNotes?, receivedById?,
                                               expectedUpdatedAt }
     POST /api/tool-assignments/:id/cancel   { reason, expectedUpdatedAt } --
                                             an assignment made by mistake
   There is no delete: assignment history is never removed.

   WHO HAS AN ITEM NOW stays on the item itself, as Equipment Inventory
   (0021) keeps it: tools.assigned_staff_id / assigned_mechanic_id with
   status 'In Use'. Equipment Inventory (assign / return) and Maintenance
   & Repairs (starting work ends an assignment) change those columns as
   before -- their code is not touched. This register is kept in step by
   reconcile(), run before every read and write here:
     * an Active assignment whose item is no longer with that person
       (returned in Equipment Inventory, taken for maintenance, deleted) is
       closed as Returned, saying why;
     * an item In Use with nobody's Active assignment (assigned in
       Equipment Inventory) gets one, marked source 'Equipment Inventory'.
   Both are written to tool_assignment_events as 'sync' by "System".

   Rules (the item must be Available -- never In Use, Under Maintenance,
   Damaged or Retired -- and have no maintenance in progress; the person
   must be an ACTIVE employee or mechanic; one Active assignment per item,
   also a unique index) are checked here. Assigning, handing over,
   returning and cancelling change the assignment AND the item in ONE
   batch; if either changed after it was read, a NOT NULL tripwire rolls
   the whole batch back (as in job-cards.js) and the answer is 409. Every
   change to the item is also written to tool_events (its own history).

   Permissions (the existing Workshop Assets module, no new ones):
   view tools.view; assign, edit, return and cancel tools.edit.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readEnum, readDate, nowIso, todayInDhaka, allocateId,
} from '../lib/write.js';
import { principalOf } from '../lib/auth.js';

export const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Damaged'];
export const USABLE_CONDITIONS = ['Excellent', 'Good', 'Fair'];
export const ASSIGNMENT_STATUSES = ['Active', 'Returned', 'Cancelled'];
export const FILTER_STATUSES = ['Active', 'Overdue', 'Returned', 'Cancelled'];
/** What an item can become when it comes back, by its condition then. */
export function statusesAfterReturn(condition) {
  if (USABLE_CONDITIONS.includes(condition)) return ['Available', 'Under Maintenance', 'Damaged'];
  return ['Under Maintenance', 'Damaged'];
}
export function defaultStatusAfterReturn(condition) {
  if (USABLE_CONDITIONS.includes(condition)) return 'Available';
  return condition === 'Damaged' ? 'Damaged' : 'Under Maintenance';
}

const EARLIEST = '2000-01-01';
const MAX_DAYS_AHEAD = 366;
const LIMITS = { purpose: 200, workLocation: 80, notes: 1000, damageNotes: 500, returnNotes: 1000, reason: 300, q: 100 };
const PERSON_ID = /^[A-Z]{3}-\d{4,}$/;
const ASG_ID = /^ASG-\d{1,10}$/;
const CREATE_KEYS = ['toolId', 'assigneeId', 'assignedDate', 'expectedReturnDate', 'purpose', 'workLocation', 'conditionBefore', 'notes'];
const UPDATE_KEYS = ['assigneeId', 'expectedReturnDate', 'purpose', 'workLocation', 'notes', 'expectedUpdatedAt'];
const RETURN_KEYS = ['returnDate', 'conditionAfter', 'statusAfter', 'damageNotes', 'returnNotes', 'receivedById', 'expectedUpdatedAt'];
const CANCEL_KEYS = ['reason', 'expectedUpdatedAt'];
const SYSTEM = 'System';

const COLUMNS = `id, tool_id, tool_name, assignee_type, assignee_id, assignee_name, status, source, assigned_date,
  expected_return_date, purpose, work_location, condition_before, notes, return_date, condition_after, damage_notes,
  return_notes, received_by_id, received_by_name, cancel_reason, created_by, updated_by, created_at, updated_at,
  returned_at, cancelled_at,
  (SELECT t.status FROM tools t WHERE t.id = tool_assignments.tool_id) AS tool_status`;

/* ---------- helpers ---------- */

function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const dhakaDay = (iso) => todayInDhaka(new Date(iso));

/** Overdue for an Active assignment past its expected return; otherwise its status. Derived, never stored. */
export function assignmentState(row, today = todayInDhaka()) {
  if (row.status === 'Active' && row.expected_return_date && row.expected_return_date < today) return 'Overdue';
  return row.status;
}

function toRecord(row, today = todayInDhaka()) {
  return {
    id: row.id,
    toolId: row.tool_id,
    toolName: row.tool_name,
    toolStatus: row.tool_status ?? null,
    assigneeType: row.assignee_type,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    status: row.status,
    state: assignmentState(row, today),
    source: row.source,
    assignedDate: row.assigned_date,
    expectedReturnDate: row.expected_return_date ?? '',
    purpose: row.purpose ?? '',
    workLocation: row.work_location ?? '',
    conditionBefore: row.condition_before ?? '',
    notes: row.notes ?? '',
    returnDate: row.return_date ?? '',
    conditionAfter: row.condition_after ?? '',
    damageNotes: row.damage_notes ?? '',
    returnNotes: row.return_notes ?? '',
    receivedById: row.received_by_id ?? '',
    receivedByName: row.received_by_name ?? '',
    cancelReason: row.cancel_reason ?? '',
    createdBy: row.created_by ?? '',
    updatedBy: row.updated_by ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    returnedAt: row.returned_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
  };
}

function actorName(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') return String(p.username || p.id || 'Account').slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  if (p.kind === 'token') return 'API token';
  return null;
}

const clip = (s) => String(s).slice(0, 300);
const readId = (raw) => (typeof raw === 'string' && ASG_ID.test(raw) ? raw : null);
const findRow = (env, id) => env.DB.prepare(`SELECT ${COLUMNS} FROM tool_assignments WHERE id = ?1`).bind(id).first();
const staleConflict = () => conflict('This assignment or its equipment was changed by someone else after you opened it. Reload it and try again.', { reason: 'concurrent_modification' });

function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) if (!allowed.includes(key)) errors[key] = 'This field cannot be set here.';
  return errors;
}
function readExpected(body, errors) {
  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt || body.expectedUpdatedAt.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the change was made from.';
  }
}

async function findTool(env, id) {
  return env.DB.prepare(
    `SELECT id, name, status, condition, assigned_staff_id, assigned_mechanic_id, coalesce(updated_at, created_at) AS stamp
       FROM tools WHERE id = ?1`
  ).bind(id).first();
}

/** An ACTIVE employee (not a mechanic's own staff profile) or mechanic: { id, name, type } or null. */
async function activePerson(env, id) {
  return env.DB.prepare(
    `SELECT id, name, 'staff' AS type FROM staff WHERE id = ?1 AND mechanic_id IS NULL AND status = 'Active'
     UNION ALL
     SELECT id, name, 'mechanic' AS type FROM mechanics WHERE id = ?1 AND coalesce(status, 'Active') = 'Active'
     LIMIT 1`
  ).bind(id).first();
}

async function readPerson(env, body, key, errors, { required = false } = {}) {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) errors[key] = 'Choose a member of staff or a mechanic.';
    return null;
  }
  if (typeof raw !== 'string' || !PERSON_ID.test(raw)) { errors[key] = 'Choose a member of staff or a mechanic.'; return null; }
  const p = await activePerson(env, raw);
  if (!p) { errors[key] = 'That is not an active member of staff or mechanic.'; return null; }
  return { id: p.id, name: String(p.name || p.id).slice(0, 120), type: p.type };
}

/** Rolls the whole batch back (NOT NULL tripwire) unless the assignment still carries `stamp`. */
const assignmentTripwire = (env, id, stamp) => env.DB.prepare(
  'UPDATE tool_assignments SET tool_id = NULL WHERE id = ?1 AND updated_at IS NOT ?2'
).bind(id, stamp);
/** The same for the equipment row. */
const toolTripwire = (env, id, stamp) => env.DB.prepare(
  'UPDATE tools SET name = NULL WHERE id = ?1 AND coalesce(updated_at, created_at) IS NOT ?2'
).bind(id, stamp);
const toolEvent = (env, toolId, at, who, action, summary) => env.DB.prepare(
  'INSERT INTO tool_events (tool_id, occurred_at, actor, action, summary) VALUES (?1, ?2, ?3, ?4, ?5)'
).bind(toolId, at, who, action, clip(summary));
const assignmentEvent = (env, id, toolId, at, who, action, summary) => env.DB.prepare(
  'INSERT INTO tool_assignment_events (assignment_id, tool_id, occurred_at, actor, action, summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
).bind(id, toolId, at, who, action, clip(summary));

/** Run a batch; a tripwire or the one-Active-per-item index turns into a 409, nothing saved. */
async function runBatch(env, statements) {
  try {
    await env.DB.batch(statements);
    return null;
  } catch (err) {
    const msg = String(err && err.message);
    if (/NOT NULL/i.test(msg)) return staleConflict();
    if (/UNIQUE/i.test(msg)) return conflict('This equipment already has an active assignment.', { reason: 'already_assigned' });
    throw err;
  }
}

/* ---------- keeping this register in step with the equipment ---------- */

/**
 * Close Active assignments the equipment no longer reflects, and record
 * assignments made outside this page. Idempotent; safe to run concurrently
 * (guarded updates, and the unique index for the inserts).
 */
export async function reconcile(env) {
  const now = nowIso();
  const today = todayInDhaka();
  const { results: drifted } = await env.DB.prepare(
    `SELECT a.id, a.tool_id, a.assignee_id, a.assigned_date, t.id AS t_id, t.status AS t_status,
            coalesce(t.assigned_staff_id, t.assigned_mechanic_id) AS t_holder
       FROM tool_assignments a LEFT JOIN tools t ON t.id = a.tool_id
      WHERE a.status = 'Active'
        AND (t.id IS NULL OR t.status <> 'In Use' OR coalesce(t.assigned_staff_id, t.assigned_mechanic_id) IS NOT a.assignee_id)
      LIMIT 50`
  ).all();
  const closing = [];
  for (const a of drifted || []) {
    const why = !a.t_id ? 'the equipment was deleted'
      : a.t_status === 'Under Maintenance' ? 'the equipment was taken for maintenance'
      : a.t_status === 'In Use' ? `it was handed to ${a.t_holder} in Equipment Inventory`
      : `it was marked ${a.t_status} in Equipment Inventory`;
    const day = today < a.assigned_date ? a.assigned_date : today;
    closing.push(env.DB.prepare(
      `UPDATE tool_assignments SET status = 'Returned', return_date = ?2, return_notes = ?3, returned_at = ?4,
              updated_at = ?4, updated_by = ?5 WHERE id = ?1 AND status = 'Active'`
    ).bind(a.id, day, clip(`Ended outside Asset Assignment: ${why}.`), now, SYSTEM));
    closing.push(env.DB.prepare(
      `INSERT INTO tool_assignment_events (assignment_id, tool_id, occurred_at, actor, action, summary)
       SELECT ?1, ?2, ?3, ?4, 'sync', ?5 WHERE EXISTS (SELECT 1 FROM tool_assignments WHERE id = ?1 AND updated_at = ?3 AND status = 'Returned')`
    ).bind(a.id, a.tool_id, now, SYSTEM, clip(`Closed: ${why}`)));
  }
  if (closing.length) await env.DB.batch(closing);

  const { results: untracked } = await env.DB.prepare(
    `SELECT t.id, t.name, t.condition, coalesce(t.updated_at, t.created_at) AS stamp,
            t.assigned_staff_id, t.assigned_mechanic_id,
            coalesce((SELECT s.name FROM staff s WHERE s.id = t.assigned_staff_id),
                     (SELECT m.name FROM mechanics m WHERE m.id = t.assigned_mechanic_id)) AS holder_name
       FROM tools t
      WHERE t.status = 'In Use' AND (t.assigned_staff_id IS NOT NULL OR t.assigned_mechanic_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM tool_assignments a WHERE a.tool_id = t.id AND a.status = 'Active')
      LIMIT 50`
  ).all();
  for (const t of untracked || []) {
    const allocated = await allocateId(env, 'toolAssignments');
    if (allocated.error) throw new Error(allocated.error);
    const holder = t.assigned_staff_id || t.assigned_mechanic_id;
    const day = dhakaDay(t.stamp) > today ? today : dhakaDay(t.stamp);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO tool_assignments (id, tool_id, tool_name, assignee_type, assignee_id, assignee_name, status, source,
             assigned_date, condition_before, created_by, updated_by, created_at, updated_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'Active', 'Equipment Inventory', ?7, ?8, ?9, ?9, ?10, ?10
            WHERE NOT EXISTS (SELECT 1 FROM tool_assignments WHERE tool_id = ?2 AND status = 'Active')`
        ).bind(allocated.id, t.id, t.name, t.assigned_staff_id ? 'staff' : 'mechanic', holder, String(t.holder_name || holder).slice(0, 120),
          day, CONDITIONS.includes(t.condition) ? t.condition : null, SYSTEM, now),
        env.DB.prepare(
          `INSERT INTO tool_assignment_events (assignment_id, tool_id, occurred_at, actor, action, summary)
           SELECT ?1, ?2, ?3, ?4, 'sync', ?5 WHERE EXISTS (SELECT 1 FROM tool_assignments WHERE id = ?1)`
        ).bind(allocated.id, t.id, now, SYSTEM, clip(`Recorded from Equipment Inventory: ${t.name} is with ${t.holder_name || holder}`)),
      ]);
    } catch (err) {
      // Another request recorded it first (the one-Active-per-item index): nothing to do.
      if (!/UNIQUE/i.test(String(err && err.message))) throw err;
    }
  }
}

/* ---------- GET /api/tool-assignments ---------- */

export async function listToolAssignments(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: 25, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !FILTER_STATUSES.includes(status)) return fail('invalid_parameter', `\`status\` must be one of: ${FILTER_STATUSES.join(', ')}.`, 400);
  const assigneeId = url.searchParams.get('assigneeId') || null;
  if (assigneeId !== null && !PERSON_ID.test(assigneeId)) return fail('invalid_parameter', '`assigneeId` is not a valid staff or mechanic id.', 400);
  const toolId = url.searchParams.get('toolId') || null;
  if (toolId !== null && readRecordId(toolId).error) return fail('invalid_parameter', '`toolId` is not a valid equipment id.', 400);
  const range = {};
  for (const k of ['from', 'to']) {
    const r = readDate(Object.fromEntries(url.searchParams), k, { fallback: '' });
    if (r.error) return fail('invalid_parameter', `\`${k}\` must be a date in YYYY-MM-DD form.`, 400);
    range[k] = r.value || null;
  }
  if (range.from && range.to && range.to < range.from) return fail('invalid_parameter', '`to` must be on or after `from`.', 400);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > LIMITS.q) return fail('invalid_parameter', `\`q\` must be ${LIMITS.q} characters or fewer.`, 400);
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const today = todayInDhaka();

  try {
    await reconcile(env);
    // ?1 status ?2 assignee ?3 tool ?4 from ?5 to ?6 needle ?7 today
    const where = `
      WHERE (?1 IS NULL
             OR (?1 IN ('Active', 'Returned', 'Cancelled') AND status = ?1)
             OR (?1 = 'Overdue' AND status = 'Active' AND expected_return_date IS NOT NULL AND expected_return_date < ?7))
        AND (?2 IS NULL OR assignee_id = ?2)
        AND (?3 IS NULL OR tool_id = ?3)
        AND (?4 IS NULL OR assigned_date >= ?4)
        AND (?5 IS NULL OR assigned_date <= ?5)
        AND (?6 IS NULL OR lower(id) LIKE ?6 ESCAPE '\\' OR lower(tool_name) LIKE ?6 ESCAPE '\\' OR lower(tool_id) LIKE ?6 ESCAPE '\\'
             OR lower(assignee_name) LIKE ?6 ESCAPE '\\' OR lower(assignee_id) LIKE ?6 ESCAPE '\\'
             OR lower(coalesce(purpose, '')) LIKE ?6 ESCAPE '\\' OR lower(coalesce(work_location, '')) LIKE ?6 ESCAPE '\\')`;
    const binds = [status, assigneeId, toolId, range.from, range.to, needle, today];
    // Active first (overdue, then soonest due), then the rest newest first.
    const order = `ORDER BY CASE WHEN status = 'Active' THEN 0 ELSE 1 END,
                            CASE WHEN status = 'Active' THEN coalesce(expected_return_date, '9999-12-31') END ASC,
                            assigned_date DESC, id DESC`;
    const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM tool_assignments ${where} ${order} LIMIT ?8 OFFSET ?9`)
      .bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM tool_assignments ${where}`).bind(...binds).first();
    const sums = await env.DB.prepare(
      `SELECT count(*) AS total,
              coalesce(sum(status = 'Active'), 0) AS active,
              coalesce(sum(status = 'Active' AND expected_return_date IS NOT NULL AND expected_return_date < ?1), 0) AS overdue,
              coalesce(sum(status = 'Returned'), 0) AS returned,
              coalesce(sum(status = 'Cancelled'), 0) AS cancelled
         FROM tool_assignments`
    ).bind(today).first();
    const tools = await env.DB.prepare(
      `SELECT coalesce(sum(status = 'Available' AND NOT EXISTS (
                SELECT 1 FROM tool_maintenance m WHERE m.tool_id = tools.id AND m.status = 'In Progress')), 0) AS available,
              coalesce(sum(status = 'In Use'), 0) AS in_use,
              coalesce(sum(status <> 'Retired'), 0) AS in_service
         FROM tools`
    ).first();
    const rows = (results || []).map((r) => toRecord(r, today));
    return ok(rows, {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      summary: {
        total: sums.total, active: sums.active, overdue: sums.overdue, returned: sums.returned, cancelled: sums.cancelled,
        available: tools.available, assignedNow: tools.in_use, inService: tools.in_service,
      },
      today,
    });
  } catch (err) {
    console.error('GET /api/tool-assignments failed:', err && err.message);
    return fail('database_error', 'Could not read the assignments.', 500);
  }
}

/* ---------- GET /api/tool-assignments/:id ---------- */

async function withDetail(env, row) {
  const { results } = await env.DB.prepare(
    'SELECT occurred_at, actor, action, summary FROM tool_assignment_events WHERE assignment_id = ?1 ORDER BY id DESC LIMIT 50'
  ).bind(row.id).all();
  const tool = await env.DB.prepare(
    `SELECT id, name, category, status, condition,
            coalesce((SELECT s.name FROM staff s WHERE s.id = tools.assigned_staff_id),
                     (SELECT m.name FROM mechanics m WHERE m.id = tools.assigned_mechanic_id)) AS holder
       FROM tools WHERE id = ?1`
  ).bind(row.tool_id).first();
  return {
    ...toRecord(row),
    history: (results || []).map((e) => ({ at: e.occurred_at, actor: e.actor || '', action: e.action, summary: e.summary })),
    tool: tool ? { id: tool.id, name: tool.name, category: tool.category, status: tool.status, condition: tool.condition, holder: tool.holder || '' } : null,
  };
}

export async function getToolAssignment(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'An assignment id looks like ASG-0001.', 400);
  try {
    await reconcile(env);
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No assignment with that id.', 404);
    return ok(await withDetail(env, row));
  } catch (err) {
    console.error('GET /api/tool-assignments/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the assignment.', 500);
  }
}

/* ---------- POST /api/tool-assignments ---------- */

export async function createToolAssignment(request, env) {
  if (!env.DB) return noDatabase();
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, CREATE_KEYS);
  const today = todayInDhaka();

  let toolId = null;
  const t = readString(body, 'toolId', { required: true, max: 40 });
  if (t.error || readRecordId(t.value).error) errors.toolId = 'Choose the equipment.'; else toolId = t.value;
  const person = await readPerson(env, body, 'assigneeId', errors, { required: true });
  const ad = readDate(body, 'assignedDate', { fallback: today });
  let assignedDate = null;
  if (ad.error) errors.assignedDate = 'Choose a valid assignment date.';
  else if (ad.value > today) errors.assignedDate = 'The assignment date cannot be in the future.';
  else if (ad.value < EARLIEST) errors.assignedDate = `The date cannot be before ${EARLIEST}.`;
  else assignedDate = ad.value;
  const er = readDate(body, 'expectedReturnDate', { fallback: '' });
  let expectedReturn = null;
  if (er.error) errors.expectedReturnDate = 'Choose a valid return date.';
  else if (er.value && assignedDate && er.value < assignedDate) errors.expectedReturnDate = 'The expected return cannot be before the assignment date.';
  else if (er.value && er.value > addDays(today, MAX_DAYS_AHEAD)) errors.expectedReturnDate = 'The expected return is too far ahead.';
  else expectedReturn = er.value || null;
  const text = {};
  for (const [key, max] of [['purpose', LIMITS.purpose], ['workLocation', LIMITS.workLocation], ['notes', LIMITS.notes]]) {
    const r = readString(body, key, { max });
    if (r.error) errors[key] = `Keep this to ${max} characters or fewer.`; else text[key] = r.value || null;
  }
  const cb = readEnum(body, 'conditionBefore', USABLE_CONDITIONS, { fallback: null });
  if (cb.error) errors.conditionBefore = 'Equipment handed out must be in Excellent, Good or Fair condition.';
  if (Object.keys(errors).length) return unprocessable('The equipment could not be assigned.', errors);

  try {
    await reconcile(env);
    const tool = await findTool(env, toolId);
    if (!tool) return unprocessable('The equipment could not be assigned.', { toolId: 'No equipment with that id.' });
    if (tool.status !== 'Available') {
      const why = {
        'In Use': 'It is already assigned. Return it first.',
        'Under Maintenance': 'It is under maintenance.',
        Damaged: 'It is marked Damaged.',
        Retired: 'It is retired.',
      }[tool.status] || `It is ${tool.status}.`;
      return conflict(`${tool.name} cannot be assigned: ${why}`, { reason: 'tool_not_available', status: tool.status });
    }
    const working = await env.DB.prepare(
      `SELECT id FROM tool_maintenance WHERE tool_id = ?1 AND status = 'In Progress' LIMIT 1`
    ).bind(tool.id).first();
    if (working) return conflict(`${tool.name} cannot be assigned: maintenance ${working.id} is in progress on it.`, { reason: 'maintenance_in_progress' });
    const conditionBefore = cb.value || tool.condition;
    if (!USABLE_CONDITIONS.includes(conditionBefore)) {
      return unprocessable('The equipment could not be assigned.', { conditionBefore: 'Equipment handed out must be in Excellent, Good or Fair condition.' });
    }

    const allocated = await allocateId(env, 'toolAssignments');
    if (allocated.error) throw new Error(allocated.error);
    const now = nowIso();
    const who = actorName(request);
    const blocked = await runBatch(env, [
      toolTripwire(env, tool.id, tool.stamp),
      env.DB.prepare(
        `UPDATE tools SET status = 'In Use', assigned_staff_id = ?2, assigned_mechanic_id = ?3, condition = ?4,
                updated_at = ?5, updated_by = ?6 WHERE id = ?1`
      ).bind(tool.id, person.type === 'staff' ? person.id : null, person.type === 'mechanic' ? person.id : null, conditionBefore, now, who),
      toolEvent(env, tool.id, now, who, 'assign', `Assigned to ${person.name} (${person.id}) — ${allocated.id}${expectedReturn ? `, due back ${expectedReturn}` : ''}`),
      env.DB.prepare(
        `INSERT INTO tool_assignments (id, tool_id, tool_name, assignee_type, assignee_id, assignee_name, status, source,
           assigned_date, expected_return_date, purpose, work_location, condition_before, notes, created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Active', 'Assignment', ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?14)`
      ).bind(allocated.id, tool.id, tool.name, person.type, person.id, person.name, assignedDate, expectedReturn,
        text.purpose, text.workLocation, conditionBefore, text.notes, who, now),
      assignmentEvent(env, allocated.id, tool.id, now, who, 'create',
        `Assigned ${tool.name} to ${person.name} on ${assignedDate}${expectedReturn ? `, due back ${expectedReturn}` : ''} (condition ${conditionBefore})`),
    ]);
    if (blocked) return blocked;
    return ok(await withDetail(env, await findRow(env, allocated.id)), {}, 201);
  } catch (err) {
    console.error('POST /api/tool-assignments failed:', err && err.message);
    return fail('database_error', 'Could not assign the equipment.', 500);
  }
}

/* ---------- PUT /api/tool-assignments/:id ---------- */

const LABEL_OF = { expected_return_date: 'expected return', purpose: 'purpose', work_location: 'work location', notes: 'notes' };

export async function updateToolAssignment(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'An assignment id looks like ASG-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, UPDATE_KEYS);
  readExpected(body, errors);
  const person = body.assigneeId !== undefined ? await readPerson(env, body, 'assigneeId', errors, { required: true }) : null;
  const sets = {};
  if (body.expectedReturnDate !== undefined) {
    const er = readDate(body, 'expectedReturnDate', { fallback: '' });
    if (er.error) errors.expectedReturnDate = 'Choose a valid return date.';
    else if (er.value && er.value > addDays(todayInDhaka(), MAX_DAYS_AHEAD)) errors.expectedReturnDate = 'The expected return is too far ahead.';
    else sets.expected_return_date = er.value || null;
  }
  for (const [key, col, max] of [['purpose', 'purpose', LIMITS.purpose], ['workLocation', 'work_location', LIMITS.workLocation], ['notes', 'notes', LIMITS.notes]]) {
    if (body[key] === undefined) continue;
    const r = readString(body, key, { max });
    if (r.error) errors[key] = `Keep this to ${max} characters or fewer.`; else sets[col] = r.value || null;
  }
  if (Object.keys(errors).length) return unprocessable('The assignment could not be updated.', errors);

  try {
    await reconcile(env);
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No assignment with that id.', 404);
    if (row.status !== 'Active') return conflict(`A ${row.status.toLowerCase()} assignment cannot be edited.`, { reason: 'assignment_closed' });
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();
    if (sets.expected_return_date && sets.expected_return_date < row.assigned_date) {
      return unprocessable('The assignment could not be updated.', { expectedReturnDate: 'The expected return cannot be before the assignment date.' });
    }
    for (const k of Object.keys(sets)) if ((row[k] ?? null) === (sets[k] ?? null)) delete sets[k];
    const handOver = person && person.id !== row.assignee_id;
    if (!Object.keys(sets).length && !handOver) return ok(await withDetail(env, row));

    const who = actorName(request);
    let now = nowIso();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
    if (handOver) Object.assign(sets, { assignee_type: person.type, assignee_id: person.id, assignee_name: person.name });
    const names = Object.keys(sets);
    const statements = [assignmentTripwire(env, row.id, row.updated_at)];
    if (handOver) {
      const tool = await findTool(env, row.tool_id);
      if (!tool) return conflict('The equipment is no longer in the register.', { reason: 'tool_missing' });
      statements.push(
        toolTripwire(env, tool.id, tool.stamp),
        env.DB.prepare(
          `UPDATE tools SET assigned_staff_id = ?2, assigned_mechanic_id = ?3, updated_at = ?4, updated_by = ?5 WHERE id = ?1`
        ).bind(tool.id, person.type === 'staff' ? person.id : null, person.type === 'mechanic' ? person.id : null, now, who),
        toolEvent(env, tool.id, now, who, 'assign', `Handed over from ${row.assignee_name} to ${person.name} (${person.id}) — ${row.id}`),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE tool_assignments SET ${names.map((n, i) => `${n} = ?${i + 4}`).join(', ')}, updated_at = ?2, updated_by = ?3 WHERE id = ?1`
      ).bind(row.id, now, who, ...names.map((n) => sets[n])),
      assignmentEvent(env, row.id, row.tool_id, now, who, 'update', handOver
        ? `Handed over from ${row.assignee_name} to ${person.name}${names.length > 3 ? `; edited ${names.filter((n) => LABEL_OF[n]).map((n) => LABEL_OF[n]).join(', ')}` : ''}`
        : `Edited: ${names.map((n) => LABEL_OF[n]).join(', ')}`),
    );
    const blocked = await runBatch(env, statements);
    if (blocked) return blocked;
    return ok(await withDetail(env, await findRow(env, row.id)));
  } catch (err) {
    console.error('PUT /api/tool-assignments/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the assignment.', 500);
  }
}

/* ---------- POST /api/tool-assignments/:id/return ---------- */

export async function returnToolAssignment(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'An assignment id looks like ASG-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, RETURN_KEYS);
  readExpected(body, errors);
  const today = todayInDhaka();
  let returnDate = null;
  const rd = readDate(body, 'returnDate', { required: true });
  if (rd.error) errors.returnDate = 'Enter the day it came back.';
  else if (rd.value > today) errors.returnDate = 'The return date cannot be in the future.';
  else returnDate = rd.value;
  const ca = readEnum(body, 'conditionAfter', CONDITIONS, { required: true });
  if (ca.error) errors.conditionAfter = 'Choose its condition now.';
  let statusAfter = null;
  if (!ca.error) {
    const sa = readEnum(body, 'statusAfter', statusesAfterReturn(ca.value), { fallback: defaultStatusAfterReturn(ca.value) });
    if (sa.error) errors.statusAfter = `In ${ca.value} condition it can be: ${statusesAfterReturn(ca.value).join(', ')}.`;
    else statusAfter = sa.value;
  }
  const text = {};
  for (const [key, max] of [['damageNotes', LIMITS.damageNotes], ['returnNotes', LIMITS.returnNotes]]) {
    const r = readString(body, key, { max });
    if (r.error) errors[key] = `Keep this to ${max} characters or fewer.`; else text[key] = r.value || null;
  }
  const receiver = await readPerson(env, body, 'receivedById', errors);
  if (Object.keys(errors).length) return unprocessable('The return could not be recorded.', errors);

  try {
    await reconcile(env);
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No assignment with that id.', 404);
    if (row.status !== 'Active') return conflict(`This assignment is already ${row.status.toLowerCase()}.`, { reason: 'assignment_closed' });
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();
    if (returnDate < row.assigned_date) return unprocessable('The return could not be recorded.', { returnDate: 'The return date cannot be before the assignment date.' });
    const tool = await findTool(env, row.tool_id);
    const who = actorName(request);
    let now = nowIso();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
    const statements = [assignmentTripwire(env, row.id, row.updated_at)];
    if (tool) {
      statements.push(
        toolTripwire(env, tool.id, tool.stamp),
        env.DB.prepare(
          `UPDATE tools SET status = ?2, condition = ?3, assigned_staff_id = NULL, assigned_mechanic_id = NULL,
                  updated_at = ?4, updated_by = ?5 WHERE id = ?1`
        ).bind(tool.id, statusAfter, ca.value, now, who),
        toolEvent(env, tool.id, now, who, 'return',
          `Returned by ${row.assignee_name} on ${returnDate} (${row.id}), condition ${ca.value}; now ${statusAfter}${text.damageNotes ? `. Damage: ${text.damageNotes}` : ''}`),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE tool_assignments SET status = 'Returned', return_date = ?4, condition_after = ?5, damage_notes = ?6, return_notes = ?7,
                received_by_id = ?8, received_by_name = ?9, returned_at = ?2, updated_at = ?2, updated_by = ?3 WHERE id = ?1`
      ).bind(row.id, now, who, returnDate, ca.value, text.damageNotes, text.returnNotes, receiver ? receiver.id : null, receiver ? receiver.name : null),
      assignmentEvent(env, row.id, row.tool_id, now, who, 'return',
        `Returned on ${returnDate}, condition ${ca.value}; equipment now ${statusAfter}${receiver ? `; received by ${receiver.name}` : ''}${text.damageNotes ? `; damage: ${text.damageNotes}` : ''}`),
    );
    const blocked = await runBatch(env, statements);
    if (blocked) return blocked;
    return ok(await withDetail(env, await findRow(env, row.id)));
  } catch (err) {
    console.error('POST /api/tool-assignments/:id/return failed:', err && err.message);
    return fail('database_error', 'Could not record the return.', 500);
  }
}

/* ---------- POST /api/tool-assignments/:id/cancel ---------- */

export async function cancelToolAssignment(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'An assignment id looks like ASG-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, CANCEL_KEYS);
  readExpected(body, errors);
  const r = readString(body, 'reason', { max: LIMITS.reason });
  if (r.error) errors.reason = `Keep this to ${LIMITS.reason} characters or fewer.`;
  else if (!r.value) errors.reason = 'Please give a reason for cancelling.';
  if (Object.keys(errors).length) return unprocessable('The assignment could not be cancelled.', errors);

  try {
    await reconcile(env);
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No assignment with that id.', 404);
    if (row.status !== 'Active') return conflict(`This assignment is already ${row.status.toLowerCase()}.`, { reason: 'assignment_closed' });
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();
    const tool = await findTool(env, row.tool_id);
    const who = actorName(request);
    let now = nowIso();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
    // Back to the shelf as it was: Available when its condition allows, else Under Maintenance.
    const back = tool && USABLE_CONDITIONS.includes(tool.condition) ? 'Available' : 'Under Maintenance';
    const statements = [assignmentTripwire(env, row.id, row.updated_at)];
    if (tool) {
      statements.push(
        toolTripwire(env, tool.id, tool.stamp),
        env.DB.prepare(
          `UPDATE tools SET status = ?2, assigned_staff_id = NULL, assigned_mechanic_id = NULL, updated_at = ?3, updated_by = ?4 WHERE id = ?1`
        ).bind(tool.id, back, now, who),
        toolEvent(env, tool.id, now, who, 'return', `Assignment ${row.id} to ${row.assignee_name} cancelled: ${r.value}; now ${back}`),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE tool_assignments SET status = 'Cancelled', cancel_reason = ?4, cancelled_at = ?2, updated_at = ?2, updated_by = ?3 WHERE id = ?1`
      ).bind(row.id, now, who, r.value),
      assignmentEvent(env, row.id, row.tool_id, now, who, 'cancel', `Cancelled: ${r.value}`),
    );
    const blocked = await runBatch(env, statements);
    if (blocked) return blocked;
    return ok(await withDetail(env, await findRow(env, row.id)));
  } catch (err) {
    console.error('POST /api/tool-assignments/:id/cancel failed:', err && err.message);
    return fail('database_error', 'Could not cancel the assignment.', 500);
  }
}
