/* inbox-facebook — Social Inbox › Facebook Messenger, connected to the database.

   What must hold:
     1. In the sidebar, Facebook is a link to its page, labelled Messenger
        (no longer Demo), active only on that page.
     2. The Social Inbox still holds exactly All Conversations, Facebook,
        WhatsApp and Website Forms.
     3. The page is not a demo: no sample data, no DEMO banner; its script
        talks only to the Worker (Api), never to Facebook, holds no token,
        and touches no browser storage.
     4. Helpers: list query, request ids, escaped bubbles (attachments only
        as https links), the reply window text.
     5. In 'api' mode: the list loads and is escaped; opening a conversation
        reads its thread and marks it read; a reply shows Sending, then Sent;
        a refused reply shows Not sent with a Retry and is never shown as
        sent; outside the window the composer is closed; details save.
     6. Failures: a failed list read shows Retry, never demo data; no backend
        says so and never asks for /api/messenger.

   Drives the REAL js/app.js and js/inbox-facebook.js through the harness. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

function shellFor(page, root = '') {
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: () => null, setItem: () => {} };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const inboxGroup = html => (html.match(/<details class="nav__inbox"[\s\S]*?<\/details>/) || [''])[0];
// One sidebar entry per piece: each starts at its own <a|span class="nav__sub ...">.
const subFor = (group, label) => group.split(/(?=<(?:a|span) class="nav__sub[ "])/).find(p => p.includes(`<span>${label}</span>`)) || '';

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const conv = (id, extra = {}) => ({ id, platform: 'Facebook', customerPsid: `9000${id.slice(-2)}`, customerName: 'Customer', nameKnown: true,
  status: 'Open', unreadCount: 0, lastMessage: 'Hello', lastMessageAt: iso(60000), lastDirection: 'in', lastInboundAt: iso(60000),
  canReply: true, replyWindowEndsAt: new Date(NOW + 23 * 3600000).toISOString(), assignedTo: '', notes: '', createdAt: iso(3600000), updatedAt: iso(60000), ...extra });
const CONVS = [
  conv('FBC-0002', { customerName: '<img src=x onerror=alert(1)>', unreadCount: 2, lastMessage: 'Brake noise <b>loud</b>' }),
  conv('FBC-0001', { customerName: 'Rahim Uddin', lastMessage: 'Thanks', lastDirection: 'out', lastMessageAt: iso(7200000) }),
];
const MSGS = [
  { id: 1, conversationId: 'FBC-0002', direction: 'in', senderType: 'customer', sentBy: '', kind: 'message', text: 'Is my car <ready>?',
    attachments: [{ type: 'image', url: 'https://scontent.example/x.jpg', title: null }, { type: 'file', url: null, title: null }], status: 'received', error: '', createdAt: iso(60000) },
  { id: 2, conversationId: 'FBC-0002', direction: 'out', senderType: 'staff', sentBy: 'karim', kind: 'message', text: 'Yes', attachments: [], status: 'read', error: '', createdAt: iso(30000) },
];

/** fakeApi for hydration; /messenger answered as the Worker would. `send` decides the reply's fate. */
function api({ convs = CONVS, msgs = MSGS, failList = null, failTimes = Infinity, send = 'ok', connection = { send: true, webhook: true } } = {}) {
  const base = fakeApi({ rows: {} });
  const calls = base.calls;
  let failures = 0, nextId = 100;
  const thread = JSON.parse(JSON.stringify(msgs));
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (!path.startsWith('/messenger')) return base(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const [p] = path.split('?');
    if (p === '/messenger/conversations' && method === 'GET') {
      if (failList && failures < failTimes) { failures++; return res(failList.status, { error: failList.error }); }
      return res(200, { data: convs, count: convs.length, total: convs.length, limit: 50, offset: 0,
        summary: { total: convs.length, unreadConversations: convs.filter(c => c.unreadCount).length, unreadMessages: 2, open: 2, pending: 0, resolved: 0 }, connection });
    }
    const m = /^\/messenger\/conversations\/(FBC-\d+)(?:\/([a-z]+))?$/.exec(p);
    const c = m && convs.find(x => x.id === m[1]);
    if (!c) return res(404, { error: { code: 'not_found', message: 'No conversation with that id.' } });
    if (!m[2]) return res(200, { data: c });
    if (m[2] === 'messages') return res(200, { data: thread.filter(x => x.conversationId === c.id), count: 2, hasMore: false, nextBefore: null });
    if (m[2] === 'read') { c.unreadCount = 0; return res(200, { data: c }); }
    if (m[2] === 'status') { Object.assign(c, body); return res(200, { data: c }); }
    if (m[2] === 'reply') {
      if (send === 'window') return res(409, { error: { code: 'conflict', message: 'This customer last wrote more than 24 hours ago.', reason: 'outside_messaging_window' } });
      const row = { id: nextId++, conversationId: c.id, direction: 'out', senderType: 'staff', sentBy: 'API token', kind: 'message', text: body.text, attachments: [], clientRequestId: body.clientRequestId,
        status: send === 'ok' ? 'sent' : 'failed', error: send === 'ok' ? '' : 'Facebook refused the message.', createdAt: new Date().toISOString() };
      thread.push(row);
      if (send === 'ok') return res(201, { data: row });
      return res(502, { error: { code: 'send_failed', message: 'Facebook refused the message.', reason: 'meta_100' } });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'no' } });
  };
  fn.calls = calls;
  return fn;
}

