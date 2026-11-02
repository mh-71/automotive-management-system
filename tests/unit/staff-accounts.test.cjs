/* staff-accounts — Staff Management › User Accounts, connected to the database.

   Drives the REAL js/staff-accounts.js (with the real api.js, storage.js,
   utils.js and app.js) through the shared harness, against a fake API that
   answers /api/accounts and /api/staff the way the Worker does.

     1. Helpers: search (name, staff ID, username), filters and sort, the staff
        eligible for an account (active, none yet), the summary cards, the
        username suggestion, the password and create-form rules, and rows that
        are escaped, mark your own account and disable what the Worker refuses.
     2. The page in 'api' mode: accounts and staff loaded on demand, rows and
        cards, search / role / status filters, Clear filters, who is signed in.
     3. Empty and no-results states; a refused (403), failed (500) or ended
        (401) load each say so, with no rows; no backend shows nothing.
     4. Writes: Create sends exactly { staffId, username, role, password } and
        clears the password fields; a duplicate (409) keeps the dialog open;
        Deactivate asks first and sends only { status }; Set new password sends
        only { password } through the action route.
     5. Signing in with an account: Api.loginAccount sends { username,
        password } and answers a 401 in plain words; Api.session reads the
        account; nothing about an account or a password reaches browser storage. */
const vm = require('vm');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const { fakeApi } = require('../lib/fake-api.cjs');

const tick = (ms = 40) => new Promise(r => setTimeout(r, ms));

const STAFF = [
  { id: 'MEC-0001', isMechanic: true, name: 'Jamal Uddin', designation: 'Mechanic', department: 'Workshop', status: 'Active' },
  { id: 'MEC-0002', isMechanic: true, name: 'Kamal', designation: 'Senior Mechanic', department: 'Workshop', status: 'Active' },
  { id: 'STF-0001', isMechanic: false, name: 'Nadia Akter', designation: 'Accountant', department: 'Accounts', status: 'Active' },
  { id: 'STF-0002', isMechanic: false, name: 'Gone Staff', designation: 'Helper', department: 'Workshop', status: 'Inactive' },
];
const acct = (id, staffId, staffName, username, extra = {}) => ({ id, staffId, isMechanic: staffId.startsWith('MEC'), staffName, staffStatus: 'Active',
  designation: '', username, role: 'Super Admin', status: 'Active', locked: false, lastLoginAt: '', passwordChangedAt: '2026-10-01T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z', self: false, ...extra });
const ACCOUNTS = [
  acct('USR-0001', 'MEC-0001', 'Jamal Uddin', 'jamal', { self: true, lastLoginAt: '2026-10-22T08:30:00.000Z' }),
  acct('USR-0002', 'STF-0001', '<img src=x onerror=alert(1)>', 'nadia', { status: 'Inactive' }),
];

// GET /api/roles as the Worker answers it (0018): canManage = this caller may give the role.
const ROLES = [
  { id: 'ROL-0001', name: 'Super Admin', status: 'Active', canManage: true },
  { id: 'ROL-0002', name: 'Admin', status: 'Active', canManage: false },
  { id: 'ROL-0004', name: 'Accountant', status: 'Inactive', canManage: true },
  { id: 'ROL-0007', name: 'Mechanic', status: 'Active', canManage: true },
];
/** fakeApi for the hydrated collections; /accounts, /staff and /roles answered as the Worker would. */
function api({ accounts = ACCOUNTS, staff = STAFF, failAccounts = null, failWrite = null, account = null } = {}) {
  const base = fakeApi({ rows: { mechanics: [] } });
  const calls = base.calls;
  const db = JSON.parse(JSON.stringify(accounts));
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fn = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+\/api/, '');
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (path === '/session' && method === 'GET') {
      return res(200, { data: { authenticated: true, passphrase: true, accounts: true, ...(account ? { account } : {}) } });
    }
    if (path.startsWith('/staff')) { calls.push({ method, path, body }); return res(200, { data: staff, total: staff.length }); }
    if (path.startsWith('/roles')) { calls.push({ method, path, body }); return res(200, { data: ROLES, total: ROLES.length }); }
    if (!path.startsWith('/accounts')) return base(url, init);
    calls.push({ method, path, body });
    if (failAccounts) return res(failAccounts.status, { error: failAccounts.error });
    const [, , id, action] = path.split('?')[0].split('/');
    if (method === 'GET' && !id) return res(200, { data: db, count: db.length, total: db.length });
    if (method === 'POST' && !id) {
      if (failWrite) return res(failWrite.status, { error: failWrite.error });
      const rec = acct(`USR-000${db.length + 1}`, body.staffId, STAFF.find(s => s.id === body.staffId).name, body.username);
      db.push(rec);
      return res(201, { data: rec });
    }
    const row = db.find(a => a.id === id);
    if (!row) return res(404, { error: { code: 'not_found', message: 'No account with that id.' } });
    if (method === 'GET') return res(200, { data: row });
    if (method === 'PUT') { Object.assign(row, body); return res(200, { data: row }); }
    if (method === 'POST' && action === 'password') return res(200, { data: row });
    return res(405, { error: { code: 'method_not_allowed', message: 'x' } });
  };
  fn.calls = calls;
  return fn;
}

