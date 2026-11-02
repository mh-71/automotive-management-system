/* ============================================================
   job-cards.js — Job Cards Management module
   The central workshop transaction record.

   Conventions (matching existing data consumed by Customers,
   Vehicles, Mechanics, Dashboard):
   - statuses: Received → Inspection → (Waiting for Approval) →
     In Progress → (Waiting for Parts) → Completed → Delivered,
     with Cancelled branches. "Waiting for Approval" plays the
     spec's "Waiting for Customer" role.
   - flat money fields: subtotal, tax, total, paid, due,
     labourCost, discount, taxRate (existing modules read these)
   - services[]: { serviceId, name, qty, unitPrice, total } —
     name + unitPrice are SNAPSHOTS; catalog changes never
     rewrite history.
   - partsUsed[]: { partId|null, name, partNo, qty, unitPrice,
     total } — manual entry until the Inventory module lands;
     partId is the future integration point.
   - mileage = mileage-in (existing field name), mileageOut new.
   - appointmentId / invoiceId are the integration hooks.
   All totals are recalculated in JS before saving — client
   totals are never trusted.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, fmtTime, todayStr, badge, toast, Modal } = Utils;

  /* ---------- status model (existing project statuses) ---------- */

  const ACTIVE = Utils.ACTIVE_JOB_STATUSES;   // Received..Waiting for Parts
  const DONE = Utils.DONE_JOB_STATUSES;       // Completed, Delivered
  const WAITING = ['Waiting for Approval', 'Waiting for Parts'];
  // Edit-lock: statuses treated as read-only historical records. Completed
  // is included alongside Delivered/Cancelled so inventory-impacting edits
  // can't slip in after work is done (Completed can still move → Delivered
  // via statusButtons(), which reads TRANSITIONS separately from this list).
  const TERMINAL = ['Completed', 'Delivered', 'Cancelled'];
  // Statuses where inventory has already started moving for this job, so an
  // edit to partsUsed must reconcile stock rather than just overwrite the
  // record. Waiting for Parts is included because it's only ever reached
  // from In Progress — by then, whatever was on the job at that point has
  // already been deducted.
  const INVENTORY_TRACKED_STATUSES = ['In Progress', 'Waiting for Parts'];

  const TRANSITIONS = {
    'Received':             ['Inspection', 'Cancelled'],
    'Inspection':           ['In Progress', 'Waiting for Approval', 'Cancelled'],
    'Waiting for Approval': ['In Progress', 'Cancelled'],
    'In Progress':          ['Waiting for Parts', 'Waiting for Approval', 'Completed', 'Cancelled'],
    'Waiting for Parts':    ['In Progress'],
    'Completed':            ['Delivered'],
    'Delivered':            [],
    'Cancelled':            []
  };

  const TRANSITION_LABELS = {
    'Inspection': 'Start Inspection', 'In Progress': 'Start Work',
    'Waiting for Approval': 'Wait: Customer', 'Waiting for Parts': 'Wait: Parts',
    'Completed': 'Complete', 'Delivered': 'Deliver', 'Cancelled': 'Cancel'
  };

  const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
  const PRIORITY_TONE = { low: 'neutral', normal: 'info', high: 'warn', urgent: 'bad' };
  const FUEL_LEVELS = ['empty', 'quarter', 'half', 'three-quarter', 'full'];
  const FUEL_LABELS = { empty: 'Empty', quarter: '1/4', half: '1/2', 'three-quarter': '3/4', full: 'Full' };

  const INSPECTION_ITEMS = ['Engine', 'Brakes', 'Tyres', 'Battery', 'Suspension', 'Lights', 'AC', 'Electrical', 'Fluids', 'Overall'];
  const INSPECTION_STATES = ['', 'OK', 'Attention', 'Critical', 'N/A'];

  const priorityBadge = p => {
    const key = p || 'normal';
    return `<span class="badge badge--${PRIORITY_TONE[key] || 'info'}">${PRIORITIES[key] || 'Normal'}</span>`;
  };

  /* ---------- state ---------- */

  let searchTerm = '';
  let fQuick = 'all', fStatus = 'all', fPriority = 'all', fMechanic = 'all', fDate = '';
  let sortBy = 'date-desc';

  /* ---------- safe lookups ---------- */

  const custName = id => (Storage.getById('customers', id) || {}).name || 'Unknown Customer';
  const custPhone = id => (Storage.getById('customers', id) || {}).phone || 'N/A';
  const veh = id => Storage.getById('vehicles', id);
  const vehText = id => { const v = veh(id); return v ? `${v.brand} ${v.model}` : 'Unknown Vehicle'; };
  const vehReg = id => { const v = veh(id); return v ? v.regNo : 'N/A'; };
  const mec = id => Storage.getById('mechanics', id);
  const mecName = id => id ? ((mec(id) || {}).name || 'Unknown Mechanic') : '—';
  const svc = id => Storage.getById('services', id);

  /* ---------- totals: single source of truth ---------- */

  /* ---------- advances (payments recorded against a job card) ---------- */

  /** The job card's live (non-Void) invoice, or null. */
  function liveInvoiceOf(job) {
    return Storage.getData('invoices').find(i => i.jobCardId === job.id && i.status !== 'Void') || null;
  }

  /** Every non-Void payment recorded against this job card, applied or not. */
  function jobPayments(jobId) {
    return Storage.getData('payments')
      .filter(p => p.jobCardId === jobId && p.status !== 'Void')
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id)));
  }

  const sumAmounts = list => list.reduce((s, p) => s + (Number(p.amount) || 0), 0);

  /** The form's line in place of the old typed Paid / Advance input. */
  function advanceNote(j) {
    const recorded = j.id ? Utils.jobAdvances(j.id) : [];
    if (recorded.length) {
      return `${money(sumAmounts(recorded))} recorded as advance (${recorded.length} payment${recorded.length > 1 ? 's' : ''}). Use Record Advance on the Job Card to add more.`;
    }
    if (Number(j.paid) > 0) {
      return `${money(j.paid)} was typed on this Job Card earlier. It is not a recorded payment. If the money was received, use Record Advance.`;
    }
    return j.id
      ? 'No advance recorded. Use Record Advance on the Job Card when the customer pays.'
      : 'Save the Job Card first, then use Record Advance when the customer pays.';
  }

  /** The details card's list of payments taken against this job card. */
  function advanceList(j) {
    const list = jobPayments(j.id);
    if (!list.length) return '';
    return `
          <div class="jcv-advances">
            <h4 class="jcv-advances__title">Payments &amp; Advances</h4>
            <ul>${list.map(p => `
              <li><a href="payments.html?view=${encodeURIComponent(p.id)}">${esc(p.id)}</a>
                · ${fmtDate(p.date)} · ${esc(p.method)} · <strong>${money(p.amount)}</strong>
                <span class="cell-sub">${p.invoiceId ? `On invoice ${esc(p.invoiceId)}` : 'Advance, not yet applied — applied when the invoice is created'}</span></li>`).join('')}
            </ul>
          </div>`;
  }

  function computeTotals(job) {
    const serviceTotal = (job.services || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const partsTotal = (job.partsUsed || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    const hours = Number(job.labourHours) || 0;
    const rate = Number(job.labourRate) || 0;
    // hours×rate wins when provided; otherwise a directly entered labourCost stands (legacy support)
    const labourCost = (hours > 0 && rate > 0) ? hours * rate : (Number(job.labourCost) || 0);
    const subtotal = serviceTotal + partsTotal + labourCost;
    const taxRate = Number(job.taxRate) || 0;
    const paid = Number(job.paid) || 0;
    let discount, tax, total;
    if (job.discountType === 'percent') {
      // worked in paisa so a discount such as 49.95 leaves no float residue in the total
      discount = percentDiscount(subtotal, Number(job.discountRate) || 0);
      const net = Math.round(subtotal * 100) - Math.round(discount * 100);
      tax = Math.round(net * taxRate / 10000);
      total = (net + tax * 100) / 100;
    } else {
      discount = Math.min(Number(job.discount) || 0, subtotal);
      tax = Math.round((subtotal - discount) * taxRate / 100);
      total = subtotal - discount + tax;
    }
    return { serviceTotal, partsTotal, labourCost, subtotal, discount, taxRate, tax, total, paid, due: Math.max(total - paid, 0) };
  }

  /** rate% of subtotal, half-up to the paisa, in integer arithmetic; the server's percentDiscount() is the same. */
  function percentDiscount(subtotal, rate) {
    const bp = Math.round(rate * 100);
    const paisa = Math.floor((Math.round(subtotal * 10000) * bp + 500000) / 1000000);
    return Math.min(paisa / 100, subtotal);
  }

  /** Custom work: a service line with no catalogue service behind it. serviceId null, never a name marker. */
  const isCustomWork = l => !!l && l.serviceId === null;

  /** Normalize line items with recalculated totals (never trust the UI). */
  function normalizeLines(lines, isService) {
    return (lines || [])
      .filter(l => (isService ? (l.serviceId || (isCustomWork(l) && (l.name || '').trim())) : (l.name || '').trim()))
      .map(l => ({
        ...(isService
          ? { serviceId: isCustomWork(l) ? null : l.serviceId, name: isCustomWork(l) ? l.name.trim() : l.name }
          : { partId: l.partId || null, name: (l.name || '').trim(), partNo: (l.partNo || '').trim() }),
        qty: Number(l.qty) || 1,
        unitPrice: Number(l.unitPrice) || 0,
        total: (Number(l.qty) || 1) * (Number(l.unitPrice) || 0)
      }));
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const jobs = Storage.getData('jobCards');
    const today = todayStr();
    const count = f => jobs.filter(f).length;
    const workshopValue = jobs.filter(j => ACTIVE.includes(j.status))
      .reduce((s, j) => s + (Number(j.total) || 0), 0);

    const stats = [
      { label: 'Total Job Cards', value: jobs.length, tone: 'info', icon: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z' },
      { label: 'Active', value: count(j => ACTIVE.includes(j.status)), tone: 'amber', icon: 'M13 2.05v2.02c3.95.49 7 3.85 7 7.93 0 4.42-3.58 8-8 8s-8-3.58-8-8c0-1.95.7-3.73 1.86-5.12L12 12V2.05h1z' },
      { label: 'In Progress', value: count(j => j.status === 'In Progress'), tone: 'info', icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z' },
      { label: 'Waiting', value: count(j => WAITING.includes(j.status)), tone: 'warn', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z' },
      { label: 'Completed / Delivered', value: count(j => DONE.includes(j.status)), tone: 'good', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Workshop Value (Active)', value: money(workshopValue), tone: 'good', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' }
    ];

    document.getElementById('jobStats').innerHTML = stats.map(s => `
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

  function filteredJobs() {
    const term = searchTerm.trim().toLowerCase();
    const today = todayStr();
    const prioRank = { urgent: 0, high: 1, normal: 2, low: 3 };

    let list = Storage.getData('jobCards').filter(j => {
      if (term) {
        const hay = `${j.id} ${j.appointmentId || ''} ${custName(j.customerId)} ${custPhone(j.customerId)} ${vehReg(j.vehicleId)} ${vehText(j.vehicleId)} ${mecName(j.mechanicId)} ${(j.services || []).map(s => s.name).join(' ')}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fStatus !== 'all' && j.status !== fStatus) return false;
      if (fPriority !== 'all' && (j.priority || 'normal') !== fPriority) return false;
      if (fMechanic !== 'all' && j.mechanicId !== fMechanic) return false;
      if (fDate && j.date !== fDate) return false;
      if (fQuick === 'today' && j.date !== today) return false;
      if (fQuick === 'active' && !ACTIVE.includes(j.status)) return false;
      if (fQuick === 'waiting' && !WAITING.includes(j.status)) return false;
      if (fQuick === 'done' && !DONE.includes(j.status)) return false;
      if (fQuick === 'cancelled' && j.status !== 'Cancelled') return false;
      return true;
    });

    const cmp = {
      'date-desc':  (a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id),
      'date-asc':   (a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id),
      'id':         (a, b) => a.id.localeCompare(b.id),
      'customer':   (a, b) => custName(a.customerId).localeCompare(custName(b.customerId)),
      'status':     (a, b) => (a.status || '').localeCompare(b.status || ''),
      'priority':   (a, b) => (prioRank[a.priority || 'normal'] - prioRank[b.priority || 'normal']) || (b.date || '').localeCompare(a.date || ''),
      'total-desc': (a, b) => (Number(b.total) || 0) - (Number(a.total) || 0)
    }[sortBy];
    return list.sort(cmp);
  }

  function populateMechanicFilter() {
    const sel = document.getElementById('jobMechanic');
    const current = sel.value;
    sel.innerHTML = `<option value="all">All mechanics</option>` +
      Storage.getData('mechanics').map(m =>
        `<option value="${esc(m.id)}"${m.id === current ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
  }

  function statusButtons(j) {
    const nexts = TRANSITIONS[j.status] || [];
    return nexts.map((n, i) =>
      `<button class="btn btn--sm ${i === 0 && n !== 'Cancelled' ? 'btn--primary' : 'btn--ghost'}" data-action="status" data-next="${n}">${TRANSITION_LABELS[n] || n}</button>`
    ).join('');
  }

  function renderList() {
    const rows = filteredJobs();
    // Live paid/due (Utils.liveJobBalance): the invoice once there is one,
    // else the job card's recorded advances, else its legacy typed snapshot.
    const invoiceById = new Map(Storage.getData('invoices').map(i => [i.id, i]));
    const advanceByJob = new Map();
    Storage.getData('payments').forEach(p => {
      if (p.jobCardId && !p.invoiceId && p.status !== 'Void') {
        advanceByJob.set(p.jobCardId, (advanceByJob.get(p.jobCardId) || 0) + (Number(p.amount) || 0));
      }
    });
    const balance = j => Utils.liveJobBalance(j, invoiceById, advanceByJob);
    const total = Storage.getData('jobCards').length;
    const tbody = document.getElementById('jobTableBody');
    const isFiltered = searchTerm || fQuick !== 'all' || fStatus !== 'all' || fPriority !== 'all' || fMechanic !== 'all' || fDate;

    document.getElementById('jobCount').textContent =
      isFiltered ? `${rows.length} of ${total} job cards` : `${total} job cards`;

    if (!rows.length) {
      let msg = 'No Job Cards found.';
      if (fQuick === 'active') msg = 'No active Job Cards.';
      else if (isFiltered) msg = 'No Job Cards match your search or filter.';
      tbody.innerHTML = `
        <tr><td colspan="10">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z"/></svg>
            <h3>${msg}</h3>
            <p>${isFiltered ? 'Try a different filter.' : 'Open your first job card to start tracking workshop work.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">New Job Card</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(j => `
      <tr data-id="${esc(j.id)}">
        <td class="cell-main">${esc(j.id)}${j.appointmentId ? `<span class="cell-sub">${esc(j.appointmentId)}</span>` : ''}</td>
        <td>${fmtDate(j.date)}</td>
        <td class="cell-main">${esc(custName(j.customerId))}</td>
        <td>${esc(vehText(j.vehicleId))}<span class="cell-sub">${esc(vehReg(j.vehicleId))}</span></td>
        <td>${esc(mecName(j.mechanicId))}</td>
        <td class="cell-desc">${esc((j.services || []).map(s => s.name).join(', ') || '—')}</td>
        <td>${badge(j.status)}</td>
        <td>${priorityBadge(j.priority)}</td>
        <td class="num">${money(j.total)}${balance(j).due > 0 ? `<span class="cell-sub due">Due ${money(balance(j).due)}</span>` : ''}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            ${statusButtons(j)}
            <button class="icon-btn icon-btn--sm" data-action="view" title="View" aria-label="View ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            ${!TERMINAL.includes(j.status) ? `
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>` : ''}
            <button class="icon-btn icon-btn--sm" data-action="print" title="Print" aria-label="Print ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M19 8H5c-1.7 0-3 1.3-3 3v6h4v4h12v-4h4v-6c0-1.7-1.3-3-3-3zm-3 11H8v-5h8v5zm3-7c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm-1-9H6v4h12V3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(j.id)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`).join('');
  }

  /* ============================================================
     FORM (create / edit) — multi-section with live totals
     ============================================================ */

  function customerOptions(selected) {
    return `<option value="">— Select customer —</option>` +
      Storage.getData('customers').slice().sort((a, b) => a.name.localeCompare(b.name))
        .map(c => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)} — ${esc(c.phone)}</option>`).join('');
  }

  /* ---------- searchable customer picker (New Job Card only) ----------
     A hidden input keeps name="customerId" and id="jf-customer", so
     readForm(), validate(), the appointment prefill and the customer →
     vehicle cascade read and write exactly what the old <select> carried:
     the customer's id. The search runs over the customers already loaded. */
  const CUSTOMER_LIST_LIMIT = 50;
  const digitsOf = s => String(s || '').replace(/\D/g, '');

  function customerLabel(c) {
    return c ? [c.name, c.phone].filter(Boolean).join(' — ') : '';
  }

  function customerComboHtml(selected) {
    const c = selected ? Storage.getById('customers', selected) : null;
    return `
      <label for="jf-customer-search">Customer <span class="req">*</span></label>
      <div class="cust-combo">
        <input type="hidden" id="jf-customer" name="customerId" value="${esc(c ? c.id : '')}">
        <input class="input cust-combo__input" id="jf-customer-search" type="text" role="combobox"
               autocomplete="off" spellcheck="false" placeholder="Search customer..."
               aria-autocomplete="list" aria-expanded="false" aria-controls="jf-customer-list"
               value="${esc(customerLabel(c))}">
        <button type="button" class="cust-combo__clear" aria-label="Clear customer"${c ? '' : ' hidden'}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
        <svg class="cust-combo__caret" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>
        <div class="cust-combo__list" id="jf-customer-list" role="listbox" aria-label="Customers" hidden></div>
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
      <div class="cust-combo__opt" id="jf-cust-opt-${i}" role="option" aria-selected="false" data-id="${esc(c.id)}">
        <span class="cust-combo__name">${esc(c.name)}</span>
        <span class="cust-combo__meta">${esc(c.id)}${phones ? ` • ${phones}` : ''}</span>
      </div>`;
  }

  /** Wire the picker. Returns { sync } for code that sets form.customerId directly, or null when there is no picker. */
  function bindCustomerCombo(ov) {
    const hidden = ov.querySelector('#jf-customer');
    const input = ov.querySelector('#jf-customer-search');
    const list = ov.querySelector('#jf-customer-list');
    const clearBtn = ov.querySelector('.cust-combo__clear');
    // unit-test overlays hand back inert stand-ins; only a real DOM gets the picker
    if (!hidden || !input || !list || !clearBtn || typeof input.setAttribute !== 'function') return null;

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

    return {
      /** After form.customerId was set in code: keep only a real customer id, as the <select> did, and show it. */
      sync() {
        if (!current()) hidden.value = '';
        showSelected();
        close();
      }
    };
  }

  function vehicleOptions(customerId, selected) {
    if (!customerId) return `<option value="">— Select customer first —</option>`;
    const vs = Storage.getData('vehicles').filter(v => v.customerId === customerId);
    if (!vs.length) return `<option value="">— No vehicles for this customer —</option>`;
    return `<option value="">— Select vehicle —</option>` +
      vs.map(v => `<option value="${esc(v.id)}"${v.id === selected ? ' selected' : ''}>${esc(v.regNo)} — ${esc(v.brand)} ${esc(v.model)}</option>`).join('');
  }

  function mechanicOptions(selected) {
    const all = Storage.getData('mechanics');
    const active = all.filter(m => (m.status || 'Active') === 'Active');
    const current = selected && all.find(m => m.id === selected);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">— Select mechanic —</option>` +
      list.map(m => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)} — ${esc(m.specialization || 'General')}${(m.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  function serviceSelectOptions(selectedId) {
    const all = Storage.getData('services');
    const active = all.filter(s => (s.status || 'Active') === 'Active');
    const current = selectedId && all.find(s => s.id === selectedId);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">— Select service —</option>` +
      list.sort((a, b) => a.name.localeCompare(b.name))
        .map(s => `<option value="${esc(s.id)}" data-price="${Number(s.price) || 0}" data-name="${esc(s.name)}"${s.id === selectedId ? ' selected' : ''}>${esc(s.name)}${(s.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  // Appointments eligible as a job source: active statuses, no job card yet
  function sourceAppointments(includeId = null) {
    const BLOCKING = ['Scheduled', 'Confirmed', 'In Progress', 'Pending', 'In Service'];
    return Storage.getData('appointments').filter(a =>
      (a.id === includeId) || (BLOCKING.includes(a.status) && !a.jobCardId));
  }

  function appointmentOptions(selected) {
    const appts = sourceAppointments(selected);
    if (!appts.length) return `<option value="">— No open appointments —</option>`;
    return `<option value="">— Select appointment —</option>` +
      appts.map(a => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.id)} — ${esc(custName(a.customerId))}, ${fmtDate(a.date)} ${fmtTime(a.time)}</option>`).join('');
  }

  function serviceLineHtml(line = {}) {
    if (isCustomWork(line)) return customWorkLineHtml(line);
    return `
      <div class="line-row" data-line="service">
        <select class="select line-service" aria-label="Service">${serviceSelectOptions(line.serviceId)}</select>
        <input class="input line-qty" type="number" min="1" step="1" value="${Number(line.qty) || 1}" aria-label="Quantity">
        <input class="input line-price" type="number" min="0" step="50" value="${Number(line.unitPrice) || 0}" aria-label="Unit price">
        <span class="line-total num" aria-label="Line total">${money((Number(line.qty) || 1) * (Number(line.unitPrice) || 0))}</span>
        <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-remove-line aria-label="Remove line">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
      </div>`;
  }

  /* A custom work row: its own name box instead of the catalogue select. It
     is still data-line="service", so totals, remove and save treat it as a
     service line; readLines() tells it apart by its .line-work input. */
  function customWorkLineHtml(line = {}) {
    return `
      <div class="line-row line-row--custom" data-line="service">
        <div class="line-work-wrap">
          <input class="input line-work" type="text" maxlength="200" value="${esc(line.name || '')}"
                 placeholder="Custom work, e.g. Leather work" aria-label="Custom work name">
          <span class="line-work-tag" aria-hidden="true">Custom</span>
        </div>
        <input class="input line-qty" type="number" min="1" step="1" value="${Number(line.qty) || 1}" aria-label="Quantity">
        <input class="input line-price" type="number" min="0" step="50" value="${Number(line.unitPrice) || 0}" aria-label="Unit price">
        <span class="line-total num" aria-label="Line total">${money((Number(line.qty) || 1) * (Number(line.unitPrice) || 0))}</span>
        <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-remove-line aria-label="Remove custom work">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
      </div>`;
  }

  function partSelectOptions(selectedId, manualName = '') {
    const all = Storage.getData('parts');
    const active = all.filter(p => (p.status || 'Active') === 'Active');
    const current = selectedId && all.find(p => p.id === selectedId);
    const list = active.slice();
    if (current && !active.includes(current)) list.unshift(current);
    return `<option value="">${manualName ? `${esc(manualName)} (manual entry)` : '— Select part —'}</option>` +
      list.sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `<option value="${esc(p.id)}" data-price="${Number(p.sellingPrice) || 0}" data-partno="${esc(p.partNo || '')}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)} — stock: ${Number(p.stock) || 0} ${esc(p.unit || '')}${(p.status || 'Active') !== 'Active' ? ' (inactive)' : ''}</option>`).join('');
  }

  function partLineHtml(line = {}) {
    return `
      <div class="line-row line-row--part" data-line="part" data-manual-name="${esc(line.partId ? '' : (line.name || ''))}">
        <select class="select line-part" aria-label="Part">${partSelectOptions(line.partId, line.partId ? '' : (line.name || ''))}</select>
        <input class="input line-partno" value="${esc(line.partNo || '')}" placeholder="Part no." aria-label="Part number">
        <input class="input line-qty" type="number" min="1" step="1" value="${Number(line.qty) || 1}" aria-label="Quantity">
        <input class="input line-price" type="number" min="0" step="50" value="${Number(line.unitPrice) || 0}" aria-label="Unit price">
        <span class="line-total num">${money((Number(line.qty) || 1) * (Number(line.unitPrice) || 0))}</span>
        <button type="button" class="icon-btn icon-btn--sm icon-btn--danger" data-remove-line aria-label="Remove line">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
      </div>`;
  }

  function inspectionRowsHtml(checklist = {}) {
    return INSPECTION_ITEMS.map(item => {
      const entry = checklist[item] || {};
      return `
      <div class="insp-row" data-insp="${esc(item)}">
        <span class="insp-label">${item}</span>
        <select class="select insp-state" aria-label="${item} condition">
          ${INSPECTION_STATES.map(s => `<option value="${s}"${s === (entry.state || '') ? ' selected' : ''}>${s || '—'}</option>`).join('')}
        </select>
        <input class="input insp-note" value="${esc(entry.note || '')}" placeholder="Note (optional)" aria-label="${item} note">
      </div>`;
    }).join('');
  }

  function formHtml(j = {}, fromAppointmentId = '') {
    const isEdit = !!j.id;
    const settings = Storage.getSettings();
    const pct = j.discountType === 'percent';
    const services = (j.services && j.services.length) ? j.services : [{}];
    const parts = j.partsUsed || [];
    const isCompleted = j.status === 'Completed';
    return `
      ${isCompleted ? `<div class="warn-banner">Completed Job Cards are historical records. Changes may affect future invoicing.</div>` : ''}
      <form id="jobForm" novalidate data-advances="${j.id ? sumAmounts(Utils.jobAdvances(j.id)) : 0}">
        ${!isEdit ? `
        <h3 class="detail-section-title">Source</h3>
        <div class="form-grid">
          <div class="field">
            <label for="jf-source">Job Source</label>
            <select class="select" id="jf-source" name="source">
              <option value="walkin"${!fromAppointmentId ? ' selected' : ''}>Walk-in</option>
              <option value="appointment"${fromAppointmentId ? ' selected' : ''}>From Appointment</option>
            </select>
          </div>
          <div class="field" id="jf-apt-wrap" ${fromAppointmentId ? '' : 'hidden'}>
            <label for="jf-appointment">Appointment</label>
            <select class="select" id="jf-appointment" name="appointmentId">${appointmentOptions(fromAppointmentId)}</select>
            <div class="field__error" data-err="appointmentId"></div>
          </div>
        </div>` : (j.appointmentId ? `<p class="muted-note" style="margin-bottom:12px">Linked appointment: <strong>${esc(j.appointmentId)}</strong></p>` : '')}

        <h3 class="detail-section-title">Customer &amp; Vehicle</h3>
        <div class="form-grid">
          <div class="field">
            ${isEdit ? `
            <label for="jf-customer">Customer <span class="req">*</span></label>
            <select class="select" id="jf-customer" name="customerId">${customerOptions(j.customerId)}</select>` : customerComboHtml(j.customerId)}
            <div class="field__error" data-err="customerId"></div>
          </div>
          <div class="field">
            <label for="jf-vehicle">Vehicle <span class="req">*</span></label>
            <select class="select" id="jf-vehicle" name="vehicleId">${vehicleOptions(j.customerId, j.vehicleId)}</select>
            <div class="field__error" data-err="vehicleId"></div>
          </div>
          <div class="field">
            <label for="jf-mechanic">Mechanic <span class="req">*</span></label>
            <select class="select" id="jf-mechanic" name="mechanicId">${mechanicOptions(j.mechanicId)}</select>
            <div class="field__error" data-err="mechanicId"></div>
          </div>
          <div class="field">
            <label for="jf-priority">Priority</label>
            <select class="select" id="jf-priority" name="priority">
              ${Object.entries(PRIORITIES).map(([v, l]) => `<option value="${v}"${(j.priority || 'normal') === v ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="jf-date">Date <span class="req">*</span></label>
            <input class="input" id="jf-date" name="date" type="date" value="${esc(j.date || todayStr())}">
            <div class="field__error" data-err="date"></div>
          </div>
          <div class="field">
            <label for="jf-est">Estimated Delivery</label>
            <input class="input" id="jf-est" name="estDelivery" type="date" value="${esc(j.estDelivery || '')}">
            <div class="field__error" data-err="estDelivery"></div>
          </div>
        </div>

        <h3 class="detail-section-title">Vehicle Check-in</h3>
        <div class="form-grid">
          <div class="field">
            <label for="jf-mileage">Mileage In (km)</label>
            <input class="input" id="jf-mileage" name="mileage" type="number" min="0" value="${esc(j.mileage ?? '')}">
            <div class="field__error" data-err="mileage"></div>
          </div>
          <div class="field">
            <label for="jf-mileage-out">Mileage Out (km)</label>
            <input class="input" id="jf-mileage-out" name="mileageOut" type="number" min="0" value="${esc(j.mileageOut ?? '')}">
            <div class="field__error" data-err="mileageOut"></div>
          </div>
          <div class="field">
            <label for="jf-fuel">Fuel Level</label>
            <select class="select" id="jf-fuel" name="fuelLevel">
              <option value="">— Not recorded —</option>
              ${FUEL_LEVELS.map(f => `<option value="${f}"${j.fuelLevel === f ? ' selected' : ''}>${FUEL_LABELS[f]}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="jf-condition">Vehicle Condition / Belongings</label>
            <input class="input" id="jf-condition" name="conditionNotes" value="${esc(j.conditionNotes || '')}" placeholder="Existing damage, valuables, etc.">
          </div>
          <div class="field span-2">
            <label for="jf-complaint">Customer Complaint / Requested Work <span class="req">*</span></label>
            <textarea class="textarea" id="jf-complaint" name="complaint" rows="2">${esc(j.complaint || '')}</textarea>
            <div class="field__error" data-err="complaint"></div>
          </div>
        </div>

        <h3 class="detail-section-title">Workshop Findings</h3>
        <div class="form-grid">
          <div class="field span-2">
            <label for="jf-inspection">Initial Inspection Summary</label>
            <textarea class="textarea" id="jf-inspection" name="inspection" rows="2">${esc(j.inspection || '')}</textarea>
          </div>
          <div class="field span-2">
            <label for="jf-diagnosis">Diagnosis</label>
            <textarea class="textarea" id="jf-diagnosis" name="diagnosis" rows="2">${esc(j.diagnosis || '')}</textarea>
          </div>
          <div class="field">
            <label for="jf-technotes">Technician Notes</label>
            <textarea class="textarea" id="jf-technotes" name="technicianNotes" rows="2">${esc(j.technicianNotes || '')}</textarea>
          </div>
          <div class="field">
            <label for="jf-recommend">Recommendations</label>
            <textarea class="textarea" id="jf-recommend" name="recommendations" rows="2">${esc(j.recommendations || '')}</textarea>
          </div>
        </div>

        <h3 class="detail-section-title">Services</h3>
        <div class="line-head"><span>Service / Work</span><span>Qty</span><span>Unit Price</span><span>Total</span><span></span></div>
        <div id="serviceLines">${services.map(serviceLineHtml).join('')}</div>
        <button type="button" class="btn btn--ghost btn--sm" id="addServiceLine">+ Add Service</button>
        <button type="button" class="btn btn--ghost btn--sm" id="addCustomLine">+ Add Custom Work</button>
        <div class="field__error" data-err="services"></div>

        <h3 class="detail-section-title">Parts Used <span class="muted-note-inline">(manual entry until Inventory module)</span></h3>
        <div class="line-head line-head--part"><span>Part</span><span>Part No.</span><span>Qty</span><span>Unit Price</span><span>Total</span><span></span></div>
        <div id="partLines">${parts.map(partLineHtml).join('')}</div>
        <button type="button" class="btn btn--ghost btn--sm" id="addPartLine">+ Add Part</button>

        <h3 class="detail-section-title">Labour</h3>
        <div class="form-grid form-grid--3">
          <div class="field">
            <label for="jf-lhours">Hours</label>
            <input class="input" id="jf-lhours" name="labourHours" type="number" min="0" step="0.5" value="${esc(j.labourHours ?? '')}">
            <div class="field__error" data-err="labourHours"></div>
          </div>
          <div class="field">
            <label for="jf-lrate">Rate (BDT/hr)</label>
            <input class="input" id="jf-lrate" name="labourRate" type="number" min="0" step="50" value="${esc(j.labourRate ?? '')}">
            <div class="field__error" data-err="labourRate"></div>
          </div>
          <div class="field">
            <label for="jf-lcost">Labour Total (or direct amount)</label>
            <input class="input" id="jf-lcost" name="labourCost" type="number" min="0" step="50" value="${esc(j.labourCost ?? 0)}">
            <div class="field__error" data-err="labourCost"></div>
          </div>
        </div>

        <h3 class="detail-section-title">Inspection Checklist</h3>
        <div class="insp-grid">${inspectionRowsHtml(j.inspectionChecklist)}</div>

        <h3 class="detail-section-title">Billing</h3>
        <div class="form-grid form-grid--3">
          <div class="jc-discount-pair" data-discount-mode="${pct ? 'percent' : 'fixed'}">
            <div class="field">
              <label for="jf-discount">Discount (BDT)</label>
              <div class="pay-rec__money">
                <span class="pay-rec__cur" aria-hidden="true">${esc(settings.currency || '৳')}</span>
                <input class="input" id="jf-discount" name="discount" type="number" min="0" step="50" value="${esc(j.discount ?? 0)}">
              </div>
              <div class="field__error" data-err="discount"></div>
            </div>
            <!-- One discount at a time: the box the user last typed in is the one
                 saved; the other shows its equivalent (data-discount-mode). -->
            <div class="field jc-discount-pct">
              <label for="jf-discount-pct">Discount (%)</label>
              <div class="pay-rec__money">
                <span class="pay-rec__cur" aria-hidden="true">%</span>
                <input class="input" id="jf-discount-pct" name="discountRate" type="number" min="0" max="100" step="0.01" value="${esc(pct ? j.discountRate : '')}">
              </div>
              <div class="field__error" data-err="discountRate"></div>
            </div>
          </div>
          <div class="field">
            <label for="jf-taxrate">Tax Rate (%)</label>
            <input class="input" id="jf-taxrate" name="taxRate" type="number" min="0" max="100" step="0.5" value="${esc(j.taxRate ?? settings.taxRate ?? 0)}">
            <div class="field__error" data-err="taxRate"></div>
          </div>
          <div class="field">
            <span class="field__label">Paid / Advance</span>
            <!-- Money received is a payment, recorded with Record Advance, never
                 a typed figure. A legacy card keeps its stored value untouched. -->
            <input id="jf-paid" name="paid" type="hidden" value="${esc(j.paid ?? 0)}">
            <p class="jf-advance-note">${advanceNote(j)}</p>
            <div class="field__error" data-err="paid"></div>
          </div>
        </div>

        <div class="totals-panel" id="totalsPanel"></div>

        <div class="field" style="margin-top:14px">
          <label for="jf-notes">General Notes</label>
          <textarea class="textarea" id="jf-notes" name="notes" rows="2">${esc(j.notes || '')}</textarea>
        </div>
      </form>`;
  }

  /* ---------- form interactions: cascade, lines, live totals ---------- */

  function readLines(ov) {
    const services = [...ov.querySelectorAll('[data-line="service"]')].map(row => {
      // custom work is known by its own name box, never by the select's placeholder text
      const work = row.querySelector('.line-work');
      if (work) {
        return {
          serviceId: null,
          name: work.value.trim(),
          qty: Number(row.querySelector('.line-qty').value) || 0,
          unitPrice: Number(row.querySelector('.line-price').value) || 0
        };
      }
      const sel = row.querySelector('.line-service');
      const opt = sel.selectedOptions[0];
      return {
        serviceId: sel.value,
        name: opt ? (opt.dataset.name || opt.textContent.replace(/ \(inactive\)$/, '')) : '',
        qty: Number(row.querySelector('.line-qty').value) || 0,
        unitPrice: Number(row.querySelector('.line-price').value) || 0
      };
    });
    const parts = [...ov.querySelectorAll('[data-line="part"]')].map(row => {
      const sel = row.querySelector('.line-part');
      const opt = sel.selectedOptions[0];
      const manualName = row.dataset.manualName || '';
      return {
        partId: sel.value || null,
        name: sel.value
          ? (opt ? opt.textContent.split(' — stock:')[0].replace(/ \(inactive\)$/, '') : '')
          : manualName,
        partNo: row.querySelector('.line-partno').value,
        qty: Number(row.querySelector('.line-qty').value) || 0,
        unitPrice: Number(row.querySelector('.line-price').value) || 0
      };
    });
    return { services, parts };
  }

  function readInspection(ov) {
    const checklist = {};
    ov.querySelectorAll('.insp-row').forEach(row => {
      const state = row.querySelector('.insp-state').value;
      const note = row.querySelector('.insp-note').value.trim();
      if (state || note) checklist[row.dataset.insp] = { state, note };
    });
    return checklist;
  }

  /** The recorded advance total the form was opened with (data-advances). */
  const advancesOf = form => Number(form.dataset && form.dataset.advances) || 0;

  /**
   * Which discount box the user typed in last: 'fixed' (Discount BDT) or
   * 'percent'. That box is what gets saved; the other only shows its
   * equivalent. Forms without the pair (unit-test stand-ins) are 'fixed'.
   */
  const discountPair = form => (form.querySelector && form.querySelector('.jc-discount-pair')) || null;
  const discountMode = form => (discountPair(form) && discountPair(form).dataset.discountMode) || 'fixed';

  /** A percentage applies when its box is the active one and holds anything but blank or 0. */
  const percentInUse = form => discountMode(form) === 'percent'
    && !!form.discountRate && form.discountRate.value !== '' && Number(form.discountRate.value) !== 0;

  /** What `discount` is as a percentage of `subtotal`, to 2 decimals, at most 100; 0 when undefined. */
  function discountPercentOf(subtotal, discount) {
    const s = Number(subtotal), d = Number(discount);
    if (!Number.isFinite(s) || !Number.isFinite(d) || s <= 0 || d <= 0) return 0;
    return Math.min(Math.round(d / s * 10000) / 100, 100);
  }

  function updateLiveTotals(ov) {
    const form = ov.querySelector('#jobForm');
    const { services, parts } = readLines(ov);
    const mode = discountMode(form);
    const pct = percentInUse(form);
    const t = computeTotals({
      services, partsUsed: parts,
      labourHours: form.labourHours.value, labourRate: form.labourRate.value,
      labourCost: form.labourCost.value,
      // a blank or 0 percentage is no discount, whatever the amount box last showed
      discount: mode === 'percent' ? 0 : form.discount.value, taxRate: form.taxRate.value,
      discountType: pct ? 'percent' : 'amount', discountRate: pct ? form.discountRate.value : null,
      paid: advancesOf(form) > 0 ? advancesOf(form) : form.paid.value
    });
    // the box the user is not typing in shows the equivalent; values set here fire no input event
    if (form.discountRate) {
      if (mode === 'percent') form.discount.value = t.discount;
      else form.discountRate.value = discountPercentOf(t.subtotal, form.discount.value);
      form.discount.classList.toggle('is-derived', mode === 'percent');
      form.discountRate.classList.toggle('is-derived', mode !== 'percent');
    }
    // keep labour total field in sync when hours×rate are supplied
    const h = Number(form.labourHours.value) || 0, r = Number(form.labourRate.value) || 0;
    if (h > 0 && r > 0) form.labourCost.value = h * r;

    // per-line totals
    ov.querySelectorAll('.line-row').forEach(row => {
      const qty = Number(row.querySelector('.line-qty').value) || 0;
      const price = Number(row.querySelector('.line-price').value) || 0;
      row.querySelector('.line-total').textContent = money(qty * price);
    });

    ov.querySelector('#totalsPanel').innerHTML = `
      <div><span>Services</span><strong>${money(t.serviceTotal)}</strong></div>
      <div><span>Parts</span><strong>${money(t.partsTotal)}</strong></div>
      <div><span>Labour</span><strong>${money(t.labourCost)}</strong></div>
      <div><span>Subtotal</span><strong>${money(t.subtotal)}</strong></div>
      <div><span>Discount</span><strong>− ${money(t.discount)}</strong></div>
      <div><span>Tax (${t.taxRate}%)</span><strong>+ ${money(t.tax)}</strong></div>
      <div class="totals-grand"><span>Grand Total</span><strong>${money(t.total)}</strong></div>
      <div><span>Paid</span><strong>${money(t.paid)}</strong></div>
      <div class="${t.due > 0 ? 'totals-due' : ''}"><span>Due</span><strong>${money(t.due)}</strong></div>`;
  }

  function bindFormEvents(ov, isEdit) {
    const form = ov.querySelector('#jobForm');

    // customer → vehicle cascade
    form.customerId.addEventListener('change', () => {
      form.vehicleId.innerHTML = vehicleOptions(form.customerId.value, '');
    });
    const custCombo = isEdit ? null : bindCustomerCombo(ov);

    // appointment source (create only)
    const srcSel = ov.querySelector('#jf-source');
    if (srcSel) {
      const aptWrap = ov.querySelector('#jf-apt-wrap');
      const aptSel = ov.querySelector('#jf-appointment');
      srcSel.addEventListener('change', () => {
        aptWrap.hidden = srcSel.value !== 'appointment';
        if (srcSel.value !== 'appointment') aptSel.value = '';
      });
      aptSel.addEventListener('change', () => {
        const a = Storage.getById('appointments', aptSel.value);
        if (!a) return;
        // Prefill customer/vehicle/mechanic + the appointment's service
        form.customerId.value = a.customerId;
        if (custCombo) custCombo.sync();
        form.vehicleId.innerHTML = vehicleOptions(a.customerId, a.vehicleId);
        if (a.mechanicId) form.mechanicId.value = a.mechanicId;
        if (a.complaint && !form.complaint.value.trim()) form.complaint.value = a.complaint;
        if (a.serviceId) {
          const host = ov.querySelector('#serviceLines');
          const svcRec = Storage.getById('services', a.serviceId);
          host.innerHTML = serviceLineHtml(svcRec
            ? { serviceId: a.serviceId, name: svcRec.name, qty: 1, unitPrice: Number(svcRec.price) || 0 }
            : {});
        }
        updateLiveTotals(ov);
      });
      // If opened with a preselected appointment, apply it now
      if (aptSel.value) aptSel.dispatchEvent(new Event('change'));
    }

    // line add/remove + price snapshot on service pick
    ov.querySelector('#addServiceLine').addEventListener('click', () => {
      ov.querySelector('#serviceLines').insertAdjacentHTML('beforeend', serviceLineHtml());
      updateLiveTotals(ov);
    });
    ov.querySelector('#addCustomLine').addEventListener('click', () => {
      const host = ov.querySelector('#serviceLines');
      host.insertAdjacentHTML('beforeend', customWorkLineHtml());
      const added = host.lastElementChild && host.lastElementChild.querySelector('.line-work');
      if (added) added.focus();
      updateLiveTotals(ov);
    });
    ov.querySelector('#addPartLine').addEventListener('click', () => {
      ov.querySelector('#partLines').insertAdjacentHTML('beforeend', partLineHtml());
      updateLiveTotals(ov);
    });
    ov.querySelector('.modal__body').addEventListener('click', e => {
      const rm = e.target.closest('[data-remove-line]');
      if (rm) { rm.closest('.line-row').remove(); updateLiveTotals(ov); }
    });
    ov.querySelector('.modal__body').addEventListener('change', e => {
      // when the user picks a service, snapshot the current catalog price
      if (e.target.classList.contains('line-service')) {
        const opt = e.target.selectedOptions[0];
        const priceInput = e.target.closest('.line-row').querySelector('.line-price');
        if (opt && opt.dataset.price != null && opt.value) priceInput.value = opt.dataset.price;
      }
      // when the user picks an inventory part, snapshot selling price + part no.
      if (e.target.classList.contains('line-part')) {
        const opt = e.target.selectedOptions[0];
        const row = e.target.closest('.line-row');
        if (opt && opt.value) {
          if (opt.dataset.price != null) row.querySelector('.line-price').value = opt.dataset.price;
          if (opt.dataset.partno != null) row.querySelector('.line-partno').value = opt.dataset.partno;
        }
      }
      updateLiveTotals(ov);
    });
    ov.querySelector('.modal__body').addEventListener('input', e => {
      if (e.target.matches('.line-qty, .line-price, #jf-lhours, #jf-lrate, #jf-lcost, #jf-discount, #jf-discount-pct, #jf-taxrate, #jf-paid')) {
        // typing hours/rate recomputes labour; typing labourCost directly clears hours×rate precedence
        if (e.target.id === 'jf-lcost') { form.labourHours.value = ''; form.labourRate.value = ''; }
        // typing (not focusing) in a discount box makes it the one that is saved
        if (e.target.id === 'jf-discount' || e.target.id === 'jf-discount-pct') {
          discountPair(form).dataset.discountMode = e.target.id === 'jf-discount' ? 'fixed' : 'percent';
        }
        updateLiveTotals(ov);
      }
    });

    updateLiveTotals(ov);
  }

  /* ---------- validation ---------- */

  function readForm(ov) {
    const form = ov.querySelector('#jobForm');
    const val = n => form[n] ? form[n].value.trim() : '';
    const num = n => form[n] && form[n].value !== '' ? Number(form[n].value) : '';
    const { services, parts } = readLines(ov);
    const srcSel = ov.querySelector('#jf-source');
    const pctTyped = discountMode(form) === 'percent' && num('discountRate') !== '' && num('discountRate') !== 0;
    return {
      appointmentId: srcSel
        ? (srcSel.value === 'appointment' ? val('appointmentId') : null)
        : undefined, // edit: appointmentId untouched
      customerId: val('customerId'), vehicleId: val('vehicleId'), mechanicId: val('mechanicId'),
      priority: val('priority') || 'normal',
      date: val('date'), estDelivery: val('estDelivery'),
      mileage: num('mileage'), mileageOut: num('mileageOut'),
      fuelLevel: val('fuelLevel'), conditionNotes: val('conditionNotes'),
      complaint: val('complaint'), inspection: val('inspection'),
      diagnosis: val('diagnosis'), technicianNotes: val('technicianNotes'),
      recommendations: val('recommendations'), notes: val('notes'),
      services, parts,
      inspectionChecklist: readInspection(ov),
      labourHours: num('labourHours'), labourRate: num('labourRate'), labourCost: num('labourCost') || 0,
      discount: discountMode(form) === 'percent' && !pctTyped ? 0 : (num('discount') || 0),
      taxRate: num('taxRate') || 0, paid: num('paid') || 0,
      // a percentage only when its box is the active one; blank or 0 there is no discount,
      // anything else (even out of range) is one, so validate() sees it
      discountType: pctTyped ? 'percent' : 'amount',
      discountRate: pctTyped ? num('discountRate') : null
    };
  }

  function validate(v, editingJob = null) {
    const errors = {};

    if (!v.customerId) errors.customerId = 'Select a customer.';
    else if (!Storage.getById('customers', v.customerId)) errors.customerId = 'Selected customer no longer exists.';
    else if (editingJob && v.customerId !== editingJob.customerId) {
      // The server's rule (updateJobCard, job_card_has_payments), mirrored so
      // it also holds offline: a job card holding money keeps its customer,
      // or that money would show as paid on another customer's job.
      const held = jobPayments(editingJob.id);
      if (held.length) {
        errors.customerId = `This Job Card has recorded payments or advances (${held.map(p => p.id).join(', ')}), so its customer cannot be changed. Void those payments first if the customer is wrong.`;
      }
    }

    if (!v.vehicleId) errors.vehicleId = 'Select a vehicle.';
    else {
      const vehicle = Storage.getById('vehicles', v.vehicleId);
      if (!vehicle) errors.vehicleId = 'Selected vehicle no longer exists.';
      else if (vehicle.customerId !== v.customerId) errors.vehicleId = 'Selected vehicle does not belong to this customer.';
    }

    if (!v.mechanicId) errors.mechanicId = 'Select a mechanic.';
    else if (!Storage.getById('mechanics', v.mechanicId)) errors.mechanicId = 'Selected mechanic no longer exists.';

    if (!v.date) errors.date = 'Job date is required.';
    else if (isNaN(new Date(v.date))) errors.date = 'Enter a valid date.';

    if (!v.complaint) errors.complaint = 'Record the customer complaint / requested work.';

    // appointment integrity (create-from-appointment only)
    if (v.appointmentId) {
      const a = Storage.getById('appointments', v.appointmentId);
      if (!a) errors.appointmentId = 'Selected appointment no longer exists.';
      else {
        if (a.customerId !== v.customerId) errors.appointmentId = 'Appointment belongs to a different customer.';
        else if (a.vehicleId !== v.vehicleId) errors.appointmentId = 'Appointment is for a different vehicle.';
        else if (a.jobCardId && (!editingJob || a.jobCardId !== editingJob.id)) {
          errors.appointmentId = `Job Card already exists for this appointment (${a.jobCardId}).`;
        }
      }
    }

    // valid service lines: id must exist; qty>0; price>=0
    const badService = v.services.find(l => l.serviceId && !Storage.getById('services', l.serviceId));
    if (badService) errors.services = 'A selected service no longer exists in the catalog.';
    else if (v.services.some(l => l.serviceId && (l.qty <= 0 || l.unitPrice < 0)))
      errors.services = 'Service quantity must be > 0 and price cannot be negative.';
    // custom work lines (serviceId null): a name of at most 200 characters, qty > 0, price >= 0
    else if (v.services.some(l => isCustomWork(l) && !l.name.trim()))
      errors.services = 'Enter a name for each custom work line, or remove it.';
    else if (v.services.some(l => isCustomWork(l) && l.name.trim().length > 200))
      errors.services = 'Custom work name must be 200 characters or fewer.';
    else if (v.services.some(l => isCustomWork(l) &&
        (!Number.isFinite(l.qty) || !Number.isFinite(l.unitPrice) || l.qty <= 0 || l.unitPrice < 0)))
      errors.services = 'Custom work quantity must be > 0 and price cannot be negative.';
    else if (!v.services.some(l => l.serviceId || isCustomWork(l)) && !v.parts.some(p => p.name.trim()) && !(Number(v.labourCost) > 0 || (Number(v.labourHours) > 0 && Number(v.labourRate) > 0)))
      errors.services = 'Add at least one service, part, or labour entry.';

    if (v.parts.some(p => p.name.trim() && (p.qty <= 0 || p.unitPrice < 0)))
      errors.services = errors.services || 'Part quantity must be > 0 and price cannot be negative.';
    if (v.parts.some(p => p.partId && !Storage.getById('parts', p.partId)))
      errors.services = errors.services || 'A selected part no longer exists in inventory.';

    if (v.mileage !== '' && v.mileage < 0) errors.mileage = 'Mileage cannot be negative.';
    if (v.mileageOut !== '') {
      if (v.mileageOut < 0) errors.mileageOut = 'Mileage cannot be negative.';
      else if (v.mileage !== '' && v.mileageOut < v.mileage) errors.mileageOut = 'Mileage Out cannot be lower than Mileage In.';
    }

    if (v.labourHours !== '' && v.labourHours < 0) errors.labourHours = 'Hours cannot be negative.';
    if (v.labourRate !== '' && v.labourRate < 0) errors.labourRate = 'Rate cannot be negative.';
    if (v.labourCost < 0) errors.labourCost = 'Labour cannot be negative.';
    if (v.discountType !== 'percent' && v.discount < 0) errors.discount = 'Discount cannot be negative.';
    if (v.discountType === 'percent') {
      const r = v.discountRate;
      if (!Number.isFinite(r) || r < 0 || r > 100) errors.discountRate = 'Discount must be between 0 and 100%.';
      else if (Math.abs(r * 100 - Math.round(r * 100)) >= 1e-9) errors.discountRate = 'Use at most two decimal places.';
    }
    if (v.taxRate < 0 || v.taxRate > 100) errors.taxRate = 'Tax rate must be between 0 and 100.';
    if (v.paid < 0) errors.paid = 'Paid amount cannot be negative.';

    if (v.estDelivery && v.date && v.estDelivery < v.date)
      errors.estDelivery = 'Estimated Delivery cannot be earlier than the Job Date.';

    // discount must not exceed subtotal; paid must not exceed grand total
    const t = computeTotals({ services: v.services, partsUsed: v.parts, labourHours: v.labourHours, labourRate: v.labourRate, labourCost: v.labourCost, discount: v.discount, discountType: v.discountType, discountRate: v.discountRate, taxRate: v.taxRate, paid: 0 });
    if (v.discountType !== 'percent' && v.discount > t.subtotal) errors.discount = 'Discount cannot exceed the subtotal.';
    if (v.paid > t.total) errors.paid = 'Paid amount cannot exceed the grand total.';

    return { valid: Object.keys(errors).length === 0, errors };
  }

  function showErrors(ov, errors) {
    const form = ov.querySelector('#jobForm');
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    ov.querySelectorAll('[data-err]').forEach(el => el.textContent = '');
    Object.entries(errors).forEach(([key, msg]) => {
      const el = ov.querySelector(`[data-err="${key}"]`);
      if (el) {
        el.textContent = msg;
        const field = el.closest('.field');
        if (field) field.classList.add('field--error');
      }
    });
  }

  /** Build the final record from validated values with recalculated totals. */
  function buildRecord(v) {
    const services = normalizeLines(v.services, true);
    const partsUsed = normalizeLines(v.parts, false);
    const draft = { ...v, services, partsUsed };
    const t = computeTotals(draft);
    return {
      customerId: v.customerId, vehicleId: v.vehicleId, mechanicId: v.mechanicId,
      priority: v.priority, date: v.date, estDelivery: v.estDelivery,
      mileage: v.mileage === '' ? '' : v.mileage,
      mileageOut: v.mileageOut === '' ? null : v.mileageOut,
      fuelLevel: v.fuelLevel, conditionNotes: v.conditionNotes,
      complaint: v.complaint, inspection: v.inspection,
      diagnosis: v.diagnosis, technicianNotes: v.technicianNotes,
      recommendations: v.recommendations, notes: v.notes,
      services, partsUsed, inspectionChecklist: v.inspectionChecklist,
      labourHours: v.labourHours === '' ? '' : v.labourHours,
      labourRate: v.labourRate === '' ? '' : v.labourRate,
      labourCost: t.labourCost,
      discount: t.discount, taxRate: t.taxRate,
      discountType: v.discountType, discountRate: v.discountType === 'percent' ? v.discountRate : null,
      subtotal: t.subtotal, tax: t.tax, total: t.total, paid: t.paid, due: t.due
    };
  }

  /**
   * The same record, minus the four figures the server derives from the lines
   * and refuses by name (routes/job-cards.js SERVER_OWNED). Sending any of
   * them -- even a value that matches what the server would compute -- is a
   * 422, because a client must not be able to assert a total the lines do not
   * support.
   *
   * `paid` is deliberately NOT stripped: it is a real input on this form and
   * the server stores it as sent, which is what makes it the frozen snapshot
   * audit Finding 1 depends on. `labourCost` stays too -- it is an input the
   * server only overrides when hours x rate is higher.
   *
   * buildRecord() keeps all four because 'local' mode has no server to compute
   * them: there, the record is what gets stored and read back.
   */
  function forApi(record) {
    const { subtotal, tax, total, due, ...rest } = record;
    // A percentage goes as its rate (the server derives the amount and refuses
    // one sent alongside); a fixed amount goes exactly as it always has.
    if (rest.discountType === 'percent') delete rest.discount;
    else { delete rest.discountType; delete rest.discountRate; }
    return rest;
  }

  /* ---------- create / edit ---------- */

  /* ---------- New / Edit Job Card layout ----------
     Presentation only. formHtml() renders the form as headings followed by
     grids. Those same elements are regrouped into section cards before any
     listener is bound. Nothing is re-created: every input keeps its element,
     id and name, so readForm(), validate(), the live totals and the save are
     untouched. New and Edit differ only in the first section (Edit has no
     Source and uses the plain customer select) and in the header. */
  const JC_ICONS = {
    job: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z',
    customer: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    checkin: 'M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z',
    complaint: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z',
    findings: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    services: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
    parts: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    labour: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    insp: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 16h8v-2H2v2zm19.5-4.5L23 13l-6.99 7-4.51-4.5L13 14l3.01 3 5.49-5.5z',
    billing: 'M18 17H6v-2h12v2zm0-4H6v-2h12v2zm0-4H6V7h12v2zM3 22l1.5-1.5L6 22l1.5-1.5L9 22l1.5-1.5L12 22l1.5-1.5L15 22l1.5-1.5L18 22l1.5-1.5L21 22V2l-1.5 1.5L18 2l-1.5 1.5L15 2l-1.5 1.5L12 2l-1.5 1.5L9 2 7.5 3.5 6 2 4.5 3.5 3 2v20z',
    notes: 'M3 18h12v-2H3v2zM3 6v2h18V6H3zm0 7h18v-2H3v2z'
  };

  function layoutJobForm(ov, editId = '') {
    const modal = ov && ov.querySelector && ov.querySelector('.modal');
    const form = ov && ov.querySelector && ov.querySelector('#jobForm');
    // unit-test overlays hand back inert stand-ins; only a real DOM is regrouped
    if (!modal || !form || !form.children || typeof form.prepend !== 'function' || !modal.querySelector) return;
    const isEdit = !!editId;
    // not the form this expects: leave it as rendered
    if (form.querySelectorAll(':scope > h3.detail-section-title').length !== (isEdit ? 8 : 9)) return;

    const q = sel => form.querySelector(sel);
    const field = sel => { const el = q(sel); return el ? el.closest('.field') : null; };
    const buttons = (...els) => {
      const row = document.createElement('div');
      row.className = 'jc-sec__actions';
      row.append(...els);
      return row;
    };
    const first = isEdit ? [
      { key: 'job', title: 'Job Information', desc: 'Customer, vehicle, assigned mechanic and dates',
        grid: [field('#jf-customer'), field('#jf-vehicle'), field('#jf-mechanic'), field('#jf-priority'), field('#jf-date'), field('#jf-est')] }
    ] : [
      { key: 'job', title: 'Job Information', desc: 'Where the job comes from, who is assigned and when it is due',
        cols: 3, grid: [field('#jf-source'), q('#jf-apt-wrap'), field('#jf-priority'), field('#jf-mechanic'), field('#jf-date'), field('#jf-est')] },
      { key: 'customer', title: 'Customer &amp; Vehicle', desc: 'The vehicle list follows the selected customer',
        grid: [field('#jf-customer-search'), field('#jf-vehicle')] }
    ];
    const plan = [
      ...first,
      { key: 'checkin', title: 'Vehicle Check-in', desc: 'Condition of the vehicle as it arrives',
        grid: [field('#jf-mileage'), field('#jf-mileage-out'), field('#jf-fuel'), field('#jf-condition')] },
      { key: 'complaint', title: 'Customer Complaint / Requested Work <span class="req">*</span>', desc: 'What the customer reports or asks for',
        body: [field('#jf-complaint')] },
      { key: 'findings', title: 'Workshop Findings', desc: 'Inspection, diagnosis and advice from the workshop',
        body: [q('#jf-inspection') && q('#jf-inspection').closest('.form-grid')] },
      { key: 'services', title: 'Services &amp; Custom Work', desc: 'Catalogue services, or one-off custom work that is not in the catalogue',
        body: [q('.line-head:not(.line-head--part)'), q('#serviceLines'), q('#addServiceLine'), q('#addCustomLine'), q('[data-err="services"]')] },
      { key: 'parts', title: 'Parts Used', desc: 'Manual entry until Inventory module',
        body: [q('.line-head--part'), q('#partLines'), q('#addPartLine')] },
      { key: 'labour', title: 'Labour', desc: 'Hours × rate fills the labour total, or enter a direct amount',
        body: [q('#jf-lhours') && q('#jf-lhours').closest('.form-grid')] },
      { key: 'insp', title: 'Inspection Checklist', desc: 'Condition of each area; notes are optional',
        body: [q('.insp-grid')] },
      { key: 'billing', title: 'Billing', desc: 'Discount, tax and advance; totals update as you type',
        body: [q('#jf-discount') && q('#jf-discount').closest('.form-grid'), q('#totalsPanel')] },
      { key: 'notes', title: 'General Notes', desc: 'Anything else worth recording on this job',
        body: [field('#jf-notes')] }
    ];
    if (plan.some(s => (s.grid || s.body).some(el => !el))) return;   // a part is missing: change nothing

    // moving the focused control would drop focus; put it back afterwards
    const focused = document.activeElement;

    const sections = plan.map(s => {
      const sec = document.createElement('section');
      sec.className = `form-section jc-sec jc-sec--${s.key}`;
      sec.setAttribute('aria-labelledby', `jcs-${s.key}`);
      sec.innerHTML = `
        <div class="form-section__head">
          <span class="form-section__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="${JC_ICONS[s.key]}"/></svg></span>
          <div>
            <h3 class="form-section__title" id="jcs-${s.key}">${s.title}</h3>
            <p class="form-section__desc">${s.desc}</p>
          </div>
        </div>`;
      const body = document.createElement('div');
      if (s.grid) {
        body.className = `form-grid${s.cols === 3 ? ' form-grid--3' : ''} form-section__body`;
        body.append(...s.grid);
      } else {
        body.className = 'jc-sec__body';
        if (s.key === 'services') {
          const [head, lines, addService, addCustom, err] = s.body;
          body.append(head, lines, buttons(addService, addCustom), err);
        } else if (s.key === 'parts') {
          const [head, lines, addPart] = s.body;
          body.append(head, lines, buttons(addPart));
        } else if (s.key === 'billing') {
          const wrap = document.createElement('div');
          wrap.className = 'jc-billing';
          wrap.append(...s.body);
          body.append(wrap);
        } else {
          body.append(...s.body);
        }
      }
      sec.append(body);
      return sec;
    });

    // What is left is the old headings and the grids that are now empty.
    [...form.children].forEach(ch => {
      if (ch.matches('h3.detail-section-title') || (ch.matches('.form-grid') && !ch.children.length)) ch.remove();
    });
    form.prepend(...sections);
    form.classList.add('jc-form');
    // Edit: the linked-appointment line heads the Job Information grid
    const aptNote = isEdit && form.querySelector(':scope > .muted-note');
    if (aptNote) form.querySelector('.jc-sec--job .form-section__body').prepend(aptNote);

    // inspection rows show their status as a colour; the stored value is unchanged
    const insp = form.querySelector('.insp-grid');
    const markState = sel => { sel.closest('.insp-row').dataset.state = sel.value; };
    insp.querySelectorAll('.insp-state').forEach(markState);
    insp.addEventListener('change', e => { if (e.target.matches('.insp-state')) markState(e.target); });

    // header: icon + subtitle, the same treatment as the other redesigned forms
    modal.classList.add('veh-add', isEdit ? 'jc-edit' : 'jc-new');
    const title = modal.querySelector('.modal__head h2');
    if (title) {
      title.insertAdjacentHTML('beforebegin', `<span class="veh-add__icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${JC_ICONS.job}"/></svg></span>`);
      const titles = document.createElement('div');
      titles.className = 'veh-add__titles';
      title.before(titles);
      if (isEdit) {
        // "Edit Job Card" with the number as a tag beside it; the dialog's own
        // label stays "Edit Job Card — JOB-XXXX"
        const line = document.createElement('div');
        line.className = 'jc-edit__titleline';
        title.textContent = 'Edit Job Card';
        line.append(title);
        line.insertAdjacentHTML('beforeend', `<span class="jc-edit__id">${esc(editId)}</span>`);
        titles.append(line);
        titles.insertAdjacentHTML('beforeend', '<p class="veh-add__sub" id="jc-edit-sub">Update job details, work performed and billing information</p>');
        modal.setAttribute('aria-describedby', 'jc-edit-sub');
        // The footer stays in view here, so a field reached with Tab can sit
        // under it (or under the header) while counting as visible to the
        // browser; scroll it clear.
        modal.addEventListener('focusin', e => {
          const head = modal.querySelector('.modal__head'), foot = modal.querySelector('.modal__foot');
          if (!head || !foot || e.target.closest('.modal__head, .modal__foot')) return;
          const r = e.target.getBoundingClientRect(), gap = 12;
          const top = head.getBoundingClientRect().bottom, bottom = foot.getBoundingClientRect().top;
          if (r.bottom > bottom - gap) modal.scrollTop += r.bottom - bottom + gap;
          else if (r.top < top + gap) modal.scrollTop -= top + gap - r.top;
        });
      } else {
        titles.append(title);
        titles.insertAdjacentHTML('beforeend', '<p class="veh-add__sub" id="jc-new-sub">Create a new service &amp; repair job</p>');
        modal.setAttribute('aria-describedby', 'jc-new-sub');
      }
    }

    if (focused && form.contains(focused) && document.activeElement !== focused) focused.focus();
  }

  function openCreateModal(fromAppointmentId = '') {
    if (!Storage.getData('customers').length) {
      Modal.open({
        title: 'No customers yet',
        body: `<p style="margin:0">A job card needs a customer and their vehicle. Add a customer first.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 <a class="btn btn--primary" href="customers.html">Go to Customers</a>`
      });
      return;
    }
    // duplicate guard when arriving from a specific appointment
    if (fromAppointmentId) {
      const a = Storage.getById('appointments', fromAppointmentId);
      if (!a) { toast('That appointment no longer exists.', 'error'); fromAppointmentId = ''; }
      else if (a.jobCardId) {
        Modal.open({
          title: 'Job Card already exists',
          body: `<p style="margin:0">Job Card already exists for this appointment: <strong>${esc(a.jobCardId)}</strong>.</p>`,
          footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                   <button class="btn btn--primary" data-open-existing>Open ${esc(a.jobCardId)}</button>`
        }).querySelector('[data-open-existing]').addEventListener('click', () => {
          Modal.close();
          openDetailModal(a.jobCardId);
        });
        return;
      }
    }

    const ov = Modal.open({
      title: 'New Job Card', size: 'lg',
      body: formHtml({}, fromAppointmentId),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Open Job Card</button>`
    });
    layoutJobForm(ov);
    bindFormEvents(ov, false);

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const v = readForm(ov);
      if (ov.querySelector('#jf-source').value === 'appointment' && !v.appointmentId) {
        showErrors(ov, { appointmentId: 'Select the appointment, or switch to Walk-in.' });
        toast('Please fix the highlighted fields.', 'error');
        return;
      }
      const { valid, errors } = validate(v);
      if (!valid) { showErrors(ov, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      // Totals are recomputed from the lines on the server, so what is sent
      // is the lines -- not a subtotal it would have to take on trust. Local
      // mode has no server, so there the computed record is stored as built.
      const record = buildRecord(v);
      // Offline (js/sync.js) the same body is queued for the server; the
      // computed record is what this computer shows until the server answers.
      const created = await Storage.create('jobCards', {
        ...(Storage.serverRules() ? forApi(record) : record),
        appointmentId: v.appointmentId || null,
        invoiceId: null,
        completedAt: null,
        actualDelivery: '',
        status: 'Received'
      }, { display: record });
      if (!Utils.wrote(created, ov)) return;
      const rec = created.record;

      // Appointment sync: link only. The appointment keeps its status
      // (Scheduled/Confirmed) until workshop work actually starts —
      // see changeStatus(): Job Card → In Progress moves it.
      if (v.appointmentId) {
        const a = Storage.getById('appointments', v.appointmentId);
        if (a && !a.jobCardId) {
          // The same transaction stamped the appointment's jobCardId server
          // side; re-reading is how this copy learns about it.
          if (Storage.serverRules()) await Storage.refreshAll('appointments');
          else Storage.updateData('appointments', v.appointmentId, { jobCardId: rec.id });
        }
      }

      Modal.close();
      refresh();
      toast(`Job Card ${rec.id} opened for ${custName(rec.customerId)}.`);
    }));
  }

  function openEditModal(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    if (TERMINAL.includes(j.status)) {
      toast(`${j.status} job cards are read-only.`, 'info');
      return;
    }
    const ov = Modal.open({
      title: `Edit Job Card — ${j.id}`, size: 'lg',
      body: formHtml(j),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    layoutJobForm(ov, j.id);
    bindFormEvents(ov, true);

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const v = readForm(ov);
      const { valid, errors } = validate(v, j);
      if (!valid) { showErrors(ov, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const proposed = buildRecord(v);

      // With a backend the whole edit -- the job card, both line tables, the
      // stock reconciliation against the LEDGER and the movements it implies
      // -- is one transaction on the server, guarded so a plan made against a
      // stale issued balance rolls the batch back rather than deducting the
      // same units twice. Reconciling here as well would deduct them twice.
      if (Storage.serverRules()) {
        // Offline, parts changes are queued as per-part movements (+ use /
        // - return) that the server applies through its own stock rules.
        const res = await Storage.update('jobCards', id, forApi(proposed), { display: proposed });
        if (!res.ok) {
          if (res.status === 409 && res.errorReason === 'insufficient_stock') {
            // A shortage, in the server's own words, in the dialog this
            // screen has always used for one. Any other conflict (a
            // concurrent stock change, or a payment recorded while the
            // customer was being changed) is reported as itself below.
            Modal.open({
              title: 'Insufficient stock for this change',
              body: `<p style="margin:0">${esc(res.message)}</p>
                     <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                     Receive stock in Inventory first, then save your changes again. This Job Card was not modified.</p>`,
              footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                       <a class="btn btn--primary" href="inventory.html">Go to Inventory</a>`
            });
            return;
          }
          Utils.wrote(res, ov);
          return;
        }
        const stale = await Storage.refreshAll('parts', 'inventoryTransactions');
        Modal.close();
        refresh();
        if (stale.length) Utils.wrote({ ok: true, stale });
        else toast(`Job Card ${id} updated.`);
        return;
      }

      // INVENTORY: once a job has started issuing stock (In Progress /
      // Waiting for Parts), an edit to partsUsed must reconcile against
      // what's actually been deducted — not just overwrite the record.
      // reconcileJobInventory validates every deduction against live
      // stock BEFORE writing anything; on a shortage nothing is moved
      // and the Job Card edit itself is not saved.
      let reconciled = null;
      if (INVENTORY_TRACKED_STATUSES.includes(j.status)) {
        reconciled = await Utils.Inventory.reconcileJobInventory(j, proposed);
        if (!reconciled.ok) {
          const s = reconciled.shortages[0];
          Modal.open({
            title: 'Insufficient stock for this change',
            body: `<p style="margin:0">Insufficient stock for <strong>${esc(s.name)}</strong>.
                   Available: ${s.available}, Additional required: ${s.required}.</p>
                   ${reconciled.shortages.length > 1 ? `<p style="margin:8px 0 0;font-size:.84rem;color:var(--text-2)">${reconciled.shortages.length - 1} more part${reconciled.shortages.length > 2 ? 's are' : ' is'} also short.</p>` : ''}
                   <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                   Receive stock in Inventory first, then save your changes again. This Job Card was not modified.</p>`,
            footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                     <a class="btn btn--primary" href="inventory.html">Go to Inventory</a>`
          });
          return; // Job Card changes are NOT saved — nothing was touched.
        }
      }

      // id, createdAt, appointmentId, invoiceId, status, completedAt preserved;
      // updatedAt set by Storage.updateData
      Storage.updateData('jobCards', id, proposed);
      Modal.close();
      refresh();
      if (reconciled && reconciled.applied.length) {
        const parts = reconciled.applied.map(a => `${a.name} (${a.delta > 0 ? '+' : ''}${a.delta})`).join(', ');
        toast(`Job Card ${id} updated. Stock adjusted: ${parts}.`, 'info');
      } else {
        toast(`Job Card ${id} updated.`);
      }
    }));
  }

  /* ---------- status lifecycle ---------- */

  async function changeStatus(id, next) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    if (!(TRANSITIONS[j.status] || []).includes(next)) {
      toast(`Cannot change ${j.status} job card to ${next}.`, 'error');
      return;
    }

    // INVENTORY: entering In Progress issues the job's inventory parts.
    // Utils.Inventory.deductForJob is idempotent (per part+job transaction
    // check), so In Progress ⇄ Waiting ping-pong never double-deducts.
    if (next === 'In Progress') {
      const shortages = Utils.Inventory.checkJobStock(j);
      if (shortages.length) {
        const s = shortages[0];
        Modal.open({
          title: 'Insufficient stock',
          body: `<p style="margin:0">Insufficient stock for <strong>${esc(s.name)}</strong>.
                 Available: ${s.available}, Required: ${s.required}.</p>
                 ${shortages.length > 1 ? `<p style="margin:8px 0 0;font-size:.84rem;color:var(--text-2)">${shortages.length - 1} more part${shortages.length > 2 ? 's are' : ' is'} also short.</p>` : ''}
                 <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                 Receive stock in Inventory first, or move the job to Waiting for Parts.</p>`,
          footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                   <a class="btn btn--primary" href="inventory.html">Go to Inventory</a>`
        });
        return;
      }
    }

    const apply = async () => {
      // A status change is ONE transaction on the server: the gate (which
      // refuses a move the table does not list), the stock it implies --
      // issued entering In Progress, returned on Cancelled -- completedAt,
      // actualDelivery and the appointment sync all move together, or none
      // of them does. Repeating any of it here would apply it twice, and
      // the deduction's own NOT EXISTS would then refuse the second.
      if (Storage.serverRules()) {
        const res = await Storage.action('jobCards', id, 'status', { status: next },
          ['parts', 'inventoryTransactions', 'appointments']);
        if (!res.ok) {
          if (res.status === 409) {
            Modal.open({
              title: next === 'In Progress' ? 'Insufficient stock' : 'Cannot change status',
              body: `<p style="margin:0">${esc(res.message)}</p>`,
              footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                       ${next === 'In Progress' ? '<a class="btn btn--primary" href="inventory.html">Go to Inventory</a>' : ''}`
            });
            return;
          }
          Utils.wrote(res);
          return;
        }
        refresh();
        toast(`Job Card ${id} → ${next}.`, next === 'Cancelled' ? 'warning' : 'success');
        return;
      }

      const changes = { status: next };
      if (next === 'Completed' && !j.completedAt) changes.completedAt = new Date().toISOString();
      if (next === 'Delivered' && !j.actualDelivery) changes.actualDelivery = todayStr();
      Storage.updateData('jobCards', id, changes);

      if (next === 'In Progress') {
        const res = await Utils.Inventory.deductForJob(Storage.getById('jobCards', id));
        if (res.deducted > 0) toast(`Stock issued for ${res.deducted} part line${res.deducted > 1 ? 's' : ''}.`, 'info');
      }
      if (next === 'Cancelled') {
        const returned = await Utils.Inventory.returnForJob(j);
        if (returned > 0) toast(`Stock returned for ${returned} part line${returned > 1 ? 's' : ''}.`, 'info');
      }

      // Appointment sync (one-way, no circular updates):
      // work actually starting moves the appointment to In Progress;
      // job completion completes it. Terminal appointments never change.
      if (j.appointmentId) {
        const a = Storage.getById('appointments', j.appointmentId);
        const aptTerminal = ['Completed', 'Cancelled', 'No Show'];
        if (a && !aptTerminal.includes(a.status)) {
          if (next === 'In Progress' && a.status !== 'In Progress') {
            Storage.updateData('appointments', j.appointmentId, { status: 'In Progress' });
          } else if (next === 'Completed') {
            Storage.updateData('appointments', j.appointmentId, { status: 'Completed' });
          }
        }
      }
      refresh();
      toast(`Job Card ${id} → ${next}.`, next === 'Cancelled' ? 'warning' : 'success');
    };

    if (next === 'Cancelled') {
      Modal.confirm({
        title: 'Cancel job card?',
        message: `Cancel <strong>${esc(id)}</strong>? All recorded work, findings, and amounts are preserved for history.`,
        confirmText: 'Cancel Job Card',
        onConfirm: apply
      });
    } else {
      await apply();
    }
  }

  /* ---------- delete policy ---------- */

  function openDeleteModal(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;

    const invoice = j.invoiceId ? Storage.getById('invoices', j.invoiceId) :
      Storage.getData('invoices').find(i => i.jobCardId === id);

    if (invoice) {
      Modal.open({
        title: 'Cannot delete job card',
        body: `<p style="margin:0"><strong>${esc(j.id)}</strong> is linked to invoice
               <strong>${esc(invoice.id)}</strong>. Invoiced job cards are permanent business records.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (DONE.includes(j.status)) {
      Modal.open({
        title: 'Keep completed job cards',
        body: `<p style="margin:0"><strong>${esc(j.id)}</strong> contains completed work — it's part of the
               vehicle's service history and shouldn't be deleted.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }
    if (!['Received', 'Cancelled'].includes(j.status)) {
      Modal.open({
        title: 'Work has started',
        body: `<p style="margin:0"><strong>${esc(j.id)}</strong> is ${esc(j.status)}. Cancel the job card
               instead of deleting it, so the recorded work is preserved.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
      });
      return;
    }

    Modal.confirm({
      title: 'Delete job card?',
      message: `Permanently delete <strong>${esc(j.id)}</strong> (${esc(custName(j.customerId))}, ${fmtDate(j.date)})? This cannot be undone.`,
      confirmText: 'Delete Job Card',
      onConfirm: async () => {
        if (Storage.isApi()) {
          // The appointment's link is cleared by the same delete on the
          // server -- job_cards and appointments reference each other, which
          // is why those two foreign keys are DEFERRABLE INITIALLY DEFERRED.
          const res = await Storage.remove('jobCards', id);
          if (!Utils.wrote(res)) return;
          const stale = j.appointmentId ? await Storage.refreshAll('appointments') : [];
          refresh();
          if (stale.length) Utils.wrote({ ok: true, stale });
          else toast(`Job Card ${id} deleted.`, 'warning');
          return;
        }
        // unlink from appointment if this was its job card
        if (j.appointmentId) {
          const a = Storage.getById('appointments', j.appointmentId);
          if (a && a.jobCardId === id) Storage.updateData('appointments', j.appointmentId, { jobCardId: null });
        }
        Storage.deleteData('jobCards', id);
        refresh();
        toast(`Job Card ${id} deleted.`, 'warning');
      }
    });
  }

  /* ---------- details view ----------
     Read-only. Every value below is the same expression the details view
     has always shown (computeTotals() for the services / parts / labour
     amounts, the stored j.* figures for subtotal through due); only the
     layout around them is new. Print, Close, View / Create Invoice and Edit
     keep their markup and bindings in the footer. */
  const JCV_ICONS = {
    status: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    priority: 'M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z',
    date: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z',
    appointment: 'M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z',
    delivery: 'M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9 1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
    completed: 'M16.59 7.58 10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z'
  };
  const jcvIcon = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

  function linesTable(lines, isService) {
    if (!lines || !lines.length) return `<p class="muted-note jcv-empty">${isService ? 'No services added.' : 'No parts recorded.'}</p>`;
    return `<div class="table-wrap"><table class="table table--compact jcv-table${isService ? '' : ' jcv-table--parts'}">
      <thead><tr>
        <th class="jcv-table__no" scope="col">#</th>
        <th scope="col">${isService ? 'Service / Description' : 'Part'}</th>${isService ? '' : '<th scope="col">Part No.</th>'}
        <th class="num" scope="col">Qty</th><th class="num" scope="col">Unit Price</th><th class="num" scope="col">Total</th>
      </tr></thead>
      <tbody>${lines.map((l, i) => {
        const inactive = isService && l.serviceId && (() => { const s = svc(l.serviceId); return s && (s.status || 'Active') !== 'Active'; })();
        return `<tr>
          <td class="jcv-table__no">${i + 1}</td>
          <td class="cell-main">${esc(l.name)}${isService && isCustomWork(l) ? ' (Custom)' : ''}${inactive ? ' <span class="badge badge--neutral">Inactive</span>' : ''}</td>
          ${isService ? '' : `<td data-label="Part No.">${esc(l.partNo || '—')}</td>`}
          <td class="num" data-label="Qty">${l.qty}</td>
          <td class="num" data-label="Unit Price">${money(l.unitPrice)}</td>
          <td class="num" data-label="Total">${money(l.total)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function inspectionTable(checklist) {
    const entries = Object.entries(checklist || {}).filter(([, v]) => v.state || v.note);
    if (!entries.length) return `<p class="muted-note jcv-empty">No inspection information recorded.</p>`;
    return `<div class="insp-view jcv-insp">${entries.map(([item, v]) => `
      <div class="insp-view__row" data-state="${esc(v.state || '')}">
        <span class="insp-label">${esc(item)}</span>
        ${v.state ? `<span class="badge badge--${{ OK: 'good', Attention: 'warn', Critical: 'bad' }[v.state] || 'neutral'}">${esc(v.state)}</span>` : ''}
        ${v.note ? `<span class="insp-note-text">${esc(v.note)}</span>` : ''}
      </div>`).join('')}</div>`;
  }

  function textBlock(title, value) {
    return value ? `<div class="jcv-note"><h4 class="jcv-note__title">${title}</h4><p class="detail-text">${esc(value)}</p></div>` : '';
  }

  /** A details card: icon + title head, then its body. */
  function jcvCard(key, icon, title, body) {
    return `
      <section class="jcv-card jcv-card--${key}" aria-labelledby="jcv-${key}">
        <div class="jcv-card__head">
          <span class="jcv-card__icon" aria-hidden="true">${jcvIcon(icon)}</span>
          <h3 class="jcv-card__title" id="jcv-${key}">${title}</h3>
        </div>
        <div class="jcv-card__body">${body}</div>
      </section>`;
  }

  function openDetailModal(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    const vehicle = veh(j.vehicleId);
    const mechanic = mec(j.mechanicId);
    const t = computeTotals(j);
    // Defensive: only trust invoiceId if that invoice record still actually
    // exists (guards against a stale reference; mirrors the delete-guard
    // lookup used elsewhere).
    const linkedInvoice = j.invoiceId ? Storage.getById('invoices', j.invoiceId) : null;
    const bal = Utils.liveJobBalance(j);
    const canAdvance = j.status !== 'Cancelled' && !liveInvoiceOf(j);

    const strip = [
      ['Status', JCV_ICONS.status, badge(j.status)],
      ['Priority', JCV_ICONS.priority, priorityBadge(j.priority)],
      ['Date', JCV_ICONS.date, fmtDate(j.date)],
      ['Appointment', JCV_ICONS.appointment, j.appointmentId ? esc(j.appointmentId) : '—'],
      ['Est. Delivery', JCV_ICONS.delivery, j.estDelivery ? fmtDate(j.estDelivery) : '—'],
      ['Completed', JCV_ICONS.completed, j.completedAt ? fmtDate(j.completedAt) : '—']
    ];
    const facts = [
      ['Customer', esc(custName(j.customerId))],
      ['Phone', esc(custPhone(j.customerId))],
      ['Registration', esc(vehReg(j.vehicleId))],
      ['Vehicle', esc(vehText(j.vehicleId))],
      ['VIN', vehicle && vehicle.vin ? esc(vehicle.vin) : 'N/A'],
      ['Mileage In / Out', `${j.mileage ? Number(j.mileage).toLocaleString('en-IN') : '—'} / ${j.mileageOut ? Number(j.mileageOut).toLocaleString('en-IN') : '—'} km`],
      ['Fuel Level', j.fuelLevel ? FUEL_LABELS[j.fuelLevel] || esc(j.fuelLevel) : '—'],
      ['Mechanic', `${esc(mecName(j.mechanicId))}${mechanic && (mechanic.status || 'Active') !== 'Active' ? ' (inactive)' : ''}`],
      ['Specialization', mechanic ? esc(mechanic.specialization || 'General') : 'N/A']
    ];
    const inspCount = Object.values(j.inspectionChecklist || {}).filter(v => v.state || v.note).length;
    const labourBody = t.labourCost > 0
      ? `<div class="table-wrap"><table class="table table--compact jcv-table jcv-table--labour">
          <thead><tr><th scope="col">Hours</th><th scope="col">Rate (BDT/hr)</th><th class="num" scope="col">Labour Total</th></tr></thead>
          <tbody><tr>
            <td data-label="Hours">${j.labourHours ? esc(j.labourHours) : '—'}</td>
            <td data-label="Rate (BDT/hr)">${j.labourRate ? money(j.labourRate) : '—'}</td>
            <td class="num" data-label="Labour Total">${money(t.labourCost)}</td>
          </tr></tbody></table></div>`
      : `<p class="muted-note jcv-empty">No labour recorded.</p>`;
    const tabs = [
      ['services', JC_ICONS.services, 'Services', (j.services || []).length, linesTable(j.services, true)],
      ['parts', JC_ICONS.parts, 'Parts', (j.partsUsed || []).length, linesTable(j.partsUsed, false)],
      ['labour', JC_ICONS.labour, 'Labour', t.labourCost > 0 ? 1 : 0, labourBody],
      ['insp', JC_ICONS.insp, 'Inspection', inspCount, inspectionTable(j.inspectionChecklist)]
    ];
    const notes = [
      textBlock('Initial Inspection', j.inspection),
      textBlock('Diagnosis', j.diagnosis),
      textBlock('Technician Notes', j.technicianNotes),
      textBlock('Recommendations', j.recommendations),
      textBlock('General Notes', j.notes)
    ].join('');

    const ov = Modal.open({
      title: `Job Card ${j.id}`, size: 'lg',
      body: `
      <div class="jcv">
        <div class="jcv-strip">
          ${strip.map(([label, icon, value]) => `
          <div class="jcv-strip__item">
            <span class="jcv-strip__label">${label}</span>
            <span class="jcv-strip__value"><span class="jcv-strip__icon" aria-hidden="true">${jcvIcon(icon, 16)}</span>${value}</span>
          </div>`).join('')}
        </div>

        <div class="jcv-cols">
          ${jcvCard('cv', JC_ICONS.customer, 'Customer &amp; Vehicle', `
            <dl class="jcv-dl">
              ${facts.map(([label, value]) => `<div class="jcv-dl__row"><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
            </dl>`)}
          <div class="jcv-stack">
            ${jcvCard('complaint', JC_ICONS.services, 'Customer Complaint',
              j.complaint ? `<p class="detail-text">${esc(j.complaint)}</p>` : '<p class="muted-note jcv-empty">No complaint recorded.</p>')}
            ${jcvCard('condition', JC_ICONS.checkin, 'Vehicle Condition / Belongings',
              j.conditionNotes ? `<p class="detail-text">${esc(j.conditionNotes)}</p>` : '<p class="muted-note jcv-empty">Nothing recorded.</p>')}
          </div>
        </div>

        <section class="jcv-card jcv-work" aria-label="Work details">
          <div class="jcv-tabs" role="tablist" aria-label="Work details">
            ${tabs.map(([key, icon, label, count], i) => `
            <button type="button" class="jcv-tab" role="tab" id="jcv-tab-${key}" aria-controls="jcv-panel-${key}"
                    aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">
              ${jcvIcon(icon, 16)}<span>${label} (${count})</span>
            </button>`).join('')}
          </div>
          ${tabs.map(([key, , , , body], i) => `
          <div class="jcv-panel" role="tabpanel" id="jcv-panel-${key}" aria-labelledby="jcv-tab-${key}" tabindex="0"${i === 0 ? '' : ' hidden'}>${body}</div>`).join('')}
        </section>

        <div class="jcv-cols jcv-cols--end">
          ${jcvCard('notes', JC_ICONS.notes, 'Workshop Notes', notes || '<p class="muted-note jcv-empty">No notes recorded.</p>')}
          ${jcvCard('summary', JC_ICONS.billing, 'Summary', `
          <div class="totals-panel totals-panel--view">
            <div><span>Services</span><strong>${money(t.serviceTotal)}</strong></div>
            <div><span>Parts</span><strong>${money(t.partsTotal)}</strong></div>
            <div><span>Labour${j.labourHours && j.labourRate ? ` (${j.labourHours} hr × ${money(j.labourRate)})` : ''}</span><strong>${money(t.labourCost)}</strong></div>
            <div><span>Subtotal</span><strong>${money(j.subtotal)}</strong></div>
            <div><span>Discount</span><strong>− ${money(j.discount)}</strong></div>
            <div><span>Tax (${j.taxRate || 0}%)</span><strong>+ ${money(j.tax)}</strong></div>
            <div class="totals-grand"><span>Grand Total</span><strong>${money(j.total)}</strong></div>
            <div><span>Paid</span><strong>${money(bal.paid)}</strong></div>
            <div class="${bal.due > 0 ? 'totals-due' : ''}"><span>Due</span><strong>${money(bal.due)}</strong></div>
          </div>
          ${advanceList(j)}`)}
        </div>
      </div>`,
      footer: `
        <button class="btn btn--ghost" data-print-view>Print</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        ${canAdvance ? `<a class="btn btn--ghost" href="payments.html?advanceFor=${encodeURIComponent(j.id)}">Record Advance</a>` : ''}
        ${linkedInvoice ? `<a class="btn btn--ghost" href="invoices.html?view=${encodeURIComponent(linkedInvoice.id)}">View Invoice</a>` :
          (['Completed', 'Delivered'].includes(j.status) && Number(j.total) > 0 ? `<a class="btn btn--ghost" href="invoices.html?fromJobCard=${encodeURIComponent(j.id)}">Create Invoice</a>` : '')}
        ${!TERMINAL.includes(j.status) ? '<button class="btn btn--primary" data-edit-from-view>Edit Job Card</button>' : ''}`
    });
    const editBtn = document.querySelector('[data-edit-from-view]');
    if (editBtn) editBtn.addEventListener('click', () => { Modal.close(); openEditModal(id); });
    document.querySelector('[data-print-view]').addEventListener('click', () => printJobCard(id));

    // Header: icon, a "Job Card" label and the job id; the dialog keeps its
    // full aria-label. Tabs switch the work-details panels. (Skipped when
    // Modal.open hands back no real element, as in the unit tests' stub.)
    const modal = ov && ov.querySelector ? ov.querySelector('.modal') : null;
    if (!modal || typeof modal.querySelector !== 'function') return;
    modal.classList.add('veh-view', 'jcv-modal');
    const title = modal.querySelector('.modal__head h2');
    if (title) {
      title.textContent = j.id;
      title.insertAdjacentHTML('beforebegin', `<span class="veh-view__icon" aria-hidden="true">${jcvIcon(JC_ICONS.job, 26)}</span>`);
      const titles = document.createElement('div');
      titles.className = 'veh-view__titles';
      title.replaceWith(titles);
      titles.insertAdjacentHTML('beforeend', '<span class="jcv-kicker">Job Card</span>');
      titles.append(title);
    }
    const tabButtons = [...modal.querySelectorAll('.jcv-tab')];
    // Modal.open() focused the first button, which is now a tab; focus stays where it always was, on Print
    if (tabButtons.includes(document.activeElement)) {
      const print = modal.querySelector('[data-print-view]');
      if (print) print.focus();
    }
    const select = tab => {
      tabButtons.forEach(b => {
        const on = b === tab;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        modal.querySelector(`#${b.getAttribute('aria-controls')}`).hidden = !on;
      });
    };
    tabButtons.forEach((b, i) => {
      b.addEventListener('click', () => select(b));
      b.addEventListener('keydown', e => {
        const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabButtons.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        const next = tabButtons[(to + tabButtons.length) % tabButtons.length];
        select(next);
        next.focus();
      });
    });
  }

  /* ---------- print ---------- */

  /* The phone printed on every Job Card. The Settings phone is still the
     placeholder "+880 1XXX-XXXXXX", so the print carries the workshop's real
     number rather than reading it from there. */
  const WORKSHOP_PHONE = '01854226757';

  // Page margin marks naming this job card: every page's footer, and a
  // "continued" line at the top of every page after the first.
  function jobPageMarks(jobId) {
    const id = String(jobId).replace(/[^\w\- ]/g, '');
    return `@page jobcard {
        @bottom-center { content: "${id} · Page " counter(page) " of " counter(pages); }
        @top-right { content: "Taqwa Automobile · ${id} (continued)"; font: 8pt sans-serif; color: #777; }
      }
      @page jobcard:first { @top-right { content: none; } }`;
  }

  function printJobCard(id) {
    const j = Storage.getById('jobCards', id);
    if (!j) return;
    const settings = Storage.getSettings();
    const vehicle = veh(j.vehicleId);
    const customer = Storage.getById('customers', j.customerId);
    const mechanic = mec(j.mechanicId);
    const t = computeTotals(j);
    const bal = Utils.liveJobBalance(j);
    const root = (document.body.dataset && document.body.dataset.root) || '../';

    const lineRows = (lines, isService) => (lines || []).map((l, i) =>
      `<tr><td class="jcp-no">${i + 1}</td><td>${esc(l.name)}${isService && isCustomWork(l) ? ' (Custom)' : ''}${!isService && l.partNo ? ` (${esc(l.partNo)})` : ''}</td>
       <td class="pr-num">${l.qty}</td><td class="pr-num">${money(l.unitPrice)}</td><td class="pr-num">${money(l.total)}</td></tr>`).join('');
    const lineTable = (lines, isService) => `
      <table class="jcp-table">
        <thead><tr><th class="jcp-no">#</th><th>${isService ? 'Service / Work' : 'Part'}</th><th class="pr-num">Qty</th><th class="pr-num">Unit Price</th><th class="pr-num">Total</th></tr></thead>
        <tbody>${lineRows(lines, isService)}</tbody>
      </table>`;

    const inspEntries = Object.entries(j.inspectionChecklist || {}).filter(([, v]) => v.state || v.note);
    const inspTable = entries => `
        <table class="jcp-table">
          <thead><tr><th>Item</th><th>Condition</th><th>Note</th></tr></thead>
          <tbody>${entries.map(([item, v]) => `<tr><td>${esc(item)}</td><td>${esc(v.state || '—')}</td><td>${esc(v.note || '')}</td></tr>`).join('')}</tbody>
        </table>`;
    // more than three items: two tables side by side, so a full checklist takes half the height
    const half = Math.ceil(inspEntries.length / 2);
    const inspBody = inspEntries.length > 3
      ? `<div class="jcp-insp-cols">${inspTable(inspEntries.slice(0, half))}${inspTable(inspEntries.slice(half))}</div>`
      : inspTable(inspEntries);

    const meta = [
      ['Date', fmtDate(j.date)],
      ['Status', esc(j.status)],
      ['Priority', PRIORITIES[j.priority || 'normal']],
      j.appointmentId ? ['Appointment', esc(j.appointmentId)] : null,
      j.estDelivery ? ['Est. Delivery', fmtDate(j.estDelivery)] : null,
      j.completedAt ? ['Completed', fmtDate(j.completedAt)] : null
    ].filter(Boolean);
    const party = (title, rows) => `
      <div class="jcp-party">
        <h3>${title}</h3>
        <dl>${rows.filter(Boolean).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      </div>`;
    const textSection = (title, value, empty = '') => (value || empty) ? `
      <section class="jcp-sec">
        <h3>${title}</h3>
        <p class="jcp-text${value ? '' : ' jcp-empty'}">${value ? esc(value) : empty}</p>
      </section>` : '';

    const area = document.getElementById('printArea');
    area.innerHTML = `
    <div class="jcp">
      <header class="jcp-head">
        <span class="jcp-logo"><img src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile"></span>
        <div class="jcp-org">
          <div class="jcp-org__name">TAQWA AUTOMOBILE</div>
          <div class="jcp-org__tag">Service Center / Workshop</div>
          <div class="jcp-org__phone">Phone: <strong>${WORKSHOP_PHONE}</strong></div>
          ${settings.address ? `<div class="jcp-org__addr">${esc(settings.address)}</div>` : ''}
        </div>
      </header>

      <section class="jcp-title">
        <div class="jcp-doc"><span class="jcp-doc__label">JOB CARD</span><span class="jcp-doc__id">${esc(j.id)}</span></div>
        <dl class="jcp-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
      </section>

      <section class="jcp-parties">
        ${party('Customer', [
          ['Name', customer ? esc(customer.name) : 'Unknown Customer'],
          ['Phone', customer ? esc(customer.phone) : '—']
        ])}
        ${party('Vehicle', [
          ['Vehicle', vehicle ? esc(`${vehicle.brand} ${vehicle.model}`) : 'Unknown Vehicle'],
          ['Registration', esc(vehReg(j.vehicleId))],
          vehicle && vehicle.vin ? ['VIN', esc(vehicle.vin)] : null,
          ['Mileage In / Out', `${j.mileage ? Number(j.mileage).toLocaleString('en-IN') : '—'} / ${j.mileageOut ? Number(j.mileageOut).toLocaleString('en-IN') : '—'} km`],
          j.fuelLevel ? ['Fuel Level', FUEL_LABELS[j.fuelLevel] || esc(j.fuelLevel)] : null
        ])}
        ${party('Mechanic', [
          ['Mechanic', esc(mecName(j.mechanicId))],
          mechanic && mechanic.specialization ? ['Specialization', esc(mechanic.specialization)] : null,
          ['Status', esc(j.status)],
          ['Priority', PRIORITIES[j.priority || 'normal']]
        ])}
      </section>

      <div class="jcp-texts">
        ${textSection('Customer Complaint', j.complaint, 'No complaint recorded.')}
        ${textSection('Vehicle Condition / Belongings', j.conditionNotes)}
        ${textSection('Diagnosis', j.diagnosis)}
      </div>

      <section class="jcp-sec">
        <h3>Services</h3>
        ${(j.services || []).length ? lineTable(j.services, true) : '<p class="jcp-text jcp-empty">No services recorded.</p>'}
      </section>

      <section class="jcp-sec">
        <h3>Parts Used</h3>
        ${(j.partsUsed || []).length ? lineTable(j.partsUsed, false) : '<p class="jcp-text jcp-empty">No parts recorded.</p>'}
      </section>

      ${Number(j.labourCost) > 0 ? `
      <section class="jcp-sec jcp-labour">
        <h3>Labour</h3>
        <span><em>Hours</em> ${j.labourHours ? esc(j.labourHours) : '—'}</span>
        <span><em>Rate (BDT/hr)</em> ${j.labourRate ? money(j.labourRate) : '—'}</span>
        <span class="jcp-labour__total"><em>Labour Total</em> ${money(j.labourCost || 0)}</span>
      </section>` : ''}

      ${inspEntries.length ? `
      <section class="jcp-sec">
        <h3>Inspection</h3>
        ${inspBody}
      </section>` : ''}

      <div class="jcp-close">
      <section class="jcp-end">
        <div class="jcp-end__left">
          <div class="jcp-end__notes">
            ${j.notes ? `<h3>Notes</h3><p class="jcp-text">${esc(j.notes)}</p>` : ''}
          </div>
          <div class="jcp-sign">
            <div><span class="jcp-sign__line"></span>Customer Signature</div>
            <div><span class="jcp-sign__line"></span>Service Advisor</div>
          </div>
        </div>
        <table class="jcp-sum">
          <tr><td>Services</td><td class="pr-num">${money(t.serviceTotal)}</td></tr>
          <tr><td>Parts</td><td class="pr-num">${money(t.partsTotal)}</td></tr>
          <tr><td>Labour</td><td class="pr-num">${money(j.labourCost || 0)}</td></tr>
          <tr class="jcp-sum__sub"><td>Subtotal</td><td class="pr-num">${money(j.subtotal)}</td></tr>
          <tr><td>Discount</td><td class="pr-num">− ${money(j.discount)}</td></tr>
          <tr><td>Tax (${j.taxRate || 0}%)</td><td class="pr-num">+ ${money(j.tax)}</td></tr>
          <tr class="jcp-sum__grand"><td>GRAND TOTAL</td><td class="pr-num">${money(j.total)}</td></tr>
          <tr><td>Paid</td><td class="pr-num">${money(bal.paid)}</td></tr>
          <tr class="jcp-sum__due"><td>DUE</td><td class="pr-num">${money(bal.due)}</td></tr>
        </table>
      </section>

      <footer class="jcp-foot">
        <p>${esc(settings.invoiceFooter)}</p>
        <p>Taqwa Automobile · Phone: ${WORKSHOP_PHONE}</p>
      </footer>
      </div>
      <style>${jobPageMarks(j.id)}</style>
    </div>`;

    // Print once the logo has loaded, so it is on the page that gets printed.
    document.body.classList.add('printing-job');
    const go = () => {
      window.print();
      setTimeout(() => document.body.classList.remove('printing-job'), 300);
    };
    const logo = area.querySelector ? area.querySelector('.jcp-logo img') : null;
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
    populateMechanicFilter();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addJobBtn').addEventListener('click', () => openCreateModal());
    document.getElementById('jobSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    document.getElementById('jobQuick').addEventListener('change', e => { fQuick = e.target.value; renderList(); });
    document.getElementById('jobStatus').addEventListener('change', e => { fStatus = e.target.value; renderList(); });
    document.getElementById('jobPriority').addEventListener('change', e => { fPriority = e.target.value; renderList(); });
    document.getElementById('jobMechanic').addEventListener('change', e => { fMechanic = e.target.value; renderList(); });
    document.getElementById('jobDate').addEventListener('change', e => { fDate = e.target.value; renderList(); });
    document.getElementById('jobSort').addEventListener('change', e => { sortBy = e.target.value; renderList(); });

    document.getElementById('jobTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openCreateModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      // A status change writes (and on a job card moves stock), so the row's
      // own button is held until the server answers. Delegated, so the button
      // is this row's rather than the one the listener sits on.
      if (action === 'status') { Utils.guard(btn, () => changeStatus(id, btn.dataset.next)); return; }
      if (action === 'print') printJobCard(id);
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const params = new URLSearchParams(location.search);
    const viewId = params.get('view');
    const fromApt = params.get('fromAppointment');
    if (viewId && Storage.getById('jobCards', viewId)) openDetailModal(viewId);
    else if (fromApt) openCreateModal(fromApt);
  });

})();
