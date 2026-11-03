/* ============================================================
   equipment-inventory.js — Workshop Assets › Equipment Inventory
   ------------------------------------------------------------
   Loaded only by pages/equipment-inventory.html. A REAL page: every
   item shown comes from the workshop database and every change goes
   back through the API. It is the same register as Tools & Equipment
   (table `tools`, migrations 0013 + 0021) -- one physical item, one
   record -- so nothing is kept twice.

     List / search    GET /api/tools -- the server searches (ID, name,
                      brand, model, serial), filters (category, status,
                      purchase date), sorts and pages; its meta fills the
                      summary cards. Nothing is downloaded in full.
     Add / Edit       POST /api/tools, PUT /api/tools/:id (expectedUpdatedAt)
     Assign / Return  PUT with assignedStaffId | assignedMechanicId and
                      status In Use (shown here as "Assigned"), or back
     Deactivate       POST /api/tools/:id/retire      (tools.manage)
     Reactivate       POST /api/tools/:id/reactivate  (tools.manage)
     Delete           DELETE /api/tools/:id           (tools.delete)
     Details          GET /api/tools/:id -- with the item's history

   Permissions: buttons follow Storage.can(); the server checks every
   request again, so a hidden button is a convenience, not the guard.

   Offline (js/sync.js): a NEW item can be added, and an item added on
   this computer can be edited before it syncs; both wait in the queue
   and are sent when the internet is back (idempotent on the server, a
   refusal becomes a conflict in the Conflict Center). Everything else
   -- reading the register, assigning, deactivating, deleting -- needs
   the internet, and the page says so instead of showing stale numbers.

   Everything from the data is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const EquipmentInventory = (() => {

  /* ---------- vocabulary (the API's own lists: 0013's CHECKs) ---------- */

  const CATEGORIES = ['Diagnostic Equipment', 'Engine Tools', 'Electrical Tools', 'AC Service Equipment',
    'Lifting Equipment', 'Workshop Hand Tools', 'Safety Equipment', 'Cleaning Equipment', 'Other'];
  const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Damaged'];
  const STATUSES = ['Available', 'In Use', 'Under Maintenance', 'Damaged', 'Retired'];
  /** In Use is reached by assigning; Retired by Deactivate. Neither is picked in the form. */
  const FORM_STATUSES = ['Available', 'Under Maintenance', 'Damaged'];
  const USABLE = ['Available', 'In Use'];
  const USABLE_CONDITIONS = ['Excellent', 'Good', 'Fair'];
  /** On this page the stored 'In Use' reads as "Assigned"; Retired reads as "Inactive (Retired)". */
  const STATUS_LABEL = { 'In Use': 'Assigned', Retired: 'Inactive (Retired)' };
  const statusLabel = (s) => STATUS_LABEL[s] || s;

  const LIMITS = { name: 120, brand: 80, model: 80, serialNo: 80, supplier: 160, location: 80,
    description: 500, notes: 1000, reason: 300 };
  const MAX_PRICE = 100000000;
  const EARLIEST = '1980-01-01';

  const FIELDS = ['name', 'category', 'brand', 'model', 'serialNo', 'purchaseDate', 'purchasePrice',
    'supplier', 'warrantyExpiry', 'location', 'condition', 'status', 'description', 'notes',
    'lastServiceDate', 'nextServiceDue'];

  const STATUS_TONE = { Available: 'available', 'In Use': 'assigned', 'Under Maintenance': 'maintenance', Damaged: 'damaged', Retired: 'retired' };
  const CONDITION_TONE = { Excellent: 'excellent', Good: 'good', Fair: 'fair', Poor: 'poor', Damaged: 'damaged' };
  const MAINT_TONE = { Overdue: 'bad', 'Due soon': 'warn', 'Under maintenance': 'warn', Scheduled: 'good', 'Not scheduled': 'none', 'Not applicable': 'none' };

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  function todayInDhaka(at = new Date()) {
    return at.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  }

  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  function isRealDate(s) {
    if (!DATE_ONLY.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }

  /**
   * The form's values checked with the server's own rules, so a mistake is
   * named before anything is sent. The server checks again. Returns { field: message }.
   * `current` is the item being edited (its status may be In Use, which the form keeps).
   */
  function validate(v, today = todayInDhaka(), current = null) {
    const e = {};
    const text = (k) => String(v[k] ?? '').trim();
    if (!text('name')) e.name = 'Enter the equipment name.';
    else if (text('name').length > LIMITS.name) e.name = `Keep the name to ${LIMITS.name} characters or fewer.`;
    if (!CATEGORIES.includes(v.category)) e.category = 'Choose a category.';
    if (!CONDITIONS.includes(v.condition)) e.condition = 'Choose the condition.';
    const statusChoices = current && current.status === 'In Use' ? [...FORM_STATUSES, 'In Use'] : FORM_STATUSES;
    if (!statusChoices.includes(v.status)) e.status = 'Choose the status.';
    for (const k of ['brand', 'model', 'serialNo', 'supplier', 'location', 'description', 'notes']) {
      if (text(k).length > LIMITS[k]) e[k] = `Keep this to ${LIMITS[k]} characters or fewer.`;
    }
    const price = text('purchasePrice');
    if (price !== '') {
      const n = Number(price);
      if (!Number.isFinite(n)) e.purchasePrice = 'Enter the price as a number.';
      else if (n < 0) e.purchasePrice = 'The price cannot be negative.';
      else if (n > MAX_PRICE) e.purchasePrice = 'That price is too large.';
    }
    const bought = text('purchaseDate');
    if (bought) {
      if (!isRealDate(bought)) e.purchaseDate = 'Enter a real date.';
      else if (bought < EARLIEST) e.purchaseDate = `The purchase date cannot be before ${EARLIEST}.`;
      else if (bought > today) e.purchaseDate = 'The purchase date cannot be in the future.';
    }
    const warranty = text('warrantyExpiry');
    if (warranty) {
      if (!isRealDate(warranty)) e.warrantyExpiry = 'Enter a real date.';
      else if (bought && isRealDate(bought) && warranty < bought) e.warrantyExpiry = 'Warranty expiry must be on or after the purchase date.';
    }
    const last = text('lastServiceDate');
    if (last) {
      if (!isRealDate(last)) e.lastServiceDate = 'Enter a real date.';
      else if (last < EARLIEST) e.lastServiceDate = `The last service cannot be before ${EARLIEST}.`;
      else if (last > today) e.lastServiceDate = 'The last service cannot be in the future.';
    }
    const next = text('nextServiceDue');
    if (next) {
      if (!isRealDate(next)) e.nextServiceDue = 'Enter a real date.';
      else if (last && isRealDate(last) && next < last) e.nextServiceDue = 'The next service must be on or after the last one.';
    }
    if (!e.status && !e.condition) {
      if (v.condition === 'Damaged' && USABLE.includes(v.status)) {
        e.status = 'Damaged equipment cannot be Available or Assigned. Choose Damaged or Under Maintenance.';
      } else if (USABLE.includes(v.status) && !USABLE_CONDITIONS.includes(v.condition)) {
        e.status = `Equipment in ${v.condition} condition cannot be ${statusLabel(v.status)}. Choose Under Maintenance or Damaged.`;
      }
    }
    return e;
  }

  function normalise(v) {
    const out = {};
    for (const k of FIELDS) {
      const raw = String(v[k] ?? '').trim();
      out[k] = k === 'purchasePrice' ? (raw === '' ? null : Number(raw)) : raw;
    }
    return out;
  }

  /**
   * The body to send. A new item sends every filled field; an edit sends only
   * what changed plus the updatedAt it was made from. No change -> null.
   */
  function payload(values, original = null) {
    const v = normalise(values);
    if (!original) {
      const body = {};
      for (const k of FIELDS) if (v[k] !== '' && v[k] !== null) body[k] = v[k];
      return body;
    }
    const before = normalise(original);
    const body = {};
    for (const k of FIELDS) if (v[k] !== before[k]) body[k] = v[k] === null ? '' : v[k];
    if (!Object.keys(body).length) return null;
    body.expectedUpdatedAt = original.updatedAt;
    return body;
  }

  /** The list's query for `state`; empty filters are left out. */
  function buildQuery(state) {
    const q = {};
    if (state.q) q.q = state.q;
    for (const k of ['category', 'status']) if (state[k]) q[k] = state[k];
    if (state.from) q.purchasedFrom = state.from;
    if (state.to) q.purchasedTo = state.to;
    const [sort, order] = String(state.sort || 'createdAt:desc').split(':');
    q.sort = sort; q.order = order;
    q.limit = String(state.limit);
    q.offset = String(state.offset || 0);
    return q;
  }

  /** The body of an assignment: exactly one of the two person fields, and In Use. */
  function assignBody(person, tool) {
    if (!person || !person.id) return null;
    return {
      assignedStaffId: person.isMechanic ? '' : person.id,
      assignedMechanicId: person.isMechanic ? person.id : '',
      status: 'In Use',
      expectedUpdatedAt: tool.updatedAt,
    };
  }

  /** The body of a return: nobody holds it, and it goes back to `status`. */
  function returnBody(tool, status = 'Available') {
    return { assignedStaffId: '', assignedMechanicId: '', status, expectedUpdatedAt: tool.updatedAt };
  }

  /**
   * Which actions this caller may take on `tool`. `can` is a permission test
   * (Storage.can in the page). The server decides; this only hides buttons.
   */
  function actionsFor(tool, can) {
    const retired = tool.status === 'Retired';
    const assigned = tool.status === 'In Use' || Boolean(tool.assignedTo);
    const usable = USABLE_CONDITIONS.includes(tool.condition);
    return {
      view: true,
      edit: !retired && can('tools.edit'),
      assign: !retired && !assigned && tool.status === 'Available' && usable && can('tools.edit'),
      return: !retired && assigned && can('tools.edit'),
      retire: !retired && can('tools.manage'),
      reactivate: retired && can('tools.manage'),
      delete: !assigned && can('tools.delete'),
    };
  }

  const CSV_COLUMNS = [
    ['Equipment ID', 'id'], ['Name', 'name'], ['Category', 'category'], ['Brand', 'brand'], ['Model', 'model'],
    ['Serial Number', 'serialNo'], ['Location', 'location'], ['Condition', 'condition'], ['Status', (r) => statusLabel(r.status)],
    ['Assigned To', (r) => (r.assignedTo ? `${r.assignedTo.name} (${r.assignedTo.id})` : '')],
    ['Maintenance', 'maintenanceStatus'], ['Last Service', 'lastServiceDate'], ['Next Service Due', 'nextServiceDue'],
    ['Purchase Date', 'purchaseDate'], ['Purchase Price', 'purchasePrice'], ['Supplier', 'supplier'],
    ['Warranty Expiry', 'warrantyExpiry'], ['Description', 'description'], ['Notes', 'notes'],
    ['Created At', 'createdAt'], ['Updated At', 'updatedAt'],
  ];
  /** CSV text; a cell a spreadsheet would read as a formula is prefixed with '. */
  function toCsv(rows) {
    const cell = (value) => {
      let s = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const get = (r, k) => (typeof k === 'function' ? k(r) : r[k]);
    const lines = [CSV_COLUMNS.map(([h]) => cell(h)).join(',')];
    for (const r of rows) lines.push(CSV_COLUMNS.map(([, k]) => cell(get(r, k))).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  /** Offline/queued equipment from the sync outbox: [{ id, name, category, state, message }]. */
  function queuedFrom(outbox) {
    return (outbox || [])
      .filter((o) => o.collection === 'tools' && o.kind === 'create' && ['pending', 'syncing', 'conflict', 'failed'].includes(o.state))
      .map((o) => ({
        id: o.tempId, name: (o.data && o.data.name) || '(unnamed)', category: (o.data && o.data.category) || '',
        state: o.state, message: o.error || o.reason || '',
      }));
  }

  /* ---------- page state ---------- */

  const state = {
    q: '', category: '', status: '', from: '', to: '', sort: 'createdAt:desc', limit: 25, offset: 0,
    rows: [], meta: null, loading: false, error: null, offline: false,
  };
  let requestSeq = 0;
  let searchTimer = null;
  let people = null;      // the Active roster for assignment, read once when first needed

  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const can = (perm) => (typeof Storage !== 'undefined' && Storage.can ? Storage.can(perm) : true);

  const ICON = {
    view: '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>',
    edit: '<path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/>',
    assign: '<path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>',
    return: '<path d="M19 7v4H5.83l3.58-3.59L8 6l-6 6 6 6 1.41-1.41L5.83 13H21V7z"/>',
    retire: '<path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>',
    reactivate: '<path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>',
    delete: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
    alert: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>',
    empty: '<path d="M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z"/>',
    offline: '<path d="M23.64 7c-.45-.34-4.93-4-11.64-4-1.5 0-2.89.19-4.15.48L18.18 13.8 23.64 7zm-6.6 8.22L3.27 1.44 2 2.72l2.05 2.06C1.91 5.76.59 6.82.36 7l11.63 14.49.01.01.01-.01 3.9-4.86 3.32 3.32 1.27-1.27-3.46-3.46z"/>',
  };
  const svg = (path, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${path}</svg>`;

  const statusBadge = (s) => `<span class="ei-status ei-status--${STATUS_TONE[s] || 'retired'}">${esc(statusLabel(s))}</span>`;
  const conditionBadge = (c) => `<span class="ei-cond ei-cond--${CONDITION_TONE[c] || 'fair'}">${esc(c)}</span>`;
  const maintBadge = (m) => `<span class="ei-maint ei-maint--${MAINT_TONE[m] || 'none'}">${esc(m || 'Not scheduled')}</span>`;
  const dash = '<span class="ei-none">&#8212;</span>';
  const orDash = (v) => (v === '' || v === null || v === undefined ? dash : esc(v));
  const brandModel = (t) => [t.brand, t.model].filter(Boolean).join(' · ');
  const holder = (t) => (t.assignedTo ? `${esc(t.assignedTo.name)} <span class="ei-sub">${esc(t.assignedTo.kind === 'mechanic' ? 'Mechanic' : 'Staff')} · ${esc(t.assignedTo.id)}</span>` : dash);
  const moneyOr = (n) => (n === null || n === undefined || n === '' ? dash : esc(Utils.money(n)));
  const fmtDay = (d) => (d ? esc(Utils.fmtDate(d)) : dash);

  /* ---------- rendering ---------- */

  function setText(id, text) { const el = $(id); if (el) el.textContent = text; }

  function renderSummary(meta) {
    const s = (meta && meta.summary) || {};
    const n = (v) => (Number.isFinite(v) ? String(v) : '—');
    setText('eiTotal', n(s.total));
    setText('eiAvailable', n(s.available));
    setText('eiAssigned', n(s.inUse));
    setText('eiMaint', n(s.underMaintenance));
    setText('eiDamaged', n(s.damaged));
    setText('eiValue', meta && Number.isFinite(meta.purchaseValue) ? Utils.money(meta.purchaseValue) : '—');
    const due = meta && Number.isFinite(meta.serviceDue) ? meta.serviceDue : null;
    setText('eiMaintSub', due ? `${due} due for service soon or overdue` : 'Being serviced or repaired');
    setText('eiTotalSub', s && Number.isFinite(s.retired) && s.retired ? `In service · ${s.retired} inactive not counted` : 'In service, excluding inactive');
  }

  function showList(show) {
    $('eiTableWrap').hidden = !show;
    $('eiCards').hidden = !show;
    $('eiFoot').hidden = !show;
  }

  function renderState(kind, opts = {}) {
    const host = $('eiState');
    if (kind === 'none') { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;
    if (kind === 'loading') {
      host.innerHTML = `<div class="ei-skeleton" aria-label="Loading equipment">${'<span class="ei-skeleton__row"></span>'.repeat(5)}</div>
        <span class="ei-sr-only">Loading equipment…</span>`;
      return;
    }
    const tone = kind === 'empty' ? '' : ' ei-state__box--bad';
    host.innerHTML = `<div class="empty ei-state__box${tone}">
        ${svg(kind === 'empty' ? ICON.empty : kind === 'offline' ? ICON.offline : ICON.alert, 40)}
        <h3>${esc(opts.title)}</h3>
        <p>${esc(opts.text)}</p>
        ${opts.action ? `<button type="button" class="btn btn--ghost btn--sm" data-state-action="${esc(opts.action)}">${esc(opts.actionLabel)}</button>` : ''}
      </div>`;
  }

  function actionButtons(t) {
    const a = actionsFor(t, can);
    const b = (act, label, extra = '') => `<button type="button" class="ei-act${extra}" data-act="${act}" data-id="${esc(t.id)}" aria-label="${esc(label)} ${esc(t.name)}" title="${esc(label)}">${svg(ICON[act])}</button>`;
    return `<div class="ei-actions">
        ${b('view', 'View details')}
        ${a.edit ? b('edit', 'Edit') : ''}
        ${a.assign ? b('assign', 'Assign') : ''}
        ${a.return ? b('return', 'Return') : ''}
        ${a.retire ? b('retire', 'Deactivate', ' ei-act--warn') : ''}
        ${a.reactivate ? b('reactivate', 'Reactivate') : ''}
        ${a.delete ? b('delete', 'Delete', ' ei-act--danger') : ''}
      </div>`;
  }

  function renderRows(rows) {
    $('eiBody').innerHTML = rows.map(t => `
      <tr${t.status === 'Retired' ? ' class="ei-row--retired"' : ''}>
        <td class="ei-c-code">${esc(t.id)}</td>
        <td><div class="ei-item"><button type="button" class="ei-item__name" data-act="view" data-id="${esc(t.id)}">${esc(t.name)}</button>
          <span class="ei-sub ei-item__cat">${esc(t.category)}</span>
          ${t.serialNo ? `<span class="ei-sub">S/N ${esc(t.serialNo)}</span>` : ''}</div></td>
        <td>${esc(t.category)}</td>
        <td>${orDash(brandModel(t))}</td>
        <td>${holder(t)}</td>
        <td>${orDash(t.location)}</td>
        <td>${conditionBadge(t.condition)}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${maintBadge(t.maintenanceStatus)}</td>
        <td class="ei-c-num">${moneyOr(t.purchasePrice)}</td>
        <td class="ei-c-actions">${actionButtons(t)}</td>
      </tr>`).join('');

    $('eiCards').innerHTML = rows.map(t => `
      <li class="ei-card${t.status === 'Retired' ? ' ei-row--retired' : ''}">
        <div class="ei-card__head">
          <div class="ei-item">
            <button type="button" class="ei-item__name" data-act="view" data-id="${esc(t.id)}">${esc(t.name)}</button>
            <span class="ei-sub">${esc(t.id)} · ${esc(t.category)}</span>
          </div>
          ${statusBadge(t.status)}
        </div>
        <dl class="ei-card__facts">
          <div><dt>Brand / Model</dt><dd>${orDash(brandModel(t))}</dd></div>
          <div><dt>Assigned to</dt><dd>${holder(t)}</dd></div>
          <div><dt>Location</dt><dd>${orDash(t.location)}</dd></div>
          <div><dt>Condition</dt><dd>${conditionBadge(t.condition)}</dd></div>
          <div><dt>Maintenance</dt><dd>${maintBadge(t.maintenanceStatus)}</dd></div>
          <div><dt>Price</dt><dd>${moneyOr(t.purchasePrice)}</dd></div>
        </dl>
        ${actionButtons(t)}
      </li>`).join('');
  }

  function renderFoot(meta) {
    const total = meta.total || 0;
    const from = total ? meta.offset + 1 : 0;
    const to = meta.offset + state.rows.length;
    setText('eiCount', total ? `Showing ${from}–${to} of ${total} item${total === 1 ? '' : 's'}` : 'No equipment');
    const pages = Math.max(1, Math.ceil(total / state.limit));
    const page = Math.floor(meta.offset / state.limit) + 1;
    setText('eiPageLabel', `Page ${page} of ${pages}`);
    $('eiPrev').disabled = meta.offset <= 0;
    $('eiNext').disabled = to >= total;
  }

  function renderQueued() {
    const host = $('eiQueued');
    const list = typeof Sync !== 'undefined' && Sync.isOpen && Sync.isOpen() ? queuedFrom(Sync.outbox()) : [];
    if (!list.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    const tone = { pending: 'Waiting to sync', syncing: 'Sending…', conflict: 'Needs review (Conflict Center)', failed: 'Not sent — will retry' };
    host.innerHTML = `<h3 class="ei-queued__title">Saved on this computer, not yet in the workshop database (${list.length})</h3>
      <ul class="ei-queued__list">${list.map((q) => `<li><strong>${esc(q.name)}</strong> <span class="ei-sub">${esc(q.id)}${q.category ? ` · ${esc(q.category)}` : ''}</span>
        <span class="ei-queued__state ei-queued__state--${esc(q.state)}">${esc(tone[q.state] || q.state)}</span>
        ${q.message ? `<span class="ei-sub">${esc(q.message)}</span>` : ''}</li>`).join('')}</ul>
      <p class="ei-sub">They are sent automatically when the internet is back. <a href="offline-sync.html">Open Offline Sync</a>${list.some((q) => q.state === 'conflict') ? ' · <a href="sync-conflicts.html">Open the Conflict Center</a>' : ''}</p>`;
  }

  const filtered = () => Boolean(state.q || state.category || state.status || state.from || state.to);

  function render() {
    $('eiClear').hidden = !filtered();
    renderQueued();
    $('eiAdd').hidden = !can('tools.create');
    $('eiExport').hidden = !can('tools.export');
    if (state.offline) {
      showList(false);
      renderSummary(null);
      $('eiExport').disabled = true;
      $('eiAdd').disabled = !(typeof Sync !== 'undefined' && Sync.isOpen && Sync.isOpen());
      renderState('offline', {
        title: 'You are offline',
        text: $('eiAdd').disabled
          ? 'The equipment register is in the workshop database, which needs the internet. Nothing is shown from memory.'
          : 'The register needs the internet, so it is not shown. You can still add new equipment: it is saved on this computer and sent when you are back online.',
      });
      return;
    }
    if (state.loading && !state.rows.length) { showList(false); renderState('loading'); return; }
    if (state.error) {
      showList(false);
      renderSummary(null);
      $('eiExport').disabled = true;
      renderState('error', state.error);
      return;
    }
    renderSummary(state.meta);
    $('eiExport').disabled = !(state.meta && state.meta.total);
    if (!state.rows.length) {
      showList(false);
      renderState('empty', filtered()
        ? { title: 'No equipment matches', text: 'Try a different search or clear the filters.', action: 'clear', actionLabel: 'Clear filters' }
        : { title: 'No equipment registered yet', text: 'Add the workshop’s first piece of equipment to start the register.', ...(can('tools.create') ? { action: 'add', actionLabel: 'Add Equipment' } : {}) });
      return;
    }
    renderState('none');
    renderRows(state.rows);
    renderFoot(state.meta);
    showList(true);
  }

  function errorFor(res) {
    if (res.code === 'no_api') {
      return { title: 'The workshop database is not connected', text: 'Equipment is kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in its place.' };
    }
    if (res.code === 'unauthorized' || res.code === 'locked') {
      return { title: 'Your session has ended', text: 'Sign in again to see the equipment. Nothing was changed.', action: 'reload', actionLabel: 'Sign in again' };
    }
    if (res.code === 'forbidden' || res.status === 403) {
      return { title: 'Your role cannot see equipment', text: 'Ask an administrator for the Workshop Assets “view” permission.' };
    }
    return { title: 'The equipment could not be loaded', text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.', action: 'retry', actionLabel: 'Retry' };
  }

  /* ---------- loading ---------- */

  async function load() {
    state.offline = Storage.isOffline && Storage.isOffline();
    if (state.offline) { state.loading = false; render(); return false; }
    if (!Storage.isApi()) {
      state.loading = false;
      state.error = errorFor({ code: Storage.isLocked() ? 'locked' : 'no_api' });
      render();
      return false;
    }
    const seq = ++requestSeq;
    state.loading = true;
    state.error = null;
    render();
    const res = await Storage.loadPage('tools', buildQuery(state));
    if (seq !== requestSeq) return false;
    state.loading = false;
    if (!res.ok) {
      state.rows = [];
      state.error = errorFor(res);
      render();
      return false;
    }
    if (!res.rows.length && state.offset > 0 && res.meta && res.meta.total > 0) {
      state.offset = Math.max(0, (Math.ceil(res.meta.total / state.limit) - 1) * state.limit);
      return load();
    }
    state.rows = res.rows;
    state.meta = { ...res.meta, offset: state.offset };
    $('eiAdd').disabled = false;
    render();
    return true;
  }

  const findRow = (id) => state.rows.find(t => t.id === id) || null;

  /* ---------- the people equipment can be assigned to ---------- */

  async function loadPeople() {
    if (people) return people;
    const list = [];
    const res = can('staff.view') ? await Storage.loadPage('staff', { status: 'Active', limit: 1000 }) : { ok: false };
    if (res.ok) {
      for (const p of res.rows) if (p.status === 'Active') list.push({ id: p.id, name: p.name, isMechanic: p.isMechanic, role: p.designation || (p.isMechanic ? 'Mechanic' : 'Staff') });
    } else {
      // No Staff permission: mechanics, from the data every page already has.
      for (const m of Storage.getData('mechanics') || []) {
        if (!m.status || m.status === 'Active') list.push({ id: m.id, name: m.name, isMechanic: true, role: m.specialization || 'Mechanic' });
      }
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    people = list;
    return people;
  }

  /* ---------- forms ---------- */

  const options = (list, chosen, placeholder, label = (x) => x) =>
    (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '') +
    list.map(x => `<option value="${esc(x)}"${x === chosen ? ' selected' : ''}>${esc(label(x))}</option>`).join('');

  function field({ key, label, required = false, type = 'text', value = '', span = false, attrs = '', control = null, hint = '' }) {
    const id = `eif-${key}`;
    const input = control || (type === 'textarea'
      ? `<textarea class="textarea" id="${id}" name="${key}" rows="3" ${attrs}>${esc(value)}</textarea>`
      : `<input class="input" type="${type}" id="${id}" name="${key}" value="${esc(value)}" ${attrs}>`);
    return `<div class="field${span ? ' span-2' : ''}">
        <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${input}
        ${hint ? `<span class="ei-hint" id="${id}-hint">${esc(hint)}</span>` : ''}
        <span class="field__error" data-err="${key}" id="${id}-err" role="alert"></span>
      </div>`;
  }

  function formBody(t) {
    const v = t || { condition: 'Good', status: 'Available' };
    const today = todayInDhaka();
    const max = (n) => `maxlength="${n}"`;
    const section = (title, inner) => `<fieldset class="ei-fieldset"><legend>${esc(title)}</legend><div class="form-grid">${inner}</div></fieldset>`;
    const statuses = t && t.status === 'In Use' ? ['In Use', ...FORM_STATUSES] : FORM_STATUSES;
    return `<form id="eiForm" class="ei-form" novalidate>
      <p class="ei-form__note">Fields marked <span class="req">*</span> are required.${t ? ` Editing <strong>${esc(t.id)}</strong>.` : ' The Equipment ID is assigned when you save.'}</p>
      ${section('Equipment Information',
        field({ key: 'name', label: 'Equipment name', required: true, value: v.name || '', span: true, attrs: `${max(LIMITS.name)} required autocomplete="off" placeholder="e.g. Two Post Car Lift"` }) +
        field({ key: 'category', label: 'Category', required: true, control: `<select class="select" id="eif-category" name="category" required>${options(CATEGORIES, v.category, 'Choose a category')}</select>` }) +
        field({ key: 'brand', label: 'Brand', value: v.brand || '', attrs: `${max(LIMITS.brand)} autocomplete="off"` }) +
        field({ key: 'model', label: 'Model', value: v.model || '', attrs: `${max(LIMITS.model)} autocomplete="off"` }) +
        field({ key: 'serialNo', label: 'Serial number', value: v.serialNo || '', attrs: `${max(LIMITS.serialNo)} autocomplete="off" spellcheck="false"`, hint: 'Unique among equipment in service.' }) +
        field({ key: 'description', label: 'Description', value: v.description || '', span: true, attrs: `${max(LIMITS.description)} autocomplete="off" placeholder="e.g. 4 ton, 220 V"` }))}
      ${section('Purchase Information',
        field({ key: 'purchaseDate', label: 'Purchase date', type: 'date', value: v.purchaseDate || '', attrs: `min="${EARLIEST}" max="${today}"` }) +
        field({ key: 'purchasePrice', label: 'Purchase price (৳)', type: 'number', value: v.purchasePrice ?? '', attrs: `min="0" max="${MAX_PRICE}" step="0.01" inputmode="decimal"` }) +
        field({ key: 'supplier', label: 'Supplier name', value: v.supplier || '', attrs: `${max(LIMITS.supplier)} autocomplete="off"` }) +
        field({ key: 'warrantyExpiry', label: 'Warranty expiry', type: 'date', value: v.warrantyExpiry || '' }))}
      ${section('Location, Condition & Status',
        field({ key: 'location', label: 'Current location', value: v.location || '', span: true, attrs: `${max(LIMITS.location)} autocomplete="off" placeholder="e.g. Bay 2"` }) +
        field({ key: 'condition', label: 'Condition', required: true, control: `<select class="select" id="eif-condition" name="condition" required>${options(CONDITIONS, v.condition)}</select>` }) +
        field({ key: 'status', label: 'Status', required: true, control: `<select class="select" id="eif-status" name="status" required${t && t.status === 'In Use' ? ' disabled' : ''}>${options(statuses, v.status, undefined, statusLabel)}</select>`,
          hint: t && t.status === 'In Use' ? 'Assigned equipment keeps this status until it is returned.' : 'Use Assign to hand it to someone; Deactivate to retire it.' }))}
      ${section('Maintenance',
        field({ key: 'lastServiceDate', label: 'Last service date', type: 'date', value: v.lastServiceDate || '', attrs: `min="${EARLIEST}" max="${today}"` }) +
        field({ key: 'nextServiceDue', label: 'Next service due', type: 'date', value: v.nextServiceDue || '' }))}
      ${section('Notes',
        field({ key: 'notes', label: 'Notes', type: 'textarea', value: v.notes || '', span: true, attrs: max(LIMITS.notes) }))}
    </form>`;
  }

  function readForm(form, t) {
    const v = {};
    for (const k of FIELDS) { const el = form.elements[k]; v[k] = el ? el.value : ''; }
    if (t && t.status === 'In Use') v.status = 'In Use';      // the disabled select is not edited
    return v;
  }

  function showErrors(form, errors) {
    form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
    let first = null;
    for (const [k, msg] of Object.entries(errors || {})) {
      const slot = form.querySelector(`[data-err="${k}"]`);
      const input = form.elements[k];
      if (slot) slot.textContent = msg;
      if (input) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', `eif-${k}-err`); first = first || input; }
    }
    if (first) first.focus();
    return Boolean(first);
  }

  /** A form dialog that asks before throwing away typed changes (backdrop, Esc, Cancel). */
  function guardDirty(ov, dirty) {
    const ask = () => !dirty() || window.confirm('Discard the changes you made?');
    ov.addEventListener('click', (e) => {
      if ((e.target === ov || e.target.closest('[data-modal-close]')) && !ask()) { e.stopImmediatePropagation(); e.preventDefault(); }
    }, true);
    const onKey = (e) => { if (e.key === 'Escape' && document.body.contains(ov) && !ask()) e.stopImmediatePropagation(); };
    document.addEventListener('keydown', onKey, true);
    new MutationObserver((_, obs) => { if (!document.body.contains(ov)) { document.removeEventListener('keydown', onKey, true); obs.disconnect(); } })
      .observe(document.body, { childList: true });
  }

  function openForm(tool = null) {
    const ov = Utils.Modal.open({
      title: tool ? `Edit ${tool.name}` : 'Add Equipment',
      size: 'lg',
      body: formBody(tool),
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="eiForm" class="btn btn--primary" data-ei-save>${tool ? 'Save Changes' : 'Save Equipment'}</button>`,
    });
    ov.classList.add('ei-modal');
    const form = ov.querySelector('#eiForm');
    const start = JSON.stringify(readForm(form, tool));
    guardDirty(ov, () => JSON.stringify(readForm(form, tool)) !== start);
    const saveBtn = ov.querySelector('[data-ei-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(saveBtn, () => save(form, tool));
    });
  }

  async function save(form, tool) {
    const values = readForm(form, tool);
    const errors = validate(values, todayInDhaka(), tool);
    if (showErrors(form, errors)) return;
    const body = payload(values, tool);
    if (tool && !body) { Utils.Modal.close(); Utils.toast('Nothing was changed.', 'info'); return; }
    const res = tool ? await Storage.update('tools', tool.id, body) : await Storage.create('tools', body);
    if (!res.ok) {
      if (res.fields && showErrors(form, res.fields)) { Utils.toast(res.message || 'Some fields need attention.', 'error'); return; }
      Utils.toast(res.message || 'The equipment could not be saved.', 'error');
      if (['concurrent_modification', 'tool_retired'].includes(res.errorReason)) { Utils.Modal.close(); load(); }
      return;
    }
    Utils.Modal.close();
    if (res.pending) {
      Utils.toast(`${res.record.name} was saved on this computer as ${res.record.id}. It will be sent when the internet is back.`, 'warning');
      render();
      return;
    }
    Utils.toast(tool ? `${res.record.name} (${res.record.id}) was updated.` : `${res.record.name} was added as ${res.record.id}.`, 'success');
    if (!tool) state.offset = 0;
    await load();
  }

  /* ---------- assign / return ---------- */

  async function openAssign(t) {
    const list = await loadPeople();
    if (!list.length) { Utils.toast('There is no active staff member or mechanic to assign it to.', 'error'); return; }
    const ov = Utils.Modal.open({
      title: `Assign ${t.name}`,
      body: `<form id="eiAssignForm" novalidate>
          <p class="ei-form__note"><strong>${esc(t.id)}</strong> will be marked <strong>Assigned</strong> to the person you choose.</p>
          <div class="field">
            <label for="eif-person">Staff member or mechanic <span class="req" aria-hidden="true">*</span></label>
            <select class="select" id="eif-person" name="person" required>
              <option value="">Choose a person</option>
              ${list.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} — ${esc(p.role)} (${esc(p.id)})</option>`).join('')}
            </select>
            <span class="field__error" data-err="person" id="eif-person-err" role="alert"></span>
          </div>
        </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="eiAssignForm" class="btn btn--primary" data-ei-confirm>Assign</button>`,
    });
    const form = ov.querySelector('#eiAssignForm');
    const btn = ov.querySelector('[data-ei-confirm]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const person = list.find((p) => p.id === form.elements.person.value);
        if (!person) { showErrors(form, { person: 'Choose who receives it.' }); return; }
        const res = await Storage.update('tools', t.id, assignBody(person, t));
        if (!res.ok) {
          const msg = (res.fields && (res.fields.assignedStaffId || res.fields.assignedMechanicId || res.fields.status)) || res.message;
          if (res.fields && showErrors(form, { person: msg })) return;
          Utils.toast(msg || 'It could not be assigned.', 'error');
          if (res.status === 409) { Utils.Modal.close(); load(); }
          return;
        }
        Utils.Modal.close();
        Utils.toast(`${t.name} is now assigned to ${person.name}.`, 'success');
        await load();
      });
    });
  }

  function openReturn(t) {
    const who = t.assignedTo ? t.assignedTo.name : 'its holder';
    const ov = Utils.Modal.open({
      title: `Return ${t.name}`,
      body: `<form id="eiReturnForm" novalidate>
          <p class="ei-form__note">Record that <strong>${esc(who)}</strong> has returned <strong>${esc(t.id)}</strong>.</p>
          <div class="field">
            <label for="eif-retstatus">Status after return</label>
            <select class="select" id="eif-retstatus" name="status">${options(FORM_STATUSES, USABLE_CONDITIONS.includes(t.condition) ? 'Available' : 'Under Maintenance')}</select>
            <span class="field__error" data-err="status" id="eif-retstatus-err" role="alert"></span>
          </div>
        </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="eiReturnForm" class="btn btn--primary" data-ei-confirm>Record Return</button>`,
    });
    const form = ov.querySelector('#eiReturnForm');
    const btn = ov.querySelector('[data-ei-confirm]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const res = await Storage.update('tools', t.id, returnBody(t, form.elements.status.value));
        if (!res.ok) {
          if (res.fields && showErrors(form, res.fields)) return;
          Utils.toast(res.message || 'The return could not be recorded.', 'error');
          if (res.status === 409) { Utils.Modal.close(); load(); }
          return;
        }
        Utils.Modal.close();
        Utils.toast(`${t.name} was returned.`, 'success');
        await load();
      });
    });
  }

  /* ---------- deactivate (retire) / reactivate / delete ---------- */

  function openRetire(t) {
    const ov = Utils.Modal.open({
      title: `Deactivate ${t.name}?`,
      body: `<form id="eiRetireForm" novalidate>
          <p class="ei-form__note"><strong>${esc(t.id)}</strong> leaves the active register (status Inactive / Retired). Its record and history are kept, and it can be reactivated later.${t.assignedTo ? ` Its assignment to ${esc(t.assignedTo.name)} ends.` : ''}</p>
          <div class="field">
            <label for="eif-reason">Reason <span class="req" aria-hidden="true">*</span></label>
            <textarea class="textarea" id="eif-reason" name="reason" rows="3" maxlength="${LIMITS.reason}" required placeholder="e.g. Beyond economical repair"></textarea>
            <span class="field__error" data-err="reason" id="eif-reason-err" role="alert"></span>
          </div>
        </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="eiRetireForm" class="btn btn--danger" data-ei-confirm>Deactivate</button>`,
    });
    const form = ov.querySelector('#eiRetireForm');
    const btn = ov.querySelector('[data-ei-confirm]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const reason = form.elements.reason.value.trim();
        if (!reason) { showErrors(form, { reason: 'Say why it is being deactivated.' }); return; }
        const res = await Storage.action('tools', t.id, 'retire', { reason, expectedUpdatedAt: t.updatedAt });
        if (!res.ok) {
          if (res.fields && showErrors(form, res.fields)) return;
          Utils.toast(res.message || 'It could not be deactivated.', 'error');
          if (res.status === 409 || res.status === 403) { Utils.Modal.close(); load(); }
          return;
        }
        Utils.Modal.close();
        Utils.toast(`${t.name} (${t.id}) is now inactive.`, 'success');
        await load();
      });
    });
  }

  function openReactivate(t) {
    const fallback = t.condition === 'Damaged' ? 'Damaged' : USABLE_CONDITIONS.includes(t.condition) ? 'Available' : 'Under Maintenance';
    const ov = Utils.Modal.open({
      title: `Reactivate ${t.name}?`,
      body: `<form id="eiReactForm" novalidate>
          <p class="ei-form__note"><strong>${esc(t.id)}</strong> returns to the active register.</p>
          <div class="field">
            <label for="eif-reactstatus">Status</label>
            <select class="select" id="eif-reactstatus" name="status">${options(FORM_STATUSES, fallback)}</select>
            <span class="field__error" data-err="status" id="eif-reactstatus-err" role="alert"></span>
          </div>
        </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="eiReactForm" class="btn btn--primary" data-ei-confirm>Reactivate</button>`,
    });
    const form = ov.querySelector('#eiReactForm');
    const btn = ov.querySelector('[data-ei-confirm]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const res = await Storage.action('tools', t.id, 'reactivate', { status: form.elements.status.value, expectedUpdatedAt: t.updatedAt });
        if (!res.ok) {
          if (res.fields && showErrors(form, res.fields)) return;
          Utils.toast(res.message || 'It could not be reactivated.', 'error');
          if (res.status === 409 || res.status === 403) { Utils.Modal.close(); load(); }
          return;
        }
        Utils.Modal.close();
        Utils.toast(`${t.name} (${t.id}) is back in service.`, 'success');
        await load();
      });
    });
  }

  function openDelete(t) {
    Utils.Modal.confirm({
      title: `Delete ${t.name}?`,
      message: `<strong>${esc(t.id)}</strong> will be removed from the register permanently. Its history entry is kept. `
        + 'To take equipment out of service but keep its record, use <strong>Deactivate</strong> instead. This cannot be undone.',
      confirmText: 'Delete permanently',
      onConfirm: async () => {
        const res = await Storage.remove('tools', t.id);
        if (!res.ok) { Utils.toast(res.message || 'It could not be deleted.', 'error'); await load(); return; }
        Utils.toast(`${t.name} (${t.id}) was deleted.`, 'success');
        await load();
      },
    });
  }

  /* ---------- details ---------- */

  const ACTION_LABEL = { create: 'Added', update: 'Edited', status: 'Status', assign: 'Assigned', return: 'Returned', retire: 'Deactivated', reactivate: 'Reactivated', delete: 'Deleted' };
  const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }) : '');

  function detailsBody(t, events) {
    const item = (label, value, span = false) => `<div class="detail-item${span ? ' span-2' : ''}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
    const by = (iso, who) => `${iso ? esc(stamp(iso)) : dash}${who ? ` <span class="ei-sub">by ${esc(who)}</span>` : ''}`;
    const today = todayInDhaka();
    const warranty = !t.warrantyExpiry ? dash
      : t.warrantyExpiry < today ? `<span class="ei-maint ei-maint--bad">Expired ${esc(Utils.fmtDate(t.warrantyExpiry))}</span>`
        : `<span class="ei-maint ei-maint--good">Until ${esc(Utils.fmtDate(t.warrantyExpiry))}</span>`;
    const holderLink = t.assignedTo
      ? `${esc(t.assignedTo.name)} <span class="ei-sub">(${esc(t.assignedTo.id)})</span> · <a href="${t.assignedTo.kind === 'mechanic' ? `mechanics.html` : `staff-list.html`}">${t.assignedTo.kind === 'mechanic' ? 'Mechanics' : 'Staff List'}</a>`
      : dash;
    return `<div class="ei-detail">
      <div class="ei-detail__head">
        <div><div class="ei-detail__id">${esc(t.id)}</div><div class="ei-sub">${esc(t.category)}</div></div>
        <div class="ei-detail__badges">${statusBadge(t.status)} ${conditionBadge(t.condition)}</div>
      </div>
      ${t.status === 'Retired' ? `<div class="ei-retired-note"><strong>Inactive since ${esc(t.retiredAt ? Utils.fmtDate(t.retiredAt.slice(0, 10)) : '')}</strong> — ${esc(t.retiredReason)}</div>` : ''}
      <h3 class="ei-detail__h">Equipment Information</h3>
      <div class="detail-grid">
        ${item('Name', esc(t.name), true)}${item('Brand', orDash(t.brand))}${item('Model', orDash(t.model))}
        ${item('Serial number', orDash(t.serialNo))}${item('Current location', orDash(t.location))}
        ${t.description ? item('Description', esc(t.description), true) : ''}
      </div>
      <h3 class="ei-detail__h">Purchase Information</h3>
      <div class="detail-grid">
        ${item('Purchase date', fmtDay(t.purchaseDate))}${item('Purchase price', moneyOr(t.purchasePrice))}
        ${item('Supplier', orDash(t.supplier))}${item('Warranty', warranty)}
      </div>
      <h3 class="ei-detail__h">Current Status &amp; Assigned Person</h3>
      <div class="detail-grid">
        ${item('Status', statusBadge(t.status))}${item('Condition', conditionBadge(t.condition))}
        ${item('Assigned to', holderLink, true)}
      </div>
      <h3 class="ei-detail__h">Maintenance Information</h3>
      <div class="detail-grid">
        ${item('Maintenance status', maintBadge(t.maintenanceStatus))}${item('Last service', fmtDay(t.lastServiceDate))}
        ${item('Next service due', fmtDay(t.nextServiceDue))}
      </div>
      <h3 class="ei-detail__h">Notes</h3>
      <p class="ei-detail__notes">${t.notes ? esc(t.notes) : dash}</p>
      <h3 class="ei-detail__h">Previous Activity</h3>
      ${events && events.length
        ? `<ol class="ei-history">${events.map((e) => `<li><span class="ei-history__what">${esc(ACTION_LABEL[e.action] || e.action)}</span> ${esc(e.summary)}
            <span class="ei-sub">${esc(stamp(e.at))}${e.actor ? ` · ${esc(e.actor)}` : ''}</span></li>`).join('')}</ol>`
        : '<p class="ei-sub">No history recorded yet. Changes made from now on are listed here.</p>'}
      <h3 class="ei-detail__h">Related Records</h3>
      <div class="detail-grid ei-detail__stamps">
        ${item('Created', by(t.createdAt, t.createdBy))}${item('Last updated', by(t.updatedAt, t.updatedBy))}
        ${item('Also listed in', '<a href="workshop-tools.html">Tools &amp; Equipment</a> (same register)', true)}
      </div>
    </div>`;
  }

  async function openDetails(id) {
    const res = await Storage.loadOne('tools', id);
    if (!res.ok) { Utils.toast(res.message || 'The equipment could not be loaded.', 'error'); return; }
    const t = res.record;
    const a = actionsFor(t, can);
    const ov = Utils.Modal.open({
      title: t.name,
      size: 'lg',
      body: detailsBody(t, res.meta && res.meta.events),
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        ${a.delete ? '<button type="button" class="btn btn--danger-ghost" data-ei-do="delete">Delete</button>' : ''}
        ${a.retire ? '<button type="button" class="btn btn--danger-ghost" data-ei-do="retire">Deactivate</button>' : ''}
        ${a.reactivate ? '<button type="button" class="btn btn--ghost" data-ei-do="reactivate">Reactivate</button>' : ''}
        ${a.return ? '<button type="button" class="btn btn--ghost" data-ei-do="return">Return</button>' : ''}
        ${a.assign ? '<button type="button" class="btn btn--ghost" data-ei-do="assign">Assign</button>' : ''}
        ${a.edit ? '<button type="button" class="btn btn--primary" data-ei-do="edit">Edit</button>' : ''}`,
    });
    ov.classList.add('ei-modal');
    ov.querySelectorAll('[data-ei-do]').forEach((b) => b.addEventListener('click', () => run(b.dataset.eiDo, t)));
  }

  function run(act, t) {
    if (act === 'view') return openDetails(t.id);
    if (act === 'edit') return openForm(t);
    if (act === 'assign') return openAssign(t);
    if (act === 'return') return openReturn(t);
    if (act === 'retire') return openRetire(t);
    if (act === 'reactivate') return openReactivate(t);
    if (act === 'delete') return openDelete(t);
    return null;
  }

  /* ---------- export ---------- */

  async function exportCsv(btn) {
    await Utils.guard(btn, async () => {
      const rows = [];
      for (let guard = 0; guard < 200; guard++) {
        const res = await Storage.loadPage('tools', buildQuery({ ...state, limit: 1000, offset: rows.length }));
        if (!res.ok) { Utils.toast(res.message || 'The export could not be prepared.', 'error'); return; }
        rows.push(...res.rows);
        const total = res.meta && Number.isFinite(res.meta.total) ? res.meta.total : rows.length;
        if (!res.rows.length || rows.length >= total) break;
      }
      const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `equipment-${todayInDhaka()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      Utils.toast(`Exported ${rows.length} item${rows.length === 1 ? '' : 's'}.`, 'success');
    });
  }

  /* ---------- events ---------- */

  function resetFilters() {
    Object.assign(state, { q: '', category: '', status: '', from: '', to: '', offset: 0 });
    for (const id of ['eiSearch', 'eiCategory', 'eiStatus', 'eiFrom', 'eiTo']) $(id).value = '';
    load();
  }

  function onAct(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const t = findRow(btn.dataset.id);
    if (btn.dataset.act === 'view') openDetails(btn.dataset.id);
    else if (t) run(btn.dataset.act, t);
  }

  function bind() {
    $('eiCategory').insertAdjacentHTML('beforeend', options(CATEGORIES));
    $('eiStatus').insertAdjacentHTML('beforeend', options(STATUSES, '', undefined, statusLabel));
    $('eiTo').max = todayInDhaka();
    $('eiFrom').max = todayInDhaka();
    $('eiAdd').addEventListener('click', () => openForm());
    $('eiSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('eiSearch').value.trim(); state.offset = 0; load(); }, 300);
    });
    for (const [id, key] of [['eiCategory', 'category'], ['eiStatus', 'status'], ['eiSort', 'sort'], ['eiFrom', 'from'], ['eiTo', 'to']]) {
      $(id).addEventListener('change', () => {
        const v = $(id).value;
        if ((key === 'from' || key === 'to') && v && !isRealDate(v)) return;
        state[key] = v; state.offset = 0; load();
      });
    }
    $('eiPageSize').addEventListener('change', () => { state.limit = Number($('eiPageSize').value) || 25; state.offset = 0; load(); });
    $('eiPrev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
    $('eiNext').addEventListener('click', () => { state.offset += state.limit; load(); });
    $('eiClear').addEventListener('click', resetFilters);
    $('eiExport').addEventListener('click', (ev) => exportCsv(ev.currentTarget));
    $('eiBody').addEventListener('click', onAct);
    $('eiCards').addEventListener('click', onAct);
    $('eiState').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-state-action]');
      if (!b) return;
      const a = b.dataset.stateAction;
      if (a === 'retry') load();
      else if (a === 'clear') resetFilters();
      else if (a === 'add') openForm();
      else if (a === 'reload') location.reload();
    });
    // The queue changes as sync runs: keep the "saved on this computer" box current,
    // and read the register again once queued items have reached the server.
    if (typeof Sync !== 'undefined' && Sync.on) {
      let before = 0;
      Sync.on(() => {
        const now = typeof Sync.isOpen === 'function' && Sync.isOpen() ? queuedFrom(Sync.outbox()).length : 0;
        renderQueued();
        if (now < before && !state.offline) load();
        before = now;
      });
    }
  }

  function init() {
    if (document.body.dataset.page !== 'equipment-inventory') return;
    bind();
    state.loading = true;
    render();
    Storage.ready(() => load());
  }

  return {
    CATEGORIES, CONDITIONS, STATUSES, FORM_STATUSES, LIMITS,
    validate, payload, buildQuery, assignBody, returnBody, actionsFor, statusLabel, toCsv, queuedFrom, todayInDhaka,
    init, _state: state, load,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { EquipmentInventory };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) EquipmentInventory.init();
