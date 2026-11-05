/* inbox-bookings — Social Inbox › Bookings, a DEMO page (UI only).

   What must hold:
     1. In the sidebar, Bookings is the fifth Social Inbox entry, links to
        pages/inbox-bookings.html, is labelled Demo, and is active (with the
        group open) only on its own page; the other four keep their links.
     2. The page says it is a demo, and its script makes no request and
        touches no browser storage or Api: it is UI only.
     3. Helpers: status filter, summary counts, date and time labels, and
        cards / details are escaped and show every required field.
     4. The page: summary cards, status tabs filter the list at once, an
        empty status says so, clicking a booking opens its details, Back
        closes them.

   Drives the REAL js/app.js and js/inbox-bookings.js through the harness. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
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

function page() {
  const h = boot({
    origin: '', modules: ['js/inbox-bookings.js'],
    beforeModules(doc) {
      doc.body.dataset.page = 'inbox-bookings';
      const els = new Map();
      const make = (id) => {
        const e = makeElement(id); e.hidden = false;
        e.classList = (() => { const s = new Set(); return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)),
          toggle: (x, f) => { const on = f === undefined ? !s.has(x) : f; on ? s.add(x) : s.delete(x); return on; }, contains: (x) => s.has(x) }; })();
        return e;
      };
      doc.getElementById = (id) => { if (!els.has(id)) els.set(id, make(id)); return els.get(id); };
    },
  });
  return { h, el: id => h.ctx.document.getElementById(id) };
}
const cards = html => (html.match(/class="bk-card[ "]/g) || []).length;
const clickTab = (el, status) => el('bkTabs').dispatch('click', { target: { closest: () => ({ dataset: { status } }) } });

(async () => {
console.log('=== inbox-bookings: Bookings (demo) ===\n');

console.log('-- 1. the sidebar --');
{
  const group = inboxGroup(shellFor('dashboard'));
  check('Social Inbox has five entries, Bookings last', subs(group).map(s => (s.match(/<span>([^<]+)<\/span><small>/) || [])[1]),
    ['All Conversations', 'Facebook', 'WhatsApp', 'Website Forms', 'Bookings']);
  const row = subFor(group, 'Bookings');
  ok('Bookings links to pages/inbox-bookings.html', /^<a class="nav__sub" href="pages\/inbox-bookings\.html"/.test(row), row.slice(0, 160));
  ok('   ...labelled Demo', /<small>Demo<\/small>/.test(row), row.slice(0, 200));
  ok('   ...not active on another page', !/is-active|aria-current/.test(row), row.slice(0, 160));
  for (const [label, href] of [['All Conversations', 'inbox-conversations'], ['Facebook', 'inbox-facebook'], ['WhatsApp', 'inbox-whatsapp'], ['Website Forms', 'inbox-website-forms']]) {
    ok(`${label} still links to pages/${href}.html`, new RegExp(`^<a class="nav__sub" href="pages/${href}\\.html"`).test(subFor(group, label)), '');
  }
  const html = shellFor('inbox-bookings', '../');
  const g = inboxGroup(html);
  ok('on its page Bookings is active and the current page', /^<a class="nav__sub is-active" href="\.\.\/pages\/inbox-bookings\.html"[^>]*aria-current="page"/.test(subFor(g, 'Bookings')), subFor(g, 'Bookings').slice(0, 200));
  ok('   ...the Social Inbox group is open', /^<details class="nav__inbox" id="navInbox" open>/.test(g), g.slice(0, 80));
  check('   ...it is the only active sub-entry', (html.match(/class="nav__sub[^"]*is-active/g) || []).length, 1);
  ok('   ...and the header says Bookings', /<h1>Bookings<\/h1>/.test(html), '');
}

console.log('\n-- 2. a demo, UI only --');
const html = fs.readFileSync(path.join(ROOT, 'pages/inbox-bookings.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/inbox-bookings.js'), 'utf8');
{
  ok('the page declares data-page="inbox-bookings"', html.includes('<body data-page="inbox-bookings" data-root="../">'), '');
  ok('the page says DEMO MODE and the Live Inbox chip says (Demo)', /DEMO MODE/.test(html) && /Live Inbox <small>\(Demo\)<\/small>/.test(html), '');
  ok('the page has the summary cards, status tabs, list and details panel', ['id="bkTotal"', 'id="bkPending"', 'id="bkConfirmed"', 'id="bkTabs"', 'id="bkList"', 'id="bkDetail"'].every(s => html.includes(s)), '');
  const code = codeOf(src);
  for (const [what, re] of [['a request (fetch)', /\bfetch\s*\(/], ['XMLHttpRequest', /XMLHttpRequest/], ['the Api client', /\bApi\./], ['Storage', /\bStorage\./], ['localStorage', /localStorage/], ['sessionStorage', /sessionStorage/]]) {
    ok(`the script uses no ${what}`, !re.test(code), '');
  }
  ok('sample phones and emails cannot reach a real person', /0170000/.test(src) && !/@(gmail|yahoo|hotmail)\./.test(src), '');
}

console.log('\n-- 3. helpers --');
{
  const { h } = page();
  vm.runInContext('globalThis.BK = InboxBookings;', h.ctx);
  const B = h.ctx.BK;
  check('the six statuses', B.STATUSES, ['New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed']);
  ok('there is at least one sample booking of every status', B.STATUSES.every(s => B.SAMPLE.some(b => b.status === s)), '');
  check('filter: All keeps everything', B.filterBy(B.SAMPLE, '').length, B.SAMPLE.length);
  ok('filter: one status keeps only that status', B.filterBy(B.SAMPLE, 'Pending').every(b => b.status === 'Pending') && B.filterBy(B.SAMPLE, 'Pending').length > 0, '');
  check('summary counts total, pending and confirmed', B.summary(B.SAMPLE), {
    total: B.SAMPLE.length, pending: B.SAMPLE.filter(b => b.status === 'Pending').length, confirmed: B.SAMPLE.filter(b => b.status === 'Confirmed').length });
  check('date and time labels', [B.dateLabel('2026-11-06'), B.timeLabel('10:30'), B.timeLabel('14:00'), B.timeLabel('00:15'), B.dateLabel('bad')], ['Nov 06, 2026', '10:30 AM', '2:00 PM', '12:15 AM', '']);
  const evil = { id: 'BKG-X', name: '<img src=x onerror=alert(1)>', phone: '1', email: '', make: 'A', model: '<b>B</b>', year: '', regNo: '', service: 'S', date: '2026-11-06', time: '10:30', source: 'Website', status: 'New', message: '<script>x</script>' };
  const c = B.cardHtml(evil, null);
  ok('a card is escaped', c.includes('&lt;img src=x') && !c.includes('<img src=x') && c.includes('&lt;b&gt;B'), c);
  const real = B.cardHtml(B.SAMPLE[0], null);
  ok('a card shows name, reference, vehicle, service, date, time, source and status',
    ['Rahim Ahmed', 'BKG-001', 'Toyota Corolla', 'AC Service', 'Nov 06, 2026', '10:30 AM', 'Source: Website', 'bk-status--pending">Pending'].every(s => real.includes(s)), real);
  const d = B.detailHtml(B.SAMPLE[0]);
  ok('details have every section', ['Customer Information', 'Vehicle Information', 'Requested service', 'Preferred date', 'Preferred time', 'Customer Message', 'Booking source', 'Status'].every(s => d.includes(s)), d);
  ok('details are escaped', !B.detailHtml(evil).includes('<script>'), '');
}

console.log('\n-- 4. the page --');
{
  const { h, el } = page();
  h.fireReady();
  await tick(40);
  vm.runInContext('globalThis.BK = InboxBookings;', h.ctx);
  const B = h.ctx.BK;
  check('summary cards', [el('bkTotal').textContent, el('bkPending').textContent, el('bkConfirmed').textContent],
    [String(B.SAMPLE.length), String(B.summary(B.SAMPLE).pending), String(B.summary(B.SAMPLE).confirmed)]);
  ok('the tabs are All plus the six statuses, All active', /data-status="" aria-selected="true">All/.test(el('bkTabs').innerHTML)
    && B.STATUSES.every(s => el('bkTabs').innerHTML.includes(`data-status="${s}"`)), el('bkTabs').innerHTML);
  check('every booking is listed', cards(el('bkList').innerHTML), B.SAMPLE.length);
  clickTab(el, 'Confirmed');
  check('clicking Confirmed filters the list at once', [cards(el('bkList').innerHTML), (el('bkList').innerHTML.match(/bk-status--(?!confirmed)/g) || []).length, el('bkFilterLabel').textContent],
    [B.SAMPLE.filter(b => b.status === 'Confirmed').length, 0, 'Confirmed']);
  ok('   ...and marks that tab active', /data-status="Confirmed" aria-selected="true"/.test(el('bkTabs').innerHTML), '');
  el('bkList').dispatch('click', { target: { closest: () => ({ dataset: { id: 'BKG-002' } }) } });
  check('clicking a booking opens its details', [el('bkDetail').hidden, el('bkdName').textContent, el('bkdStatus').textContent, /Toyota Axio/.test(el('bkdBody').innerHTML)], [false, 'Karim Hasan', 'Confirmed', true]);
  ok('   ...and highlights it in the list', /bk-card is-active" data-id="BKG-002"/.test(el('bkList').innerHTML), '');
  clickTab(el, 'Pending');
  check('switching to a status the open booking is not in closes it', [el('bkDetail').hidden, cards(el('bkList').innerHTML)], [true, B.SAMPLE.filter(b => b.status === 'Pending').length]);
  clickTab(el, '');
  el('bkList').dispatch('click', { target: { closest: () => ({ dataset: { id: 'BKG-001' } }) } });
  el('bkBack').dispatch('click');
  check('Back closes the details', el('bkDetail').hidden, true);
  const only = B.SAMPLE.splice(0); B.SAMPLE.push(only[0]);
  clickTab(el, 'Completed');
  check('a status with no bookings says so', [el('bkEmpty').hidden, el('bkList').hidden], [false, true]);
  B.SAMPLE.splice(0, B.SAMPLE.length, ...only);
}

process.exit(summary('inbox-bookings') === 0 ? 0 : 1);
})();
