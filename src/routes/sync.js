/* ============================================================
   sync.js — offline sync (0020): devices, push, pull, conflicts,
   invoice drafts.
   ------------------------------------------------------------
   A device that worked offline keeps every change as an OPERATION
   with its own UUID (js/sync.js). Online again, it pushes them here.

   THE RULES THIS FILE KEEPS
   - Every operation is applied THROUGH THE EXISTING ROUTE HANDLERS,
     as the person who made it (the internal request carries their
     own session cookie). So an offline customer, payment or job card
     passes exactly the validation, permission check, stock rule and
     balance rule an online one does -- no rule has a second home.
   - Idempotent: sync_ops is keyed by the operation UUID. A repeat of
     an operation already decided returns the stored answer; it is
     never applied twice. An operation whose first attempt was cut off
     mid-way becomes a conflict for review -- never a blind re-post
     (that could record a payment twice).
   - Nothing is lost and nothing is overwritten silently. An operation
     the server will not apply as it stands (insufficient stock, an
     overpayment, an edit to a record someone else changed, a refused
     permission) becomes a CONFLICT, kept with the device's values and
     the server's, until an authorized Admin resolves it.
   - Financial: a payment made offline is pending until this server
     accepts it; an invoice made offline is a DRAFT without a number
     until an authorized person finalizes it online.
   - Inventory: parts usage is applied as an incremental movement
     through the job card's own stock reconciliation; a shortage is
     flagged for review, stock is never overwritten.

   ROUTES (all behind the auth gate; finer checks below)
     POST   /api/devices/register          this browser, for the signed-in person
     GET    /api/devices                   devices (all with sync.view; else your own)
     DELETE /api/devices/:id               revoke a device (sync.manage, or your own)
     GET    /api/sync/status               cursor, server time, counts, 14-day window
     POST   /api/sync/push                 apply a batch of operations
     GET    /api/sync/pull                 changes after a cursor (with tombstones)
     GET    /api/sync/history              operations received (yours; all with sync.view)
     GET    /api/sync/conflicts            conflicts (all with sync.view; else your own)
     GET    /api/sync/conflicts/:id        one conflict and its history
     POST   /api/sync/conflicts/:id/resolve  resolve (sync.manage)
     GET    /api/invoice-drafts            drafts (invoices.view)
     GET    /api/invoice-drafts/:id
     POST   /api/invoice-drafts/:id/finalize  create the real invoice (invoices.create)
     POST   /api/invoice-drafts/:id/discard   keep it, marked discarded (invoices.create)
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, notFound, unprocessable, conflict, readIntParam } from '../lib/http.js';
import { readJsonBody, readOptionalBody, nowIso, allocateId } from '../lib/write.js';
import { principalOf, authConfig } from '../lib/auth.js';
import { can, collectionPermission } from '../lib/permissions.js';
import { logChanges } from '../lib/changes.js';

export const SYNC_ROUTES = [
  'POST /api/devices/register',
  'GET /api/devices',
  'DELETE /api/devices/:id',
  'GET /api/sync/status',
  'POST /api/sync/push',
  'GET /api/sync/pull',
  'GET /api/sync/history',
  'GET /api/sync/conflicts',
  'GET /api/sync/conflicts/:id',
  'POST /api/sync/conflicts/:id/resolve',
  'GET /api/invoice-drafts',
  'GET /api/invoice-drafts/:id',
  'POST /api/invoice-drafts/:id/finalize',
  'POST /api/invoice-drafts/:id/discard',
];

/** How long offline access lasts after the last online authorization (owner decision). */
export const OFFLINE_DAYS = 14;
const DAY_MS = 86400000;
const MAX_OPS = 50;
const MAX_OP_BYTES = 64 * 1024;
/** A claim older than this with no answer was cut off mid-way. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A device's temporary reference: OFF-<device code>-<prefix>-<number>. Never a server key. */
export const TEMP_REF = /^OFF-[A-Z0-9]{1,8}-[A-Z]{3}-\d{4,}$/;

/** Frontend collection -> API path. */
const PATHS = {
  customers: 'customers', vehicles: 'vehicles', appointments: 'appointments', jobCards: 'job-cards',
  services: 'services', mechanics: 'mechanics', parts: 'parts', invoices: 'invoices', payments: 'payments',
  expenses: 'expenses', inventoryTransactions: 'inventory-transactions', invoiceAdjustments: 'invoice-adjustments',
};
/** What may be created or edited offline (the rest is online-only). */
const OFFLINE_EDITABLE = ['customers', 'vehicles', 'appointments', 'jobCards', 'expenses', 'services', 'mechanics'];
const KINDS = ['create', 'update', 'status', 'payment', 'invoice_draft', 'parts_usage', 'stock_movement'];

/* ---------------------------------------------------------------
   Small helpers
   --------------------------------------------------------------- */

const json = (v) => JSON.stringify(v ?? null);
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Device codes: 1 -> A, 26 -> Z, 27 -> AA. Short, readable, unique (from id_counters). */
export function deviceCode(n) {
  let s = '';
  let v = Number(n);
  while (v > 0) { v -= 1; s = String.fromCharCode(65 + (v % 26)) + s; v = Math.floor(v / 26); }
  return s || 'A';
}

/** The internal request: the same person's own credential, to an existing route. */
function internalRequest(request, method, path, body) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-taqwa-sync': '1' });
  const cookie = request.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);
  const auth = request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  return new Request(new URL(path, request.url).toString(), {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(c, method, path, body) {
  let res;
  try {
    res = await c.dispatch(internalRequest(c.request, method, path, body));
  } catch (err) {
    console.error('sync: internal call failed', method, path, err && err.message);
    return { status: 500, body: null };
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}
const errorOf = (r) => (r.body && r.body.error) || {};

/** Deep equality for plain JSON values (field values as the API returns them). */
function same(a, b) {
  if (a === b) return true;
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  return json(a) === json(b);
}

/** Is the caller a personal account? Devices and pushes belong to a person. */
function accountOf(request) {
  const who = principalOf(request);
  return who && who.kind === 'account' ? who : null;
}

/** The HMAC escrow key that lets THIS account on THIS device reopen its encrypted
    offline journal while signed in online (js/offline.js). Derived, never stored. */
async function journalEscrow(env, accountId, deviceId) {
  const { secret } = authConfig(env);
  if (!secret) return null;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`taqwa-offline-journal.v1|${accountId}|${deviceId}`));
  let s = '';
  for (const b of new Uint8Array(mac)) s += String.fromCharCode(b);
  return btoa(s);
}

/* ---------------------------------------------------------------
   Devices
   --------------------------------------------------------------- */

const deviceRecord = (row, accounts = null) => ({
  id: row.id, code: row.code, label: row.label || '',
  registeredBy: row.registered_by, registeredAt: row.registered_at,
  lastSeenAt: row.last_seen_at || null, lastSeenBy: row.last_seen_by || null,
  revoked: !!row.revoked_at, revokedAt: row.revoked_at || null, revokedBy: row.revoked_by || null, revokeReason: row.revoke_reason || '',
  ...(accounts ? { accounts } : {}),
});

async function loadDevice(env, id) {
  return env.DB.prepare('SELECT * FROM devices WHERE id = ?1').bind(id).first();
}

/** The device a sync call names, for this account: { row } or { response }. */
async function deviceFor(env, who, deviceId) {
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) {
    return { response: unprocessable('A device id is required.', { deviceId: 'Must be the device UUID.' }) };
  }
  const row = await loadDevice(env, deviceId);
  if (!row) return { response: conflict('This device is not registered. Register it first.', { reason: 'device_not_registered' }) };
  if (row.revoked_at) {
    return { response: fail('device_revoked', 'An administrator has revoked offline access for this device. Its unsynced changes are kept; contact an administrator.', 403) };
  }
  return { row };
}

