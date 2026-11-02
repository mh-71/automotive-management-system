/**
 * Sign-in throttle (0019 auth_throttle).
 *
 * Failed sign-ins are counted for a short window, both per client address
 * and per identifier (a username, e-mail or Staff ID -- whether or not it
 * exists, so the limit itself reveals nothing). Once either count reaches its
 * limit, POST /api/session answers 429 until the window passes. This sits on
 * top of the per-account pause after five wrong passwords (lib/accounts.js),
 * and also covers what that cannot: unknown identifiers and the shared
 * passphrase.
 *
 * Keys are salted SHA-256 hashes ('ip:<hex>', 'id:<hex>'): no address,
 * username or e-mail is stored. A database problem here never blocks a
 * sign-in on its own (it is logged); the password check still runs.
 */

export const WINDOW_MINUTES = 15;
export const LIMITS = { ip: 20, id: 10 };

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The throttle keys for a sign-in: by client address (when known) and by identifier (when given). */
export async function throttleKeys(request, env, identifier) {
  const salt = typeof env?.AUTH_SECRET === 'string' && env.AUTH_SECRET ? env.AUTH_SECRET : 'taqwa-auth';
  const keys = [];
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip) keys.push({ key: `ip:${await sha256(`auth-ip:${salt}:${ip}`)}`, limit: LIMITS.ip });
  const id = typeof identifier === 'string' ? identifier.trim().toLowerCase() : '';
  if (id) keys.push({ key: `id:${await sha256(`auth-id:${salt}:${id}`)}`, limit: LIMITS.id });
  return keys;
}

const cutoff = (now) => new Date(now - WINDOW_MINUTES * 60000).toISOString();

/** Is any key over its limit right now? */
export async function isThrottled(env, keys, now = Date.now()) {
  if (!env.DB || !keys.length) return false;
  try {
    for (const { key, limit } of keys) {
      const row = await env.DB.prepare('SELECT failures FROM auth_throttle WHERE key = ?1 AND window_start >= ?2').bind(key, cutoff(now)).first();
      if (row && row.failures >= limit) return true;
    }
    return false;
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) console.error('auth throttle: read failed:', err && err.message);
    return false;
  }
}

/** Count one failed sign-in against every key (a new window starts once the old one is over). */
export async function recordFailure(env, keys, now = Date.now()) {
  if (!env.DB || !keys.length) return;
  const at = new Date(now).toISOString();
  const old = cutoff(now);
  try {
    await env.DB.batch([
      ...keys.map(({ key }) => env.DB.prepare(
        `INSERT INTO auth_throttle (key, window_start, failures) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           failures = CASE WHEN window_start < ?3 THEN 1 ELSE failures + 1 END,
           window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END`
      ).bind(key, at, old)),
      // Forget windows long over, so the table stays small.
      env.DB.prepare('DELETE FROM auth_throttle WHERE window_start < ?1').bind(new Date(now - 24 * 3600 * 1000).toISOString()),
    ]);
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) console.error('auth throttle: write failed:', err && err.message);
  }
}

/** A successful sign-in clears the identifier's count (not the address's). */
export async function clearIdentifier(env, keys) {
  const ids = keys.filter((k) => k.key.startsWith('id:'));
  if (!env.DB || !ids.length) return;
  try {
    await env.DB.batch(ids.map(({ key }) => env.DB.prepare('DELETE FROM auth_throttle WHERE key = ?1').bind(key)));
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) console.error('auth throttle: clear failed:', err && err.message);
  }
}
