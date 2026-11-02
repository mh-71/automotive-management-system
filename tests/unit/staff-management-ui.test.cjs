/* staff-management-ui — Staff Management: the sidebar group and the static
   shape of its nine pages, all of them real (Overview, Staff List, Add Staff,
   User Accounts, Roles & Permissions, Attendance, Leave Management,
   Performance and Activity Log, whose behaviour is tested in
   staff-overview.test.cjs, staff-list.test.cjs, staff-add.test.cjs,
   staff-accounts.test.cjs, staff-roles.test.cjs, staff-attendance.test.cjs,
   staff-leave.test.cjs, staff-performance.test.cjs and
   staff-activity-log.test.cjs).

   What must hold:
     1. The sidebar has a "Staff Management" group right after Mechanics and
        before Inventory, with nine entries that link to real pages, mark the
        current one as active and open the group on a Staff page. The original
        six keep their order and URLs; Attendance, Leave Management and
        Performance sit between Roles & Permissions and Activity Log. The group
        follows the approved reference design: outline icons (the group's own
        and all nine entries') while every other link and group keeps its filled
        icons, and its styling is scoped to #navStaff. It is no longer a
        top-level link, and every other link keeps its order.
     2. On each Staff page only its own entry is active and the header title
        names the page; on any other page nothing in the group is active.
     3. Every Staff page shares the Settings <head> (title and the staff
        stylesheets aside), declares its own page key and has no file or
        password input, inline handler or inline script. None is a preview:
        no preview notice, no Demo badge, no preview-only control, and its own
        script after the shared shell scripts. Add Staff is the one page with
        a form: one submit button (Save Staff), no pay, password or photo
        field. User Accounts shows no password column and says plainly what an
        account can do. Roles & Permissions says plainly which rules the
        server enforces and offers no way to change them. Attendance says a
        day with no record is not counted as absent. Leave Management says
        approving leave changes nothing else. Activity Log says the server
        records successful changes only. Performance says what each count is
        based on and that no score is calculated.
     4. The preview script js/staff-ui.js is gone: no page loads it.
     5. css/staff.css reaches the Staff pages only.

   Drives the REAL js/app.js through the shared harness. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ENTRIES = [
  ['staff-management', 'Overview', 'pages/staff-management.html', 'Staff Management'],
  ['staff-list', 'Staff List', 'pages/staff-list.html', 'Staff List'],
  ['staff-add', 'Add Staff', 'pages/staff-add.html', 'Add Staff'],
  ['staff-accounts', 'User Accounts', 'pages/staff-accounts.html', 'User Accounts'],
  ['staff-roles', 'Roles & Permissions', 'pages/staff-roles.html', 'Roles & Permissions'],
  ['staff-attendance', 'Attendance', 'pages/staff-attendance.html', 'Attendance'],
  ['staff-leave', 'Leave Management', 'pages/staff-leave.html', 'Leave Management'],
  ['staff-performance', 'Performance', 'pages/staff-performance.html', 'Performance'],
  ['staff-activity-log', 'Activity Log', 'pages/staff-activity-log.html', 'Activity Log'],
];
// The approved reference design: one outline icon per entry, in order (24-unit stroke markup).
const REF_ICONS = [
  ['staff-management', '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'],
  ['staff-list', '<path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>'],
  ['staff-add', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6"/><path d="M22 11h-6"/>'],
  ['staff-accounts', '<path d="M8 2v2"/><path d="M16 2v2"/><rect width="18" height="18" x="3" y="4" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M7 22v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>'],
  ['staff-roles', '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'],
  ['staff-attendance', '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>'],
  ['staff-leave', '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>'],
  ['staff-performance', '<path d="M4 18v3"/><path d="M8 14v7"/><path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/><path d="m22 3-8.65 8.65a.5.5 0 0 1-.7 0L9.35 8.35a.5.5 0 0 0-.7 0L2 15"/>'],
  ['staff-activity-log', '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>'],
];

/** Render the shell for one page; return the HTML the shell wrote. */
function shellFor(page, root = '', sessionHint = null) {
  const session = new Map(sessionHint ? [['taqwa_nav_staff_open', sessionHint]] : []);
  const h = boot({
    modules: ['js/app.js'],
    beforeModules(doc, ctx) {
      doc.body.dataset.page = page;
      doc.body.dataset.root = root;
      ctx.sessionStorage = { getItem: k => (session.has(k) ? session.get(k) : null), setItem: (k, v) => session.set(k, String(v)) };
    },
  });
  h.fireReady();
  return h.ctx.document.body._lastShellHtml || '';
}
const staffBlock = html => (html.match(/<details class="nav__group[^"]*" id="navStaff"[\s\S]*?<\/details>/) || [''])[0];
// Top-level links only: group entries are nav__sub.
const topLinks = html => [...html.matchAll(/<a class="nav__link( is-active)?" href="([^"]+)">[\s\S]*?<span>([^<]+)<\/span><\/a>/g)]
  .map(m => ({ active: !!m[1], href: m[2], label: m[3] }));

console.log('=== staff-management-ui: Staff Management group and preview pages ===\n');

/* ---------- 1. sidebar ---------- */
console.log('-- 1. sidebar --');
{
  const html = shellFor('dashboard');
  check('the top-level links, in order (Staff Management is a group, not a link)', topLinks(html).map(l => l.label),
    ['Dashboard', 'Customers', 'Vehicles', 'Appointments', 'Job Cards', 'Estimates & Quotations', 'Services', 'Mechanics',
      'Inventory', 'Invoices', 'Payments', 'Expenses', 'Reports', 'Settings']);
  const block = staffBlock(html);
  ok('the sidebar has a Staff Management group', /<summary class="nav__summary"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"[^>]*>[\s\S]*?<\/svg><span>Staff Management<\/span>/.test(block), block.slice(0, 200));
  const iMec = html.indexOf('href="pages/mechanics.html"'), iGrp = html.indexOf('id="navStaff"'), iInv = html.indexOf('href="pages/inventory.html"');
  ok('   ...placed right after Mechanics and before Inventory', iMec > -1 && iMec < iGrp && iGrp < iInv
    && !/<a class="nav__link/.test(html.slice(iMec + 1, iGrp).replace(/^[^>]*>/, '')), JSON.stringify({ iMec, iGrp, iInv }));
  const links = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span><\/a>/g)].map(m => [m[1], m[2]]);
  check('   ...with the nine entries, in order', links, ENTRIES.map(([, label, href]) => [href, label]));
  check('   ...the three new entries sit right after Roles & Permissions and right before Activity Log',
    links.slice(4, 9).map(l => l[1]), ['Roles & Permissions', 'Attendance', 'Leave Management', 'Performance', 'Activity Log']);
  const subs = [...block.matchAll(/<a class="nav__sub[^"]*" href="([^"]+)"[^>]*><svg ([^>]*)>([\s\S]*?)<\/svg><span>([^<]+)<\/span><\/a>/g)]
    .map(m => ({ href: m[1], attrs: m[2], icon: m[3], label: m[4] }));
  check('   ...each entry has the outline icon of the approved reference design, in order',
    subs.map(x => [x.href, x.icon]), REF_ICONS.map(([k, icon]) => [`pages/${k}.html`, icon]));
  ok('   ...drawn as 16px stroke icons that follow the text colour',
    subs.length === 9 && subs.every(x => /^viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"$/.test(x.attrs)), JSON.stringify(subs.map(x => x.attrs)));
  ok('   ...nine different icons', new Set(subs.map(x => x.icon)).size === 9, '');
  ok('   ...the chevron is an outline chevron that turns with the group',
    /<svg class="nav__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"[^>]*><path d="m6 9 6 6 6-6"\/><\/svg><\/summary>/.test(block), '');
  const crm = (html.match(/<details class="nav__group[^"]*" id="navCrm"[\s\S]*?<\/details>/) || [''])[0];
  // Outline (Lucide-style) icons belong to two groups: Staff Management and
  // Workshop Assets. Everything else -- the CRM group and every top-level
  // link -- keeps its filled icons.
  const assets = (html.match(/<details class="nav__group[^"]*" id="navAssets"[\s\S]*?<\/details>/) || [''])[0];
  ok('every other group and link keeps its filled icons (the outline style is the Staff and Workshop Assets groups\' only)',
    crm && assets && !/fill="none"/.test(crm) && !/fill="none"/.test((html.match(/<nav[\s\S]*?<\/nav>/) || [''])[0].replace(block, '').replace(assets, ''))
      && (html.match(/<a class="nav__link[^"]*" href="[^"]+"><svg[^>]*fill="currentColor"/g) || []).length === 14, '');
  ok('   ...each linking to a page that exists', ENTRIES.every(([, , href]) => fs.existsSync(path.join(ROOT, href))), '');
  ok('   ...the Overview keeps its existing URL', links[0] && links[0][0] === 'pages/staff-management.html', '');
  ok('   ...a native <details> with a chevron, so it opens from the keyboard',
    /^<details[\s\S]*<summary class="nav__summary">/.test(block) && /<svg class="nav__chevron"/.test(block), '');
  ok('   ...closed by default on another page, with nothing marked active',
    /^<details class="nav__group" id="navStaff">/.test(block) && !/is-active|aria-current|has-active/.test(block), block.slice(0, 120));
  ok('the Customer CRM and Social Inbox groups are still there', /id="navCrm"/.test(html) && /id="navInbox"/.test(html), '');
}
{
  const block = staffBlock(shellFor('dashboard', '', '1'));
  ok('a group the user left open stays open on the next page', /^<details class="nav__group" id="navStaff" open>/.test(block), block.slice(0, 80));
}

/* ---------- 2. active state and header ---------- */
console.log('\n-- 2. active state --');
for (const [key, label, href, title] of ENTRIES) {
  const html = shellFor(key, '../');
  const block = staffBlock(html);
  const active = [...block.matchAll(/<a class="nav__sub is-active" href="([^"]+)" aria-current="page">/g)].map(m => m[1]);
  ok(`on ${label}: the group is open and marked, and only its entry is active`,
    /^<details class="nav__group has-active" id="navStaff" open>/.test(block) && active.length === 1 && active[0] === `../${href}`,
    JSON.stringify({ head: block.slice(0, 70), active }));
  ok(`   ...no top-level link and no Customer CRM entry is active`,
    topLinks(html).every(l => !l.active) && !/id="navCrm"[^>]*has-active/.test(html), '');
  ok(`   ...and the header title reads "${title}"`, html.includes(`<h1>${title}</h1>`), '');
}
for (const page of ['mechanics', 'crm-reports', 'settings']) {
  const html = shellFor(page, '../');
  ok(`on ${page}: nothing in the Staff group is active`, !/is-active|aria-current|has-active/.test(staffBlock(html)), '');
}

/* ---------- 3. the pages ---------- */
console.log('\n-- 3. the pages --');
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'));
const SCRIPTS = ['../js/api.js', '../js/seed-data.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/staff-ui.js'];
const pages = {};
// Each real page: its stylesheet and the scripts it loads after the shared shell.
const REAL = {
  'staff-management': ['staff-overview.css', ['staff-overview.js']],
  'staff-list': ['staff-list.css', ['staff-form.js', 'staff-list.js']],
  'staff-add': ['staff-add.css', ['staff-form.js', 'staff-add.js']],
  'staff-accounts': ['staff-accounts.css', ['staff-accounts.js']],
  'staff-roles': ['staff-roles.css', ['staff-roles.js']],
  'staff-attendance': ['staff-attendance.css', ['staff-attendance.js']],
  'staff-leave': ['staff-leave.css', ['staff-leave.js']],
  'staff-activity-log': ['staff-activity-log.css', ['staff-activity-log.js']],
  'staff-performance': ['staff-performance.css', ['staff-performance.js']],
};
for (const [key, label] of ENTRIES) {
  const html = read(`pages/${key}.html`);
  const body = html.slice(html.indexOf('<body data-page='));
  pages[key] = body;
  const titleText = label === 'Overview' ? 'Staff Management' : label;
  const real = REAL[key];
  check(`${label}: <head> is the Settings head with only the title and the staff stylesheet${real ? 's' : ''} changed`, head(html),
    settingsHead.replace('<title>Settings — ', `<title>${titleText} — `)
      .replace('<link rel="stylesheet" href="../css/responsive.css">',
        '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/staff.css">'
          + (real ? `\n  <link rel="stylesheet" href="../css/${real[0]}">` : '')));
  ok('   ...declares its own page key', body.startsWith(`<body data-page="${key}" data-root="../">`), body.slice(0, 60));
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  if (real) {
    ok('   ...is NOT a preview: no preview notice, Demo badge, empty-state switch or preview-only control',
      !/stf-preview|Preview:|>Demo<|data-empty-toggle|data-preview|not saved or sent/.test(body), '');
    check(`   ...loads the shared shell scripts plus ${real[1].map(f => `js/${f}`).join(' and ')} (never staff-ui.js), last`, scripts,
      [...SCRIPTS.slice(0, -1), ...real[1].map(f => `../js/${f}`)]);
  } else {
    ok('   ...says it is a preview and that nothing is saved or sent',
      /<div class="stf-preview" role="note">/.test(body) && /<strong>Preview: [^<]+<\/strong>/.test(body) && /Nothing on this page is saved or sent/.test(body), '');
    check('   ...loads the shared shell scripts plus js/staff-ui.js, last', scripts, SCRIPTS);
  }
  ok('   ...keeps the shell-drawn marker after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='), '');
  ok('   ...has no file input or password input', !/type="file"|type="password"/i.test(body), '');
  if (key !== 'staff-add') ok('   ...has no form', !/<form\b/i.test(body), '');
  ok('   ...has no inline handler and no inline script in the body', !/\son[a-z]+=/i.test(html) && !/<script>/.test(body), '');
  const buttons = (body.match(/<button\b[^>]*>/g) || []).filter(b => !(key === 'staff-add' && b === '<button type="submit" class="btn btn--primary" id="saSave" disabled>'));
  ok(`   ...every button${key === 'staff-add' ? ' but Save Staff' : ''} is type="button"`, buttons.every(b => /\stype="button"/.test(b)), JSON.stringify(buttons.filter(b => !/type="button"/.test(b))));
  if (key !== 'staff-management') {
    ok('   ...has a breadcrumb back to the Overview', /<nav class="stf-crumbs" aria-label="Breadcrumb">/.test(body)
      && body.includes('<a href="staff-management.html">Staff Management</a>') && body.includes(`<li aria-current="page">${label}</li>`), '');
  }
}
{
  const o = pages['staff-management'];
  check('Overview: six summary cards, from the database', [...o.matchAll(/<div class="stat__value" id="sov-([a-z]+)">/g)].map(m => m[1]),
    ['total', 'active', 'present', 'late', 'absent', 'pending']);
  check('   ...the four sections, each with a link to its page',
    [...o.matchAll(/<h2 id="sov(\w+)Title">([^<]+)<\/h2>[\s\S]*?<a class="btn btn--ghost btn--sm" href="([^"]+)">/g)].map(m => [m[2], m[3]]),
    [['Attendance', 'staff-attendance.html'], ['Pending Leave Requests', 'staff-leave.html'], ['Recently Added Staff', 'staff-list.html'], ['Recent Activity', 'staff-activity-log.html']]);
  ok('   ...the subtitle, Add Staff, and a day picker that starts disabled',
    o.includes('<p class="page-subtitle">Manage workshop staff and employee information.</p>') && /<a class="btn btn--primary" href="staff-add.html">/.test(o)
      && /<input type="date" class="input sov-day" id="sovDay" disabled>/.test(o), '');
  ok('   ...no Demo badge, demo staff or chart of demo data is left', !/>Demo<|DEMO-|stfRoleChart|stfRecentBody|demo/i.test(o.replace(/<!--[\s\S]*?-->/g, '')), '');
  const l = pages['staff-list'];
  ok('Staff List: search, designation, department, status and sort controls, page size and pager',
    ['stlSearch', 'stlDesignation', 'stlDepartment', 'stlStatus', 'stlSort', 'stlClear', 'stlAdd', 'stlPageSize', 'stlPrev', 'stlNext', 'stlBody'].every(id => l.includes(`id="${id}"`)), '');
  ok('   ...every control starts disabled until the data loads', ['stlSearch', 'stlDesignation', 'stlDepartment', 'stlStatus', 'stlSort', 'stlClear']
    .every(id => new RegExp(`id="${id}"[^>]*\\sdisabled`).test(l)), '');
  ok('   ...Add Staff is a link to the Add Staff page', /<a class="btn btn--primary" id="stlAdd" href="staff-add.html">/.test(l), '');
  check('   ...the requested columns', [...l.matchAll(/<th scope="col">(?:<span class="stl-sr-only">)?([^<]+)/g)].map(m => m[1]),
    ['Staff ID / Code', 'Name', 'Designation', 'Department', 'Phone', 'Email', 'Status', 'Joining Date', 'Actions']);
  ok('   ...and no salary or commission column', !/salary|commission/i.test(l), '');
  const a = pages['staff-add'];
  ok('Add Staff: the "Add New Staff" heading', a.includes('<h2 class="sa-title">Add New Staff</h2>'), '');
  check('   ...personal, employment, contact and additional sections, in order',
    [...a.matchAll(/<h3 class="form-section__title" id="sa-sec-([a-z]+)">([^<]+)<\/h3>/g)].map(m => [m[1], m[2]]),
    [['personal', 'Personal Information'], ['employment', 'Employment Information'], ['contact', 'Contact Information'], ['additional', 'Additional Information']]);
  check('   ...the requested fields, each labelled', [...a.matchAll(/<label for="(sa[A-Za-z]+)">/g)].map(m => m[1]),
    ['saName', 'saDesignation', 'saDesignationOther', 'saDepartment', 'saDepartmentOther', 'saJoined', 'saStatus', 'saCode', 'saSpec', 'saPhone', 'saEmail', 'saAddress', 'saNotes']);
  check('   ...full name, phone, joining date, designation and department are required (and marked)',
    ['saName', 'saPhone', 'saJoined', 'saDesignation', 'saDepartment'].map(id => new RegExp(`id="${id}"[^>]*\\srequired aria-required="true"`).test(a)), [true, true, true, true, true]);
  ok('   ...a Staff type choice (other staff by default, or mechanic), each option labelled',
    /<label class="sa-choice" for="saTypeStaff">\s*<input type="radio" name="staffType" id="saTypeStaff" value="staff" checked>/.test(a)
      && /<label class="sa-choice" for="saTypeMechanic">\s*<input type="radio" name="staffType" id="saTypeMechanic" value="mechanic">/.test(a), '');
  ok('   ...Status defaults to Active', /<option value="Active" selected>Active<\/option><option value="Inactive">Inactive<\/option>/.test(a), '');
  ok('   ...no pay, password, login or photo field', !/salary|commission|payroll|password|username|type="file"|photo/i.test(a.replace(/<!--[\s\S]*?-->/g, '').replace(/no pay is recorded|Their pay is set there|Pay is set there, never here/g, '')), '');
  ok('   ...every field is disabled until the database answers (one fieldset), and Save Staff too',
    a.includes('<fieldset class="sa-fields" id="saFields" disabled>') && a.includes('<button type="submit" class="btn btn--primary" id="saSave" disabled>Save Staff</button>'), '');
  ok('   ...Cancel goes back to the Staff List', a.includes('<a class="btn btn--ghost" id="saCancel" href="staff-list.html">Cancel</a>'), '');
  ok('   ...a page-level alert and a polite status line', a.includes('id="saAlert" role="alert"') && a.includes('id="saStatus" role="status" aria-live="polite"'), '');
  ok('   ...every field\'s message is tied to its input', [...a.matchAll(/<p class="field__error" id="([^"]+)-err"/g)].every(m => new RegExp(`id="${m[1]}"[^>]*aria-describedby="[^"]*${m[1]}-err`).test(a)), '');
  const u = pages['staff-accounts'];
  ok('User Accounts: explains what an account is, that every account has full access, and that there is no e-mail recovery',
    /<h2 class="uac-note__title" id="uacNoteTitle">How accounts work<\/h2>/.test(u) && /full access \(Administrator\)/.test(u)
      && /Password recovery by e-mail is not available/.test(u) && /shared workshop passphrase, which keeps working/.test(u), '');
  check('   ...the requested columns, with no password column', [...u.matchAll(/<th scope="col">(?:<span class="uac-sr-only">)?([^<]+)/g)].map(m => m[1]),
    ['Employee', 'Staff ID', 'Username', 'Role', 'Account Status', 'Last Sign-in', 'Actions']);
  ok('   ...search, role and status filters, Clear filters and Create Account, all disabled until the data loads',
    ['uacSearch', 'uacRole', 'uacStatus', 'uacClear', 'uacCreate'].every(id => new RegExp(`id="${id}"[^>]*\\sdisabled`).test(u)), '');
  ok('   ...the four summary cards', ['uacTotal', 'uacActive', 'uacInactive', 'uacNone'].every(id => u.includes(`id="${id}"`)), '');
  ok('   ...no password, hash or token anywhere in the markup', !/type="password"|password_hash|passwordHash|token/i.test(u), '');
  const r = pages['staff-roles'];
  ok('Roles & Permissions: explains the protected Super Admin role, that the server enforces every permission, and that nobody grants more than they hold',
    /<h2 class="rop-note__title" id="ropNoteTitle">How access works<\/h2>/.test(r) && /<strong>Super Admin<\/strong> is the protected system role/.test(r)
      && /the server refuses it even if it is tried directly/.test(r) && /Nobody can give a role, or an account, more than their own role has/.test(r), '');
  check('   ...a permission matrix per module (View to Export), and a user role assignment table', [...r.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1]),
    ['Module', 'View', 'Create', 'Edit', 'Delete', 'Approve', 'Manage', 'Export', 'Staff member', 'Username', 'Status', 'Role']);
  ok('   ...New role, search, status filter and the assignment card are there (shown by role)', ['id="ropCreate"', 'id="ropSearch"', 'id="ropStatus"', 'id="ropAssignCard"', 'id="ropUsers"'].every(x => r.includes(x)), '');
  ok('   ...the role list, matrix body, alert and count are filled by its script', ['ropRoleList', 'ropBody', 'ropAlert', 'ropCount', 'ropWho', 'ropRoleMembers'].every(id => r.includes(`id="${id}"`)), '');
  ok('   ...no "example" or "demo" wording is left', !/example|demo/i.test(r.replace(/<!--[\s\S]*?-->/g, '')), '');
  const g = pages['staff-activity-log'];
  ok('Activity Log: explains that the server records successful Staff Management changes only, never private details, and that entries cannot be changed',
    /<h2 class="alg-note__title" id="algNoteTitle">How the activity log works<\/h2>/.test(g) && /The server records an entry when a Staff Management change <strong>succeeds<\/strong>/.test(g)
      && /Passwords and other private details are never recorded/.test(g) && /Entries cannot be edited or deleted\./.test(g), '');
  check('   ...four summary cards, from the server', [...g.matchAll(/<div class="stat__value" id="alg-([a-z-]+)">/g)].map(m => m[1]), ['total', 'today', 'people', 'days']);
  ok('   ...search, date range, module and action filters and Clear filters, all disabled until the data loads',
    ['algSearch', 'algFrom', 'algTo', 'algModule', 'algAction', 'algClear'].every(id => new RegExp(`id="${id}"[^>]*\\sdisabled`).test(g)), '');
  ok('   ...the table body, pager and details panel are filled by its script', ['algBody', 'algPrev', 'algNext', 'algRange', 'algDetails', 'algDetailsList'].every(id => g.includes(`id="${id}"`)), '');
  check('   ...the columns', [...g.matchAll(/<th>([^<]+)<\/th>/g)].map(m => m[1]), ['Date &amp; Time', 'User', 'Action', 'Module', 'Description', 'Details']);
  ok('   ...no Demo badge, demo entry or empty-state switch is left', !/>Demo<|ACT-DEMO|data-empty-toggle|demo/i.test(g.replace(/<!--[\s\S]*?-->/g, '')), '');
}
{
  const cols = body => [...body.matchAll(/<th(?: class="num")?>([^<]+)<\/th>/g)].map(m => m[1]);
  const t = pages['staff-attendance'];
  ok('Attendance: explains one record per person per day, that an unrecorded day is not absent, and that nothing is calculated',
    /<h2 class="att-note__title" id="attNoteTitle">How attendance works<\/h2>/.test(t) && /it is not counted as absent/.test(t)
      && /Nothing is calculated from attendance: no pay, overtime or leave balance\./.test(t), '');
  check('   ...a summary card for each of the six statuses, in order, from the records',
    [...t.matchAll(/<div class="stat__value" id="att-([a-z-]+)">/g)].map(m => m[1]), ['present', 'late', 'half-day', 'absent', 'on-leave', 'holiday']);
  ok('   ...day picker, search, status and department filters, Clear filters and Record Attendance, all disabled until the data loads',
    ['attDay', 'attSearch', 'attStatus', 'attDept', 'attClear', 'attRecord'].every(id => new RegExp(`id="${id}"[^>]*\\sdisabled`).test(t)), '');
  ok('   ...the day picker is a real date input (any day, not a demo week)', /<input type="date" class="input" id="attDay"/.test(t), '');
  check('   ...the daily columns', [...t.matchAll(/<th scope="col">(?:<span class="att-sr-only">)?([^<]+)/g)].map(m => m[1]).slice(0, 7),
    ['Staff', 'Department', 'Status', 'Check-in', 'Check-out', 'Hours', 'Actions']);
  check('   ...the monthly summary columns', [...t.matchAll(/<th scope="col" class="num">([^<]+)<\/th>/g)].map(m => m[1]),
    ['Present', 'Late', 'Half-day', 'Absent', 'On Leave', 'Holiday', 'Recorded days']);
  ok('   ...no Demo badge, demo week or empty-state switch is left', !/>Demo<|stfWeek|data-empty-toggle|demo/i.test(t.replace(/<!--[\s\S]*?-->/g, '')), '');
  const v = pages['staff-leave'];
  ok('Leave Management: explains overlap, that only an administrator decides once, and that approving changes nothing else',
    /<h2 class="lv-note__title" id="lvNoteTitle">How leave requests work<\/h2>/.test(v) && /It may not overlap another <strong>Pending<\/strong> or <strong>Approved<\/strong> request/.test(v)
      && /An administrator approves or rejects a pending request once/.test(v) && /Approving leave changes nothing else: attendance is not marked/.test(v), '');
  check('   ...Pending, Approved, Rejected and approved-days cards, from the requests',
    [...v.matchAll(/<div class="stat__value" id="lv-([a-z-]+)">/g)].map(m => m[1]), ['pending', 'approved', 'rejected', 'days']);
  ok('   ...both charts, the table body and the pager are filled by its script',
    ['lvTypeChart', 'lvTypeLegend', 'lvStatusChart', 'lvStatusLegend', 'lvBody', 'lvPrev', 'lvNext', 'lvRange'].every(id => v.includes(`id="${id}"`)), '');
  ok('   ...search, type and status filters, Clear filters and New Leave Request, all disabled until the data loads',
    ['lvSearch', 'lvType', 'lvStatus', 'lvClear', 'lvNew'].every(id => new RegExp(`id="${id}"[^>]*\\sdisabled`).test(v)), '');
  check('   ...the requested columns', cols(v), ['Staff', 'Department', 'Leave Type', 'Dates', 'Days', 'Reason', 'Submitted', 'Status', 'Actions']);
  ok('   ...no Demo badge, demo request or empty-state switch is left', !/>Demo<|LV-DEMO|data-empty-toggle|demo/i.test(v.replace(/<!--[\s\S]*?-->/g, '')), '');
  const f = pages['staff-performance'];
  ok('Performance: says what each count is based on (job date, completion time), that only mechanics are assigned job cards, and that no score is calculated',
    /<h2 class="prf-note__title" id="prfNoteTitle">How performance is measured<\/h2>/.test(f) && /<strong>job date<\/strong>/.test(f)
      && /<strong>completion time<\/strong>/.test(f) && /Only mechanics are assigned job cards/.test(f) && /no score or ranking is calculated/.test(f), '');
  check('   ...six summary cards, from the job cards', [...f.matchAll(/<div class="stat__value" id="prf-([a-z]+)">/g)].map(m => m[1]),
    ['mechanics', 'assigned', 'done', 'open', 'cancelled', 'ontime']);
  ok('   ...period, date range, mechanic, search, Reset and status controls, all disabled until the data loads',
    ['prfPeriod', 'prfFrom', 'prfTo', 'prfMechanic', 'prfSearch', 'prfClear', 'prfStatus'].every(id => new RegExp(`id="${id}"[^>]*\\sdisabled`).test(f)), '');
  check('   ...the periods offered', [...f.matchAll(/<option value="(today|last7|month|lastMonth|custom)"/g)].map(m => m[1]), ['today', 'last7', 'month', 'lastMonth', 'custom']);
  check('   ...the mechanic table columns', [...f.matchAll(/<th(?: class="num")?>([^<]+)<\/th>/g)].map(m => m[1]).slice(0, 9),
    ['Mechanic', 'Specialization', 'Assigned', 'Open', 'Completed / Delivered', 'Cancelled', 'Completion rate', 'Completed in period', 'On time']);
  ok('   ...the job card list and its pager are filled by its script', ['prfBody', 'prfJobsBody', 'prfJobsPrev', 'prfJobsNext', 'prfJobsRange'].every(id => f.includes(`id="${id}"`)), '');
  ok('   ...no Demo badge, sample figure or empty-state switch is left', !/>Demo<|Sample figure|data-empty-toggle|demo/i.test(f.replace(/<!--[\s\S]*?-->/g, '')), '');
}

/* ---------- 4. no preview script is left ---------- */
console.log('\n-- 4. js/staff-ui.js --');
ok('the preview script js/staff-ui.js is gone (every Staff page is real)', !fs.existsSync(path.join(ROOT, 'js/staff-ui.js')), '');
ok('   ...and no page loads it', fs.readdirSync(path.join(ROOT, 'pages')).every(f => !read(`pages/${f}`).includes('staff-ui.js')), '');

/* ---------- 5. the stylesheet ---------- */
console.log('\n-- 5. css/staff.css --');
const css = read('css/staff.css').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = css.replace(/@media[^{]*\{/g, '').split('}').map(r => r.trim()).filter(Boolean)
  // Split selector lists on top-level commas only: :is(a, b) is one selector.
  .flatMap(r => r.split('{')[0].split(/,(?![^(]*\))/).map(s => s.trim())).filter(Boolean);
const loose = selectors.filter(sel => !sel.startsWith('[data-page^="staff-"]'));
check('every rule is scoped to the Staff pages', loose, []);
const shared = read('css/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const navStaffRules = shared.split('}').map(x => x.trim()).filter(x => x.includes('#navStaff')).flatMap(x => x.split('{')[0].split(/,(?![^(]*\))/).map(y => y.trim()));
ok('the Staff menu styling lives in the shared stylesheet (the sidebar is on every page), every rule scoped to #navStaff',
  navStaffRules.length >= 10 && navStaffRules.every(sel => sel.startsWith('#navStaff')), JSON.stringify(navStaffRules.filter(sel => !sel.startsWith('#navStaff'))));
ok('   ...and css/staff.css no longer restyles the menu on Staff pages only', !css.includes('#navStaff'), '');
ok('   ...and only the nine Staff pages load it',
  fs.readdirSync(path.join(ROOT, 'pages')).filter(f => read(`pages/${f}`).includes('../css/staff.css')).sort().join('|')
    === ENTRIES.map(([k]) => `${k}.html`).sort().join('|'), '');

summary('staff-management-ui');
