# Offline system — Taqwa Autos CRM

Status:
- **Phase 1:** the offline app shell and the encrypted offline copy.
- **Phases 2–4:** offline work, sync, financial and inventory safety, and conflict management.

Phases 2–4 implement the owner's final decisions:

| Decision | Result |
|---|---|
| Temporary IDs | **Yes.** |
| Offline payments | **Pending.** |
| Offline invoices | **Draft.** |
| Parts usage | **Flag for review.** |
| Conflict resolution | **Admin.** |
| Offline access | **14 days.** |

This document is the reference for how the CRM behaves without internet and how
data reaches the server. It also covers how the data on each computer is
protected, and how to deploy, test and roll back.

---

## 1. What works

| Situation | What happens |
|---|---|
| Online | Unchanged. Every read and write goes to the Worker and D1, checked by Roles & Permissions. After each page load, the person's **encrypted copy** is refreshed on this computer (at most every 2 minutes), and anything waiting is sent. |
| Internet lost, app opened | The app shell opens from the service worker. The person signs in **with the same identifier and password**. Their copy and their **journal** of offline changes open. |
| Offline, working | Changes are allowed for customers, vehicles, appointments, job cards (including services and parts), expenses, services and mechanics. They are **saved on this computer**, encrypted, and shown at once. Each new record gets a **temporary reference** such as `OFF-A-CUS-0007`. The bar says *"N changes waiting"*. |
| Offline, taking a payment | Saved as **PENDING**. It is not counted in any balance, advance or report, and is listed apart on the Payments page. |
| Offline, making an invoice | Saved as an **invoice DRAFT** with no invoice number, listed apart on the Invoices page. |
| Offline, recording parts or stock | The job card shows the parts. Stock does **not** change on this computer; the server applies the movement. |
| Offline, deleting / voiding / write-offs / accounts / roles / settings | Refused: *"… needs the internet."* Nothing is deleted offline. |
| Internet back | The engine sends the queue in order. The server gives official ids and applies every rule. Each change is marked **Synced only after the server accepts it**. Anything it would not apply becomes a **conflict** for an Admin, kept and never dropped. |
| Never signed in on this computer | Offline: "this computer has no saved offline copy yet". |

Each of the 2–3 computers is independent: its own service-worker cache, IndexedDB,
copies and journals. No computer depends on another, and no local server is needed.

---

## 2. Architecture

```
 ┌──────────────────────── one workshop computer (each is independent) ──────────────────────────┐
 │  Pages (existing modules, unchanged UI)                                                        │
 │      │  Storage.getData / create / update / action                                             │
 │      ▼                                                                                         │
 │  js/storage.js ── 'api'     ─► js/api.js ── fetch /api/* ─────────────────────────┐             │
 │      │         ── 'offline' ─► js/sync.js  (repository layer: local or remote)    │             │
 │      │                          outbox · temp refs · pending payments · drafts    │             │
 │      │                          engine: push ▸ pull ▸ refresh copy (online)       │             │
 │      ▼                                                                            │             │
 │  js/offline.js ── IndexedDB "taqwa-offline" v2                                    │             │
 │     meta       device UUID, server code (A, B, …), reference counters, revoked    │             │
 │     users      per person: public key; private key wrapped by PBKDF2(password)    │             │
 │     snapshots  per person: AES-256-GCM copy of what the role could read           │             │
 │     journals   per person: AES-256-GCM journal (local records + outbox + history) │             │
 │                key wrapped by the public key (password) AND by a server escrow    │             │
 │  sw.js ── Cache Storage "taqwa-shell-<version>": pages, scripts, styles, images   │             │
 └───────────────────────────────────────────────────────────────────────────────────┼─────────────┘
                                                                                     │ internet
          ┌──────────────────────────────────────────────────────────────────────────▼──────────┐
          │ Cloudflare Worker: auth gate · roles · existing routes (all business rules)         │
          │   /api/devices/*  /api/sync/push|pull|status|history|conflicts  /api/invoice-drafts │
          │   push applies each operation THROUGH the existing route, as its author             │
          │   the router logs every successful write to change_log (cursor, tombstones)         │
          │ D1 (the only source of truth) + the 0020 tables                                     │
          └─────────────────────────────────────────────────────────────────────────────────────┘
```

