/* maintenance-repairs-ui — Workshop Assets › Maintenance & Repairs, the page (0024).

   Loads the REAL js/maintenance-repairs.js in Node. The Worker's rules are
   tested against the real Worker in api-tool-maintenance.test.mjs, and the
   page is driven in a real browser by the end-to-end script; here:

     1. The page is no longer a demo: no demo engine, no demo stylesheet, no
        sample data, its own real script; every element id the script reads
        exists in the markup; the other demo pages still use the engine.
     2. Validation of the schedule / edit form.
     3. Request bodies: create sends what was filled in; an edit only what
        changed plus expectedUpdatedAt (and nothing when nothing changed).
     4. The list query (search, status incl. Due Soon / Overdue, type, dates, paging).
     5. Which buttons a role sees, by status and permission. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const sandbox = { Utils: { esc: (s) => String(s ?? ''), money: (n) => `৳${n}`, fmtDate: (d) => d }, console };
vm.createContext(sandbox);
vm.runInContext(`${read('js/maintenance-repairs.js')}\n;globalThis.__M = MaintenanceRepairs;`, sandbox, { filename: 'maintenance-repairs.js' });
const M = sandbox.__M;

console.log('=== maintenance-repairs-ui: the real Maintenance & Repairs page ===\n');

console.log('-- 1. not a demo --');
{
  const html = read('pages/maintenance-repairs.html');
  const js = read('js/maintenance-repairs.js');
  ok('the page loads its own real script', html.includes('<script src="../js/maintenance-repairs.js"></script>'), '');
  ok('   ...and neither the demo engine, its stylesheet nor the old demo script', !html.includes('workshop-assets-demo') && !html.includes('maintenance-repairs-ui.js'), '');
  ok('the demo script is gone', !fs.existsSync(path.join(ROOT, 'js/maintenance-repairs-ui.js')), '');
  ok('no sample data in the script or page (no DEMO codes, no SAMPLE list, no "(Demo)" people)', !/DEMO-|SAMPLE\s*=|\(Demo\)/.test(js) && !/DEMO MODE|Sample data/i.test(html), '');
  ok('it reads and writes through the API, never browser storage', /Api\.get\(`\/tool-maintenance/.test(js) && /Api\.post\(/.test(js) && /Api\.put\(/.test(js) && /Api\.delete\(/.test(js) && !/localStorage|sessionStorage/.test(js), '');
  const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]))];
  check('every element id the script reads is in the markup', ids.filter((id) => !html.includes(`id="${id}"`)), []);
  ok('the page keeps the shared head (theme, render hold) and data-page', html.includes('<body data-page="maintenance-repairs" data-root="../">') && html.includes('blocking="render"') && html.includes('taqwa_theme'), '');
  // Asset Assignment became a real page in 0025 (asset-assignment-ui.test.cjs).
  // Asset History became a real page too (asset-history-ui.test.cjs).
  for (const p of ['asset-reports']) {
    const h = read(`pages/${p}.html`);
    ok(`${p} is untouched: still the demo engine and its own script`, h.includes('workshop-assets-demo.js') && h.includes(`${p}-ui.js`) && h.includes('workshop-assets-demo.css'), '');
  }
  ok('the shared demo engine no longer carries Maintenance & Repairs sample data', !/DEMO-MNT/.test(read('js/workshop-assets-demo.js')), '');
}

console.log('\n-- 2. validation --');
{
  const good = { toolId: 'TOL-0001', maintenanceType: 'Repair', priority: 'Normal', scheduledDate: '2026-12-01', estimatedCost: '1500', vendor: '', description: '' };
  check('a complete form passes', M.validate(good), {});
  check('the required fields', Object.keys(M.validate({ priority: 'Normal' })).sort(), ['maintenanceType', 'scheduledDate', 'toolId']);
  check('an impossible date, a negative cost, an unknown type', Object.keys(M.validate({ ...good, scheduledDate: '2026-02-31', estimatedCost: '-5', maintenanceType: 'Painting' })).sort(),
    ['estimatedCost', 'maintenanceType', 'scheduledDate']);
  ok('an over-long vendor and description', 'vendor' in M.validate({ ...good, vendor: 'x'.repeat(121) }) && 'description' in M.validate({ ...good, description: 'x'.repeat(1001) }), '');
  check('real dates only', [M.isRealDate('2026-02-28'), M.isRealDate('2026-02-30'), M.isRealDate('28-02-2026')], [true, false, false]);
}

console.log('\n-- 3. request bodies --');
{
  const v = { toolId: 'TOL-0001', maintenanceType: 'Repair', priority: 'High', scheduledDate: '2026-12-01', technicianId: 'MEC-0001', vendor: ' Lift Co ', estimatedCost: '1500', description: ' Fix it ' };
  check('create sends every field, trimmed, cost as a number, no technician as null', M.payload({ ...v, technicianId: '' }),
    { toolId: 'TOL-0001', maintenanceType: 'Repair', priority: 'High', scheduledDate: '2026-12-01', technicianId: null, vendor: 'Lift Co', estimatedCost: 1500, description: 'Fix it' });
  const original = { toolId: 'TOL-0001', maintenanceType: 'Repair', priority: 'High', scheduledDate: '2026-12-01', technicianId: 'MEC-0001', vendor: 'Lift Co', estimatedCost: 1500, description: 'Fix it', updatedAt: 'T1' };
  check('an edit with nothing changed sends nothing', M.payload(v, original), null);
  check('an edit sends only what changed, with expectedUpdatedAt', M.payload({ ...v, priority: 'Urgent', estimatedCost: '' }, original),
    { priority: 'Urgent', estimatedCost: null, expectedUpdatedAt: 'T1' });
}

console.log('\n-- 4. the list query --');
check('search, status, type, dates and paging; empty ones left out',
  M.buildQuery({ q: ' lift ', status: 'Due Soon', type: '', from: '2026-11-01', to: '', offset: 25 }),
  { limit: '25', offset: '25', q: 'lift', status: 'Due Soon', from: '2026-11-01' });
check('the status filter offers the worked-out states too', M.FILTER_STATUSES, ['Scheduled', 'Due Soon', 'Overdue', 'In Progress', 'Completed', 'Cancelled']);

console.log('\n-- 5. which buttons --');
{
  const all = () => true;
  const viewOnly = (p) => p === 'tools.view';
  const editor = (p) => p !== 'tools.delete';
  const pick = (a) => Object.keys(a).filter((k) => a[k]).sort();
  check('Scheduled, full access: edit, start, complete, cancel, delete', pick(M.actionsFor({ status: 'Scheduled' }, all)), ['cancel', 'complete', 'delete', 'edit', 'start']);
  check('In Progress: edit, complete, cancel -- no start, no delete', pick(M.actionsFor({ status: 'In Progress' }, all)), ['cancel', 'complete', 'edit']);
  check('Completed: nothing', pick(M.actionsFor({ status: 'Completed' }, all)), []);
  check('Cancelled: only delete (a record entered by mistake)', pick(M.actionsFor({ status: 'Cancelled' }, all)), ['delete']);
  check('view-only role: no buttons', pick(M.actionsFor({ status: 'Scheduled' }, viewOnly)), []);
  check('edit without delete: no delete button', pick(M.actionsFor({ status: 'Scheduled' }, editor)), ['cancel', 'complete', 'edit', 'start']);
}

process.exit(summary('maintenance-repairs-ui') === 0 ? 0 : 1);
