/* ============================================================
   routes/website-forms.js — website enquiries   (migration 0016)
   ------------------------------------------------------------
   PUBLIC (no session -- the website's visitors have none):

     POST    /api/forms/submit        a booking / quote / contact form
     OPTIONS /api/forms/submit        the browser's CORS preflight

   Only the website's own origins may call it from a browser
   (https://taqwa.autos, https://www.taqwa.autos, plus any listed in
   FORMS_ALLOWED_ORIGINS). Every field is validated here; nothing the
   browser checked is trusted. Spam and repeats are held back by:
     * a honeypot field (`company`) a person never sees or fills;
     * a minimum time on the form (`startedAt`), when the page sends it;
     * at most RATE_SHORT submissions per address per 10 minutes and
       RATE_DAY per day (by a salted hash of the IP; the IP is not kept);
     * the same phone + form + service within 10 minutes is the same
       enquiry: the first one's reference is returned, nothing is added.
   A suspected bot is told "received" and nothing is stored, so it
   learns nothing. The answer carries only a reference number -- never
   any stored data.

   STAFF (behind the auth gate):

     GET  /api/website-forms          list: q, status, type, from, to,
                                      assigned (staff id | "none"),
                                      limit, offset; summary counts
     GET  /api/website-forms/:id      one enquiry, with its history
     PUT  /api/website-forms/:id      { status?, notes?, assignedToId?,
                                        expectedUpdatedAt }

   Assignment (migration 0022): an enquiry is assigned to an ACTIVE
   employee or mechanic from the roster (checked here, not trusted from
   the browser), stored with their name as it was when assigned and who
   assigned it, when. `assignedToId: null` (or "") un-assigns.

   No delete: an unwanted enquiry is Rejected and kept. Each status
   change and note edit is recorded in website_form_events with who and
   when. An edit made from an old copy is refused (409).
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, unprocessable, conflict, SECURITY_HEADERS } from '../lib/http.js';
import { readJsonBody, readDate, nowIso, todayInDhaka, allocateId } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';

export const FORM_STATUSES = ['New', 'Contacted', 'Confirmed', 'Rejected'];
export const FORM_TYPES = ['booking', 'quote', 'contact'];
const DEFAULT_ORIGINS = ['https://taqwa.autos', 'https://www.taqwa.autos'];
const MAX_PUBLIC_BYTES = 16 * 1024;
const RATE_SHORT = 5;            // per address per 10 minutes
const RATE_DAY = 20;             // per address per day
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const MIN_FILL_MS = 3000;        // a person takes longer than this to fill the form
const LIMITS = { name: 120, phone: 20, email: 160, service: 80, vehicle: 120, regNo: 40, message: 2000, sourcePage: 200, notes: 2000, q: 100 };
const PHONE = /^[0-9+\-\s()]{6,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const FORM_ID = /^WEB-\d{1,10}$/;
const STAFF_ID = /^[A-Z]{2,5}-\d{1,10}$/;
const PUBLIC_KEYS = ['formType', 'name', 'phone', 'email', 'service', 'vehicle', 'regNo', 'preferredDate', 'preferredTime',
  'message', 'sourcePage', 'company', 'startedAt'];

const COLUMNS = `id, form_type, name, phone, phone_digits, email, service, vehicle, reg_no, preferred_date, preferred_time,
  message, source_page, status, notes, assigned_to_id, assigned_to_name, assigned_at, assigned_by,
  created_at, updated_at, updated_by`;

function toRecord(row) {
  return {
    id: row.id,
    formType: row.form_type,
    name: row.name,
    phone: row.phone,
    email: row.email || '',
    service: row.service || '',
    vehicle: row.vehicle || '',
    regNo: row.reg_no || '',
    preferredDate: row.preferred_date || '',
    preferredTime: row.preferred_time || '',
    message: row.message || '',
    sourcePage: row.source_page || '',
    status: row.status,
    notes: row.notes || '',
    source: 'website',
    assignedToId: row.assigned_to_id || '',
    assignedToName: row.assigned_to_name || '',
    assignedAt: row.assigned_at || '',
    assignedBy: row.assigned_by || '',
    createdAt: row.created_at,
    submittedAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    updatedBy: row.updated_by || '',
  };
}

const toEvent = (row) => ({ id: row.id, action: row.action, fromStatus: row.from_status || '', toStatus: row.to_status || '', actor: row.actor, at: row.created_at });

/* ---------- CORS for the public endpoint ---------- */

