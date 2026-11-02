-- ===========================================================================
-- 0020 — Offline sync (Phases 2-4): devices, the sync journal, conflicts,
--        invoice drafts, the offline stock-movement ledger and a change log.
-- ---------------------------------------------------------------------------
-- ADDITIVE ONLY. Every statement creates something new (IF NOT EXISTS / OR
-- IGNORE): no table, column, row or index that exists is dropped, altered or
-- deleted. The only writes to existing tables are:
--   * three new rows in id_counters (devices, sync conflicts, invoice drafts);
--   * two new permissions for the Admin role (ROL-0002): sync.view and
--     sync.manage -- the owner's decision that authorized Admins resolve
--     offline conflicts (Super Admin already holds every permission).
--
-- WHAT EACH TABLE IS FOR (see OFFLINE_SYSTEM.md)
--   devices              one row per browser that has synced: its UUID, a short
--                        server-assigned code used in temporary references
--                        (OFF-<code>-CUS-0007), and whether it was revoked.
--   device_accounts      which people have used which device, and when the
--                        server last authorized them there (the 14-day rule).
--   sync_ops             every offline operation a device pushed, keyed by the
--                        operation's own UUID: the idempotency record. A
--                        repeated push of the same UUID returns the stored
--                        answer and never applies the operation twice.
--   sync_conflicts       operations the server would not apply as they were
--                        (insufficient stock, a rejected payment, an edit made
--                        on a record someone else changed...). Kept, never
--                        deleted; resolved by an authorized Admin.
--   sync_conflict_events the append-only resolution history of each conflict.
--   invoice_drafts       invoices prepared offline: a draft has NO invoice
--                        number. Only an authorized online finalization creates
--                        the real invoice (with its official number).
--   offline_stock_movements  every parts-usage movement recorded offline:
--                        applied through the job card's own stock rules, or
--                        flagged for review. Append-only.
--   change_log           a server-side sequence of what changed (upsert or
--                        delete, by collection and id), written by triggers.
--                        Devices pull from it with a cursor -- a sequence
--                        number, never a client clock -- and deletes arrive as
--                        tombstones.
--
-- ROLLBACK (only if no device has synced through it; data in these tables
-- would be lost): DROP the triggers trg_cl_*, then DROP TABLE change_log, sync_ops_locks,
-- offline_stock_movements, invoice_drafts, sync_conflict_events,
-- sync_conflicts, sync_ops, device_accounts, devices; DELETE the three
-- id_counters rows and the two role_permissions rows. Existing tables are
-- untouched by this migration, so nothing else needs undoing.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS devices (
  id             TEXT PRIMARY KEY CHECK (length(id) = 36),   -- the browser's random UUID
  code           TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 8 AND code NOT GLOB '*[^A-Z]*'),
  label          TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  registered_by  TEXT NOT NULL,                               -- account id
  registered_at  TEXT NOT NULL,
  last_seen_at   TEXT,
  last_seen_by   TEXT,
  revoked_at     TEXT,
  revoked_by     TEXT,
  revoke_reason  TEXT NOT NULL DEFAULT '' CHECK (length(revoke_reason) <= 300)
);

CREATE TABLE IF NOT EXISTS device_accounts (
  device_id      TEXT NOT NULL REFERENCES devices(id),
  account_id     TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  authorized_at  TEXT NOT NULL,                               -- server time of the last online authorization
  PRIMARY KEY (device_id, account_id)
);

CREATE TABLE IF NOT EXISTS sync_ops (
  op_id            TEXT PRIMARY KEY CHECK (length(op_id) = 36),
  device_id        TEXT NOT NULL,
  account_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('create', 'update', 'status', 'payment', 'invoice_draft', 'parts_usage', 'stock_movement')),
  collection       TEXT,
  temp_id          TEXT,                                      -- the record's temporary reference, for a create
  target_id        TEXT,                                      -- the record an update / status / usage is for
  payload          TEXT NOT NULL,                             -- exactly what the device sent (JSON)
  status           TEXT NOT NULL CHECK (status IN ('processing', 'applied', 'conflict', 'rejected', 'dismissed')),
  result_id        TEXT,                                      -- the official server id, once applied
  result           TEXT,                                      -- the stored answer (JSON), replayed on a repeat
  local_created_at TEXT,
  received_at      TEXT NOT NULL,
  applied_at       TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_sync_ops_temp    ON sync_ops (device_id, temp_id);
