# Offline system — Taqwa Autos CRM

Status: **Phase 1 implemented** (offline app shell + encrypted read-only copy).
Phases 2–4 (saving changes offline and synchronising them) are **designed here
but not implemented**; they need the decisions listed in §9 first.

This document is the reference for how the CRM behaves without internet, how
the data on each computer is protected, and how to deploy, troubleshoot and roll
back.

---

## 1. What works today (Phase 1)

| Situation | What happens |
|---|---|
| Online | Unchanged. Every read and write goes to the Worker and D1, checked by Roles & Permissions. |
| Online, after each page load | The signed-in person's **encrypted copy** of what their role could read is refreshed on this computer (at most every 2 minutes). |
| Internet lost, app opened | The app shell opens from the service worker. The person signs in **with the same identifier and password**; the copy saved on *this* computer opens **read-only**. |
| Offline, trying to save | Refused on every screen with: *"You are offline. This is a read-only copy: changes can be saved when the internet is back."* Nothing is queued, so nothing can be lost or duplicated. |
| Internet back | A bar offers **Go online**; the person signs in online as usual. |
| Never signed in on this computer | Offline: "this computer has no saved offline copy yet". |

Each of the 2–3 computers works independently: its own service-worker cache,
its own IndexedDB, its own copies. No computer depends on another, and no local
server is needed.

**Not in Phase 1:** creating or changing records offline, a sync queue,
conflict handling. See §8–§9.

### Why Phase 1 stops at read-only

Inspection of the code found that offline writes cannot be bolted on safely:

1. **Every id is allocated by the server** (`id_counters`: `CUS-0001`,
   `INV-0042`, ...). Two offline computers cannot safely invent the next
   number.
2. **The business rules live in the Worker**: stock deduction and restoration
   on job-card status changes, invoice totals and balances, payment rebalancing
   and write-offs, estimate conversion, appointment syncing. Re-implementing
   them in the browser would create a second, diverging source of truth for
   money and stock.
3. **There is no server change feed**: no change sequence, no tombstones, and
   several collections are hard-deleted. Incremental pull and reliable
   multi-device sync need a server-side cursor first.
4. **The old fallback was unsafe**: when the server could not be reached, the
   app switched to a browser-only store seeded with *demo* data and accepted
   writes that never reached D1 (only a toast warned). Phase 1 removes that
   path from the deployed app.

---

## 2. Architecture

```
 ┌──────────────────────── one workshop computer (each is independent) ─────────────────────────┐
 │                                                                                               │
 │  Pages (HTML/JS, unchanged modules)                                                           │
 │      │  Storage.getData / create / update ...                                                 │
 │      ▼                                                                                        │
 │  js/storage.js  ── mode 'api' ──────────────► js/api.js ── fetch /api/* ──┐                   │
 │      │          ── mode 'offline' (read-only) ◄─────────┐                 │                   │
 │      │                                                  │                 │                   │
 │      ▼                                                  │                 │                   │
 │  js/offline.js  ── IndexedDB "taqwa-offline" ───────────┘                 │                   │
 │     users:     id, name, role, identifiers, public key,                   │                   │
 │                private key wrapped by PBKDF2(password)                    │                   │
 │     snapshots: AES-256-GCM copy, key sealed with the public key           │                   │
 │     meta:      device UUID                                                │                   │
 │                                                                           │                   │
 │  sw.js (service worker) ── Cache Storage "taqwa-shell-<version>"          │                   │
 │     pages, scripts, styles, images ONLY (never /api/*)                    │                   │
 └───────────────────────────────────────────────────────────────────────────┼───────────────────┘
                                                                             │ internet
                                                     ┌───────────────────────▼──────────────────┐
                                                     │ Cloudflare Worker (auth, roles, rules)   │
                                                     │            │                             │
                                                     │            ▼                             │
                                                     │ D1 taqwa-prod (the only source of truth) │
                                                     └──────────────────────────────────────────┘
```

### Files

