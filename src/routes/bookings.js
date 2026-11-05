/* ============================================================
   routes/bookings.js — Social Inbox › Bookings        (migration 0023)
   ------------------------------------------------------------
   A BOOKING is a customer's request for a service. It is not an
   appointment: nothing here creates, changes or reserves an
   appointment, and a booking reserves no workshop slot.

   PUBLIC (no session -- the website's visitors have none):

     POST    /api/bookings/submit     the website's Book Now form
     OPTIONS /api/bookings/submit     the browser's CORS preflight

   Only the website's own origins may call it from a browser (the same
   list as Website Forms: https://taqwa.autos, https://www.taqwa.autos,
   plus FORMS_ALLOWED_ORIGINS). Every field is validated here. Spam and
   repeats are held back by:
     * a honeypot field (`company`) a person never sees or fills;
     * a minimum time on the form (`startedAt`);
     * at most RATE_SHORT submissions per address per 10 minutes and
       RATE_DAY per day (by a salted hash of the IP; the IP is not kept);
     * an idempotency key from the browser: a retried submission gets the
       same reference back, nothing is added;
     * the same phone + date + service while an earlier request for it is
       still open (within 24 hours) is the same booking: its reference is
       returned, nothing is added.
   A suspected bot is told "received" (BKG-0000) and nothing is stored.
   The answer carries only a reference number -- never any stored data.

   STAFF (behind the auth gate, permission `bookings.*`):

     GET  /api/bookings               list: q, status, source, from, to
                                      (preferred date), assigned, limit,
                                      offset; summary counts per status
     GET  /api/bookings/:id           one booking, with history, notes and
                                      possible customer / vehicle matches
     POST /api/bookings               a booking entered by staff
                                      (Phone, Walk-in, Manual, WhatsApp,
                                      Facebook)
     PUT  /api/bookings/:id           { assignedStaffId?, customerId?,
                                        vehicleId?, expectedUpdatedAt }
     POST /api/bookings/:id/status    { to, reason?, date?, time?,
                                        expectedUpdatedAt }
     POST /api/bookings/:id/notes     { note }

   The submitted details are a snapshot and are never edited. Status
   changes follow TRANSITIONS; Rejected and Cancelled need a reason;
   Rescheduled needs the new date and time. Every change is written to
   booking_history in the same batch as the guarded update, so a change
   made from an old copy is refused (409) and leaves no history behind.
   There is no delete: an unwanted booking is Rejected or Cancelled.
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, unprocessable, conflict, SECURITY_HEADERS } from '../lib/http.js';
import { readJsonBody, readDate, nowIso, todayInDhaka, allocateId } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { can } from '../lib/permissions.js';
import { corsHeaders, withHeaders, ipHash } from './website-forms.js';

export const BOOKING_STATUSES = ['New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Rejected', 'Completed'];
export const BOOKING_SOURCES = ['Website', 'WhatsApp', 'Facebook', 'Phone', 'Walk-in', 'Manual'];
/** Current status -> the statuses it may move to. The last three are final. */
export const TRANSITIONS = {
  New: ['Pending', 'Confirmed', 'Rejected', 'Cancelled'],
  Pending: ['Confirmed', 'Rejected', 'Cancelled'],
  Confirmed: ['Rescheduled', 'Cancelled', 'Completed'],
  Rescheduled: ['Confirmed', 'Cancelled'],
  Cancelled: [],
  Rejected: [],
  Completed: [],
};
const OPEN_STATUSES = ['New', 'Pending', 'Confirmed', 'Rescheduled'];
const NEEDS_REASON = ['Rejected', 'Cancelled'];
/** The website's Book Now service keys and the labels it shows (mh-71/taqwa BookingForm.astro). */
export const SERVICE_TYPES = {
  'lpg-conversion': 'LPG Conversion',
  'cng-conversion': 'CNG Conversion',
  'engine-repair': 'Engine Repair & Service',
  'car-ac': 'Car AC Service',
  'battery-electrical': 'Battery & Electrical',
  'denting-painting': 'Denting & Painting',
  'car-wash': 'Car Wash & Detailing',
  'periodic-maintenance': 'Periodic Maintenance',
  hybrid: 'Hybrid Vehicle Service',
  other: 'Other',
};

