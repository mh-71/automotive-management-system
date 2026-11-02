-- ===========================================================================
-- 0018 — Roles & Permissions
-- ---------------------------------------------------------------------------
-- Real, enforced roles for user accounts. Until now every account had full
-- access ('Administrator', the only role the Worker accepted -- see 0009).
--
-- roles             one row per role: ROL-0001 ... Built-in roles are seeded
--                   here; more are created on the Roles & Permissions page.
--                   ROL-0001 Super Admin is the protected system role
--                   (is_system = 1, full_access = 1): every permission, now
--                   and in future; the Worker refuses to rename, switch off,
--                   delete or narrow it.
-- role_permissions  one row per (role, permission), e.g. ('ROL-0004',
--                   'invoices.view'). The permission names are checked by
--                   the Worker against its catalog (src/lib/permissions.js).
-- user_accounts.role_id
--                   the account's role (new column, foreign key). The old
--                   `role` text column stays, unchanged for existing rows,
--                   and is kept in step with the role's name on new writes;
--                   role_id is what the Worker trusts.
--
-- EXISTING ACCOUNTS
--   Every existing account has role 'Administrator', which today means full
--   access. Each is linked to Super Admin, so nobody loses access and nobody
--   gains any. The owner can then move accounts to narrower roles.
--   An account with no role_id (none, after this file) would have NO access.
--
-- ADDITIVE ONLY: two new tables, one new nullable column, one backfill of
-- that new column. No row is deleted and no existing value is changed.
-- ALTER TABLE ... ADD COLUMN is not re-runnable, which is why D1 applies
-- each migration once; every other statement is IF NOT EXISTS / OR IGNORE.
--
-- To reverse it (code rolled back first; the old code ignores all of this):
--   DROP INDEX ix_user_accounts_role; ALTER TABLE user_accounts DROP COLUMN role_id;
--   DROP TABLE role_permissions; DROP TABLE roles;
--   DELETE FROM id_counters WHERE collection = 'roles';
-- ===========================================================================

CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY CHECK (id GLOB 'ROL-[0-9][0-9][0-9][0-9]*'),
  name         TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 40),
  description  TEXT CHECK (description IS NULL OR length(description) <= 300),
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  full_access  INTEGER NOT NULL DEFAULT 0 CHECK (full_access IN (0, 1)),
  status       TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  -- Only the system role holds full access, and the system role is always on.
  CHECK (full_access = 0 OR is_system = 1),
  CHECK (is_system = 0 OR status = 'Active')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_roles_name ON roles(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL CHECK (permission GLOB '[a-z]*.[a-z]*' AND length(permission) <= 60),
  PRIMARY KEY (role_id, permission)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_role_permissions_permission ON role_permissions(permission, role_id);

ALTER TABLE user_accounts ADD COLUMN role_id TEXT REFERENCES roles(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS ix_user_accounts_role ON user_accounts(role_id, status);

-- The built-in roles and their starting permissions (src/lib/permissions.js
-- DEFAULT_ROLES; a unit test checks the two match). Edit them on the page,
-- not here.
INSERT OR IGNORE INTO roles (id, name, description, is_system, full_access, status, created_at, updated_at, updated_by) VALUES
  ('ROL-0001', 'Super Admin', 'Every permission, now and in future. Protected: cannot be changed, switched off or deleted.', 1, 1, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0002', 'Admin', 'Runs the whole workshop and its user accounts. Cannot change role definitions.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0003', 'Manager', 'Day-to-day operations, approvals and staff; no deletions of money records, accounts or settings.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0004', 'Accountant', 'Invoices, payments and expenses, with read access to the work they bill for.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0005', 'Service Advisor', 'Front desk: customers, vehicles, bookings, job cards, estimates and taking payment.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0006', 'Store Manager', 'Parts, stock and workshop tools.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0007', 'Mechanic', 'The jobs: job cards and their status, with read access to what a job needs. No money records.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018'),
  ('ROL-0008', 'Staff', 'Basic front-office access: look up customers and vehicles, book appointments.', 0, 0, 'Active', '2026-11-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'Migration 0018');

-- Admin
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0002', 'dashboard.view'),
  ('ROL-0002', 'customers.view'),
  ('ROL-0002', 'customers.create'),
  ('ROL-0002', 'customers.edit'),
  ('ROL-0002', 'customers.delete'),
  ('ROL-0002', 'vehicles.view'),
  ('ROL-0002', 'vehicles.create'),
  ('ROL-0002', 'vehicles.edit'),
  ('ROL-0002', 'vehicles.delete'),
  ('ROL-0002', 'appointments.view'),
  ('ROL-0002', 'appointments.create'),
  ('ROL-0002', 'appointments.edit'),
  ('ROL-0002', 'appointments.delete'),
  ('ROL-0002', 'job_cards.view'),
  ('ROL-0002', 'job_cards.create'),
  ('ROL-0002', 'job_cards.edit'),
  ('ROL-0002', 'job_cards.delete'),
  ('ROL-0002', 'job_cards.manage'),
  ('ROL-0002', 'services.view'),
  ('ROL-0002', 'services.create'),
  ('ROL-0002', 'services.edit'),
  ('ROL-0002', 'services.delete'),
  ('ROL-0002', 'estimates.view'),
  ('ROL-0002', 'estimates.create'),
  ('ROL-0002', 'estimates.edit'),
  ('ROL-0002', 'estimates.approve'),
  ('ROL-0002', 'invoices.view'),
  ('ROL-0002', 'invoices.create'),
  ('ROL-0002', 'invoices.edit'),
  ('ROL-0002', 'invoices.delete'),
  ('ROL-0002', 'invoices.manage'),
  ('ROL-0002', 'payments.view'),
  ('ROL-0002', 'payments.create'),
  ('ROL-0002', 'payments.edit'),
  ('ROL-0002', 'payments.delete'),
  ('ROL-0002', 'payments.manage'),
  ('ROL-0002', 'expenses.view'),
  ('ROL-0002', 'expenses.create'),
  ('ROL-0002', 'expenses.edit'),
  ('ROL-0002', 'expenses.delete'),
  ('ROL-0002', 'inventory.view'),
  ('ROL-0002', 'inventory.create'),
  ('ROL-0002', 'inventory.edit'),
  ('ROL-0002', 'inventory.delete'),
  ('ROL-0002', 'inventory.manage'),
  ('ROL-0002', 'mechanics.view'),
  ('ROL-0002', 'mechanics.create'),
  ('ROL-0002', 'mechanics.edit'),
  ('ROL-0002', 'mechanics.delete'),
  ('ROL-0002', 'crm.view'),
  ('ROL-0002', 'crm.create'),
  ('ROL-0002', 'crm.edit'),
  ('ROL-0002', 'inbox.view'),
  ('ROL-0002', 'inbox.edit'),
  ('ROL-0002', 'staff.view'),
  ('ROL-0002', 'staff.create'),
  ('ROL-0002', 'staff.edit'),
  ('ROL-0002', 'attendance.view'),
  ('ROL-0002', 'attendance.create'),
  ('ROL-0002', 'attendance.edit'),
  ('ROL-0002', 'leave.view'),
  ('ROL-0002', 'leave.create'),
  ('ROL-0002', 'leave.approve'),
  ('ROL-0002', 'activity_log.view'),
  ('ROL-0002', 'users.view'),
  ('ROL-0002', 'users.create'),
  ('ROL-0002', 'users.edit'),
  ('ROL-0002', 'users.manage'),
  ('ROL-0002', 'roles.view'),
  ('ROL-0002', 'roles.manage'),
  ('ROL-0002', 'tools.view'),
  ('ROL-0002', 'tools.create'),
  ('ROL-0002', 'tools.edit'),
  ('ROL-0002', 'tools.manage'),
  ('ROL-0002', 'tools.export'),
  ('ROL-0002', 'notifications.view'),
  ('ROL-0002', 'reports.view'),
  ('ROL-0002', 'reports.export'),
  ('ROL-0002', 'settings.view'),
  ('ROL-0002', 'settings.edit');

-- Manager
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0003', 'dashboard.view'),
  ('ROL-0003', 'customers.view'),
  ('ROL-0003', 'customers.create'),
  ('ROL-0003', 'customers.edit'),
  ('ROL-0003', 'vehicles.view'),
  ('ROL-0003', 'vehicles.create'),
  ('ROL-0003', 'vehicles.edit'),
  ('ROL-0003', 'appointments.view'),
  ('ROL-0003', 'appointments.create'),
  ('ROL-0003', 'appointments.edit'),
  ('ROL-0003', 'job_cards.view'),
  ('ROL-0003', 'job_cards.create'),
  ('ROL-0003', 'job_cards.edit'),
  ('ROL-0003', 'job_cards.manage'),
  ('ROL-0003', 'services.view'),
  ('ROL-0003', 'services.create'),
  ('ROL-0003', 'services.edit'),
  ('ROL-0003', 'estimates.view'),
  ('ROL-0003', 'estimates.create'),
  ('ROL-0003', 'estimates.edit'),
  ('ROL-0003', 'estimates.approve'),
  ('ROL-0003', 'invoices.view'),
  ('ROL-0003', 'invoices.create'),
  ('ROL-0003', 'invoices.edit'),
  ('ROL-0003', 'payments.view'),
  ('ROL-0003', 'payments.create'),
  ('ROL-0003', 'expenses.view'),
  ('ROL-0003', 'expenses.create'),
  ('ROL-0003', 'inventory.view'),
  ('ROL-0003', 'inventory.create'),
  ('ROL-0003', 'inventory.edit'),
  ('ROL-0003', 'inventory.manage'),
  ('ROL-0003', 'mechanics.view'),
  ('ROL-0003', 'mechanics.create'),
  ('ROL-0003', 'mechanics.edit'),
  ('ROL-0003', 'crm.view'),
  ('ROL-0003', 'crm.create'),
  ('ROL-0003', 'crm.edit'),
  ('ROL-0003', 'inbox.view'),
  ('ROL-0003', 'inbox.edit'),
  ('ROL-0003', 'staff.view'),
  ('ROL-0003', 'attendance.view'),
  ('ROL-0003', 'attendance.create'),
  ('ROL-0003', 'attendance.edit'),
  ('ROL-0003', 'leave.view'),
  ('ROL-0003', 'leave.create'),
  ('ROL-0003', 'leave.approve'),
  ('ROL-0003', 'activity_log.view'),
  ('ROL-0003', 'tools.view'),
  ('ROL-0003', 'tools.create'),
  ('ROL-0003', 'tools.edit'),
  ('ROL-0003', 'tools.export'),
  ('ROL-0003', 'notifications.view'),
  ('ROL-0003', 'reports.view'),
  ('ROL-0003', 'reports.export'),
  ('ROL-0003', 'settings.view');

-- Accountant
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0004', 'dashboard.view'),
  ('ROL-0004', 'customers.view'),
  ('ROL-0004', 'vehicles.view'),
  ('ROL-0004', 'appointments.view'),
  ('ROL-0004', 'job_cards.view'),
  ('ROL-0004', 'services.view'),
  ('ROL-0004', 'estimates.view'),
  ('ROL-0004', 'invoices.view'),
  ('ROL-0004', 'invoices.create'),
  ('ROL-0004', 'invoices.edit'),
  ('ROL-0004', 'invoices.delete'),
  ('ROL-0004', 'invoices.manage'),
  ('ROL-0004', 'payments.view'),
  ('ROL-0004', 'payments.create'),
  ('ROL-0004', 'payments.edit'),
  ('ROL-0004', 'payments.delete'),
  ('ROL-0004', 'payments.manage'),
  ('ROL-0004', 'expenses.view'),
  ('ROL-0004', 'expenses.create'),
  ('ROL-0004', 'expenses.edit'),
  ('ROL-0004', 'expenses.delete'),
  ('ROL-0004', 'inventory.view'),
  ('ROL-0004', 'mechanics.view'),
  ('ROL-0004', 'notifications.view'),
  ('ROL-0004', 'reports.view'),
  ('ROL-0004', 'reports.export');

-- Service Advisor
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0005', 'dashboard.view'),
  ('ROL-0005', 'customers.view'),
  ('ROL-0005', 'customers.create'),
  ('ROL-0005', 'customers.edit'),
  ('ROL-0005', 'vehicles.view'),
  ('ROL-0005', 'vehicles.create'),
  ('ROL-0005', 'vehicles.edit'),
  ('ROL-0005', 'appointments.view'),
  ('ROL-0005', 'appointments.create'),
  ('ROL-0005', 'appointments.edit'),
  ('ROL-0005', 'job_cards.view'),
  ('ROL-0005', 'job_cards.create'),
  ('ROL-0005', 'job_cards.edit'),
  ('ROL-0005', 'job_cards.manage'),
  ('ROL-0005', 'services.view'),
  ('ROL-0005', 'estimates.view'),
  ('ROL-0005', 'estimates.create'),
  ('ROL-0005', 'estimates.edit'),
  ('ROL-0005', 'estimates.approve'),
  ('ROL-0005', 'invoices.view'),
  ('ROL-0005', 'invoices.create'),
  ('ROL-0005', 'payments.view'),
  ('ROL-0005', 'payments.create'),
  ('ROL-0005', 'inventory.view'),
  ('ROL-0005', 'mechanics.view'),
  ('ROL-0005', 'crm.view'),
  ('ROL-0005', 'crm.create'),
  ('ROL-0005', 'crm.edit'),
  ('ROL-0005', 'inbox.view'),
  ('ROL-0005', 'inbox.edit'),
  ('ROL-0005', 'notifications.view');

-- Store Manager
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0006', 'dashboard.view'),
  ('ROL-0006', 'job_cards.view'),
  ('ROL-0006', 'services.view'),
  ('ROL-0006', 'inventory.view'),
  ('ROL-0006', 'inventory.create'),
  ('ROL-0006', 'inventory.edit'),
  ('ROL-0006', 'inventory.delete'),
  ('ROL-0006', 'inventory.manage'),
  ('ROL-0006', 'mechanics.view'),
  ('ROL-0006', 'expenses.view'),
  ('ROL-0006', 'expenses.create'),
  ('ROL-0006', 'tools.view'),
  ('ROL-0006', 'tools.create'),
  ('ROL-0006', 'tools.edit'),
  ('ROL-0006', 'tools.manage'),
  ('ROL-0006', 'tools.export'),
  ('ROL-0006', 'notifications.view');

-- Mechanic
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0007', 'dashboard.view'),
  ('ROL-0007', 'customers.view'),
  ('ROL-0007', 'vehicles.view'),
  ('ROL-0007', 'appointments.view'),
  ('ROL-0007', 'job_cards.view'),
  ('ROL-0007', 'job_cards.manage'),
  ('ROL-0007', 'services.view'),
  ('ROL-0007', 'inventory.view'),
  ('ROL-0007', 'mechanics.view'),
  ('ROL-0007', 'tools.view'),
  ('ROL-0007', 'notifications.view');

-- Staff
INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES
  ('ROL-0008', 'dashboard.view'),
  ('ROL-0008', 'customers.view'),
  ('ROL-0008', 'vehicles.view'),
  ('ROL-0008', 'appointments.view'),
  ('ROL-0008', 'appointments.create'),
  ('ROL-0008', 'notifications.view');

-- Custom roles continue from ROL-0009.
INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('roles', 'ROL', 8);

-- Existing accounts: 'Administrator' meant full access, which is Super Admin.
UPDATE user_accounts SET role_id = 'ROL-0001' WHERE role_id IS NULL AND role = 'Administrator';
