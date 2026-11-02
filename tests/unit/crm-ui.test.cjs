/* crm-ui — the Customer CRM: all five pages connected.

   What must hold:
     1. The sidebar has a "Customer CRM" group after Expenses and before
        Reports, with five entries that link to real pages, mark the current
        one as active and open the group on a CRM page.
     2. The Dashboard's CRM Overview shows four cards with a "—" placeholder
        and "Coming soon" -- never a number, and nothing in dashboard.js
        calculates one. (Service Reminders being connected does not change
        the Dashboard.)
     3. No CRM page is still a placeholder: every sidebar entry is one of
        the connected pages checked below.
     4. Service Reminders shares the same <head>, keeps its layout, starts in
        a loading state with every control disabled, and loads exactly one
        page script of its own. Its behaviour is tested in
        crm-reminders.test.cjs.
     5. Customer Follow-up shares the same <head>, starts in a loading state
        with every control (and its one static button) disabled, loads
        exactly one page script of its own, and that script reads no browser
        storage and writes only follow-ups through the database. Its
        behaviour is tested in crm-follow-up.test.cjs.
     6. Service History shares the same <head>, keeps its layout (status
        filter, From / To range, ten columns, four cards), starts in a
        loading state with every control disabled, loads exactly one page
        script of its own, and that script reads no browser storage, makes no
        requests and writes nothing. Its behaviour is tested in
        crm-history.test.cjs.
     7. Follow-up Tasks shares the same <head>, keeps its layout (status,
        priority, staff and due-by filters, seven columns, four cards, two
        colour keys), starts in a loading state with every control disabled,
        loads exactly one page script of its own, and that script reads no
        browser storage and writes only tasks through the database. Its
        behaviour is tested in crm-tasks.test.cjs.
     8. CRM Reports shares the same <head>, keeps its layout (period select,
        From / To range, four cards, the chart and the details list with its
        two tabs), starts in a loading state with every control disabled,
        loads exactly one page script of its own, and that script reads no
        browser storage, makes no requests of its own (follow-ups only through
        Storage.load) and writes nothing. Its behaviour is tested in
        crm-reports.test.cjs.

   Drives the REAL js/app.js through the shared harness. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ENTRIES = [
  ['crm-reminders', 'Service Reminders', 'pages/crm-reminders.html'],
  ['crm-follow-up', 'Customer Follow-up', 'pages/crm-follow-up.html'],
  ['crm-history', 'Service History', 'pages/crm-history.html'],
  ['crm-tasks', 'Follow-up Tasks', 'pages/crm-tasks.html'],
  ['crm-reports', 'CRM Reports', 'pages/crm-reports.html'],
];

/* Service Reminders is connected; its layout is checked in section 4. */
const REMINDERS = {
  options: [['all', 'All statuses'], ['Upcoming', 'Upcoming'], ['Due Today', 'Due Today'], ['Overdue', 'Overdue']],
  cols: ['Customer', 'Vehicle', 'Registration Number', 'Last Service', 'Next Service Due', 'Status', 'Actions'],
  cards: ['Upcoming Services', 'Due Today', 'Overdue Services', 'Customers Requiring Follow-up'],
};
// Pages that are connected to the database and tested on their own below.
const CONNECTED = ['crm-reminders', 'crm-follow-up', 'crm-history', 'crm-tasks', 'crm-reports'];
const PLACEHOLDERS = ENTRIES.filter(([key]) => !CONNECTED.includes(key));

/* Service History is connected; its layout is checked in section 6. */
const HISTORY = {
  options: [['all', 'All Statuses'], ['completed', 'Completed'], ['pending', 'Pending'], ['cancelled', 'Cancelled']],
  cols: ['Service Date', 'Customer', 'Vehicle', 'Registration Number', 'Job Card', 'Services Performed',
    'Mileage', 'Total Cost', 'Status', 'Actions'],
  cards: [['crhVisits', 'Total Service Visits'], ['crhCompleted', 'Completed Services'],
    ['crhPending', 'Pending Services'], ['crhCost', 'Total Service Cost']],
};