function allowedOrigins(env) {
  const extra = typeof env?.FORMS_ALLOWED_ORIGINS === 'string'
    ? env.FORMS_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter((s) => /^https?:\/\/[^/\s]+$/.test(s))
    : [];
  return [...DEFAULT_ORIGINS, ...extra];
}

/** The CORS headers for this request's Origin, or null when it is not one of ours. */
export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return {};                     // not a browser cross-origin call
  if (!allowedOrigins(env).includes(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

export const withHeaders = (response, extra) => {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(extra || {})) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
};

/* ---------- validation ---------- */

const text = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : null);

function readSubmission(body) {
  const e = {};
  for (const k of Object.keys(body)) if (!PUBLIC_KEYS.includes(k)) e[k] = 'This is not a form field.';
  const v = {};
  for (const k of ['name', 'phone', 'email', 'service', 'vehicle', 'regNo', 'message', 'sourcePage']) {
    const t = text(body[k]);
    if (t === null) { e[k] = 'Must be text.'; continue; }
    if (t.length > LIMITS[k]) { e[k] = `Keep this to ${LIMITS[k]} characters or fewer.`; continue; }
    v[k] = t.replace(k === 'message' ? /[^\S\n]+/g : /\s+/g, ' ');
  }
  v.formType = body.formType === undefined || body.formType === '' ? 'booking' : body.formType;
  if (!FORM_TYPES.includes(v.formType)) e.formType = `Must be one of: ${FORM_TYPES.join(', ')}.`;
  if (!e.name && !v.name) e.name = 'Please enter your name.';
  if (!e.phone) {
    if (!v.phone) e.phone = 'Please enter your phone number.';
    else if (!PHONE.test(v.phone) || v.phone.replace(/\D/g, '').length < 6 || v.phone.replace(/\D/g, '').length > 15) e.phone = 'Please enter a valid phone number.';
  }
  if (!e.email && v.email && !EMAIL.test(v.email)) e.email = 'Please enter a valid email address.';
  const date = readDate(body, 'preferredDate', { fallback: '' });
  if (date.error) e.preferredDate = 'Please choose a valid date.';
  else if (date.value && date.value < todayInDhaka()) e.preferredDate = 'The preferred date cannot be in the past.';
  else v.preferredDate = date.value;
  const time = text(body.preferredTime);
  if (time === null || (time && !TIME.test(time))) e.preferredTime = 'Please choose a valid time.';
  else v.preferredTime = time;
  if (v.formType === 'contact' && !e.message && !v.message) e.message = 'Please write your message.';
  return { values: v, errors: e };
}

