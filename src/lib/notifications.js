/**
 * Notifications (0017): how real workshop events become notifications.
 *
 * Two sources, and nothing else -- no notification is ever made up:
 *
 *   1. Request-driven events. withNotification() wraps a route at the router
 *      (src/index.js), exactly as withActivity() does: it runs the route and,
 *      only when the route answered 200/201, turns the saved record in the
 *      response into one notification. The CRM route modules themselves are
 *      not changed, and a failure here never fails the request -- the record
 *      is saved either way; only its notification would be missing (logged).
 *
 *   2. Conditions that become true with time (a follow-up falls due, stock is
 *      low). sweepNotifications() finds them with set-based
 *      INSERT OR IGNORE ... SELECT statements. It runs when the Notifications
 *      API is read (at most once a minute per Worker instance, or on demand
 *      with ?refresh=1), so no scheduler is needed.
 *
 * Duplicates are impossible by construction: every row has a UNIQUE
 * event_key built from the event itself (record id plus, where the same
 * record can raise the event again, the state that makes it new -- a status
 * and the record's updated_at, a due date), and every insert is
 * INSERT OR IGNORE on it. A retried request or a second sweep inserts nothing.
 */

import { principalOf } from './auth.js';
import { can, hasFullAccess, NOTIFICATION_RECORD_PERMISSIONS } from './permissions.js';
import { nowIso, todayInDhaka } from './write.js';

export const CATEGORIES = ['Enquiry', 'Customer', 'Appointment', 'Workshop', 'Finance', 'Inventory', 'Follow-up', 'Staff'];

