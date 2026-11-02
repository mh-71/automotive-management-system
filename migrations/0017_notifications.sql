-- ===========================================================================
-- 0017 — Notifications Center
-- ---------------------------------------------------------------------------
-- Notifications raised by real workshop events, and who has read them.
-- Additive only: two new tables, no existing table is changed.
--
-- notifications       one row per event. event_key is UNIQUE, so the same
--                     event (a retried request, a second sweep of the same
--                     due follow-up) can never produce a second row: every
--                     insert is INSERT OR IGNORE on it.
--                     recipient_account_id NULL = for everyone signed in;
--                     set = for that user account only (e.g. a staff
--                     member's own leave decision).
--                     record_type + record_id name the record the
--                     notification is about, so the page can open it. No
--                     foreign key there: it points into several tables.
--                     Rows are never updated or deleted by the app.
-- notification_reads  one row per (notification, reader) that has read it.
--                     "reader" is the signed-in identity: 'account:USR-0001',
--                     or 'passphrase' / 'token' for the shared credentials.
--                     Marking unread deletes only this marker row.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS notifications (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key             TEXT NOT NULL UNIQUE CHECK (length(event_key) BETWEEN 3 AND 200),
  event_type            TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 60),
  category              TEXT NOT NULL CHECK (category IN (
                          'Enquiry', 'Customer', 'Appointment', 'Workshop',
                          'Finance', 'Inventory', 'Follow-up', 'Staff')),
  priority              TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important')),
  title                 TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 120),
  message               TEXT NOT NULL CHECK (length(message) <= 500),
  record_type           TEXT CHECK (record_type IS NULL OR record_type IN (
                          'customer', 'vehicle', 'appointment', 'job_card', 'estimate',
                          'invoice', 'payment', 'part', 'follow_up', 'follow_up_task',
                          'leave_request', 'website_form')),
  record_id             TEXT CHECK (record_id IS NULL OR length(record_id) BETWEEN 1 AND 40),
  recipient_account_id  TEXT REFERENCES user_accounts(id) ON DELETE CASCADE,
  actor_name            TEXT CHECK (actor_name IS NULL OR length(actor_name) <= 100),
  created_at            TEXT NOT NULL,
  CHECK ((record_type IS NULL) = (record_id IS NULL))
);

CREATE INDEX IF NOT EXISTS ix_notifications_created ON notifications(created_at, id);
CREATE INDEX IF NOT EXISTS ix_notifications_category ON notifications(category, id);
CREATE INDEX IF NOT EXISTS ix_notifications_recipient ON notifications(recipient_account_id, id);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id  INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  reader           TEXT NOT NULL CHECK (length(reader) BETWEEN 3 AND 60),
  read_at          TEXT NOT NULL,
  PRIMARY KEY (notification_id, reader)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_notification_reads_reader ON notification_reads(reader, notification_id);
