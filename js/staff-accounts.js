/* ============================================================
   staff-accounts.js — Staff Management › User Accounts
   ------------------------------------------------------------
   A sign-in of their own for named staff members.

   Source of truth: the workshop database, and nothing else.
     - Accounts are read on demand through Storage.load('accounts')
       (GET /api/accounts) together with the staff roster
       (Storage.load('staff')), ONLY in 'api' mode. In every other mode
       this page shows nothing and changes nothing.
     - Create, Activate / Deactivate and Set new password go through
       Storage.create / update / action (POST /api/accounts,
       PUT /api/accounts/:id, POST /api/accounts/:id/password). The Worker
       allows them only to an administrator and re-checks every field:
       the staff member, the username, the role, the password rules, one
       account per person, never your own account, never the last active
       administrator. The checks here only spare a round trip.

   Passwords are typed into a dialog, sent once over the API and then
   cleared from the field. They are never shown, logged or stored, and the
   API never returns a password, a hash or a session value.

   Roles (0018): each account has one role from Roles & Permissions
   (GET /api/roles). The create form offers only the roles this user may
   give -- active, and within their own permissions (the Worker decides,
   `canManage`) -- and the Worker checks the same again on every request.
   Changing an existing account's role is done on the Roles & Permissions
   page.
   ============================================================ */

