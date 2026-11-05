/* ============================================================
   inbox-website-forms.js — Social Inbox › Website Forms
   ------------------------------------------------------------
   Loaded only by pages/inbox-website-forms.html. Every enquiry comes
   from the workshop database through the Worker:

     GET /api/website-forms         the list (search, status, form type,
                                    date range, paging, status counts)
     GET /api/website-forms/:id     one enquiry, with its history
     PUT /api/website-forms/:id     status, internal notes and the member
                                    of staff it is assigned to
                                    (expectedUpdatedAt: an edit made from
                                    an old copy is refused, not lost)

   Staff to assign are read from the roster (Storage.load('staff'), active
   only); the Worker checks the choice again. The list refreshes itself
   every POLL_MS while the page is visible, so a new enquiry from the
   website appears without pressing Refresh; an open enquiry is refreshed
   too unless its form has unsaved changes.

   Enquiries arrive from the public website through the Worker's public
   endpoint (POST /api/forms/submit), never through this page.

   When the database cannot be read the page says so and offers Retry. It
   never shows sample or browser-stored enquiries in their place.
   Everything from the data is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const InboxWebsiteForms = (() => {

  const PAGE_SIZE = 50;
  const POLL_MS = 30000;
  const STATUSES = ['New', 'Contacted', 'Confirmed', 'Rejected'];
  const TYPE_LABEL = { booking: 'Booking', quote: 'Quote', contact: 'Contact' };
  const ACTION_LABEL = { submitted: 'Submitted from the website', status: 'Status changed', notes: 'Notes updated' };

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** Query string parameters for the list. Empty filters are left out. */
  function buildQuery({ q = '', status = '', type = '', from = '', to = '', assigned = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (assigned) out.assigned = assigned;
    if (q.trim()) out.q = q.trim();
    if (status) out.status = status;
    if (type) out.type = type;
    if (from) out.from = from;
    if (to) out.to = to;
    return out;
  }

  function whenLabel(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  const statusTone = (s) => ({ New: 'new', Contacted: 'contacted', Confirmed: 'confirmed', Rejected: 'rejected' }[s] || 'new');

  function rowHtml(r, selectedId) {
    const esc = Utils.esc;
    const what = [TYPE_LABEL[r.formType] || r.formType, r.service, r.vehicle].filter(Boolean).join(' · ');
    return `<li><button type="button" class="wf-row${r.id === selectedId ? ' is-active' : ''}${r.status === 'New' ? ' is-new' : ''}" data-id="${esc(r.id)}"${r.id === selectedId ? ' aria-current="true"' : ''}>
        <span class="wf-row__top"><span class="wf-row__name">${esc(r.name)}</span><span class="wf-status wf-status--${statusTone(r.status)}">${esc(r.status)}</span></span>
        <span class="wf-row__what">${esc(what)}</span>
        ${r.message ? `<span class="wf-row__msg">${esc(r.message)}</span>` : ''}
        <span class="wf-row__meta">${esc(r.id)} · ${esc(whenLabel(r.createdAt))}${r.assignedToName ? ` · ${esc(r.assignedToName)}` : ''}</span>
      </button></li>`;
  }

  function factsHtml(r) {
    const esc = Utils.esc;
    const item = (label, value) => (value ? `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '');
    return item('Phone', `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a>`)
      + item('Email', r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : '')
      + item('Form', esc(TYPE_LABEL[r.formType] || r.formType))
      + item('Service', esc(r.service))
      + item('Vehicle', esc(r.vehicle))
      + item('Registration', esc(r.regNo))
      + item('Preferred date', r.preferredDate ? esc(Utils.fmtDate(r.preferredDate)) + (r.preferredTime ? ` at ${esc(r.preferredTime)}` : '') : '')
      + item('Received', esc(whenLabel(r.createdAt)))
      + item('Source', 'Website')
      + item('Website page', esc(r.sourcePage))
      + item('Reference', esc(r.id))
      + item('Assigned to', r.assignedToName
        ? esc(r.assignedToName) + (r.assignedBy ? ` <small>(by ${esc(r.assignedBy)}${r.assignedAt ? `, ${esc(whenLabel(r.assignedAt))}` : ''})</small>` : '')
        : '');
  }

  function historyHtml(events) {
    const esc = Utils.esc;
    return (events || []).map((e) => `<li><strong>${esc(ACTION_LABEL[e.action] || e.action)}</strong>${e.action === 'status' ? ` · ${esc(e.fromStatus)} → ${esc(e.toStatus)}` : ''}
        <span>${esc(e.actor)} · ${esc(whenLabel(e.at))}</span></li>`).join('');
  }

  /* ---------- page state ---------- */

  const state = { q: '', status: '', type: '', from: '', to: '', assigned: '', rows: [], total: 0, summary: null, error: null, loading: false, selected: null };
  let seq = 0, searchTimer = null, pollTimer = null, staffList = [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);

  const filtered = () => Boolean(state.q || state.status || state.type || state.from || state.to || state.assigned);

  function renderCounts() {
    const s = state.summary || {};
    document.querySelectorAll('[data-count]').forEach((el) => {
      const n = s[el.dataset.count];
      el.textContent = Number.isFinite(n) ? String(n) : '';
    });
  }

  function renderList() {
    $('wfClear').hidden = !(state.q || state.type || state.from || state.to || state.assigned);
    const box = $('wfListState');
    if (state.loading && !state.rows.length) {
      box.innerHTML = '<div class="wf-skel"><span></span><span></span><span></span></div>';
      $('wfList').hidden = true; $('wfFoot').hidden = true; return;
    }
    if (state.error) {
      const local = state.error.code === 'no_api' || state.error.code === 'locked';
      box.innerHTML = `<div class="wf-box wf-box--bad"><strong>${local ? 'The workshop database is not connected' : 'The enquiries could not be loaded'}</strong>
          <p>${local ? 'Website enquiries are kept only in the workshop database. Nothing stored in this browser is shown in their place.' : 'The workshop database did not answer, so no enquiries are shown.'}</p>
          ${local ? '' : '<button type="button" class="btn btn--ghost btn--sm" data-retry>Retry</button>'}</div>`;
      $('wfList').hidden = true; $('wfFoot').hidden = true; return;
    }
    if (!state.rows.length) {
      box.innerHTML = `<div class="wf-box"><strong>${filtered() ? 'No enquiries match' : 'No website enquiries yet'}</strong>
          <p>${filtered() ? 'Try a different search, status, form or date.' : 'When a customer sends a form on taqwa.autos, it appears here.'}</p></div>`;
      $('wfList').hidden = true; $('wfFoot').hidden = true; return;
    }
    box.innerHTML = '';
    $('wfList').innerHTML = state.rows.map((r) => rowHtml(r, state.selected && state.selected.id)).join('');
    $('wfList').hidden = false;
    $('wfFoot').hidden = false;
    $('wfCount').textContent = `${state.rows.length} of ${state.total} enquir${state.total === 1 ? 'y' : 'ies'}`;
    $('wfMore').hidden = state.rows.length >= state.total;
  }

  async function load({ append = false, quiet = false } = {}) {
    if (!Storage.isApi()) { state.error = { code: Storage.isLocked() ? 'locked' : 'no_api' }; state.loading = false; renderList(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    if (!append && !quiet) renderList();
    const qs = new URLSearchParams(buildQuery({ ...state, offset: append ? state.rows.length : 0 })).toString();
    const res = await Api.get(`/website-forms?${qs}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) {
      if (quiet && state.rows.length) return false;   // a background refresh failed: keep what is shown
      state.error = res; state.rows = []; renderList(); return false;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    state.rows = append ? [...state.rows, ...rows] : rows;
    state.total = res.meta.total || 0;
    state.summary = res.meta.summary || null;
    renderCounts();
    renderList();
    return true;
  }

  /* ---------- details ---------- */

  function renderDetail() {
    const r = state.selected;
    $('wfDetailEmpty').hidden = Boolean(r);
    $('wfDetail').hidden = !r;
    $('wfLayout').classList.toggle('is-detail-open', Boolean(r));
    if (!r) return;
    $('wfdName').textContent = r.name;
    $('wfdMeta').textContent = `${TYPE_LABEL[r.formType] || r.formType}${r.service ? ` · ${r.service}` : ''}`;
    $('wfdStatusBadge').textContent = r.status;
    $('wfdStatusBadge').className = `wf-status wf-status--${statusTone(r.status)}`;
    $('wfdFacts').innerHTML = factsHtml(r);
    $('wfdMessageWrap').hidden = !r.message;
    $('wfdMessage').textContent = r.message;
    $('wfdStatus').value = r.status;
    $('wfdNotes').value = r.notes;
    renderStaffOptions(r.assignedToId);
    $('wfdAssigned').value = r.assignedToId || '';
    $('wfManage').querySelector('[data-err="manage"]').textContent = '';
    $('wfdHistory').innerHTML = historyHtml(r.history);
  }

  async function open(id, { quiet = false } = {}) {
    const res = await Api.get(`/website-forms/${encodeURIComponent(id)}`);
    if (!res.ok) { if (!quiet) Utils.toast(res.message || 'That enquiry could not be opened.', 'error'); return; }
    if (quiet && (!state.selected || state.selected.id !== id || dirty())) return;
    state.selected = res.data;
    renderDetail();
    renderList();
  }

  async function save(btn) {
    const r = state.selected;
    if (!r) return;
    await Utils.guard(btn, async () => {
      const body = { expectedUpdatedAt: r.updatedAt };
      if ($('wfdStatus').value !== r.status) body.status = $('wfdStatus').value;
      if ($('wfdNotes').value.trim() !== (r.notes || '')) body.notes = $('wfdNotes').value.trim();
      if (($('wfdAssigned').value || '') !== (r.assignedToId || '')) body.assignedToId = $('wfdAssigned').value || null;
      if (!('status' in body) && !('notes' in body) && !('assignedToId' in body)) { Utils.toast('Nothing to save.', 'info'); return; }
      const res = await Api.put(`/website-forms/${encodeURIComponent(r.id)}`, body);
      if (!res.ok) {
        const msg = res.fields ? Object.values(res.fields)[0] : (res.message || 'The enquiry could not be saved.');
        // Someone else changed it: show their version first, then say why the save was refused.
        if (res.errorReason === 'concurrent_modification') { await open(r.id); await load(); }
        $('wfManage').querySelector('[data-err="manage"]').textContent = msg;
        Utils.toast(msg, 'error');
        return;
      }
      state.selected = res.data;
      const i = state.rows.findIndex((x) => x.id === r.id);
      if (i !== -1) state.rows[i] = res.data;
      renderDetail();
      Utils.toast(`${res.data.id} saved.`, 'success');
      await load();
    });
  }

  /* ---------- staff for assignment ---------- */

  /** Does the open enquiry's form hold changes not saved yet? */
  function dirty() {
    const r = state.selected;
    if (!r) return false;
    return $('wfdStatus').value !== r.status || $('wfdNotes').value.trim() !== (r.notes || '')
      || ($('wfdAssigned').value || '') !== (r.assignedToId || '');
  }

  /** Active staff and mechanics from the roster, by name. A failure leaves only "Not assigned". */
  async function loadStaff() {
    const res = await Storage.load('staff');
    if (!res || !res.ok) return false;
    staffList = (Storage.getData('staff') || [])
      .filter((p) => p && p.status === 'Active')
      .map((p) => ({ id: p.id, name: p.name || p.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    renderAssignedFilter();
    if (state.selected && !dirty()) renderDetail();
    return true;
  }

  /** The Assign options: everyone active, plus whoever is assigned now even if no longer active. */
  function renderStaffOptions(currentId) {
    const opts = [...staffList];
    if (currentId && !opts.some((p) => p.id === currentId)) {
      opts.unshift({ id: currentId, name: (state.selected && state.selected.assignedToName) || currentId });
    }
    $('wfdAssigned').innerHTML = '<option value="">Not assigned</option>'
      + opts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('');
  }

  function renderAssignedFilter() {
    const sel = $('wfAssigned');
    const keep = state.assigned;
    sel.innerHTML = '<option value="">Anyone</option><option value="none">Not assigned</option>'
      + staffList.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    sel.value = keep;
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
    document.querySelectorAll('.wf-chip').forEach((chip) => chip.addEventListener('click', () => {
      state.status = chip.dataset.status;
      document.querySelectorAll('.wf-chip').forEach((c) => {
        c.classList.toggle('is-active', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
      });
      load();
    }));
    $('wfSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('wfSearch').value; load(); }, 300);
    });
    for (const [id, key] of [['wfType', 'type'], ['wfFrom', 'from'], ['wfTo', 'to'], ['wfAssigned', 'assigned']]) {
      $(id).addEventListener('change', () => { state[key] = $(id).value; load(); });
    }
    $('wfClear').addEventListener('click', () => {
      state.q = state.type = state.from = state.to = state.assigned = '';
      $('wfSearch').value = ''; $('wfType').value = ''; $('wfFrom').value = ''; $('wfTo').value = ''; $('wfAssigned').value = '';
      load();
    });
    $('wfRefresh').addEventListener('click', async () => { await load(); if (state.selected) await open(state.selected.id); });
    $('wfMore').addEventListener('click', () => load({ append: true }));
    $('wfList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-id]'); if (b) open(b.dataset.id); });
    $('wfListState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry]')) load(); });
    $('wfBack').addEventListener('click', () => { state.selected = null; renderDetail(); renderList(); });
    $('wfManage').addEventListener('submit', (ev) => { ev.preventDefault(); save($('wfdSave')); });
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-website-forms') return;
    bind();
    state.loading = true;
    renderList();
    Storage.ready(() => {
      load();
      if (Storage.isApi()) { loadStaff(); startPolling(); }
    });
  }

  return { STATUSES, POLL_MS, buildQuery, rowHtml, factsHtml, historyHtml, init, _state: state, load, open };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxWebsiteForms };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxWebsiteForms.init();
