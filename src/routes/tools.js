/* ============================================================
   routes/tools.js — /api/tools[/:id]   (migration 0013)
   ------------------------------------------------------------
   Workshop Assets › Tools & Equipment: one row per physical tool.

     GET  /api/tools               list -- q, category, status, condition,
                                   includeRetired, sort, order, limit, offset;
                                   meta.summary counts the whole register
     GET  /api/tools/:id           one tool
     POST /api/tools               register a tool
     PUT  /api/tools/:id           merge; `expectedUpdatedAt` is required
     POST /api/tools/:id/retire    { reason, expectedUpdatedAt } -- tools.manage
     POST /api/tools/:id/reactivate { status?, expectedUpdatedAt } -- tools.manage
                                   (0021): a retired tool back in service
     DELETE /api/tools/:id         ?expectedUpdatedAt -- tools.delete (0021):
                                   removes the row for good; its history in
                                   tool_events stays. Refused while assigned.

   Retiring is the normal way out of service: the record is kept. A retired
   tool is left out of the list unless asked for (status=Retired or
   includeRetired=1) and cannot be edited until it is reactivated. DELETE is
   for a record that should never have existed (entered twice, by mistake).

   0021 (Equipment Inventory, the same register) adds, all optional:
     * assignedStaffId | assignedMechanicId -- who has it. Never both; only an
       Active person; an assigned item is In Use. Moving an item out of In Use
       ends its assignment (so a form that knows nothing of assignment, like
       Tools & Equipment, keeps working);
     * lastServiceDate, nextServiceDue -- and a derived maintenanceStatus;
     * tool_events -- the item's history, written in the SAME batch as the
       change, so a change is never saved without its entry or vice versa;
     * list: purchasedFrom / purchasedTo, meta.purchaseValue, meta.serviceDue.

   Rules the schema also holds, checked here first so the answer names
   the field (the CHECKs remain the final word):
     * status and condition do not contradict each other;
     * warranty expiry is on or after the purchase date;
     * a serial number is unique, ignoring case, among tools in service.
   And one it cannot hold: a purchase date is not in the future.

   Who may retire: an administrator as /api/accounts already defines one
   (lib: isAdmin in routes/accounts.js) -- the workshop passphrase, the
   machine token, or an account whose role is Administrator. No new role
   is introduced.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId, conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, readEnum, readDate, nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';
import { fieldSet } from '../lib/collection-write.js';
import { principalOf } from '../lib/auth.js';
import { can } from '../lib/permissions.js';

export const TOOL_CATEGORIES = [
  'Diagnostic Equipment', 'Engine Tools', 'Electrical Tools', 'AC Service Equipment',
  'Lifting Equipment', 'Workshop Hand Tools', 'Safety Equipment', 'Cleaning Equipment', 'Other',
];
export const TOOL_CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Damaged'];
export const TOOL_STATUSES = ['Available', 'In Use', 'Under Maintenance', 'Damaged', 'Retired'];
/** Retired is reached only through the retire action. */
const WRITABLE_STATUSES = TOOL_STATUSES.filter((s) => s !== 'Retired');
const USABLE = ['Available', 'In Use'];
const USABLE_CONDITIONS = ['Excellent', 'Good', 'Fair'];

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 50;
const EARLIEST_PURCHASE = '1980-01-01';
const MAX_PRICE = 100000000;
const LIMITS = { name: 120, brand: 80, model: 80, serialNo: 80, supplier: 160, location: 80,
  description: 500, notes: 1000, reason: 300, q: 100 };

/** Every field a create or edit may send. Anything else is refused by name. */
const FIELD_KEYS = ['name', 'category', 'brand', 'model', 'serialNo', 'purchaseDate', 'purchasePrice',
  'supplier', 'warrantyExpiry', 'location', 'condition', 'status', 'description', 'notes',
  'assignedStaffId', 'assignedMechanicId', 'lastServiceDate', 'nextServiceDue'];
const UPDATE_KEYS = [...FIELD_KEYS, 'expectedUpdatedAt'];
const RETIRE_KEYS = ['reason', 'expectedUpdatedAt'];
const REACTIVATE_KEYS = ['status', 'expectedUpdatedAt'];
/** A reactivated tool is not assigned to anyone yet, so it cannot come back In Use. */
const REACTIVATE_STATUSES = ['Available', 'Under Maintenance', 'Damaged'];
/** Days ahead that count as "service due soon". */
export const SERVICE_SOON_DAYS = 14;
const PERSON_ID = /^[A-Z]{3}-\d{4,}$/;

