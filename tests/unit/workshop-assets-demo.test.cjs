/* workshop-assets-demo — the four Workshop Assets demo pages.
   (Equipment Inventory left this list in 0021: it is a real page now,
   covered by tests/unit/equipment-inventory-ui.test.cjs.)

   What must hold:
     1. Each page exists, loads the shared engine and its own script and
        stylesheet, keeps the shared head (render hold, theme script), and
        says what it is in its title.
     2. Demo only: neither the engine nor any page script makes a request,
        touches the API, Storage or browser storage, inserts HTML or names a
        URL. The banner and the "nothing was saved" wording are the agreed
        ones, and no script claims a record was saved.
     3. The shared helpers behave: search and filters, date ranges against
        the fixed demo "today", money and date formatting, and CSV text.
     4. Each page's sample data is fictional and its figures add up: DEMO
        codes, "(Demo)" people, and the summary counts the cards show.

   Loads the REAL shipped scripts in Node; nothing is reimplemented. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const PAGES = {
  'maintenance-repairs': 'Maintenance &amp; Repairs',
  'asset-assignment': 'Asset Assignment',
  'asset-history': 'Asset History',
  'asset-reports': 'Asset Reports',
};

console.log('=== workshop-assets-demo: the four Workshop Assets demo pages ===\n');

console.log('-- 1. the pages --');
const toolsHead = read('pages/workshop-tools.html').split('\n<body')[0];
const inlineOf = html => (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
for (const [key, title] of Object.entries(PAGES)) {
  const html = read(`pages/${key}.html`);
  ok(`${key}.html declares data-page="${key}"`, html.includes(`<body data-page="${key}" data-root="../">`), '');
  ok('   ...has its title', html.includes(`<title>${title} — Taqwa Automobile Service Center</title>`), '');
  ok('   ...loads the shared engine, then its own script', /js\/workshop-assets-demo\.js"><\/script>\s*<script src="\.\.\/js\/[a-z-]+-ui\.js"><\/script>/.test(html) && html.includes(`../js/${key}-ui.js`), '');
  ok('   ...loads the shared stylesheet and its own', html.includes('../css/workshop-assets-demo.css') && html.includes(`../css/${key}.css`), '');
  ok('   ...whose files exist', fs.existsSync(path.join(ROOT, `js/${key}-ui.js`)) && fs.existsSync(path.join(ROOT, `css/${key}.css`)), '');
  ok('   ...keeps the shared theme script (so the CSP hash still matches)', inlineOf(html) === inlineOf(toolsHead), '');
  ok('   ...and holds its first paint for the shell', html.includes('<link rel="expect" href="#shell-drawn" blocking="render">') && html.includes('<span id="shell-drawn" hidden></span>'), '');
}

console.log('\n-- 2. demo only --');
const scripts = ['js/workshop-assets-demo.js', ...Object.keys(PAGES).map(k => `js/${k}-ui.js`)];
for (const f of scripts) {
  const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const [what, re] of [
    ['fetch/XHR/WebSocket/beacon', /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/],
    ['the API or Storage', /\bApi\.|\bStorage\./],
    ['browser storage', /localStorage|sessionStorage|indexedDB|document\.cookie/],
    ['HTML insertion', /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function/],
    ['a URL other than the SVG namespace', /https?:\/\/(?!www\.w3\.org\/2000\/svg)/],
    ['a download', /\.download\s*=|createObjectURL/],
  ]) ok(`${f}: no ${what}`, !re.test(code), '');
  ok(`${f}: never claims a record was saved`, !/\b(saved|created|assigned|scheduled) successfully\b/i.test(code), '');
}
// The shipped scripts run in one VM context with no document, so no page boots;
// each one's global is read back from it.
const ctx = vm.createContext({});
const load = (file, name) => { vm.runInContext(`${read(file)}\nthis.${name} = ${name};`, ctx, { filename: file }); return ctx[name]; };
const A = load('js/workshop-assets-demo.js', 'AssetDemo');
check('the "nothing saved" wording', A.NOT_SAVED, 'Demo preview only — Nothing was saved or sent.');
ok('the banner wording', read('js/workshop-assets-demo.js').includes("'DEMO MODE — Sample data only. Nothing is saved or sent.'"), '');

console.log('\n-- 3. shared helpers --');
{
  const rows = [{ n: 'Air Compressor', c: 'A' }, { n: 'Tyre Changer', c: 'B' }, { n: 'Car Lift', c: 'A' }];
  check('search, any case', A.filterRows(rows, 'TYRE', ['n'], {}).map(r => r.n), ['Tyre Changer']);
  check('a filter', A.filterRows(rows, '', ['n'], { c: ['A', (r, v) => r.c === v] }).length, 2);
  check('"all" means no filter', A.filterRows(rows, '', ['n'], { c: ['all', () => false] }).length, 3);
  check('search and filter together', A.filterRows(rows, 'lift', ['n'], { c: ['B', (r, v) => r.c === v] }).length, 0);
  check('a computed search field', A.filterRows(rows, 'xa', [r => 'x' + r.c], {}).length, 2);
  check('the demo "today"', A.DEMO_TODAY, '2026-10-30');
  check('last 30 days: 30 days ago is in', A.inDateRange('2026-09-30', '30'), true);
  check('   ...31 days ago is out', A.inDateRange('2026-09-29', '30'), false);
  check('   ...a future date is out', A.inDateRange('2026-11-02', '30'), false);
  check('upcoming: a future date is in', A.inDateRange('2026-11-02', 'future'), true);
  check('   ...today is out', A.inDateRange('2026-10-30', 'future'), false);
  check('no date is out of any range', A.inDateRange('', '90'), false);
  check('money', A.money(3065000), '৳3,065,000');
  check('dates', A.fmtDate('2026-10-04'), '4 Oct 2026');
  check('no date', A.fmtDate(''), '—');
  check('CSV quoting', A.toCsv([{ label: 'Name', csv: r => r.n }], [{ n: 'A, "B"' }]), 'Name\n"A, ""B"""');
}

console.log('\n-- 4. sample data --');
const demoPerson = p => !p || / \(Demo\)$/.test(p);
{
  const M = load('js/maintenance-repairs-ui.js', 'MaintenanceRepairsUI');
  ok('Maintenance & Repairs: fictional records and technicians', M.SAMPLE.every(r => /^DEMO-MNT-\d{3}$/.test(r.id) && demoPerson(r.tech)), '');
  ok('   ...overdue = open and past its next service', M.overdue(M.SAMPLE).every(r => r.status !== 'Completed' && r.next < '2026-10-30') && M.overdue(M.SAMPLE).length > 0, '');
  ok('   ...upcoming = open and due within 30 days', M.upcoming(M.SAMPLE).every(r => r.status !== 'Completed' && r.next >= '2026-10-30' && r.next <= '2026-11-29') && M.upcoming(M.SAMPLE).length > 0, '');
  ok('   ...recent repairs are completed repairs', M.recentRepairs(M.SAMPLE).every(r => r.type === 'Repair' && r.status === 'Completed'), '');
}
{
  const S = load('js/asset-assignment-ui.js', 'AssetAssignmentUI');
  ok('Asset Assignment: fictional mechanics with DEMO ids', S.MECHANICS.every(m => demoPerson(m) && /^DEMO-MEC-\d{2}$/.test(S.MECHANIC_ID[m])), '');
  ok('   ...every assignment names one of them', S.SAMPLE.every(r => !r.mechanic || S.MECHANICS.includes(r.mechanic)), '');
  const c = S.summary(S.SAMPLE);
  check('   ...assigned + available = total', c.assigned + c.available, c.total);
  ok('   ...an overdue one is past its return date', S.SAMPLE.filter(r => r.status === 'Overdue').every(r => r.due < '2026-10-30'), '');
}
{
  const H = load('js/asset-history-ui.js', 'AssetHistoryUI');
  check('Asset History: the six activity types', Object.keys(H.TYPES), ['Asset Purchased', 'Asset Assigned', 'Asset Returned', 'Maintenance Completed', 'Repair Recorded', 'Status Changed']);
  ok('   ...every activity has a known type and a known asset', H.SAMPLE.every(r => H.TYPES[r.type] && H.ASSETS[r.code]), '');
  ok('   ...performed by fictional people', H.SAMPLE.every(r => demoPerson(r.by)), '');
  ok('   ...newest first', H.SAMPLE.every((r, i, a) => i === 0 || a[i - 1].date >= r.date), '');
  const c = H.counts(H.SAMPLE);
  check('   ...type counts add up', Object.values(c).reduce((n, v) => n + v, 0), H.SAMPLE.length);
}
{
  const R = load('js/asset-reports-ui.js', 'AssetReportsUI');
  const t = R.totals(R.SAMPLE);
  check('Asset Reports: units add up', t.available + t.inUse + t.maintenance, t.assets);
  check('   ...twelve months of spending', R.MONTHLY.length, 12);
  check('   ...a 90-day period is the last three months', R.monthsIn('90').map(m => m[0]), ['2026-08', '2026-09', '2026-10']);
  check('   ...grouping sums by category, largest first', R.groupSum(R.SAMPLE, 'category', r => r.qty)[0][0], 'Lifting');
  ok('   ...utilisation is a percentage', R.SAMPLE.every(r => r.use >= 0 && r.use <= 100), '');
}

process.exit(summary('workshop-assets-demo') === 0 ? 0 : 1);