### Files

| File | Role |
|---|---|
| `sw.js`, `js/version.js`, `js/sw-assets.js`, `tools/sw-assets.mjs` | The offline app shell (Phase 1). |
| `js/offline.js` | IndexedDB, device, enrolment, the encrypted copy and journal, the 14-day window and clock guard, revocation. |
| `js/sync.js` | **New.** The local repository, the outbox, temporary references, pending payments, drafts, parts movements, and the sync engine. |
| `js/storage.js` | Hands offline writes to `Sync`, opens the journal online and offline, and saves only server-confirmed records in the copy. |
| `js/app.js` | Offline unlock screen and offline bar (live count). Starts sync on open, back online, focus and a timer. Shows the pending panels. |
| `pages/offline-sync.html`, `js/offline-sync.js` | Offline & Sync page: real counts, Sync now, Retry failed, pending list, history. |
| `pages/sync-conflicts.html`, `js/sync-conflicts.js` | **New.** Conflict Center: conflicts and invoice drafts. |
| `migrations/0020_offline_sync.sql` | **New, additive.** |
| `src/routes/sync.js` | **New.** Devices, push, pull, status, history, conflicts, invoice drafts. |
| `src/lib/changes.js` | **New.** The change log, written by the router after every successful write. |

---

## 3. Server schema (migration 0020, additive only)

| Table | Purpose |
|---|---|
| `devices` | One row per browser that registered. `id` is the browser's UUID; `code` is a short server-assigned code (`A`, `B`, … `AA`) used in temporary references. Also holds the registering account, last seen, and revoked at / by / reason. |
| `device_accounts` | Who used which device, and `authorized_at`: the server time of their last online authorization there. |
| `sync_ops` | **Idempotency journal.** Primary key is the operation UUID. Holds the device, account, kind, collection, temporary reference, target, exact payload, status, official result id, stored answer, and both local and server timestamps. |
| `sync_conflicts`, `sync_conflict_events` | Conflicts (type, severity, record, device, person, reason, device-vs-server values, resolution) and their append-only history. |
| `invoice_drafts` | Invoices made offline: `DRF-0001`, never an invoice number. Holds the job card, the total the device saw, the status (Draft, Finalized or Discarded), the real invoice once finalized, and who did what and when. |
| `offline_stock_movements` | Append-only ledger of offline parts usage. Holds the part, job card, type (use or return), quantity, person, device, local and server time, and status (Applied, Review or Dismissed). |
| `sync_ops_locks` | Short advisory lock per job card, so two devices' parts usage is applied one after the other. |
| `change_log` | `seq` (the cursor), collection, record id, and `op`: `upsert`, `delete` (a tombstone) or `refresh` (a collection the write also moved). |

The only rows 0020 writes into existing tables:
- three `id_counters` rows: devices, syncConflicts and invoiceDrafts;
- `sync.view` and `sync.manage` for the Admin role, ROL-0002 (owner decision 5). Super Admin already holds every permission.

**Change log not by triggers.** The real-D1 integration run showed that D1
counts trigger-written rows in `meta.changes`. Existing write guards depend on
that count (for example, stock movements check that exactly one row changed).
So `src/lib/changes.js` writes the log as one statement after the route has
answered 2xx. A logging failure is reported and never fails the write; a device
then catches up at its next full online load.

New permissions:
- `sync.view`: see every device, sync history and conflict;
- `sync.manage`: resolve conflicts and revoke devices.

Every account can always see and act on its **own** device, pushes, pulls,
history and conflicts.

---

## 4. Local schema (IndexedDB `taqwa-offline`, version 2)

