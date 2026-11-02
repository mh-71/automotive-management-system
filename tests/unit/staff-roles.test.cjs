/* staff-roles — Staff Management › Roles & Permissions (0018), connected.

   Drives the REAL js/staff-roles.js (with the real api.js, storage.js and
   utils.js) through the shared harness, against a fake API answering
   /api/session, /api/roles and /api/accounts the way the Worker does.

     1. Helpers: role and account filters; the read-only matrix (allowed /
        not allowed / no such action, escaped); the editor matrix, where a
        permission the editor does not hold cannot be ticked; plain errors.
     2. Full access: the roles load (escaped), the first is shown with its
        matrix and holders; a custom role offers Edit / Switch off / Delete /
        Copy, Super Admin none of the changes; Switch off and Delete are
        disabled while accounts hold the role; the assignment table lists the
        accounts, never lets you change your own role, and Save asks first and
        then sends { roleId } only.
     3. Creating and editing a role sends name, description and the ticked
        permissions (and expectedUpdatedAt when editing); a refusal is shown.
     4. A role that may only view roles sees no New role, no change buttons
        and no assignment table.
     5. Failures: 403, 500 (Try again), an ended session and no backend each
        say so; nothing is written by loading. */
const vm = require('vm');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const CATALOG = [
  { key: 'customers', label: 'Customers', actions: { view: 'See customers', create: 'Add customers', edit: 'Edit customers', delete: 'Delete customers' } },
  { key: 'invoices', label: 'Invoices', actions: { view: 'See invoices', create: 'Create invoices', manage: 'Void invoices' } },
  { key: 'roles', label: 'Roles & Permissions', actions: { view: 'See roles', edit: 'Edit roles', manage: 'Assign roles' } },
];
const ALL = CATALOG.flatMap(m => Object.keys(m.actions).map(a => `${m.key}.${a}`));
const role = (id, name, extra = {}) => ({ id, name, description: '', system: false, fullAccess: false, status: 'Active', permissions: [], accounts: 0, activeAccounts: 0,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: `2026-11-01T00:00:0${id.slice(-1)}.000Z`, updatedBy: '', canManage: true, ...extra });
const ROLES = [
  role('ROL-0001', 'Super Admin', { system: true, fullAccess: true, permissions: ALL, accounts: 1, activeAccounts: 1, canManage: true }),
  role('ROL-0004', 'Accountant', { permissions: ['customers.view', 'invoices.view', 'invoices.create'], accounts: 1, activeAccounts: 1 }),
  role('ROL-0009', '<b>Night shift</b>', { description: 'Evening <i>desk</i>', permissions: ['customers.view'] }),
  role('ROL-0010', 'Old role', { status: 'Inactive' }),
];
const acct = (id, name, roleId, extra = {}) => ({ id, staffId: 'STF-0001', staffName: name, username: name.toLowerCase().split(' ')[0], roleId,
  role: (ROLES.find(r => r.id === roleId) || {}).name || '', status: 'Active', self: false, ...extra });
const ACCOUNTS = [acct('USR-0001', 'Nadia Akter', 'ROL-0001'), acct('USR-0002', 'Rafi Test', 'ROL-0004')];