| File | Role |
|---|---|
| `sw.js` | Service worker: pre-caches the shell, network-first, never touches `/api/*`. |
| `js/version.js` | `TAQWA_VERSION`: cache name and the version shown in the footer. |
| `js/sw-assets.js` | Generated list of files to pre-cache (`node tools/sw-assets.mjs`). |
| `tools/sw-assets.mjs` | Generator for the list; a unit test fails if it is stale. |
| `js/offline.js` | IndexedDB store, device id, enrolment, sealing, unlocking. |
| `js/storage.js` | `offline` mode: reads from the copy, refuses every write. |
| `js/app.js` | Offline unlock screen, offline bar, footer status, service-worker registration. |
| `pages/offline-sync.html`, `js/offline-sync.js`, `css/offline-sync.css` | Offline & Sync page. |

---

## 3. Installation (each computer)

1. Open `https://app.taqwa.autos/` in **Chrome or Edge** while online.
2. Sign in with **your own account** (username, e-mail or Staff ID) and
   password. The shared passphrase gives no offline copy, because there is no
   person to protect it for.
3. Optionally install it as an app: the browser's *Install Taqwa ASC* button
   in the address bar, or menu → *Install app*.
4. Use any page once. The shell is cached in the background, and your copy is
   saved about 2 seconds after each page loads (at most every 2 minutes).
5. Check **Offline & Sync** (the link at the bottom of the sidebar). It should
   show *"The offline app is installed and in use"* and a row with your name and
   *Copy saved*.

Repeat on each computer, for each person who needs offline access there.

---

## 4. Local database (IndexedDB `taqwa-offline`, schema version 1)

| Store | Key | Contents |
|---|---|---|
| `meta` | `key` | `{ key: 'device', deviceId, createdAt }`: a random UUID per browser profile. |
| `users` | `accountId` | `accountId, username, name, staffId, role, identifiers[]`, the RSA-OAEP **public** key (SPKI), and the **private** key wrapped with AES-GCM under PBKDF2-SHA-256 (310,000 rounds, 16-byte salt). `lastOnlineAt, enrolledAt`. |
| `snapshots` | `accountId` | `iv, ciphertext` (AES-256-GCM of the JSON copy), `wrappedKey` (the AES key, RSA-OAEP-sealed), `savedAt, size, schema`. |

- **The copy** holds the core collections the role could read at that page
  load: customers, vehicles, appointments, job cards, services, mechanics,
  parts, invoices, payments, expenses, inventory movements and invoice
  adjustments. It also holds the settings, the role's permissions, and which
  collections the role was refused.
- **Not in the copy:** on-demand pages (estimates, staff, attendance, leave,
  follow-ups, tools, roles, accounts, notifications, inbox). Offline they say
  they need a connection.
- **Schema upgrades:** handled in `onupgradeneeded` by version number. A new
  version only adds stores and never deletes data.

---

## 5. Security

| Requirement | How |
|---|---|
| Previous online sign-in needed | A person can be enrolled on a computer only right after a successful **online** password sign-in (or own-password change) there. |
| No plaintext passwords | The password is used once to derive a key, then dropped; it is never stored. A wrong password is detected because AES-GCM authentication fails. |
| No reusable server credential stored | The session cookie stays HttpOnly and is never copied; offline needs no server token. |
| Data protected at rest | AES-256-GCM. The key opens only with the person's private key, which opens only with their password. |
| User- and device-specific | One key pair and one copy per person per browser profile. Another person's password does not open it, and a person not enrolled here cannot open anything. |
| No offline admin | There is no default account. Offline, a person sees only what their own role could read when the copy was saved, and the role's page restrictions still apply. |
| No offline escalation | Offline is read-only, so nothing can be changed. Roles and permissions can only change online, on the server. |
| Expiry | A copy older than **7 days** will not open. The age is read from **inside** the authenticated copy, so editing stored dates does not extend it. |
| Unlocked session | After unlocking, the copy's own key is kept in **sessionStorage for that tab** (at most 12 hours), so moving between pages does not ask for the password again. It ends when the tab closes or on Sign out. |
| Clearing | Offline & Sync: anyone can remove their own copy; removing all copies needs a role with User Accounts → edit, or full access. Both ask first. |

### What can and cannot be revoked while a computer is offline

