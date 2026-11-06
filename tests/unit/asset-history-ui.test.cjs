/* asset-history-ui — Workshop Assets › Asset History, the page.

   Loads the REAL js/asset-history.js in Node. The Worker's rules are tested
   against the real Worker in api-asset-history.test.mjs, and the page is
   driven in a real browser by the end-to-end script; here:

     1. The page is no longer a demo: no demo engine, no demo stylesheet, no
        sample data, no "Demo" badge or banner; its own real script, read only
        (GET requests only); the look is the same (same classes, same
        controls); Asset Reports still uses the engine, which is unchanged.
     2. The list query (search, asset, type, date range, paging).
     3. The summary cards come from the server's counts; nothing is made up.
     4. Each timeline entry: type, title, asset name and code, date and time,
        description and amount, performed by, related person, Asset details
        button with the real asset id; everything escaped.
     5. Dates and money. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const escape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sandbox = { Utils: { esc: escape }, console };
vm.createContext(sandbox);
vm.runInContext(`${read('js/asset-history.js')}\n;globalThis.__H = AssetHistory;`, sandbox, { filename: 'asset-history.js' });
const H = sandbox.__H;

console.log('=== asset-history-ui: the real Asset History page ===\n');

console.log('-- 1. not a demo, same look --');
{
  const html = read('pages/asset-history.html');
  const js = read('js/asset-history.js');
  const css = read('css/asset-history.css');
  ok('the page loads its own real script and stylesheet', html.includes('<script src="../js/asset-history.js"></script>') && html.includes('href="../css/asset-history.css"'), '');
  ok('   ...and neither the demo engine, its stylesheet nor the old demo script', !html.includes('workshop-assets-demo') && !html.includes('asset-history-ui.js'), '');
  ok('no sample data, no Demo badge or banner, no "sample" wording', !/DEMO-|SAMPLE\s*=|\(Demo\)|DEMO MODE|'Demo'|Sample events|sample figures/i.test(js) && !/DEMO PAGE|DEMO MODE/.test(html), '');
  ok('it only reads: GET requests, never browser storage', /Api\.get\(`\/asset-history/.test(js) && !/Api\.(post|put|delete)\(/.test(js) && !/localStorage|sessionStorage/.test(js), '');
  ok('the same controls: search, All Assets, All Activity Types, All dates', ['id="adSearch"', 'All Assets', 'All Activity Types', 'id="adf-date"', 'Search activity, asset, code or person…'].every((t) => js.includes(t)), '');
  ok('the same look: the classes of the timeline and cards it had', ['ad-stats', 'ad-stat__value', 'ad-toolbar', 'ah-timeline', 'ah-month', 'ah-item', 'ah-dot', 'ah-type', 'ah-view'].every((c) => js.includes(c) && css.includes(`.${c}`)), '');
  ok('every stylesheet rule is scoped to this page', css.split('\n').filter((l) => /^\s*[.#\[a-z].*\{/.test(l) && !/^\s*(from|to)\s*\{/.test(l)).every((l) => l.trim().startsWith('[data-page="asset-history"]')), '');
  ok('the page keeps the shared head (theme, render hold) and data-page', html.includes('<body data-page="asset-history" data-root="../">') && html.includes('blocking="render"') && html.includes('taqwa_theme'), '');
  const ar = read('pages/asset-reports.html');
  ok('Asset Reports loads its own real script (it became real after this page)', ar.includes('../js/asset-reports.js') && !ar.includes('workshop-assets-demo'), '');
}

console.log('\n-- 2. the list query --');
check('search, asset, type, range and paging; "all" and empty left out',
  H.buildQuery({ q: ' lift ', toolId: 'TOL-0001', type: 'Repair Recorded', range: '90', offset: 50 }),
  { limit: '50', offset: '50', q: 'lift', toolId: 'TOL-0001', type: 'Repair Recorded', range: '90' });
check('nothing chosen: only paging', H.buildQuery({ q: '', toolId: 'all', type: 'all', range: 'all' }), { limit: '50', offset: '0' });
check('the six activity types', Object.keys(H.TYPES), ['Asset Purchased', 'Asset Assigned', 'Asset Returned', 'Maintenance Completed', 'Repair Recorded', 'Status Changed']);
check('the date ranges', H.RANGES.map((r) => r[1]), ['All dates', 'Last 30 days', 'Last 90 days', 'Last 12 months']);

console.log('\n-- 3. summary cards --');
{
  const c = H.cards({ total: 9, purchases: 2, assigned: 3, returned: 1, maintenance: 1, repairs: 1, statusChanges: 1 });
  check('labels and values from the server', c.map((x) => [x.label, x.value]), [['Total Activities', 9], ['Purchases', 2], ['Assignments', 4], ['Maintenance Events', 1], ['Repairs', 1]]);
  check('assignments sub-line', c[2].sub, '3 issued · 1 returned');
  check('before anything loads: dashes, not numbers', H.cards(null).map((x) => x.value), ['—', '—', '—', '—', '—']);
}

console.log('\n-- 4. timeline entries --');
{
  const rows = [
    { key: 'te:2', type: 'Asset Assigned', toolId: 'TOL-0002', toolName: 'Air <Compressor>', date: '2026-11-05', at: '2026-11-05T04:30:00.000Z', performedBy: 'Store Keeper', relatedId: 'MEC-0001', relatedName: 'Jamal Uddin', description: 'Assigned to Jamal Uddin (MEC-0001)', amount: null },
    { key: 'tl:TOL-0001', type: 'Asset Purchased', toolId: 'TOL-0001', toolName: 'Two Post Lift', date: '2026-10-01', at: null, performedBy: '', relatedId: '', relatedName: '', description: 'Bought · Lifting Equipment', amount: 450000 },
  ];
  const out = H.timeline(rows);
  ok('grouped under their months', out.indexOf('Nov 2026') < out.indexOf('Oct 2026') && (out.match(/ah-month/g) || []).length === 2, out.slice(0, 200));
  ok('type, title, asset name and code', out.includes('Issued to staff or a mechanic') && out.includes('>Asset Assigned<') && out.includes('TOL-0002'), '');
  ok('asset name is escaped', out.includes('Air &lt;Compressor&gt;') && !out.includes('<Compressor>'), '');
  ok('date and time in the workshop\'s zone', out.includes('5 Nov 2026 · 10:30'), out.match(/<time[^>]*>[^<]*/)[0]);
  ok('performed by and the related person', out.includes('Performed by Store Keeper') && out.includes('Staff / mechanic: Jamal Uddin (MEC-0001)'), '');
  ok('a purchase shows its amount; no time when only the day is known', out.includes('Bought · Lifting Equipment · for ৳450,000') && out.includes('>1 Oct 2026</time>'), '');
  ok('who is missing is said, not invented', out.includes('Performed by: not recorded'), '');
  ok('Asset details uses the real asset id', out.includes('data-tool="TOL-0002"') && out.includes('data-tool="TOL-0001"'), '');
}

console.log('\n-- 5. dates and money --');
check('dates', [H.fmtDate('2026-10-04'), H.fmtDate(''), H.monthOf('2026-10-04')], ['4 Oct 2026', '—', 'Oct 2026']);
check('money', [H.money(1250000), H.money(0)], ['৳1,250,000', '৳0']);
check('no time for a date-only value', H.fmtTime('2026-10-04'), '');

process.exit(summary('asset-history-ui') === 0 ? 0 : 1);
