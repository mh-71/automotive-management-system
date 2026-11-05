/* asset-assignment-ui — Workshop Assets › Asset Assignment, the page (0025).

   Loads the REAL js/asset-assignment.js in Node. The Worker's rules are
   tested against the real Worker in api-tool-assignments.test.mjs, and the
   page is driven in a real browser by the end-to-end script; here:

     1. The page is no longer a demo: no demo engine, no demo stylesheet, no
        sample data, its own real script; every element id the script reads
        exists in the markup; Asset History and Asset Reports still use the engine.
     2. Validation of the assign / edit / return forms.
     3. Request bodies: create sends what was filled in; an edit only what
        changed plus expectedUpdatedAt (and nothing when nothing changed).
     4. The list query (search, status, person, equipment, dates, paging).
     5. Which buttons a role sees, by status and permission. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const sandbox = { Utils: { esc: (s) => String(s ?? ''), money: (n) => `৳${n}`, fmtDate: (d) => d }, console };
vm.createContext(sandbox);
vm.runInContext(`${read('js/asset-assignment.js')}\n;globalThis.__A = AssetAssignment;`, sandbox, { filename: 'asset-assignment.js' });
const A = sandbox.__A;

console.log('=== asset-assignment-ui: the real Asset Assignment page ===\n');

console.log('-- 1. not a demo --');
{
  const html = read('pages/asset-assignment.html');
  const js = read('js/asset-assignment.js');
  const css = read('css/asset-assignment.css');
  ok('the page loads its own real script and stylesheet', html.includes('<script src="../js/asset-assignment.js"></script>') && html.includes('href="../css/asset-assignment.css"'), '');
  ok('   ...and neither the demo engine, its stylesheet nor the old demo script', !html.includes('workshop-assets-demo') && !html.includes('asset-assignment-ui.js'), '');
  ok('the demo script is gone', !fs.existsSync(path.join(ROOT, 'js/asset-assignment-ui.js')), '');
  ok('no sample data in the script or page (no DEMO codes, no SAMPLE list, no "(Demo)" people)', !/DEMO-|SAMPLE\s*=|\(Demo\)/.test(js) && !/DEMO MODE|Sample data|DEMO PAGE/i.test(html), '');
  ok('it reads and writes through the API, never browser storage', /Api\.get\(`\/tool-assignments/.test(js) && /Api\.post\(/.test(js) && /Api\.put\(/.test(js) && !/localStorage|sessionStorage/.test(js), '');
  ok('   ...and never deletes (history is kept)', !/Api\.delete\(/.test(js), '');
  const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]))];
  check('every element id the script reads is in the markup', ids.filter((id) => !html.includes(`id="${id}"`)), []);
  ok('the page keeps the shared head (theme, render hold) and data-page', html.includes('<body data-page="asset-assignment" data-root="../">') && html.includes('blocking="render"') && html.includes('taqwa_theme'), '');
  ok('every stylesheet rule is scoped to this page', css.split('\n').filter((l) => /^[^\s@/}].*\{/.test(l)).every((l) => l.startsWith('[data-page="asset-assignment"]')), '');
  for (const p of ['asset-history', 'asset-reports']) {
    const h = read(`pages/${p}.html`);
    ok(`${p} is untouched: still the demo engine and its own script`, h.includes('workshop-assets-demo.js') && h.includes(`${p}-ui.js`) && h.includes('workshop-assets-demo.css'), '');
  }
  ok('Maintenance & Repairs still loads its own real page', read('pages/maintenance-repairs.html').includes('../js/maintenance-repairs.js'), '');
}

console.log('\n-- 2. validation --');
{
  const today = '2026-11-05';
  const good = { toolId: 'TOL-0001', assigneeId: 'MEC-0001', assignedDate: '2026-11-04', expectedReturnDate: '2026-11-10', conditionBefore: '', purpose: '', workLocation: '', notes: '' };
  check('a complete form passes', A.validate(good, { today }), {});
  check('the required fields', Object.keys(A.validate({}, { today })).sort(), ['assignedDate', 'assigneeId', 'toolId']);
  check('a future assignment date, a return before it, Poor condition, too-long text',
    Object.keys(A.validate({ ...good, assignedDate: '2026-11-06', expectedReturnDate: '2026-11-01', conditionBefore: 'Poor', purpose: 'x'.repeat(201) }, { today })).sort(),
    ['assignedDate', 'conditionBefore', 'expectedReturnDate', 'purpose']);
  check('an expected return before the assignment date', A.validate({ ...good, expectedReturnDate: '2026-11-01' }, { today }).expectedReturnDate, 'The expected return cannot be before the assignment date.');
  check('editing: equipment and date are not asked for; the return date is checked against the original', Object.keys(A.validate({ assigneeId: 'STF-0001', expectedReturnDate: '2026-10-01' }, { editing: true, today, assignedDate: '2026-10-05' })), ['expectedReturnDate']);
  const ret = { returnDate: today, conditionAfter: 'Good', statusAfter: 'Available', damageNotes: '', returnNotes: '' };
  check('a good return passes', A.validateReturn(ret, { today, assignedDate: '2026-11-01' }), {});
  check('return: date in the future, before the assignment, no condition', [Object.keys(A.validateReturn({ ...ret, returnDate: '2026-11-06' }, { today })), Object.keys(A.validateReturn({ ...ret, returnDate: '2026-10-01' }, { today, assignedDate: '2026-11-01' })), Object.keys(A.validateReturn({ ...ret, conditionAfter: '' }, { today }))],
    [['returnDate'], ['returnDate'], ['conditionAfter']]);
  check('Damaged or Poor cannot go back as Available', [Object.keys(A.validateReturn({ ...ret, conditionAfter: 'Damaged' }, { today })), Object.keys(A.validateReturn({ ...ret, conditionAfter: 'Poor' }, { today }))], [['statusAfter'], ['statusAfter']]);
  check('statuses after return, as the Worker allows', [A.statusesAfterReturn('Good'), A.statusesAfterReturn('Poor')], [['Available', 'Under Maintenance', 'Damaged'], ['Under Maintenance', 'Damaged']]);
  check('default status after return', ['Excellent', 'Fair', 'Poor', 'Damaged'].map(A.defaultStatusAfterReturn), ['Available', 'Available', 'Under Maintenance', 'Damaged']);
}

console.log('\n-- 3. request bodies --');
{
  check('create sends what was filled in, trimmed; blanks left out', A.payload({ toolId: 'TOL-0001', assigneeId: 'MEC-0001', assignedDate: '2026-11-04', expectedReturnDate: '', conditionBefore: '', purpose: ' Brake job ', workLocation: '', notes: '' }),
    { toolId: 'TOL-0001', assigneeId: 'MEC-0001', assignedDate: '2026-11-04', purpose: 'Brake job' });
  const original = { assigneeId: 'MEC-0001', expectedReturnDate: '2026-11-10', purpose: 'Brake job', workLocation: 'Bay 2', notes: '', updatedAt: 'T1' };
  const same = { assigneeId: 'MEC-0001', expectedReturnDate: '2026-11-10', purpose: 'Brake job ', workLocation: 'Bay 2', notes: '' };
  check('an edit with nothing changed sends nothing', A.payload(same, original), null);
  check('an edit sends only what changed, with expectedUpdatedAt', A.payload({ ...same, assigneeId: 'STF-0001', expectedReturnDate: '' }, original),
    { assigneeId: 'STF-0001', expectedReturnDate: '', expectedUpdatedAt: 'T1' });
}

console.log('\n-- 4. the list query --');
check('search, status, person, equipment, dates and paging; empty ones left out',
  A.buildQuery({ q: ' lift ', status: 'Overdue', assigneeId: 'MEC-0001', toolId: '', from: '2026-11-01', to: '', offset: 25 }),
  { limit: '25', offset: '25', q: 'lift', status: 'Overdue', assigneeId: 'MEC-0001', from: '2026-11-01' });
check('the status filter: Active, Overdue (worked out), Returned, Cancelled', A.FILTER_STATUSES, ['Active', 'Overdue', 'Returned', 'Cancelled']);

console.log('\n-- 5. which buttons --');
{
  const all = () => true;
  const viewOnly = (p) => p === 'tools.view';
  const pick = (a) => Object.keys(a).filter((k) => a[k]).sort();
  check('Active, with tools.edit: edit, return, cancel', pick(A.actionsFor({ status: 'Active' }, all)), ['cancel', 'edit', 'return']);
  check('Returned: nothing', pick(A.actionsFor({ status: 'Returned' }, all)), []);
  check('Cancelled: nothing', pick(A.actionsFor({ status: 'Cancelled' }, all)), []);
  check('view-only role: no buttons', pick(A.actionsFor({ status: 'Active' }, viewOnly)), []);
}

process.exit(summary('asset-assignment-ui') === 0 ? 0 : 1);
