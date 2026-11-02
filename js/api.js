/* ============================================================
   api.js — the one place the browser talks to the Worker API
   ------------------------------------------------------------
   storage.js calls this; UI modules never do. Everything about
   HTTP lives here: where the API is, how a request is
   authenticated, and how a failure becomes something the UI can
   show.

   ---- where the API is ----

   One base URL, resolved once, in this order:

     1. window.TAQWA_API_BASE            (explicit override)
     2. <meta name="taqwa-api-base">     (per-deployment, no JS)
     3. same origin + /api               (the normal case)
     4. null on file:// -- a page opened from disk has no origin
        to call, so the app stays on localStorage rather than
        firing requests that cannot succeed.

   Same origin is the default on purpose: it needs no CORS on the
   Worker and no origin allow-list to keep in step. `npm run
   dev:app` serves this folder and proxies /api to `wrangler dev`
   for exactly that reason.

   ---- authentication ----

   Every route except /api/health and /api/session now requires a
   credential, READS INCLUDED, and there are two kinds.

   A browser signs in at /api/session with the workshop passphrase
   and is given an HttpOnly cookie. Nothing in this file can read
   that cookie, store it, or leak it -- the browser attaches it
   and script never sees it. That is the whole point of doing it
   this way rather than with a token.

   A machine (CI, the integration suite) uses
   `Authorization: Bearer <API_TOKEN>` instead, supplied at runtime
   through Api.configure({ token }) and held in a closure for that
   page's lifetime only. Nothing here ships a token, reads one from
   the repository, or puts one in localStorage or sessionStorage.

   A request with no credential is SENT and refused by the server
   with a 401, rather than second-guessed here: the cookie is
   invisible to this code, so the server is the only thing that
   knows whether a request can be authenticated.

   This requires the app and the API to share an origin -- which
   they do, by being served from the same Worker. Cookies are why:
   a cross-origin deployment would need CORS with credentials, and
   a browser will not attach a cookie to a preflight at all.
   ============================================================ */