async function touchDevice(env, deviceId, who, at) {
  await env.DB.batch([
    env.DB.prepare('UPDATE devices SET last_seen_at = ?2, last_seen_by = ?3 WHERE id = ?1').bind(deviceId, at, who.id),
    env.DB.prepare(
      `INSERT INTO device_accounts (device_id, account_id, first_seen_at, authorized_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (device_id, account_id) DO UPDATE SET authorized_at = ?3`
    ).bind(deviceId, who.id, at),
  ]);
}

async function registerDevice(c) {
  const who = accountOf(c.request);
  if (!who) return fail('account_required', 'Offline sync needs a personal account sign-in.', 403);
  const body = await readJsonBody(c.request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const deviceId = body.value.deviceId;
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)) {
    return unprocessable('A device id is required.', { deviceId: 'Must be a UUID.' });
  }
  const label = typeof body.value.label === 'string' ? body.value.label.trim().slice(0, 80) : '';
  const at = nowIso();
  let row = await loadDevice(c.env, deviceId);
  if (row && row.revoked_at) {
    return fail('device_revoked', 'An administrator has revoked offline access for this device. Its unsynced changes are kept; contact an administrator.', 403);
  }
  if (!row) {
    const allocated = await allocateId(c.env, 'devices');
    if (allocated.error) return fail('database_error', 'Could not register this device.', 500);
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO devices (id, code, label, registered_by, registered_at, last_seen_at, last_seen_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?4)`
    ).bind(deviceId, deviceCode(allocated.value), label, who.id, at).run();
    row = await loadDevice(c.env, deviceId);
  }
  await touchDevice(c.env, deviceId, who, at);
  return ok({
    ...deviceRecord(row), accountId: who.id, serverTime: at, authorizedAt: at, offlineDays: OFFLINE_DAYS,
    offlineUntil: new Date(Date.parse(at) + OFFLINE_DAYS * DAY_MS).toISOString(),
    escrow: await journalEscrow(c.env, who.id, deviceId),
  }, {}, row && row.registered_at === at ? 201 : 200);
}

async function listDevices(c) {
  const who = principalOf(c.request);
  const all = can(who, 'sync.view');
  if (!all && (!who || who.kind !== 'account')) return ok([], { count: 0 });
  const { results } = all
    ? await c.env.DB.prepare('SELECT * FROM devices ORDER BY registered_at DESC LIMIT 500').all()
    : await c.env.DB.prepare(
      `SELECT d.* FROM devices d JOIN device_accounts da ON da.device_id = d.id
        WHERE da.account_id = ?1 ORDER BY d.registered_at DESC LIMIT 500`
    ).bind(who.id).all();
  const { results: links } = await c.env.DB.prepare(
    `SELECT da.device_id, da.account_id, da.first_seen_at, da.authorized_at, a.username
       FROM device_accounts da LEFT JOIN user_accounts a ON a.id = da.account_id`
  ).all();
  const byDevice = new Map();
  for (const l of links || []) {
    if (!all && l.account_id !== who.id) continue;
    if (!byDevice.has(l.device_id)) byDevice.set(l.device_id, []);
    byDevice.get(l.device_id).push({ accountId: l.account_id, username: l.username || '', firstSeenAt: l.first_seen_at, authorizedAt: l.authorized_at });
  }
  const rows = (results || []).map((r) => deviceRecord(r, byDevice.get(r.id) || []));
  return ok(rows, { count: rows.length });
}

async function revokeDevice(c, id) {
  const who = principalOf(c.request);
  if (!UUID.test(id)) return fail('invalid_id', 'Not a device id.', 400);
  const row = await loadDevice(c.env, id);
  if (!row) return fail('not_found', 'No such device.', 404);
  const own = who && who.kind === 'account' && row.registered_by === who.id;
  if (!can(who, 'sync.manage') && !own) return fail('forbidden', 'Your role does not allow this.', 403);
  if (row.revoked_at) return ok(deviceRecord(row));
  const body = await readOptionalBody(c.request);
  const reason = body && body.value && typeof body.value.reason === 'string' ? body.value.reason.trim().slice(0, 300) : '';
  await c.env.DB.prepare('UPDATE devices SET revoked_at = ?2, revoked_by = ?3, revoke_reason = ?4 WHERE id = ?1 AND revoked_at IS NULL')
    .bind(id, nowIso(), who.kind === 'account' ? who.id : who.kind, reason).run();
  return ok(deviceRecord(await loadDevice(c.env, id)));
}

/* ---------------------------------------------------------------
   Status, history
   --------------------------------------------------------------- */

export async function currentCursor(env) {
  try {
    const row = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log').first();
    return row ? Number(row.seq) : 0;
  } catch {
    return null;   // the table does not exist yet (0020 not applied)
  }
}

async function syncStatus(c, url) {
  const who = accountOf(c.request);
  if (!who) return fail('account_required', 'Offline sync needs a personal account sign-in.', 403);
  const at = nowIso();
  const deviceId = url.searchParams.get('deviceId');
  let device = null;
  if (deviceId) {
    const d = await deviceFor(c.env, who, deviceId);
    if (d.response) return d.response;
    await touchDevice(c.env, deviceId, who, at);
    device = deviceRecord(d.row);
  }
  const counts = {};
  const { results } = await c.env.DB.prepare(
    `SELECT status, COUNT(*) AS n FROM sync_ops WHERE account_id = ?1 ${deviceId ? 'AND device_id = ?2' : ''} GROUP BY status`
  ).bind(...(deviceId ? [who.id, deviceId] : [who.id])).all();
  for (const r of results || []) counts[r.status] = Number(r.n);
  const review = can(who, 'sync.view');
  const openConflicts = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sync_conflicts WHERE status = 'Open' ${review ? '' : 'AND account_id = ?1'}`
  ).bind(...(review ? [] : [who.id])).first();
  const drafts = can(who, 'invoices.view')
    ? await c.env.DB.prepare("SELECT COUNT(*) AS n FROM invoice_drafts WHERE status = 'Draft'").first() : { n: 0 };
  const movements = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM offline_stock_movements WHERE status = 'Review' ${review ? '' : 'AND account_id = ?1'}`
  ).bind(...(review ? [] : [who.id])).first();
  return ok({
    serverTime: at, cursor: await currentCursor(c.env), device,
    authorizedAt: device ? at : null, offlineDays: OFFLINE_DAYS,
    offlineUntil: device ? new Date(Date.parse(at) + OFFLINE_DAYS * DAY_MS).toISOString() : null,
    ops: counts, openConflicts: Number(openConflicts?.n || 0), invoiceDrafts: Number(drafts?.n || 0),
    inventoryReview: Number(movements?.n || 0), canReview: review, canResolve: can(who, 'sync.manage'),
  });
}

const opRecord = (r) => ({
  opId: r.op_id, deviceId: r.device_id, accountId: r.account_id, kind: r.kind, collection: r.collection,
  tempId: r.temp_id, targetId: r.target_id, status: r.status, resultId: r.result_id,
  localCreatedAt: r.local_created_at, receivedAt: r.received_at, appliedAt: r.applied_at, updatedAt: r.updated_at,
});

async function syncHistory(c, url) {
  const who = principalOf(c.request);
  const all = can(who, 'sync.view');
  if (!all && (!who || who.kind !== 'account')) return ok([], { count: 0 });
  const limit = readIntParam(url, 'limit', { def: 100, min: 1, max: 500 });
  if (limit.error) return fail('invalid_param', limit.error, 400);
  const deviceId = url.searchParams.get('deviceId');
  const where = []; const binds = [];
  if (!all) { binds.push(who.id); where.push(`account_id = ?${binds.length}`); }
  if (deviceId) { binds.push(deviceId); where.push(`device_id = ?${binds.length}`); }
  binds.push(limit.value);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM sync_ops ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at DESC LIMIT ?${binds.length}`
  ).bind(...binds).all();
  const rows = (results || []).map(opRecord);
  return ok(rows, { count: rows.length });
}

