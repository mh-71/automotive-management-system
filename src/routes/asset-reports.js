/* ============================================================
   routes/asset-reports.js — /api/asset-reports   (read only)
   ------------------------------------------------------------
   Workshop Assets › Asset Reports: value, availability, utilisation and
   maintenance spending, worked out in SQL from the records the other
   Workshop Assets pages already keep. Nothing new is stored and nothing
   is written here.

     GET /api/asset-reports           the report. Asset filters: q (name,
                                      code, brand, model), category, status,
                                      from / to (purchase date). Cost filter:
                                      costFrom / costTo (the day a cost
                                      belongs to). limit / offset page the
                                      asset table only; every figure covers
                                      all the assets the filters leave.
     GET /api/asset-reports/:toolId   one asset's purchase and maintenance
                                      costs, record by record

   Sources: tools (the register) and tool_maintenance (maintenance and
   repair jobs). Each maintenance record is read once, in one place, so no
   cost can be counted twice. No staff, mechanic or technician names are
   returned.

   Definitions (also shown on the page):
     * In service       every item whose status is not Retired.
     * Asset value      the sum of purchase prices of items in service;
                        items without a price add nothing and are counted
                        as "no price recorded" -- nothing is estimated.
     * Utilisation      In Use ÷ items in service (Retired never counted).
     * Spent            the ACTUAL cost of Completed jobs, on the day they
                        were completed. "Maintenance" is every type except
                        Repair; "Repairs" is Repair.
     * Open estimates   the ESTIMATED cost of In Progress (on the day work
                        started) and Scheduled jobs (on their scheduled
                        day): shown apart, never added to spent.
     * Cancelled        their estimate is shown apart, never added anywhere.

   Permission: tools.view (the existing Workshop Assets "view").
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId } from '../lib/http.js';
import { readDate, todayInDhaka } from '../lib/write.js';
// The register's own lists (read only, never redefined here).
import { TOOL_CATEGORIES, TOOL_STATUSES } from './tools.js';

const NOT_IN_REGISTER = 'Not in the register';
const MAX_MONTHS = 36;

/* The asset filters, on `t` (tools). ?1 needle ?2 category ?3 status ?4 from ?5 to */
const ASSET_WHERE = `
      (?1 IS NULL OR lower(t.name) LIKE ?1 ESCAPE '\\' OR lower(t.id) LIKE ?1 ESCAPE '\\'
                  OR lower(coalesce(t.brand, '')) LIKE ?1 ESCAPE '\\' OR lower(coalesce(t.model, '')) LIKE ?1 ESCAPE '\\')
  AND (?2 IS NULL OR t.category = ?2)
  AND (?3 IS NULL OR t.status = ?3)
  AND (?4 IS NULL OR t.purchase_date >= ?4)
  AND (?5 IS NULL OR t.purchase_date <= ?5)`;

/* Maintenance jobs with the day each cost belongs to. The asset filters
   apply to the item (a job on an item no longer in the register only shows
   while no asset filter is set); the purchase dates do not. ?6 costFrom ?7 costTo */
const JOBS = `
  SELECT m.id, m.tool_id, coalesce(t.name, m.tool_name) AS tool_name, coalesce(t.category, '${NOT_IN_REGISTER}') AS category,
         m.maintenance_type, m.status, m.estimated_cost, m.actual_cost,
         CASE m.status WHEN 'Completed' THEN m.completed_date
                       WHEN 'In Progress' THEN coalesce(date(m.started_at, '+6 hours'), m.scheduled_date)
                       ELSE m.scheduled_date END AS cost_day
    FROM tool_maintenance m LEFT JOIN tools t ON t.id = m.tool_id
   WHERE (?1 IS NULL OR lower(coalesce(t.name, m.tool_name)) LIKE ?1 ESCAPE '\\' OR lower(m.tool_id) LIKE ?1 ESCAPE '\\'
                     OR lower(coalesce(t.brand, '')) LIKE ?1 ESCAPE '\\' OR lower(coalesce(t.model, '')) LIKE ?1 ESCAPE '\\')
     AND (?2 IS NULL OR t.category = ?2)
     AND (?3 IS NULL OR t.status = ?3)`;
const COST_WHERE = 'WHERE (?6 IS NULL OR cost_day >= ?6) AND (?7 IS NULL OR cost_day <= ?7)';

const num = (v) => Number(v) || 0;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7));
  while ((y < endY || (y === endY && m <= endM)) && out.length < MAX_MONTHS) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