| Store | Key | Contents |
|---|---|---|
| `meta` | `key` | `device`: the UUID and the server code. `seq`: the reference counters, device-wide, so two people on one computer never make the same reference. `revoked`: set when the server says the device was revoked. |
| `users` | `accountId` | The person's public key; the private key wrapped by PBKDF2-SHA-256 (310,000 rounds); identifiers; and `lastOnlineAt` / `lastSeenAt` (the clock guard). |
| `snapshots` | `accountId` | The encrypted copy. It holds **only server-confirmed records**, plus `cursor`, `authorizedAt` (server time) and `clientAt`. |
| `journals` | `accountId` | The encrypted journal (`iv`, `ciphertext`), plus the two wraps of its key: `rsaWrap` (the password) and `escrowWrap` (the server escrow). Also plain **counts** (pending, conflict, failed): nothing else is readable. |

The decrypted journal contains:
- `records`: the local versions of records made or edited offline, each with `_sync` (state, temporary reference, person, device, time);
- `bases`: the server version of each edited record;
- `localOnly`: pending payments, invoice drafts and stock movements;
- `outbox`: the operations;
- `history`;
- `idMap`: temporary reference → server id.

**Removing a copy never removes the journal.** Unsynced work leaves only by being
accepted, or decided, on the server.

---

## 5. Temporary IDs (owner decision 1)

**Format:** `OFF-<device code>-<prefix>-<number>`, for example `OFF-A-CUS-0007`.
- Every record also gets a random **UUID**.
- Before a computer's first online registration, the code is `X` plus 5 hex characters of its UUID (still unique).

**On push**, the server:
- resolves every temporary reference in an operation (as the record itself, or inside its fields) to the official id;
- refuses an operation that depends on a reference it has not accepted yet: it is retried later, or becomes a **dependency** conflict if that reference was refused.

**The server never uses a temporary reference as a key.** It is kept in
`sync_ops.temp_id` (and `invoice_drafts.temp_ref`) beside `result_id`, for audit.

After acceptance, the device rewrites the reference everywhere it still holds it:
local records, the queue and what is on screen.

---

## 6. Sync protocol

### Push: `POST /api/sync/push { deviceId, ops: [...] }`

At most 50 operations per batch; the client sends batches of 25.

Each operation is `{ opId (UUID), kind, collection, tempId?, targetId?, data, base?, createdAt }`.
The `kind` is one of `create`, `update`, `status`, `payment`, `invoice_draft`,
`parts_usage` or `stock_movement`.

The server works in the order sent: the device sends in the order the changes were made.

1. **Claim.** `INSERT OR IGNORE` into `sync_ops` with status `processing`.
   - **The same UUID again** (a lost answer, a retry, another tab) returns the stored answer marked `replayed`. It is never applied twice.
   - **The same UUID from another device or person** is refused.
   - **An earlier claim still in progress** returns `retry`.
   - **A claim older than 2 minutes with no answer** means the first attempt was cut off. It becomes an **interrupted** conflict for review, never a blind re-post (that could record a payment twice).
2. **Permission.** The author's own permission for the change is checked first.
3. **Apply through the existing route, as the author.** The Worker calls itself with the author's own session cookie, so validation, Roles & Permissions, stock rules, balance rules, activity log and notifications are exactly as online.
4. **Answer.**

   | Answer | Meaning |
   |---|---|
   | `applied` | With `serverId` and the server's record. |
   | `conflict` | With `conflictId`, type and reason. |
   | `rejected` | Malformed. |
   | `dismissed` | An Admin decided not to apply it. |
   | `retry` | 5xx, or a dependency still on its way. The claim is released; the route's write rolled back. |

   A `401` stops the batch.

### Pull: `GET /api/sync/pull?deviceId&cursor&limit`