/** sort key -> a fixed SQL expression. Nothing from the request reaches ORDER BY. */
const SORTS = {
  name: 'name COLLATE NOCASE',
  purchaseDate: 'purchase_date',
  purchasePrice: 'purchase_price',
  createdAt: 'created_at',
};

const COLUMNS = `id, name, category, brand, model, serial_no, purchase_date, purchase_price, supplier,
  warranty_expiry, location, condition, status, description, notes, retired_at, retired_reason,
  created_by, updated_by, created_at, updated_at,
  assigned_staff_id, assigned_mechanic_id, last_service_date, next_service_due,
  (SELECT s.name FROM staff s WHERE s.id = tools.assigned_staff_id) AS assigned_staff_name,
  (SELECT m.name FROM mechanics m WHERE m.id = tools.assigned_mechanic_id) AS assigned_mechanic_name`;

/** YYYY-MM-DD `days` after `day`. */
function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What the item's servicing looks like today. Derived, never stored. */
export function maintenanceStatus(row, today = todayInDhaka()) {
  if (row.status === 'Retired') return 'Not applicable';
  if (row.status === 'Under Maintenance') return 'Under maintenance';
  const due = row.next_service_due;
  if (!due) return 'Not scheduled';
  if (due < today) return 'Overdue';
  if (due <= addDays(today, SERVICE_SOON_DAYS)) return 'Due soon';
  return 'Scheduled';
}

function toRecord(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    brand: row.brand ?? '',
    model: row.model ?? '',
    serialNo: row.serial_no ?? '',
    purchaseDate: row.purchase_date ?? '',
    purchasePrice: row.purchase_price ?? null,
    supplier: row.supplier ?? '',
    warrantyExpiry: row.warranty_expiry ?? '',
    location: row.location ?? '',
    condition: row.condition,
    status: row.status,
    description: row.description ?? '',
    notes: row.notes ?? '',
    retiredAt: row.retired_at ?? null,
    retiredReason: row.retired_reason ?? '',
    createdBy: row.created_by ?? '',
    updatedBy: row.updated_by ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    assignedStaffId: row.assigned_staff_id ?? '',
    assignedMechanicId: row.assigned_mechanic_id ?? '',
    assignedTo: row.assigned_staff_id
      ? { kind: 'staff', id: row.assigned_staff_id, name: row.assigned_staff_name || row.assigned_staff_id }
      : row.assigned_mechanic_id
        ? { kind: 'mechanic', id: row.assigned_mechanic_id, name: row.assigned_mechanic_name || row.assigned_mechanic_id }
        : null,
    lastServiceDate: row.last_service_date ?? '',
    nextServiceDue: row.next_service_due ?? '',
    maintenanceStatus: maintenanceStatus(row),
  };
}

/* ---------- helpers ---------- */

/** The caller as the record names them: an account's username, or the passphrase / token. */
function actorName(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') return String(p.username || p.id || 'Account').slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  if (p.kind === 'token') return 'API token';
  return null;
}

const nullIfBlank = (v) => (v === '' ? null : v);

function unknownKeys(body, allowed) {
  const errors = {};
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    errors[key] = key === 'id' || key === 'retiredAt' || key === 'retiredReason' || key === 'createdAt'
      ? 'This field is set by the system.'
      : 'This is not a tool field.';
  }
  return errors;
}

