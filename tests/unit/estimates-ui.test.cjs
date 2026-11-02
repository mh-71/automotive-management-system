/* estimates-ui — Estimates & Quotations: the real, database-backed staff pages
   (Overview, New / Edit Estimate, Estimate Details) and js/estimates.js.

   What must hold:
     1. The sidebar has an "Estimates & Quotations" link right after Job Cards;
        on the three pages it is the only active link and the header reads
        "Estimates & Quotations".
     2. Every Estimates page shares the Settings <head> (title and the
        estimates stylesheet aside), declares data-page="estimates" and its
        view, loads exactly the shared shell scripts plus js/estimates.js, has
        no form / file / password input, inline handler or inline script, and
        every button is type="button". No demo notice, demo record or demo
        number is left anywhere, and js/estimates-demo.js is gone.
     3. js/estimates.js reads and writes estimates only through Storage
        (load / loadOne / create / update / action), never browser storage,
        cookies, IndexedDB or the network directly; it escapes every piece of
        record text it puts into HTML; Print opens the browser's dialog only.
     4. Storage treats `estimates` as API_ONLY: loaded on demand, refused
        outside 'api' mode, never part of hydration, never kept locally.
     5. The pure logic is right: the preview totals are the Job Card page's
        computeTotals() exactly, the summary cards, search, filters and paging,
        the actions each status offers, form validation and the request body,
        and the once-per-submission idempotency key.
     6. css/estimates.css reaches the Estimates pages only.

   Drives the REAL js/app.js and js/storage.js through the shared harness;
   js/estimates.js is loaded on its own with no page, which runs none of its
   rendering. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PAGES = [
  ['estimates', 'overview', 'Estimates &amp; Quotations'],
  ['estimate-create', 'create', 'New Estimate'],
  ['estimate-details', 'details', 'Estimate Details'],
];

/** Render the shell for one page; return the HTML the shell wrote. */
function shellFor(page, root = '') {
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: () => null, setItem() {} };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const topLinks = html => [...html.matchAll(/<a class="nav__link( is-active)?" href="([^"]+)">[\s\S]*?<span>([^<]+)<\/span><\/a>/g)]
  .map(m => ({ active: !!m[1], href: m[2], label: m[3] }));

console.log('=== estimates-ui: Estimates & Quotations staff pages ===\n');

/* ---------- 1. sidebar and header ---------- */
console.log('-- 1. sidebar --');
{
  const html = shellFor('dashboard');
  check('the top-level links, in order (Estimates & Quotations right after Job Cards)', topLinks(html).map(l => l.label),
    ['Dashboard', 'Customers', 'Vehicles', 'Appointments', 'Job Cards', 'Estimates & Quotations', 'Services', 'Mechanics',
      'Inventory', 'Invoices', 'Payments', 'Expenses', 'Reports', 'Settings']);
  const est = topLinks(html).find(l => l.label === 'Estimates & Quotations');
  ok('   ...linking to the Overview page, not active elsewhere', est && est.href === 'pages/estimates.html' && !est.active, JSON.stringify(est));
  const on = shellFor('estimates', '../');
  check('on an Estimates page only the Estimates link is active', topLinks(on).filter(l => l.active).map(l => l.href), ['../pages/estimates.html']);
  ok('   ...and the header reads "Estimates & Quotations"', on.includes('<h1>Estimates & Quotations</h1>'), '');
}