- The cursor is the **server's** `change_log.seq`, never a client clock.
- **Paging:** `hasMore` is set when there are more pages; the last entry per record wins.
- `upsert` carries the record as the person's role may read it.
- `delete` is a tombstone.
- `refresh` asks the device to re-read a collection the write also moved (a payment moves its invoice).
- `hidden` means the role may not read it.
- The client applies a page, re-reads any `refresh` collections, and only then moves its cursor. An interrupted pull restarts from the last cursor: upserts are idempotent.
- `GET /api/session` gives a personal account its `syncCursor` and `serverTime`. Data read after that answer is at least that new, so the copy saved from it carries a safe cursor.

### Engine (client)

- **When it runs:**
  - on opening the app online;
  - on the browser's `online` event;
  - when the tab comes to the front;
  - every minute while something waits;
  - on **Sync now**.
- **Ordering and safety:**
  - one run at a time per person (Web Locks);
  - the journal is re-read before every change, so two tabs never overwrite each other.
- **Push in order:**

  | Answer | What the engine does |
  |---|---|
  | `applied` | Takes the server id and record, and rewrites references. |
  | `conflict` | Keeps the operation, marked *Needs review*. |
  | `rejected` | Keeps the operation, marked *Failed*. |
  | `retry` | Exponential back-off: 2 s, 4 s, … up to 10 min. |
  | Network error | Back-off. |
  | `401` | Stops and asks for a sign-in. |
  | `device_revoked` | Stops and closes offline access. |

- **Pull:** pulls from the page's cursor, then refreshes the encrypted copy.

### Status, history, devices

| Endpoint | What it does |
|---|---|
| `GET /api/sync/status?deviceId` | Server time, cursor, this person's operations by status, open conflicts, drafts and inventory review counts. Renews the 14-day authorization. |
| `GET /api/sync/history` | Operations received. |
| `POST /api/devices/register` | Registers the device: code, server time, `offlineUntil`, escrow. |
| `GET /api/devices` | Lists devices. |
| `DELETE /api/devices/:id` | Revokes a device. The row is kept. |

---

## 7. Financial rules

### Payments: PENDING (owner decision 2)

**While pending:**
- Kept in the journal's `localOnly.payments`, **never** in the payments the app reads.
- So no invoice balance, job-card advance, receivable or report counts it.
- It is shown on the Payments page under *"Pending payments — not confirmed"*.
- Preserved:

  | Kept | Fields |
  |---|---|
  | What | amount, method, reference, date |
  | For whom | customer, invoice / job card |
  | By | person, device |
  | Ids | temporary reference, operation UUID |

**On push**, the server:
1. holds a payment with the same customer, amount, date, method and invoice / job card as an existing active one, as a **duplicate** (financial) conflict, not applied;
2. otherwise applies it through `POST /api/payments`, with the same overpayment rule and the same balance recomputation.

Notes keep the reference and `Offline OFF-…`.

**After the server answers:**
- **Accepted:** it becomes a normal payment, and balances move only now.
- **Refused** (overpayment, a voided invoice, a permission): a **payment** conflict. The device keeps the entry, marked *Needs review*.
- **Dismissed:** marked *Not accepted*, kept.
- **Never deleted silently.**

### Invoices: DRAFT (owner decision 3)

- Offline, *Create Invoice* saves a draft: no number, no invoice. The job card is not marked invoiced.
- The server stores it in `invoice_drafts` (`DRF-…`).
- **Finalize** (Conflict Center, needs `invoices.create`) calls the existing `POST /api/invoices`. It copies the job card's **current** lines and totals, and gets the official `INV-…` number.
- If the job card's total differs from what the device saw, finalization stops with *pricing_changed* until someone confirms the current pricing.
- A finalized draft cannot be finalized again.
- **Discard** keeps the draft with a reason.

---

## 8. Inventory (owner decision 4)

**Offline:**
- A change to a job card's parts becomes **per-part movements**: `+n` use and `-n` return.
- The full parts array is never overwritten.
- Stock on the computer does not change.

