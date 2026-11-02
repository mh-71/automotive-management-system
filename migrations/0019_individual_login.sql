-- ===========================================================================
-- 0019 — Individual staff login
-- ---------------------------------------------------------------------------
-- Lets each staff member sign in with their own username, e-mail address or
-- Staff ID (MEC-0001 / STF-0001) and password, in one field, and gives the
-- workshop a controlled way off the shared passphrase.
--
-- user_accounts.email      optional login e-mail, lower case, unique ignoring
--                          case. Existing accounts get NULL: no address is
--                          invented or copied; an administrator adds one.
-- user_accounts.mobile     optional contact number for the account.
-- user_accounts.password_change_required
--                          1 = the password was set by someone else (a new
--                          account, or an administrator's reset): the person
--                          must choose their own at their next sign-in before
--                          anything else works. Existing accounts: 0, so
--                          nobody is forced through a change unexpectedly.
-- auth_throttle            failed sign-in counts per client address and per
--                          identifier, for a short window, so guessing is
--                          slowed down. Keys are salted SHA-256 hashes: no IP
--                          address, username or e-mail is stored here.
-- auth_settings            one row: whether the shared workshop passphrase may
--                          still sign in. Starts ENABLED (today's behaviour);
--                          a Super Admin signed in with their own account
--                          switches it off once individual login is verified.
--
-- ADDITIVE ONLY: three nullable / defaulted columns, two new tables, no
-- existing row or value changed. A Worker built before this file ignores all
-- of it. ALTER TABLE ... ADD COLUMN is not re-runnable (D1 applies each
-- migration once); everything else is IF NOT EXISTS / OR IGNORE.
-- ===========================================================================

ALTER TABLE user_accounts ADD COLUMN email TEXT
  CHECK (email IS NULL OR (length(email) BETWEEN 6 AND 160 AND email = lower(email) AND email GLOB '?*@?*.?*' AND email NOT GLOB '* *'));
ALTER TABLE user_accounts ADD COLUMN mobile TEXT
  CHECK (mobile IS NULL OR length(mobile) BETWEEN 6 AND 20);
ALTER TABLE user_accounts ADD COLUMN password_change_required INTEGER NOT NULL DEFAULT 0
  CHECK (password_change_required IN (0, 1));

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_email ON user_accounts (email COLLATE NOCASE) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_throttle (
  key           TEXT PRIMARY KEY CHECK (length(key) BETWEEN 10 AND 80),   -- 'ip:<sha256>' / 'id:<sha256>'
  window_start  TEXT NOT NULL,
  failures      INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_auth_throttle_window ON auth_throttle (window_start);

CREATE TABLE IF NOT EXISTS auth_settings (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  passphrase_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (passphrase_enabled IN (0, 1)),
  updated_at           TEXT,
  updated_by           TEXT CHECK (updated_by IS NULL OR length(updated_by) <= 100)
);
INSERT OR IGNORE INTO auth_settings (id, passphrase_enabled) VALUES (1, 1);
