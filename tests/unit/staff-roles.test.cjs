/* staff-roles — Staff Management › Roles & Permissions, read from the Worker.

   Drives the REAL js/staff-roles.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API whose
   GET /api/health lists the REAL route registry of src/index.js.

     1. Helpers: the areas and actions built from the route list (nothing
        invented, nothing hidden, public routes left out, an unknown route
        still shown), the one role (Administrator), the account counts, and
        rows that are escaped and mark the one area only administrators use.
     2. The page in 'api' mode: the role list and its account count, the
        matrix of every real area, who is signed in, nothing written.
     3. Feedback: Edit permissions only explains why it is unavailable; a
        refused (403) account read still shows the permissions and says why
        the counts are missing; a failed health read (Try again), an ended
        session (401) and no backend each say so, with no matrix. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

/** The Worker's real route list, as its 404 advertises it (no database needed). */
async function realRoutes() {
  const worker = (await import('../../src/index.js')).default;
  const db = { prepare() { const s = { bind() { return s; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) }; return s; } };
  const r = await worker.fetch(new Request('http://x/api/__nope__'), { DB: db, API_TOKEN: 't'.repeat(32) }, { waitUntil() {} });
  return (await r.json()).error.available;
}

const acct = (id, role, status) => ({ id, staffId: 'MEC-0001', staffName: 'Someone', username: `u${id.slice(-1)}`, role, status, self: false });
const ACCOUNTS = [acct('USR-0001', 'Administrator', 'Active'), acct('USR-0002', 'Administrator', 'Inactive'), acct('USR-0003', 'Administrator', 'Active')];