export async function ipHash(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!ip) return null;
  const salt = typeof env?.AUTH_SECRET === 'string' && env.AUTH_SECRET ? env.AUTH_SECRET : 'taqwa-forms';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`forms:${salt}:${ip}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- POST /api/forms/submit (public) ---------- */

async function submit(request, env) {
  const cors = corsHeaders(request, env);
  if (cors === null) return fail('forbidden_origin', 'Submissions are accepted from the Taqwa Autos website only.', 403);
  const answer = (response) => withHeaders(response, cors);
  if (!env.DB) return answer(noDatabase());

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_PUBLIC_BYTES) return answer(fail('payload_too_large', 'The form is too large.', 413));
  const parsed = await readJsonBody(request);
  if (parsed.error) return answer(fail('invalid_body', 'The form could not be read.', 400));
  const body = parsed.value;
  const received = (reference) => answer(ok({ reference }, { message: 'Thank you. Your request has been received.' }, 201));

  // A bot: told "received", nothing stored, no reference that exists.
  const started = Number(body.startedAt);
  if ((typeof body.company === 'string' && body.company.trim() !== '')
      || (Number.isFinite(started) && started > 0 && Date.now() - started < MIN_FILL_MS)) {
    console.log(JSON.stringify({ event: 'website_form', outcome: 'spam_suspected', status: 201 }));
    return received('WEB-0000');
  }

  const { values: v, errors } = readSubmission(body);
  if (Object.keys(errors).length) return answer(unprocessable('Please check the highlighted fields.', errors));

  try {
    const hash = await ipHash(request, env);
    if (hash) {
      const tenMin = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const counts = await env.DB.prepare(
        `SELECT coalesce(sum(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END), 0) AS short, count(*) AS day
           FROM website_form_submissions WHERE ip_hash = ?1 AND created_at >= ?3`
      ).bind(hash, tenMin, day).first();
      if (counts && (counts.short >= RATE_SHORT || counts.day >= RATE_DAY)) {
        console.log(JSON.stringify({ event: 'website_form', outcome: 'rate_limited', status: 429 }));
        return answer(fail('rate_limited', 'Too many requests from this connection. Please call us or try again later.', 429));
      }
    }
    const digits = v.phone.replace(/\D/g, '');
    const recent = await env.DB.prepare(
      `SELECT id FROM website_form_submissions
        WHERE phone_digits = ?1 AND form_type = ?2 AND coalesce(service, '') = ?3 AND created_at >= ?4
        ORDER BY created_at DESC LIMIT 1`
    ).bind(digits, v.formType, v.service || '', new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()).first();
    if (recent) {
      console.log(JSON.stringify({ event: 'website_form', outcome: 'duplicate', status: 200 }));
      return answer(ok({ reference: recent.id, duplicate: true }, { message: 'We already have your request.' }, 200));
    }

    const allocated = await allocateId(env, 'websiteForms');
    if (allocated.error) throw new Error(allocated.error);
    const now = nowIso();
    const nul = (x) => (x ? x : null);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO website_form_submissions (id, form_type, name, phone, phone_digits, email, service, vehicle, reg_no,
           preferred_date, preferred_time, message, source_page, status, ip_hash, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'New', ?14, ?15, ?15)`
      ).bind(allocated.id, v.formType, v.name, v.phone, digits, nul(v.email), nul(v.service), nul(v.vehicle), nul(v.regNo ? v.regNo.toUpperCase() : ''),
        nul(v.preferredDate), nul(v.preferredTime), nul(v.message), nul(v.sourcePage), hash, now),
      env.DB.prepare(
        `INSERT INTO website_form_events (submission_id, action, to_status, actor, created_at) VALUES (?1, 'submitted', 'New', 'Website', ?2)`
      ).bind(allocated.id, now),
    ]);
    console.log(JSON.stringify({ event: 'website_form', outcome: 'stored', status: 201 }));
    return received(allocated.id);
  } catch (err) {
    console.error('POST /api/forms/submit failed:', err && err.message);
    return answer(fail('database_error', 'Your request could not be saved. Please try again or call us.', 500));
  }
}

/** The router hands every /api/forms/submit request here. Public: see the header. */
export async function publicFormSubmit(request, env) {
  if (request.method === 'OPTIONS') {
    const cors = corsHeaders(request, env);
    if (!cors || !Object.keys(cors).length) return new Response(null, { status: 403, headers: SECURITY_HEADERS });
    return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...cors } });
  }
  if (request.method === 'POST') return submit(request, env);
  return methodNotAllowed(['POST', 'OPTIONS']);
}

/* ---------- staff: list ---------- */

function actorName(request) {
  const p = principalOf(request);
  if (!p) return 'Staff';
  if (p.kind === 'account') return String(p.username || p.id).slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  return 'API token';
}

/** 'YYYY-MM-DD' in Dhaka -> the UTC instant that day starts. */
const dhakaDayStart = (day) => new Date(`${day}T00:00:00+06:00`).toISOString();
const nextDay = (day) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

