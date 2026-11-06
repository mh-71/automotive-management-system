/* ============================================================
   routes/asset-history.js — /api/asset-history   (read only)
   ------------------------------------------------------------
   Workshop Assets › Asset History: one timeline of what has happened to
   the equipment, read from the records the other Workshop Assets pages
   already keep. Nothing new is stored and nothing is written here.

     GET /api/asset-history            the timeline, newest first --
                                       q, toolId, type, range (all | 30 |
                                       90 | 365 days), limit, offset;
                                       `summary` counts the activities that
                                       match the same filters
     GET /api/asset-history/:toolId    one asset as it is now, with its
                                       whole timeline (Asset details)

   Where each activity comes from -- every one from exactly ONE source,
   so the same event is never listed twice:
     Asset Purchased        tools: one per item (purchase date and price,
                            or the day it was added to the register).
                            tool_events 'create' is NOT used: items
                            registered before 0021 have no such row.
     Asset Assigned         tool_events 'assign'   (Equipment Inventory and
     Asset Returned         tool_events 'return'    Asset Assignment both
                                                    write these; the
                                                    tool_assignment_events
                                                    copies are NOT used)
     Status Changed         tool_events 'status', 'retire', 'reactivate',
                            'delete'
     Maintenance Completed  tool_maintenance: Completed, other than Repair
     Repair Recorded        tool_maintenance: Repair, In Progress or Completed
   Field edits (tool_events 'update') are not activities.

   Permission: tools.view (the existing Workshop Assets "view").
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId } from '../lib/http.js';
import { todayInDhaka } from '../lib/write.js';

export const ACTIVITY_TYPES = ['Asset Purchased', 'Asset Assigned', 'Asset Returned', 'Maintenance Completed', 'Repair Recorded', 'Status Changed'];
export const RANGES = ['all', '30', '90', '365'];
const PERSON_ID = /\(([A-Z]{3}-\d{4,})\)/g;
const ASG_ID = /\b(ASG-\d{1,10})\b/;
const NOT_PEOPLE = new Set(['TOL', 'MNT', 'ASG']);

/* Every activity, as one row shape. Dates: `day` is the workshop's calendar
   day (Asia/Dhaka, UTC+6, no daylight saving); `at` the moment, when known. */
const ACTIVITIES = `
  SELECT 'tl:' || t.id AS key, 'Asset Purchased' AS type, t.id AS tool_id, t.name AS tool_name,
         coalesce(t.purchase_date, date(t.created_at, '+6 hours')) AS day,
         CASE WHEN t.purchase_date IS NULL THEN t.created_at END AS at,
         t.created_by AS actor, NULL AS related,
         CASE WHEN t.purchase_date IS NOT NULL OR t.purchase_price IS NOT NULL THEN 'Bought' ELSE 'Added to the register' END
           || ' · ' || t.category || coalesce(' · from ' || t.supplier, '') || coalesce(' · ' || t.brand, '') || coalesce(' ' || t.model, '') AS summary,
         t.purchase_price AS amount, 0 AS seq
    FROM tools t
  UNION ALL
  SELECT 'te:' || e.id,
         CASE e.action WHEN 'assign' THEN 'Asset Assigned' WHEN 'return' THEN 'Asset Returned' ELSE 'Status Changed' END,
         e.tool_id,
         coalesce((SELECT t.name FROM tools t WHERE t.id = e.tool_id),
                  (SELECT m.tool_name FROM tool_maintenance m WHERE m.tool_id = e.tool_id LIMIT 1),
                  (SELECT a.tool_name FROM tool_assignments a WHERE a.tool_id = e.tool_id LIMIT 1), e.tool_id),
         date(e.occurred_at, '+6 hours'), e.occurred_at, e.actor, NULL,
         e.summary,
         NULL, e.id
    FROM tool_events e
   WHERE e.action IN ('assign', 'return', 'status', 'retire', 'reactivate', 'delete')
  UNION ALL
  SELECT 'mn:' || m.id,
         CASE WHEN m.maintenance_type = 'Repair' THEN 'Repair Recorded' ELSE 'Maintenance Completed' END,
         m.tool_id, coalesce((SELECT t.name FROM tools t WHERE t.id = m.tool_id), m.tool_name),
         coalesce(m.completed_date, date(m.started_at, '+6 hours')), coalesce(m.completed_at, m.started_at),
         coalesce((SELECT x.actor FROM tool_maintenance_events x WHERE x.maintenance_id = m.id AND x.action IN ('complete', 'start') ORDER BY x.id DESC LIMIT 1), m.updated_by),
         m.technician_name,
         m.maintenance_type || ' ' || m.id || CASE WHEN m.status = 'In Progress' THEN ' (in progress)' ELSE '' END
           || coalesce(': ' || m.work_done, ': ' || m.description, '') || coalesce(' · vendor ' || m.vendor, ''),
         m.actual_cost, 0
    FROM tool_maintenance m
   WHERE m.status = 'Completed' OR (m.maintenance_type = 'Repair' AND m.status = 'In Progress')`;

