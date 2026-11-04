/* inbox-website-forms — Social Inbox › Website Forms, connected to the database.

   What must hold:
     1. In the sidebar, Website Forms links to its page, labelled Website (no
        longer Demo), active only on that page.
     2. The page is not a demo: no DEMO banner or sample rows; its script
        reads the Worker (Api) only and touches no browser storage.
     3. Helpers: the list query (search, status, type, dates), escaped rows,
        facts and history.
     4. In 'api' mode: enquiries load and are escaped; the status chips,
        type, date and search re-query the Worker; opening one shows its
        details and history; Save sends the status, notes and
        expectedUpdatedAt; a stale save reloads.
     6. Assignment and auto-refresh (0022): Assigned to offers only active
        staff and mechanics from the roster, saves only what changed, shows
        the assignee in the row and facts, and the Assigned filter is sent;
        the list refreshes itself while visible (a new enquiry appears),
        never while hidden, and never overwrites unsaved edits.
     5. Failures: Retry, never demo data; empty and no-match states; no
        backend says so and never asks for /api/website-forms.

   Drives the REAL js/app.js and js/inbox-website-forms.js through the harness. */
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
const sub = (id, extra = {}) => ({ id, formType: 'booking', name: 'Test Person', phone: '+880 1700-000001', email: '', service: 'AC Service', vehicle: 'Toyota Axio',
  regNo: 'DHAKA-GA-1', preferredDate: '', preferredTime: '', message: '', sourcePage: '/book', status: 'New', notes: '', createdAt: iso(60000), updatedAt: iso(60000), updatedBy: '', ...extra });
const ROWS = [
  sub('WEB-0002', { name: '<img src=x onerror=alert(1)>', message: 'AC <b>noise</b>' }),
  sub('WEB-0001', { name: 'Karim Test', formType: 'quote', service: 'LPG Conversion', status: 'Contacted', createdAt: iso(7200000), updatedAt: iso(3600000) }),
];

function api({ rows = ROWS, failList = null, failTimes = Infinity, stale = false } = {}) {
  const base = fakeApi({ rows: {} });
  const STAFF_ROWS = [{ id: 'STF-0001', name: 'Nadia Akter', status: 'Active' }, { id: 'MEC-0001', name: 'Jamal Uddin', status: 'Active' }, { id: 'STF-0002', name: 'Gone', status: 'Inactive' }];
  const calls = base.calls;
  let failures = 0;
  const db = JSON.parse(JSON.stringify(rows));
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (path.startsWith('/staff')) { calls.push({ method: 'GET', path }); return res(200, { data: STAFF_ROWS, count: 3, total: 3, limit: 1000, offset: 0 }); }
    if (!path.startsWith('/website-forms')) return base(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const [p] = path.split('?');
    if (p === '/website-forms' && method === 'GET') {
      if (failList && failures < failTimes) { failures++; return res(failList.status, { error: failList.error }); }
      return res(200, { data: db, count: db.length, total: db.length, limit: 50, offset: 0, summary: { total: db.length, new: 1, contacted: 1, confirmed: 0, rejected: 0 } });
    }
    const id = p.split('/')[2];
    const r = db.find((x) => x.id === id);
    if (!r) return res(404, { error: { code: 'not_found', message: 'No enquiry with that id.' } });
    const history = [{ id: 1, action: 'submitted', fromStatus: '', toStatus: 'New', actor: 'Website', at: r.createdAt }];
    if (method === 'GET') return res(200, { data: { ...r, history } });
    if (method === 'PUT') {
      if (stale) return res(409, { error: { code: 'conflict', message: 'This enquiry was changed by someone else after you opened it. Reload it and try again.', reason: 'concurrent_modification' } });
      const who = 'assignedToId' in body ? { assignedToId: body.assignedToId || '', assignedToName: (STAFF_ROWS.find((x) => x.id === body.assignedToId) || {}).name || '', assignedBy: 'API token', assignedAt: new Date().toISOString() } : {};
      Object.assign(r, body.status ? { status: body.status } : {}, 'notes' in body ? { notes: body.notes } : {}, who, { updatedAt: new Date().toISOString(), updatedBy: 'API token' });
      return res(200, { data: { ...r, history: [...history, { id: 2, action: 'status', fromStatus: 'New', toStatus: r.status, actor: 'API token', at: r.updatedAt }] } });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'no' } });
  };
  fn.calls = calls;
  fn.db = db;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch, plantDemo = false } = {}) {
  const chips = [];
  const timers = [];
  const h = boot({
    origin, fetch, modules: ['js/inbox-website-forms.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = 'inbox-website-forms';
      ctx.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
      ctx.clearInterval = () => {};
      const els = new Map();
      const make = (id) => {
        const e = makeElement(id); e.hidden = false; e.disabled = false;
        const kids = new Map();
        e.querySelector = (sel) => { if (!kids.has(sel)) kids.set(sel, makeElement(sel)); return kids.get(sel); };
        e.classList = (() => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)),
          toggle: (x, f) => { const on = f === undefined ? !s.has(x) : f; on ? s.add(x) : s.delete(x); return on; }, contains: (x) => s.has(x) }; })();
        return e;
      };
      doc.getElementById = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
      for (const st of ['', 'New', 'Contacted', 'Confirmed', 'Rejected']) { const c = make(`chip-${st}`); c.dataset = { status: st }; c.setAttribute = () => {}; chips.push(c); }
      doc.querySelectorAll = (sel) => (sel === '.wf-chip' ? chips : []);
      if (plantDemo) ctx.localStorage.setItem('taqwa_websiteForms', JSON.stringify([sub('WEB-9999', { name: 'DEMO ROW' })]));
    },
  });
  return { h, el: id => h.ctx.document.getElementById(id), chips, timers };
}
const formCalls = calls => calls.filter(c => c.path.startsWith('/website-forms'));
const lastQuery = calls => new URLSearchParams(formCalls(calls).filter(c => c.method === 'GET' && !/WEB-/.test(c.path)).slice(-1)[0].path.split('?')[1] || '');
const codeOf = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

