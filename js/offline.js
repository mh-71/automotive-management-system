/* ============================================================
   offline.js — the encrypted, read-only offline copy (Phase 1)
   ------------------------------------------------------------
   When this computer cannot reach the server, the CRM can still
   open the business data it last saw -- READ-ONLY, for a person
   who signed in here online before, with their own password.

   WHAT IS STORED (IndexedDB "taqwa-offline", this browser only)
     meta       the device: a random UUID made once per browser.
     users      one row per person who signed in here online:
                their account id, name, role, the identifiers they
                may type (username / Staff ID / e-mail they used),
                an RSA-OAEP public key, and the matching PRIVATE key
                ENCRYPTED with a key derived from their password
                (PBKDF2-SHA-256, 310,000 rounds, random salt).
     snapshots  one row per person: the collections and settings
                their role could read at the last online page load,
                encrypted with a fresh AES-256-GCM key that is itself
                sealed with that person's public key.

   WHY THIS SHAPE
     - Online, every page load can refresh the copy WITHOUT any
       secret on hand: sealing needs only the public key.
     - Offline, opening it needs the password: it unlocks the
       private key, which unseals the copy. A wrong password simply
       fails to decrypt (AES-GCM is authenticated); no password,
       hash or reusable server token is ever stored.
     - Each person's copy holds only what their role could read.
     - A copy older than OFFLINE_DAYS (14) will not open: offline
       access needs regular online contact. Account deactivation
       and permission changes take effect the next time this
       computer is online (the server decides then); while it stays
       fully offline they cannot reach it -- see OFFLINE_SYSTEM.md.

   PHASES 2-4: CHANGES MADE OFFLINE (js/sync.js) live in a separate
   encrypted JOURNAL per person ("journals" store): the records made
   or edited offline and the queue of operations waiting for the
   server. Its AES-256 key is wrapped TWICE:
     - with the person's public key (opened offline with the
       password, exactly like the copy), and
     - with an ESCROW key the server derives for this person on THIS
       device (HMAC of the server's signing secret; never stored on
       the server). Online, a signed-in session can reopen the
       journal without the password -- so a password reset or a
       fresh tab never strands unsynced changes.
   The journal is never deleted by removing a copy: unsynced work is
   only ever removed by being accepted (or decided) by the server.

   THE 14-DAY RULE (owner decision) is measured from the SERVER's time
   at the last online authorization, saved inside the authenticated
   copy, not from this computer's clock. A clock turned back (earlier
   than the latest time this copy was seen) refuses to open; a clock
   turned forward only makes the copy expire sooner. Clearing site data
   removes the copy itself, so it cannot extend access either. These
   are checks a determined person with the password and developer tools
   could still defeat on their own computer: the server re-checks
   everything (account, role, device) on reconnect, and revocation
   reaches an offline computer only then. See OFFLINE_SYSTEM.md.
   ============================================================ */