/** Read the editable fields. On 'update' an absent key is left untouched. */
function readFields(body, mode) {
  const f = fieldSet(body, mode);
  const required = mode === 'create';
  f.take('name', 'name', readString(body, 'name', { required: true, max: LIMITS.name }));
  f.take('category', 'category', readEnum(body, 'category', TOOL_CATEGORIES, { required: true }));
  f.take('brand', 'brand', readString(body, 'brand', { max: LIMITS.brand }));
  f.take('model', 'model', readString(body, 'model', { max: LIMITS.model }));
  f.take('serial_no', 'serialNo', readString(body, 'serialNo', { max: LIMITS.serialNo }));
  f.take('purchase_date', 'purchaseDate', readDate(body, 'purchaseDate'));
  f.take('purchase_price', 'purchasePrice', readNumber(body, 'purchasePrice', { min: 0, max: MAX_PRICE }));
  f.take('supplier', 'supplier', readString(body, 'supplier', { max: LIMITS.supplier }));
  f.take('warranty_expiry', 'warrantyExpiry', readDate(body, 'warrantyExpiry'));
  f.take('location', 'location', readString(body, 'location', { max: LIMITS.location }));
  f.take('condition', 'condition', readEnum(body, 'condition', TOOL_CONDITIONS, { required }));
  if (body.status === 'Retired') f.reject('status', 'A tool is retired with the Retire action, not by editing it.');
  else f.take('status', 'status', readEnum(body, 'status', WRITABLE_STATUSES, { required }));
  f.take('description', 'description', readString(body, 'description', { max: LIMITS.description }));
  f.take('notes', 'notes', readString(body, 'notes', { max: LIMITS.notes }));
  for (const [col, key] of [['assigned_staff_id', 'assignedStaffId'], ['assigned_mechanic_id', 'assignedMechanicId']]) {
    const r = readString(body, key, { max: 40 });
    if (!r.error && r.value && !PERSON_ID.test(r.value)) f.reject(key, 'That is not a staff or mechanic id.');
    else f.take(col, key, r);
  }
  f.take('last_service_date', 'lastServiceDate', readDate(body, 'lastServiceDate'));
  f.take('next_service_due', 'nextServiceDue', readDate(body, 'nextServiceDue'));

  for (const col of ['brand', 'model', 'serial_no', 'purchase_date', 'supplier', 'warranty_expiry',
    'location', 'description', 'notes', 'assigned_staff_id', 'assigned_mechanic_id', 'last_service_date', 'next_service_due']) {
    if (f.values[col] !== undefined) f.values[col] = nullIfBlank(f.values[col]);
  }
  if (f.values.name !== undefined) f.values.name = f.values.name.replace(/\s+/g, ' ');
  if (typeof f.values.purchase_price === 'number') f.values.purchase_price = Math.round(f.values.purchase_price * 100) / 100;
  return f;
}

/** Rules across fields, checked on the record as it will be stored. */
function checkWhole(tool, errors) {
  if (tool.purchase_date) {
    if (tool.purchase_date < EARLIEST_PURCHASE) errors.purchaseDate = `Purchase date cannot be before ${EARLIEST_PURCHASE}.`;
    else if (tool.purchase_date > todayInDhaka()) errors.purchaseDate = 'Purchase date cannot be in the future.';
  }
  if (tool.warranty_expiry && tool.purchase_date && tool.warranty_expiry < tool.purchase_date) {
    errors.warrantyExpiry = 'Warranty expiry must be on or after the purchase date.';
  }
  if (tool.condition === 'Damaged' && USABLE.includes(tool.status)) {
    errors.status = 'A damaged tool cannot be Available or In Use. Mark it Damaged or Under Maintenance.';
  } else if (USABLE.includes(tool.status) && !USABLE_CONDITIONS.includes(tool.condition)) {
    errors.status = `A tool in ${tool.condition} condition cannot be ${tool.status}. Mark it Under Maintenance or Damaged.`;
  }
  if (tool.assigned_staff_id && tool.assigned_mechanic_id) {
    errors.assignedStaffId = 'Assign it to one person: an employee or a mechanic, not both.';
  } else if ((tool.assigned_staff_id || tool.assigned_mechanic_id) && tool.status !== 'In Use' && !errors.status) {
    errors.status = 'Equipment assigned to someone must be In Use (Assigned). Return it first to change its status.';
  }
  if (tool.last_service_date) {
    if (tool.last_service_date < EARLIEST_PURCHASE) errors.lastServiceDate = `Last service date cannot be before ${EARLIEST_PURCHASE}.`;
    else if (tool.last_service_date > todayInDhaka()) errors.lastServiceDate = 'Last service date cannot be in the future.';
  }
  if (tool.next_service_due && tool.last_service_date && tool.next_service_due < tool.last_service_date) {
    errors.nextServiceDue = 'Next service must be on or after the last service.';
  }
}

/**
 * The person an assignment names must exist and be Active: an employee from
 * Staff (not a mechanic's profile row) or a mechanic. Only checked when the
 * assignment is being set; fills errors and returns the person's name.
 */