const MAX_PUBLIC_BYTES = 16 * 1024;
const RATE_SHORT = 5;                         // per address per 10 minutes
const RATE_DAY = 20;                          // per address per day
const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;
const MIN_FILL_MS = 3000;
const MAX_DAYS_AHEAD = 90;
const LIMITS = { name: 120, phone: 20, email: 160, make: 50, model: 50, reg: 20, message: 1000, reason: 500, note: 2000, q: 100, sourceReference: 60 };
const PHONE_CHARS = /^[0-9+\-\s()]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const BOOKING_ID = /^BKG-\d{1,10}$/;
const STAFF_ID = /^[A-Z]{2,5}-\d{1,10}$/;
const RECORD_ID = /^[A-Z]{2,5}-\d{1,10}$/;
const IDEMPOTENCY = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const PUBLIC_KEYS = ['name', 'phone', 'email', 'vehicleMake', 'vehicleModel', 'registrationNumber', 'serviceType',
  'preferredDate', 'preferredTime', 'message', 'consent', 'company', 'startedAt', 'idempotencyKey'];
const STAFF_CREATE_KEYS = ['name', 'phone', 'email', 'vehicleMake', 'vehicleModel', 'registrationNumber', 'serviceType',
  'preferredDate', 'preferredTime', 'message', 'consent', 'source', 'sourceReference'];

const COLUMNS = `id, source, source_reference, customer_name, phone, phone_digits, email, vehicle_make, vehicle_model,
  registration_number, service_type, service_label, preferred_date, preferred_time, customer_message, consent, consent_at,
  status, customer_id, vehicle_id, appointment_id, assigned_staff_id, assigned_staff_name, assigned_at, assigned_by,
  created_at, updated_at, updated_by, confirmed_at, cancelled_at`;

function toRecord(row) {
  return {
    id: row.id,
    reference: row.id,
    source: row.source,
    sourceReference: row.source_reference || '',
    customerName: row.customer_name,
    phone: row.phone,
    email: row.email || '',
    vehicleMake: row.vehicle_make,
    vehicleModel: row.vehicle_model,
    registrationNumber: row.registration_number || '',
    serviceType: row.service_type,
    serviceLabel: row.service_label,
    preferredDate: row.preferred_date,
    preferredTime: row.preferred_time,
    message: row.customer_message || '',
    consent: row.consent === 1,
    consentAt: row.consent_at || '',
    status: row.status,
    customerId: row.customer_id || '',
    vehicleId: row.vehicle_id || '',
    appointmentId: row.appointment_id || '',
    assignedStaffId: row.assigned_staff_id || '',
    assignedStaffName: row.assigned_staff_name || '',
    assignedAt: row.assigned_at || '',
    assignedBy: row.assigned_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || '',
    confirmedAt: row.confirmed_at || '',
    cancelledAt: row.cancelled_at || '',
  };
}

const toEvent = (row) => ({
  id: row.id, action: row.action, fromStatus: row.from_status || '', toStatus: row.to_status || '',
  detail: row.detail || '', reason: row.reason || '', actor: row.actor, at: row.created_at,
});
const toNote = (row) => ({ id: row.id, note: row.note, by: row.created_by, at: row.created_at });

/* ---------- helpers ---------- */

/**
 * A Bangladeshi number in one form, for searching and duplicate checks:
 * '+880 1711-000000', '8801711000000' and '01711000000' all become '01711000000'.
 * Anything else keeps its digits as they are.
 */
export function normalizePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('880') && d.length >= 12) d = `0${d.slice(3)}`;
  return d;
}

