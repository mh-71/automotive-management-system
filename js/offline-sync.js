/* ============================================================
   offline-sync.js — the Offline & Sync page
   ------------------------------------------------------------
   Shows what this computer keeps for working without internet:
   the connection, the app version and whether the offline app
   shell is installed (sw.js), this computer's id and code, the
   encrypted offline copies saved here (js/offline.js) -- names,
   roles and dates only; nothing secret is ever read or shown --
   and the changes made offline (js/sync.js): what is waiting,
   what synced, what failed or needs review, with Sync now, Retry
   failed, and the pending list and history. Online, the server's
   own counts (GET /api/sync/status) are added: open conflicts,
   invoice drafts awaiting finalization, parts usage under review.

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

  const KIND = { create: 'Create', update: 'Edit', status: 'Status', payment: 'Payment (pending)', invoice_draft: 'Invoice draft', parts_usage: 'Parts used', stock_movement: 'Stock movement' };
  const STATE = { pending: ['Waiting', 'badge--warn'], syncing: ['Sending', 'badge--info'], conflict: ['Needs review', 'badge--info'], failed: ['Failed', 'badge--bad'], dismissed: ['Not accepted', 'badge--bad'] };

  /** One waiting change (pure; escaped). */
  function pendingRowHtml(o) {
    const [label, cls] = STATE[o.state] || [o.state, 'badge--neutral'];
    const what = o.kind === 'parts_usage' ? `${o.data.quantity > 0 ? '+' : ''}${o.data.quantity} × ${o.data.name || o.data.partId || ''}` : '';
    return `<tr data-op="${esc(o.opId)}">
        <th scope="row">${esc(KIND[o.kind] || o.kind)}${what ? `<span class="ofs-sub">${esc(what)}</span>` : ''}</th>
        <td data-label="Record">${esc(o.tempId || o.targetId || '')}<span class="ofs-sub">${esc(o.collection || '')}</span></td>
        <td data-label="Made">${esc(fmt(o.createdAt))}</td>
        <td data-label="Status"><span class="badge ${cls}">${esc(label)}</span></td>
        <td data-label="Detail">${esc(o.error || '')}${o.conflictId ? ` <a href="sync-conflicts.html#${esc(o.conflictId)}">${esc(o.conflictId)}</a>` : ''}</td>
      </tr>`;
  }

  let server = null;   // GET /api/sync/status, online

  async function renderSync() {
    const open = typeof Sync !== 'undefined' && Sync.isOpen();
    const c = open ? Sync.counts() : null;
    const online = Storage.isApi() && Storage.account;
    if (online && !server) {
      try {
        const dev = await Offline.deviceId();
        const res = await Api.get(`/sync/status?deviceId=${encodeURIComponent(dev)}`);
        server = res.ok ? res.data : { error: res.code };
      } catch (e) { server = { error: 'network_error' }; }
    }
    const n = v => (v === null || v === undefined ? '–' : String(v));
    const srv = server && !server.error ? server : null;
    $('ofsPending').textContent = n(c ? c.pending : null);
    $('ofsSynced').textContent = n(c ? c.synced : null);
    $('ofsFailed').textContent = n(c ? c.failed : null);
    // Conflicts: this computer's waiting for review, and (online) every open one the server knows that this person may see.
    $('ofsConflicts').textContent = srv ? n(Math.max(srv.openConflicts, c ? c.conflict : 0)) : n(c ? c.conflict : null);
    $('ofsDrafts').textContent = n((c ? c.drafts : 0) + (srv ? srv.invoiceDrafts : 0));
    $('ofsPayments').textContent = n(c ? c.payments : null);
    $('ofsInventory').textContent = srv ? n(Math.max(srv.inventoryReview, c ? c.inventoryReview : 0)) : n(c ? c.inventoryReview : null);
    $('ofsCountsNote').textContent = !open
      ? (online ? 'Nothing made offline is on this computer for you.' : 'Open the offline copy to see changes made offline.')
      : srv ? 'Draft invoices, conflicts and inventory review include those already on the server.' : 'Counts from this computer.';
    const last = open && Sync.lastSync;
    $('ofsLastSync').textContent = last ? fmt(last.at) : 'Never';
    const st = typeof Sync !== 'undefined' ? Sync.state : null;
    $('ofsSyncState').textContent = st && st.phase === 'signin' ? st.error
      : st && st.phase === 'revoked' ? 'Offline access on this computer was revoked by an administrator.'
      : st && st.error ? `Last attempt: ${st.error}` : last ? `Sent ${last.sent}, received ${last.pulled}.` : '';
    $('ofsSyncNow').disabled = !(online && open);
    $('ofsSyncNow').title = online ? '' : 'Needs the internet.';
    $('ofsRetry').disabled = !(open && c && c.failed);
    const list = open ? Sync.outbox() : [];
    $('ofsPendingList').innerHTML = list.length ? list.map(pendingRowHtml).join('') : '<tr><td colspan="5" class="ofs-empty">Nothing is waiting on this computer.</td></tr>';
    const items = (open ? Sync.history() : []).slice(0, 100);
    $('ofsHistory').innerHTML = items.length ? items.map(h => `<li><time>${esc(fmt(h.at))}</time> ${esc(h.text)}</li>`).join('') : '<li class="ofs-empty">No sync history on this computer yet.</li>';
  }

  async function render() {
    const offline = Storage.isOffline && Storage.isOffline();
    const writable = Storage.offlineWritable && Storage.offlineWritable();
    $('ofsConn').textContent = offline ? 'Offline' : Storage.isApi() ? 'Online' : 'Not connected';
    $('ofsConnSub').textContent = offline ? `${writable ? 'Working from' : 'Read-only'} copy saved ${fmt(Storage.offlineSavedAt)}.` : Storage.isApi() ? 'Records are read from and saved to the shared database.' : '';
    $('ofsVersion').textContent = typeof TAQWA_VERSION === 'string' ? TAQWA_VERSION : '–';
    $('ofsDays').textContent = String(Offline.OFFLINE_DAYS);
    try { $('ofsShell').textContent = await shellInfo(); } catch (e) { $('ofsShell').textContent = ''; }
    if (!Offline.supported()) {
      $('ofsDevice').textContent = '–';
      $('ofsCopies').innerHTML = '<tr><td colspan="6" class="ofs-empty">This browser cannot keep an encrypted offline copy.</td></tr>';
      return;
    }
    const dev = await Offline.deviceInfo();
    $('ofsDevice').textContent = dev.deviceId;
    $('ofsCode').textContent = dev.registered ? `Code ${dev.code}` : 'Not registered yet';
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
    await renderSync();
  }

  function bind() {
    $('ofsSyncNow').addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Syncing…';
      const r = await Sync.syncNow();
      btn.textContent = 'Sync now';
      server = null;
      Utils.toast(r && r.ok ? `Sync finished: ${r.sent} sent, ${r.pulled} received.` : (r && r.message) || 'Sync could not finish. It will try again.', r && r.ok ? 'success' : 'error');
      render();
    });
    $('ofsRetry').addEventListener('click', async () => {
      const n = await Sync.retryFailed();
      Utils.toast(`${n} failed change${n === 1 ? '' : 's'} put back in the queue.`, 'info');
      if (Storage.isApi()) await Sync.run({ reason: 'retry' });
      server = null;
      render();
    });
    const toggle = (btnId, boxId) => $(btnId).addEventListener('click', () => {
      const box = $(boxId); box.hidden = !box.hidden; $(btnId).setAttribute('aria-expanded', String(!box.hidden));
    });
    toggle('ofsViewPending', 'ofsPendingBox');
    toggle('ofsViewHistory', 'ofsHistoryBox');
    if (typeof Sync !== 'undefined') Sync.on(() => { renderSync().catch(() => {}); });
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
        message: 'The copy saved on this computer for this person is deleted. They can no longer open it offline until they sign in online here again. Changes they made offline that have not synced are kept (they are sent at their next online sign-in). Nothing is removed from the shared database.',
        confirmText: 'Remove copy',
        onConfirm: async () => { await Offline.forget(id); Utils.toast('The offline copy was removed from this computer.', 'success'); render(); },
      });
    });
    $('ofsClearAll').addEventListener('click', () => {
      Utils.Modal.confirm({
        title: 'Remove every offline copy?',
        message: 'Every offline copy saved on this computer is deleted. Nobody can open the CRM offline here until they sign in online again. Changes made offline that have not synced are kept. Nothing is removed from the shared database.',
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

  return { rowHtml, pendingRowHtml, render, init };
})();

if (typeof document !== 'undefined' && document.body && document.body.dataset) OfflineSync.init();