async function checkAssignee(env, values, errors) {
  if (values.assigned_staff_id) {
    const p = await env.DB.prepare(
      'SELECT id, name, status FROM staff WHERE id = ?1 AND mechanic_id IS NULL LIMIT 1'
    ).bind(values.assigned_staff_id).first();
    if (!p) errors.assignedStaffId = 'No employee with that id.';
    else if (p.status !== 'Active') errors.assignedStaffId = `${p.name} is not active, so equipment cannot be assigned to them.`;
    return p ? p.name : null;
  }
  if (values.assigned_mechanic_id) {
    const p = await env.DB.prepare('SELECT id, name, status FROM mechanics WHERE id = ?1 LIMIT 1')
      .bind(values.assigned_mechanic_id).first();
    if (!p) errors.assignedMechanicId = 'No mechanic with that id.';
    else if (p.status && p.status !== 'Active') errors.assignedMechanicId = `${p.name} is not active, so equipment cannot be assigned to them.`;
    return p ? p.name : null;
  }
  return null;
}

/* ---------- history (tool_events, 0021) ---------- */

const clip = (s) => String(s).slice(0, 300);

/** An event row, written only if the tool row now carries `stamp` (the change landed). */
function eventIfLanded(env, id, stamp, actor, action, summary) {
  return env.DB.prepare(
    `INSERT INTO tool_events (tool_id, occurred_at, actor, action, summary)
     SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM tools WHERE id = ?1 AND updated_at = ?2)`
  ).bind(id, stamp, actor, action, clip(summary));
}

const FIELD_LABELS = {
  name: 'name', category: 'category', brand: 'brand', model: 'model', serial_no: 'serial number',
  purchase_date: 'purchase date', purchase_price: 'purchase price', supplier: 'supplier',
  warranty_expiry: 'warranty expiry', location: 'location', condition: 'condition', description: 'description',
  notes: 'notes', last_service_date: 'last service date', next_service_due: 'next service due',
};

/** What an edit did, as history entries: [action, summary]. */
function editEvents(row, merged, changedCols, newName) {
  const out = [];
  const before = row.assigned_staff_id || row.assigned_mechanic_id || null;
  const after = merged.assigned_staff_id || merged.assigned_mechanic_id || null;
  const beforeName = row.assigned_staff_name || row.assigned_mechanic_name || before;
  if (before !== after) {
    if (before) out.push(['return', `Returned by ${beforeName} (${before})`]);
    if (after) out.push(['assign', `Assigned to ${newName || after} (${after})`]);
  }
  // Assigning puts an item In Use: the assignment entry says so already.
  if (merged.status !== row.status && !(before !== after && after && merged.status === 'In Use')) {
    out.push(['status', `Status: ${row.status} → ${merged.status}`]);
  }
  const plain = changedCols.filter((c) => FIELD_LABELS[c] && !same(row[c], merged[c]));
  if (plain.length) out.push(['update', `Edited ${plain.map((c) => FIELD_LABELS[c]).join(', ')}`]);
  return out;
}
const same = (a, b) => (a ?? null) === (b ?? null);

async function findRow(env, id) {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM tools WHERE id = ?1 LIMIT 1`).bind(id).first();
}

/** The tool in service already carrying this serial number, if any (ignoring case). */
async function serialClash(env, serial, exceptId) {
  if (!serial) return null;
  return env.DB.prepare(
    `SELECT id, name FROM tools
      WHERE serial_no IS NOT NULL AND lower(serial_no) = lower(?1) AND status <> 'Retired' AND id <> ?2
      LIMIT 1`
  ).bind(serial, exceptId || '').first();
}

const serialConflict = (clash) => conflict(
  `Serial number is already registered to ${clash.name} (${clash.id}).`,
  { reason: 'duplicate_serial', conflictsWith: clash.id, fields: { serialNo: `Already registered to ${clash.id}.` } }
);

const staleConflict = () => conflict(
  'This tool was changed by someone else after you opened it. Reload it and try again.',
  { reason: 'concurrent_modification' }
);

const retiredConflict = () => conflict('This tool is retired and can no longer be changed.', { reason: 'tool_retired' });

/** A timestamp strictly after the one being replaced, so expectedUpdatedAt always moves. */
function nextStamp(previous) {
  const now = nowIso();
  return previous && now <= previous ? new Date(Date.parse(previous) + 1).toISOString() : now;
}

function readId(rawId) {
  const id = readRecordId(rawId);
  return id.error ? null : id.value;
}

function readExpected(body, errors) {
  const expected = body.expectedUpdatedAt;
  if (typeof expected !== 'string' || expected === '' || expected.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the change was made from.';
    return null;
  }
  return expected;
}

/* ---------- GET /api/tools ---------- */

function readFilter(url, name, allowed) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return { value: null };
  if (!allowed.includes(raw)) return { error: `\`${name}\` must be one of: ${allowed.join(', ')}.` };
  return { value: raw };
}

