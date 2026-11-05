/**
 * Roles & Permissions (0018): the one place that says what can be allowed,
 * what each built-in role starts with, and which permission every API route
 * needs.
 *
 * WHO HAS WHAT
 *   - An account has one role (user_accounts.role_id). Its permissions are
 *     the role's rows in role_permissions, read from the database by the auth
 *     gate on every request (lib/accounts.js) -- never from anything the
 *     browser sends.
 *   - The Super Admin role (is_system = 1, full_access = 1) holds every
 *     permission, including any added later. It cannot be renamed,
 *     deactivated, deleted or have its permissions reduced.
 *   - The workshop passphrase and the machine API token are the two shared
 *     credentials that existed before accounts. They keep full access, exactly
 *     as before this change (removing it would lock the workshop out of its
 *     own system). See the limitations in the PR.
 *   - An account whose role is missing or inactive has NO permissions: every
 *     protected route answers 403. There is no fallback to any role.
 *
 * ENFORCEMENT
 *   routePermission() maps a request to what it needs. The router asks it for
 *   every request it hands to a handler; a route it does not know needs
 *   FULL access (fail closed), so a route added later without an entry here
 *   is usable only by full-access callers until it is given one.
 */

/** Every module and the actions that exist in it, in the order the Roles page shows them. */
export const CATALOG = [
  { key: 'dashboard', label: 'Dashboard', actions: { view: 'Open the dashboard' } },
  { key: 'customers', label: 'Customers', actions: { view: 'See customers', create: 'Add customers', edit: 'Edit customers', delete: 'Delete customers' } },
  { key: 'vehicles', label: 'Vehicles', actions: { view: 'See vehicles', create: 'Add vehicles', edit: 'Edit vehicles', delete: 'Delete vehicles' } },
  { key: 'appointments', label: 'Appointments', actions: { view: 'See appointments (and website bookings)', create: 'Book appointments', edit: 'Edit or cancel appointments', delete: 'Delete appointments' } },
  { key: 'job_cards', label: 'Job Cards', actions: { view: 'See job cards', create: 'Open job cards', edit: 'Edit job cards (work, parts, prices)', delete: 'Delete job cards', manage: 'Change job card status' } },
  { key: 'services', label: 'Services', actions: { view: 'See the service catalog', create: 'Add services', edit: 'Edit services and prices', delete: 'Delete services' } },
  { key: 'estimates', label: 'Estimates / Quotations', actions: { view: 'See estimates', create: 'Write estimates', edit: 'Edit, send or cancel estimates', approve: 'Record approval or rejection, convert to a job card' } },
  { key: 'invoices', label: 'Invoices', actions: { view: 'See invoices', create: 'Create invoices', edit: 'Edit invoices', delete: 'Delete invoices', manage: 'Void invoices and write off balances' } },
  { key: 'payments', label: 'Payments', actions: { view: 'See payments', create: 'Record payments', edit: 'Edit payments', delete: 'Delete payments', manage: 'Void payments and link advances' } },
  { key: 'expenses', label: 'Expenses', actions: { view: 'See expenses', create: 'Record expenses', edit: 'Edit expenses', delete: 'Delete expenses' } },
  { key: 'inventory', label: 'Inventory / Parts', actions: { view: 'See parts and stock movements', create: 'Add parts', edit: 'Edit parts and prices', delete: 'Delete parts', manage: 'Record stock movements' } },
  { key: 'mechanics', label: 'Mechanics', actions: { view: 'See mechanics', create: 'Add mechanics', edit: 'Edit mechanics', delete: 'Delete mechanics' } },
  { key: 'crm', label: 'Customer CRM', actions: { view: 'See follow-ups, tasks and CRM pages', create: 'Add follow-ups and tasks', edit: 'Update, complete, cancel and log contacts' } },
  { key: 'inbox', label: 'Social Inbox', actions: { view: 'See website enquiries, Messenger and WhatsApp', edit: 'Reply, change status and assign' } },
  { key: 'bookings', label: 'Bookings', actions: { view: 'See booking requests, their notes and history', create: 'Enter booking requests (phone, walk-in, manual)', edit: 'Assign bookings, link customers and vehicles, add notes', manage: 'Confirm, reject, cancel, reschedule and complete bookings' } },
  { key: 'staff', label: 'Staff', actions: { view: 'See staff and their details', create: 'Add staff', edit: 'Edit staff' } },
  { key: 'attendance', label: 'Attendance', actions: { view: 'See attendance', create: 'Record attendance', edit: 'Correct attendance' } },
  { key: 'leave', label: 'Leave', actions: { view: 'See leave requests', create: 'Submit leave requests', approve: 'Approve or reject leave' } },
  { key: 'activity_log', label: 'Activity Log', actions: { view: 'Read the staff activity log' } },
  { key: 'users', label: 'User Accounts', actions: { view: 'See user accounts', create: 'Create user accounts', edit: 'Activate / deactivate accounts', manage: 'Set new passwords' } },
  { key: 'roles', label: 'Roles & Permissions', actions: { view: 'See roles and permissions', create: 'Create roles', edit: 'Edit roles and their permissions', delete: 'Delete unused roles', manage: 'Assign roles to user accounts' } },
  { key: 'tools', label: 'Workshop Assets', actions: { view: 'See tools and equipment', create: 'Add tools and equipment', edit: 'Edit, assign and return tools and equipment', manage: 'Retire and reactivate tools and equipment (status)', export: 'Export the tool list (CSV)', delete: 'Delete tools and equipment permanently' } },
  { key: 'notifications', label: 'Notifications', actions: { view: 'See notifications (only for modules the role can see)' } },
  { key: 'reports', label: 'Reports', actions: { view: 'Open the reports pages', export: 'Export CRM reports (CSV)' } },
  { key: 'settings', label: 'Settings', actions: { view: 'Open the settings page', edit: 'Change workshop settings' } },
  // Offline sync (0020): reviewing what devices pushed, and deciding conflicts.
  { key: 'sync', label: 'Offline & Sync', actions: { view: 'See every device, sync history and conflict', manage: 'Resolve sync conflicts and revoke devices' } },
];

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'manage', 'export'];