function addDays(day, days) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Who an assignment entry is about: the person id in its text, or the assignment it names. */
async function attachPeople(env, rows) {
  const ids = new Set();
  const asg = new Set();
  for (const r of rows) {
    if (r.type !== 'Asset Assigned' && r.type !== 'Asset Returned') continue;
    const people = [...String(r.summary).matchAll(PERSON_ID)].map((m) => m[1]).filter((id) => !NOT_PEOPLE.has(id.slice(0, 3)));
    r._person = people.length ? people[people.length - 1] : null;
    if (r._person) ids.add(r._person);
    else { const a = ASG_ID.exec(r.summary); if (a) { r._asg = a[1]; asg.add(a[1]); } }
  }
  const names = new Map();
  if (ids.size) {
    const list = [...ids];
    const ph = list.map((_, i) => `?${i + 1}`).join(', ');
    const { results } = await env.DB.prepare(
      `SELECT id, name FROM staff WHERE id IN (${ph}) UNION ALL SELECT id, name FROM mechanics WHERE id IN (${ph})`
    ).bind(...list).all();
    for (const p of results || []) if (!names.has(p.id)) names.set(p.id, p.name);
  }
  const holders = new Map();
  if (asg.size) {
    const list = [...asg];
    const { results } = await env.DB.prepare(
      `SELECT id, assignee_id, assignee_name FROM tool_assignments WHERE id IN (${list.map((_, i) => `?${i + 1}`).join(', ')})`
    ).bind(...list).all();
    for (const a of results || []) holders.set(a.id, a);
  }
  for (const r of rows) {
    if (r._person) { r.relatedId = r._person; r.relatedName = names.get(r._person) || ''; }
    else if (r._asg && holders.has(r._asg)) { r.relatedId = holders.get(r._asg).assignee_id; r.relatedName = holders.get(r._asg).assignee_name; }
  }
}

function toRecord(r) {
  return {
    key: r.key,
    type: r.type,
    toolId: r.tool_id,
    toolName: r.tool_name || r.tool_id,
    date: r.day,
    at: r.at || null,
    performedBy: r.actor || '',
    relatedId: r.relatedId || '',
    relatedName: r.relatedName || r.related || '',
    description: r.summary || '',
    amount: r.amount ?? null,
  };
}

function readFilters(url) {
  const toolId = url.searchParams.get('toolId') || null;
  if (toolId !== null && readRecordId(toolId).error) return { error: '`toolId` is not a valid equipment id.' };
  const type = url.searchParams.get('type') || null;
  if (type !== null && !ACTIVITY_TYPES.includes(type)) return { error: `\`type\` must be one of: ${ACTIVITY_TYPES.join(', ')}.` };
  const range = url.searchParams.get('range') || 'all';
  if (!RANGES.includes(range)) return { error: `\`range\` must be one of: ${RANGES.join(', ')}.` };
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 100) return { error: '`q` must be 100 characters or fewer.' };
  const today = todayInDhaka();
  return {
    toolId, type, range, today,
    since: range === 'all' ? null : addDays(today, -Number(range)),
    needle: q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
  };
}