function page({ origin = 'http://localhost:8787', fetch } = {}) {
  const h = boot({ origin, fetch, modules: ['js/staff-accounts.js'] });
  vm.runInContext('globalThis.StaffAccounts = StaffAccounts;', h.ctx);
  const el = id => h.ctx.document.getElementById(id);
  return { h, el, S: h.ctx.StaffAccounts };
}
const rowIds = html => [...html.matchAll(/<tr data-id="([^"]+)"/g)].map(m => m[1]);
const click = (el, action, id) => el('uacBody').dispatch('click', { target: { closest: () => ({ dataset: { action, id }, disabled: false }) } });

/** A stand-in for a modal's form, so the real dialog code can be driven: values in, clicks out. */
function fakeModal(values) {
  const inputs = {};
  for (const [sel, value] of Object.entries(values)) { const e = makeElement(sel); e.value = value; e.type = /pw|password|confirm/.test(sel) ? 'password' : 'text'; inputs[sel] = e; }
  const save = makeElement('save'); save._on = {};
  const form = makeElement('form');
  form.querySelector = sel => inputs[sel] || null;
  form.querySelectorAll = sel => (sel === 'input[type="password"]' ? Object.values(inputs).filter(e => e.type === 'password') : []);
  const ov = { querySelector: sel => (sel === '[data-save]' ? save : sel === '#uacForm' || sel === '#uacPwForm' ? form : null) };
  return { ov, save, inputs, press: () => Promise.all((save._on.click || []).map(cb => cb({ currentTarget: save }))) };
}