const text = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : null);
const dayOfWeek = (iso) => DAY_NAMES[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function actorName(request) {
  const p = principalOf(request);
  if (!p) return 'Staff';
  if (p.kind === 'account') return String(p.username || p.id).slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  return 'API token';
}

/** The workshop's opening hours and working days from settings, or null for any part not set. */
async function workshopHours(env) {
  try {
    const row = await env.DB.prepare('SELECT opening_time, closing_time, working_days FROM settings WHERE id = 1').first();
    if (!row) return {};
    let days = null;
    try { const parsed = JSON.parse(row.working_days || 'null'); if (Array.isArray(parsed) && parsed.length) days = parsed.filter((d) => DAY_NAMES.includes(d)); } catch { /* not set */ }
    return {
      open: TIME.test(row.opening_time || '') ? row.opening_time : null,
      close: TIME.test(row.closing_time || '') ? row.closing_time : null,
      days: days && days.length ? days : null,
    };
  } catch {
    return {};
  }
}

/** Date + time checks shared by submit, staff create and reschedule. Returns an errors object. */
async function checkSlot(env, date, time, { dateKey = 'preferredDate', timeKey = 'preferredTime' } = {}) {
  const e = {};
  const today = todayInDhaka();
  if (date < today) e[dateKey] = 'The date cannot be in the past.';
  else if (date > addDays(today, MAX_DAYS_AHEAD)) e[dateKey] = `Please choose a date within the next ${MAX_DAYS_AHEAD} days.`;
  const hours = await workshopHours(env);
  if (!e[dateKey] && hours.days && !hours.days.includes(dayOfWeek(date))) {
    e[dateKey] = `The workshop is closed on ${dayOfWeek(date)}. Open: ${hours.days.join(', ')}.`;
  }
  if (hours.open && hours.close && (time < hours.open || time > hours.close)) {
    e[timeKey] = `Please choose a time between ${hours.open} and ${hours.close}.`;
  }
  return e;
}

/** Validate the booking fields. `mode` is 'public' or 'staff'. */
async function readBooking(env, body, mode) {
  const keys = mode === 'public' ? PUBLIC_KEYS : STAFF_CREATE_KEYS;
  const e = {};
  for (const k of Object.keys(body)) if (!keys.includes(k)) e[k] = 'This is not a booking field.';
  const v = {};
  const field = (k, max, { required = false, min = 0, label }) => {
    const t = text(body[k]);
    if (t === null) { e[k] = 'Must be text.'; return; }
    const clean = t.replace(/\s+/g, ' ');
    if (!clean && required) { e[k] = `Please enter ${label}.`; return; }
    if (clean && clean.length < min) { e[k] = `Please enter ${label}.`; return; }
    if (clean.length > max) { e[k] = `Keep this to ${max} characters or fewer.`; return; }
    v[k] = clean;
  };
  field('name', LIMITS.name, { required: true, min: 2, label: 'your name' });
  field('phone', LIMITS.phone, { required: true, label: 'your phone number' });
  field('email', LIMITS.email, { label: 'an email' });
  field('vehicleMake', LIMITS.make, { required: true, min: 2, label: 'the vehicle make' });
  field('vehicleModel', LIMITS.model, { required: true, min: 1, label: 'the vehicle model' });
  field('registrationNumber', LIMITS.reg, { label: 'a registration number' });
  const msg = text(body.message);
  if (msg === null) e.message = 'Must be text.';
  else if (msg.length > LIMITS.message) e.message = `Keep this to ${LIMITS.message} characters or fewer.`;
  else v.message = msg.replace(/[^\S\n]+/g, ' ');

  if (!e.phone && v.phone) {
    const digits = normalizePhone(v.phone);
    if (!PHONE_CHARS.test(v.phone) || !/^01\d{9}$/.test(digits)) e.phone = 'Please enter a valid Bangladeshi mobile number, e.g. 01711-000000.';
    else v.phoneDigits = digits;
  }
  if (!e.email && v.email && !EMAIL.test(v.email)) e.email = 'Please enter a valid email address.';
  if (v.registrationNumber) v.registrationNumber = v.registrationNumber.toUpperCase();

  if (typeof body.serviceType !== 'string' || !SERVICE_TYPES[body.serviceType]) e.serviceType = 'Please choose a service.';
  else { v.serviceType = body.serviceType; v.serviceLabel = SERVICE_TYPES[body.serviceType]; }

  const date = readDate(body, 'preferredDate', { required: true });
  if (date.error) e.preferredDate = 'Please choose a valid date.';
  else v.preferredDate = date.value;
  const time = text(body.preferredTime);
  if (!time || !TIME.test(time)) e.preferredTime = 'Please choose a valid time.';
  else v.preferredTime = time;
  if (!e.preferredDate && !e.preferredTime) Object.assign(e, await checkSlot(env, v.preferredDate, v.preferredTime));

  if (mode === 'public') {
    if (body.consent !== true) e.consent = 'Please agree that we may contact you about this booking.';
    v.consent = true;
    v.source = 'Website';
    if (body.idempotencyKey !== undefined && body.idempotencyKey !== null && body.idempotencyKey !== '') {
      if (typeof body.idempotencyKey !== 'string' || !IDEMPOTENCY.test(body.idempotencyKey)) e.idempotencyKey = 'Not a valid submission key.';
      else v.idempotencyKey = body.idempotencyKey;
    }
  } else {
    if (body.consent !== undefined && typeof body.consent !== 'boolean') e.consent = 'Must be true or false.';
    v.consent = body.consent === true;
    const staffSources = BOOKING_SOURCES.filter((s) => s !== 'Website');
    v.source = body.source === undefined || body.source === '' ? 'Manual' : body.source;
    if (!staffSources.includes(v.source)) e.source = `Choose one of: ${staffSources.join(', ')}.`;
    const ref = text(body.sourceReference);
    if (ref === null || (ref && ref.length > LIMITS.sourceReference)) e.sourceReference = `Keep this to ${LIMITS.sourceReference} characters or fewer.`;
    else v.sourceReference = ref;
  }
  return { values: v, errors: e };
}

/** The INSERT for a new booking and its first history row (one batch). */
function insertStatements(env, id, v, { ipHashValue = null, actor, now }) {
  const nul = (x) => (x ? x : null);
  return [
    env.DB.prepare(
      `INSERT INTO bookings (id, source, source_reference, idempotency_key, customer_name, phone, phone_digits, email,
         vehicle_make, vehicle_model, registration_number, service_type, service_label, preferred_date, preferred_time,
         customer_message, consent, consent_at, status, ip_hash, created_at, updated_at, updated_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'New', ?19, ?20, ?20, ?21)`
    ).bind(id, v.source, nul(v.sourceReference), nul(v.idempotencyKey), v.name, v.phone, v.phoneDigits, nul(v.email),
      v.vehicleMake, v.vehicleModel, nul(v.registrationNumber), v.serviceType, v.serviceLabel, v.preferredDate, v.preferredTime,
      nul(v.message), v.consent ? 1 : 0, v.consent ? now : null, ipHashValue, now, actor === 'Website' ? null : actor),
    env.DB.prepare(
      `INSERT INTO booking_history (booking_id, action, to_status, detail, actor, created_at)
       VALUES (?1, 'submitted', 'New', ?2, ?3, ?4)`
    ).bind(id, `Source: ${v.source}`, actor, now),
  ];
}

const logLine = (outcome, status) => console.log(JSON.stringify({ event: 'booking_submit', outcome, status }));

/* ---------- POST /api/bookings/submit (public) ---------- */

async function submit(request, env) {
  const cors = corsHeaders(request, env);
  if (cors === null) return fail('forbidden_origin', 'Bookings are accepted from the Taqwa Autos website only.', 403);
  const answer = (response) => withHeaders(response, cors);
  if (!env.DB) return answer(noDatabase());

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_PUBLIC_BYTES) return answer(fail('payload_too_large', 'The form is too large.', 413));
  const parsed = await readJsonBody(request);
  if (parsed.error || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return answer(fail('invalid_body', 'The form could not be read.', 400));
  }
  const body = parsed.value;
  const received = (reference, extra = {}, status = 201) => answer(ok({ reference, ...extra },
    { message: extra.duplicate ? 'We already have your booking request.' : 'Thank you. Your booking request has been received.' }, status));

  // A bot: told "received", nothing stored, no reference that exists.
  const started = Number(body.startedAt);
  if ((typeof body.company === 'string' && body.company.trim() !== '')
      || (Number.isFinite(started) && started > 0 && Date.now() - started < MIN_FILL_MS)) {
    logLine('spam_suspected', 201);
    return received('BKG-0000');
  }

  const { values: v, errors } = await readBooking(env, body, 'public');
  if (Object.keys(errors).length) return answer(unprocessable('Please check the highlighted fields.', errors));

  try {
    // The same submission again (a retry after a network failure): its own reference.
    if (v.idempotencyKey) {
      const again = await env.DB.prepare('SELECT id FROM bookings WHERE idempotency_key = ?1').bind(v.idempotencyKey).first();
      if (again) { logLine('idempotent_repeat', 200); return received(again.id, { duplicate: true }, 200); }
    }
    const hash = await ipHash(request, env);
    if (hash) {
      const counts = await env.DB.prepare(
        `SELECT coalesce(sum(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END), 0) AS short, count(*) AS day
           FROM bookings WHERE ip_hash = ?1 AND created_at >= ?3`
      ).bind(hash, new Date(Date.now() - 10 * 60 * 1000).toISOString(), new Date(Date.now() - 24 * 3600 * 1000).toISOString()).first();
      if (counts && (counts.short >= RATE_SHORT || counts.day >= RATE_DAY)) {
        logLine('rate_limited', 429);
        return answer(fail('rate_limited', 'Too many booking requests from this connection. Please call us or try again later.', 429));
      }
    }
    const open = OPEN_STATUSES.map((s) => `'${s}'`).join(', ');
    const recent = await env.DB.prepare(
      `SELECT id FROM bookings
        WHERE phone_digits = ?1 AND preferred_date = ?2 AND service_type = ?3 AND status IN (${open}) AND created_at >= ?4
        ORDER BY created_at DESC LIMIT 1`
    ).bind(v.phoneDigits, v.preferredDate, v.serviceType, new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()).first();
    if (recent) { logLine('duplicate', 200); return received(recent.id, { duplicate: true }, 200); }

    const allocated = await allocateId(env, 'bookings');
    if (allocated.error) throw new Error(allocated.error);
    try {
      await env.DB.batch(insertStatements(env, allocated.id, v, { ipHashValue: hash, actor: 'Website', now: nowIso() }));
    } catch (err) {
      // Two copies of the same retry raced: the other one was stored first.
      if (v.idempotencyKey && /UNIQUE/i.test(String(err && err.message))) {
        const first = await env.DB.prepare('SELECT id FROM bookings WHERE idempotency_key = ?1').bind(v.idempotencyKey).first();
        if (first) { logLine('idempotent_repeat', 200); return received(first.id, { duplicate: true }, 200); }
      }
      throw err;
    }
    logLine('stored', 201);
    return received(allocated.id);
  } catch (err) {
    console.error('POST /api/bookings/submit failed:', err && err.message);
    return answer(fail('database_error', 'Your booking could not be saved. Please try again or call us.', 500));
  }
}