export async function listTools(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  const filters = {
    category: readFilter(url, 'category', TOOL_CATEGORIES),
    status: readFilter(url, 'status', TOOL_STATUSES),
    condition: readFilter(url, 'condition', TOOL_CONDITIONS),
    includeRetired: readFilter(url, 'includeRetired', ['0', '1']),
    sort: readFilter(url, 'sort', Object.keys(SORTS)),
    order: readFilter(url, 'order', ['asc', 'desc']),
  };
  for (const f of Object.values(filters)) if (f.error) return fail('invalid_parameter', f.error, 400);

  const dates = {};
  for (const name of ['purchasedFrom', 'purchasedTo']) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') { dates[name] = null; continue; }
    const d = readDate({ [name]: raw }, name);
    if (d.error) return fail('invalid_parameter', d.error, 400);
    dates[name] = d.value;
  }

  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > LIMITS.q) return fail('invalid_parameter', `\`q\` must be ${LIMITS.q} characters or fewer.`, 400);
  // LIKE wildcards in the search text are matched literally.
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  const status = filters.status.value;
  const withRetired = status === 'Retired' || filters.includeRetired.value === '1';
  const sortKey = filters.sort.value || 'createdAt';
  const order = (filters.order.value || (sortKey === 'name' ? 'asc' : 'desc')).toUpperCase();
  // Tools without a price or date sort last whichever way the list is turned.
  const sortCol = SORTS[sortKey];
  const orderBy = `${sortCol} IS NULL, ${sortCol} ${order}, id ${order}`;

  const where = `
     WHERE (?1 IS NULL OR category = ?1)
       AND (?2 IS NULL OR status = ?2)
       AND (?3 IS NULL OR condition = ?3)
       AND (?4 = 1 OR status <> 'Retired')
       AND (?5 IS NULL
            OR lower(id) LIKE ?5 ESCAPE '\\' OR lower(name) LIKE ?5 ESCAPE '\\'
            OR lower(coalesce(brand, '')) LIKE ?5 ESCAPE '\\' OR lower(coalesce(model, '')) LIKE ?5 ESCAPE '\\'
            OR lower(coalesce(serial_no, '')) LIKE ?5 ESCAPE '\\')
       AND (?6 IS NULL OR purchase_date >= ?6)
       AND (?7 IS NULL OR purchase_date <= ?7)`;
  const binds = [filters.category.value, status, filters.condition.value, withRetired ? 1 : 0, needle,
    dates.purchasedFrom, dates.purchasedTo];

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM tools ${where} ORDER BY ${orderBy} LIMIT ?8 OFFSET ?9`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM tools ${where}`).bind(...binds).first();
    const counts = await env.DB.prepare('SELECT status, count(*) AS n, total(purchase_price) AS v FROM tools GROUP BY status').all();
    const today = todayInDhaka();
    const due = await env.DB.prepare(
      `SELECT count(*) AS n FROM tools
        WHERE status NOT IN ('Retired', 'Under Maintenance') AND next_service_due IS NOT NULL AND next_service_due <= ?1`
    ).bind(addDays(today, SERVICE_SOON_DAYS)).first();

    const summary = { total: 0, available: 0, inUse: 0, underMaintenance: 0, damaged: 0, retired: 0 };
    const keyOf = { Available: 'available', 'In Use': 'inUse', 'Under Maintenance': 'underMaintenance', Damaged: 'damaged', Retired: 'retired' };
    let value = 0;
    for (const r of counts.results || []) {
      if (keyOf[r.status]) summary[keyOf[r.status]] = r.n;
      if (r.status !== 'Retired') { summary.total += r.n; value += Number(r.v) || 0; }
    }

    const rows = results || [];
    return ok(rows.map(toRecord), {
      count: rows.length,
      total: total ? total.n : rows.length,
      limit: limit.value,
      offset: offset.value,
      summary,
      // Purchase value of everything in service (retired items excluded), in taka.
      purchaseValue: Math.round(value * 100) / 100,
      // In service and due for servicing within SERVICE_SOON_DAYS, or overdue.
      serviceDue: due ? due.n : 0,
      categories: TOOL_CATEGORIES,
      statuses: TOOL_STATUSES,
      conditions: TOOL_CONDITIONS,
    });
  } catch (err) {
    console.error('GET /api/tools failed:', err && err.message);
    return fail('database_error', 'Could not read tools.', 500);
  }
}

