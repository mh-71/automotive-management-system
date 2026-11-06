/* ============================================================
   asset-history.js — Workshop Assets › Asset History
   ------------------------------------------------------------
   Loaded only by pages/asset-history.html. A timeline of what has
   happened to the workshop equipment, read from the workshop database
   through the Worker (read only -- this page changes nothing):

     GET /api/asset-history             the timeline and its summary
                                        (q, toolId, type, range, paging)
     GET /api/asset-history/:toolId     Asset details: the item as it is
                                        now and its whole history
     GET /api/tools?includeRetired=1    the "All Assets" filter's choices

   The look is the one the page had as a demo (same layout, cards,
   toolbar, timeline, classes), drawn here without the shared demo
   engine, which the remaining demo page still uses unchanged.

   Permission: tools.view; the server checks every request. Without the
   database the page says so; it never shows sample or browser-stored
   records. Everything from the data is escaped (Utils.esc).
   ============================================================ */

const AssetHistory = (() => {

  // Activity types: icon and tone of the timeline dot, and the item's title.
  const TYPES = {
    'Asset Purchased': ['cart', 'violet', 'New asset added to the workshop'],
    'Asset Assigned': ['userCheck', 'amber', 'Issued to staff or a mechanic'],
    'Asset Returned': ['undo', 'good', 'Returned to the store'],
    'Maintenance Completed': ['check', 'info', 'Service completed'],
    'Repair Recorded': ['wrench', 'bad', 'Repair logged'],
    'Status Changed': ['refresh', 'neutral', 'Status updated'],
  };
  // Status words mapped to the shared badge tones (as the page always showed them).
  const TONES = { Available: 'good', 'In Use': 'warn', 'Under Maintenance': 'bad', Damaged: 'bad', Retired: 'neutral' };
  const RANGES = [['all', 'All dates'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months']];
  const PAGE_SIZE = 50;

  /* Lucide outline icons (the same shapes the page has always used). */
  const ICONS = {
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  };
  const icon = (name, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.history}</svg>`;

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "2026-10-04" -> "4 Oct 2026"; anything else is a dash. */
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
  }
  /** "Oct 2026" for the month headings. */
  const monthOf = (iso) => fmtDate(iso).replace(/^\d+ /, '');
  /** The time of day in the workshop's zone, or '' when only the day is known. */
  function fmtTime(at) {
    if (!at || !/T/.test(at)) return '';
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
  }
  /** Whole Taka with thousands separators. */
  const money = (n) => `৳${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

  /** The list's query. Empty filters are left out. */
  function buildQuery({ q = '', toolId = '', type = '', range = 'all', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (toolId && toolId !== 'all') out.toolId = toolId;
    if (type && type !== 'all') out.type = type;
    if (range && range !== 'all') out.range = range;
    return out;
  }

  /** The five summary cards, from the server's counts. */
  function cards(s) {
    const v = (n) => (Number.isFinite(n) ? n : '—');
    return [
      { label: 'Total Activities', value: v(s && s.total), sub: 'Recorded events', icon: 'history', tone: 'info' },
      { label: 'Purchases', value: v(s && s.purchases), sub: 'New assets', icon: 'cart', tone: 'violet' },
      { label: 'Assignments', value: s ? v(s.assigned + s.returned) : '—', sub: s ? `${s.assigned} issued · ${s.returned} returned` : 'Issued and returned', icon: 'userCheck', tone: 'amber' },
      { label: 'Maintenance Events', value: v(s && s.maintenance), sub: 'Completed services', icon: 'check', tone: 'good' },
      { label: 'Repairs', value: v(s && s.repairs), sub: 'Recorded repairs', icon: 'wrench', tone: 'bad' },
    ];
  }

  /** The words under an entry: its description, plus the amount when there is one. */
  function describe(r) {
    const parts = [r.description || ''];
    if (r.amount !== null && r.amount !== undefined && r.amount !== '') parts.push(r.type === 'Asset Purchased' ? `for ${money(r.amount)}` : `cost ${money(r.amount)}`);
    return parts.filter(Boolean).join(' · ');
  }

  /* ---------- page state ---------- */

  const state = { q: '', toolId: 'all', type: 'all', range: 'all', rows: [], summary: null, total: 0, error: null, loading: false };
  let seq = 0, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const filtered = () => Boolean(state.q || state.toolId !== 'all' || state.type !== 'all' || state.range !== 'all');

  function shell() {
    const opts = (list) => list.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    $('adRoot').innerHTML = `
      <div class="ad-top">
        <nav class="ad-crumbs" aria-label="Breadcrumb"><ol>
          <li><a href="../index.html">${icon('home', 16)}<span>Dashboard</span></a></li>
          <li><a href="workshop-tools.html">Workshop Assets</a></li>
          <li aria-current="page">Asset History</li>
        </ol></nav>
        <div class="ad-head">
          <span class="ad-head__icon">${icon('history', 30)}</span>
          <div class="ad-head__text">
            <h2 class="ad-head__title">Asset History</h2>
            <p class="page-subtitle">A timeline of purchases, assignments, returns, maintenance, repairs and status changes.</p>
          </div>
          <div class="ad-head__actions"></div>
        </div>
      </div>
      <section class="ad-stats" id="ahStats" aria-label="Summary" aria-live="polite"></section>
      <section class="card ad-card" aria-label="Asset activity timeline">
        <div class="ad-toolbar" role="search">
          <label class="ad-search">${icon('search', 18)}<input type="search" class="input" id="adSearch" autocomplete="off" maxlength="100" placeholder="Search activity, asset, code or person…" aria-label="Search activity, asset, code or person"></label>
          <select class="select ad-select" id="adf-asset" aria-label="Filter by asset"><option value="all">All Assets</option></select>
          <select class="select ad-select" id="adf-type" aria-label="Filter by activity type"><option value="all">All Activity Types</option>${opts(Object.keys(TYPES).map((t) => [t, t]))}</select>
          <select class="select ad-select" id="adf-date" aria-label="Filter by date range">${opts(RANGES)}</select>
        </div>
        <div class="ad-view" id="ahView" hidden></div>
        <div class="ah-state" id="ahState" role="status" aria-live="polite"></div>
        <div class="ad-foot"><span id="adCount" aria-live="polite"></span><button type="button" class="btn btn--ghost btn--sm" id="ahMore" hidden>Show more</button></div>
      </section>`;
  }

  function renderCards() {
    $('ahStats').innerHTML = cards(state.summary).map((c) => `
      <div class="ad-stat ad-tone--${c.tone}">
        <span class="ad-stat__icon">${icon(c.icon, 22)}</span>
        <div class="ad-stat__body"><div class="ad-stat__label">${esc(c.label)}</div><div class="ad-stat__value">${esc(c.value)}</div><div class="ad-stat__sub">${esc(c.sub)}</div></div>
      </div>`).join('');
  }

  function item(r) {
    const [ic, tone, title] = TYPES[r.type] || TYPES['Status Changed'];
    const time = fmtTime(r.at);
    const who = [r.performedBy ? `Performed by ${r.performedBy}` : 'Performed by: not recorded'];
    return `<li class="ah-item ad-tone--${tone}">
        <span class="ah-dot">${icon(ic, 16)}</span>
        <div class="ah-body">
          <div class="ah-top"><h3 class="ah-title">${esc(title)}</h3><span class="ah-type">${esc(r.type)}</span><time class="ah-date" datetime="${esc(r.at || r.date)}">${esc(fmtDate(r.date))}${time ? ` · ${esc(time)}` : ''}</time></div>
          <p class="ah-asset"><span class="ah-asset__name">${esc(r.toolName)}</span><span class="ad-code">${esc(r.toolId)}</span></p>
          <p class="ah-text">${esc(describe(r)) || '<span class="ah-none">No description recorded.</span>'}</p>
          <p class="ah-meta">${icon('user', 14)}<span>${esc(who[0])}</span>${r.relatedName ? `<span class="ah-meta__sep" aria-hidden="true">·</span>${icon('users', 14)}<span>${esc(r.type === 'Maintenance Completed' || r.type === 'Repair Recorded' ? 'Technician' : 'Staff / mechanic')}: ${esc(r.relatedName)}${r.relatedId ? ` (${esc(r.relatedId)})` : ''}</span>` : ''}</p>
          <button type="button" class="btn btn--ghost btn--sm ah-view" data-tool="${esc(r.toolId)}" aria-label="Asset details: ${esc(r.toolName)}">${icon('eye', 15)}<span>Asset details</span></button>
        </div>
      </li>`;
  }

  /** The timeline: one item per activity, grouped under its month. */
  function timeline(rows) {
    let month = '';
    let html = '';
    for (const r of rows) {
      const m = monthOf(r.date);
      if (m !== month) { month = m; html += `<li class="ah-month">${esc(m)}</li>`; }
      html += item(r);
    }
    return `<ol class="ah-timeline">${html}</ol>`;
  }

  function renderState(kind, opts = {}) {
    const host = $('ahState');
    if (kind === 'none') { host.innerHTML = ''; return; }
    if (kind === 'loading') { host.innerHTML = `<div class="ah-skeleton" aria-label="Loading the asset history">${'<span class="ah-skeleton__row"></span>'.repeat(4)}</div>`; return; }
    host.innerHTML = `<div class="empty ad-empty${kind === 'error' ? ' ah-error' : ''}">
        ${icon(kind === 'error' ? 'alert' : 'inbox', 40)}
        <h3>${esc(opts.title)}</h3><p>${esc(opts.text)}</p>
        ${opts.action ? `<button type="button" class="btn btn--ghost btn--sm" data-state-action="${esc(opts.action)}">${esc(opts.actionLabel)}</button>` : ''}
      </div>`;
  }

  function render() {
    renderCards();
    const view = $('ahView');
    if (state.loading && !state.rows.length) { view.hidden = true; renderState('loading'); $('adCount').textContent = ''; $('ahMore').hidden = true; return; }
    if (state.error) { view.hidden = true; renderState('error', state.error); $('adCount').textContent = ''; $('ahMore').hidden = true; return; }
    if (!state.rows.length) {
      view.hidden = true;
      renderState('empty', filtered()
        ? { title: 'No activities found', text: 'Try a different search or filter.', action: 'clear', actionLabel: 'Clear filters' }
        : { title: 'No asset history yet', text: 'Purchases, assignments, returns, maintenance, repairs and status changes appear here as they are recorded in Equipment Inventory, Asset Assignment and Maintenance & Repairs.' });
      $('adCount').textContent = 'Showing 0 activities';
      $('ahMore').hidden = true;
      return;
    }
    renderState('none');
    view.innerHTML = timeline(state.rows);
    view.hidden = false;
    $('adCount').textContent = `Showing ${state.rows.length} of ${state.total} ${state.total === 1 ? 'activity' : 'activities'}`;
    $('ahMore').hidden = state.rows.length >= state.total;
  }

  function errorFor(res) {
    if (res.code === 'no_api') return { title: 'The workshop database is not connected', text: 'The asset history is kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in its place.' };
    if (res.code === 'offline') return { title: 'You are offline', text: 'The asset history is in the workshop database, which needs the internet. Nothing is shown from memory.', action: 'retry', actionLabel: 'Try again' };
    if (res.code === 'unauthorized' || res.code === 'locked') return { title: 'Your session has ended', text: 'Sign in again to see the asset history.', action: 'reload', actionLabel: 'Sign in again' };
    if (res.code === 'forbidden' || res.status === 403) return { title: 'Your role cannot see the asset history', text: 'Ask an administrator for the Workshop Assets “view” permission.' };
    return { title: 'The asset history could not be loaded', text: 'The workshop database did not answer, so nothing is shown. Try again in a moment.', action: 'retry', actionLabel: 'Retry' };
  }

  /** Load the first page (more = false) or the next one (more = true). */
  async function load(more = false) {
    if (Storage.isOffline && Storage.isOffline()) { state.loading = false; state.error = errorFor({ code: 'offline' }); state.summary = null; render(); return false; }
    if (!Storage.isApi()) { state.loading = false; state.error = errorFor({ code: Storage.isLocked() ? 'locked' : 'no_api' }); state.summary = null; render(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    if (!more) { state.rows = []; render(); }
    const res = await Api.get(`/asset-history?${new URLSearchParams(buildQuery({ ...state, offset: more ? state.rows.length : 0 })).toString()}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) { state.rows = []; state.summary = null; state.error = errorFor(res); render(); return false; }
    const meta = res.meta || {};
    const fresh = Array.isArray(res.data) ? res.data : [];
    // Never the same activity twice, even if a page boundary moved while loading more.
    const seen = new Set(more ? state.rows.map((r) => r.key) : []);
    state.rows = (more ? state.rows : []).concat(fresh.filter((r) => !seen.has(r.key) && seen.add(r.key)));
    state.summary = meta.summary || null;
    state.total = Number.isFinite(meta.total) ? meta.total : state.rows.length;
    render();
    return true;
  }

  async function fillAssets() {
    const res = await Api.get('/tools?limit=1000&sort=name&order=asc&includeRetired=1');
    if (!res.ok) return;
    $('adf-asset').insertAdjacentHTML('beforeend', (res.data || []).map((t) => `<option value="${esc(t.id)}">${esc(`${t.name} (${t.id})`)}</option>`).join(''));
    if (state.toolId !== 'all') $('adf-asset').value = state.toolId;
  }

  /* ---------- asset details ---------- */

  async function openAsset(toolId) {
    const res = await Api.get(`/asset-history/${encodeURIComponent(toolId)}`);
    if (!res.ok) { Utils.toast(res.message || 'The asset could not be loaded.', 'error'); return; }
    const { asset, activities } = res.data;
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v === '' || v === null || v === undefined ? '—' : v}</dd>`;
    const a = asset || {};
    const details = asset ? `<dl class="ad-details">
        ${row('Asset', esc(a.name))}${row('Asset code', `<span class="ad-code">${esc(a.id)}</span>`)}${row('Category', esc(a.category))}
        ${row('Brand / model', esc([a.brand, a.model].filter(Boolean).join(' ')))}${row('Serial number', esc(a.serialNo))}
        ${row('Current status', `<span class="badge badge--${TONES[a.status] || 'neutral'} ad-badge">${esc(a.status)}</span>`)}${row('Condition', esc(a.condition))}
        ${row('With', esc(a.holder))}${row('Location', esc(a.location))}
        ${row('Purchased', a.purchaseDate ? esc(fmtDate(a.purchaseDate)) : '')}${row('Purchase price', a.purchasePrice !== null ? esc(money(a.purchasePrice)) : '')}${row('Supplier', esc(a.supplier))}
        ${row('Last serviced', a.lastServiceDate ? esc(fmtDate(a.lastServiceDate)) : '')}${row('Next service due', a.nextServiceDue ? esc(fmtDate(a.nextServiceDue)) : '')}
        ${row('Recorded activities', esc(activities.length))}
      </dl>`
      : `<p class="ah-gone">This item is no longer in the equipment register; its recorded history is kept below.</p>`;
    const list = activities.length
      ? `<ul class="ad-mini ah-preview">${activities.map((e) => `<li><span class="ad-mini__text"><span class="ad-mini__title">${esc(e.type)}</span><span class="ad-mini__sub">${esc(describe(e))}${e.performedBy ? ` — ${esc(e.performedBy)}` : ''}</span></span><span class="ad-mini__side">${esc(fmtDate(e.date))}${fmtTime(e.at) ? `<br>${esc(fmtTime(e.at))}` : ''}</span></li>`).join('')}</ul>`
      : '<p class="ad-mini__sub ah-preview">No activities recorded yet.</p>';
    const ov = Utils.Modal.open({ title: `${asset ? asset.name : toolId} — history`, size: 'lg', body: `<div class="ah-asset-modal">${details}${list}</div>`,
      footer: '<button type="button" class="btn btn--ghost" data-modal-close>Close</button>' });
    if (ov && ov.classList) ov.classList.add('ah-modal');
  }

  /* ---------- events ---------- */

  function resetFilters() {
    Object.assign(state, { q: '', toolId: 'all', type: 'all', range: 'all' });
    $('adSearch').value = ''; $('adf-asset').value = 'all'; $('adf-type').value = 'all'; $('adf-date').value = 'all';
    load();
  }

  function bind() {
    $('adSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('adSearch').value.trim(); load(); }, 300);
    });
    for (const [id, key] of [['adf-asset', 'toolId'], ['adf-type', 'type'], ['adf-date', 'range']]) {
      $(id).addEventListener('change', () => { state[key] = $(id).value; load(); });
    }
    $('ahMore').addEventListener('click', () => Utils.guard ? Utils.guard($('ahMore'), () => load(true)) : load(true));
    $('ahView').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tool]'); if (b) openAsset(b.dataset.tool); });
    $('ahState').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-state-action]');
      if (!b) return;
      if (b.dataset.stateAction === 'retry') load();
      else if (b.dataset.stateAction === 'clear') resetFilters();
      else if (b.dataset.stateAction === 'reload') location.reload();
    });
  }

  function init() {
    if (document.body.dataset.page !== 'asset-history' || !$('adRoot')) return;
    shell();
    bind();
    state.loading = true;
    render();
    Storage.ready(() => { load().then((ok) => { if (ok) fillAssets(); }); });
  }

  return { TYPES, RANGES, buildQuery, cards, describe, fmtDate, fmtTime, monthOf, money, timeline, init, _state: state, load };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AssetHistory };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) AssetHistory.init();