export async function listWebsiteForms(request, env, url) {
  if (request.method !== 'GET') return methodNotAllowed(['GET']);
  if (!env.DB) return noDatabase();
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !FORM_STATUSES.includes(status)) return fail('invalid_parameter', `\`status\` must be one of: ${FORM_STATUSES.join(', ')}.`, 400);
  const type = url.searchParams.get('type') || null;
  if (type !== null && !FORM_TYPES.includes(type)) return fail('invalid_parameter', `\`type\` must be one of: ${FORM_TYPES.join(', ')}.`, 400);
  const range = {};
  for (const k of ['from', 'to']) {
    const r = readDate(Object.fromEntries(url.searchParams), k, { fallback: '' });
    if (r.error) return fail('invalid_parameter', `\`${k}\` must be a date in YYYY-MM-DD form.`, 400);
    range[k] = r.value;
  }
  if (range.from && range.to && range.to < range.from) return fail('invalid_parameter', '`to` must be on or after `from`.', 400);
  const assigned = url.searchParams.get('assigned') || null;
  if (assigned !== null && assigned !== 'none' && !STAFF_ID.test(assigned)) {
    return fail('invalid_parameter', '`assigned` must be a staff id or "none".', 400);
  }
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > LIMITS.q) return fail('invalid_parameter', `\`q\` must be ${LIMITS.q} characters or fewer.`, 400);
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const digits = q.replace(/\D/g, '');
  const digitNeedle = digits.length >= 3 ? `%${digits}%` : null;

  const where = `
    WHERE (?1 IS NULL OR status = ?1)
      AND (?2 IS NULL OR form_type = ?2)
      AND (?3 IS NULL OR created_at >= ?3)
      AND (?4 IS NULL OR created_at < ?4)
      AND (?5 IS NULL OR lower(name) LIKE ?5 ESCAPE '\\' OR lower(id) LIKE ?5 ESCAPE '\\'
           OR lower(coalesce(reg_no, '')) LIKE ?5 ESCAPE '\\' OR lower(coalesce(email, '')) LIKE ?5 ESCAPE '\\'
           OR lower(coalesce(service, '')) LIKE ?5 ESCAPE '\\' OR lower(coalesce(vehicle, '')) LIKE ?5 ESCAPE '\\'
           OR lower(coalesce(message, '')) LIKE ?5 ESCAPE '\\'
           OR (?6 IS NOT NULL AND phone_digits LIKE ?6))
      AND (?7 IS NULL OR (?7 = 'none' AND assigned_to_id IS NULL) OR assigned_to_id = ?7)`;
  const binds = [status, type, range.from ? dhakaDayStart(range.from) : null, range.to ? dhakaDayStart(nextDay(range.to)) : null, needle, digitNeedle, assigned];
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM website_form_submissions ${where} ORDER BY created_at DESC, id DESC LIMIT ?8 OFFSET ?9`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM website_form_submissions ${where}`).bind(...binds).first();
    const sums = await env.DB.prepare(
      `SELECT count(*) AS total,
              coalesce(sum(CASE WHEN status = 'New' THEN 1 ELSE 0 END), 0) AS new,
              coalesce(sum(CASE WHEN status = 'Contacted' THEN 1 ELSE 0 END), 0) AS contacted,
              coalesce(sum(CASE WHEN status = 'Confirmed' THEN 1 ELSE 0 END), 0) AS confirmed,
              coalesce(sum(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END), 0) AS rejected
         FROM website_form_submissions`
    ).first();
    const rows = (results || []).map(toRecord);
    return ok(rows, {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      summary: { total: sums.total, new: sums.new, contacted: sums.contacted, confirmed: sums.confirmed, rejected: sums.rejected },
    });
  } catch (err) {
    console.error('GET /api/website-forms failed:', err && err.message);
    return fail('database_error', 'Could not read website enquiries.', 500);
  }
}

/* ---------- staff: one, with history ---------- */

const findRow = (env, id) => env.DB.prepare(`SELECT ${COLUMNS} FROM website_form_submissions WHERE id = ?1`).bind(id).first();

async function withHistory(env, row) {
  const { results } = await env.DB.prepare(
    'SELECT id, action, from_status, to_status, actor, created_at FROM website_form_events WHERE submission_id = ?1 ORDER BY id'
  ).bind(row.id).all();
  return { ...toRecord(row), history: (results || []).map(toEvent) };
}

export async function getWebsiteForm(request, env, rawId) {
  if (request.method !== 'GET') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  if (!FORM_ID.test(rawId || '')) return fail('invalid_id', 'Enquiry id must look like WEB-0001.', 400);
  try {
    const row = await findRow(env, rawId);
    if (!row) return fail('not_found', 'No enquiry with that id.', 404);
    return ok(await withHistory(env, row));
  } catch (err) {
    console.error('GET /api/website-forms/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the enquiry.', 500);
  }
}

/* ---------- staff: status, notes and assignment ---------- */

/** An ACTIVE employee (not a mechanic's own staff profile) or mechanic, or null. */
async function activeStaff(env, id) {
  return env.DB.prepare(
    `SELECT id, name FROM staff WHERE id = ?1 AND mechanic_id IS NULL AND status = 'Active'
     UNION ALL
     SELECT id, name FROM mechanics WHERE id = ?1 AND status = 'Active'
     LIMIT 1`
  ).bind(id).first();
}

