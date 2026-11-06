/* ============================================================
   asset-reports.js — Workshop Assets › Asset Reports
   ------------------------------------------------------------
   Loaded only by pages/asset-reports.html. Every figure comes from the
   workshop database through the Worker (read only -- this page changes
   nothing):

     GET /api/asset-reports           the report: summary, categories,
                                      utilisation, expenses and the asset
                                      table (paged), all for the filters
     GET /api/asset-reports/:toolId   one asset's purchase and costs

   The look is the one the page had as a demo (same cards, toolbar and CSS
   bar charts -- no chart library), drawn here without the shared demo
   engine, which no page uses any more but which is left unchanged.

   Export: CSV of the assets the filters leave (every page, not only the
   one shown), CSV of maintenance costs by equipment for the period, and
   Print / Save as PDF through the browser's own print dialog, using the
   shared print layout (body.printing-report, as the Reports page does).
   Spreadsheet formulas are neutralised in CSV cells.

   Permission: tools.view; the server checks every request. Without the
   database the page says so; it never shows sample or browser-stored
   figures. Everything from the data is escaped (Utils.esc).
   ============================================================ */

const AssetReports = (() => {

  const CATEGORIES = ['Diagnostic Equipment', 'Engine Tools', 'Electrical Tools', 'AC Service Equipment',
    'Lifting Equipment', 'Workshop Hand Tools', 'Safety Equipment', 'Cleaning Equipment', 'Other'];
  const STATUSES = ['Available', 'In Use', 'Under Maintenance', 'Damaged', 'Retired'];
  const PERIODS = [['all', 'All dates'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months'], ['year', 'This year'], ['lastyear', 'Last year']];
  const STATUS_TONE = { Available: 'good', 'In Use': 'warn', 'Under Maintenance': 'bad', Damaged: 'bad', Retired: 'neutral' };
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const PAGE_SIZE = 25;

  /* Lucide outline icons (the same shapes the page has always used). */
  const ICONS = {
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
    package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
    check: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    printer: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  };
  const icon = (name, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  const DHAKA = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' });
  const todayInDhaka = (at = new Date()) => DHAKA.format(at);
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const isRealDate = (s) => {
    if (!DATE_ONLY.test(s || '')) return false;
    const [y, m, d] = s.split('-').map(Number);
    const p = new Date(Date.UTC(y, m - 1, d));
    return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
  };
  function addDays(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  /** Whole Taka with thousands separators. */
  const money = (n) => `৳${Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  /** "2026-10-04" -> "4 Oct 2026"; anything else is a dash. */
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? `${Number(m[3])} ${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : '—';
  }
  const fmtMonth = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
  const pctText = (n) => `${Number.isFinite(n) ? (Math.round(n * 10) / 10) : 0}%`;

  /** The cost period of a preset, as [costFrom, costTo] (empty = open). */
  function periodRange(period, today = todayInDhaka()) {
    if (period === '30' || period === '90' || period === '365') return [addDays(today, -Number(period)), today];
    if (period === 'year') return [`${today.slice(0, 4)}-01-01`, today];
    if (period === 'lastyear') { const y = Number(today.slice(0, 4)) - 1; return [`${y}-01-01`, `${y}-12-31`]; }
    return ['', ''];
  }

  /** The report's query. Empty filters are left out. */
  function buildQuery({ q = '', category = 'all', status = 'all', from = '', to = '', period = 'all', limit = PAGE_SIZE, offset = 0 } = {}, today = todayInDhaka()) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (category && category !== 'all') out.category = category;
    if (status && status !== 'all') out.status = status;
    if (from) out.from = from;
    if (to) out.to = to;
    const [cf, ct] = periodRange(period, today);
    if (cf) out.costFrom = cf;
    if (ct) out.costTo = ct;
    return out;
  }

  /** The five summary cards, from the server's figures. */
  function cards(s, x, periodLabel) {
    const has = Boolean(s);
    return [
      { label: 'Total Asset Value', value: has ? money(s.value) : '—', money: true, sub: has ? (s.unpriced ? `Purchase value · ${s.unpriced} without a price` : 'Purchase value of items in service') : 'Purchase value', icon: 'coins', tone: 'violet' },
      { label: 'Total Assets', value: has ? s.inService : '—', sub: has ? `In service${s.retired ? ` · ${s.retired} retired` : ''}` : 'In service', icon: 'package', tone: 'info' },
      { label: 'Available Assets', value: has ? s.available : '—', sub: has ? `${s.underMaintenance} under maintenance${s.damaged ? ` · ${s.damaged} damaged` : ''}` : 'Ready to use', icon: 'check', tone: 'good' },
      { label: 'Assets In Use', value: has ? s.inUse : '—', sub: has ? `Utilisation ${pctText(s.utilisation)}` : 'Working right now', icon: 'userCheck', tone: 'amber' },
      { label: 'Maintenance Expenses', value: x ? money(x.spent) : '—', money: true, sub: x ? `${periodLabel} · ${money(x.spentRepairs)} repairs` : periodLabel, icon: 'wrench', tone: 'bad' },
    ];
  }

  /** The lines of the Report Summary card -- real figures only, nothing guessed. */
  function summaryLines(s, cats, x, periodLabel) {
    const lines = [
      `${s.inService} ${s.inService === 1 ? 'item' : 'items'} in service across ${cats.filter((c) => c.inService).length} ${cats.filter((c) => c.inService).length === 1 ? 'category' : 'categories'}, bought for ${money(s.value)}${s.unpriced ? ` (${s.unpriced} with no purchase price recorded)` : ''}.`,
      `${s.available} available, ${s.inUse} in use, ${s.underMaintenance} under maintenance${s.damaged ? `, ${s.damaged} damaged` : ''}${s.retired ? `; ${s.retired} retired (${money(s.retiredValue)}, not counted above)` : ''}.`,
      `Utilisation ${pctText(s.utilisation)} — items In Use ÷ items in service (retired items are not counted).`,
      `Maintenance spending (${periodLabel.toLowerCase()}): ${money(x.spent)} — ${money(x.spentMaintenance)} maintenance and ${money(x.spentRepairs)} repairs, the actual cost of ${x.completed} completed ${x.completed === 1 ? 'job' : 'jobs'}${x.completedWithoutCost ? ` (${x.completedWithoutCost} with no cost recorded)` : ''}.`,
      `Not in that total: ${money(x.inProgressEstimate)} estimated for ${x.inProgress} in progress, ${money(x.scheduledEstimate)} for ${x.scheduled} scheduled, and ${money(x.cancelledEstimate)} for ${x.cancelled} cancelled.`,
    ];
    if (s.undated) lines.push(`${s.undated} ${s.undated === 1 ? 'item has' : 'items have'} no purchase date recorded; purchase-date filters leave them out.`);
    return lines;
  }

  /** CSV text; a cell a spreadsheet would read as a formula is prefixed with ' (as Equipment Inventory does). */
  function toCsv(columns, rows) {
    const cell = (value) => {
      let s = value === null || value === undefined ? '' : String(value);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [columns.map(([h]) => cell(h)).join(',')];
    for (const r of rows) lines.push(columns.map(([, get]) => cell(get(r))).join(','));
    return lines.join('\r\n') + '\r\n';
  }
  const ASSET_COLUMNS = [
    ['Equipment', (r) => r.name], ['Asset Code', (r) => r.id], ['Category', (r) => r.category],
    ['Purchase Date', (r) => r.purchaseDate || 'Not recorded'], ['Purchase Cost', (r) => (r.purchasePrice === null ? 'Not recorded' : r.purchasePrice)],
    ['Current Status', (r) => r.status], ['Condition', (r) => r.condition], ['Supplier', (r) => r.supplier],
    ['Maintenance Spent (period)', (r) => r.maintenanceSpent], ['Maintenance Jobs (all time)', (r) => r.maintenanceJobs],
  ];
  const COST_COLUMNS = [
    ['Equipment', (r) => r.toolName], ['Asset Code', (r) => r.toolId], ['Category', (r) => r.category],
    ['Spent (completed, actual)', (r) => r.spent], ['of which Repairs', (r) => r.repairs], ['Completed Jobs', (r) => r.completed],
    ['Open Estimates (in progress + scheduled)', (r) => r.openEstimate], ['All Jobs', (r) => r.jobs],
  ];

  /* ---------- page state ---------- */

  const state = { q: '', category: 'all', status: 'all', from: '', to: '', period: 'all', offset: 0, rows: [], meta: null, error: null, loading: false };
  let seq = 0, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);
  const periodLabel = () => (PERIODS.find(([v]) => v === state.period) || PERIODS[0])[1];

  function shell() {
    const opts = (list) => list.map((o) => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}">${esc(t)}</option>`; }).join('');
    $('adRoot').innerHTML = `
      <div class="ad-top">
        <nav class="ad-crumbs" aria-label="Breadcrumb"><ol>
          <li><a href="../index.html">${icon('home', 16)}<span>Dashboard</span></a></li>
          <li><a href="workshop-tools.html">Workshop Assets</a></li>
          <li aria-current="page">Asset Reports</li>
        </ol></nav>
        <div class="ad-head">
          <span class="ad-head__icon">${icon('chart', 30)}</span>
          <div class="ad-head__text">
            <h2 class="ad-head__title">Asset Reports</h2>
            <p class="page-subtitle">Asset value, availability, utilisation and maintenance spending at a glance.</p>
          </div>
          <div class="ad-head__actions">
            <button type="button" class="btn btn--ghost" id="arPrintBtn" disabled>${icon('printer', 18)}<span>Print / PDF</span></button>
          </div>
        </div>
      </div>
      <section class="ad-stats" id="arStats" aria-label="Summary" aria-live="polite"></section>
      <section class="card ad-card" aria-label="Asset reports">
        <div class="ad-toolbar" role="search">
          <label class="ad-search">${icon('search', 18)}<input type="search" class="input" id="adSearch" autocomplete="off" maxlength="100" placeholder="Search asset or code…" aria-label="Search asset name or code"></label>
          <select class="select ad-select" id="adf-category" aria-label="Filter by category"><option value="all">All Categories</option>${opts(CATEGORIES)}</select>
          <select class="select ad-select" id="adf-status" aria-label="Filter by asset status"><option value="all">All Statuses</option>${opts(STATUSES)}</select>
          <select class="select ad-select" id="adf-date" aria-label="Maintenance cost period">${opts(PERIODS)}</select>
          <label class="ar-date"><span>Bought from</span><input type="date" class="input" id="arFrom" aria-label="Purchased on or after"></label>
          <label class="ar-date"><span>to</span><input type="date" class="input" id="arTo" aria-label="Purchased on or before"></label>
          <button type="button" class="btn btn--ghost ar-clear" id="arClear" hidden>Clear filters</button>
          <span class="ar-exports">
            <button type="button" class="btn btn--ghost ad-export" id="adExport" disabled>${icon('download', 18)}<span>Export CSV</span></button>
            <button type="button" class="btn btn--ghost ad-export" id="arExportCosts" disabled>${icon('download', 18)}<span>Costs CSV</span></button>
          </span>
        </div>
        <div class="ad-view" id="arView" hidden></div>
        <div class="ar-state" id="arState" role="status" aria-live="polite"></div>
      </section>`;
  }

  const filtered = () => Boolean(state.q || state.category !== 'all' || state.status !== 'all' || state.from || state.to || state.period !== 'all');

  function renderCards() {
    const m = state.meta;
    $('arStats').innerHTML = cards(m && m.summary, m && m.expenses, periodLabel()).map((c) => `
      <div class="ad-stat ad-tone--${c.tone}">
        <span class="ad-stat__icon">${icon(c.icon, 22)}</span>
        <div class="ad-stat__body"><div class="ad-stat__label">${esc(c.label)}</div><div class="ad-stat__value${c.money ? ' ad-stat__value--money' : ''}">${esc(c.value)}</div><div class="ad-stat__sub">${esc(c.sub)}</div></div>
      </div>`).join('');
  }

  /* Charts: CSS bars, as before. Items: [label, value, display]. */
  function hbars(items, tone, emptyText) {
    if (!items.length) return `<p class="ar-none">${esc(emptyText)}</p>`;
    const max = Math.max(1, ...items.map((i) => i[1]));
    return `<ul class="ar-hbars ad-tone--${tone}">${items.map(([label, v, shown]) => `
      <li class="ar-hbar"><div class="ar-hbar__head"><span class="ar-hbar__label">${esc(label)}</span><span class="ar-hbar__value">${esc(shown)}</span></div>
      <div class="ar-hbar__track"><div class="ar-hbar__fill" style="width:${Math.round((v / max) * 100)}%"></div></div></li>`).join('')}</ul>`;
  }
  function columnsChart(items) {
    const max = Math.max(1, ...items.map((i) => i[1]));
    return `<div class="ar-cols" role="img" aria-label="${esc(items.map(([l, , s]) => `${l}: ${s}`).join(', '))}">${items.map(([label, v, shown]) => `
      <div class="ar-col" title="${esc(`${label}: ${shown}`)}"><span class="ar-col__value">${esc(shown)}</span>
      <div class="ar-col__wrap"><div class="ar-col__bar" style="height:${v > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0}%"></div></div>
      <span class="ar-col__label">${esc(label)}</span></div>`).join('')}</div>`;
  }
  function split(s) {
    const total = s.inService;
    const parts = [['Available', s.available, 'good'], ['In Use', s.inUse, 'amber'], ['Under Maintenance', s.underMaintenance, 'bad'], ['Damaged', s.damaged, 'neutral']];
    const share = (n) => (total > 0 ? (n / total) * 100 : 0);
    return `<div class="ar-split">
        <div class="ar-split__bar">${parts.map(([l, n, t]) => `<div class="ar-split__seg ad-tone--${t}" style="width:${share(n)}%" title="${esc(`${l}: ${n}`)}"></div>`).join('')}</div>
        <ul class="ar-legend">${parts.map(([l, n, t]) => `<li class="ad-tone--${t}"><span class="ar-legend__dot"></span><span>${esc(`${l}: ${n} (${Math.round(share(n))}%)`)}</span></li>`).join('')}</ul>
        <p class="ar-note">Utilisation ${esc(pctText(s.utilisation))} = In Use ÷ items in service (${esc(total)}). Retired items (${esc(s.retired)}) are not counted.</p>
      </div>`;
  }
  const chartCard = (title, iconName, content, wide = false, extra = '') => `<section class="card ar-chart${wide ? ' ar-chart--wide' : ''}${extra}"><div class="ad-panel__head"><span class="ad-panel__icon">${icon(iconName, 18)}</span><h3>${esc(title)}</h3></div>${content}</section>`;

  function expensesBreakdown(x) {
    const row = (k, v, cls = '') => `<div class="ar-kv${cls}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
    const years = x.yearly.length
      ? `<h4 class="ar-sub">By year (spent)</h4><dl class="ar-kvs">${x.yearly.map((y) => row(y.year, `${money(y.spent)} · ${y.jobs} ${y.jobs === 1 ? 'job' : 'jobs'}`)).join('')}</dl>` : '';
    return `<dl class="ar-kvs">
        ${row('Spent — maintenance (completed, actual cost)', money(x.spentMaintenance))}
        ${row('Spent — repairs (completed, actual cost)', money(x.spentRepairs))}
        ${row('Total spent', money(x.spent), ' ar-kv--total')}
        ${row('Completed jobs', `${x.completed}${x.completedWithoutCost ? ` (${x.completedWithoutCost} with no cost recorded)` : ''}`)}
        ${row('In progress — estimated, not spent yet', `${money(x.inProgressEstimate)} · ${x.inProgress} ${x.inProgress === 1 ? 'job' : 'jobs'}`)}
        ${row('Scheduled — estimated, not spent yet', `${money(x.scheduledEstimate)} · ${x.scheduled} ${x.scheduled === 1 ? 'job' : 'jobs'}`)}
        ${row('Cancelled — estimate, never spent', `${money(x.cancelledEstimate)} · ${x.cancelled} ${x.cancelled === 1 ? 'job' : 'jobs'}`)}
      </dl>${years}
      <p class="ar-note">Spent counts each completed job once, at its actual cost, on the day it was completed. Estimates are shown apart and never added to spent.</p>`;
  }

  function equipmentCosts(list) {
    if (!list.length) return '<p class="ar-none">No maintenance or repair jobs in this period.</p>';
    return `<div class="table-wrap ar-table-wrap"><table class="table ar-table">
        <thead><tr><th>Equipment</th><th>Category</th><th class="ar-num">Spent</th><th class="ar-num">Repairs</th><th class="ar-num">Completed</th><th class="ar-num">Open estimates</th></tr></thead>
        <tbody>${list.slice(0, 10).map((r) => `<tr>
          <td data-label="Equipment"><button type="button" class="ar-link" data-tool="${esc(r.toolId)}">${esc(r.toolName)}</button> <span class="ad-code">${esc(r.toolId)}</span></td>
          <td data-label="Category">${esc(r.category)}</td><td data-label="Spent" class="ar-num">${esc(money(r.spent))}</td><td data-label="Repairs" class="ar-num">${esc(money(r.repairs))}</td>
          <td data-label="Completed" class="ar-num">${esc(r.completed)}</td><td data-label="Open estimates" class="ar-num">${esc(money(r.openEstimate))}</td></tr>`).join('')}</tbody>
      </table></div>${list.length > 10 ? `<p class="ar-note">Top 10 of ${list.length}; Costs CSV has them all.</p>` : ''}`;
  }

  function purchaseTable(rows, total) {
    const badge = (s) => `<span class="badge badge--${STATUS_TONE[s] || 'neutral'} ad-badge">${esc(s)}</span>`;
    const none = '<span class="ar-none">Not recorded</span>';
    const to = state.offset + rows.length;
    return `<div class="table-wrap ar-table-wrap"><table class="table ar-table">
        <thead><tr><th>Equipment</th><th>Asset Code</th><th>Category</th><th>Purchase Date</th><th class="ar-num">Purchase Cost</th><th>Current Status</th><th class="ar-num">Maintenance spent</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td data-label="Equipment"><button type="button" class="ar-link" data-tool="${esc(r.id)}">${esc(r.name)}</button></td>
          <td data-label="Asset Code"><span class="ad-code">${esc(r.id)}</span></td><td data-label="Category">${esc(r.category)}</td>
          <td data-label="Purchase Date">${r.purchaseDate ? esc(fmtDate(r.purchaseDate)) : none}</td>
          <td data-label="Purchase Cost" class="ar-num">${r.purchasePrice === null ? none : esc(money(r.purchasePrice))}</td>
          <td data-label="Current Status">${badge(r.status)}</td><td data-label="Maintenance spent" class="ar-num">${esc(money(r.maintenanceSpent))}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="ad-foot"><span id="adCount">Showing ${esc(state.offset + 1)}–${esc(to)} of ${esc(total)} ${total === 1 ? 'asset' : 'assets'}</span>
        <span class="ar-pager"><button type="button" class="btn btn--ghost btn--sm" id="arPrev"${state.offset <= 0 ? ' disabled' : ''}>Previous</button>
        <button type="button" class="btn btn--ghost btn--sm" id="arNext"${to >= total ? ' disabled' : ''}>Next</button></span></div>`;
  }

  /** Everything below the toolbar. */
  function report(m) {
    const s = m.summary, x = m.expenses, cats = m.categories;
    const live = cats.filter((c) => c.inService);
    return `<div class="ar-grid">
      ${chartCard('Report Summary', 'info', `<ul class="ar-summary__list">${summaryLines(s, cats, x, periodLabel()).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`, true, ' ar-summary')}
      ${chartCard('Asset Category Distribution', 'package', hbars(live.map((c) => [c.category, c.inService, `${c.inService} ${c.inService === 1 ? 'item' : 'items'} · ${pctText(c.share)}`]), 'info', 'No equipment in service matches these filters.'))}
      ${chartCard('Available vs In Use', 'check', split(s))}
      ${chartCard(`Monthly Maintenance Expenses — ${periodLabel()}`, 'coins', columnsChart(x.monthly.map((mm) => [fmtMonth(mm.month), mm.spent, money(mm.spent)])), true)}
      ${chartCard('Asset Purchase Value', 'cart', hbars(live.filter((c) => c.value > 0).map((c) => [c.category, c.value, `${money(c.value)} · ${pctText(c.valueShare)}`]), 'violet', 'No purchase prices recorded for these items.'))}
      ${chartCard('Category Utilisation', 'chart', hbars(live.map((c) => [c.category, c.utilisation, `${pctText(c.utilisation)} · ${c.inUse} of ${c.inService} in use`]), 'amber', 'No equipment in service matches these filters.'))}
      ${chartCard('Maintenance & Repair Expenses', 'wrench', expensesBreakdown(x))}
      ${chartCard('Maintenance Cost by Category', 'coins', hbars(x.byCategory.filter((c) => c.spent > 0).map((c) => [c.category, c.spent, `${money(c.spent)} · ${c.jobs} ${c.jobs === 1 ? 'job' : 'jobs'}`]), 'bad', 'No completed work with a cost in this period.'))}
      ${chartCard('Maintenance Cost by Equipment', 'list', equipmentCosts(x.byEquipment), true)}
      ${chartCard('Asset Purchase Report', 'cart', state.rows.length ? purchaseTable(state.rows, m.total) : '<p class="ar-none">No assets match these filters.</p>', true, ' ar-purchases')}
    </div>`;
  }

  function renderState(kind, opts = {}) {
    const host = $('arState');
    if (kind === 'none') { host.innerHTML = ''; return; }
    if (kind === 'loading') { host.innerHTML = `<div class="ar-skeleton" aria-label="Preparing the reports">${'<span class="ar-skeleton__row"></span>'.repeat(4)}</div>`; return; }
    host.innerHTML = `<div class="empty ad-empty${kind === 'error' ? ' ar-error' : ''}">${icon(kind === 'error' ? 'alert' : 'inbox', 40)}
        <h3>${esc(opts.title)}</h3><p>${esc(opts.text)}</p>
        ${opts.action ? `<button type="button" class="btn btn--ghost btn--sm" data-state-action="${esc(opts.action)}">${esc(opts.actionLabel)}</button>` : ''}</div>`;
  }

  function render() {
    renderCards();
    $('arClear').hidden = !filtered();
    const view = $('arView');
    const ready = Boolean(state.meta) && !state.error;
    for (const id of ['adExport', 'arExportCosts', 'arPrintBtn']) $(id).disabled = !ready;
    if (state.loading && !state.meta) { view.hidden = true; renderState('loading'); return; }
    if (state.error) { view.hidden = true; renderState('error', state.error); return; }
    const m = state.meta;
    if (!m.summary.allItems && !m.expenses.byEquipment.length && !filtered()) {
      view.hidden = true;
      renderState('empty', { title: 'No equipment recorded yet', text: 'Add equipment in Equipment Inventory; its value, availability, utilisation and maintenance costs then appear here. All figures are 0 until then.' });
      return;
    }
    renderState('none');
    view.innerHTML = report(m);
    view.hidden = false;
  }

  function errorFor(res) {
    if (res.code === 'no_api') return { title: 'The workshop database is not connected', text: 'The reports are worked out from the workshop database, which this page cannot reach. Nothing stored in this browser is shown in their place.' };
    // 'offline': the app opened offline; 'network_error': the connection dropped after it opened.
    const offline = res.code === 'offline' || res.code === 'network_error' || (typeof navigator !== 'undefined' && navigator.onLine === false);
    if (offline) return { title: 'You are offline', text: 'The reports are worked out in the workshop database, which needs the internet. No figures are shown from memory.', action: 'retry', actionLabel: 'Try again' };
    if (res.code === 'unauthorized' || res.code === 'locked') return { title: 'Your session has ended', text: 'Sign in again to see the reports.', action: 'reload', actionLabel: 'Sign in again' };
    if (res.code === 'forbidden' || res.status === 403) return { title: 'Your role cannot see the asset reports', text: 'Ask an administrator for the Workshop Assets “view” permission.' };
    return { title: 'The reports could not be prepared', text: 'The workshop database did not answer, so no figures are shown. Try again in a moment.', action: 'retry', actionLabel: 'Retry' };
  }

  async function load() {
    if (Storage.isOffline && Storage.isOffline()) { state.loading = false; state.meta = null; state.error = errorFor({ code: 'offline' }); render(); return false; }
    if (!Storage.isApi()) { state.loading = false; state.meta = null; state.error = errorFor({ code: Storage.isLocked() ? 'locked' : 'no_api' }); render(); return false; }
    const my = ++seq;
    state.loading = true; state.error = null;
    render();
    const res = await Api.get(`/asset-reports?${new URLSearchParams(buildQuery(state)).toString()}`);
    if (my !== seq) return false;
    state.loading = false;
    if (!res.ok) { state.rows = []; state.meta = null; state.error = errorFor(res); render(); return false; }
    const meta = res.meta || {};
    if (!(res.data || []).length && state.offset > 0 && meta.total > 0) { state.offset = 0; return load(); }
    state.rows = Array.isArray(res.data) ? res.data : [];
    state.meta = { ...meta, total: Number(meta.total) || 0 };
    render();
    return true;
  }

  /* ---------- export ---------- */

  function download(text, name) {
    const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Every asset the filters leave (all pages), fetched again so the file matches the database now. */
  async function allAssets() {
    const rows = [];
    for (let guard = 0; guard < 100; guard++) {
      const res = await Api.get(`/asset-reports?${new URLSearchParams(buildQuery({ ...state, limit: 1000, offset: rows.length })).toString()}`);
      if (!res.ok) return { error: res.message || 'The export could not be prepared.' };
      rows.push(...(res.data || []));
      if (!(res.data || []).length || rows.length >= Number(res.meta && res.meta.total)) return { rows, meta: res.meta };
    }
    return { rows };
  }

  async function exportAssets(btn) {
    await Utils.guard(btn, async () => {
      const r = await allAssets();
      if (r.error) { Utils.toast(r.error, 'error'); return; }
      download(toCsv(ASSET_COLUMNS, r.rows), `asset-report-${todayInDhaka()}.csv`);
      Utils.toast(`Exported ${r.rows.length} asset${r.rows.length === 1 ? '' : 's'}.`, 'success');
    });
  }

  async function exportCosts(btn) {
    await Utils.guard(btn, async () => {
      const res = await Api.get(`/asset-reports?${new URLSearchParams(buildQuery({ ...state, limit: 1, offset: 0 })).toString()}`);
      if (!res.ok) { Utils.toast(res.message || 'The export could not be prepared.', 'error'); return; }
      const list = (res.meta && res.meta.expenses && res.meta.expenses.byEquipment) || [];
      download(toCsv(COST_COLUMNS, list), `maintenance-costs-${todayInDhaka()}.csv`);
      Utils.toast(`Exported costs of ${list.length} item${list.length === 1 ? '' : 's'}.`, 'success');
    });
  }

  /** A printable report of the current filters, through the shared print layout. */
  async function printReport(btn) {
    await Utils.guard(btn, async () => {
      const r = await allAssets();
      if (r.error || !r.meta) { Utils.toast(r.error || 'The report could not be prepared.', 'error'); return; }
      const m = r.meta, s = m.summary, x = m.expenses;
      const settings = (Storage.getSettings && Storage.getSettings()) || {};
      const filters = [state.q && `Search: ${state.q}`, state.category !== 'all' && `Category: ${state.category}`, state.status !== 'all' && `Status: ${state.status}`,
        (state.from || state.to) && `Bought ${state.from ? fmtDate(state.from) : '…'} – ${state.to ? fmtDate(state.to) : '…'}`, `Costs: ${periodLabel()}`].filter(Boolean);
      const tr = (cells) => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;
      $('printArea').innerHTML = `
        <div class="pr-head"><div><h1>${esc(settings.businessName || 'Taqwa Automobile Service Center')}</h1>${settings.address ? `<p>${esc(settings.address)}${settings.phone ? ` · ${esc(settings.phone)}` : ''}</p>` : ''}</div>
          <div class="pr-meta"><h2>ASSET REPORT</h2><p>${esc(fmtDate(todayInDhaka()))}</p><p>${esc(filters.join(' · '))}</p></div></div>
        <h3>Summary</h3>${summaryLines(s, m.categories, x, periodLabel()).map((l) => `<p>${esc(l)}</p>`).join('')}
        <h3>Category distribution</h3><table class="pr-table"><thead><tr><th>Category</th><th>In service</th><th>Share</th><th>Value</th><th>In use</th><th>Utilisation</th></tr></thead>
          <tbody>${m.categories.map((c) => tr([c.category, c.inService, pctText(c.share), money(c.value), c.inUse, pctText(c.utilisation)])).join('')}</tbody></table>
        <h3>Maintenance cost by equipment (${esc(periodLabel())})</h3><table class="pr-table"><thead><tr><th>Equipment</th><th>Code</th><th>Spent</th><th>Repairs</th><th>Completed</th><th>Open estimates</th></tr></thead>
          <tbody>${x.byEquipment.map((e) => tr([e.toolName, e.toolId, money(e.spent), money(e.repairs), e.completed, money(e.openEstimate)])).join('') || tr(['No jobs in this period', '', '', '', '', ''])}</tbody></table>
        <h3>Asset purchase report</h3><table class="pr-table"><thead><tr><th>Equipment</th><th>Code</th><th>Category</th><th>Purchase date</th><th>Purchase cost</th><th>Status</th></tr></thead>
          <tbody>${r.rows.map((a) => tr([a.name, a.id, a.category, a.purchaseDate ? fmtDate(a.purchaseDate) : 'Not recorded', a.purchasePrice === null ? 'Not recorded' : money(a.purchasePrice), a.status])).join('') || tr(['No assets match these filters', '', '', '', '', ''])}</tbody></table>`;
      document.body.classList.add('printing-report');
      window.print();
      setTimeout(() => document.body.classList.remove('printing-report'), 300);
    });
  }

  /* ---------- one asset ---------- */

  async function openAsset(toolId) {
    const res = await Api.get(`/asset-reports/${encodeURIComponent(toolId)}`);
    if (!res.ok) { Utils.toast(res.message || 'The asset could not be loaded.', 'error'); return; }
    const { asset: a, jobs, totals, inRegister } = res.data;
    const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v === '' || v === null || v === undefined ? '—' : v}</dd>`;
    const ov = Utils.Modal.open({
      title: `${a.name} — costs`, size: 'lg',
      body: `<div class="ar-asset-modal"><dl class="ad-details">
          ${row('Asset code', `<span class="ad-code">${esc(a.id)}</span>`)}${row('Category', esc(a.category))}
          ${inRegister ? row('Current status', `<span class="badge badge--${STATUS_TONE[a.status] || 'neutral'} ad-badge">${esc(a.status)}</span>`) : row('Register', 'No longer in the register')}
          ${row('Purchase date', a.purchaseDate ? esc(fmtDate(a.purchaseDate)) : 'Not recorded')}${row('Purchase cost', a.purchasePrice === null || a.purchasePrice === undefined ? 'Not recorded' : esc(money(a.purchasePrice)))}
          ${row('Maintenance spent (all time)', esc(money(totals.spent)))}${row('of which repairs', esc(money(totals.repairs)))}
          ${row('Open estimates', esc(money(totals.openEstimate)))}${row('Cancelled estimates (not spent)', esc(money(totals.cancelledEstimate)))}
        </dl>
        ${jobs.length ? `<ul class="ad-mini ar-jobs">${jobs.map((j) => `<li><span class="ad-mini__text"><span class="ad-mini__title">${esc(`${j.id} · ${j.type}`)}</span><span class="ad-mini__sub">${esc(j.status)} · ${esc(j.status === 'Completed' ? `actual ${j.actualCost === null ? 'not recorded' : money(j.actualCost)}` : `estimate ${j.estimatedCost === null ? 'not recorded' : money(j.estimatedCost)}`)}</span></span><span class="ad-mini__side">${esc(fmtDate(j.completedDate || j.scheduledDate))}</span></li>`).join('')}</ul>` : '<p class="ar-none">No maintenance or repair jobs recorded.</p>'}
      </div>`,
      footer: '<button type="button" class="btn btn--ghost" data-modal-close>Close</button>',
    });
    if (ov && ov.classList) ov.classList.add('ar-modal');
  }

  /* ---------- events ---------- */

  function resetFilters() {
    Object.assign(state, { q: '', category: 'all', status: 'all', from: '', to: '', period: 'all', offset: 0 });
    $('adSearch').value = ''; $('adf-category').value = 'all'; $('adf-status').value = 'all'; $('adf-date').value = 'all'; $('arFrom').value = ''; $('arTo').value = '';
    load();
  }

  function bind() {
    $('adSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('adSearch').value.trim(); state.offset = 0; load(); }, 300);
    });
    for (const [id, key] of [['adf-category', 'category'], ['adf-status', 'status'], ['adf-date', 'period'], ['arFrom', 'from'], ['arTo', 'to']]) {
      $(id).addEventListener('change', () => {
        const v = $(id).value;
        if ((key === 'from' || key === 'to') && v && !isRealDate(v)) return;
        state[key] = v; state.offset = 0; load();
      });
    }
    $('arClear').addEventListener('click', resetFilters);
    $('adExport').addEventListener('click', () => exportAssets($('adExport')));
    $('arExportCosts').addEventListener('click', () => exportCosts($('arExportCosts')));
    $('arPrintBtn').addEventListener('click', () => printReport($('arPrintBtn')));
    $('arView').addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-tool]');
      if (t) { openAsset(t.dataset.tool); return; }
      if (ev.target.closest('#arPrev')) { state.offset = Math.max(0, state.offset - PAGE_SIZE); load(); }
      if (ev.target.closest('#arNext')) { state.offset += PAGE_SIZE; load(); }
    });
    $('arState').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-state-action]');
      if (!b) return;
      if (b.dataset.stateAction === 'retry') load();
      else if (b.dataset.stateAction === 'reload') location.reload();
    });
  }

  function init() {
    if (document.body.dataset.page !== 'asset-reports' || !$('adRoot')) return;
    shell();
    bind();
    state.loading = true;
    render();
    Storage.ready(() => load());
  }

  return { CATEGORIES, STATUSES, PERIODS, buildQuery, periodRange, cards, summaryLines, toCsv, ASSET_COLUMNS, COST_COLUMNS, money, fmtDate, fmtMonth, pctText, report, hbars, split, init, _state: state, load };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AssetReports };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) AssetReports.init();
