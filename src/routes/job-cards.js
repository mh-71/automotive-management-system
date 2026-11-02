/* ============================================================
   routes/job-cards.js — GET /api/job-cards[/:id]   (read-only)
   ------------------------------------------------------------
   The central workshop transaction record, and the first
   collection with child line tables, so it does not go through
   lib/collection.js.

   Why bespoke rather than the shared factory: collectionRoutes()
   builds one fixed SQL string, maps one row at a time, and issues
   exactly two queries. A job card needs its service and part lines
   too, which means an IN-list whose placeholder count varies, a
   mapper that takes a row plus two line sets, and three to six
   queries. Teaching the factory all of that would turn it into the
   generic CRUD layer lib/collection.js:11-14 deliberately refuses
   to be, and would complicate six collections to serve one. So the
   plumbing is written out here instead, reusing lib/http.js for
   the response envelope, the id and parameter validators, and
   every status code, so the contract is identical to the other
   collections.

   ---- what this route must never do ----

   1. paid and due are HISTORICAL SNAPSHOTS, frozen when the job
      card was invoiced. They are NOT the live payment balance.
      The live balance lives in Utils.liveJobBalance() on the
      client, which reads the invoice when one exists and is not
      Void (utils.js:163-175), and that is the fix for audit
      Finding 1. This route reports the stored numbers and joins
      neither invoices nor payments. Computing a live balance here
      would put Finding 1's answer in two places, which is exactly
      how the original bug got in.

   2. Service and part lines are SNAPSHOTS. js/job-cards.js:16-18
      states it: "name + unitPrice are SNAPSHOTS; catalog changes
      never rewrite history." A job card that sold "Premium Oil
      Change" at 1200 still says so after the catalogue renames the
      service and reprices it. So the catalogue is never joined,
      and nothing is refreshed from services or parts.

   3. Nothing is derived. Totals are recomputed by the client
      before every save (computeTotals(), job-cards.js:95) and
      stored; this route returns what is stored. Inventory is not
      touched at all: no stock recalculation, no issued quantity,
      no SUM over inventory_transactions. parts.stock stays the one
      answer to "how much is in stock", as established in B-6.

   4. Relationships stay as ids. Five of them -- customer, vehicle
      and mechanic are NOT NULL, appointment and invoice nullable
      -- and none is embedded. The UI resolves names at render time
      from the ids it already holds.
   ============================================================ */

import {
  ok, fail, methodNotAllowed, noDatabase, readIntParam, readRecordId,
  conflict, unprocessable,
} from '../lib/http.js';
import {
  readJsonBody, readString, readNumber, readEnum, readDate,
  nowIso, todayInDhaka, allocateId, constraintFailure,
} from '../lib/write.js';
import { fieldSet } from '../lib/collection-write.js';

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

/**
 * How many job card ids go into one `WHERE job_card_id IN (...)` query.
 *
 * SQLite's SQLITE_MAX_VARIABLE_NUMBER defaults to 999, and a list page can ask
 * for up to MAX_LIMIT rows, so a single IN-list would overflow it at the top of
 * the range. Chunking at 500 keeps every query comfortably inside the ceiling
 * and caps the work at two chunks per child table even for limit=1000.
 *
 * The only thing assembled into the SQL text is the placeholder run (`?1, ?2,
 * ...`), whose length comes from how many ids this chunk holds -- a number this
 * module computed, never a request value. Every id itself goes through .bind().
 */
const ID_CHUNK = 500;

const PARENT_COLUMNS = `
  id, customer_id, vehicle_id, mechanic_id, appointment_id, invoice_id,
  date, est_delivery, actual_delivery, completed_at,
  status, priority, mileage, mileage_out, fuel_level,
  complaint, inspection, diagnosis, technician_notes, recommendations,
  condition_notes, notes, inspection_checklist,
  labour_hours, labour_rate, labour_cost, discount, discount_type, discount_rate, tax_rate,
  subtotal, tax, total, paid, due, created_at, updated_at
`;

// Child rows carry job_card_id so a batched result can be grouped by parent.
// The surrogate `id` and `line_no` are read for ordering but are not returned:
// the app's records have never had them (seed-data.js), so exposing them would
// invent a shape the UI does not use.
const SERVICE_COLUMNS = `job_card_id, service_id, name, qty, unit_price, total`;
const PART_COLUMNS = `job_card_id, part_id, name, part_no, qty, unit_price, total`;

// line_no carries no uniqueness constraint, so the surrogate id breaks ties and
// keeps the order of two lines sharing a line_no stable across requests.
const LINE_ORDER = `ORDER BY job_card_id, line_no, id`;

/**
 * inspection_checklist is stored as JSON in a TEXT column. The UI reads it with
 * Object.entries(j.inspectionChecklist || {}) (job-cards.js:1219), so it wants
 * an object, not a string.
 *
 * A row whose JSON is unparseable must not take down the request that happens
 * to include it -- one bad checklist would otherwise 500 an entire page of job
 * cards. It degrades to {} and says so in the Worker log, naming the job card
 * so it can be found. Valid data is never replaced: only null, '' and genuinely
 * unusable JSON become {}.
 */
function parseChecklist(raw, jobCardId) {
  if (raw === null || raw === undefined || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn(`job_cards.inspection_checklist for ${jobCardId} is JSON but not an object; returning {}`);
    return {};
  } catch {
    console.warn(`job_cards.inspection_checklist for ${jobCardId} is not valid JSON; returning {}`);
    return {};
  }
}

/** One job_card_services row -> the line shape the UI already reads. */
function toServiceLine(row) {
  return {
    serviceId: row.service_id ?? null,
    name: row.name,               // snapshot — never the catalogue's current name
    qty: row.qty,
    unitPrice: row.unit_price,    // snapshot — never the catalogue's current price
    total: row.total,
  };
}

/**
 * One job_card_parts row -> the line shape the UI already reads.
 *
 * part_id NULL is a manual line: a part written in by hand with no inventory
 * record behind it. It keeps its own name, part number and price and never
 * moves stock (utils.js: deductForJob and reconcileJobInventory both skip a
 * line with no partId), so nothing here promotes it into a catalogue part.
 */
function toPartLine(row) {
  return {
    partId: row.part_id ?? null,
    name: row.name,               // snapshot
    partNo: row.part_no ?? '',    // snapshot
    qty: row.qty,
    unitPrice: row.unit_price,    // snapshot
    total: row.total,
  };
}

/**
 * One job_cards row plus its lines -> the record shape the UI already expects.
 *
 * Nullable numbers stay null rather than falling back to 0: a job card with no
 * recorded mileage has not been driven zero kilometres, and no labour rate is
 * not a rate of zero. The NOT NULL money columns all default to 0 in the
 * schema, so a 0 there is a real figure.
 *
 * Prose columns fall back to '' because the UI concatenates and renders them.
 */
function toRecord(row, services, partsUsed) {
  return {
    id: row.id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    mechanicId: row.mechanic_id,
    appointmentId: row.appointment_id ?? null,
    invoiceId: row.invoice_id ?? null,

    date: row.date,                                   // local calendar day, verbatim
    estDelivery: row.est_delivery ?? '',
    actualDelivery: row.actual_delivery ?? '',
    completedAt: row.completed_at ?? '',

    status: row.status,
    priority: row.priority,
    mileage: row.mileage ?? null,
    mileageOut: row.mileage_out ?? null,
    fuelLevel: row.fuel_level ?? '',

    complaint: row.complaint,
    inspection: row.inspection ?? '',
    diagnosis: row.diagnosis ?? '',
    technicianNotes: row.technician_notes ?? '',
    recommendations: row.recommendations ?? '',
    conditionNotes: row.condition_notes ?? '',
    notes: row.notes ?? '',
    inspectionChecklist: parseChecklist(row.inspection_checklist, row.id),

    labourHours: row.labour_hours ?? null,
    labourRate: row.labour_rate ?? null,
    labourCost: row.labour_cost,
    discount: row.discount,
    discountType: row.discount_type ?? 'amount',   // NULL only before migration 0003
    discountRate: row.discount_rate ?? null,
    taxRate: row.tax_rate,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    paid: row.paid,                                   // SNAPSHOT, not the live balance
    due: row.due,                                     // SNAPSHOT, not the live balance

    services,
    partsUsed,

    createdAt: row.created_at,
    // Omitted rather than null until first updated, matching storage.js.
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  };
}

/**
 * Fetch the service and part lines for a set of job card ids.
 *
 * Two queries per chunk of ID_CHUNK ids, so the query count is bounded by the
 * page size ceiling rather than growing with it: a page of 500 costs two
 * queries, a page of 1000 costs four. Never one query per job card.
 *
 * Returns two Maps keyed by job card id, each holding that card's lines in
 * stored order.
 */
async function fetchLines(env, ids) {
  const services = new Map();
  const parts = new Map();
  if (ids.length === 0) return { services, parts };

  for (let start = 0; start < ids.length; start += ID_CHUNK) {
    const chunk = ids.slice(start, start + ID_CHUNK);
    // Placeholder run only; its length is this chunk's size, and every id is bound.
    const holes = chunk.map((_, i) => `?${i + 1}`).join(', ');

    const [svcRows, partRows] = await Promise.all([
      env.DB.prepare(
        `SELECT ${SERVICE_COLUMNS}
           FROM job_card_services
          WHERE job_card_id IN (${holes})
          ${LINE_ORDER}`
      ).bind(...chunk).all(),
      env.DB.prepare(
        `SELECT ${PART_COLUMNS}
           FROM job_card_parts
          WHERE job_card_id IN (${holes})
          ${LINE_ORDER}`
      ).bind(...chunk).all(),
    ]);

    for (const r of svcRows.results ?? []) {
      if (!services.has(r.job_card_id)) services.set(r.job_card_id, []);
      services.get(r.job_card_id).push(toServiceLine(r));
    }
    for (const r of partRows.results ?? []) {
      if (!parts.has(r.job_card_id)) parts.set(r.job_card_id, []);
      parts.get(r.job_card_id).push(toPartLine(r));
    }
  }

  return { services, parts };
}

/** GET /api/job-cards?limit=&offset= */
export async function listJobCards(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const limit = readIntParam(url, 'limit', { def: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);

  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);

  try {
    const { results } = await env.DB.prepare(
      `SELECT ${PARENT_COLUMNS}
         FROM job_cards
        ORDER BY created_at DESC, id DESC
        LIMIT ?1 OFFSET ?2`
    )
      .bind(limit.value, offset.value)
      .all();

    const rows = results ?? [];
    const total = await env.DB.prepare(
      `SELECT count(*) AS n FROM job_cards`
    ).first();

    // An empty page asks for no lines at all.
    const { services, parts } = await fetchLines(env, rows.map((r) => r.id));

    return ok(
      rows.map((r) => toRecord(r, services.get(r.id) ?? [], parts.get(r.id) ?? [])),
      {
        count: rows.length,
        total: total ? total.n : rows.length,
        limit: limit.value,
        offset: offset.value,
      }
    );
  } catch (err) {
    // A failed line query fails the whole request: half a job card, with its
    // totals but not the lines behind them, would read as a complete record.
    console.error('GET /api/job-cards failed:', err);
    return fail('database_error', 'Could not read job cards.', 500);
  }
}

