/* inbox-bookings — Social Inbox › Bookings, connected to the database (0023).

   What must hold:
     1. In the sidebar, Bookings is the fifth Social Inbox entry, links to
        pages/inbox-bookings.html, is labelled Requests (no longer Demo), and is
        active (with the group open) only on its own page.
     2. The page is not a demo: no DEMO banner or sample bookings; its script
        reads the Worker (Api) only and touches no browser storage directly.
     3. Helpers: the list query, date and time labels; cards, details,
        history and notes are escaped.
     4. In 'api' mode: bookings and live counts load; status tabs, search,
        source and assigned filters re-query the Worker; opening one shows
        its details; a status change sends to + reason / new date +
        expectedUpdatedAt and offers only the allowed moves; assign, links
        and notes are sent; a stale save reloads; the list refreshes itself
        while visible and never overwrites unsaved edits.
     5. Failures: Retry, never demo data; empty and no-match states; no
        backend says so and never asks for /api/bookings.

   Drives the REAL js/app.js and js/inbox-bookings.js through the harness. */
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
const subs = group => group.split(/(?=<(?:a|span) class="nav__sub[ "])/).slice(1);
const subFor = (group, label) => subs(group).find(p => p.includes(`<span>${label}</span>`)) || '';
const codeOf = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const NEXT = { New: ['Pending', 'Confirmed', 'Rejected', 'Cancelled'], Pending: ['Confirmed', 'Rejected', 'Cancelled'], Confirmed: ['Rescheduled', 'Cancelled', 'Completed'], Rescheduled: ['Confirmed', 'Cancelled'], Cancelled: [], Rejected: [], Completed: [] };
const bk = (id, extra = {}) => ({ id, reference: id, source: 'Website', sourceReference: '', customerName: 'Test Person', phone: '01711-000001', email: '',
  vehicleMake: 'Toyota', vehicleModel: 'Axio', registrationNumber: 'METRO-GA-1', serviceType: 'car-ac', serviceLabel: 'Car AC Service',
  preferredDate: '2026-12-10', preferredTime: '10:30', message: '', consent: true, consentAt: iso(1000), status: 'New',
  customerId: '', vehicleId: '', appointmentId: '', assignedStaffId: '', assignedStaffName: '', assignedAt: '', assignedBy: '',
  createdAt: iso(60000), updatedAt: iso(60000), updatedBy: '', confirmedAt: '', cancelledAt: '', ...extra });
const ROWS = [
  bk('BKG-0002', { customerName: '<img src=x onerror=alert(1)>', message: 'AC <b>noise</b>' }),
  bk('BKG-0001', { customerName: 'Karim Test', status: 'Confirmed', serviceLabel: 'Hybrid Vehicle Service', createdAt: iso(7200000), updatedAt: iso(3600000) }),
];
const STAFF_ROWS = [{ id: 'STF-0001', name: 'Nadia Akter', status: 'Active' }, { id: 'MEC-0001', name: 'Jamal Uddin', status: 'Active' }, { id: 'STF-0002', name: 'Gone', status: 'Inactive' }];