/** The router hands every /api/bookings/submit request here. Public: see the header. */
export async function publicBookingSubmit(request, env) {
  if (request.method === 'OPTIONS') {
    const cors = corsHeaders(request, env);
    if (!cors || !Object.keys(cors).length) return new Response(null, { status: 403, headers: SECURITY_HEADERS });
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
  }
  if (request.method === 'POST') return submit(request, env);
  return methodNotAllowed(['POST', 'OPTIONS']);
}

/* ---------- staff: list ---------- */

export async function listBookings(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'POST']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !BOOKING_STATUSES.includes(status)) return fail('invalid_parameter', `\`status\` must be one of: ${BOOKING_STATUSES.join(', ')}.`, 400);
  const source = url.searchParams.get('source') || null;
  if (source !== null && !BOOKING_SOURCES.includes(source)) return fail('invalid_parameter', `\`source\` must be one of: ${BOOKING_SOURCES.join(', ')}.`, 400);
  const assigned = url.searchParams.get('assigned') || null;
  if (assigned !== null && assigned !== 'none' && !STAFF_ID.test(assigned)) return fail('invalid_parameter', '`assigned` must be a staff id or "none".', 400);
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
  // A phone typed in any form, even partly: '+880 1822' searches for '01822'.
  let digits = q.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length > 3) digits = `0${digits.slice(3)}`;
  const digitNeedle = digits.length >= 3 ? `%${digits}%` : null;

  const where = `
    WHERE (?1 IS NULL OR status = ?1)
      AND (?2 IS NULL OR source = ?2)
      AND (?3 IS NULL OR preferred_date >= ?3)
      AND (?4 IS NULL OR preferred_date <= ?4)
      AND (?5 IS NULL OR (?5 = 'none' AND assigned_staff_id IS NULL) OR assigned_staff_id = ?5)
      AND (?6 IS NULL OR lower(customer_name) LIKE ?6 ESCAPE '\\' OR lower(id) LIKE ?6 ESCAPE '\\'
           OR lower(coalesce(registration_number, '')) LIKE ?6 ESCAPE '\\' OR lower(coalesce(email, '')) LIKE ?6 ESCAPE '\\'
           OR lower(vehicle_make || ' ' || vehicle_model) LIKE ?6 ESCAPE '\\'
           OR lower(coalesce(customer_message, '')) LIKE ?6 ESCAPE '\\'
           OR (?7 IS NOT NULL AND phone_digits LIKE ?7))`;
  const binds = [status, source, range.from, range.to, assigned, needle, digitNeedle];
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM bookings ${where} ORDER BY created_at DESC, id DESC LIMIT ?8 OFFSET ?9`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM bookings ${where}`).bind(...binds).first();
    const { results: byStatus } = await env.DB.prepare('SELECT status, count(*) AS n FROM bookings GROUP BY status').all();
    const summary = { total: 0 };
    for (const s of BOOKING_STATUSES) summary[s.toLowerCase()] = 0;
    for (const r of byStatus || []) { summary[String(r.status).toLowerCase()] = r.n; summary.total += r.n; }
    const rows = (results || []).map(toRecord);
    return ok(rows, { count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value, summary });
  } catch (err) {
    console.error('GET /api/bookings failed:', err && err.message);
    return fail('database_error', 'Could not read bookings.', 500);
  }
}