/** GET /api/job-cards/:id */
export async function getJobCard(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  try {
    const row = await env.DB.prepare(
      `SELECT ${PARENT_COLUMNS}
         FROM job_cards
        WHERE id = ?1
        LIMIT 1`
    )
      .bind(id.value)
      .first();

    // readRecordId is shape-only, not prefix-specific, so a well-formed id
    // belonging to another collection lands here as a 404, not a 400. Returning
    // before the line queries is deliberate: an id that is not a job card must
    // cost one query, not three.
    if (!row) return fail('not_found', 'No job card with that id.', 404);

    const { services, parts } = await fetchLines(env, [row.id]);

    return ok(toRecord(row, services.get(row.id) ?? [], parts.get(row.id) ?? []));
  } catch (err) {
    console.error('GET /api/job-cards/:id failed:', err);
    return fail('database_error', 'Could not read job card.', 500);
  }
}

/* ============================================================
   C-5 — the write half
   ------------------------------------------------------------
   POST /api/job-cards, PUT /api/job-cards/:id, DELETE
   /api/job-cards/:id, plus the inventory reconciliation an edit
   performs.

   Everything below is a port of what js/job-cards.js and
   js/utils.js already do, moved server-side. Where a rule looks
   surprising, the line number of the client code it preserves is
   given. Nothing here is a new business rule.

   ---- the five things this route must get right ----

   1. TOTALS ARE NEVER TRUSTED. job-cards.js:21-22 -- "All totals
      are recalculated in JS before saving -- client totals are
      never trusted." computeTotals() below is a line-for-line port
      of job-cards.js:95-109, and subtotal/tax/total/due are
      refused by name if a caller sends them.

   2. LINES ARE SNAPSHOTS. name, partNo and unitPrice are stored as
      given and never refreshed from the catalogue. That is why a
      line carries its own name even when it has a serviceId.

   3. INVENTORY IS RECONCILED, NOT RE-APPLIED. The ledger -- not
      the job card's own lines -- says how much a job has actually
      been issued (utils.js:254-261). An edit moves only the
      difference. See reconcile() below.

   4. ONE BATCH. The job card, its two line tables, every stock
      movement, every ledger row and the appointment back-link go
      in a single env.DB.batch(), so a shortage on the third part
      undoes the first two and the job card with them.

   5. STATUS IS NOT TOUCHED HERE. The client changes status through
      changeStatus() (job-cards.js:967), a separate operation with
      its own transitions, its own inventory effects and its own
      appointment sync. C-6 owns it. A write here that tried to
      move the status would be a second, competing state machine,
      so status is immutable on PUT and fixed to 'Received' on
      POST -- exactly what openCreateModal() (:877) stores.
   ============================================================ */

/* ---- the status model, copied from job-cards.js:32-56 ------------------- */

// Every status the column's CHECK allows, in the client's own order.
const STATUSES = [
  'Received', 'Inspection', 'Waiting for Approval', 'In Progress',
  'Waiting for Parts', 'Completed', 'Delivered', 'Cancelled',
];
// :877 — openCreateModal() stores this and nothing else.
const CREATE_STATUS = 'Received';
// :39 — the edit form refuses to open at all on one of these.
const TERMINAL = ['Completed', 'Delivered', 'Cancelled'];
// utils.js:114 — DONE_JOB_STATUSES, the second delete blocker.
const DONE = ['Completed', 'Delivered'];
// :1062 — the third delete blocker: everything else is "work has started".
const DELETABLE = ['Received', 'Cancelled'];
// :45 — the only statuses where an edit has to reconcile stock, because they
// are the only ones where stock has already moved for this job.
const INVENTORY_TRACKED = ['In Progress', 'Waiting for Parts'];

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// :67 — plus '', which the column's CHECK also allows for "not recorded".
const FUEL_LEVELS = ['', 'empty', 'quarter', 'half', 'three-quarter', 'full'];
// :70 — the five states an inspection row can be in.
const INSPECTION_STATES = ['', 'OK', 'Attention', 'Critical', 'N/A'];

/* ---- the ledger vocabulary, copied from utils.js:200-201 ---------------- */

const USE = 'job-card-use';
const RETURN = 'return';
const JOB_REFERENCE = 'job-card';
// utils.js:412-413 — the exact note reconcileJobInventory() writes. Kept
// verbatim so a ledger row written here is indistinguishable from one the
// browser wrote.
const adjustNote = (jobId) => `Adjusted on ${jobId} (qty change)`;

/* A job card's line arrays are bounded so one request cannot ask for an
   unbounded batch. 200 is far past anything a real card carries and keeps the
   reconciliation lookup's IN-list well inside SQLite's 999 variable limit. */
const MAX_LINES = 200;
const MAX_CHECKLIST_ITEMS = 50;

/**
 * Fields the server owns. Refused by name rather than ignored, so a caller
 * cannot believe it set a figure the server actually computed -- the same rule
 * C-4 applies to prevStock/newStock.
 *
 * subtotal, tax, total and due are here because computeTotals() derives all
 * four; `paid` is NOT, because it is a real input on the job card form
 * (#jf-paid, read at :715 and validated against the grand total at :787). It
 * is stored exactly as sent and never computed from payments -- that is what
 * makes it the frozen snapshot the schema's own comment describes
 * (0001_initial_schema.sql:247-251) and what keeps audit Finding 1 answered in
 * one place.
 */
const SERVER_OWNED = {
  id: '`id` is allocated by the server.',
  createdAt: '`createdAt` is set by the server.',
  updatedAt: '`updatedAt` is set by the server.',
  subtotal: '`subtotal` is calculated by the server from the lines.',
  tax: '`tax` is calculated by the server from the lines.',
  total: '`total` is calculated by the server from the lines.',
  due: '`due` is calculated by the server from the total and what is paid.',
  prevStock: '`prevStock` is not a job card field.',
  newStock: '`newStock` is not a job card field.',
};

/* ---------------------------------------------------------------
   Totals — a line-for-line port of computeTotals(), job-cards.js:95-109
   --------------------------------------------------------------- */

const DISCOUNT_TYPES = ['amount', 'percent'];

/**
 * `rate` percent of `subtotal`, rounded half-up to the paisa, never above the
 * subtotal. All integer arithmetic (basis points x subtotal in units of
 * 1/10000 taka), so it is exact up to a subtotal of 1 crore: 999 x 5% is
 * 49.95, 16,000 x 7% is 1,120. The client's copy (js/job-cards.js) is the same
 * function.
 */
export function percentDiscount(subtotal, rate) {
  const bp = Math.round(rate * 100);
  const paisa = Math.floor((Math.round(subtotal * 10000) * bp + 500000) / 1000000);
  return Math.min(paisa / 100, subtotal);
}

/**
 * The single source of truth for a job card's money, on the server side.
 *
 * Deliberately identical to the client's, including the details that look
 * like accidents and are not:
 *
 *   - a line's contribution is qty x unitPrice, NOT its stored `total`, so a
 *     client that sends an inconsistent line total cannot change the bill;
 *   - hours x rate WINS over a directly entered labourCost, but only when
 *     both are above zero (:100-101);
 *   - the discount is clamped to the subtotal (:103);
 *   - tax is rounded to whole taka, and only the tax (:105);
 *   - due never goes below zero (:108).
 */
export function computeTotals(job) {
  const lineSum = (lines) => (lines || []).reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0
  );
  const serviceTotal = lineSum(job.services);
  const partsTotal = lineSum(job.partsUsed);
  const hours = Number(job.labourHours) || 0;
  const rate = Number(job.labourRate) || 0;
  const labourCost = (hours > 0 && rate > 0) ? hours * rate : (Number(job.labourCost) || 0);
  const subtotal = serviceTotal + partsTotal + labourCost;
  const taxRate = Number(job.taxRate) || 0;
  const paid = Number(job.paid) || 0;
  let discount, tax, total;
  if (job.discountType === 'percent') {
    // Worked in paisa so a discount such as 49.95 leaves no float residue in
    // the total. The fixed-amount branch below is untouched.
    discount = percentDiscount(subtotal, Number(job.discountRate) || 0);
    const net = Math.round(subtotal * 100) - Math.round(discount * 100);
    tax = Math.round(net * taxRate / 10000);
    total = (net + tax * 100) / 100;
  } else {
    discount = Math.min(Number(job.discount) || 0, subtotal);
    tax = Math.round((subtotal - discount) * taxRate / 100);
    total = subtotal - discount + tax;
  }
  return {
    serviceTotal, partsTotal, labourCost, subtotal, discount, taxRate,
    tax, total, paid, due: Math.max(total - paid, 0),
  };
}

/* ---------------------------------------------------------------
   Line items
   --------------------------------------------------------------- */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Read one line array into the shape normalizeLines() produces
 * (job-cards.js:112-123), applying the validation readForm()/validate() apply
 * to the raw form rows first.
 *
 * Two rules carried over that a reader will want explained:
 *
 *   EMPTY ROWS ARE DROPPED, NOT REJECTED. normalizeLines() filters a service
 *   line out when it has no serviceId and a part line out when its name is
 *   blank. That is the "Add Line" button's leftover empty row, and the form
 *   has always discarded it silently.
 *
 *   CUSTOM WORK is the one service line kept without a serviceId: serviceId
 *   null or absent AND a non-blank name. It is stored with service_id NULL,
 *   the same convention a manual part line uses, and never touches the
 *   catalogue. A serviceId of '' is a catalogue row nobody picked, so it is
 *   still dropped whatever name it carries -- a blank catalogue row must not
 *   turn into custom work.
 *
 *   qty IS `Number(x) || 0`, NOT `|| 1`. readLines() (:545-566) reads the
 *   boxes that way and validate() (:760) then rejects anything at or below
 *   zero, so normalizeLines()'s `|| 1` fallback is unreachable in the client
 *   and is unreachable here too. Reproducing the fallback instead of the
 *   check would silently turn a missing quantity into one unit.
 *
 * The one place this is STRICTER than the form: a part line that carries a
 * partId but no name is rejected rather than dropped. The form cannot produce
 * one -- it takes the name from the selected option (:557-559) -- so no
 * existing behaviour is changed, and dropping it over the API would silently
 * lose an inventory line the caller believed it had sent.
 */
