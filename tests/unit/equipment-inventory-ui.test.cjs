/* equipment-inventory-ui — Workshop Assets › Equipment Inventory, the page.

   Loads the REAL js/equipment-inventory.js in Node. The Worker's rules are
   tested against the real Worker in api-equipment.test.mjs, and the page is
   driven in a real browser by the end-to-end script; here:

     1. The page is no longer a demo: no demo engine, no sample data, its own
        real script, every element id the script reads exists in the markup.
     2. Validation mirrors the server (dates, prices, status/condition, service dates).
     3. Request bodies: create sends what was filled in; an edit only what
        changed plus expectedUpdatedAt; assign / return bodies.
     4. The list query (search, category, status, purchase-date range, paging).
     5. Which buttons a role sees (view / create / edit / manage / delete).
     6. CSV is formula-safe; queued offline items are read from the outbox. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// The shipped script, run as the browser runs it (a classic script), with the one helper it calls at load.
const sandbox = { Utils: { esc: (s) => String(s ?? ''), money: (n) => `৳${n}`, fmtDate: (d) => d }, console };
vm.createContext(sandbox);
vm.runInContext(`${read('js/equipment-inventory.js')}\n;globalThis.__E = EquipmentInventory;`, sandbox, { filename: 'equipment-inventory.js' });
const E = sandbox.__E;

console.log('=== equipment-inventory-ui: the real Equipment Inventory page ===\n');

console.log('-- 1. not a demo --');
{
  const html = read('pages/equipment-inventory.html');
  const js = read('js/equipment-inventory.js');
  ok('the page loads its own real script', html.includes('<script src="../js/equipment-inventory.js"></script>'), '');
  ok('   ...and neither the demo engine nor its stylesheet', !html.includes('workshop-assets-demo') && !html.includes('equipment-inventory-ui.js'), '');
  ok('the demo script is gone', !fs.existsSync(path.join(ROOT, 'js/equipment-inventory-ui.js')), '');
  ok('no sample data in the script (no DEMO codes, no SAMPLE list)', !/DEMO-|SAMPLE\s*=/.test(js), '');
  ok('it reads through Storage (the API), never localStorage', /Storage\.loadPage\('tools'/.test(js) && !/localStorage/.test(js), '');
  const ids = [...new Set([...js.matchAll(/\$\('([A-Za-z]+)'\)/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  check('every element id the script reads is in the markup', missing, []);
  ok('the page keeps the shared head (theme, render hold) and data-page', html.includes('data-page="equipment-inventory"') && html.includes('blocking="render"') && html.includes('taqwa_theme'), '');
  ok('six summary cards', ['eiTotal', 'eiAvailable', 'eiAssigned', 'eiMaint', 'eiDamaged', 'eiValue'].every((id) => html.includes(`id="${id}"`)), '');
  ok('the service worker pre-caches the real script, not the demo one', read('js/sw-assets.js').includes('/js/equipment-inventory.js') && !read('js/sw-assets.js').includes('equipment-inventory-ui'), '');
  ok('every rule in its stylesheet is scoped to the page', read('css/equipment-inventory.css').split('\n').filter((l) => /^\s*\.[a-z]/.test(l)).length === 0, '');
}

console.log('\n-- 2. validation --');
{
  const T = '2026-11-03';
  const base = { name: 'Lift', category: 'Lifting Equipment', condition: 'Good', status: 'Available' };
  check('a minimal item is valid', E.validate(base, T), {});
  check('name, category, condition required', Object.keys(E.validate({}, T)).sort(), ['category', 'condition', 'name', 'status']);
  check('future purchase date', Object.keys(E.validate({ ...base, purchaseDate: '2026-11-04' }, T)), ['purchaseDate']);
  check('impossible date', E.validate({ ...base, purchaseDate: '2026-02-30' }, T).purchaseDate, 'Enter a real date.');
  check('warranty before purchase', Object.keys(E.validate({ ...base, purchaseDate: '2026-01-10', warrantyExpiry: '2026-01-09' }, T)), ['warrantyExpiry']);
  check('negative price', Object.keys(E.validate({ ...base, purchasePrice: '-1' }, T)), ['purchasePrice']);
  check('damaged cannot be Available', Object.keys(E.validate({ ...base, condition: 'Damaged' }, T)), ['status']);
  check('In Use cannot be chosen in the form (assign instead)', Object.keys(E.validate({ ...base, status: 'In Use' }, T)), ['status']);
  check('   ...but an assigned item being edited keeps it', E.validate({ ...base, status: 'In Use' }, T, { status: 'In Use' }), {});
  check('last service in the future', Object.keys(E.validate({ ...base, lastServiceDate: '2026-12-01' }, T)), ['lastServiceDate']);
  check('next service before the last', Object.keys(E.validate({ ...base, lastServiceDate: '2026-10-01', nextServiceDue: '2026-09-01' }, T)), ['nextServiceDue']);
}

console.log('\n-- 3. request bodies --');
{
  const v = { name: ' Lift ', category: 'Lifting Equipment', condition: 'Good', status: 'Available', purchasePrice: '1200.50', notes: '' };
  check('create sends what was filled, trimmed, price as a number', E.payload(v), { name: 'Lift', category: 'Lifting Equipment', purchasePrice: 1200.5, condition: 'Good', status: 'Available' });
  const orig = { ...v, name: 'Lift', purchasePrice: 1200.5, updatedAt: 'U1' };
  check('an edit sends only what changed, with expectedUpdatedAt', E.payload({ ...v, location: 'Bay 2' }, orig), { location: 'Bay 2', expectedUpdatedAt: 'U1' });
  check('an edit that changes nothing sends nothing', E.payload({ ...v }, orig), null);
  check('clearing a price sends an empty value', E.payload({ ...v, purchasePrice: '' }, orig), { purchasePrice: '', expectedUpdatedAt: 'U1' });
  const t = { id: 'TOL-0001', updatedAt: 'U2' };
  check('assign to a mechanic', E.assignBody({ id: 'MEC-0001', isMechanic: true }, t), { assignedStaffId: '', assignedMechanicId: 'MEC-0001', status: 'In Use', expectedUpdatedAt: 'U2' });
  check('assign to an employee', E.assignBody({ id: 'STF-0004', isMechanic: false }, t), { assignedStaffId: 'STF-0004', assignedMechanicId: '', status: 'In Use', expectedUpdatedAt: 'U2' });
  check('return', E.returnBody(t, 'Under Maintenance'), { assignedStaffId: '', assignedMechanicId: '', status: 'Under Maintenance', expectedUpdatedAt: 'U2' });
}

console.log('\n-- 4. the list query --');
{
  check('defaults: newest first, a page of 25', E.buildQuery({ limit: 25, offset: 0 }), { sort: 'createdAt', order: 'desc', limit: '25', offset: '0' });
  check('search, filters and a purchase-date range', E.buildQuery({ q: 'lift', category: 'Lifting Equipment', status: 'In Use', from: '2025-01-01', to: '2025-12-31', sort: 'name:asc', limit: 10, offset: 20 }),
    { q: 'lift', category: 'Lifting Equipment', status: 'In Use', purchasedFrom: '2025-01-01', purchasedTo: '2025-12-31', sort: 'name', order: 'asc', limit: '10', offset: '20' });
  check('In Use reads as Assigned; Retired as Inactive', [E.statusLabel('In Use'), E.statusLabel('Retired'), E.statusLabel('Damaged')], ['Assigned', 'Inactive (Retired)', 'Damaged']);
}

console.log('\n-- 5. who sees which buttons --');
{
  const role = (...perms) => (p) => perms.includes(p);
  const avail = { status: 'Available', condition: 'Good', assignedTo: null };
  const held = { status: 'In Use', condition: 'Good', assignedTo: { id: 'MEC-0001' } };
  const retired = { status: 'Retired', condition: 'Good', assignedTo: null };
  const pick = (a) => Object.keys(a).filter((k) => a[k]);
  check('view only (Mechanic)', pick(E.actionsFor(avail, role('tools.view'))), ['view']);
  check('Manager: edit and assign, no deactivate or delete', pick(E.actionsFor(avail, role('tools.view', 'tools.edit'))), ['view', 'edit', 'assign']);
  const all = role('tools.view', 'tools.edit', 'tools.manage', 'tools.delete');
  check('Store Manager on an available item', pick(E.actionsFor(avail, all)), ['view', 'edit', 'assign', 'retire', 'delete']);
  check('   ...on an assigned item: return, never delete', pick(E.actionsFor(held, all)), ['view', 'edit', 'return', 'retire']);
  check('   ...on an inactive item: reactivate or delete', pick(E.actionsFor(retired, all)), ['view', 'reactivate', 'delete']);
  check('a Poor item cannot be assigned', E.actionsFor({ ...avail, status: 'Under Maintenance', condition: 'Poor' }, all).assign, false);
}

console.log('\n-- 6. CSV and the offline queue --');
{
  const csv = E.toCsv([{ id: 'TOL-1', name: '=HYPERLINK("x")', status: 'In Use', assignedTo: { name: 'A, B', id: 'MEC-1' } }]);
  ok('a formula-looking cell is made text', csv.includes(`"'=HYPERLINK(""x"")"`), csv);
  ok('status reads as on screen and the holder is named', csv.includes('"Assigned"') && csv.includes('"A, B (MEC-1)"'), csv);
  const outbox = [
    { kind: 'create', collection: 'tools', tempId: 'OFF-A-TOL-0001', state: 'pending', data: { name: 'Jack', category: 'Lifting Equipment' } },
    { kind: 'create', collection: 'tools', tempId: 'OFF-A-TOL-0002', state: 'conflict', error: 'Serial number is already registered', data: { name: 'Scanner' } },
    { kind: 'create', collection: 'tools', tempId: 'OFF-A-TOL-0003', state: 'synced', data: { name: 'Done' } },
    { kind: 'create', collection: 'customers', tempId: 'OFF-A-CUS-0001', state: 'pending', data: { name: 'Not equipment' } },
  ];
  check('only unsent equipment is listed as queued', E.queuedFrom(outbox).map((q) => [q.id, q.state]), [['OFF-A-TOL-0001', 'pending'], ['OFF-A-TOL-0002', 'conflict']]);
  check('   ...with the reason a conflict was raised', E.queuedFrom(outbox)[1].message, 'Serial number is already registered');
}

process.exit(summary('equipment-inventory-ui') ? 1 : 0);
