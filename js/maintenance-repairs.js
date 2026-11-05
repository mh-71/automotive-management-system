/* ============================================================
   maintenance-repairs.js — Workshop Assets › Maintenance & Repairs   (0024)
   ------------------------------------------------------------
   Loaded only by pages/maintenance-repairs.html. Every record comes
   from the workshop database through the Worker:

     GET    /api/tool-maintenance             the list, summary and panels
     GET    /api/tool-maintenance/:id         one job, its history, the equipment now
     POST   /api/tool-maintenance             schedule a job
     PUT    /api/tool-maintenance/:id         edit an open job (expectedUpdatedAt)
     POST   /api/tool-maintenance/:id/status  start / complete / cancel
     DELETE /api/tool-maintenance/:id         a job entered by mistake (Api.delete)

   The equipment to choose from is the Tools & Equipment / Equipment
   Inventory register (GET /api/tools: equipment in service only), and
   the technicians the active staff and mechanics. Starting, completing
   and cancelling a job also updates the equipment (status, service
   dates); the Worker does that in the same transaction.

   Permissions: buttons follow Storage.can() -- tools.edit to schedule,
   edit and change status, tools.delete to delete. The server checks
   every request again. Without the database the page says so; it never
   shows sample or browser-stored records. Everything from the data is
   escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const MaintenanceRepairs = (() => {

  const TYPES = ['Preventive Service', 'Inspection', 'Calibration', 'Repair'];
  const PRIORITIES = ['Normal', 'High', 'Urgent'];
  const FILTER_STATUSES = ['Scheduled', 'Due Soon', 'Overdue', 'In Progress', 'Completed', 'Cancelled'];
  const TRANSITIONS = { Scheduled: ['In Progress', 'Completed', 'Cancelled'], 'In Progress': ['Completed', 'Cancelled'], Completed: [], Cancelled: [] };
  const STATE_TONE = { Scheduled: 'info', 'Due Soon': 'warn', Overdue: 'bad', 'In Progress': 'violet', Completed: 'good', Cancelled: 'none' };
  const PRIORITY_TONE = { Normal: 'none', High: 'warn', Urgent: 'bad' };
  const LIMITS = { description: 1000, workDone: 1000, vendor: 120, reason: 300 };
  const MAX_COST = 100000000;
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

  /** The list's query. Empty filters are left out. */
  function buildQuery({ q = '', status = '', type = '', from = '', to = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (status) out.status = status;
    if (type) out.type = type;
    if (from) out.from = from;
    if (to) out.to = to;
    return out;
  }

  /** Client-side checks of the schedule / edit form (the Worker checks again). */
  function validate(v) {
    const e = {};
    if (!v.toolId) e.toolId = 'Choose the equipment.';
    if (!TYPES.includes(v.maintenanceType)) e.maintenanceType = 'Choose the maintenance type.';
    if (!PRIORITIES.includes(v.priority)) e.priority = 'Choose a priority.';
    if (!isRealDate(v.scheduledDate)) e.scheduledDate = 'Choose the service date.';
    if (v.estimatedCost !== '' && v.estimatedCost !== null && v.estimatedCost !== undefined) {
      const n = Number(v.estimatedCost);
      if (!Number.isFinite(n) || n < 0 || n > MAX_COST) e.estimatedCost = 'Enter a cost of 0 or more.';
    }
    if ((v.vendor || '').length > LIMITS.vendor) e.vendor = `Keep this to ${LIMITS.vendor} characters or fewer.`;
    if ((v.description || '').length > LIMITS.description) e.description = `Keep this to ${LIMITS.description} characters or fewer.`;
    return e;
  }

  /** The request body for a form: everything on create; only what changed on edit (null if nothing). */
  function payload(v, original = null) {
    const body = {
      toolId: v.toolId, maintenanceType: v.maintenanceType, priority: v.priority, scheduledDate: v.scheduledDate,
      technicianId: v.technicianId || null, vendor: (v.vendor || '').trim(),
      estimatedCost: v.estimatedCost === '' || v.estimatedCost === null || v.estimatedCost === undefined ? null : Number(v.estimatedCost),
      description: (v.description || '').trim(),
    };
    if (!original) return body;
    const out = {};
    const was = {
      toolId: original.toolId, maintenanceType: original.maintenanceType, priority: original.priority, scheduledDate: original.scheduledDate,
      technicianId: original.technicianId || null, vendor: original.vendor || '', estimatedCost: original.estimatedCost ?? null, description: original.description || '',
    };
    for (const k of Object.keys(body)) if (JSON.stringify(body[k]) !== JSON.stringify(was[k])) out[k] = body[k];
    if (!Object.keys(out).length) return null;
    out.expectedUpdatedAt = original.updatedAt;
    return out;
  }

  /** Which actions a record offers, given the caller's permissions. */
  function actionsFor(r, can = () => true) {
    const open = r.status === 'Scheduled' || r.status === 'In Progress';
    const edit = can('tools.edit');
    return {
      edit: edit && open,
      start: edit && r.status === 'Scheduled',
      complete: edit && open,
      cancel: edit && open,
      delete: can('tools.delete') && (r.status === 'Scheduled' || r.status === 'Cancelled'),
    };
  }

  const tone = (map, key) => map[key] || 'none';
  const stateBadge = (r) => `<span class="mr-badge mr-badge--${tone(STATE_TONE, r.dueState || r.status)}">${Utils.esc(r.dueState || r.status)}</span>`;
  const priorityBadge = (p) => `<span class="mr-badge mr-badge--${tone(PRIORITY_TONE, p)} mr-badge--plain">${Utils.esc(p)}</span>`;
  const fmtDate = (d) => (d ? Utils.fmtDate(d) : '');
  const moneyOr = (n) => (n === null || n === undefined || n === '' ? '<span class="mr-none">—</span>' : Utils.esc(Utils.money(n)));
  function who(r) {
    const parts = [r.technicianName, r.vendor].filter(Boolean);
    return parts.length ? Utils.esc(parts.join(' · ')) : '<span class="mr-none">Not assigned</span>';
  }
  /** The cost to show: the actual one once completed, else the estimate. */
  function costCell(r) {
    if (r.status === 'Completed' && r.actualCost !== null && r.actualCost !== undefined) return moneyOr(r.actualCost);
    return r.estimatedCost !== null && r.estimatedCost !== undefined ? `${moneyOr(r.estimatedCost)} <span class="mr-sub">est.</span>` : moneyOr(null);
  }

  /* ---------- page state ---------- */

  const state = { q: '', status: '', type: '', from: '', to: '', offset: 0, rows: [], meta: null, error: null, loading: false };
  let seq = 0, searchTimer = null, tools = null, people = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const can = (perm) => (typeof Storage !== 'undefined' && Storage.can ? Storage.can(perm) : true);
  const filtered = () => Boolean(state.q || state.status || state.type || state.from || state.to);
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };

  function renderSummary(meta) {
    const s = (meta && meta.summary) || {};
    const n = (v) => (Number.isFinite(v) ? String(v) : '—');
    setText('mrTotal', n(s.total));
    setText('mrSoon', n(s.dueSoon));
    setText('mrOverdue', n(s.overdue));
    setText('mrProgress', n(s.inProgress));
    setText('mrCost', Number.isFinite(s.totalCost) ? Utils.money(s.totalCost) : '—');
    setText('mrTotalSub', Number.isFinite(s.completed) ? `${s.completed} completed · ${s.scheduled + s.inProgress} open` : 'All jobs');
    setText('mrCostSub', Number.isFinite(s.estimatedOpenCost) && s.estimatedOpenCost ? `Completed work · ${Utils.money(s.estimatedOpenCost)} estimated still open` : 'Actual cost of completed work');
  }

  function renderPanels(meta) {
    const p = (meta && meta.panels) || {};
    const list = (id, rows, line, empty) => {
      $(id).innerHTML = rows && rows.length
        ? rows.map((r) => `<li><button type="button" class="mr-panel__item" data-act="view" data-id="${esc(r.id)}"><span class="mr-panel__name">${esc(r.toolName)}</span><span class="mr-panel__line">${line(r)}</span></button></li>`).join('')
        : `<li class="mr-panel__empty">${esc(empty)}</li>`;
    };
    list('mrUpcoming', p.upcoming, (r) => `${esc(r.maintenanceType)} · ${esc(fmtDate(r.scheduledDate))}${r.technicianName ? ` · ${esc(r.technicianName)}` : ''}`, 'Nothing due in the next 30 days.');
    list('mrOverduePanel', p.overdue, (r) => `${esc(r.maintenanceType)} · was due ${esc(fmtDate(r.scheduledDate))}`, 'Nothing overdue.');
    list('mrRecent', p.recentRepairs, (r) => `${esc(fmtDate(r.completedDate))}${r.actualCost !== null ? ` · ${esc(Utils.money(r.actualCost))}` : ''}`, 'No completed repairs yet.');
  }

  function actionButtons(r) {
    const a = actionsFor(r, can);
    const ICON = {
      view: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
      edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
      start: 'M8 5v14l11-7z',
      complete: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
      cancel: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
      delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    };
    const b = (act, label, extra = '') => `<button type="button" class="mr-act${extra}" data-act="${act}" data-id="${esc(r.id)}" aria-label="${esc(label)} ${esc(r.id)}" title="${esc(label)}"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${ICON[act]}"/></svg></button>`;
    return `<div class="mr-actions">${b('view', 'View details')}${a.edit ? b('edit', 'Edit') : ''}${a.start ? b('start', 'Start work') : ''}${a.complete ? b('complete', 'Mark completed', ' mr-act--good') : ''}${a.cancel ? b('cancel', 'Cancel', ' mr-act--warn') : ''}${a.delete ? b('delete', 'Delete', ' mr-act--danger') : ''}</div>`;
  }

  function renderRows(rows) {
    $('mrBody').innerHTML = rows.map((r) => `
      <tr${r.status === 'Cancelled' ? ' class="mr-row--muted"' : ''}>
        <td class="mr-c-code">${esc(r.id)}</td>
        <td><div class="mr-item"><button type="button" class="mr-item__name" data-act="view" data-id="${esc(r.id)}">${esc(r.toolName)}</button><span class="mr-sub">${esc(r.toolId)}</span></div></td>
        <td>${esc(r.maintenanceType)}</td>
        <td class="mr-nowrap">${esc(fmtDate(r.status === 'Completed' ? r.completedDate : r.scheduledDate))}${r.status === 'Completed' ? '<span class="mr-sub">completed</span>' : ''}</td>
        <td>${who(r)}</td>
        <td>${priorityBadge(r.priority)}</td>
        <td class="mr-c-num">${costCell(r)}</td>
        <td>${stateBadge(r)}</td>
        <td class="mr-c-actions">${actionButtons(r)}</td>
      </tr>`).join('');
    $('mrCards').innerHTML = rows.map((r) => `
      <li class="mr-card${r.status === 'Cancelled' ? ' mr-row--muted' : ''}">
        <div class="mr-card__head">
          <div class="mr-item"><button type="button" class="mr-item__name" data-act="view" data-id="${esc(r.id)}">${esc(r.toolName)}</button><span class="mr-sub">${esc(r.id)} · ${esc(r.maintenanceType)}</span></div>
          ${stateBadge(r)}
        </div>
        <dl class="mr-card__facts">
          <div><dt>${r.status === 'Completed' ? 'Completed' : 'Scheduled'}</dt><dd>${esc(fmtDate(r.status === 'Completed' ? r.completedDate : r.scheduledDate))}</dd></div>
          <div><dt>Priority</dt><dd>${priorityBadge(r.priority)}</dd></div>
          <div><dt>Technician / Vendor</dt><dd>${who(r)}</dd></div>
          <div><dt>Cost</dt><dd>${costCell(r)}</dd></div>
        </dl>
        ${actionButtons(r)}
      </li>`).join('');
  }

  function showList(show) { $('mrTableWrap').hidden = !show; $('mrCards').hidden = !show; $('mrFoot').hidden = !show; }

  function renderState(kind, opts = {}) {
    const host = $('mrState');
    if (kind === 'none') { host.innerHTML = ''; return; }
    if (kind === 'loading') {
      host.innerHTML = `<div class="mr-skeleton" aria-label="Loading maintenance records">${'<span class="mr-skeleton__row"></span>'.repeat(5)}</div>`;
      return;
    }
    host.innerHTML = `<div class="empty mr-state__box${kind === 'empty' ? '' : ' mr-state__box--bad'}">
        <h3>${esc(opts.title)}</h3><p>${esc(opts.text)}</p>
        ${opts.action ? `<button type="button" class="btn btn--ghost btn--sm" data-state-action="${esc(opts.action)}">${esc(opts.actionLabel)}</button>` : ''}
      </div>`;
  }

  function render() {
    $('mrClear').hidden = !filtered();
    $('mrAdd').hidden = !can('tools.edit');
    if (state.loading && !state.rows.length && !state.meta) { showList(false); renderState('loading'); return; }
    if (state.error) { showList(false); renderSummary(null); renderPanels(null); renderState('error', state.error); return; }
    renderSummary(state.meta);
    renderPanels(state.meta);
    if (!state.rows.length) {
      showList(false);
      renderState('empty', filtered()
        ? { title: 'No maintenance records match', text: 'Try a different search or clear the filters.', action: 'clear', actionLabel: 'Clear filters' }
        : { title: 'No maintenance scheduled yet', text: 'Schedule the first service, inspection, calibration or repair of a piece of equipment.', ...(can('tools.edit') ? { action: 'add', actionLabel: 'Schedule Maintenance' } : {}) });
      return;
    }
    renderState('none');
    renderRows(state.rows);
    const total = state.meta.total || 0;
    const to = state.offset + state.rows.length;
    setText('mrCount', `Showing ${state.offset + 1}–${to} of ${total} record${total === 1 ? '' : 's'}`);
    setText('mrPageLabel', `Page ${Math.floor(state.offset / PAGE_SIZE) + 1} of ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`);
    $('mrPrev').disabled = state.offset <= 0;
    $('mrNext').disabled = to >= total;
    showList(true);
  }

  function errorFor(res) {
    if (res.code === 'no_api') return { title: 'The workshop database is not connected', text: 'Maintenance records are kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in their place.' };
    if (res.code === 'offline') return { title: 'You are offline', text: 'Maintenance records are in the workshop database, which needs the internet. Nothing is shown from memory.', action: 'retry', actionLabel: 'Try again' };
    if (res.code === 'unauthorized' || res.code === 'locked') return { title: 'Your session has ended', text: 'Sign in again to see the maintenance records. Nothing was changed.', action: 'reload', actionLabel: 'Sign in again' };
    if (res.code === 'forbidden' || res.status === 403) return { title: 'Your role cannot see maintenance records', text: 'Ask an administrator for the Workshop Assets “view” permission.' };
    return { title: 'The maintenance records could not be loaded', text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.', action: 'retry', actionLabel: 'Retry' };
  }

  async function load() {
    if (Storage.isOffline && Storage.isOffline()) { state.loading = false; state.error = errorFor({ code: 'offline' }); render(); return false; }
    if (!Storage.isApi()) { state.loading = false; state.error = errorFor({ code: Storage.isLocked() ? 'locked' : 'no_api' }); render(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    render();
    const res = await Api.get(`/tool-maintenance?${new URLSearchParams(buildQuery({ ...state, limit: PAGE_SIZE })).toString()}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) { state.rows = []; state.meta = null; state.error = errorFor(res); render(); return false; }
    if (!res.data.length && state.offset > 0 && res.meta.total > 0) { state.offset = Math.max(0, (Math.ceil(res.meta.total / PAGE_SIZE) - 1) * PAGE_SIZE); return load(); }
    state.rows = Array.isArray(res.data) ? res.data : [];
    state.meta = res.meta || {};
    $('mrAdd').disabled = false;
    render();
    return true;
  }

  /* ---------- choices: equipment and people ---------- */

  async function loadTools() {
    const res = await Api.get('/tools?limit=1000&sort=name&order=asc');
    if (!res.ok) return null;
    tools = (res.data || []).filter((t) => t.status !== 'Retired').map((t) => ({ id: t.id, name: t.name, status: t.status, category: t.category }));
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

  /* ---------- forms ---------- */

  const options = (list, chosen, placeholder) => (placeholder !== undefined ? `<option value="">${esc(placeholder)}</option>` : '')
    + list.map((x) => (typeof x === 'string'
      ? `<option value="${esc(x)}"${x === chosen ? ' selected' : ''}>${esc(x)}</option>`
      : `<option value="${esc(x.id)}"${x.id === chosen ? ' selected' : ''}>${esc(x.label)}</option>`)).join('');

  function field({ key, label, required = false, control, span = false, hint = '' }) {
    return `<div class="field${span ? ' span-2' : ''}">
        <label for="mrf-${key}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${control}
        ${hint ? `<span class="mr-hint">${esc(hint)}</span>` : ''}
        <span class="field__error" data-err="${key}" id="mrf-${key}-err" role="alert"></span>
      </div>`;
  }
  const input = (key, value = '', attrs = '', type = 'text') => `<input class="input" type="${type}" id="mrf-${key}" name="${key}" value="${esc(value)}" ${attrs}>`;
  const textarea = (key, value = '', max = 1000) => `<textarea class="textarea" id="mrf-${key}" name="${key}" rows="3" maxlength="${max}">${esc(value)}</textarea>`;
  const select = (key, inner, attrs = '') => `<select class="select" id="mrf-${key}" name="${key}" ${attrs}>${inner}</select>`;

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

  async function openForm(record = null) {
    const [toolList, peopleList] = await Promise.all([loadTools(), loadPeople()]);
    if (!toolList) { Utils.toast('The equipment list could not be loaded. Try again.', 'error'); return; }
    const v = record || { priority: 'Normal', scheduledDate: todayInDhaka() };
    const started = record && record.status !== 'Scheduled';
    const toolChoices = toolList.map((t) => ({ id: t.id, label: `${t.name} (${t.id})${t.status !== 'Available' ? ` · ${t.status}` : ''}` }));
    if (record && !toolChoices.some((t) => t.id === record.toolId)) toolChoices.unshift({ id: record.toolId, label: `${record.toolName} (${record.toolId})` });
    const personChoices = peopleList.map((p) => ({ id: p.id, label: `${p.name} (${p.role})` }));
    if (record && record.technicianId && !personChoices.some((p) => p.id === record.technicianId)) personChoices.unshift({ id: record.technicianId, label: record.technicianName });
    const ov = Utils.Modal.open({
      title: record ? `Edit ${record.id}` : 'Schedule Maintenance',
      size: 'lg',
      body: `<form id="mrForm" class="mr-form" novalidate>
        <p class="mr-form__note">Fields marked <span class="req">*</span> are required.${record ? '' : ' The record number is given when you save.'}</p>
        <div class="form-grid">
          ${field({ key: 'toolId', label: 'Equipment', required: true, span: true, control: select('toolId', options(toolChoices, v.toolId, 'Choose the equipment'), started ? 'disabled' : 'required'),
            hint: started ? 'The equipment cannot change once work has started.' : (toolList.length ? '' : 'No equipment in service yet: add it under Equipment Inventory first.') })}
          ${field({ key: 'maintenanceType', label: 'Maintenance type', required: true, control: select('maintenanceType', options(TYPES, v.maintenanceType, 'Choose a type'), 'required') })}
          ${field({ key: 'priority', label: 'Priority', required: true, control: select('priority', options(PRIORITIES, v.priority || 'Normal')) })}
          ${field({ key: 'scheduledDate', label: 'Service date', required: true, control: input('scheduledDate', v.scheduledDate, 'required', 'date') })}
          ${field({ key: 'technicianId', label: 'Assigned technician', control: select('technicianId', options(personChoices, v.technicianId || '', 'Not assigned')) })}
          ${field({ key: 'vendor', label: 'Outside vendor', control: input('vendor', v.vendor || '', `maxlength="${LIMITS.vendor}" autocomplete="off" placeholder="e.g. Lift Service Co"`) })}
          ${field({ key: 'estimatedCost', label: 'Estimated cost (৳)', control: input('estimatedCost', v.estimatedCost ?? '', `min="0" max="${MAX_COST}" step="0.01" inputmode="decimal"`, 'number') })}
          ${field({ key: 'description', label: 'What needs doing', span: true, control: textarea('description', v.description || '', LIMITS.description) })}
        </div>
      </form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="submit" form="mrForm" class="btn btn--primary" data-mr-save>${record ? 'Save Changes' : 'Schedule'}</button>`,
    });
    ov.classList.add('mr-modal');
    const form = ov.querySelector('#mrForm');
    const read = () => {
      const out = {};
      for (const k of ['toolId', 'maintenanceType', 'priority', 'scheduledDate', 'technicianId', 'vendor', 'estimatedCost', 'description']) out[k] = form.elements[k] ? form.elements[k].value : '';
      if (started) out.toolId = record.toolId;
      return out;
    };
    const start = JSON.stringify(read());
    guardDirty(ov, () => JSON.stringify(read()) !== start);
    const btn = ov.querySelector('[data-mr-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const values = read();
        if (showErrors(form, validate(values))) return;
        const body = payload(values, record);
        if (record && !body) { Utils.Modal.close(); Utils.toast('Nothing was changed.', 'info'); return; }
        const res = record ? await Api.put(`/tool-maintenance/${encodeURIComponent(record.id)}`, body) : await Api.post('/tool-maintenance', body);
        if (!res.ok) { refused(form, res, 'The maintenance could not be saved.'); return; }
        Utils.Modal.close();
        Utils.toast(record ? `${res.data.id} was updated.` : `${res.data.maintenanceType} of ${res.data.toolName} scheduled as ${res.data.id}.`, 'success');
        if (!record) state.offset = 0;
        load();
      });
    });
  }

  /** One small status dialog: start, complete or cancel. */
  function openStatus(r, to) {
    const today = todayInDhaka();
    const titles = { 'In Progress': `Start work — ${r.toolName}`, Completed: `Mark completed — ${r.toolName}`, Cancelled: `Cancel ${r.id}` };
    let inner = '';
    if (to === 'In Progress') {
      inner = `<p class="mr-form__note">Work on <strong>${esc(r.toolName)}</strong> (${esc(r.maintenanceType)}) starts now.</p>
        <label class="mr-check"><input type="checkbox" name="takeOutOfService" checked> Mark the equipment <strong>Under Maintenance</strong> while the work is done (ends any assignment)</label>`;
    } else if (to === 'Completed') {
      inner = `<div class="form-grid">
          ${field({ key: 'completedDate', label: 'Completed on', required: true, control: input('completedDate', today, `required max="${today}"`, 'date') })}
          ${field({ key: 'actualCost', label: 'Actual cost (৳)', control: input('actualCost', r.estimatedCost ?? '', `min="0" max="${MAX_COST}" step="0.01" inputmode="decimal"`, 'number') })}
          ${field({ key: 'nextServiceDue', label: 'Next service due', control: input('nextServiceDue', '', `min="${today}"`, 'date'), hint: 'Saved on the equipment too.' })}
          ${field({ key: 'workDone', label: 'Work done', span: true, control: textarea('workDone', '', LIMITS.workDone) })}
        </div>
        <p class="mr-hint">The equipment’s last service date is updated, and it goes back to Available if no other work on it is still in progress and its condition allows.</p>`;
    } else {
      inner = field({ key: 'reason', label: 'Reason', required: true, control: textarea('reason', '', LIMITS.reason) });
    }
    const ov = Utils.Modal.open({
      title: titles[to],
      body: `<form id="mrStatusForm" class="mr-form" novalidate>${inner}</form>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        <button type="submit" form="mrStatusForm" class="btn ${to === 'Cancelled' ? 'btn--danger' : 'btn--primary'}" data-mr-save>${to === 'In Progress' ? 'Start Work' : to === 'Completed' ? 'Mark Completed' : 'Cancel Maintenance'}</button>`,
    });
    ov.classList.add('mr-modal');
    const form = ov.querySelector('#mrStatusForm');
    const btn = ov.querySelector('[data-mr-save]');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      Utils.guard(btn, async () => {
        const body = { to, expectedUpdatedAt: r.updatedAt };
        const val = (k) => (form.elements[k] ? form.elements[k].value.trim() : '');
        if (to === 'In Progress') body.takeOutOfService = Boolean(form.elements.takeOutOfService && form.elements.takeOutOfService.checked);
        if (to === 'Completed') {
          const e = {};
          if (!isRealDate(val('completedDate'))) e.completedDate = 'Enter the day the work was completed.';
          else if (val('completedDate') > today) e.completedDate = 'The completion date cannot be in the future.';
          if (val('nextServiceDue') && (!isRealDate(val('nextServiceDue')) || val('nextServiceDue') <= val('completedDate'))) e.nextServiceDue = 'The next service must be after the completion date.';
          if (showErrors(form, e)) return;
          body.completedDate = val('completedDate');
          if (val('actualCost') !== '') body.actualCost = Number(val('actualCost'));
          if (val('workDone')) body.workDone = val('workDone');
          if (val('nextServiceDue')) body.nextServiceDue = val('nextServiceDue');
        }
        if (to === 'Cancelled') {
          if (!val('reason')) { showErrors(form, { reason: 'Please give a reason for cancelling.' }); return; }
          body.reason = val('reason');
        }
        const res = await Api.post(`/tool-maintenance/${encodeURIComponent(r.id)}/status`, body);
        if (!res.ok) { refused(form, res, 'The status could not be changed.'); return; }
        Utils.Modal.close();
        Utils.toast(`${res.data.id} is now ${res.data.status}.`, 'success');
        load();
      });
    });
  }

  function openDelete(r) {
    const ov = Utils.Modal.open({
      title: `Delete ${r.id}?`,
      body: `<p class="mr-form__note">Delete the ${esc(r.status.toLowerCase())} ${esc(r.maintenanceType.toLowerCase())} of <strong>${esc(r.toolName)}</strong> scheduled for ${esc(fmtDate(r.scheduledDate))}? Use this only for a record entered by mistake. Its history is kept.</p>`,
      footer: '<button type="button" class="btn btn--ghost" data-modal-close>Keep it</button><button type="button" class="btn btn--danger" data-mr-del>Delete</button>',
    });
    const btn = ov.querySelector('[data-mr-del]');
    btn.addEventListener('click', () => Utils.guard(btn, async () => {
      const res = await Api.delete(`/tool-maintenance/${encodeURIComponent(r.id)}?expectedUpdatedAt=${encodeURIComponent(r.updatedAt)}`);
      if (!res.ok) { refused(null, res, 'The record could not be deleted.'); return; }
      Utils.Modal.close();
      Utils.toast(`${r.id} was deleted.`, 'success');
      load();
    }));
  }

  async function openDetails(id) {
    const res = await Api.get(`/tool-maintenance/${encodeURIComponent(id)}`);
    if (!res.ok) { Utils.toast(res.message || 'The record could not be loaded.', 'error'); return; }
    const r = res.data;
    const a = actionsFor(r, can);
    const fact = (label, value, span = false) => (value ? `<div class="detail-item${span ? ' span-2' : ''}"><div class="label">${esc(label)}</div><div class="value">${value}</div></div>` : '');
    const t = r.tool;
    const ov = Utils.Modal.open({
      title: `${r.toolName} — ${r.maintenanceType}`,
      size: 'lg',
      body: `<div class="mr-detail__head"><span class="mr-detail__id">${esc(r.id)}</span><span class="mr-detail__badges">${stateBadge(r)} ${priorityBadge(r.priority)}</span></div>
        ${r.status === 'Cancelled' ? `<p class="mr-note">Cancelled: ${esc(r.cancelReason)}</p>` : ''}
        <div class="detail-grid">
          ${fact('Equipment', `${esc(r.toolName)} <span class="mr-sub">${esc(r.toolId)}${t ? ` · now ${esc(t.status)}` : ' · no longer in the register'}</span>`, true)}
          ${fact('Scheduled', esc(fmtDate(r.scheduledDate)))}
          ${fact('Completed', esc(fmtDate(r.completedDate)))}
          ${fact('Assigned technician', esc(r.technicianName))}
          ${fact('Outside vendor', esc(r.vendor))}
          ${fact('Estimated cost', r.estimatedCost !== null ? esc(Utils.money(r.estimatedCost)) : '')}
          ${fact('Actual cost', r.actualCost !== null ? esc(Utils.money(r.actualCost)) : '')}
          ${fact('Next service due', esc(fmtDate(r.nextServiceDue)))}
          ${t ? fact('Equipment last serviced', esc(fmtDate(t.lastServiceDate)) || '<span class="mr-none">Not recorded</span>') : ''}
        </div>
        ${r.description ? `<h4 class="mr-detail__h">What needs doing</h4><p class="mr-detail__text">${esc(r.description)}</p>` : ''}
        ${r.workDone ? `<h4 class="mr-detail__h">Work done</h4><p class="mr-detail__text">${esc(r.workDone)}</p>` : ''}
        <h4 class="mr-detail__h">History</h4>
        <ol class="mr-history">${(r.history || []).map((e) => `<li><span class="mr-history__what">${esc(e.summary)}</span><span class="mr-sub">${esc(e.actor || 'Unknown')} · ${esc(new Date(e.at).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }))}</span></li>`).join('')}</ol>`,
      footer: `<button type="button" class="btn btn--ghost" data-modal-close>Close</button>
        ${a.delete ? '<button type="button" class="btn btn--danger-ghost" data-mr-do="delete">Delete</button>' : ''}
        ${a.cancel ? '<button type="button" class="btn btn--danger-ghost" data-mr-do="cancel">Cancel</button>' : ''}
        ${a.edit ? '<button type="button" class="btn btn--ghost" data-mr-do="edit">Edit</button>' : ''}
        ${a.start ? '<button type="button" class="btn btn--ghost" data-mr-do="start">Start Work</button>' : ''}
        ${a.complete ? '<button type="button" class="btn btn--primary" data-mr-do="complete">Mark Completed</button>' : ''}`,
    });
    ov.classList.add('mr-modal');
    ov.querySelectorAll('[data-mr-do]').forEach((b) => b.addEventListener('click', () => run(b.dataset.mrDo, r)));
  }

  function run(act, r) {
    if (act === 'view') return openDetails(r.id);
    if (act === 'edit') return openForm(r);
    if (act === 'start') return openStatus(r, 'In Progress');
    if (act === 'complete') return openStatus(r, 'Completed');
    if (act === 'cancel') return openStatus(r, 'Cancelled');
    if (act === 'delete') return openDelete(r);
    return null;
  }

  /* ---------- events ---------- */

  function resetFilters() {
    Object.assign(state, { q: '', status: '', type: '', from: '', to: '', offset: 0 });
    for (const id of ['mrSearch', 'mrStatus', 'mrType', 'mrFrom', 'mrTo']) $(id).value = '';
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
    $('mrStatus').insertAdjacentHTML('beforeend', options(FILTER_STATUSES));
    $('mrType').insertAdjacentHTML('beforeend', options(TYPES));
    $('mrAdd').addEventListener('click', () => openForm());
    $('mrSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('mrSearch').value.trim(); state.offset = 0; load(); }, 300);
    });
    for (const [id, key] of [['mrStatus', 'status'], ['mrType', 'type'], ['mrFrom', 'from'], ['mrTo', 'to']]) {
      $(id).addEventListener('change', () => {
        const v = $(id).value;
        if ((key === 'from' || key === 'to') && v && !isRealDate(v)) return;
        state[key] = v; state.offset = 0; load();
      });
    }
    $('mrClear').addEventListener('click', resetFilters);
    $('mrPrev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - PAGE_SIZE); load(); });
    $('mrNext').addEventListener('click', () => { state.offset += PAGE_SIZE; load(); });
    for (const id of ['mrBody', 'mrCards', 'mrUpcoming', 'mrOverduePanel', 'mrRecent']) $(id).addEventListener('click', onAct);
    $('mrState').addEventListener('click', (ev) => {
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
    if (document.body.dataset.page !== 'maintenance-repairs') return;
    bind();
    state.loading = true;
    render();
    Storage.ready(() => load());
  }

  return { TYPES, PRIORITIES, FILTER_STATUSES, TRANSITIONS, buildQuery, validate, payload, actionsFor, isRealDate, init, _state: state, load };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { MaintenanceRepairs };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) MaintenanceRepairs.init();