export function readLines(raw, { isService, field }) {
  if (!Array.isArray(raw)) return { error: `\`${field}\` must be an array.` };
  if (raw.length > MAX_LINES) {
    return { error: `\`${field}\` cannot hold more than ${MAX_LINES} lines.` };
  }

  const lines = [];
  for (let i = 0; i < raw.length; i += 1) {
    const l = raw[i];
    const at = `${field}[${i}]`;
    if (!isPlainObject(l)) return { error: `\`${at}\` must be an object.` };

    const refRaw = isService ? l.serviceId : l.partId;
    if (refRaw !== undefined && refRaw !== null && typeof refRaw !== 'string') {
      return { error: `\`${at}.${isService ? 'serviceId' : 'partId'}\` must be a string.` };
    }
    const ref = typeof refRaw === 'string' ? refRaw.trim() : '';

    const name = typeof l.name === 'string' ? l.name.trim() : '';

    // The form's leftover empty row.
    const customWork = isService && (refRaw === undefined || refRaw === null) && name !== '';
    if (isService ? (!ref && !customWork) : (!name && !ref)) continue;
    if (!isService && ref && !name) {
      return { error: `\`${at}.name\` is required for an inventory part line.` };
    }
    if (name.length > 200) return { error: `\`${at}.name\` must be 200 characters or fewer.` };

    const qty = Number(l.qty) || 0;
    const unitPrice = Number(l.unitPrice) || 0;
    // :760 / :765 — the client's own wording, kept so a form can show it.
    if (!(qty > 0) || unitPrice < 0) {
      return {
        error: isService
          ? 'Service quantity must be > 0 and price cannot be negative.'
          : 'Part quantity must be > 0 and price cannot be negative.',
      };
    }
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) {
      return { error: `\`${at}\` has a quantity or price that is not a number.` };
    }

    if (isService) {
      lines.push({ serviceId: ref || null, name, qty, unitPrice, total: qty * unitPrice });
    } else {
      const partNo = typeof l.partNo === 'string' ? l.partNo.trim() : '';
      if (partNo.length > 100) {
        return { error: `\`${at}.partNo\` must be 100 characters or fewer.` };
      }
      lines.push({
        partId: ref || null, name, partNo, qty, unitPrice, total: qty * unitPrice,
      });
    }
  }
  return { value: lines };
}

/**
 * The inspection checklist, as readInspection() builds it (job-cards.js:570-578):
 * an object keyed by item name, each value `{ state, note }`.
 *
 * The item names themselves are NOT restricted to INSPECTION_ITEMS. That list
 * is the form's display order and can grow; the read route already accepts any
 * object (parseChecklist()), and a stored card whose checklist predates an item
 * being renamed must still round-trip. The shape is checked, the vocabulary is
 * not -- except `state`, which comes from a fixed <select>.
 */
function readChecklist(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (!isPlainObject(raw)) return { error: '`inspectionChecklist` must be an object.' };

  const entries = Object.entries(raw);
  if (entries.length > MAX_CHECKLIST_ITEMS) {
    return { error: `\`inspectionChecklist\` cannot hold more than ${MAX_CHECKLIST_ITEMS} items.` };
  }

  const out = {};
  for (const [item, value] of entries) {
    if (!item.trim() || item.length > 60) {
      return { error: '`inspectionChecklist` has an item name that is blank or too long.' };
    }
    if (!isPlainObject(value)) {
      return { error: `\`inspectionChecklist.${item}\` must be an object with state and note.` };
    }
    const extra = Object.keys(value).find((k) => k !== 'state' && k !== 'note');
    if (extra) {
      return { error: `\`inspectionChecklist.${item}.${extra}\` is not a checklist field.` };
    }
    const state = value.state === undefined || value.state === null ? '' : value.state;
    const note = value.note === undefined || value.note === null ? '' : value.note;
    if (typeof state !== 'string' || !INSPECTION_STATES.includes(state)) {
      return {
        error: `\`inspectionChecklist.${item}.state\` must be one of: `
          + `${INSPECTION_STATES.filter(Boolean).join(', ')}.`,
      };
    }
    if (typeof note !== 'string' || note.length > 500) {
      return { error: `\`inspectionChecklist.${item}.note\` must be a string of 500 characters or fewer.` };
    }
    out[item] = { state, note };
  }
  return { value: JSON.stringify(out) };
}

/* ---------------------------------------------------------------
   Field reading
   --------------------------------------------------------------- */

/** 0 to 100 with at most two decimals, or null when absent. */
function readDiscountRate(body) {
  const read = readNumber(body, 'discountRate', { min: 0, max: 100, fallback: null });
  if (read.error || read.value === null) return read;
  if (Math.abs(read.value * 100 - Math.round(read.value * 100)) >= 1e-9) {
    return { error: '`discountRate` can have at most two decimal places.' };
  }
  return read;
}

/**
 * Which discount a write leaves the job card with: { type, rate } or { errors }.
 *
 * A percentage discount's money is always derived from its rate, so a request
 * may not also send `discount` for one. A request that sends `discount`
 * without `discountType` is a fixed amount -- that is every client written
 * before percentages, and it keeps working unchanged. A request that names
 * neither keeps what the card already has (a create starts at 'amount'), so an
 * edit that only changes lines re-applies a stored percentage to them.
 */
function resolveDiscount(body, values, stored = null) {
  const sent = (key) => body[key] !== undefined && body[key] !== null && body[key] !== '';
  let type;
  if (sent('discountType')) type = values.discount_type;
  else if (sent('discount')) type = 'amount';
  else if (sent('discountRate')) {
    return { errors: { discountRate: '`discountRate` needs `discountType: "percent"`.' } };
  } else type = (stored && stored.discount_type) || 'amount';

  if (type === 'percent') {
    if (sent('discount')) {
      return { errors: { discount: 'A percentage discount is calculated from `discountRate`; do not send `discount`.' } };
    }
    const rate = sent('discountRate') ? values.discount_rate
      : (stored && stored.discount_type === 'percent' ? stored.discount_rate : null);
    if (rate === null || rate === undefined) {
      return { errors: { discountRate: '`discountRate` is required for a percentage discount.' } };
    }
    return { type, rate };
  }
  if (sent('discountRate')) {
    return { errors: { discountRate: '`discountRate` applies only to a percentage discount.' } };
  }
  return { type, rate: null };
}

/**
 * Which columns a job card write accepts, and what each one must look like.
 *
 * Existence of customer, vehicle, mechanic, appointment, service and part is
 * NOT checked here: all six are foreign keys in the schema, so a bad reference
 * raises FOREIGN KEY and constraintFailure() turns it into a 409 without a
 * preflight SELECT for each one. That is the same division C-3 uses, and it is
 * what keeps a card with twelve part lines from costing twelve lookups.
 *
 * Returns the fieldSet plus the line arrays, which are not columns.
 */
function readJobFields(body, mode) {
  const create = mode === 'create';
  const f = fieldSet(body, mode);

  for (const [key, message] of Object.entries(SERVER_OWNED)) {
    if (body[key] !== undefined) f.reject(key, message);
  }

  // The five NOT NULL fields a job card cannot be without. `sent` makes each
  // one required on an update TOO, whenever the key is present: clearing a
  // customer, a date or the complaint is not a thing an edit can do, and
  // letting a null through would only be answered by the column one statement
  // later, with a message naming nothing.
  const sent = (key) => create || body[key] !== undefined;

  f.take('customer_id', 'customerId', readString(body, 'customerId', { required: sent('customerId'), max: 32 }));
  f.take('vehicle_id', 'vehicleId', readString(body, 'vehicleId', { required: sent('vehicleId'), max: 32 }));
  // NOT NULL in the schema, and :729 requires it on every save.
  f.take('mechanic_id', 'mechanicId', readString(body, 'mechanicId', { required: sent('mechanicId'), max: 32 }));

  f.take('date', 'date', readDate(body, 'date', { required: sent('date') }));
  // NULL when not set: the column's CHECK allows NULL and '' alike, and the
  // read route reports NULL as '' anyway, so both spellings round-trip.
  f.take('est_delivery', 'estDelivery', readDate(body, 'estDelivery', { fallback: null }));

  // :707 — `val('priority') || 'normal'`, so absent and blank both mean normal.
  f.take('priority', 'priority', readEnum(body, 'priority', PRIORITIES, { fallback: 'normal' }));
  f.take('fuel_level', 'fuelLevel', readEnum(body, 'fuelLevel', FUEL_LEVELS, { fallback: null }));

  // Nullable numbers: absent, null and '' all mean "not recorded", which is
  // NULL -- never 0. :773-781 bounds each one at zero.
  f.take('mileage', 'mileage', readNumber(body, 'mileage', { min: 0 }));
  f.take('mileage_out', 'mileageOut', readNumber(body, 'mileageOut', { min: 0 }));
  f.take('labour_hours', 'labourHours', readNumber(body, 'labourHours', { min: 0 }));
  f.take('labour_rate', 'labourRate', readNumber(body, 'labourRate', { min: 0 }));

  // The four money inputs the form actually collects. All are NOT NULL DEFAULT
  // 0, and readForm() reads each as `num(x) || 0` (:714-715), so a blank box is
  // zero rather than "not recorded" -- the opposite of the nullable numbers
  // above, and the reason these carry a 0 fallback in both modes.
  // labour_cost is then STORED as computeTotals() resolves it, not as sent:
  // hours x rate wins whenever both are above zero.
  f.take('labour_cost', 'labourCost', readNumber(body, 'labourCost', { min: 0, fallback: 0 }));
  f.take('discount', 'discount', readNumber(body, 'discount', { min: 0, fallback: 0 }));
  f.take('discount_type', 'discountType', readEnum(body, 'discountType', DISCOUNT_TYPES, { fallback: 'amount' }));
  f.take('discount_rate', 'discountRate', readDiscountRate(body));
  f.take('tax_rate', 'taxRate', readNumber(body, 'taxRate', { min: 0, max: 100, fallback: 0 }));
  f.take('paid', 'paid', readNumber(body, 'paid', { min: 0, fallback: 0 }));

  f.take('complaint', 'complaint', readString(body, 'complaint', { required: sent('complaint'), max: 2000 }));
  f.take('inspection', 'inspection', readString(body, 'inspection', { max: 2000 }));
  f.take('diagnosis', 'diagnosis', readString(body, 'diagnosis', { max: 2000 }));
  f.take('technician_notes', 'technicianNotes', readString(body, 'technicianNotes', { max: 2000 }));
  f.take('recommendations', 'recommendations', readString(body, 'recommendations', { max: 2000 }));
  f.take('condition_notes', 'conditionNotes', readString(body, 'conditionNotes', { max: 2000 }));
  f.take('notes', 'notes', readString(body, 'notes', { max: 2000 }));

  if (body.inspectionChecklist !== undefined || create) {
    f.take('inspection_checklist', 'inspectionChecklist', readChecklist(body.inspectionChecklist));
  }

  const lines = {};
  for (const [field, isService] of [['services', true], ['partsUsed', false]]) {
    if (body[field] === undefined) {
      if (create) lines[field] = [];
      continue;
    }
    const read = readLines(body[field], { isService, field });
    if (read.error) f.reject(field, read.error);
    else lines[field] = read.value;
  }

  return { f, lines };
}

/* ---------------------------------------------------------------
   Cross-field rules — the port of validate(), job-cards.js:719-789
   --------------------------------------------------------------- */

/**
 * The rules that need the whole record rather than one field, applied to the
 * record as it will be AFTER the write. On an update that means the stored row
 * with the supplied fields merged over it: judging the patch alone would let a
 * request that changes only the discount slip past the discount<=subtotal check.
 *
 * Returns a map of field -> message, empty when everything passes.
 */