const Api = (() => {

  const DEFAULT_TIMEOUT_MS = 15000;

  let baseUrl;            // undefined = not resolved yet, null = no API reachable
  let sameOrigin = false; // the API is this page's own origin (set by detectBase)
  let token = null;       // runtime only -- never read from or written to storage
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  /* ---------- base URL ---------- */

  function detectBase() {
    if (typeof window !== 'undefined' && typeof window.TAQWA_API_BASE === 'string') {
      return window.TAQWA_API_BASE.replace(/\/+$/, '') || null;
    }
    if (typeof document !== 'undefined' && document.querySelector) {
      const meta = document.querySelector('meta[name="taqwa-api-base"]');
      const content = meta && meta.getAttribute('content');
      if (content) return content.replace(/\/+$/, '');
    }
    // A file:// page has origin "null" as a string; there is nothing to call.
    const origin = typeof location !== 'undefined' ? location.origin : '';
    if (!origin || origin === 'null' || !/^https?:/.test(origin)) return null;
    // The app and its API share this origin: the real deployment (and wrangler dev).
    sameOrigin = true;
    return `${origin}/api`;
  }

  function base() {
    if (baseUrl === undefined) baseUrl = detectBase();
    return baseUrl;
  }

  /**
   * Set the base URL and/or the write token for this page's lifetime.
   * Passing a key explicitly is what changes it, so configure({ token })
   * cannot accidentally clear a base URL that was already resolved.
   */
  function configure(options = {}) {
    if ('baseUrl' in options) {
      baseUrl = options.baseUrl ? String(options.baseUrl).replace(/\/+$/, '') : null;
    }
    if ('token' in options) {
      const t = options.token == null ? '' : String(options.token).trim();
      token = t === '' ? null : t;
    }
    if ('timeoutMs' in options) {
      const n = Number(options.timeoutMs);
      if (Number.isFinite(n) && n > 0) timeoutMs = n;
    }
    return { baseUrl, hasToken: token !== null, timeoutMs };
  }

  /** Whether a write could be authenticated. Never reveals the token itself. */
  function hasToken() { return token !== null; }

  /* ---------- failures ---------- */

  /**
   * Every failure leaves here in one shape, so callers branch on `code`
   * rather than on a status number or a message string.
   */
  function failure(code, message, extra = {}) {
    return { ok: false, status: extra.status ?? 0, code, message, ...extra };
  }

  /**
   * The message a user should see for a transport-level problem. A server
   * failure carries its own message and is shown verbatim; these are the
   * cases where there is no server answer to quote.
   */
  const TRANSPORT_MESSAGES = {
    no_api: 'No backend is configured, so this is running on browser storage.',
    timeout: 'The server took too long to answer. Check that it is running.',
    network_error: 'Could not reach the server. Check that it is running.',
    malformed_response: 'The server sent a response this app could not read.',
  };

  const transportFailure = (code, extra) =>
    failure(code, TRANSPORT_MESSAGES[code], extra);

  /* ---------- the request ---------- */

  /**
   * Perform one API call.
   *
   * Resolves to { ok: true, status, data, meta } or { ok: false, status,
   * code, message, fields? }. It never throws and never rejects: a caller
   * that has to try/catch around every write would eventually forget one.
   */
  async function request(method, path, body = undefined, options = {}) {
    const root = base();
    if (!root) return transportFailure('no_api');

    const upper = String(method).toUpperCase();
    const headers = {};

    // A machine token, if one was configured, goes on every request now that
    // reads are protected too. A browser sends nothing here: its session
    // cookie is attached by the browser itself, and is not readable from JS.
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const url = `${root}${path}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const limit = options.timeoutMs ?? timeoutMs;
    const timer = controller && typeof setTimeout === 'function'
      ? setTimeout(() => controller.abort(), limit)
      : null;

    let response;
    try {
      response = await fetch(url, {
        method: upper,
        headers,
        // The default, said out loud: the session cookie rides along on a
        // same-origin request and is never sent anywhere else. 'include'
        // would be the cross-origin setting, and this app deliberately has
        // no cross-origin deployment to need it.
        credentials: 'same-origin',
        // A 401 must never be answered from cache, or a signed-out browser
        // could go on being shown the last signed-in reply.
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (e) {
      // An abort is a timeout; anything else is the network. The caught
      // error is deliberately not echoed to the user -- it can carry the
      // full request URL, and a URL can carry a query string.
      const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      return transportFailure(aborted ? 'timeout' : 'network_error');
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    const status = response.status;

    // 204 has no body by definition; treat it as success with no data.
    let payload = null;
    if (status !== 204) {
      try {
        payload = await response.json();
      } catch (e) {
        return failure('malformed_response', TRANSPORT_MESSAGES.malformed_response, { status });
      }
      if (payload === null || typeof payload !== 'object') {
        return failure('malformed_response', TRANSPORT_MESSAGES.malformed_response, { status });
      }
    }

    if (response.ok) {
      if (payload && 'error' in payload) {
        return failure('malformed_response', TRANSPORT_MESSAGES.malformed_response, { status });
      }
      const { data = null, ...meta } = payload || {};
      return { ok: true, status, data, meta };
    }

    const error = (payload && payload.error) || {};
    const code = typeof error.code === 'string' ? error.code : 'request_failed';
    const message = typeof error.message === 'string' && error.message
      ? error.message
      : `The server refused this request (${status}).`;
    return failure(code, message, {
      status,
      ...(error.fields ? { fields: error.fields } : {}),
      ...(error.conflictsWith ? { conflictsWith: error.conflictsWith } : {}),
      // The server's machine-readable reason (e.g. 'insufficient_stock'), for
      // a caller that must tell one 409 from another. Named apart from the
      // `reason` that module wrappers use for the human-readable message.
      ...(typeof error.reason === 'string' ? { errorReason: error.reason } : {}),
    });
  }

  const get = (path, options) => request('GET', path, undefined, options);
  const post = (path, body, options) => request('POST', path, body, options);
  const put = (path, body, options) => request('PUT', path, body, options);
  const del = (path, options) => request('DELETE', path, undefined, options);

  /* ---------- signing in and out ---------- */

  /**
   * Exchange the workshop passphrase for a session.
   *
   * The passphrase is passed straight through to the server and is never
   * kept here: not in a variable, not in storage, not in a closure. What
   * comes back is an HttpOnly cookie this code cannot read, which is the
   * reason to do it this way -- there is nothing for an XSS to steal and
   * nothing for a later bug to log.
   */
  async function login(passphrase) {
    const res = await post('/session', { passphrase });
    // 401 here means the passphrase was wrong. It is deliberately the same
    // answer the server gives for every other failure, so this cannot report
    // anything more specific than "that did not work".
    if (!res.ok && res.status === 401) {
      return { ok: false, code: 'unauthorized', message: 'That passphrase was not accepted.' };
    }
    return res;
  }

  /**
   * Sign in with a staff member's own account. Like login(), nothing is kept:
   * the username and password go straight to the server, and a refusal says
   * no more than that they were not accepted (the server gives one answer for
   * an unknown name, a wrong password, an inactive account and a paused one).
   */
  async function loginAccount(username, password) {
    const res = await post('/session', { username, password });
    if (!res.ok && res.status === 401) {
      return { ok: false, code: 'unauthorized', message: 'That username and password were not accepted.' };
    }
    return res;
  }

  /**
   * Sign in with one identifier -- username, e-mail or Staff ID -- and a
   * password (0019). Every refusal reads the same: the server does not say
   * which part was wrong, so neither does this. Too many attempts is the one
   * different answer (429), with the server's own words.
   */
  async function loginIdentifier(identifier, password) {
    const res = await post('/session', { identifier, password });
    if (!res.ok && res.status === 401) {
      return { ok: false, code: 'unauthorized', message: 'The sign-in details are not correct. Check them and try again.' };
    }
    if (!res.ok && res.status === 429) {
      return { ok: false, code: 'too_many_attempts', message: res.message || 'Too many sign-in attempts. Please wait and try again.' };
    }
    if (!res.ok) return { ok: false, code: res.code, message: 'Signing in is not possible right now. Please try again in a moment.' };
    return res;
  }

  /** The signed-in account replaces its own password (0019). */
  const changePassword = (currentPassword, newPassword) => post('/session/password', { currentPassword, newPassword });

  /** End this browser's session. */
  const logout = () => request('DELETE', '/session');

  /**
   * Ask whether this browser is signed in, without provoking a 401.
   * Resolves to { authenticated, passphrase, accounts, account } -- whether
   * signing in is possible here at all (so the app knows to offer a form),
   * whether a staff member may use their own account, and, for an account
   * session only, that account's id, username and role.
   */
  async function session() {
    const res = await get('/session');
    if (!res.ok) return { ok: false, authenticated: false, passphrase: false, accounts: false, account: null, code: res.code };
    const data = res.data || {};
    const account = data.account && typeof data.account === 'object'
      ? { id: String(data.account.id || ''), username: String(data.account.username || ''), role: String(data.account.role || ''),
          ...(data.account.roleId ? { roleId: String(data.account.roleId) } : {}),
          ...(data.account.name ? { name: String(data.account.name) } : {}),
          ...(data.account.staffId ? { staffId: String(data.account.staffId) } : {}),
          ...(data.account.passwordChangeRequired === true ? { passwordChangeRequired: true } : {}) }
      : null;
    // What the signed-in caller may do (0018). For showing only what will work;
    // the server checks every request itself.
    // null when the server does not say (one older than 0018): nothing is hidden then.
    const permissions = Array.isArray(data.permissions) ? data.permissions.filter(p => typeof p === 'string') : null;
    return { ok: true, authenticated: data.authenticated === true, passphrase: data.passphrase === true, accounts: data.accounts === true, account,
      // Whether the shared workshop passphrase may still sign in (0019); true when the server does not say.
      sharedPassphrase: data.sharedPassphrase !== false,
      fullAccess: data.fullAccess === true, permissions,
      // Offline sync (0020), for a personal account: the server's clock and change-log position.
      serverTime: typeof data.serverTime === 'string' ? data.serverTime : null,
      syncCursor: Number.isInteger(data.syncCursor) ? data.syncCursor : null };
  }

  /**
   * Is a backend actually there?
   *
   * GET /api/health is public in C-9, so this needs no token and tells us
   * nothing about whether writes will be allowed -- only whether the API
   * answers at all. storage.js uses it to decide between D1 and
   * localStorage before it fetches anything.
   */
  async function probe(options = {}) {
    if (!base()) return { ok: false, code: 'no_api' };
    const res = await get('/health', { timeoutMs: options.timeoutMs ?? 5000 });
    return res.ok ? { ok: true, health: res.data } : { ok: false, code: res.code };
  }

  return { configure, hasToken, request, get, post, put, delete: del, probe,
           login, loginAccount, loginIdentifier, changePassword, logout, session,
           get baseUrl() { return base(); },
           /** Is the API this page's own origin -- the deployed app, not a cross-origin dev setup? */
           get sameOrigin() { base(); return sameOrigin; } };
})();

/* Node's test harness loads this file as a script; the browser does not. */
if (typeof module !== 'undefined' && module.exports) module.exports = { Api };
