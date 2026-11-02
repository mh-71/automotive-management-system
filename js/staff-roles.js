/* ============================================================
   staff-roles.js — Staff Management › Roles & Permissions
   ------------------------------------------------------------
   Real roles, read from and saved to the Worker (migration 0018):

     GET    /api/roles              roles, their permissions, how many
                                    accounts hold each, and the catalog of
                                    every module and action that exists
     POST   /api/roles              create a role
     PUT    /api/roles/:id          edit name, description, permissions,
                                    switch on / off (expectedUpdatedAt)
     DELETE /api/roles/:id          a role no account holds
     GET    /api/accounts           the user accounts, for assignment
     PUT    /api/accounts/:id       { roleId } -- assign a role

   The server is what enforces all of it: it refuses a role change the
   caller may not make, however the page was used. This page only shows
   what will work -- a button the caller's role does not allow is not
   drawn, and a permission the caller does not hold cannot be ticked.

   Nothing from the data is put into the page unescaped (Utils.esc).
   ============================================================ */

const StaffRoles = (() => {

  const { esc } = Utils;
  const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'manage', 'export'];
  const ACTION_LABELS = { view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', manage: 'Manage', export: 'Export' };

  const svg = d => `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    yes: svg('M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'),
    no: svg('M19 13H5v-2h14v2z'),
    alert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>',
  };

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  /** Roles matching a search text (name or description) and a status ('' = all). */
  function filterRoles(list, { q = '', status = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return (Array.isArray(list) ? list : []).filter(r =>
      (!status || r.status === status)
      && (!needle || [r.name, r.description].some(t => String(t || '').toLowerCase().includes(needle))));
  }

  /** Accounts matching a search (name, username, id) and a role id ('' = all). */
  function filterAccounts(list, { q = '', roleId = '' } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    return (Array.isArray(list) ? list : []).filter(a =>
      (!roleId || a.roleId === roleId)
      && (!needle || [a.staffName, a.username, a.id, a.staffId].some(t => String(t || '').toLowerCase().includes(needle))));
  }

  /** One cell of the read-only matrix. */
  function markCell(exists, yes, label) {
    if (!exists) return `<td class="stf-perm rop-na-cell" data-label="${esc(label)}"><span class="rop-na" title="The module has no such action">·</span><span class="rop-sr-only">${esc(label)}: not applicable</span></td>`;
    return `<td class="stf-perm" data-label="${esc(label)}"><span class="stf-perm__mark ${yes ? 'is-yes' : 'is-no'}" title="${esc(label)}: ${yes ? 'allowed' : 'not allowed'}">${yes ? ICON.yes : ICON.no}<span class="rop-sr-only">${esc(label)}: ${yes ? 'allowed' : 'not allowed'}</span></span></td>`;
  }

  /** The read-only permission matrix of a role: one row per module, one column per action. */
  function matrixHtml(catalog, permissions) {
    const held = new Set(permissions || []);
    return (catalog || []).map(m => `
      <tr data-module="${esc(m.key)}">
        <th scope="row">${esc(m.label)}</th>
        ${ACTIONS.map(a => markCell(a in m.actions, held.has(`${m.key}.${a}`), ACTION_LABELS[a])).join('')}
      </tr>`).join('');
  }

  /**
   * The editable matrix for the role dialog. A permission the editor's own
   * role does not hold is shown but cannot be ticked (the server would refuse it).
   */
  function editorMatrixHtml(catalog, permissions, mayGrant) {
    const held = new Set(permissions || []);
    return (catalog || []).map(m => `
      <tr data-module="${esc(m.key)}">
        <th scope="row">${esc(m.label)}</th>
        ${ACTIONS.map(a => {
          if (!(a in m.actions)) return `<td class="stf-perm rop-na-cell" data-label="${esc(ACTION_LABELS[a])}"><span class="rop-na" aria-hidden="true">·</span></td>`;
          const p = `${m.key}.${a}`;
          const allowed = mayGrant(p);
          return `<td class="stf-perm" data-label="${esc(ACTION_LABELS[a])}"><label class="rop-check" title="${esc(m.actions[a])}${allowed ? '' : ' — your own role does not have this, so you cannot give it'}">
            <input type="checkbox" name="perm" value="${esc(p)}"${held.has(p) ? ' checked' : ''}${allowed ? '' : ' disabled'} data-module="${esc(m.key)}" data-action="${esc(a)}">
            <span class="rop-sr-only">${esc(m.label)}: ${esc(m.actions[a])}</span></label></td>`;
        }).join('')}
      </tr>`).join('');
  }

  /** How many permissions a role has, as words. */
  function permissionCount(role) {
    if (role.fullAccess) return 'every permission';
    const n = (role.permissions || []).length;
    return `${n} permission${n === 1 ? '' : 's'}`;
  }

  /** Plain words for a failed request. */
  function errorWords(res) {
    const code = res && res.code;
    if (code === 'no_api') return { title: 'Roles & Permissions needs the workshop database', text: 'This copy of the app is not connected to the workshop server, so no roles are shown.' };
    if (code === 'unauthorized' || code === 'locked') return { title: 'Your session has ended', text: 'Sign in again to see roles and permissions. Nothing was changed.', signIn: true };
    if (code === 'forbidden') return { title: 'Your role does not include Roles & Permissions', text: 'Ask an administrator if you need to see or change roles.' };
    return { title: 'The roles could not be loaded', text: (res && res.message) || 'The workshop server did not answer. Try again in a moment.', retry: true };
  }

  /* ---------- state ---------- */

  const state = {
    roles: [], catalog: [], accounts: [], accountsLoaded: false, accountsError: null,
    selectedId: null, q: '', status: '', userQ: '', userRole: '', busy: false, error: null,
  };
  const $ = id => document.getElementById(id);
  const me = () => Storage.account;
  const myRoleId = () => (me() && me().roleId) || null;
  const roleById = id => state.roles.find(r => r.id === id) || null;

  /** May I give this permission? (Only what my own role has.) */
  const mayGrant = p => Storage.fullAccess || Storage.can(p);

  function showAlert(text) {
    const el = $('ropAlert');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  function stateRow({ title, text, retry = false, signIn = false, cols = 8 }) {
    return `
      <tr class="rop-state-row"><td colspan="${cols}">
        <div class="rop-state" role="alert">
          <span class="rop-state__icon">${ICON.alert}</span>
          <div class="rop-state__text">
            <h3>${esc(title)}</h3>
            <p>${esc(text)}</p>
            ${retry || signIn ? `<p class="rop-state__actions">${retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Try again</button>' : ''}${signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : ''}</p>` : ''}
          </div>
        </div>
      </td></tr>`;
  }

  /* ---------- rendering ---------- */

  function renderWho() {
    const el = $('ropWho');
    if (!el) return;
    const a = me();
    el.textContent = a
      ? `You are signed in as “${a.username}”, role ${a.role || 'none'}.`
      : (Storage.fullAccess ? 'You are signed in with the shared workshop passphrase (full access).' : '');
  }

  function renderRoleList() {
    const box = $('ropRoleList');
    box.setAttribute('aria-busy', 'false');
    const shown = filterRoles(state.roles, state);
    if (!shown.length) {
      box.innerHTML = `<p class="stf-muted rop-empty">${state.roles.length ? 'No roles match the search or filter.' : 'No roles yet.'}</p>`;
      return;
    }
    box.innerHTML = shown.map(r => `
      <button type="button" class="stf-rolecard${r.id === state.selectedId ? ' is-active' : ''}" data-role="${esc(r.id)}" aria-pressed="${r.id === state.selectedId ? 'true' : 'false'}">
        <span class="stf-avatar stf-avatar--${(Number(String(r.id).slice(4)) % 8) + 1}" aria-hidden="true">${esc(String(r.name).charAt(0).toUpperCase())}</span>
        <span class="stf-rolecard__text">
          <span class="stf-rolecard__name">${esc(r.name)}${r.system ? ' <span class="badge badge--info rop-tag">System</span>' : ''}${r.status !== 'Active' ? ' <span class="badge badge--neutral rop-tag">Off</span>' : ''}</span>
          <span class="stf-rolecard__meta">${r.accounts} account${r.accounts === 1 ? '' : 's'} · ${esc(permissionCount(r))}</span>
        </span>
      </button>`).join('');
  }

  function roleButtons(r) {
    const own = myRoleId() === r.id;
    const reach = r.canManage && !r.system && !own;
    const out = [];
    if (Storage.can('roles.edit') && reach) {
      out.push(`<button type="button" class="btn btn--ghost btn--sm" data-act="edit">${ICON.edit}<span>Edit</span></button>`);
      out.push(r.status === 'Active'
        ? `<button type="button" class="btn btn--ghost btn--sm" data-act="off"${r.accounts ? ` disabled title="${r.accounts} account${r.accounts === 1 ? ' holds' : 's hold'} this role. Move them to another role first."` : ''}>Switch off</button>`
        : '<button type="button" class="btn btn--ghost btn--sm" data-act="on">Switch on</button>');
    }
    if (Storage.can('roles.delete') && reach) {
      out.push(`<button type="button" class="btn btn--danger btn--sm" data-act="delete"${r.accounts ? ` disabled title="Accounts hold this role. Move them to another role first."` : ''}>Delete</button>`);
    }
    if (Storage.can('roles.create')) out.push('<button type="button" class="btn btn--ghost btn--sm" data-act="copy">Copy as new</button>');
    return out.join('');
  }

  function renderDetail() {
    const r = roleById(state.selectedId);
    const body = $('ropBody');
    $('ropMatrix').setAttribute('aria-busy', 'false');
    if (!r) {
      $('ropRoleName').textContent = '—';
      $('ropRoleDesc').textContent = '';
      $('ropRoleMembers').textContent = '';
      $('ropRoleActions').innerHTML = '';
      $('ropRoleNotes').innerHTML = '';
      $('ropHolders').innerHTML = '';
      body.innerHTML = stateRow({ title: 'Choose a role', text: 'Pick a role on the left to see its permissions.' });
      $('ropCount').textContent = '';
      return;
    }
    $('ropRoleName').textContent = r.name;
    $('ropRoleDesc').textContent = r.description || '';
    $('ropRoleMembers').textContent = `${r.accounts} account${r.accounts === 1 ? '' : 's'}${r.accounts !== r.activeAccounts ? ` (${r.activeAccounts} active)` : ''}`;
    $('ropRoleActions').innerHTML = roleButtons(r);
    const notes = [];
    if (r.system) notes.push('The protected system role: every permission, including any added later. It cannot be changed, switched off or deleted.');
    if (r.status !== 'Active') notes.push('Switched off: it cannot be given to an account.');
    if (myRoleId() === r.id) notes.push('This is your own role, so you cannot change it.');
    else if (!r.canManage) notes.push('This role has permissions your own role does not, so you cannot change it or give it to anyone.');
    if (r.updatedBy) notes.push(`Last changed ${Utils.fmtDate ? Utils.fmtDate(r.updatedAt) : r.updatedAt} by ${r.updatedBy}.`);
    $('ropRoleNotes').innerHTML = notes.map(n => `<li>${esc(n)}</li>`).join('');
    body.innerHTML = matrixHtml(state.catalog, r.permissions);
    $('ropCount').textContent = `${permissionCount(r)} across ${state.catalog.length} modules`;
    const holders = state.accounts.filter(a => a.roleId === r.id);
    $('ropHolders').innerHTML = !state.accountsLoaded ? '' : `
      <h3 class="rop-holders__title">Accounts with this role</h3>
      ${holders.length ? `<ul class="rop-holders__list">${holders.map(a => `<li><strong>${esc(a.staffName || a.username)}</strong> <span class="stf-muted">${esc(a.username)}${a.status !== 'Active' ? ' · inactive' : ''}</span></li>`).join('')}</ul>`
        : '<p class="stf-muted">No account has this role.</p>'}`;
  }

  /** Roles this user may give to an account. */
  const assignable = () => state.roles.filter(r => r.status === 'Active' && r.canManage);

  function renderUsers() {
    const card = $('ropAssignCard');
    const may = Storage.can('users.view') && Storage.can('users.edit') && Storage.can('roles.manage');
    card.hidden = !may;
    if (!may) return;
    const sel = $('ropUserRole');
    sel.innerHTML = '<option value="">All roles</option>' + state.roles.map(r => `<option value="${esc(r.id)}"${r.id === state.userRole ? ' selected' : ''}>${esc(r.name)}</option>`).join('');
    const tbody = $('ropUsers');
    if (state.accountsError) {
      tbody.innerHTML = stateRow({ ...errorWords(state.accountsError), cols: 5 });
      $('ropUserCount').textContent = '';
      return;
    }
    if (!state.accountsLoaded) { tbody.innerHTML = '<tr class="rop-skel-row"><td colspan="5"><span class="rop-skel"></span></td></tr>'; return; }
    if (!state.accounts.length) {
      tbody.innerHTML = stateRow({ title: 'No user accounts yet', text: 'Create accounts on the User Accounts page, then give each one a role here.', cols: 5 });
      $('ropUserCount').textContent = '';
      return;
    }
    const shown = filterAccounts(state.accounts, { q: state.userQ, roleId: state.userRole });
    const options = assignable();
    tbody.innerHTML = shown.length ? shown.map(a => {
      const current = roleById(a.roleId);
      const self = me() && me().id === a.id;
      const reach = !current || current.canManage;
      const locked = self || !reach;
      const why = self ? 'You cannot change your own role.' : !reach ? 'This account\'s role has permissions yours does not.' : '';
      const opts = [...options];
      if (current && !opts.some(o => o.id === current.id)) opts.unshift(current);
      return `
        <tr data-account="${esc(a.id)}">
          <th scope="row" data-label="Staff member">${esc(a.staffName || '—')}<span class="stf-muted rop-sub">${esc(a.staffId || '')}</span></th>
          <td data-label="Username">${esc(a.username)}${self ? ' <span class="badge badge--neutral">You</span>' : ''}</td>
          <td data-label="Status"><span class="badge ${a.status === 'Active' ? 'badge--good' : 'badge--neutral'}">${esc(a.status)}</span></td>
          <td data-label="Role"><select class="select rop-role-select" data-account="${esc(a.id)}" aria-label="Role for ${esc(a.username)}"${locked ? ` disabled title="${esc(why)}"` : ''}>
            ${current ? '' : '<option value="">No role (no access)</option>'}
            ${opts.map(o => `<option value="${esc(o.id)}"${o.id === a.roleId ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}
          </select></td>
          <td data-label=""><button type="button" class="btn btn--primary btn--sm" data-assign="${esc(a.id)}" disabled>Save</button></td>
        </tr>`;
    }).join('') : stateRow({ title: 'No accounts match', text: 'Change or clear the search or role filter.', cols: 5 });
    $('ropUserCount').textContent = `${shown.length} of ${state.accounts.length} accounts`;
  }

  function render() {
    renderWho();
    $('ropCreate').hidden = !Storage.can('roles.create');
    if (state.error) {
      const w = errorWords(state.error);
      $('ropRoleList').innerHTML = '';
      $('ropRoleList').setAttribute('aria-busy', 'false');
      $('ropBody').innerHTML = stateRow(w);
      $('ropMatrix').setAttribute('aria-busy', 'false');
      ['ropRoleName', 'ropRoleDesc', 'ropRoleMembers', 'ropCount'].forEach(id => { $(id).textContent = id === 'ropRoleName' ? '—' : ''; });
      $('ropRoleActions').innerHTML = '';
      $('ropRoleNotes').innerHTML = '';
      $('ropHolders').innerHTML = '';
      $('ropAssignCard').hidden = true;
      return;
    }
    renderRoleList();
    renderDetail();
    renderUsers();
  }

  function renderLoading() {
    $('ropRoleList').innerHTML = '<span class="rop-skel"></span><span class="rop-skel"></span><span class="rop-skel"></span>';
    $('ropRoleList').setAttribute('aria-busy', 'true');
    $('ropMatrix').setAttribute('aria-busy', 'true');
    $('ropBody').innerHTML = Array.from({ length: 6 }, () => '<tr class="rop-skel-row"><td colspan="8"><span class="rop-skel"></span></td></tr>').join('');
  }

  /* ---------- data ---------- */

  async function load({ keepSelection = true } = {}) {
    if (!Storage.isApi()) { state.error = { code: Storage.isLocked() ? 'locked' : 'no_api' }; render(); return false; }
    state.error = null;
    if (!state.roles.length) renderLoading();
    const wantAccounts = Storage.can('users.view');
    const [res, acc] = await Promise.all([
      Api.get('/roles'),
      wantAccounts ? Api.get('/accounts?limit=1000') : Promise.resolve(null),
    ]);
    if (!res.ok) { state.error = res; render(); return false; }
    state.roles = Array.isArray(res.data) ? res.data : [];
    state.catalog = (res.meta && Array.isArray(res.meta.catalog)) ? res.meta.catalog : [];
    if (acc) {
      state.accountsLoaded = acc.ok;
      state.accountsError = acc.ok ? null : acc;
      state.accounts = acc.ok && Array.isArray(acc.data) ? acc.data : [];
    }
    if (!keepSelection || !roleById(state.selectedId)) {
      const mine = myRoleId() && roleById(myRoleId());
      state.selectedId = (mine || state.roles[0] || {}).id || null;
    }
    render();
    return true;
  }

  /* ---------- the role dialog ---------- */

  function openEditor(role, { copy = false } = {}) {
    const editing = role && !copy;
    const start = role ? role.permissions.filter(p => !copy || mayGrant(p)) : ['dashboard.view', 'notifications.view'].filter(mayGrant);
    const ov = Utils.Modal.open({
      title: editing ? `Edit role: ${role.name}` : 'New role',
      size: 'lg',
      body: `
        <form id="ropForm" novalidate>
          <div class="form-grid">
            <div class="field">
              <label for="rf-name">Role name <span class="req" aria-hidden="true">*</span></label>
              <input class="input" id="rf-name" name="name" maxlength="40" required aria-required="true" aria-describedby="rf-name-err" value="${esc(editing ? role.name : copy ? `${role.name} (copy)` : '')}">
              <div class="field__error" id="rf-name-err" data-err="name" role="alert"></div>
            </div>
            <div class="field">
              <label for="rf-desc">Description</label>
              <input class="input" id="rf-desc" name="description" maxlength="300" aria-describedby="rf-desc-err" value="${esc(role ? role.description || '' : '')}">
              <div class="field__error" id="rf-desc-err" data-err="description" role="alert"></div>
            </div>
          </div>
          <p class="rop-hint">Tick what this role may do. A permission your own role does not have is greyed out: you cannot give it. Ticking an action also ticks <em>View</em> for that module.</p>
          <div class="table-wrap rop-editor">
            <table class="table stf-matrix rop-matrix">
              <caption class="rop-sr-only">Permissions for this role</caption>
              <thead><tr><th scope="col">Module</th>${ACTIONS.map(a => `<th scope="col">${ACTION_LABELS[a]}</th>`).join('')}</tr></thead>
              <tbody>${editorMatrixHtml(state.catalog, start, mayGrant)}</tbody>
            </table>
          </div>
          <div class="field__error" data-err="permissions" role="alert"></div>
          <p class="field__error" data-err="form" role="alert"></p>
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>${editing ? 'Save role' : 'Create role'}</button>`,
    });
    if (!ov) return;
    const form = ov.querySelector('#ropForm');
    form.addEventListener('change', e => {
      const box = e.target;
      if (!box || box.name !== 'perm' || !box.checked || box.dataset.action === 'view') return;
      const view = form.querySelector(`input[name="perm"][data-module="${box.dataset.module}"][data-action="view"]`);
      if (view && !view.disabled) view.checked = true;
    });
    const showErrors = fields => {
      form.querySelectorAll('[data-err]').forEach(el => { el.textContent = (fields && fields[el.dataset.err]) || ''; });
    };
    const save = ov.querySelector('[data-save]');
    save.addEventListener('click', async () => {
      const name = form.querySelector('#rf-name').value.trim();
      const description = form.querySelector('#rf-desc').value.trim();
      const permissions = [...form.querySelectorAll('input[name="perm"]:checked')].map(b => b.value);
      const errors = {};
      if (name.length < 2 || name.length > 40) errors.name = 'Use 2-40 characters.';
      if (!permissions.length) errors.permissions = 'Tick at least one permission.';
      if (Object.keys(errors).length) { showErrors(errors); return; }
      save.disabled = true;
      const res = editing
        ? await Api.put(`/roles/${encodeURIComponent(role.id)}`, { name, description, permissions, expectedUpdatedAt: role.updatedAt })
        : await Api.post('/roles', { name, description, permissions });
      save.disabled = false;
      if (!res.ok) {
        if (res.fields) showErrors(res.fields);
        else showErrors({ form: res.message || 'The role could not be saved.' });
        if (res.status === 409 && res.errorReason === 'concurrent_modification') await load();
        return;
      }
      Utils.Modal.close();
      Utils.toast(editing ? `Role “${res.data.name}” saved.` : `Role “${res.data.name}” created.`, 'success');
      state.selectedId = res.data.id;
      await load();
    });
  }

  /* ---------- actions ---------- */

  function confirmStatus(r, to) {
    Utils.Modal.confirm({
      title: to === 'Inactive' ? 'Switch off this role?' : 'Switch this role on?',
      message: to === 'Inactive'
        ? `<strong>${esc(r.name)}</strong> will no longer be offered when giving accounts a role. No account holds it now. You can switch it on again later.`
        : `<strong>${esc(r.name)}</strong> can be given to accounts again.`,
      confirmText: to === 'Inactive' ? 'Switch off' : 'Switch on',
      onConfirm: async () => {
        const res = await Api.put(`/roles/${encodeURIComponent(r.id)}`, { status: to, expectedUpdatedAt: r.updatedAt });
        if (!res.ok) { Utils.toast(res.message || 'The role could not be changed.', 'error'); await load(); return; }
        Utils.toast(`Role “${r.name}” ${to === 'Inactive' ? 'switched off' : 'switched on'}.`, 'success');
        await load();
      },
    });
  }

  function confirmDelete(r) {
    Utils.Modal.confirm({
      title: 'Delete this role?',
      message: `<strong>${esc(r.name)}</strong> and its permissions will be deleted. No account holds it. This cannot be undone.`,
      confirmText: 'Delete role',
      onConfirm: async () => {
        const res = await Api.delete(`/roles/${encodeURIComponent(r.id)}`);
        if (!res.ok) { Utils.toast(res.message || 'The role could not be deleted.', 'error'); await load(); return; }
        Utils.toast(`Role “${r.name}” deleted.`, 'success');
        state.selectedId = null;
        await load({ keepSelection: false });
      },
    });
  }

  function confirmAssign(accountId) {
    const a = state.accounts.find(x => x.id === accountId);
    const select = document.querySelector(`.rop-role-select[data-account="${accountId}"]`);
    if (!a || !select) return;
    const to = roleById(select.value);
    if (!to || to.id === a.roleId) return;
    const from = roleById(a.roleId);
    Utils.Modal.confirm({
      title: 'Change this account\'s role?',
      message: `<strong>${esc(a.staffName || a.username)}</strong> (${esc(a.username)}) will change from <strong>${esc(from ? from.name : 'no role')}</strong> to <strong>${esc(to.name)}</strong> and will be signed out, so the new role applies at once.${to.fullAccess ? '<br><br>Super Admin has <strong>every permission</strong>, including changing roles and accounts.' : ''}`,
      confirmText: 'Change role',
      onConfirm: async () => {
        const res = await Api.put(`/accounts/${encodeURIComponent(a.id)}`, { roleId: to.id });
        if (!res.ok) { Utils.toast(res.message || 'The role could not be changed.', 'error'); await load(); return; }
        Utils.toast(`${a.username} now has the role ${to.name}.`, 'success');
        await load();
      },
    });
  }

  function bind() {
    $('ropRoleList').addEventListener('click', e => {
      const b = e.target.closest('[data-role]');
      if (!b) return;
      state.selectedId = b.dataset.role;
      renderRoleList();
      renderDetail();
    });
    $('ropSearch').addEventListener('input', e => { state.q = e.target.value; renderRoleList(); });
    $('ropStatus').addEventListener('change', e => { state.status = e.target.value; renderRoleList(); });
    $('ropCreate').addEventListener('click', () => openEditor(null));
    $('ropRoleActions').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      const r = roleById(state.selectedId);
      if (!b || !r || b.disabled) return;
      if (b.dataset.act === 'edit') openEditor(r);
      else if (b.dataset.act === 'copy') openEditor(r, { copy: true });
      else if (b.dataset.act === 'off') confirmStatus(r, 'Inactive');
      else if (b.dataset.act === 'on') confirmStatus(r, 'Active');
      else if (b.dataset.act === 'delete') confirmDelete(r);
    });
    $('ropUserSearch').addEventListener('input', e => { state.userQ = e.target.value; renderUsers(); });
    $('ropUserRole').addEventListener('change', e => { state.userRole = e.target.value; renderUsers(); });
    $('ropUsers').addEventListener('change', e => {
      const select = e.target.closest('.rop-role-select');
      if (!select) return;
      const a = state.accounts.find(x => x.id === select.dataset.account);
      const btn = document.querySelector(`[data-assign="${select.dataset.account}"]`);
      if (btn) btn.disabled = !a || !select.value || select.value === a.roleId;
    });
    $('ropUsers').addEventListener('click', e => {
      const b = e.target.closest('[data-assign]');
      if (b && !b.disabled) confirmAssign(b.dataset.assign);
    });
    $('page-content').addEventListener('click', e => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      if (b.dataset.action === 'retry') load();
      else if (b.dataset.action === 'signin') window.location.reload();
    });
  }

  function init() {
    if (!document.body || document.body.dataset.page !== 'staff-roles') return;
    bind();
    Storage.ready(() => { load({ keepSelection: false }); });
  }

  return { ACTIONS, filterRoles, filterAccounts, matrixHtml, editorMatrixHtml, permissionCount, errorWords, state, load, init };
})();

if (typeof document !== 'undefined' && document.body && document.body.dataset) StaffRoles.init();
