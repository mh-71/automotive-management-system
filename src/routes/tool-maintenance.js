/* ============================================================
   routes/tool-maintenance.js — /api/tool-maintenance   (migration 0024)
   ------------------------------------------------------------
   Workshop Assets › Maintenance & Repairs: one row per service,
   inspection, calibration or repair of a piece of equipment in the
   existing `tools` register (0013 / 0021).

     GET    /api/tool-maintenance            list -- q, status, type, toolId,
                                             from, to (scheduled date), limit,
                                             offset; meta.summary counts the whole
                                             register, meta.panels the upcoming,
                                             overdue and recent-repair lists
     GET    /api/tool-maintenance/:id        one job, with its history and the
                                             equipment as it is now
     POST   /api/tool-maintenance            schedule a job (status Scheduled)
     PUT    /api/tool-maintenance/:id        edit a Scheduled / In Progress job;
                                             `expectedUpdatedAt` is required
     POST   /api/tool-maintenance/:id/status { to, expectedUpdatedAt, ... }:
                                             Scheduled -> In Progress | Completed |
                                             Cancelled; In Progress -> Completed |
                                             Cancelled. Completed and Cancelled are final.
     DELETE /api/tool-maintenance/:id        ?expectedUpdatedAt -- a job entered by
                                             mistake, only while Scheduled or
                                             Cancelled (tools.delete). Its history stays.

   "Due soon" (within SOON_DAYS) and "Overdue" are worked out from the
   scheduled date and today in Dhaka -- never stored, never stale.

   The equipment is kept in step, through the same rules as /api/tools:
     * starting a job (takeOutOfService, default yes) marks the equipment
       Under Maintenance and ends any assignment -- an Available, In Use or
       Damaged item only; Retired equipment cannot be maintained;
     * completing a job records the equipment's last service date (and the
       next service due, when given) and, if no other job on it is still in
       progress, puts it back to Available when its condition allows (else
       it stays Under Maintenance for staff to decide);
     * cancelling a started job puts the equipment back the same way.
   Each of those changes is written to tool_events (the equipment's own
   history) in the SAME batch as the job, and the job's own history goes to
   tool_maintenance_events. If the job or the equipment changed after the
   caller read them, the whole batch rolls back (a NOT NULL tripwire, as in
   job-cards.js) and the answer is 409 -- never half a change.

   Permissions (the existing Workshop Assets module, no new ones):
   view tools.view; create / edit / status tools.edit; delete tools.delete.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, readEnum, readDate, nowIso, todayInDhaka, allocateId,
} from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { can } from '../lib/permissions.js';

export const MAINTENANCE_TYPES = ['Preventive Service', 'Inspection', 'Calibration', 'Repair'];
export const PRIORITIES = ['Normal', 'High', 'Urgent'];
export const MAINTENANCE_STATUSES = ['Scheduled', 'In Progress', 'Completed', 'Cancelled'];
/** What the list's status filter accepts: the stored four plus the two worked out from the date. */
export const FILTER_STATUSES = ['Scheduled', 'Due Soon', 'Overdue', 'In Progress', 'Completed', 'Cancelled'];
export const TRANSITIONS = {
  Scheduled: ['In Progress', 'Completed', 'Cancelled'],
  'In Progress': ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};
/** Days ahead that count as "due soon" (the same as the equipment's own "Due soon", tools.js). */
export const SOON_DAYS = 14;
/** Days ahead the "Upcoming Maintenance" panel looks. */
const UPCOMING_DAYS = 30;
const OPEN = ['Scheduled', 'In Progress'];
const USABLE_CONDITIONS = ['Excellent', 'Good', 'Fair'];
/** Equipment a started job takes out of service. Under Maintenance already is; Retired cannot be. */
const TAKEABLE = ['Available', 'In Use', 'Damaged'];
const MAX_COST = 100000000;
const EARLIEST = '2000-01-01';
const MAX_DAYS_AHEAD = 3 * 366;
const LIMITS = { description: 1000, workDone: 1000, vendor: 120, reason: 300, q: 100 };
const PERSON_ID = /^[A-Z]{3}-\d{4,}$/;
const MNT_ID = /^MNT-\d{1,10}$/;

