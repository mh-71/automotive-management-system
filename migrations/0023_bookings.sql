-- ===========================================================================
-- 0023 — Social Inbox › Bookings: a dedicated booking-request register
-- ---------------------------------------------------------------------------
-- A BOOKING is a customer's request for a service (from the website's Book
-- Now form, WhatsApp, Messenger, the phone, a walk-in or entered by staff).
-- It is NOT an appointment: an appointment is the workshop's scheduled job
-- (`appointments`, 0001). A booking may later be linked to one appointment
-- (appointment_id); this migration creates the link column only.
--
--   bookings          one row per request. The submitted details are kept as
--                     a SNAPSHOT (customer_name, phone, vehicle_make, ...) so
--                     they never change when a customer or vehicle record is
--                     edited later. customer_id / vehicle_id / appointment_id
--                     are optional links that staff set.
--   booking_history   every submission, status change, reschedule,
--                     assignment, link and note event: who and when. Like
--                     website_form_events (0016). A booking with history
--                     cannot be deleted (and there is no delete API).
--   booking_notes     staff-only internal notes, several per booking.
--
-- Additive and backward-compatible only: three NEW tables, their indexes, a
-- BKG id counter and four new permissions for the built-in roles that already
-- run the Social Inbox. No existing table, column, CHECK or row is changed.
-- Re-runnable: every statement is IF NOT EXISTS / OR IGNORE.
--
-- Apply BEFORE deploying the Worker that reads these tables.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS bookings (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'BKG-[0-9]*'),   -- the booking reference, from id_counters
  source              TEXT NOT NULL CHECK (source IN ('Website', 'WhatsApp', 'Facebook', 'Phone', 'Walk-in', 'Manual')),
  source_reference    TEXT CHECK (source_reference IS NULL OR length(source_reference) <= 60),
  idempotency_key     TEXT CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 8 AND 64),

  -- What the customer submitted (snapshot).
  customer_name       TEXT NOT NULL CHECK (length(trim(customer_name)) > 0 AND length(customer_name) <= 120),
  phone               TEXT NOT NULL CHECK (length(trim(phone)) > 0 AND length(phone) <= 20),
  phone_digits        TEXT NOT NULL CHECK (length(phone_digits) BETWEEN 6 AND 15),   -- normalised: +8801.. / 8801.. -> 01..
  email               TEXT CHECK (email IS NULL OR length(email) <= 160),
  vehicle_make        TEXT NOT NULL CHECK (length(trim(vehicle_make)) > 0 AND length(vehicle_make) <= 50),
  vehicle_model       TEXT NOT NULL CHECK (length(trim(vehicle_model)) > 0 AND length(vehicle_model) <= 50),
  registration_number TEXT CHECK (registration_number IS NULL OR length(registration_number) <= 20),
  service_type        TEXT NOT NULL CHECK (length(service_type) BETWEEN 1 AND 40),
  service_label       TEXT NOT NULL CHECK (length(service_label) BETWEEN 1 AND 80),
  preferred_date      TEXT NOT NULL CHECK (preferred_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  preferred_time      TEXT NOT NULL CHECK (preferred_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  customer_message    TEXT CHECK (customer_message IS NULL OR length(customer_message) <= 1000),
  consent             INTEGER NOT NULL DEFAULT 0 CHECK (consent IN (0, 1)),
  consent_at          TEXT,

  status              TEXT NOT NULL DEFAULT 'New' CHECK (status IN (
                        'New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Rejected', 'Completed')),

  -- Optional links to existing CRM records, set by staff.
  customer_id         TEXT REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_id          TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  appointment_id      TEXT REFERENCES appointments(id) ON DELETE SET NULL,

  -- The member of staff who looks after it: an employee or a mechanic id,
  -- checked against the roster by the API, with the name as it was then.
  assigned_staff_id   TEXT CHECK (assigned_staff_id IS NULL OR length(assigned_staff_id) <= 20),
  assigned_staff_name TEXT CHECK (assigned_staff_name IS NULL OR length(assigned_staff_name) <= 120),
  assigned_at         TEXT,
  assigned_by         TEXT CHECK (assigned_by IS NULL OR length(assigned_by) <= 100),

  ip_hash             TEXT,                                   -- salted SHA-256 of the sender's IP; the IP is never kept
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100),
  confirmed_at        TEXT,
  cancelled_at        TEXT,

  CHECK ((assigned_staff_id IS NULL) = (assigned_staff_name IS NULL)),
  CHECK (consent = 0 OR consent_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_bookings_status_created ON bookings(status, created_at);
CREATE INDEX IF NOT EXISTS ix_bookings_created        ON bookings(created_at);
CREATE INDEX IF NOT EXISTS ix_bookings_phone          ON bookings(phone_digits, created_at);
CREATE INDEX IF NOT EXISTS ix_bookings_preferred_date ON bookings(preferred_date);
CREATE INDEX IF NOT EXISTS ix_bookings_source         ON bookings(source, created_at);
CREATE INDEX IF NOT EXISTS ix_bookings_assigned       ON bookings(assigned_staff_id) WHERE assigned_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bookings_ip             ON bookings(ip_hash, created_at) WHERE ip_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_idempotency ON bookings(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_appointment ON bookings(appointment_id) WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS booking_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id    TEXT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  action        TEXT NOT NULL CHECK (action IN ('submitted', 'status', 'rescheduled', 'assigned', 'linked', 'note')),
  from_status   TEXT CHECK (from_status IS NULL OR from_status IN (
                  'New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Rejected', 'Completed')),
  to_status     TEXT CHECK (to_status IS NULL OR to_status IN (
                  'New', 'Pending', 'Confirmed', 'Rescheduled', 'Cancelled', 'Rejected', 'Completed')),
  detail        TEXT CHECK (detail IS NULL OR length(detail) <= 300),
  reason        TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  actor         TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_booking_history_booking ON booking_history(booking_id, id);

CREATE TABLE IF NOT EXISTS booking_notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id    TEXT NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  note          TEXT NOT NULL CHECK (length(trim(note)) > 0 AND length(note) <= 2000),
  created_by    TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 100),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_booking_notes_booking ON booking_notes(booking_id, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('bookings', 'BKG', 0);

-- Permissions (0018 catalogue): the built-in roles that already run the Social
-- Inbox (inbox.edit) get all four; Staff (front office) can see bookings when
-- it can see appointments. Only where the role still holds that permission, so
-- a role the owner has narrowed is not widened. Super Admin needs no rows.
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT rp.role_id, p.permission
    FROM role_permissions rp
    JOIN (SELECT 'bookings.view' AS permission UNION ALL SELECT 'bookings.create'
          UNION ALL SELECT 'bookings.edit' UNION ALL SELECT 'bookings.manage') p
   WHERE rp.permission = 'inbox.edit' AND rp.role_id IN ('ROL-0002', 'ROL-0003', 'ROL-0005');
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT role_id, 'bookings.view' FROM role_permissions
   WHERE permission = 'appointments.view' AND role_id = 'ROL-0008';
