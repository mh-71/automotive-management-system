/* inbox-nav — Social Inbox › All Conversations, with real Facebook data.

   What must hold:
     1. In the sidebar, All Conversations is a link to its page, labelled
        Facebook (the one connected channel); active only on that page.
     2. The Social Inbox holds exactly All Conversations, Facebook, WhatsApp
        and Website Forms.
     3. The page is not a demo: no sample data or DEMO banner; its script
        reads the Worker (Api) and touches no browser storage.
     4. Helpers: a Messenger conversation becomes a Facebook row linking to
        the Facebook inbox; rows from every channel merge newest first; the
        query carries search and status.
     5. In 'api' mode: real Facebook conversations are listed, escaped,
        tagged Facebook; WhatsApp and Website say "not connected" and list
        nothing -- no fake conversations; search and status re-query.
     6. Failures: Retry, never demo data; no backend says so.

   Drives the REAL js/app.js and js/inbox-conversations.js through the harness. */
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
console.log('=== inbox-nav: All Conversations ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'All Conversations');
  ok('All Conversations is a link to pages/inbox-conversations.html', /^<a class="nav__sub" href="pages\/inbox-conversations\.html"/.test(row), row.slice(0, 160));
  ok('   ...a page that exists', fs.existsSync(path.join(ROOT, 'pages/inbox-conversations.html')), '');
  ok('   ...labelled Facebook, no longer Demo', /<small>Facebook<\/small>/.test(row) && !/<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
}
{
  const html = shellFor('inbox-conversations', '../');
  const group = inboxGroup(html);
  const row = subFor(group, 'All Conversations');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(row) && /aria-current="page"/.test(row), row.slice(0, 200));
  ok('   ...and the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(group), group.slice(0, 80));
  check('   ...and it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
}

console.log('\n-- 2. the Social Inbox entries --');
{
  const html = shellFor('dashboard');
  const group = inboxGroup(html);
  check('Social Inbox has exactly five entries', group.split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1).length, 5);
  for (const [label, href] of [['All Conversations', 'inbox-conversations'], ['Facebook', 'inbox-facebook'], ['WhatsApp', 'inbox-whatsapp'], ['Website Forms', 'inbox-website-forms'], ['Bookings', 'inbox-bookings']]) {
    ok(`${label} links to pages/${href}.html`, new RegExp(`^<a class="nav__sub" href="pages/${href}\\.html"`).test(subFor(group, label)), subFor(group, label).slice(0, 120));
  }
  ok('Book Now and Comments are not in the Social Inbox', !/<span>Book Now<\/span>/.test(group) && !/<span>Comments<\/span>/.test(group), '');
  ok('the main Appointments link is still in the sidebar', /<a class="nav__link[^"]*" href="pages\/appointments\.html">[\s\S]*?<span>Appointments<\/span><\/a>/.test(html), '');
}

console.log('\n-- 3. real, not a demo --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-conversations.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-conversations.js'), 'utf8');
{
  ok('the page declares data-page="inbox-conversations"', html.includes('<body data-page="inbox-conversations" data-root="../">'), '');
  ok('the page has no Demo banner', !/Demo Mode|sample data/i.test(html), '');
  ok('WhatsApp and Website are marked Not connected', (html.match(/Not connected/g) || []).length >= 2, '');
  const code = codeOf(src);
  ok('the script reads the Worker through Api', /\bApi\.get\(/.test(code), '');
  for (const [what, re] of [['a direct fetch', /\bfetch\s*\(/], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['sample data', /SAMPLE|\(Demo\)/]]) {
    ok(`the script has no ${what}`, !re.test(code), '');
  }
}

console.log('\n-- 4. helpers --');
{
  const { h } = page('nothing', 'js/inbox-conversations.js', [], { origin: '' });
  vm.runInContext('globalThis.IC = InboxConversations;', h.ctx);
  const C = h.ctx.IC;
  const row = C.fromMessenger(CONVS[0]);
  check('a Messenger conversation becomes a Facebook row that opens it in the Facebook inbox',
    [row.platform, row.id, row.unread, row.href], ['Facebook', 'FBC-0002', 2, 'inbox-facebook.html?c=FBC-0002']);
  check('rows merge newest first across channels', C.mergeRows([{ id: 'a', at: '2026-10-01' }], [{ id: 'b', at: '2026-10-03' }, { id: 'c', at: '2026-10-02' }]).map(r => r.id), ['b', 'c', 'a']);
  check('the query carries search and status', C.messengerQuery({ q: ' x ', status: 'unread' }), { limit: '50', offset: '0', q: 'x', unread: '1' });
  check('only Facebook is connected', C.CHANNELS.map(c => [c.key, c.connected]), [['Facebook', true], ['WhatsApp', false], ['Website', false]]);
  const r = C.rowHtml(row);
  ok('a row is escaped and tagged Facebook', r.includes('&lt;img src=x') && !r.includes('<img src=x') && r.includes('inb-plat--facebook" title="Facebook">Facebook'), r);
}

console.log('\n-- 5. the page --');
{
  const fetch = api();
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { fetch });
  h.fireReady();
  await tick(80);
  const list = el('inbList').innerHTML;
  check('real Facebook conversations are listed, each tagged Facebook', [(list.match(/<li>/g) || []).length, (list.match(/inb-plat--facebook/g) || []).length], [2, 2]);
  ok('   ...linking to the Facebook inbox', list.includes('href="inbox-facebook.html?c=FBC-0002"'), '');
  ok('   ...and no WhatsApp or Website conversation is invented', !/inb-plat--whatsapp|inb-plat--website/.test(list), '');
  ok('WhatsApp and Website say they are not connected', /WhatsApp is not connected yet/.test(el('inbNotes').innerHTML) && /Website is not connected yet/.test(el('inbNotes').innerHTML), el('inbNotes').innerHTML);
  check('the footer counts them', el('inbCount').textContent, '2 of 2 conversations');
  el('inbStatus').value = 'unread'; el('inbStatus').dispatch('change');
  await tick(60);
  ok('a status filter re-queries the Worker', msgCalls(fetch.calls).slice(-1)[0].path.includes('unread=1'), msgCalls(fetch.calls).slice(-1)[0].path);
  el('inbSearch').value = 'brake'; el('inbSearch').dispatch('input');
  await tick(400);
  ok('search re-queries the Worker', msgCalls(fetch.calls).slice(-1)[0].path.includes('q=brake'), msgCalls(fetch.calls).slice(-1)[0].path);
}

console.log('\n-- 6. failures --');
{
  const fetch = api({ failList: { status: 500, error: { code: 'database_error', message: 'x' } }, failTimes: 1 });
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { fetch, plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('a failed read shows an error with Retry, and lists nothing', /could not be loaded/.test(el('inbState').innerHTML) && /data-retry/.test(el('inbState').innerHTML) && el('inbList').hidden, el('inbState').innerHTML);
}
{
  const fetch = api();
  const { h, el } = page('inbox-conversations', 'js/inbox-conversations.js', [], { origin: '', fetch });
  h.fireReady();
  await tick(40);
  ok('no backend: says the database is not connected, and asks for nothing', /not connected/.test(el('inbState').innerHTML) && msgCalls(fetch.calls).length === 0, el('inbState').innerHTML);
}

process.exit(summary('inbox-nav') === 0 ? 0 : 1);
})();
