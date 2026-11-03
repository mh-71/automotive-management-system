/* ============================================================
   app.js — Application shell
   Injects the sidebar + header into every page (one source of
   truth, no duplicated layout HTML), handles theme + mobile nav.
   Each page declares itself via <body data-page="..." data-root="">
   data-root is "" for index.html and "../" for files in /pages.
   ============================================================ */

const App = (() => {

  const NAV = [
    { key: 'dashboard',    label: 'Dashboard',    href: 'index.html',            icon: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z' },
    { key: 'customers',    label: 'Customers',    href: 'pages/customers.html',  icon: 'M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z' },
    { key: 'vehicles',     label: 'Vehicles',     href: 'pages/vehicles.html',   icon: 'M18.9 6c-.2-.6-.8-1-1.4-1H6.5c-.6 0-1.2.4-1.4 1L3 12v8c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h12v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-8l-2.1-6zM6.5 15c-.8 0-1.5-.7-1.5-1.5S5.7 12 6.5 12s1.5.7 1.5 1.5S7.3 15 6.5 15zm11 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zM5 10l1.5-4.5h11L19 10H5z' },
    { key: 'appointments', label: 'Appointments', href: 'pages/appointments.html', icon: 'M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z' },
    { key: 'job-cards',    label: 'Job Cards',    href: 'pages/job-cards.html',  icon: 'M20 6h-4V4c0-1.1-.9-2-2-2h-4C8.9 2 8 2.9 8 4v2H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zM10 4h4v2h-4V4z' },
    { key: 'estimates',    label: 'Estimates & Quotations', href: 'pages/estimates.html', icon: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm1 10h-4v1h3c.55 0 1 .45 1 1v3c0 .55-.45 1-1 1h-1v1h-2v-1H9v-2h4v-1h-3c-.55 0-1-.45-1-1v-3c0-.55.45-1 1-1h1V8h2v1h2v2zm-2-4V3.5L17.5 8H13z' },
    { key: 'services',     label: 'Services',     href: 'pages/services.html',   icon: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1 .1-1.4z' },
    { key: 'mechanics',    label: 'Mechanics',    href: 'pages/mechanics.html',  icon: 'M12 2L4 6v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V6l-8-4zm0 10.9c-1.6 0-2.9-1.3-2.9-2.9S10.4 7.1 12 7.1s2.9 1.3 2.9 2.9-1.3 2.9-2.9 2.9zm0 2c1.9 0 5.8.9 5.8 2.9v1.3c-1.4 1.9-3.5 3.3-5.8 3.8-2.3-.5-4.4-1.9-5.8-3.8v-1.3c0-2 3.9-2.9 5.8-2.9z' },
    { key: 'inventory',    label: 'Inventory',    href: 'pages/inventory.html',  icon: 'M20 2H4c-1 0-2 .9-2 2v3c0 .7.4 1.4 1 1.7V20c0 1.1 1.1 2 2 2h14c.9 0 2-.9 2-2V8.7c.6-.3 1-1 1-1.7V4c0-1.1-1-2-2-2zm-5 12H9v-2h6v2zm5-7H4V4h16v3z' },
    { key: 'invoices',     label: 'Invoices',     href: 'pages/invoices.html',   icon: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z' },
    { key: 'payments',     label: 'Payments',     href: 'pages/payments.html',   icon: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z' },
    { key: 'expenses',     label: 'Expenses',     href: 'pages/expenses.html',   icon: 'M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.8-1.2-3.4-3.3-3.9V3h-3v2.1c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H8.1c.1 2.3 1.9 3.6 3.9 4v2.1h3v-2.1c1.9-.4 3.5-1.5 3.5-3.7 0-2.8-2.4-3.7-4.7-4.3z' },
    { key: 'reports',      label: 'Reports',      href: 'pages/reports.html',    icon: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z' },
    { key: 'settings',     label: 'Settings',     href: 'pages/settings.html',   icon: 'M19.1 12.9c0-.3.1-.6.1-.9s0-.6-.1-.9l2-1.6c.2-.1.2-.4.1-.6l-1.9-3.3c-.1-.2-.4-.3-.6-.2l-2.4 1c-.5-.4-1-.7-1.6-.9l-.4-2.5c0-.2-.2-.4-.5-.4h-3.8c-.2 0-.4.2-.5.4l-.4 2.5c-.6.2-1.1.6-1.6.9l-2.4-1c-.2-.1-.5 0-.6.2L2.6 9c-.1.2-.1.4.1.6l2 1.6c0 .3-.1.6-.1.9s0 .6.1.9l-2 1.6c-.2.1-.2.4-.1.6l1.9 3.3c.1.2.4.3.6.2l2.4-1c.5.4 1 .7 1.6.9l.4 2.5c0 .2.2.4.5.4h3.8c.2 0 .4-.2.5-.4l.4-2.5c.6-.2 1.1-.6 1.6-.9l2.4 1c.2.1.5 0 .6-.2l1.9-3.3c.1-.2.1-.4-.1-.6l-2-1.6zM12 15.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z' }
  ];

  /* Social Inbox, shown after Inventory: exactly four entries. Facebook is
     connected to the real Page (Messenger, migration 0014) and All
     Conversations lists its conversations; WhatsApp is connected to the
     WhatsApp Business Cloud API (migration 0015); Website Forms receives the
     website's enquiries (migration 0016) (sample data in memory, nothing connected, sent or
     booked). Website
     bookings are listed in Appointments, and Facebook page comments are part
     of the Facebook inbox, so neither has an entry of its own here. Every
     entry is a link; the not-configured rendering below stays for any entry
     added later without an href. */
  const INBOX_AFTER = 'inventory';
  const INBOX_ICON = 'M19 3H4.99C3.88 3 3.01 3.89 3.01 5L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z';
  const CHEVRON_ICON = 'M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z';
  const INBOX = [
    { key: 'inbox-conversations', label: 'All Conversations', href: 'pages/inbox-conversations.html', hint: 'Facebook',
      title: 'Real Facebook Messenger conversations. WhatsApp and Website are not connected yet.', icon: 'M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z' },
    { key: 'inbox-facebook', label: 'Facebook', href: 'pages/inbox-facebook.html', hint: 'Messenger',
      title: 'Real Facebook Messenger conversations with the workshop\'s Page.', icon: 'M24 12.07C24 5.41 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.04V9.41c0-3.02 1.8-4.7 4.54-4.7 1.31 0 2.68.24 2.68.24v2.97h-1.5c-1.5 0-1.96.93-1.96 1.89v2.26h3.32l-.53 3.5h-2.8V24C19.62 23.1 24 18.1 24 12.07z' },
    { key: 'inbox-whatsapp', label: 'WhatsApp', href: 'pages/inbox-whatsapp.html', hint: 'Business',
      title: 'Real WhatsApp Business conversations (Cloud API).', icon: 'M12 2C6.48 2 2 6.03 2 11c0 2.84 1.46 5.36 3.74 7L5 22l4.27-2.18c.87.12 1.79.18 2.73.18 5.52 0 10-4.03 10-9S17.52 2 12 2z' },
    { key: 'inbox-website-forms', label: 'Website Forms', href: 'pages/inbox-website-forms.html', hint: 'Website',
      title: 'Booking, quote and contact enquiries sent from the taqwa.autos website.', icon: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z' },
  ];
  // Whether Social Inbox was left open, so it does not snap shut on every page
  // change (each one is a full document load). Display state only.
  const INBOX_OPEN_KEY = 'taqwa_nav_inbox_open';

  /* Customer CRM, shown after Expenses. UI ONLY for now: each entry opens a
     "Coming soon" page. Nothing is calculated, stored or sent -- reminders and
     follow-ups arrive in a later release. Each page is its own document, so
     its key drives the active state exactly as NAV's keys do. */
  const CRM_AFTER = 'expenses';
  const CRM_ICON = 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z';
  const CRM = [
    { key: 'crm-reminders', label: 'Service Reminders',  href: 'pages/crm-reminders.html', icon: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z' },
    { key: 'crm-follow-up', label: 'Customer Follow-up', href: 'pages/crm-follow-up.html', icon: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z' },
    { key: 'crm-history',   label: 'Service History',    href: 'pages/crm-history.html',   icon: 'M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z' },
    { key: 'crm-tasks',     label: 'Follow-up Tasks',    href: 'pages/crm-tasks.html',     icon: 'M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm-2 14l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z' },
    { key: 'crm-reports',   label: 'CRM Reports',        href: 'pages/crm-reports.html',   icon: 'M7.5 21H2V9h5.5v12zm7.25-18h-5.5v18h5.5V3zM22 11h-5.5v10H22V11z' },
  ];
  // Whether Customer CRM was left open (display state only, like Social Inbox).
  // On a CRM page the group is always open, so the current entry is visible.
  const CRM_OPEN_KEY = 'taqwa_nav_crm_open';

  /* Notifications Center, shown after Customer CRM. The badge is the signed-in
     user's unread count from GET /api/notifications/unread-count: drawn empty
     and hidden, filled once the shell knows the API is live, refreshed every
     minute while the tab is visible, and at once when the Notifications page
     changes it (the 'taqwa:notifications-unread' event). Hidden at 0, and
     never shown without the API -- no number is ever made up. */
  const NOTIFY_ICON = 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z';
  const NOTIFY_POLL_MS = 60000;

  /* Workshop Assets, shown after Customer CRM and before Notifications Center:
     an expandable group drawn like Customer CRM and Staff Management.
     Tools & Equipment (pages/workshop-tools.html) and Equipment Inventory
     (pages/equipment-inventory.html, 0021) are REAL pages on the same register
     (GET /api/tools). The other four are still DEMO pages (fictional sample
     data held in memory, nothing saved or sent) sharing js/workshop-assets-demo.js.
     An entry without an href would be shown as "Coming soon", never as a link. */
  const ASSETS_ICON = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>';
  const ASSETS = [
    { key: 'workshop-tools', label: 'Tools & Equipment', href: 'pages/workshop-tools.html',
      icon: '<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>' },
    { key: 'equipment-inventory', label: 'Equipment Inventory', href: 'pages/equipment-inventory.html',
      icon: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>' },
    { key: 'maintenance-repairs', label: 'Maintenance & Repairs', href: 'pages/maintenance-repairs.html',
      icon: '<path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"/><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"/><path d="M12 2v2"/><path d="M12 22v-2"/><path d="m17 20.66-1-1.73"/><path d="M11 10.27 7 3.34"/><path d="m20.66 17-1.73-1"/><path d="m3.34 7 1.73 1"/><path d="M14 12h8"/><path d="M2 12h2"/><path d="m20.66 7-1.73 1"/><path d="m3.34 17 1.73-1"/><path d="m17 3.34-1 1.73"/><path d="m11 13.73-4 6.93"/>' },
    { key: 'asset-assignment', label: 'Asset Assignment', href: 'pages/asset-assignment.html',
      icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>' },
    { key: 'asset-history', label: 'Asset History', href: 'pages/asset-history.html',
      icon: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>' },
    { key: 'asset-reports', label: 'Asset Reports', href: 'pages/asset-reports.html',
      icon: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>' },
  ];
  // Whether Workshop Assets was left open (display state only, like Customer CRM).
  const ASSETS_OPEN_KEY = 'taqwa_nav_assets_open';

  /* Staff Management, shown after Mechanics. UI PREVIEW ONLY: every page shows
     demo data that is labelled as such; nothing is read from or saved to the
     database, and no account, permission, log, attendance record, leave request
     or performance figure exists behind them yet. Built
     like Customer CRM: each page is its own document, its key drives the
     active state, and the group opens on a Staff page. */
  const STAFF_AFTER = 'mechanics';
  // Outline icons (24-unit strokes), to the approved reference design. Only the Staff group uses
  // them, through staffIcon() below; every other link and group keeps its filled icon.
  const STAFF_ICON = '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>';
  const STAFF_CHEVRON = '<path d="m6 9 6 6 6-6"/>';
  const STAFF = [
    { key: 'staff-management',   label: 'Overview',            href: 'pages/staff-management.html',   icon: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>' },
    { key: 'staff-list',         label: 'Staff List',          href: 'pages/staff-list.html',         icon: '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>' },
    { key: 'staff-add',          label: 'Add Staff',           href: 'pages/staff-add.html',          icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>' },
    { key: 'staff-accounts',     label: 'User Accounts',       href: 'pages/staff-accounts.html',     icon: '<path d="M8 2v2"/><path d="M16 2v2"/><rect width="18" height="18" x="3" y="4" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>' },
    { key: 'staff-roles',        label: 'Roles & Permissions', href: 'pages/staff-roles.html',        icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>' },
    { key: 'staff-attendance',   label: 'Attendance',          href: 'pages/staff-attendance.html',   icon: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>' },
    { key: 'staff-leave',        label: 'Leave Management',    href: 'pages/staff-leave.html',        icon: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>' },
    { key: 'staff-performance',  label: 'Performance',         href: 'pages/staff-performance.html',  icon: '<path d="M4 18v3"/><path d="M8 14v7"/><path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/><path d="m22 3-8.65 8.65a.5.5 0 0 1-.7 0L9.35 8.35a.5.5 0 0 0-.7 0L2 15"/>' },
    { key: 'staff-activity-log', label: 'Activity Log',        href: 'pages/staff-activity-log.html', icon: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>' },
  ];
  /** An outline icon of the Staff group: stroke only, so it follows the text colour. */
  function staffIcon(markup, size) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${markup}</svg>`;
  }
  // Whether Staff Management was left open (display state only, like Customer CRM).
  const STAFF_OPEN_KEY = 'taqwa_nav_staff_open';

  const PAGE_TITLES = {
    dashboard: 'Dashboard', customers: 'Customers', vehicles: 'Vehicles',
    appointments: 'Appointments', 'job-cards': 'Job Cards', estimates: 'Estimates & Quotations', services: 'Service Catalog',
    mechanics: 'Mechanics', inventory: 'Inventory', invoices: 'Invoices',
    payments: 'Payments', expenses: 'Expenses', reports: 'Reports', settings: 'Settings',
    profile: 'Profile',   // design prototype pages
    'account-settings': 'Account Settings',
    'crm-reminders': 'Service Reminders', 'crm-follow-up': 'Customer Follow-up',
    'crm-history': 'Service History', 'crm-tasks': 'Follow-up Tasks', 'crm-reports': 'CRM Reports',
    'staff-management': 'Staff Management', 'staff-list': 'Staff List', 'staff-add': 'Add Staff',
    'staff-accounts': 'User Accounts', 'staff-roles': 'Roles & Permissions', 'staff-attendance': 'Attendance',
    'staff-leave': 'Leave Management', 'staff-performance': 'Performance', 'staff-activity-log': 'Activity Log',
    'workshop-tools': 'Workshop Tools & Equipment',
    'inbox-conversations': 'All Conversations',
    'inbox-whatsapp': 'WhatsApp',
    'inbox-facebook': 'Facebook Messenger',
    'inbox-website-forms': 'Website Forms',
    notifications: 'Notifications Center',
    'offline-sync': 'Offline & Sync',
    'sync-conflicts': 'Conflict Center',
    'equipment-inventory': 'Equipment Inventory', 'maintenance-repairs': 'Maintenance & Repairs',
    'asset-assignment': 'Asset Assignment', 'asset-history': 'Asset History', 'asset-reports': 'Asset Reports'
  };

  function icon(path) {
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;
  }

  /* ---------- layout injection ---------- */

  /**
   * What the footer says about where the data actually is.
   *
   * This exists because the alternative is silence. When no Worker answers,
   * Storage falls back to this browser -- which is the right thing for an
   * app that must keep working offline, and the wrong thing to keep to
   * yourself: someone who believes they are on the shop's database will go
   * on entering records that only ever exist on their own machine.
   */
  /* ---------- signing in ----------

     Shown when the Worker is answering but this browser has no session.
     It is a screen rather than a banner on purpose: there is nothing behind
     it to look at, because nothing has been read.                        */

  const EYE_ICON = 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z';
  const EYE_OFF_ICON = 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z';
  const eyeSvg = d => `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;

  /** A password input with a show / hide button. */
  function passwordField(id, label, placeholder, autocomplete) {
    return `
      <div class="field">
        <label for="${id}">${label}</label>
        <div class="login__pw">
          <input class="input" type="password" id="${id}" placeholder="${placeholder}" autocomplete="${autocomplete}" maxlength="128"
                 aria-describedby="${id}-err">
          <button type="button" class="login__eye" data-eye="${id}" aria-label="Show password" aria-pressed="false">${eyeSvg(EYE_ICON)}</button>
        </div>
        <span class="field__error" id="${id}-err"></span>
      </div>`;
  }
  function bindEyes(root) {
    root.querySelectorAll('[data-eye]').forEach(btn => btn.addEventListener('click', () => {
      const input = root.querySelector(`#${btn.dataset.eye}`);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.innerHTML = eyeSvg(show ? EYE_OFF_ICON : EYE_ICON);
      input.focus();
    }));
  }

  /**
   * The sign-in screen (0019). One field takes a username, an e-mail address
   * or a Staff ID; the server works out which. Every refusal reads the same,
   * because the server does not say which part was wrong. While the shared
   * workshop passphrase is still allowed, it stays reachable as a secondary
   * "legacy" option, so nobody is locked out during the move to personal
   * accounts. Nothing typed is ever kept: the password fields are cleared
   * whether the sign-in worked or not.
   */
  function renderSignIn(canSignIn, accountSignIn = false, sharedPassphrase = true) {
    const root = document.body.dataset.root || '';
    const gate = document.createElement('div');
    gate.className = 'app-gate';
    if (!canSignIn) {
      gate.innerHTML = `
        <div class="login">
          <img class="login__logo" src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile">
          <div class="card app-gate__card"><h1 class="login__title">Taqwa Autos CRM</h1>
            <p class="muted-note">This server is not set up for signing in yet. An administrator needs to configure it.</p></div>
        </div>`;
      document.body.appendChild(gate);
      return;
    }
    const legacyOnly = !accountSignIn;
    gate.innerHTML = `
      <div class="login">
        <img class="login__logo" src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile">
        <form class="card app-gate__card login__card" id="signInForm" novalidate aria-labelledby="loginTitle">
          <div class="login__head">
            <h1 class="login__title" id="loginTitle">Taqwa Autos CRM</h1>
            <p class="login__subtitle">Sign in to your account</p>
          </div>
          <div data-mode="account"${legacyOnly ? ' hidden' : ''}>
            <div class="field">
              <label for="login-id">Username / Email / Staff ID</label>
              <input class="input" type="text" id="login-id" placeholder="Enter username, email or staff ID"
                     autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="160" aria-describedby="login-id-err">
              <span class="field__error" id="login-id-err"></span>
            </div>
            ${passwordField('login-pw', 'Password', 'Enter password', 'current-password')}
          </div>
          <div data-mode="passphrase"${legacyOnly ? '' : ' hidden'}>
            ${passwordField('gate-passphrase', 'Workshop passphrase', 'Enter the shared passphrase', 'current-password')}
          </div>
          <p class="login__error" id="loginError" role="alert"></p>
          <button class="btn btn--primary login__submit" type="submit" data-signin>Login</button>
          <div class="login__links">
            <button type="button" class="login__link" data-forgot aria-expanded="false" aria-controls="forgotPanel">Forgot password?</button>
          </div>
          <div class="login__forgot" id="forgotPanel" hidden>
            <strong>Forgot your password?</strong>
            <p>Ask a workshop administrator to reset it. They set a temporary password, and you choose your own the next time you sign in &mdash; nobody else ever knows it.</p>
            <p class="login__fine">Reset by e-mail is not available: the system has no verified e-mail delivery service connected.</p>
          </div>
          ${accountSignIn && sharedPassphrase ? `<button class="login__legacy" type="button" data-switch aria-pressed="false">Use the shared workshop passphrase (legacy)</button>` : ''}
        </form>
      </div>`;
    document.body.appendChild(gate);

    const form = gate.querySelector('#signInForm');
    const idInput = gate.querySelector('#login-id');
    const pwInput = gate.querySelector('#login-pw');
    const phrase = gate.querySelector('#gate-passphrase');
    const button = gate.querySelector('[data-signin]');
    const error = gate.querySelector('#loginError');
    const switcher = gate.querySelector('[data-switch]');
    let useAccount = !legacyOnly;
    bindEyes(gate);
    (useAccount ? idInput : phrase).focus();

    const setErr = (id, text) => { const el = gate.querySelector(`#${id}-err`); if (el) el.textContent = text || ''; };
    const clearErrors = () => { ['login-id', 'login-pw', 'gate-passphrase'].forEach(id => setErr(id, '')); error.textContent = ''; };

    gate.querySelector('[data-forgot]').addEventListener('click', e => {
      const panel = gate.querySelector('#forgotPanel');
      panel.hidden = !panel.hidden;
      e.currentTarget.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    });
    if (switcher) {
      switcher.addEventListener('click', () => {
        useAccount = !useAccount;
        gate.querySelector('[data-mode="passphrase"]').hidden = useAccount;
        gate.querySelector('[data-mode="account"]').hidden = !useAccount;
        switcher.textContent = useAccount ? 'Use the shared workshop passphrase (legacy)' : 'Sign in with my own account';
        switcher.setAttribute('aria-pressed', useAccount ? 'false' : 'true');
        // Nothing typed for one way in is kept when switching to the other.
        idInput.value = ''; pwInput.value = ''; phrase.value = '';
        clearErrors();
        (useAccount ? idInput : phrase).focus();
      });
    }

    let busy = false;
    const setBusy = on => {
      busy = on;
      button.disabled = on;
      button.textContent = on ? 'Signing in…' : 'Login';
      form.setAttribute('aria-busy', on ? 'true' : 'false');
    };

    // preventDefault() runs at once, before any await, so the browser never
    // submits the form itself; Enter in any field submits the same way.
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (busy) return;
      clearErrors();
      if (useAccount) {
        const id = idInput.value.trim();
        const pw = pwInput.value;
        if (!id) setErr('login-id', 'Enter your username, email or staff ID.');
        if (!pw) setErr('login-pw', 'Enter your password.');
        if (!id || !pw) { (!id ? idInput : pwInput).focus(); return; }
        setBusy(true);
        let res;
        try { res = await Storage.signInWithIdentifier(id, pw); }
        catch (e) { res = { ok: false, message: 'Signing in is not possible right now. Please try again in a moment.' }; }
        pwInput.value = '';
        if (!res.ok) {
          setBusy(false);
          error.textContent = res.code === 'hydrate_failed'
            ? 'You are signed in, but the workshop data could not be loaded. Please reload the page.'
            : (res.message || 'The sign-in details are not correct. Check them and try again.');
          pwInput.focus();
          return;
        }
        // To the dashboard -- or, for a password someone else set, to choosing a new one first.
        if (res.passwordChange) { location.reload(); return; }
        // Let this person open a read-only copy on this computer when it is offline
        // (js/offline.js). The password is used to protect that copy, then dropped.
        await Storage.enrollOffline(pw, id);
        location.href = `${root}index.html`;
        return;
      }
      if (!phrase.value) { setErr('gate-passphrase', 'Enter the passphrase.'); phrase.focus(); return; }
      setBusy(true);
      const res = await Storage.signIn(phrase.value);
      // The passphrase is never held anywhere, including here.
      phrase.value = '';
      if (!res.ok) {
        setBusy(false);
        error.textContent = res.message || 'That passphrase was not accepted.';
        phrase.focus();
        return;
      }
      location.href = `${root}index.html`;
    });
  }

  /**
   * Offline (Phase 1): the server cannot be reached. Someone who signed in on
   * this computer while online can open the read-only copy saved here, with
   * the same identifier and password. Nothing typed is kept.
   */
  function renderOfflineUnlock(hydration) {
    const root = document.body.dataset.root || '';
    const gate = document.createElement('div');
    gate.className = 'app-gate';
    const copies = hydration && hydration.hasCopies;
    gate.innerHTML = `
      <div class="login">
        <img class="login__logo" src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile">
        <form class="card app-gate__card login__card" id="offlineForm" novalidate aria-labelledby="offTitle">
          <div class="login__head">
            <span class="badge badge--warn login__badge">No internet</span>
            <h1 class="login__title" id="offTitle">Taqwa Autos CRM</h1>
            ${hydration && hydration.storage ? `<p class="login__error" role="alert">${Utils.esc(hydration.storage.message)}</p>` : ''}
            <p class="login__subtitle">${copies
              ? 'The server cannot be reached. Sign in with your own password to keep working offline: your changes are kept on this computer, encrypted, and sent to the server when the internet is back (payments as <strong>pending</strong>, invoices as <strong>drafts</strong>).'
              : 'The server cannot be reached, and this computer has no saved offline copy yet. Connect to the internet and sign in once; after that, you can work offline here for up to 14 days.'}</p>
          </div>
          ${copies ? `
          <div class="field">
            <label for="off-id">Username / Email / Staff ID</label>
            <input class="input" type="text" id="off-id" placeholder="Enter username, email or staff ID" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="160" aria-describedby="off-id-err">
            <span class="field__error" id="off-id-err"></span>
          </div>
          ${passwordField('off-pw', 'Password', 'Enter password', 'current-password')}
          <p class="login__error" id="offError" role="alert"></p>
          <button class="btn btn--primary login__submit" type="submit" data-open>Open offline copy</button>` : ''}
          <button class="btn btn--ghost login__submit" type="button" data-retry>Try the internet again</button>
        </form>
      </div>`;
    document.body.appendChild(gate);
    bindEyes(gate);
    gate.querySelector('[data-retry]').addEventListener('click', () => location.reload());
    if (!copies) return;
    const form = gate.querySelector('#offlineForm');
    const idIn = gate.querySelector('#off-id'), pwIn = gate.querySelector('#off-pw');
    const btn = gate.querySelector('[data-open]'), error = gate.querySelector('#offError');
    idIn.focus();
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      gate.querySelector('#off-id-err').textContent = ''; gate.querySelector('#off-pw-err').textContent = ''; error.textContent = '';
      const id = idIn.value.trim(), pw = pwIn.value;
      if (!id) { gate.querySelector('#off-id-err').textContent = 'Enter your username, email or staff ID.'; idIn.focus(); return; }
      if (!pw) { gate.querySelector('#off-pw-err').textContent = 'Enter your password.'; pwIn.focus(); return; }
      btn.disabled = true; btn.textContent = 'Opening…';
      const res = await Storage.unlockOffline(id, pw);
      pwIn.value = '';
      if (!res.ok) { btn.disabled = false; btn.textContent = 'Open offline copy'; error.textContent = res.message; pwIn.focus(); return; }
      location.reload();
    });
  }

  /** Offline: a bar saying so, and -- once the server answers again -- an offer to go back online. */
  function showOfflineBar() {
    const content = document.getElementById('content') || document.querySelector('main');
    if (!content || document.getElementById('offlineBar')) return;
    const bar = document.createElement('div');
    bar.id = 'offlineBar';
    bar.className = 'offline-bar';
    bar.setAttribute('role', 'status');
    const at = Storage.offlineSavedAt ? new Date(Storage.offlineSavedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const writable = Storage.offlineWritable && Storage.offlineWritable();
    const waiting = () => {
      const c = typeof Sync !== 'undefined' && Sync.isOpen() ? Sync.counts() : null;
      return c ? c.pending + c.conflict + c.failed : 0;
    };
    const draw = () => {
      if (bar.dataset.back) return;
      const n = waiting();
      bar.innerHTML = writable
        ? `<strong>Offline.</strong> Working from the copy saved on this computer${at ? ` (${Utils.esc(at)})` : ''}. Changes are kept here and sent when the internet is back. <span class="offline-bar__count" id="offlineWaiting">${n} change${n === 1 ? '' : 's'} waiting</span>${n && !persisted ? ' <span class="offline-bar__warn" id="offlinePersistWarn">· This browser has not promised to keep them: do not clear site data, and sync as soon as you can.</span>' : ''} · <a href="${document.body.dataset.root || ''}pages/offline-sync.html">Offline &amp; Sync</a>`
        : `<strong>Offline.</strong> You are viewing a read-only copy saved on this computer${at ? ` (${Utils.esc(at)})` : ''}. Nothing can be changed until the internet is back.`;
    };
    let persisted = true;
    draw();
    content.prepend(bar);
    if (typeof Sync !== 'undefined') Sync.on(draw);
    if (typeof Offline !== 'undefined') Offline.persistence().then(p => { persisted = !!(p && p.persisted); draw(); }).catch(() => {});
    const back = async () => {
      if (bar.dataset.back) return;
      const probe = await Api.probe({ timeoutMs: 4000 });
      if (!probe.ok) return;
      bar.dataset.back = '1';
      bar.classList.add('offline-bar--back');
      const n = waiting();
      bar.innerHTML = `<strong>The internet is back.</strong> ${n ? `${n} change${n === 1 ? '' : 's'} made offline will be sent to the server.` : 'Go online to see the latest records.'} <button type="button" class="btn btn--primary btn--sm" data-online>Go online</button>`;
      // The journal's key stays with the tab, so the changes are sent as soon as the page is online.
      bar.querySelector('[data-online]').addEventListener('click', () => { Storage.lockOffline({ keepJournal: true }); location.reload(); });
    };
    window.addEventListener('online', back);
    if (typeof setInterval === 'function') setInterval(back, 30000);
  }

  /**
   * Choosing a new password (0019): shown after signing in with a password
   * someone else set -- a new account, or an administrator's reset. Nothing
   * else works until it is done, on the server as well as here.
   */
  function renderPasswordChange() {
    const root = document.body.dataset.root || '';
    const me = Storage.account || {};
    const gate = document.createElement('div');
    gate.className = 'app-gate';
    gate.innerHTML = `
      <div class="login">
        <img class="login__logo" src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile">
        <form class="card app-gate__card login__card" id="pwChangeForm" novalidate aria-labelledby="pwTitle">
          <div class="login__head">
            <h1 class="login__title" id="pwTitle">Choose your own password</h1>
            <p class="login__subtitle">${Utils.esc(me.name || me.username || 'Your account')}: your password was set by an administrator. Choose a new one that only you know to continue.</p>
          </div>
          ${passwordField('pw-current', 'Current (temporary) password', 'Enter the password you signed in with', 'current-password')}
          ${passwordField('pw-new', 'New password', 'At least 10 characters', 'new-password')}
          ${passwordField('pw-repeat', 'Repeat new password', 'Type the new password again', 'new-password')}
          <p class="login__error" id="pwError" role="alert"></p>
          <button class="btn btn--primary login__submit" type="submit" data-save>Save password</button>
          <div class="login__links"><button type="button" class="login__link" data-out>Sign out</button></div>
        </form>
      </div>`;
    document.body.appendChild(gate);
    bindEyes(gate);
    const form = gate.querySelector('#pwChangeForm');
    const cur = gate.querySelector('#pw-current'), nw = gate.querySelector('#pw-new'), rep = gate.querySelector('#pw-repeat');
    const btn = gate.querySelector('[data-save]'), error = gate.querySelector('#pwError');
    const setErr = (id, t) => { gate.querySelector(`#${id}-err`).textContent = t || ''; };
    cur.focus();
    gate.querySelector('[data-out]').addEventListener('click', async () => { await Storage.signOut(); location.reload(); });
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      if (btn.disabled) return;
      ['pw-current', 'pw-new', 'pw-repeat'].forEach(id => setErr(id, '')); error.textContent = '';
      if (!cur.value) { setErr('pw-current', 'Enter the password you signed in with.'); cur.focus(); return; }
      if (nw.value.length < 10) { setErr('pw-new', 'Use at least 10 characters.'); nw.focus(); return; }
      if (nw.value !== rep.value) { setErr('pw-repeat', 'The two new passwords do not match.'); rep.focus(); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      const chosen = nw.value;
      const previous = cur.value;
      const res = await Api.changePassword(previous, chosen);
      cur.value = ''; nw.value = ''; rep.value = '';
      // The previous password re-wraps any unsynced offline work for the new one (kept in memory only here).
      if (res.ok) await Storage.enrollOffline(chosen, undefined, { oldPassword: previous });
      if (!res.ok) {
        btn.disabled = false; btn.textContent = 'Save password';
        const f = res.fields || {};
        if (f.currentPassword) setErr('pw-current', f.currentPassword);
        if (f.newPassword) setErr('pw-new', f.newPassword);
        if (!f.currentPassword && !f.newPassword) error.textContent = res.status === 429 ? (res.message || 'Too many attempts. Please wait and try again.') : 'The password could not be changed. Please try again.';
        cur.focus();
        return;
      }
      location.href = `${root}index.html`;
    });
  }

  /* What the footer said on the previous page of this tab. Every page change is
     a full document load, so without this the indicator would read
     "Connecting…" and then flip back on every click. It is a display hint
     only -- nothing is decided by it -- and completeShell() corrects it as
     soon as this page's own hydration has settled. */
  const LAST_SOURCE_KEY = 'taqwa_shell_source';

  function lastSource() {
    try { return sessionStorage.getItem(LAST_SOURCE_KEY); } catch (e) { return null; }
  }

  function rememberSource() {
    const kind = Storage.isLocked() ? 'locked' : Storage.isApi() ? 'api' : Storage.isOffline && Storage.isOffline() ? 'offline' : 'local';
    try { sessionStorage.setItem(LAST_SOURCE_KEY, kind); } catch (e) { /* private mode: no hint */ }
  }

  function dataSource(pending) {
    // Drawn before the data source is known (see drawShellEarly). Repeat what
    // this tab last knew, so the footer holds still across a page change; on
    // a first page, say it is connecting rather than claim "This browser only".
    if (pending) {
      if (lastSource() === 'api') return sourceFor('api');
      return { offline: false, pending: true, label: 'Connecting…',
               title: 'Loading the workshop records.' };
    }
    return sourceFor(Storage.isLocked() ? 'locked' : Storage.isApi() ? 'api' : Storage.isOffline && Storage.isOffline() ? 'offline' : 'local');
  }

  function sourceFor(kind) {
    if (kind === 'offline') {
      const at = Storage.offlineSavedAt ? new Date(Storage.offlineSavedAt) : null;
      const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'earlier';
      if (Storage.offlineWritable && Storage.offlineWritable()) {
        return { offline: true, label: 'Offline — changes kept here',
                 title: `No internet. Working from the copy saved on this computer (${when}). Changes are kept here and sent when the internet is back.` };
      }
      return { offline: true, label: 'Offline — read-only copy',
               title: `No internet. Showing the copy saved on this computer (${when}). Nothing can be changed until the internet is back.` };
    }
    if (kind === 'locked') {
      return { offline: true, label: 'Signed out',
               title: 'Sign in to read or change the workshop records.' };
    }
    if (kind === 'api') {
      return { offline: false, label: 'Connected to the database',
               title: 'Records are read from and saved to the shared database.' };
    }
    return { offline: true, label: 'This browser only',
             title: 'No server is answering, so records are kept in this browser '
                  + 'and are not saved to the shared database.' };
  }

  function footDotClass(source) {
    return 'sidebar__foot-dot'
      + (source.pending ? ' sidebar__foot-dot--pending' : source.offline ? ' sidebar__foot-dot--local' : '');
  }

  // Placeholder blocks for the content area while an early shell waits on its
  // data. Neutral shapes only -- no invented rows, names or figures -- and
  // hidden from assistive tech, which hears the loader's status instead.
  const CONTENT_SKELETON = `
          <div class="content-skeleton" aria-hidden="true">
            <div class="content-skeleton__toolbar"><span></span><span></span><span></span></div>
            <div class="content-skeleton__card">${'<span></span>'.repeat(6)}</div>
          </div>`;

  // In an early shell, draw the sign-out button wherever a session is likely
  // (a backend is configured and this tab was not last offline or signed
  // out), so the header's buttons do not shift when it would otherwise appear
  // after the data. completeShell() removes it if this load ends up local.
  function earlySignOut() {
    return !!Api.baseUrl && !['local', 'locked'].includes(lastSource());
  }

  const SIGN_OUT_BUTTON = `
            <button class="icon-btn" id="signOutBtn" aria-label="Sign out" title="Sign out">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M10 17l1.4-1.4-2.6-2.6H17v-2H8.8l2.6-2.6L10 7l-5 5 5 5zm9-14H5c-1.1 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>
            </button>`;

  /* Admin profile menu. Profile and Account Settings open their pages
     (pages/profile.html, pages/account-settings.html); Sign Out does exactly
     what the #signOutBtn above does (signOutNow). */
  const PROFILE_ITEM_ICONS = {
    profile: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    signout: 'M10 17l1.4-1.4-2.6-2.6H17v-2H8.8l2.6-2.6L10 7l-5 5 5 5zm9-14H5c-1.1 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z'
  };
  const profileItem = (key, label, extra = '', href = '', attrs = '') => `
              <button type="button" class="profile-menu__item${extra}" role="menuitem" tabindex="-1" data-preview-item="${label}"${href ? ` data-preview-href="${href}"` : ''}${attrs}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${PROFILE_ITEM_ICONS[key]}"/></svg>
                <span>${label}</span>
              </button>`;
  const PROFILE_MENU = `
            <div class="profile-menu" id="profileMenu" role="menu" aria-labelledby="profileMenuBtn" hidden>
              ${profileItem('profile', 'Profile', '', 'pages/profile.html')}
              ${profileItem('settings', 'Account Settings', '', 'pages/account-settings.html')}
              <div class="profile-menu__sep" role="separator"></div>
              ${profileItem('signout', 'Sign Out', ' profile-menu__item--danger', '', ' data-signout')}
            </div>`;

  /**
   * `pending` draws the shell before the data has arrived: the parts that
   * depend on the source (the footer, the sign-out button, the business
   * name) are filled in by completeShell() once it is known, and the page's
   * own content stays hidden until its module has rendered it.
   */
  function renderShell(pending = false) {
    const body = document.body;
    const page = body.dataset.page || 'dashboard';
    const root = body.dataset.root || '';
    const settings = Storage.getSettings();
    const source = dataSource(pending);

    const linkHtml = item => {
      const active = item.key === page ? ' is-active' : '';
      const href = item.key === 'dashboard' ? `${root}index.html` : `${root}${item.href}`;
      return `<a class="nav__link${active}" href="${href}">${icon(item.icon)}<span>${item.label}</span></a>`;
    };
    const inboxHtml = () => {
      const here = INBOX.some(s => s.key && s.key === page);
      let open = here;
      if (!here) { try { open = sessionStorage.getItem(INBOX_OPEN_KEY) === '1'; } catch (e) { /* no hint */ } }
      const subs = INBOX.map(s => s.href
        ? `<a class="nav__sub${s.key && s.key === page ? ' is-active' : ''}" href="${root}${s.href}" title="${Utils.esc(s.title)}"${s.key && s.key === page ? ' aria-current="page"' : ''}>${icon(s.icon)}<span class="nav__sub-text"><span>${s.label}</span><small>${s.hint}</small></span></a>`
        : `<span class="nav__sub nav__sub--off" aria-disabled="true" title="${s.label} is not configured yet.">${icon(s.icon)}<span class="nav__sub-text"><span>${s.label}</span><small>Not configured</small></span></span>`
      ).join('');
      return `<details class="nav__inbox" id="navInbox"${open ? ' open' : ''}>
            <summary class="nav__summary">${icon(INBOX_ICON)}<span>Social Inbox</span>
              <svg class="nav__chevron" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${CHEVRON_ICON}"/></svg></summary>
            <div class="nav__subs">${subs}</div>
          </details>`;
    };
    const crmHtml = () => {
      const here = CRM.some(s => s.key === page);
      let open = here;
      if (!here) { try { open = sessionStorage.getItem(CRM_OPEN_KEY) === '1'; } catch (e) { /* no hint */ } }
      const subs = CRM.map(s => {
        const active = s.key === page;
        return `<a class="nav__sub${active ? ' is-active' : ''}" href="${root}${s.href}"${active ? ' aria-current="page"' : ''}>${icon(s.icon)}<span>${s.label}</span></a>`;
      }).join('');
      return `<details class="nav__group${here ? ' has-active' : ''}" id="navCrm"${open ? ' open' : ''}>
            <summary class="nav__summary">${icon(CRM_ICON)}<span>Customer CRM</span>
              <svg class="nav__chevron" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${CHEVRON_ICON}"/></svg></summary>
            <div class="nav__subs">${subs}</div>
          </details>`;
    };
    const staffHtml = () => {
      const here = STAFF.some(s => s.key === page);
      let open = here;
      if (!here) { try { open = sessionStorage.getItem(STAFF_OPEN_KEY) === '1'; } catch (e) { /* no hint */ } }
      const subs = STAFF.map(s => {
        const active = s.key === page;
        return `<a class="nav__sub${active ? ' is-active' : ''}" href="${root}${s.href}"${active ? ' aria-current="page"' : ''}>${staffIcon(s.icon, 16)}<span>${s.label}</span></a>`;
      }).join('');
      return `<details class="nav__group${here ? ' has-active' : ''}" id="navStaff"${open ? ' open' : ''}>
            <summary class="nav__summary">${staffIcon(STAFF_ICON, 20)}<span>Staff Management</span>
              ${staffIcon(STAFF_CHEVRON, 16).replace('<svg ', '<svg class="nav__chevron" ')}</summary>
            <div class="nav__subs">${subs}</div>
          </details>`;
    };
    const assetsHtml = () => {
      const here = ASSETS.some(s => s.key && s.key === page);
      let open = here;
      if (!here) { try { open = sessionStorage.getItem(ASSETS_OPEN_KEY) === '1'; } catch (e) { /* no hint */ } }
      const subs = ASSETS.map(s => {
        if (!s.href) {
          return `<span class="nav__sub nav__sub--off" aria-disabled="true" title="${s.label} is coming soon.">${staffIcon(s.icon, 16)}<span class="nav__sub-text"><span>${s.label}</span><small>Coming soon</small></span></span>`;
        }
        const active = s.key === page;
        return `<a class="nav__sub${active ? ' is-active' : ''}" href="${root}${s.href}"${active ? ' aria-current="page"' : ''}>${staffIcon(s.icon, 16)}<span>${s.label}</span></a>`;
      }).join('');
      return `<details class="nav__group${here ? ' has-active' : ''}" id="navAssets"${open ? ' open' : ''}>
            <summary class="nav__summary">${staffIcon(ASSETS_ICON, 20)}<span>Workshop Assets</span>
              <svg class="nav__chevron" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="${CHEVRON_ICON}"/></svg></summary>
            <div class="nav__subs">${subs}</div>
          </details>`;
    };
    const notifyHtml = () => {
      const active = page === 'notifications';
      return `<a class="nav__link nav__notify${active ? ' is-active' : ''}" id="navNotify" href="${root}pages/notifications.html"${active ? ' aria-current="page"' : ''}>${icon(NOTIFY_ICON)}<span>Notifications Center</span><span class="nav__count" id="navNotifyCount" hidden></span></a>`;
    };
    const navHtml = NAV.map(item => linkHtml(item)
      + (item.key === STAFF_AFTER ? staffHtml() : '')
      + (item.key === INBOX_AFTER ? inboxHtml() : '')
      + (item.key === CRM_AFTER ? crmHtml() + assetsHtml() + notifyHtml() : '')).join('');

    const shell = document.createElement('div');
    shell.className = pending ? 'shell is-pending' : 'shell';
    shell.innerHTML = `
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__brand">
          <img class="brand-logo" src="${root}assets/logo/logo-white.png" alt="Taqwa Automobile"
               width="1555" height="593">
          <span class="brand-tag">Service Center Management</span>
        </div>
        <nav class="nav" aria-label="Main navigation">${navHtml}</nav>
        <div class="sidebar__foot" id="dataSource" title="${Utils.esc(source.title)}">
          <span class="${footDotClass(source)}"></span>
          ${Utils.esc(source.label)}
        </div>
      </aside>
      <div class="sidebar-scrim" id="sidebarScrim" hidden></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn topbar__menu" id="menuToggle" aria-label="Open menu" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z"/></svg>
          </button>
          <div class="topbar__title">
            <h1>${PAGE_TITLES[page] || 'Dashboard'}</h1>
            <span class="topbar__date" id="topbarDate"></span>
          </div>
          <div class="topbar__actions">
            <button class="icon-btn" id="themeToggle" aria-label="Toggle dark mode" title="Toggle dark mode">
              <svg class="ico-sun" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0-5h0v3h0zm0 17v3zm10-7h-3zM5 12H2zm14.1-7.1l-2.1 2.1zM7 17l-2.1 2.1zm12.1 2.1L17 17zM7 7L4.9 4.9z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              <svg class="ico-moon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12.3 2c-5.6 0-10 4.5-10 10s4.4 10 10 10c3.9 0 7.3-2.3 9-5.6-8 1.9-13.9-6.4-9-14.4z"/></svg>
            </button>
            ${(pending ? earlySignOut() : Storage.isApi()) ? SIGN_OUT_BUTTON : ''}
            <button type="button" class="topbar__user" id="profileMenuBtn"
                    aria-haspopup="menu" aria-expanded="false" aria-controls="profileMenu">
              <img class="avatar" src="${root}assets/avatar/admin.webp"
                   alt="Admin profile photo" width="36" height="36">
              <span class="topbar__user-text">
                <strong data-who-name>${Utils.esc(whoName())}</strong>
                <span data-who-role>${Utils.esc(whoRole(settings))}</span>
              </span>
              <svg class="topbar__chevron" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="${CHEVRON_ICON}"/></svg>
            </button>
            ${PROFILE_MENU}
          </div>
        </header>
        <main class="content" id="content">${pending ? CONTENT_SKELETON : ''}</main>
      </div>`;

    // Move existing page content into the content area
    const pageContent = document.getElementById('page-content');
    body.prepend(shell);
    const host = shell.querySelector('#content');
    if (pageContent && host) host.appendChild(pageContent);

    // Date in header
    document.getElementById('topbarDate').textContent =
      new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    bindShellEvents();
  }

  /* ---------- theme ---------- */

  function applyTheme(theme) {
    // 'system' resolves to the OS preference for the actual applied
    // data-theme attribute, but the user's chosen preference (which may be
    // 'system' itself) is what gets persisted -- so returning here later
    // still remembers "follow system" rather than freezing whatever it
    // resolved to at the time.
    const resolved = theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.dataset.theme = resolved;
    Storage.saveTheme(theme);
  }

  /* ---------- events ---------- */

  function bindShellEvents() {
    const sidebar = document.getElementById('sidebar');
    const scrim = document.getElementById('sidebarScrim');
    const menuBtn = document.getElementById('menuToggle');

    function setMenu(open) {
      sidebar.classList.toggle('is-open', open);
      scrim.hidden = !open;
      menuBtn.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('no-scroll', open);
    }

    menuBtn.addEventListener('click', () => setMenu(!sidebar.classList.contains('is-open')));
    scrim.addEventListener('click', () => setMenu(false));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

    document.getElementById('themeToggle').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });

    const inbox = document.getElementById('navInbox');
    if (inbox) {
      inbox.addEventListener('toggle', () => {
        try { sessionStorage.setItem(INBOX_OPEN_KEY, inbox.open ? '1' : '0'); } catch (e) { /* private mode */ }
      });
    }
    const crm = document.getElementById('navCrm');
    if (crm) {
      crm.addEventListener('toggle', () => {
        try { sessionStorage.setItem(CRM_OPEN_KEY, crm.open ? '1' : '0'); } catch (e) { /* private mode */ }
      });
    }
    const assets = document.getElementById('navAssets');
    if (assets) {
      assets.addEventListener('toggle', () => {
        try { sessionStorage.setItem(ASSETS_OPEN_KEY, assets.open ? '1' : '0'); } catch (e) { /* private mode */ }
      });
    }
    const staff = document.getElementById('navStaff');
    if (staff) {
      staff.addEventListener('toggle', () => {
        try { sessionStorage.setItem(STAFF_OPEN_KEY, staff.open ? '1' : '0'); } catch (e) { /* private mode */ }
      });
    }

    bindProfileMenu();
    bindSignOut();
  }

  /* Open/close and keyboard support for the profile menu. Profile and
     Account Settings navigate to their pages; Sign Out runs signOutNow(). */
  function bindProfileMenu() {
    const btn = document.getElementById('profileMenuBtn');
    const menu = document.getElementById('profileMenu');
    if (!btn || !menu) return;
    const items = () => [...menu.querySelectorAll('[role="menuitem"]')];
    const isOpen = () => !menu.hidden;

    function setOpen(open, focusFirst = false) {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.classList.toggle('is-open', open);
      if (open && focusFirst) items()[0].focus();
    }
    function close(returnFocus) {
      if (!isOpen()) return;
      setOpen(false);
      if (returnFocus) btn.focus();
    }

    btn.addEventListener('click', () => setOpen(!isOpen()));
    btn.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true, true); }
      else if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(true); }
    });
    menu.addEventListener('keydown', e => {
      const list = items(); const i = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    menu.addEventListener('click', e => {
      const item = e.target.closest('[data-preview-item]');
      if (!item) return;
      close(true);
      if (item.dataset.previewHref) { location.href = (document.body.dataset.root || '') + item.dataset.previewHref; return; }
      if ('signout' in item.dataset) signOutNow();
    });
    document.addEventListener('click', e => {
      if (isOpen() && !menu.contains(e.target) && !btn.contains(e.target)) close(false);
    });
  }

  function bindSignOut() {
    const signOut = document.getElementById('signOutBtn');
    if (signOut) signOut.addEventListener('click', () => signOutNow());
  }

  /**
   * End the session -- the header button and the profile menu's Sign Out
   * both come here.
   *
   * Storage.signOut() reports success only once the server confirms the
   * session is gone. Then a full reload is the honest way to finish: it
   * throws away every rendered row along with the cache, so the next person
   * at this screen cannot read the last one's customers out of the DOM, and
   * the page comes back as the sign-in screen. Anything short of that
   * leaves the page as it was and says so: the session is still live.
   *
   * Not Utils.saving(): it would swap the icon button's SVG for "Saving…"
   * text and, on a failure, never put it back.
   */
  let signingOut = false;

  async function signOutNow() {
    if (signingOut) return;
    // Offline: close the saved copy in this tab (there is no server session to end).
    if (Storage.isOffline && Storage.isOffline()) { Storage.lockOffline(); location.reload(); return; }
    // No server configured at all (a page opened from disk, the static demo):
    // there was never a session. Anything else asks the server, including a
    // press while the page is still loading and the mode is not settled yet.
    if (!Api.baseUrl) {
      Utils.toast('This browser is not connected to the workshop server, so there is no session to sign out of.', 'info');
      return;
    }
    signingOut = true;
    const btn = document.getElementById('signOutBtn');
    const hadFocus = !!btn && document.activeElement === btn;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }

    let res = null;
    try {
      res = await Storage.signOut();
    } catch (e) {
      console.error('Sign-out failed:', e);
    }
    if (res && res.ok) {
      rememberSource();        // 'locked', so the reloading shell does not claim a connection
      location.reload();
      return;                  // the button stays disabled until the page is gone
    }

    signingOut = false;
    if (btn) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (hadFocus) btn.focus();
    }
    const why = res && res.message ? ` ${res.message}` : '';
    Utils.toast(`Sign-out failed: you are still signed in.${why}`, 'error');
  }

  /* ---------- back/forward cache ----------

     A page left by navigation can be kept whole in the browser's back/forward
     cache and shown again by Back, rendered rows and all, without running a
     line of script -- after a sign-out on another page, too. A page holding
     workshop data is blanked as it goes in and reloaded if it ever comes
     back out, so what Back shows is decided by a fresh hydrate(): the
     records again if the session is still live, the sign-in screen if not. */
  let blankedForCache = false;

  window.addEventListener('pagehide', (e) => {
    if (!e || !e.persisted || !Storage.isApi() || !document.body) return;
    document.body.style.display = 'none';
    blankedForCache = true;
  });
  window.addEventListener('pageshow', (e) => {
    if (e && e.persisted && blankedForCache) location.reload();
  });

  /* ---------- init ---------- */

  /**
   * Warn only when a backend was there to be reached and was not.
   *
   * `no_api` means there was never a server to call -- a page opened from
   * disk, or the static demo -- which is the app working as designed and
   * not worth interrupting anyone over. Any other reason means a Worker was
   * addressable and did not answer, and the user is now about to type into
   * a copy nobody else will ever see.
   */
  function warnIfBackendExpected(result) {
    if (!result || result.mode !== 'local') return;
    if (result.reason === 'no_api') return;
    Utils.toast('The server did not answer, so this session is using this browser only. '
              + 'Anything you enter will not reach the shared database.', 'warning');
  }

  /* ---------- Roles & Permissions (0018): what this role may open ----------
     Every page and the permission it needs to be opened. The server checks
     every request itself (src/lib/permissions.js), so a page opened anyway
     would load nothing; this keeps the sidebar to what works and puts a plain
     "no access" in place of a page opened by its address. A page missing here
     needs nothing beyond being signed in (Profile, Account Settings). */
  const PAGE_PERMISSIONS = {
    dashboard: 'dashboard.view', customers: 'customers.view', vehicles: 'vehicles.view', appointments: 'appointments.view',
    'job-cards': 'job_cards.view', estimates: 'estimates.view', 'estimate-create': 'estimates.create', 'estimate-details': 'estimates.view',
    services: 'services.view', mechanics: 'mechanics.view', inventory: 'inventory.view', invoices: 'invoices.view',
    payments: 'payments.view', expenses: 'expenses.view', reports: 'reports.view', settings: 'settings.view',
    'crm-reminders': 'crm.view', 'crm-follow-up': 'crm.view', 'crm-history': 'crm.view', 'crm-tasks': 'crm.view', 'crm-reports': 'crm.view',
    'staff-management': 'staff.view', 'staff-list': 'staff.view', 'staff-add': 'staff.create', 'staff-performance': 'staff.view',
    'staff-accounts': 'users.view', 'staff-roles': 'roles.view', 'staff-attendance': 'attendance.view', 'staff-leave': 'leave.view',
    'staff-activity-log': 'activity_log.view',
    'inbox-conversations': 'inbox.view', 'inbox-facebook': 'inbox.view', 'inbox-whatsapp': 'inbox.view', 'inbox-website-forms': 'inbox.view',
    'workshop-tools': 'tools.view', 'equipment-inventory': 'tools.view', 'maintenance-repairs': 'tools.view',
    'asset-assignment': 'tools.view', 'asset-history': 'tools.view', 'asset-reports': 'tools.view',
    notifications: 'notifications.view',
  };
  /**
   * The modules that do NOT work offline (M10): their records are read on
   * demand and are not in the offline copy, and nothing can be saved for them
   * on this computer. Offline, the sidebar marks them and their pages say so.
   * (Accounts, roles and settings are online-only by design: under Staff and Settings.)
   */
  const ONLINE_ONLY = {
    estimates: 'Estimates', 'estimate-create': 'Estimates', 'estimate-details': 'Estimates',
    'staff-attendance': 'Attendance',
    // Equipment Inventory (0021) is not listed: offline it says so itself and still lets equipment be added (queued).
    'workshop-tools': 'Workshop Assets', 'maintenance-repairs': 'Workshop Assets',
    'asset-assignment': 'Workshop Assets', 'asset-history': 'Workshop Assets', 'asset-reports': 'Workshop Assets',
    notifications: 'Notifications',
    'staff-management': 'Staff', 'staff-list': 'Staff', 'staff-add': 'Staff', 'staff-performance': 'Staff',
    'staff-accounts': 'Staff', 'staff-roles': 'Staff', 'staff-leave': 'Staff', 'staff-activity-log': 'Staff',
    'crm-reminders': 'CRM', 'crm-follow-up': 'CRM', 'crm-history': 'CRM', 'crm-tasks': 'CRM', 'crm-reports': 'CRM',
    'inbox-conversations': 'Inbox', 'inbox-facebook': 'Inbox', 'inbox-whatsapp': 'Inbox', 'inbox-website-forms': 'Inbox',
    settings: 'Settings',
  };
  const ONLINE_ONLY_MODULES = ['Estimates', 'Attendance', 'Workshop Assets', 'Notifications', 'Staff', 'CRM', 'Inbox'];

  /** Offline: mark every online-only link in the sidebar, and say so on an online-only page. */
  function markOnlineOnly() {
    if (!(Storage.isOffline && Storage.isOffline())) return;
    document.querySelectorAll('.sidebar a[href]').forEach(a => {
      const key = pageOfHref(a.getAttribute('href'));
      if (!key || !ONLINE_ONLY[key] || a.querySelector('.online-only-badge')) return;
      a.classList.add('is-online-only');
      a.setAttribute('title', `${ONLINE_ONLY[key]} needs the internet: not available offline.`);
      a.insertAdjacentHTML('beforeend', '<span class="online-only-badge">Online only</span>');
    });
    // A group whose every link is online-only is marked too.
    document.querySelectorAll('.sidebar details').forEach(group => {
      const links = [...group.querySelectorAll('a[href]')];
      const summary = group.querySelector('summary');
      if (summary && links.length && links.every(a => a.classList.contains('is-online-only')) && !summary.querySelector('.online-only-badge')) {
        summary.insertAdjacentHTML('beforeend', '<span class="online-only-badge">Online only</span>');
      }
    });
    const page = document.body.dataset.page || 'dashboard';
    const content = document.getElementById('page-content');
    if (ONLINE_ONLY[page] && content && !document.getElementById('onlineOnlyNotice')) {
      content.insertAdjacentHTML('afterbegin', `
        <section class="card online-only-notice" id="onlineOnlyNotice" role="alert">
          <h2>${Utils.esc(ONLINE_ONLY[page])} is online-only</h2>
          <p>It does not work offline: its records are not on this computer, and nothing can be saved for it here. Connect to the internet to use it.</p>
          <p class="online-only-notice__list">Offline you can use Customers, Vehicles, Appointments, Job Cards, Invoices (drafts), Payments (pending), Inventory, Expenses, Services, Mechanics, the Dashboard and Reports. Online only: ${ONLINE_ONLY_MODULES.join(', ')}.</p>
        </section>`);
    }
  }

  /** The page key behind a sidebar link: 'pages/invoices.html' -> 'invoices', 'index.html' -> 'dashboard'. */
  const pageOfHref = href => {
    const m = /(?:^|\/)([a-z0-9-]+)\.html(?:[?#].*)?$/.exec(String(href || ''));
    return m ? (m[1] === 'index' ? 'dashboard' : m[1]) : null;
  };
  /** May the signed-in role open this page? (Always, when no role is known: nothing can be read then.) */
  const mayOpen = key => !PAGE_PERMISSIONS[key] || Storage.can(PAGE_PERMISSIONS[key]);

  /**
   * Hide the sidebar entries this role cannot open (a group with none left
   * goes too), and stand in for this page if it is one of them.
   */
  function applyAccess() {
    // Online, and offline too: the copy carries the role it was saved with.
    if (!Storage.isApi() && !(Storage.isOffline && Storage.isOffline())) return;
    const page = document.body.dataset.page || 'dashboard';
    const root = document.body.dataset.root || '';
    document.querySelectorAll('.sidebar a[href]').forEach(a => {
      const key = pageOfHref(a.getAttribute('href'));
      if (key && !mayOpen(key)) a.remove();
    });
    document.querySelectorAll('.sidebar details').forEach(group => {
      if (!group.querySelector('a[href]')) group.remove();
    });
    // A control a page marks with the permission it needs (data-requires) is
    // hidden and disabled for a role without it -- kept in the page, so the
    // page's own code can still find it. The server refuses the action anyway.
    document.querySelectorAll('[data-requires]').forEach(el => {
      if (Storage.can(el.dataset.requires)) return;
      el.hidden = true;
      el.style.display = 'none';
      if ('disabled' in el) el.disabled = true;
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('tabindex', '-1');
    });
    if (mayOpen(page)) return;
    Storage.blockPage();
    const content = document.getElementById('page-content');
    if (content) {
      content.innerHTML = `
        <section class="card access-denied" role="alert">
          <h2>You do not have access to this page</h2>
          <p>Your role${Storage.account && Storage.account.role ? ` (${Utils.esc(Storage.account.role)})` : ''} does not include this part of the workshop system.
             If you need it, ask an administrator to change your role.</p>
          <a class="btn btn--primary btn--sm" href="${root}index.html">Go to the dashboard</a>
        </section>`;
    }
  }

  function init(hydration) {
    applyTheme(Storage.getTheme());
    // Live-follow OS theme changes only while the user has chosen "System".
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (Storage.getTheme() === 'system') applyTheme('system');
      });
    }
    if (hydration && hydration.mode === 'locked') {
      // Nothing has been read. The sign-in screen covers the whole window;
      // an early shell behind it holds no data (its content was never
      // revealed) and is made inert so focus cannot wander into it.
      const shell = earlyShell && document.querySelector('.shell');
      if (shell) shell.inert = true;
      rememberSource();
      if (hydration.offline) renderOfflineUnlock(hydration);
      else if (hydration.passwordChange) renderPasswordChange();
      else renderSignIn(hydration.canSignIn !== false, hydration.accountSignIn === true, hydration.sharedPassphrase !== false);
      return;
    }
    Storage.seedIfEmpty();
    // Before the shell, not after: if rendering ever fails, the warning that
    // this session is not reaching the database is the thing that still has
    // to get through.
    warnIfBackendExpected(hydration);
    // Before the content is revealed, so a page this role may not open never shows.
    if (earlyShell) { applyAccess(); completeShell(); }
    else { renderShell(); applyAccess(); showWho(); showFootLink(); rememberSource(); afterReveal(); }
  }

  /**
   * Finish a shell that drawShellEarly() put up before the data arrived:
   * the footer, the sign-out button and the business name all depend on
   * which source hydration settled on. Then show the page's content.
   */
  /** Show an unread count on the Notifications Center link (hidden at 0 or when unknown). */
  function setNotifyCount(n) {
    const badge = document.getElementById('navNotifyCount');
    if (!badge) return;
    const count = Number(n);
    if (!Number.isFinite(count) || count <= 0) { badge.hidden = true; badge.textContent = ''; badge.removeAttribute('title'); return; }
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.title = `${count} unread notification${count === 1 ? '' : 's'}`;
    badge.setAttribute('aria-label', badge.title);
    badge.hidden = false;
  }

  let notifyTimer = null;
  async function refreshNotifyCount() {
    if (!Storage.isApi() || (typeof document !== 'undefined' && document.hidden)) return;
    try {
      const res = await Api.get('/notifications/unread-count');
      if (res && res.ok && res.data) setNotifyCount(res.data.unread);
    } catch (e) { /* the badge simply keeps its last value */ }
  }
  // Optional: whatever happens here must never stop the page from showing.
  function startNotifyBadge() {
    if (!Storage.isApi() || notifyTimer || typeof Api === 'undefined' || typeof setInterval !== 'function') return;
    try {
      refreshNotifyCount();
      notifyTimer = setInterval(refreshNotifyCount, NOTIFY_POLL_MS);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNotifyCount(); });
    } catch (e) { /* no badge, nothing else affected */ }
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('taqwa:notifications-unread', (e) => setNotifyCount(e && e.detail && e.detail.unread));
  }

  /* Who is signed in, for the header (0019): the person's own name and role,
     or the shared workshop login. Drawn before the session is known as an
     empty name, so it never shows someone it is not. */
  const signedInHere = () => Storage.isApi() || (Storage.isOffline && Storage.isOffline());
  function whoName() {
    if (!signedInHere()) return 'Admin';
    const a = Storage.account;
    if (a) return a.name || a.username;
    return Storage.fullAccess ? 'Shared workshop login' : 'Workshop';
  }
  function whoRole(settings) {
    const a = signedInHere() ? Storage.account : null;
    if (a) return a.role || 'No role';
    if (Storage.isApi() && Storage.fullAccess) return 'Passphrase (full access)';
    return `${(settings || Storage.getSettings()).businessName.split(' ')[0]} ASC`;
  }
  function showWho() {
    const name = document.querySelector('[data-who-name]') || document.querySelector('.topbar__user-text strong');
    const role = document.querySelector('[data-who-role]') || document.querySelector('.topbar__user-text span');
    if (name) name.textContent = whoName();
    if (role) role.textContent = whoRole();
    const btn = document.getElementById('profileMenuBtn');
    const img = btn && btn.querySelector('img.avatar');
    const a = signedInHere() ? Storage.account : null;
    // A personal account gets its own initial, not the owner's photo.
    if (img && a) {
      const initial = document.createElement('span');
      initial.className = 'avatar avatar--initial';
      initial.setAttribute('aria-hidden', 'true');
      initial.textContent = String(a.name || a.username || '?').trim().charAt(0).toUpperCase();
      img.replaceWith(initial);
    }
    if (btn) btn.setAttribute('aria-label', `${whoName()}, ${whoRole()} — account menu`);
  }

  /* The footer: a link to Offline & Sync, with the app version (js/version.js). */
  function showFootLink() {
    // Optional: whatever happens here must never stop the page from showing.
    try {
      const foot = document.getElementById('dataSource');
      if (!foot || typeof foot.insertAdjacentHTML !== 'function' || foot.querySelector('.sidebar__foot-link')) return;
      const root = document.body.dataset.root || '';
      const version = typeof TAQWA_VERSION === 'string' ? TAQWA_VERSION : '';
      foot.insertAdjacentHTML('beforeend', `<a class="sidebar__foot-link" href="${root}pages/offline-sync.html">Offline &amp; sync${version ? ` · v${Utils.esc(version)}` : ''}</a>`);
    } catch (e) { /* no link, nothing else affected */ }
  }
  /* After the page is shown: online, refresh this person's offline copy; offline, say so. */
  function afterReveal() {
    if (Storage.isOffline && Storage.isOffline()) { markOnlineOnly(); showOfflineBar(); showPendingPanel(); return; }
    if (Storage.isApi() && typeof Storage.saveOfflineCopy === 'function' && typeof setTimeout === 'function') {
      setTimeout(() => { Storage.saveOfflineCopy().catch(() => {}); }, 1500);
    }
    showPendingPanel();
    startSync();
  }

  /**
   * Online, for a personal account: send what was made offline, then pull
   * what changed (js/sync.js). On opening the app, when the browser says the
   * network is back, when the tab comes to the front, and every minute while
   * something is still waiting.
   */
  let syncStarted = false;
  function startSync() {
    if (syncStarted || typeof Sync === 'undefined' || !Storage.isApi() || !Storage.account || !Api.sameOrigin
      || typeof Offline === 'undefined' || !Offline.supported() || typeof setTimeout !== 'function') return;
    syncStarted = true;
    // M8: ask the browser to keep this computer's offline data (shown on Offline & Sync).
    Offline.ensurePersistent().catch(() => null);
    const go = reason => Sync.run({ reason }).then(r => {
      if (r && r.ok && r.sent) {
        Utils.toast(`${r.sent} change${r.sent === 1 ? '' : 's'} made offline ${r.sent === 1 ? 'was' : 'were'} accepted by the server.`, 'success');
        showSyncedBar(r.sent);
      }
      showPendingPanel();
    }).catch(() => {});
    setTimeout(() => go('open'), 800);
    window.addEventListener('online', () => go('online'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Sync.isOpen() && Sync.counts().pending) go('focus'); });
    if (typeof setInterval === 'function') setInterval(() => { if (Sync.isOpen() && Sync.counts().pending) go('timer'); }, 60000);
  }

  /** After a sync changed what is on screen: offer to show the server's records. */
  function showSyncedBar(n) {
    const content = document.getElementById('content') || document.querySelector('main');
    if (!content || document.getElementById('syncedBar')) return;
    const bar = document.createElement('div');
    bar.id = 'syncedBar';
    bar.className = 'offline-bar offline-bar--back';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<strong>Synced.</strong> ${n} offline change${n === 1 ? '' : 's'} now ${n === 1 ? 'has its' : 'have their'} official server ids. <button type="button" class="btn btn--primary btn--sm" data-refresh>Show the latest</button>`;
    bar.querySelector('[data-refresh]').addEventListener('click', () => location.reload());
    content.prepend(bar);
  }

  /**
   * Payments, invoices and stock moves made offline are kept APART from the
   * confirmed records (so no balance or stock counts them): this panel is
   * where they are seen, on their own page, until the server accepts them.
   */
  function showPendingPanel() {
    if (typeof Sync === 'undefined' || !Sync.isOpen() || !document.body) return;
    const kind = { payments: 'payments', invoices: 'invoiceDrafts', inventory: 'inventoryTransactions' }[document.body.dataset.page];
    const host = document.getElementById('page-content');
    if (!kind || !host) return;
    const rows = Sync.pending(kind);
    let panel = document.getElementById('pendingPanel');
    if (!rows.length) { if (panel) panel.remove(); return; }
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'pendingPanel';
      panel.className = 'card pending-panel';
      host.prepend(panel);
      Sync.on(() => showPendingPanel());
    }
    const esc = Utils.esc;
    const money = v => (Utils.formatCurrency ? Utils.formatCurrency(v) : String(v));
    const cust = id => { const c = Storage.getById('customers', id); return c ? c.name : (id || ''); };
    const stateBadge = r => {
      const s = (r._sync && r._sync.state) || 'pending';
      const label = { pending: 'Waiting to sync', conflict: 'Needs review', failed: 'Failed', dismissed: 'Not accepted' }[s] || s;
      return `<span class="badge ${s === 'pending' ? 'badge--warn' : s === 'dismissed' || s === 'failed' ? 'badge--bad' : 'badge--info'}" title="${esc((r._sync && r._sync.error) || '')}">${esc(label)}</span>`;
    };
    const titles = {
      payments: ['Pending payments — not confirmed', 'Recorded offline. They are not counted in any balance until the server accepts them.'],
      invoiceDrafts: ['Invoice drafts made offline', 'No invoice number yet. Each becomes an invoice only when an authorized person finalizes it online.'],
      inventoryTransactions: ['Stock movements waiting to sync', 'Stock changes only when the server applies them under its stock rules.'],
    }[kind];
    const body = rows.map(r => kind === 'payments'
      ? `<tr><td>${esc(r.id)}</td><td>${esc(cust(r.customerId))}</td><td>${esc(money(r.amount))}</td><td>${esc(r.method || '')}</td><td>${esc(r.date || '')}</td><td>${stateBadge(r)}</td></tr>`
      : kind === 'invoiceDrafts'
        ? `<tr><td>${esc(r.id)}</td><td>${esc(r.jobCardId)}</td><td>${esc(cust(r.customerId))}</td><td>${esc(money(r.localTotal))}</td><td>${esc(r.date || '')}</td><td>${stateBadge(r)}</td></tr>`
        : `<tr><td>${esc(r.id)}</td><td>${esc(r.partId)}</td><td>${esc(r.type)}</td><td>${esc(String(r.quantity))}</td><td>${esc(r.notes || '')}</td><td>${stateBadge(r)}</td></tr>`).join('');
    const head = kind === 'payments' ? ['Ref', 'Customer', 'Amount', 'Method', 'Date', 'Status']
      : kind === 'invoiceDrafts' ? ['Draft', 'Job card', 'Customer', 'Total seen', 'Date', 'Status'] : ['Ref', 'Part', 'Type', 'Qty', 'Notes', 'Status'];
    panel.innerHTML = `<div class="card__head"><h2>${esc(titles[0])}</h2></div><div class="card__body"><p class="ofs-hint">${esc(titles[1])}</p>
      <div class="table-wrap"><table class="table" id="pendingTable"><thead><tr>${head.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div></div>`;
  }

  function completeShell() {
    const source = dataSource();
    const foot = document.getElementById('dataSource');
    if (foot) {
      foot.title = source.title;
      foot.innerHTML = `<span class="${footDotClass(source)}"></span>${Utils.esc(source.label)}`;
    }
    rememberSource();
    const signOut = document.getElementById('signOutBtn');
    if (Storage.isApi() && !signOut) {
      const user = document.querySelector('.topbar__user');
      if (user) { user.insertAdjacentHTML('beforebegin', SIGN_OUT_BUTTON); bindSignOut(); }
    } else if (!Storage.isApi() && signOut) {
      // Drawn early on the expectation of a session; this load fell back to
      // the browser instead, where there is nothing to sign out of.
      signOut.remove();
    }
    showWho();
    showFootLink();
    revealContent();
    afterReveal();
    startNotifyBadge();
  }

  /**
   * The page module renders in its own Storage.ready() callback, which runs
   * right after this one (app.js registers first). A zero timeout lands after
   * it, so the content is shown already filled in -- never as empty tables
   * with buttons that are not wired up yet.
   */
  function revealContent() {
    const shell = document.querySelector('.shell');
    if (!shell || !shell.classList.contains('is-pending')) return;
    setTimeout(() => {
      const skeleton = shell.querySelector('.content-skeleton');
      if (skeleton) skeleton.remove();
      shell.classList.remove('is-pending');
      shell.classList.add('is-revealed');
    }, 0);
  }

  /* ---------- while the data is on its way ----------

     Every page is a full document load, and with a backend the data takes
     several round trips to arrive (hydrate() in storage.js). The shell does
     not need that data, so when there is a wait it is drawn straight away
     (drawShellEarly, below) and the sidebar and header stay put from one
     page to the next. Only the content area waits; this loader sits there
     and shows its text only if the wait is long enough to notice (see
     .app-loading in style.css). It is removed by init(), which runs the
     moment the source is decided -- with no backend that is the same tick,
     so nobody ever sees it.                                              */

  let loader = null;

  function showLoading() {
    if (!document.body || loader) return;
    loader = document.createElement('div');
    loader.className = 'app-loading';
    loader.setAttribute('role', 'status');
    loader.innerHTML = '<span class="app-loading__dot"></span><span>Loading…</span>';
    document.body.appendChild(loader);
  }

  function hideLoading() {
    if (loader && loader.remove) loader.remove();
    loader = null;
  }

  // Registered BEFORE Storage.ready() so it runs first: with no backend the
  // ready callback fires inside this same DOMContentLoaded, and a loader
  // shown afterwards would be a loader shown after the page was already up.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showLoading, { once: true });
  } else {
    showLoading();
  }

  /**
   * Draw the shell now, before hydration, when there is a network wait to
   * cover. app.js runs at the end of <body>, after #page-content, so the
   * page is already parsed up to here. With no backend there is no wait --
   * hydration settles in the same tick -- and init() draws the shell exactly
   * as it always has.
   */
  let earlyShell = false;

  function drawShellEarly() {
    if (!Api.baseUrl || !document.body || !document.getElementById('page-content')) return;
    try {
      applyTheme(Storage.getTheme());
      renderShell(true);
    } catch (e) {
      console.error('Early shell failed; it will be drawn once the data arrives:', e);
    }
    // A shell that made it into the page is completed later rather than
    // drawn a second time, even if something after the prepend threw.
    earlyShell = !!document.querySelector('.shell');
  }

  drawShellEarly();

  // Storage.ready() hands init the hydration result, so the shell can say
  // which source it is showing and warn when that is not the one expected.
  Storage.ready((hydration) => { hideLoading(); init(hydration); });

  return { NAV, applyTheme };
})();

/* The service worker (sw.js): the app shell opens without internet. Only on
   the deployed app (the API on this same origin), never from a file or a
   cross-origin dev setup. It caches pages, scripts, styles and images only --
   never business data. */
if (typeof navigator !== 'undefined' && navigator.serviceWorker && typeof window !== 'undefined'
    && typeof Api !== 'undefined' && Api.sameOrigin) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(e => console.warn('The offline app shell could not be installed:', e && e.message));
  });
}