const CREATE_KEYS = ['toolId', 'maintenanceType', 'priority', 'scheduledDate', 'technicianId', 'vendor', 'estimatedCost', 'description'];
const UPDATE_KEYS = [...CREATE_KEYS, 'expectedUpdatedAt'];
const STATUS_KEYS = ['to', 'expectedUpdatedAt', 'completedDate', 'actualCost', 'workDone', 'nextServiceDue', 'reason', 'takeOutOfService'];

const COLUMNS = `id, tool_id, tool_name, maintenance_type, priority, status, scheduled_date, technician_id, technician_name,
  vendor, estimated_cost, actual_cost, description, work_done, started_at, completed_date, next_service_due, cancel_reason,
  created_by, updated_by, created_at, updated_at, completed_at, cancelled_at,
  (SELECT t.status FROM tools t WHERE t.id = tool_maintenance.tool_id) AS tool_status`;

/* ---------- helpers ---------- */

function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Overdue / Due Soon for a Scheduled job; otherwise its status. Derived, never stored. */
export function dueState(row, today = todayInDhaka()) {
  if (row.status !== 'Scheduled') return row.status;
  if (row.scheduled_date < today) return 'Overdue';
  if (row.scheduled_date <= addDays(today, SOON_DAYS)) return 'Due Soon';
  return 'Scheduled';
}

function toRecord(row, today = todayInDhaka()) {
  return {
    id: row.id,
    toolId: row.tool_id,
    toolName: row.tool_name,
    toolStatus: row.tool_status ?? null,          // null: the equipment has since been deleted
    maintenanceType: row.maintenance_type,
    priority: row.priority,
    status: row.status,
    dueState: dueState(row, today),
    scheduledDate: row.scheduled_date,
    technicianId: row.technician_id ?? '',
    technicianName: row.technician_name ?? '',
    vendor: row.vendor ?? '',
    estimatedCost: row.estimated_cost ?? null,
    actualCost: row.actual_cost ?? null,
    description: row.description ?? '',
    workDone: row.work_done ?? '',
    startedAt: row.started_at ?? null,
    completedDate: row.completed_date ?? '',
    nextServiceDue: row.next_service_due ?? '',
    cancelReason: row.cancel_reason ?? '',
    createdBy: row.created_by ?? '',
    updatedBy: row.updated_by ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
  };
}

/** The caller as the record names them (the same rule as tools.js). */
function actorName(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') return String(p.username || p.id || 'Account').slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  if (p.kind === 'token') return 'API token';
  return null;
}