export async function updateWebsiteForm(request, env, rawId) {
  if (request.method !== 'PUT') return methodNotAllowed(['GET', 'PUT']);
  if (!env.DB) return noDatabase();
  if (!FORM_ID.test(rawId || '')) return fail('invalid_id', 'Enquiry id must look like WEB-0001.', 400);
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (!['status', 'notes', 'assignedToId', 'expectedUpdatedAt'].includes(k)) errors[k] = 'This field cannot be changed here.';
  if (body.status !== undefined && !FORM_STATUSES.includes(body.status)) errors.status = `Choose one of: ${FORM_STATUSES.join(', ')}.`;
  let notes;
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') errors.notes = 'Must be text.';
    else if ((body.notes || '').trim().length > LIMITS.notes) errors.notes = `Keep this to ${LIMITS.notes} characters or fewer.`;
    else notes = (body.notes || '').trim() || null;
  }
  let assignTo;               // undefined: not asked; null: un-assign; string: a staff id to check
  if (body.assignedToId !== undefined) {
    if (body.assignedToId === null || body.assignedToId === '') assignTo = null;
    else if (typeof body.assignedToId !== 'string' || !STAFF_ID.test(body.assignedToId)) errors.assignedToId = 'Choose a member of staff.';
    else assignTo = body.assignedToId;
  }
  if (typeof body.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt || body.expectedUpdatedAt.length > 40) {
    errors.expectedUpdatedAt = '`expectedUpdatedAt` is required: send the updatedAt value the change was made from.';
  }
  if (!Object.keys(errors).length && body.status === undefined && body.notes === undefined && body.assignedToId === undefined) errors.status = 'Nothing to change.';
  if (Object.keys(errors).length) return unprocessable('The enquiry could not be updated.', errors);

  try {
    const row = await findRow(env, rawId);
    if (!row) return fail('not_found', 'No enquiry with that id.', 404);
    if ((row.updated_at || row.created_at) !== body.expectedUpdatedAt) {
      return conflict('This enquiry was changed by someone else after you opened it. Reload it and try again.', { reason: 'concurrent_modification' });
    }
    const statusChanged = body.status !== undefined && body.status !== row.status;
    const notesChanged = notes !== undefined && notes !== (row.notes || null);
    const assignChanged = assignTo !== undefined && assignTo !== (row.assigned_to_id || null);
    let person = null;
    if (assignChanged && assignTo !== null) {
      person = await activeStaff(env, assignTo);
      if (!person) return unprocessable('The enquiry could not be updated.', { assignedToId: 'That is not an active member of staff.' });
    }
    if (!statusChanged && !notesChanged && !assignChanged) return ok(await withHistory(env, row));
    const who = actorName(request);
    let now = nowIso();
    if (now <= (row.updated_at || '')) now = new Date(Date.parse(row.updated_at) + 1).toISOString();
    const statements = [
      env.DB.prepare(
        `UPDATE website_form_submissions SET status = ?3, notes = ?4, updated_at = ?5, updated_by = ?6,
                assigned_to_id = ?7, assigned_to_name = ?8, assigned_at = ?9, assigned_by = ?10
          WHERE id = ?1 AND coalesce(updated_at, created_at) = ?2`
      ).bind(row.id, body.expectedUpdatedAt, statusChanged ? body.status : row.status, notesChanged ? notes : row.notes, now, who,
        ...(assignChanged
          ? (person ? [person.id, String(person.name || person.id).slice(0, 120), now, who] : [null, null, now, who])
          : [row.assigned_to_id || null, row.assigned_to_name || null, row.assigned_at || null, row.assigned_by || null])),
    ];
    // History rows are written only if the guarded update itself applied (same batch, same transaction).
    const guard = 'EXISTS (SELECT 1 FROM website_form_submissions WHERE id = ?1 AND updated_at = ?2 AND updated_by = ?3)';
    if (statusChanged) {
      statements.push(env.DB.prepare(
        `INSERT INTO website_form_events (submission_id, action, from_status, to_status, actor, created_at)
         SELECT ?1, 'status', ?4, ?5, ?3, ?2 WHERE ${guard}`
      ).bind(row.id, now, who, row.status, body.status));
    }
    if (notesChanged) {
      statements.push(env.DB.prepare(
        `INSERT INTO website_form_events (submission_id, action, actor, created_at) SELECT ?1, 'notes', ?3, ?2 WHERE ${guard}`
      ).bind(row.id, now, who));
    }
    const results = await env.DB.batch(statements);
    if (!results[0].meta || results[0].meta.changes !== 1) {
      return conflict('This enquiry was changed by someone else after you opened it. Reload it and try again.', { reason: 'concurrent_modification' });
    }
    return ok(await withHistory(env, await findRow(env, row.id)));
  } catch (err) {
    console.error('PUT /api/website-forms/:id failed:', err && err.message);
    return fail('database_error', 'Could not update the enquiry.', 500);
  }
}