function checkRecord(merged, totals) {
  const errors = {};

  // :787-788. Both are also CHECK constraints; reporting them here names the
  // offending field instead of letting the database answer with a generic 422.
  if (merged.discount_type !== 'percent' && (Number(merged.discount) || 0) > totals.subtotal) {
    errors.discount = 'Discount cannot exceed the subtotal.';
  }
  if ((Number(merged.paid) || 0) > totals.total) {
    errors.paid = 'Paid amount cannot exceed the grand total.';
  }
  // :771 — mileage out is the reading at handover, so it cannot be lower.
  if (merged.mileage_out !== null && merged.mileage !== null
      && merged.mileage_out < merged.mileage) {
    errors.mileageOut = 'Mileage Out cannot be lower than Mileage In.';
  }
  // :783
  if (merged.est_delivery && merged.date && merged.est_delivery < merged.date) {
    errors.estDelivery = 'Estimated Delivery cannot be earlier than the Job Date.';
  }
  // :762 — a job card has to record SOMETHING. Labour counts either way it can
  // be entered, which is why the test is on the resolved labour cost.
  const hasWork = merged.services.length > 0
    || merged.partsUsed.length > 0
    || totals.labourCost > 0;
  if (!hasWork) {
    errors.services = 'Add at least one service, part, or labour entry.';
  }
  return errors;
}

/* ---------------------------------------------------------------
   Reading a stored job card
   --------------------------------------------------------------- */

/**
 * The stored parent row and both line sets, in one place, so a write and the
 * GET that follows it can never disagree about what a job card is.
 */
async function loadJobCard(env, id) {
  const row = await env.DB.prepare(
    `SELECT ${PARENT_COLUMNS} FROM job_cards WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) return null;

  const { services, parts } = await fetchLines(env, [row.id]);
  return {
    row,
    services: services.get(row.id) ?? [],
    partsUsed: parts.get(row.id) ?? [],
  };
}

/** The record a successful write reports — identical to what a GET returns. */
async function respondWith(env, id, status) {
  const loaded = await loadJobCard(env, id);
  if (!loaded) {
    // The row was written and is already gone; nothing sensible to report.
    console.error(`Job card ${id} disappeared between write and read.`);
    return fail('database_error', 'Could not read the job card back.', 500);
  }
  return ok(toRecord(loaded.row, loaded.services, loaded.partsUsed), {}, status);
}

/* ---------------------------------------------------------------
   Statements
   --------------------------------------------------------------- */

/** The INSERTs for one job card's line tables, in array order. */
function lineStatements(env, jobCardId, services, partsUsed) {
  const statements = [];
  services.forEach((l, i) => {
    statements.push(env.DB.prepare(
      `INSERT INTO job_card_services
         (job_card_id, service_id, name, qty, unit_price, total, line_no)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(jobCardId, l.serviceId, l.name, l.qty, l.unitPrice, l.total, i + 1));
  });
  partsUsed.forEach((l, i) => {
    statements.push(env.DB.prepare(
      `INSERT INTO job_card_parts
         (job_card_id, part_id, name, part_no, qty, unit_price, total, line_no)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(jobCardId, l.partId, l.name, l.partNo, l.qty, l.unitPrice, l.total, i + 1));
  });
  return statements;
}

/**
 * The two statements that move one part's stock for a job card.
 *
 * Nothing here is computed in JavaScript. prev_stock and new_stock are read
 * from the live row inside the INSERT, so they cannot be stale and cannot be
 * supplied by a caller -- the same rule C-4 established for a manual movement.
 *
 * Three different failures each raise a constraint the schema already has, and
 * a raised constraint aborts the whole batch. That is what makes a shortage on
 * the third part undo the first two AND the job card itself:
 *
 *   part missing        prev_stock reads NULL -> NOT NULL
 *   stock would go < 0  new_stock < 0 -> CHECK, and parts.stock >= 0 -> CHECK
 *   ledger moved        quantity reads NULL -> NOT NULL  (see below)
 *
 * `?8` below is the STOCK delta, which is the negative of the issued delta --
 * see stockDelta. Both statements bind the same one, so the ledger's new_stock
 * and the part's balance can never disagree.
 *
 * THE RECONCILIATION GUARD. `plannedIssued` is the issued balance this plan
 * was calculated against. The CASE re-reads that balance from the ledger at
 * write time and yields the quantity only while it still matches; if a
 * concurrent write to the SAME job card moved it, the quantity is NULL and the
 * batch aborts rather than deducting twice. A second identical request does
 * not reach here at all -- its delta is zero -- so this closes only the window
 * where two requests planned at the same moment.
 */
function movementStatements(env, { txnId, jobCardId, partId, delta, plannedIssued, at }) {
  const type = delta > 0 ? USE : RETURN;
  const quantity = Math.abs(delta);
  // `delta` is the change in the quantity ISSUED to this job card. Stock moves
  // the OTHER way: issuing two more units takes two out of stock, and returning
  // two puts two back. The two signs are opposite and must never be conflated.
  const stockDelta = -delta;
  return [
    env.DB.prepare(
      `INSERT INTO inventory_transactions
         (id, part_id, type, quantity, unit_cost, reference_type, reference_id,
          reason, notes, prev_stock, new_stock, created_at)
       SELECT ?1, ?2, ?3,
              CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type = '${USE}'    THEN quantity
                                                  WHEN type = '${RETURN}' THEN -quantity
                                                  ELSE 0 END), 0)
                           FROM inventory_transactions
                          WHERE reference_type = '${JOB_REFERENCE}'
                            AND reference_id   = ?4
                            AND part_id        = ?2) = ?5
                   THEN ?6 END,
              NULL, '${JOB_REFERENCE}', ?4, '', ?7,
              (SELECT stock FROM parts WHERE id = ?2),
              (SELECT stock FROM parts WHERE id = ?2) + ?8,
              ?9`
    ).bind(
      txnId, partId, type, jobCardId, plannedIssued, quantity,
      adjustNote(jobCardId), stockDelta, at
    ),
    env.DB.prepare(
      `UPDATE parts SET stock = stock + ?2, updated_at = ?3 WHERE id = ?1`
    ).bind(partId, stockDelta, at),
  ];
}

/* ---------------------------------------------------------------
   Reconciliation — the port of reconcileJobInventory(), utils.js:361-420
   --------------------------------------------------------------- */

/**
 * Work out which parts have to move, and by how much, for a job card whose
 * lines are changing.
 *
 * The ledger, not the job card, says what has already been issued
 * (utils.js:254-261) -- so an edit that halves a quantity returns the
 * difference even if the lines were edited several times in between. Lines
 * sharing a partId are summed into one requirement, and a manual line (no
 * partId) never enters the calculation at all.
 *
 * The union of parts considered is the stored lines plus the proposed ones,
 * which is exactly utils.js:374-376. A part dropped from the lines is still in
 * it, so whatever it was issued comes back.
 *
 * Returns { plan, shortages } -- plan entries are { partId, delta, issued },
 * and a shortage means a deduction is larger than the part's live stock.
 */
async function planReconciliation(env, jobCardId, storedParts, proposedParts) {
  const required = new Map();
  for (const l of proposedParts) {
    if (!l.partId) continue;
    required.set(l.partId, (required.get(l.partId) || 0) + (Number(l.qty) || 0));
  }
  const partIds = [...new Set([
    ...storedParts.filter((l) => l.partId).map((l) => l.partId),
    ...required.keys(),
  ])];
  if (partIds.length === 0) return { plan: [], shortages: [] };

  // One query for every part: its live stock and its issued balance on this
  // job. Never one lookup per line.
  const holes = partIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT p.id AS part_id, p.name, p.stock,
            COALESCE((SELECT SUM(CASE WHEN t.type = '${USE}'    THEN t.quantity
                                      WHEN t.type = '${RETURN}' THEN -t.quantity
                                      ELSE 0 END)
                        FROM inventory_transactions t
                       WHERE t.reference_type = '${JOB_REFERENCE}'
                         AND t.reference_id   = ?1
                         AND t.part_id        = p.id), 0) AS issued
       FROM parts p
      WHERE p.id IN (${holes})`
  ).bind(jobCardId, ...partIds).all();

  const live = new Map((results ?? []).map((r) => [r.part_id, r]));

  const plan = [];
  const shortages = [];
  for (const partId of partIds) {
    const row = live.get(partId);
    const issued = row ? Number(row.issued) || 0 : 0;
    const delta = (required.get(partId) || 0) - issued;
    if (delta === 0) continue;
    plan.push({ partId, delta, issued });
    if (delta > 0) {
      const available = row ? Number(row.stock) || 0 : 0;
      if (!row || available < delta) {
        shortages.push({
          partId, name: row ? row.name : partId, available, required: delta,
        });
      }
    }
  }
  return { plan, shortages };
}

/**
 * The shortage response, worded as the client's own dialog words it
 * (job-cards.js:936-938) so a form can show it unchanged.
 */
function shortageConflict(shortages) {
  const s = shortages[0];
  return conflict(
    `Insufficient stock for ${s.name}. Available: ${s.available}, Additional required: ${s.required}.`,
    { reason: 'insufficient_stock', shortages }
  );
}

/* Payments are Active or Void (0001); only a Void one holds no money. */
const VOID_PAYMENT = 'Void';

/** The non-Void payments recorded against a job card, oldest first. */
async function activePaymentsOn(env, jobCardId) {
  const { results } = await env.DB.prepare(
    `SELECT id, amount, invoice_id FROM payments
      WHERE job_card_id = ?1 AND status <> '${VOID_PAYMENT}'
      ORDER BY date, id`
  ).bind(jobCardId).all();
  return results ?? [];
}

/** Refusal for an edit made from an older copy of the job card (expectedUpdatedAt). */
function staleEditConflict(current) {
  return conflict('This job card was changed by someone else since it was read. Nothing was saved; read it again and retry.',
    { reason: 'stale_edit', ...(current ? { updatedAt: current } : {}) });
}

/** Refusal for a customer change on a job card that holds payments. */
function customerLockedConflict(held) {
  const ids = held.map((p) => p.id);
  return conflict(
    'This Job Card has recorded payments or advances'
    + (ids.length ? ` (${ids.join(', ')})` : '')
    + ', so its customer cannot be changed. Void those payments first if the customer is wrong.',
    { reason: 'job_card_has_payments', payments: ids }
  );
}

/**
 * A constraint the reconciliation statements raise on purpose, mapped to the
 * rule it enforces. Anything else falls through to constraintFailure().
 */
function inventoryFailure(err) {
  const message = String((err && err.message) || err || '');
  if (/CHECK constraint failed:\s*(new_stock|stock)\s*>=\s*0/i.test(message)) {
    return conflict(
      'Stock changed while this job card was being saved, and the change would take it below zero.',
      { reason: 'insufficient_stock' }
    );
  }
  if (/NOT NULL constraint failed: inventory_transactions\.quantity/i.test(message)) {
    return conflict(
      'This job card\'s stock was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' }
    );
  }
  if (/NOT NULL constraint failed: inventory_transactions\.(prev|new)_stock/i.test(message)) {
    return conflict('A part on this job card no longer exists.', { reason: 'part_not_found' });
  }
  return null;
}