- **Online (immediate):** account deactivation, password reset, role change,
  device-level removal of copies, and switching off the shared passphrase. A
  computer that is online always uses the server.
- **While a computer stays fully offline:** nothing can reach it. A
  deactivated person could still open their **read-only** copy on that
  computer until it is **7 days old**, or until the computer comes online (then
  only an online sign-in works). They cannot change anything. Reduce the risk by
  removing their copy on Offline & Sync, or by clearing the site data on that
  computer.
- **Server-side device registry and revocation:** not in Phase 1; planned in
  Phase 2 (§8).

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Offline: "this computer has no saved offline copy yet" | Nobody has signed in online here with a password since Phase 1 was deployed. Sign in online once. |
| Offline: "The sign-in details are not correct..." | Wrong password, or this person never signed in **on this computer**. Copies are per computer. |
| Offline: "more than 7 days old" | Connect and sign in online to refresh it. |
| Offline & Sync: "not installed yet" | Visit any page while online and reload once. |
| Copy not refreshed | You are using the shared passphrase (no copy), or must choose your own password first. Sign out and sign in with your own account. |
| A page says it needs the workshop database offline | That page reads on demand and is not in the copy (§4). |
| After a deploy, an old screen appears offline | Normal until the computer has been online once with the new version. Online, every file is always fetched fresh. |

---

## 7. Backup and restore

- **Phase 1 creates no data that exists only on a computer.** Every record is
  in D1, and the local copy is a protected cache of it. Losing a computer, or
  clearing its browser data, loses nothing: sign in online again.
- **Cloud backup** is unchanged: back up D1 before every production migration
  (see `DEPLOYMENT.md`), e.g. `wrangler d1 export taqwa-prod --remote --output backup-YYYYMMDD.sql`.
  Keep the file **outside** the repository folder.
- **Device loss:** the copy on a lost computer is encrypted with each person's
  password. To be safe, reset the password of every account that was used on
  it (User Accounts → Set new password).
- **Warning before clearing browser data:** Offline & Sync explains what clearing
  removes. In Phase 1 that is only the copies and the cached app.
- **Phase 2 and later:** once changes can wait on a computer, the outbox will
  need backup and export. Designed in §8.

---

## 8. Phases 2–4: saving changes offline (design, not implemented)

### Phase 2: server foundations (no client writes yet)

- **Migration (additive): `change_log` table.** Columns:
  - `seq INTEGER PRIMARY KEY AUTOINCREMENT`
  - `collection`, `record_id`, `op` (`upsert` or `delete`), `changed_at`

  It is filled by **D1 triggers** on the core tables, so no route code changes.
  The server-side `seq` is the sync cursor; client clocks are never trusted.
  Hard deletes become tombstones in the log.
- **`GET /api/sync/changes?after=<seq>&limit=`:** paginated, permission-filtered
  changed records plus tombstones. The client applies each page in one IndexedDB
  transaction and advances its cursor only after that transaction commits.
  Interrupted pulls resume from the last committed cursor.
- **Device registry:** a `devices` table (`id` UUID, `account_id`, `name`,
  `registered_at`, `last_seen_at`, `revoked_at`) and
  `POST /api/devices/register`. A revoked device is refused at its next sync,
  and its copies are wiped at its next online contact.

### Phase 3: offline writes for non-financial records

Customers, vehicles and appointments. Then job-card *drafts*.