CREATE INDEX IF NOT EXISTS ix_sync_ops_account ON sync_ops (account_id, received_at);
CREATE INDEX IF NOT EXISTS ix_sync_ops_status  ON sync_ops (status);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id              TEXT PRIMARY KEY,                           -- CNF-0001
  op_id           TEXT NOT NULL REFERENCES sync_ops(op_id),
  type            TEXT NOT NULL CHECK (type IN ('payment', 'invoice', 'inventory', 'edit', 'validation', 'permission', 'dependency', 'duplicate', 'interrupted')),
  severity        TEXT NOT NULL CHECK (severity IN ('financial', 'inventory', 'normal')),
  collection      TEXT,
  record_id       TEXT,
  temp_ref        TEXT,
  device_id       TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  details         TEXT NOT NULL DEFAULT '{}',                 -- local values, server values, the server's answer (JSON)
  status          TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved')),
  resolution      TEXT,
  resolution_note TEXT,
  resolved_by     TEXT,
  resolved_at     TEXT,
  result_id       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sync_conflicts_status ON sync_conflicts (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sync_conflicts_open_op ON sync_conflicts (op_id) WHERE status = 'Open';

CREATE TABLE IF NOT EXISTS sync_conflict_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conflict_id  TEXT NOT NULL REFERENCES sync_conflicts(id),
  at           TEXT NOT NULL,
  account_id   TEXT,
  action       TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  outcome      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_sync_conflict_events ON sync_conflict_events (conflict_id, id);

CREATE TABLE IF NOT EXISTS invoice_drafts (
  id              TEXT PRIMARY KEY,                           -- DRF-0001: never an invoice number
  job_card_id     TEXT NOT NULL REFERENCES job_cards(id),
  date            TEXT,
  notes           TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  status          TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Finalized', 'Discarded')),
  local_total     REAL,                                       -- the total the device saw when it drafted
  local_snapshot  TEXT NOT NULL DEFAULT '{}',                 -- the lines it saw (JSON), for pricing review
  invoice_id      TEXT REFERENCES invoices(id),               -- the real invoice, once finalized
  temp_ref        TEXT,
  op_id           TEXT UNIQUE,
  device_id       TEXT,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  finalized_by    TEXT,
  finalized_at    TEXT,
  discarded_by    TEXT,
  discarded_at    TEXT,
  discard_reason  TEXT NOT NULL DEFAULT '',
  updated_at      TEXT
);
CREATE INDEX IF NOT EXISTS ix_invoice_drafts_status ON invoice_drafts (status, created_at);
CREATE INDEX IF NOT EXISTS ix_invoice_drafts_job ON invoice_drafts (job_card_id);

CREATE TABLE IF NOT EXISTS offline_stock_movements (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id            TEXT NOT NULL UNIQUE,
  part_id          TEXT NOT NULL,
  job_card_id      TEXT,
  type             TEXT NOT NULL CHECK (type IN ('job-card-use', 'return')),
  quantity         REAL NOT NULL CHECK (quantity > 0),
  account_id       TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  local_created_at TEXT,
  received_at      TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('Applied', 'Review', 'Dismissed')),
  applied_at       TEXT,
  conflict_id      TEXT,
  updated_at       TEXT
);
CREATE INDEX IF NOT EXISTS ix_osm_status ON offline_stock_movements (status);
CREATE INDEX IF NOT EXISTS ix_osm_part ON offline_stock_movements (part_id);