function monthsBack(today, n) {
  let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)) - (n - 1);
  while (m < 1) { m += 12; y -= 1; }
  return monthsBetween(`${y}-${String(m).padStart(2, '0')}-01`, today);
}

function readFilters(url) {
  const params = Object.fromEntries(url.searchParams);
  const category = url.searchParams.get('category') || null;
  if (category !== null && !TOOL_CATEGORIES.includes(category)) return { error: `\`category\` must be one of: ${TOOL_CATEGORIES.join(', ')}.` };
  const status = url.searchParams.get('status') || null;
  if (status !== null && !TOOL_STATUSES.includes(status)) return { error: `\`status\` must be one of: ${TOOL_STATUSES.join(', ')}.` };
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 100) return { error: '`q` must be 100 characters or fewer.' };
  const d = {};
  for (const k of ['from', 'to', 'costFrom', 'costTo']) {
    const r = readDate(params, k, { fallback: '' });
    if (r.error) return { error: `\`${k}\` must be a date in YYYY-MM-DD form.` };
    d[k] = r.value || null;
  }
  if (d.from && d.to && d.to < d.from) return { error: '`to` must be on or after `from`.' };
  if (d.costFrom && d.costTo && d.costTo < d.costFrom) return { error: '`costTo` must be on or after `costFrom`.' };
  return {
    needle: q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null,
    category, status, ...d,
  };
}

function assetRow(r) {
  return {
    id: r.id, name: r.name, category: r.category, status: r.status, condition: r.condition,
    purchaseDate: r.purchase_date || '', purchasePrice: r.purchase_price ?? null, supplier: r.supplier || '',
    maintenanceSpent: num(r.spent), maintenanceJobs: num(r.jobs),
  };
}

/* ---------- GET /api/asset-reports ---------- */

