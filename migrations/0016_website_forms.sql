-- ===========================================================================
-- 0016 — Social Inbox › Website Forms
-- ---------------------------------------------------------------------------
-- Booking, quote and contact enquiries sent from the public website
-- (taqwa.autos) to the CRM's public endpoint POST /api/forms/submit, and the
-- staff's handling of them. Additive only.
--
-- website_form_submissions  one row per enquiry: WEB-0001, from id_counters.
--                           Never deleted; a spam or unwanted enquiry is
--                           marked Rejected.
-- website_form_events       what happened to it: submitted, status changes and
--                           note edits, with who and when. INTEGER ids, like
--                           activity_log.
--
-- ip_hash is a salted SHA-256 of the sender's IP address, kept only so the
-- endpoint can limit how often one address submits. The IP itself is never
-- stored.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS website_form_submissions (
  id              TEXT PRIMARY KEY,                       -- 'WEB-0001', from id_counters
  form_type       TEXT NOT NULL DEFAULT 'booking' CHECK (form_type IN ('booking', 'quote', 'contact')),
  name            TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
  phone           TEXT NOT NULL CHECK (length(phone) BETWEEN 6 AND 20),
  phone_digits    TEXT NOT NULL CHECK (length(phone_digits) BETWEEN 6 AND 15),
  email           TEXT CHECK (email IS NULL OR length(email) <= 160),
  service         TEXT CHECK (service IS NULL OR length(service) <= 80),
  vehicle         TEXT CHECK (vehicle IS NULL OR length(vehicle) <= 120),
  reg_no          TEXT CHECK (reg_no IS NULL OR length(reg_no) <= 40),
  preferred_date  TEXT CHECK (preferred_date IS NULL OR preferred_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  preferred_time  TEXT CHECK (preferred_time IS NULL OR preferred_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  message         TEXT CHECK (message IS NULL OR length(message) <= 2000),
  source_page     TEXT CHECK (source_page IS NULL OR length(source_page) <= 200),
  status          TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Contacted', 'Confirmed', 'Rejected')),
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  ip_hash         TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  updated_by      TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100)
);

CREATE INDEX IF NOT EXISTS ix_wfs_created ON website_form_submissions(created_at, id);
CREATE INDEX IF NOT EXISTS ix_wfs_status ON website_form_submissions(status);
CREATE INDEX IF NOT EXISTS ix_wfs_phone ON website_form_submissions(phone_digits, created_at);
CREATE INDEX IF NOT EXISTS ix_wfs_ip ON website_form_submissions(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS website_form_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id   TEXT NOT NULL REFERENCES website_form_submissions(id) ON DELETE RESTRICT,
  action          TEXT NOT NULL CHECK (action IN ('submitted', 'status', 'notes')),
  from_status     TEXT CHECK (from_status IS NULL OR from_status IN ('New', 'Contacted', 'Confirmed', 'Rejected')),
  to_status       TEXT CHECK (to_status IS NULL OR to_status IN ('New', 'Contacted', 'Confirmed', 'Rejected')),
  actor           TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_wfe_submission ON website_form_events(submission_id, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('websiteForms', 'WEB', 0);
