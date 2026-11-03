-- ===========================================================================
-- 0021 — Workshop Assets › Equipment Inventory
-- ---------------------------------------------------------------------------
-- The Equipment Inventory page becomes a real page on the SAME register as
-- Tools & Equipment (0013): one physical item = one row in `tools`. Nothing
-- is duplicated. Additive and backward-compatible only:
--
--   * four NULLable columns on `tools` -- who the item is assigned to (an
--     employee OR a mechanic) and its service dates. Every existing row keeps
--     working unchanged (all four are NULL for it). No CHECK on `tools` is
--     changed, no column is renamed or dropped.
--   * `tool_events`: the item's own history (added, edited, status changes,
--     assigned / returned, retired, reactivated, deleted). It keeps no
--     foreign key to `tools` on purpose: a deleted item's history stays.
--   * three indexes for the page's filters.
--   * `tools.delete` (new permission, 0018 catalogue) for the two built-in
--     roles that already hold `tools.manage` (retire) -- only where they
--     still hold it, so a role the owner has narrowed is not widened.
--
-- Nothing existing is read for business purposes, altered or dropped:
-- customer, vehicle, job card, invoice, payment and parts data are untouched.
-- Re-runnable: every statement is IF NOT EXISTS / OR IGNORE, except the
-- ALTERs, which D1's migration table runs exactly once.
--
-- Apply BEFORE deploying the Worker that reads these columns.
-- ===========================================================================

-- An employee (staff row that is not a mechanic's profile) ...
ALTER TABLE tools ADD COLUMN assigned_staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL;
-- ... or a mechanic. Never both (checked by the API; a column CHECK added by
-- ALTER cannot see the other new column on every SQLite, so it is not relied on).
ALTER TABLE tools ADD COLUMN assigned_mechanic_id TEXT REFERENCES mechanics(id) ON DELETE SET NULL;
ALTER TABLE tools ADD COLUMN last_service_date TEXT
  CHECK (last_service_date IS NULL OR last_service_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE tools ADD COLUMN next_service_due TEXT
  CHECK (next_service_due IS NULL OR next_service_due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

CREATE INDEX IF NOT EXISTS ix_tools_purchase_date     ON tools(purchase_date);
CREATE INDEX IF NOT EXISTS ix_tools_assigned_staff    ON tools(assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tools_assigned_mechanic ON tools(assigned_mechanic_id) WHERE assigned_mechanic_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tools_service_due       ON tools(next_service_due) WHERE next_service_due IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_id     TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 40),
  occurred_at TEXT NOT NULL,
  actor       TEXT CHECK (actor IS NULL OR length(actor) <= 100),
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'status', 'assign', 'return', 'retire', 'reactivate', 'delete')),
  summary     TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300)
);
CREATE INDEX IF NOT EXISTS ix_tool_events_tool ON tool_events(tool_id, id);

INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT role_id, 'tools.delete' FROM role_permissions
   WHERE permission = 'tools.manage' AND role_id IN ('ROL-0002', 'ROL-0006');