/* ---------- 2. the pages ---------- */
console.log('\n-- 2. the pages --');
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'));
const SCRIPTS = ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/estimates.js'];
const bodies = {};
for (const [file, view, title] of PAGES) {
  const html = read(`pages/${file}.html`);
  const body = html.slice(html.indexOf('<body data-page='));
  bodies[view] = body;
  check(`${file}: <head> is the Settings head with only the title and the estimates stylesheet changed`, head(html),
    settingsHead.replace('<title>Settings — ', `<title>${title} — `)
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/estimates.css">'));
  ok('   ...declares the estimates page key and its view',
    body.startsWith('<body data-page="estimates" data-root="../">') && body.includes(`<div id="page-content" data-est-view="${view}">`), body.slice(0, 80));
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  check('   ...loads the shared shell scripts plus js/estimates.js, last', scripts, SCRIPTS);
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...has no form, file input or password input', !/<form\b|type="file"|type="password"/i.test(body), '');
  ok('   ...has no inline handler and no inline script in the body', !/\son[a-z]+=/i.test(html) && !/<script>/.test(body), '');
  const buttons = body.match(/<button\b[^>]*>/g) || [];
  ok('   ...every button is type="button"', buttons.every(b => /\stype="button"/.test(b)), JSON.stringify(buttons.filter(b => !/type="button"/.test(b))));
  ok('   ...no demo notice, demo record, demo number or "Demo" badge is left', !/DEMO|Demo Customer|EST-DEMO|badge--neutral">Demo</.test(body), '');
  ok('   ...says "Tax", never "VAT"', !/\bVAT\b/.test(body), '');
  if (view !== 'overview') {
    ok('   ...has a breadcrumb back to the Overview', body.includes('<li><a href="estimates.html">Estimates &amp; Quotations</a></li>'), '');
  }
}
{
  const o = bodies.overview;
  ok('Overview: six summary cards, search, status and date filters, table and pager',
    ['estTotal', 'estPending', 'estApproved', 'estRejected', 'estExpired', 'estPendingValue', 'estSearch', 'estStatus', 'estFrom', 'estTo',
      'estClear', 'estBody', 'estPrev', 'estNext', 'estRange'].every(id => o.includes(`id="${id}"`)), '');
  check('   ...every status, stored or derived, can be filtered', [...o.matchAll(/<option value="([^"]+)">/g)].map(m => m[1]),
    ['all', 'Draft', 'Pending', 'Expired', 'Approved', 'Converted', 'Rejected', 'Cancelled']);
  ok('   ...the table starts in a loading state, not with sample rows', /Loading estimates/.test(o) && !/EST-\d/.test(o), '');
  const c = bodies.create;
  ok('Create/Edit: customer search, customer, vehicle, dates, description, notes, both line tables, labour, discount, tax and name',
    ['estCustomerSearch', 'estCustomer', 'estVehicle', 'estDate', 'estValid', 'estDescription', 'estNotes', 'estServiceRows', 'estPartRows',
      'estAddService', 'estAddPart', 'estLabourHours', 'estLabourRate', 'estLabourCost', 'estDiscType', 'estDiscValue', 'estTax', 'estBy',
      'estSaveDraft', 'estSaveSend', 'estEditNotice', 'estFormNotice'].every(id => c.includes(`id="${id}"`)), '');
  ok('   ...every server field has a place to show its error',
    ['customerId', 'vehicleId', 'date', 'validUntil', 'complaint', 'notes', 'services', 'partsUsed', 'labourHours', 'labourRate',
      'labourCost', 'discount', 'discountRate', 'taxRate', 'createdBy', 'updatedBy'].every(k => c.includes(`data-err="${k}"`)), '');
  ok('   ...says the name is not a verified identity, and stock is not reserved',
    /not a verified identity/.test(c) && /not reserved or deducted/.test(c), '');
  const d = bodies.details;
  ok('Details: header, actions, print, quotation sheet, status, breakdown and history',
    ['estDetailId', 'estDetailStatus', 'estDetailVersion', 'estDetailValidity', 'estDetailActions', 'estPrint', 'estShBusiness',
      'estShNo', 'estShDate', 'estShValid', 'estShCustomer', 'estShVehicle', 'estShDesc', 'estShServices', 'estShParts', 'estShSummary',
      'estShTerms', 'estDecision', 'estBreakdown', 'estHistory', 'estStateNotice'].every(id => d.includes(`id="${id}"`)), '');
  ok('   ...the sheet is titled a quotation / estimate and says it is not an invoice',
    d.includes('<h3>QUOTATION / ESTIMATE</h3>') && d.includes('<footer class="est-sheet__foot">Quotation / Estimate &#8212; not an invoice.</footer>'), '');
  ok('   ...the history says names are not verified identities', /not verified identities/.test(d), '');
}
ok('js/estimates-demo.js and its test are gone', !fs.existsSync(path.join(ROOT, 'js/estimates-demo.js')) && !fs.existsSync(path.join(ROOT, 'tests/unit/estimates-demo-ui.test.cjs')), '');
ok('   ...and no page or script refers to them', ![...fs.readdirSync(path.join(ROOT, 'pages')).map(f => `pages/${f}`), ...fs.readdirSync(path.join(ROOT, 'js')).map(f => `js/${f}`)]
  .some(f => /estimates-demo/.test(read(f))), '');

/* ---------- 3. the page script ---------- */
console.log('\n-- 3. js/estimates.js --');
const src = read('js/estimates.js');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
check('it never reaches browser storage, cookies, IndexedDB or the network directly',
  ['fetch(', 'XMLHttpRequest', 'Api.', 'localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'sendBeacon', 'WebSocket',
    'eval(', 'new Function', 'document.write'].filter(t => code.includes(t)), []);
ok('estimates are read and written only through Storage',
  /Storage\.load\('estimates'\)/.test(code) && /Storage\.loadOne\('estimates'/.test(code) && /Storage\.create\('estimates'/.test(code)
    && /Storage\.update\('estimates'/.test(code) && /Storage\.action\('estimates'/.test(code)
    && !/Storage\.(addData|updateData|saveData|deleteData|remove)\(/.test(code), '');
ok('it starts through Storage.ready() and shows nothing when signed out',
  /Storage\.ready\(start\)/.test(code) && /outcome\.mode === 'locked'\) return;/.test(code), '');
ok('without the database it says so instead of showing anything', /if \(!Storage\.isApi\(\)\)/.test(code) && /not connected to the workshop database/.test(code), '');
const printCalls = (code.match(/window\.print\(/g) || []).length;
ok('window.print() is called only by the Print button and the ?print=1 link',
  printCalls === 2 && /\$\('estPrint'\)\.addEventListener\('click', \(\) => window\.print\(\)\);/.test(code)
    && /get\('print'\) === '1'\) setTimeout\(\(\) => window\.print\(\), 300\)/.test(code), String(printCalls));
// Every template expression that prints record text INTO HTML goes through
// esc(): on each line that builds markup, the innermost ${...} naming a record
// field must be an esc() / money() / formatDay() call (text set through
// textContent, and Modal titles, which Utils.Modal escapes, are not markup).
const TEXT_FIELDS = /\.(name|complaint|notes|note|actor|decisionNote|decidedBy|cancelReason|regNo|phone|email|address|partNo|brand|model|businessName|paymentTerms|id|year|qty|message|jobCardId)\b/;
const unescaped = code.split('\n').filter(line => /<[a-z]/.test(line))
  .flatMap(line => [...line.matchAll(/\$\{([^{}]*)\}/g)].map(m => m[1].trim()))
  .filter(expr => (TEXT_FIELDS.test(expr) || /\b(customerName|vehicleText|terms)\(/.test(expr)) && !/^(esc|encodeURIComponent|money|formatDay|formatStamp|statusBadge)\(/.test(expr))
  // A comparison that prints a fixed attribute, or a numeric constant, is not record text.
  .filter(expr => !/^[\w.]+ === [\w.]+ \? ' selected' : ''$/.test(expr) && !/^LIMITS\.\w+$/.test(expr));
check('every piece of record text put into HTML is escaped', unescaped, []);
ok('the history and decisions label typed names as not verified',
  /name entered, not verified/.test(code) && /not verified/.test(code), '');
ok('staff-recorded approval is labelled as such, never as online approval',
  /Recorded by staff/.test(code) && /not as an online approval/.test(code), '');
ok('the send dialog says the system sends no message', /does not send any message/.test(code) && /No message was sent by the system/.test(code), '');

/* ---------- 4. Storage ---------- */
console.log('\n-- 4. js/storage.js --');
{
  const st = read('js/storage.js');
  ok('estimates is API_ONLY and mapped to /api/estimates', /const API_ONLY = \[[^\]]*'estimates'[^\]]*\]/.test(st) && /estimates: 'estimates'/.test(st), '');
  ok('   ...and is not in the hydrated COLLECTIONS', !/const COLLECTIONS = \[[^\]]*'estimates'/.test(st), '');
  const h = boot({ modules: [] });
  const res = { load: null, one: null };
  const Storage = h.ctx.Storage;
  Promise.all([Storage.load('estimates'), Storage.loadOne('estimates', 'EST-0001'), Storage.create('estimates', { a: 1 }), Storage.loadOne('customers', 'CUS-0001')])
    .then(([l, o, c, x]) => {
      check('outside api mode: load, loadOne and create are refused, nothing is kept locally',
        [l.ok, l.code, o.ok, o.code, c.ok, c.code, h.ctx.localStorage.getItem('taqwa_estimates')], [false, 'no_api', false, 'no_api', false, 'no_api', null]);
      check('loadOne is for on-demand collections only', [x.ok, x.code], [false, 'not_on_demand']);
      part5();
    });
}

/* ---------- 5. pure logic ---------- */
function part5() {
  console.log('\n-- 5. pure logic --');
  const ctx = { console, Math, JSON, Object, Array, String, Number, Set, Map, Date, Intl, URLSearchParams, Uint8Array };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nglobalThis.E = Estimates;`, ctx, { filename: 'js/estimates.js' });
  const E = ctx.E;

  /** The source of `function <name>(...) { ... }`, by brace matching. */
  function fnSource(text, name) {
    const start = text.indexOf(`function ${name}(`);
    let depth = 0;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
    }
    throw new Error(name);
  }
  const jc = {};
  const jcText = read('js/job-cards.js');
  vm.runInNewContext(`${fnSource(jcText, 'percentDiscount')}\n${fnSource(jcText, 'computeTotals')}\nthis.computeTotals = computeTotals;`, jc);
  check('the preview computeTotals() is the Job Card page\'s, character for character',
    fnSource(src, 'computeTotals'), fnSource(jcText, 'computeTotals'));
  let seed = 7;
  const rnd = n => { seed = (seed * 16807) % 2147483647; return seed % n; };
  let bad = 0;
  for (let i = 0; i < 2000; i++) {
    const job = {
      services: Array.from({ length: rnd(4) }, () => ({ qty: rnd(4) + 1, unitPrice: rnd(500000) / 100 })),
      partsUsed: Array.from({ length: rnd(4) }, () => ({ qty: rnd(5) + 1, unitPrice: rnd(900000) / 100 })),
      labourHours: rnd(9) / 2, labourRate: rnd(150000) / 100, labourCost: rnd(300000) / 100,
      discountType: rnd(2) ? 'percent' : 'amount', discount: rnd(100000) / 100, discountRate: rnd(10001) / 100, taxRate: rnd(4) * 2.5,
    };
    if (JSON.stringify(E.computeTotals(job)) !== JSON.stringify(jc.computeTotals(job))) bad++;
  }
  check('   ...and gives identical results on 2,000 random estimates', bad, 0);

  const L = (s, extra = {}) => ({ id: `EST-000${s.length}`, status: s, displayStatus: s, total: 100, date: '2026-10-10', customerId: 'C', vehicleId: 'V', complaint: 'Brakes', ...extra });
  const list = [L('Draft'), L('Pending', { total: 250.5 }), L('Pending', { displayStatus: 'Expired', isExpired: true }), L('Approved'),
    L('Approved', { displayStatus: 'Converted', isConverted: true }), L('Rejected'), L('Cancelled')];
  const s = E.summary(list);
  check('summary: total excludes cancelled; pending, approved (ready), rejected, expired; pending value counts live Pending only',
    [s.total, s.pending, s.approved, s.rejected, s.expired, s.drafts, s.converted, s.pendingValue], [6, 1, 1, 1, 1, 1, 1, 250.5]);
  const lk = { customer: () => ({ name: 'Rahim Uddin', phone: '01711-000001' }), vehicle: () => ({ regNo: 'DHA-11', brand: 'Toyota', model: 'Corolla' }) };
  check('filter: by derived status', E.filterList(list, { status: 'Expired' }, lk).length, 1);
  check('search: number, customer, phone, vehicle and work, case-insensitive',
    ['est-0005', 'RAHIM', '01711-000001', 'dha-11', 'corolla', 'brakes', 'nothing'].map(q => E.filterList(list, { q }, lk).length > 0),
    [true, true, true, true, true, true, false]);
  check('date range is inclusive', [E.filterList(list, { from: '2026-10-10', to: '2026-10-10' }, lk).length, E.filterList(list, { from: '2026-10-11' }, lk).length], [7, 0]);
  check('paging: 7 rows by 5, clamped', [E.paginate(list, 2, 5).rows.length, E.paginate(list, 9, 5).page, E.paginate([], 1, 5).from], [2, 2, 0]);

  check('actions: Draft can be edited, sent or cancelled', E.actionsFor(L('Draft')), ['edit', 'send', 'cancel']);
  check('actions: Pending can be edited, approved, rejected or cancelled', E.actionsFor(L('Pending')), ['edit', 'approve', 'reject', 'cancel']);
  check('actions: an expired Pending estimate cannot be approved', E.actionsFor(L('Pending', { isExpired: true })), ['edit', 'reject', 'cancel']);
  check('actions: Approved can be converted or cancelled', E.actionsFor(L('Approved')), ['convert', 'cancel']);
  check('actions: Converted only links to its job card', E.actionsFor(L('Approved', { isConverted: true, jobCardId: 'JOB-0001' })), ['jobcard']);
  check('actions: Rejected and Cancelled are final', [E.actionsFor(L('Rejected')), E.actionsFor(L('Cancelled'))], [[], []]);
  check('actions: nothing while a conversion is in progress', E.actionsFor(L('Approved', { conversionInProgress: true })), []);

  const base = {
    customerId: 'CUS-0001', vehicleId: 'VEH-0001', date: '2026-10-10', validUntil: '2026-11-09', complaint: 'Brakes', notes: '',
    services: [{ serviceId: 'SRV-0001', name: 'Brake service', qty: '1', unitPrice: '1500' }], partsUsed: [],
    labourHours: null, labourRate: null, labourCost: null, discountType: 'amount', discount: 0, discountRate: null, taxRate: 5, by: '',
  };
  check('validation: a complete form passes', Object.keys(E.validateForm(base)), []);
  check('validation: the server\'s field names', Object.keys(E.validateForm({ ...base, customerId: '', vehicleId: '', complaint: ' ' })).sort(), ['complaint', 'customerId', 'vehicleId']);
  check('validation: valid-until before the date', Object.keys(E.validateForm({ ...base, validUntil: '2026-10-01' })), ['validUntil']);
  check('validation: a discount above the subtotal', Object.keys(E.validateForm({ ...base, discount: 2000 })), ['discount']);
  check('validation: a negative or zero line', [Object.keys(E.validateForm({ ...base, services: [{ name: 'X', qty: '0', unitPrice: '1' }] })).includes('services'),
    Object.keys(E.validateForm({ ...base, services: [{ name: 'X', qty: '1', unitPrice: '-1' }] })).includes('services')], [true, true]);
  check('validation: no work at all', Object.keys(E.validateForm({ ...base, services: [] })), ['services']);
  const body = E.formBody({ ...base, discountType: 'percent', discountRate: 7.5, discount: 0, taxRate: null });
  check('request body: a percentage sends discountRate only, and an empty tax is left to the server (Settings default)',
    ['discountRate' in body, 'discount' in body, 'taxRate' in body, body.services[0].qty, body.services[0].unitPrice], [true, false, false, 1, 1500]);
  ok('request body: no figure the server owns is ever sent', !['subtotal', 'tax', 'total', 'status', 'version'].some(k => k in E.formBody(base)), '');

  const fakeCrypto = { randomUUID: () => 'k-0000000000000001' };
  const sub = E.createSubmission(fakeCrypto);
  const first = sub.body({ complaint: 'A' });
  sub.settle({ ok: false, code: 'network_error' });
  check('idempotency: one key per submission; after an ambiguous answer the payload is frozen',
    [first.idempotencyKey, sub.frozen, sub.body({ complaint: 'B' }).complaint], ['k-0000000000000001', true, 'A']);
  check('   ...a refused answer (422) is not ambiguous; a 5xx or timeout is', [E.isAmbiguous({ ok: false, status: 422 }), E.isAmbiguous({ ok: false, status: 503 }), E.isAmbiguous({ ok: false, code: 'timeout' })], [false, true, true]);
  check('dates: +30 days and day counts in calendar arithmetic', [E.addDays('2026-12-15', 30), E.daysBetween('2026-10-21', '2026-11-20'), E.VALIDITY_DAYS], ['2027-01-14', 30, 30]);
  check('dates: "today" is the Asia/Dhaka day (UTC 20:00 is already tomorrow)', E.dhakaToday(new Date('2026-10-20T20:00:00Z')), '2026-10-21');
  check('dates read as day, month, year', E.formatDay('2026-09-02'), '02 Sep 2026');

  part6();
}

/* ---------- 6. the stylesheet ---------- */
function part6() {
  console.log('\n-- 6. css/estimates.css --');
  const css = read('css/estimates.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = css.replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean)
    .flatMap(r => r.split('{')[0].split(/,(?![^(]*\))/).map(s => s.trim())).filter(Boolean);
  check('every rule is scoped to the Estimates pages', selectors.filter(sel => !sel.startsWith('[data-page="estimates"]')), []);
  ok('   ...no demo styling is left', !/est-demo|est-sheet__mark/.test(css), '');
  const loaders = needle => fs.readdirSync(path.join(ROOT, 'pages')).filter(f => read(`pages/${f}`).includes(needle)).sort().join('|');
  const own = PAGES.map(([f]) => `${f}.html`).sort().join('|');
  ok('   ...and only the three Estimates pages load it', loaders('../css/estimates.css') === own, loaders('../css/estimates.css'));
  ok('only the three Estimates pages load js/estimates.js', loaders('../js/estimates.js') === own, loaders('../js/estimates.js'));
  summary('estimates-ui');
}