const TITLE_MAX = 120;
const MESSAGE_MAX = 500;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const money = (n) => `৳ ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** The reader key for read/unread state: the signed-in identity, never a client-supplied value. */
export function readerOf(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account' && typeof p.id === 'string' && p.id.startsWith('USR-')) {
    return { reader: `account:${p.id}`, accountId: p.id, visible: visibleSql(p) };
  }
  if (p.kind === 'passphrase') return { reader: 'passphrase', accountId: null, visible: visibleSql(p) };
  if (p.kind === 'token') return { reader: 'token', accountId: null, visible: visibleSql(p) };
  return null;
}

/**
 * Which notifications a caller may see, as SQL on the alias `n` (bound ?2 =
 * the caller's account id): their own personal ones, and shared ones about a
 * kind of record their role may view (0018) -- a Mechanic is not shown
 * "Payment received". The record types are fixed server-side constants.
 */
export function visibleSql(who) {
  const mine = 'n.recipient_account_id = ?2';
  if (hasFullAccess(who)) return `(n.recipient_account_id IS NULL OR ${mine})`;
  const types = Object.entries(NOTIFICATION_RECORD_PERMISSIONS).filter(([, perm]) => can(who, perm)).map(([type]) => `'${type}'`);
  return types.length
    ? `(${mine} OR (n.recipient_account_id IS NULL AND n.record_type IN (${types.join(', ')})))`
    : `(${mine})`;
}

function actorName(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') return clip(p.username || p.id, 100) || null;
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  if (p.kind === 'token') return 'API token';
  return null;
}

/** Insert one notification; a repeat of the same event_key is ignored. Returns true if a row was added. */
export async function insertNotification(env, n) {
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO notifications
       (event_key, event_type, category, priority, title, message, record_type, record_id,
        recipient_account_id, actor_name, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
  ).bind(
    clip(n.key, 200), n.type, n.category, n.priority || 'normal',
    clip(n.title, TITLE_MAX), clip(n.message, MESSAGE_MAX),
    n.recordType || null, n.recordId ? clip(n.recordId, 40) : null,
    n.recipient || null, n.actor || null, n.createdAt || nowIso()
  ).run();
  return !!(res && res.meta && res.meta.changes);
}

/* ---------------------------------------------------------------
   1. Request-driven events
   --------------------------------------------------------------- */

async function customerName(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT name FROM customers WHERE id = ?1').bind(id).first();
  return row ? row.name : null;
}
async function vehicleLabel(env, id) {
  if (!id) return null;
  const row = await env.DB.prepare('SELECT reg_no, brand, model FROM vehicles WHERE id = ?1').bind(id).first();
  if (!row) return null;
  const car = [row.brand, row.model].filter(Boolean).join(' ');
  return car ? `${row.reg_no} (${car})` : row.reg_no;
}
const forWhom = (name, vehicle) => [name, vehicle].filter(Boolean).join(' — ');
const when = (date, time) => [date, time].filter(Boolean).join(' at ');

/**
 * What each wrapped route's success means, keyed `${collection}.${op}`.
 * Each builder gets the saved record from the response and returns the
 * notification, or null when this success is not notification-worthy.
 */
const EVENTS = {
  'customers.create': async (env, d) => ({
    key: `customer.created:${d.id}`, type: 'customer.created', category: 'Customer',
    title: 'New customer registered',
    message: `${d.name}${d.phone ? ` (${d.phone})` : ''} was added as ${d.id}.`,
    recordType: 'customer', recordId: d.id,
  }),

  'vehicles.create': async (env, d) => {
    const owner = await customerName(env, d.customerId);
    const car = [d.brand, d.model].filter(Boolean).join(' ');
    return {
      key: `vehicle.created:${d.id}`, type: 'vehicle.created', category: 'Customer',
      title: 'New vehicle registered',
      message: `${d.regNo}${car ? ` (${car})` : ''}${owner ? ` for ${owner}` : ''}.`,
      recordType: 'vehicle', recordId: d.id,
    };
  },

  'appointments.create': async (env, d) => ({
    key: `appointment.created:${d.id}`, type: 'appointment.created', category: 'Appointment',
    title: 'New appointment',
    message: `${forWhom(await customerName(env, d.customerId), await vehicleLabel(env, d.vehicleId)) || d.id} on ${when(d.date, d.time)}${d.source ? ` (${d.source})` : ''}.`,
    recordType: 'appointment', recordId: d.id,
  }),

  'appointments.update': async (env, d) => {
    const who = forWhom(await customerName(env, d.customerId), await vehicleLabel(env, d.vehicleId)) || d.id;
    if (d.status === 'Cancelled') {
      // Once per appointment: a later edit of a cancelled appointment is not a new cancellation.
      return {
        key: `appointment.cancelled:${d.id}`, type: 'appointment.cancelled', category: 'Appointment',
        priority: 'important', title: 'Appointment cancelled',
        message: `${d.id} for ${who} on ${when(d.date, d.time)} was cancelled.`,
        recordType: 'appointment', recordId: d.id,
      };
    }
    return {
      key: `appointment.updated:${d.id}:${d.updatedAt || nowIso()}`, type: 'appointment.updated', category: 'Appointment',
      title: 'Appointment updated',
      message: `${d.id} for ${who}: ${when(d.date, d.time)}, ${d.status}.`,
      recordType: 'appointment', recordId: d.id,
    };
  },

  'job-cards.create': async (env, d) => ({
    key: `job_card.created:${d.id}`, type: 'job_card.created', category: 'Workshop',
    title: 'Job card created',
    message: `${d.id} for ${forWhom(await customerName(env, d.customerId), await vehicleLabel(env, d.vehicleId)) || 'a customer'}${d.status ? ` — ${d.status}` : ''}.`,
    recordType: 'job_card', recordId: d.id,
  }),

  'job-cards.status': async (env, d) => ({
    key: `job_card.status:${d.id}:${d.status}:${d.updatedAt || nowIso()}`, type: 'job_card.status', category: 'Workshop',
    title: d.status === 'Completed' ? 'Job card completed' : `Job card: ${d.status}`,
    message: `${d.id} for ${forWhom(await customerName(env, d.customerId), await vehicleLabel(env, d.vehicleId)) || 'a customer'} is now ${d.status}.`,
    recordType: 'job_card', recordId: d.id,
  }),

  'estimates.create': async (env, d) => ({
    key: `estimate.created:${d.id}`, type: 'estimate.created', category: 'Finance',
    title: 'Estimate created',
    message: `${d.id} for ${(await customerName(env, d.customerId)) || 'a customer'}: ${money(d.total)}.`,
    recordType: 'estimate', recordId: d.id,
  }),

  // Converting an approved estimate creates a job card. Same key as a job card
  // created directly, so the one job card can never be announced twice.
  'estimates.convert': async (env, d) => {
    if (typeof d.jobCardId !== 'string' || !d.jobCardId) return null;
    return {
      key: `job_card.created:${d.jobCardId}`, type: 'job_card.created', category: 'Workshop',
      title: 'Job card created',
      message: `${d.jobCardId} from estimate ${d.id} for ${forWhom(await customerName(env, d.customerId), await vehicleLabel(env, d.vehicleId)) || 'a customer'}.`,
      recordType: 'job_card', recordId: d.jobCardId,
    };
  },

  'invoices.create': async (env, d) => {
    const due = Number(d.due) || 0;
    return {
      key: `invoice.created:${d.id}`, type: 'invoice.created', category: 'Finance',
      title: due > 0 ? 'Invoice created — payment due' : 'Invoice created',
      message: `${d.id} for ${(await customerName(env, d.customerId)) || 'a customer'}: total ${money(d.total)}`
        + (due > 0 ? `, balance due ${money(due)}.` : ', fully paid.'),
      recordType: 'invoice', recordId: d.id,
    };
  },

  'payments.create': async (env, d) => ({
    key: `payment.created:${d.id}`, type: 'payment.received', category: 'Finance',
    title: 'Payment received',
    message: `${money(d.amount)}${d.method ? ` (${d.method})` : ''} from ${(await customerName(env, d.customerId)) || 'a customer'}`
      + (d.invoiceId ? ` for ${d.invoiceId}.` : ' as an advance.'),
    recordType: 'payment', recordId: d.id,
  }),

  'leave-requests.create': async (env, d) => ({
    key: `leave.created:${d.id}`, type: 'leave.requested', category: 'Staff',
    title: 'Leave request submitted',
    message: `${d.staffName || 'A staff member'}: ${d.leaveType || 'leave'}, ${d.startDate}${d.endDate && d.endDate !== d.startDate ? ` to ${d.endDate}` : ''}${d.days ? ` (${d.days} day${Number(d.days) === 1 ? '' : 's'})` : ''}.`,
    recordType: 'leave_request', recordId: d.id,
  }),

  // A decision is for the person who asked -- only when they have a user account.
  'leave-requests.approve': (env, d) => leaveDecision(env, d),
  'leave-requests.reject': (env, d) => leaveDecision(env, d),

  // The public website form (routes/website-forms.js, unchanged): its 201 answer
  // carries only the reference, so the enquiry is read back by that id.
  'website-forms.submit': async (env, d) => {
    const ref = d.reference;
    if (d.duplicate || typeof ref !== 'string' || !/^WEB-\d{1,10}$/.test(ref)) return null;
    const row = await env.DB.prepare(
      'SELECT form_type, name, service, preferred_date, preferred_time FROM website_form_submissions WHERE id = ?1'
    ).bind(ref).first();
    if (!row) return null;
    const kind = { booking: 'booking', quote: 'quote request', contact: 'message' }[row.form_type] || 'enquiry';
    return {
      key: `website_form.created:${ref}`, type: 'website_form.received', category: 'Enquiry',
      title: 'New website enquiry',
      message: `${row.name} sent a ${kind}${row.service ? ` for ${row.service}` : ''}`
        + (row.preferred_date ? `, preferred ${when(row.preferred_date, row.preferred_time)}` : '') + ` (${ref}).`,
      recordType: 'website_form', recordId: ref,
    };
  },
};

async function leaveDecision(env, d) {
  if (!d.staffId || (d.status !== 'Approved' && d.status !== 'Rejected')) return null;
  const acct = await env.DB.prepare(
    // A person is staff (STF-) or a mechanic (MEC-); an account belongs to one of them.
    `SELECT id FROM user_accounts WHERE (staff_id = ?1 OR mechanic_id = ?1) AND status = 'Active'`
  ).bind(d.staffId).first();
  if (!acct) return null;
  return {
    key: `leave.decided:${d.id}`, type: 'leave.decided', category: 'Staff',
    title: `Your leave request was ${d.status.toLowerCase()}`,
    message: `${d.leaveType || 'Leave'}, ${d.startDate}${d.endDate && d.endDate !== d.startDate ? ` to ${d.endDate}` : ''}${d.decisionNote ? `: ${d.decisionNote}` : '.'}`,
    recordType: 'leave_request', recordId: d.id, recipient: acct.id,
  };
}

export const NOTIFIED_EVENTS = Object.keys(EVENTS);

/**
 * Run `respond` and, if it succeeded, record the notification its event
 * raises. Returns the route's own Response unchanged and at once: the
 * notification is written after the answer, through ctx.waitUntil(), so it
 * adds no time to the request and can never change its outcome. The Workers
 * runtime always passes ctx; a direct call of the router without one (the
 * unit tests of other modules) records nothing.
 */
export async function withNotification(request, env, ctx, collection, op, respond) {
  const build = EVENTS[`${collection}.${op}`];
  const response = await respond();
  if (!build || (response.status !== 200 && response.status !== 201) || !env.DB) return response;
  if (!ctx || typeof ctx.waitUntil !== 'function') return response;
  const actor = actorName(request);
  const copy = response.clone();
  ctx.waitUntil((async () => {
    try {
      const body = await copy.json();
      const data = body && body.data;
      if (!data || typeof data !== 'object') return;
      if (collection !== 'website-forms' && (typeof data.id !== 'string' || !data.id)) return;
      const n = await build(env, data);
      if (n) await insertNotification(env, { ...n, actor });
    } catch (err) {
      // The record is saved; only its notification is missing. Never turn that into a failure.
      console.error(`notifications: not recorded for ${collection} ${op}:`, err && err.message);
    }
  })());
  return response;
}

/* ---------------------------------------------------------------
   2. Conditions that become true with time
   --------------------------------------------------------------- */

const SWEEP_EVERY_MS = 60 * 1000;
let lastSweepAt = 0;

/** Forget when the last sweep ran (tests). */
export function resetSweepClock() { lastSweepAt = 0; }

/**
 * Raise the notifications that time has made true. Idempotent: each
 * statement is INSERT OR IGNORE with a key that names the condition, so
 * running it twice adds nothing. Returns how many rows were added, or null
 * when skipped because a sweep ran less than a minute ago.
 */
export async function sweepNotifications(env, { force = false, now = Date.now() } = {}) {
  if (!force && now - lastSweepAt < SWEEP_EVERY_MS) return null;
  lastSweepAt = now;
  const today = todayInDhaka(new Date(now));
  const at = new Date(now).toISOString();
  const statements = [
    // A customer follow-up that is open and due today or earlier. Keyed on the
    // due date, so rescheduling it and letting it fall due again raises a new one.
    env.DB.prepare(
      `INSERT OR IGNORE INTO notifications
         (event_key, event_type, category, priority, title, message, record_type, record_id, created_at)
       SELECT 'follow_up.due:' || f.id || ':' || f.due_date, 'follow_up.due', 'Follow-up',
              CASE WHEN f.due_date < ?1 THEN 'important' ELSE 'normal' END,
              CASE WHEN f.due_date < ?1 THEN 'Follow-up overdue' ELSE 'Follow-up due today' END,
              substr(COALESCE(c.name, 'A customer') || ': ' || f.reason || ' (due ' || f.due_date || ', ' || f.id || ').', 1, 500),
              'follow_up', f.id, ?2
         FROM follow_ups f LEFT JOIN customers c ON c.id = f.customer_id
        WHERE f.status = 'Open' AND f.due_date <= ?1`
    ).bind(today, at),
    // A follow-up task that is not finished and due today or earlier.
    env.DB.prepare(
      `INSERT OR IGNORE INTO notifications
         (event_key, event_type, category, priority, title, message, record_type, record_id, created_at)
       SELECT 'follow_up_task.due:' || t.id || ':' || t.due_date, 'follow_up_task.due', 'Follow-up',
              CASE WHEN t.due_date < ?1 OR t.priority = 'urgent' THEN 'important' ELSE 'normal' END,
              CASE WHEN t.due_date < ?1 THEN 'Task overdue' ELSE 'Task due today' END,
              substr(t.title || ' (' || t.priority || ' priority, due ' || t.due_date
                     || COALESCE(', ' || m.name, '') || ', ' || t.id || ').', 1, 500),
              'follow_up_task', t.id, ?2
         FROM follow_up_tasks t LEFT JOIN mechanics m ON m.id = t.assigned_to
        WHERE t.status IN ('Pending', 'In Progress') AND t.due_date <= ?1`
    ).bind(today, at),
    // An active part with a minimum stock level that is at or below it. Keyed
    // on the part's updated_at, which every stock movement changes: a part
    // that stays low raises nothing new, one that changes again does.
    env.DB.prepare(
      `INSERT OR IGNORE INTO notifications
         (event_key, event_type, category, priority, title, message, record_type, record_id, created_at)
       SELECT 'part.low_stock:' || p.id || ':' || COALESCE(p.updated_at, p.created_at), 'part.low_stock', 'Inventory',
              'important',
              CASE WHEN p.stock <= 0 THEN 'Out of stock' ELSE 'Low stock' END,
              substr(p.name || ' (' || p.id || '): ' || printf('%g', p.stock) || ' in stock, minimum ' || printf('%g', p.min_stock) || '.', 1, 500),
              'part', p.id, ?1
         FROM parts p
        WHERE p.status = 'Active' AND p.min_stock > 0 AND p.stock <= p.min_stock`
    ).bind(at),
  ];
  const results = await env.DB.batch(statements);
  return results.reduce((sum, r) => sum + ((r && r.meta && r.meta.changes) || 0), 0);
}