/** Every permission that exists: 'customers.view', ... */
export const ALL_PERMISSIONS = CATALOG.flatMap((m) => Object.keys(m.actions).map((a) => `${m.key}.${a}`));
const KNOWN = new Set(ALL_PERMISSIONS);
export const isPermission = (p) => typeof p === 'string' && KNOWN.has(p);

/** Shorthand for the defaults: 'customers:view,create' -> ['customers.view', 'customers.create']. */
function perms(...specs) {
  return specs.flatMap((s) => {
    const [mod, acts] = s.split(':');
    const list = acts === '*' ? Object.keys(CATALOG.find((m) => m.key === mod).actions) : acts.split(',');
    return list.map((a) => `${mod}.${a}`);
  });
}

export const SUPER_ADMIN_ID = 'ROL-0001';

/**
 * The built-in roles and what each starts with. These are DEFAULTS: migration
 * 0018 writes them once, and from then on each role (other than Super Admin)
 * is edited on the Roles & Permissions page. A test checks the migration
 * matches this list.
 */
export const DEFAULT_ROLES = [
  { id: 'ROL-0001', name: 'Super Admin', system: true, description: 'Every permission, now and in future. Protected: cannot be changed, switched off or deleted.', permissions: [] },
  { id: 'ROL-0002', name: 'Admin', system: false, description: 'Runs the whole workshop and its user accounts. Cannot change role definitions.',
    permissions: ALL_PERMISSIONS.filter((p) => !['roles.create', 'roles.edit', 'roles.delete'].includes(p)) },
  { id: 'ROL-0003', name: 'Manager', system: false, description: 'Day-to-day operations, approvals and staff; no deletions of money records, accounts or settings.',
    permissions: perms('dashboard:view', 'customers:view,create,edit', 'vehicles:view,create,edit', 'appointments:view,create,edit',
      'job_cards:view,create,edit,manage', 'services:view,create,edit', 'estimates:*', 'invoices:view,create,edit', 'payments:view,create',
      'expenses:view,create', 'inventory:view,create,edit,manage', 'mechanics:view,create,edit', 'crm:*', 'inbox:*', 'bookings:*', 'staff:view',
      'attendance:*', 'leave:*', 'activity_log:view', 'tools:view,create,edit,export', 'notifications:view', 'reports:*', 'settings:view') },
  { id: 'ROL-0004', name: 'Accountant', system: false, description: 'Invoices, payments and expenses, with read access to the work they bill for.',
    permissions: perms('dashboard:view', 'customers:view', 'vehicles:view', 'appointments:view', 'job_cards:view', 'services:view',
      'estimates:view', 'invoices:*', 'payments:*', 'expenses:*', 'inventory:view', 'mechanics:view', 'notifications:view', 'reports:*') },
  { id: 'ROL-0005', name: 'Service Advisor', system: false, description: 'Front desk: customers, vehicles, bookings, job cards, estimates and taking payment.',
    permissions: perms('dashboard:view', 'customers:view,create,edit', 'vehicles:view,create,edit', 'appointments:view,create,edit',
      'job_cards:view,create,edit,manage', 'services:view', 'estimates:view,create,edit,approve', 'invoices:view,create', 'payments:view,create',
      'inventory:view', 'mechanics:view', 'crm:*', 'inbox:*', 'bookings:*', 'notifications:view') },
  { id: 'ROL-0006', name: 'Store Manager', system: false, description: 'Parts, stock and workshop tools.',
    permissions: perms('dashboard:view', 'job_cards:view', 'services:view', 'inventory:*', 'mechanics:view', 'expenses:view,create',
      'tools:*', 'notifications:view') },
  { id: 'ROL-0007', name: 'Mechanic', system: false, description: 'The jobs: job cards and their status, with read access to what a job needs. No money records.',
    permissions: perms('dashboard:view', 'customers:view', 'vehicles:view', 'appointments:view', 'job_cards:view,manage', 'services:view',
      'inventory:view', 'mechanics:view', 'tools:view', 'notifications:view') },
  { id: 'ROL-0008', name: 'Staff', system: false, description: 'Basic front-office access: look up customers and vehicles, book appointments.',
    permissions: perms('dashboard:view', 'customers:view', 'vehicles:view', 'appointments:view,create', 'bookings:view', 'notifications:view') },
];