/* ---------- GET /api/tools/:id ---------- */

export async function getTool(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  try {
    const row = await findRow(env, id.value);
    if (!row) return fail('not_found', 'No tool with that id.', 404);
    const ev = await env.DB.prepare(
      'SELECT occurred_at, actor, action, summary FROM tool_events WHERE tool_id = ?1 ORDER BY id DESC LIMIT 50'
    ).bind(id.value).all();
    const events = (ev.results || []).map((e) => ({ at: e.occurred_at, actor: e.actor || '', action: e.action, summary: e.summary }));
    return ok(toRecord(row), { events });
  } catch (err) {
    console.error('GET /api/tools/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the tool.', 500);
  }
}

/* ---------- POST /api/tools ---------- */

export async function createTool(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, FIELD_KEYS);
  const f = readFields(body, 'create');
  Object.assign(errors, f.errors);
  if (!Object.keys(errors).length) checkWhole(f.values, errors);
  if (Object.keys(errors).length) return unprocessable('Some tool fields are not valid.', errors);

  try {
    const assigneeName = await checkAssignee(env, f.values, errors);
    if (Object.keys(errors).length) return unprocessable('Some tool fields are not valid.', errors);
    const clash = await serialClash(env, f.values.serial_no, null);
    if (clash) return serialConflict(clash);

    const allocated = await allocateId(env, 'tools');
    if (allocated.error) {
      console.error('POST /api/tools could not allocate an id:', allocated.error);
      return fail('database_error', 'Could not create the tool.', 500);
    }
    const now = nowIso();
    const who = actorName(request);
    const values = { ...f.values, id: allocated.id, created_by: who, updated_by: who, created_at: now, updated_at: now };
    const names = Object.keys(values);
    const stmts = [
      env.DB.prepare(
        `INSERT INTO tools (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`
      ).bind(...names.map((n) => values[n])),
      eventIfLanded(env, allocated.id, now, who, 'create', `Added ${values.name} (${values.category}) as ${values.status}`),
    ];
    const assignee = values.assigned_staff_id || values.assigned_mechanic_id;
    if (assignee) stmts.push(eventIfLanded(env, allocated.id, now, who, 'assign', `Assigned to ${assigneeName || assignee} (${assignee})`));
    // The row and its history entry are one transaction.
    await env.DB.batch(stmts);
    return ok(toRecord(await findRow(env, allocated.id)), {}, 201);
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err && err.message)) && /serial/i.test(String(err && err.message))) {
      const clash = await serialClash(env, f.values.serial_no, null).catch(() => null);
      if (clash) return serialConflict(clash);
    }
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/tools failed:', err && err.message);
    return fail('database_error', 'Could not create the tool.', 500);
  }
}

/* ---------- PUT /api/tools/:id ---------- */