const Offline = (() => {

  const DB_NAME = 'taqwa-offline';
  const DB_VERSION = 2;
  const JOURNAL_SCHEMA = 1;
  /** A clock this much earlier than the latest seen is "turned back". */
  const CLOCK_SLACK_MS = 10 * 60 * 1000;
  const SNAPSHOT_SCHEMA = 1;
  const PBKDF2_ITERATIONS = 310000;
  const OFFLINE_DAYS = 14;
  const DAY_MS = 86400000;

  const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle) || null;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const b64 = (buf) => { let s = ''; const v = new Uint8Array(buf); for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]); return btoa(s); };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  const random = (n) => crypto.getRandomValues(new Uint8Array(n));

  /* ---------- storage: IndexedDB in the browser, any { get, put, del, all } in tests ---------- */

  function idbStore() {
    let opening = null;
    const open = () => opening || (opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      // Versioned schema: each version adds what it needs, never drops data.
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('users', { keyPath: 'accountId' });
          db.createObjectStore('snapshots', { keyPath: 'accountId' });
        }
        // 2 (Phases 2-4): the encrypted journal of changes made offline.
        if (e.oldVersion < 2) db.createObjectStore('journals', { keyPath: 'accountId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('The offline store is open in another tab with an older version.'));
    }));
    const tx = async (store, mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Offline store transaction aborted.'));
      });
    };
    return {
      get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
      put: (store, value) => tx(store, 'readwrite', (s) => s.put(value)),
      del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
      all: (store) => tx(store, 'readonly', (s) => s.getAll()),
      clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
    };
  }

  /** An in-memory store with the same shape (tests, or a browser without IndexedDB). */
  function memoryStore() {
    const data = { meta: new Map(), users: new Map(), snapshots: new Map(), journals: new Map() };
    const keyOf = { meta: 'key', users: 'accountId', snapshots: 'accountId', journals: 'accountId' };
    const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
    return {
      get: async (s, k) => copy(data[s].get(k)),
      put: async (s, v) => { data[s].set(v[keyOf[s]], copy(v)); },
      del: async (s, k) => { data[s].delete(k); },
      all: async (s) => [...data[s].values()].map(copy),
      clear: async (s) => { data[s].clear(); },
    };
  }

  let store = null;
  const db = () => store || (store = (typeof indexedDB !== 'undefined' ? idbStore() : memoryStore()));
  /** Use another store (tests). */
  function useStore(s) { store = s; }

  /** Is the offline copy possible in this browser at all? */
  const supported = () => !!(subtle() && typeof indexedDB !== 'undefined' && typeof crypto.getRandomValues === 'function');

  /* ---------- the device ---------- */

  async function deviceId() {
    const row = await db().get('meta', 'device');
    if (row && row.deviceId) return row.deviceId;
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
      : [...random(16)].map((b, i) => (i === 6 ? (b & 15) | 64 : i === 8 ? (b & 63) | 128 : b).toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4-');
    await db().put('meta', { key: 'device', deviceId: id, createdAt: new Date().toISOString() });
    return id;
  }

  /** The device's short code from the server (temporary references: OFF-<code>-CUS-0007). */
  async function setDeviceCode(code) {
    const id = await deviceId();
    const row = await db().get('meta', 'device');
    await db().put('meta', { ...(row || { key: 'device', deviceId: id }), code: String(code || '') });
  }
  async function deviceInfo() {
    const id = await deviceId();
    const row = (await db().get('meta', 'device')) || {};
    // Before the first online registration: a code made from the device UUID, still unique.
    return { deviceId: id, code: row.code || `X${id.replace(/-/g, '').slice(0, 5).toUpperCase()}`, registered: !!row.code };
  }

  /**
   * The next number for a temporary reference with this prefix, for the whole
   * DEVICE (every person on it), so two people on one computer never make the
   * same OFF-A-CUS-0007. Kept in plain sight: it is only a counter.
   */
  async function nextSequence(prefix) {
    const take = async () => {
      const row = (await db().get('meta', 'seq')) || { key: 'seq', values: {} };
      const n = (Number(row.values[prefix]) || 0) + 1;
      row.values[prefix] = n;
      await db().put('meta', row);
      return n;
    };
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) return navigator.locks.request('taqwa-offline-seq', take);
    return take();
  }

  /** An administrator revoked this device (the server said so): nothing opens offline any more. */
  async function markRevoked(reason) {
    await db().put('meta', { key: 'revoked', at: new Date().toISOString(), reason: String(reason || '') });
  }
  async function revoked() { return (await db().get('meta', 'revoked')) || null; }

  /* ---------- identifiers (the same rules as the server's sign-in) ---------- */

  function normalise(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    if (v.includes('@')) return v.toLowerCase();
    if (/^(mec|stf)-\d{4,}$/i.test(v)) return v.toUpperCase();
    return v.toLowerCase();
  }

  /* ---------- keys ---------- */

  async function passwordKey(password, salt, iterations) {
    const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base,
      { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
  }

  /** The person's private key, if this password opens it; null otherwise. */
  async function openPrivateKey(user, password) {
    try {
      const kek = await passwordKey(password, unb64(user.salt), user.iterations);
      return await subtle().unwrapKey('pkcs8', unb64(user.wrappedPrivateKey), kek, { name: 'AES-GCM', iv: unb64(user.privIv) },
        { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['unwrapKey']);
    } catch (e) {
      return null;   // wrong password (the AES-GCM tag does not verify) -- or a damaged record
    }
  }

  /**
   * Enrol this person on this computer, or refresh their entry. Called right
   * after a successful ONLINE sign-in (or own-password change), while the
   * password is in hand -- it is used here and never kept.
   */
  async function enroll(account, password, typedIdentifier, opts = {}) {
    if (!account || !account.id || typeof password !== 'string' || !password) return false;
    const existing = await db().get('users', account.id);
    const identifiers = [...new Set([account.username, account.staffId, typedIdentifier].map(normalise).filter(Boolean)
      .concat(existing ? existing.identifiers : []))];
    const base = {
      accountId: account.id, username: account.username || '', name: account.name || account.username || '',
      staffId: account.staffId || '', role: account.role || '', identifiers, lastOnlineAt: new Date().toISOString(),
    };
    // Same password as before: keep the key pair (the saved copy stays readable).
    if (existing && await openPrivateKey(existing, password)) {
      await db().put('users', { ...existing, ...base });
      return true;
    }
    const pair = await subtle().generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['wrapKey', 'unwrapKey']);
    const salt = random(16);
    const iv = random(12);
    const kek = await passwordKey(password, salt, PBKDF2_ITERATIONS);
    const wrapped = await subtle().wrapKey('pkcs8', pair.privateKey, kek, { name: 'AES-GCM', iv });
    const spki = await subtle().exportKey('spki', pair.publicKey);
    // The journal keeps its key across a new key pair (a changed or reset
    // password): re-wrapped for the new public key if it is known here --
    // from this tab, or from the server's escrow -- so unsynced work survives.
    const journalKey = opts.journalKey || null;
    await db().put('users', { ...base, salt: b64(salt), iterations: PBKDF2_ITERATIONS, privIv: b64(iv), wrappedPrivateKey: b64(wrapped),
      publicKey: b64(spki), enrolledAt: new Date().toISOString(),
      ...(journalKey ? { journalKeyRsa: b64(await subtle().encrypt({ name: 'RSA-OAEP' }, pair.publicKey, unb64(journalKey))) } : {}) });
    // A new key pair: any older copy could no longer be opened, so it goes.
    // (The journal is NOT removed: it can still be opened with the escrow.)
    await db().del('snapshots', account.id);
    return true;
  }

  /* ---------- the copy ---------- */

  /**
   * Seal and save what this person's role could read, online. Needs no
   * secret: only their public key. Returns false when they are not enrolled
   * on this computer (they have not signed in here with a password yet).
   */
  async function saveSnapshot(accountId, payload) {
    const user = accountId && await db().get('users', accountId);
    if (!user) return false;
    const publicKey = await subtle().importKey('spki', unb64(user.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['wrapKey']);
    const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const iv = random(12);
    const savedAt = new Date().toISOString();
    const plain = enc.encode(JSON.stringify({ schema: SNAPSHOT_SCHEMA, accountId, savedAt, ...payload }));
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plain);
    const wrappedKey = await subtle().wrapKey('raw', key, publicKey, { name: 'RSA-OAEP' });
    await db().put('snapshots', { accountId, savedAt, schema: SNAPSHOT_SCHEMA, iv: b64(iv), ciphertext: b64(ciphertext), wrappedKey: b64(wrappedKey), size: plain.length });
    await db().put('users', { ...user, lastOnlineAt: savedAt });
    return true;
  }

  /**
   * Open the copy, offline: { ok, data } or { ok: false, code, message }.
   * Every "wrong identifier" and "wrong password" answer is the same.
   */
  async function unlock(identifier, password, now = Date.now()) {
    const wrong = { ok: false, code: 'unauthorized', message: 'The sign-in details are not correct, or this person has not signed in on this computer before.' };
    const rv = await revoked();
    if (rv) return REVOKED;
    const id = normalise(identifier);
    if (!id || typeof password !== 'string' || !password) return wrong;
    const users = (await db().all('users')).filter((u) => u.identifiers.includes(id));
    if (users.length !== 1) return wrong;
    const user = users[0];
    const privateKey = await openPrivateKey(user, password);
    if (!privateKey) return wrong;
    const snap = await db().get('snapshots', user.accountId);
    if (!snap) return { ok: false, code: 'no_copy', message: 'There is no saved copy for you on this computer yet. Sign in once while online, then try again.' };
    let key;
    try {
      key = await subtle().unwrapKey('raw', unb64(snap.wrappedKey), privateKey, { name: 'RSA-OAEP' }, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
    } catch (e) {
      return DAMAGED;
    }
    const opened = await openSnapshot(user, snap, key, now);
    if (!opened.ok) return opened;
    // The copy's own key, for this browser TAB only (sessionStorage), so moving
    // between pages does not ask for the password every time. It opens only this
    // copy, ends with the tab, and stops working when a newer copy is saved.
    // The journal's key travels with it the same way (made now if this person
    // has none yet: wrapping needs only the public key).
    return { ...opened, sessionKey: b64(await subtle().exportKey('raw', key)), journalKey: await journalKeyFor(user, privateKey) };
  }

  const DAMAGED = { ok: false, code: 'damaged', message: 'The saved copy on this computer could not be read. Sign in online to refresh it.' };
  const REVOKED = { ok: false, code: 'revoked', message: 'An administrator has revoked offline access on this computer. Changes not yet sent are kept here; connect to the internet and ask an administrator.' };

  async function openSnapshot(user, snap, key, now) {
    let data;
    try {
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(snap.iv) }, key, unb64(snap.ciphertext));
      data = JSON.parse(dec.decode(plain));
    } catch (e) {
      return DAMAGED;
    }
    // The age comes from INSIDE the authenticated copy, so it cannot be extended by editing the store.
    if (data.schema !== SNAPSHOT_SCHEMA || data.accountId !== user.accountId) return DAMAGED;
    const window = accessWindow(data, user, now);
    if (!window.ok) return window;
    // Remember the latest time seen, so a clock turned back later is noticed.
    if (!(Number(user.lastSeenAt) >= window.now)) await db().put('users', { ...user, lastSeenAt: window.now });
    return { ok: true, data, until: window.until, user: { accountId: user.accountId, username: user.username, name: user.name, staffId: user.staffId, role: user.role } };
  }

  /**
   * The 14-day window: from the SERVER's time at the last online authorization
   * (data.authorizedAt), with this computer's clock corrected by the offset
   * measured then. A clock earlier than one already seen is refused.
   */
  function accessWindow(data, user, now) {
    const authorized = Date.parse(data.authorizedAt || data.savedAt);
    const offset = data.authorizedAt && data.clientAt ? authorized - Date.parse(data.clientAt) : 0;
    const est = now + (Number.isFinite(offset) ? offset : 0);
    const seen = Number(user.lastSeenAt) || 0;
    if (!Number.isFinite(authorized) || est < authorized - CLOCK_SLACK_MS || est < seen - CLOCK_SLACK_MS) {
      return { ok: false, code: 'clock', message: "This computer's date and time are earlier than when the offline copy was last used, so it will not open. Correct the clock, or connect to the internet and sign in." };
    }
    const until = authorized + OFFLINE_DAYS * DAY_MS;
    if (est > until) {
      return { ok: false, code: 'expired', message: `Offline access lasts ${OFFLINE_DAYS} days after you last signed in online, and that time has passed. Connect to the internet and sign in to continue.` };
    }
    return { ok: true, now: est, until: new Date(until).toISOString() };
  }

  /* ---------- the journal: changes made offline (js/sync.js) ---------- */

  /** This person's journal key (base64), unwrapped with their private key; made (and saved) if they have none yet. */
  async function journalKeyFor(user, privateKey) {
    try {
      if (user.journalKeyRsa) {
        return b64(await subtle().decrypt({ name: 'RSA-OAEP' }, privateKey, unb64(user.journalKeyRsa)));
      }
    } catch (e) { /* fall through: a damaged entry -- the escrow may still open the journal online */ }
    const journal = await db().get('journals', user.accountId);
    if (journal) return null;   // a journal exists under a key this password cannot open: only the escrow can (online)
    const raw = random(32);
    const publicKey = await subtle().importKey('spki', unb64(user.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const fresh = (await db().get('users', user.accountId)) || user;
    await db().put('users', { ...fresh, journalKeyRsa: b64(await subtle().encrypt({ name: 'RSA-OAEP' }, publicKey, raw)) });
    return b64(raw);
  }

  /** With the password (an online sign-in): this person's journal key, or null. */
  async function journalKeyWithPassword(accountId, password) {
    const user = await db().get('users', accountId);
    if (!user) return null;
    const privateKey = await openPrivateKey(user, password);
    return privateKey ? journalKeyFor(user, privateKey) : null;
  }

  /**
   * Online, with a session: the journal key, from the server's escrow for this
   * person on this device. Makes (and wraps) a key if there is none. Also wraps
   * the key for the person's public key, so the password opens it offline.
   */
  async function journalKeyFromEscrow(accountId, escrowB64) {
    if (!escrowB64) return null;
    const ek = await subtle().importKey('raw', unb64(escrowB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const journal = await db().get('journals', accountId);
    const user = await db().get('users', accountId);
    let raw = null;
    if (journal && journal.escrowWrap) {
      try { raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(journal.escrowWrap.iv) }, ek, unb64(journal.escrowWrap.ct))); }
      catch (e) { return null; }   // another person's escrow, or a rotated server secret
    } else if (journal) {
      return null;   // made before escrow existed and not openable without the password
    }
    if (!raw) raw = random(32);
    const iv = random(12);
    const escrowWrap = { iv: b64(iv), ct: b64(await subtle().encrypt({ name: 'AES-GCM', iv }, ek, raw)) };
    if (!journal) await db().put('journals', { accountId, escrowWrap, savedAt: null, summary: { pending: 0, conflict: 0, failed: 0 } });
    if (user && !user.journalKeyRsa && user.publicKey) {
      const publicKey = await subtle().importKey('spki', unb64(user.publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
      await db().put('users', { ...user, journalKeyRsa: b64(await subtle().encrypt({ name: 'RSA-OAEP' }, publicKey, raw)) });
    }
    return b64(raw);
  }

  /** Make sure the journal row carries an escrow wrap of this key (online, after an offline unlock). */
  async function ensureEscrow(accountId, keyB64, escrowB64) {
    if (!keyB64 || !escrowB64) return false;
    const journal = (await db().get('journals', accountId)) || { accountId, savedAt: null, summary: { pending: 0, conflict: 0, failed: 0 } };
    if (journal.escrowWrap) return true;
    const ek = await subtle().importKey('raw', unb64(escrowB64), { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = random(12);
    await db().put('journals', { ...journal, escrowWrap: { iv: b64(iv), ct: b64(await subtle().encrypt({ name: 'AES-GCM', iv }, ek, unb64(keyB64))) } });
    return true;
  }

  async function journalCryptoKey(keyB64) {
    return subtle().importKey('raw', unb64(keyB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  /** The journal's contents, or null when there is none yet. Throws on a wrong key (never silently "empty"). */
  async function readJournal(accountId, keyB64) {
    const row = await db().get('journals', accountId);
    if (!row || !row.ciphertext) return null;
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(row.iv) }, await journalCryptoKey(keyB64), unb64(row.ciphertext));
    const data = JSON.parse(dec.decode(plain));
    if (data.schema !== JOURNAL_SCHEMA || data.accountId !== accountId) throw new Error('This offline journal belongs to someone else.');
    return data;
  }

  /** Seal and save the journal (one IndexedDB write: contents and counts together). */
  async function writeJournal(accountId, keyB64, data, summary) {
    const row = (await db().get('journals', accountId)) || { accountId };
    const iv = random(12);
    const plain = enc.encode(JSON.stringify({ ...data, schema: JOURNAL_SCHEMA, accountId }));
    const ciphertext = await subtle().encrypt({ name: 'AES-GCM', iv }, await journalCryptoKey(keyB64), plain);
    await db().put('journals', { ...row, accountId, iv: b64(iv), ciphertext: b64(ciphertext), savedAt: new Date().toISOString(), summary: summary || row.summary || {} });
  }

  /** Counts only (nothing secret): how much unsynced work each person has on this computer. */
  async function journalSummaries() {
    try { return (await db().all('journals')).map((j) => ({ accountId: j.accountId, savedAt: j.savedAt, summary: j.summary || {} })); }
    catch (e) { return []; }
  }

  /** Open the copy again on the next page of the same tab, with the key unlock() gave. */
  async function openWithSession(accountId, sessionKey, now = Date.now()) {
    try {
      const user = await db().get('users', accountId);
      const snap = await db().get('snapshots', accountId);
      if (!user || !snap || typeof sessionKey !== 'string') return DAMAGED;
      if (await revoked()) return REVOKED;
      const key = await subtle().importKey('raw', unb64(sessionKey), { name: 'AES-GCM' }, false, ['decrypt']);
      return await openSnapshot(user, snap, key, now);
    } catch (e) {
      return DAMAGED;
    }
  }

  /* ---------- what is on this computer ---------- */

  /** People who can open a copy here, without anything secret: name, role, when last online, copy size. */
  async function status() {
    const [users, snaps] = await Promise.all([db().all('users'), db().all('snapshots')]);
    const byId = new Map(snaps.map((s) => [s.accountId, s]));
    return users.map((u) => ({
      accountId: u.accountId, name: u.name, username: u.username, role: u.role, lastOnlineAt: u.lastOnlineAt,
      savedAt: byId.get(u.accountId)?.savedAt || null, size: byId.get(u.accountId)?.size || 0,
    }));
  }

  /** Is there any copy that could be opened on this computer? */
  async function hasCopies() {
    try { return (await db().all('snapshots')).length > 0; } catch (e) { return false; }
  }

  /** Remove one person's entry and copy from this computer. Their journal of
      unsynced changes is KEPT (it opens again online, with the escrow). */
  async function forget(accountId) {
    await db().del('snapshots', accountId);
    await db().del('users', accountId);
  }

  /** Remove every copy and entry from this computer (the device id and any unsynced journals stay). */
  async function forgetAll() {
    await db().clear('snapshots');
    await db().clear('users');
  }

  return {
    OFFLINE_DAYS, PBKDF2_ITERATIONS, supported, useStore, memoryStore, deviceId, deviceInfo, setDeviceCode, nextSequence, markRevoked, revoked, normalise,
    enroll, saveSnapshot, unlock, openWithSession, status, hasCopies, forget, forgetAll, accessWindow,
    journalKeyFromEscrow, journalKeyWithPassword, ensureEscrow, readJournal, writeJournal, journalSummaries,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Offline };