- **Outbox:** an IndexedDB `outbox` store. Each operation has:
  - `opId` (UUID) and `deviceId`;
  - `collection` and `kind` (create / update / action);
  - `localId` (UUID), `dependsOn[]` (the local ids it references);
  - `baseVersion` (the record's `updatedAt` when edited);
  - `payload`, `status` (pending / syncing / failed / conflict), `attempts`, `lastError`.
- **`POST /api/sync/push`:** a batch, processed in dependency order. Each
  operation is idempotent on `opId`, recorded server-side in a `sync_ops` table
  with the result, so a retried batch returns the same result and never creates
  twice. The server allocates the real id (`CUS-0042`) and returns the
  `localId → serverId` mapping. The client rewrites dependants before sending
  them.
- **Removal from the outbox:** only after the server acknowledges the
  operation.
- **Retries:** exponential backoff (5 s → 15 min).
- **When it runs:** on reconnect, app open, return to the foreground, and
  **Sync now**. Background Sync is an extra trigger only.
- **Conflicts:**
  - Customer and vehicle edits use **field-level three-way merge** against
    `baseVersion`. Differing values for the same field become a `conflict`
    record, resolved by an authorised user in a Conflict Center (logged in the
    activity log).
  - Appointment and job-card status changes go through the **server's existing
    transition rules**. An invalid transition is a failed operation, never
    forced.
- **UI:** a pending badge per record (*"Saved on this computer — not yet on the
  server"*), and a Sync Center with pending, failed and conflict counts, last
  sync time, retry, and the device id.
- **Backup:** the outbox can be exported and imported (JSON, encrypted with the
  person's key) from Offline & Sync. The app warns before anything that clears
  storage while operations are pending.

### Phase 4: money and stock (needs business decisions, §9)

- **Payments:** append-only offline *receipts* with a unique `opId`. They are
  shown as **"Pending — not yet confirmed"** and never as a confirmed payment
  until the server accepts them. The server posts them through the normal
  payment route (rebalancing, advances) and rejects duplicates by `opId`.
- **Invoices:** never created or changed offline, or created only as drafts
  numbered by the server on sync (decision needed). Issued invoices are never
  overwritten; corrections go through the existing adjustment and void routes.
- **Stock:** only as **movement intents** (job-card part usage, receipts). The
  server applies them in order with its existing stock checks. Insufficient
  stock becomes a conflict for review, never a negative or overwritten quantity.
- **Expenses and attendance:**
  - expenses are append-only;
  - attendance is unique per (person, day), so a second entry for the same day
    becomes a conflict.

---

## 9. Decisions needed before Phase 3 / 4

1. **Offline numbering:** may an offline-created customer or job card show a
   provisional reference (e.g. `OFF-A-0007`) until sync gives it its real
   number?
2. **Payments offline:** allowed, as pending receipts that are confirmed only
   after sync? Who may record them?
3. **Invoices offline:** not at all, or drafts only?
4. **Stock offline:** may job cards use parts offline (resolved at sync, with
   conflicts if stock ran out), or should parts usage need a connection?
5. **Conflict resolution:** which roles may resolve conflicts?
6. **Offline window:** is 7 days right for read-only access?

---

## 10. Deployment (Phase 1)

There is **no database migration** in Phase 1, and nothing on the server changes.

1. Review and merge the PR (not done automatically).
2. **Before every deploy that changes a page, script, style or image:**
   - bump `TAQWA_VERSION` in `js/version.js`;
   - run `node tools/sw-assets.mjs`;
   - commit both. `npm test` fails if the asset list is stale.
3. Deploy as usual (`DEPLOYMENT.md`). `sw.js` is served from the site root by
   the assets binding. `.assetsignore` already keeps `tools/` and this document
   out of the published site.
4. **Verify on one computer:**
   - sign in online with your own account;
   - Offline & Sync shows the app installed and your copy saved;
   - turn off the network and reload: the offline sign-in appears and opens
     your copy;
   - try to add a record: it is refused.
   - Then turn the network back on.

### Rollback

- **Code rollback** is safe: a browser keeps the old service worker, but it is
  network-first, so online it always serves what the server has.
- **To remove the service worker from every browser,** deploy this as `sw.js`
  (keep the file name):

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('taqwa-shell-')) await caches.delete(k);
  await self.registration.unregister();
  for (const c of await self.clients.matchAll()) c.navigate(c.url);
})()));
```

- The encrypted copies in IndexedDB are harmless without the code. They can
  be removed from Offline & Sync, or by clearing site data.

---

## 11. Local testing

```bash
npm test                                   # unit suites (offline-store, offline-sw, storage-offline, ...)
npm run test:integration                   # Worker + local D1 (unchanged by Phase 1)
```

Browser offline check (Chromium + Playwright, local only): start
`wrangler dev --local` with test credentials, sign in with a test account, and
use DevTools → Network → **Offline**. Alternatively, Playwright's
`context.setOffline(true)` exercises the real service worker and IndexedDB.