/* ---------------------------------------------------------------
   Push
   --------------------------------------------------------------- */

/** Replace every temporary reference in a value with its server id. */
async function resolveRefs(c, deviceId, value, missing) {
  if (typeof value === 'string') {
    if (!TEMP_REF.test(value)) return value;
    const row = await c.env.DB.prepare(
      `SELECT result_id, status FROM sync_ops WHERE device_id = ?1 AND temp_id = ?2 ORDER BY received_at DESC LIMIT 1`
    ).bind(deviceId, value).first();
    if (row && row.status === 'applied' && row.result_id) return row.result_id;
    missing.push({ ref: value, status: row ? row.status : 'not_received' });
    return value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await resolveRefs(c, deviceId, v, missing));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await resolveRefs(c, deviceId, v, missing);
    return out;
  }
  return value;
}

/** Fields a device keeps for itself, never sent to a route. */
function clientFree(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k.startsWith('_') || ['id', 'uuid', 'tempRef', 'createdAt', 'updatedAt'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

const SEVERITY = { payment: 'financial', invoice_draft: 'financial', parts_usage: 'inventory', stock_movement: 'inventory' };
const severityOf = (op) => SEVERITY[op.kind] || (op.collection === 'expenses' ? 'financial' : 'normal');

/** A route's refusal, as a conflict outcome. 5xx and 401 are not conflicts: they are retried. */
function refusal(op, r, extra = {}) {
  const e = errorOf(r);
  if (r.status === 401) return { status: 'stop', reason: 'unauthorized' };
  if (r.status >= 500 || r.status === 0) return { status: 'retry', reason: e.code || 'server_error' };
  let type = 'validation';
  if (r.status === 403) type = 'permission';
  else if (e.reason === 'insufficient_stock' || e.reason === 'part_not_found') type = 'inventory';
  else if (op.kind === 'payment') type = 'payment';
  else if (op.kind === 'invoice_draft') type = 'invoice';
  else if (r.status === 409 && /duplicate|unique|already/i.test(`${e.message || ''} ${e.reason || ''}`)) type = 'duplicate';
  return {
    status: 'conflict', type, severity: severityOf(op),
    reason: e.message || `The server refused this change (${r.status}).`,
    details: { answer: { status: r.status, code: e.code || null, reason: e.reason || null, message: e.message || null, fields: e.fields || null, shortages: e.shortages || null }, ...extra },
  };
}

/** Apply one operation. Returns an outcome; never throws. `opts.force` skips the edit/duplicate checks (an Admin's decision). */
async function applyOp(c, op, opts = {}) {
  const missing = [];
  const data = await resolveRefs(c, op.deviceId, op.data || {}, missing);
  const target = op.targetId ? await resolveRefs(c, op.deviceId, op.targetId, missing) : null;
  if (missing.length) {
    if (missing.some((m) => m.status === 'processing' || m.status === 'not_received')) {
      return { status: 'retry', reason: 'dependency_pending', details: { missing } };
    }
    return {
      status: 'conflict', type: 'dependency', severity: severityOf(op),
      reason: `This change depends on ${missing.map((m) => m.ref).join(', ')}, which the server did not accept.`,
      details: { missing, local: op.data },
    };
  }
  const path = PATHS[op.collection];
  // The author's own permission first, so a change they could not have made
  // online is reported as exactly that (the route would refuse it anyway).
  const routeOp = { create: 'create', update: 'update', status: 'status', payment: 'create', stock_movement: 'create', parts_usage: 'update' }[op.kind];
  if (routeOp && !opts.force) {
    const need = collectionPermission(op.kind === 'parts_usage' || op.kind === 'status' ? 'job-cards' : path, routeOp);
    if (!can(principalOf(c.request), need)) {
      return { status: 'conflict', type: 'permission', severity: severityOf(op), reason: 'Your role does not allow this change, so the server did not apply it.', details: { local: op.data, needs: need } };
    }
  }

  switch (op.kind) {
    case 'create': {
      const r = await call(c, 'POST', `/api/${path}`, clientFree(data));
      if (r.status === 201 || r.status === 200) return { status: 'applied', id: r.body.data.id, record: r.body.data };
      return refusal(op, r, { local: op.data });
    }

    case 'update': {
      const cur = await call(c, 'GET', `/api/${path}/${encodeURIComponent(target)}`);
      if (cur.status !== 200) return refusal(op, cur, { local: op.data });
      const server = cur.body.data;
      const changes = clientFree(data);
      const base = op.base && op.base.values ? op.base.values : null;
      if (!opts.force && base) {
        // Field by field: only a field this device changed AND someone else
        // also changed since the device last saw it is a conflict. No last-write-wins.
        const clashes = Object.keys(changes).filter((k) => Object.hasOwn(base, k) && !same(server[k], base[k]) && !same(server[k], changes[k]));
        if (clashes.length) {
          return {
            status: 'conflict', type: 'edit', severity: severityOf(op),
            reason: `Changed on the server since this device last saw it: ${clashes.join(', ')}.`,
            details: { fields: clashes, local: Object.fromEntries(clashes.map((k) => [k, changes[k]])),
              server: Object.fromEntries(clashes.map((k) => [k, server[k]])), base: Object.fromEntries(clashes.map((k) => [k, base[k]])),
              allLocal: changes, serverUpdatedAt: server.updatedAt || null },
          };
        }
      }
      const r = await call(c, 'PUT', `/api/${path}/${encodeURIComponent(target)}`, changes);
      if (r.status === 200) return { status: 'applied', id: r.body.data.id, record: r.body.data };
      return refusal(op, r, { local: changes });
    }

    case 'status': {
      const cur = await call(c, 'GET', `/api/job-cards/${encodeURIComponent(target)}`);
      if (cur.status !== 200) return refusal(op, cur, { local: op.data });
      const before = op.base && op.base.status;
      if (!opts.force && before && cur.body.data.status !== before && cur.body.data.status !== data.status) {
        return {
          status: 'conflict', type: 'edit', severity: 'inventory',
          reason: `The job card's status changed on the server (${before} → ${cur.body.data.status}) since this device moved it to ${data.status}.`,
          details: { fields: ['status'], local: { status: data.status }, server: { status: cur.body.data.status }, base: { status: before } },
        };
      }
      if (cur.body.data.status === data.status) return { status: 'applied', id: target, record: cur.body.data, note: 'already_in_status' };
      const r = await call(c, 'POST', `/api/job-cards/${encodeURIComponent(target)}/status`, { status: data.status });
      if (r.status === 200) return { status: 'applied', id: target, record: r.body.data };
      const out = refusal(op, r, { local: op.data });
      if (out.status === 'conflict' && errorOf(r).reason === 'insufficient_stock') { out.type = 'inventory'; out.severity = 'inventory'; }
      return out;
    }

    case 'payment': {
      const body = clientFree(data);
      const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
      delete body.reference;
      const notes = [body.notes, reference ? `Ref: ${reference}` : '', `Offline ${op.tempId || op.opId}`].filter(Boolean).join(' · ').slice(0, 1000);
      if (!opts.force) {
        // The same money, recorded twice (two devices, or a retype online): held for review, not applied.
        const dup = await c.env.DB.prepare(
          `SELECT id, amount, date, method FROM payments
            WHERE customer_id = ?1 AND amount = ?2 AND date = ?3 AND method = ?4 AND status <> 'Void'
              AND COALESCE(invoice_id, '') = COALESCE(?5, '') AND COALESCE(job_card_id, '') = COALESCE(?6, '') LIMIT 1`
        ).bind(body.customerId ?? null, Number(body.amount), body.date ?? null, body.method ?? 'Cash', body.invoiceId || null, body.jobCardId || null).first();
        if (dup) {
          return {
            status: 'conflict', type: 'duplicate', severity: 'financial',
            reason: `A payment with the same customer, amount, date and method is already recorded (${dup.id}). Held for review so the money is not counted twice.`,
            details: { local: op.data, server: dup },
          };
        }
      }
      const r = await call(c, 'POST', '/api/payments', { ...body, notes });
      if (r.status === 201) return { status: 'applied', id: r.body.data.id, record: r.body.data };
      return refusal(op, r, { local: op.data });
    }

    case 'invoice_draft': {
      const who = principalOf(c.request);
      if (!can(who, 'invoices.create')) {
        return { status: 'conflict', type: 'permission', severity: 'financial', reason: 'Your role may not create invoices, so this draft was not accepted.', details: { local: op.data } };
      }
      const job = await call(c, 'GET', `/api/job-cards/${encodeURIComponent(data.jobCardId || '')}`);
      if (job.status !== 200) return refusal(op, job, { local: op.data });
      const allocated = await allocateId(c.env, 'invoiceDrafts');
      if (allocated.error) return { status: 'retry', reason: 'id_allocation' };
      const at = nowIso();
      const localTotal = Number.isFinite(Number(data.localTotal)) ? Number(data.localTotal) : null;
      await c.env.DB.prepare(
        `INSERT INTO invoice_drafts (id, job_card_id, date, notes, status, local_total, local_snapshot, temp_ref, op_id, device_id, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'Draft', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
      ).bind(allocated.id, job.body.data.id, data.date || null, String(data.notes || '').slice(0, 1000), localTotal,
        json(data.lines || {}), op.tempId || null, op.opId, op.deviceId, op.accountId, at).run();
      await logChanges(c.env, [{ collection: 'invoiceDrafts', id: allocated.id, op: 'upsert' }]);
      return { status: 'applied', id: allocated.id, record: await draftById(c.env, allocated.id) };
    }

    case 'parts_usage': return applyPartsUsage(c, op, data, target);

    case 'stock_movement': {
      const r = await call(c, 'POST', '/api/inventory-transactions', clientFree(data));
      if (r.status === 201) return { status: 'applied', id: r.body.data.id, record: r.body.data };
      const out = refusal(op, r, { local: op.data });
      if (out.status === 'conflict') { out.type = out.type === 'permission' ? 'permission' : 'inventory'; out.severity = 'inventory'; }
      return out;
    }

    default:
      return { status: 'rejected', reason: 'unknown_kind' };
  }
}

/**
 * Parts usage recorded offline: ONE movement (part, quantity +/-) merged into
 * the job card's CURRENT lines on the server and saved through the job card's
 * own route -- which reconciles stock against the ledger for a job in
 * progress and refuses a shortage. Incremental, so two devices using parts on
 * the same job both count; never an overwrite of stock.
 */
async function applyPartsUsage(c, op, data, jobCardId) {
  const qty = Number(data.quantity);
  if (!Number.isFinite(qty) || qty === 0) return { status: 'rejected', reason: 'invalid_quantity' };
  const lockKey = `job:${jobCardId}`;
  if (!(await acquire(c.env, lockKey, op.opId))) return { status: 'retry', reason: 'busy' };
  try {
    const cur = await call(c, 'GET', `/api/job-cards/${encodeURIComponent(jobCardId)}`);
    if (cur.status !== 200) return refusal(op, cur, { local: op.data });
    const job = cur.body.data;
    const lines = (job.partsUsed || []).map((l) => ({ partId: l.partId || null, name: l.name, partNo: l.partNo || '', qty: Number(l.qty), unitPrice: Number(l.unitPrice) }));
    const partId = data.partId || null;
    const at = lines.findIndex((l) => (partId ? l.partId === partId : !l.partId && l.name === data.name));
    let unitPrice = Number.isFinite(Number(data.unitPrice)) ? Number(data.unitPrice) : null;
    if (at === -1) {
      if (qty < 0) {
        return { status: 'conflict', type: 'inventory', severity: 'inventory', reason: 'This device returned a part the job card no longer lists.', details: { local: op.data, server: { partsUsed: job.partsUsed } } };
      }
      let name = data.name; let partNo = data.partNo || '';
      if (partId) {
        const part = await call(c, 'GET', `/api/parts/${encodeURIComponent(partId)}`);
        if (part.status !== 200) return refusal(op, part, { local: op.data });
        name = part.body.data.name; partNo = part.body.data.partNo || partNo;
        // The server's price, unless the device set one on purpose (job_cards.edit covers prices).
        if (unitPrice === null) unitPrice = Number(part.body.data.sellingPrice) || 0;
      }
      lines.push({ partId, name, partNo, qty, unitPrice: unitPrice ?? 0 });
    } else {
      const next = lines[at].qty + qty;
      if (next < 0) {
        return { status: 'conflict', type: 'inventory', severity: 'inventory', reason: `This device returned more of ${lines[at].name} than the job card lists (${lines[at].qty}).`, details: { local: op.data, server: { line: lines[at] } } };
      }
      if (next === 0) lines.splice(at, 1);
      else { lines[at].qty = next; if (unitPrice !== null) lines[at].unitPrice = unitPrice; }
    }
    const r = await call(c, 'PUT', `/api/job-cards/${encodeURIComponent(jobCardId)}`, { partsUsed: lines });
    if (r.status === 200) return { status: 'applied', id: jobCardId, record: r.body.data };
    const out = refusal(op, r, { local: op.data, server: { status: job.status, partsUsed: job.partsUsed } });
    if (out.status === 'conflict' && out.type !== 'permission') { out.type = 'inventory'; out.severity = 'inventory'; }
    return out;
  } finally {
    await release(c.env, lockKey, op.opId);
  }
}

/* A short advisory lock per job card (sync_ops_locks): two devices' parts
   usage on the same job is applied one after the other, so neither
   read-modify-write of its lines can lose the other's. Expires by itself. */
async function acquire(env, key, holder) {
  for (let i = 0; i < 20; i++) {
    const now = Date.now();
    await env.DB.prepare('DELETE FROM sync_ops_locks WHERE expires_at < ?1').bind(now).run();
    const r = await env.DB.prepare('INSERT OR IGNORE INTO sync_ops_locks (key, holder, expires_at) VALUES (?1, ?2, ?3)').bind(key, holder, now + 15000).run();
    if ((r.meta && r.meta.changes) === 1) return true;
    await sleep(100);
  }
  return false;
}
async function release(env, key, holder) {
  await env.DB.prepare('DELETE FROM sync_ops_locks WHERE key = ?1 AND holder = ?2').bind(key, holder).run();
}

/** Validate one operation's shape. Returns { op } or { error }. */
function readOp(raw, who, deviceId) {
  if (!raw || typeof raw !== 'object') return { error: 'Not an object.' };
  const { opId, kind, collection, tempId, targetId, data, base, createdAt } = raw;
  if (typeof opId !== 'string' || !UUID.test(opId)) return { error: '`opId` must be a UUID.' };
  if (!KINDS.includes(kind)) return { error: '`kind` is not one the server knows.' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: '`data` must be an object.' };
  if (json(raw).length > MAX_OP_BYTES) return { error: 'The operation is too large.' };
  if (tempId !== undefined && tempId !== null && (typeof tempId !== 'string' || !TEMP_REF.test(tempId))) return { error: '`tempId` is not a temporary reference.' };
  if ((kind === 'create' || kind === 'update') && !OFFLINE_EDITABLE.includes(collection)) return { error: `${collection} cannot be changed offline.` };
  if (['update', 'status', 'parts_usage'].includes(kind) && (typeof targetId !== 'string' || !targetId)) return { error: '`targetId` is required.' };
  if (kind === 'status' && typeof data.status !== 'string') return { error: '`data.status` is required.' };
  const fixed = { payment: 'payments', invoice_draft: 'invoices', parts_usage: 'jobCards', stock_movement: 'inventoryTransactions', status: 'jobCards' };
  return {
    op: {
      opId, kind, collection: fixed[kind] || collection, tempId: tempId || null, targetId: targetId || null, data,
      base: base && typeof base === 'object' ? base : null, localCreatedAt: typeof createdAt === 'string' ? createdAt.slice(0, 40) : null,
      deviceId, accountId: who.id,
    },
  };
}

/** Record a conflict for an operation (one open conflict per operation). */
async function raiseConflict(env, op, out, at) {
  const existing = await env.DB.prepare("SELECT id FROM sync_conflicts WHERE op_id = ?1 AND status = 'Open'").bind(op.opId).first();
  if (existing) return existing.id;
  const allocated = await allocateId(env, 'syncConflicts');
  if (allocated.error) throw new Error(allocated.error);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_conflicts (id, op_id, type, severity, collection, record_id, temp_ref, device_id, account_id, reason, details, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'Open', ?12)`
    ).bind(allocated.id, op.opId, out.type, out.severity, op.collection, op.targetId || null, op.tempId || null, op.deviceId, op.accountId,
      String(out.reason).slice(0, 1000), json({ ...(out.details || {}), op: { kind: op.kind, collection: op.collection, tempId: op.tempId, targetId: op.targetId, localCreatedAt: op.localCreatedAt, data: op.data, base: op.base } }), at),
    env.DB.prepare("INSERT INTO sync_conflict_events (conflict_id, at, account_id, action, note, outcome) VALUES (?1, ?2, ?3, 'raised', ?4, '{}')")
      .bind(allocated.id, at, op.accountId, String(out.reason).slice(0, 1000)),
  ]);
  if (op.kind === 'parts_usage') {
    await env.DB.prepare("UPDATE offline_stock_movements SET status = 'Review', conflict_id = ?2, updated_at = ?3 WHERE op_id = ?1").bind(op.opId, allocated.id, at).run();
  }
  return allocated.id;
}

/** What the device is told about an operation, from its stored row. */
function answerFor(row) {
  const result = parse(row.result, {});
  return { opId: row.op_id, status: row.status, serverId: row.result_id || null, ...result };
}

async function pushOps(c) {
  const who = accountOf(c.request);
  if (!who) return fail('account_required', 'Offline sync needs a personal account sign-in.', 403);
  const body = await readJsonBody(c.request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const d = await deviceFor(c.env, who, body.value.deviceId);
  if (d.response) return d.response;
  const deviceId = d.row.id;
  const ops = body.value.ops;
  if (!Array.isArray(ops) || ops.length === 0) return unprocessable('`ops` must be a non-empty list.');
  if (ops.length > MAX_OPS) return unprocessable(`At most ${MAX_OPS} operations per push.`);
  await touchDevice(c.env, deviceId, who, nowIso());

  const results = [];
  let stopped = null;
  for (const raw of ops) {
    if (stopped) { results.push({ opId: raw && raw.opId, status: 'retry', reason: stopped }); continue; }
    const read = readOp(raw, who, deviceId);
    if (read.error) { results.push({ opId: raw && raw.opId, status: 'rejected', reason: 'invalid_op', message: read.error }); continue; }
    const op = read.op;
    const at = nowIso();
    // Claim it: the operation UUID is the idempotency key.
    const claim = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO sync_ops (op_id, device_id, account_id, kind, collection, temp_id, target_id, payload, status, local_created_at, received_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'processing', ?9, ?10, ?10)`
    ).bind(op.opId, deviceId, who.id, op.kind, op.collection, op.tempId, op.targetId, json({ data: op.data, base: op.base }), op.localCreatedAt, at).run();
    if ((claim.meta && claim.meta.changes) !== 1) {
      const row = await c.env.DB.prepare('SELECT * FROM sync_ops WHERE op_id = ?1').bind(op.opId).first();
      if (!row || row.device_id !== deviceId || row.account_id !== who.id) {
        results.push({ opId: op.opId, status: 'rejected', reason: 'op_id_reused', message: 'This operation id belongs to another device or person.' });
        continue;
      }
      if (row.status !== 'processing') { results.push({ ...answerFor(row), replayed: true }); continue; }
      if (Date.now() - Date.parse(row.updated_at || row.received_at) < STALE_CLAIM_MS) {
        results.push({ opId: op.opId, status: 'retry', reason: 'in_progress' });
        continue;
      }
      // Cut off mid-way earlier: whether it reached the database is unknown. Review, never re-post.
      const out = { status: 'conflict', type: 'interrupted', severity: severityOf(op),
        reason: 'An earlier attempt to apply this change was interrupted, so the server cannot tell whether it was saved. Check the records, then mark it applied or retry it.',
        details: { local: op.data } };
      const conflictId = await raiseConflict(c.env, op, out, at);
      await c.env.DB.prepare("UPDATE sync_ops SET status = 'conflict', result = ?2, updated_at = ?3 WHERE op_id = ?1")
        .bind(op.opId, json({ conflictId, type: out.type, reason: out.reason }), at).run();
      results.push({ opId: op.opId, status: 'conflict', conflictId, type: out.type, reason: out.reason });
      continue;
    }

    if (op.kind === 'parts_usage') {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO offline_stock_movements (op_id, part_id, job_card_id, type, quantity, account_id, device_id, local_created_at, received_at, status, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'Review', ?9)`
      ).bind(op.opId, String(op.data.partId || op.data.name || '').slice(0, 200), op.targetId, Number(op.data.quantity) < 0 ? 'return' : 'job-card-use',
        Math.abs(Number(op.data.quantity)) || 0.0001, who.id, deviceId, op.localCreatedAt, at).run().catch(() => {});
    }

    let out;
    try { out = await applyOp(c, op); } catch (err) {
      console.error('sync: applying an operation failed', err && err.message);
      out = { status: 'retry', reason: 'server_error' };
    }
    const done = nowIso();
    if (out.status === 'applied') {
      const answer = { record: out.record || null };
      await c.env.DB.prepare("UPDATE sync_ops SET status = 'applied', result_id = ?2, result = ?3, applied_at = ?4, updated_at = ?4 WHERE op_id = ?1")
        .bind(op.opId, out.id || null, json(answer), done).run();
      if (op.kind === 'parts_usage') {
        await c.env.DB.prepare("UPDATE offline_stock_movements SET status = 'Applied', applied_at = ?2, updated_at = ?2 WHERE op_id = ?1").bind(op.opId, done).run();
      }
      results.push({ opId: op.opId, status: 'applied', serverId: out.id || null, record: out.record || null });
    } else if (out.status === 'conflict') {
      const conflictId = await raiseConflict(c.env, op, out, done);
      await c.env.DB.prepare("UPDATE sync_ops SET status = 'conflict', result = ?2, updated_at = ?3 WHERE op_id = ?1")
        .bind(op.opId, json({ conflictId, type: out.type, reason: out.reason }), done).run();
      results.push({ opId: op.opId, status: 'conflict', conflictId, type: out.type, reason: out.reason });
    } else if (out.status === 'rejected') {
      await c.env.DB.prepare("UPDATE sync_ops SET status = 'rejected', result = ?2, updated_at = ?3 WHERE op_id = ?1")
        .bind(op.opId, json({ reason: out.reason }), done).run();
      results.push({ opId: op.opId, status: 'rejected', reason: out.reason });
    } else {
      // Not applied and safe to try again (the route's write rolled back, or a
      // dependency is still on its way): the claim is released.
      await c.env.DB.prepare("DELETE FROM sync_ops WHERE op_id = ?1 AND status = 'processing'").bind(op.opId).run();
      if (op.kind === 'parts_usage') await c.env.DB.prepare("DELETE FROM offline_stock_movements WHERE op_id = ?1 AND status = 'Review' AND conflict_id IS NULL").bind(op.opId).run();
      if (out.status === 'stop') stopped = out.reason;
      results.push({ opId: op.opId, status: 'retry', reason: out.reason });
    }
  }
  if (stopped === 'unauthorized') return fail('unauthorized', 'Authentication required.', 401, { results });
  return ok({ results }, { serverTime: nowIso() });
}

/* ---------------------------------------------------------------
   Pull
   --------------------------------------------------------------- */

const DRAFT_COLUMNS = '*';
function toDraft(r) {
  return {
    id: r.id, jobCardId: r.job_card_id, date: r.date || null, notes: r.notes || '', status: r.status,
    localTotal: r.local_total, localSnapshot: parse(r.local_snapshot, {}), invoiceId: r.invoice_id || null,
    tempRef: r.temp_ref || null, deviceId: r.device_id || null, createdBy: r.created_by, createdAt: r.created_at,
    finalizedBy: r.finalized_by || null, finalizedAt: r.finalized_at || null,
    discardedBy: r.discarded_by || null, discardedAt: r.discarded_at || null, discardReason: r.discard_reason || '',
    updatedAt: r.updated_at || null,
  };
}
async function draftById(env, id) {
  const r = await env.DB.prepare(`SELECT ${DRAFT_COLUMNS} FROM invoice_drafts WHERE id = ?1`).bind(id).first();
  return r ? toDraft(r) : null;
}

async function pullChanges(c, url) {
  const who = accountOf(c.request);
  if (!who) return fail('account_required', 'Offline sync needs a personal account sign-in.', 403);
  const d = await deviceFor(c.env, who, url.searchParams.get('deviceId'));
  if (d.response) return d.response;
  const cursor = readIntParam(url, 'cursor', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = readIntParam(url, 'limit', { def: 200, min: 1, max: 500 });
  if (cursor.error || limit.error) return fail('invalid_param', cursor.error || limit.error, 400);
  const { results } = await c.env.DB.prepare(
    'SELECT seq, collection, record_id, op FROM change_log WHERE seq > ?1 ORDER BY seq LIMIT ?2'
  ).bind(cursor.value, limit.value + 1).all();
  const rows = results || [];
  const hasMore = rows.length > limit.value;
  const page = rows.slice(0, limit.value);
  // The latest entry per record wins; the earlier ones are superseded.
  const latest = new Map();
  for (const r of page) latest.set(`${r.collection}|${r.record_id}`, r);
  const changes = [];
  const entries = [...latest.values()].sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = await Promise.all(entries.slice(i, i + 8).map(async (r) => {
      const base = { seq: Number(r.seq), collection: r.collection, id: r.record_id };
      if (r.op === 'refresh') {
        // A write elsewhere moved this collection (a payment, its invoice): re-read it -- if this role may.
        const path = PATHS[r.collection];
        return path && can(who, collectionPermission(path, 'view')) ? { ...base, op: 'refresh' } : { ...base, op: 'hidden' };
      }
      if (r.op === 'delete') return { ...base, op: 'delete' };
      if (r.collection === 'invoiceDrafts') {
        if (!can(who, 'invoices.view')) return { ...base, op: 'hidden' };
        const draft = await draftById(c.env, r.record_id);
        return draft ? { ...base, op: 'upsert', record: draft } : { ...base, op: 'delete' };
      }
      const path = PATHS[r.collection];
      if (!path) return { ...base, op: 'hidden' };
      const got = await call(c, 'GET', `/api/${path}/${encodeURIComponent(r.record_id)}`);
      if (got.status === 200) return { ...base, op: 'upsert', record: got.body.data };
      if (got.status === 404) return { ...base, op: 'delete' };
      return { ...base, op: 'hidden' };   // not this role's to read (403), or a passing error
    }));
    changes.push(...chunk);
  }
  const next = page.length ? Number(page[page.length - 1].seq) : cursor.value;
  return ok({ changes, cursor: next, hasMore }, { serverTime: nowIso() });
}

/* ---------------------------------------------------------------
   Conflicts
   --------------------------------------------------------------- */

function toConflict(r, events = null) {
  return {
    id: r.id, opId: r.op_id, type: r.type, severity: r.severity, collection: r.collection, recordId: r.record_id,
    tempRef: r.temp_ref, deviceId: r.device_id, accountId: r.account_id, username: r.username || null, deviceCode: r.device_code || null,
    reason: r.reason, details: parse(r.details, {}), status: r.status, resolution: r.resolution || null,
    resolutionNote: r.resolution_note || null, resolvedBy: r.resolved_by || null, resolvedAt: r.resolved_at || null,
    resultId: r.result_id || null, createdAt: r.created_at, actions: actionsFor(r),
    ...(events ? { history: events } : {}),
  };
}

/** What can be done with a conflict of this type. */
function actionsFor(r) {
  if (r.status !== 'Open') return [];
  const base = ['retry', 'dismiss'];
  if (r.type === 'edit') return ['apply_local', 'keep_server', 'retry'];
  if (r.type === 'duplicate' && (r.collection === 'payments')) return ['apply_anyway', 'dismiss'];
  if (r.type === 'interrupted') return ['mark_applied', 'retry', 'dismiss'];
  return base;
}

const CONFLICT_SQL = `SELECT sc.*, a.username, d.code AS device_code FROM sync_conflicts sc
  LEFT JOIN user_accounts a ON a.id = sc.account_id LEFT JOIN devices d ON d.id = sc.device_id`;

async function listConflicts(c, url) {
  const who = principalOf(c.request);
  const all = can(who, 'sync.view');
  if (!all && (!who || who.kind !== 'account')) return ok([], { count: 0 });
  const status = url.searchParams.get('status') || 'Open';
  const where = []; const binds = [];
  if (status !== 'all') { binds.push(status === 'Resolved' ? 'Resolved' : 'Open'); where.push(`sc.status = ?${binds.length}`); }
  if (!all) { binds.push(who.id); where.push(`sc.account_id = ?${binds.length}`); }
  const { results } = await c.env.DB.prepare(
    `${CONFLICT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sc.created_at DESC LIMIT 500`
  ).bind(...binds).all();
  const rows = (results || []).map((r) => toConflict(r));
  return ok(rows, { count: rows.length, canResolve: can(who, 'sync.manage') });
}

async function getConflict(c, id) {
  const who = principalOf(c.request);
  const row = await c.env.DB.prepare(`${CONFLICT_SQL} WHERE sc.id = ?1`).bind(id).first();
  if (!row || (!can(who, 'sync.view') && !(who && who.kind === 'account' && row.account_id === who.id))) {
    return fail('not_found', 'No such conflict.', 404);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT e.*, a.username FROM sync_conflict_events e LEFT JOIN user_accounts a ON a.id = e.account_id WHERE e.conflict_id = ?1 ORDER BY e.id`
  ).bind(id).all();
  const events = (results || []).map((e) => ({ at: e.at, accountId: e.account_id, username: e.username || null, action: e.action, note: e.note, outcome: parse(e.outcome, {}) }));
  return ok(toConflict(row, events));
}

async function resolveConflict(c, id) {
  const who = principalOf(c.request);
  if (!can(who, 'sync.manage')) return fail('forbidden', 'Only an authorized administrator can resolve sync conflicts.', 403);
  const body = await readJsonBody(c.request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const row = await c.env.DB.prepare('SELECT * FROM sync_conflicts WHERE id = ?1').bind(id).first();
  if (!row) return fail('not_found', 'No such conflict.', 404);
  if (row.status !== 'Open') return conflict('This conflict is already resolved.', { reason: 'already_resolved' });
  const action = body.value.action;
  const note = typeof body.value.note === 'string' ? body.value.note.trim().slice(0, 1000) : '';
  if (!actionsFor(row).includes(action)) {
    return unprocessable('That action is not available for this conflict.', { action: `One of: ${actionsFor(row).join(', ')}.` });
  }
  // Financial and inventory decisions are reviewed: the reason is required and kept.
  if (row.severity !== 'normal' && note.length < 5) {
    return unprocessable('A note (at least 5 characters) is required to resolve a financial or inventory conflict.', { note: 'Required.' });
  }
  const opRow = await c.env.DB.prepare('SELECT * FROM sync_ops WHERE op_id = ?1').bind(row.op_id).first();
  if (!opRow) return fail('not_found', 'The operation behind this conflict is missing.', 404);
  const stored = parse(opRow.payload, {});
  const op = {
    opId: opRow.op_id, kind: opRow.kind, collection: opRow.collection, tempId: opRow.temp_id, targetId: opRow.target_id,
    data: stored.data || {}, base: stored.base || null, localCreatedAt: opRow.local_created_at, deviceId: opRow.device_id, accountId: opRow.account_id,
  };
  const at = nowIso();
  const actor = who.kind === 'account' ? who.id : who.kind;
  const finish = async (resolution, resultId, outcome, opStatus) => {
    const stmts = [
      c.env.DB.prepare(`UPDATE sync_conflicts SET status = 'Resolved', resolution = ?2, resolution_note = ?3, resolved_by = ?4, resolved_at = ?5, result_id = ?6 WHERE id = ?1 AND status = 'Open'`)
        .bind(id, resolution, note, actor, at, resultId || null),
      c.env.DB.prepare('INSERT INTO sync_conflict_events (conflict_id, at, account_id, action, note, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
        .bind(id, at, actor, resolution, note, json(outcome)),
    ];
    if (opStatus === 'applied') {
      stmts.push(c.env.DB.prepare("UPDATE sync_ops SET status = 'applied', result_id = ?2, result = ?3, applied_at = ?4, updated_at = ?4 WHERE op_id = ?1")
        .bind(op.opId, resultId || null, json({ record: outcome.record || null, resolvedBy: actor, conflictId: id }), at));
      if (op.kind === 'parts_usage') stmts.push(c.env.DB.prepare("UPDATE offline_stock_movements SET status = 'Applied', applied_at = ?2, updated_at = ?2 WHERE op_id = ?1").bind(op.opId, at));
    } else {
      stmts.push(c.env.DB.prepare("UPDATE sync_ops SET status = 'dismissed', result = ?2, updated_at = ?3 WHERE op_id = ?1")
        .bind(op.opId, json({ conflictId: id, resolution, resolvedBy: actor, reason: note }), at));
      if (op.kind === 'parts_usage') stmts.push(c.env.DB.prepare("UPDATE offline_stock_movements SET status = 'Dismissed', updated_at = ?2 WHERE op_id = ?1").bind(op.opId, at));
    }
    await c.env.DB.batch(stmts);
    const r = await c.env.DB.prepare(`${CONFLICT_SQL} WHERE sc.id = ?1`).bind(id).first();
    return ok(toConflict(r));
  };

  if (action === 'dismiss' || action === 'keep_server') return finish(action, null, {}, 'dismissed');
  if (action === 'mark_applied') {
    const resultId = typeof body.value.resultId === 'string' ? body.value.resultId.trim() : '';
    if (!/^[A-Z]{2,5}-\d{1,10}$/.test(resultId)) return unprocessable('Name the record that was saved.', { resultId: 'A record id such as PAY-0042.' });
    return finish(action, resultId, { resultId }, 'applied');
  }
  // retry / apply_local / apply_anyway: apply it now, with this administrator's authority.
  const out = await applyOp(c, op, { force: action !== 'retry' });
  if (out.status === 'applied') return finish(action, out.id, { record: out.record || null }, 'applied');
  await c.env.DB.prepare('INSERT INTO sync_conflict_events (conflict_id, at, account_id, action, note, outcome) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, at, actor, `${action}_failed`, note, json({ status: out.status, reason: out.reason || null, details: out.details || null })).run();
  return conflict(`Still not applied: ${out.reason || out.status}`, { reason: 'not_applied', outcome: out.status });
}

/* ---------------------------------------------------------------
   Invoice drafts
   --------------------------------------------------------------- */

async function listDrafts(c, url) {
  const who = principalOf(c.request);
  if (!can(who, 'invoices.view')) return fail('forbidden', 'Your role does not allow this.', 403);
  const status = url.searchParams.get('status') || 'Draft';
  const { results } = status === 'all'
    ? await c.env.DB.prepare('SELECT * FROM invoice_drafts ORDER BY created_at DESC LIMIT 500').all()
    : await c.env.DB.prepare('SELECT * FROM invoice_drafts WHERE status = ?1 ORDER BY created_at DESC LIMIT 500').bind(status).all();
  const rows = (results || []).map(toDraft);
  return ok(rows, { count: rows.length });
}

async function finalizeDraft(c, id) {
  const who = principalOf(c.request);
  if (!can(who, 'invoices.create')) return fail('forbidden', 'Your role does not allow this.', 403);
  const draft = await draftById(c.env, id);
  if (!draft) return fail('not_found', 'No such invoice draft.', 404);
  if (draft.status !== 'Draft') return conflict(`This draft is already ${draft.status}.`, { reason: 'not_draft', invoiceId: draft.invoiceId });
  const body = await readOptionalBody(c.request);
  const accept = !!(body && body.value && body.value.acceptCurrentPricing === true);
  const job = await call(c, 'GET', `/api/job-cards/${encodeURIComponent(draft.jobCardId)}`);
  if (job.status !== 200) return fail(errorOf(job).code || 'not_found', errorOf(job).message || 'The job card could not be read.', job.status);
  const current = Number(job.body.data.total) || 0;
  // The server's pricing is what an invoice copies. If it moved since the draft
  // was made offline, someone must look at it before an invoice exists.
  if (draft.localTotal !== null && Math.abs(current - Number(draft.localTotal)) > 0.005 && !accept) {
    return conflict(`The job card's total is now ${current}, but the draft was made when it was ${draft.localTotal}. Review the pricing, then finalize with the current pricing.`,
      { reason: 'pricing_changed', draftTotal: draft.localTotal, currentTotal: current });
  }
  const r = await call(c, 'POST', '/api/invoices', { jobCardId: draft.jobCardId, ...(draft.date ? { date: draft.date } : {}), ...(draft.notes ? { notes: draft.notes } : {}) });
  if (r.status !== 201) {
    const e = errorOf(r);
    return fail(e.code || 'conflict', e.message || 'The invoice could not be created.', r.status, { reason: e.reason || null });
  }
  const at = nowIso();
  await c.env.DB.prepare("UPDATE invoice_drafts SET status = 'Finalized', invoice_id = ?2, finalized_by = ?3, finalized_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = 'Draft'")
    .bind(id, r.body.data.id, who.kind === 'account' ? who.id : who.kind, at).run();
  await logChanges(c.env, [{ collection: 'invoiceDrafts', id, op: 'upsert' }]);
  return ok({ draft: await draftById(c.env, id), invoice: r.body.data }, { appliedAdvances: r.body.appliedAdvances || [] });
}