function api({ rows = ROWS, failList = null, failTimes = Infinity, stale = false } = {}) {
  const base = fakeApi({ rows: {} });
  const calls = base.calls;
  let failures = 0;
  const db = JSON.parse(JSON.stringify(rows));
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const detail = (r) => ({ ...r, allowedStatuses: NEXT[r.status], history: [{ id: 1, action: 'submitted', fromStatus: '', toStatus: 'New', detail: 'Source: Website', reason: '', actor: 'Website', at: r.createdAt }, ...(r._h || [])],
    notes: r._notes || [], matches: { customers: [{ id: 'CUS-0001', name: 'Karim In CRM', phone: '+8801711000001' }], vehicles: [{ id: 'VEH-0001', customerId: 'CUS-0001', regNo: 'METRO-GA-1', brand: 'Toyota', model: 'Axio' }] } });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    if (path.startsWith('/staff')) { calls.push({ method: 'GET', path }); return res(200, { data: STAFF_ROWS, count: 3, total: 3, limit: 1000, offset: 0 }); }
    if (!path.startsWith('/bookings')) return base(url, init);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const [p] = path.split('?');
    if (p === '/bookings' && method === 'GET') {
      if (failList && failures < failTimes) { failures++; return res(failList.status, { error: failList.error }); }
      return res(200, { data: db, count: db.length, total: db.length, limit: 50, offset: 0,
        summary: { total: db.length, new: db.filter(r => r.status === 'New').length, pending: 0, confirmed: db.filter(r => r.status === 'Confirmed').length, rescheduled: 0, cancelled: 0, rejected: 0, completed: 0 } });
    }
    const [, , id, action] = p.split('/');
    const r = db.find((x) => x.id === id);
    if (!r) return res(404, { error: { code: 'not_found', message: 'No booking with that id.' } });
    if (method === 'GET') return res(200, { data: detail(r) });
    if (stale) return res(409, { error: { code: 'conflict', message: 'This booking was changed by someone else after you opened it. Reload it and try again.', reason: 'concurrent_modification' } });
    const stamp = () => { r.updatedAt = new Date().toISOString(); };
    if (method === 'POST' && action === 'status') {
      r._h = [...(r._h || []), { id: 9, action: 'status', fromStatus: r.status, toStatus: body.to, detail: '', reason: body.reason || '', actor: 'API token', at: new Date().toISOString() }];
      r.status = body.to; if (body.date) { r.preferredDate = body.date; r.preferredTime = body.time; } stamp();
      return res(200, { data: detail(r) });
    }
    if (method === 'POST' && action === 'notes') { r._notes = [{ id: 1, note: body.note, by: 'API token', at: new Date().toISOString() }, ...(r._notes || [])]; return res(201, { data: detail(r) }); }
    if (method === 'PUT') {
      if ('assignedStaffId' in body) { r.assignedStaffId = body.assignedStaffId || ''; r.assignedStaffName = (STAFF_ROWS.find(s => s.id === body.assignedStaffId) || {}).name || ''; r.assignedBy = 'API token'; }
      if ('customerId' in body) r.customerId = body.customerId || '';
      if ('vehicleId' in body) r.vehicleId = body.vehicleId || '';
      stamp();
      return res(200, { data: detail(r) });
    }
    return res(405, { error: { code: 'method_not_allowed', message: 'no' } });
  };
  fn.calls = calls;
  fn.db = db;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch, plantDemo = false } = {}) {
  const timers = [];
  const h = boot({
    origin, fetch, modules: ['js/inbox-bookings.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = 'inbox-bookings';
      ctx.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
      ctx.clearInterval = () => {};
      const els = new Map();
      const make = (id) => {
        const e = makeElement(id); e.hidden = false; e.disabled = false;
        e.classList = (() => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)),
          toggle: (x, f) => { const on = f === undefined ? !s.has(x) : f; on ? s.add(x) : s.delete(x); return on; }, contains: (x) => s.has(x) }; })();
        return e;
      };
      doc.getElementById = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
      const errs = new Map();
      const orig = doc.querySelector ? doc.querySelector.bind(doc) : () => null;
      doc.querySelector = (sel) => {
        if (!/^\[data-err=/.test(sel)) return orig(sel);
        if (!errs.has(sel)) errs.set(sel, make(sel));
        return errs.get(sel);
      };
      doc.querySelectorAll = (sel) => (sel === '[data-err]' ? [...errs.values()] : []);
      if (plantDemo) ctx.localStorage.setItem('taqwa_bookings', JSON.stringify([bk('BKG-9999', { customerName: 'DEMO ROW' })]));
    },
  });
  return { h, el: id => h.ctx.document.getElementById(id), timers, err: key => h.ctx.document.querySelector(`[data-err="${key}"]`) };
}
const bookingCalls = calls => calls.filter(c => c.path.startsWith('/bookings'));
const lastQuery = calls => new URLSearchParams(bookingCalls(calls).filter(c => c.method === 'GET' && !/BKG-/.test(c.path)).slice(-1)[0].path.split('?')[1] || '');
const cards = html => (html.match(/class="bk-card[ "]/g) || []).length;
const openCard = (el, id) => el('bkList').dispatch('click', { target: { closest: () => ({ dataset: { id } }) } });
const clickTab = (el, status) => el('bkTabs').dispatch('click', { target: { closest: () => ({ dataset: { status } }) } });

