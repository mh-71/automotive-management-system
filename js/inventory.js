/* ============================================================
   inventory.js — Inventory / Parts Management module
   Source of truth: part.stock is the operational quantity;
   the inventoryTransactions collection is the audit trail.
   All stock changes go through Utils.Inventory.move() so the
   two never diverge and stock can never go negative.
   Stock is NEVER edited through the Part master form — only
   through Receive Stock and Stock Adjustment.
   Usage reporting reads Job Cards (via partId); the audit trail
   reads transactions — never both summed together.
   ============================================================ */

(() => {

  const { esc, money, fmtDate, badge, toast, Modal, Inventory } = Utils;

  const CATEGORIES = [
    'Engine', 'Oil & Filters', 'Lubricants', 'Filters', 'Brakes', 'Suspension', 'Steering',
    'Transmission', 'Electrical', 'Battery', 'Cooling', 'AC / Climate', 'Climate', 'Fuel System',
    'Exhaust', 'Wheels & Tyres', 'Body', 'Lights', 'Accessories', 'General', 'Other'
  ];
  const UNITS = ['pc', 'pcs', 'set', 'pair', 'litre', 'can', 'bottle', 'box', 'pack', 'meter', 'kg'];
  const ADJUST_REASONS = ['Stock Count Correction', 'Damaged', 'Lost', 'Return', 'Expired', 'Initial Stock', 'Other'];
  const TXN_LABELS = {
    'purchase': 'Purchase', 'sale': 'Sale', 'job-card-use': 'Job Card Use',
    'adjustment-in': 'Adjustment In', 'adjustment-out': 'Adjustment Out',
    'return': 'Return', 'damaged': 'Damaged', 'initial-stock': 'Initial Stock'
  };
  const TXN_TONE = {
    'purchase': 'good', 'initial-stock': 'neutral', 'adjustment-in': 'good', 'return': 'info',
    'job-card-use': 'warn', 'sale': 'warn', 'adjustment-out': 'bad', 'damaged': 'bad'
  };

  let searchTerm = '';
  let fCategory = 'all', fBrand = 'all', fStockStatus = 'all', fStatus = 'all';
  let sortBy = 'name-asc';

  const isActive = p => (p.status || 'Active') === 'Active';

  function stockBadge(part) {
    if (!isActive(part)) return badge('Inactive');
    const st = Inventory.stockStatus(part);
    const tone = { 'Normal': 'good', 'Low Stock': 'warn', 'Out of Stock': 'bad' }[st];
    return `<span class="badge badge--${tone}">${st}</span>`;
  }

  /* ---------- summary cards ---------- */

  function renderStats() {
    const parts = Storage.getData('parts');
    const active = parts.filter(isActive);
    const low = active.filter(p => Inventory.stockStatus(p) === 'Low Stock').length;
    const out = active.filter(p => Inventory.stockStatus(p) === 'Out of Stock').length;
    const costValue = parts.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.purchasePrice) || 0), 0);
    const salesValue = parts.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.sellingPrice) || 0), 0);

    const stats = [
      { label: 'Total Parts', value: parts.length, tone: 'info', icon: 'M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z' },
      { label: 'Active Parts', value: active.length, tone: 'good', icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: 'Low Stock', value: low, tone: 'warn', icon: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z' },
      { label: 'Out of Stock', value: out, tone: 'bad', icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm5 13.6L15.6 17 12 13.4 8.4 17 7 15.6 10.6 12 7 8.4 8.4 7 12 10.6 15.6 7 17 8.4 13.4 12 17 15.6z' },
      { label: 'Inventory Cost Value', value: money(costValue), tone: 'amber', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
      { label: 'Potential Sales Value', value: money(salesValue), tone: 'good', icon: 'M16 6l2.3 2.3-4.9 4.9-4-4L2 16.6 3.4 18l6-6 4 4 6.3-6.3L22 12V6h-6z' }
    ];

    document.getElementById('invStats').innerHTML = stats.map(s => `
      <div class="stat">
        <div class="stat__icon stat__icon--${s.tone}">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="${s.icon}"/></svg>
        </div>
        <div>
          <div class="stat__value">${s.value}</div>
          <div class="stat__label">${s.label}</div>
        </div>
      </div>`).join('');
  }

  /* ---------- list ---------- */

  function filteredParts() {
    const term = searchTerm.trim().toLowerCase();
    let list = Storage.getData('parts').filter(p => {
      if (term) {
        const hay = `${p.id} ${p.partNo || ''} ${p.name} ${p.brand || ''} ${p.category || ''} ${p.location || ''} ${p.supplier || ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (fCategory !== 'all' && p.category !== fCategory) return false;
      if (fBrand !== 'all' && p.brand !== fBrand) return false;
      if (fStatus !== 'all' && (p.status || 'Active') !== fStatus) return false;
      if (fStockStatus !== 'all' && Inventory.stockStatus(p) !== fStockStatus) return false;
      return true;
    });

    const val = p => (Number(p.stock) || 0) * (Number(p.purchasePrice) || 0);
    const cmp = {
      'name-asc':     (a, b) => a.name.localeCompare(b.name),
      'name-desc':    (a, b) => b.name.localeCompare(a.name),
      'partno':       (a, b) => (a.partNo || '').localeCompare(b.partNo || ''),
      'stock-asc':    (a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0),
      'stock-desc':   (a, b) => (Number(b.stock) || 0) - (Number(a.stock) || 0),
      'price-asc':    (a, b) => (Number(a.sellingPrice) || 0) - (Number(b.sellingPrice) || 0),
      'price-desc':   (a, b) => (Number(b.sellingPrice) || 0) - (Number(a.sellingPrice) || 0),
      'value-desc':   (a, b) => val(b) - val(a),
      'updated-desc': (a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
    }[sortBy];
    return list.sort(cmp);
  }

  function populateFilters() {
    const parts = Storage.getData('parts');
    const fill = (id, values, label) => {
      const sel = document.getElementById(id);
      const current = sel.value;
      sel.innerHTML = `<option value="all">${label}</option>` +
        values.map(v => `<option${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
    };
    fill('invCategory', [...new Set([...parts.map(p => p.category).filter(Boolean)])].sort(), 'All categories');
    fill('invBrand', [...new Set(parts.map(p => p.brand).filter(Boolean))].sort(), 'All brands');
  }

  function renderList() {
    const rows = filteredParts();
    const total = Storage.getData('parts').length;
    const tbody = document.getElementById('invTableBody');
    const isFiltered = searchTerm || fCategory !== 'all' || fBrand !== 'all' || fStockStatus !== 'all' || fStatus !== 'all';

    document.getElementById('invCount').textContent =
      isFiltered ? `${rows.length} of ${total} parts` : `${total} parts`;

    if (!rows.length) {
      let msg = 'No parts found.';
      if (fStockStatus === 'Low Stock') msg = 'No low-stock parts.';
      else if (fStockStatus === 'Out of Stock') msg = 'No out-of-stock parts.';
      else if (isFiltered) msg = 'No parts match your search or filter.';
      tbody.innerHTML = `
        <tr><td colspan="11">
          <div class="empty">
            <svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z"/></svg>
            <h3>${msg}</h3>
            <p>${isFiltered ? 'Try a different filter.' : 'Add your first part to start tracking inventory.'}</p>
            ${isFiltered ? '' : '<button class="btn btn--primary" data-action="add">Add Part</button>'}
          </div>
        </td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(p => `
      <tr data-id="${esc(p.id)}">
        <td class="cell-main">${esc(p.id)}</td>
        <td class="cell-main">${esc(p.name)}${p.brand ? `<span class="cell-sub">${esc(p.brand)}${p.location ? ' · ' + esc(p.location) : ''}</span>` : ''}</td>
        <td>${esc(p.partNo || '—')}</td>
        <td><span class="badge badge--neutral">${esc(p.category || '—')}</span></td>
        <td class="num">${Number(p.stock) || 0} ${esc(p.unit || '')}</td>
        <td class="num">${Number(p.minStock) || 0}</td>
        <td class="num">${money(p.purchasePrice)}</td>
        <td class="num">${money(p.sellingPrice)}</td>
        <td class="num">${money((Number(p.stock) || 0) * (Number(p.purchasePrice) || 0))}</td>
        <td>${stockBadge(p)}</td>
        <td>
          <div class="row-actions row-actions--wrap">
            <button class="btn btn--sm btn--ghost" data-action="receive">Receive</button>
            <button class="btn btn--sm btn--ghost" data-action="adjust">Adjust</button>
            <button class="icon-btn icon-btn--sm" data-action="view" title="View details" aria-label="View ${esc(p.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8c-1.7 0-3 1.3-3 3s1.3 3 3 3 3-1.3 3-3-1.3-3-3-3z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="edit" title="Edit" aria-label="Edit ${esc(p.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 17.2V21h3.8l11-11.1-3.7-3.7L3 17.2zM20.7 7c.4-.4.4-1 0-1.4l-2.3-2.3c-.4-.4-1-.4-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>
            </button>
            <button class="icon-btn icon-btn--sm" data-action="toggle" title="${isActive(p) ? 'Deactivate' : 'Activate'}" aria-label="${isActive(p) ? 'Deactivate' : 'Activate'} ${esc(p.name)}">
              ${isActive(p)
                ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8 0-1.8.6-3.5 1.7-4.9L16.9 18.3C15.5 19.4 13.8 20 12 20zm6.3-3.1L7.1 5.7C8.5 4.6 10.2 4 12 4c4.4 0 8 3.6 8 8 0 1.8-.6 3.5-1.7 4.9z"/></svg>'
                : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>'}
            </button>
            <button class="icon-btn icon-btn--sm icon-btn--danger" data-action="delete" title="Delete" aria-label="Delete ${esc(p.name)}">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            </button>
          </div>
        </td>
      </tr>`).join('');
  }

  /* ---------- add / edit part (master data — stock NOT editable here) ---------- */

  function optList(options, selected) {
    return options.map(o => `<option${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }

  function formHtml(p = {}) {
    const isEdit = !!p.id;
    const cats = p.category && !CATEGORIES.includes(p.category) ? [p.category, ...CATEGORIES] : CATEGORIES;
    const units = p.unit && !UNITS.includes(p.unit) ? [p.unit, ...UNITS] : UNITS;
    return `
      <form id="partForm" novalidate>
        <div class="form-grid">
          <div class="field">
            <label for="pf-partno">Part Number / SKU <span class="req">*</span></label>
            <input class="input" id="pf-partno" name="partNo" value="${esc(p.partNo || '')}" placeholder="BP-001" autocomplete="off">
            <div class="field__error" data-err="partNo"></div>
          </div>
          <div class="field">
            <label for="pf-name">Part Name <span class="req">*</span></label>
            <input class="input" id="pf-name" name="name" value="${esc(p.name || '')}" autocomplete="off">
            <div class="field__error" data-err="name"></div>
          </div>
          <div class="field">
            <label for="pf-category">Category <span class="req">*</span></label>
            <select class="select" id="pf-category" name="category">
              <option value="">— Select —</option>${optList(cats, p.category)}
            </select>
            <div class="field__error" data-err="category"></div>
          </div>
          <div class="field">
            <label for="pf-brand">Brand</label>
            <input class="input" id="pf-brand" name="brand" value="${esc(p.brand || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="pf-unit">Unit <span class="req">*</span></label>
            <select class="select" id="pf-unit" name="unit">
              <option value="">— Select —</option>${optList(units, p.unit)}
            </select>
            <div class="field__error" data-err="unit"></div>
          </div>
          <div class="field">
            <label for="pf-location">Location / Rack</label>
            <input class="input" id="pf-location" name="location" value="${esc(p.location || '')}" placeholder="Rack A-01" autocomplete="off">
          </div>
          <div class="field">
            <label for="pf-supplier">Supplier</label>
            <input class="input" id="pf-supplier" name="supplier" value="${esc(p.supplier || '')}" autocomplete="off">
          </div>
          <div class="field">
            <label for="pf-status">Status</label>
            <select class="select" id="pf-status" name="status">
              <option${(p.status || 'Active') === 'Active' ? ' selected' : ''}>Active</option>
              <option${p.status === 'Inactive' ? ' selected' : ''}>Inactive</option>
            </select>
          </div>
          <div class="field">
            <label for="pf-purchase">Purchase Price (BDT) <span class="req">*</span></label>
            <input class="input" id="pf-purchase" name="purchasePrice" type="number" min="0" step="10" value="${esc(p.purchasePrice ?? '')}">
            <div class="field__error" data-err="purchasePrice"></div>
          </div>
          <div class="field">
            <label for="pf-selling">Selling Price (BDT) <span class="req">*</span></label>
            <input class="input" id="pf-selling" name="sellingPrice" type="number" min="0" step="10" value="${esc(p.sellingPrice ?? '')}">
            <div class="field__error" data-err="sellingPrice"></div>
          </div>
          ${isEdit ? `
          <div class="field">
            <label>Current Stock</label>
            <input class="input" value="${Number(p.stock) || 0} ${esc(p.unit || '')}" disabled aria-label="Current stock (read-only)">
            <div class="muted-note">Stock changes only via Receive Stock or Stock Adjustment — this keeps the audit trail honest.</div>
          </div>` : `
          <div class="field">
            <label for="pf-opening">Opening Stock</label>
            <input class="input" id="pf-opening" name="openingStock" type="number" min="0" step="1" value="0">
            <div class="field__error" data-err="openingStock"></div>
          </div>`}
          <div class="field">
            <label for="pf-min">Minimum Stock <span class="req">*</span></label>
            <input class="input" id="pf-min" name="minStock" type="number" min="0" step="1" value="${esc(p.minStock ?? '')}">
            <div class="field__error" data-err="minStock"></div>
          </div>
          <div class="field">
            <label for="pf-reorder">Reorder Quantity</label>
            <input class="input" id="pf-reorder" name="reorderQty" type="number" min="0" step="1" value="${esc(p.reorderQty ?? 10)}">
            <div class="field__error" data-err="reorderQty"></div>
          </div>
          <div class="field span-2">
            <label for="pf-notes">Notes</label>
            <textarea class="textarea" id="pf-notes" name="notes" rows="2">${esc(p.notes || '')}</textarea>
          </div>
        </div>
      </form>`;
  }

  function readForm(form, isEdit) {
    const val = n => form[n] ? form[n].value.trim() : '';
    const num = n => form[n] && form[n].value !== '' ? Number(form[n].value) : '';
    return {
      partNo: val('partNo').toUpperCase(),
      name: val('name').replace(/\s+/g, ' '),
      category: val('category'), brand: val('brand'),
      unit: val('unit'), location: val('location'), supplier: val('supplier'),
      status: val('status'),
      purchasePrice: num('purchasePrice'), sellingPrice: num('sellingPrice'),
      openingStock: isEdit ? null : (num('openingStock') || 0),
      minStock: num('minStock'), reorderQty: num('reorderQty') || 0,
      notes: val('notes')
    };
  }

  function validate(v, editingId = null) {
    const errors = {};
    if (!v.name) errors.name = 'Part name is required.';
    if (!v.partNo) errors.partNo = 'Part number / SKU is required.';
    else {
      const dup = Storage.getData('parts').find(p =>
        p.id !== editingId && (p.status || 'Active') === 'Active' &&
        (p.partNo || '').toUpperCase() === v.partNo);
      if (dup) errors.partNo = `An active part with this part number already exists (${dup.name}).`;
    }
    if (!v.category) errors.category = 'Select a category.';
    if (!v.unit) errors.unit = 'Select a unit.';
    if (v.purchasePrice === '' || v.purchasePrice < 0) errors.purchasePrice = 'Purchase price must be 0 or more.';
    if (v.sellingPrice === '' || v.sellingPrice < 0) errors.sellingPrice = 'Selling price must be 0 or more.';
    if (v.openingStock != null && v.openingStock < 0) errors.openingStock = 'Opening stock cannot be negative.';
    if (v.minStock === '' || v.minStock < 0) errors.minStock = 'Minimum stock must be 0 or more.';
    if (v.reorderQty < 0) errors.reorderQty = 'Reorder quantity cannot be negative.';
    return { valid: Object.keys(errors).length === 0, errors };
  }

  function showErrors(form, errors) {
    form.querySelectorAll('.field').forEach(f => f.classList.remove('field--error'));
    form.querySelectorAll('[data-err]').forEach(el => el.textContent = '');
    Object.entries(errors).forEach(([key, msg]) => {
      const el = form.querySelector(`[data-err="${key}"]`);
      if (el) { el.textContent = msg; el.closest('.field').classList.add('field--error'); }
    });
  }

  function marginWarning(v) {
    if (v.sellingPrice !== '' && v.purchasePrice !== '' && v.sellingPrice < v.purchasePrice) {
      toast('Selling price is below purchase cost.', 'warning');
    }
  }

  function openAddModal() {
    const ov = Modal.open({
      title: 'Add Part', size: 'lg',
      body: formHtml(),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Part</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#partForm');
      const v = readForm(form, false);
      const { valid, errors } = validate(v);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const { openingStock, ...master } = v;
      // stock is deliberately not in `master`, and the API refuses it even as
      // a 0: a balance only moves through the ledger. The column is NOT NULL
      // DEFAULT 0, so a new part starts at zero without being told to.
      const created = await Storage.create('parts', master);
      if (!Utils.wrote(created, form)) return;
      const rec = created.record;
      // Opening stock is a proper audited transaction, never a silent field write
      if (openingStock > 0) {
        const moved = await Inventory.move({
          partId: rec.id, type: 'initial-stock', quantity: openingStock,
          unitCost: v.purchasePrice, referenceType: 'manual', referenceId: null,
          reason: 'Initial Stock', notes: 'Opening stock'
        });
        // The part exists either way; only its opening balance failed, and
        // saying so is better than implying the whole save was lost.
        if (!moved.ok) {
          Modal.close();
          refresh();
          toast(`Part "${rec.name}" added, but its opening stock was not recorded: ${moved.error}`, 'error');
          return;
        }
      }
      marginWarning(v);
      Modal.close();
      refresh();
      toast(`Part "${rec.name}" added (${rec.id}).`);
    }));
  }

  function openEditModal(id) {
    const p = Storage.getById('parts', id);
    if (!p) return;
    const ov = Modal.open({
      title: `Edit Part — ${p.id}`, size: 'lg',
      body: formHtml(p),
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Save Changes</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#partForm');
      const v = readForm(form, true);
      const { valid, errors } = validate(v, id);
      if (!valid) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }
      const { openingStock, ...master } = v;
      // stock is deliberately not in `master`, and the API would refuse it
      // anyway: a balance only moves through the ledger.
      const res = await Storage.update('parts', id, master);
      if (!Utils.wrote(res, form)) return;
      marginWarning(v);
      Modal.close();
      refresh();
      toast(`Part "${v.name}" updated.`);
    }));
  }

  /* ---------- receive stock ---------- */

  function partPicker(selectedId) {
    return `<option value="">— Select part —</option>` +
      Storage.getData('parts').filter(isActive)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(p => `<option value="${esc(p.id)}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)} (${esc(p.partNo || p.id)}) — stock: ${Number(p.stock) || 0}</option>`).join('');
  }

  function openReceiveModal(partId = '') {
    if (!Storage.getData('parts').some(isActive)) { toast('Add a part first.', 'info'); return; }
    const ov = Modal.open({
      title: 'Receive Stock',
      body: `
        <form id="recvForm" novalidate>
          <div class="field">
            <label for="rf-part">Part <span class="req">*</span></label>
            <select class="select" id="rf-part" name="partId">${partPicker(partId)}</select>
            <div class="field__error" data-err="partId"></div>
          </div>
          <div class="form-grid">
            <div class="field">
              <label for="rf-qty">Quantity <span class="req">*</span></label>
              <input class="input" id="rf-qty" name="quantity" type="number" min="1" step="1">
              <div class="field__error" data-err="quantity"></div>
            </div>
            <div class="field">
              <label for="rf-cost">Unit Cost (BDT)</label>
              <input class="input" id="rf-cost" name="unitCost" type="number" min="0" step="10">
              <div class="field__error" data-err="unitCost"></div>
            </div>
            <div class="field">
              <label for="rf-supplier">Supplier</label>
              <input class="input" id="rf-supplier" name="supplier" autocomplete="off">
            </div>
            <div class="field">
              <label for="rf-ref">Reference / Invoice No.</label>
              <input class="input" id="rf-ref" name="reference" autocomplete="off">
            </div>
            <div class="field span-2">
              <label for="rf-notes">Notes</label>
              <textarea class="textarea" id="rf-notes" name="notes" rows="2"></textarea>
            </div>
          </div>
        </form>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Receive Stock</button>`
    });
    // Prefill unit cost from the part's purchase price
    ov.querySelector('#rf-part').addEventListener('change', e => {
      const p = Storage.getById('parts', e.target.value);
      if (p) ov.querySelector('#rf-cost').value = p.purchasePrice ?? '';
    });
    if (partId) ov.querySelector('#rf-part').dispatchEvent(new Event('change'));

    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#recvForm');
      const errors = {};
      const pid = form.partId.value;
      const qty = Number(form.quantity.value);
      const cost = form.unitCost.value === '' ? null : Number(form.unitCost.value);
      if (!pid || !Storage.getById('parts', pid)) errors.partId = 'Select a part.';
      if (!qty || qty <= 0) errors.quantity = 'Quantity must be greater than 0.';
      if (cost != null && cost < 0) errors.unitCost = 'Unit cost cannot be negative.';
      if (Object.keys(errors).length) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      const res = await Inventory.move({
        partId: pid, type: 'purchase', quantity: qty, unitCost: cost,
        referenceType: 'manual', referenceId: form.reference.value.trim() || null,
        notes: [form.supplier.value.trim() && `Supplier: ${form.supplier.value.trim()}`, form.notes.value.trim()].filter(Boolean).join(' — ')
      });
      if (!res.ok) { toast(res.error, 'error'); return; }
      Modal.close();
      refresh();
      if (res.pending) toast(`Saved offline as ${res.transaction.id}. Stock changes when the server accepts it.`, 'info');
      else if (res.stale && res.stale.length) Utils.wrote(res);
      else toast(`Stock received. New stock: ${res.newStock}.`);
    }));
  }

  /* ---------- stock adjustment ---------- */

  function openAdjustModal(partId) {
    const p = Storage.getById('parts', partId);
    if (!p) return;
    const ov = Modal.open({
      title: `Stock Adjustment — ${p.name}`,
      body: `
        <p class="muted-note" style="margin-bottom:12px">Current stock: <strong>${Number(p.stock) || 0} ${esc(p.unit || '')}</strong></p>
        <form id="adjForm" novalidate>
          <div class="form-grid">
            <div class="field">
              <label for="af-dir">Direction <span class="req">*</span></label>
              <select class="select" id="af-dir" name="direction">
                <option value="adjustment-in">Adjustment In (+)</option>
                <option value="adjustment-out">Adjustment Out (−)</option>
              </select>
            </div>
            <div class="field">
              <label for="af-qty">Quantity <span class="req">*</span></label>
              <input class="input" id="af-qty" name="quantity" type="number" min="1" step="1">
              <div class="field__error" data-err="quantity"></div>
            </div>
            <div class="field span-2">
              <label for="af-reason">Reason <span class="req">*</span></label>
              <select class="select" id="af-reason" name="reason">
                <option value="">— Select reason —</option>
                ${ADJUST_REASONS.map(r => `<option>${r}</option>`).join('')}
              </select>
              <div class="field__error" data-err="reason"></div>
            </div>
            <div class="field span-2">
              <label for="af-notes">Notes</label>
              <textarea class="textarea" id="af-notes" name="notes" rows="2"></textarea>
            </div>
          </div>
        </form>`,
      footer: `<button class="btn btn--ghost" data-modal-close>Cancel</button>
               <button class="btn btn--primary" data-save>Apply Adjustment</button>`
    });
    ov.querySelector('[data-save]').addEventListener('click', Utils.saving(async () => {
      const form = ov.querySelector('#adjForm');
      const errors = {};
      const qty = Number(form.quantity.value);
      if (!qty || qty <= 0) errors.quantity = 'Quantity must be greater than 0.';
      if (!form.reason.value) errors.reason = 'A reason is required for every adjustment.';
      if (Object.keys(errors).length) { showErrors(form, errors); toast('Please fix the highlighted fields.', 'error'); return; }

      // Damaged/Lost/Expired reasons map to their own OUT types for cleaner audit
      let type = form.direction.value;
      if (type === 'adjustment-out' && form.reason.value === 'Damaged') type = 'damaged';
      if (type === 'adjustment-in' && form.reason.value === 'Return') type = 'return';

      const res = await Inventory.move({
        partId, type, quantity: qty,
        referenceType: 'manual', referenceId: null,
        reason: form.reason.value, notes: form.notes.value.trim()
      });
      if (!res.ok) { toast(res.error, 'error'); return; }   // "Insufficient stock…" surfaces here
      Modal.close();
      refresh();
      if (res.pending) toast(`Saved offline as ${res.transaction.id}. Stock changes when the server accepts it.`, 'info');
      else if (res.stale && res.stale.length) Utils.wrote(res);
      else toast(`Adjustment applied. New stock: ${res.newStock}.`);
    }));
  }

  /* ---------- activate / deactivate ---------- */

  async function toggleStatus(id) {
    const p = Storage.getById('parts', id);
    if (!p) return;
    const next = isActive(p) ? 'Inactive' : 'Active';
    const res = await Storage.update('parts', id, { status: next });
    if (!Utils.wrote(res)) return;
    refresh();
    toast(`Part "${p.name}" ${next === 'Active' ? 'activated' : 'deactivated'}.`, next === 'Active' ? 'success' : 'info');
  }

  /* ---------- delete (only genuinely unused parts) ---------- */

  function partUsage(partId) {
    let count = 0, qty = 0, sales = 0;
    Storage.getData('jobCards').forEach(j => (j.partsUsed || []).forEach(l => {
      if (l.partId === partId) { count++; qty += Number(l.qty) || 0; sales += Number(l.total) || 0; }
    }));
    return { count, qty, sales };
  }

  function openDeleteModal(id) {
    const p = Storage.getById('parts', id);
    if (!p) return;
    const usage = partUsage(id);
    const txns = Utils.Inventory.history(id).filter(t => t.type !== 'initial-stock');
    const hasStock = (Number(p.stock) || 0) > 0;

    if (usage.count || txns.length || hasStock) {
      const reasons = [];
      if (usage.count) reasons.push(`${usage.count} job card line${usage.count > 1 ? 's' : ''}`);
      if (txns.length) reasons.push(`${txns.length} stock transaction${txns.length > 1 ? 's' : ''}`);
      if (hasStock) reasons.push(`${p.stock} ${p.unit || ''} still in stock`);
      Modal.open({
        title: 'Cannot delete part',
        body: `<p style="margin:0"><strong>${esc(p.name)}</strong> has ${reasons.join(', ')}.
               Deleting it would corrupt inventory history.</p>
               <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
               Deactivate the part instead — it stays in history but can't be added to new job cards.</p>`,
        footer: `<button class="btn btn--ghost" data-modal-close>Close</button>
                 ${isActive(p) ? '<button class="btn btn--primary" data-deactivate>Deactivate Part</button>' : ''}`
      });
      const btn = document.querySelector('[data-deactivate]');
      // toggleStatus writes, so the click waits for it: closing first would
      // take the dialog away before anyone knew whether it worked, and leave a
      // second click free to send the request twice.
      if (btn) btn.addEventListener('click', Utils.saving(async () => {
        await toggleStatus(id);
        Modal.close();
      }));
      return;
    }

    Modal.confirm({
      title: 'Delete part?',
      message: `Permanently delete <strong>${esc(p.name)}</strong> (${esc(p.id)})? This cannot be undone.`,
      confirmText: 'Delete Part',
      onConfirm: async () => {
        if (Storage.isApi()) {
          // The ledger is append-only on the server and inventory_transactions
          // .part_id is ON DELETE RESTRICT, so an initial-stock row makes the
          // part undeletable -- deliberately: erasing stock history to tidy up
          // a catalogue entry is exactly what that constraint exists to stop.
          // The guard above already sends every part that HAS history down the
          // "deactivate instead" path; this is the one case it let through.
          const res = await Storage.remove('parts', id);
          if (!res.ok) {
            Modal.open({
              title: 'Cannot delete part',
              body: `<p style="margin:0">${esc(res.message)}</p>
                     <p style="margin:12px 0 0;color:var(--text-2);font-size:.84rem">
                     Deactivate the part instead — it stays in history but can't be added to new job cards.</p>`,
              footer: `<button class="btn btn--ghost" data-modal-close>Close</button>`
            });
            return;
          }
          const stale = await Storage.refreshAll('inventoryTransactions');
          refresh();
          if (stale.length) Utils.wrote({ ok: true, stale });
          else toast(`Part "${p.name}" deleted.`, 'warning');
          return;
        }
        // remove its initial-stock audit rows too (the only txns it can have here)
        Storage.getData('inventoryTransactions')
          .filter(t => t.partId === id)
          .forEach(t => Storage.deleteData('inventoryTransactions', t.id));
        Storage.deleteData('parts', id);
        refresh();
        toast(`Part "${p.name}" deleted.`, 'warning');
      }
    });
  }

  /* ---------- details + stock history ---------- */

  function openDetailModal(id) {
    const p = Storage.getById('parts', id);
    if (!p) return;
    const usage = partUsage(id);
    const txns = Inventory.history(id).slice(0, 10);
    const stock = Number(p.stock) || 0;
    const profit = (Number(p.sellingPrice) || 0) - (Number(p.purchasePrice) || 0);
    const marginPct = Number(p.purchasePrice) > 0
      ? Math.round(profit / Number(p.purchasePrice) * 1000) / 10 + '%' : 'N/A';

    const historyHtml = txns.length
      ? `<div class="table-wrap"><table class="table table--compact">
          <thead><tr><th>Date</th><th>Txn</th><th>Type</th><th class="num">Qty</th><th class="num">Unit Cost</th><th class="num">Stock</th><th>Ref / Notes</th></tr></thead>
          <tbody>${txns.map(t => `
            <tr>
              <td>${fmtDate(t.createdAt)}</td>
              <td class="cell-main">${esc(t.id)}</td>
              <td><span class="badge badge--${TXN_TONE[t.type] || 'neutral'}">${TXN_LABELS[t.type] || esc(t.type)}</span></td>
              <td class="num">${t.quantity}</td>
              <td class="num">${t.unitCost != null ? money(t.unitCost) : '—'}</td>
              <td class="num">${t.prevStock != null ? `${t.prevStock} → ${t.newStock}` : '—'}</td>
              <td class="cell-desc">${esc([t.referenceId, t.reason, t.notes].filter(Boolean).join(' · ') || '—')}</td>
            </tr>`).join('')}
          </tbody></table></div>`
      : `<p class="muted-note">No stock movements found.</p>`;

    Modal.open({
      title: `${p.name} — ${p.id}`, size: 'lg',
      body: `
        <div class="detail-grid detail-grid--3">
          <div class="detail-item"><span>Part Number</span><strong>${esc(p.partNo || '—')}</strong></div>
          <div class="detail-item"><span>Category</span><strong>${esc(p.category || '—')}</strong></div>
          <div class="detail-item"><span>Brand</span><strong>${esc(p.brand || '—')}</strong></div>
          <div class="detail-item"><span>Unit</span><strong>${esc(p.unit || '—')}</strong></div>
          <div class="detail-item"><span>Location</span><strong>${esc(p.location || '—')}</strong></div>
          <div class="detail-item"><span>Supplier</span><strong>${esc(p.supplier || '—')}</strong></div>
          <div class="detail-item"><span>Purchase Price</span><strong>${money(p.purchasePrice)}</strong></div>
          <div class="detail-item"><span>Selling Price</span><strong>${money(p.sellingPrice)}</strong></div>
          <div class="detail-item"><span>Profit / Unit</span><strong>${money(profit)} (${marginPct})</strong></div>
          <div class="detail-item"><span>Status</span><strong>${badge(p.status || 'Active')}</strong></div>
          <div class="detail-item"><span>Created</span><strong>${p.createdAt ? fmtDate(p.createdAt) : '—'}</strong></div>
          <div class="detail-item"><span>Updated</span><strong>${p.updatedAt ? fmtDate(p.updatedAt) : '—'}</strong></div>
        </div>

        <div class="summary-row summary-row--6">
          <div class="summary-tile"><strong>${stock} ${esc(p.unit || '')}</strong><span>Current Stock</span></div>
          <div class="summary-tile"><strong>${Number(p.minStock) || 0}</strong><span>Minimum</span></div>
          <div class="summary-tile"><strong>${Number(p.reorderQty) || 0}</strong><span>Reorder Qty</span></div>
          <div class="summary-tile"><strong>${stockBadge(p)}</strong><span>Stock Status</span></div>
          <div class="summary-tile"><strong>${money(stock * (Number(p.purchasePrice) || 0))}</strong><span>Cost Value</span></div>
          <div class="summary-tile summary-tile--good"><strong>${money(stock * (Number(p.sellingPrice) || 0))}</strong><span>Sales Value</span></div>
        </div>

        ${usage.count ? `
        <h3 class="detail-section-title">Job Card Usage</h3>
        <div class="summary-row summary-row--3">
          <div class="summary-tile"><strong>${usage.count}</strong><span>Times Used</span></div>
          <div class="summary-tile"><strong>${usage.qty}</strong><span>Total Qty Used</span></div>
          <div class="summary-tile summary-tile--good"><strong>${money(usage.sales)}</strong><span>Sales from Job Cards</span></div>
        </div>` : ''}

        <h3 class="detail-section-title">Recent Stock Movements</h3>
        ${historyHtml}`,
      footer: `
        <button class="btn btn--ghost" data-do="receive">Receive Stock</button>
        <button class="btn btn--ghost" data-do="adjust">Adjust</button>
        <button class="btn btn--ghost" data-modal-close>Close</button>
        <button class="btn btn--primary" data-do="edit">Edit Part</button>`
    });
    document.querySelectorAll('[data-do]').forEach(btn => btn.addEventListener('click', () => {
      Modal.close();
      if (btn.dataset.do === 'receive') openReceiveModal(id);
      if (btn.dataset.do === 'adjust') openAdjustModal(id);
      if (btn.dataset.do === 'edit') openEditModal(id);
    }));
  }

  /* ---------- events + init ---------- */

  function refresh() {
    renderStats();
    populateFilters();
    renderList();
  }

  function bindEvents() {
    document.getElementById('addPartBtn').addEventListener('click', openAddModal);
    document.getElementById('receiveStockBtn').addEventListener('click', () => openReceiveModal());
    document.getElementById('invSearch').addEventListener('input', e => { searchTerm = e.target.value; renderList(); });
    ['invCategory', 'invBrand', 'invStockStatus', 'invStatus', 'invSort'].forEach(fid => {
      document.getElementById(fid).addEventListener('change', e => {
        if (fid === 'invCategory') fCategory = e.target.value;
        if (fid === 'invBrand') fBrand = e.target.value;
        if (fid === 'invStockStatus') fStockStatus = e.target.value;
        if (fid === 'invStatus') fStatus = e.target.value;
        if (fid === 'invSort') sortBy = e.target.value;
        renderList();
      });
    });

    document.getElementById('invTableBody').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'add') { openAddModal(); return; }
      const id = btn.closest('tr')?.dataset.id;
      if (!id) return;
      if (action === 'view') openDetailModal(id);
      if (action === 'edit') openEditModal(id);
      if (action === 'receive') openReceiveModal(id);
      if (action === 'adjust') openAdjustModal(id);
      // Delegated: the listener is on the table body, so the button being
      // held is the one in this row, not the one the listener sits on.
      if (action === 'toggle') { Utils.guard(btn, () => toggleStatus(id)); return; }
      if (action === 'delete') openDeleteModal(id);
    });
  }

  Storage.ready(() => {
    bindEvents();
    refresh();
    const viewId = new URLSearchParams(location.search).get('view');
    if (viewId && Storage.getById('parts', viewId)) openDetailModal(viewId);
  });

})();