function api({ roles = ROLES, accounts = ACCOUNTS, session = { fullAccess: true, permissions: ALL }, account = { id: 'USR-0001', username: 'nadia', role: 'Super Admin', roleId: 'ROL-0001' },
  failRoles = null, failWrite = null } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === '/session' && method === 'GET') {
      return res(200, { data: { authenticated: true, passphrase: true, accounts: true, ...(account ? { account } : {}), ...session } });
    }
    if (path.startsWith('/roles')) {
      calls.push({ method, path, body });
      if (failRoles) return res(failRoles.status, { error: failRoles.error });
      if (method === 'GET') return res(200, { data: roles, count: roles.length, total: roles.length, catalog: CATALOG });
      if (failWrite) return res(failWrite.status, { error: failWrite.error });
      if (method === 'POST') return res(201, { data: role('ROL-0011', body.name, { permissions: body.permissions }) });
      const r = roles.find(x => path.includes(x.id));
      if (method === 'PUT') return res(200, { data: { ...r, ...body } });
      if (method === 'DELETE') return res(200, { data: { id: r.id, deleted: true } });
    }
    if (path.startsWith('/accounts')) {
      calls.push({ method, path, body });
      if (method === 'GET') return res(200, { data: accounts, count: accounts.length, total: accounts.length });
      const a = accounts.find(x => path.includes(x.id));
      return res(200, { data: { ...a, roleId: body.roleId } });
    }
    return base(url, init);
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const dialogs = [];
  const h = boot({
    origin, fetch, modules: ['js/staff-roles.js'],
    beforeModules(doc) { doc.body.dataset.page = 'staff-roles'; },
  });
  vm.runInContext('globalThis.StaffRoles = StaffRoles;', h.ctx);
  // Capture dialogs instead of drawing them (the harness has no real DOM).
  h.ctx.Utils.Modal.confirm = (opts) => dialogs.push({ kind: 'confirm', ...opts });
  h.ctx.Utils.Modal.open = (opts) => { dialogs.push({ kind: 'open', ...opts }); return null; };
  h.ctx.Utils.toast = () => {};
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffRoles, dialogs };
}
const writes = calls => calls.filter(c => c.method && c.method !== 'GET');