/* ---------- staff: one booking, with history, notes and matches ---------- */

const findRow = (env, id) => env.DB.prepare(`SELECT ${COLUMNS} FROM bookings WHERE id = ?1`).bind(id).first();

/** Customers and vehicles that may be this booking's, for staff to link -- only for callers who may see them. */
async function matchesFor(request, env, row) {
  const who = principalOf(request);
  const out = { customers: [], vehicles: [] };
  if (can(who, 'customers.view')) {
    const local = row.phone_digits;                                  // 01XXXXXXXXX
    const intl = local.startsWith('0') ? `88${local}` : local;       // 8801XXXXXXXXX
    const { results } = await env.DB.prepare(
      `SELECT id, name, phone FROM customers
        WHERE phone_digits IN (?1, ?2, ?3) OR replace(phone_digits, '+', '') IN (?1, ?2)
        ORDER BY id LIMIT 5`
    ).bind(local, intl, `+${intl}`).all();
    out.customers = (results || []).map((c) => ({ id: c.id, name: c.name, phone: c.phone }));
  }
  if (can(who, 'vehicles.view') && row.registration_number) {
    const key = row.registration_number.toUpperCase().replace(/[\s-]/g, '');
    const { results } = await env.DB.prepare(
      `SELECT id, customer_id, reg_no, brand, model FROM vehicles
        WHERE upper(replace(replace(reg_no, ' ', ''), '-', '')) = ?1 ORDER BY id LIMIT 5`
    ).bind(key).all();
    out.vehicles = (results || []).map((x) => ({ id: x.id, customerId: x.customer_id, regNo: x.reg_no, brand: x.brand, model: x.model }));
  }
  if (can(who, 'vehicles.view') && row.customer_id) {
    const { results } = await env.DB.prepare(
      'SELECT id, customer_id, reg_no, brand, model FROM vehicles WHERE customer_id = ?1 ORDER BY id LIMIT 20'
    ).bind(row.customer_id).all();
    for (const x of results || []) {
      if (!out.vehicles.some((m) => m.id === x.id)) out.vehicles.push({ id: x.id, customerId: x.customer_id, regNo: x.reg_no, brand: x.brand, model: x.model });
    }
  }
  return out;
}