export async function updateTool(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not a tool id.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, UPDATE_KEYS);
  const expected = readExpected(body, errors);
  const f = readFields(body, 'update');
  Object.assign(errors, f.errors);
  if (!Object.keys(errors).length && !f.touched) errors.name = 'Nothing to change.';
  if (Object.keys(errors).length) return unprocessable('Some tool fields are not valid.', errors);

  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No tool with that id.', 404);
    if (row.status === 'Retired') return retiredConflict();
    if ((row.updated_at ?? row.created_at) !== expected) return staleConflict();

    // Leaving In Use ends the assignment, unless this same edit names one
    // (which checkWhole then refuses). A caller that knows nothing of
    // assignment -- Tools & Equipment -- can still move an item on.
    const assignmentSent = body.assignedStaffId !== undefined || body.assignedMechanicId !== undefined;
    if (f.values.status !== undefined && f.values.status !== 'In Use' && !assignmentSent
      && (row.assigned_staff_id || row.assigned_mechanic_id)) {
      f.values.assigned_staff_id = null;
      f.values.assigned_mechanic_id = null;
    }

    const merged = { ...row, ...f.values };
    checkWhole(merged, errors);
    if (Object.keys(errors).length) return unprocessable('Some tool fields are not valid.', errors);

    const assignmentChanged = !same(row.assigned_staff_id, merged.assigned_staff_id)
      || !same(row.assigned_mechanic_id, merged.assigned_mechanic_id);
    const assigneeName = assignmentChanged ? await checkAssignee(env, merged, errors) : null;
    if (Object.keys(errors).length) return unprocessable('Some tool fields are not valid.', errors);

    if (f.values.serial_no !== undefined) {
      const clash = await serialClash(env, merged.serial_no, id);
      if (clash) return serialConflict(clash);
    }

    const who = actorName(request);
    const stamp = nextStamp(row.updated_at);
    const values = { ...f.values, updated_by: who, updated_at: stamp };
    const names = Object.keys(values);
    const sets = names.map((n, i) => `${n} = ?${i + 3}`).join(', ');
    const events = editEvents(row, merged, Object.keys(f.values), assigneeName);
    // The check and the change are one statement: an edit made meanwhile is
    // never overwritten. Its history entries land only if the change did.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tools SET ${sets} WHERE id = ?1 AND coalesce(updated_at, created_at) = ?2 AND status <> 'Retired'`
      ).bind(id, expected, ...names.map((n) => values[n])),
      ...events.map(([action, summary]) => eventIfLanded(env, id, stamp, who, action, summary)),
    ]);
    const res = results[0];
    if (!res.meta || res.meta.changes !== 1) return staleConflict();
    return ok(toRecord(await findRow(env, id)));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/tools/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the tool.', 500);
  }
}

/* ---------- POST /api/tools/:id/retire ---------- */

export async function retireTool(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();
  if (!can(principalOf(request), 'tools.manage')) {
    return fail('forbidden', 'Your role cannot retire tools.', 403);
  }
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not a tool id.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, RETIRE_KEYS);
  const expected = readExpected(body, errors);
  const reason = readString(body, 'reason', { required: true, max: LIMITS.reason });
  if (reason.error) errors.reason = reason.error;
  if (Object.keys(errors).length) return unprocessable('The tool could not be retired.', errors);

  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No tool with that id.', 404);
    if (row.status === 'Retired') return conflict('This tool is already retired.', { reason: 'already_retired' });
    if ((row.updated_at ?? row.created_at) !== expected) return staleConflict();

    const now = nextStamp(row.updated_at);
    const who = actorName(request);
    const holder = row.assigned_staff_id || row.assigned_mechanic_id;
    // A retired item is with no one: its assignment ends with it.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tools
            SET status = 'Retired', retired_at = ?3, retired_reason = ?4, updated_by = ?5, updated_at = ?3,
                assigned_staff_id = NULL, assigned_mechanic_id = NULL
          WHERE id = ?1 AND coalesce(updated_at, created_at) = ?2 AND status <> 'Retired'`
      ).bind(id, expected, now, reason.value, who),
      ...(holder ? [eventIfLanded(env, id, now, who, 'return', `Returned by ${row.assigned_staff_name || row.assigned_mechanic_name || holder} (${holder}) on retirement`)] : []),
      eventIfLanded(env, id, now, who, 'retire', `Retired (was ${row.status}): ${reason.value}`),
    ]);
    if (!results[0].meta || results[0].meta.changes !== 1) return staleConflict();
    return ok(toRecord(await findRow(env, id)));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/tools/:id/retire failed:', err && err.message);
    return fail('database_error', 'Could not retire the tool.', 500);
  }
}

/* ---------- POST /api/tools/:id/reactivate (0021) ---------- */

export async function reactivateTool(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();
  if (!can(principalOf(request), 'tools.manage')) {
    return fail('forbidden', 'Your role cannot return equipment to service.', 403);
  }
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not a tool id.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;

  const errors = unknownKeys(body, REACTIVATE_KEYS);
  const expected = readExpected(body, errors);
  const wanted = readEnum(body, 'status', REACTIVATE_STATUSES);
  if (wanted.error) errors.status = wanted.error;
  if (Object.keys(errors).length) return unprocessable('The equipment could not be reactivated.', errors);

  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No tool with that id.', 404);
    if (row.status !== 'Retired') return conflict('This equipment is already in service.', { reason: 'not_retired' });
    if ((row.updated_at ?? row.created_at) !== expected) return staleConflict();

    const status = wanted.value || (row.condition === 'Damaged' ? 'Damaged'
      : USABLE_CONDITIONS.includes(row.condition) ? 'Available' : 'Under Maintenance');
    checkWhole({ ...row, status, assigned_staff_id: null, assigned_mechanic_id: null }, errors);
    if (Object.keys(errors).length) return unprocessable('The equipment could not be reactivated.', errors);
    const clash = await serialClash(env, row.serial_no, id);
    if (clash) return serialConflict(clash);

    const now = nextStamp(row.updated_at);
    const who = actorName(request);
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE tools
            SET status = ?3, retired_at = NULL, retired_reason = NULL, updated_by = ?4, updated_at = ?5
          WHERE id = ?1 AND coalesce(updated_at, created_at) = ?2 AND status = 'Retired'`
      ).bind(id, expected, status, who, now),
      eventIfLanded(env, id, now, who, 'reactivate', `Returned to service as ${status}`),
    ]);
    if (!results[0].meta || results[0].meta.changes !== 1) return staleConflict();
    return ok(toRecord(await findRow(env, id)));
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err && err.message))) {
      return conflict('Another item in service already carries this serial number.', { reason: 'duplicate_serial' });
    }
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/tools/:id/reactivate failed:', err && err.message);
    return fail('database_error', 'Could not reactivate the equipment.', 500);
  }
}

