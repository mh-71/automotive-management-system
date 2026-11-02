-- ===========================================================================
-- 0015 — Social Inbox › WhatsApp (WhatsApp Business Platform, Cloud API)
-- ---------------------------------------------------------------------------
-- Real WhatsApp conversations between the workshop's WhatsApp Business number
-- and its customers, written by the Meta webhook (POST /api/webhooks/whatsapp)
-- and by staff replies sent through the Cloud API. Additive only.
--
-- whatsapp_conversations  one row per business number + customer WhatsApp id
--                         ("wa_id", the customer's number): WAC-0001.
-- whatsapp_messages       every message in either direction, never deleted.
--                         INTEGER ids: a high-volume log, like activity_log.
--
-- No access token, app secret or verify token is ever stored here; they are
-- Worker secrets. Nothing deletes a message: the foreign key RESTRICTs
-- removing a conversation that has any.
--
-- Duplicate webhook deliveries (Meta retries) are absorbed by the unique index
-- on the WhatsApp message id ("wamid"); a staff reply sent twice from a retried
-- request is absorbed by the unique (conversation, client request id).
-- ===========================================================================

CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id                    TEXT PRIMARY KEY,                       -- 'WAC-0001', from id_counters
  phone_number_id       TEXT NOT NULL CHECK (length(phone_number_id) BETWEEN 1 AND 40),
  customer_wa_id        TEXT NOT NULL CHECK (length(customer_wa_id) BETWEEN 1 AND 20),
  customer_name         TEXT CHECK (customer_name IS NULL OR length(customer_name) <= 120),
  status                TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Pending', 'Resolved')),
  unread_count          INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message          TEXT CHECK (last_message IS NULL OR length(last_message) <= 300),
  last_message_at       TEXT,
  last_direction        TEXT CHECK (last_direction IS NULL OR last_direction IN ('in', 'out')),
  -- When the customer last wrote: WhatsApp's customer service window runs from here.
  last_inbound_at       TEXT,
  -- The member of staff the conversation is assigned to: a staff or mechanic id,
  -- checked against the roster by the API, with the name as it was when assigned.
  assigned_to_id        TEXT CHECK (assigned_to_id IS NULL OR length(assigned_to_id) <= 20),
  assigned_to_name      TEXT CHECK (assigned_to_name IS NULL OR length(assigned_to_name) <= 120),
  notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_at            TEXT NOT NULL,
  updated_at            TEXT,
  CHECK ((assigned_to_id IS NULL) = (assigned_to_name IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wac_number_customer ON whatsapp_conversations(phone_number_id, customer_wa_id);
CREATE INDEX IF NOT EXISTS ix_wac_last ON whatsapp_conversations(last_message_at, id);
CREATE INDEX IF NOT EXISTS ix_wac_status ON whatsapp_conversations(status);
CREATE INDEX IF NOT EXISTS ix_wac_assigned ON whatsapp_conversations(assigned_to_id);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id       TEXT NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE RESTRICT,
  wamid                 TEXT CHECK (wamid IS NULL OR length(wamid) BETWEEN 1 AND 200),
  direction             TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  sender_type           TEXT NOT NULL CHECK (sender_type IN ('customer', 'staff')),
  sent_by               TEXT CHECK (sent_by IS NULL OR length(sent_by) <= 100),
  -- text, or the type of a message this inbox shows only as a label
  -- (image, audio, video, document, sticker, location, contacts, button,
  -- interactive, reaction, unsupported).
  type                  TEXT NOT NULL DEFAULT 'text' CHECK (length(type) BETWEEN 1 AND 30),
  message_text          TEXT CHECK (message_text IS NULL OR length(message_text) <= 20000),
  status                TEXT NOT NULL CHECK (status IN ('received', 'sending', 'sent', 'delivered', 'read', 'failed')),
  error_code            TEXT CHECK (error_code IS NULL OR length(error_code) <= 40),
  error_message         TEXT CHECK (error_message IS NULL OR length(error_message) <= 300),
  client_request_id     TEXT CHECK (client_request_id IS NULL OR length(client_request_id) BETWEEN 8 AND 64),
  platform_timestamp    INTEGER,                                -- Meta's event time, seconds since the epoch
  created_at            TEXT NOT NULL,
  updated_at            TEXT,

  CHECK ((direction = 'in') = (sender_type = 'customer')),
  CHECK (direction = 'out' OR status = 'received'),
  CHECK (direction = 'in' OR status <> 'received')
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_wam_wamid ON whatsapp_messages(wamid) WHERE wamid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_wam_client_request
  ON whatsapp_messages(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_wam_conversation ON whatsapp_messages(conversation_id, id);

INSERT OR IGNORE INTO id_counters (collection, prefix, last_value) VALUES ('whatsappConversations', 'WAC', 0);
