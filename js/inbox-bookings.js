/* ============================================================
   inbox-bookings.js — Social Inbox › Bookings           (0023)
   ------------------------------------------------------------
   Loaded only by pages/inbox-bookings.html. Every booking comes from
   the workshop database through the Worker:

     GET  /api/bookings               the list (search, status, source,
                                      assigned, paging, status counts)
     GET  /api/bookings/:id           one booking, with history, notes and
                                      possible customer / vehicle matches
     PUT  /api/bookings/:id           assignment, customer and vehicle links
     POST /api/bookings/:id/status    a status change (reason, new date)
     POST /api/bookings/:id/notes     an internal note

   Every change sends expectedUpdatedAt: a change made from an old copy is
   refused by the Worker (409), never lost silently. The Worker also
   decides which status moves are allowed (allowedStatuses); this page
   only offers those.

   Bookings arrive from the website's Book Now form through the Worker's
   public endpoint (POST /api/bookings/submit), never through this page.
   The list refreshes itself every POLL_MS while the page is visible; an
   open booking is refreshed too unless one of its forms holds unsaved
   changes. Without the database the page says so; it never shows sample
   or browser-stored bookings. Everything from the data is escaped.
   ============================================================ */

const InboxBookings = (() => {

  const PAGE_SIZE = 50;
  const POLL_MS = 30000;
  const STATUSES = ['New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Rejected', 'Completed'];
  const SOURCES = ['Website', 'WhatsApp', 'Facebook', 'Phone', 'Walk-in', 'Manual'];
  const TONE = { New: 'new', Pending: 'pending', Confirmed: 'confirmed', Rescheduled: 'rescheduled', Cancelled: 'cancelled', Rejected: 'rejected', Completed: 'completed' };
  const NEEDS_REASON = ['Rejected', 'Cancelled'];
  const ACTION_LABEL = { submitted: 'Received', status: 'Status changed', rescheduled: 'Rescheduled', assigned: 'Assignment', linked: 'Linked', note: 'Note added' };

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** Query string parameters for the list. Empty filters are left out. */
  function buildQuery({ q = '', status = '', source = '', assigned = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (status) out.status = status;
    if (source) out.source = source;
    if (assigned) out.assigned = assigned;
    return out;
  }

  /** '2026-11-06' -> 'Nov 06, 2026'; '10:30' -> '10:30 AM'. Fixed formats, no time zone involved. */
  function dateLabel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${MON[Number(m[2]) - 1]} ${m[3]}, ${m[1]}`;
  }
  function timeLabel(hm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hm || '');
    if (!m) return '';
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }
  function whenLabel(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  function statusHtml(status) {
    return `<span class="bk-status bk-status--${TONE[status] || 'new'}">${Utils.esc(status)}</span>`;
  }

  function cardHtml(b, selectedId) {
    const esc = Utils.esc;
    const active = b.id === selectedId;
    return `<li><button type="button" class="bk-card${active ? ' is-active' : ''}${b.status === 'New' ? ' is-new' : ''}" data-id="${esc(b.id)}"${active ? ' aria-current="true"' : ''}>
        <span class="bk-card__top"><span class="bk-card__name">${esc(b.customerName)}</span>${statusHtml(b.status)}</span>
        <span class="bk-card__meta">${esc(b.id)} · ${esc(b.phone)} · ${esc(`${b.vehicleMake} ${b.vehicleModel}`)}</span>
        <span class="bk-card__what">${esc(b.serviceLabel)} · ${esc(dateLabel(b.preferredDate))} · ${esc(timeLabel(b.preferredTime))}</span>
        <span class="bk-card__src">Source: ${esc(b.source)}${b.assignedStaffName ? ` · ${esc(b.assignedStaffName)}` : ''}</span>
      </button></li>`;
  }

  function detailHtml(b) {
    const esc = Utils.esc;
    const fact = (label, value) => (value ? `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '');
    const group = (title, facts) => `<section class="bk-group"><h4>${esc(title)}</h4><dl class="bk-facts">${facts}</dl></section>`;
    return group('Customer Information',
        fact('Name', esc(b.customerName))
        + fact('Phone', `<a href="tel:${esc(String(b.phone).replace(/[^\d+]/g, ''))}">${esc(b.phone)}</a>`)
        + fact('Email', b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : '')
        + fact('Contact consent', b.consent ? 'Given' : 'Not recorded'))
      + group('Vehicle Information',
        fact('Make & model', esc(`${b.vehicleMake} ${b.vehicleModel}`))
        + fact('Registration', esc(b.registrationNumber)))
      + group('Booking',
        fact('Requested service', esc(b.serviceLabel))
        + fact('Preferred date', esc(dateLabel(b.preferredDate)))
        + fact('Preferred time', esc(timeLabel(b.preferredTime)))
        + fact('Booking source', esc(b.source) + (b.sourceReference ? ` <small>(${esc(b.sourceReference)})</small>` : ''))
        + fact('Status', statusHtml(b.status))
        + fact('Reference', esc(b.id))
        + fact('Received', esc(whenLabel(b.createdAt)))
        + fact('Assigned to', b.assignedStaffName ? esc(b.assignedStaffName) + (b.assignedBy ? ` <small>(by ${esc(b.assignedBy)}${b.assignedAt ? `, ${esc(whenLabel(b.assignedAt))}` : ''})</small>` : '') : '')
        + fact('Linked appointment', esc(b.appointmentId)))
      + (b.message ? `<section class="bk-group"><h4>Customer Message</h4><p class="bk-message">${esc(b.message)}</p></section>` : '');
  }

  function historyHtml(events) {
    const esc = Utils.esc;
    return (events || []).map((e) => `<li><strong>${esc(ACTION_LABEL[e.action] || e.action)}</strong>`
      + (e.action === 'status' ? ` · ${esc(e.fromStatus)} → ${esc(e.toStatus)}` : '')
      + (e.detail ? ` · ${esc(e.detail)}` : '')
      + (e.reason ? `<em>Reason: ${esc(e.reason)}</em>` : '')
      + `<span>${esc(e.actor)} · ${esc(whenLabel(e.at))}</span></li>`).join('');
  }

  function notesHtml(notes) {
    const esc = Utils.esc;
    return (notes || []).map((n) => `<li><p>${esc(n.note)}</p><span>${esc(n.by)} · ${esc(whenLabel(n.at))}</span></li>`).join('');
  }

  /* ---------- page state ---------- */

  const state = { q: '', status: '', source: '', assigned: '', rows: [], total: 0, summary: null, error: null, loading: false, selected: null };
  let seq = 0, searchTimer = null, pollTimer = null, staffList = [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const filtered = () => Boolean(state.q || state.status || state.source || state.assigned);

  function renderSummary() {
    const s = state.summary || {};
    const set = (id, n) => { $(id).textContent = Number.isFinite(n) ? String(n) : '–'; };
    set('bkTotal', s.total); set('bkNew', s.new); set('bkPending', s.pending); set('bkConfirmed', s.confirmed);
  }

  function renderTabs() {
    const s = state.summary || {};
    $('bkTabs').innerHTML = [['', 'All', s.total], ...STATUSES.map((st) => [st, st, s[st.toLowerCase()]])]
      .map(([value, label, n]) => `<button type="button" class="bk-tab${value === state.status ? ' is-active' : ''}" role="tab" data-status="${esc(value)}" aria-selected="${value === state.status}">${esc(label)}${Number.isFinite(n) ? ` <span class="bk-tab__n">${n}</span>` : ''}</button>`)
      .join('');
  }

  function renderList() {
    $('bkFilterLabel').textContent = state.status || 'All';
    $('bkClear').hidden = !(state.q || state.source || state.assigned);
    const box = $('bkListState');
    if (state.loading && !state.rows.length) {
      box.innerHTML = '<div class="bk-skel"><span></span><span></span><span></span></div>';
      $('bkList').hidden = true; $('bkFoot').hidden = true; return;
    }
    if (state.error) {
      const local = state.error.code === 'no_api' || state.error.code === 'locked';
      box.innerHTML = `<div class="bk-box bk-box--bad"><strong>${local ? 'The workshop database is not connected' : 'The bookings could not be loaded'}</strong>
          <p>${local ? 'Bookings are kept only in the workshop database. Nothing stored in this browser is shown in their place.' : 'The workshop database did not answer, so no bookings are shown.'}</p>
          ${local ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-retry>Retry</button>'}</div>`;
      $('bkList').innerHTML = ''; $('bkList').hidden = true; $('bkFoot').hidden = true; return;
    }
    if (!state.rows.length) {
      box.innerHTML = `<div class="bk-box"><strong>${filtered() ? 'No bookings match' : 'No bookings yet'}</strong>
          <p>${filtered() ? 'Try a different search, status, source or person.' : 'When a customer books on taqwa.autos, the request appears here.'}</p></div>`;
      $('bkList').innerHTML = ''; $('bkList').hidden = true; $('bkFoot').hidden = true; return;
    }
    box.innerHTML = '';
    $('bkList').innerHTML = state.rows.map((b) => cardHtml(b, state.selected && state.selected.id)).join('');
    $('bkList').hidden = false;
    $('bkFoot').hidden = false;
    $('bkCount').textContent = `${state.rows.length} of ${state.total} booking${state.total === 1 ? '' : 's'}`;
    $('bkMore').hidden = state.rows.length >= state.total;
  }

  async function load({ append = false, quiet = false } = {}) {
    if (!Storage.isApi()) {
      state.error = { code: Storage.isLocked() ? 'locked' : 'no_api' }; state.loading = false;
      $('bkLive').hidden = true; renderList(); return false;
    }
    const my = ++seq;
    state.loading = true; state.error = null;
    if (!append && !quiet) renderList();
    const qs = new URLSearchParams(buildQuery({ ...state, offset: append ? state.rows.length : 0 })).toString();
    const res = await Api.get(`/bookings?${qs}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) {
      if (quiet && state.rows.length) return false;   // a background refresh failed: keep what is shown
      state.error = res; state.rows = []; $('bkLive').hidden = true; renderList(); return false;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    state.rows = append ? [...state.rows, ...rows] : rows;
    state.total = res.meta.total || 0;
    state.summary = res.meta.summary || null;
    $('bkLive').hidden = false;
    renderSummary(); renderTabs(); renderList();
    return true;
  }

  /* ---------- details ---------- */

  function renderStatusForm(b) {
    const allowed = b.allowedStatuses || [];
    $('bkStatusForm').hidden = allowed.length === 0;
    $('bkClosed').hidden = allowed.length !== 0;
    $('bkdTo').innerHTML = '<option value="">Choose…</option>' + allowed.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    $('bkdReason').value = ''; $('bkdDate').value = ''; $('bkdTime').value = '';
    syncStatusFields();
  }

  /** Show the reason box for Rejected / Cancelled and the date + time for Rescheduled. */
  function syncStatusFields() {
    const to = $('bkdTo').value;
    $('bkReasonField').hidden = !NEEDS_REASON.includes(to);
    $('bkWhenFields').hidden = to !== 'Rescheduled';
  }

  function renderLinks(b) {
    const m = b.matches || { customers: [], vehicles: [] };
    const opt = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
    const customers = [...m.customers];
    if (b.customerId && !customers.some((c) => c.id === b.customerId)) customers.unshift({ id: b.customerId, name: b.customerId, phone: '' });
    $('bkdCustomer').innerHTML = opt('', 'Not linked') + customers.map((c) => opt(c.id, `${c.name} (${c.id})${c.phone ? ` · ${c.phone}` : ''}`)).join('');
    $('bkdCustomer').value = b.customerId || '';
    const vehicles = m.vehicles.filter((v) => !b.customerId || v.customerId === b.customerId);
    if (b.vehicleId && !vehicles.some((v) => v.id === b.vehicleId)) vehicles.unshift({ id: b.vehicleId, regNo: b.vehicleId, brand: '', model: '' });
    $('bkdVehicle').innerHTML = opt('', 'Not linked') + vehicles.map((v) => opt(v.id, `${v.regNo} (${v.id})${v.brand ? ` · ${v.brand} ${v.model}` : ''}`)).join('');
    $('bkdVehicle').value = b.vehicleId || '';
    $('bkMatchHint').textContent = !m.customers.length && !b.customerId
      ? 'No customer with this phone number was found. Add the customer under Customers, then link them here.'
      : '';
  }

  /** The Assign options: everyone active, plus whoever is assigned now even if no longer active. */
  function renderStaffOptions(b) {
    const opts = [...staffList];
    if (b.assignedStaffId && !opts.some((p) => p.id === b.assignedStaffId)) opts.unshift({ id: b.assignedStaffId, name: b.assignedStaffName || b.assignedStaffId });
    $('bkdAssigned').innerHTML = '<option value="">Not assigned</option>'
      + opts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('');
    $('bkdAssigned').value = b.assignedStaffId || '';
  }

  function renderDetail() {
    const b = state.selected;
    $('bkDetailEmpty').hidden = Boolean(b);
    $('bkDetail').hidden = !b;
    $('bkLayout').classList.toggle('is-detail-open', Boolean(b));
    if (!b) return;
    $('bkdName').textContent = b.customerName;
    $('bkdRef').textContent = `${b.id} · ${b.serviceLabel}`;
    $('bkdStatus').className = `bk-status bk-status--${TONE[b.status] || 'new'}`;
    $('bkdStatus').textContent = b.status;
    $('bkdBody').innerHTML = detailHtml(b);
    renderStatusForm(b);
    renderStaffOptions(b);
    renderLinks(b);
    $('bkdNote').value = '';
    $('bkdNotes').innerHTML = notesHtml(b.notes);
    $('bkNotesEmpty').hidden = (b.notes || []).length > 0;
    $('bkdHistory').innerHTML = historyHtml(b.history);
    document.querySelectorAll('[data-err]').forEach((el) => { el.textContent = ''; });
  }

  /** Does the open booking hold changes not saved yet? */
  function dirty() {
    const b = state.selected;
    if (!b) return false;
    return Boolean($('bkdTo').value || $('bkdReason').value.trim() || $('bkdNote').value.trim())
      || ($('bkdAssigned').value || '') !== (b.assignedStaffId || '')
      || ($('bkdCustomer').value || '') !== (b.customerId || '')
      || ($('bkdVehicle').value || '') !== (b.vehicleId || '');
  }

  async function open(id, { quiet = false } = {}) {
    const res = await Api.get(`/bookings/${encodeURIComponent(id)}`);
    if (!res.ok) { if (!quiet) Utils.toast(res.message || 'That booking could not be opened.', 'error'); return; }
    if (quiet && (!state.selected || state.selected.id !== id || dirty())) return;
    state.selected = res.data;
    renderDetail();
    renderList();
  }

  /** Apply a saved booking to the page. */
  function applySaved(data, message) {
    state.selected = data;
    const i = state.rows.findIndex((x) => x.id === data.id);
    if (i !== -1) state.rows[i] = data;
    renderDetail();
    Utils.toast(message, 'success');
    load({ quiet: true });
  }

  /** A refused save: say why, and if someone else changed it, show their version first. */
  async function refused(res, errKey, fallback) {
    const msg = res.fields ? Object.values(res.fields)[0] : (res.message || fallback);
    if (res.errorReason === 'concurrent_modification' && state.selected) { await open(state.selected.id); await load({ quiet: true }); }
    const el = document.querySelector(`[data-err="${errKey}"]`);
    if (el) el.textContent = msg;
    Utils.toast(msg, 'error');
  }

  async function saveStatus(btn) {
    const b = state.selected;
    if (!b) return;
    const to = $('bkdTo').value;
    if (!to) { document.querySelector('[data-err="status"]').textContent = 'Choose the new status.'; return; }
    await Utils.guard(btn, async () => {
      const body = { to, expectedUpdatedAt: b.updatedAt };
      if ($('bkdReason').value.trim()) body.reason = $('bkdReason').value.trim();
      if (to === 'Rescheduled') { body.date = $('bkdDate').value; body.time = $('bkdTime').value; }
      const res = await Api.post(`/bookings/${encodeURIComponent(b.id)}/status`, body);
      if (!res.ok) { await refused(res, 'status', 'The status could not be changed.'); return; }
      applySaved(res.data, `${res.data.id} is now ${res.data.status}.`);
    });
  }

  async function saveAssign(btn) {
    const b = state.selected;
    if (!b) return;
    const value = $('bkdAssigned').value || null;
    if ((value || '') === (b.assignedStaffId || '')) { Utils.toast('Nothing to save.', 'info'); return; }
    await Utils.guard(btn, async () => {
      const res = await Api.put(`/bookings/${encodeURIComponent(b.id)}`, { assignedStaffId: value, expectedUpdatedAt: b.updatedAt });
      if (!res.ok) { await refused(res, 'assign', 'The booking could not be assigned.'); return; }
      applySaved(res.data, value ? `${res.data.id} assigned to ${res.data.assignedStaffName}.` : `${res.data.id} unassigned.`);
    });
  }

  async function saveLinks(btn) {
    const b = state.selected;
    if (!b) return;
    const body = { expectedUpdatedAt: b.updatedAt };
    const c = $('bkdCustomer').value || null, v = $('bkdVehicle').value || null;
    if ((c || '') !== (b.customerId || '')) body.customerId = c;
    if ((v || '') !== (b.vehicleId || '')) body.vehicleId = v;
    if (!('customerId' in body) && !('vehicleId' in body)) { Utils.toast('Nothing to save.', 'info'); return; }
    await Utils.guard(btn, async () => {
      const res = await Api.put(`/bookings/${encodeURIComponent(b.id)}`, body);
      if (!res.ok) { await refused(res, 'links', 'The links could not be saved.'); return; }
      applySaved(res.data, `${res.data.id} links saved.`);
    });
  }

  async function addNote(btn) {
    const b = state.selected;
    if (!b) return;
    const note = $('bkdNote').value.trim();
    if (!note) { document.querySelector('[data-err="note"]').textContent = 'Write the note first.'; return; }
    await Utils.guard(btn, async () => {
      const res = await Api.post(`/bookings/${encodeURIComponent(b.id)}/notes`, { note });
      if (!res.ok) { await refused(res, 'note', 'The note could not be added.'); return; }
      applySaved(res.data, 'Note added.');
    });
  }

  /* ---------- staff for assignment ---------- */

  async function loadStaff() {
    const res = await Storage.load('staff');
    if (!res || !res.ok) return false;
    staffList = (Storage.getData('staff') || [])
      .filter((p) => p && p.status === 'Active')
      .map((p) => ({ id: p.id, name: p.name || p.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sel = $('bkAssignedFilter');
    sel.innerHTML = '<option value="">Anyone</option><option value="none">Not assigned</option>'
      + staffList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    sel.value = state.assigned;
    if (state.selected && !dirty()) renderStaffOptions(state.selected);
    return true;
  }

  /* ---------- auto-refresh ---------- */

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (state.loading || !Storage.isApi()) return;
      load({ quiet: true });
      if (state.selected) open(state.selected.id, { quiet: true });
    }, POLL_MS);
  }

  /* ---------- events ---------- */

  function bind() {
    $('bkTabs').addEventListener('click', (ev) => {
      const tab = ev.target.closest('[data-status]');
      if (!tab) return;
      state.status = tab.dataset.status;
      renderTabs();
      load();
    });
    $('bkSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('bkSearch').value; load(); }, 300);
    });
    for (const [id, key] of [['bkSource', 'source'], ['bkAssignedFilter', 'assigned']]) {
      $(id).addEventListener('change', () => { state[key] = $(id).value; load(); });
    }
    $('bkClear').addEventListener('click', () => {
      state.q = state.source = state.assigned = '';
      $('bkSearch').value = ''; $('bkSource').value = ''; $('bkAssignedFilter').value = '';
      load();
    });
    $('bkRefresh').addEventListener('click', async () => { await load(); if (state.selected && !dirty()) await open(state.selected.id); });
    $('bkMore').addEventListener('click', () => load({ append: true }));
    $('bkList').addEventListener('click', (ev) => { const card = ev.target.closest('[data-id]'); if (card) open(card.dataset.id); });
    $('bkListState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry]')) load(); });
    $('bkBack').addEventListener('click', () => { state.selected = null; renderDetail(); renderList(); });
    $('bkdTo').addEventListener('change', syncStatusFields);
    $('bkStatusForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveStatus($('bkdStatusSave')); });
    $('bkAssignForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveAssign($('bkdAssignSave')); });
    $('bkLinkForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveLinks($('bkdLinkSave')); });
    $('bkNoteForm').addEventListener('submit', (ev) => { ev.preventDefault(); addNote($('bkdNoteSave')); });
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-bookings') return;
    $('bkSource').innerHTML = '<option value="">All sources</option>' + SOURCES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    bind();
    state.loading = true;
    renderTabs();
    renderList();
    Storage.ready(() => {
      load();
      if (Storage.isApi()) { loadStaff(); startPolling(); }
    });
  }

  return { STATUSES, SOURCES, POLL_MS, buildQuery, dateLabel, timeLabel, cardHtml, detailHtml, historyHtml, notesHtml, init, _state: state, load, open };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxBookings };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxBookings.init();