(async () => {
console.log('=== inbox-website-forms: Website Forms ===\n');

console.log('-- 1. the link --');
{
  const row = subFor(inboxGroup(shellFor('dashboard')), 'Website Forms');
  ok('Website Forms links to pages/inbox-website-forms.html', /^<a class="nav__sub" href="pages\/inbox-website-forms\.html"/.test(row), row.slice(0, 160));
  ok('   ...labelled Website, no longer Demo', /<small>Website<\/small>/.test(row) && !/<small>Demo<\/small>/.test(row), row.slice(0, 200));
  const html = shellFor('inbox-website-forms', '../');
  ok('on its page it is active and the current page', /^<a class="nav__sub is-active"/.test(subFor(inboxGroup(html), 'Website Forms')), '');
  ok('   ...and the header says Website Forms', /<h1>Website Forms<\/h1>/.test(html), '');
  check('Social Inbox still has exactly four entries', inboxGroup(shellFor('dashboard')).split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1).length, 4);
}

console.log('\n-- 2. real, not a demo --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-website-forms.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-website-forms.js'), 'utf8');
{
  ok('the page has no DEMO banner or sample rows', !/DEMO MODE|Demo only|\(Demo\)|\(sample\)|DEMO-FORM/.test(html), '');
  ok('the page has search, status chips, type and date filters, list and details', ['id="wfSearch"', 'data-status="Confirmed"', 'id="wfType"', 'id="wfFrom"', 'id="wfTo"', 'id="wfList"', 'id="wfManage"', 'id="wfdHistory"'].every(s => html.includes(s)), '');
  const code = codeOf(src);
  ok('the script reads the Worker through Api', /\bApi\.get\(/.test(code) && /\bApi\.put\(/.test(code), '');
  for (const [what, re] of [['a direct fetch', /\bfetch\s*\(/], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['sample data', /SAMPLE|\(Demo\)|DEMO-FORM/]]) {
    ok(`the script has no ${what}`, !re.test(code), '');
  }
}

console.log('\n-- 3. helpers --');
{
  const { h } = page({ origin: '' });
  vm.runInContext('globalThis.WF = InboxWebsiteForms;', h.ctx);
  const W = h.ctx.WF;
  check('the query carries search, status, type and dates; empty ones are left out',
    W.buildQuery({ q: ' karim ', status: 'New', type: 'quote', from: '2026-10-01', to: '', offset: 50 }),
    { limit: '50', offset: '50', q: 'karim', status: 'New', type: 'quote', from: '2026-10-01' });
  check('the four statuses', W.STATUSES, ['New', 'Contacted', 'Confirmed', 'Rejected']);
  const r = W.rowHtml(ROWS[0], null);
  ok('a row is escaped', r.includes('&lt;img src=x') && !r.includes('<img src=x') && r.includes('AC &lt;b&gt;noise'), r);
  const f = W.factsHtml(ROWS[0]);
  ok('facts link the phone, and leave out empty fields', f.includes('href="tel:+8801700000001"') && !/Email/.test(f), f);
  ok('history is escaped and labelled', /Submitted from the website/.test(W.historyHtml([{ action: 'submitted', actor: '<b>', at: iso(1) }])) && !/<b>/.test(W.historyHtml([{ action: 'notes', actor: '<b>', at: iso(1) }])), '');
}

console.log('\n-- 4. the page --');
{
  const fetch = api();
  const { h, el, chips } = page({ fetch });
  h.fireReady();
  await tick(80);
  const list = el('wfList').innerHTML;
  check('enquiries load from the Worker', (list.match(/class="wf-row[ "]/g) || []).length, 2);
  ok('names and messages are escaped', !list.includes('<img src=x') && list.includes('&lt;img src=x'), '');
  check('the footer counts them', el('wfCount').textContent, '2 of 2 enquiries');
  ok('no demo row appears', !/DEMO/.test(list), '');
  chips[3].dispatch('click');
  await tick(60);
  check('a status chip re-queries with that status', lastQuery(fetch.calls).get('status'), 'Confirmed');
  el('wfType').value = 'quote'; el('wfType').dispatch('change');
  el('wfFrom').value = '2026-10-01'; el('wfFrom').dispatch('change');
  el('wfTo').value = '2026-10-31'; el('wfTo').dispatch('change');
  await tick(60);
  const q = lastQuery(fetch.calls);
  check('type and dates are sent', [q.get('type'), q.get('from'), q.get('to')], ['quote', '2026-10-01', '2026-10-31']);
  el('wfSearch').value = '01700'; el('wfSearch').dispatch('input');
  await tick(400);
  check('search is sent after typing pauses', lastQuery(fetch.calls).get('q'), '01700');
  check('Clear filters is offered', el('wfClear').hidden, false);
  el('wfClear').dispatch('click');
  await tick(60);
  check('Clear drops search, type and dates', ['q', 'type', 'from', 'to'].map(k => lastQuery(fetch.calls).get(k)), [null, null, null, null]);

  el('wfList').dispatch('click', { target: { closest: () => ({ dataset: { id: 'WEB-0002' } }) } });
  await tick(60);
  check('opening an enquiry shows its details', [el('wfDetail').hidden, el('wfdStatus').value, /Toyota Axio/.test(el('wfdFacts').innerHTML)], [false, 'New', true]);
  ok('   ...and its history', /Submitted from the website/.test(el('wfdHistory').innerHTML), el('wfdHistory').innerHTML);
  el('wfdStatus').value = 'Contacted'; el('wfdNotes').value = '  Called the customer  ';
  el('wfManage').dispatch('submit', { preventDefault() {} });
  await tick(80);
  const put = formCalls(fetch.calls).find(c => c.method === 'PUT');
  ok('Save sends the status, trimmed notes and expectedUpdatedAt', put && put.body.status === 'Contacted' && put.body.notes === 'Called the customer' && put.body.expectedUpdatedAt === ROWS[0].updatedAt, JSON.stringify(put && put.body));
  check('   ...and the page shows the saved status and history', [el('wfdStatusBadge').textContent, /Status changed/.test(el('wfdHistory').innerHTML)], ['Contacted', true]);
}
{
  const fetch = api({ stale: true });
  const { h, el } = page({ fetch });
  h.fireReady();
  await tick(80);
  el('wfList').dispatch('click', { target: { closest: () => ({ dataset: { id: 'WEB-0001' } }) } });
  await tick(60);
  el('wfdStatus').value = 'Rejected';
  el('wfManage').dispatch('submit', { preventDefault() {} });
  await tick(80);
  ok('a stale save says so and reloads the enquiry', /changed by someone else/.test(el('wfManage').querySelector('[data-err="manage"]').textContent)
    && formCalls(fetch.calls).filter(c => c.method === 'GET' && c.path.startsWith('/website-forms/WEB-0001')).length === 2, '');
}

console.log('\n-- 5. failures and empty states --');
{
  const fetch = api({ failList: { status: 500, error: { code: 'database_error', message: 'x' } }, failTimes: 1 });
  const { h, el } = page({ fetch, plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('a failed read shows an error with Retry, and no rows', /could not be loaded/.test(el('wfListState').innerHTML) && /data-retry/.test(el('wfListState').innerHTML) && el('wfList').hidden, el('wfListState').innerHTML);
  ok('   ...never the demo rows', !/DEMO/.test(el('wfList').innerHTML), '');
  el('wfListState').dispatch('click', { target: { closest: () => ({}) } });
  await tick(80);
  check('Retry reads again and shows them', (el('wfList').innerHTML.match(/class="wf-row[ "]/g) || []).length, 2);
}
{
  const { h, el } = page({ fetch: api({ rows: [] }) });
  h.fireReady();
  await tick(80);
  ok('no enquiries yet: an honest empty state', /No website enquiries yet/.test(el('wfListState').innerHTML), el('wfListState').innerHTML);
}
{
  const fetch = api();
  const { h, el } = page({ origin: '', fetch, plantDemo: true });
  h.fireReady();
  await tick(40);
  ok('no backend: says the database is not connected', /not connected/.test(el('wfListState').innerHTML), el('wfListState').innerHTML);
  check('   ...and never asks for /api/website-forms', formCalls(fetch.calls).length, 0);
}

console.log('\n-- 6. assignment and auto-refresh --');
{
  const fetch = api();
  const { h, el, timers } = page({ fetch });
  h.fireReady();
  await tick(100);
  const filterOpts = el('wfAssigned').innerHTML;
  ok('the Assigned filter offers Anyone, Not assigned and active staff only', /value="none">Not assigned/.test(filterOpts) && /value="STF-0001">Nadia Akter/.test(filterOpts) && !/STF-0002/.test(filterOpts), filterOpts);
  el('wfAssigned').value = 'none'; el('wfAssigned').dispatch('change');
  await tick(60);
  check('   ...and is sent to the Worker', lastQuery(fetch.calls).get('assigned'), 'none');
  el('wfAssigned').value = ''; el('wfAssigned').dispatch('change');
  await tick(60);

  el('wfList').dispatch('click', { target: { closest: () => ({ dataset: { id: 'WEB-0001' } }) } });
  await tick(60);
  const opts = el('wfdAssigned').innerHTML;
  ok('Assigned to offers only active staff and mechanics from the roster', /value="">Not assigned/.test(opts) && /value="STF-0001">Nadia Akter/.test(opts) && /value="MEC-0001">Jamal Uddin/.test(opts) && !/STF-0002/.test(opts), opts);
  ok('the facts say the source is the website', /<dt>Source<\/dt><dd>Website<\/dd>/.test(el('wfdFacts').innerHTML), el('wfdFacts').innerHTML);
  el('wfdAssigned').value = 'MEC-0001';
  el('wfManage').dispatch('submit', { preventDefault() {} });
  await tick(80);
  const put = formCalls(fetch.calls).filter(c => c.method === 'PUT').slice(-1)[0];
  check('Save sends only the assignment (status and notes unchanged)', put && put.body, { expectedUpdatedAt: ROWS[1].updatedAt, assignedToId: 'MEC-0001' });
  ok('   ...the facts show who it is assigned to and by whom', /Assigned to<\/dt><dd>Jamal Uddin <small>\(by API token/.test(el('wfdFacts').innerHTML), el('wfdFacts').innerHTML);
  ok('   ...and the list row shows the assignee', /WEB-0001[^<]*· Jamal Uddin/.test(el('wfList').innerHTML), el('wfList').innerHTML);
  el('wfdAssigned').value = '';
  el('wfManage').dispatch('submit', { preventDefault() {} });
  await tick(80);
  check('choosing Not assigned sends null', formCalls(fetch.calls).filter(c => c.method === 'PUT').slice(-1)[0].body.assignedToId, null);

  const poll = timers.find(t => t.ms === 30000);
  ok('the page refreshes itself every 30 seconds', Boolean(poll), JSON.stringify(timers.map(t => t.ms)));
  fetch.db.unshift(sub('WEB-0003', { name: 'Brand New Contact', formType: 'contact', service: 'Car AC Service', message: 'Hello', sourcePage: '/contact' }));
  const gets = () => formCalls(fetch.calls).filter(c => c.method === 'GET').length;
  h.ctx.document.hidden = true;
  let n = gets(); poll.fn(); await tick(60);
  check('   ...not while the tab is hidden', gets(), n);
  h.ctx.document.hidden = false;
  el('wfdNotes').value = 'typing, not saved yet';
  poll.fn(); await tick(80);
  ok('   ...a new website enquiry appears without pressing Refresh', /Brand New Contact/.test(el('wfList').innerHTML), el('wfList').innerHTML);
  check('   ...and unsaved notes in the open enquiry are not overwritten', el('wfdNotes').value, 'typing, not saved yet');
}

process.exit(summary('inbox-website-forms') === 0 ? 0 : 1);
})();
