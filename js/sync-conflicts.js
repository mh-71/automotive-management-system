/* ============================================================
   sync-conflicts.js — the Conflict Center
   ------------------------------------------------------------
   Offline changes the server would not apply as they were: an
   edit to a record someone else changed, a payment that looks
   like a duplicate or would overpay, parts usage the stock could
   not cover, a permission the author's role lacks, an operation
   whose first attempt was cut off. Each shows its type, the
   record, the device and person, the device's values beside the
   server's, the reason, the actions available and its history.

   Resolving is an authorized Admin's decision (sync.manage),
   checked by the server; a financial or inventory decision needs
   a written reason. Everyone else sees their own conflicts, read
   only. Invoice drafts made offline are finalized (or discarded)
   here by a role that may create invoices.
   ============================================================ */

const SyncConflicts = (() => {
  const { esc } = Utils;
  const $ = (id) => document.getElementById(id);
  const fmt = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  };
  const ACTION_LABEL = {
    retry: 'Retry now', dismiss: 'Dismiss (do not apply)', apply_local: "Apply the device's value", keep_server: "Keep the server's value",
    apply_anyway: 'Record it anyway', mark_applied: 'It was saved — link the record',
  };
  const TYPE_LABEL = {
    payment: 'Payment', invoice: 'Invoice', inventory: 'Inventory', edit: 'Edit clash', validation: 'Not valid', permission: 'Permission',
    dependency: 'Depends on another change', duplicate: 'Possible duplicate', interrupted: 'Interrupted',
  };
  const state = { status: 'Open', rows: [], canResolve: false, selected: null };

  const show = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

  /** The device's values beside the server's (pure; escaped). */
  function compareHtml(details) {
    const local = details.local || {};
    const server = details.server || {};
    const base = details.base || null;
    const keys = [...new Set([...Object.keys(local), ...Object.keys(server)])].filter((k) => !['_sync', 'uuid'].includes(k));
    if (!keys.length) return '';
    return `<div class="table-wrap"><table class="table ofs-table sc-compare"><thead><tr><th scope="col">Field</th>${base ? '<th scope="col">When the device last saw it</th>' : ''}<th scope="col">This device (offline)</th><th scope="col">Server now</th></tr></thead><tbody>${
      keys.map((k) => `<tr><th scope="row">${esc(k)}</th>${base ? `<td>${esc(show(base[k]))}</td>` : ''}<td>${esc(show(local[k]))}</td><td>${esc(show(server[k]))}</td></tr>`).join('')
    }</tbody></table></div>`;
  }

  function rowHtml(c) {
    return `<tr data-conflict="${esc(c.id)}" tabindex="0" class="sc-row${state.selected === c.id ? ' is-selected' : ''}">
      <th scope="row">${esc(c.id)}<span class="ofs-sub">${esc(c.severity)}</span></th>
      <td data-label="Type"><span class="badge ${c.severity === 'financial' ? 'badge--bad' : c.severity === 'inventory' ? 'badge--warn' : 'badge--info'}">${esc(TYPE_LABEL[c.type] || c.type)}</span></td>
      <td data-label="Record">${esc(c.recordId || c.tempRef || '')}<span class="ofs-sub">${esc(c.collection || '')}</span></td>
      <td data-label="Device / person">${esc(c.deviceCode ? `Computer ${c.deviceCode}` : '')}<span class="ofs-sub">${esc(c.username || c.accountId || '')}</span></td>
      <td data-label="Reason">${esc(c.reason)}</td>
      <td data-label="Raised">${esc(fmt(c.createdAt))}${c.status === 'Resolved' ? `<span class="ofs-sub">${esc(c.resolution)} · ${esc(fmt(c.resolvedAt))}</span>` : ''}</td>
    </tr>`;
  }

  async function loadList() {
    const res = await Api.get(`/sync/conflicts?status=${encodeURIComponent(state.status)}`);
    if (!res.ok) {
      $('scList').innerHTML = `<tr><td colspan="6" class="ofs-empty">${esc(res.message || 'The conflicts could not be read.')}</td></tr>`;
      return;
    }
    state.rows = res.data || [];
    state.canResolve = !!(res.meta && res.meta.canResolve);
    $('scHint').textContent = state.canResolve
      ? 'Select a conflict to compare the values and decide. Financial and inventory decisions need a written reason; every decision is kept in the conflict\'s history.'
      : 'These are your own changes the server is holding for review. An authorized administrator decides them.';
    $('scList').innerHTML = state.rows.length ? state.rows.map(rowHtml).join('')
      : `<tr><td colspan="6" class="ofs-empty">${state.status === 'Open' ? 'No open conflicts.' : 'No resolved conflicts yet.'}</td></tr>`;
  }

  async function openDetail(id) {
    state.selected = id;
    document.querySelectorAll('#scList tr[data-conflict]').forEach((tr) => tr.classList.toggle('is-selected', tr.dataset.conflict === id));
    const res = await Api.get(`/sync/conflicts/${encodeURIComponent(id)}`);
    const box = $('scDetail');
    box.hidden = false;
    if (!res.ok) { $('scDetailBody').textContent = res.message || 'This conflict could not be read.'; return; }
    const c = res.data;
    const d = c.details || {};
    const answer = d.answer && d.answer.message ? `<p class="ofs-hint"><strong>The server said:</strong> ${esc(d.answer.message)}</p>` : '';
    const shortages = d.answer && Array.isArray(d.answer.shortages) && d.answer.shortages.length
      ? `<p class="ofs-hint">${d.answer.shortages.map((s) => `${esc(s.name)}: available ${esc(String(s.available))}, needed ${esc(String(s.required))}`).join('<br>')}</p>` : '';
    const op = d.op || {};
    const actions = state.canResolve && c.status === 'Open' && c.actions.length
      ? `<form class="sc-resolve" id="scResolve" novalidate>
          <div class="field"><label for="sc-note">Reason for the decision${c.severity !== 'normal' ? ' <span class="req">*</span>' : ''}</label>
            <textarea class="input" id="sc-note" rows="2" maxlength="1000" placeholder="${c.severity !== 'normal' ? 'Required for a financial or inventory decision' : 'Optional'}"></textarea></div>
          ${c.actions.includes('mark_applied') ? '<div class="field"><label for="sc-result">Record that was saved (for "link the record")</label><input class="input" id="sc-result" placeholder="e.g. PAY-0042" maxlength="20"></div>' : ''}
          <p class="login__error" id="scError" role="alert"></p>
          <div class="ofs-actions">${c.actions.map((a) => `<button type="button" class="btn ${a === 'dismiss' || a === 'keep_server' ? 'btn--ghost' : 'btn--primary'} btn--sm" data-act="${esc(a)}">${esc(ACTION_LABEL[a] || a)}</button>`).join('')}</div>
        </form>`
      : c.status === 'Resolved' ? `<p class="ofs-hint"><strong>Resolved</strong> (${esc(c.resolution)}) by ${esc(c.resolvedBy || '')} on ${esc(fmt(c.resolvedAt))}${c.resultId ? ` — ${esc(c.resultId)}` : ''}${c.resolutionNote ? `: ${esc(c.resolutionNote)}` : ''}.</p>` : '';
    $('scDetailTitle').textContent = `${c.id} — ${TYPE_LABEL[c.type] || c.type}`;
    $('scDetailBody').innerHTML = `
      <p class="ofs-hint"><strong>${esc(c.reason)}</strong></p>
      <dl class="sc-meta">
        <dt>Change</dt><dd>${esc(op.kind || '')} ${esc(op.collection || '')}</dd>
        <dt>Record</dt><dd>${esc(c.recordId || '—')}${c.tempRef ? ` (made offline as ${esc(c.tempRef)})` : ''}</dd>
        <dt>Device</dt><dd>${esc(c.deviceCode ? `Computer ${c.deviceCode}` : c.deviceId)}</dd>
        <dt>Person</dt><dd>${esc(c.username || c.accountId)}</dd>
        <dt>Made offline</dt><dd>${esc(fmt(op.localCreatedAt))}</dd>
        <dt>Severity</dt><dd>${esc(c.severity)}</dd>
      </dl>
      ${answer}${shortages}
      ${compareHtml(d)}
      ${actions}
      <h3 class="ofs-sub-title">History</h3>
      <ul class="ofs-history">${(c.history || []).map((h) => `<li><time>${esc(fmt(h.at))}</time> ${esc(h.action)} — ${esc(h.username || h.accountId || '')}${h.note ? `: ${esc(h.note)}` : ''}</li>`).join('')}</ul>`;
    const form = $('scResolve');
    if (form) {
      form.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const note = $('sc-note').value.trim();
        if (c.severity !== 'normal' && note.length < 5) { $('scError').textContent = 'Write the reason for this decision (at least 5 characters).'; return; }
        form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        const body = { action: btn.dataset.act, note, ...($('sc-result') ? { resultId: $('sc-result').value.trim() } : {}) };
        const r = await Api.post(`/sync/conflicts/${encodeURIComponent(c.id)}/resolve`, body);
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        if (!r.ok) { $('scError').textContent = r.message || 'The decision was not recorded.'; await openDetail(c.id); return; }
        Utils.toast(`${c.id} resolved: ${ACTION_LABEL[body.action] || body.action}.`, 'success');
        await loadList();
        await openDetail(c.id);
      });
    }
  }

  async function loadDrafts() {
    if (!Storage.can('invoices.view')) { $('scDraftsCard').hidden = true; return; }
    const res = await Api.get('/invoice-drafts?status=all');
    if (!res.ok) { $('scDrafts').innerHTML = `<tr><td colspan="6" class="ofs-empty">${esc(res.message || 'The drafts could not be read.')}</td></tr>`; return; }
    const mayFinalize = Storage.can('invoices.create');
    const rows = res.data || [];
    $('scDrafts').innerHTML = rows.length ? rows.map((d) => `<tr data-draft="${esc(d.id)}">
        <th scope="row">${esc(d.id)}<span class="ofs-sub">${esc(d.tempRef || '')}</span></th>
        <td data-label="Job card">${esc(d.jobCardId)}</td>
        <td data-label="Total when drafted">${esc(d.localTotal === null ? '—' : (Utils.formatCurrency ? Utils.formatCurrency(d.localTotal) : String(d.localTotal)))}</td>
        <td data-label="Made">${esc(fmt(d.createdAt))}</td>
        <td data-label="Status"><span class="badge ${d.status === 'Draft' ? 'badge--warn' : d.status === 'Finalized' ? 'badge--good' : 'badge--neutral'}">${esc(d.status)}</span>${d.invoiceId ? `<span class="ofs-sub">${esc(d.invoiceId)}</span>` : ''}</td>
        <td data-label="">${d.status === 'Draft' && mayFinalize ? `<button type="button" class="btn btn--primary btn--sm" data-finalize="${esc(d.id)}">Finalize</button> <button type="button" class="btn btn--ghost btn--sm" data-discard="${esc(d.id)}">Discard</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="6" class="ofs-empty">No invoice drafts.</td></tr>';
  }

  async function finalize(id, accept = false) {
    const r = await Api.post(`/invoice-drafts/${encodeURIComponent(id)}/finalize`, accept ? { acceptCurrentPricing: true } : {});
    if (r.ok) {
      Utils.toast(`Invoice ${r.data.invoice.id} created from draft ${id}.`, 'success');
      await loadDrafts();
      return;
    }
    if (r.errorReason === 'pricing_changed') {
      Utils.Modal.confirm({
        title: 'The pricing changed since this draft',
        message: `${esc(r.message)} Finalizing creates the invoice from the job card's CURRENT pricing.`,
        confirmText: 'Finalize with current pricing',
        onConfirm: () => finalize(id, true),
      });
      return;
    }
    Utils.toast(r.message || 'The draft could not be finalized.', 'error');
  }

  function bind() {
    document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      state.status = b.dataset.status;
      document.querySelectorAll('[data-status]').forEach((x) => {
        const on = x === b;
        x.classList.toggle('btn--primary', on); x.classList.toggle('btn--ghost', !on); x.setAttribute('aria-selected', String(on));
      });
      $('scDetail').hidden = true; state.selected = null;
      await loadList();
    }));
    const pick = (e) => { const tr = e.target.closest('tr[data-conflict]'); if (tr) openDetail(tr.dataset.conflict); };
    $('scList').addEventListener('click', pick);
    $('scList').addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(e); });
    $('scDrafts').addEventListener('click', (e) => {
      const f = e.target.closest('[data-finalize]');
      if (f) { finalize(f.dataset.finalize); return; }
      const d = e.target.closest('[data-discard]');
      if (!d) return;
      const reason = window.prompt('Why is this draft discarded? (kept, marked discarded)');
      if (!reason || reason.trim().length < 3) return;
      Api.post(`/invoice-drafts/${encodeURIComponent(d.dataset.discard)}/discard`, { reason: reason.trim() }).then((r) => {
        Utils.toast(r.ok ? `Draft ${d.dataset.discard} discarded (kept for the record).` : (r.message || 'Not discarded.'), r.ok ? 'success' : 'error');
        loadDrafts();
      });
    });
  }

  function init() {
    if (!document.body || document.body.dataset.page !== 'sync-conflicts') return;
    bind();
    Storage.ready(async () => {
      if (!Storage.isApi()) {
        $('scOffline').hidden = false;
        $('scList').innerHTML = '<tr><td colspan="6" class="ofs-empty">Needs the internet.</td></tr>';
        $('scDrafts').innerHTML = '<tr><td colspan="6" class="ofs-empty">Needs the internet.</td></tr>';
        return;
      }
      try {
        await loadList();
        await loadDrafts();
        const hash = (location.hash || '').slice(1);
        if (/^CNF-\d+$/.test(hash)) await openDetail(hash);
      } catch (err) { console.error('The Conflict Center could not be shown:', err && err.message); }
    });
  }

  return { compareHtml, rowHtml, init };
})();

if (typeof document !== 'undefined' && document.body && document.body.dataset) SyncConflicts.init();