async function discardDraft(c, id) {
  const who = principalOf(c.request);
  if (!can(who, 'invoices.create')) return fail('forbidden', 'Your role does not allow this.', 403);
  const draft = await draftById(c.env, id);
  if (!draft) return fail('not_found', 'No such invoice draft.', 404);
  if (draft.status !== 'Draft') return conflict(`This draft is already ${draft.status}.`, { reason: 'not_draft' });
  const body = await readJsonBody(c.request);
  const reason = body.value && typeof body.value.reason === 'string' ? body.value.reason.trim().slice(0, 300) : '';
  if (reason.length < 3) return unprocessable('Say why the draft is discarded.', { reason: 'Required.' });
  const at = nowIso();
  await c.env.DB.prepare("UPDATE invoice_drafts SET status = 'Discarded', discarded_by = ?2, discarded_at = ?3, discard_reason = ?4, updated_at = ?3 WHERE id = ?1 AND status = 'Draft'")
    .bind(id, who.kind === 'account' ? who.id : who.kind, at, reason).run();
  await logChanges(c.env, [{ collection: 'invoiceDrafts', id, op: 'upsert' }]);
  return ok(await draftById(c.env, id));
}

/* ---------------------------------------------------------------
   Dispatch
   --------------------------------------------------------------- */

