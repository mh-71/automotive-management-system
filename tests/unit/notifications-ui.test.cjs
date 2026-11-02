/* notifications-ui — the Notifications Center page, connected to the Worker.

   What must hold:
     1. The page is no longer a demo: no Demo badge, sample notifications or
        "nothing is saved" note; it has the real controls (All / Unread /
        Read, category, search, Refresh, Mark all as read, Load more) and
        loading, empty and error states.
     2. The script reads and writes through Api only: no sample data, no
        direct fetch, no browser storage, and nothing from the data is parsed
        as HTML (textContent only).
     3. Helpers: where "Open" goes for each record type; relative and full
        times in the workshop's time zone; the list query; plain error words.
     4. The page polls (30 s), and tells the sidebar badge the new count.

   The page's behaviour in a real browser (against wrangler dev and a local
   database) is checked separately; see the PR description. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const codeOf = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

console.log('=== notifications-ui: the Notifications Center page ===\n');

const html = fs.readFileSync(path.join(ROOT, 'pages/notifications.html'), 'utf8');
const src = fs.readFileSync(path.join(ROOT, 'js/notifications-ui.js'), 'utf8');
const code = codeOf(src);

console.log('-- 1. the page --');
{
  ok('no Demo badge, sample note or sample figures', !/badge--neutral">Demo|Sample notifications|Nothing here is real|>24<|DEMO/.test(html), '');
  ok('it declares data-page="notifications"', html.includes('<body data-page="notifications" data-root="../">'), '');
  for (const [what, needle] of [
    ['All / Unread / Read filters', ['data-status="all"', 'data-status="unread"', 'data-status="read"']],
    ['a category filter with the eight categories', ['id="ntfCategory"', 'value="Enquiry"', 'value="Customer"', 'value="Appointment"', 'value="Workshop"', 'value="Finance"', 'value="Inventory"', 'value="Follow-up"', 'value="Staff"']],
    ['search', ['id="ntfSearch"', 'maxlength="100"']],
    ['Refresh and Mark all as read', ['id="ntfRefresh"', 'id="ntfReadAll"']],
    ['loading, empty and error states', ['id="ntfLoading"', 'id="ntfEmpty"', 'id="ntfError"', 'id="ntfRetry"']],
    ['paging and a new-arrivals banner', ['id="ntfMore"', 'id="ntfNew"']],
    ['the three summary figures, empty until loaded', ['id="ntfTotal">&ndash;', 'id="ntfUnread">&ndash;', 'id="ntfImportant">&ndash;']],
  ]) ok(`the page has ${what}`, needle.every(n => html.includes(n)), needle.filter(n => !html.includes(n)).join(', '));
  ok('Mark all as read starts disabled (nothing is known yet)', /id="ntfReadAll" disabled/.test(html), '');
}

console.log('\n-- 2. the script --');
{
  ok('reads the Worker through Api', /Api\.get\(`\/notifications\?/.test(code) && /Api\.get\('\/notifications\/unread-count'\)/.test(code), '');
  ok('writes read state through Api', /Api\.post\(`\/notifications\/\$\{encodeURIComponent\(id\)\}\/\$\{read \? 'read' : 'unread'\}`/.test(code) && /Api\.post\('\/notifications\/read-all'/.test(code), '');
  for (const [what, re] of [['sample data', /SAMPLE|DEMO-|\(Demo\)/], ['a direct fetch', /\bfetch\s*\(/], ['localStorage', /localStorage/],
    ['sessionStorage', /sessionStorage/], ['innerHTML', /innerHTML/], ['insertAdjacentHTML', /insertAdjacentHTML/]]) {
    ok(`the script has no ${what}`, !re.test(code), '');
  }
  ok('mark-all sends the newest id the page knows (later arrivals stay unread)', /read-all', state\.latestId \? \{ upToId: state\.latestId \}/.test(code), '');
  ok('it polls every 30 seconds, skipping a hidden tab', /POLL_MS = 30000/.test(code) && /document\.hidden\) return;/.test(code), '');
  ok('it tells the sidebar badge the count', /new CustomEvent\('taqwa:notifications-unread'/.test(code), '');
  ok('a late answer to an older request is dropped', /if \(seq !== state\.requestSeq\) return;/.test(code), '');
}

console.log('\n-- 3. helpers --');
{
  const h = boot({ modules: ['js/notifications-ui.js'], beforeModules(doc) { doc.body.dataset.page = 'dashboard'; } });
  vm.runInContext('globalThis.N = NotificationsUI;', h.ctx);
  const N = h.ctx.N;
  check('Open goes to the record itself where its page takes an id',
    ['customer', 'vehicle', 'appointment', 'job_card', 'estimate', 'invoice', 'payment', 'part'].map(t => N.recordHref(t, 'X-1')),
    ['pages/customers.html?view=X-1', 'pages/vehicles.html?view=X-1', 'pages/appointments.html?view=X-1', 'pages/job-cards.html?view=X-1',
      'pages/estimate-details.html?id=X-1', 'pages/invoices.html?view=X-1', 'pages/payments.html?view=X-1', 'pages/inventory.html?view=X-1']);
  check('   ...and to its list where the page has no address for one record',
    ['follow_up', 'follow_up_task', 'leave_request', 'website_form'].map(t => N.recordHref(t, 'X-1')),
    ['pages/crm-follow-up.html', 'pages/crm-tasks.html', 'pages/staff-leave.html', 'pages/inbox-website-forms.html']);
  check('   ...nowhere for an unknown type or a missing id', [N.recordHref('planet', 'X'), N.recordHref('customer', null)], [null, null]);
  check('   ...the id is URL-encoded', N.recordHref('customer', 'A&B=1'), 'pages/customers.html?view=A%26B%3D1');
  ok('every page Open can go to exists', ['customers', 'vehicles', 'appointments', 'job-cards', 'estimate-details', 'invoices', 'payments', 'inventory', 'crm-follow-up', 'crm-tasks', 'staff-leave', 'inbox-website-forms']
    .every(p => fs.existsSync(path.join(ROOT, 'pages', `${p}.html`))), '');

  const now = Date.parse('2026-11-02T06:00:00Z');   // 12:00 in Dhaka
  check('relative times', [
    N.relativeTime('2026-11-02T05:59:30Z', now), N.relativeTime('2026-11-02T05:55:00Z', now), N.relativeTime('2026-11-02T03:00:00Z', now),
    N.relativeTime('2026-11-01T06:00:00Z', now), N.relativeTime('2026-10-20T06:00:00Z', now), N.relativeTime('nonsense', now),
  ], ['Just now', '5 min ago', '3 h ago', 'Yesterday', '20 Oct 2026', '']);
  ok('the full time is in Dhaka time', /2 Nov 2026,? 12:00/.test(N.fullTime('2026-11-02T06:00:00Z')), N.fullTime('2026-11-02T06:00:00Z'));
  check('the list query: defaults', N.listQuery({}), 'limit=25');
  check('   ...with filters, search, paging and refresh', N.listQuery({ status: 'unread', category: 'Follow-up', q: '  oil  ', offset: 25, refresh: true }),
    'status=unread&category=Follow-up&q=oil&limit=25&offset=25&refresh=1');
  check('   ...All sends no status; search is capped at 100', [N.listQuery({ status: 'all' }), new URLSearchParams(N.listQuery({ q: 'x'.repeat(150) })).get('q').length], ['limit=25', 100]);
  check('error words', [N.errorText({ code: 'unauthorized' }).title, N.errorText({ code: 'no_api' }).title, N.errorText({ code: 'network_error' }).title, N.errorText({ code: 'x', message: 'Server says no.' }).text],
    ['Your session has ended', 'Notifications need the workshop database', 'Could not reach the workshop server', 'Server says no.']);
  check('eight categories, each with a label, icon and tone', Object.keys(N.CATEGORIES), ['Enquiry', 'Customer', 'Appointment', 'Workshop', 'Finance', 'Inventory', 'Follow-up', 'Staff']);
  ok('   ...the same eight the Worker accepts', /CATEGORIES = \['Enquiry', 'Customer', 'Appointment', 'Workshop', 'Finance', 'Inventory', 'Follow-up', 'Staff'\]/.test(fs.readFileSync(path.join(ROOT, 'src/lib/notifications.js'), 'utf8')), '');
  check('on another page it does nothing', N.state.items.length, 0);
}

process.exit(summary('notifications-ui') === 0 ? 0 : 1);
