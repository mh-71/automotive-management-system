-- ===========================================================================
-- 0022 — Social Inbox › Website Forms: assign an enquiry to a member of staff
-- ---------------------------------------------------------------------------
-- Website enquiries (0016) can now be assigned to an ACTIVE employee or
-- mechanic, the same way WhatsApp conversations are (0015): the person's id,
-- checked against the roster by the API, and their name as it was when
-- assigned, plus who made the assignment and when.
--
-- Additive and backward-compatible only:
--   * four NULLable columns on `website_form_submissions`. Every existing row
--     keeps working unchanged (all four are NULL = "Not assigned").
--   * one index for the page's "Assigned to" filter.
-- No table is created, rebuilt, renamed or dropped; no CHECK is changed; no
-- existing data is read or altered. website_form_events is untouched (its
-- action CHECK stays submitted/status/notes); the current assignment and
-- who made it are kept on the enquiry itself.
--
-- Apply BEFORE deploying the Worker that reads these columns.
-- Re-runnable apart from the ALTERs, which D1's migration table runs once.
-- ===========================================================================

ALTER TABLE website_form_submissions ADD COLUMN assigned_to_id TEXT
  CHECK (assigned_to_id IS NULL OR length(assigned_to_id) <= 20);
ALTER TABLE website_form_submissions ADD COLUMN assigned_to_name TEXT
  CHECK (assigned_to_name IS NULL OR length(assigned_to_name) <= 120);
ALTER TABLE website_form_submissions ADD COLUMN assigned_at TEXT;
ALTER TABLE website_form_submissions ADD COLUMN assigned_by TEXT
  CHECK (assigned_by IS NULL OR length(assigned_by) <= 100);

CREATE INDEX IF NOT EXISTS ix_wfs_assigned ON website_form_submissions(assigned_to_id, created_at);