-- A short advisory lock: two devices' parts usage on the same job card is
-- applied one after the other, so neither read-modify-write loses the other.
CREATE TABLE IF NOT EXISTS sync_ops_locks (
  key         TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS change_log (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  collection  TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  changed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_change_log_record ON change_log (collection, record_id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES
  ('devices', 'DEV', 0),
  ('syncConflicts', 'CNF', 0),
  ('invoiceDrafts', 'DRF', 0);

-- Owner decision: authorized Admins review and resolve offline conflicts.
-- Only added to the Admin role (ROL-0002) if that role still exists.
INSERT OR IGNORE INTO role_permissions (role_id, permission)
  SELECT 'ROL-0002', p FROM (SELECT 'sync.view' AS p UNION ALL SELECT 'sync.manage')
   WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'ROL-0002');

-- ---------------------------------------------------------------------------
-- change_log triggers. A line table's change is logged against its parent
-- (a job card's parts are part of the job card the devices pull).
-- ---------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_cl_customers_ins AFTER INSERT ON customers BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('customers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_customers_upd AFTER UPDATE ON customers BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('customers', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_customers_del AFTER DELETE ON customers BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('customers', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_vehicles_ins AFTER INSERT ON vehicles BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('vehicles', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_vehicles_upd AFTER UPDATE ON vehicles BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('vehicles', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_vehicles_del AFTER DELETE ON vehicles BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('vehicles', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_appointments_ins AFTER INSERT ON appointments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('appointments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_appointments_upd AFTER UPDATE ON appointments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('appointments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_appointments_del AFTER DELETE ON appointments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('appointments', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_cards_ins AFTER INSERT ON job_cards BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_cards_upd AFTER UPDATE ON job_cards BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_cards_del AFTER DELETE ON job_cards BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_services_ins AFTER INSERT ON services BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('services', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_services_upd AFTER UPDATE ON services BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('services', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_services_del AFTER DELETE ON services BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('services', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_mechanics_ins AFTER INSERT ON mechanics BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('mechanics', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_mechanics_upd AFTER UPDATE ON mechanics BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('mechanics', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_mechanics_del AFTER DELETE ON mechanics BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('mechanics', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_parts_ins AFTER INSERT ON parts BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('parts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_parts_upd AFTER UPDATE ON parts BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('parts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_parts_del AFTER DELETE ON parts BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('parts', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoices_ins AFTER INSERT ON invoices BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoices_upd AFTER UPDATE ON invoices BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoices_del AFTER DELETE ON invoices BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_payments_ins AFTER INSERT ON payments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('payments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_payments_upd AFTER UPDATE ON payments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('payments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_payments_del AFTER DELETE ON payments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('payments', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_expenses_ins AFTER INSERT ON expenses BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('expenses', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_expenses_upd AFTER UPDATE ON expenses BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('expenses', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_expenses_del AFTER DELETE ON expenses BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('expenses', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_inventory_transactions_ins AFTER INSERT ON inventory_transactions BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('inventoryTransactions', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_inventory_transactions_upd AFTER UPDATE ON inventory_transactions BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('inventoryTransactions', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_inventory_transactions_del AFTER DELETE ON inventory_transactions BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('inventoryTransactions', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_adjustments_ins AFTER INSERT ON invoice_adjustments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoiceAdjustments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_adjustments_upd AFTER UPDATE ON invoice_adjustments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoiceAdjustments', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_adjustments_del AFTER DELETE ON invoice_adjustments BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoiceAdjustments', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_card_services_ins AFTER INSERT ON job_card_services
  WHEN EXISTS (SELECT 1 FROM job_cards WHERE id = NEW.job_card_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', NEW.job_card_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_card_services_upd AFTER UPDATE ON job_card_services
  WHEN EXISTS (SELECT 1 FROM job_cards WHERE id = NEW.job_card_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', NEW.job_card_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_card_services_del AFTER DELETE ON job_card_services
  WHEN EXISTS (SELECT 1 FROM job_cards WHERE id = OLD.job_card_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', OLD.job_card_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_card_parts_ins AFTER INSERT ON job_card_parts
  WHEN EXISTS (SELECT 1 FROM job_cards WHERE id = NEW.job_card_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', NEW.job_card_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_card_parts_upd AFTER UPDATE ON job_card_parts
  WHEN EXISTS (SELECT 1 FROM job_cards WHERE id = NEW.job_card_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', NEW.job_card_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_job_card_parts_del AFTER DELETE ON job_card_parts
  WHEN EXISTS (SELECT 1 FROM job_cards WHERE id = OLD.job_card_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('jobCards', OLD.job_card_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_services_ins AFTER INSERT ON invoice_services
  WHEN EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', NEW.invoice_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_services_upd AFTER UPDATE ON invoice_services
  WHEN EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', NEW.invoice_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_services_del AFTER DELETE ON invoice_services
  WHEN EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', OLD.invoice_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_parts_ins AFTER INSERT ON invoice_parts
  WHEN EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', NEW.invoice_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_parts_upd AFTER UPDATE ON invoice_parts
  WHEN EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', NEW.invoice_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_parts_del AFTER DELETE ON invoice_parts
  WHEN EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoices', OLD.invoice_id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_drafts_ins AFTER INSERT ON invoice_drafts BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoiceDrafts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_drafts_upd AFTER UPDATE ON invoice_drafts BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoiceDrafts', NEW.id, 'upsert', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS trg_cl_invoice_drafts_del AFTER DELETE ON invoice_drafts BEGIN
  INSERT INTO change_log (collection, record_id, op, changed_at) VALUES ('invoiceDrafts', OLD.id, 'delete', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