export async function getAssetReports(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: 25, min: 1, max: 1000 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const f = readFilters(url);
  if (f.error) return fail('invalid_parameter', f.error, 400);
  const today = todayInDhaka();
  const assetBinds = [f.needle, f.category, f.status, f.from, f.to];
  const jobBinds = [f.needle, f.category, f.status, null, null, f.costFrom, f.costTo];

  try {
    const s = await env.DB.prepare(
      `SELECT count(*) AS all_items,
              coalesce(sum(t.status <> 'Retired'), 0) AS in_service,
              coalesce(sum(t.status = 'Available'), 0) AS available,
              coalesce(sum(t.status = 'In Use'), 0) AS in_use,
              coalesce(sum(t.status = 'Under Maintenance'), 0) AS under_maintenance,
              coalesce(sum(t.status = 'Damaged'), 0) AS damaged,
              coalesce(sum(t.status = 'Retired'), 0) AS retired,
              coalesce(sum(CASE WHEN t.status <> 'Retired' THEN t.purchase_price END), 0) AS value,
              coalesce(sum(t.status <> 'Retired' AND t.purchase_price IS NULL), 0) AS unpriced,
              coalesce(sum(CASE WHEN t.status = 'Retired' THEN t.purchase_price END), 0) AS retired_value,
              coalesce(sum(t.purchase_date IS NULL), 0) AS undated
         FROM tools t WHERE ${ASSET_WHERE}`
    ).bind(...assetBinds).first();

    const { results: cats } = await env.DB.prepare(
      `SELECT t.category,
              coalesce(sum(t.status <> 'Retired'), 0) AS in_service,
              coalesce(sum(t.status = 'Available'), 0) AS available,
              coalesce(sum(t.status = 'In Use'), 0) AS in_use,
              coalesce(sum(t.status = 'Under Maintenance'), 0) AS under_maintenance,
              coalesce(sum(t.status = 'Damaged'), 0) AS damaged,
              coalesce(sum(t.status = 'Retired'), 0) AS retired,
              coalesce(sum(CASE WHEN t.status <> 'Retired' THEN t.purchase_price END), 0) AS value
         FROM tools t WHERE ${ASSET_WHERE} GROUP BY t.category`
    ).bind(...assetBinds).all();

    const e = await env.DB.prepare(
      `WITH jobs AS (${JOBS}) SELECT
              coalesce(sum(CASE WHEN status = 'Completed' THEN actual_cost END), 0) AS spent,
              coalesce(sum(CASE WHEN status = 'Completed' AND maintenance_type <> 'Repair' THEN actual_cost END), 0) AS spent_maintenance,
              coalesce(sum(CASE WHEN status = 'Completed' AND maintenance_type = 'Repair' THEN actual_cost END), 0) AS spent_repairs,
              coalesce(sum(status = 'Completed'), 0) AS completed,
              coalesce(sum(status = 'Completed' AND actual_cost IS NULL), 0) AS completed_no_cost,
              coalesce(sum(status = 'In Progress'), 0) AS in_progress,
              coalesce(sum(CASE WHEN status = 'In Progress' THEN estimated_cost END), 0) AS in_progress_estimate,
              coalesce(sum(status = 'Scheduled'), 0) AS scheduled,
              coalesce(sum(CASE WHEN status = 'Scheduled' THEN estimated_cost END), 0) AS scheduled_estimate,
              coalesce(sum(status = 'Cancelled'), 0) AS cancelled,
              coalesce(sum(CASE WHEN status = 'Cancelled' THEN estimated_cost END), 0) AS cancelled_estimate
         FROM jobs ${COST_WHERE}`
    ).bind(...jobBinds).first();

    const spentBy = (key) => env.DB.prepare(
      `WITH jobs AS (${JOBS}) SELECT ${key} AS k, coalesce(sum(actual_cost), 0) AS spent, count(*) AS jobs,
              coalesce(sum(CASE WHEN maintenance_type = 'Repair' THEN actual_cost END), 0) AS repairs
         FROM jobs ${COST_WHERE} AND status = 'Completed' GROUP BY k`
    ).bind(...jobBinds).all();
    const [byMonth, byYear, byCategory] = await Promise.all([spentBy('substr(cost_day, 1, 7)'), spentBy('substr(cost_day, 1, 4)'), spentBy('category')]);
    const { results: byTool } = await env.DB.prepare(
      `WITH jobs AS (${JOBS}) SELECT tool_id, max(tool_name) AS tool_name, max(category) AS category,
              coalesce(sum(CASE WHEN status = 'Completed' THEN actual_cost END), 0) AS spent,
              coalesce(sum(CASE WHEN status = 'Completed' AND maintenance_type = 'Repair' THEN actual_cost END), 0) AS repairs,
              coalesce(sum(status = 'Completed'), 0) AS completed,
              coalesce(sum(CASE WHEN status IN ('In Progress', 'Scheduled') THEN estimated_cost END), 0) AS open_estimate,
              count(*) AS jobs
         FROM jobs ${COST_WHERE} GROUP BY tool_id ORDER BY spent DESC, jobs DESC, tool_id LIMIT 500`
    ).bind(...jobBinds).all();

    // The month axis: the chosen cost period, else the last 12 months.
    const axis = f.costFrom || f.costTo
      ? monthsBetween((f.costFrom || (byMonth.results || []).map((r) => r.k).filter(Boolean).sort()[0] || today).slice(0, 7) + '-01', f.costTo || today)
      : monthsBack(today, 12);
    const monthMap = new Map((byMonth.results || []).map((r) => [r.k, r]));

    const { results: rows } = await env.DB.prepare(
      `SELECT t.id, t.name, t.category, t.status, t.condition, t.purchase_date, t.purchase_price, t.supplier,
              (SELECT coalesce(sum(m.actual_cost), 0) FROM tool_maintenance m WHERE m.tool_id = t.id AND m.status = 'Completed'
                  AND (?6 IS NULL OR m.completed_date >= ?6) AND (?7 IS NULL OR m.completed_date <= ?7)) AS spent,
              (SELECT count(*) FROM tool_maintenance m WHERE m.tool_id = t.id) AS jobs
         FROM tools t WHERE ${ASSET_WHERE}
        ORDER BY t.purchase_date IS NULL, t.purchase_date DESC, t.name COLLATE NOCASE, t.id
        LIMIT ?8 OFFSET ?9`
    ).bind(...assetBinds, f.costFrom, f.costTo, limit.value, offset.value).all();

    const inService = num(s.in_service);
    const summary = {
      allItems: num(s.all_items), inService, available: num(s.available), inUse: num(s.in_use),
      underMaintenance: num(s.under_maintenance), damaged: num(s.damaged), retired: num(s.retired),
      value: num(s.value), unpriced: num(s.unpriced), retiredValue: num(s.retired_value), undated: num(s.undated),
      utilisation: pct(num(s.in_use), inService),
    };
    const categories = (cats || []).map((c) => ({
      category: c.category, inService: num(c.in_service), available: num(c.available), inUse: num(c.in_use),
      underMaintenance: num(c.under_maintenance), damaged: num(c.damaged), retired: num(c.retired), value: num(c.value),
      share: pct(num(c.in_service), inService), valueShare: pct(num(c.value), summary.value), utilisation: pct(num(c.in_use), num(c.in_service)),
    })).filter((c) => c.inService || c.retired).sort((a, b) => b.inService - a.inService || b.value - a.value || a.category.localeCompare(b.category));

    const expenses = {
      spent: num(e.spent), spentMaintenance: num(e.spent_maintenance), spentRepairs: num(e.spent_repairs),
      completed: num(e.completed), completedWithoutCost: num(e.completed_no_cost),
      inProgress: num(e.in_progress), inProgressEstimate: num(e.in_progress_estimate),
      scheduled: num(e.scheduled), scheduledEstimate: num(e.scheduled_estimate),
      cancelled: num(e.cancelled), cancelledEstimate: num(e.cancelled_estimate),
      monthly: axis.map((m) => ({ month: m, spent: num(monthMap.get(m) && monthMap.get(m).spent), repairs: num(monthMap.get(m) && monthMap.get(m).repairs), jobs: num(monthMap.get(m) && monthMap.get(m).jobs) })),
      yearly: (byYear.results || []).filter((r) => r.k).map((r) => ({ year: r.k, spent: num(r.spent), repairs: num(r.repairs), jobs: num(r.jobs) })).sort((a, b) => b.year.localeCompare(a.year)),
      byCategory: (byCategory.results || []).map((r) => ({ category: r.k, spent: num(r.spent), repairs: num(r.repairs), jobs: num(r.jobs) })).sort((a, b) => b.spent - a.spent),
      byEquipment: (byTool || []).map((r) => ({ toolId: r.tool_id, toolName: r.tool_name, category: r.category, spent: num(r.spent), repairs: num(r.repairs), completed: num(r.completed), openEstimate: num(r.open_estimate), jobs: num(r.jobs) })),
    };

    const data = (rows || []).map(assetRow);
    return ok(data, {
      count: data.length, total: summary.allItems, limit: limit.value, offset: offset.value,
      summary, categories, expenses, today,
      period: { from: f.from, to: f.to, costFrom: f.costFrom, costTo: f.costTo },
    });
  } catch (err) {
    console.error('GET /api/asset-reports failed:', err && err.message);
    return fail('database_error', 'Could not prepare the asset reports.', 500);
  }
}

