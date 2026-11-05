-- ===========================================================================
-- 0025 — Workshop Assets › Asset Assignment
-- ---------------------------------------------------------------------------
-- The Asset Assignment page becomes a real page: one row per time a piece of
-- equipment from the existing `tools` register (0013 / 0021) is handed to a
-- member of staff or a mechanic -- when, until when, for what, in what
-- condition, and how and when it came back.
--
-- Who has an item RIGHT NOW stays where it already is: tools.assigned_staff_id
-- / assigned_mechanic_id with status 'In Use' (0021). Equipment Inventory and
-- Maintenance & Repairs keep changing those columns exactly as before; the
-- Asset Assignment API keeps this register in step with them (an assignment
-- ended there is closed here; one made there is recorded here). Nothing about
-- equipment, staff or mechanics is duplicated: names are kept as they were
-- (snapshots), like tool_events and tool_maintenance.
--
--   tool_assignments          one hand-over: Active -> Returned | Cancelled.
--                             At most ONE Active assignment per item (a unique
--                             index, not just a check in code).
--   tool_assignment_events    every change: created, edited, returned,
--                             cancelled, and the ones recorded from the other
--                             pages (sync) -- who and when. Never deleted.
--
-- "Overdue" is NOT stored: an Active assignment past its expected return date.
--
-- Additive and backward-compatible only: two NEW tables, their indexes and an
-- ASG id counter. No existing table, column, CHECK, permission or row is
-- changed. Re-runnable: every statement is IF NOT EXISTS / OR IGNORE.
--
-- Apply BEFORE deploying the Worker that reads these tables.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tool_assignments (
  id                    TEXT PRIMARY KEY CHECK (id GLOB 'ASG-[0-9]*'),   -- 'ASG-0001', from id_counters
  tool_id               TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 40),
  tool_name             TEXT NOT NULL CHECK (length(trim(tool_name)) > 0 AND length(tool_name) <= 120),
  assignee_type         TEXT NOT NULL CHECK (assignee_type IN ('staff', 'mechanic')),
  assignee_id           TEXT NOT NULL CHECK (length(assignee_id) BETWEEN 1 AND 20),
  assignee_name         TEXT NOT NULL CHECK (length(trim(assignee_name)) > 0 AND length(assignee_name) <= 120),
  status                TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Returned', 'Cancelled')),
  -- Where it came from: this page, or recorded from Equipment Inventory.
  source                TEXT NOT NULL DEFAULT 'Assignment' CHECK (source IN ('Assignment', 'Equipment Inventory')),
  assigned_date         TEXT NOT NULL CHECK (assigned_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  expected_return_date  TEXT CHECK (expected_return_date IS NULL OR expected_return_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  purpose               TEXT CHECK (purpose IS NULL OR length(purpose) <= 200),
  work_location         TEXT CHECK (work_location IS NULL OR length(work_location) <= 80),
  condition_before      TEXT CHECK (condition_before IS NULL OR condition_before IN ('Excellent', 'Good', 'Fair', 'Poor', 'Damaged')),
  notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  -- The return.
  return_date           TEXT CHECK (return_date IS NULL OR return_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  condition_after       TEXT CHECK (condition_after IS NULL OR condition_after IN ('Excellent', 'Good', 'Fair', 'Poor', 'Damaged')),
  damage_notes          TEXT CHECK (damage_notes IS NULL OR length(damage_notes) <= 500),
  return_notes          TEXT CHECK (return_notes IS NULL OR length(return_notes) <= 1000),
  received_by_id        TEXT CHECK (received_by_id IS NULL OR length(received_by_id) <= 20),
  received_by_name      TEXT CHECK (received_by_name IS NULL OR length(received_by_name) <= 120),
  cancel_reason         TEXT CHECK (cancel_reason IS NULL OR (length(trim(cancel_reason)) > 0 AND length(cancel_reason) <= 300)),
  created_by            TEXT CHECK (created_by IS NULL OR length(created_by) <= 100),
  updated_by            TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  returned_at           TEXT,
  cancelled_at          TEXT,
  -- Returned, and only Returned, carries the day it came back.
  CHECK ((status = 'Returned') = (return_date IS NOT NULL)),
  -- Cancelled, and only Cancelled, carries why.
  CHECK ((status = 'Cancelled') = (cancel_reason IS NOT NULL)),
  CHECK ((received_by_id IS NULL) = (received_by_name IS NULL)),
  CHECK (expected_return_date IS NULL OR expected_return_date >= assigned_date),
  CHECK (return_date IS NULL OR return_date >= assigned_date)
);

-- One Active assignment per item, enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tool_assignments_active ON tool_assignments(tool_id) WHERE status = 'Active';
CREATE INDEX IF NOT EXISTS ix_tool_assignments_status   ON tool_assignments(status, assigned_date);
CREATE INDEX IF NOT EXISTS ix_tool_assignments_tool     ON tool_assignments(tool_id, assigned_date);
CREATE INDEX IF NOT EXISTS ix_tool_assignments_assignee ON tool_assignments(assignee_id, status);
CREATE INDEX IF NOT EXISTS ix_tool_assignments_due      ON tool_assignments(expected_return_date) WHERE status = 'Active';

CREATE TABLE IF NOT EXISTS tool_assignment_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id   TEXT NOT NULL CHECK (length(assignment_id) BETWEEN 1 AND 40),
  tool_id         TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 40),
  occurred_at     TEXT NOT NULL,
  actor           TEXT CHECK (actor IS NULL OR length(actor) <= 100),
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'return', 'cancel', 'sync')),
  summary         TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300)
);
CREATE INDEX IF NOT EXISTS ix_tool_assignment_events_asg ON tool_assignment_events(assignment_id, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('toolAssignments', 'ASG', 0);
