/* ============================================================
   inbox-website-forms.js — Social Inbox › Website Forms
   ------------------------------------------------------------
   Loaded only by pages/inbox-website-forms.html. Every enquiry comes
   from the workshop database through the Worker:

     GET /api/website-forms         the list (search, status, form type,
                                    date range, paging, status counts)
     GET /api/website-forms/:id     one enquiry, with its history
     PUT /api/website-forms/:id     status and internal notes
                                    (expectedUpdatedAt: an edit made from
                                    an old copy is refused, not lost)

   Enquiries arrive from the public website through the Worker's public
   endpoint (POST /api/forms/submit), never through this page.

   When the database cannot be read the page says so and offers Retry. It
   never shows sample or browser-stored enquiries in their place.
   Everything from the data is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const InboxWebsiteForms = (() => {

  const PAGE_SIZE = 50;
  const STATUSES = ['New', 'Contacted', 'Confirmed', 'Rejected'];
  const TYPE_LABEL = { booking: 'Booking', quote: 'Quote', contact: 'Contact' };
  const ACTION_LABEL = { submitted: 'Submitted from the website', status: 'Status changed', notes: 'Notes updated' };

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** Query string parameters for the list. Empty filters are left out. */
  function buildQuery({ q = '', status = '', type = '', from = '', to = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
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
        <span class="wf-row__meta">${esc(r.id)} · ${esc(whenLabel(r.createdAt))}</span>
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
      + item('Reference', esc(r.id))
      + item('Website page', esc(r.sourcePage));
  }

  function historyHtml(events) {
    const esc = Utils.esc;
    return (events || []).map((e) => `<li><strong>${esc(ACTION_LABEL[e.action] || e.action)}</strong>${e.action === 'status' ? ` · ${esc(e.fromStatus)} → ${esc(e.toStatus)}` : ''}
        <span>${esc(e.actor)} · ${esc(whenLabel(e.at))}</span></li>`).join('');
  }

  /* ---------- page state ---------- */

  const state = { q: '', status: '', type: '', from: '', to: '', rows: [], total: 0, summary: null, error: null, loading: false, selected: null };
  let seq = 0, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);

  const filtered = () => Boolean(state.q || state.status || state.type || state.from || state.to);

  function renderCounts() {
    const s = state.summary || {};
    document.querySelectorAll('[data-count]').forEach((el) => {
      const n = s[el.dataset.count];
      el.textContent = Number.isFinite(n) ? String(n) : '';
    });
  }

  function renderList() {
    $('wfClear').hidden = !(state.q || state.type || state.from || state.to);
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

  async function load({ append = false } = {}) {
    if (!Storage.isApi()) { state.error = { code: Storage.isLocked() ? 'locked' : 'no_api' }; state.loading = false; renderList(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    if (!append) renderList();
    const qs = new URLSearchParams(buildQuery({ ...state, offset: append ? state.rows.length : 0 })).toString();
    const res = await Api.get(`/website-forms?${qs}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) { state.error = res; state.rows = []; renderList(); return false; }
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
    $('wfManage').querySelector('[data-err="manage"]').textContent = '';
    $('wfdHistory').innerHTML = historyHtml(r.history);
  }

  async function open(id) {
    const res = await Api.get(`/website-forms/${encodeURIComponent(id)}`);
    if (!res.ok) { Utils.toast(res.message || 'That enquiry could not be opened.', 'error'); return; }
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
      if (!('status' in body) && !('notes' in body)) { Utils.toast('Nothing to save.', 'info'); return; }
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
    for (const [id, key] of [['wfType', 'type'], ['wfFrom', 'from'], ['wfTo', 'to']]) {
      $(id).addEventListener('change', () => { state[key] = $(id).value; load(); });
    }
    $('wfClear').addEventListener('click', () => {
      state.q = state.type = state.from = state.to = '';
      $('wfSearch').value = ''; $('wfType').value = ''; $('wfFrom').value = ''; $('wfTo').value = '';
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
    Storage.ready(() => load());
  }

  return { STATUSES, buildQuery, rowHtml, factsHtml, historyHtml, init, _state: state, load, open };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxWebsiteForms };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxWebsiteForms.init();