/**
 * `dispatch(request)` is the Worker's own fetch handler: operations are applied
 * through the existing routes, never around them.
 */
export async function sync(request, env, url, dispatch, ctx) {
  if (!env.DB) return noDatabase();
  const c = { request, env, dispatch, ctx };
  const p = url.pathname;
  const m = request.method;
  try {
    if (p === '/api/devices/register') return m === 'POST' ? registerDevice(c) : methodNotAllowed(['POST']);
    if (p === '/api/devices') return m === 'GET' ? listDevices(c) : methodNotAllowed(['GET']);
    let match = /^\/api\/devices\/([^/]+)$/.exec(p);
    if (match) return m === 'DELETE' ? revokeDevice(c, decodeURIComponent(match[1])) : methodNotAllowed(['DELETE']);
    if (p === '/api/sync/status') return m === 'GET' ? syncStatus(c, url) : methodNotAllowed(['GET']);
    if (p === '/api/sync/push') return m === 'POST' ? pushOps(c) : methodNotAllowed(['POST']);
    if (p === '/api/sync/pull') return m === 'GET' ? pullChanges(c, url) : methodNotAllowed(['GET']);
    if (p === '/api/sync/history') return m === 'GET' ? syncHistory(c, url) : methodNotAllowed(['GET']);
    if (p === '/api/sync/conflicts') return m === 'GET' ? listConflicts(c, url) : methodNotAllowed(['GET']);
    match = /^\/api\/sync\/conflicts\/(CNF-\d{1,10})(\/resolve)?$/.exec(p);
    if (match) {
      if (match[2]) return m === 'POST' ? resolveConflict(c, match[1]) : methodNotAllowed(['POST']);
      return m === 'GET' ? getConflict(c, match[1]) : methodNotAllowed(['GET']);
    }
    if (p === '/api/invoice-drafts') return m === 'GET' ? listDrafts(c, url) : methodNotAllowed(['GET']);
    match = /^\/api\/invoice-drafts\/(DRF-\d{1,10})(?:\/(finalize|discard))?$/.exec(p);
    if (match) {
      if (match[2] === 'finalize') return m === 'POST' ? finalizeDraft(c, match[1]) : methodNotAllowed(['POST']);
      if (match[2] === 'discard') return m === 'POST' ? discardDraft(c, match[1]) : methodNotAllowed(['POST']);
      if (m !== 'GET') return methodNotAllowed(['GET']);
      if (!can(principalOf(request), 'invoices.view')) return fail('forbidden', 'Your role does not allow this.', 403);
      const d = await draftById(env, match[1]);
      return d ? ok(d) : fail('not_found', 'No such invoice draft.', 404);
    }
    return notFound(SYNC_ROUTES);
  } catch (err) {
    console.error('sync route failed:', err && err.message);
    if (/no such table/i.test(String(err && err.message))) return fail('not_migrated', 'Offline sync needs migration 0020.', 503);
    return fail('database_error', 'The sync request could not be completed.', 500);
  }
}