const clip = (s) => String(s).slice(0, 300);
const money = (n) => `৳${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) if (!allowed.includes(key)) errors[key] = 'This field cannot be set here.';
  return errors;
}

const readId = (raw) => (typeof raw === 'string' && MNT_ID.test(raw) ? raw : null);
const findRow = (env, id) => env.DB.prepare(`SELECT ${COLUMNS} FROM tool_maintenance WHERE id = ?1`).bind(id).first();
const staleConflict = () => conflict('This maintenance record was changed by someone else after you opened it. Reload it and try again.', { reason: 'concurrent_modification' });

async function findTool(env, id) {
  return env.DB.prepare(
    `SELECT id, name, status, condition, assigned_staff_id, assigned_mechanic_id, last_service_date, next_service_due,
            coalesce(updated_at, created_at) AS stamp
       FROM tools WHERE id = ?1`
  ).bind(id).first();
}

/** An ACTIVE employee (not a mechanic's own staff profile) or mechanic, or null. */
async function activeTechnician(env, id) {
  return env.DB.prepare(
    `SELECT id, name FROM staff WHERE id = ?1 AND mechanic_id IS NULL AND status = 'Active'
     UNION ALL
     SELECT id, name FROM mechanics WHERE id = ?1 AND status = 'Active'
     LIMIT 1`
  ).bind(id).first();
}

/** Validate the job's own fields. `partial` for an edit: only what was sent. */
async function readFields(env, body, { partial = false, current = null } = {}) {
  const errors = {};
  const v = {};
  const has = (k) => body[k] !== undefined;
  const today = todayInDhaka();

  if (!partial || has('toolId')) {
    const r = readString(body, 'toolId', { required: true, max: 40 });
    if (r.error) errors.toolId = 'Choose the equipment.';
    else {
      const id = readRecordId(r.value);
      if (id.error) errors.toolId = 'Choose the equipment.';
      else v.toolId = id.value;
    }
  }
  if (!partial || has('maintenanceType')) {
    const r = readEnum(body, 'maintenanceType', MAINTENANCE_TYPES, { required: true });
    if (r.error) errors.maintenanceType = `Choose one of: ${MAINTENANCE_TYPES.join(', ')}.`; else v.maintenanceType = r.value;
  }
  if (!partial || has('priority')) {
    const r = readEnum(body, 'priority', PRIORITIES, { fallback: 'Normal' });
    if (r.error) errors.priority = `Choose one of: ${PRIORITIES.join(', ')}.`; else v.priority = r.value || 'Normal';
  }
  if (!partial || has('scheduledDate')) {
    const r = readDate(body, 'scheduledDate', { required: true });
    if (r.error) errors.scheduledDate = 'Choose a valid service date.';
    else if (r.value < EARLIEST) errors.scheduledDate = `The date cannot be before ${EARLIEST}.`;
    else if (r.value > addDays(today, MAX_DAYS_AHEAD)) errors.scheduledDate = 'The date is too far in the future.';
    else v.scheduledDate = r.value;
  }
  if (!partial || has('technicianId')) {
    if (body.technicianId === null || body.technicianId === '' || body.technicianId === undefined) {
      v.technicianId = null; v.technicianName = null;
    } else if (typeof body.technicianId !== 'string' || !PERSON_ID.test(body.technicianId)) {
      errors.technicianId = 'Choose a member of staff or a mechanic.';
    } else {
      const person = await activeTechnician(env, body.technicianId);
      if (!person) errors.technicianId = 'That is not an active member of staff or mechanic.';
      else { v.technicianId = person.id; v.technicianName = String(person.name || person.id).slice(0, 120); }
    }
  }
  if (!partial || has('vendor')) {
    const r = readString(body, 'vendor', { max: LIMITS.vendor });
    if (r.error) errors.vendor = `Keep this to ${LIMITS.vendor} characters or fewer.`; else v.vendor = r.value || null;
  }
  if (!partial || has('estimatedCost')) {
    const r = readNumber(body, 'estimatedCost', { min: 0, max: MAX_COST });
    if (r.error) errors.estimatedCost = 'Enter a cost of 0 or more.'; else v.estimatedCost = r.value;
  }
  if (!partial || has('description')) {
    const r = readString(body, 'description', { max: LIMITS.description });
    if (r.error) errors.description = `Keep this to ${LIMITS.description} characters or fewer.`; else v.description = r.value || null;
  }

  // The equipment must exist and be in service (a job on retired equipment is refused).
  if (v.toolId && (!current || v.toolId !== current.tool_id)) {
    const tool = await findTool(env, v.toolId);
    if (!tool) errors.toolId = 'No equipment with that id.';
    else if (tool.status === 'Retired') errors.toolId = 'That equipment is retired. Reactivate it first.';
    else v.toolName = tool.name;
  }
  return { values: v, errors };
}

/* ---------- GET /api/tool-maintenance ---------- */

export async function listToolMaintenance(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: 25, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !FILTER_STATUSES.includes(status)) return fail('invalid_parameter', `\`status\` must be one of: ${FILTER_STATUSES.join(', ')}.`, 400);
  const type = url.searchParams.get('type') || null;
  if (type !== null && !MAINTENANCE_TYPES.includes(type)) return fail('invalid_parameter', `\`type\` must be one of: ${MAINTENANCE_TYPES.join(', ')}.`, 400);
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
  const soon = addDays(today, SOON_DAYS);
  // ?1 status ?2 type ?3 tool ?4 from ?5 to ?6 needle ?7 today ?8 soon
  const where = `
    WHERE (?1 IS NULL
           OR (?1 IN ('Scheduled', 'In Progress', 'Completed', 'Cancelled') AND status = ?1)
           OR (?1 = 'Due Soon' AND status = 'Scheduled' AND scheduled_date >= ?7 AND scheduled_date <= ?8)
           OR (?1 = 'Overdue' AND status = 'Scheduled' AND scheduled_date < ?7))
      AND (?2 IS NULL OR maintenance_type = ?2)
      AND (?3 IS NULL OR tool_id = ?3)
      AND (?4 IS NULL OR scheduled_date >= ?4)
      AND (?5 IS NULL OR scheduled_date <= ?5)
      AND (?6 IS NULL OR lower(id) LIKE ?6 ESCAPE '\\' OR lower(tool_name) LIKE ?6 ESCAPE '\\' OR lower(tool_id) LIKE ?6 ESCAPE '\\'
           OR lower(maintenance_type) LIKE ?6 ESCAPE '\\' OR lower(coalesce(technician_name, '')) LIKE ?6 ESCAPE '\\'
           OR lower(coalesce(vendor, '')) LIKE ?6 ESCAPE '\\' OR lower(coalesce(description, '')) LIKE ?6 ESCAPE '\\')`;
  const binds = [status, type, toolId, range.from, range.to, needle, today, soon];
  // Open jobs first, soonest first; then closed ones, newest first.
  const order = `ORDER BY CASE WHEN status IN ('Scheduled', 'In Progress') THEN 0 ELSE 1 END,
                          CASE WHEN status IN ('Scheduled', 'In Progress') THEN scheduled_date END ASC,
                          coalesce(completed_date, scheduled_date) DESC, id DESC`;
  try {
    const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM tool_maintenance ${where} ${order} LIMIT ?9 OFFSET ?10`)
      .bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM tool_maintenance ${where}`).bind(...binds).first();
    const sums = await env.DB.prepare(
      `SELECT count(*) AS total,
              coalesce(sum(status = 'Scheduled'), 0) AS scheduled,
              coalesce(sum(status = 'Scheduled' AND scheduled_date >= ?1 AND scheduled_date <= ?2), 0) AS due_soon,
              coalesce(sum(status = 'Scheduled' AND scheduled_date < ?1), 0) AS overdue,
              coalesce(sum(status = 'In Progress'), 0) AS in_progress,
              coalesce(sum(status = 'Completed'), 0) AS completed,
              coalesce(sum(status = 'Cancelled'), 0) AS cancelled,
              coalesce(sum(CASE WHEN status = 'Completed' THEN actual_cost END), 0) AS spent,
              coalesce(sum(CASE WHEN status IN ('Scheduled', 'In Progress') THEN estimated_cost END), 0) AS estimated_open
         FROM tool_maintenance`
    ).bind(today, soon).first();
    const panel = async (sql, ...b) => ((await env.DB.prepare(`SELECT ${COLUMNS} FROM tool_maintenance ${sql}`).bind(...b).all()).results || []).map((r) => toRecord(r, today));
    const panels = {
      upcoming: await panel(`WHERE status = 'Scheduled' AND scheduled_date >= ?1 AND scheduled_date <= ?2 ORDER BY scheduled_date, id LIMIT 5`, today, addDays(today, UPCOMING_DAYS)),
      overdue: await panel(`WHERE status = 'Scheduled' AND scheduled_date < ?1 ORDER BY scheduled_date, id LIMIT 5`, today),
      recentRepairs: await panel(`WHERE status = 'Completed' AND maintenance_type = 'Repair' ORDER BY completed_date DESC, id DESC LIMIT 5`),
    };
    const rows = (results || []).map((r) => toRecord(r, today));
    return ok(rows, {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      summary: {
        total: sums.total, scheduled: sums.scheduled, dueSoon: sums.due_soon, overdue: sums.overdue,
        inProgress: sums.in_progress, completed: sums.completed, cancelled: sums.cancelled,
        totalCost: sums.spent, estimatedOpenCost: sums.estimated_open,
      },
      panels,
      today,
    });
  } catch (err) {
    console.error('GET /api/tool-maintenance failed:', err && err.message);
    return fail('database_error', 'Could not read the maintenance records.', 500);
  }
}

