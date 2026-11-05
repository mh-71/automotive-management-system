/* ============================================================
   inbox-bookings.js — Social Inbox › Bookings   (DEMO, UI ONLY)
   ------------------------------------------------------------
   Loaded only by pages/inbox-bookings.html. A preview of a future
   bookings inbox, drawn from the FICTIONAL sample bookings below.

   Nothing here talks to the Worker, the database or browser storage,
   and nothing is created, saved or sent: the status tabs filter this
   list in memory and the details panel only shows a sample booking.
   Everything shown is escaped (Utils.esc) before it reaches HTML.
   ============================================================ */

const InboxBookings = (() => {

  const STATUSES = ['New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed'];
  const TONE = { New: 'new', Pending: 'pending', Confirmed: 'confirmed', Rescheduled: 'rescheduled', Cancelled: 'cancelled', Completed: 'completed' };

  /* Fictional sample bookings (DEMO). Phone numbers use the 0170000xxxx
     range and emails the .invalid domain, so none can reach a real person. */
  const SAMPLE = [
    { id: 'BKG-001', name: 'Rahim Ahmed', phone: '01700-000101', email: 'rahim.demo@example.invalid', make: 'Toyota', model: 'Corolla', year: '2016', regNo: 'DHAKA-METRO-GA-00-0101',
      service: 'AC Service', date: '2026-11-06', time: '10:30', source: 'Website', status: 'Pending', message: 'The AC is blowing warm air since last week.' },
    { id: 'BKG-002', name: 'Karim Hasan', phone: '01700-000102', email: 'karim.demo@example.invalid', make: 'Toyota', model: 'Axio', year: '2015', regNo: 'DHAKA-METRO-KHA-00-0102',
      service: 'Engine Service', date: '2026-11-07', time: '11:00', source: 'Website', status: 'Confirmed', message: 'Full engine service and oil change, please.' },
    { id: 'BKG-003', name: 'Sajid Khan', phone: '01700-000103', email: '', make: 'Honda', model: 'Vezel', year: '2017', regNo: 'DHAKA-METRO-GA-00-0103',
      service: 'Hybrid Service', date: '2026-11-08', time: '09:30', source: 'Website', status: 'New', message: 'Hybrid system warning light came on.' },
    { id: 'BKG-004', name: 'Nusrat Jahan', phone: '01700-000104', email: 'nusrat.demo@example.invalid', make: 'Toyota', model: 'Premio', year: '2014', regNo: 'DHAKA-METRO-GA-00-0104',
      service: 'LPG Conversion', date: '2026-11-08', time: '14:00', source: 'Facebook Messenger', status: 'Pending', message: 'Want a price and time for LPG conversion.' },
    { id: 'BKG-005', name: 'Tanvir Rahman', phone: '01700-000105', email: '', make: 'Nissan', model: 'X-Trail', year: '2016', regNo: 'DHAKA-METRO-GHA-00-0105',
      service: 'Brake Service', date: '2026-11-09', time: '12:00', source: 'WhatsApp', status: 'Confirmed', message: 'Brakes squeal when stopping.' },
    { id: 'BKG-006', name: 'Farhana Akter', phone: '01700-000106', email: 'farhana.demo@example.invalid', make: 'Honda', model: 'Grace', year: '2018', regNo: 'DHAKA-METRO-GA-00-0106',
      service: 'Car Wash & Detailing', date: '2026-11-10', time: '16:30', source: 'Website', status: 'Rescheduled', message: 'Moved from 5 Nov because of travel.' },
    { id: 'BKG-007', name: 'Imran Hossain', phone: '01700-000107', email: '', make: 'Toyota', model: 'Noah', year: '2013', regNo: 'DHAKA-METRO-CHA-00-0107',
      service: 'Periodic Maintenance', date: '2026-11-04', time: '10:00', source: 'Phone', status: 'Completed', message: '40,000 km service.' },
    { id: 'BKG-008', name: 'Mehedi Hasan', phone: '01700-000108', email: 'mehedi.demo@example.invalid', make: 'Mitsubishi', model: 'Pajero', year: '2012', regNo: 'DHAKA-METRO-GHA-00-0108',
      service: 'Denting & Painting', date: '2026-11-05', time: '15:00', source: 'Website', status: 'Cancelled', message: 'Customer cancelled; will come next month.' },
    { id: 'BKG-009', name: 'Shirin Sultana', phone: '01700-000109', email: '', make: 'Toyota', model: 'Allion', year: '2017', regNo: 'DHAKA-METRO-GA-00-0109',
      service: 'Battery & Electrical', date: '2026-11-11', time: '11:30', source: 'WhatsApp', status: 'New', message: 'Car does not start in the morning.' },
    { id: 'BKG-010', name: 'Abdul Malek', phone: '01700-000110', email: '', make: 'Toyota', model: 'Hiace', year: '2011', regNo: 'DHAKA-METRO-CHA-00-0110',
      service: 'CNG Conversion', date: '2026-11-12', time: '09:00', source: 'Website', status: 'Confirmed', message: 'CNG cylinder re-test and kit check.' },
  ];

  /* ---------- pure helpers (exported for the unit suite) ---------- */

  const filterBy = (rows, status) => (status ? rows.filter((b) => b.status === status) : rows.slice());

  function summary(rows) {
    return {
      total: rows.length,
      pending: rows.filter((b) => b.status === 'Pending').length,
      confirmed: rows.filter((b) => b.status === 'Confirmed').length,
    };
  }

  /** '2026-11-06' -> 'Nov 06, 2026'; '10:30' -> '10:30 AM'. Fixed formats, no time zone involved. */
  function dateLabel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${MON[Number(m[2]) - 1]} ${m[3]}, ${m[1]}`;
  }
  function timeLabel(hm) {
    const m = /^(\d{2}):(\d{2})$/.exec(hm || '');
    if (!m) return '';
    const h = Number(m[1]);
    return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
  }

  function statusHtml(status) {
    return `<span class="bk-status bk-status--${TONE[status] || 'new'}">${Utils.esc(status)}</span>`;
  }

  function cardHtml(b, selectedId) {
    const esc = Utils.esc;
    const active = b.id === selectedId;
    return `<li><button type="button" class="bk-card${active ? ' is-active' : ''}" data-id="${esc(b.id)}"${active ? ' aria-current="true"' : ''}>
        <span class="bk-card__top"><span class="bk-card__name">${esc(b.name)}</span>${statusHtml(b.status)}</span>
        <span class="bk-card__meta">${esc(b.id)} · ${esc(`${b.make} ${b.model}`)}</span>
        <span class="bk-card__what">${esc(b.service)} · ${esc(dateLabel(b.date))} · ${esc(timeLabel(b.time))}</span>
        <span class="bk-card__src">Source: ${esc(b.source)}</span>
      </button></li>`;
  }

  function detailHtml(b) {
    const esc = Utils.esc;
    const fact = (label, value) => (value ? `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>` : '');
    const group = (title, facts) => `<section class="bk-group"><h4>${esc(title)}</h4><dl class="bk-facts">${facts}</dl></section>`;
    return group('Customer Information',
        fact('Name', esc(b.name))
        + fact('Phone', esc(b.phone))
        + fact('Email', esc(b.email)))
      + group('Vehicle Information',
        fact('Make & model', esc(`${b.make} ${b.model}`))
        + fact('Year', esc(b.year))
        + fact('Registration', esc(b.regNo)))
      + group('Booking',
        fact('Requested service', esc(b.service))
        + fact('Preferred date', esc(dateLabel(b.date)))
        + fact('Preferred time', esc(timeLabel(b.time)))
        + fact('Booking source', esc(b.source))
        + fact('Status', statusHtml(b.status))
        + fact('Reference', esc(b.id)))
      + (b.message ? `<section class="bk-group"><h4>Customer Message</h4><p class="bk-message">${esc(b.message)}</p></section>` : '');
  }

  /* ---------- page ---------- */

  const state = { status: '', selected: null };
  const $ = (id) => document.getElementById(id);

  function renderTabs() {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, SAMPLE.filter((b) => b.status === s).length]));
    $('bkTabs').innerHTML = [['', 'All', SAMPLE.length], ...STATUSES.map((s) => [s, s, counts[s]])]
      .map(([value, label, n]) => `<button type="button" class="bk-tab${value === state.status ? ' is-active' : ''}" role="tab" data-status="${Utils.esc(value)}" aria-selected="${value === state.status}">${Utils.esc(label)} <span class="bk-tab__n">${n}</span></button>`)
      .join('');
  }

  function renderSummary() {
    const s = summary(SAMPLE);
    $('bkTotal').textContent = String(s.total);
    $('bkPending').textContent = String(s.pending);
    $('bkConfirmed').textContent = String(s.confirmed);
  }

  function renderList() {
    const rows = filterBy(SAMPLE, state.status);
    $('bkFilterLabel').textContent = state.status || 'All';
    $('bkList').innerHTML = rows.map((b) => cardHtml(b, state.selected && state.selected.id)).join('');
    $('bkList').hidden = rows.length === 0;
    $('bkEmpty').hidden = rows.length !== 0;
  }

  function renderDetail() {
    const b = state.selected;
    $('bkDetailEmpty').hidden = Boolean(b);
    $('bkDetail').hidden = !b;
    $('bkLayout').classList.toggle('is-detail-open', Boolean(b));
    if (!b) return;
    $('bkdName').textContent = b.name;
    $('bkdRef').textContent = `${b.id} · ${b.service}`;
    $('bkdStatus').className = `bk-status bk-status--${TONE[b.status] || 'new'}`;
    $('bkdStatus').textContent = b.status;
    $('bkdBody').innerHTML = detailHtml(b);
  }

  function select(id) {
    state.selected = SAMPLE.find((b) => b.id === id) || null;
    renderList();
    renderDetail();
  }

  function bind() {
    $('bkTabs').addEventListener('click', (ev) => {
      const tab = ev.target.closest('[data-status]');
      if (!tab) return;
      state.status = tab.dataset.status;
      // The open booking stays open only if it is still in the filtered list.
      if (state.selected && state.status && state.selected.status !== state.status) state.selected = null;
      renderTabs(); renderList(); renderDetail();
    });
    $('bkList').addEventListener('click', (ev) => { const card = ev.target.closest('[data-id]'); if (card) select(card.dataset.id); });
    $('bkBack').addEventListener('click', () => { state.selected = null; renderList(); renderDetail(); });
  }

  function init() {
    if (document.body.dataset.page !== 'inbox-bookings') return;
    renderSummary(); renderTabs(); renderList(); renderDetail();
    bind();
  }

  return { STATUSES, SAMPLE, filterBy, summary, dateLabel, timeLabel, cardHtml, detailHtml, init, _state: state };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { InboxBookings };

if (typeof document !== 'undefined' && document.body && document.body.dataset && document.getElementById) InboxBookings.init();
