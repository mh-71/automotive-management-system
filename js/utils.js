/* ============================================================
   utils.js — Shared helpers: formatting, DOM, toasts
   ============================================================ */

const Utils = (() => {

  /* ---------- formatting ---------- */

  /** Format a number as currency, e.g. ৳ 4,200 */
  function money(amount) {
    const cur = Storage.getSettings().currency || '৳';
    const n = Number(amount) || 0;
    return `${cur} ${n.toLocaleString('en-IN')}`;
  }

  /** Format ISO / yyyy-mm-dd date as "14 Sep 2026" */
  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d)) return value;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Format "HH:MM" (24h) as "10:00 AM" */
  function fmtTime(hhmm) {
    if (!hhmm) return '—';
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hr = h % 12 || 12;
    return `${hr}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  /**
   * Format a Date as a yyyy-mm-dd string in the browser's LOCAL calendar.
   * Never toISOString() -- that converts to UTC first, which reports the
   * wrong calendar date for part of every day outside UTC (in Dhaka,
   * UTC+6, midnight--06:00 local would resolve to the previous day).
   */
  function toDateStr(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d)) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Today as yyyy-mm-dd, in the browser's local calendar. */
  function todayStr() {
    return toDateStr(new Date());
  }

  /** Escape text before inserting into HTML */
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- status badge ---------- */

  const STATUS_TONE = {
    // job / appointment statuses → badge tone
    'Received': 'neutral', 'Inspection': 'info', 'Waiting for Approval': 'warn',
    'In Progress': 'info', 'Waiting for Parts': 'warn', 'Completed': 'good',
    'Delivered': 'good', 'Cancelled': 'bad',
    'Pending': 'neutral', 'Confirmed': 'info', 'In Service': 'warn',
    'Scheduled': 'neutral', 'No Show': 'bad',
    'Paid': 'good', 'Partial': 'warn', 'Unpaid': 'bad', 'Active': 'good', 'Inactive': 'neutral',
    'Void': 'neutral',
    // display-only invoice labels (invoiceStatusLabel); never stored
    'Settled': 'good', 'Written Off': 'info'
  };

  function badge(status) {
    const tone = STATUS_TONE[status] || 'neutral';
    return `<span class="badge badge--${tone}">${esc(status)}</span>`;
  }

  /**
   * The label an invoice's status is SHOWN with. The stored status stays one
   * of Unpaid / Partial / Paid / Void (filters, the API and the database all
   * use it); a write-off only changes how a fully cleared invoice reads:
   *   Settled      nothing is owed, some cash was paid and the rest written off
   *   Written Off  nothing is owed and no cash was paid at all
   */
  function invoiceStatusLabel(inv) {
    if (!inv) return '';
    if (inv.status === 'Void') return 'Void';
    const writtenOff = Number(inv.writtenOff) || 0;
    if (writtenOff > 0 && (Number(inv.due) || 0) < 0.005) {
      return (Number(inv.paid) || 0) > 0 ? 'Settled' : 'Written Off';
    }
    return inv.status;
  }

  /* ---------- toast notifications ---------- */

  function toast(message, type = 'success') {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="toast__dot"></span><span>${esc(message)}</span>`;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    setTimeout(() => {
      el.classList.remove('is-in');
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 500); // fallback
    }, 3200);
  }

  /* ---------- lookups ---------- */

  function customerName(id) { return (Storage.getById('customers', id) || {}).name || '—'; }
  function mechanicName(id) { return (Storage.getById('mechanics', id) || {}).name || '—'; }
  function vehicleLabel(id) {
    const v = Storage.getById('vehicles', id);
    return v ? `${v.brand} ${v.model}` : '—';
  }
  function vehicleReg(id) {
    const v = Storage.getById('vehicles', id);
    return v ? v.regNo : '—';
  }
  function serviceName(id) { return (Storage.getById('services', id) || {}).name || '—'; }

  /* ---------- mechanic job stats (shared with future Job Card module) ---------- */

  const ACTIVE_JOB_STATUSES = ['Received', 'Inspection', 'Waiting for Approval', 'In Progress', 'Waiting for Parts'];
  const DONE_JOB_STATUSES = ['Completed', 'Delivered'];

  function getMechanicJobs(mechanicId) {
    return Storage.getData('jobCards').filter(j => j.mechanicId === mechanicId);
  }
  function getMechanicActiveJobs(mechanicId) {
    return getMechanicJobs(mechanicId).filter(j => ACTIVE_JOB_STATUSES.includes(j.status));
  }
  function getMechanicCompletedJobs(mechanicId) {
    return getMechanicJobs(mechanicId).filter(j => DONE_JOB_STATUSES.includes(j.status));
  }
  function getMechanicRevenue(mechanicId) {
    return getMechanicCompletedJobs(mechanicId).reduce((s, j) => s + (Number(j.total) || 0), 0);
  }

  /* ============================================================
     Live Job Card balances
     ------------------------------------------------------------
     A Job Card's own paid/due are a FROZEN pre-invoice snapshot --
     correct as history, wrong as a current balance. Once an Invoice
     exists, Payments become the source of truth and payments.js
     recomputes the INVOICE's paid/due from non-Void Payments; it
     deliberately never writes back to the Job Card.

     These helpers resolve the right source at read time. Nothing is
     written, nothing is synced, and the snapshot stays intact:

       - Cancelled job          -> nothing is owed (due 0); any money
                                   actually taken still counts as paid
       - Live (non-Void) invoice -> the Invoice's paid/due
       - Recorded advances       -> paid = the job card's Active advance
                                    payments (no invoice yet), due = total
                                    minus them: the ledger, not the typed
                                    figure
       - Otherwise               -> the Job Card's own snapshot (legacy
                                    cards whose money was only typed)

     Voiding an Invoice clears jobCard.invoiceId (invoices.js), which
     returns the job to its un-invoiced state, so it falls back to the
     snapshot it carried before that invoice existed. The status guard
     on a still-linked invoice is defensive, for a stale reference --
     a Void invoice's frozen figures are never treated as live.
     ============================================================ */

  /** Map of invoiceId -> invoice, built once, for summing many jobs cheaply. */
  function invoiceIndex(jobs) {
    if (!(jobs || []).some(j => j && j.invoiceId)) return null;
    return new Map(Storage.getData('invoices').map(i => [i.id, i]));
  }

  /**
   * A job card's advances: Active payments recorded against it that no
   * invoice holds yet, oldest first. Invoice creation applies exactly these.
   */
  function jobAdvances(jobId) {
    return Storage.getData('payments')
      .filter(p => p.jobCardId === jobId && !p.invoiceId && p.status !== 'Void')
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)));
  }

  /** Map of jobCardId -> advance total, built once, for summing many jobs. */
  function advanceIndex() {
    const map = new Map();
    Storage.getData('payments').forEach(p => {
      if (!p.jobCardId || p.invoiceId || p.status === 'Void') return;
      map.set(p.jobCardId, (map.get(p.jobCardId) || 0) + (Number(p.amount) || 0));
    });
    return map;
  }

  /**
   * Current paid/due for one Job Card. Pass the optional indexes when
   * looping over many jobs to avoid a per-job lookup.
   */
  function liveJobBalance(job, invoiceById, advanceByJob) {
    if (!job) return { paid: 0, due: 0 };
    const inv = job.invoiceId
      ? (invoiceById ? invoiceById.get(job.invoiceId) || null : Storage.getById('invoices', job.invoiceId))
      : null;
    const useInvoice = !!inv && inv.status !== 'Void';
    let paid, due;
    if (useInvoice) {
      paid = Number(inv.paid) || 0;
      due = Number(inv.due) || 0;
    } else {
      const advanced = advanceByJob
        ? (advanceByJob.get(job.id) || 0)
        : jobAdvances(job.id).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      if (advanced > 0) {
        paid = advanced;
        due = Math.max((Number(job.total) || 0) - advanced, 0);
      } else {
        paid = Number(job.paid) || 0;
        due = Number(job.due) || 0;
      }
    }
    return { paid, due: job.status === 'Cancelled' ? 0 : due };
  }

  function liveJobPaid(job) { return liveJobBalance(job).paid; }
  function liveJobDue(job) { return liveJobBalance(job).due; }

  /** Total currently outstanding across a list of Job Cards. */
  function sumJobsDue(jobs) {
    const idx = invoiceIndex(jobs);
    const adv = advanceIndex();
    return (jobs || []).reduce((s, j) => s + liveJobBalance(j, idx, adv).due, 0);
  }

  /** Total actually collected across a list of Job Cards. */
  function sumJobsPaid(jobs) {
    const idx = invoiceIndex(jobs);
    const adv = advanceIndex();
    return (jobs || []).reduce((s, j) => s + liveJobBalance(j, idx, adv).paid, 0);
  }

  /* ============================================================
     Inventory engine (shared by inventory.js and job-cards.js)
     Source of truth: part.stock is the operational quantity;
     inventoryTransactions is the audit trail. Every stock change
     goes through move(), which updates both together and never
     lets stock go negative.
     ============================================================ */

  const Inventory = (() => {
    const IN_TYPES = ['purchase', 'adjustment-in', 'return', 'initial-stock'];
    const OUT_TYPES = ['sale', 'job-card-use', 'adjustment-out', 'damaged'];

    /**
     * Apply a stock movement and record its transaction, together.
     * Returns { ok, error?, transaction?, newStock? }.
     *
     * With a backend that is ONE request: the Worker writes the ledger row
     * and moves parts.stock in a single batch, derives the direction from
     * the type itself, and computes prevStock/newStock in SQL from the live
     * row -- which is why none of those three is sent. The shortage rule is
     * a guard inside that write (`stock + delta >= 0`), so two people
     * issuing the last unit cannot both succeed. The checks below still run
     * first, because refusing an obviously impossible movement without a
     * round trip is kinder than waiting for the server to say the same.
     */
    async function move({ partId, type, quantity, unitCost = null, referenceType = 'manual', referenceId = null, reason = '', notes = '' }) {
      const part = Storage.getById('parts', partId);
      if (!part) return { ok: false, error: 'Part not found.' };
      const qty = Number(quantity);
      if (!qty || qty <= 0) return { ok: false, error: 'Quantity must be greater than 0.' };

      const dir = IN_TYPES.includes(type) ? 1 : OUT_TYPES.includes(type) ? -1 : 0;
      if (!dir) return { ok: false, error: `Unknown transaction type: ${type}` };

      const prevStock = Number(part.stock) || 0;
      const newStock = prevStock + dir * qty;
      if (newStock < 0) {
        return { ok: false, error: `Insufficient stock for ${part.name}. Available: ${prevStock}, Required: ${qty}.` };
      }

      if (Storage.serverRules()) {
        const res = await Storage.create('inventoryTransactions', {
          partId, type, quantity: qty,
          unitCost: unitCost != null && unitCost !== '' ? Number(unitCost) : null,
          referenceType, referenceId, reason, notes
        });
        if (!res.ok) return { ok: false, error: res.message };
        // Offline: queued. The stock shown does not move until the server
        // applies the movement under its own rules.
        if (res.pending) return { ok: true, pending: true, transaction: res.record, newStock: prevStock };
        // The stock the server settled on, re-read rather than assumed. If
        // that re-read fails the movement still happened, so it is reported
        // as a success carrying `stale` rather than as a failure.
        const stale = await Storage.refreshAll('parts');
        const after = Storage.getById('parts', partId);
        return { ok: true, transaction: res.record,
                 newStock: after ? Number(after.stock) : res.record.newStock,
                 ...(stale.length ? { stale } : {}) };
      }

      // Validate everything BEFORE writing, then write transaction + stock
      // back-to-back so localStorage never holds a half-applied change.
      const transaction = Storage.addData('inventoryTransactions', {
        partId, type, quantity: qty,
        unitCost: unitCost != null && unitCost !== '' ? Number(unitCost) : null,
        referenceType, referenceId, reason, notes,
        prevStock, newStock
      });
      Storage.updateData('parts', partId, { stock: newStock });
      return { ok: true, transaction, newStock };
    }

    /** All movements for a part, newest first. */
    function history(partId) {
      return Storage.getData('inventoryTransactions')
        .filter(t => t.partId === partId)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || b.id.localeCompare(a.id));
    }

    function hasJobDeduction(jobId, partId) {
      return Storage.getData('inventoryTransactions').some(t =>
        t.type === 'job-card-use' && t.referenceType === 'job-card' &&
        t.referenceId === jobId && t.partId === partId);
    }

    /**
     * Net quantity currently issued (deducted minus returned) for one
     * part on one job, computed from the transaction ledger only —
     * NOT from the job record's current partsUsed. This is the source
     * of truth reconciliation compares against, so it stays correct
     * even if the job's line items have since been edited.
     */
    function getIssuedQtyForJobPart(jobId, partId) {
      if (!jobId || !partId) return 0;
      const txns = Storage.getData('inventoryTransactions')
        .filter(t => t.referenceType === 'job-card' && t.referenceId === jobId && t.partId === partId);
      const deducted = txns.filter(t => t.type === 'job-card-use').reduce((s, t) => s + (Number(t.quantity) || 0), 0);
      const returned = txns.filter(t => t.type === 'return').reduce((s, t) => s + (Number(t.quantity) || 0), 0);
      return deducted - returned;
    }

    /**
     * Pre-check a job's inventory parts (lines with a partId) against stock,
     * ignoring lines already deducted. Returns array of shortages.
     */
    function checkJobStock(job) {
      const shortages = [];
      (job.partsUsed || []).forEach(line => {
        if (!line.partId) return;                              // manual line — no stock tracking
        if (hasJobDeduction(job.id, line.partId)) return;      // already issued
        const part = Storage.getById('parts', line.partId);
        const available = part ? (Number(part.stock) || 0) : 0;
        const required = Number(line.qty) || 0;
        if (!part || available < required) {
          shortages.push({ name: line.name, available, required });
        }
      });
      return shortages;
    }

    /**
     * Idempotently deduct a job's inventory parts. Safe to call on every
     * entry into In Progress: lines already deducted are skipped, so status
     * ping-pong (In Progress ⇄ Waiting for Parts) never double-deducts.
     * Returns { ok, shortages, deducted }.
     */
    async function deductForJob(job) {
      const shortages = checkJobStock(job);
      if (shortages.length) return { ok: false, shortages, deducted: 0 };
      let deducted = 0;
      for (const line of (job.partsUsed || [])) {
        if (!line.partId || hasJobDeduction(job.id, line.partId)) continue;
        const res = await move({
          partId: line.partId, type: 'job-card-use', quantity: line.qty,
          referenceType: 'job-card', referenceId: job.id,
          notes: `Used on ${job.id}`
        });
        if (res.ok) deducted++;
      }
      return { ok: true, shortages: [], deducted };
    }

    /**
     * Return everything currently outstanding for a job — used when a
     * job is cancelled. Reads the ACTUAL issued balance from the
     * transaction ledger (getIssuedQtyForJobPart), not the job's
     * current line quantities, so it stays correct even if partsUsed
     * was edited after issuance (or a part was removed entirely).
     * Idempotent: a part with nothing outstanding is simply skipped,
     * so calling this twice never double-returns.
     */
    async function returnForJob(job) {
      const partIds = new Set();
      (job.partsUsed || []).forEach(line => { if (line.partId) partIds.add(line.partId); });
      // Also cover parts removed from partsUsed that still carry an
      // outstanding balance from before they were removed.
      Storage.getData('inventoryTransactions')
        .filter(t => t.referenceType === 'job-card' && t.referenceId === job.id && t.type === 'job-card-use')
        .forEach(t => partIds.add(t.partId));

      let returned = 0;
      for (const partId of partIds) {
        const outstanding = getIssuedQtyForJobPart(job.id, partId);
        if (outstanding <= 0) continue;
        const res = await move({
          partId, type: 'return', quantity: outstanding,
          referenceType: 'job-card', referenceId: job.id,
          notes: `Returned — ${job.id} cancelled`
        });
        if (res.ok) returned++;
      }
      return returned;
    }

    /**
     * Reconcile inventory for a Job Card edit. Compares what's
     * currently issued per the ledger (getIssuedQtyForJobPart) against
     * what the proposed partsUsed lines require, and applies only the
     * difference:
     *   - qty increase on an existing part → deduct the extra units
     *   - qty decrease → return the reduced units
     *   - part removed entirely → return whatever was issued for it
     *   - part swapped for another → the old one returns, the new one deducts
     *   - a brand-new inventory-managed line → deducted immediately
     * Manual lines (partId null) never enter the calculation. Lines
     * sharing the same partId are summed, so duplicate part lines are
     * treated as one combined requirement.
     *
     * ALL positive deltas (deductions) are validated against live
     * stock before ANY movement is written — on a shortage nothing is
     * touched and { ok:false, shortages } is returned so the caller
     * can reject the whole edit. Only meaningful for jobs that have
     * already started issuing stock (In Progress / Waiting for Parts);
     * callers should not invoke this for jobs that haven't reached
     * that point, or for Completed/Delivered historical records.
     *
     * Returns { ok: true, applied: [{partId, name, delta}] } or
     * { ok: false, shortages: [{partId, name, available, required}] }.
     */
    async function reconcileJobInventory(existingJob, proposedJob) {
      const jobId = existingJob.id;

      // Required qty per part in the proposed lines — duplicate partId
      // lines are summed into one combined requirement.
      const required = {};
      (proposedJob.partsUsed || []).forEach(line => {
        if (!line.partId) return;                     // manual line — never touches inventory
        required[line.partId] = (required[line.partId] || 0) + (Number(line.qty) || 0);
      });

      // Union of every part currently issued or newly required, so a
      // part removed from the proposed lines still gets returned.
      const existingPartIds = (existingJob.partsUsed || []).filter(l => l.partId).map(l => l.partId);
      const partIds = Array.from(new Set([...existingPartIds, ...Object.keys(required)]));

      // Build the delta plan first — no writes yet.
      const plan = [];
      partIds.forEach(partId => {
        const issued = getIssuedQtyForJobPart(jobId, partId);
        const need = required[partId] || 0;
        const delta = need - issued;
        if (delta !== 0) plan.push({ partId, delta });
      });

      if (!plan.length) return { ok: true, applied: [] };

      // Validate every deduction against live stock BEFORE moving anything.
      const shortages = [];
      plan.forEach(({ partId, delta }) => {
        if (delta <= 0) return;
        const part = Storage.getById('parts', partId);
        const available = part ? (Number(part.stock) || 0) : 0;
        if (!part || available < delta) {
          shortages.push({ partId, name: part ? part.name : partId, available, required: delta });
        }
      });
      if (shortages.length) return { ok: false, shortages };

      // All clear — apply deltas through move(), which writes the audit
      // transaction and updates part.stock together for each line.
      const applied = [];
      for (const { partId, delta } of plan) {
        const part = Storage.getById('parts', partId);
        const name = part ? part.name : partId;
        const res = delta > 0
          ? await move({ partId, type: 'job-card-use', quantity: delta, referenceType: 'job-card', referenceId: jobId, notes: `Adjusted on ${jobId} (qty change)` })
          : await move({ partId, type: 'return', quantity: -delta, referenceType: 'job-card', referenceId: jobId, notes: `Adjusted on ${jobId} (qty change)` });
        if (res.ok) applied.push({ partId, name, delta });
      }
      return { ok: true, applied };
    }

    /** Stock status derived from quantities — never stored. */
    function stockStatus(part) {
      const stock = Number(part.stock) || 0;
      if (stock <= 0) return 'Out of Stock';
      if (stock <= (Number(part.minStock) || 0)) return 'Low Stock';
      return 'Normal';
    }

    return {
      move, history, checkJobStock, deductForJob, returnForJob, hasJobDeduction, stockStatus,
      getIssuedQtyForJobPart, reconcileJobInventory
    };
  })();

  /* ---------- reusable modal system ---------- */

  const Modal = (() => {
    let overlay = null;
    let lastFocus = null;

    function open({ title, body, footer = '', size = '' }) {
      close();
      lastFocus = document.activeElement;
      overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal ${size ? 'modal--' + size : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal__head">
            <h2>${esc(title)}</h2>
            <button class="icon-btn modal__close" data-modal-close aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
            </button>
          </div>
          <div class="modal__body">${body}</div>
          ${footer ? `<div class="modal__foot">${footer}</div>` : ''}
        </div>`;
      document.body.appendChild(overlay);
      document.body.classList.add('no-scroll');

      overlay.addEventListener('click', e => {
        if (e.target === overlay || e.target.closest('[data-modal-close]')) close();
      });
      document.addEventListener('keydown', escHandler);

      const first = overlay.querySelector('input, select, textarea, button:not(.modal__close)');
      if (first) first.focus();
      return overlay;
    }

    function escHandler(e) { if (e.key === 'Escape') close(); }

    function close() {
      if (!overlay) return;
      overlay.remove();
      overlay = null;
      document.body.classList.remove('no-scroll');
      document.removeEventListener('keydown', escHandler);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    /** Confirmation dialog. onConfirm runs when the danger button is clicked. */
    function confirm({ title = 'Are you sure?', message, confirmText = 'Delete', onConfirm }) {
      const ov = open({
        title,
        body: `<p style="margin:0">${message}</p>`,
        footer: `
          <button class="btn btn--ghost" data-modal-close>Cancel</button>
          <button class="btn btn--danger" data-confirm>${esc(confirmText)}</button>`
      });
      // The confirm button waits for onConfirm, which now usually means
      // waiting for the server. Closing first -- as this did while writes
      // were synchronous and could not fail -- would take the dialog away
      // before anyone knew whether the thing had actually been deleted, and
      // would leave a second click free to send the request twice.
      ov.querySelector('[data-confirm]').addEventListener('click', saving(async () => {
        if (onConfirm) await onConfirm();
        close();
      }));
    }

    return { open, close, confirm };
  })();

  /* ============================================================
     Writing through the Storage layer
     ------------------------------------------------------------
     A write used to be a synchronous call that could not fail:
     localStorage either took it or the browser was out of quota.
     Against the API it is a round trip that can be refused for
     reasons the browser cannot know in advance -- a duplicate
     registration the local copy had not seen yet, a job card
     someone else already invoiced, a token that is missing.

     These two helpers are what stop that difference being
     re-handled, slightly differently, at forty call sites.
     ============================================================ */

  /**
   * Run one write with `btn` held disabled until it finishes.
   *
   * The disabled control IS the duplicate-submit guard: a disabled button
   * fires no click, so the second impatient press has nothing to send. It
   * is also the only feedback the user gets that something is in flight.
   *
   * Errors are swallowed deliberately -- but never silently. A refusal the
   * caller already reported (via wrote()) needs nothing more; an unexpected
   * throw is a bug, and the user gets a plain sentence while the detail
   * goes to the console, because a stack trace in a toast helps nobody and
   * can carry a URL.
   */
  async function guard(btn, fn) {
    if (btn && btn.disabled) return;
    const label = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      await fn();
    } catch (e) {
      console.error('Write failed:', e);
      toast('Something went wrong. Please try again.', 'error');
    } finally {
      if (btn) { btn.disabled = false; if (label !== null) btn.textContent = label; }
    }
  }

  /**
   * Wrap a click handler that performs a write; the control is taken from
   * the event. Use guard() directly when the listener is delegated and the
   * button being clicked is not the one the listener sits on.
   */
  function saving(handler) {
    let busy = false;
    return async function (ev) {
      if (busy) return;
      busy = true;
      try {
        await guard(ev && (ev.currentTarget || ev.target), () => handler(ev));
      } finally {
        busy = false;
      }
    };
  }

  /**
   * Report a write's outcome and say whether it succeeded, so a caller
   * reads: `if (!Utils.wrote(res, form)) return;`
   *
   * A 422 carries a field map in the same shape the local validate()
   * functions produce, so the server's objection lands on the same input
   * the browser's own would have.
   */
  function wrote(res, form = null) {
    if (res && res.ok) {
      // The write landed, but something the server ALSO changed could not be
      // re-read. Saying so beats letting the screen quietly disagree with the
      // database -- the figure most likely affected is a balance or a stock
      // level, which is exactly the kind a user acts on.
      if (res.stale && res.stale.length) {
        toast('Saved, but this page could not be refreshed. Reload to see the latest.', 'warning');
      }
      return true;
    }
    const fields = res && res.fields;
    if (fields && form && form.querySelectorAll) {
      form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
      form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
      Object.entries(fields).forEach(([key, msg]) => {
        const errEl = form.querySelector(`[data-err="${key}"]`);
        if (errEl) {
          errEl.textContent = msg;
          const field = errEl.closest('.field');
          if (field) field.classList.add('field--error');
        }
      });
    }
    toast((res && res.message) || 'Could not save. Please try again.', 'error');
    return false;
  }

  return {
    money, fmtDate, fmtTime, todayStr, toDateStr, esc, badge, invoiceStatusLabel, toast, Modal,
    saving, guard, wrote,
    liveJobBalance, jobAdvances, liveJobPaid, liveJobDue, sumJobsDue, sumJobsPaid,
    customerName, mechanicName, vehicleLabel, vehicleReg, serviceName,
    ACTIVE_JOB_STATUSES, DONE_JOB_STATUSES,
    getMechanicJobs, getMechanicActiveJobs, getMechanicCompletedJobs, getMechanicRevenue,
    Inventory
  };
})();