async function withDetail(request, env, row) {
  const { results: history } = await env.DB.prepare(
    'SELECT id, action, from_status, to_status, detail, reason, actor, created_at FROM booking_history WHERE booking_id = ?1 ORDER BY id'
  ).bind(row.id).all();
  const { results: notes } = await env.DB.prepare(
    'SELECT id, note, created_by, created_at FROM booking_notes WHERE booking_id = ?1 ORDER BY id DESC'
  ).bind(row.id).all();
  return {
    ...toRecord(row),
    allowedStatuses: TRANSITIONS[row.status] || [],
    history: (history || []).map(toEvent),
    notes: (notes || []).map(toNote),
    matches: await matchesFor(request, env, row),
  };
}

export async function getBooking(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  if (!BOOKING_ID.test(rawId || '')) return fail('invalid_id', 'Booking id must look like BKG-0001.', 400);
  try {
    const row = await findRow(env, rawId);
    if (!row) return fail('not_found', 'No booking with that id.', 404);
    return ok(await withDetail(request, env, row));
  } catch (err) {
    console.error('GET /api/bookings/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the booking.', 500);
  }
}

/* ---------- staff: create ---------- */

export async function createBooking(request, env) {
  if (!env.DB) return noDatabase();
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const { values: v, errors } = await readBooking(env, parsed.value, 'staff');
  if (Object.keys(errors).length) return unprocessable('The booking could not be created.', errors);
  try {
    const allocated = await allocateId(env, 'bookings');
    if (allocated.error) throw new Error(allocated.error);
    await env.DB.batch(insertStatements(env, allocated.id, v, { actor: actorName(request), now: nowIso() }));
    return ok(await withDetail(request, env, await findRow(env, allocated.id)), {}, 201);
  } catch (err) {
    console.error('POST /api/bookings failed:', err && err.message);
    return fail('database_error', 'Could not create the booking.', 500);
  }
}

/* ---------- staff: guarded change + history in one batch ---------- */

/** `sets` = column -> value. Writes the change and its history rows only if the row is unchanged since expectedUpdatedAt. */
async function applyChange(request, env, row, expectedUpdatedAt, sets, events) {
  const who = actorName(request);
  let now = nowIso();
  if (now <= row.updated_at) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
  const names = Object.keys(sets);
  const statements = [
    env.DB.prepare(
      `UPDATE bookings SET ${names.map((n, i) => `${n} = ?${i + 4}`).join(', ')}${names.length ? ', ' : ''}updated_at = ?2, updated_by = ?3
        WHERE id = ?1 AND updated_at = ?${names.length + 4}`
    ).bind(row.id, now, who, ...names.map((n) => sets[n]), expectedUpdatedAt),
  ];
  // History rows are written only if the guarded update itself applied (same batch, same transaction).
  const guard = 'EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND updated_at = ?2 AND updated_by = ?3)';
  for (const ev of events) {
    statements.push(env.DB.prepare(
      `INSERT INTO booking_history (booking_id, action, from_status, to_status, detail, reason, actor, created_at)
       SELECT ?1, ?4, ?5, ?6, ?7, ?8, ?3, ?2 WHERE ${guard}`
    ).bind(row.id, now, who, ev.action, ev.from || null, ev.to || null, ev.detail || null, ev.reason || null));
  }
  const results = await env.DB.batch(statements);
  if (!results[0].meta || results[0].meta.changes !== 1) return null;
  return findRow(env, row.id);
}

const staleConflict = () => conflict('This booking was changed by someone else after you opened it. Reload it and try again.', { reason: 'concurrent_modification' });

function readExpected(body, errors) {
  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt || body.expectedUpdatedAt.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the change was made from.';
  }
}