const StaffAccounts = (() => {

  const { esc } = Utils;

  // The Worker's rules (src/lib/accounts.js), repeated only to spare a round trip.
  const USERNAME = /^[a-z0-9._-]{3,32}$/;
  const PASSWORD_MIN = 10;
  const PASSWORD_MAX = 128;
  const STATUSES = ['Active', 'Inactive'];
  const COLS = 7;
  // The workshop's roles, from GET /api/roles: { id, name, status, assignable }.
  const roles = [];
  const roleNames = () => roles.map(r => r.name);
  const assignableRoles = () => roles.filter(r => r.assignable);
  /** Fill `roles` from the Worker's list; `assignable` = this user may give it (active, within reach). */
  function setRoles(list, mayAssign) {
    roles.length = 0;
    for (const r of Array.isArray(list) ? list : []) {
      roles.push({ id: r.id, name: r.name, status: r.status, assignable: !!mayAssign && r.status === 'Active' && r.canManage === true });
    }
  }

  const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICON = {
    view: svg('M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z'),
    key: svg('M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z'),
    off: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.9 7.9 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.9 7.9 0 0 1 20 12c0 4.42-3.58 8-8 8z'),
    on: svg('M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'),
    people: svg('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
    search: svg('M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'),
    alert: svg('M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z'),
    edit: svg('M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z'),
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MOBILE_RE = /^[0-9+\-() ]{6,20}$/;
  /** Optional contact fields: e-mail (6-160, one @ and a dot) and mobile (6-20 digits and + - ( ) spaces). */
  function contactProblems(v) {
    const e = {};
    if (v.email && (v.email.length < 6 || v.email.length > 160 || !EMAIL_RE.test(v.email))) e.email = 'Enter a valid e-mail address, or leave it empty.';
    if (v.mobile && !MOBILE_RE.test(v.mobile)) e.mobile = 'Use 6-20 digits, spaces, + - ( ).';
    return e;
  }

  /* ---------- pure helpers (also used by the unit tests) ---------- */

  /** Does one account match the search text? Name, staff ID, username or account id. */
  function matchesSearch(a, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [a.staffName, a.staffId, a.username, a.id].some(v => String(v || '').toLowerCase().includes(q));
  }

  function filterAccounts(list, { search = '', status = 'all', role = 'all' } = {}) {
    return list.filter(a => matchesSearch(a, search)
      && (status === 'all' || a.status === status)
      && (role === 'all' || a.role === role))
      .sort((x, y) => String(x.staffName || '').localeCompare(String(y.staffName || ''), undefined, { sensitivity: 'base' })
        || String(x.id).localeCompare(String(y.id)));
  }

  /** Active staff members who do not have an account yet: the only ones one can be created for. */
  function eligibleStaff(staff, accounts) {
    const taken = new Set(accounts.map(a => a.staffId));
    return staff.filter(s => s.status === 'Active' && !taken.has(s.id))
      .sort((x, y) => String(x.name || '').localeCompare(String(y.name || ''), undefined, { sensitivity: 'base' }));
  }

  /** The figures on the four cards. */
  function summary(accounts, staff) {
    const active = accounts.filter(a => a.status === 'Active').length;
    return { total: accounts.length, active, inactive: accounts.length - active, none: eligibleStaff(staff, accounts).length };
  }

  /** A first guess at a username from a name: 'Nadia Akter' -> 'nadia.akter'. Empty if nothing usable. */
  function suggestUsername(name) {
    const parts = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/).filter(Boolean);
    const guess = parts.slice(0, 2).join('.').slice(0, 32);
    return USERNAME.test(guess) ? guess : '';
  }

  /** Why a new password is not acceptable, or null. Mirrors the Worker; never echoes the password. */
  function passwordProblem(password, username = '') {
    if (!password) return 'A password is required.';
    if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
    if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
    if (password.trim() !== password) return 'The password cannot start or end with a space.';
    if (username && password.toLowerCase().includes(username.toLowerCase())) return 'The password cannot contain the username.';
    return null;
  }

  /** The create form's checks. Returns { field: message }. */
  function validateCreate(v) {
    const e = {};
    if (!/^(MEC|STF)-\d{4,}$/.test(String(v.staffId || ''))) e.staffId = 'Choose a staff member.';
    if (!USERNAME.test(String(v.username || ''))) e.username = 'Use 3-32 lower-case letters, digits, dots, dashes or underscores.';
    if (!assignableRoles().some(r => r.name === v.role)) e.role = 'Choose a role.';
    if (/^(mec|stf)-\d+$/i.test(String(v.username || ''))) e.username = 'A username cannot look like a Staff ID (e.g. STF-0001).';
    Object.assign(e, contactProblems(v));
    const p = passwordProblem(v.password, v.username);
    if (p) e.password = p;
    else if (v.confirm !== v.password) e.confirm = 'The two passwords do not match.';
    return e;
  }

  /* ---------- markup ---------- */

  const muted = text => `<span class="uac-muted">${esc(text)}</span>`;
  const badge = (text, good) => `<span class="badge ${good ? 'badge--good' : 'badge--bad'}">${esc(text)}</span>`;

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${Utils.fmtDate(Utils.toDateStr(d))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function statusCell(a) {
    const parts = [badge(a.status, a.status === 'Active')];
    if (a.locked) parts.push('<span class="badge badge--warn" title="Too many wrong passwords: sign-in is paused for a few minutes">Paused</span>');
    if (a.staffStatus && a.staffStatus !== 'Active') parts.push('<span class="badge badge--neutral" title="The staff record is inactive, so this account cannot sign in">Staff inactive</span>');
    if (a.passwordChangeRequired) parts.push('<span class="badge badge--info" title="The password was set by an administrator: they must choose their own at their next sign-in">New password due</span>');
    return parts.join(' ');
  }

  function rowHtml(a) {
    const active = a.status === 'Active';
    const blocked = active ? (a.self ? 'You cannot deactivate your own account.' : '') : (a.staffStatus !== 'Active' ? 'Activate the staff member in the Staff List first.' : '');
    const toggle = active ? 'deactivate' : 'activate';
    return `
      <tr data-id="${esc(a.id)}">
        <td data-label="Employee">
          <span class="cell-main">${esc(a.staffName || '—')}${a.self ? ' <span class="badge badge--neutral">You</span>' : ''}</span>
          <span class="cell-sub">${a.designation ? esc(a.designation) : (a.isMechanic ? 'Mechanic' : 'Staff')}</span>
        </td>
        <td data-label="Staff ID" class="stf-nowrap">${esc(a.staffId)}</td>
        <td data-label="Username" class="stf-nowrap"><span class="cell-main">${esc(a.username)}</span>${a.email ? `<span class="cell-sub">${esc(a.email)}</span>` : ''}</td>
        <td data-label="Role">${esc(a.role)}</td>
        <td data-label="Account Status">${statusCell(a)}</td>
        <td data-label="Last Sign-in" class="stf-nowrap">${a.lastLoginAt ? esc(fmtWhen(a.lastLoginAt)) : muted('Never')}</td>
        <td data-label="Actions">
          <div class="row-actions">
            <button type="button" class="icon-btn icon-btn--sm" data-action="view" data-id="${esc(a.id)}" title="View ${esc(a.username)}" aria-label="View account ${esc(a.username)}">${ICON.view}</button>
            <button type="button" class="icon-btn icon-btn--sm" data-action="contact" data-id="${esc(a.id)}" title="Edit e-mail and mobile for ${esc(a.username)}" aria-label="Edit e-mail and mobile for ${esc(a.username)}">${ICON.edit}</button>
            <button type="button" class="icon-btn icon-btn--sm" data-action="password" data-id="${esc(a.id)}" title="Set a new password for ${esc(a.username)}" aria-label="Set a new password for ${esc(a.username)}">${ICON.key}</button>
            <button type="button" class="icon-btn icon-btn--sm${active ? ' uac-danger' : ''}" data-action="${toggle}" data-id="${esc(a.id)}"
              title="${esc(blocked || `${active ? 'Deactivate' : 'Activate'} ${a.username}`)}" aria-label="${active ? 'Deactivate' : 'Activate'} account ${esc(a.username)}"${blocked ? ' disabled' : ''}>${active ? ICON.off : ICON.on}</button>
          </div>
        </td>
      </tr>`;
  }

  function stateRow({ icon = ICON.people, title, text, retry = false, clear = false, create = false, signIn = false, tone = 'neutral' }) {
    const actions = [
      retry ? '<button type="button" class="btn btn--primary btn--sm" data-action="retry">Retry</button>' : '',
      signIn ? '<button type="button" class="btn btn--primary btn--sm" data-action="signin">Sign in again</button>' : '',
      create ? '<button type="button" class="btn btn--primary btn--sm" data-action="create">Create Account</button>' : '',
      clear ? '<button type="button" class="btn btn--ghost btn--sm" data-action="clear">Clear filters</button>' : '',
    ].filter(Boolean).join(' ');
    return `
      <tr class="uac-state-row">
        <td colspan="${COLS}">
          <div class="uac-state${tone === 'bad' ? ' uac-state--bad' : ''}" role="${tone === 'bad' ? 'alert' : 'status'}">
            <span class="uac-state__icon">${icon}</span>
            <div class="uac-state__text">
              <h3>${esc(title)}</h3>
              <p>${esc(text)}</p>
              ${actions ? `<p class="uac-state__actions">${actions}</p>` : ''}
            </div>
          </div>
        </td>
      </tr>`;
  }

  function skeletonRows(n = 4) {
    const cell = '<td><span class="uac-skel"></span></td>';
    return Array.from({ length: n }, () => `<tr class="uac-state-row uac-skel-row" aria-hidden="true">${cell.repeat(COLS)}</tr>`).join('');
  }

  /* ---------- the page ---------- */

  const state = { loaded: false, search: '', status: 'all', role: 'all' };
  const $ = id => document.getElementById(id);
  let debounce = null;
  const accounts = () => Storage.getData('accounts');
  const staff = () => Storage.getData('staff');

  const CONTROLS = ['uacSearch', 'uacRole', 'uacStatus', 'uacClear', 'uacCreate'];
  function setControls(enabled) { for (const id of CONTROLS) { const el = $(id); if (el) el.disabled = !enabled; } }
  function setBody(html, busy = false) {
    const body = $('uacBody'); if (body) body.innerHTML = html;
    const table = $('uacTable'); if (table && table.setAttribute) table.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  const note = text => { const el = $('uacCount'); if (el) el.textContent = text; };
  function setCards(s) {
    for (const [id, v] of [['uacTotal', s.total], ['uacActive', s.active], ['uacInactive', s.inactive], ['uacNone', s.none]]) {
      const el = $(id); if (el) el.textContent = s.total === null ? '—' : String(v);
    }
  }
  function who() {
    const el = $('uacWho');
    if (!el) return;
    const me = Storage.account;
    el.textContent = me
      ? `You are signed in with the account “${me.username}” (${me.role}).`
      : 'You are signed in with the shared workshop passphrase.';
  }

  function fillRoles() {
    const el = $('uacRole');
    if (!el) return;
    const names = [...new Set([...roleNames(), ...accounts().map(a => a.role).filter(Boolean)])];
    if (!names.includes(state.role)) state.role = 'all';
    el.innerHTML = '<option value="all">All roles</option>' + names.map(r => `<option value="${esc(r)}"${r === state.role ? ' selected' : ''}>${esc(r)}</option>`).join('');
    el.value = state.role;
  }

  function renderList() {
    const all = accounts();
    setCards(summary(all, staff()));
    if (!all.length) {
      setBody(stateRow({ title: 'No user accounts yet', create: true,
        text: 'Everyone signs in with the shared workshop passphrase. Create an account to give a staff member their own sign-in.' }));
      note('0 accounts');
      return;
    }
    const shown = filterAccounts(all, state);
    if (!shown.length) {
      setBody(stateRow({ icon: ICON.search, title: 'No accounts match your search or filters', clear: true,
        text: 'Change or clear the search, role or status filter to see more accounts.' }));
      note(`No matches among ${all.length} accounts`);
      return;
    }
    setBody(shown.map(rowHtml).join(''));
    note(`${shown.length} of ${all.length} accounts`);
  }

  function renderUnavailable(code) {
    state.loaded = false;
    setControls(false);
    setCards({ total: null });
    note('Search and filters are unavailable until the accounts load.');
    if (code === 'no_api') {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'User Accounts needs the workshop database',
        text: 'This copy of the app is not connected to the workshop database, so no accounts are shown and none can be created.' }));
    } else if (code === 'unauthorized') {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your session has ended', signIn: true,
        text: 'Sign in again to manage user accounts. Nothing was changed.' }));
    } else if (code === 'forbidden') {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'Your role does not include User Accounts',
        text: 'Ask an administrator if you need to see or change user accounts.' }));
    } else {
      setBody(stateRow({ icon: ICON.alert, tone: 'bad', title: 'The accounts could not be loaded', retry: true,
        text: 'The workshop database did not answer, so no accounts are shown. Try again in a moment.' }));
    }
  }

  async function load() {
    if (!Storage.isApi()) { renderUnavailable('no_api'); return false; }
    setControls(false);
    note('Loading accounts…');
    setBody(skeletonRows(), true);
    const [acc, st, rl] = await Promise.all([Storage.load('accounts'), Storage.load('staff'),
      Storage.can('roles.view') ? Storage.load('roles') : Promise.resolve({ ok: true })]);
    if (!acc.ok) { renderUnavailable(acc.code); return false; }
    if (!st.ok) { renderUnavailable(st.code); return false; }
    // Without the role list nobody can be given a role here; the accounts still show.
    setRoles(rl.ok ? Storage.getData('roles') : [], Storage.can('roles.manage'));
    state.loaded = true;
    setControls(true);
    fillRoles();
    who();
    renderPassphrase();
    renderList();
    return true;
  }

  /* ---------- dialogs ---------- */

  function field({ id, label, required = false, html, err, hint = '' }) {
    return `
      <div class="field">
        <label for="${id}">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
        ${html}
        ${hint ? `<p class="uac-hint" id="${id}-hint">${esc(hint)}</p>` : ''}
        <div class="field__error" id="${id}-err" data-err="${err}" role="alert"></div>
      </div>`;
  }

  const pwInput = (id, name, autocomplete) =>
    `<input class="input" type="password" id="${id}" name="${name}" maxlength="${PASSWORD_MAX}" autocomplete="${autocomplete}" required aria-required="true" aria-describedby="${id}-hint ${id}-err">`;

  /** Messages on their fields, aria-invalid in step, focus on the first. */
  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => { el.textContent = ''; });
    Object.entries(errors).forEach(([key, msg]) => {
      const err = form.querySelector(`[data-err="${key}"]`);
      if (!err) return;
      err.textContent = msg;
      const wrap = err.closest('.field');
      if (wrap) wrap.classList.add('field--error');
    });
    markInvalid(form);
  }

  function markInvalid(form) {
    let first = null;
    form.querySelectorAll('.field').forEach(wrap => {
      const ctl = wrap.querySelector('input, select, textarea');
      if (!ctl) return;
      if (wrap.classList.contains('field--error')) { ctl.setAttribute('aria-invalid', 'true'); if (!first) first = ctl; }
      else ctl.removeAttribute('aria-invalid');
    });
    if (first && first.focus) first.focus();
  }

  /** Clear every password field in a form, whatever happened. */
  function forgetPasswords(form) {
    form.querySelectorAll('input[type="password"]').forEach(el => { el.value = ''; });
  }

  function openCreate() {
    if (!state.loaded) return;
    const people = eligibleStaff(staff(), accounts());
    if (!people.length) {
      Utils.Modal.open({
        title: 'Create Account',
        body: '<p>Every active staff member already has an account. Add the person in <a href="staff-add.html">Add Staff</a> first, or activate them in the <a href="staff-list.html">Staff List</a>.</p>',
        footer: '<button type="button" class="btn btn--primary" data-modal-close>OK</button>',
      });
      return;
    }
    const options = people.map(s => `<option value="${esc(s.id)}">${esc(s.name)} — ${esc(s.id)}${s.designation ? ` (${esc(s.designation)})` : ''}</option>`).join('');
    const ov = Utils.Modal.open({
      title: 'Create Account',
      size: 'lg',
      body: `
        <form id="uacForm" novalidate>
          <p class="uac-hint">The account belongs to an existing staff member; nothing about the person is copied. Only active staff without an account are listed.</p>
          <div class="form-grid">
            ${field({ id: 'ua-staff', label: 'Staff member', required: true, err: 'staffId', html: `<select class="select" id="ua-staff" name="staffId" required aria-required="true" aria-describedby="ua-staff-err"><option value="">Choose a staff member</option>${options}</select>` })}
            ${field({ id: 'ua-username', label: 'Username', required: true, err: 'username', hint: '3-32 lower-case letters, digits, dots, dashes or underscores. Used to sign in.',
              html: `<input class="input" type="text" id="ua-username" name="username" maxlength="32" autocomplete="off" autocapitalize="none" spellcheck="false" required aria-required="true" aria-describedby="ua-username-hint ua-username-err">` })}
            ${field({ id: 'ua-role', label: 'Role', required: true, err: 'role', hint: 'What this person may do. Only roles you may give are listed (Roles & Permissions).',
              html: `<select class="select" id="ua-role" name="role" aria-describedby="ua-role-hint ua-role-err"><option value="">Choose a role</option>${assignableRoles().map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')}</select>` })}
            ${field({ id: 'ua-email', label: 'E-mail (optional)', err: 'email', hint: 'Can be used to sign in. Must not be used by another account.',
              html: '<input class="input" type="email" id="ua-email" name="email" maxlength="160" autocomplete="off" aria-describedby="ua-email-hint ua-email-err">' })}
            ${field({ id: 'ua-mobile', label: 'Mobile (optional)', err: 'mobile',
              html: '<input class="input" type="tel" id="ua-mobile" name="mobile" maxlength="20" autocomplete="off" aria-describedby="ua-mobile-err">' })}
            ${field({ id: 'ua-password', label: 'Temporary password', required: true, err: 'password', hint: `At least ${PASSWORD_MIN} characters, not containing the username. Give it to the person privately: they must choose their own at their first sign-in.`, html: pwInput('ua-password', 'password', 'new-password') })}
            ${field({ id: 'ua-confirm', label: 'Repeat password', required: true, err: 'confirm', hint: 'Type the same password again.', html: pwInput('ua-confirm', 'confirm', 'new-password') })}
          </div>
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>Create Account</button>`,
    });
    const form = ov.querySelector('#uacForm');
    const pick = form.querySelector('#ua-staff');
    const user = form.querySelector('#ua-username');
    let suggested = '';
    pick.addEventListener('change', () => {
      const person = people.find(s => s.id === pick.value);
      const next = person ? suggestUsername(person.name) : '';
      if (!user.value || user.value === suggested) { user.value = next; suggested = next; }
    });
    user.addEventListener('input', () => { user.value = user.value.toLowerCase(); });
    form.addEventListener('submit', e => { e.preventDefault(); ov.querySelector('[data-save]').click(); });

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const v = {
        staffId: pick.value, username: user.value.trim().toLowerCase(), role: form.querySelector('#ua-role').value,
        password: form.querySelector('#ua-password').value, confirm: form.querySelector('#ua-confirm').value,
        email: ((form.querySelector('#ua-email') || {}).value || '').trim().toLowerCase(),
        mobile: ((form.querySelector('#ua-mobile') || {}).value || '').trim(),
      };
      const errors = validateCreate(v);
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      showErrors(form, {});
      const res = await Storage.create('accounts', { staffId: v.staffId, username: v.username, role: v.role, password: v.password,
        ...(v.email ? { email: v.email } : {}), ...(v.mobile ? { mobile: v.mobile } : {}) });
      forgetPasswords(form);
      if (!Utils.wrote(res, form)) { markInvalid(form); return; }
      Utils.Modal.close();
      Utils.toast(`Account “${res.record.username}” was created for ${res.record.staffName} (${res.record.id}).`, 'success');
      renderList();
    }));
  }

  function openPassword(a) {
    const ov = Utils.Modal.open({
      title: `Set a new password — ${a.username}`,
      body: `
        <form id="uacPwForm" novalidate>
          <p class="uac-hint">${a.self
            ? 'This is your own account. After saving you will be signed out and need to sign in with the new password.'
            : `${esc(a.staffName)} will be signed out everywhere. This is a <strong>temporary</strong> password: give it to them privately; they must choose their own the next time they sign in.`}</p>
          ${field({ id: 'ua-newpw', label: 'New password', required: true, err: 'password', hint: `At least ${PASSWORD_MIN} characters, not containing the username.`, html: pwInput('ua-newpw', 'password', 'new-password') })}
          ${field({ id: 'ua-newpw2', label: 'Repeat new password', required: true, err: 'confirm', hint: 'Type the same password again.', html: pwInput('ua-newpw2', 'confirm', 'new-password') })}
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>Set Password</button>`,
    });
    const form = ov.querySelector('#uacPwForm');
    form.addEventListener('submit', e => { e.preventDefault(); ov.querySelector('[data-save]').click(); });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const password = form.querySelector('#ua-newpw').value, confirm = form.querySelector('#ua-newpw2').value;
      const p = passwordProblem(password, a.username);
      const errors = p ? { password: p } : (confirm !== password ? { confirm: 'The two passwords do not match.' } : {});
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      const res = await Storage.action('accounts', a.id, 'password', { password });
      forgetPasswords(form);
      if (!Utils.wrote(res, form)) { markInvalid(form); return; }
      Utils.Modal.close();
      if (a.self) { Utils.toast('Your password was changed. Please sign in again.', 'success'); setTimeout(() => location.reload(), 900); return; }
      Utils.toast(`A temporary password was set for “${a.username}”. They have been signed out everywhere and will choose their own at their next sign-in.`, 'success');
      renderList();
    }));
  }

  /** Edit an account's e-mail and mobile (either may be cleared). */
  function openContact(a) {
    const ov = Utils.Modal.open({
      title: `E-mail and mobile — ${a.username}`,
      body: `
        <form id="uacContactForm" novalidate>
          <p class="uac-hint">The e-mail address can be used to sign in, so no two accounts may share one. Leave a field empty to remove it.</p>
          ${field({ id: 'uc-email', label: 'E-mail', err: 'email', html: `<input class="input" type="email" id="uc-email" maxlength="160" autocomplete="off" value="${esc(a.email || '')}" aria-describedby="uc-email-err">` })}
          ${field({ id: 'uc-mobile', label: 'Mobile', err: 'mobile', html: `<input class="input" type="tel" id="uc-mobile" maxlength="20" autocomplete="off" value="${esc(a.mobile || '')}" aria-describedby="uc-mobile-err">` })}
        </form>`,
      footer: `
        <button type="button" class="btn btn--ghost" data-modal-close>Cancel</button>
        <button type="button" class="btn btn--primary" data-save>Save</button>`,
    });
    if (!ov) return;
    const form = ov.querySelector('#uacContactForm');
    form.addEventListener('submit', e => { e.preventDefault(); ov.querySelector('[data-save]').click(); });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const v = { email: form.querySelector('#uc-email').value.trim().toLowerCase(), mobile: form.querySelector('#uc-mobile').value.trim() };
      const errors = contactProblems(v);
      if (Object.keys(errors).length) { showErrors(form, errors); return; }
      const res = await Storage.update('accounts', a.id, { email: v.email, mobile: v.mobile });
      if (!Utils.wrote(res, form)) { markInvalid(form); return; }
      Utils.Modal.close();
      Utils.toast(`Contact details saved for “${a.username}”.`, 'success');
      renderList();
    }));
  }

  /* The shared workshop passphrase (0019): shown to a Super Admin signed in
     with their own account -- the only one the server lets switch it. */
  function renderPassphrase() {
    const box = $('uacPassphrase');
    if (!box) return;
    const mine = Storage.account;
    const show = !!(mine && Storage.fullAccess && !mine.passwordChangeRequired);
    box.hidden = !show;
    if (!show) return;
    const on = Storage.sharedPassphrase;
    $('uacPassText').textContent = on
      ? 'Still allowed. Anyone who knows it gets full access, and it does not say who they are. Switch it off once every staff member signs in with their own account.'
      : 'Switched off. Only personal accounts (and the server\'s machine token) can sign in.';
    const btn = $('uacPassToggle');
    btn.textContent = on ? 'Switch off the passphrase' : 'Allow the passphrase again';
    btn.className = `btn btn--sm ${on ? 'btn--danger' : 'btn--ghost'}`;
  }
  function togglePassphrase() {
    const on = Storage.sharedPassphrase;
    Utils.Modal.confirm({
      title: on ? 'Switch off the shared passphrase?' : 'Allow the shared passphrase again?',
      message: on
        ? 'Nobody will be able to sign in with the workshop passphrase, and everyone signed in with it now is signed out. Make sure every staff member who needs access has a personal account and has signed in with it.'
        : 'Anyone who knows the workshop passphrase will be able to sign in again, with full access.',
      confirmText: on ? 'Switch off' : 'Allow it',
      onConfirm: async () => {
        const res = await Api.put('/session/passphrase', { enabled: !on });
        if (!res.ok) { Utils.toast(res.message || 'The setting could not be changed.', 'error'); return; }
        Utils.toast(on ? 'The shared passphrase is switched off.' : 'The shared passphrase is allowed again.', 'success');
        setTimeout(() => location.reload(), 600);
      },
    });
  }

  function detailHtml(a) {
    const item = (label, value, span = false) => `<div class="detail-item${span ? ' span-2' : ''}"><span>${esc(label)}</span><strong>${value}</strong></div>`;
    return `
      <div class="detail-grid">
        ${item('Account', esc(a.id))}
        ${item('Username', esc(a.username))}
        ${item('Staff member', `${esc(a.staffName)} (${esc(a.staffId)})`)}
        ${item('Designation', a.designation ? esc(a.designation) : muted('Not set'))}
        ${item('E-mail', a.email ? esc(a.email) : muted('Not set'))}
        ${item('Mobile', a.mobile ? esc(a.mobile) : muted('Not set'))}
        ${item('Role', esc(a.role))}
        ${item('Password', a.passwordChangeRequired ? 'Temporary — they must choose their own at the next sign-in' : 'Chosen by the person')}
        ${item('Account status', statusCell(a))}
        ${item('Last sign-in', a.lastLoginAt ? esc(fmtWhen(a.lastLoginAt)) : muted('Never'))}
        ${item('Password last set', a.passwordChangedAt ? esc(fmtWhen(a.passwordChangedAt)) : muted('Unknown'))}
        ${item('Created', esc(fmtWhen(a.createdAt)))}
      </div>
      <p class="uac-hint">Passwords are never shown. To give this person a new password, use Set new password.</p>`;
  }

  async function busy(btn, fn) {
    if (btn && btn.disabled) return;
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) {
      console.error('Account action failed:', e && e.message);
      Utils.toast('Something went wrong. Please try again.', 'error');
    } finally { if (btn) btn.disabled = false; }
  }

  async function openDetail(id, btn) {
    await busy(btn, async () => {
      const res = await Storage.loadOne('accounts', id);
      if (!res.ok) { Utils.toast(res.message || 'Could not open this account.', 'error'); if (res.code === 'not_found') load(); return; }
      Utils.Modal.open({ title: res.record.username, size: 'lg', body: detailHtml(res.record),
        footer: '<button type="button" class="btn btn--primary" data-modal-close>Close</button>' });
    });
  }

  function setStatus(id, status, btn) {
    const a = Storage.getById('accounts', id);
    if (!a) return;
    const save = async () => {
      const res = await Storage.update('accounts', id, { status });
      if (!Utils.wrote(res)) return;
      Utils.toast(status === 'Active' ? `“${a.username}” can sign in again.` : `“${a.username}” was deactivated and signed out everywhere.`, 'success');
      renderList();
    };
    Utils.Modal.confirm({
      title: status === 'Active' ? 'Activate account?' : 'Deactivate account?',
      message: status === 'Active'
        ? `<strong>${esc(a.username)}</strong> (${esc(a.staffName)}) will be able to sign in again with their current password.`
        : `<strong>${esc(a.username)}</strong> (${esc(a.staffName)}) will be signed out everywhere and will not be able to sign in. Nothing is deleted; the account can be activated again later.`,
      confirmText: status === 'Active' ? 'Activate' : 'Deactivate',
      onConfirm: () => busy(btn, save),
    });
  }

  /* ---------- events ---------- */

  function clearFilters() {
    clearTimeout(debounce);
    Object.assign(state, { search: '', status: 'all', role: 'all' });
    for (const [id, value] of [['uacSearch', ''], ['uacStatus', 'all'], ['uacRole', 'all']]) { const el = $(id); if (el) el.value = value; }
    renderList();
  }

  function bindEvents() {
    const search = $('uacSearch'), body = $('uacBody');
    if (search) search.addEventListener('input', e => {
      const value = String(e.target.value || '').slice(0, 100);
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.search = value; renderList(); }, 200);
    });
    for (const [id, key, ok] of [['uacStatus', 'status', v => v === 'all' || STATUSES.includes(v)], ['uacRole', 'role', v => v === 'all' || roles.includes(v)]]) {
      const el = $(id);
      if (el) el.addEventListener('change', e => { const v = String(e.target.value || 'all'); state[key] = ok(v) ? v : 'all'; renderList(); });
    }
    const clear = $('uacClear'), create = $('uacCreate');
    if (clear) clear.addEventListener('click', clearFilters);
    if (create) create.addEventListener('click', openCreate);
    const passToggle = $('uacPassToggle'); if (passToggle) passToggle.addEventListener('click', togglePassphrase);
    if (body) body.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn || btn.disabled) return;
      const action = btn.dataset ? btn.dataset.action : btn.action;
      const id = btn.dataset ? btn.dataset.id : btn.id;
      switch (action) {
        case 'retry': load(); break;
        case 'signin': window.location.reload(); break;
        case 'clear': clearFilters(); break;
        case 'create': openCreate(); break;
        case 'view': openDetail(id, btn); break;
        case 'password': { const a = Storage.getById('accounts', id); if (a) openPassword(a); break; }
        case 'contact': { const a = Storage.getById('accounts', id); if (a) openContact(a); break; }
        case 'deactivate': setStatus(id, 'Inactive', btn); break;
        case 'activate': setStatus(id, 'Active', btn); break;
        default: break;
      }
    });
  }

  function start(outcome) {
    if (outcome && outcome.mode === 'locked') return;
    bindEvents();
    load();
  }

  Storage.ready(start);

  return {
    USERNAME, PASSWORD_MIN, PASSWORD_MAX, ROLES: roles, setRoles,
    matchesSearch, filterAccounts, eligibleStaff, summary, suggestUsername, passwordProblem, validateCreate, rowHtml,
    load, renderList, clearFilters, state,
  };
})();