/* ---------- DELETE /api/tools/:id (0021) ---------- */

export async function deleteTool(request, env, rawId) {
  if (request.method !== 'DELETE') return methodNotAllowed(['GET', 'PUT', 'DELETE']);
  if (!env.DB) return noDatabase();
  // The router already required tools.delete; checked again so this handler is safe on its own.
  if (!can(principalOf(request), 'tools.delete')) {
    return fail('forbidden', 'Your role cannot delete equipment.', 403);
  }
  const id = readId(rawId);
  if (!id) return fail('invalid_id', 'That is not a tool id.', 400);
  const url = new URL(request.url);
  const expected = url.searchParams.get('expectedUpdatedAt');
  if (expected !== null && (expected === '' || expected.length > 40)) {
    return fail('invalid_parameter', '`expectedUpdatedAt` is not valid.', 400);
  }

  try {
    const row = await findRow(env, id);
    if (!row) return fail('not_found', 'No tool with that id.', 404);
    if (row.assigned_staff_id || row.assigned_mechanic_id || row.status === 'In Use') {
      return conflict('This equipment is assigned or in use. Return it before deleting it.', { reason: 'tool_in_use' });
    }
    if (expected !== null && (row.updated_at ?? row.created_at) !== expected) return staleConflict();

    const who = actorName(request);
    const summary = `Deleted ${row.name} (${row.category})${row.serial_no ? `, S/N ${row.serial_no}` : ''}, status ${row.status}`;
    const guard = `id = ?1 AND status <> 'In Use' AND assigned_staff_id IS NULL AND assigned_mechanic_id IS NULL
                   AND coalesce(updated_at, created_at) = ?2`;
    const stamp = row.updated_at ?? row.created_at;
    // The history entry is written first and only for a row the delete will
    // remove (the same guard, the same transaction): it outlives the row.
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tool_events (tool_id, occurred_at, actor, action, summary)
         SELECT ?1, ?3, ?4, 'delete', ?5 FROM tools WHERE ${guard}`
      ).bind(id, stamp, nowIso(), who, clip(summary)),
      env.DB.prepare(`DELETE FROM tools WHERE ${guard}`).bind(id, stamp),
    ]);
    if (!results[1].meta || results[1].meta.changes !== 1) return staleConflict();
    return ok({ id, deleted: true });
  } catch (err) {
    console.error('DELETE /api/tools/:id failed:', err && err.message);
    return fail('database_error', 'Could not delete the equipment.', 500);
  }
}