**On push, the server:**
1. takes a short lock on the job card;
2. reads its **current** lines and adds or removes the quantity;
3. prices a new inventory line from the server's part price;
4. saves through `PUT /api/job-cards/:id`. For a job already in progress, that route reconciles stock against the ledger and refuses a shortage.

**The movement** is recorded in `offline_stock_movements`:
- **Applied** when the job card route accepts it;
- **Review** with an **inventory** conflict when stock is short or the line is gone. Stock is never overwritten, never taken below zero, and the movement is never discarded.

**After a conflict:**
- An Admin retries after stock arrives, or dismisses it with a reason.

**Other movements:**
- Manual stock movements made offline go through `POST /api/inventory-transactions`, under the same guard.
- A job-card **status** change made offline (for example *In Progress*, which deducts stock) carries the status it started from. If the job card moved meanwhile, it is a conflict.

---

## 9. Conflicts (owner decision 5)

### Types

| Type | Cause |
|---|---|
| **edit** | A field this device changed was also changed on the server since the device saw it. The check is field by field; changes to different fields both apply. There is **no last-write-wins**. |
| **payment** | A payment refused by the payments route. |
| **duplicate** | A payment that matches an existing active one. |
| **invoice** | An invoice draft refused. |
| **inventory** | A shortage, or a line missing. |
| **permission** | The author's role does not allow the change. |
| **validation** | The route refused the values. |
| **dependency** | A record this change needs was refused. |
| **interrupted** | A first attempt was cut off mid-way. |

**Severity:**
- `financial`: payments, drafts, expenses;
- `inventory`;
- `normal`.

### Conflict Center

Page: **Offline & Sync → View conflicts**.

**What it shows:**
- the type, record, device code and person, and when it was made offline;
- the reason and the server's own message (and shortages);
- **the device's values beside the server's**, and what both started from;
- the available actions;
- the full history.

**Who can do what:**
- Only `sync.manage` resolves: authorized Admins, and Super Admin. This is checked on the **server**; the page only hides buttons.
- Financial and inventory decisions **require a written reason**.
- Everyone else sees their own conflicts, read-only.

**Actions:**

| Action | Effect |
|---|---|
| `retry` | Apply now, with the same checks. |
| `apply_local` | Edit: apply the device's value. |
| `keep_server` | Edit: keep the server's value. |
| `apply_anyway` | Duplicate payment: record it. |
| `mark_applied` | Interrupted: name the record that was saved. |
| `dismiss` | Do not apply. |

A retry that fails again stays open, with the attempt in its history.

The device learns the decision at its next sync (`applied` or `dismissed`).

---

## 10. Offline access: 14 days (owner decision 6)

- **The window:** a copy opens for **14 days from the SERVER's time** at the person's last online authorization on that computer.
  - That time comes from `GET /api/session`.
  - It is saved **inside** the authenticated, encrypted copy, with this computer's clock offset at that moment.
  - Every online page load, and every status or register call, renews it. The server also records it in `device_accounts.authorized_at`.
- **Clock moved back:**
  - earlier than that authorization, or more than 10 minutes earlier than the latest time this copy was seen: the copy is refused (*"date and time are earlier…"*);
  - a clock moved forward only makes it expire sooner.
- **Clearing site data** removes the copy itself, so it cannot extend access. It also removes unsynced work: the page warns first.
- **No reusable credentials are stored:**
  - no plaintext password;
  - no server token;
  - the session cookie stays HttpOnly.
- **Permissions:** cached permissions are those saved in the copy, and expire with it.

**Limits, stated plainly.** All of this is enforced by code on the person's own
computer:
- Someone who knows the password and uses developer tools could defeat the client-side age and clock checks on that computer.
- **Revocation reaches an offline computer only when it reconnects.** Account deactivation, password reset, role change and device revocation then take effect at once, because every push and pull is checked by the server: an inactive account's session is refused, and a revoked device gets `device_revoked`.
- Nothing the person does offline is applied without passing the server's checks under their **current** account and role.
- Users cannot be created and roles cannot be changed offline.

