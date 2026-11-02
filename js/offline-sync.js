/* ============================================================
   offline-sync.js — the Offline & Sync page (Phase 1)
   ------------------------------------------------------------
   Shows what this computer keeps for working without internet:
   the connection, the app version and whether the offline app
   shell is installed (sw.js), this computer's id, and the
   encrypted offline copies saved here (js/offline.js) -- names,
   roles and dates only; nothing secret is ever read or shown.

   Removing copies: anyone may remove their own; removing every
   copy on the computer needs a role that manages user accounts
   (users.edit) or full access. Both ask first. They remove
   nothing from the shared database.
   ============================================================ */

const OfflineSync = (() => {
  const { esc } = Utils;
  const $ = id => document.getElementById(id);
  const DAY = 86400000;

  const fmt = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  };
  const size = n => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);

  /** One row of the copies table (pure; escaped). */
  function rowHtml(c, { mine, mayRemove, days, now = Date.now() }) {
    const until = c.savedAt ? new Date(Date.parse(c.savedAt) + days * DAY) : null;
    const expired = until && until.getTime() < now;
    return `
      <tr data-account="${esc(c.accountId)}">
        <th scope="row">${esc(c.name || c.username)}${mine ? ' <span class="badge badge--neutral">You</span>' : ''}<span class="ofs-sub">${esc(c.username)}</span></th>
        <td data-label="Role">${esc(c.role || '—')}</td>
        <td data-label="Copy saved">${c.savedAt ? esc(fmt(c.savedAt)) : '<span class="ofs-muted">Not yet — sign in online here once</span>'}</td>
        <td data-label="Opens until">${until ? (expired ? '<span class="badge badge--bad">Expired</span>' : esc(fmt(until.toISOString()))) : '—'}</td>
        <td data-label="Size">${c.size ? esc(size(c.size)) : '—'}</td>
        <td data-label="">${mayRemove ? `<button type="button" class="btn btn--ghost btn--sm" data-forget="${esc(c.accountId)}">Remove</button>` : ''}</td>
      </tr>`;
  }

  async function shellInfo() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return 'This browser cannot install the offline app.';
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.active) return 'The offline app is not installed yet (it installs on the next online visit).';
    return navigator.serviceWorker.controller ? 'The offline app is installed and in use.' : 'The offline app is installed; it takes over on the next page.';
  }

  async function render() {
    const offline = Storage.isOffline && Storage.isOffline();
    $('ofsConn').textContent = offline ? 'Offline' : Storage.isApi() ? 'Online' : 'Not connected';
    $('ofsConnSub').textContent = offline ? `Read-only copy saved ${fmt(Storage.offlineSavedAt)}.` : Storage.isApi() ? 'Records are read from and saved to the shared database.' : '';
    $('ofsVersion').textContent = typeof TAQWA_VERSION === 'string' ? TAQWA_VERSION : '–';
    $('ofsDays').textContent = String(Offline.OFFLINE_DAYS);
    try { $('ofsShell').textContent = await shellInfo(); } catch (e) { $('ofsShell').textContent = ''; }
    if (!Offline.supported()) {
      $('ofsDevice').textContent = '–';
      $('ofsCopies').innerHTML = '<tr><td colspan="6" class="ofs-empty">This browser cannot keep an encrypted offline copy.</td></tr>';
      return;
    }
    $('ofsDevice').textContent = await Offline.deviceId();
    const me = Storage.account;
    const manager = Storage.fullAccess || Storage.can('users.edit');
    const copies = await Offline.status();
    $('ofsCopies').innerHTML = copies.length
      ? copies.map(c => rowHtml(c, { mine: !!me && me.id === c.accountId, mayRemove: (!!me && me.id === c.accountId) || manager, days: Offline.OFFLINE_DAYS })).join('')
      : '<tr><td colspan="6" class="ofs-empty">No offline copies on this computer yet.</td></tr>';
    $('ofsClearAll').hidden = !(manager && copies.length);
    const online = Storage.isApi() && me && !me.passwordChangeRequired;
    $('ofsSave').hidden = !online;
    const mine = me && copies.find(c => c.accountId === me.id);
    $('ofsMine').textContent = !me
      ? (Storage.fullAccess ? 'You are signed in with the shared passphrase: it has no personal offline copy. Sign in with your own account for offline access.' : '')
      : !mine ? 'You have no offline access on this computer yet: sign out, then sign in again with your password here to set it up.'
      : '';
  }

  function bind() {
    $('ofsSave').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const saved = await Storage.saveOfflineCopy({ force: true });
      btn.disabled = false;
      Utils.toast(saved ? 'Your offline copy was saved on this computer.' : 'No copy was saved: sign out and sign in again with your password on this computer first.', saved ? 'success' : 'info');
      render();
    });
    $('ofsCopies').addEventListener('click', e => {
      const btn = e.target.closest('[data-forget]');
      if (!btn) return;
      const id = btn.dataset.forget;
      Utils.Modal.confirm({
        title: 'Remove this offline copy?',
        message: 'The copy saved on this computer for this person is deleted. They can no longer open it offline until they sign in online here again. Nothing is removed from the shared database.',
        confirmText: 'Remove copy',
        onConfirm: async () => { await Offline.forget(id); Utils.toast('The offline copy was removed from this computer.', 'success'); render(); },
      });
    });
    $('ofsClearAll').addEventListener('click', () => {
      Utils.Modal.confirm({
        title: 'Remove every offline copy?',
        message: 'Every offline copy saved on this computer is deleted. Nobody can open the CRM offline here until they sign in online again. Nothing is removed from the shared database.',
        confirmText: 'Remove all',
        onConfirm: async () => { await Offline.forgetAll(); Utils.toast('Every offline copy was removed from this computer.', 'success'); render(); },
      });
    });
  }

  function init() {
    if (!document.body || document.body.dataset.page !== 'offline-sync') return;
    bind();
    Storage.ready(() => { render().catch(err => console.error('Offline & Sync could not be shown:', err && err.message)); });
  }

  return { rowHtml, render, init };
})();

if (typeof document !== 'undefined' && document.body && document.body.dataset) OfflineSync.init();
