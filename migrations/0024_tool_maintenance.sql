-- ===========================================================================
-- 0024 — Workshop Assets › Maintenance & Repairs
-- ---------------------------------------------------------------------------
-- The Maintenance & Repairs page becomes a real page: one row per service,
-- inspection, calibration or repair of a piece of equipment in the existing
-- `tools` register (0013 / 0021). Nothing about equipment is duplicated.
--
--   tool_maintenance         one maintenance job: which equipment, what kind,
--                            when it is scheduled, who does it (a member of
--                            staff / mechanic, or an outside vendor), the
--                            estimated and actual cost, its status and, once
--                            done, when it was completed and what was done.
--                            The equipment's name is kept as it was (a
--                            snapshot), like tool_events: the record outlives
--                            a deleted tool, so there is no foreign key.
--   tool_maintenance_events  every change to a job: created, edited, started,
--                            completed, cancelled, deleted -- who and when.
--                            No foreign key either: a deleted job's history
--                            stays.
--
-- "Due soon" and "Overdue" are NOT stored: they are worked out from the
-- scheduled date and today (Dhaka), so they are never out of date.
--
-- Additive and backward-compatible only: two NEW tables, their indexes and a
-- MNT id counter. No existing table, column, CHECK, permission or row is
-- changed. The API keeps the equipment's own status and service dates in
-- step (Under Maintenance while a job is in progress; last / next service
-- dates when it is completed) through the same rules as /api/tools.
-- Re-runnable: every statement is IF NOT EXISTS / OR IGNORE.
--
-- Apply BEFORE deploying the Worker that reads these tables.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS tool_maintenance (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'MNT-[0-9]*'),     -- 'MNT-0001', from id_counters
  tool_id           TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 40),
  tool_name         TEXT NOT NULL CHECK (length(trim(tool_name)) > 0 AND length(tool_name) <= 120),
  maintenance_type  TEXT NOT NULL CHECK (maintenance_type IN ('Preventive Service', 'Inspection', 'Calibration', 'Repair')),
  priority          TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Normal', 'High', 'Urgent')),
  status            TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'In Progress', 'Completed', 'Cancelled')),
  scheduled_date    TEXT NOT NULL CHECK (scheduled_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Who does it: a member of staff or a mechanic (checked by the API, name kept as it was) ...
  technician_id     TEXT CHECK (technician_id IS NULL OR length(technician_id) <= 20),
  technician_name   TEXT CHECK (technician_name IS NULL OR length(technician_name) <= 120),
  -- ... and/or an outside vendor.
  vendor            TEXT CHECK (vendor IS NULL OR (length(trim(vendor)) > 0 AND length(vendor) <= 120)),
  estimated_cost    REAL CHECK (estimated_cost IS NULL OR (estimated_cost >= 0 AND estimated_cost <= 100000000)),
  actual_cost       REAL CHECK (actual_cost IS NULL OR (actual_cost >= 0 AND actual_cost <= 100000000)),
  description       TEXT CHECK (description IS NULL OR length(description) <= 1000),
  work_done         TEXT CHECK (work_done IS NULL OR length(work_done) <= 1000),
  started_at        TEXT,
  completed_date    TEXT CHECK (completed_date IS NULL OR completed_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  next_service_due  TEXT CHECK (next_service_due IS NULL OR next_service_due GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  cancel_reason     TEXT CHECK (cancel_reason IS NULL OR (length(trim(cancel_reason)) > 0 AND length(cancel_reason) <= 300)),
  created_by        TEXT CHECK (created_by IS NULL OR length(created_by) <= 100),
  updated_by        TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT,
  cancelled_at      TEXT,
  CHECK ((technician_id IS NULL) = (technician_name IS NULL)),
  -- Completed, and only completed, carries the day it was done.
  CHECK ((status = 'Completed') = (completed_date IS NOT NULL)),
  -- Cancelled, and only cancelled, carries why.
  CHECK ((status = 'Cancelled') = (cancel_reason IS NOT NULL)),
  CHECK (next_service_due IS NULL OR completed_date IS NULL OR next_service_due > completed_date)
);

CREATE INDEX IF NOT EXISTS ix_tool_maintenance_tool      ON tool_maintenance(tool_id, scheduled_date);
CREATE INDEX IF NOT EXISTS ix_tool_maintenance_status    ON tool_maintenance(status, scheduled_date);
CREATE INDEX IF NOT EXISTS ix_tool_maintenance_scheduled ON tool_maintenance(scheduled_date, id);
CREATE INDEX IF NOT EXISTS ix_tool_maintenance_completed ON tool_maintenance(completed_date) WHERE completed_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tool_maintenance_tech      ON tool_maintenance(technician_id) WHERE technician_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tool_maintenance_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  maintenance_id  TEXT NOT NULL CHECK (length(maintenance_id) BETWEEN 1 AND 40),
  tool_id         TEXT NOT NULL CHECK (length(tool_id) BETWEEN 1 AND 40),
  occurred_at     TEXT NOT NULL,
  actor           TEXT CHECK (actor IS NULL OR length(actor) <= 100),
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'start', 'complete', 'cancel', 'delete')),
  summary         TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 300)
);
CREATE INDEX IF NOT EXISTS ix_tool_maintenance_events_job ON tool_maintenance_events(maintenance_id, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('toolMaintenance', 'MNT', 0);