/** Render the shell for one page; return the sidebar HTML the shell wrote. */
function shellFor(page, root = '', sessionHint = null) {
  const session = new Map(sessionHint ? [['taqwa_nav_crm_open', sessionHint]] : []);
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)) };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const crmBlock = html => (html.match(/<details class="nav__group[^"]*" id="navCrm"[\s\S]*?<\/details>/) || [''])[0];

console.log('=== crm-ui: Customer CRM ===\n');

/* ---------- 1. sidebar ---------- */
console.log('-- 1. sidebar --');
{
  const html = shellFor('dashboard');
  const block = crmBlock(html);
  ok('the sidebar has a Customer CRM group', /<span>Customer CRM<\/span>/.test(block), block.slice(0, 200));
  const iExp = html.indexOf('pages/expenses.html'), iCrm = html.indexOf('id="navCrm"'), iRep = html.indexOf('pages/reports.html');
  ok('   ...placed after Expenses and before Reports', iExp > -1 && iExp < iCrm && iCrm < iRep, JSON.stringify({ iExp, iCrm, iRep }));
  const links = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map(m => [m[1], m[2]]);
  check('   ...with the five entries, in order', links, ENTRIES.map(([, label, href]) => [href, label]));
  ok('   ...each linking to a page that exists', ENTRIES.every(([, , href]) => fs.existsSync(path.join(ROOT, href))), '');
  ok('   ...a native <details>, so it opens from the keyboard', /^<details[\s\S]*<summary class="nav__summary">/.test(block), '');
  ok('   ...with an expand/collapse chevron', /<svg class="nav__chevron"/.test(block), '');
  ok('   ...closed by default on a non-CRM page, with nothing marked active',
    !/ open>/.test(block.slice(0, block.indexOf('>') + 1) + '>') && !/is-active|aria-current|has-active/.test(block), block.slice(0, 120));
  ok('existing navigation is all still there (Dashboard ... Settings, Social Inbox)',
    ['index.html', 'pages/customers.html', 'pages/vehicles.html', 'pages/appointments.html', 'pages/job-cards.html', 'pages/services.html',
      'pages/mechanics.html', 'pages/inventory.html', 'pages/invoices.html', 'pages/payments.html', 'pages/expenses.html', 'pages/reports.html',
      'pages/settings.html'].every(h => html.includes(`href="${h}"`)) && /id="navInbox"/.test(html), '');
}
{
  const block = crmBlock(shellFor('dashboard', '', '1'));
  ok('a group the user left open stays open on the next page', /^<details class="nav__group" id="navCrm" open>/.test(block), block.slice(0, 80));
}
for (const [key, label, href] of ENTRIES) {
  const html = shellFor(key, '../');
  const block = crmBlock(html);
  const active = [...block.matchAll(/<a class="nav__sub is-active" href="([^"]+)" aria-current="page">/g)].map(m => m[1]);
  ok(`on ${label}: the group is open and marked, and only its entry is active`,
    /^<details class="nav__group has-active" id="navCrm" open>/.test(block) && active.length === 1 && active[0] === `../${href}`,
    JSON.stringify({ head: block.slice(0, 70), active }));
  ok(`   ...and the header title reads "${label}"`, html.includes(`<h1>${label}</h1>`), '');
  ok('   ...while no top-level link claims to be active', !/class="nav__link is-active"/.test(html), '');
}

/* ---------- 2. dashboard overview ---------- */
console.log('\n-- 2. dashboard CRM overview --');
const index = read('index.html');
const overview = (index.match(/<section class="card crm-overview"[\s\S]*?<\/section>/) || [''])[0];
ok('the Dashboard has a Customer CRM Overview section', /<h2 id="crmOverviewTitle">Customer CRM Overview<\/h2>/.test(overview), '');
ok('   ...between the KPI cards and Revenue Overview',
  index.indexOf('id="statsGrid"') < index.indexOf('crm-overview') && index.indexOf('crm-overview') < index.indexOf('Revenue Overview'), '');
const cards = [...overview.matchAll(/<a class="crm-card crm-card--\w+" href="([^"]+)">[\s\S]*?<span class="crm-card__title">([^<]+)<\/span>[\s\S]*?<span class="crm-card__value">([\s\S]*?)<\/span><span class="crm-card__soon">([^<]+)<\/span>/g)]
  .map(m => ({ href: m[1], title: m[2], value: m[3], soon: m[4] }));
check('   ...with the four cards', cards.map(c => c.title), ['Upcoming Reminders', 'Overdue Services', 'Customers to Follow Up', 'Vehicles Due for Service']);
ok('   ...each showing a "—" placeholder and "Coming soon", never a number',
  cards.length === 4 && cards.every(c => c.value === '<span aria-hidden="true">—</span>' && c.soon === 'Coming soon'), JSON.stringify(cards));
ok('   ...with no digit anywhere in the section\'s visible text',
  !/\d/.test(overview.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ')), '');
ok('   ...each card opening a CRM page that exists', cards.every(c => fs.existsSync(path.join(ROOT, c.href))), JSON.stringify(cards.map(c => c.href)));
ok('   ...and saying nothing is calculated or sent yet', /Nothing is calculated or sent yet\./.test(overview), '');
const dash = read('js/dashboard.js');
ok('dashboard.js does not compute anything for the CRM (untouched)', !/crm|nextServiceDate|follow/i.test(dash), '');
ok('the existing Dashboard sections are all still there',
  ['id="statsGrid"', 'Revenue Overview', 'id="revChart"', "Today's Appointments", 'id="apptList"', 'Recent Service Jobs', 'id="recentJobsBody"']
    .every(s => index.includes(s)), '');

/* ---------- 3. placeholder pages ---------- */
console.log('\n-- 3. no placeholder pages left --');
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'));
check('no CRM page is still a placeholder', PLACEHOLDERS.map(([key]) => key), []);

/* ---------- 4. Service Reminders (connected) ---------- */
console.log('\n-- 4. Service Reminders --');
{
  const html = read('pages/crm-reminders.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Service Reminders: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Service Reminders — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-reminders.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-reminders" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon"', !/Coming soon|activated in a future release/.test(body), '');
  ok('   ...has no form, textarea, static button or inline handler (actions are rendered from data)',
    !/<form|<textarea|<button|\son[a-z]+=/i.test(body), '');
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box, a status filter and a due-by date, all disabled until the reminders load',
    controls.length === 3 && /type="search"/.test(controls[0]) && controls[1].startsWith('<select') && /type="date"/.test(controls[2])
      && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  check('   ...the status filter offers All / Upcoming / Due Today / Overdue, by value',
    [...body.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]), REMINDERS.options);
  ok('   ...with no option pre-selected', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the reminder table keeps its columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]), REMINDERS.cols);
  const rows = [...body.matchAll(/<tbody id="crrBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="crr-empty-row">\s*<td colspan="7">/.test(rows[0]) && /Loading service reminders/.test(rows[0]), '');
  const stats = [...body.matchAll(/<div class="stat__value"( id="\w+")?>([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>\s*<div class="(crr-sub|crr-pending)"( id="\w+")?>([^<]+)<\/div>/g)]
    .map(m => ({ id: (m[1] || '').trim(), value: m[2], label: m[3], kind: m[4], note: m[6] }));
  check('   ...four summary cards', stats.map(x => x.label), REMINDERS.cards);
  check('   ...the first three wired by id', stats.slice(0, 3).map(x => x.id), ['id="crrUpcoming"', 'id="crrDueToday"', 'id="crrOverdue"']);
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...and "Customers Requiring Follow-up" stays "Not yet connected" (no follow-up data exists)',
    stats[3] && stats[3].kind === 'crr-pending' && stats[3].note === 'Not yet connected'
      && /<div class="stat crr-stat crr-stat--pending">/.test(body), JSON.stringify(stats[3]));
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-reminders.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-reminders.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-reminders"]'))), '');
  const js = read('js/crm-reminders.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...writes nothing: no Storage write, seed or reset call',
    !/Storage\.(create|update|remove|action|addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings)\b/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

/* ---------- 5. Customer Follow-up (connected) ---------- */
console.log('\n-- 5. Customer Follow-up --');
{
  const html = read('pages/crm-follow-up.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Customer Follow-up: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Customer Follow-up — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-follow-up.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-follow-up" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon" or "not yet connected"', !/Coming soon|future release|not yet connected/i.test(body), '');
  ok('   ...has no form, textarea or inline handler (dialogs are rendered by the page module)',
    !/<form|<textarea|\son[a-z]+=/i.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  ok('   ...exactly one static button, "New Follow-up", type="button" and disabled until the data loads',
    buttons.length === 1 && /id="crfNew"/.test(buttons[0]) && /type="button"/.test(buttons[0]) && /\sdisabled\b/.test(buttons[0]),
    JSON.stringify(buttons));
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box and three filters (status, due date, priority), all disabled until the data loads',
    controls.length === 4 && /type="search"/.test(controls[0]) && controls.slice(1).every(c => c.startsWith('<select'))
      && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  const selects = [...body.matchAll(/<select[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)]
    .map(m => [m[1], [...m[2].matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(o => [o[1], o[2]])]);
  check('   ...the filters offer exactly these values', selects, [
    ['crfStatus', [['open', 'Open'], ['all', 'All statuses'], ['Completed', 'Completed'], ['Cancelled', 'Cancelled']]],
    ['crfDue', [['any', 'Any due date'], ['today', 'Due today'], ['overdue', 'Overdue']]],
    ['crfPriority', [['all', 'All priorities'], ['high', 'High'], ['normal', 'Normal']]],
  ]);
  ok('   ...with no option pre-selected (Open is first, so it is the default)', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the follow-up table has its columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]),
    ['Customer', 'Vehicle', 'Follow-up Reason', 'Priority', 'Due Date', 'Status', 'Last Contact', 'Actions']);
  const rows = [...body.matchAll(/<tbody id="crfBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="crf-empty-row">\s*<td colspan="8">/.test(rows[0]) && /Loading follow-ups/.test(rows[0]), '');
  const stats = [...body.matchAll(/<div class="stat__value" id="(\w+)">([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>/g)]
    .map(m => ({ id: m[1], value: m[2], label: m[3] }));
  check('   ...four summary cards, labelled as Open counts and wired by id', stats.map(x => [x.id, x.label]),
    [['crfTotal', 'Open Follow-ups'], ['crfDueToday', 'Due Today'], ['crfContacted', 'Contacted'], ['crfOverdue', 'Overdue']]);
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-follow-up.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-follow-up.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-follow-up"]'))), '');
  const js = read('js/crm-follow-up.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...never seeds, resets or writes browser storage',
    !/Storage\.(addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings|remove)\b/.test(js), '');
  const writes = [...js.matchAll(/Storage\.(create|update|action)\('(\w+)'/g)].map(m => m[2]);
  ok('   ...and writes only follow-ups and their contacts, through the database',
    writes.length > 0 && writes.every(c => c === 'followUps' || c === 'followUpContacts'), JSON.stringify(writes));
  ok('   ...never makes a key with Math.random', !/Math\.random/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

/* ---------- 6. Service History (connected) ---------- */
console.log('\n-- 6. Service History --');
{
  const html = read('pages/crm-history.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Service History: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Service History — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-history.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-history" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon" or "not yet connected"', !/Coming soon|future release|not yet connected/i.test(body), '');
  ok('   ...has no form, textarea or inline handler (rows and messages are rendered by the page module)',
    !/<form|<textarea|\son[a-z]+=/i.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  check('   ...three static buttons: Clear filters, Previous, Next', buttons.map(b => (b.match(/id="(\w+)"/) || [])[1]), ['crhClear', 'crhPrev', 'crhNext']);
  ok('   ...each type="button" and disabled until the data loads',
    buttons.every(b => /type="button"/.test(b) && /\sdisabled\b/.test(b)), JSON.stringify(buttons));
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box, a status filter and a From / To range, all disabled until the data loads',
    controls.length === 4 && /type="search"/.test(controls[0]) && controls[1].startsWith('<select')
      && controls.slice(2).every(c => /type="date"/.test(c)) && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  ok('   ...and the date range tied to its inline error message',
    controls.slice(2).every(c => /aria-describedby="crhRangeError"/.test(c)) && /<p class="crh-range-error" id="crhRangeError" role="alert" hidden><\/p>/.test(body), '');
  check('   ...the status filter offers All / Completed / Pending / Cancelled, by value',
    [...body.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]), HISTORY.options);
  ok('   ...with no option pre-selected', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the service records table keeps its ten columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]), HISTORY.cols);
  const rows = [...body.matchAll(/<tbody id="crhBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="crh-empty-row">\s*<td colspan="10">/.test(rows[0]) && /Loading service history/.test(rows[0]), '');
  const stats = [...body.matchAll(/<div class="stat__value" id="(\w+)">([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>\s*<div class="crh-sub" id="(\w+)">([^<]+)<\/div>/g)]
    .map(m => ({ id: m[1], value: m[2], label: m[3], sub: m[4] }));
  check('   ...four summary cards, wired by id', stats.map(x => [x.id, x.label]), HISTORY.cards);
  ok('   ...each with its own note line', stats.every(x => x.sub === `${x.id}Sub`), JSON.stringify(stats));
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...a hidden, empty timeline panel and a hidden pager',
    /<section class="card crh-timeline" id="crhTimeline" aria-labelledby="crhTimelineTitle" hidden><\/section>/.test(body)
      && /<nav class="crh-pager" id="crhPager" aria-label="Service records pages" hidden>/.test(body), '');
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-history.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-history.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-history"]'))), '');
  const js = read('js/crm-history.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...writes nothing: no Storage write, seed or reset call',
    !/Storage\.(create|update|remove|action|addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings)\b/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

/* ---------- 7. Follow-up Tasks (connected) ---------- */
console.log('\n-- 7. Follow-up Tasks --');
{
  const html = read('pages/crm-tasks.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('Follow-up Tasks: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>Follow-up Tasks — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-tasks.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-tasks" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon" or "not yet connected"', !/Coming soon|future release|not yet connected/i.test(body), '');
  ok('   ...has no form, textarea or inline handler (rows and dialogs are rendered by the page module)',
    !/<form|<textarea|\son[a-z]+=/i.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  check('   ...four static buttons: New Task, Clear filters, Previous, Next', buttons.map(b => (b.match(/id="(\w+)"/) || [])[1]),
    ['ctkNew', 'ctkClear', 'ctkPrev', 'ctkNext']);
  ok('   ...each type="button" and disabled until the data loads',
    buttons.every(b => /type="button"/.test(b) && /\sdisabled\b/.test(b)), JSON.stringify(buttons));
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a search box, three filters (status, priority, staff) and a due-by date, all disabled until the data loads',
    controls.length === 5 && /type="search"/.test(controls[0]) && controls.slice(1, 4).every(c => c.startsWith('<select'))
      && /type="date"/.test(controls[4]) && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  const selects = [...body.matchAll(/<select[^>]*id="(\w+)"[^>]*>([\s\S]*?)<\/select>/g)]
    .map(m => [m[1], [...m[2].matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)].map(o => [o[1], o[2]])]);
  check('   ...the filters offer exactly these values (staff names are added from the database)', selects, [
    ['ctkStatus', [['all', 'All Statuses'], ['Pending', 'Pending'], ['In Progress', 'In Progress'], ['Completed', 'Completed'], ['overdue', 'Overdue'], ['Cancelled', 'Cancelled']]],
    ['ctkPriority', [['all', 'All Priorities'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['urgent', 'Urgent']]],
    ['ctkStaff', [['all', 'All Staff'], ['none', 'Unassigned']]],
  ]);
  ok('   ...with no option pre-selected', !/<option[^>]*\sselected/.test(body), '');
  check('   ...the task table keeps its seven columns', [...body.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]),
    ['Task', 'Customer / Vehicle', 'Assigned To', 'Priority', 'Due Date', 'Status', 'Actions']);
  const rows = [...body.matchAll(/<tbody id="ctkBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...and starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1
      && /<tr class="ctk-empty-row">\s*<td colspan="7">/.test(rows[0]) && /Loading tasks/.test(rows[0]), '');
  for (const [name, keys] of Object.entries({
    'Status colours': [['neutral', 'Pending'], ['info', 'In Progress'], ['good', 'Completed'], ['bad', 'Overdue']],
    'Priority colours': [['neutral', 'Low'], ['info', 'Medium'], ['warn', 'High'], ['bad', 'Urgent']],
  })) {
    const list = (body.match(new RegExp(`<ul class="ctk-legend" aria-label="${name}">([\\s\\S]*?)<\\/ul>`)) || [])[1] || '';
    check(`   ...a ${name.toLowerCase()} key in the app's tones`,
      [...list.matchAll(/<span class="badge badge--(\w+)">([^<]+)<\/span>/g)].map(m => [m[1], m[2]]), keys);
  }
  const stats = [...body.matchAll(/<div class="stat__value" id="(\w+)">([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>\s*<div class="ctk-sub" id="(\w+)">([^<]+)<\/div>/g)]
    .map(m => ({ id: m[1], value: m[2], label: m[3], sub: m[4] }));
  check('   ...four summary cards, wired by id', stats.map(x => [x.id, x.label]),
    [['ctkTotal', 'Total Tasks'], ['ctkDueToday', 'Due Today'], ['ctkOverdue', 'Overdue Tasks'], ['ctkCompleted', 'Completed Tasks']]);
  ok('   ...each with its own note line', stats.every(x => x.sub === `${x.id}Sub`), JSON.stringify(stats));
  ok('   ...all four start as a "—", never a number',
    stats.length === 4 && stats.every(x => x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...and a hidden pager', /<nav class="ctk-pager" id="ctkPager" aria-label="Task list pages" hidden>/.test(body), '');
  ok('   ...with no digit anywhere in the static visible text',
    !/\d/.test(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '')
      .replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, ' ')), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-tasks.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-tasks.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-tasks"]'))), '');
  const js = read('js/crm-tasks.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest/.test(js), '');
  ok('   ...never seeds, resets or writes browser storage',
    !/Storage\.(addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings|remove)\b/.test(js), '');
  const writes = [...js.matchAll(/Storage\.(create|update|action)\('(\w+)'/g)].map(m => m[2]);
  ok('   ...and writes only follow-up tasks, through the database',
    writes.length > 0 && writes.every(c => c === 'followUpTasks'), JSON.stringify(writes));
  ok('   ...never makes a key with Math.random', !/Math\.random/.test(js), '');
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

/* ---------- 8. CRM Reports (connected) ---------- */
console.log('\n-- 8. CRM Reports --');
{
  const html = read('pages/crm-reports.html');
  const body = html.slice(html.indexOf('<body data-page='));
  check('CRM Reports: <head> is the Settings head with only the title and its stylesheet changed', head(html),
    settingsHead.replace('<title>Settings — ', '<title>CRM Reports — ')
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/crm-reports.css">'));
  ok('   ...declares its own page key', body.startsWith('<body data-page="crm-reports" data-root="../">'), body.slice(0, 60));
  ok('   ...no longer claims to be "Coming soon" or "not yet connected"', !/Coming soon|future release|not yet connected/i.test(body), '');
  ok('   ...has no form, textarea or inline handler (rows are rendered by the page module)', !/<form|<textarea|\son[a-z]+=/i.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  check('   ...six static buttons: the two tabs, Clear filters, Export CSV, Previous, Next', buttons.map(b => (b.match(/id="(\w+)"/) || [])[1]),
    ['crpTabVisits', 'crpTabFollowUps', 'crpClear', 'crpExport', 'crpPrev', 'crpNext']);
  ok('   ...each type="button" and disabled until the data loads', buttons.every(b => /type="button"/.test(b) && /\sdisabled\b/.test(b)), JSON.stringify(buttons));
  ok('   ...the tabs are a labelled tablist controlling one panel',
    /<div class="crp-tabs" role="tablist" aria-label="Activity details">/.test(body) && (body.match(/role="tab" aria-selected="(true|false)" aria-controls="crpPanel"/g) || []).length === 2
      && /id="crpPanel" role="tabpanel"/.test(body), '');
  const controls = [...body.matchAll(/<(input|select)\b[^>]*>/g)].map(m => m[0]);
  ok('   ...a period select, a From / To range, a search box and a status filter, all disabled until the data loads',
    controls.length === 5 && controls[0].startsWith('<select') && /type="date"/.test(controls[1]) && /type="date"/.test(controls[2])
      && /type="search"/.test(controls[3]) && controls[4].startsWith('<select') && controls.every(c => /\sdisabled\b/.test(c)), JSON.stringify(controls));
  ok('   ...each control with an accessible label', controls.every(c => /\saria-label="[^"]+"/.test(c)), JSON.stringify(controls));
  ok('   ...the date range tied to its inline error message',
    controls.slice(1, 3).every(c => /aria-describedby="crpRangeError"/.test(c)) && /<p class="crp-range-error" id="crpRangeError" role="alert" hidden><\/p>/.test(body), '');
  const period = (body.match(/<select[^>]*id="crpPeriodKind"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || '';
  check('   ...the period select offers the four periods by value, Last 30 days pre-selected',
    [...period.matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)].map(m => [m[1], !!m[2], m[3]]),
    [['last7', false, 'Last 7 days'], ['last30', true, 'Last 30 days'], ['month', false, 'This month'], ['custom', false, 'Custom range']]);
  const stats = [...body.matchAll(/<div class="stat__value" id="(\w+)">([\s\S]*?)<\/div>\s*<div class="stat__label">([^<]+)<\/div>\s*<div class="crp-sub" id="(\w+)">([^<]+)<\/div>/g)]
    .map(m => ({ id: m[1], value: m[2], label: m[3], sub: m[4] }));
  check('   ...four summary cards, wired by id, with Open Follow-ups (not "Pending")', stats.map(x => [x.id, x.label]),
    [['crpReminders', 'Service Reminders Due'], ['crpOpen', 'Open Follow-ups'], ['crpCompleted', 'Completed Follow-ups'], ['crpReturning', 'Returning Customers']]);
  ok('   ...each with its own note line, all four starting as a "—"',
    stats.length === 4 && stats.every(x => x.sub === `${x.id}Sub` && x.value === '<span aria-hidden="true">&#8212;</span>'), JSON.stringify(stats));
  ok('   ...the chart key lists only series the data supports (no reminders series)',
    !/Reminders due/.test((body.match(/<ul class="crp-key"[\s\S]*?<\/ul>/) || [''])[0]), '');
  ok('   ...a hidden chart-as-table alternative and a hidden pager',
    /<details class="crp-chart__data" id="crpChartData" hidden>/.test(body) && /<nav class="crp-pager" id="crpPager" aria-label="Activity details pages" hidden>/.test(body), '');
  const rows = [...body.matchAll(/<tbody id="crpBody">([\s\S]*?)<\/tbody>/g)].map(m => m[1]);
  ok('   ...the details table starts with one loading row, no data rows',
    rows.length === 1 && (rows[0].match(/<tr\b/g) || []).length === 1 && /<tr class="crp-empty-row">\s*<td colspan="6">/.test(rows[0]) && /Loading CRM activity/.test(rows[0]), '');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus its own page module, last', scripts,
    ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/crm-reports.js']);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...whose stylesheet is scoped to this page alone',
    read('css/crm-reports.css').replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.trim()).filter(Boolean)
      .every(r => r.replace(/^@media[^{]*\{/, '').trim().split('{')[0].split(',').every(sel => sel.trim().startsWith('[data-page="crm-reports"]'))), '');
  const js = read('js/crm-reports.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('the page module reads no browser storage and makes no requests of its own',
    !/localStorage|sessionStorage|fetch\(|Api\.|XMLHttpRequest|https?:/.test(js), '');
  ok('   ...writes nothing: no Storage write, seed or reset call',
    !/Storage\.(create|update|remove|action|addData|updateData|deleteData|saveData|seedIfEmpty|resetToSeedData|putSettings|saveSettings)\b/.test(js), '');
  const loads = [...js.matchAll(/Storage\.load\('(\w+)'\)/g)].map(m => m[1]);
  check('   ...and loads only the follow-ups on demand', loads, ['followUps']);
  ok('   ...and sends nothing (no SMS, WhatsApp or email links)', !/sms:|mailto:|wa\.me|whatsapp/i.test(js), '');
}

process.exit(summary('CRM UI unit') === 0 ? 0 : 1);