// ?1 toolId ?2 type ?3 since ?4 needle
const WHERE = `
  WHERE day IS NOT NULL
    AND (?1 IS NULL OR tool_id = ?1)
    AND (?2 IS NULL OR type = ?2)
    AND (?3 IS NULL OR day >= ?3)
    AND (?4 IS NULL OR lower(coalesce(tool_name, '')) LIKE ?4 ESCAPE '\\' OR lower(tool_id) LIKE ?4 ESCAPE '\\'
         OR lower(coalesce(summary, '')) LIKE ?4 ESCAPE '\\' OR lower(coalesce(actor, '')) LIKE ?4 ESCAPE '\\'
         OR lower(coalesce(related, '')) LIKE ?4 ESCAPE '\\' OR lower(type) LIKE ?4 ESCAPE '\\')`;
const ORDER = 'ORDER BY day DESC, coalesce(at, day) DESC, seq DESC, key DESC';

function summarise(rows) {
  const by = Object.fromEntries(ACTIVITY_TYPES.map((t) => [t, 0]));
  for (const r of rows || []) by[r.type] = r.n;
  return {
    total: Object.values(by).reduce((a, b) => a + b, 0),
    purchases: by['Asset Purchased'],
    assigned: by['Asset Assigned'],
    returned: by['Asset Returned'],
    maintenance: by['Maintenance Completed'],
    repairs: by['Repair Recorded'],
    statusChanges: by['Status Changed'],
  };
}

/* ---------- GET /api/asset-history ---------- */

export async function listAssetHistory(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const f = readFilters(url);
  if (f.error) return fail('invalid_parameter', f.error, 400);
  const binds = [f.toolId, f.type, f.since, f.needle];
  try {
    const { results } = await env.DB.prepare(`WITH acts AS (${ACTIVITIES}) SELECT * FROM acts ${WHERE} ${ORDER} LIMIT ?5 OFFSET ?6`)
      .bind(...binds, limit.value, offset.value).all();
    const counts = await env.DB.prepare(`WITH acts AS (${ACTIVITIES}) SELECT type, count(*) AS n FROM acts ${WHERE} GROUP BY type`)
      .bind(...binds).all();
    const rows = results || [];
    await attachPeople(env, rows);
    const summary = summarise(counts.results);
    return ok(rows.map(toRecord), { count: rows.length, total: summary.total, limit: limit.value, offset: offset.value, summary, today: f.today });
  } catch (err) {
    console.error('GET /api/asset-history failed:', err && err.message);
    return fail('database_error', 'Could not read the asset history.', 500);
  }
}

/* ---------- GET /api/asset-history/:toolId ---------- */

export async function getAssetHistory(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  try {
    const tool = await env.DB.prepare(
      `SELECT id, name, category, brand, model, serial_no, purchase_date, purchase_price, supplier, location, condition, status,
              last_service_date, next_service_due,
              coalesce((SELECT s.name FROM staff s WHERE s.id = tools.assigned_staff_id),
                       (SELECT m.name FROM mechanics m WHERE m.id = tools.assigned_mechanic_id)) AS holder
         FROM tools WHERE id = ?1`
    ).bind(id.value).first();
    const { results } = await env.DB.prepare(`WITH acts AS (${ACTIVITIES}) SELECT * FROM acts WHERE day IS NOT NULL AND tool_id = ?1 ${ORDER} LIMIT 200`)
      .bind(id.value).all();
    const rows = results || [];
    if (!tool && !rows.length) return fail('not_found', 'No equipment with that id.', 404);
    await attachPeople(env, rows);
    const counts = {};
    for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
    return ok({
      asset: tool ? {
        id: tool.id, name: tool.name, category: tool.category, brand: tool.brand || '', model: tool.model || '', serialNo: tool.serial_no || '',
        purchaseDate: tool.purchase_date || '', purchasePrice: tool.purchase_price ?? null, supplier: tool.supplier || '',
        location: tool.location || '', condition: tool.condition, status: tool.status, holder: tool.holder || '',
        lastServiceDate: tool.last_service_date || '', nextServiceDue: tool.next_service_due || '',
      } : null,
      inRegister: Boolean(tool),
      activities: rows.map(toRecord),
      counts,
    });
  } catch (err) {
    console.error('GET /api/asset-history/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the asset history.', 500);
  }
}