/* ---------------------------------------------------------------
   POST /api/job-cards
   --------------------------------------------------------------- */

/**
 * Create a job card.
 *
 * ---- why this writes no stock ----
 *
 * A new job card is always 'Received' (job-cards.js:877), and stock moves only
 * when a job ENTERS 'In Progress' (:973-1002, via deductForJob). 'Received' is
 * not in INVENTORY_TRACKED, so creation records the part lines and moves
 * nothing -- including when those lines carry a partId. That is not an
 * omission: issuing parts for a job that has not started would take them out
 * of stock for work nobody is doing yet, and the deduction would then happen a
 * second time when the job really started. The batch below still has to be
 * atomic for the parent, its lines and the appointment back-link.
 */
export async function createJobCard(request, env) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const { f, lines } = readJobFields(b, 'create');

  // Status, and the four fields the lifecycle owns. A create may name the
  // status it is about to get, and nothing else: every other value is a
  // transition, which changeStatus() performs and C-6 exposes.
  if (b.status !== undefined && b.status !== CREATE_STATUS) {
    f.reject('status', STATUSES.includes(b.status)
      ? `A new job card always starts as ${CREATE_STATUS}.`
      : `\`status\` must be one of: ${STATUSES.join(', ')}.`);
  }
  if (b.invoiceId !== undefined && b.invoiceId !== null) {
    f.reject('invoiceId', '`invoiceId` is set when the job card is invoiced.');
  }
  for (const key of ['completedAt', 'actualDelivery']) {
    if (b[key] !== undefined && b[key] !== null && b[key] !== '') {
      f.reject(key, `\`${key}\` is set when the job card reaches that status.`);
    }
  }

  const appointmentId = b.appointmentId === undefined || b.appointmentId === null
    || b.appointmentId === ''
    ? null
    : b.appointmentId;
  if (appointmentId !== null && typeof appointmentId !== 'string') {
    f.reject('appointmentId', '`appointmentId` must be a string.');
  }

  if (!f.ok) return unprocessable('Some job card fields are not valid.', f.errors);

  const v = f.values;
  const disc = resolveDiscount(b, v);
  if (disc.errors) return unprocessable('Some job card fields are not valid.', disc.errors);
  const totals = computeTotals({
    services: lines.services, partsUsed: lines.partsUsed,
    labourHours: v.labour_hours, labourRate: v.labour_rate, labourCost: v.labour_cost,
    discount: v.discount, discountType: disc.type, discountRate: disc.rate,
    taxRate: v.tax_rate, paid: v.paid,
  });

  const errors = checkRecord(
    { ...v, discount_type: disc.type, services: lines.services, partsUsed: lines.partsUsed }, totals
  );
  if (Object.keys(errors).length) {
    return unprocessable('Some job card fields are not valid.', errors);
  }

  // The two rules the schema cannot express, in one round trip. Existence of
  // the customer, vehicle and mechanic is left to their foreign keys.
  const check = await env.DB.prepare(
    `SELECT (SELECT customer_id FROM vehicles     WHERE id = ?2) AS vehicle_owner,
            (SELECT customer_id FROM appointments WHERE id = ?1) AS appt_customer,
            (SELECT vehicle_id  FROM appointments WHERE id = ?1) AS appt_vehicle,
            (SELECT job_card_id FROM appointments WHERE id = ?1) AS appt_job_card,
            (SELECT count(*)    FROM appointments WHERE id = ?1) AS appt_found`
  ).bind(appointmentId, v.vehicle_id).first();

  // :726 — nothing in the schema expresses this; there is no composite key.
  if (check.vehicle_owner !== null && check.vehicle_owner !== v.customer_id) {
    return unprocessable('Some job card fields are not valid.', {
      vehicleId: 'Selected vehicle does not belong to this customer.',
    });
  }
  // :738-747 — an appointment must be this customer's, for this vehicle, and
  // not already claimed by another job card.
  if (appointmentId !== null) {
    if (!check.appt_found) {
      return unprocessable('Some job card fields are not valid.', {
        appointmentId: 'Selected appointment no longer exists.',
      });
    }
    if (check.appt_customer !== v.customer_id) {
      return unprocessable('Some job card fields are not valid.', {
        appointmentId: 'Appointment belongs to a different customer.',
      });
    }
    if (check.appt_vehicle !== v.vehicle_id) {
      return unprocessable('Some job card fields are not valid.', {
        appointmentId: 'Appointment is for a different vehicle.',
      });
    }
    if (check.appt_job_card) {
      return conflict(
        `Job Card already exists for this appointment (${check.appt_job_card}).`,
        { reason: 'appointment_already_claimed', conflictsWith: check.appt_job_card }
      );
    }
  }

  const allocated = await allocateId(env, 'jobCards');
  if (allocated.error) {
    console.error('POST /api/job-cards could not allocate an id:', allocated.error);
    return fail('database_error', 'Could not create the job card.', 500);
  }
  const at = nowIso();

  // buildRecord() (:805-826) decides what is stored; these are its outputs.
  const columns = {
    id: allocated.id,
    customer_id: v.customer_id,
    vehicle_id: v.vehicle_id,
    mechanic_id: v.mechanic_id,
    appointment_id: appointmentId,
    invoice_id: null,
    date: v.date,
    est_delivery: v.est_delivery,
    actual_delivery: null,
    completed_at: null,
    status: CREATE_STATUS,
    priority: v.priority,
    mileage: v.mileage,
    mileage_out: v.mileage_out,
    fuel_level: v.fuel_level,
    complaint: v.complaint,
    inspection: v.inspection,
    diagnosis: v.diagnosis,
    technician_notes: v.technician_notes,
    recommendations: v.recommendations,
    condition_notes: v.condition_notes,
    notes: v.notes,
    inspection_checklist: v.inspection_checklist,
    labour_hours: v.labour_hours,
    labour_rate: v.labour_rate,
    labour_cost: totals.labourCost,
    discount: totals.discount,
    discount_type: disc.type,
    discount_rate: disc.rate,
    tax_rate: totals.taxRate,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    paid: totals.paid,
    due: totals.due,
    created_at: at,
  };
  const names = Object.keys(columns);

  const statements = [
    env.DB.prepare(
      `INSERT INTO job_cards (${names.join(', ')})
            VALUES (${names.map((_, i) => `?${i + 1}`).join(', ')})`
    ).bind(...names.map((n) => columns[n])),
    ...lineStatements(env, allocated.id, lines.services, lines.partsUsed),
  ];

  // :888-893 — link only, and only when the appointment is unclaimed. The
  // appointment keeps its own status until work actually starts. The race is
  // closed by ux_jc_appointment, the unique index on job_cards.appointment_id:
  // a second job card for the same appointment cannot be inserted at all, so
  // this UPDATE can never be the thing that decides who wins.
  if (appointmentId !== null) {
    statements.push(env.DB.prepare(
      `UPDATE appointments
          SET job_card_id = ?2, updated_at = ?3
        WHERE id = ?1 AND job_card_id IS NULL`
    ).bind(appointmentId, allocated.id, at));
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('POST /api/job-cards failed:', err);
    return fail('database_error', 'Could not create the job card.', 500);
  }

  return respondWith(env, allocated.id, 201);
}

/* ---------------------------------------------------------------
   PUT /api/job-cards/:id
   --------------------------------------------------------------- */

/**
 * Update a job card, reconciling inventory when the job has already started
 * issuing stock.
 *
 * Merge, not replace (storage.js:71-78): a field that is absent is left alone.
 * `services` and `partsUsed` are whole-array fields -- supplying one replaces
 * that set, leaving it out keeps the stored lines -- which is exactly what
 * `{ ...record, ...changes }` does with an array.
 *
 * Five fields are immutable here, and each names the phase that owns it. They
 * are not silently ignored: a caller that PUTs a whole record back gets a 409
 * naming the field rather than a quiet no-op.
 */