/** An ACTIVE employee (not a mechanic's own staff profile) or mechanic, or null. */
async function activeStaff(env, id) {
  return env.DB.prepare(
    `SELECT id, name FROM staff WHERE id = ?1 AND mechanic_id IS NULL AND status = 'Active'
     UNION ALL
     SELECT id, name FROM mechanics WHERE id = ?1 AND status = 'Active'
     LIMIT 1`
  ).bind(id).first();
}

/* ---------- staff: PUT — assignment and links ---------- */

export async function updateBooking(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  if (!BOOKING_ID.test(rawId || '')) return fail('invalid_id', 'Booking id must look like BKG-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) {
    if (!['assignedStaffId', 'customerId', 'vehicleId', 'expectedUpdatedAt'].includes(k)) {
      errors[k] = 'This field cannot be changed here. The submitted details are kept as they were sent.';
    }
  }
  readExpected(body, errors);
  const readRef = (k, pattern) => {
    if (body[k] === undefined) return undefined;
    if (body[k] === null || body[k] === '') return null;
    if (typeof body[k] !== 'string' || !pattern.test(body[k])) { errors[k] = 'Not a valid id.'; return undefined; }
    return body[k];
  };
  const staffId = readRef('assignedStaffId', STAFF_ID);
  const customerId = readRef('customerId', RECORD_ID);
  const vehicleId = readRef('vehicleId', RECORD_ID);
  if (!Object.keys(errors).length && staffId === undefined && customerId === undefined && vehicleId === undefined) errors.assignedStaffId = 'Nothing to change.';
  if (Object.keys(errors).length) return unprocessable('The booking could not be updated.', errors);

  try {
    const row = await findRow(env, rawId);
    if (!row) return fail('not_found', 'No booking with that id.', 404);
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();
    const sets = {};
    const events = [];
    const who = actorName(request);

    if (staffId !== undefined && staffId !== (row.assigned_staff_id || null)) {
      if (staffId === null) {
        Object.assign(sets, { assigned_staff_id: null, assigned_staff_name: null, assigned_at: null, assigned_by: null });
        events.push({ action: 'assigned', detail: 'Unassigned' });
      } else {
        const person = await activeStaff(env, staffId);
        if (!person) return unprocessable('The booking could not be updated.', { assignedStaffId: 'That is not an active member of staff.' });
        const name = String(person.name || person.id).slice(0, 120);
        Object.assign(sets, { assigned_staff_id: person.id, assigned_staff_name: name, assigned_at: nowIso(), assigned_by: who });
        events.push({ action: 'assigned', detail: `Assigned to ${name} (${person.id})` });
      }
    }
    const finalCustomer = customerId !== undefined ? customerId : (row.customer_id || null);
    if (customerId !== undefined && customerId !== (row.customer_id || null)) {
      if (customerId !== null) {
        const c = await env.DB.prepare('SELECT id FROM customers WHERE id = ?1').bind(customerId).first();
        if (!c) return unprocessable('The booking could not be updated.', { customerId: 'No customer with that id.' });
      }
      sets.customer_id = customerId;
      events.push({ action: 'linked', detail: customerId ? `Customer ${customerId} linked` : 'Customer unlinked' });
      // A vehicle linked for a different customer no longer fits.
      if (row.vehicle_id && vehicleId === undefined) {
        const veh = await env.DB.prepare('SELECT customer_id FROM vehicles WHERE id = ?1').bind(row.vehicle_id).first();
        if (!customerId || !veh || veh.customer_id !== customerId) {
          sets.vehicle_id = null;
          events.push({ action: 'linked', detail: `Vehicle ${row.vehicle_id} unlinked` });
        }
      }
    }
    if (vehicleId !== undefined && vehicleId !== (row.vehicle_id || null)) {
      if (vehicleId !== null) {
        if (!finalCustomer) return unprocessable('The booking could not be updated.', { vehicleId: 'Link the customer first.' });
        const veh = await env.DB.prepare('SELECT customer_id FROM vehicles WHERE id = ?1').bind(vehicleId).first();
        if (!veh) return unprocessable('The booking could not be updated.', { vehicleId: 'No vehicle with that id.' });
        if (veh.customer_id !== finalCustomer) return unprocessable('The booking could not be updated.', { vehicleId: 'That vehicle belongs to a different customer.' });
      }
      sets.vehicle_id = vehicleId;
      events.push({ action: 'linked', detail: vehicleId ? `Vehicle ${vehicleId} linked` : 'Vehicle unlinked' });
    }
    if (!events.length) return ok(await withDetail(request, env, row));
    const updated = await applyChange(request, env, row, body.expectedUpdatedAt, sets, events);
    if (!updated) return staleConflict();
    return ok(await withDetail(request, env, updated));
  } catch (err) {
    console.error('PUT /api/bookings/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the booking.', 500);
  }
}