---

## 11. Devices

- **Registration:** a computer registers on the first online page load of a personal account.
- **Revoking:**
  - Admins (`sync.manage`) can revoke any device, and a person can revoke their own: `DELETE /api/devices/:id`, with a reason.
  - A revoked device cannot register, push, pull or renew its window.
  - The computer then refuses to open offline copies, and keeps the unsynced journal, never deleting it.
  - The device row is kept.
- **Using that browser again:** clear its site data (a new UUID), then sign in online.
- **No device-management page yet:** `GET /api/devices` and `DELETE /api/devices/:id` are API only.

---

## 12. Backup and restore

- **Cloud:**
  - D1 is the source of truth;
  - back up before the production migration: `wrangler d1 export taqwa-prod --remote --output backup-YYYYMMDD.sql`, kept **outside** the repository;
  - the 0020 tables are included in the export.
- **Unsynced work on a computer:**
  - It exists only in that browser's journal until it syncs.
  - It is encrypted, and survives refreshes, restarts and removing copies.
  - It is lost if the site data is cleared or the computer dies before syncing: sync before maintenance.
  - The Offline & Sync counts must show **0 waiting**.
- **Device loss:**
  - Revoke the device: `DELETE /api/devices/:id`.
  - Reset the passwords of the accounts used on it.
  - The copy and journal on it are encrypted under those passwords and the escrow.
- **Restore:**
  - restoring D1 from a backup does not restore a computer's unsynced journal;
  - after a restore, devices re-read everything on their next full online load.

---

## 13. Installation (each computer)

1. Open `https://app.taqwa.autos/` in **Chrome or Edge** while online.
2. Sign in with **your own account**. The shared passphrase gives no offline access.
3. Optionally install it as an app (address bar → *Install*).
4. Use any page once:
   - the shell is cached;
   - the computer registers (Offline & Sync shows *Code A*);
   - your copy is saved.
5. Check **Offline & Sync**. It should show the app installed, your copy, and the computer's code.

Repeat for each person on each computer.

---

## 14. Per-module capability (offline)

| Module | Read | Create | Edit | Delete | Notes |
|---|---|---|---|---|---|
| Customers, Vehicles | ✔ | ✔ | ✔ | online | Temporary references; field-level conflicts. |
| Appointments | ✔ | ✔ | ✔ | online | |
| Job Cards (and their service and part lines) | ✔ | ✔ | ✔ + status | online | Parts become movements; status carries its base. |
| Invoices | ✔ | **draft** | online | online | No number offline; finalized online. |
| Payments | ✔ | **pending** | online | online | Void and link: online. |
| Expenses | ✔ | ✔ | ✔ | online | Financial severity on conflict. |
| Inventory parts | ✔ | online | online | online | Stock changes only through movements. |
| Inventory movements | ✔ | ✔ (queued) | — | — | Applied by the server's guard. |
| Services, Mechanics | ✔ | ✔ | ✔ | online | |
| Dashboard, Reports | ✔ | — | — | — | Computed from the copy (confirmed records only). |
| Estimates, Attendance, Workshop Assets, Notifications, Staff, CRM, Inbox | online | online | online | online | Read on demand, not in the copy. **Not offline yet.** |
| Accounts, Roles, Settings | online | online | online | online | Never offline (by design). |

---

## 15. Testing

```bash
npm test                     # unit: api-sync (86), offline-sync-client (46), offline-store, storage-offline, ...
npm run test:integration     # Worker + local D1 (needs: npm run db:migrate:local)
```

