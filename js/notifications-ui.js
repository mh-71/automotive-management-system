/* ============================================================
   notifications-ui.js — Notifications Center
   ------------------------------------------------------------
   Loaded only by pages/notifications.html. Everything shown comes
   from the workshop database through the Worker:

     GET  /api/notifications                list (status, category, q, paging)
     GET  /api/notifications/unread-count   polled every 30 s while visible
     POST /api/notifications/:id/read       / :id/unread
     POST /api/notifications/read-all       up to the newest one shown

   Notifications are raised on the server by real workshop events
   (src/lib/notifications.js); this page never makes one up and keeps
   nothing in browser storage. Read state belongs to the signed-in
   user. All content is built with textContent -- nothing from the
   data is parsed as HTML.
   ============================================================ */

const NotificationsUI = (() => {

  const PAGE = 25;
  const POLL_MS = 30000;

  const ICONS = {
    enquiry:  'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z',
    people:   'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z',
    wrench:   'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z',
    card:     'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    box:      'M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z',
    clock:    'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
    badge:    'M20 7h-5V4c0-1.1-.9-2-2-2h-2c-1.1 0-2 .9-2 2v3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zM9 12c.83 0 1.5.67 1.5 1.5S9.83 15 9 15s-1.5-.67-1.5-1.5S8.17 12 9 12zm3 6H6v-.75c0-1 2-1.5 3-1.5s3 .5 3 1.5V18zm1-9h-2V4h2v5zm5 7.5h-4V15h4v1.5zm0-3h-4V12h4v1.5z',
  };

  /** Each category: its label on the page, its icon and its colour tone. */
  const CATEGORIES = {
    'Enquiry':     { label: 'Enquiry',     icon: 'enquiry',  tone: 'enquiry' },
    'Customer':    { label: 'Customer',    icon: 'people',   tone: 'customer' },
    'Appointment': { label: 'Appointment', icon: 'calendar', tone: 'appointment' },
    'Workshop':    { label: 'Job card',    icon: 'wrench',   tone: 'workshop' },
    'Finance':     { label: 'Finance',     icon: 'card',     tone: 'finance' },
    'Inventory':   { label: 'Stock',       icon: 'box',      tone: 'inventory' },
    'Follow-up':   { label: 'Follow-up',   icon: 'clock',    tone: 'followup' },
    'Staff':       { label: 'Staff',       icon: 'badge',    tone: 'staff' },
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  /** Where "Open" goes for a record, relative to the site root; null when there is nowhere to go. */
  function recordHref(type, id) {
    if (!type || !id) return null;
    const v = encodeURIComponent(id);
    switch (type) {
      case 'customer':       return `pages/customers.html?view=${v}`;
      case 'vehicle':        return `pages/vehicles.html?view=${v}`;
      case 'appointment':    return `pages/appointments.html?view=${v}`;
      case 'job_card':       return `pages/job-cards.html?view=${v}`;
      case 'estimate':       return `pages/estimate-details.html?id=${v}`;
      case 'invoice':        return `pages/invoices.html?view=${v}`;
      case 'payment':        return `pages/payments.html?view=${v}`;
      case 'part':           return `pages/inventory.html?view=${v}`;
      // These pages have no address for one record: open the list it is in.
      case 'follow_up':      return 'pages/crm-follow-up.html';
      case 'follow_up_task': return 'pages/crm-tasks.html';
      case 'leave_request':  return 'pages/staff-leave.html';
      case 'website_form':   return 'pages/inbox-website-forms.html';
      default:               return null;
    }
  }

  /** "Just now", "5 min ago", "3 h ago", "Yesterday", then a date -- in the workshop's time zone. */
  function relativeTime(iso, now = Date.now()) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'Just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const day = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d);
    const yesterday = day(new Date(now - 86400000));
    if (day(new Date(t)) === yesterday) return 'Yesterday';
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(t));
  }

  /** The full date and time, for the tooltip and screen readers. */
  function fullTime(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(t));
  }

  /** The query string for a list request. */
  function listQuery({ status = 'all', category = '', q = '', offset = 0, limit = PAGE, refresh = false } = {}) {
    const p = new URLSearchParams();
    if (status && status !== 'all') p.set('status', status);
    if (category) p.set('category', category);
    const text = String(q || '').trim();
    if (text) p.set('q', text.slice(0, 100));
    p.set('limit', String(limit));
    if (offset) p.set('offset', String(offset));
    if (refresh) p.set('refresh', '1');
    return p.toString();
  }

  /** Plain words for a failed request. */
  function errorText(res) {
    const code = res && res.code;
    if (code === 'locked' || code === 'unauthorized') return { title: 'Your session has ended', text: 'Sign in again to see your notifications.', signIn: true };
    if (code === 'no_api') return { title: 'Notifications need the workshop database', text: 'This page shows real workshop events, so it only works when the app is connected to the workshop server.' };
    if (code === 'network_error' || code === 'timeout') return { title: 'Could not reach the workshop server', text: 'Check the connection and try again.' };
    return { title: 'Notifications could not be loaded', text: (res && res.message) || 'Please try again in a moment.' };
  }

  /* ---------- state ---------- */

  const state = {
    status: 'all', category: '', q: '',
    items: [], total: 0, summary: null,
    loading: false, error: null, busy: new Set(),
    latestId: 0, pendingNew: 0, updatedAt: null, requestSeq: 0,
  };
  let pollTimer = null;
  let searchTimer = null;
  const $ = id => document.getElementById(id);
  const root = () => (document.body && document.body.dataset.root) || '';

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svgIcon(name, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.clock);
    svg.appendChild(path);
    return svg;
  }

  /** Tell the sidebar badge (js/app.js) the new unread count at once, rather than at its next poll. */
  function announce(summary) {
    if (!summary || typeof document === 'undefined' || typeof CustomEvent !== 'function') return;
    document.dispatchEvent(new CustomEvent('taqwa:notifications-unread', { detail: { unread: summary.unread } }));
  }

  /* ---------- rendering ---------- */

  function itemNode(n) {
    const cat = CATEGORIES[n.category] || { label: n.category, icon: 'clock', tone: 'system' };
    const important = n.priority === 'important';
    const li = el('li', `ntf-item${n.read ? '' : ' is-unread'}${important ? ' is-important' : ''}`);
    li.dataset.id = String(n.id);

    const icon = el('span', `ntf-item__icon ntf-tone--${important && !n.read ? 'important' : cat.tone}`);
    icon.appendChild(svgIcon(cat.icon, 22));
    li.appendChild(icon);

    const body = el('div', 'ntf-item__body');
    const top = el('div', 'ntf-item__top');
    top.appendChild(el('h3', 'ntf-item__title', n.title));
    if (important) top.appendChild(el('span', 'badge badge--bad', 'Important'));
    if (n.personal) top.appendChild(el('span', 'badge badge--neutral', 'For you'));
    body.appendChild(top);
    body.appendChild(el('p', 'ntf-item__text', n.message));
    const meta = el('p', 'ntf-item__meta');
    meta.appendChild(svgIcon('clock', 14));
    const time = el('time', null, relativeTime(n.createdAt));
    time.dateTime = n.createdAt;
    time.title = fullTime(n.createdAt);
    meta.appendChild(time);
    meta.appendChild(el('span', 'ntf-item__sep', '·'));
    meta.appendChild(el('span', null, cat.label));
    if (n.recordId) { meta.appendChild(el('span', 'ntf-item__sep', '·')); meta.appendChild(el('span', null, n.recordId)); }
    if (n.actorName) { meta.appendChild(el('span', 'ntf-item__sep', '·')); meta.appendChild(el('span', null, `by ${n.actorName}`)); }
    body.appendChild(meta);
    li.appendChild(body);

    const side = el('div', 'ntf-item__side');
    if (!n.read) {
      const dot = el('span', 'ntf-dot');
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Unread');
      side.appendChild(dot);
    }
    const href = recordHref(n.recordType, n.recordId);
    if (href) {
      const open = el('a', 'btn btn--ghost btn--sm ntf-open', 'Open');
      open.href = root() + href;
      open.dataset.open = String(n.id);
      open.setAttribute('aria-label', `Open ${n.recordId || 'the record'}`);
      side.appendChild(open);
    }
    const toggle = el('button', 'btn btn--ghost btn--sm ntf-read', n.read ? 'Mark unread' : 'Mark as read');
    toggle.type = 'button';
    toggle.dataset.toggle = String(n.id);
    toggle.disabled = state.busy.has(n.id);
    side.appendChild(toggle);
    li.appendChild(side);
    return li;
  }

  function filtered() {
    return state.status !== 'all' || !!state.category || !!state.q.trim();
  }

  function drawStats() {
    const s = state.summary;
    $('ntfTotal').textContent = s ? String(s.total) : '–';
    $('ntfUnread').textContent = s ? String(s.unread) : '–';
    $('ntfImportant').textContent = s ? String(s.important) : '–';
    $('ntfReadAll').disabled = !s || s.unread === 0 || state.loading || state.busy.has('all');
  }

  function draw() {
    const card = $('ntfCard');
    const loadingFirst = state.loading && !state.items.length;
    card.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    $('ntfLoading').hidden = !loadingFirst || !!state.error;

    const err = state.error;
    $('ntfError').hidden = !err;
    if (err) {
      const words = errorText(err);
      $('ntfErrorTitle').textContent = words.title;
      $('ntfErrorText').textContent = words.text;
      const retry = $('ntfRetry');
      retry.textContent = words.signIn ? 'Sign in again' : 'Try again';
      retry.dataset.signIn = words.signIn ? '1' : '';
    }

    const list = $('ntfList');
    list.replaceChildren(...state.items.map(itemNode));
    list.hidden = !state.items.length || !!err;

    const empty = !loadingFirst && !err && !state.items.length;
    $('ntfEmpty').hidden = !empty;
    if (empty) {
      $('ntfEmptyTitle').textContent = filtered() ? 'No notifications match' : 'No notifications yet';
      $('ntfEmptyText').textContent = filtered()
        ? 'Try another filter or search.'
        : 'New enquiries, appointments, job cards, payments and other workshop events will appear here.';
      $('ntfClear').hidden = !filtered();
    }

    const shown = state.items.length;
    $('ntfCount').textContent = err || loadingFirst ? '' : shown
      ? `Showing ${shown} of ${state.total} notification${state.total === 1 ? '' : 's'}`
      : '';
    const more = $('ntfMore');
    more.hidden = !!err || shown >= state.total;
    more.disabled = state.loading;
    more.textContent = state.loading && shown ? 'Loading…' : 'Load more';

    const banner = $('ntfNew');
    banner.hidden = !state.pendingNew;
    if (state.pendingNew) banner.textContent = `${state.pendingNew === 1 ? 'A new notification' : 'New notifications'} — show`;

    $('ntfUpdated').textContent = state.updatedAt ? `Updated ${fullTime(state.updatedAt)}. New events appear automatically.` : '';

    document.querySelectorAll('.ntf-filter').forEach(b => {
      const on = b.dataset.status === state.status;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    drawStats();
  }

  /* ---------- data ---------- */

  function takeSummary(summary) {
    if (!summary) return;
    state.summary = summary;
    state.latestId = Math.max(state.latestId, Number(summary.latestId) || 0);
    announce(summary);
  }

  /**
   * Load the first page (or, with append, the next one). A quiet load keeps
   * what is on screen until the answer arrives; an older answer that comes
   * back after a newer request was made is dropped.
   */
  async function load({ append = false, quiet = false, refresh = false } = {}) {
    if (typeof Storage !== 'undefined' && !Storage.isApi()) {
      state.error = { code: Storage.isLocked && Storage.isLocked() ? 'locked' : 'no_api' };
      state.loading = false;
      draw();
      return;
    }
    const seq = ++state.requestSeq;
    state.loading = true;
    if (!quiet) state.error = null;
    if (!append && !quiet) state.items = [];
    draw();
    const res = await Api.get(`/notifications?${listQuery({
      status: state.status, category: state.category, q: state.q,
      offset: append ? state.items.length : 0, refresh,
    })}`);
    if (seq !== state.requestSeq) return;
    state.loading = false;
    if (!res.ok) {
      if (!quiet || !state.items.length) state.error = res;
      else Utils.toast('Could not refresh notifications. Showing the last loaded list.', 'error');
      draw();
      return;
    }
    state.error = null;
    const rows = Array.isArray(res.data) ? res.data : [];
    state.items = append ? state.items.concat(rows.filter(r => !state.items.some(x => x.id === r.id))) : rows;
    state.total = Number(res.meta && res.meta.total) || 0;
    takeSummary(res.meta && res.meta.summary);
    state.pendingNew = 0;
    state.updatedAt = new Date().toISOString();
    draw();
  }

  /** Poll the count; when something new has arrived, bring the list up to date without a reload. */
  async function poll() {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (state.loading || state.busy.size || !Storage.isApi()) return;
    const res = await Api.get('/notifications/unread-count');
    if (!res.ok || !res.data) return;
    const before = state.latestId;
    const latest = Number(res.data.latestId) || 0;
    state.summary = res.data;
    announce(res.data);
    if (latest > before) {
      state.latestId = latest;
      // Only the first page is on screen: replace it. Further pages are loaded:
      // offer the new ones instead of collapsing what the user scrolled to.
      if (state.items.length <= PAGE) await load({ quiet: true });
      else { state.pendingNew += latest - before; draw(); }
    } else {
      drawStats();
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { poll().catch(() => {}); }, POLL_MS);
  }

  async function setRead(id, read) {
    const item = state.items.find(n => n.id === id);
    if (!item || state.busy.has(id)) return;
    state.busy.add(id);
    draw();
    const res = await Api.post(`/notifications/${encodeURIComponent(id)}/${read ? 'read' : 'unread'}`, {});
    state.busy.delete(id);
    if (!res.ok) {
      Utils.toast(res.code === 'not_found' ? 'That notification is no longer available.' : 'Could not update the notification. Please try again.', 'error');
      draw();
      return;
    }
    Object.assign(item, res.data);
    // A row that no longer matches the Unread / Read filter leaves the list.
    if ((state.status === 'unread' && item.read) || (state.status === 'read' && !item.read)) {
      state.items = state.items.filter(n => n.id !== id);
      state.total = Math.max(0, state.total - 1);
    }
    takeSummary(res.meta && res.meta.summary);
    draw();
  }

  async function readAll() {
    if (state.busy.has('all') || !state.summary || !state.summary.unread) return;
    state.busy.add('all');
    drawStats();
    // Only up to the newest notification the page knows about: one that
    // arrives meanwhile stays unread rather than being marked unseen.
    const res = await Api.post('/notifications/read-all', state.latestId ? { upToId: state.latestId } : {});
    state.busy.delete('all');
    if (!res.ok) {
      Utils.toast('Could not mark the notifications as read. Please try again.', 'error');
      drawStats();
      return;
    }
    Utils.toast(res.data && res.data.marked === 1 ? '1 notification marked as read.' : `${(res.data && res.data.marked) || 0} notifications marked as read.`, 'success');
    takeSummary(res.meta && res.meta.summary);
    await load({ quiet: true });
  }

  /* ---------- events ---------- */

  function bind() {
    document.querySelector('.ntf-filters').addEventListener('click', e => {
      const b = e.target.closest('.ntf-filter');
      if (!b || b.dataset.status === state.status) return;
      state.status = b.dataset.status;
      load();
    });
    $('ntfCategory').addEventListener('change', e => { state.category = e.target.value; load(); });
    $('ntfSearch').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = e.target.value; load(); }, 300);
    });
    $('ntfClear').addEventListener('click', () => {
      state.status = 'all'; state.category = ''; state.q = '';
      $('ntfSearch').value = ''; $('ntfCategory').value = '';
      load();
    });
    $('ntfRefresh').addEventListener('click', () => load({ quiet: !!state.items.length, refresh: true }));
    $('ntfRetry').addEventListener('click', e => {
      if (e.currentTarget.dataset.signIn) { location.reload(); return; }
      load({ refresh: true });
    });
    $('ntfMore').addEventListener('click', () => load({ append: true, quiet: true }));
    $('ntfNew').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      load({ quiet: true });
    });
    $('ntfReadAll').addEventListener('click', () => { readAll(); });
    $('ntfList').addEventListener('click', e => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const item = state.items.find(n => String(n.id) === toggle.dataset.toggle);
        if (item) setRead(item.id, !item.read);
        return;
      }
      const open = e.target.closest('[data-open]');
      if (open) {
        const item = state.items.find(n => String(n.id) === open.dataset.open);
        if (!item || item.read || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
        // Opening it counts as reading it: mark it first, then follow the link.
        e.preventDefault();
        const href = open.href;
        Api.post(`/notifications/${encodeURIComponent(item.id)}/read`, {})
          .catch(() => {})
          .then(() => { location.href = href; });
      }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll().catch(() => {}); });
  }

  function init() {
    if (document.body.dataset.page !== 'notifications') return;
    bind();
    draw();
    if (typeof Storage === 'undefined' || !Storage.ready) return;
    Storage.ready(() => {
      load({ refresh: true });
      startPolling();
    });
  }

  return { CATEGORIES, PAGE, POLL_MS, recordHref, relativeTime, fullTime, listQuery, errorText, state, init };
})();

// The page's markup is already parsed (this script is at the end of <body>),
// so it is wired up now; the data follows once Storage is ready.
if (typeof document !== 'undefined' && document.body && document.body.dataset) NotificationsUI.init();