/* ---------- staff: POST /:id/status ---------- */

export async function setBookingStatus(request, env, rawId) {
  if (!env.DB) return noDatabase();
  if (!BOOKING_ID.test(rawId || '')) return fail('invalid_id', 'Booking id must look like BKG-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (!['to', 'reason', 'date', 'time', 'expectedUpdatedAt'].includes(k)) errors[k] = 'This is not a status field.';
  readExpected(body, errors);
  if (!BOOKING_STATUSES.includes(body.to)) errors.to = `Choose one of: ${BOOKING_STATUSES.join(', ')}.`;
  const reason = text(body.reason);
  if (reason === null || (reason && reason.length > LIMITS.reason)) errors.reason = `Keep this to ${LIMITS.reason} characters or fewer.`;
  else if (NEEDS_REASON.includes(body.to) && !reason) errors.reason = `Please give a reason for marking it ${body.to}.`;
  let date; let time;
  if (body.date !== undefined || body.time !== undefined || body.to === 'Rescheduled') {
    const d = readDate(body, 'date', { required: true });
    if (d.error) errors.date = 'Please choose the new date.'; else date = d.value;
    const t = text(body.time);
    if (!t || !TIME.test(t)) errors.time = 'Please choose the new time.'; else time = t;
    if (date && time) Object.assign(errors, await checkSlot(env, date, time, { dateKey: 'date', timeKey: 'time' }));
    if (body.to !== 'Rescheduled' && body.to !== 'Confirmed' && !errors.to) errors.date = 'A new date and time can only be set when rescheduling or confirming.';
  }
  if (Object.keys(errors).length) return unprocessable('The status could not be changed.', errors);

  try {
    const row = await findRow(env, rawId);
    if (!row) return fail('not_found', 'No booking with that id.', 404);
    if (row.updated_at !== body.expectedUpdatedAt) return staleConflict();
    const allowed = TRANSITIONS[row.status] || [];
    if (!allowed.includes(body.to)) {
      return conflict(`A ${row.status} booking cannot be marked ${body.to}.`, { reason: 'illegal_status_transition', from: row.status, to: body.to });
    }
    const now = nowIso();
    const sets = { status: body.to };
    if (body.to === 'Confirmed') sets.confirmed_at = now;
    if (body.to === 'Cancelled') sets.cancelled_at = now;
    const events = [{ action: 'status', from: row.status, to: body.to, reason: reason || null }];
    if (date && time && (date !== row.preferred_date || time !== row.preferred_time)) {
      Object.assign(sets, { preferred_date: date, preferred_time: time });
      events.push({ action: 'rescheduled', detail: `${row.preferred_date} ${row.preferred_time} → ${date} ${time}` });
    }
    const updated = await applyChange(request, env, row, body.expectedUpdatedAt, sets, events);
    if (!updated) return staleConflict();
    return ok(await withDetail(request, env, updated));
  } catch (err) {
    console.error('POST /api/bookings/:id/status failed:', err && err.message);
    return fail('database_error', 'Could not change the status.', 500);
  }
}

/* ---------- staff: POST /:id/notes ---------- */

/**
 * A note does not change the booking itself, so it needs no expectedUpdatedAt
 * and does not move updated_at: adding one never makes someone else's open
 * status change or assignment fail.
 */
export async function addBookingNote(request, env, rawId) {
  if (!env.DB) return noDatabase();
  if (!BOOKING_ID.test(rawId || '')) return fail('invalid_id', 'Booking id must look like BKG-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (k !== 'note') errors[k] = 'This is not a note field.';
  const note = text(body.note);
  if (note === null) errors.note = 'Must be text.';
  else if (!note) errors.note = 'Please write the note.';
  else if (note.length > LIMITS.note) errors.note = `Keep this to ${LIMITS.note} characters or fewer.`;
  if (Object.keys(errors).length) return unprocessable('The note could not be added.', errors);
  try {
    const row = await findRow(env, rawId);
    if (!row) return fail('not_found', 'No booking with that id.', 404);
    const who = actorName(request);
    const now = nowIso();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO booking_notes (booking_id, note, created_by, created_at) VALUES (?1, ?2, ?3, ?4)').bind(row.id, note, who, now),
      env.DB.prepare(`INSERT INTO booking_history (booking_id, action, actor, created_at) VALUES (?1, 'note', ?2, ?3)`).bind(row.id, who, now),
    ]);
    return ok(await withDetail(request, env, row), {}, 201);
  } catch (err) {
    console.error('POST /api/bookings/:id/notes failed:', err && err.message);
    return fail('database_error', 'Could not add the note.', 500);
  }
}