function api({ routes, accounts = ACCOUNTS, failAccounts = null, failHealth = false, account = null } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  let healthReads = 0;
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    if (path === '/session' && method === 'GET') {
      return res(200, { data: { authenticated: true, passphrase: true, accounts: true, ...(account ? { account } : {}) } });
    }
    if (path === '/health') {
      calls.push({ method, path });
      healthReads++;
      // The first read is the app's start-up probe; the page's own read comes after it.
      if (failHealth && healthReads > 1) return res(503, { error: { code: 'database_error', message: 'D1 did not answer.' } });
      return res(200, { data: { service: 'taqwa-api', routes } });
    }
    if (!path.startsWith('/accounts')) return base(url, init);
    calls.push({ method, path });
    if (failAccounts) return res(failAccounts.status, { error: failAccounts.error });
    return res(200, { data: accounts, count: accounts.length, total: accounts.length });
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-roles.js'] });
  vm.runInContext('globalThis.StaffRoles = StaffRoles;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffRoles };
}
const areas = html => [...html.matchAll(/<tr data-area="([^"]+)"/g)].map(m => m[1]);

(async () => {
console.log('=== staff-roles: Roles & Permissions ===\n');
const ROUTES = await realRoutes();

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  const caps = S.capabilities(ROUTES);
  const by = k => caps.find(a => a.key === k);
  check('one area per collection the Worker serves, in sidebar order; health and session are left out', caps.map(a => a.key),
    ['customers', 'vehicles', 'appointments', 'job-cards', 'estimates', 'services', 'parts', 'inventory-transactions', 'invoices',
      'invoice-adjustments', 'payments', 'expenses', 'follow-ups', 'follow-up-contacts', 'follow-up-tasks', 'mechanics', 'staff', 'accounts', 'settings', 'tools', 'activity-log', 'attendance', 'leave-requests', 'website-forms']);
  ok('every real area is named: from the page\'s list, or (Attendance, Leave Requests and Activity Log, added after it) from its path, never hidden',
    caps.every(a => S.AREAS.some(([k, l]) => k === a.key && l === a.label)) || caps.every(a => S.AREAS.some(([k, l]) => k === a.key && l === a.label)
      || (a.key === 'attendance' && a.label === 'Attendance') || (a.key === 'leave-requests' && a.label === 'Leave Requests')
      || (a.key === 'activity-log' && a.label === 'Activity Log') || (a.key === 'website-forms' && a.label === 'Website Forms')), '');
  const ops = k => ['view', 'create', 'edit', 'remove'].map(o => by(k)[o]);
  check('customers: view, create, edit and delete', ops('customers'), [true, true, true, true]);
  check('estimates: no delete; send / approve / reject / cancel / convert', [ops('estimates'), by('estimates').actionLabels],
    [[true, true, true, false], ['Send', 'Approve', 'Reject', 'Cancel', 'Convert to job card']]);
  check('tools: named, no delete (a tool is retired); Retire is its one action', [by('tools').label, ops('tools'), by('tools').actionLabels],
    ['Workshop Assets: Tools & Equipment', [true, true, true, false], ['Retire']]);
  check('staff and user accounts: no delete (they are switched off instead)', [ops('staff'), ops('accounts'), by('accounts').actionLabels],
    [[true, true, true, false], [true, true, true, false], ['Set new password']]);
  check('stock movements and invoice adjustments: no edit or delete', [ops('inventory-transactions'), ops('invoice-adjustments')],
    [[true, true, false, false], [true, true, false, false]]);
  check('settings: view and edit only', ops('settings'), [true, false, true, false]);
  check('only User Accounts is administrators-only (what src/routes/accounts.js enforces)', caps.filter(a => a.adminOnly).map(a => a.key), ['accounts']);
  check('an unknown route is still shown, named from its path; malformed entries are ignored',
    S.capabilities(['GET /api/tyre-stock', 'POST /api/tyre-stock/:id/rotate', 'nonsense', 'PATCH /api/customers', 'GET /api/session']).map(a => [a.key, a.label, a.view, a.actionLabels]),
    [['tyre-stock', 'Tyre Stock', true, ['Rotate']]]);
  check('no routes, no areas', [S.capabilities([]).length, S.capabilities(null).length], [0, 0]);
  check('one role: Administrator (what the Worker accepts)', S.ROLES.map(r => r.name), ['Administrator']);
  check('account counts per role', [JSON.parse(JSON.stringify(S.members(ACCOUNTS, 'Administrator'))), S.members(ACCOUNTS, 'Mechanic').total, S.members(null, 'Administrator').total],
    [{ total: 3, active: 2 }, 0, 0]);
  check('count wording', [S.membersText({ total: 3, active: 2 }), S.membersText({ total: 1, active: 1 }), S.membersText({ total: 0, active: 0 })],
    ['3 accounts (2 active)', '1 account', '0 accounts']);
  const row = S.rowHtml({ key: 'x', label: '<b>Bad</b>', view: true, create: false, edit: false, remove: false, actionLabels: ['<i>'], adminOnly: false });
  ok('a row escapes every value', !row.includes('<b>Bad') && row.includes('&lt;b&gt;Bad&lt;/b&gt;') && row.includes('&lt;i&gt;'), row);
  ok('   ...says "allowed" or "the app has no such action" in words, not only by colour', /View: allowed/.test(row) && /Create: the app has no such action/.test(row), row);
  ok('   ...an area open to anyone signed in says so', /Anyone signed in/.test(row) && !/Administrators only/.test(row), '');
  ok('the User Accounts row says administrators only', /Administrators only/.test(S.rowHtml(by('accounts'))), '');
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
{
  const f = api({ routes: ROUTES, account: { id: 'USR-0001', username: 'jamal', role: 'Administrator' } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('the routes and the accounts are read on demand', f.calls.filter(c => c.path === '/health').length >= 2 && f.calls.some(c => c.path === '/accounts?limit=1000&offset=0'), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written', !f.calls.some(c => c.method && c.method !== 'GET'), '');
  ok('one role card: Administrator, its account count and full access', /data-role="Administrator"/.test(el('ropRoleList').innerHTML)
    && /3 accounts \(2 active\) · 24 areas, full access/.test(el('ropRoleList').innerHTML), el('ropRoleList').innerHTML);
  check('the detail: name, description, account count', [el('ropRoleName').textContent, el('ropRoleDesc').textContent, el('ropRoleMembers').textContent],
    ['Administrator', 'Full access to every part of the app, including user accounts and settings.', '3 accounts (2 active)']);
  ok('   ...its rules, including the two the server checks', /Only an administrator can create accounts.*\(checked by the server\)/.test(el('ropRoleNotes').innerHTML)
    && /At least one active administrator account must always remain \(checked by the server\)/.test(el('ropRoleNotes').innerHTML), '');
  check('the matrix lists every real area', areas(el('ropBody').innerHTML).length, 24);
  check('   ...and says where it came from', el('ropCount').textContent, '24 areas, read from the Worker');
  ok('who is signed in', el('ropWho').textContent === 'You are signed in with the account “jamal” (Administrator).', el('ropWho').textContent);
  ok('no alert when everything loaded', el('ropAlert').hidden === true, '');
}
{
  const { h, el } = page({ fetch: api({ routes: ROUTES }) });
  h.fireReady();
  await tick(80);
  ok('signed in with the passphrase: the page says so', el('ropWho').textContent === 'You are signed in with the shared workshop passphrase.', el('ropWho').textContent);
}

/* ---------- 3. feedback, failures, no backend ---------- */
console.log('\n-- 3. feedback, failures, no backend --');
{
  const f = api({ routes: ROUTES });
  const { h, el } = page({ fetch: f });
  const toasts = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  h.fireReady();
  await tick(80);
  const before = f.calls.length;
  el('ropEdit').dispatch('click', { preventDefault() {} });
  ok('Edit permissions only explains it is unavailable, and why', toasts.length === 1 && toasts[0][1] === 'info'
    && /cannot be edited yet/.test(toasts[0][0]) && /server does not check any narrower permission/.test(toasts[0][0]) && /Nothing was changed/.test(toasts[0][0]), JSON.stringify(toasts));
  ok('   ...and sends nothing', f.calls.length === before, '');
}
{
  const { h, el } = page({ fetch: api({ routes: ROUTES, failAccounts: { status: 403, error: { code: 'forbidden', message: 'Only an administrator can manage user accounts.' } } }) });
  h.fireReady();
  await tick(80);
  ok('accounts refused (403): the permissions are still shown', areas(el('ropBody').innerHTML).length === 24, '');
  ok('   ...the alert says only an administrator can see who holds each role', el('ropAlert').hidden === false && /Only an administrator can see who holds each role/.test(el('ropAlert').textContent), el('ropAlert').textContent);
  ok('   ...and no count is made up', el('ropRoleMembers').textContent === 'Accounts not shown' && /Accounts not shown/.test(el('ropRoleList').innerHTML), el('ropRoleMembers').textContent);
}
{
  const { h, el } = page({ fetch: api({ routes: ROUTES, failAccounts: { status: 500, error: { code: 'database_error', message: 'x' } } }) });
  h.fireReady();
  await tick(80);
  ok('accounts failed (500): permissions shown, the alert says the counts could not be loaded', areas(el('ropBody').innerHTML).length === 24 && /could not be loaded/.test(el('ropAlert').textContent), el('ropAlert').textContent);
}
{
  const f = api({ routes: ROUTES, failHealth: true });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('the route list failed: no matrix, a plain message and Try again', areas(el('ropBody').innerHTML).length === 0
    && /The permissions could not be loaded/.test(el('ropBody').innerHTML) && /data-action="retry"/.test(el('ropBody').innerHTML), el('ropBody').innerHTML);
}
{
  const { h, el } = page({ fetch: api({ routes: ROUTES, failAccounts: { status: 401, error: { code: 'unauthorized', message: 'Sign in.' } } }) });
  h.fireReady();
  await tick(80);
  ok('session ended (401): says so and offers to sign in again, no matrix', /Your session has ended/.test(el('ropBody').innerHTML) && /data-action="signin"/.test(el('ropBody').innerHTML) && areas(el('ropBody').innerHTML).length === 0, '');
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(60);
  ok('no backend: the page says it needs the workshop database, and shows no permissions', /needs the workshop database/.test(el('ropBody').innerHTML) && areas(el('ropBody').innerHTML).length === 0, '');
}

summary('staff-roles');
})().catch(e => { console.error(e); process.exit(1); });