export async function updateJobCard(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['PUT']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const stored = await loadJobCard(env, id.value);
  if (!stored) return fail('not_found', 'No job card with that id.', 404);

  // Optional, and only when sent (offline sync sends it, 0020): the edit was
  // made from the record as it was at `expectedUpdatedAt`. If anyone saved it
  // since, nothing is written -- so a parts movement merged into the lines it
  // read can never overwrite a change made in between. Checked here, and again
  // inside the write itself (the guard statement below), so there is no gap.
  const expected = b.expectedUpdatedAt === undefined ? undefined : (b.expectedUpdatedAt || null);
  if (expected !== undefined && (stored.row.updated_at || null) !== expected) {
    return staleEditConflict(stored.row.updated_at);
  }

  // :860-863 — the edit form refuses to open on a terminal job card, so a
  // terminal one cannot be edited at all. This is the protection that keeps an
  // inventory-affecting change out of a finished record.
  if (TERMINAL.includes(stored.row.status)) {
    return conflict(
      `${stored.row.status} job cards are read-only.`,
      { reason: 'job_card_read_only', status: stored.row.status }
    );
  }

  const { f, lines } = readJobFields(b, 'update');

  // The lifecycle fields. Sending the value a record already has is accepted
  // so a full-record PUT works; changing one is refused, with the reason.
  const immutable = [
    ['status', stored.row.status, 'status_change_not_supported',
      'A job card\'s status is changed by its own status operation, not by an edit.'],
    ['appointmentId', stored.row.appointment_id, 'appointment_link_immutable',
      'An appointment is linked when the job card is created and cannot be changed by an edit.'],
    ['invoiceId', stored.row.invoice_id, 'invoice_link_immutable',
      '`invoiceId` is set when the job card is invoiced.'],
    ['completedAt', stored.row.completed_at, 'completed_at_immutable',
      '`completedAt` is set when the job card is completed.'],
    ['actualDelivery', stored.row.actual_delivery, 'actual_delivery_immutable',
      '`actualDelivery` is set when the job card is delivered.'],
  ];
  for (const [key, current, reason, message] of immutable) {
    if (b[key] === undefined) continue;
    const sent = b[key] === '' ? null : b[key];
    if (sent !== (current ?? null)) {
      return conflict(message, { reason, field: key, current: current ?? null });
    }
  }

  if (!f.ok) return unprocessable('Some job card fields are not valid.', f.errors);
  if (!f.touched && lines.services === undefined && lines.partsUsed === undefined) {
    return unprocessable('No job card fields were supplied to update.');
  }

  const disc = resolveDiscount(b, f.values, stored.row);
  if (disc.errors) return unprocessable('Some job card fields are not valid.', disc.errors);

  // The merged record: stored values, with what was supplied written over them.
  const pick = (column) => (column in f.values ? f.values[column] : stored.row[column]);
  const merged = {
    customer_id: pick('customer_id'),
    vehicle_id: pick('vehicle_id'),
    mechanic_id: pick('mechanic_id'),
    date: pick('date'),
    est_delivery: pick('est_delivery'),
    priority: pick('priority'),
    mileage: pick('mileage'),
    mileage_out: pick('mileage_out'),
    fuel_level: pick('fuel_level'),
    complaint: pick('complaint'),
    inspection: pick('inspection'),
    diagnosis: pick('diagnosis'),
    technician_notes: pick('technician_notes'),
    recommendations: pick('recommendations'),
    condition_notes: pick('condition_notes'),
    notes: pick('notes'),
    inspection_checklist: pick('inspection_checklist'),
    labour_hours: pick('labour_hours'),
    labour_rate: pick('labour_rate'),
    labour_cost: pick('labour_cost'),
    discount: pick('discount'),
    discount_type: disc.type,
    discount_rate: disc.rate,
    tax_rate: pick('tax_rate'),
    paid: pick('paid'),
    services: lines.services ?? stored.services,
    partsUsed: lines.partsUsed ?? stored.partsUsed,
  };

  const totals = computeTotals({
    services: merged.services, partsUsed: merged.partsUsed,
    labourHours: merged.labour_hours, labourRate: merged.labour_rate,
    labourCost: merged.labour_cost,
    discount: merged.discount, discountType: merged.discount_type, discountRate: merged.discount_rate,
    taxRate: merged.tax_rate, paid: merged.paid,
  });

  const errors = checkRecord(merged, totals);
  if (Object.keys(errors).length) {
    return unprocessable('Some job card fields are not valid.', errors);
  }

  // :726 — re-checked against the merged pair, since either side may have moved.
  if (merged.customer_id !== stored.row.customer_id
      || merged.vehicle_id !== stored.row.vehicle_id) {
    const owner = await env.DB.prepare(
      'SELECT customer_id FROM vehicles WHERE id = ?1'
    ).bind(merged.vehicle_id).first();
    if (owner && owner.customer_id !== merged.customer_id) {
      return unprocessable('Some job card fields are not valid.', {
        vehicleId: 'Selected vehicle does not belong to this customer.',
      });
    }
  }

  // A job card holding money keeps its customer. An advance is the customer's
  // money taken against THIS job card, and payments are immutable, so moving
  // the job card to someone else would leave that money on another customer's
  // job -- shown as paid on it, and refused when it is invoiced. This is the
  // explanation; the UPDATE below re-checks it inside the write.
  if (merged.customer_id !== stored.row.customer_id) {
    const held = await activePaymentsOn(env, stored.row.id);
    if (held.length) return customerLockedConflict(held);
  }

  // ---- inventory -----------------------------------------------------------
  // :928-930 — reconciliation happens only for a job that has already started
  // issuing stock. For any other status the lines are a plan, not an issue, and
  // changing them moves nothing.
  let plan = [];
  if (INVENTORY_TRACKED.includes(stored.row.status)) {
    const reconciliation = await planReconciliation(
      env, stored.row.id, stored.partsUsed, merged.partsUsed
    );
    // :932-946 — on a shortage NOTHING is touched and the edit itself is
    // rejected, so the job card and the stock stay in step.
    if (reconciliation.shortages.length) return shortageConflict(reconciliation.shortages);
    plan = reconciliation.plan;
  }

  const at = nowIso();

  // One id per movement, allocated together rather than one after another.
  let txnIds = [];
  if (plan.length) {
    const allocations = await Promise.all(
      plan.map(() => allocateId(env, 'inventoryTransactions'))
    );
    const bad = allocations.find((a) => a.error);
    if (bad) {
      console.error('PUT /api/job-cards/:id could not allocate a ledger id:', bad.error);
      return fail('database_error', 'Could not update the job card.', 500);
    }
    txnIds = allocations.map((a) => a.id);
  }

  const columns = {
    customer_id: merged.customer_id,
    vehicle_id: merged.vehicle_id,
    mechanic_id: merged.mechanic_id,
    date: merged.date,
    est_delivery: merged.est_delivery,
    priority: merged.priority,
    mileage: merged.mileage,
    mileage_out: merged.mileage_out,
    fuel_level: merged.fuel_level,
    complaint: merged.complaint,
    inspection: merged.inspection,
    diagnosis: merged.diagnosis,
    technician_notes: merged.technician_notes,
    recommendations: merged.recommendations,
    condition_notes: merged.condition_notes,
    notes: merged.notes,
    inspection_checklist: merged.inspection_checklist,
    labour_hours: merged.labour_hours,
    labour_rate: merged.labour_rate,
    labour_cost: totals.labourCost,
    discount: totals.discount,
    discount_type: merged.discount_type,
    discount_rate: merged.discount_rate,
    tax_rate: totals.taxRate,
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    paid: totals.paid,
    due: totals.due,
    updated_at: at,
  };
  const names = Object.keys(columns);

  const statements = [];
  // The stale-edit guard, inside the write: if the row changed after the check
  // above, this sets vehicle_id to NULL, the NOT NULL constraint refuses it and
  // the WHOLE batch -- lines and stock included -- rolls back.
  if (expected !== undefined) {
    statements.push(env.DB.prepare(
      'UPDATE job_cards SET vehicle_id = NULL WHERE id = ?1 AND updated_at IS NOT ?2'
    ).bind(stored.row.id, expected));
  }
  // A customer CHANGE is re-checked inside the write: if a payment was recorded
  // against this job card after the check above, this statement writes NULL
  // into customer_id, the NOT NULL constraint refuses it, and the whole batch
  // -- lines and stock included -- rolls back (explained in the catch below).
  // With no payment it matches nothing. It runs first, while the row still
  // holds the stored customer, and is not sent at all when the customer stays.
  if (merged.customer_id !== stored.row.customer_id) {
    statements.push(env.DB.prepare(
      `UPDATE job_cards SET customer_id = NULL
        WHERE id = ?1 AND customer_id <> ?2
          AND EXISTS (SELECT 1 FROM payments p
                       WHERE p.job_card_id = ?1 AND p.status <> '${VOID_PAYMENT}')`
    ).bind(stored.row.id, merged.customer_id));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE job_cards
          SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')}
        WHERE id = ?${names.length + 1}`
    ).bind(...names.map((n) => columns[n]), stored.row.id),
  );

  // A line table is rewritten only when its array was supplied. The child rows
  // carry no identity anything else refers to -- the ledger reconciles by
  // part_id and job card id, never by line -- so replacing the set wholesale
  // loses no history. Leaving an untouched table alone keeps a patch that only
  // changes the discount from churning rows for no reason.
  if (lines.services !== undefined) {
    statements.push(env.DB.prepare(
      'DELETE FROM job_card_services WHERE job_card_id = ?1'
    ).bind(stored.row.id));
  }
  if (lines.partsUsed !== undefined) {
    statements.push(env.DB.prepare(
      'DELETE FROM job_card_parts WHERE job_card_id = ?1'
    ).bind(stored.row.id));
  }
  statements.push(...lineStatements(
    env, stored.row.id,
    lines.services !== undefined ? lines.services : [],
    lines.partsUsed !== undefined ? lines.partsUsed : []
  ));

  plan.forEach((entry, i) => {
    statements.push(...movementStatements(env, {
      txnId: txnIds[i],
      jobCardId: stored.row.id,
      partId: entry.partId,
      delta: entry.delta,
      plannedIssued: entry.issued,
      at,
    }));
  });

  try {
    await env.DB.batch(statements);
  } catch (err) {
    const inventory = inventoryFailure(err);
    if (inventory) return inventory;
    if (/NOT NULL constraint failed: job_cards\.customer_id/i.test(String((err && err.message) || err || ''))) {
      return customerLockedConflict(await activePaymentsOn(env, stored.row.id));
    }
    if (expected !== undefined && /NOT NULL constraint failed: job_cards\.vehicle_id/i.test(String((err && err.message) || err || ''))) {
      return staleEditConflict(null);
    }
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('PUT /api/job-cards/:id failed:', err);
    return fail('database_error', 'Could not update the job card.', 500);
  }

  return respondWith(env, stored.row.id, 200);
}

/* ---------------------------------------------------------------
   DELETE /api/job-cards/:id
   --------------------------------------------------------------- */

/**
 * Delete a job card, if all three of the client's guards allow it
 * (job-cards.js:1040-1086).
 *
 * ---- what deletion does NOT do ----
 *
 * It does not return stock. A deletable job card is either 'Received', which
 * never issued anything, or 'Cancelled', whose stock was already returned by
 * changeStatus() when it was cancelled (:1003-1006). Returning it again here
 * would credit the same units twice.
 *
 * It does not remove ledger rows either. inventory_transactions has no foreign
 * key to job_cards on purpose: the ledger is append-only history that explains
 * a stock balance, and it must survive the record that caused it.
 */
export async function deleteJobCard(request, env, rawId) {
  if (request.method !== 'DELETE') return methodNotAllowed(['DELETE']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  // :1044-1045 — the client looks for the invoice the job card points at, or,
  // when it points at none, for an invoice that points back at it.
  const row = await env.DB.prepare(
    `SELECT j.status,
            CASE WHEN j.invoice_id IS NOT NULL
                 THEN (SELECT i.id FROM invoices i WHERE i.id = j.invoice_id)
                 ELSE (SELECT i.id FROM invoices i WHERE i.job_card_id = j.id LIMIT 1)
            END AS invoice_id
       FROM job_cards j
      WHERE j.id = ?1`
  ).bind(id.value).first();
  if (!row) return fail('not_found', 'No job card with that id.', 404);

  if (row.invoice_id) {
    return conflict(
      `This job card is linked to invoice ${row.invoice_id}. Invoiced job cards are permanent business records.`,
      { reason: 'job_card_invoiced', invoiceId: row.invoice_id }
    );
  }
  if (DONE.includes(row.status)) {
    return conflict(
      'This job card contains completed work and is part of the vehicle\'s service history.',
      { reason: 'job_card_completed', status: row.status }
    );
  }
  if (!DELETABLE.includes(row.status)) {
    return conflict(
      `This job card is ${row.status}. Cancel it instead of deleting it, so the recorded work is preserved.`,
      { reason: 'work_started', status: row.status }
    );
  }

  try {
    // :1078-1082 — unlink the appointment first so it keeps its own record.
    // The foreign key is ON DELETE SET NULL and would do the same, but doing
    // it here refreshes updated_at the way Storage.updateData() does.
    // The line tables are ON DELETE CASCADE and need no statement.
    const results = await env.DB.batch([
      env.DB.prepare(
        'UPDATE appointments SET job_card_id = NULL, updated_at = ?2 WHERE job_card_id = ?1'
      ).bind(id.value, nowIso()),
      env.DB.prepare('DELETE FROM job_cards WHERE id = ?1').bind(id.value),
    ]);

    const removed = results[results.length - 1];
    if (!removed.meta || removed.meta.changes === 0) {
      return fail('not_found', 'No job card with that id.', 404);
    }
  } catch (err) {
    // payments.job_card_id is ON DELETE RESTRICT, so a job card with a payment
    // against it raises here. That IS a delete guard, not a server error.
    const mapped = constraintFailure(err);
    if (mapped) return mapped;
    console.error('DELETE /api/job-cards/:id failed:', err);
    return fail('database_error', 'Could not delete the job card.', 500);
  }

  return ok({ id: id.value, deleted: true });
}

/* ============================================================
   C-6 — the status transition
   ------------------------------------------------------------
   POST /api/job-cards/:id/status, and the ONLY place a job card's
   status moves. C-5's PUT refuses a status change on purpose, so
   there is exactly one state machine in this API and it is the one
   below.

   This is a port of changeStatus() (job-cards.js:964-1036). One
   request can move the job card's status, its completedAt or
   actualDelivery, parts.stock, the inventory ledger and the linked
   appointment's status. All of it goes in ONE env.DB.batch().

   ---- the four things that make this safe ----

   1. THE STATUS UPDATE IS THE GATE. It carries
      `AND status = <expected>`, so two concurrent requests cannot
      both perform the same transition -- one matches the row, the
      other matches nothing. meta.changes says which happened.

   2. EVERY DEPENDENT STATEMENT IS CONDITIONAL ON THAT GATE.
      Statements in a batch share one transaction, so the ones
      after it re-read the job card's status and do nothing unless
      the transition actually landed. A status update that changes
      no rows can therefore never be followed by a stock movement.

   3. THE DEDUCTION CARRIES hasJobDeduction() ITSELF. The ledger
      INSERT's `NOT EXISTS (... job-card-use ... this job ... this
      part)` is utils.js:241-245 written in SQL -- the same rule
      that makes In Progress <-> Waiting for Parts ping-pong safe
      in the browser. The stock UPDATE beside it applies only if
      that INSERT wrote its row, so the two can never disagree.

   4. A RETURN RE-VERIFIES THE BALANCE IT PLANNED AGAINST, and
      yields a NULL quantity if it moved -- which the column's NOT
      NULL turns into a rolled-back batch rather than a wrong
      return. The status change goes back with it.
   ============================================================ */

/**
 * The transition table, copied from job-cards.js:46-56.
 *
 * This is the whole state machine and nothing is derived from it: a status is
 * reachable only if it is listed here. No entry lists itself, which is what
 * makes "no change" an invalid transition rather than a silent success --
 * changeStatus() rejects it at :967 exactly like any other illegal move.
 */
const TRANSITIONS = {
  'Received': ['Inspection', 'Cancelled'],
  'Inspection': ['In Progress', 'Waiting for Approval', 'Cancelled'],
  'Waiting for Approval': ['In Progress', 'Cancelled'],
  'In Progress': ['Waiting for Parts', 'Waiting for Approval', 'Completed', 'Cancelled'],
  'Waiting for Parts': ['In Progress'],
  'Completed': ['Delivered'],
  'Delivered': [],
  'Cancelled': [],
};

/* The two statuses that move stock, and nothing else does. :973 issues the
   job's parts on entering In Progress; :1003 returns them on Cancelled.
   Waiting for Parts has NO branch in changeStatus(), so entering or leaving it
   moves nothing -- what was issued stays issued while the job waits. */
const DEDUCT_ON = 'In Progress';
const RETURN_ON = 'Cancelled';

/* utils.js:296 and :328 — the notes each movement carries, verbatim, so a row
   written here is indistinguishable from one the browser wrote. */
const usedNote = (jobId) => `Used on ${jobId}`;
const cancelNote = (jobId) => `Returned — ${jobId} cancelled`;

/* :1015 — an appointment that has finished is never moved again. Its own
   terminal list, not the job card's. */
const APPOINTMENT_TERMINAL = ['Completed', 'Cancelled', 'No Show'];

/**
 * :1016-1020 — the one-way status mapping, and the whole of it.
 *
 * Work actually starting moves the appointment to In Progress; the job card
 * being completed completes it. Every other transition leaves the appointment
 * alone, and nothing ever flows the other way.
 *
 * Note what this deliberately does NOT do: it does not consult the
 * APPOINTMENT's own transition table (appointments.js:26-33), which would not
 * allow Scheduled -> In Progress or Confirmed -> Completed. changeStatus()
 * writes the status directly, so the job card overrides that table, and
 * reproducing the override is the faithful thing to do. C-3's own endpoint
 * still enforces it for a caller changing an appointment directly.
 */
const APPOINTMENT_SYNC = {
  'In Progress': 'In Progress',
  'Completed': 'Completed',
};

/**
 * Fields the server owns on a status change. Refused by name rather than
 * ignored, so a caller cannot believe it set a timestamp or a quantity that
 * the server actually decided.
 */
const STATUS_SERVER_OWNED = {
  completedAt: '`completedAt` is set by the server when a job card is completed.',
  actualDelivery: '`actualDelivery` is set by the server when a job card is delivered.',
  paid: '`paid` is not changed by a status transition.',
  due: '`due` is not changed by a status transition.',
  subtotal: '`subtotal` is not changed by a status transition.',
  tax: '`tax` is not changed by a status transition.',
  total: '`total` is not changed by a status transition.',
  invoiceId: '`invoiceId` is not changed by a status transition.',
  appointmentId: '`appointmentId` is set when the job card is created.',
  quantity: '`quantity` is not a status field. Inventory follows from the transition.',
  prevStock: '`prevStock` is recorded by the server from the live stock.',
  newStock: '`newStock` is recorded by the server from the live stock.',
};

/**
 * The parent row a transition needs, plus the part lines it may have to issue.
 *
 * Deliberately narrower than loadJobCard(): a status change never looks at the
 * service lines or the money, so it does not read them. The part lines are
 * read only for the one transition that issues stock.
 */
async function loadForTransition(env, id, next) {
  const row = await env.DB.prepare(
    `SELECT id, status, appointment_id, completed_at, actual_delivery
       FROM job_cards WHERE id = ?1 LIMIT 1`
  ).bind(id).first();
  if (!row) return null;

  if (next !== DEDUCT_ON) return { row, partLines: [] };

  const { results } = await env.DB.prepare(
    `SELECT part_id, name, qty FROM job_card_parts
      WHERE job_card_id = ?1 AND part_id IS NOT NULL
      ORDER BY line_no, id`
  ).bind(id).all();
  return { row, partLines: results ?? [] };
}

/**
 * What entering In Progress has to issue — the port of checkJobStock() and
 * deductForJob() (utils.js:267-301).
 *
 * The rule is NOT a delta. deductForJob() asks hasJobDeduction(): has this job
 * ever been issued this part at all? If it has, the line is skipped entirely,
 * whatever quantity it now names; if it has not, the line's FULL quantity is
 * issued. That is what makes In Progress -> Waiting for Parts -> In Progress
 * safe, and it is why a quantity changed while the job was already issuing is
 * C-5's reconciliation to settle, not this one's.
 *
 * Two lines naming the same part issue ONCE, for the first line's quantity:
 * move() writes its ledger row immediately, so the second line's
 * hasJobDeduction() already sees it. Reproduced here by taking the first line
 * per part and ignoring the rest.
 *
 * The shortage check is per LINE and against live stock, and it reports the
 * LINE's name -- the snapshot, which is what checkJobStock() pushes (:276).
 *
 * Returns { plan, shortages }.
 */
async function planIssue(env, jobCardId, partLines) {
  if (partLines.length === 0) return { plan: [], shortages: [] };

  const partIds = [...new Set(partLines.map((l) => l.part_id))];
  // One query for every part: its live stock, and whether this job has ever
  // been issued it. Never one lookup per line.
  const holes = partIds.map((_, i) => `?${i + 2}`).join(', ');
  const { results } = await env.DB.prepare(
    `SELECT p.id AS part_id, p.stock,
            EXISTS (SELECT 1 FROM inventory_transactions t
                     WHERE t.type           = '${USE}'
                       AND t.reference_type = '${JOB_REFERENCE}'
                       AND t.reference_id   = ?1
                       AND t.part_id        = p.id) AS issued_before
       FROM parts p
      WHERE p.id IN (${holes})`
  ).bind(jobCardId, ...partIds).all();

  const live = new Map((results ?? []).map((r) => [r.part_id, r]));

  const plan = [];
  const shortages = [];
  const planned = new Set();
  for (const line of partLines) {
    const row = live.get(line.part_id);
    // :271 — already issued to this job, so neither checked nor deducted.
    if (row && row.issued_before) continue;
    const available = row ? Number(row.stock) || 0 : 0;
    const required = Number(line.qty) || 0;
    // :277-279 — a missing part counts as zero available, and the message
    // names the LINE, because that is the name the user typed or chose.
    if (!row || available < required) {
      shortages.push({ partId: line.part_id, name: line.name, available, required });
      continue;
    }
    // :293 — the second line for a part finds the first line's row already
    // written, so only the first one issues.
    if (planned.has(line.part_id)) continue;
    planned.add(line.part_id);
    plan.push({ partId: line.part_id, quantity: required });
  }
  return { plan, shortages };
}

/**
 * What Cancelled has to give back — the port of returnForJob()
 * (utils.js:313-333).
 *
 * The LEDGER decides, not the job card's lines: each part gets back exactly
 * what is still outstanding, which is why a job whose quantity was later
 * reduced returns three rather than the five it once asked for. A part with
 * nothing outstanding is skipped, so cancelling twice cannot return twice.
 *
 * returnForJob() takes the union of the job's current part lines and every
 * part the ledger has issued it. A line with no ledger history has an
 * outstanding balance of zero and is skipped, so grouping the ledger alone is
 * the same set of movements and costs one query with no IN-list.
 */
async function planReturn(env, jobCardId) {
  const { results } = await env.DB.prepare(
    `SELECT t.part_id,
            COALESCE(SUM(CASE WHEN t.type = '${USE}'    THEN t.quantity
                              WHEN t.type = '${RETURN}' THEN -t.quantity
                              ELSE 0 END), 0) AS outstanding
       FROM inventory_transactions t
      WHERE t.reference_type = '${JOB_REFERENCE}' AND t.reference_id = ?1
      GROUP BY t.part_id
      ORDER BY t.part_id`
  ).bind(jobCardId).all();

  return (results ?? [])
    .filter((r) => Number(r.outstanding) > 0)
    .map((r) => ({ partId: r.part_id, quantity: Number(r.outstanding) }));
}

/**
 * The two statements that issue one part for a job card.
 *
 * `landed` is the status the transition is moving TO. Both statements are
 * conditional on the job card actually holding it, so a status UPDATE that
 * matched nothing is never followed by a movement.
 *
 * Nothing is computed in JavaScript. prev_stock and new_stock are read from
 * the live row inside the INSERT, and the schema answers every failure:
 *
 *   part missing        prev_stock reads NULL -> NOT NULL -> batch aborts
 *   stock would go < 0  new_stock < 0 and parts.stock >= 0 -> CHECK -> aborts
 *   already issued      NOT EXISTS matches nothing -> no row, and the stock
 *                       UPDATE beside it finds no row to point at either
 */
function issueStatements(env, { txnId, jobCardId, partId, quantity, landed, at }) {
  return [
    env.DB.prepare(
      `INSERT INTO inventory_transactions
         (id, part_id, type, quantity, unit_cost, reference_type, reference_id,
          reason, notes, prev_stock, new_stock, created_at)
       SELECT ?1, ?2, '${USE}', ?3, NULL, '${JOB_REFERENCE}', ?4, '', ?5,
              (SELECT stock FROM parts WHERE id = ?2),
              (SELECT stock FROM parts WHERE id = ?2) - ?3,
              ?6
        WHERE (SELECT status FROM job_cards WHERE id = ?4) = ?7
          AND NOT EXISTS (SELECT 1 FROM inventory_transactions
                           WHERE type           = '${USE}'
                             AND reference_type = '${JOB_REFERENCE}'
                             AND reference_id   = ?4
                             AND part_id        = ?2)`
    ).bind(txnId, partId, quantity, jobCardId, usedNote(jobCardId), at, landed),
    // Tied to its own ledger row rather than repeating the guards: the stock
    // moves if and only if the movement above was recorded.
    env.DB.prepare(
      `UPDATE parts SET stock = stock - ?2, updated_at = ?3
        WHERE id = ?1
          AND EXISTS (SELECT 1 FROM inventory_transactions WHERE id = ?4)`
    ).bind(partId, quantity, at, txnId),
  ];
}

/**
 * The two statements that give one part back when a job card is cancelled.
 *
 * The WHERE keeps it conditional on the transition landing, exactly as above.
 * The quantity is where the two differ: `plannedOutstanding` is the balance
 * this plan was computed from, and the CASE re-reads it at write time. If
 * something moved it in between -- a concurrent edit reconciling the same job
 * -- the quantity is NULL, the column's NOT NULL aborts the batch, and the
 * status change rolls back with it. Returning a stale amount would put the
 * ledger and the stock permanently out of step, which no later operation could
 * repair.
 */
function returnStatements(env, { txnId, jobCardId, partId, quantity, landed, at }) {
  return [
    env.DB.prepare(
      `INSERT INTO inventory_transactions
         (id, part_id, type, quantity, unit_cost, reference_type, reference_id,
          reason, notes, prev_stock, new_stock, created_at)
       SELECT ?1, ?2, '${RETURN}',
              CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type = '${USE}'    THEN quantity
                                                  WHEN type = '${RETURN}' THEN -quantity
                                                  ELSE 0 END), 0)
                           FROM inventory_transactions
                          WHERE reference_type = '${JOB_REFERENCE}'
                            AND reference_id   = ?4
                            AND part_id        = ?2) = ?3
                   THEN ?3 END,
              NULL, '${JOB_REFERENCE}', ?4, '', ?5,
              (SELECT stock FROM parts WHERE id = ?2),
              (SELECT stock FROM parts WHERE id = ?2) + ?3,
              ?6
        WHERE (SELECT status FROM job_cards WHERE id = ?4) = ?7`
    ).bind(txnId, partId, quantity, jobCardId, cancelNote(jobCardId), at, landed),
    env.DB.prepare(
      `UPDATE parts SET stock = stock + ?2, updated_at = ?3
        WHERE id = ?1
          AND EXISTS (SELECT 1 FROM inventory_transactions WHERE id = ?4)`
    ).bind(partId, quantity, at, txnId),
  ];
}

/**
 * A constraint the transition's statements raise on purpose, mapped to the
 * rule it enforces. Anything else falls through to constraintFailure().
 */
function transitionFailure(err) {
  const message = String((err && err.message) || err || '');
  if (/CHECK constraint failed:\s*(new_stock|stock)\s*>=\s*0/i.test(message)) {
    return conflict(
      'Stock changed while this job card was being updated, and the change would take it below zero.',
      { reason: 'insufficient_stock' }
    );
  }
  if (/NOT NULL constraint failed: inventory_transactions\.quantity/i.test(message)) {
    return conflict(
      'This job card\'s stock was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification' }
    );
  }
  if (/NOT NULL constraint failed: inventory_transactions\.(prev|new)_stock/i.test(message)) {
    return conflict('A part on this job card no longer exists.', { reason: 'part_not_found' });
  }
  return null;
}

/**
 * POST /api/job-cards/:id/status
 *
 * The only backend operation that moves a job card's status.
 *
 * ---- what a transition does, and when ----
 *
 *   any             the status itself, and updated_at
 *   -> In Progress  issues every part line this job has never been issued,
 *                   and moves a linked, unfinished appointment to In Progress
 *   -> Completed    stamps completed_at, if it is not already stamped, and
 *                   completes a linked, unfinished appointment
 *   -> Delivered    stamps actual_delivery with the WORKSHOP's calendar day,
 *                   if it is not already stamped
 *   -> Cancelled    returns whatever is still outstanding on the ledger
 *   -> Waiting for Parts, Inspection, Waiting for Approval
 *                   the status alone; changeStatus() has no branch for them
 *
 * Nothing here touches the money. paid, due, subtotal, tax, total and
 * invoice_id are not part of a status change in the client either -- an
 * invoiced job card's status moves like any other, because changeStatus() has
 * no invoice guard (:964-1036). C-7 and C-8 own those.
 */
export async function setJobCardStatus(request, env, rawId) {
  if (request.method !== 'POST') return methodNotAllowed(['POST']);
  if (!env.DB) return noDatabase();

  const id = readRecordId(rawId);
  if (id.error) return fail('invalid_id', id.error, 400);

  const body = await readJsonBody(request);
  if (body.error) return fail('invalid_body', body.error, 400);
  const b = body.value;

  const errors = {};
  for (const [key, message] of Object.entries(STATUS_SERVER_OWNED)) {
    if (b[key] !== undefined) errors[key] = message;
  }
  const next = readEnum(b, 'status', STATUSES, { required: true });
  if (next.error) errors.status = next.error;
  if (Object.keys(errors).length) {
    return unprocessable('Some status fields are not valid.', errors);
  }

  const loaded = await loadForTransition(env, id.value, next.value);
  if (!loaded) return fail('not_found', 'No job card with that id.', 404);
  const current = loaded.row.status;

  // :967 — the whole gate. A status is reachable only if TRANSITIONS lists it,
  // and no entry lists itself, so "no change" lands here too. The message is
  // the client's own; the reason distinguishes the three ways to get it.
  const allowed = TRANSITIONS[current] ?? [];
  if (!allowed.includes(next.value)) {
    return conflict(
      `Cannot change ${current} job card to ${next.value}.`,
      {
        reason: current === next.value ? 'same_status'
          : allowed.length === 0 ? 'job_card_terminal'
            : 'invalid_status_transition',
        from: current,
        to: next.value,
        allowed,
      }
    );
  }

  // ---- the inventory plan, worked out in full before anything moves --------
  let issues = [];
  let returns = [];
  if (next.value === DEDUCT_ON) {
    const planned = await planIssue(env, id.value, loaded.partLines);
    // :976-989 — one short part stops the whole transition, and the job card
    // does not move. The wording is the client's own dialog.
    if (planned.shortages.length) {
      const s = planned.shortages[0];
      return conflict(
        `Insufficient stock for ${s.name}. Available: ${s.available}, Required: ${s.required}.`,
        { reason: 'insufficient_stock', shortages: planned.shortages }
      );
    }
    issues = planned.plan;
  } else if (next.value === RETURN_ON) {
    returns = await planReturn(env, id.value);
  }

  // One id per movement, allocated together rather than one after another.
  const movements = [...issues, ...returns];
  let txnIds = [];
  if (movements.length) {
    const allocations = await Promise.all(
      movements.map(() => allocateId(env, 'inventoryTransactions'))
    );
    const bad = allocations.find((a) => a.error);
    if (bad) {
      console.error('POST /api/job-cards/:id/status could not allocate a ledger id:', bad.error);
      return fail('database_error', 'Could not change the job card status.', 500);
    }
    txnIds = allocations.map((a) => a.id);
  }

  const at = nowIso();
  const sets = ['status = ?2', 'updated_at = ?3'];
  const binds = [id.value, next.value, at];

  // :993 — stamped on entering Completed, and only if it is not already
  // stamped. An instant, so nowIso(); the column is a timestamp, not a day.
  if (next.value === 'Completed' && !loaded.row.completed_at) {
    binds.push(at);
    sets.push(`completed_at = ?${binds.length}`);
  }
  // :994 — todayStr() reads the BROWSER's calendar, which in the shop is
  // Asia/Dhaka. A Worker runs in UTC, so the zone is named explicitly; this is
  // audit Finding 2, and the column holds a local calendar day.
  if (next.value === 'Delivered' && !loaded.row.actual_delivery) {
    binds.push(todayInDhaka());
    sets.push(`actual_delivery = ?${binds.length}`);
  }
  binds.push(current);

  const statements = [
    // THE GATE. `AND status = <expected>` is what makes two concurrent
    // requests settle: one matches the row, the other matches nothing, and
    // meta.changes below says which this was.
    env.DB.prepare(
      `UPDATE job_cards SET ${sets.join(', ')}
        WHERE id = ?1 AND status = ?${binds.length}`
    ).bind(...binds),
  ];

  issues.forEach((m, i) => {
    statements.push(...issueStatements(env, {
      txnId: txnIds[i], jobCardId: id.value, partId: m.partId,
      quantity: m.quantity, landed: next.value, at,
    }));
  });
  returns.forEach((m, i) => {
    statements.push(...returnStatements(env, {
      txnId: txnIds[issues.length + i], jobCardId: id.value, partId: m.partId,
      quantity: m.quantity, landed: next.value, at,
    }));
  });

  // :1013-1023 — the appointment follows the job card, never the other way
  // round, and only for these two transitions. A finished appointment is left
  // alone, its source is never touched, and its job_card_id is C-5's to set.
  const apptStatus = APPOINTMENT_SYNC[next.value];
  if (loaded.row.appointment_id && apptStatus) {
    const terminal = APPOINTMENT_TERMINAL.map((s) => `'${s}'`).join(', ');
    statements.push(env.DB.prepare(
      `UPDATE appointments SET status = ?2, updated_at = ?3
        WHERE id = ?1
          AND status NOT IN (${terminal})
          AND status <> ?2
          AND (SELECT status FROM job_cards WHERE id = ?4) = ?2`
    ).bind(loaded.row.appointment_id, apptStatus, at, id.value));
  }

  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (err) {
    const mapped = transitionFailure(err);
    if (mapped) return mapped;
    const constraint = constraintFailure(err);
    if (constraint) return constraint;
    console.error('POST /api/job-cards/:id/status failed:', err);
    return fail('database_error', 'Could not change the job card status.', 500);
  }

  // The gate's own answer. Nothing else in the batch can have run, because
  // every dependent statement re-reads the status this one was meant to set.
  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    return conflict(
      'This job card was changed by another request. Reload it and try again.',
      { reason: 'concurrent_modification', expected: current }
    );
  }

  return respondWith(env, id.value, 200);
}