/* ---------- GET /api/tool-maintenance/:id ---------- */

async function withDetail(env, row) {
  const { results } = await env.DB.prepare(
    'SELECT occurred_at, actor, action, summary FROM tool_maintenance_events WHERE maintenance_id = ?1 ORDER BY id DESC LIMIT 50'
  ).bind(row.id).all();
  const tool = await env.DB.prepare(
    'SELECT id, name, category, status, condition, last_service_date, next_service_due FROM tools WHERE id = ?1'
  ).bind(row.tool_id).first();
  return {
    ...toRecord(row),
    allowedStatuses: TRANSITIONS[row.status] || [],
    history: (results || []).map((e) => ({ at: e.occurred_at, actor: e.actor || '', action: e.action, summary: e.summary })),
    tool: tool ? {
      id: tool.id, name: tool.name, category: tool.category, status: tool.status, condition: tool.condition,
      lastServiceDate: tool.last_service_date ?? '', nextServiceDue: tool.next_service_due ?? '',
    } : null,
  };
}

export async function getToolMaintenance(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'A maintenance record id looks like MNT-0001.', 400);
  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No maintenance record with that id.', 404);
    return ok(await withDetail(env, row));
  } catch (err) {
    console.error('GET /api/tool-maintenance/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the maintenance record.', 500);
  }
}