/* ---------- GET /api/asset-reports/:toolId ---------- */

export async function getAssetReport(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);
  try {
    const t = await env.DB.prepare(
      'SELECT id, name, category, status, condition, purchase_date, purchase_price, supplier FROM tools WHERE id = ?1'
    ).bind(id.value).first();
    const { results } = await env.DB.prepare(
      `SELECT id, tool_name, maintenance_type, status, scheduled_date, completed_date, estimated_cost, actual_cost
         FROM tool_maintenance WHERE tool_id = ?1 ORDER BY coalesce(completed_date, scheduled_date) DESC, id DESC LIMIT 200`
    ).bind(id.value).all();
    const jobs = results || [];
    if (!t && !jobs.length) return fail('not_found', 'No equipment with that id.', 404);
    const done = jobs.filter((j) => j.status === 'Completed');
    return ok({
      asset: t ? assetRow({ ...t, spent: done.reduce((n, j) => n + num(j.actual_cost), 0), jobs: jobs.length })
        : { id: id.value, name: jobs[0].tool_name, category: NOT_IN_REGISTER, status: '', inRegister: false },
      inRegister: Boolean(t),
      jobs: jobs.map((j) => ({
        id: j.id, type: j.maintenance_type, status: j.status, scheduledDate: j.scheduled_date, completedDate: j.completed_date || '',
        estimatedCost: j.estimated_cost ?? null, actualCost: j.actual_cost ?? null,
      })),
      totals: {
        spent: done.reduce((n, j) => n + num(j.actual_cost), 0),
        repairs: done.filter((j) => j.maintenance_type === 'Repair').reduce((n, j) => n + num(j.actual_cost), 0),
        openEstimate: jobs.filter((j) => j.status === 'In Progress' || j.status === 'Scheduled').reduce((n, j) => n + num(j.estimated_cost), 0),
        cancelledEstimate: jobs.filter((j) => j.status === 'Cancelled').reduce((n, j) => n + num(j.estimated_cost), 0),
      },
    });
  } catch (err) {
    console.error('GET /api/asset-reports/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the asset report.', 500);
  }
}