/* ---------------------------------------------------------------
   Checking
   --------------------------------------------------------------- */

/** Does the authenticated caller hold full access? (Super Admin, or the passphrase / token.) */
export function hasFullAccess(who) {
  if (!who) return false;
  if (who.kind === 'token' || who.kind === 'passphrase') return true;
  return who.kind === 'account' && who.fullAccess === true;
}

/**
 * May this caller do `need`? `need` is a permission, an array of permissions
 * (all required), AUTHENTICATED (any signed-in caller) or FULL (full access).
 */
export const AUTHENTICATED = 'authenticated';
export const FULL = 'full';
export function can(who, need) {
  if (!who) return false;
  if (need === AUTHENTICATED) return true;
  if (hasFullAccess(who)) return true;
  if (need === FULL || need == null) return false;
  const list = Array.isArray(need) ? need : [need];
  const held = who.permissions instanceof Set ? who.permissions : new Set(who.permissions || []);
  return list.length > 0 && list.every((p) => held.has(p));
}

/** The caller's permissions as a sorted list (every permission for full access). */
export function permissionsOf(who) {
  if (hasFullAccess(who)) return [...ALL_PERMISSIONS];
  if (!who || !who.permissions) return [];
  return [...(who.permissions instanceof Set ? who.permissions : new Set(who.permissions))].filter(isPermission).sort();
}

/** Is `granted` (a list) within what `who` holds? Used to stop anyone granting more than they have. */
export function withinCaller(who, granted) {
  if (hasFullAccess(who)) return true;
  const held = new Set(permissionsOf(who));
  return granted.every((p) => held.has(p));
}

/* ---------------------------------------------------------------
   What each route needs
   --------------------------------------------------------------- */

const CRUD = (mod) => ({ view: `${mod}.view`, create: `${mod}.create`, update: `${mod}.edit`, remove: `${mod}.delete` });