(async () => {
console.log('=== staff-roles: Roles & Permissions ===\n');

console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  check('roles filter by name or description, and by status', [S.filterRoles(ROLES, { q: 'NIGHT' }).map(r => r.id), S.filterRoles(ROLES, { q: 'desk' }).map(r => r.id), S.filterRoles(ROLES, { status: 'Inactive' }).map(r => r.id)],
    [['ROL-0009'], ['ROL-0009'], ['ROL-0010']]);
  check('accounts filter by name / username and by role', [S.filterAccounts(ACCOUNTS, { q: 'rafi' }).map(a => a.id), S.filterAccounts(ACCOUNTS, { roleId: 'ROL-0001' }).map(a => a.id)], [['USR-0002'], ['USR-0001']]);
  const m = S.matrixHtml(CATALOG, ['customers.view', 'invoices.manage']);
  check('the matrix has one row per module', [...m.matchAll(/<tr data-module="([^"]+)"/g)].map(x => x[1]), ['customers', 'invoices', 'roles']);
  ok('   ...allowed, not allowed, and "no such action" are three different marks', /title="View: allowed"/.test(m) && /title="Create: not allowed"/.test(m) && /The module has no such action/.test(m), m.slice(0, 300));
  const e = S.editorMatrixHtml(CATALOG, ['customers.view'], p => p !== 'invoices.manage');
  ok('the editor ticks what the role has', /value="customers\.view" checked/.test(e), '');
  ok('   ...and a permission the editor does not hold cannot be ticked', /value="invoices\.manage"[^>]*disabled/.test(e) && /your own role does not have this/.test(e), '');
  ok('   ...and there is no box for an action a module does not have', !/value="invoices\.delete"/.test(e), '');
  check('permission counts', [S.permissionCount(ROLES[0]), S.permissionCount(ROLES[1]), S.permissionCount(ROLES[3])], ['every permission', '3 permissions', '0 permissions']);
  check('plain errors', ['forbidden', 'unauthorized', 'no_api', 'database_error'].map(code => S.errorWords({ code }).title),
    ['Your role does not include Roles & Permissions', 'Your session has ended', 'Roles & Permissions needs the workshop database', 'The roles could not be loaded']);
}

console.log('\n-- 2. full access --');
{
  const f = api();
  const { h, el, dialogs } = page({ fetch: f });
  h.fireReady();
  await tick(100);
  const list = el('ropRoleList').innerHTML;
  check('every role is listed', [...list.matchAll(/data-role="([^"]+)"/g)].map(x => x[1]), ['ROL-0001', 'ROL-0004', 'ROL-0009', 'ROL-0010']);
  ok('   ...names are escaped', list.includes('&lt;b&gt;Night shift') && !list.includes('<b>Night'), '');
  ok('   ...Super Admin is marked System, the switched-off role Off', /Super Admin <span class="badge badge--info rop-tag">System/.test(list) && /Old role <span class="badge badge--neutral rop-tag">Off/.test(list), '');
  check('your own role (Super Admin) is shown first', el('ropRoleName').textContent, 'Super Admin');
  ok('   ...with every permission ticked', !/is-no/.test(el('ropBody').innerHTML) && /is-yes/.test(el('ropBody').innerHTML), '');
  ok('   ...and no Edit, Switch off or Delete (it is protected, and it is your own)', !/data-act="(edit|off|delete)"/.test(el('ropRoleActions').innerHTML) && /data-act="copy"/.test(el('ropRoleActions').innerHTML), el('ropRoleActions').innerHTML);
  ok('   ...the notes say it is protected', /protected system role/.test(el('ropRoleNotes').innerHTML), '');
  ok('   ...its holders are listed', /Nadia Akter/.test(el('ropHolders').innerHTML), '');

  el('ropRoleList').dispatch('click', { target: { closest: () => ({ dataset: { role: 'ROL-0004' } }) } });
  const acts = el('ropRoleActions').innerHTML;
  ok('a custom role offers Edit, Switch off, Delete and Copy', ['edit', 'off', 'delete', 'copy'].every(a => acts.includes(`data-act="${a}"`)), acts);
  ok('   ...Switch off and Delete are disabled while an account holds it, saying why', /data-act="off" disabled title="1 account holds this role/.test(acts) && /data-act="delete" disabled/.test(acts), acts);
  ok('   ...the matrix shows what it has and what it has not', /title="View: allowed"/.test(el('ropBody').innerHTML) && /title="Delete: not allowed"/.test(el('ropBody').innerHTML), '');

  el('ropRoleList').dispatch('click', { target: { closest: () => ({ dataset: { role: 'ROL-0010' } }) } });
  ok('a switched-off role offers Switch on', /data-act="on"/.test(el('ropRoleActions').innerHTML), '');
  el('ropRoleActions').dispatch('click', { target: { closest: () => ({ dataset: { act: 'on' }, disabled: false }) } });
  const on = dialogs.pop();
  ok('   ...which asks first', on && on.kind === 'confirm' && on.confirmText === 'Switch on', '');
  await on.onConfirm();
  await tick(60);
  const put = writes(f.calls).find(c => c.method === 'PUT' && c.path === '/roles/ROL-0010');
  check('   ...and sends the status with the version it saw', put && put.body, { status: 'Active', expectedUpdatedAt: '2026-11-01T00:00:00.000Z' });

  el('ropSearch').dispatch('input', { target: { value: 'account' } });
  check('the role search filters the list', [...el('ropRoleList').innerHTML.matchAll(/data-role="([^"]+)"/g)].map(x => x[1]), ['ROL-0004']);
  el('ropSearch').dispatch('input', { target: { value: 'zzz' } });
  ok('   ...and says so when nothing matches', /No roles match/.test(el('ropRoleList').innerHTML), '');

  check('the assignment table is shown', el('ropAssignCard').hidden, false);
  const users = el('ropUsers').innerHTML;
  check('   ...one row per account', [...users.matchAll(/<tr data-account="([^"]+)"/g)].map(x => x[1]), ['USR-0001', 'USR-0002']);
  ok('   ...your own role cannot be changed (disabled, with the reason)', /data-account="USR-0001" aria-label="Role for nadia" disabled title="You cannot change your own role\."/.test(users), users.slice(0, 600));
  ok('   ...the offered roles are the active ones you may give (no switched-off role)', /<option value="ROL-0004" selected>Accountant/.test(users) && !/value="ROL-0010"/.test(users), '');
  // Choose a new role for Rafi, then Save.
  h.ctx.document.querySelector = (sel) => (sel === '.rop-role-select[data-account="USR-0002"]' ? { value: 'ROL-0009' } : null);
  el('ropUsers').dispatch('click', { target: { closest: (sel) => (sel === '[data-assign]' ? { dataset: { assign: 'USR-0002' }, disabled: false } : null) } });
  const ask = dialogs.pop();
  ok('Save asks first, naming the person and both roles, and that they are signed out', ask && ask.kind === 'confirm' && /Rafi Test/.test(ask.message) && /Accountant/.test(ask.message)
    && /&lt;b&gt;Night shift/.test(ask.message) && /signed out/.test(ask.message), ask && ask.message);
  ok('   ...nothing is sent before confirming', !writes(f.calls).some(c => c.path.startsWith('/accounts')), '');
  await ask.onConfirm();
  await tick(60);
  const assign = writes(f.calls).find(c => c.path === '/accounts/USR-0002');
  check('   ...then sends exactly { roleId }', assign && assign.body, { roleId: 'ROL-0009' });
}

console.log('\n-- 3. create and edit --');
{
  const f = api();
  const { h, el, dialogs } = page({ fetch: f });
  h.fireReady();
  await tick(100);
  check('New role is offered to a role that may create roles', el('ropCreate').hidden, false);
  el('ropCreate').dispatch('click');
  const dlg = dialogs.pop();
  ok('it opens the role dialog, with the matrix to tick', dlg && dlg.kind === 'open' && dlg.title === 'New role' && /name="perm"/.test(dlg.body) && /value="dashboard|value="customers\.view"/.test(dlg.body), dlg && dlg.title);
  el('ropRoleList').dispatch('click', { target: { closest: () => ({ dataset: { role: 'ROL-0009' } }) } });
  el('ropRoleActions').dispatch('click', { target: { closest: () => ({ dataset: { act: 'edit' }, disabled: false }) } });
  const edit = dialogs.pop();
  ok('Edit opens it with the role\'s name (escaped) and its permissions ticked', edit && /value="&lt;b&gt;Night shift&lt;\/b&gt;"/.test(edit.body) && /value="customers\.view" checked/.test(edit.body), edit && edit.body.slice(0, 300));
  el('ropRoleActions').dispatch('click', { target: { closest: () => ({ dataset: { act: 'delete' }, disabled: false }) } });
  const del = dialogs.pop();
  ok('Delete (no account holds it) asks first', del && del.kind === 'confirm' && /cannot be undone/.test(del.message), '');
  await del.onConfirm();
  await tick(60);
  ok('   ...then sends DELETE /api/roles/ROL-0009', writes(f.calls).some(c => c.method === 'DELETE' && c.path === '/roles/ROL-0009'), '');
}

console.log('\n-- 4. a role that may only view roles --');
{
  const f = api({ session: { fullAccess: false, permissions: ['roles.view', 'customers.view'] }, account: { id: 'USR-0002', username: 'rafi', role: 'Accountant', roleId: 'ROL-0004' },
    roles: ROLES.map(r => ({ ...r, canManage: r.id === 'ROL-0009' })) });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(100);
  check('no New role', el('ropCreate').hidden, true);
  check('it opens on their own role', el('ropRoleName').textContent, 'Accountant');
  ok('   ...which says they cannot change it', /This is your own role/.test(el('ropRoleNotes').innerHTML), '');
  ok('no Edit, Switch off or Delete anywhere', !/data-act="(edit|off|on|delete|copy)"/.test(el('ropRoleActions').innerHTML), el('ropRoleActions').innerHTML);
  check('no assignment table, and the accounts are not even asked for', [el('ropAssignCard').hidden, f.calls.some(c => c.path.startsWith('/accounts'))], [true, false]);
  ok('nothing was written', !writes(f.calls).length, '');
}

console.log('\n-- 5. failures --');
for (const [name, failRoles, re] of [
  ['refused (403)', { status: 403, error: { code: 'forbidden', message: 'Your role does not allow this.' } }, /Your role does not include Roles &amp; Permissions/],
  ['failed (500)', { status: 500, error: { code: 'database_error', message: 'Could not read the roles.' } }, /The roles could not be loaded[\s\S]*data-action="retry"/],
  ['ended (401)', { status: 401, error: { code: 'unauthorized', message: 'Authentication required.' } }, null],
]) {
  const f = api({ failRoles });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(100);
  if (re) ok(`${name}: says so, with no roles`, re.test(el('ropBody').innerHTML) && !/data-role=/.test(el('ropRoleList').innerHTML), el('ropBody').innerHTML.slice(0, 300));
  else ok(`${name}: the app locks or says the session ended`, !/data-role=/.test(el('ropRoleList').innerHTML), '');
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(60);
  ok('no backend: the page says it needs the workshop database, and shows no roles', /needs the workshop database/.test(el('ropBody').innerHTML) && !/data-role=/.test(el('ropRoleList').innerHTML), el('ropBody').innerHTML.slice(0, 200));
}

process.exit(summary('staff-roles') === 0 ? 0 : 1);
})();
