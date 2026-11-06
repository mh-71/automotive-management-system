/* asset-reports-ui — Workshop Assets › Asset Reports, the page.

   Loads the REAL js/asset-reports.js in Node. The figures are tested against
   the real Worker in api-asset-reports.test.mjs, and the page is driven in a
   real browser by the end-to-end script; here:

     1. Not a demo: no demo engine or stylesheet, no sample data, no Demo
        badge or banner; read only (GET only); same look (cards, toolbar,
        CSS bar charts); every stylesheet rule scoped; the shared demo
        engine and its stylesheet are unchanged and still on disk.
     2. The query: search, category, status, purchase dates, cost period.
     3. Cards and summary lines: server figures only; formulas stated.
     4. Charts: category distribution, Available vs In Use, empty data.
     5. Export: CSV columns, missing data stays "Not recorded", formulas
        neutralised, quotes escaped. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const escape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sandbox = { Utils: { esc: escape }, console, Intl, Date };
vm.createContext(sandbox);
vm.runInContext(`${read('js/asset-reports.js')}\n;globalThis.__R = AssetReports;`, sandbox, { filename: 'asset-reports.js' });
const R = sandbox.__R;

console.log('=== asset-reports-ui: the real Asset Reports page ===\n');

console.log('-- 1. not a demo, same look --');
{
  const html = read('pages/asset-reports.html');
  const js = read('js/asset-reports.js');
  const css = read('css/asset-reports.css');
  ok('the page loads its own real script and stylesheet', html.includes('<script src="../js/asset-reports.js"></script>') && html.includes('href="../css/asset-reports.css"'), '');
  ok('   ...and neither the demo engine, its stylesheet nor the old demo script', !html.includes('workshop-assets-demo') && !html.includes('asset-reports-ui.js'), '');
  ok('   ...and has the print area the shared print layout uses', html.includes('<div id="printArea" class="print-area" aria-hidden="true"></div>'), '');
  ok('no sample data, no Demo badge or banner, no "sample" wording', !/DEMO-|SAMPLE\s*=|MONTHLY\s*=|\(Demo\)|DEMO MODE|'Demo'|sample units|Export Preview/i.test(js) && !/DEMO PAGE|DEMO MODE/.test(html), '');
  ok('it only reads: GET requests, never browser storage', /Api\.get\(`\/asset-reports/.test(js) && !/Api\.(post|put|delete)\(/.test(js) && !/localStorage|sessionStorage/.test(js), '');
  ok('the same look: cards, toolbar and CSS bar charts it had', ['ad-stats', 'ad-stat__value', 'ad-toolbar', 'ar-grid', 'ar-hbars', 'ar-cols', 'ar-split', 'ar-legend'].every((c) => js.includes(c) && css.includes(`.${c}`)), '');
  ok('the same five card titles', ['Total Asset Value', 'Total Assets', 'Available Assets', 'Assets In Use', 'Maintenance Expenses'].every((t) => js.includes(`'${t}'`)), '');
  ok('every stylesheet rule is scoped to this page', css.split('\n').filter((l) => /^\s*[.#\[a-z].*\{/.test(l) && !/^\s*(from|to)\s*\{/.test(l)).every((l) => l.trim().startsWith('[data-page="asset-reports"]')), '');
  ok('the page keeps the shared head (theme, render hold) and data-page', html.includes('<body data-page="asset-reports" data-root="../">') && html.includes('blocking="render"') && html.includes('taqwa_theme'), '');
  ok('the shared demo engine and its stylesheet are still there (unchanged, used by no page)', fs.existsSync(path.join(ROOT, 'js/workshop-assets-demo.js')) && fs.existsSync(path.join(ROOT, 'css/workshop-assets-demo.css')), '');
}

console.log('\n-- 2. the query --');
check('search, category, status, purchase dates, cost period; empty left out',
  R.buildQuery({ q: ' lift ', category: 'Lifting Equipment', status: 'In Use', from: '2026-01-01', to: '', period: '30', offset: 25 }, '2026-11-06'),
  { limit: '25', offset: '25', q: 'lift', category: 'Lifting Equipment', status: 'In Use', from: '2026-01-01', costFrom: '2026-10-07', costTo: '2026-11-06' });
check('nothing chosen: only paging', R.buildQuery({}, '2026-11-06'), { limit: '25', offset: '0' });
check('cost periods', ['all', '90', '365', 'year', 'lastyear'].map((p) => R.periodRange(p, '2026-11-06')),
  [['', ''], ['2026-08-08', '2026-11-06'], ['2025-11-06', '2026-11-06'], ['2026-01-01', '2026-11-06'], ['2025-01-01', '2025-12-31']]);
check('filters: categories and statuses of the register', [R.CATEGORIES.length, R.STATUSES], [9, ['Available', 'In Use', 'Under Maintenance', 'Damaged', 'Retired']]);

const S = { allItems: 6, inService: 5, available: 2, inUse: 1, underMaintenance: 1, damaged: 1, retired: 1, value: 519000, unpriced: 1, retiredValue: 9000, undated: 1, utilisation: 20 };
const X = { spent: 11000, spentMaintenance: 3000, spentRepairs: 8000, completed: 3, completedWithoutCost: 1, inProgress: 1, inProgressEstimate: 5000, scheduled: 1, scheduledEstimate: 1200, cancelled: 1, cancelledEstimate: 900,
  monthly: [{ month: '2026-10', spent: 3000 }, { month: '2026-11', spent: 8000 }], yearly: [{ year: '2026', spent: 11000, jobs: 3 }], byCategory: [{ category: 'Lifting Equipment', spent: 11000, jobs: 2 }],
  byEquipment: [{ toolId: 'TOL-0001', toolName: 'Lift <A>', category: 'Lifting Equipment', spent: 11000, repairs: 8000, completed: 2, openEstimate: 0, jobs: 2 }] };
const C = [{ category: 'Lifting Equipment', inService: 2, available: 1, inUse: 0, underMaintenance: 1, damaged: 0, retired: 0, value: 464000, share: 40, valueShare: 89.4, utilisation: 0 },
  { category: 'Workshop Hand Tools', inService: 0, available: 0, inUse: 0, underMaintenance: 0, damaged: 0, retired: 1, value: 0, share: 0, valueShare: 0, utilisation: 0 }];

console.log('\n-- 3. cards and summary --');
{
  const c = R.cards(S, X, 'All dates');
  check('card values from the server', c.map((x) => x.value), ['৳519,000', 5, 2, 1, '৳11,000']);
  check('card lines say what is behind them', c.map((x) => x.sub), ['Purchase value · 1 without a price', 'In service · 1 retired', '1 under maintenance · 1 damaged', 'Utilisation 20%', 'All dates · ৳8,000 repairs']);
  check('before anything loads: dashes, not numbers', R.cards(null, null, 'All dates').map((x) => x.value), ['—', '—', '—', '—', '—']);
  const lines = R.summaryLines(S, C, X, 'All dates').join('\n');
  ok('summary: counts only categories with items in service', /5 items in service across 1 category/.test(lines), lines);
  ok('summary: retired value kept apart', /1 retired \(৳9,000, not counted above\)/.test(lines), '');
  ok('summary: the utilisation formula is stated', /In Use ÷ items in service \(retired items are not counted\)/.test(lines), '');
  ok('summary: spent split and estimates apart', /৳3,000 maintenance and ৳8,000 repairs/.test(lines) && /Not in that total: ৳5,000 .* ৳1,200 .* ৳900 for 1 cancelled/.test(lines), '');
  ok('summary: missing purchase dates are stated, not guessed', /1 item has no purchase date recorded/.test(lines), '');
}

console.log('\n-- 4. charts --');
{
  const sp = R.split(S);
  ok('Available vs In Use: four parts of items in service, formula stated', /Available: 2 \(40%\)/.test(sp) && /In Use: 1 \(20%\)/.test(sp) && /Under Maintenance: 1 \(20%\)/.test(sp) && /Damaged: 1 \(20%\)/.test(sp) && /Retired items \(1\) are not counted/.test(sp), sp);
  ok('an empty register: no division by zero, all 0%', /Available: 0 \(0%\)/.test(R.split({ ...S, inService: 0, available: 0, inUse: 0, underMaintenance: 0, damaged: 0, utilisation: 0 })), '');
  check('bars with no data say so', R.hbars([], 'info', 'Nothing here.'), '<p class="ar-none">Nothing here.</p>');
  const html = R.report({ summary: S, categories: C, expenses: X, total: 6 });
  ok('report: names are escaped', html.includes('Lift &lt;A&gt;') && !html.includes('Lift <A>'), '');
  ok('report: every section is there', ['Report Summary', 'Asset Category Distribution', 'Available vs In Use', 'Monthly Maintenance Expenses', 'Asset Purchase Value', 'Category Utilisation', 'Maintenance &amp; Repair Expenses', 'Maintenance Cost by Category', 'Maintenance Cost by Equipment', 'Asset Purchase Report'].every((t) => html.includes(t)), '');
  ok('report: a retired-only category is not drawn as in service', !/Workshop Hand Tools<\/span><span class="ar-hbar__value">0 items/.test(html), '');
}

console.log('\n-- 5. export --');
{
  const rows = [{ id: 'TOL-0001', name: '=HYPERLINK("x")', category: 'Other', purchaseDate: '', purchasePrice: null, status: 'Available', condition: 'Good', supplier: 'A "B"', maintenanceSpent: 0, maintenanceJobs: 0 }];
  const csv = R.toCsv(R.ASSET_COLUMNS, rows);
  const [head, line] = csv.trim().split('\r\n');
  check('asset CSV columns', head, '"Equipment","Asset Code","Category","Purchase Date","Purchase Cost","Current Status","Condition","Supplier","Maintenance Spent (period)","Maintenance Jobs (all time)"');
  ok('a formula is neutralised, quotes escaped', line.startsWith('"\'=HYPERLINK(""x"")"') && line.includes('"A ""B"""'), line);
  ok('missing date and price stay "Not recorded" -- nothing invented', line.includes('"Not recorded","Not recorded"'), line);
  check('costs CSV columns', R.toCsv(R.COST_COLUMNS, []).trim(), '"Equipment","Asset Code","Category","Spent (completed, actual)","of which Repairs","Completed Jobs","Open Estimates (in progress + scheduled)","All Jobs"');
}

check('money and dates', [R.money(1250000), R.fmtDate('2026-10-04'), R.fmtDate(''), R.fmtMonth('2026-10'), R.pctText(33.333)], ['৳1,250,000', '4 Oct 2026', '—', 'Oct 26', '33.3%']);

process.exit(summary('asset-reports-ui') === 0 ? 0 : 1);