(async () => {
console.log('=== inbox-bookings: Bookings ===\n');

console.log('-- 1. the sidebar --');
{
  const group = inboxGroup(shellFor('dashboard'));
  check('Social Inbox has five entries, Bookings last', subs(group).map(s => (s.match(/<span>([^<]+)<\/span><small>/) || [])[1]),
    ['All Conversations', 'Facebook', 'WhatsApp', 'Website Forms', 'Bookings']);
  const row = subFor(group, 'Bookings');
  ok('Bookings links to pages/inbox-bookings.html', /^<a class="nav__sub" href="pages\/inbox-bookings\.html"/.test(row), row.slice(0, 160));
  ok('   ...labelled Requests, no longer Demo', /<small>Requests<\/small>/.test(row) && !/<small>Demo<\/small>/.test(row), row.slice(0, 200));
  const html = shellFor('inbox-bookings', '../');
  const g = inboxGroup(html);
  ok('on its page Bookings is active, the current page, and the group is open',
    /^<a class="nav__sub is-active" href="\.\.\/pages\/inbox-bookings\.html"[^>]*aria-current="page"/.test(subFor(g, 'Bookings')) && /^<details class="nav__inbox" id="navInbox" open>/.test(g), '');
  ok('   ...and the header says Bookings', /<h1>Bookings<\/h1>/.test(html), '');
}

console.log('\n-- 2. real, not a demo --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-bookings.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-bookings.js'), 'utf8');
{
  ok('the page has no DEMO banner or sample data', !/DEMO MODE|\(Demo\)|Sample bookings|fictional/i.test(html), '');
  ok('the page has the cards, tabs, search, filters, list, detail, status, assign, links, notes and history',
    ['id="bkTotal"', 'id="bkNew"', 'id="bkTabs"', 'id="bkSearch"', 'id="bkSource"', 'id="bkAssignedFilter"', 'id="bkList"', 'id="bkDetail"',
      'id="bkStatusForm"', 'id="bkAssignForm"', 'id="bkLinkForm"', 'id="bkNoteForm"', 'id="bkdHistory"'].every(s => html.includes(s)), '');
  const code = codeOf(src);
  ok('the script reads and writes through Api', /\bApi\.get\(/.test(code) && /\bApi\.put\(/.test(code) && /\bApi\.post\(/.test(code), '');
  for (const [what, re] of [['a direct fetch', /\bfetch\s*\(/], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/], ['sample data', /SAMPLE|Rahim Ahmed|BKG-001'/]]) {
    ok(`the script has no ${what}`, !re.test(code), '');
  }
}

console.log('\n-- 3. helpers --');
{
  const { h } = page({ origin: '' });
  vm.runInContext('globalThis.BK = InboxBookings;', h.ctx);
  const B = h.ctx.BK;
  check('the query carries search, status, source and assigned; empty ones are left out',
    B.buildQuery({ q: ' karim ', status: 'Pending', source: '', assigned: 'none', offset: 50 }), { limit: '50', offset: '50', q: 'karim', status: 'Pending', assigned: 'none' });
  check('date and time labels', [B.dateLabel('2026-11-06'), B.timeLabel('14:05'), B.timeLabel('00:15')], ['Nov 06, 2026', '2:05 PM', '12:15 AM']);
  const c = B.cardHtml(ROWS[0], null);
  ok('a card is escaped and shows reference, phone, vehicle, service, date, time and source', c.includes('&lt;img src=x') && !c.includes('<img src=x')
    && ['BKG-0002', '01711-000001', 'Toyota Axio', 'Car AC Service', 'Dec 10, 2026', '10:30 AM', 'Source: Website'].every(s => c.includes(s)), c);
  const d = B.detailHtml({ ...ROWS[0], assignedStaffName: 'Nadia', assignedBy: '<b>x</b>' });
  ok('details are escaped and grouped', !/<b>x<\/b>|AC <b>/.test(d) && ['Customer Information', 'Vehicle Information', 'Booking', 'Customer Message'].every(s => d.includes(s)), d);
  ok('history and notes are escaped', !B.historyHtml([{ action: 'status', fromStatus: 'New', toStatus: 'Pending', reason: '<i>r</i>', actor: '<b>', at: iso(1) }]).includes('<i>')
    && !B.notesHtml([{ note: '<script>x</script>', by: 'a', at: iso(1) }]).includes('<script>'), '');
}

console.log('\n-- 4. the page --');
{
  const fetch = api();
  const { h, el, timers, err } = page({ fetch });
  h.fireReady();
  await tick(100);
  check('bookings load from the Worker, with live counts', [cards(el('bkList').innerHTML), el('bkTotal').textContent, el('bkNew').textContent, el('bkConfirmed').textContent], [2, '2', '1', '1']);
  ok('names and messages are escaped', !el('bkList').innerHTML.includes('<img src=x'), '');
  ok('the Live Inbox chip shows once the database answers', el('bkLive').hidden === false, '');
  ok('the tabs are All plus the seven statuses, with counts', ['All', 'New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Rejected', 'Completed'].every(s => el('bkTabs').innerHTML.includes(`>${s} <span class="bk-tab__n">`)), el('bkTabs').innerHTML);
  clickTab(el, 'Rejected');
  await tick(60);
  check('a status tab re-queries with that status', lastQuery(fetch.calls).get('status'), 'Rejected');
  clickTab(el, '');
  el('bkSource').value = 'Phone'; el('bkSource').dispatch('change');
  el('bkAssignedFilter').value = 'none'; el('bkAssignedFilter').dispatch('change');
  await tick(60);
  check('source and assigned filters are sent', [lastQuery(fetch.calls).get('source'), lastQuery(fetch.calls).get('assigned')], ['Phone', 'none']);
  el('bkSearch').value = '01711'; el('bkSearch').dispatch('input');
  await tick(400);
  check('search is sent after typing pauses', lastQuery(fetch.calls).get('q'), '01711');
  el('bkClear').dispatch('click');
  await tick(60);
  check('Clear drops search, source and assigned', ['q', 'source', 'assigned'].map(k => lastQuery(fetch.calls).get(k)), [null, null, null]);

  openCard(el, 'BKG-0002');
  await tick(60);
  check('opening a booking shows its details and history', [el('bkDetail').hidden, el('bkdStatus').textContent, /Toyota Axio/.test(el('bkdBody').innerHTML), /Received/.test(el('bkdHistory').innerHTML)], [false, 'New', true, true]);
  ok('   ...the status choice offers only the allowed moves', ['Pending', 'Confirmed', 'Rejected', 'Cancelled'].every(s => el('bkdTo').innerHTML.includes(`value="${s}"`)) && !el('bkdTo').innerHTML.includes('value="Completed"'), el('bkdTo').innerHTML);
  ok('   ...the customer match from the CRM is offered for linking', /value="CUS-0001">Karim In CRM/.test(el('bkdCustomer').innerHTML), el('bkdCustomer').innerHTML);
  ok('   ...Assigned to offers active staff only', /STF-0001/.test(el('bkdAssigned').innerHTML) && !/STF-0002/.test(el('bkdAssigned').innerHTML), el('bkdAssigned').innerHTML);
  el('bkdTo').value = 'Rejected'; el('bkdTo').dispatch('change');
  ok('choosing Rejected asks for a reason', el('bkReasonField').hidden === false && el('bkWhenFields').hidden === true, '');
  el('bkdReason').value = '  Duplicate request  ';
  el('bkStatusForm').dispatch('submit', { preventDefault() {} });
  await tick(80);
  let post = bookingCalls(fetch.calls).filter(c => c.method === 'POST').slice(-1)[0];
  check('Update status sends to, the trimmed reason and expectedUpdatedAt', post && post.body, { to: 'Rejected', expectedUpdatedAt: ROWS[0].updatedAt, reason: 'Duplicate request' });
  check('   ...and shows the new status, closed for further moves', [el('bkdStatus').textContent, el('bkStatusForm').hidden, el('bkClosed').hidden], ['Rejected', true, false]);

  openCard(el, 'BKG-0001');
  await tick(60);
  el('bkdTo').value = 'Rescheduled'; el('bkdTo').dispatch('change');
  ok('choosing Rescheduled asks for the new date and time', el('bkWhenFields').hidden === false, '');
  el('bkdDate').value = '2026-12-20'; el('bkdTime').value = '15:00';
  el('bkStatusForm').dispatch('submit', { preventDefault() {} });
  await tick(80);
  post = bookingCalls(fetch.calls).filter(c => c.method === 'POST').slice(-1)[0];
  check('...and sends them', [post.body.to, post.body.date, post.body.time], ['Rescheduled', '2026-12-20', '15:00']);

  el('bkdAssigned').value = 'MEC-0001';
  el('bkAssignForm').dispatch('submit', { preventDefault() {} });
  await tick(80);
  let put = bookingCalls(fetch.calls).filter(c => c.method === 'PUT').slice(-1)[0];
  check('Save assignment sends the staff id', put && put.body.assignedStaffId, 'MEC-0001');
  el('bkdCustomer').value = 'CUS-0001';
  el('bkLinkForm').dispatch('submit', { preventDefault() {} });
  await tick(80);
  put = bookingCalls(fetch.calls).filter(c => c.method === 'PUT').slice(-1)[0];
  check('Save links sends only what changed', put && Object.keys(put.body).sort(), ['customerId', 'expectedUpdatedAt']);
  el('bkdNote').value = '  Called, will come Sunday.  ';
  el('bkNoteForm').dispatch('submit', { preventDefault() {} });
  await tick(80);
  post = bookingCalls(fetch.calls).filter(c => c.method === 'POST' && c.path.endsWith('/notes')).slice(-1)[0];
  check('Add note sends the trimmed note, and it appears', [post && post.body, /Called, will come Sunday\./.test(el('bkdNotes').innerHTML)], [{ note: 'Called, will come Sunday.' }, true]);

  const poll = timers.find(t => t.ms === 30000);
  ok('the page refreshes itself every 30 seconds', Boolean(poll), JSON.stringify(timers.map(t => t.ms)));
  fetch.db.unshift(bk('BKG-0003', { customerName: 'Brand New Booker' }));
  const gets = () => bookingCalls(fetch.calls).filter(c => c.method === 'GET').length;
  h.ctx.document.hidden = true;
  let n = gets(); poll.fn(); await tick(60);
  check('   ...not while the tab is hidden', gets(), n);
  h.ctx.document.hidden = false;
  el('bkdNote').value = 'typing, not saved yet';
  poll.fn(); await tick(80);
  ok('   ...a new website booking appears without pressing Refresh', /Brand New Booker/.test(el('bkList').innerHTML), el('bkList').innerHTML);
  check('   ...and an unsaved note in the open booking is not overwritten', el('bkdNote').value, 'typing, not saved yet');
  void err;
}
{
  const fetch = api({ stale: true });
  const { h, el, err } = page({ fetch });
  h.fireReady();
  await tick(80);
  openCard(el, 'BKG-0002');
  await tick(60);
  el('bkdTo').value = 'Pending';
  el('bkStatusForm').dispatch('submit', { preventDefault() {} });
  await tick(80);
  ok('a stale save says so and reloads the booking', /changed by someone else/.test(err('status').textContent)
    && bookingCalls(fetch.calls).filter(c => c.method === 'GET' && c.path.startsWith('/bookings/BKG-0002')).length === 2, err('status').textContent);
}

console.log('\n-- 5. failures and empty states --');
{
  const fetch = api({ failList: { status: 500, error: { code: 'database_error', message: 'x' } }, failTimes: 1 });
  const { h, el } = page({ fetch, plantDemo: true });
  h.fireReady();
  await tick(80);
  ok('a failed read shows an error with Retry, and no rows', /could not be loaded/.test(el('bkListState').innerHTML) && /data-retry/.test(el('bkListState').innerHTML) && el('bkList').hidden, el('bkListState').innerHTML);
  ok('   ...never demo rows', !/DEMO/.test(el('bkList').innerHTML), '');
  el('bkListState').dispatch('click', { target: { closest: () => ({}) } });
  await tick(80);
  check('Retry reads again and shows them', cards(el('bkList').innerHTML), 2);
}
{
  const { h, el } = page({ fetch: api({ rows: [] }) });
  h.fireReady();
  await tick(80);
  ok('no bookings yet: an honest empty state', /No bookings yet/.test(el('bkListState').innerHTML), el('bkListState').innerHTML);
}
{
  const fetch = api();
  const { h, el } = page({ origin: '', fetch, plantDemo: true });
  h.fireReady();
  await tick(40);
  ok('no backend: says the database is not connected', /not connected/.test(el('bkListState').innerHTML), el('bkListState').innerHTML);
  check('   ...and never asks for /api/bookings', bookingCalls(fetch.calls).length, 0);
}

process.exit(summary('inbox-bookings') === 0 ? 0 : 1);
})();