/* ---------- POST /api/tool-maintenance ---------- */

export async function createToolMaintenance(request, env) {
  if (!env.DB) return noDatabase();
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const unknown = unknownKeys(body, CREATE_KEYS);
  const { values: v, errors } = await readFields(env, body);
  Object.assign(errors, unknown);
  if (Object.keys(errors).length) return unprocessable('The maintenance could not be scheduled.', errors);
  try {
    const allocated = await allocateId(env, 'toolMaintenance');
    if (allocated.error) throw new Error(allocated.error);
    const now = nowIso();
    const who = actorName(request);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tool_maintenance (id, tool_id, tool_name, maintenance_type, priority, status, scheduled_date,
           technician_id, technician_name, vendor, estimated_cost, description, created_by, updated_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'Scheduled', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13, ?13)`
      ).bind(allocated.id, v.toolId, v.toolName, v.maintenanceType, v.priority, v.scheduledDate,
        v.technicianId, v.technicianName, v.vendor, v.estimatedCost, v.description, who, now),
      env.DB.prepare(
        `INSERT INTO tool_maintenance_events (maintenance_id, tool_id, occurred_at, actor, action, summary)
         VALUES (?1, ?2, ?3, ?4, 'create', ?5)`
      ).bind(allocated.id, v.toolId, now, who,
        clip(`Scheduled ${v.maintenanceType} of ${v.toolName} for ${v.scheduledDate}${v.technicianName ? `, ${v.technicianName}` : ''}${v.vendor ? `, ${v.vendor}` : ''}`)),
    ]);
    return ok(await withDetail(env, await findRow(env, allocated.id)), {}, 201);
  } catch (err) {
    console.error('POST /api/tool-maintenance failed:', err && err.message);
    return fail('database_error', 'Could not schedule the maintenance.', 500);
  }
}

/* ---------- PUT /api/tool-maintenance/:id ---------- */

const COLUMN_OF = {
  toolId: 'tool_id', toolName: 'tool_name', maintenanceType: 'maintenance_type', priority: 'priority',
  scheduledDate: 'scheduled_date', technicianId: 'technician_id', technicianName: 'technician_name',
  vendor: 'vendor', estimatedCost: 'estimated_cost', description: 'description',
};
const LABEL_OF = {
  tool_id: 'equipment', maintenance_type: 'type', priority: 'priority', scheduled_date: 'date',
  technician_id: 'technician', vendor: 'vendor', estimated_cost: 'estimated cost', description: 'description',
};

export async function updateToolMaintenance(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'A maintenance record id looks like MNT-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No maintenance record with that id.', 404);
    const errors = unknownKeys(body, UPDATE_KEYS);
    if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt || body.expectedUpdatedAt.length > 40) {
      errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the change was made from.';
    }
    const { values: v, errors: fieldErrors } = await readFields(env, body, { partial: true, current: row });
    Object.assign(errors, fieldErrors);
    if (body.toolId !== undefined && v.toolId && v.toolId !== row.tool_id && row.status !== 'Scheduled') {
      errors.toolId = 'The equipment cannot be changed once the work has started.';
    }
    if (Object.keys(errors).length) return unprocessable('The maintenance record could not be updated.', errors);
    if (!OPEN.includes(row.status)) {
      return conflict(`A ${row.status.toLowerCase()} maintenance record cannot be edited.`, { reason: 'maintenance_closed' });
    }
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();

    const sets = {};
    for (const [k, col] of Object.entries(COLUMN_OF)) {
      if (v[k] === undefined) continue;
      if (k === 'toolName' && v.toolId === row.tool_id) continue;
      if ((row[col] ?? null) !== (v[k] ?? null)) sets[col] = v[k] ?? null;
    }
    if (!Object.keys(sets).length) return ok(await withDetail(env, row));
    const who = actorName(request);
    let now = nowIso();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
    const names = Object.keys(sets);
    const changed = [...new Set(names.map((n) => LABEL_OF[n]).filter(Boolean))];
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tool_maintenance SET ${names.map((n, i) => `${n} = ?${i + 4}`).join(', ')}, updated_at = ?2, updated_by = ?3
          WHERE id = ?1 AND updated_at = ?${names.length + 4} AND status IN ('Scheduled', 'In Progress')`
      ).bind(row.id, now, who, ...names.map((n) => sets[n]), body.expectedUpdatedAt),
      env.DB.prepare(
        `INSERT INTO tool_maintenance_events (maintenance_id, tool_id, occurred_at, actor, action, summary)
         SELECT ?1, tool_id, ?2, ?3, 'update', ?4 FROM tool_maintenance WHERE id = ?1 AND updated_at = ?2`
      ).bind(row.id, now, who, clip(`Edited: ${changed.join(', ')}`)),
    ]);
    if (!results[0].meta || results[0].meta.changes !== 1) return staleConflict();
    return ok(await withDetail(env, await findRow(env, row.id)));
  } catch (err) {
    console.error('PUT /api/tool-maintenance/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the maintenance record.', 500);
  }
}