function page(pageKey, module, ids, { origin = 'http://localhost:8787', fetch, plantDemo = false, search = '' } = {}) {
  const h = boot({
    origin, fetch, modules: [module],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = pageKey;
      ctx.setInterval = () => 0; ctx.clearInterval = () => {};
      ctx.location.search = search;
      const els = new Map();
      const make = (id) => {
        const e = makeElement(id); e.hidden = false; e.disabled = false;
        e.querySelector = () => make(`${id}-child`);
        e.classList = (() => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)),
          toggle: (x) => (s.has(x) ? (s.delete(x), false) : (s.add(x), true)), contains: (x) => s.has(x) }; })();
        e.requestSubmit = () => e.dispatch('submit', { preventDefault() {} });
        return e;
      };
      doc.getElementById = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
      doc.querySelectorAll = () => [];
      if (plantDemo) ctx.localStorage.setItem('taqwa_messengerConversations', JSON.stringify([conv('FBC-9999', { customerName: 'DEMO ROW' })]));
    },
  });
  return { h, el: id => h.ctx.document.getElementById(id) };
}
const msgCalls = calls => calls.filter(c => c.path.startsWith('/messenger'));
const codeOf = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

(async () => {
console.log('=== inbox-facebook: Facebook Messenger ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'Facebook');
  ok('Facebook is a link to pages/inbox-facebook.html', /^<a class="nav__sub" href="pages\/inbox-facebook\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-facebook.html')), '');
  ok('   ...labelled Messenger, no longer Demo', /<small>Messenger<\/small>/.test(row) && !/<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const html = shellFor('inbox-facebook', '../');
  const group = inboxGroup(html);
  const row = subFor(group, 'Facebook');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
  ok('   ...and the header says Facebook Messenger', /<h1>Facebook Messenger<\/h1>/.test(html), '');
}

console.log('\n-- 2. the Social Inbox entries --');
{
  const group = inboxGroup(shellFor('dashboard'));
  check('Social Inbox has exactly five entries', group.split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1).length, 5);
  for (const [label, href, hint] of [['All Conversations', 'inbox-conversations', 'Facebook'], ['Facebook', 'inbox-facebook', 'Messenger'], ['WhatsApp', 'inbox-whatsapp', 'Business'], ['Website Forms', 'inbox-website-forms', 'Website']]) {
    const row = subFor(group, label);
    ok(`${label} links to pages/${href}.html, labelled ${hint}`, new RegExp(`^<a class="nav__sub" href="pages/${href}\\.html"`).test(row) && row.includes(`<small>${hint}</small>`), row.slice(0, 200));
  }
}

console.log('\n-- 3. real, not a demo --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-facebook.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-facebook.js'), 'utf8');
{
  ok('the page declares data-page="inbox-facebook"', html.includes('<body data-page="inbox-facebook" data-root="../">'), '');
  ok('the page has no DEMO banner or sample wording', !/DEMO MODE|Not connected \(demo\)|\(sample\)/i.test(html), '');
  ok('the page has the three columns: list, thread, details', ['id="fbList"', 'id="fbThread"', 'id="fbComposer"', 'id="fbDetails"'].every(s => html.includes(s)), '');
  ok('the page loads its script and stylesheet', html.includes('../js/inbox-facebook.js') && html.includes('../css/inbox-facebook.css'), '');
  const code = codeOf(src);
  ok('the script talks to the Worker through Api', /\bApi\.get\(/.test(code) && /\bApi\.post\(/.test(code), '');
  for (const [what, re] of [['a direct fetch', /\bfetch\s*\(/], ['graph.facebook.com', /graph\.facebook\.com/], ['an access token', /access_token|PAGE_ACCESS|META_/],
    ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['indexedDB', /indexedDB/], ['sample data', /SAMPLE|\(Demo\)/]]) {
    ok(`the script has no ${what}`, !re.test(code), '');
  }
}

console.log('\n-- 4. helpers --');
{
  const { h } = page('nothing', 'js/inbox-facebook.js', [], { origin: '' });
  vm.runInContext('globalThis.IF = InboxFacebook;', h.ctx);
  const F = h.ctx.IF;
  check('list query: search, unread and paging', F.buildListQuery({ q: ' brake ', filter: 'unread', limit: 50, offset: 50 }), { limit: '50', offset: '50', q: 'brake', unread: '1' });
  check('list query: a status filter', F.buildListQuery({ filter: 'Pending' }), { limit: '50', offset: '0', status: 'Pending' });
  const ids = new Set(Array.from({ length: 50 }, () => F.newRequestId()));
  ok('request ids are unique and in the Worker\'s shape', ids.size === 50 && [...ids].every(i => /^[A-Za-z0-9_-]{8,64}$/.test(i)), [...ids][0]);
  check('initials', [F.initials('Rahim Uddin'), F.initials('nadia'), F.initials('')], ['RU', 'N', '?']);
  const b = F.bubbleHtml(MSGS[0]);
  ok('a bubble escapes the text', b.includes('Is my car &lt;ready&gt;?') && !b.includes('<ready>'), b);
  ok('an attachment with an https URL is a link that opens safely', /<a class="fb-att" href="https:\/\/scontent\.example\/x\.jpg" target="_blank" rel="noopener noreferrer">Photo/.test(b), b);
  ok('one without a URL is a label, never a link', /<span class="fb-att">File<\/span>/.test(b), b);
  const failed = F.bubbleHtml({ ...MSGS[1], status: 'failed', error: 'Facebook refused <x>' });
  ok('a failed reply says Not sent, why, and offers Retry', /Not sent/.test(failed) && /Facebook refused &lt;x&gt;/.test(failed) && /data-retry=/.test(failed), failed);
  ok('a read reply says Seen', /Seen/.test(F.bubbleHtml(MSGS[1])), '');
  check('the window: open, closed, never opened', [F.windowText({ replyWindowEndsAt: new Date(NOW + 2 * 3600000 + 600000).toISOString() }, NOW), F.windowText({ replyWindowEndsAt: iso(1) }, NOW), F.windowText({}, NOW)],
    ['Open for 2 h 10 min more', 'Closed: more than 24 hours since the customer last wrote', 'Closed: the customer has not written yet']);
}

const IDS = [];
console.log('\n-- 5. the page --');
{
  const fetch = api();
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { fetch });
  h.fireReady();
  await tick(80);
  const list = el('fbList').innerHTML;
  check('the list loads both conversations', (list.match(/class="fb-row[ "]/g) || []).length, 2);
  ok('names and previews are escaped', !list.includes('<img src=x') && list.includes('&lt;img src=x') && list.includes('&lt;b&gt;loud'), '');
  ok('an unread conversation shows its count', /aria-label="2 unread">2</.test(list), '');
  ok('an outbound preview is prefixed You:', list.includes('You: Thanks'), '');
  check('the connection chip says it is connected', [el('fbConn').dataset.state, el('fbConnText').textContent], ['live', 'Connected to the Facebook Page']);
  ok('no demo row appears', !/DEMO/.test(list), '');

  el('fbList').dispatch('click', { target: { closest: () => ({ dataset: { id: 'FBC-0002' } }) } });
  await tick(80);
  const calls = msgCalls(fetch.calls).map(c => `${c.method} ${c.path.split('?')[0]}`);
  ok('opening a conversation reads its thread and marks it read', calls.includes('GET /messenger/conversations/FBC-0002/messages') && calls.includes('POST /messenger/conversations/FBC-0002/read'), JSON.stringify(calls));
  ok('   ...the thread shows both messages, escaped', (el('fbThread').innerHTML.match(/class="fb-msg /g) || []).length === 2 && el('fbThread').innerHTML.includes('&lt;ready&gt;'), el('fbThread').innerHTML.slice(0, 200));
  check('   ...the details show the Facebook id and status', [el('fbdPsid').textContent, el('fbdStatus').value, el('fbdId').textContent], ['900002', 'Open', 'FBC-0002']);
  check('   ...the composer is open inside the window', [el('fbReply').disabled, el('fbWindow').hidden], [false, true]);

  el('fbReply').value = '  Your car is ready  ';
  el('fbComposer').dispatch('submit', { preventDefault() {} });
  ok('while sending, the reply is shown as Sending…', /Sending…/.test(el('fbThread').innerHTML) && el('fbSend').disabled, el('fbThread').innerHTML.slice(-300));
  await tick(80);
  const sent = msgCalls(fetch.calls).find(c => c.path.endsWith('/reply'));
  ok('the reply goes to the Worker, trimmed, with a request id', sent && sent.body.text === 'Your car is ready' && /^[A-Za-z0-9_-]{8,64}$/.test(sent.body.clientRequestId), JSON.stringify(sent));
  ok('   ...and then shows as Sent, once', (el('fbThread').innerHTML.match(/Your car is ready/g) || []).length === 1 && /fb-msg__state--sent">Sent/.test(el('fbThread').innerHTML) && !/Sending…/.test(el('fbThread').innerHTML), el('fbThread').innerHTML.slice(-400));
  check('   ...the box is cleared', el('fbReply').value, '');

  el('fbdStatus').value = 'Pending'; el('fbdAssigned').value = ' Karim '; el('fbdNotes').value = 'Quote sent';
  el('fbDetailsForm').dispatch('submit', { preventDefault() {} });
  await tick(60);
  const put = msgCalls(fetch.calls).find(c => c.method === 'PUT');
  check('details save status, assignment and notes', put && put.body, { status: 'Pending', assignedTo: 'Karim', notes: 'Quote sent' });
}
{
  const fetch = api({ send: 'fail' });
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { fetch, search: '?c=FBC-0001' });
  h.fireReady();
  await tick(100);
  ok('?c= opens that conversation', msgCalls(fetch.calls).some(c => c.path.startsWith('/messenger/conversations/FBC-0001/messages')), '');
  el('fbReply').value = 'Hello';
  el('fbComposer').dispatch('submit', { preventDefault() {} });
  await tick(100);
  const t = el('fbThread').innerHTML;
  ok('a reply Facebook refused shows Not sent, the reason and Retry', /Not sent/.test(t) && /Facebook refused the message/.test(t) && /data-retry=/.test(t), t.slice(-500));
  ok('   ...and is never shown as Sent', !/fb-msg__state--sent">Sent/.test(t), '');
  check('   ...shown once (the server\'s failed copy), not twice', (t.match(/<p>Hello<\/p>/g) || []).length, 1);
}
{
  const fetch = api({ convs: [conv('FBC-0003', { canReply: false, replyWindowEndsAt: iso(3600000) })] });
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { fetch, search: '?c=FBC-0003' });
  h.fireReady();
  await tick(100);
  ok('outside the 24-hour window the composer is closed and says why', el('fbReply').disabled && el('fbSend').disabled && !el('fbWindow').hidden && /24 hours/.test(el('fbWindow').textContent), el('fbWindow').textContent);
}
{
  const fetch = api({ connection: { send: false, webhook: true } });
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { fetch, search: '?c=FBC-0001' });
  h.fireReady();
  await tick(100);
  check('receiving but no Page token: the chip and the composer say so', [el('fbConn').dataset.state, el('fbReply').disabled, /not been configured/.test(el('fbWindow').textContent)], ['partial', true, true]);
}

console.log('\n-- 6. failures --');
{
  const fetch = api({ failList: { status: 500, error: { code: 'database_error', message: 'x' } }, failTimes: 1 });
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { fetch, plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('a failed read shows an error with Retry', /could not be loaded/.test(el('fbListState').innerHTML) && /data-retry-list/.test(el('fbListState').innerHTML), el('fbListState').innerHTML);
  check('   ...and no conversations, demo or otherwise', [el('fbList').hidden, /DEMO/.test(el('fbList').innerHTML)], [true, false]);
  el('fbListState').dispatch('click', { target: { closest: (s) => (s === '[data-retry-list]' ? {} : null) } });
  await tick(80);
  check('Retry reads again and shows them', (el('fbList').innerHTML.match(/class="fb-row[ "]/g) || []).length, 2);
}
{
  const fetch = api({ convs: [] });
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { fetch });
  h.fireReady();
  await tick(80);
  ok('no conversations yet: an honest empty state', /No messages yet/.test(el('fbListState').innerHTML), el('fbListState').innerHTML);
}
{
  const fetch = api();
  const { h, el } = page('inbox-facebook', 'js/inbox-facebook.js', IDS, { origin: '', fetch, plantDemo: true });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says the database is not connected', /not connected/.test(el('fbListState').innerHTML), el('fbListState').innerHTML);
  check('   ...and never asks for /api/messenger', msgCalls(fetch.calls).length, 0);
}

process.exit(summary('inbox-facebook') === 0 ? 0 : 1);
})();
