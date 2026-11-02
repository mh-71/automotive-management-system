/* ============================================================
   dashboard.js — Dashboard page logic
   Reads everything through the Storage layer, renders stats,
   a pure HTML/CSS revenue chart, recent jobs, and today's
   appointments.
   ============================================================ */

(() => {

  function todaysPayments() {
    const today = Utils.todayStr();
    // Exclude Void payments so a voided payment never counts as revenue.
    return Storage.getData('payments').filter(p => (p.date || '').slice(0, 10) === today && p.status !== 'Void');
  }

  function todaysExpenses() {
    const today = Utils.todayStr();
    // Exclude Void expenses, same principle as todaysPayments().
    return Storage.getData('expenses').filter(e => (e.date || '').slice(0, 10) === today && e.status !== 'Void');
  }

  /* ---------- stats ---------- */

  function renderStats() {
    const customers = Storage.getData('customers');
    const vehicles = Storage.getData('vehicles');
    const jobCards = Storage.getData('jobCards');
    const parts = Storage.getData('parts');
    const appts = Storage.getData('appointments');
    const today = Utils.todayStr();

    const ACTIVE = ['Received', 'Inspection', 'Waiting for Approval', 'In Progress', 'Waiting for Parts'];
    const activeJobs = jobCards.filter(j => ACTIVE.includes(j.status)).length;
    const completedJobs = jobCards.filter(j => ['Completed', 'Delivered'].includes(j.status)).length;
    const todaysAppts = appts.filter(a => a.date === today && a.status !== 'Cancelled').length;
    const todayRevenue = todaysPayments().reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const todayExpenseTotal = todaysExpenses().reduce((s, e) => s + (Number(e.amount) || 0), 0);
    // Live balance, not the Job Cards' frozen pre-invoice snapshot: once a
    // job is invoiced its Invoice carries the current due (see Utils).
    const totalDue = Utils.sumJobsDue(jobCards);
    const lowStock = parts.filter(p => Number(p.stock) <= Number(p.minStock)).length;

    const stats = [
      { label: 'Total Customers',     value: customers.length,        tone: 'info',  icon: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z' },
      { label: 'Total Vehicles',      value: vehicles.length,         tone: 'info',  icon: 'M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6z' },
      { label: "Today's Appointments",value: todaysAppts,             tone: 'amber', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10z' },
      { label: 'Active Job Cards',    value: activeJobs,              tone: 'warn',  icon: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z' },
      { label: 'Completed Jobs',      value: completedJobs,           tone: 'good',  icon: 'M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z' },
      { label: "Today's Revenue",     value: Utils.money(todayRevenue), from: ['payments'], tone: 'good', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
      { label: "Today's Expenses",    value: Utils.money(todayExpenseTotal), from: ['expenses'], tone: 'bad', icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
      { label: 'Total Due',           value: Utils.money(totalDue),   from: ['invoices', 'payments'], tone: 'bad',   icon: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z' },
      { label: 'Low Stock Items',     value: lowStock,                tone: 'bad',   icon: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z' }
    ];

    // Roles & Permissions (0018): a figure drawn from records this role may not
    // read would only ever show 0, so it is left out rather than shown as fact.
    const denied = c => typeof Storage.isDenied === 'function' && Storage.isDenied(c);
    const shown = stats.filter(s => !(s.from || []).some(denied));
    document.getElementById('statsGrid').innerHTML = shown.map(s => `
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

  /* ---------- revenue chart (last 7 days, pure HTML/CSS) ---------- */

  function renderRevenueChart() {
    if (typeof Storage.isDenied === 'function' && Storage.isDenied('payments')) {
      document.getElementById('revChart').innerHTML = '<p class="muted" style="margin:auto">Your role does not include payments, so revenue is not shown.</p>';
      document.getElementById('revSummary').innerHTML = '';
      return;
    }
    // Exclude Void payments so a voided payment never counts as revenue.
    const payments = Storage.getData('payments').filter(p => p.status !== 'Void');
    const days = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = Utils.toDateStr(d);   // local calendar, never UTC
      const total = payments
        .filter(p => (p.date || '').slice(0, 10) === key)
        .reduce((s, p) => s + (Number(p.amount) || 0), 0);
      days.push({
        key,
        label: d.toLocaleDateString('en-GB', { weekday: 'short' }),
        total,
        isToday: i === 0
      });
    }

    const max = Math.max(...days.map(d => d.total), 1);
    const weekTotal = days.reduce((s, d) => s + d.total, 0);

    document.getElementById('revChart').innerHTML = days.map(d => `
      <div class="rev-col${d.isToday ? ' rev-col--today' : ''}">
        <div class="rev-col__bar-wrap">
          <div class="rev-col__bar" style="height:${Math.round(d.total / max * 100)}%"
               data-amount="${Utils.money(d.total)}"
               role="img" aria-label="${d.label}: ${Utils.money(d.total)}"></div>
        </div>
        <span class="rev-col__label">${d.label}</span>
      </div>`).join('');

    document.getElementById('revSummary').innerHTML = `
      <span>Last 7 days: <strong>${Utils.money(weekTotal)}</strong></span>
      <span>Today: <strong>${Utils.money(days[6].total)}</strong></span>`;
  }

  /* ---------- recent jobs table ---------- */

  function renderRecentJobs() {
    const jobs = Storage.getData('jobCards')
      .slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id.localeCompare(a.id))
      .slice(0, 6);

    const tbody = document.getElementById('recentJobsBody');

    if (!jobs.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><h3>No job cards yet</h3><p>Create your first job card to see it here.</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = jobs.map(j => {
      const svcNames = (j.services || []).map(s => s.name).join(', ') || '—';
      return `
      <tr>
        <td class="cell-main">${Utils.esc(j.id)}</td>
        <td>${Utils.esc(Utils.customerName(j.customerId))}</td>
        <td>${Utils.esc(Utils.vehicleLabel(j.vehicleId))}<span class="cell-sub">${Utils.esc(Utils.vehicleReg(j.vehicleId))}</span></td>
        <td>${Utils.esc(svcNames)}</td>
        <td>${Utils.esc(Utils.mechanicName(j.mechanicId))}</td>
        <td>${Utils.badge(j.status)}</td>
        <td class="num">${Utils.money(j.total)}</td>
        <td>${Utils.fmtDate(j.date)}</td>
      </tr>`;
    }).join('');
  }

  /* ---------- today's appointments ---------- */

  function renderTodaysAppointments() {
    const today = Utils.todayStr();
    const appts = Storage.getData('appointments')
      .filter(a => a.date === today)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

    const host = document.getElementById('apptList');

    if (!appts.length) {
      host.innerHTML = `<div class="empty"><h3>No appointments today</h3><p>Booked appointments for today will appear here.</p></div>`;
      return;
    }

    host.innerHTML = `<ul class="appt-list">${appts.map(a => `
      <li class="appt-item">
        <span class="appt-time">${Utils.fmtTime(a.time)}</span>
        <div class="appt-info">
          <strong>${Utils.esc(Utils.customerName(a.customerId))}</strong>
          <span>${Utils.esc(Utils.vehicleLabel(a.vehicleId))} · ${Utils.esc(Utils.serviceName(a.serviceId))}</span>
        </div>
        ${Utils.badge(a.status)}
      </li>`).join('')}</ul>`;
  }

  /* ---------- init ---------- */

  Storage.ready(() => {
    // App.init (in app.js) runs first and seeds data + builds shell
    renderStats();
    renderRevenueChart();
    renderRecentJobs();
    renderTodaysAppointments();
  });

})();