/** API collection -> the permission each kind of request needs. */
export const COLLECTION_PERMISSIONS = {
  customers: CRUD('customers'),
  vehicles: CRUD('vehicles'),
  services: CRUD('services'),
  mechanics: CRUD('mechanics'),
  parts: CRUD('inventory'),
  appointments: CRUD('appointments'),
  'job-cards': { ...CRUD('job_cards'), actions: { status: 'job_cards.manage' } },
  invoices: { ...CRUD('invoices'), actions: { void: 'invoices.manage' } },
  payments: { ...CRUD('payments'), actions: { void: 'payments.manage', link: 'payments.manage' } },
  'invoice-adjustments': { view: 'invoices.view', create: 'invoices.manage', actions: { void: 'invoices.manage' } },
  expenses: CRUD('expenses'),
  'inventory-transactions': { view: 'inventory.view', create: 'inventory.manage' },
  'follow-ups': { view: 'crm.view', create: 'crm.create', update: 'crm.edit', actions: { complete: 'crm.edit', cancel: 'crm.edit', contact: 'crm.edit' } },
  'follow-up-contacts': { view: 'crm.view', actions: { void: 'crm.edit' } },
  'follow-up-tasks': { view: 'crm.view', create: 'crm.create', update: 'crm.edit', actions: { start: 'crm.edit', complete: 'crm.edit', cancel: 'crm.edit' } },
  estimates: {
    view: 'estimates.view', create: 'estimates.create', update: 'estimates.edit',
    actions: { send: 'estimates.edit', cancel: 'estimates.edit', approve: 'estimates.approve', reject: 'estimates.approve',
      convert: ['estimates.approve', 'job_cards.create'] },
  },
  staff: { view: 'staff.view', create: 'staff.create', update: 'staff.edit' },
  accounts: { view: 'users.view', create: 'users.create', update: 'users.edit', actions: { password: 'users.manage' } },
  attendance: { view: 'attendance.view', create: 'attendance.create', update: 'attendance.edit' },
  'leave-requests': { view: 'leave.view', create: 'leave.create', actions: { approve: 'leave.approve', reject: 'leave.approve' } },
  'activity-log': { view: 'activity_log.view' },
  'website-forms': { view: 'inbox.view', update: 'inbox.edit' },
  bookings: { view: 'bookings.view', create: 'bookings.create', update: 'bookings.edit', actions: { status: 'bookings.manage', notes: 'bookings.edit' } },
  tools: { view: 'tools.view', create: 'tools.create', update: 'tools.edit', remove: 'tools.delete', actions: { retire: 'tools.manage', reactivate: 'tools.manage' } },
  // Maintenance & Repairs (0024): part of Workshop Assets, so its permissions -- no new ones.
  'tool-maintenance': { view: 'tools.view', create: 'tools.edit', update: 'tools.edit', remove: 'tools.delete', actions: { status: 'tools.edit' } },
  // Asset Assignment (0025): also Workshop Assets -- tools.edit is "Edit, assign and return".
  'tool-assignments': { view: 'tools.view', create: 'tools.edit', update: 'tools.edit', actions: { return: 'tools.edit', cancel: 'tools.edit' } },
  roles: { view: 'roles.view', create: 'roles.create', update: 'roles.edit', remove: 'roles.delete' },
};

/**
 * The permission a collection request needs. `op` is 'view' (GET list or
 * detail), 'create', 'update', 'remove' or an action name. Unknown -> FULL.
 */
export function collectionPermission(collection, op) {
  const c = COLLECTION_PERMISSIONS[collection];
  if (!c) return FULL;
  if (op === 'view' || op === 'create' || op === 'update' || op === 'remove') return c[op] || FULL;
  return (c.actions && c.actions[op]) || FULL;
}

/** The permission a non-collection route needs. Unknown -> FULL. */
export function routePermission(method, pathname) {
  // Business settings (name, currency, invoice footer) are read by every page.
  if (pathname === '/api/settings') return method === 'GET' ? AUTHENTICATED : 'settings.edit';
  if (pathname === '/api/website-bookings') return 'appointments.view';
  // A person's own notifications; what they show is filtered by permission (routes/notifications.js).
  if (pathname === '/api/notifications' || pathname.startsWith('/api/notifications/')) return 'notifications.view';
  if (/^\/api\/(messenger|whatsapp)(\/|$)/.test(pathname)) return method === 'GET' ? 'inbox.view' : 'inbox.edit';
  // Offline sync (0020). Invoice drafts are invoices; resolving a conflict is
  // sync.manage. The rest are a PERSON'S OWN: their device, their pushes, their
  // pulls (which return only what their role may read) and their own conflicts
  // and history -- so any signed-in account reaches them, and the route itself
  // widens the view to everyone's only with sync.view / sync.manage (routes/sync.js).
  if (pathname === '/api/invoice-drafts' || pathname.startsWith('/api/invoice-drafts/')) {
    return method === 'GET' ? 'invoices.view' : 'invoices.create';
  }
  if (/^\/api\/sync\/conflicts\/[^/]+\/resolve$/.test(pathname)) return 'sync.manage';
  if (/^\/api\/(sync|devices)(\/|$)/.test(pathname)) return AUTHENTICATED;
  return FULL;
}

/** Notification record types -> the permission needed to see them (routes/notifications.js). */
export const NOTIFICATION_RECORD_PERMISSIONS = {
  customer: 'customers.view', vehicle: 'vehicles.view', appointment: 'appointments.view', job_card: 'job_cards.view',
  estimate: 'estimates.view', invoice: 'invoices.view', payment: 'payments.view', part: 'inventory.view',
  follow_up: 'crm.view', follow_up_task: 'crm.view', leave_request: 'leave.view', website_form: 'inbox.view',
};