(async () => {
console.log('=== staff-accounts: User Accounts ===\n');

/* ---------- 1. helpers ---------- */
console.log('-- 1. helpers --');
{
  const { S } = page({ origin: '' });
  const ids = (list) => list.map(a => a.id);
  check('search: name, staff ID, username, any case', [ids(ACCOUNTS.filter(a => S.matchesSearch(a, 'JAMAL'))), ids(ACCOUNTS.filter(a => S.matchesSearch(a, 'stf-0001'))), ids(ACCOUNTS.filter(a => S.matchesSearch(a, 'nad')))],
    [['USR-0001'], ['USR-0002'], ['USR-0002']]);
  check('filters: status and role', [ids(S.filterAccounts(ACCOUNTS, { status: 'Inactive' })), S.filterAccounts(ACCOUNTS, { role: 'Super Admin' }).length, S.filterAccounts(ACCOUNTS, { role: 'Mechanic' }).length], [['USR-0002'], 2, 0]);
  check('eligible for an account: active staff without one, sorted by name', S.eligibleStaff(STAFF, ACCOUNTS).map(s => s.id), ['MEC-0002']);
  check('summary cards', JSON.parse(JSON.stringify(S.summary(ACCOUNTS, STAFF))), { total: 2, active: 1, inactive: 1, none: 1 });
  check('username suggestions', [S.suggestUsername('Nadia Akter'), S.suggestUsername('José  Núñez Pérez'), S.suggestUsername('নাদিয়া'), S.suggestUsername('Al')], ['nadia.akter', 'jose.nunez', '', '']);
  check('password rules', [S.passwordProblem('short'), S.passwordProblem('kamal-is-my-name', 'kamal'), S.passwordProblem(' padded-password '), S.passwordProblem('Correct-Horse-42', 'kamal')],
    ['Use at least 10 characters.', 'The password cannot contain the username.', 'The password cannot start or end with a space.', null]);
  S.setRoles(ROLES, true);
  const v = x => Object.keys(S.validateCreate({ staffId: 'MEC-0002', username: 'kamal', role: 'Mechanic', password: 'Correct-Horse-42', confirm: 'Correct-Horse-42', ...x })).sort();
  check('create form: a complete form passes', v({}), []);
  check('create form: staff, username, role, password, and the repeat must match', [v({ staffId: '' }), v({ username: 'Ka Mal' }), v({ role: 'Admin' }), v({ password: 'x', confirm: 'x' }), v({ confirm: 'Correct-Horse-43' })],
    [['staffId'], ['username'], ['role'], ['password'], ['confirm']]);
  check('only roles this user may give are offered: active, and within their own permissions (canManage)', S.ROLES.filter(r => r.assignable).map(r => r.name), ['Super Admin', 'Mechanic']);
  S.setRoles(ROLES, false);
  check('   ...none at all without Roles: assign', S.ROLES.filter(r => r.assignable).length, 0);
  const mine = S.rowHtml(ACCOUNTS[0]), other = S.rowHtml(ACCOUNTS[1]);
  ok('a row escapes every value', !other.includes('<img src=x') && other.includes('&lt;img src=x onerror=alert(1)&gt;'), other);
  ok('your own account is marked, and its Deactivate is disabled with the reason', /badge--neutral">You</.test(mine) && /data-action="deactivate"[^>]*title="You cannot deactivate your own account\."[^>]*disabled/.test(mine), mine);
  ok('an inactive account offers Activate', /data-action="activate" data-id="USR-0002"/.test(other) && !/data-action="activate"[^>]*disabled/.test(other), other);
  const left = S.rowHtml({ ...ACCOUNTS[1], staffStatus: 'Inactive' });
  ok('...but not when the staff member is inactive (disabled, with the reason)', /data-action="activate"[^>]*title="Activate the staff member in the Staff List first\."[^>]*disabled/.test(left) && /Staff inactive/.test(left), left);
  ok('a paused account says so', /Paused/.test(S.rowHtml({ ...ACCOUNTS[0], locked: true })), '');
  ok('no row ever holds a password, hash or session field', ![mine, other].some(h => /password_hash|pbkdf2|session|type="password"/i.test(h)), '');
}

/* ---------- 2. the page, connected ---------- */
console.log('\n-- 2. the page in api mode --');
{
  const f = api({ account: { id: 'USR-0001', username: 'jamal', role: 'Super Admin' } });
  const { h, el, S } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  ok('accounts and staff are loaded on demand', f.calls.some(c => c.path === '/accounts?limit=1000&offset=0') && f.calls.some(c => c.path.startsWith('/staff')), JSON.stringify(f.calls.map(c => c.path)));
  ok('   ...and nothing is written by loading', !f.calls.some(c => c.method && c.method !== 'GET'), '');
  ok('the controls are enabled once loaded', ['uacSearch', 'uacRole', 'uacStatus', 'uacClear', 'uacCreate'].every(id => el(id).disabled === false), '');
  check('every account is a row, sorted by name', rowIds(el('uacBody').innerHTML), ['USR-0002', 'USR-0001']);
  check('the cards come from the data', ['uacTotal', 'uacActive', 'uacInactive', 'uacNone'].map(id => el(id).textContent), ['2', '1', '1', '1']);
  check('the role filter offers every role (from GET /api/roles)', (el('uacRole').innerHTML.match(/<option value="([^"]+)"/g) || []).length, 5);
  check('it says who is signed in', el('uacWho').textContent, 'You are signed in with the account “jamal” (Super Admin).');
  el('uacStatus').dispatch('change', { target: { value: 'Inactive' } });
  check('status filter', rowIds(el('uacBody').innerHTML), ['USR-0002']);
  el('uacStatus').dispatch('change', { target: { value: 'Retired' } });
  check('   ...an unknown status is treated as "all"', S.state.status, 'all');
  el('uacSearch').dispatch('input', { target: { value: 'jam' } });
  await tick(260);
  check('search', rowIds(el('uacBody').innerHTML), ['USR-0001']);
  el('uacSearch').dispatch('input', { target: { value: 'nobody' } });
  await tick(260);
  ok('no results: says so, with Clear filters', /No accounts match/.test(el('uacBody').innerHTML) && /data-action="clear"/.test(el('uacBody').innerHTML), '');
  S.clearFilters();
  check('Clear filters shows everyone again', rowIds(el('uacBody').innerHTML).length, 2);
}
{
  const { h, el } = page({ fetch: api() });
  h.fireReady();
  await tick(80);
  check('a passphrase session is described as such', el('uacWho').textContent, 'You are signed in with the shared workshop passphrase.');
}

/* ---------- 3. empty, failures, no backend ---------- */
console.log('\n-- 3. empty, failures, no backend --');
{
  const { h, el } = page({ fetch: api({ accounts: [] }) });
  h.fireReady();
  await tick(80);
  ok('no accounts yet: says so, with Create Account', /No user accounts yet/.test(el('uacBody').innerHTML) && /data-action="create"/.test(el('uacBody').innerHTML), '');
}
for (const [label, status, code, re] of [
  ['refused (403)', 403, 'forbidden', /Your role does not include User Accounts/],
  ['failed (500)', 500, 'database_error', /could not be loaded[\s\S]*data-action="retry"/],
  ['ended session (401)', 401, 'unauthorized', /Your session has ended[\s\S]*data-action="signin"/]]) {
  const { h, el } = page({ fetch: api({ failAccounts: { status, error: { code, message: 'x' } } }) });
  h.fireReady();
  await tick(80);
  const html = el('uacBody').innerHTML;
  ok(`a ${label} load says so and shows no rows`, re.test(html) && rowIds(html).length === 0, html.slice(0, 200));
  ok('   ...and the controls stay disabled', el('uacCreate').disabled === true && el('uacSearch').disabled === true, '');
}
{
  const { h, el } = page({ origin: '' });
  h.fireReady();
  await tick(40);
  ok('no backend: the page says it needs the workshop database, and shows no one', /needs the workshop database/.test(el('uacBody').innerHTML) && rowIds(el('uacBody').innerHTML).length === 0, '');
  const w = await h.ctx.Storage.create('accounts', { username: 'x' });
  check('   ...and Storage refuses to write accounts to browser storage', [w.ok, w.code], [false, 'no_api']);
}

/* ---------- 4. writes ---------- */
console.log('\n-- 4. writes --');
{
  const f = api();
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  let opened = null;
  const m = fakeModal({ '#ua-staff': 'MEC-0002', '#ua-username': ' Kamal ', '#ua-role': 'Mechanic', '#ua-password': 'Correct-Horse-42', '#ua-confirm': 'Correct-Horse-42' });
  h.ctx.Utils.Modal.open = (opts) => { opened = opts; return m.ov; };
  const toasts = [];
  h.ctx.Utils.toast = (msg, type) => toasts.push([msg, type]);
  el('uacCreate').dispatch('click');
  ok('Create Account opens a dialog listing only staff who can have an account', opened && /value="MEC-0002"/.test(opened.body) && !/value="MEC-0001"|value="STF-0001"|value="STF-0002"/.test(opened.body), opened && opened.body.slice(0, 300));
  ok('   ...whose role list has only the roles this user may give (not Admin, not the inactive Accountant)', opened
    && /<option value="Super Admin">/.test(opened.body) && /<option value="Mechanic">/.test(opened.body)
    && !/<option value="Admin">|<option value="Accountant">/.test(opened.body), opened && opened.body.slice(0, 400));
  await m.press();
  await tick(20);
  const post = f.calls.find(c => c.method === 'POST' && c.path === '/accounts');
  check('Create sends exactly staffId, username (lower case, trimmed), role and password', post && post.body, { staffId: 'MEC-0002', username: 'kamal', role: 'Mechanic', password: 'Correct-Horse-42' });
  check('   ...and clears both password fields afterwards', [m.inputs['#ua-password'].value, m.inputs['#ua-confirm'].value], ['', '']);
  ok('   ...the new account is listed, and the success says so', rowIds(el('uacBody').innerHTML).includes('USR-0003') && toasts.some(([t, k]) => k === 'success' && /kamal/.test(t)), JSON.stringify(toasts));

  // Deactivate asks first, then sends only the status.
  let confirmed = null;
  h.ctx.Utils.Modal.confirm = (opts) => { confirmed = opts; };
  click(el, 'deactivate', 'USR-0003');
  ok('Deactivate asks first, saying the person is signed out everywhere and nothing is deleted', confirmed && /signed out everywhere/.test(confirmed.message) && /Nothing is deleted/.test(confirmed.message), '');
  check('   ...nothing is sent before confirming', f.calls.filter(c => c.method === 'PUT').length, 0);
  await confirmed.onConfirm();
  await tick(20);
  check('   ...then PUT /accounts/:id with only the status', JSON.stringify(f.calls.filter(c => c.method === 'PUT').map(c => [c.path, c.body])), JSON.stringify([['/accounts/USR-0003', { status: 'Inactive' }]]));

  // Set a new password: only the password, through the action route.
  const p = fakeModal({ '#ua-newpw': 'Another-Password-1', '#ua-newpw2': 'Another-Password-1' });
  h.ctx.Utils.Modal.open = () => p.ov;
  click(el, 'password', 'USR-0003');
  await p.press();
  await tick(20);
  const reset = f.calls.find(c => c.path === '/accounts/USR-0003/password');
  check('Set new password sends only the password, to the action route', reset && [reset.method, reset.body], ['POST', { password: 'Another-Password-1' }]);
  check('   ...and clears the fields', [p.inputs['#ua-newpw'].value, p.inputs['#ua-newpw2'].value], ['', '']);
  const q = fakeModal({ '#ua-newpw': 'Another-Password-1', '#ua-newpw2': 'Different-Password-1' });
  h.ctx.Utils.Modal.open = () => q.ov;
  click(el, 'password', 'USR-0003');
  await q.press();
  await tick(20);
  check('   ...two different passwords send nothing', f.calls.filter(c => c.path === '/accounts/USR-0003/password').length, 1);
  ok('nothing about an account or a password reached browser storage',
    !/Correct-Horse|Another-Password|kamal|jamal/.test(JSON.stringify([...Array(1)].map(() => h.ctx.localStorage.getItem('taqwa_accounts')))) && h.ctx.localStorage.getItem('taqwa_accounts') === null, '');
}
{
  const f = api({ failWrite: { status: 409, error: { code: 'conflict', message: 'That username is already taken.', field: 'username', fields: { username: 'That username is already taken.' } } } });
  const { h, el } = page({ fetch: f });
  h.fireReady();
  await tick(80);
  const m = fakeModal({ '#ua-staff': 'MEC-0002', '#ua-username': 'nadia', '#ua-role': 'Mechanic', '#ua-password': 'Correct-Horse-42', '#ua-confirm': 'Correct-Horse-42' });
  h.ctx.Utils.Modal.open = () => m.ov;
  let closed = false;
  h.ctx.Utils.Modal.close = () => { closed = true; };
  el('uacCreate').dispatch('click');
  await m.press();
  await tick(20);
  ok('a duplicate username (409): the request was made and the dialog stays open', f.calls.some(c => c.method === 'POST' && c.path === '/accounts') && !closed, '');
  check('   ...the passwords are still cleared', m.inputs['#ua-password'].value, '');
  check('   ...and no account was added to the list', rowIds(el('uacBody').innerHTML).length, 2);
}

/* ---------- 5. signing in with an account ---------- */
console.log('\n-- 5. account sign-in (client) --');
{
  const sent = [];
  const fetch = async (url, init = {}) => {
    sent.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith('/session') && init.method === 'POST') return { status: 401, ok: false, json: async () => ({ error: { code: 'unauthorized', message: 'Authentication required.' } }) };
    return { status: 200, ok: true, json: async () => ({ data: { authenticated: true, passphrase: true, accounts: true, account: { id: 'USR-0001', username: 'jamal', role: 'Administrator', extra: 'ignored' } } }) };
  };
  const { h } = page({ fetch });
  const r = await h.ctx.Api.loginAccount('jamal', 'Wrong-Password-1');
  const post = sent.find(x => x.method === 'POST');
  check('Api.loginAccount posts only the username and password to /session', post && [post.url.endsWith('/api/session'), post.body], [true, { username: 'jamal', password: 'Wrong-Password-1' }]);
  check('   ...a 401 is answered in plain words, no more', [r.ok, r.code, r.message], [false, 'unauthorized', 'That username and password were not accepted.']);
  const w = await h.ctx.Storage.signInWithAccount('jamal', 'Wrong-Password-1');
  check('Storage.signInWithAccount reports the same refusal', [w.ok, w.code], [false, 'unauthorized']);
  const s = await h.ctx.Api.session();
  check('Api.session reads whether accounts can sign in, and the account (id, username, role only)', [s.accounts, JSON.parse(JSON.stringify(s.account))], [true, { id: 'USR-0001', username: 'jamal', role: 'Administrator' }]);
  ok('the password never reached browser storage', !JSON.stringify(Object.keys(h.ctx.localStorage)).includes('Wrong') && h.ctx.localStorage.getItem('taqwa_accounts') === null, '');
}

process.exit(summary('staff-accounts') === 0 ? 0 : 1);
})();
