/* ============================================================
   asset-assignment.js — Workshop Assets › Asset Assignment   (0025)
   ------------------------------------------------------------
   Loaded only by pages/asset-assignment.html. Every record comes from
   the workshop database through the Worker:

     GET  /api/tool-assignments              the list and its summary
     GET  /api/tool-assignments/:id          one assignment, its history, the equipment now
     POST /api/tool-assignments              assign an Available item
     PUT  /api/tool-assignments/:id          edit / hand over an Active one (expectedUpdatedAt)
     POST /api/tool-assignments/:id/return   record the return
     POST /api/tool-assignments/:id/cancel   an assignment made by mistake

   There is no delete: assignment history is kept. The equipment to choose
   from is the Tools & Equipment / Equipment Inventory register (GET
   /api/tools); only Available items can be assigned. The people are the
   active staff and mechanics. Assigning, handing over, returning and
   cancelling also update the equipment (who has it, its status and
   condition); the Worker does both in the same transaction.

   Permissions: buttons follow Storage.can() -- tools.view to see,
   tools.edit to assign, edit, return and cancel. The server checks every
   request again. Without the database the page says so; it never shows
   sample or browser-stored records. Everything from the data is escaped
   (Utils.esc) before it reaches HTML.
   ============================================================ */

const AssetAssignment = (() => {

  const CONDITIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Damaged'];
  const USABLE = ['Excellent', 'Good', 'Fair'];
  const FILTER_STATUSES = ['Active', 'Overdue', 'Returned', 'Cancelled'];
  const STATE_TONE = { Active: 'info', Overdue: 'bad', Returned: 'good', Cancelled: 'none' };
  const LIMITS = { purpose: 200, workLocation: 80, notes: 1000, damageNotes: 500, returnNotes: 1000, reason: 300 };
  const PAGE_SIZE = 25;

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  const DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });
  const todayInDhaka = (at = new Date()) => DHAKA.format(at);
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  function isRealDate(s) {
    if (!DATE_ONLY.test(s || '')) return false;
    const [y, m, d] = s.split('-').map(Number);
    const p = new Date(Date.UTC(y, m - 1, d));
    return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
  }

  /** What the equipment can become when it comes back, by its condition (as the Worker allows). */
  function statusesAfterReturn(condition) {
    return USABLE.includes(condition) ? ['Available', 'Under Maintenance', 'Damaged'] : ['Under Maintenance', 'Damaged'];
  }
  function defaultStatusAfterReturn(condition) {
    if (USABLE.includes(condition)) return 'Available';
    return condition === 'Damaged' ? 'Damaged' : 'Under Maintenance';
  }

  /** The list's query. Empty filters are left out. */
  function buildQuery({ q = '', status = '', assigneeId = '', toolId = '', from = '', to = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (status) out.status = status;
    if (assigneeId) out.assigneeId = assigneeId;
    if (toolId) out.toolId = toolId;
    if (from) out.from = from;
    if (to) out.to = to;
    return out;
  }

  /** Client-side checks of the assign / edit form (the Worker checks again). */
  function validate(v, { editing = false, today = todayInDhaka(), assignedDate = null } = {}) {
    const e = {};
    if (!editing && !v.toolId) e.toolId = 'Choose the equipment.';
    if (!v.assigneeId) e.assigneeId = 'Choose a member of staff or a mechanic.';
    const start = editing ? assignedDate : v.assignedDate;
    if (!editing) {
      if (!isRealDate(v.assignedDate)) e.assignedDate = 'Choose the assignment date.';
      else if (v.assignedDate > today) e.assignedDate = 'The assignment date cannot be in the future.';
    }
    if (v.expectedReturnDate) {
      if (!isRealDate(v.expectedReturnDate)) e.expectedReturnDate = 'Choose a valid return date.';
      else if (start && isRealDate(start) && v.expectedReturnDate < start) e.expectedReturnDate = 'The expected return cannot be before the assignment date.';
    }
    if (!editing && v.conditionBefore && !USABLE.includes(v.conditionBefore)) e.conditionBefore = 'Equipment handed out must be in Excellent, Good or Fair condition.';
    for (const k of ['purpose', 'workLocation', 'notes']) if ((v[k] || '').length > LIMITS[k]) e[k] = `Keep this to ${LIMITS[k]} characters or fewer.`;
    return e;
  }

  /** The request body: everything on create; only what changed on edit (null if nothing). */
  function payload(v, original = null) {
    if (!original) {
      const body = { toolId: v.toolId, assigneeId: v.assigneeId, assignedDate: v.assignedDate };
      if (v.expectedReturnDate) body.expectedReturnDate = v.expectedReturnDate;
      if (v.conditionBefore) body.conditionBefore = v.conditionBefore;
      for (const k of ['purpose', 'workLocation', 'notes']) if ((v[k] || '').trim()) body[k] = v[k].trim();
      return body;
    }
    const now = { assigneeId: v.assigneeId, expectedReturnDate: v.expectedReturnDate || '', purpose: (v.purpose || '').trim(), workLocation: (v.workLocation || '').trim(), notes: (v.notes || '').trim() };
    const was = { assigneeId: original.assigneeId, expectedReturnDate: original.expectedReturnDate || '', purpose: original.purpose || '', workLocation: original.workLocation || '', notes: original.notes || '' };
    const out = {};
    for (const k of Object.keys(now)) if (now[k] !== was[k]) out[k] = now[k];
    if (!Object.keys(out).length) return null;
    out.expectedUpdatedAt = original.updatedAt;
    return out;
  }

  /** Client-side checks of the return form. */
  function validateReturn(v, { today = todayInDhaka(), assignedDate = '' } = {}) {
    const e = {};
    if (!isRealDate(v.returnDate)) e.returnDate = 'Enter the day it came back.';
    else if (v.returnDate > today) e.returnDate = 'The return date cannot be in the future.';
    else if (assignedDate && v.returnDate < assignedDate) e.returnDate = 'The return date cannot be before the assignment date.';
    if (!CONDITIONS.includes(v.conditionAfter)) e.conditionAfter = 'Choose its condition now.';
    else if (v.statusAfter && !statusesAfterReturn(v.conditionAfter).includes(v.statusAfter)) e.statusAfter = `In ${v.conditionAfter} condition it can be: ${statusesAfterReturn(v.conditionAfter).join(', ')}.`;
    if ((v.damageNotes || '').length > LIMITS.damageNotes) e.damageNotes = `Keep this to ${LIMITS.damageNotes} characters or fewer.`;
    if ((v.returnNotes || '').length > LIMITS.returnNotes) e.returnNotes = `Keep this to ${LIMITS.returnNotes} characters or fewer.`;
    return e;
  }

  /** Which actions a record offers, given the caller's permissions. */
  function actionsFor(r, can = () => true) {
    const open = r.status === 'Active';
    const edit = can('tools.edit');
    return { edit: edit && open, return: edit && open, cancel: edit && open };
  }

  const tone = (map, key) => map[key] || 'none';
  const stateBadge = (r) => `<span class="aa-badge aa-badge--${tone(STATE_TONE, r.state || r.status)}">${Utils.esc(r.state || r.status)}</span>`;
  const fmtDate = (d) => (d ? Utils.fmtDate(d) : '');

  /* ---------- page state ---------- */

  const state = { q: '', status: '', assigneeId: '', toolId: '', from: '', to: '', offset: 0, rows: [], meta: null, error: null, loading: false };
  let seq = 0, searchTimer = null, tools = null, people = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const can = (perm) => (typeof Storage !== 'undefined' && Storage.can ? Storage.can(perm) : true);
  const filtered = () => Boolean(state.q || state.status || state.assigneeId || state.toolId || state.from || state.to);
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };

  function renderSummary(meta) {
    const s = (meta && meta.summary) || {};
    const n = (v) => (Number.isFinite(v) ? String(v) : '—');
    setText('aaTotal', n(s.total));
    setText('aaActive', n(s.assignedNow));
    setText('aaOverdue', n(s.overdue));
    setText('aaReturned', n(s.returned));
    setText('aaAvailable', n(s.available));
    setText('aaTotalSub', Number.isFinite(s.active) ? `${s.active} active · ${s.cancelled} cancelled` : 'All time');
    setText('aaAvailableSub', Number.isFinite(s.inService) ? `of ${s.inService} in service` : 'Ready to be assigned');
  }

  function person(r) {
    return `<div class="aa-person"><span>${esc(r.assigneeName)}</span><span class="aa-sub">${esc(r.assigneeType === 'mechanic' ? 'Mechanic' : 'Staff')} · ${esc(r.assigneeId)}</span></div>`;
  }
  function dates(r) {
    const due = r.status === 'Returned' ? `returned ${esc(fmtDate(r.returnDate))}`
      : r.status === 'Cancelled' ? 'cancelled'
      : r.expectedReturnDate ? `<span class="${r.state === 'Overdue' ? 'aa-overdue-text' : ''}">due ${esc(fmtDate(r.expectedReturnDate))}</span>` : 'no return date';
    return `${esc(fmtDate(r.assignedDate))}<span class="aa-sub">${due}</span>`;
  }
  function purpose(r) {
    const parts = [r.purpose, r.workLocation].filter(Boolean);
    return parts.length ? esc(parts.join(' · ')) : '<span class="aa-none">—</span>';
  }

  function actionButtons(r) {
    const a = actionsFor(r, can);
    const ICON = {
      view: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
      edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
      return: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
      cancel: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
    };
    const b = (act, label, extra = '') => `<button type="button" class="aa-act${extra}" data-act="${act}" data-id="${esc(r.id)}" aria-label="${esc(label)} ${esc(r.id)}" title="${esc(label)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${ICON[act]}"/></svg></button>`;
    return `<div class="aa-actions">${b('view', 'View details')}${a.edit ? b('edit', 'Edit') : ''}${a.return ? b('return', 'Return', ' aa-act--good') : ''}${a.cancel ? b('cancel', 'Cancel', ' aa-act--warn') : ''}</div>`;
  }

  function renderRows(rows) {
    $('aaBody').innerHTML = rows.map((r) => `
      <tr${r.status === 'Cancelled' ? ' class="aa-row--muted"' : ''}>
        <td class="aa-c-code">${esc(r.id)}</td>
        <td><div class="aa-item"><button type="button" class="aa-item__name" data-act="view" data-id="${esc(r.id)}">${esc(r.toolName)}</button><span class="aa-sub">${esc(r.toolId)}</span></div></td>
        <td>${person(r)}</td>
        <td class="aa-nowrap">${dates(r)}</td>
        <td>${purpose(r)}</td>
        <td>${stateBadge(r)}</td>
        <td class="aa-c-actions">${actionButtons(r)}</td>
      </tr>`).join('');
    $('aaCards').innerHTML = rows.map((r) => `
      <li class="aa-card${r.status === 'Cancelled' ? ' aa-row--muted' : ''}">
        <div class="aa-card__head">
          <div class="aa-item"><button type="button" class="aa-item__name" data-act="view" data-id="${esc(r.id)}">${esc(r.toolName)}</button><span class="aa-sub">${esc(r.id)} · ${esc(r.toolId)}</span></div>
          ${stateBadge(r)}
        </div>
        <dl class="aa-card__facts">
          <div><dt>Assigned to</dt><dd>${person(r)}</dd></div>
          <div><dt>Assigned / Due</dt><dd>${dates(r)}</dd></div>
          <div><dt>Purpose / Location</dt><dd>${purpose(r)}</dd></div>
          <div><dt>Condition out</dt><dd>${esc(r.conditionBefore) || '<span class="aa-none">—</span>'}</dd></div>
        </dl>
        ${actionButtons(r)}
      </li>`).join('');
  }

  function showList(show) { $('aaTableWrap').hidden = !show; $('aaCards').hidden = !show; $('aaFoot').hidden = !show; }

  function renderState(kind, opts = {}) {
    const host = $('aaState');
    if (kind === 'none') { host.innerHTML = ''; return; }
    if (kind === 'loading') {
      host.innerHTML = `<div class="aa-skeleton" aria-label="Loading assignments">${'<span class="aa-skeleton__row"></span>'.repeat(5)}</div>`;
      return;
    }
    host.innerHTML = `<div class="empty aa-state__box${kind === 'empty' ? '' : ' aa-state__box--bad'}">
        <h3>${esc(opts.title)}</h3><p>${esc(opts.text)}</p>
        ${opts.action ? `<button type="button" class="btn btn--ghost btn--sm" data-state-action="${esc(opts.action)}">${esc(opts.actionLabel)}</button>` : ''}
      </div>`;
  }

  function render() {
    $('aaClear').hidden = !filtered();
    $('aaAdd').hidden = !can('tools.edit');
    if (state.loading && !state.rows.length && !state.meta) { showList(false); renderState('loading'); return; }
    if (state.error) { showList(false); renderSummary(null); renderState('error', state.error); return; }
    renderSummary(state.meta);
    if (!state.rows.length) {
      showList(false);
      renderState('empty', filtered()
        ? { title: 'No assignments match', text: 'Try a different search or clear the filters.', action: 'clear', actionLabel: 'Clear filters' }
        : { title: 'No equipment assigned yet', text: 'Assign a piece of equipment from the register to a member of staff or a mechanic.', ...(can('tools.edit') ? { action: 'add', actionLabel: 'Assign Equipment' } : {}) });
      return;
    }
    renderState('none');
    renderRows(state.rows);
    const total = state.meta.total || 0;
    const to = state.offset + state.rows.length;
    setText('aaCount', `Showing ${state.offset + 1}–${to} of ${total} assignment${total === 1 ? '' : 's'}`);
    setText('aaPageLabel', `Page ${Math.floor(state.offset / PAGE_SIZE) + 1} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`);
    $('aaPrev').disabled = state.offset <= 0;
    $('aaNext').disabled = to >= total;
    showList(true);
  }

  function errorFor(res) {
    if (res.code === 'no_api') return { title: 'The workshop database is not connected', text: 'Assignments are kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in their place.' };
    if (res.code === 'offline') return { title: 'You are offline', text: 'Assignments are in the workshop database, which needs the internet. Nothing is shown from memory.', action: 'retry', actionLabel: 'Try again' };
    if (res.code === 'unauthorized' || res.code === 'locked') return { title: 'Your session has ended', text: 'Sign in again to see the assignments. Nothing was changed.', action: 'reload', actionLabel: 'Sign in again' };
    if (res.code === 'forbidden' || res.status === 403) return { title: 'Your role cannot see assignments', text: 'Ask an administrator for the Workshop Assets “view” permission.' };
    return { title: 'The assignments could not be loaded', text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.', action: 'retry', actionLabel: 'Retry' };
  }

  async function load() {
    if (Storage.isOffline && Storage.isOffline()) { state.loading = false; state.error = errorFor({ code: 'offline' }); render(); return false; }
    if (!Storage.isApi()) { state.loading = false; state.error = errorFor({ code: Storage.isLocked() ? 'locked' : 'no_api' }); render(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    render();
    const res = await Api.get(`/tool-assignments?${new URLSearchParams(buildQuery({ ...state, limit: PAGE_SIZE })).toString()}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) { state.rows = []; state.meta = null; state.error = errorFor(res); render(); return false; }
    if (!res.data.length && state.offset > 0 && res.meta.total > 0) { state.offset = Math.max(0, (Math.ceil(res.meta.total / PAGE_SIZE) - 1) * PAGE_SIZE); return load(); }
    state.rows = Array.isArray(res.data) ? res.data : [];
    state.meta = res.meta || {};
    $('aaAdd').disabled = false;
    render();
    return true;
  }

  /* ---------- choices: equipment and people ---------- */

  async function loadTools() {
    const res = await Api.get('/tools?limit=1000&sort=name&order=asc');
    if (!res.ok) return null;
    tools = (res.data || []).filter((t) => t.status !== 'Retired').map((t) => ({ id: t.id, name: t.name, status: t.status, condition: t.condition, category: t.category }));
    return tools;
  }

  async function loadPeople() {
    if (people) return people;
    const list = [];
    const res = can('staff.view') && Storage.loadPage ? await Storage.loadPage('staff', { status: 'Active', limit: 1000 }) : { ok: false };
    if (res.ok) {
      for (const p of res.rows) if (p.status === 'Active') list.push({ id: p.id, name: p.name, role: p.designation || (p.isMechanic ? 'Mechanic' : 'Staff') });
    } else {
      for (const m of Storage.getData('mechanics') || []) if (!m.status || m.status === 'Active') list.push({ id: m.id, name: m.name, role: m.specialization || 'Mechanic' });
    }
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    people = list;
    return people;
  }

  /** Fill the person and equipment filters (best effort: the page works without them). */
  async function fillFilters() {
    const [toolList, peopleList] = await Promise.all([loadTools(), loadPeople()]);
    if (peopleList) $('aaPerson').insertAdjacentHTML('beforeend', options(peopleList.map((p) => ({ id: p.id, label: `${p.name} (${p.id})` }))));
    if (toolList) $('aaTool').insertAdjacentHTML('beforeend', options(toolList.map((t) => ({ id: t.id, label: `${t.name} (${t.id})` }))));
  }

  /* ---------- forms ---------- */

  const options = (list, chosen, placeholder) => (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '')
    + list.map((x) => (typeof x === 'string'
      ? `<option value="${esc(x)}"${x === chosen ? ' selected' : ''}>${esc(x)}</option>`
      : `<option value="${esc(x.id)}"${x.id === chosen ? ' selected' : ''}>${esc(x.label)}</option>`)).join('');

  function field({ key, label, required = false, control, span = false, hint = '' }) {
    return `<div class="field${span ? ' span-2' : ''}">
        <label for="aaf-${key}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${control}
        ${hint ? `<span class="aa-hint" data-hint="${key}">${esc(hint)}</span>` : ''}
        <span class="field__error" data-err="${key}" id="aaf-${key}-err" role="alert"></span>
      </div>`;
  }
  const input = (key, value = '', attrs = '', type = 'text') => `<input class="input" type="${type}" id="aaf-${key}" name="${key}" value="${esc(value)}" ${attrs}>`;
  const textarea = (key, value = '', max = 1000) => `<textarea class="textarea" id="aaf-${key}" name="${key}" rows="3" maxlength="${max}">${esc(value)}</textarea>`;
  const select = (key, inner, attrs = '') => `<select class="select" id="aaf-${key}" name="${key}" ${attrs}>${inner}</select>`;

  function showErrors(form, errors) {
    form.querySelectorAll('[data-err]').forEach((el) => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    let first = null;
    for (const [k, msg] of Object.entries(errors || {})) {
      const slot = form.querySelector(`[data-err="${k}"]`);
      const el = form.elements[k];
      if (slot) slot.textContent = msg;
      if (el) { el.setAttribute('aria-invalid', 'true'); first = first || el; }
    }
    if (first && first.focus) first.focus();
    return Boolean(first);
  }

  /** Ask before throwing away typed changes (backdrop, Esc, Cancel). */
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

  /** A failed save: field messages, or a toast; reload on a conflict. */
  function refused(form, res, fallback) {
    if (res.fields && form && showErrors(form, res.fields)) { Utils.toast(res.message || 'Some fields need attention.', 'error'); return; }
    Utils.toast(res.message || fallback, 'error');
    if (res.status === 409 || res.status === 404) { Utils.Modal.close(); load(); }
  }

  const readForm = (form, keys) => {
    const out = {};
    for (const k of keys) out[k] = form.elements[k] ? form.elements[k].value : '';
    return out;
  };

  async function openForm(record = null, presetToolId = '') {
    const [toolList, peopleList] = await Promise.all([loadTools(), loadPeople()]);
    if (!toolList) { Utils.toast('The equipment list could not be loaded. Try again.', 'error'); return; }
    const today = todayInDhaka();
    const v = record || { assignedDate: today, toolId: presetToolId };
    const available = toolList.filter((t) => t.status === 'Available');
    const toolChoices = available.map((t) => ({ id: t.id, label: `${t.name} (${t.id}) · ${t.condition}` }));
    const personChoices = peopleList.map((p) => ({ id: p.id, label: `${p.name} (${p.role})` }));
    if (record && !personChoices.some((p) => p.id === record.assigneeId)) personChoices.unshift({ id: record.assigneeId, label: `${record.assigneeName} (${record.assigneeId})` });
    const unavailable = toolList.length - available.length;
    const ov = Utils.Modal.open({
      title: record ? `Edit ${record.id}` : 'Assign Equipment',
      size: 'lg',
      body: `<form id="aaForm" class="aa-form" novalidate>
        <p class="aa-form__note">Fields marked <span class="req">*</span> are required.${record ? '' : ' The record number is given when you save.'}</p>
        <div class="form-grid">
          ${record
            ? field({ key: 'toolId', label: 'Equipment', span: true, control: `<input class="input" id="aaf-toolId" value="${esc(`${record.toolName} (${record.toolId})`)}" disabled>`, hint: 'The equipment cannot change. To give out something else, return this and assign the other item.' })
            : field({ key: 'toolId', label: 'Equipment', required: true, span: true, control: select('toolId', options(toolChoices, v.toolId, 'Choose available equipment'), 'required'),
              hint: available.length ? (unavailable ? `${unavailable} item${unavailable === 1 ? ' is' : 's are'} not shown: already assigned, under maintenance or damaged.` : '') : 'No equipment is Available right now. Return an item, or add one under Equipment Inventory.' })}
          ${field({ key: 'assigneeId', label: record ? 'Assigned to (hand over)' : 'Assign to', required: true, control: select('assigneeId', options(personChoices, v.assigneeId || '', 'Choose staff or mechanic'), 'required'),
            hint: personChoices.length ? '' : 'No active staff or mechanics found.' })}
          ${record
            ? field({ key: 'assignedDate', label: 'Assignment date', control: `<input class="input" id="aaf-assignedDate" value="${esc(fmtDate(record.assignedDate))}" disabled>` })
            : field({ key: 'assignedDate', label: 'Assignment date', required: true, control: input('assignedDate', v.assignedDate, `required max="${today}"`, 'date') })}
          ${field({ key: 'expectedReturnDate', label: 'Expected return date', control: input('expectedReturnDate', v.expectedReturnDate || '', `min="${esc(record ? record.assignedDate : today)}"`, 'date') })}
          ${record ? '' : field({ key: 'conditionBefore', label: 'Condition when handed out', control: select('conditionBefore', options(USABLE, '', 'As in the register')) })}
          ${field({ key: 'purpose', label: 'Purpose', control: input('purpose', v.purpose || '', `maxlength="${LIMITS.purpose}" autocomplete="off" placeholder="e.g. Brake job on a customer car"`) })}
          ${field({ key: 'workLocation', label: 'Work location', control: input('workLocation', v.workLocation || '', `maxlength="${LIMITS.workLocation}" autocomplete="off" placeholder="e.g. Bay 2"`) })}
          ${field({ key: 'notes', label: 'Notes', span: true, control: textarea('notes', v.notes || '', LIMITS.notes) })}
        </div>
      </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="aaForm" class="btn btn--primary" data-aa-save>${record ? 'Save Changes' : 'Assign'}</button>`,
    });
    ov.classList.add('aa-modal');
    const form = ov.querySelector('#aaForm');
    const keys = record ? ['assigneeId', 'expectedReturnDate', 'purpose', 'workLocation', 'notes'] : ['toolId', 'assigneeId', 'assignedDate', 'expectedReturnDate', 'conditionBefore', 'purpose', 'workLocation', 'notes'];
    const start = JSON.stringify(readForm(form, keys));
    guardDirty(ov, () => JSON.stringify(readForm(form, keys)) !== start);
    const btn = ov.querySelector('[data-aa-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const values = readForm(form, keys);
        if (showErrors(form, validate(values, { editing: Boolean(record), today, assignedDate: record ? record.assignedDate : null }))) return;
        const body = payload(values, record);
        if (record && !body) { Utils.Modal.close(); Utils.toast('Nothing was changed.', 'info'); return; }
        const res = record ? await Api.put(`/tool-assignments/${encodeURIComponent(record.id)}`, body) : await Api.post('/tool-assignments', body);
        if (!res.ok) { refused(form, res, 'The assignment could not be saved.'); return; }
        Utils.Modal.close();
        Utils.toast(record ? `${res.data.id} was updated.` : `${res.data.toolName} assigned to ${res.data.assigneeName} as ${res.data.id}.`, 'success');
        if (!record) state.offset = 0;
        tools = null;
        load();
      });
    });
  }

  async function openReturn(r) {
    const peopleList = await loadPeople();
    const today = todayInDhaka();
    const start = r.assignedDate > today ? r.assignedDate : today;
    const condition = r.conditionBefore || 'Good';
    const statusOptions = (c) => options(statusesAfterReturn(c), defaultStatusAfterReturn(c));
    const ov = Utils.Modal.open({
      title: `Return — ${r.toolName}`,
      size: 'lg',
      body: `<form id="aaReturnForm" class="aa-form" novalidate>
        <p class="aa-form__note"><strong>${esc(r.toolName)}</strong> was given to <strong>${esc(r.assigneeName)}</strong> on ${esc(fmtDate(r.assignedDate))}${r.conditionBefore ? ` in ${esc(r.conditionBefore)} condition` : ''}.</p>
        ${r.state === 'Overdue' ? `<p class="aa-warn">This return is overdue: it was expected back on ${esc(fmtDate(r.expectedReturnDate))}.</p>` : ''}
        <div class="form-grid">
          ${field({ key: 'returnDate', label: 'Actual return date', required: true, control: input('returnDate', start, `required min="${esc(r.assignedDate)}" max="${today}"`, 'date') })}
          ${field({ key: 'receivedById', label: 'Received by', control: select('receivedById', options(peopleList.map((p) => ({ id: p.id, label: `${p.name} (${p.role})` })), '', 'Not recorded')) })}
          ${field({ key: 'conditionAfter', label: 'Condition now', required: true, control: select('conditionAfter', options(CONDITIONS, condition), 'required') })}
          ${field({ key: 'statusAfter', label: 'Equipment status after return', required: true, control: select('statusAfter', statusOptions(condition)), hint: 'Poor or Damaged equipment cannot go back as Available.' })}
          ${field({ key: 'damageNotes', label: 'Damage / missing parts', span: true, control: textarea('damageNotes', '', LIMITS.damageNotes) })}
          ${field({ key: 'returnNotes', label: 'Return notes', span: true, control: textarea('returnNotes', '', LIMITS.returnNotes) })}
        </div>
      </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        <button type="submit" form="aaReturnForm" class="btn btn--primary" data-aa-save>Record Return</button>`,
    });
    ov.classList.add('aa-modal');
    const form = ov.querySelector('#aaReturnForm');
    form.elements.conditionAfter.addEventListener('change', () => { form.elements.statusAfter.innerHTML = statusOptions(form.elements.conditionAfter.value); });
    const keys = ['returnDate', 'receivedById', 'conditionAfter', 'statusAfter', 'damageNotes', 'returnNotes'];
    const first = JSON.stringify(readForm(form, keys));
    guardDirty(ov, () => JSON.stringify(readForm(form, keys)) !== first);
    const btn = ov.querySelector('[data-aa-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const v = readForm(form, keys);
        if (showErrors(form, validateReturn(v, { today, assignedDate: r.assignedDate }))) return;
        const body = { returnDate: v.returnDate, conditionAfter: v.conditionAfter, statusAfter: v.statusAfter, expectedUpdatedAt: r.updatedAt };
        if (v.receivedById) body.receivedById = v.receivedById;
        if (v.damageNotes.trim()) body.damageNotes = v.damageNotes.trim();
        if (v.returnNotes.trim()) body.returnNotes = v.returnNotes.trim();
        const res = await Api.post(`/tool-assignments/${encodeURIComponent(r.id)}/return`, body);
        if (!res.ok) { refused(form, res, 'The return could not be recorded.'); return; }
        Utils.Modal.close();
        Utils.toast(`${res.data.toolName} returned; it is now ${res.data.tool ? res.data.tool.status : v.statusAfter}.`, 'success');
        tools = null;
        load();
      });
    });
  }

  function openCancel(r) {
    const ov = Utils.Modal.open({
      title: `Cancel ${r.id}`,
      body: `<form id="aaCancelForm" class="aa-form" novalidate>
        <p class="aa-form__note">Cancel the assignment of <strong>${esc(r.toolName)}</strong> to <strong>${esc(r.assigneeName)}</strong>? Use this for an assignment made by mistake; to record the item coming back, use Return. The equipment goes back to Available and the record is kept.</p>
        ${field({ key: 'reason', label: 'Reason', required: true, control: textarea('reason', '', LIMITS.reason) })}
      </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Keep it</button>
        <button type="submit" form="aaCancelForm" class="btn btn--danger" data-aa-save>Cancel Assignment</button>`,
    });
    ov.classList.add('aa-modal');
    const form = ov.querySelector('#aaCancelForm');
    const btn = ov.querySelector('[data-aa-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const reason = form.elements.reason.value.trim();
        if (!reason) { showErrors(form, { reason: 'Please give a reason for cancelling.' }); return; }
        const res = await Api.post(`/tool-assignments/${encodeURIComponent(r.id)}/cancel`, { reason, expectedUpdatedAt: r.updatedAt });
        if (!res.ok) { refused(form, res, 'The assignment could not be cancelled.'); return; }
        Utils.Modal.close();
        Utils.toast(`${res.data.id} was cancelled.`, 'success');
        tools = null;
        load();
      });
    });
  }

  async function openDetails(id) {
    const res = await Api.get(`/tool-assignments/${encodeURIComponent(id)}`);
    if (!res.ok) { Utils.toast(res.message || 'The assignment could not be loaded.', 'error'); return; }
    const r = res.data;
    const a = actionsFor(r, can);
    const fact = (label, value, span = false) => (value ? `<div class="detail-item${span ? ' span-2' : ''}"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>` : '');
    const t = r.tool;
    const ov = Utils.Modal.open({
      title: `${r.toolName} — ${r.assigneeName}`,
      size: 'lg',
      body: `<div class="aa-detail__head"><span class="aa-detail__id">${esc(r.id)}</span><span class="aa-detail__badges">${stateBadge(r)}</span></div>
        ${r.status === 'Cancelled' ? `<p class="aa-note">Cancelled: ${esc(r.cancelReason)}</p>` : ''}
        ${r.source === 'Equipment Inventory' ? '<p class="aa-note">This assignment was made in Equipment Inventory and recorded here automatically.</p>' : ''}
        <div class="detail-grid">
          ${fact('Equipment', `${esc(r.toolName)} <span class="aa-sub">${esc(r.toolId)}${t ? ` · now ${esc(t.status)}, condition ${esc(t.condition)}${t.holder ? ` · with ${esc(t.holder)}` : ''}` : ' · no longer in the register'}</span>`, true)}
          ${fact('Assigned to', `${esc(r.assigneeName)} <span class="aa-sub">${esc(r.assigneeType === 'mechanic' ? 'Mechanic' : 'Staff')} · ${esc(r.assigneeId)}</span>`)}
          ${fact('Assignment date', esc(fmtDate(r.assignedDate)))}
          ${fact('Expected return', r.expectedReturnDate ? `<span class="${r.state === 'Overdue' ? 'aa-overdue-text' : ''}">${esc(fmtDate(r.expectedReturnDate))}</span>` : '')}
          ${fact('Purpose', esc(r.purpose))}
          ${fact('Work location', esc(r.workLocation))}
          ${fact('Condition when handed out', esc(r.conditionBefore))}
          ${fact('Returned on', esc(fmtDate(r.returnDate)))}
          ${fact('Condition on return', esc(r.conditionAfter))}
          ${fact('Received by', esc(r.receivedByName))}
        </div>
        ${r.notes ? `<h4 class="aa-detail__h">Notes</h4><p class="aa-detail__text">${esc(r.notes)}</p>` : ''}
        ${r.damageNotes ? `<h4 class="aa-detail__h">Damage / missing parts</h4><p class="aa-detail__text">${esc(r.damageNotes)}</p>` : ''}
        ${r.returnNotes ? `<h4 class="aa-detail__h">Return notes</h4><p class="aa-detail__text">${esc(r.returnNotes)}</p>` : ''}
        <h4 class="aa-detail__h">History</h4>
        <ol class="aa-history">${(r.history || []).map((e) => `<li><span class="aa-history__what">${esc(e.summary)}</span><span class="aa-sub">${esc(e.actor || 'Unknown')} · ${esc(new Date(e.at).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }))}</span></li>`).join('')}</ol>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        ${a.cancel ? '<button type="button" class="btn btn--danger-ghost" data-aa-do="cancel">Cancel</button>' : ''}
        ${a.edit ? '<button type="button" class="btn btn--ghost" data-aa-do="edit">Edit</button>' : ''}
        ${a.return ? '<button type="button" class="btn btn--primary" data-aa-do="return">Return</button>' : ''}`,
    });
    ov.classList.add('aa-modal');
    ov.querySelectorAll('[data-aa-do]').forEach((b) => b.addEventListener('click', () => run(b.dataset.aaDo, r)));
  }

  function run(act, r) {
    if (act === 'view') return openDetails(r.id);
    if (act === 'edit') return openForm(r);
    if (act === 'return') return openReturn(r);
    if (act === 'cancel') return openCancel(r);
    return null;
  }

  /* ---------- events ---------- */

  function resetFilters() {
    Object.assign(state, { q: '', status: '', assigneeId: '', toolId: '', from: '', to: '', offset: 0 });
    for (const id of ['aaSearch', 'aaStatus', 'aaPerson', 'aaTool', 'aaFrom', 'aaTo']) $(id).value = '';
    load();
  }

  function onAct(ev) {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'view') { openDetails(btn.dataset.id); return; }
    const r = state.rows.find((x) => x.id === btn.dataset.id);
    if (r) run(btn.dataset.act, r);
  }

  function bind() {
    $('aaStatus').insertAdjacentHTML('beforeend', options(FILTER_STATUSES));
    $('aaAdd').addEventListener('click', () => openForm());
    $('aaSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('aaSearch').value.trim(); state.offset = 0; load(); }, 300);
    });
    for (const [id, key] of [['aaStatus', 'status'], ['aaPerson', 'assigneeId'], ['aaTool', 'toolId'], ['aaFrom', 'from'], ['aaTo', 'to']]) {
      $(id).addEventListener('change', () => {
        const v = $(id).value;
        if ((key === 'from' || key === 'to') && v && !isRealDate(v)) return;
        state[key] = v; state.offset = 0; load();
      });
    }
    $('aaClear').addEventListener('click', resetFilters);
    $('aaPrev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); load(); });
    $('aaNext').addEventListener('click', () => { state.offset += PAGE_SIZE; load(); });
    for (const id of ['aaBody', 'aaCards']) $(id).addEventListener('click', onAct);
    $('aaState').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-state-action]');
      if (!b) return;
      const a = b.dataset.stateAction;
      if (a === 'retry') load();
      else if (a === 'clear') resetFilters();
      else if (a === 'add') openForm();
      else if (a === 'reload') location.reload();
    });
  }

  function init() {
    if (document.body.dataset.page !== 'asset-assignment') return;
    bind();
    state.loading = true;
    render();
    Storage.ready(() => { load().then((ok) => { if (ok) fillFilters(); }); });
  }

  return { CONDITIONS, FILTER_STATUSES, buildQuery, validate, validateReturn, payload, actionsFor, statusesAfterReturn, defaultStatusAfterReturn, isRealDate, init, _state: state, load };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AssetAssignment };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) AssetAssignment.init();
