/* ============================================================
   inbox-whatsapp.js — Social Inbox › WhatsApp (Cloud API)
   ------------------------------------------------------------
   Loaded only by pages/inbox-whatsapp.html. Every conversation and
   message comes from the workshop database through the Worker:

     GET  /api/whatsapp/conversations                the list (left)
     GET  /api/whatsapp/conversations/:id/messages   the thread (centre)
     POST /api/whatsapp/conversations/:id/reply      a reply, sent by the
                                                     Worker through the
                                                     WhatsApp Cloud API
     POST /api/whatsapp/conversations/:id/read       opened -> read
     POST /api/whatsapp/conversations/:id/unread     Mark as unread
     PUT  /api/whatsapp/conversations/:id/status     details (right):
                                                     status, assignment
                                                     to a member of staff,
                                                     notes

   The access token never reaches this page: the Worker holds it. A reply
   shows "Sending…" until the Worker answers, then "Sent" -- and later
   "Delivered" / "Seen" from WhatsApp's status webhook -- or "Not sent"
   with WhatsApp's reason and a Retry. A reply is never shown as sent when
   WhatsApp refused it. Each attempt carries its own clientRequestId, so a
   request the network retries is not delivered twice.

   Staff to assign are read from the roster (Storage.load('staff')).
   New messages arrive through the webhook; this page re-reads the list
   (and the open thread) every POLL_MS while it is visible.

   When the database cannot be read the page says so and offers Retry. It
   never shows sample or browser-stored messages in their place. Everything
   from the data is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const InboxWhatsApp = (() => {

  const POLL_MS = 15000;
  const PAGE_SIZE = 50;
  const MAX_REPLY = 4096;

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  /** Query string parameters for the list. */
  function buildListQuery({ q = '', filter = '', limit = PAGE_SIZE, offset = 0 } = {}) {
    const out = { limit: String(limit), offset: String(offset) };
    if (q.trim()) out.q = q.trim();
    if (filter === 'unread') out.unread = '1';
    else if (filter === 'none') out.assigned = 'none';
    else if (filter) out.status = filter;
    return out;
  }

  /** A fresh id for one send attempt: letters, digits and hyphens, 8-64 long. */
  function newRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  /** "14:05" today, "Yesterday", or "12 Oct" -- in the workshop's zone. */
  function timeLabel(iso, now = new Date()) {
    if (!iso) return '';
    const d = new Date(iso);
    const day = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    if (day(d) === day(now)) return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
    if (day(d) === day(new Date(now.getTime() - 86400000))) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
  }

  function fullTime(iso) {
    return iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  /** What the reply window says for a conversation. */
  function windowText(conv, now = Date.now()) {
    if (!conv || !conv.replyWindowEndsAt) return 'Closed: the customer has not written yet';
    const left = Date.parse(conv.replyWindowEndsAt) - now;
    if (left <= 0) return 'Closed: more than 24 hours since the customer last wrote';
    const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
    return `Open for ${h ? `${h} h ` : ''}${m} min more`;
  }

  /** WhatsApp message types this inbox shows as a label; media are not downloaded here. */
  const TYPE_LABEL = { image: 'Photo', video: 'Video', audio: 'Voice message', document: 'Document', sticker: 'Sticker',
    location: 'Location', contacts: 'Contact', reaction: 'Reaction', button: 'Button', interactive: 'Reply', unsupported: 'Unsupported message' };

  const STATUS_LABEL = { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered', read: 'Seen', failed: 'Not sent', received: '' };

  /** One message bubble. `m.localState` marks a reply this page is still sending. */
  function bubbleHtml(m) {
    const esc = Utils.esc;
    const out = m.direction === 'out';
    const label = m.type && m.type !== 'text' ? (TYPE_LABEL[m.type] || 'Message') : '';
    const atts = (m.attachments || []).map((a) => {
      const label = a.type === 'image' ? 'Photo' : a.type === 'postback' ? `Button: ${a.title || ''}` : a.type ? a.type[0].toUpperCase() + a.type.slice(1) : 'Attachment';
      return a.url
        ? `<a class="wa-att" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(label)} &#8599;</a>`
        : `<span class="wa-att">${esc(label)}</span>`;
    }).join('');
    const who = out ? (m.sentBy || 'Staff') : '';
    const state = out ? `<span class="wa-msg__state wa-msg__state--${esc(m.status)}">${esc(STATUS_LABEL[m.status] || m.status)}</span>` : '';
    const failed = m.status === 'failed'
      ? `<div class="wa-msg__error" role="alert">${esc(m.error || 'WhatsApp did not accept this message.')}
          ${m.retryText || m.senderType === 'staff' ? `<button type="button" class="wa-retry" data-retry="${esc(m.id)}">Retry</button>` : ''}</div>` : '';
    return `<li class="wa-msg wa-msg--${out ? 'out' : 'in'}${m.status === 'failed' ? ' wa-msg--failed' : ''}" data-id="${esc(m.id)}">
        <div class="wa-msg__bubble">${label ? `<span class="wa-att">${esc(label)}</span>` : ''}${m.text ? `<p>${esc(m.text)}</p>` : ''}${atts}</div>
        <div class="wa-msg__meta">${who ? `<span>${esc(who)}</span> · ` : ''}<time datetime="${esc(m.createdAt)}" title="${esc(fullTime(m.createdAt))}">${esc(timeLabel(m.createdAt))}</time>${state ? ` · ${state}` : ''}</div>
        ${failed}
      </li>`;
  }

  function rowHtml(c, selectedId) {
    const esc = Utils.esc;
    const unread = c.unreadCount > 0;
    return `<li><button type="button" class="wa-row${c.id === selectedId ? ' is-active' : ''}${unread ? ' is-unread' : ''}" data-id="${esc(c.id)}"${c.id === selectedId ? ' aria-current="true"' : ''}>
        <span class="wa-avatar" aria-hidden="true">${esc(initials(c.customerName))}</span>
        <span class="wa-row__body">
          <span class="wa-row__top"><span class="wa-row__name">${esc(c.customerName)}</span><time class="wa-row__time">${esc(timeLabel(c.lastMessageAt))}</time></span>
          <span class="wa-row__bottom"><span class="wa-row__preview">${c.lastDirection === 'out' ? 'You: ' : ''}${esc(c.lastMessage)}</span>
            ${unread ? `<span class="wa-badge" aria-label="${c.unreadCount} unread">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : ''}
            ${c.status !== 'Open' ? `<span class="wa-st wa-st--${esc(c.status.toLowerCase())}">${esc(c.status)}</span>` : ''}</span>
        </span>
      </button></li>`;
  }

  /* ---------- page state ---------- */

  const state = {
    q: '', filter: '', offset: 0, conversations: [], total: 0, summary: null, connection: null,
    selectedId: null, selected: null, messages: [], hasMore: false, nextBefore: null,
    pending: [], listError: null, loadingList: false, sending: false,
  };
  let listSeq = 0, threadSeq = 0, pollTimer = null, searchTimer = null;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => Utils.esc(s);

  const stateBox = (title, text, retry) => `<div class="wa-state__box">
      <strong>${esc(title)}</strong><p>${esc(text)}</p>
      ${retry ? `<button type="button" class="btn btn--ghost btn--sm" data-retry-list>${esc(retry)}</button>` : ''}</div>`;

  function failureText(res) {
    if (res.code === 'no_api') return ['The workshop database is not connected', 'WhatsApp conversations are kept only in the workshop database, which this page cannot reach. Nothing stored in this browser is shown in their place.', ''];
    if (res.code === 'unauthorized' || res.code === 'locked') return ['Your session has ended', 'Sign in again to see the inbox.', ''];
    return ['The conversations could not be loaded', 'The workshop database did not answer, so no conversations are shown. Try again in a moment.', 'Retry'];
  }

  /* ---------- the connection chip ---------- */

  function renderConnection() {
    const c = state.connection;
    const chip = $('waConn');
    if (!c) { chip.dataset.state = 'unknown'; $('waConnText').textContent = 'Connection unknown'; return; }
    const live = c.send && c.webhook;
    chip.dataset.state = live ? 'live' : c.webhook ? 'partial' : 'off';
    $('waConnText').textContent = live ? 'Connected to WhatsApp'
      : c.webhook ? 'Receiving only: replies are not set up'
        : 'WhatsApp not connected yet';
  }

  /* ---------- the list ---------- */

  function renderList() {
    const box = $('waListState');
    if (state.loadingList && !state.conversations.length) {
      box.innerHTML = '<div class="wa-skel"><span></span><span></span><span></span><span></span></div>';
      $('waList').hidden = true; return;
    }
    if (state.listError) {
      const [t, x, r] = failureText(state.listError);
      box.innerHTML = stateBox(t, x, r);
      $('waList').hidden = true; $('waListMore').hidden = true; return;
    }
    if (!state.conversations.length) {
      box.innerHTML = state.q || state.filter
        ? stateBox('No conversations match', 'Try a different search or filter.', '')
        : stateBox('No messages yet', state.connection && state.connection.webhook
          ? 'When a customer messages the workshop\'s WhatsApp number, the conversation appears here.'
          : 'WhatsApp is not connected yet. Once the webhook is set up, customer messages appear here.', '');
      $('waList').hidden = true; $('waListMore').hidden = true; return;
    }
    box.innerHTML = '';
    $('waList').innerHTML = state.conversations.map((c) => rowHtml(c, state.selectedId)).join('');
    $('waList').hidden = false;
    $('waListMore').hidden = state.conversations.length >= state.total;
    const unread = state.summary ? state.summary.unreadConversations : 0;
    $('waUnreadTotal').hidden = !unread;
    $('waUnreadTotal').textContent = unread ? `${unread} unread` : '';
  }

  async function loadList({ append = false, quiet = false } = {}) {
    if (!Storage.isApi()) {
      state.listError = { code: Storage.isLocked() ? 'locked' : 'no_api' };
      state.loadingList = false;
      renderList(); return false;
    }
    const seq = ++listSeq;
    const offset = append ? state.conversations.length : 0;
    // A quiet refresh re-reads everything shown so far, so polling never shrinks the list.
    const limit = quiet ? Math.max(PAGE_SIZE, state.conversations.length) : PAGE_SIZE;
    if (!quiet) { state.loadingList = true; if (!append) renderList(); }
    const qs = new URLSearchParams(buildListQuery({ q: state.q, filter: state.filter, limit, offset })).toString();
    const res = await Api.get(`/whatsapp/conversations?${qs}`);
    if (seq !== listSeq) return false;
    state.loadingList = false;
    if (!res.ok) {
      if (quiet) return false;                 // a failed background refresh keeps what is shown
      state.listError = res; state.conversations = [];
      renderList(); return false;
    }
    state.listError = null;
    const rows = Array.isArray(res.data) ? res.data : [];
    state.conversations = append ? [...state.conversations, ...rows] : rows;
    state.total = res.meta.total || 0;
    state.summary = res.meta.summary || null;
    state.connection = res.meta.connection || null;
    renderConnection();
    renderList();
    if (state.selectedId) {
      const fresh = state.conversations.find((c) => c.id === state.selectedId);
      if (fresh) { state.selected = fresh; renderChatHead(); renderWindow(); }
    }
    return true;
  }

  /* ---------- the thread ---------- */

  function renderChatHead() {
    const c = state.selected;
    if (!c) return;
    $('waChatAvatar').textContent = initials(c.customerName);
    $('waChatName').textContent = c.customerName;
    $('waChatMeta').textContent = `${c.customerPhone} · ${c.status}${c.assignedToName ? ` · ${c.assignedToName}` : ''}`;
  }

  function renderWindow() {
    const c = state.selected;
    const box = $('waWindow');
    const canSend = Boolean(c && c.canReply && state.connection && state.connection.send);
    $('waReply').disabled = !canSend;
    $('waSend').disabled = !canSend || state.sending;
    if (!c) { box.hidden = true; return; }
    if (!(state.connection && state.connection.send)) {
      box.hidden = false; box.textContent = 'Replies are not set up yet: the WhatsApp access token or phone number ID has not been configured.';
    } else if (!c.canReply) {
      box.hidden = false; box.textContent = 'This customer last wrote more than 24 hours ago. WhatsApp only allows a free-form reply within 24 hours of their last message, so replying is closed until they write again.';
    } else box.hidden = true;
  }

  function renderThread({ keepScroll = false } = {}) {
    const wrap = $('waThreadWrap');
    const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80;
    // A placeholder whose attempt the server has saved is shown once: as the server's row.
    const saved = new Set(state.messages.map((m) => m.clientRequestId).filter(Boolean));
    state.pending = state.pending.filter((p) => !saved.has(p.requestId));
    const all = [...state.messages, ...state.pending];
    $('waThread').innerHTML = all.map(bubbleHtml).join('');
    $('waOlder').hidden = !state.hasMore;
    $('waThreadState').innerHTML = !all.length ? stateBox('No messages in this conversation yet', '', '') : '';
    if (!keepScroll || nearBottom) wrap.scrollTop = wrap.scrollHeight;
  }

  function renderDetails() {
    const c = state.selected;
    $('waDetailsEmpty').hidden = Boolean(c);
    $('waDetailsBody').hidden = !c;
    if (!c) return;
    $('wadName').textContent = c.nameKnown ? c.customerName : 'No WhatsApp profile name';
    $('wadPhone').textContent = c.customerPhone;
    $('wadPhone').href = `tel:${c.customerPhone}`;
    $('wadId').textContent = c.id;
    $('wadCreated').textContent = fullTime(c.createdAt);
    $('wadWindow').textContent = windowText(c);
    $('wadStatus').value = c.status;
    renderStaffOptions(c.assignedToId);
    $('wadAssigned').value = c.assignedToId;
    $('wadNotes').value = c.notes;
    $('waDetailsForm').querySelector('[data-err="details"]').textContent = '';
  }

  async function loadThread({ older = false, quiet = false } = {}) {
    const id = state.selectedId;
    if (!id) return false;
    const seq = ++threadSeq;
    if (!quiet && !older) { $('waThreadState').innerHTML = '<div class="wa-skel wa-skel--thread"><span></span><span></span><span></span></div>'; $('waThread').innerHTML = ''; }
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE), ...(older && state.nextBefore ? { before: String(state.nextBefore) } : {}) }).toString();
    const res = await Api.get(`/whatsapp/conversations/${encodeURIComponent(id)}/messages?${qs}`);
    if (seq !== threadSeq || id !== state.selectedId) return false;
    if (!res.ok) {
      if (!quiet) $('waThreadState').innerHTML = `<div class="wa-state__box"><strong>The messages could not be loaded</strong><p>${esc(res.message || '')}</p><button type="button" class="btn btn--ghost btn--sm" data-retry-thread>Retry</button></div>`;
      return false;
    }
    const rows = Array.isArray(res.data) ? res.data : [];
    if (older) {
      state.messages = [...rows, ...state.messages];
    } else if (quiet && state.messages.length) {
      // Keep any earlier pages already loaded; replace the newest page.
      const firstNew = rows.length ? rows[0].id : Infinity;
      state.messages = [...state.messages.filter((m) => m.id < firstNew), ...rows];
    } else state.messages = rows;
    if (!quiet || older) { state.hasMore = res.meta.hasMore; state.nextBefore = res.meta.nextBefore; }
    renderThread({ keepScroll: quiet || older });
    return true;
  }

  async function select(id) {
    if (!id) return;
    state.selectedId = id;
    state.selected = state.conversations.find((c) => c.id === id) || null;
    state.messages = []; state.pending = []; state.hasMore = false; state.nextBefore = null;
    $('waInbox').classList.add('is-chat-open');
    $('waChatEmpty').hidden = true;
    $('waChat').hidden = false;
    try { history.replaceState(null, '', `?c=${encodeURIComponent(id)}`); } catch { /* not in a browser */ }
    if (!state.selected) {
      const one = await Api.get(`/whatsapp/conversations/${encodeURIComponent(id)}`);
      if (!one.ok) { Utils.toast(one.message || 'That conversation could not be opened.', 'error'); return; }
      state.selected = one.data;
    }
    renderChatHead(); renderWindow(); renderDetails(); renderList();
    await loadThread();
    if (state.selected && state.selected.unreadCount > 0) {
      const r = await Api.post(`/whatsapp/conversations/${encodeURIComponent(id)}/read`, {});
      if (r.ok) {
        state.selected = r.data;
        const row = state.conversations.find((c) => c.id === id);
        if (row) row.unreadCount = 0;
        if (state.summary && state.summary.unreadConversations) state.summary.unreadConversations -= 1;
        renderList();
      }
    }
  }

  /* ---------- sending ---------- */

  async function send(text, retryOf = null) {
    const id = state.selectedId;
    const body = String(text || '').trim();
    if (!id || !body) return;
    if (body.length > MAX_REPLY) { Utils.toast(`A WhatsApp message can be at most ${MAX_REPLY} characters.`, 'error'); return; }
    const requestId = newRequestId();
    const local = { id: `local-${Date.now()}`, requestId, direction: 'out', senderType: 'staff', sentBy: Storage.account ? Storage.account.username : '',
      text: body, attachments: [], status: 'sending', createdAt: new Date().toISOString(), localState: true };
    if (retryOf) state.pending = state.pending.filter((p) => p.id !== retryOf);
    state.pending.push(local);
    state.sending = true;
    renderThread(); renderWindow();
    const res = await Api.post(`/whatsapp/conversations/${encodeURIComponent(id)}/reply`, { text: body, clientRequestId: requestId });
    state.sending = false;
    if (id !== state.selectedId) return;
    if (!res.ok) {
      // Not sent: until the server's own copy (saved as failed) replaces it, the
      // placeholder says so, with the reason and a Retry. The text is kept.
      local.status = 'failed';
      local.error = res.message || 'The message was not sent.';
      local.retryText = body;
      if (res.errorReason === 'outside_messaging_window' && state.selected) state.selected.canReply = false;
      Utils.toast(local.error, 'error');
    }
    // Whatever happened, the server's history is the truth: re-read it. A saved
    // attempt replaces its placeholder; one that never reached the server stays.
    await loadThread({ quiet: true });
    if (res.ok) await loadList({ quiet: true });
    renderWindow();
  }

  /* ---------- staff for assignment ---------- */

  let staffList = [];

  /** Active staff from the roster, sorted by name. Loaded once; a failure leaves only "Not assigned". */
  async function loadStaff() {
    const res = await Storage.load('staff');
    if (!res.ok) return false;
    staffList = Storage.getData('staff')
      .filter((p) => p && p.status === 'Active')
      .map((p) => ({ id: p.id, name: p.name || p.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (state.selected) renderDetails();
    return true;
  }

  /** The Assign options: everyone active, plus whoever is assigned now even if no longer active. */
  function renderStaffOptions(currentId) {
    const opts = [...staffList];
    if (currentId && !opts.some((p) => p.id === currentId)) {
      opts.unshift({ id: currentId, name: (state.selected && state.selected.assignedToName) || currentId });
    }
    $('wadAssigned').innerHTML = '<option value="">Not assigned</option>'
      + opts.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.id)})</option>`).join('');
  }

  async function markUnread(btn) {
    const c = state.selected;
    if (!c) return;
    await Utils.guard(btn, async () => {
      const res = await Api.post(`/whatsapp/conversations/${encodeURIComponent(c.id)}/unread`, {});
      if (!res.ok) { Utils.toast(res.message || 'The conversation could not be marked as unread.', 'error'); return; }
      const i = state.conversations.findIndex((x) => x.id === c.id);
      if (i !== -1) state.conversations[i] = res.data;
      state.selected = res.data;
      renderList();
      Utils.toast('Marked as unread.', 'success');
    });
  }

  /* ---------- details ---------- */

  async function saveDetails(btn) {
    const c = state.selected;
    if (!c) return;
    await Utils.guard(btn, async () => {
      const body = { status: $('wadStatus').value, assignedToId: $('wadAssigned').value || null, notes: $('wadNotes').value.trim() };
      const res = await Api.put(`/whatsapp/conversations/${encodeURIComponent(c.id)}/status`, body);
      if (!res.ok) {
        const msg = res.fields ? Object.values(res.fields)[0] : (res.message || 'The details could not be saved.');
        $('waDetailsForm').querySelector('[data-err="details"]').textContent = msg;
        Utils.toast(msg, 'error'); return;
      }
      state.selected = res.data;
      const i = state.conversations.findIndex((x) => x.id === c.id);
      if (i !== -1) state.conversations[i] = res.data;
      renderChatHead(); renderDetails(); renderList();
      Utils.toast('Conversation details saved.', 'success');
    });
  }

  /* ---------- polling ---------- */

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (state.sending || !Storage.isApi()) return;
      loadList({ quiet: true });
      if (state.selectedId) loadThread({ quiet: true });
    }, POLL_MS);
  }

  /* ---------- events ---------- */

  function bind() {
    $('waSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = $('waSearch').value; loadList(); }, 300);
    });
    $('waStatus').addEventListener('change', () => { state.filter = $('waStatus').value; loadList(); });
    $('waList').addEventListener('click', (ev) => { const b = ev.target.closest('[data-id]'); if (b) select(b.dataset.id); });
    $('waListMore').addEventListener('click', () => loadList({ append: true }));
    $('waListState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry-list]')) loadList(); });
    $('waThreadState').addEventListener('click', (ev) => { if (ev.target.closest('[data-retry-thread]')) loadThread(); });
    $('waOlder').addEventListener('click', () => loadThread({ older: true }));
    $('waThread').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-retry]');
      if (!b) return;
      // A retry is a new attempt with its own request id; the failed one stays in the history.
      const p = state.pending.find((x) => String(x.id) === b.dataset.retry);
      if (p) { send(p.retryText || p.text, p.id); return; }
      const m = state.messages.find((x) => String(x.id) === b.dataset.retry);
      if (m && m.text) send(m.text);
    });
    $('waReply').addEventListener('input', () => { $('waReplyCount').textContent = `${$('waReply').value.length} / ${MAX_REPLY}`; });
    $('waReply').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); $('waComposer').requestSubmit(); }
    });
    $('waComposer').addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (state.sending) return;
      const text = $('waReply').value;
      if (!text.trim()) return;
      $('waReply').value = ''; $('waReplyCount').textContent = `0 / ${MAX_REPLY}`;
      send(text);
    });
    $('waBack').addEventListener('click', () => { $('waInbox').classList.remove('is-chat-open', 'is-details-open'); });
    $('waInfoBtn').addEventListener('click', () => {
      const open = $('waInbox').classList.toggle('is-details-open');
      $('waInfoBtn').setAttribute('aria-expanded', String(open));
    });
    $('waDetailsForm').addEventListener('submit', (ev) => { ev.preventDefault(); saveDetails($('wadSave')); });
    $('wadUnread').addEventListener('click', (ev) => markUnread(ev.currentTarget));
  }

  async function init() {
    if (document.body.dataset.page !== 'inbox-whatsapp') return;
    bind();
    state.loadingList = true;
    renderList();
    Storage.ready(async () => {
      const loaded = await loadList();
      const wanted = new URLSearchParams(location.search || '').get('c');
      if (loaded && wanted && /^WAC-\d+$/.test(wanted)) select(wanted);
      if (loaded) { startPolling(); loadStaff(); }
    });
  }

  return { buildListQuery, newRequestId, initials, timeLabel, windowText, bubbleHtml, rowHtml, init, _state: state, loadList, select, send };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxWhatsApp };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxWhatsApp.init();
