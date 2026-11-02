/* ============================================================
   changes.js — the change log devices pull from (0020)
   ------------------------------------------------------------
   After a write route answers 2xx, the router records what
   changed: the record itself ('upsert', or 'delete' -- a
   tombstone), and a 'refresh' for each collection the same
   write may also have moved (a payment moves its invoice's
   balance; a job card's status moves stock). A device pulls
   these by a server sequence number (GET /api/sync/pull).

   Written here, after the write, and NOT by triggers: D1 counts
   rows a trigger writes in the statement's meta.changes, and
   the write guards in the routes depend on that count.

   A failure to log never fails the write that already happened:
   it is reported in the Worker log, and a device then simply
   catches up at its next full online load.
   ============================================================ */

/** API collection -> the name the app (and its offline copy) uses. Only these are logged. */
export const LOGGED = {
  customers: 'customers', vehicles: 'vehicles', appointments: 'appointments', 'job-cards': 'jobCards',
  services: 'services', mechanics: 'mechanics', parts: 'parts', invoices: 'invoices', payments: 'payments',
  expenses: 'expenses', 'inventory-transactions': 'inventoryTransactions', 'invoice-adjustments': 'invoiceAdjustments',
};

/** What else a write to a collection can change, read again in full by a device. */
const ALSO = {
  'job-cards': ['parts', 'inventoryTransactions', 'appointments', 'invoices'],
  invoices: ['jobCards', 'payments'],
  payments: ['invoices', 'jobCards'],
  'invoice-adjustments': ['invoices'],
  'inventory-transactions': ['parts'],
  appointments: ['jobCards'],
  estimates: ['jobCards'],
};

export async function logChanges(env, entries) {
  if (!env || !env.DB || !entries.length) return;
  const at = new Date().toISOString();
  try {
    await env.DB.batch(entries.map((e) => env.DB.prepare(
      'INSERT INTO change_log (collection, record_id, op, changed_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(e.collection, e.id, e.op, at)));
  } catch (err) {
    // Before 0020 is applied the table does not exist; a write must not fail for that.
    console.error('change_log: not recorded:', err && err.message);
  }
}

/**
 * Run a write route and, if it succeeded, log what it changed.
 * `op` is 'create' | 'update' | 'remove' | an action name; `id` the path id, if any.
 */
export async function withChanges(env, name, op, id, respond) {
  const res = await respond();
  if (!res || res.status < 200 || res.status >= 300) return res;
  const entries = [];
  const own = LOGGED[name];
  if (own) {
    let recordId = id || null;
    if (!recordId) {
      try { const body = await res.clone().json(); recordId = body && body.data && body.data.id ? String(body.data.id) : null; } catch { /* no body */ }
    }
    if (recordId) entries.push({ collection: own, id: recordId, op: op === 'remove' ? 'delete' : 'upsert' });
  }
  for (const c of ALSO[name] || []) entries.push({ collection: c, id: '*', op: 'refresh' });
  await logChanges(env, entries);
  return res;
}