- **`tests/unit/api-sync.test.mjs`**: the real Worker on an in-memory database built from the migrations. It covers:
  - the migration (additive, no triggers);
  - devices, registration and the escrow;
  - temporary references and dependency order;
  - idempotency, operation-id reuse and interrupted operations;
  - payments (duplicate, overpayment, Admin-only resolution with a note);
  - drafts (permissions, pricing change, single finalization);
  - parts usage (applied, flagged, retried after stock, returns, ledger integrity);
  - field-level edits;
  - pull (cursor, pages, tombstones, refresh, hidden);
  - revocation.
- **`tests/unit/offline-sync-client.test.cjs`**: the real `storage.js`, `offline.js` and `sync.js` with WebCrypto. It covers:
  - offline create and edit, permissions and online-only refusals;
  - pending payments kept out of balances, and drafts;
  - parts movements and status;
  - persistence after refresh, and encryption at rest;
  - the 14-day window, clock rollback and revocation;
  - the engine: order, id rewrite, conflicts, failures, back-off, network loss, sign-in, Retry failed;
  - copy integrity, the escrow, two tabs, and the key-wrap race.
- **Two-computer browser scenario** (Playwright, two independent browser contexts, `wrangler dev --local`, fictional data): sign in online on both computers, go offline, create records on each, then reconnect and check the results. The script is not committed; it runs against a local Worker only.

---

## 16. Known limitations

- **Estimates, attendance, workshop assets, notifications, staff, CRM and inbox** are not available offline. They are read on demand and are not in the copy.
- **Changing only the unit price** of an existing inventory part line offline is not sent. Quantity changes are, and the server prices new lines.
- **Online UI edits are not serialized with offline usage.** Offline parts usage on the same job card is serialized on the server by a lock. An online edit of the same job card's whole parts list at the same moment is not covered by it: that is existing behaviour.
- **Possible-duplicate payment detection** matches the same customer, amount, date, method and invoice / job card. Two genuine identical payments are held for an Admin's decision.
- **Client-side 14-day and clock checks** can be defeated by the password holder with developer tools on their own computer (§10). The server re-checks everything on reconnect.
- **Rotating `AUTH_SECRET`** invalidates journal escrows. Journals still open with the password, and the escrow is rewrapped at the next sync.
- **The change log** is written after a write commits. If that insert fails, the device catches up at its next full online load.
- **Sync history across devices:** the Offline & Sync page shows this computer's journal history. The server history (`GET /api/sync/history`) has no page yet.

---

## 17. Deployment

Do not deploy or migrate without approval.

1. **Before deploying:**
   - Review and merge the PRs. This branch is **stacked on PR #93** (Phase 1), which must be merged first.
   - **Back up D1:** `wrangler d1 export taqwa-prod --remote --output backup-YYYYMMDD.sql`.
2. **Apply the migration:** `wrangler d1 migrations apply taqwa-prod --remote`. Migration 0020 is additive.
3. **Before every deploy that changes a page, script, style or image:**
   - bump `TAQWA_VERSION` (now `2026.11.02-offline.2`);
   - run `node tools/sw-assets.mjs`;
   - commit both. `npm test` fails if the list is stale.
4. **Deploy the Worker:** see `DEPLOYMENT.md`. The Worker works before the migration too: sync routes answer `not_migrated` (503), and writes are never blocked by the change log.
5. **Verify with two computers:**
   - sign in online on each, and check Offline & Sync shows *Code A* / *Code B*;
   - go offline, add a customer, then come back online: it gets a `CUS-` id;
   - the Conflict Center opens for an Admin.

### Rollback

- **Code rollback (Worker + pages)** is safe:
  - the old code ignores the 0020 tables;
  - the service worker is network-first, so browsers get the old pages online.
  - Changes waiting on a computer stay in its journal, to be sent when the new code is back. **Do not roll back while computers have unsynced work** unless they will get the new code again.
- **Database:** leave 0020 in place. Its tables are additive and unused by old code. The documented `DROP` steps are at the top of the migration, for a database where no device has synced.
- **To remove the service worker from every browser,** deploy this as `sw.js`:

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('taqwa-shell-')) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll()) c.navigate(c.url);
})()));
```
