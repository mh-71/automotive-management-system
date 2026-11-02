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
     POST /api/tools/:id/retire    { reason, expectedUpdatedAt } -- an
                                   administrator only

   There is no DELETE: a tool leaves service by being retired, and keeps
   its record. A retired tool is left out of the list unless asked for
   (status=Retired or includeRetired=1) and cannot be edited.

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
  'supplier', 'warrantyExpiry', 'location', 'condition', 'status', 'description', 'notes'];
const UPDATE_KEYS = [...FIELD_KEYS, 'expectedUpdatedAt'];
const RETIRE_KEYS = ['reason', 'expectedUpdatedAt'];

/** sort key -> a fixed SQL expression. Nothing from the request reaches ORDER BY. */
const SORTS = {
  name: 'name COLLATE NOCASE',
  purchaseDate: 'purchase_date',
  purchasePrice: 'purchase_price',
  createdAt: 'created_at',
};

const COLUMNS = `id, name, category, brand, model, serial_no, purchase_date, purchase_price, supplier,
  warranty_expiry, location, condition, status, description, notes, retired_at, retired_reason,
  created_by, updated_by, created_at, updated_at`;

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

  for (const col of ['brand', 'model', 'serial_no', 'purchase_date', 'supplier', 'warranty_expiry',
    'location', 'description', 'notes']) {
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
}

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
            OR lower(coalesce(serial_no, '')) LIKE ?5 ESCAPE '\\')`;
  const binds = [filters.category.value, status, filters.condition.value, withRetired ? 1 : 0, needle];

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM tools ${where} ORDER BY ${orderBy} LIMIT ?6 OFFSET ?7`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM tools ${where}`).bind(...binds).first();
    const counts = await env.DB.prepare('SELECT status, count(*) AS n FROM tools GROUP BY status').all();

    const summary = { total: 0, available: 0, inUse: 0, underMaintenance: 0, damaged: 0, retired: 0 };
    const keyOf = { Available: 'available', 'In Use': 'inUse', 'Under Maintenance': 'underMaintenance', Damaged: 'damaged', Retired: 'retired' };
    for (const r of counts.results || []) {
      if (keyOf[r.status]) summary[keyOf[r.status]] = r.n;
      if (r.status !== 'Retired') summary.total += r.n;
    }

    const rows = results || [];
    return ok(rows.map(toRecord), {
      count: rows.length,
      total: total ? total.n : rows.length,
      limit: limit.value,
      offset: offset.value,
      summary,
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
    return ok(toRecord(row));
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
    await env.DB.prepare(
      `INSERT INTO tools (${names.join(', ')}) VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`
    ).bind(...names.map((n) => values[n])).run();
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

    const merged = { ...row, ...f.values };
    checkWhole(merged, errors);
    if (Object.keys(errors).length) return unprocessable('Some tool fields are not valid.', errors);

    if (f.values.serial_no !== undefined) {
      const clash = await serialClash(env, merged.serial_no, id);
      if (clash) return serialConflict(clash);
    }

    const values = { ...f.values, updated_by: actorName(request), updated_at: nextStamp(row.updated_at) };
    const names = Object.keys(values);
    const sets = names.map((n, i) => `${n} = ?${i + 3}`).join(', ');
    // The check and the change are one statement: an edit made meanwhile is never overwritten.
    const res = await env.DB.prepare(
      `UPDATE tools SET ${sets} WHERE id = ?1 AND coalesce(updated_at, created_at) = ?2 AND status <> 'Retired'`
    ).bind(id, expected, ...names.map((n) => values[n])).run();
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
    const res = await env.DB.prepare(
      `UPDATE tools
          SET status = 'Retired', retired_at = ?3, retired_reason = ?4, updated_by = ?5, updated_at = ?3
        WHERE id = ?1 AND coalesce(updated_at, created_at) = ?2 AND status <> 'Retired'`
    ).bind(id, expected, now, reason.value, actorName(request)).run();
    if (!res.meta || res.meta.changes !== 1) return staleConflict();
    return ok(toRecord(await findRow(env, id)));
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/tools/:id/retire failed:', err && err.message);
    return fail('database_error', 'Could not retire the tool.', 500);
  }
}