/* ---------- POST /api/tool-maintenance/:id/status ---------- */

/** Rolls the whole batch back (NOT NULL tripwire) unless the job still carries `stamp`. */
const jobTripwire = (env, id, stamp) => env.DB.prepare(
  'UPDATE tool_maintenance SET tool_id = NULL WHERE id = ?1 AND updated_at IS NOT ?2'
).bind(id, stamp);
/** The same for the equipment row. */
const toolTripwire = (env, id, stamp) => env.DB.prepare(
  'UPDATE tools SET name = NULL WHERE id = ?1 AND coalesce(updated_at, created_at) IS NOT ?2'
).bind(id, stamp);
const toolEvent = (env, toolId, at, who, action, summary) => env.DB.prepare(
  'INSERT INTO tool_events (tool_id, occurred_at, actor, action, summary) VALUES (?1, ?2, ?3, ?4, ?5)'
).bind(toolId, at, who, action, clip(summary));

export async function setToolMaintenanceStatus(request, env, rawId) {
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'A maintenance record id looks like MNT-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = unknownKeys(body, STATUS_KEYS);
  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt || body.expectedUpdatedAt.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the change was made from.';
  }
  if (!['In Progress', 'Completed', 'Cancelled'].includes(body.to)) errors.to = 'Choose In Progress, Completed or Cancelled.';
  const today = todayInDhaka();
  let completedDate = null, actualCost, workDone, nextServiceDue = null, reason = null;
  if (body.to === 'Completed') {
    const d = readDate(body, 'completedDate', { required: true });
    if (d.error) errors.completedDate = 'Enter the day the work was completed.';
    else if (d.value > today) errors.completedDate = 'The completion date cannot be in the future.';
    else if (d.value < EARLIEST) errors.completedDate = `The date cannot be before ${EARLIEST}.`;
    else completedDate = d.value;
    const c = readNumber(body, 'actualCost', { min: 0, max: MAX_COST });
    if (c.error) errors.actualCost = 'Enter a cost of 0 or more.'; else actualCost = c.value;
    const w = readString(body, 'workDone', { max: LIMITS.workDone });
    if (w.error) errors.workDone = `Keep this to ${LIMITS.workDone} characters or fewer.`; else workDone = w.value || null;
    const n = readDate(body, 'nextServiceDue', { fallback: '' });
    if (n.error) errors.nextServiceDue = 'Choose a valid date.';
    else if (n.value && completedDate && n.value <= completedDate) errors.nextServiceDue = 'The next service must be after the completion date.';
    else nextServiceDue = n.value || null;
  } else {
    for (const k of ['completedDate', 'actualCost', 'workDone', 'nextServiceDue']) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '') errors[k] = 'Only sent when completing the work.';
    }
  }
  if (body.to === 'Cancelled') {
    const r = readString(body, 'reason', { max: LIMITS.reason });
    if (r.error) errors.reason = `Keep this to ${LIMITS.reason} characters or fewer.`;
    else if (!r.value) errors.reason = 'Please give a reason for cancelling.';
    else reason = r.value;
  } else if (body.reason !== undefined && body.reason !== null && body.reason !== '') {
    errors.reason = 'Only sent when cancelling.';
  }
  if (body.takeOutOfService !== undefined && typeof body.takeOutOfService !== 'boolean') errors.takeOutOfService = 'Must be true or false.';
  if (Object.keys(errors).length) return unprocessable('The status could not be changed.', errors);

  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No maintenance record with that id.', 404);
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();
    if (!(TRANSITIONS[row.status] || []).includes(body.to)) {
      return conflict(`A ${row.status} maintenance record cannot be marked ${body.to}.`, { reason: 'illegal_status_transition', from: row.status, to: body.to });
    }
    const tool = await findTool(env, row.tool_id);
    if (body.to === 'In Progress' && tool && tool.status === 'Retired') {
      return conflict('That equipment is retired. Reactivate it before starting work on it.', { reason: 'tool_retired' });
    }

    const who = actorName(request);
    let now = nowIso();
    if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
    const statements = [jobTripwire(env, row.id, row.updated_at)];
    const toolSets = {};
    const toolEvents = [];

    // Is another job on this equipment still in progress? Then the equipment stays Under Maintenance.
    const othersInProgress = tool ? (await env.DB.prepare(
      `SELECT count(*) AS n FROM tool_maintenance WHERE tool_id = ?1 AND status = 'In Progress' AND id <> ?2`
    ).bind(tool.id, row.id).first()).n : 0;
    const backInService = () => {
      if (tool && tool.status === 'Under Maintenance' && othersInProgress === 0 && USABLE_CONDITIONS.includes(tool.condition)) {
        toolSets.status = 'Available';
        toolEvents.push(['status', `Under Maintenance → Available (${row.id} ${body.to === 'Completed' ? 'completed' : 'cancelled'})`]);
      }
    };

    let jobSql; let jobBinds; let jobAction; let jobSummary;
    if (body.to === 'In Progress') {
      jobSql = `UPDATE tool_maintenance SET status = 'In Progress', started_at = ?2, updated_at = ?2, updated_by = ?3 WHERE id = ?1`;
      jobBinds = [row.id, now, who];
      jobAction = 'start';
      jobSummary = `Work started on ${row.tool_name}`;
      if (tool && body.takeOutOfService !== false && TAKEABLE.includes(tool.status)) {
        Object.assign(toolSets, { status: 'Under Maintenance', assigned_staff_id: null, assigned_mechanic_id: null });
        toolEvents.push(['status', `${tool.status} → Under Maintenance (${row.id}, ${row.maintenance_type})${tool.assigned_staff_id || tool.assigned_mechanic_id ? '; assignment ended' : ''}`]);
        jobSummary += '; equipment marked Under Maintenance';
      }
    } else if (body.to === 'Completed') {
      jobSql = `UPDATE tool_maintenance SET status = 'Completed', completed_date = ?4, actual_cost = ?5, work_done = ?6,
                       next_service_due = ?7, completed_at = ?2, updated_at = ?2, updated_by = ?3 WHERE id = ?1`;
      jobBinds = [row.id, now, who, completedDate, actualCost ?? null, workDone, nextServiceDue];
      jobAction = 'complete';
      jobSummary = `Completed on ${completedDate}${actualCost != null ? `, cost ${money(actualCost)}` : ''}${nextServiceDue ? `; next service ${nextServiceDue}` : ''}`;
      if (tool && tool.status !== 'Retired') {
        if (!tool.last_service_date || completedDate > tool.last_service_date) toolSets.last_service_date = completedDate;
        if (nextServiceDue) toolSets.next_service_due = nextServiceDue;
        if (toolSets.last_service_date || toolSets.next_service_due) {
          toolEvents.push(['update', `Serviced: ${row.maintenance_type} completed on ${completedDate} (${row.id})${nextServiceDue ? `; next service due ${nextServiceDue}` : ''}`]);
        }
        backInService();
      }
    } else {
      jobSql = `UPDATE tool_maintenance SET status = 'Cancelled', cancel_reason = ?4, cancelled_at = ?2, updated_at = ?2, updated_by = ?3 WHERE id = ?1`;
      jobBinds = [row.id, now, who, reason];
      jobAction = 'cancel';
      jobSummary = `Cancelled: ${reason}`;
      if (row.status === 'In Progress') backInService();
    }
    statements.push(env.DB.prepare(jobSql).bind(...jobBinds));
    statements.push(env.DB.prepare(
      `INSERT INTO tool_maintenance_events (maintenance_id, tool_id, occurred_at, actor, action, summary) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(row.id, row.tool_id, now, who, jobAction, clip(jobSummary)));

    if (tool && Object.keys(toolSets).length) {
      const names = Object.keys(toolSets);
      statements.push(toolTripwire(env, tool.id, tool.stamp));
      statements.push(env.DB.prepare(
        `UPDATE tools SET ${names.map((n, i) => `${n} = ?${i + 4}`).join(', ')}, updated_at = ?2, updated_by = ?3 WHERE id = ?1`
      ).bind(tool.id, now, who, ...names.map((n) => toolSets[n])));
      for (const [action, summary] of toolEvents) statements.push(toolEvent(env, tool.id, now, who, action, summary));
    }

    try {
      await env.DB.batch(statements);
    } catch (err) {
      // A tripwire fired: the job or the equipment changed after it was read. Nothing was saved.
      if (/NOT NULL/i.test(String(err && err.message))) return staleConflict();
      throw err;
    }
    return ok(await withDetail(env, await findRow(env, row.id)));
  } catch (err) {
    console.error('POST /api/tool-maintenance/:id/status failed:', err && err.message);
    return fail('database_error', 'Could not change the status.', 500);
  }
}

/* ---------- DELETE /api/tool-maintenance/:id ---------- */

export async function deleteToolMaintenance(request, env, rawId) {
  if (request.method !== 'DELETE') return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  if (!env.DB) return noDatabase();
  // The router already required tools.delete; checked again so this handler is safe on its own.
  if (!can(principalOf(request), 'tools.delete')) return fail('forbidden', 'Your role cannot delete maintenance records.', 403);
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'A maintenance record id looks like MNT-0001.', 400);
  const url = new URL(request.url);
  const expected = url.searchParams.get('expectedUpdatedAt');
  if (expected !== null && (expected === '' || expected.length > 40)) return fail('invalid_parameter', '`expectedUpdatedAt` is not valid.', 400);
  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No maintenance record with that id.', 404);
    if (!['Scheduled', 'Cancelled'].includes(row.status)) {
      return conflict(`A ${row.status.toLowerCase()} maintenance record is part of the equipment's service history and cannot be deleted.`, { reason: 'maintenance_kept' });
    }
    if (expected !== null && row.updated_at !== expected) return staleConflict();
    const guard = `id = ?1 AND updated_at = ?2 AND status IN ('Scheduled', 'Cancelled')`;
    // The history entry is written first and only for a row the delete will remove: it outlives the row.
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tool_maintenance_events (maintenance_id, tool_id, occurred_at, actor, action, summary)
         SELECT ?1, tool_id, ?3, ?4, 'delete', ?5 FROM tool_maintenance WHERE ${guard}`
      ).bind(row.id, row.updated_at, nowIso(), actorName(request),
        clip(`Deleted ${row.maintenance_type} of ${row.tool_name} scheduled for ${row.scheduled_date} (${row.status})`)),
      env.DB.prepare(`DELETE FROM tool_maintenance WHERE ${guard}`).bind(row.id, row.updated_at),
    ]);
    if (!results[1].meta || results[1].meta.changes !== 1) return staleConflict();
    return ok({ id: row.id, deleted: true });
  } catch (err) {
    console.error('DELETE /api/tool-maintenance/:id failed:', err && err.message);
    return fail('database_error', 'Could not delete the maintenance record.', 500);
  }
}
