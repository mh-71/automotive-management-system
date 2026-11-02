/* ============================================================
   payments.js — Payment Management module
   Payments are the SOURCE OF TRUTH for an Invoice's paid/due/status.
   invoices.js is never modified by this file's logic -- Invoice
   balances are kept in sync purely through the public Storage API
   (Storage.getById/updateData on 'invoices'), the same way Invoices
   already update Job Cards and Job Cards already update Appointments.

   Model:
   - A Payment can be linked to an Invoice (invoiceId set) or be an
     ADVANCE with no invoice yet (invoiceId: null), optionally tied to
     the jobCardId it was taken for. The one automatic link is invoice
     creation: an advance recorded against a job card (same customer,
     not yet invoiced) is applied to that job card's new invoice, whole
     or not at all (invoices.js / POST /api/invoices). Every other link
     is the explicit "Link to Invoice" action the user takes.
   - Once created, a Payment's amount/date/method/invoiceId/jobCardId
     are locked. Only `notes` stays editable. Void replaces deletion
     as the correction mechanism (mirrors Job Cards/Invoices); delete
     is only allowed once a payment is already Void.
   - Whenever a payment affecting an invoice is created, voided, or
     linked/unlinked, that invoice's paid/due/status are recomputed
     from scratch as sum(non-void payments for that invoiceId) --
     never trusted as a stale field.
   - Job Card's own paid/due fields are a frozen historical snapshot
     from before invoicing and are never read or written here.

   Storage: uses Storage.getData/getById/addData/updateData/deleteData
   exclusively -- no direct localStorage access.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal } = Utils;

  const METHODS = ['Cash', 'Card', 'Mobile Banking', 'Bank Transfer'];

  let searchTerm = '';
  let fStatus = 'all', fMethod = 'all', fType = 'all', fDate = '';
  let sortBy = 'date-desc';

  /* ---------- safe lookups ---------- */

  const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
  const custPhone = id => (Storage.getById('customers', id) || {}).phone || 'N/A';
  const veh = id => Storage.getById('vehicles', id);
  const vehText = id => { const v = veh(id); return v ? `${v.brand} ${v.model}` : 'Unknown Vehicle'; };
  const vehReg = id => { const v = veh(id); return v ? v.regNo : 'N/A'; };

  /* ---------- status derivation (intentionally duplicated from invoices.js
     rather than imported, so invoices.js is never touched by this module) ---------- */

  function deriveInvoiceStatus(total, paid) {
    const t = Number(total) || 0;
    const p = Math.max(0, Number(paid) || 0);
    if (t > 0 && p >= t) return 'Paid';
    if (p > 0) return 'Partial';
    return 'Unpaid';
  }

  /** Sum of non-void payment amounts currently linked to an invoice. */
  function sumActivePayments(invoiceId, excludePaymentId = null) {
    return Storage.getData('payments')
      .filter(p => p.invoiceId === invoiceId && p.status !== 'Void' && p.id !== excludePaymentId)
      .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  }

  /**
   * Sum of an invoice's Active write-offs (0002). Not cash: it only reduces
   * what is still owed. Always 0 offline, where write-offs do not exist.
   */
  function sumActiveWriteOffs(invoiceId) {
    return Storage.getData('invoiceAdjustments')
      .filter(a => a.invoiceId === invoiceId && a.status !== 'Void')
      .reduce((s, a) => s + (Number(a.amount) || 0), 0);
  }

  /**
   * Live outstanding balance for an invoice, computed from payments and
   * write-offs -- never from a stale field. Same arithmetic as the server's
   * recompute: cash capped at the total, write-offs capped at what is left.
   */
  function outstandingBalance(invoiceId) {
    const inv = Storage.getById('invoices', invoiceId);
    if (!inv) return 0;
    const total = Number(inv.total) || 0;
    const paid = Math.min(total, sumActivePayments(invoiceId));
    const writtenOff = Math.min(total - paid, sumActiveWriteOffs(invoiceId));
    return Math.max(total - paid - writtenOff, 0);
  }

  /**
   * Recomputes and writes an invoice's paid/due/status from scratch, based
   * on its currently non-void linked payments. Skipped entirely for a Void
   * invoice (a voided invoice's numbers are frozen, not reactivated by a
   * payment change). This is the ONLY way this module ever touches the
   * 'invoices' collection -- via Storage.updateData, exactly like Invoices
   * already update Job Cards.
   */
  /**
   * Local mode only.
   *
   * With a backend this cannot happen from here and must not: an invoice's
   * paid/due are refused by name on PUT /api/invoices, because they are a
   * cache of its payments rather than a field. The server recomputes them
   * with this same arithmetic, in the same transaction as the payment that
   * moved them -- which is what stops two concurrent payments both reading
   * the same balance and both fitting.
   */
  function recomputeInvoiceBalance(invoiceId) {
    if (!invoiceId) return;
    if (Storage.isApi()) return;
    const inv = Storage.getById('invoices', invoiceId);
    if (!inv || inv.status === 'Void') return;
    const total = Number(inv.total) || 0;
    const sum = sumActivePayments(invoiceId);
    const paid = Math.min(total, Math.max(0, sum));
    const due = Math.max(total - paid, 0);
    Storage.updateData('invoices', invoiceId, { paid, due, status: deriveInvoiceStatus(total, paid) });
  }

  /* ---------- validation ---------- */

  /**
   * Validates a proposed payment before it's written. Returns
   * { ok: true, invoice? } or { ok: false, reason }.
   * excludePaymentId lets a re-validation (e.g. before linking) ignore the
   * payment's own prior contribution when it's already counted elsewhere.
   */
  /** The job card's live (non-Void) invoice, or null. */
  function liveInvoiceForJob(jobCardId) {
    return Storage.getData('invoices').find(i => i.jobCardId === jobCardId && i.status !== 'Void') || null;
  }

  function validatePayment({ invoiceId, customerId, jobCardId, amount }, excludePaymentId = null) {
    const amt = Number(amount);
    if (!amt || amt <= 0) return { ok: false, reason: 'Amount must be greater than 0.' };

    const customer = customerId ? Storage.getById('customers', customerId) : null;
    if (!customer) return { ok: false, reason: 'A valid customer is required.' };

    if (jobCardId) {
      const job = Storage.getById('jobCards', jobCardId);
      if (!job) return { ok: false, reason: 'That Job Card no longer exists.' };
      // The server's job card guards (createPayment / linkPayment), mirrored:
      // a payment never ties one customer's money to another customer's job,
      // and an advance is money taken BEFORE invoicing -- once the job card
      // has a live invoice, money for it is a payment against that invoice.
      if (job.customerId !== customerId) {
        return { ok: false, reason: 'This Job Card belongs to a different customer.' };
      }
      const live = !invoiceId && liveInvoiceForJob(jobCardId);
      if (live) {
        return { ok: false, reason: `This Job Card is already invoiced (${live.id}). Record the payment against the invoice instead.` };
      }
    }

    if (invoiceId) {
      const invoice = Storage.getById('invoices', invoiceId);
      if (!invoice) return { ok: false, reason: 'That invoice no longer exists.' };
      if (invoice.status === 'Void') return { ok: false, reason: 'Cannot record a payment against a Void invoice.' };
      if (invoice.customerId !== customerId) return { ok: false, reason: 'This invoice belongs to a different customer.' };
      const total = Number(invoice.total) || 0;
      const already = sumActivePayments(invoiceId, excludePaymentId);
      const liveDue = Math.max(total - already - sumActiveWriteOffs(invoiceId), 0);
      if (amt > liveDue) {
        return { ok: false, reason: `This would overpay the invoice. Outstanding due is ${money(liveDue)}.` };
      }
      return { ok: true, invoice };
    }

    // Advance payment -- no invoice to validate against.
    return { ok: true, invoice: null };
  }

  /* ---------- create ---------- */

  /**
   * Records a new payment. Either linked to an existing invoice (invoiceId
   * set) or as an advance (invoiceId null). Validates fully before writing
   * anything; on failure, nothing is created and no invoice is touched.
   */
  function recordPayment({ invoiceId, customerId, jobCardId, date, amount, method, notes }) {
    const check = validatePayment({ invoiceId, customerId, jobCardId, amount });
    if (!check.ok) return check;

    // On the server the payment and its invoice's new balance are one batch,
    // and the overpayment rule is the INSERT's own WHERE rather than a check
    // that could be raced. So this sends the payment and nothing else; the
    // invoice comes back re-read, not recalculated here.
    if (Storage.serverRules()) {
      return (async () => {
        // `status` is deliberately absent: the API refuses it by name, because
        // a payment is born Active and leaves that state only through the void
        // operation, which carries its own rule and its own invoice
        // recomputation. The local branch below keeps it -- offline there is no
        // server to set it.
        const res = await Storage.create('payments', {
          invoiceId: invoiceId || null,
          customerId,
          jobCardId: jobCardId || null,
          date: date || Utils.todayStr(),
          amount: Number(amount),
          method: METHODS.includes(method) ? method : 'Cash',
          notes: (notes || '').trim()
        });
        if (!res.ok) return { ok: false, reason: res.message, response: res };
        // Offline: PENDING. Kept apart from the confirmed payments -- no
        // invoice balance or advance moves until the server accepts it.
        if (res.pending) return { ok: true, pending: true, payment: res.record };
        const stale = res.record.invoiceId ? await Storage.refreshAll('invoices') : [];
        return { ok: true, payment: res.record, ...(stale.length ? { stale } : {}) };
      })();
    }

    const payment = Storage.addData('payments', {
      invoiceId: invoiceId || null,
      customerId,
      jobCardId: jobCardId || null,
      date: date || Utils.todayStr(),
      amount: Number(amount),
      method: METHODS.includes(method) ? method : 'Cash',
      notes: (notes || '').trim(),
      status: 'Active'
    });

    if (payment.invoiceId) recomputeInvoiceBalance(payment.invoiceId);
    return { ok: true, payment };
  }

  /** Links an existing advance payment to a real invoice. Never fabricates a link -- the invoice must already exist. */
  function linkPaymentToInvoice(paymentId, invoiceId) {
    const payment = Storage.getById('payments', paymentId);
    if (!payment) return { ok: false, reason: 'Payment not found.' };
    if (payment.status === 'Void') return { ok: false, reason: 'Cannot link a voided payment.' };
    if (payment.invoiceId) return { ok: false, reason: 'This payment is already linked to an invoice.' };

    const check = validatePayment({
      invoiceId, customerId: payment.customerId, jobCardId: payment.jobCardId, amount: payment.amount
    });
    if (!check.ok) return check;

    if (Storage.isApi()) {
      // A named action, not a field change: linking re-checks the invoice's
      // room for THIS payment's amount, read from the stored row rather than
      // the request, and moves the balance in the same transaction.
      return Storage.action('payments', paymentId, 'link', { invoiceId }, ['invoices'])
        .then(res => res.ok ? { ok: true }
                            : { ok: false, reason: res.message, response: res });
    }

    Storage.updateData('payments', paymentId, { invoiceId });
    recomputeInvoiceBalance(invoiceId);
    return { ok: true };
  }

  /** Void a payment (soft-cancel). Recomputes the linked invoice, if any, to exclude it. */
  function voidPayment(id) {
    const payment = Storage.getById('payments', id);
    if (!payment) return { ok: false, reason: 'Payment not found.' };
    if (payment.status === 'Void') return { ok: false, reason: 'Payment is already void.' };

    if (Storage.isApi()) {
      return Storage.action('payments', id, 'void', {},
        payment.invoiceId ? ['invoices'] : [])
        .then(res => res.ok ? { ok: true }
                            : { ok: false, reason: res.message, response: res });
    }

    Storage.updateData('payments', id, { status: 'Void' });
    if (payment.invoiceId) recomputeInvoiceBalance(payment.invoiceId);
    return { ok: true };
  }

  /* ---------- eligible invoices for a customer (for pickers) ---------- */

  /** Non-void invoices for a customer that still have an outstanding balance. */
  function payableInvoicesFor(customerId) {
    return Storage.getData('invoices')
      .filter(i => i.customerId === customerId && i.status !== 'Void' && outstandingBalance(i.id) > 0);
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const payments = Storage.getData('payments');
    const active = payments.filter(p => p.status !== 'Void');
    const today = Utils.todayStr();
    const totalCollected = active.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const todayCollected = active.filter(p => (p.date || '').slice(0, 10) === today).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const outstandingAdvances = active.filter(p => !p.invoiceId).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const voidCount = payments.filter(p => p.status === 'Void').length;

    const stats = [
      { label: 'Total Payments', value: payments.length, tone: 'info', icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z' },
      { label: 'Total Collected', value: money(totalCollected), tone: 'good', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: "Today's Collections", value: money(todayCollected), tone: 'good', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
      { label: 'Outstanding Advances', value: money(outstandingAdvances), tone: 'amber', icon: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z' },
      { label: 'Voided', value: voidCount, tone: 'bad', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z' }
    ];

    document.getElementById('payStats').innerHTML = stats.map(s => `
      <div class="stat">
        <div class="stat__icon stat__icon--${s.tone}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${s.icon}"/></svg>
        </div>
        <div>
          <div class="stat__value">${s.value}</div>
          <div class="stat__label">${s.label}</div>
        </div>
      </div>`).join('');
  }

  /* ---------- list ---------- */

  function filteredPayments() {
    const term = searchTerm.trim().toLowerCase();
    let rows = Storage.getData('payments').filter(p => {
      if (fStatus !== 'all' && p.status !== fStatus) return false;
      if (fMethod !== 'all' && p.method !== fMethod) return false;
      if (fType === 'advance' && p.invoiceId) return false;
      if (fType === 'invoice' && !p.invoiceId) return false;
      if (fDate && p.date !== fDate) return false;
      if (term) {
        const hay = [p.id, p.invoiceId, p.jobCardId, custName(p.customerId)].join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });

    rows.sort((a, b) => {
      switch (sortBy) {
        case 'date-asc': return (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id);
        case 'id': return a.id.localeCompare(b.id);
        case 'customer': return custName(a.customerId).localeCompare(custName(b.customerId));
        case 'amount-desc': return (Number(b.amount) || 0) - (Number(a.amount) || 0);
        default: return (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id); // date-desc
      }
    });
    return rows;
  }

  function renderList() {
    const rows = filteredPayments();
    const total = Storage.getData('payments').length;
    const tbody = document.getElementById('payTableBody');
    const isFiltered = searchTerm || fStatus !== 'all' || fMethod !== 'all' || fType !== 'all' || fDate;

    document.getElementById('payCount').textContent =
      isFiltered ? `${rows.length} of ${total} payments` : `${total} payments`;

    if (!rows.length) {
      tbody.innerHTML = `
        <tr><td colspan="9">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/></svg>
            <h3>${isFiltered ? 'No payments match your search or filter.' : 'No payments recorded yet.'}</h3>
            <p>${isFiltered ? 'Try a different filter.' : 'Record a payment against an invoice, or as an advance before one exists.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">Record Payment</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(p => `
      <tr data-id="${esc(p.id)}">
        <td class="cell-main">${esc(p.id)}</td>
        <td>${fmtDate(p.date)}</td>
        <td class="cell-main">${esc(custName(p.customerId))}</td>
        <td>${p.invoiceId ? `<a href="invoices.html?view=${encodeURIComponent(p.invoiceId)}">${esc(p.invoiceId)}</a>` : `<span class="badge badge--warn">Advance</span>`}</td>
        <td>${p.jobCardId ? `<a href="job-cards.html?view=${encodeURIComponent(p.jobCardId)}">${esc(p.jobCardId)}</a>` : '—'}</td>
        <td class="num">${money(p.amount)}</td>
        <td>${esc(p.method)}</td>
        <td>${badge(p.status)}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            <button class="icon-btn icon-btn--sm" data-action="view" title="View" aria-label="View ${esc(p.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="print" title="Print" aria-label="Print ${esc(p.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 8H5c-1.7 0-3 1.3-3 3v6h4v4h12v-4h4v-6c0-1.7-1.3-3-3-3zm-3 11H8v-5h8v5zm3-7c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm-1-9H6v4h12V3z"/></svg>
            </button>
            ${p.status !== 'Void' ? `
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="void" title="Void" aria-label="Void ${esc(p.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z"/></svg>
            </button>` : `
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(p.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>`}
          </div>
        </td>
      </tr>`).join('');
  }

  /* ---------- record payment modal ---------- */

  function invoiceOptions(customerId, selected) {
    const invoices = customerId ? payableInvoicesFor(customerId) : [];
    if (!invoices.length) return `<option value="">— No invoices with a balance due —</option>`;
    return `<option value="">— Select invoice —</option>` + invoices.map(i =>
      `<option value="${esc(i.id)}"${i.id === selected ? ' selected' : ''}>${esc(i.id)} — Due ${money(outstandingBalance(i.id))}</option>`
    ).join('');
  }

  /**
   * The job cards an advance can be recorded against: this customer's, not
   * Cancelled, and not yet invoiced (an invoiced job card takes payments
   * against its invoice instead -- the server refuses an advance for it).
   */
  function jobCardOptions(customerId, selected) {
    const jobs = customerId
      ? Storage.getData('jobCards').filter(j =>
          j.customerId === customerId && j.status !== 'Cancelled' && !liveInvoiceForJob(j.id))
      : [];
    return `<option value="">— None —</option>` + jobs.map(j =>
      `<option value="${esc(j.id)}"${j.id === selected ? ' selected' : ''}>${esc(j.id)} (${esc(j.status)})</option>`
    ).join('');
  }

  /* ---------- searchable customer picker ----------
     The interaction and .cust-combo styles of New Job Card's picker
     (job-cards.js). A hidden input keeps id="pf-customer" and
     name="customerId", so the save handler and the invoice / job card
     cascade read exactly what the old <select> carried: the customer's id.
     The search runs over the customers already loaded on this page. */
  const CUSTOMER_LIST_LIMIT = 50;
  const digitsOf = s => String(s || '').replace(/\D/g, '');

  function customerLabel(c) {
    return c ? [c.name, c.phone].filter(Boolean).join(' — ') : '';
  }

  function customerPickerHtml(selected) {
    const c = selected ? Storage.getById('customers', selected) : null;
    return `
      <label for="pf-customer-search">Customer <span class="req">*</span></label>
      <div class="cust-combo">
        <input type="hidden" id="pf-customer" name="customerId" value="${esc(c ? c.id : '')}">
        <input class="input cust-combo__input" id="pf-customer-search" type="text" role="combobox"
               autocomplete="off" spellcheck="false" placeholder="Search customer name, phone or ID..."
               aria-autocomplete="list" aria-expanded="false" aria-controls="pf-customer-list"
               value="${esc(customerLabel(c))}">
        <button type="button" class="cust-combo__clear" aria-label="Clear customer"${c ? '' : ' hidden'}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
        <svg class="cust-combo__caret" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
        <div class="cust-combo__list" id="pf-customer-list" role="listbox" aria-label="Customers" hidden></div>
      </div>`;
  }

  /** Name, id, phone and alternate phone; a digits-only query also matches phones ignoring dashes and spaces. */
  function matchCustomers(sorted, query) {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    const digits = /^[\d\s+()-]+$/.test(q) ? digitsOf(q) : '';
    return sorted.filter(c =>
      [c.name, c.id, c.phone, c.altPhone].some(v => String(v || '').toLowerCase().includes(q)) ||
      (digits && (digitsOf(c.phone).includes(digits) || digitsOf(c.altPhone).includes(digits))));
  }

  function customerOptionHtml(c, i) {
    const phones = [c.phone, c.altPhone].filter(Boolean).map(esc).join(' / ');
    return `
      <div class="cust-combo__opt" id="pf-cust-opt-${i}" role="option" aria-selected="false" data-id="${esc(c.id)}">
        <span class="cust-combo__name">${esc(c.name)}</span>
        <span class="cust-combo__meta">${esc(c.id)}${phones ? ` • ${phones}` : ''}</span>
      </div>`;
  }

  /** Wire the picker. Choosing a customer sets the hidden input and fires its change event, as the <select> did. */
  function bindCustomerPicker(ov) {
    const hidden = ov.querySelector('#pf-customer');
    const input = ov.querySelector('#pf-customer-search');
    const list = ov.querySelector('#pf-customer-list');
    const clearBtn = ov.querySelector('.cust-combo__clear');
    if (!hidden || !input || !list || !clearBtn || typeof input.setAttribute !== 'function') return;

    const sorted = Storage.getData('customers').slice().sort((a, b) => a.name.localeCompare(b.name));
    let shown = [];
    let active = -1;

    const current = () => (hidden.value && Storage.getById('customers', hidden.value)) || null;

    function showSelected() {
      const c = current();
      input.value = customerLabel(c);
      clearBtn.hidden = !c;
    }

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    }

    function highlight(i) {
      const opts = list.querySelectorAll('[role="option"]');
      if (!opts.length) return;
      active = Math.max(0, Math.min(i, opts.length - 1));
      opts.forEach((o, k) => {
        o.classList.toggle('is-active', k === active);
        o.setAttribute('aria-selected', String(k === active));
      });
      input.setAttribute('aria-activedescendant', opts[active].id);
      opts[active].scrollIntoView({ block: 'nearest' });
    }

    function render(query) {
      const matches = matchCustomers(sorted, query);
      shown = matches.slice(0, CUSTOMER_LIST_LIMIT);
      list.innerHTML = shown.length
        ? shown.map(customerOptionHtml).join('') +
          (matches.length > shown.length
            ? `<div class="cust-combo__note">Showing ${shown.length} of ${matches.length} — keep typing to narrow the list.</div>`
            : '')
        : `<div class="cust-combo__note">No customers found</div>`;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      // on short screens scroll the modal just enough that the list is not cut off at its bottom edge
      list.scrollIntoView({ block: 'nearest' });
      active = -1;
      input.removeAttribute('aria-activedescendant');
      if (query.trim()) highlight(0);
      else {
        const sel = shown.findIndex(c => c.id === hidden.value);
        if (sel !== -1) highlight(sel);
      }
    }

    function choose(id) {
      const changed = hidden.value !== id;
      hidden.value = id;
      showSelected();
      close();
      if (changed) hidden.dispatchEvent(new Event('change'));
    }

    input.addEventListener('focus', () => { render(''); input.select(); });
    input.addEventListener('click', () => { if (list.hidden) render(''); });
    input.addEventListener('input', () => render(input.value));
    input.addEventListener('blur', () => {
      // emptied and left → the same as pressing ×; otherwise put the selection back
      if (!input.value.trim() && hidden.value) choose('');
      else { showSelected(); close(); }
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (list.hidden) { render(''); return; }
        highlight(active === -1 ? 0 : active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter') {
        if (list.hidden) return;
        e.preventDefault();
        if (active !== -1 && shown[active]) choose(shown[active].id);
      } else if (e.key === 'Escape' && !list.hidden) {
        // close the list only -- the modal's own Escape must not fire too
        e.preventDefault();
        e.stopPropagation();
        showSelected();
        close();
      }
    });
    // keep focus in the input while picking, so blur does not close the list first
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => {
      const opt = e.target.closest('[data-id]');
      if (opt) choose(opt.dataset.id);
    });
    clearBtn.addEventListener('click', () => { choose(''); input.focus(); });
  }

  function methodOptions(selected) {
    return METHODS.map(m => `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(m)}</option>`).join('');
  }

  /** Presentation only: the scope class for its styles, a header icon and a subtitle. */
  function decorateRecordModal(ov) {
    const modal = ov.querySelector('.modal');
    const title = modal && modal.querySelector('.modal__head h2');
    if (!title || typeof modal.setAttribute !== 'function') return;
    modal.classList.add('pay-rec');
    title.insertAdjacentHTML('beforebegin', '<span class="pay-rec__icon" aria-hidden="true"></span>');
    const titles = document.createElement('div');
    titles.className = 'pay-rec__titles';
    title.before(titles);
    titles.append(title);
    titles.insertAdjacentHTML('beforeend', '<p class="pay-rec__sub" id="pay-rec-sub">Add a new payment received from a customer</p>');
    modal.setAttribute('aria-describedby', 'pay-rec-sub');
  }

  /**
   * forInvoiceId presets a payment against that invoice; advanceForJobCardId
   * presets an advance for that job card (its customer and the job card
   * chosen). An advance's amount is never pre-filled: it is what the customer
   * actually handed over, which only the person taking it knows.
   */
  function openRecordModal({ forInvoiceId = '', advanceForJobCardId = '' } = {}) {
    const presetInvoice = forInvoiceId ? Storage.getById('invoices', forInvoiceId) : null;
    const presetJob = !presetInvoice && advanceForJobCardId ? Storage.getById('jobCards', advanceForJobCardId) : null;
    const initialType = presetInvoice ? 'invoice' : 'advance';
    const initialCustomer = presetInvoice ? presetInvoice.customerId : (presetJob ? presetJob.customerId : '');

    const ov = Modal.open({
      title: 'Record Payment', size: 'lg',
      body: `
        <div class="form-grid">
          <div class="field">
            <label for="pf-type">Payment Type</label>
            <select class="select" id="pf-type" name="type">
              <option value="invoice"${initialType === 'invoice' ? ' selected' : ''}>Against an Invoice</option>
              <option value="advance"${initialType === 'advance' ? ' selected' : ''}>Advance (no invoice yet)</option>
            </select>
          </div>
          <div class="field">
            ${customerPickerHtml(initialCustomer)}
            <div class="field__error" data-err="customerId"></div>
          </div>
          <div class="field" id="pf-invoice-wrap">
            <label for="pf-invoice">Invoice</label>
            <select class="select" id="pf-invoice" name="invoiceId">${invoiceOptions(initialCustomer, forInvoiceId)}</select>
            <div class="field__error" data-err="invoiceId"></div>
          </div>
          <div class="field" id="pf-jobcard-wrap" ${initialType === 'invoice' ? 'hidden' : ''}>
            <label for="pf-jobcard">Job Card <span class="pay-rec__opt">(optional)</span></label>
            <select class="select" id="pf-jobcard" name="jobCardId">${jobCardOptions(initialCustomer, presetJob ? presetJob.id : '')}</select>
          </div>
          <div class="field">
            <label for="pf-amount">Amount</label>
            <div class="pay-rec__money">
              <span class="pay-rec__cur" aria-hidden="true">${esc(Storage.getSettings().currency || '৳')}</span>
              <input class="input" id="pf-amount" name="amount" type="number" min="0" step="50" placeholder="Enter amount"
                     value="${presetInvoice ? outstandingBalance(presetInvoice.id) : ''}">
            </div>
            <div class="field__error" data-err="amount"></div>
          </div>
          <div class="field">
            <label for="pf-date">Date</label>
            <input class="input" id="pf-date" name="date" type="date" value="${esc(Utils.todayStr())}">
          </div>
          <div class="field">
            <label for="pf-method">Method</label>
            <select class="select" id="pf-method" name="method">${methodOptions('Cash')}</select>
          </div>
          <div class="field span-2">
            <label for="pf-notes">Notes <span class="pay-rec__opt">(optional)</span></label>
            <textarea class="input" id="pf-notes" name="notes" rows="2" placeholder="Add any notes about this payment..."></textarea>
          </div>
        </div>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Record Payment</button>`
    });

    decorateRecordModal(ov);
    bindCustomerPicker(ov);
    const typeSel = ov.querySelector('#pf-type');
    const custSel = ov.querySelector('#pf-customer');
    const invWrap = ov.querySelector('#pf-invoice-wrap');
    const invSel = ov.querySelector('#pf-invoice');
    const jobWrap = ov.querySelector('#pf-jobcard-wrap');
    const jobSel = ov.querySelector('#pf-jobcard');

    function syncTypeVisibility() {
      const isInvoice = typeSel.value === 'invoice';
      invWrap.hidden = !isInvoice;
      jobWrap.hidden = isInvoice;
    }
    function syncCustomerDependents() {
      invSel.innerHTML = invoiceOptions(custSel.value, '');
      jobSel.innerHTML = jobCardOptions(custSel.value, '');
    }
    typeSel.addEventListener('change', syncTypeVisibility);
    custSel.addEventListener('change', syncCustomerDependents);
    syncTypeVisibility();

    function showErrors(reason) {
      ov.querySelectorAll('.field__error').forEach(e => e.textContent = '');
      toast(reason, 'error');
    }

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const type = typeSel.value;
      const customerId = custSel.value;
      const invoiceId = type === 'invoice' ? invSel.value : '';
      const jobCardId = type === 'advance' ? jobSel.value : '';
      const amount = ov.querySelector('#pf-amount').value;
      const date = ov.querySelector('#pf-date').value;
      const method = ov.querySelector('#pf-method').value;
      const notes = ov.querySelector('#pf-notes').value;

      if (type === 'invoice' && !invoiceId) { showErrors('Please select an invoice.'); return; }
      if (!customerId) { showErrors('Please select a customer.'); return; }

      const result = await recordPayment({ invoiceId: invoiceId || null, customerId, jobCardId: jobCardId || null, date, amount, method, notes });
      if (!result.ok) { showErrors(result.reason); return; }

      Modal.close();
      refresh();
      if (result.pending) {
        toast(`Payment ${result.payment.id} saved offline as PENDING. It is not confirmed, and no balance changes, until the server accepts it.`, 'info');
        return;
      }
      if (result.stale && result.stale.length) Utils.wrote(result);
      else toast(`Payment ${result.payment.id} recorded for ${custName(result.payment.customerId)}.`);
      openDetailModal(result.payment.id);
    }));
  }

  /* ---------- link-to-invoice modal (for an unlinked advance) ---------- */

  function openLinkModal(id) {
    const payment = Storage.getById('payments', id);
    if (!payment) return;
    const eligible = payableInvoicesFor(payment.customerId);
    if (!eligible.length) {
      Modal.open({
        title: 'No eligible invoices',
        body: `<p style="margin:0">${esc(custName(payment.customerId))} has no invoice with an outstanding balance to link this payment to.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    const ov = Modal.open({
      title: `Link Payment ${payment.id} to an Invoice`,
      body: `
        <p class="muted-note" style="margin-top:0">Amount: <strong>${money(payment.amount)}</strong> — only invoices belonging to ${esc(custName(payment.customerId))} with a balance due are shown.</p>
        <div class="field">
          <label for="pf-link-invoice">Invoice</label>
          <select class="select" id="pf-link-invoice">${invoiceOptions(payment.customerId, '')}</select>
          <div class="field__error" data-err="invoiceId"></div>
        </div>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Link Payment</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const invoiceId = ov.querySelector('#pf-link-invoice').value;
      if (!invoiceId) { toast('Please select an invoice.', 'error'); return; }
      const result = await linkPaymentToInvoice(id, invoiceId);
      if (!result.ok) { toast(result.reason, 'error'); return; }
      Modal.close();
      refresh();
      toast(`Payment ${id} linked to ${invoiceId}.`);
      openDetailModal(id);
    }));
  }

  /* ---------- notes edit ---------- */

  function openNotesModal(id) {
    const payment = Storage.getById('payments', id);
    if (!payment) return;
    const ov = Modal.open({
      title: `Edit Notes — ${payment.id}`,
      body: `<div class="field"><label for="pf-notes-edit">Notes</label>
             <textarea class="input" id="pf-notes-edit" rows="3">${esc(payment.notes || '')}</textarea></div>
             <p class="muted-note" style="margin-top:8px">Only notes can be edited on a recorded payment. Use Void if the payment itself was wrong.</p>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Notes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      // notes is the only editable field: amount, date, method and both links
      // are historical, and the API refuses each of them by name.
      const res = await Storage.update('payments', id, { notes: ov.querySelector('#pf-notes-edit').value });
      if (!Utils.wrote(res, ov)) return;
      Modal.close();
      refresh();
      toast(`Payment ${id} notes updated.`);
    }));
  }

  /* ---------- void / delete ---------- */

  function openVoidModal(id) {
    const payment = Storage.getById('payments', id);
    if (!payment) return;
    Modal.confirm({
      title: 'Void payment?',
      message: `Void <strong>${esc(payment.id)}</strong> (${money(payment.amount)}) for ${esc(custName(payment.customerId))}?
                ${payment.invoiceId ? `The linked invoice's balance will be recalculated without it.` : ''} This cannot be undone.`,
      confirmText: 'Void Payment',
      onConfirm: async () => {
        const res = await voidPayment(id);
        if (!res.ok) { toast(res.reason, 'error'); return; }
        refresh();
        toast(`Payment ${id} voided.`, 'warning');
      }
    });
  }

  function openDeleteModal(id) {
    const payment = Storage.getById('payments', id);
    if (!payment) return;
    if (payment.status !== 'Void') {
      Modal.open({
        title: 'Cannot delete payment',
        body: `<p style="margin:0"><strong>${esc(payment.id)}</strong> is an active financial record. Void it first if it needs to be removed from the books.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    Modal.confirm({
      title: 'Delete payment?',
      message: `Permanently delete voided payment <strong>${esc(payment.id)}</strong>? This cannot be undone.`,
      confirmText: 'Delete Payment',
      onConfirm: async () => {
        if (Storage.isApi()) {
          const res = await Storage.remove('payments', id);
          if (!Utils.wrote(res)) return;
          const stale = payment.invoiceId ? await Storage.refreshAll('invoices') : [];
          refresh();
          if (stale.length) Utils.wrote({ ok: true, stale });
          else toast(`Payment ${id} deleted.`, 'warning');
          return;
        }
        Storage.deleteData('payments', id);
        // Defensive: a Void payment is already excluded from its invoice's
        // sum, but recompute anyway in case void's recompute never ran.
        if (payment.invoiceId) recomputeInvoiceBalance(payment.invoiceId);
        refresh();
        toast(`Payment ${id} deleted.`, 'warning');
      }
    });
  }

  /* ---------- detail view ---------- */

  /** Presentation only: the scope class for its styles, a header icon and a subtitle. */
  function decorateDetailModal(ov) {
    const modal = ov.querySelector('.modal');
    const title = modal && modal.querySelector('.modal__head h2');
    if (!title || typeof modal.setAttribute !== 'function') return;
    modal.classList.add('pay-view');
    title.insertAdjacentHTML('beforebegin', '<span class="pay-view__icon" aria-hidden="true"></span>');
    const titles = document.createElement('div');
    titles.className = 'pay-view__titles';
    title.before(titles);
    titles.append(title);
    titles.insertAdjacentHTML('beforeend', '<p class="pay-view__sub" id="pay-view-sub">Payment details and related information</p>');
    modal.setAttribute('aria-describedby', 'pay-view-sub');
  }

  function openDetailModal(id) {
    const p = Storage.getById('payments', id);
    if (!p) return;
    const invoice = p.invoiceId ? Storage.getById('invoices', p.invoiceId) : null;

    const ov = Modal.open({
      title: `Payment ${p.id}`,
      body: `
        <div class="detail-grid detail-grid--3 pay-view__facts">
          <div class="detail-item pay-view__fact pay-view__fact--status"><span>Status</span><strong>${badge(p.status)}</strong></div>
          <div class="detail-item pay-view__fact pay-view__fact--date"><span>Date</span><strong>${fmtDate(p.date)}</strong></div>
          <div class="detail-item pay-view__fact pay-view__fact--method"><span>Method</span><strong>${esc(p.method)}</strong></div>
        </div>

        <section class="pay-view__card pay-view__card--ref">
          <h3 class="detail-section-title pay-view__title pay-view__title--ref">Customer &amp; Reference</h3>
          <div class="detail-grid detail-grid--3 pay-view__grid">
            <div class="detail-item pay-view__item pay-view__item--customer"><span>Customer</span><strong>${esc(custName(p.customerId))}</strong></div>
            <div class="detail-item pay-view__item pay-view__item--phone"><span>Phone</span><strong>${esc(custPhone(p.customerId))}</strong></div>
            <div class="detail-item pay-view__item pay-view__item--invoice"><span>Invoice</span><strong>${p.invoiceId ? esc(p.invoiceId) : 'Advance — not yet linked'}</strong></div>
            <div class="detail-item pay-view__item pay-view__item--jobcard"><span>Job Card</span><strong>${p.jobCardId ? esc(p.jobCardId) : '—'}</strong></div>
          </div>
        </section>

        <section class="pay-view__card pay-view__card--amount">
          <h3 class="detail-section-title pay-view__title pay-view__title--amount">Amount</h3>
          <div class="totals-panel totals-panel--view">
            <div class="totals-grand"><span>Amount Paid</span><strong>${money(p.amount)}</strong></div>
            ${invoice ? `<div><span>Invoice Total</span><strong>${money(invoice.total)}</strong></div>
            <div><span>Invoice Paid (all payments)</span><strong>${money(invoice.paid)}</strong></div>
            <div class="${Number(invoice.due) > 0 ? 'totals-due' : ''}"><span>Invoice Due</span><strong>${money(invoice.due)}</strong></div>` : ''}
          </div>
        </section>

        ${p.notes ? `<section class="pay-view__card pay-view__card--notes"><h3 class="detail-section-title pay-view__title pay-view__title--notes">Notes</h3><p class="detail-text">${esc(p.notes)}</p></section>` : ''}`,
      footer: `
        <button class="btn btn--ghost" data-print-view>Print Receipt</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        ${p.invoiceId ? `<a class="btn btn--ghost" href="invoices.html?view=${encodeURIComponent(p.invoiceId)}">View Invoice</a>` : ''}
        ${p.jobCardId ? `<a class="btn btn--ghost" href="job-cards.html?view=${encodeURIComponent(p.jobCardId)}">View Job Card</a>` : ''}
        ${!p.invoiceId && p.status !== 'Void' ? '<button class="btn btn--ghost" data-link-invoice>Link to Invoice</button>' : ''}
        ${p.status !== 'Void' ? '<button class="btn btn--ghost" data-edit-notes>Edit Notes</button>' : ''}
        ${p.status !== 'Void' ? '<button class="btn btn--primary" data-void>Void Payment</button>' : ''}`
    });
    decorateDetailModal(ov);
    document.querySelector('[data-print-view]').addEventListener('click', () => printPayment(id));
    const linkBtn = document.querySelector('[data-link-invoice]');
    if (linkBtn) linkBtn.addEventListener('click', () => { Modal.close(); openLinkModal(id); });
    const editBtn = document.querySelector('[data-edit-notes]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openNotesModal(id); });
    const voidBtn = document.querySelector('[data-void]');
    if (voidBtn) voidBtn.addEventListener('click', () => { Modal.close(); openVoidModal(id); });
  }

  /* ---------- print (receipt) ---------- */

  /* The phone printed on every receipt. The Settings phone is still the
     placeholder "+880 1XXX-XXXXXX", so the receipt carries the workshop's real
     number, as the Job Card print does. */
  const RECEIPT_PHONE = '01854226757';

  function printPayment(id) {
    const p = Storage.getById('payments', id);
    if (!p) return;
    const settings = Storage.getSettings();
    const customer = Storage.getById('customers', p.customerId);
    const invoice = p.invoiceId ? Storage.getById('invoices', p.invoiceId) : null;
    const root = (document.body.dataset && document.body.dataset.root) || '../';
    const isVoid = p.status === 'Void';
    const row = (label, value) => `<div class="rcp-row"><dt>${label}</dt><dd>${value}</dd></div>`;

    const area = document.getElementById('printArea');
    area.innerHTML = `
    <div class="rcp">
      <header class="rcp-head">
        <div class="rcp-brand">
          <img class="rcp-logo" src="${root}assets/logo/logo-dark.png" alt="Taqwa Automobile">
          <div class="rcp-org">
            <div class="rcp-org__name">${esc(settings.businessName)}</div>
            <div>Phone: <strong>${RECEIPT_PHONE}</strong></div>
            ${settings.address ? `<div>${esc(settings.address)}</div>` : ''}
            ${(settings.email || settings.website) ? `<div>${[settings.email, settings.website].filter(Boolean).map(x => esc(x)).join(' · ')}</div>` : ''}
            ${settings.taxId ? `<div>Tax/VAT: ${esc(settings.taxId)}</div>` : ''}
          </div>
        </div>
        <div class="rcp-doc">
          <h2 class="rcp-doc__title">PAYMENT RECEIPT</h2>
          ${isVoid ? '<div class="rcp-void">VOID</div>' : ''}
          <dl class="rcp-meta">
            ${row('Payment No', `<strong>${esc(p.id)}</strong>`)}
            ${row('Date', fmtDate(p.date))}
            ${row('Status', esc(p.status))}
          </dl>
        </div>
      </header>

      <section class="rcp-sec">
        <h3>Customer &amp; Reference</h3>
        <dl class="rcp-grid">
          ${row('Customer', customer ? esc(customer.name) : 'Unknown Customer')}
          ${row('Phone', customer ? esc(customer.phone) : '—')}
          ${row('Payment Type', p.invoiceId ? 'Against an Invoice' : 'Advance')}
          ${row('Invoice', p.invoiceId ? esc(p.invoiceId) : 'Advance — not yet linked')}
          ${row('Job Card', p.jobCardId ? esc(p.jobCardId) : '—')}
          ${row('Payment Method', esc(p.method))}
        </dl>
      </section>

      <section class="rcp-amount">
        <div class="rcp-amount__label">Amount Received</div>
        <div class="rcp-amount__value">${money(p.amount)}</div>
      </section>
      ${invoice ? `
      <table class="rcp-inv">
        <tr><td>Invoice Total</td><td>${money(invoice.total)}</td></tr>
        <tr><td>Invoice Paid to Date</td><td>${money(invoice.paid)}</td></tr>${Number(invoice.writtenOff) > 0 ? `
        <tr><td>Adjustment</td><td>\u2212 ${money(invoice.writtenOff)}</td></tr>` : ''}
        <tr class="rcp-inv__due"><td>Invoice Due</td><td>${money(invoice.due)}</td></tr>
      </table>` : ''}

      ${p.notes ? `
      <section class="rcp-sec rcp-notes">
        <h3>Notes</h3>
        <p>${esc(p.notes)}</p>
      </section>` : ''}

      <footer class="rcp-foot">
        <p class="rcp-foot__thanks">${esc(settings.invoiceFooter)}</p>
        <p>${esc(settings.businessName)} · Phone: ${RECEIPT_PHONE}</p>
      </footer>
    </div>`;

    // Print once the logo has loaded, so it is on the page that gets printed.
    document.body.classList.add('printing-payment');
    const go = () => {
      window.print();
      setTimeout(() => document.body.classList.remove('printing-payment'), 300);
    };
    const logo = area.querySelector ? area.querySelector('.rcp-logo') : null;
    if (logo && !logo.complete) {
      logo.addEventListener('load', go, { once: true });
      logo.addEventListener('error', go, { once: true });
    } else {
      go();
    }
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addPaymentBtn').addEventListener('click', () => openRecordModal());
    document.getElementById('paySearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('payStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('payMethod').addEventListener('change', e => { fMethod = e.target.value; renderList(); });
    document.getElementById('payType').addEventListener('change', e => { fType = e.target.value; renderList(); });
    document.getElementById('payDate').addEventListener('change', e => { fDate = e.target.value; renderList(); });
    document.getElementById('paySort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('payTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openRecordModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'print') printPayment(id);
      if (action === 'void') openVoidModal(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const forInvoice = params.get('forInvoice');
    const advanceFor = params.get('advanceFor');
    const filterInvoice = params.get('invoice');
    if (viewId && Storage.getById('payments', viewId)) {
      openDetailModal(viewId);
    } else if (forInvoice && Storage.getById('invoices', forInvoice)) {
      openRecordModal({ forInvoiceId: forInvoice });
    } else if (advanceFor && Storage.getById('jobCards', advanceFor)) {
      const live = liveInvoiceForJob(advanceFor);
      if (live && live.status === 'Paid') {
        toast(`${advanceFor} is already invoiced (${live.id}) and fully paid.`, 'warning');
      } else if (live) {
        toast(`${advanceFor} is already invoiced (${live.id}). Record the payment against the invoice instead.`, 'warning');
        openRecordModal({ forInvoiceId: live.id });
      } else {
        openRecordModal({ advanceForJobCardId: advanceFor });
      }
    } else if (filterInvoice) {
      searchTerm = filterInvoice;
      document.getElementById('paySearch').value = filterInvoice;
      renderList();
    }
  });

})();
