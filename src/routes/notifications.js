/**
 * Notifications Center API (0017). Behind the auth gate, like every business
 * read: src/index.js dispatches /api/notifications/* through run().
 *
 *   GET  /api/notifications                 the caller's notifications, newest first
 *        ?status=all|unread|read  ?category=<one of CATEGORIES>  ?q=<text>
 *        ?limit=1..100 (25)  ?offset=0..  ?refresh=1 (check due/low-stock now)
 *   GET  /api/notifications/unread-count    { unread, important, latestId } -- for polling
 *   POST /api/notifications/read-all        { upToId? } -- everything visible up to that id
 *   POST /api/notifications/:id/read
 *   POST /api/notifications/:id/unread
 *
 * Who sees what: a notification with no recipient is for everyone signed in;
 * one with a recipient is for that user account only -- anyone else gets 404
 * for it, exactly as for one that does not exist. Read state is per reader
 * (the signed-in identity from the auth gate, never a value from the client).
 */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, notFound, unprocessable } from '../lib/http.js';
import { nowIso } from '../lib/write.js';
import { CATEGORIES, readerOf, sweepNotifications } from '../lib/notifications.js';

export const NOTIFICATION_ROUTES = [
  'GET /api/notifications',
  'GET /api/notifications/unread-count',
  'POST /api/notifications/read-all',
  'POST /api/notifications/:id/read',
  'POST /api/notifications/:id/unread',
];

const STATUSES = ['all', 'unread', 'read'];
const Q_MAX = 100;
const ID = /^[1-9]\d{0,14}$/;

// ?1 = reader, ?2 = the caller's account id (or NULL). What the caller may
// see is who.visible (lib/notifications.js visibleSql): their own personal
// notifications, and shared ones about records their role may view.
const FROM = `FROM notifications n
  LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.reader = ?1`;

function toNotification(row) {
  return {
    id: row.id,
    type: row.event_type,
    category: row.category,
    priority: row.priority,
    title: row.title,
    message: row.message,
    recordType: row.record_type,
    recordId: row.record_id,
    personal: row.recipient_account_id !== null,
    actorName: row.actor_name,
    createdAt: row.created_at,
    read: row.read_at !== null,
    readAt: row.read_at,
  };
}

const COLUMNS = `n.id, n.event_type, n.category, n.priority, n.title, n.message, n.record_type, n.record_id,
  n.recipient_account_id, n.actor_name, n.created_at, r.read_at`;

async function counts(env, who) {
  const row = await env.DB.prepare(
    `SELECT count(*) AS total,
            coalesce(sum(CASE WHEN r.notification_id IS NULL THEN 1 ELSE 0 END), 0) AS unread,
            coalesce(sum(CASE WHEN r.notification_id IS NULL AND n.priority = 'important' THEN 1 ELSE 0 END), 0) AS important,
            coalesce(max(n.id), 0) AS latest_id
       ${FROM} WHERE ${who.visible}`
  ).bind(who.reader, who.accountId).first();
  return { total: row.total, unread: row.unread, important: row.important, latestId: row.latest_id };
}

/** Run the time-based check; a failure there must not stop the caller seeing what exists. */
async function sweep(env, force) {
  try {
    await sweepNotifications(env, { force });
  } catch (err) {
    console.error('notifications: sweep failed:', err && err.message);
  }
}

async function list(env, who, url) {
  const limit = readIntParam(url, 'limit', { def: 25, min: 1, max: 100 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: 1000000 });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || 'all';
  if (!STATUSES.includes(status)) return fail('invalid_parameter', `\`status\` must be one of: ${STATUSES.join(', ')}.`, 400);
  const category = url.searchParams.get('category') || null;
  if (category !== null && !CATEGORIES.includes(category)) {
    return fail('invalid_parameter', `\`category\` must be one of: ${CATEGORIES.join(', ')}.`, 400);
  }
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > Q_MAX) return fail('invalid_parameter', `\`q\` must be ${Q_MAX} characters or fewer.`, 400);
  const refresh = url.searchParams.get('refresh');
  if (refresh !== null && refresh !== '' && refresh !== '0' && refresh !== '1') {
    return fail('invalid_parameter', '`refresh` must be 0 or 1.', 400);
  }
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

  await sweep(env, refresh === '1');

  const where = `WHERE ${who.visible}
      AND (?3 = 'all' OR (?3 = 'unread' AND r.notification_id IS NULL) OR (?3 = 'read' AND r.notification_id IS NOT NULL))
      AND (?4 IS NULL OR n.category = ?4)
      AND (?5 IS NULL OR lower(n.title) LIKE ?5 ESCAPE '\\' OR lower(n.message) LIKE ?5 ESCAPE '\\'
           OR lower(coalesce(n.record_id, '')) LIKE ?5 ESCAPE '\\')`;
  const binds = [who.reader, who.accountId, status, category, needle];
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} ${FROM} ${where} ORDER BY n.id DESC LIMIT ?6 OFFSET ?7`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n ${FROM} ${where}`).bind(...binds).first();
    const rows = (results || []).map(toNotification);
    return ok(rows, {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      summary: await counts(env, who),
    });
  } catch (err) {
    console.error('notifications: list failed:', err && err.message);
    return fail('notifications_unavailable', 'Notifications could not be loaded right now.', 503);
  }
}

async function unreadCount(env, who) {
  await sweep(env, false);
  try {
    return ok(await counts(env, who));
  } catch (err) {
    console.error('notifications: count failed:', err && err.message);
    return fail('notifications_unavailable', 'Notifications could not be loaded right now.', 503);
  }
}

async function findVisible(env, who, id) {
  return env.DB.prepare(`SELECT ${COLUMNS} ${FROM} WHERE n.id = ?3 AND ${who.visible}`)
    .bind(who.reader, who.accountId, id).first();
}

async function setRead(env, who, rawId, read) {
  if (!ID.test(rawId)) return fail('invalid_id', 'Notification id must be a positive whole number.', 400);
  const id = Number(rawId);
  try {
    const found = await findVisible(env, who, id);
    if (!found) return fail('not_found', `No notification ${id}.`, 404);
    if (read) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO notification_reads (notification_id, reader, read_at) VALUES (?1, ?2, ?3)'
      ).bind(id, who.reader, nowIso()).run();
    } else {
      await env.DB.prepare('DELETE FROM notification_reads WHERE notification_id = ?1 AND reader = ?2')
        .bind(id, who.reader).run();
    }
    return ok(toNotification(await findVisible(env, who, id)), { summary: await counts(env, who) });
  } catch (err) {
    console.error('notifications: read state not saved:', err && err.message);
    return fail('notifications_unavailable', 'The notification could not be updated right now.', 503);
  }
}

async function readAll(request, env, who) {
  // The body is optional: no body (or {}) means everything visible now.
  let body = {};
  let raw;
  try { raw = await request.text(); } catch { raw = ''; }
  if (raw && raw.trim()) {
    if (raw.length > 1024) return fail('invalid_body', 'Request body is too large.', 400);
    try { body = JSON.parse(raw); } catch { return fail('invalid_body', 'Request body is not valid JSON.', 400); }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return fail('invalid_body', 'Request body must be a JSON object.', 400);
    }
  }
  const upToId = body.upToId === undefined || body.upToId === null ? null : body.upToId;
  if (upToId !== null && !(Number.isSafeInteger(upToId) && upToId > 0)) {
    return unprocessable('The request has invalid fields.', { upToId: '`upToId` must be a positive whole number.' });
  }
  try {
    // Only up to the newest one the caller has seen, so a notification that
    // arrived after the page was drawn is not marked read unseen.
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO notification_reads (notification_id, reader, read_at)
       SELECT n.id, ?1, ?3 ${FROM}
        WHERE ${who.visible} AND r.notification_id IS NULL AND (?4 IS NULL OR n.id <= ?4)`
    ).bind(who.reader, who.accountId, nowIso(), upToId).run();
    return ok({ marked: (res.meta && res.meta.changes) || 0 }, { summary: await counts(env, who) });
  } catch (err) {
    console.error('notifications: read-all not saved:', err && err.message);
    return fail('notifications_unavailable', 'Notifications could not be updated right now.', 503);
  }
}

export async function notifications(request, env, url, rest) {
  if (!env.DB) return noDatabase();
  const who = readerOf(request);
  if (!who) return fail('unauthorized', 'Sign in to see notifications.', 401);
  const parts = rest === '' ? [] : rest.split('/');
  const m = request.method;
  if (parts.length === 0) return m === 'GET' ? list(env, who, url) : methodNotAllowed(['GET']);
  if (parts.length === 1 && parts[0] === 'unread-count') return m === 'GET' ? unreadCount(env, who) : methodNotAllowed(['GET']);
  if (parts.length === 1 && parts[0] === 'read-all') return m === 'POST' ? readAll(request, env, who) : methodNotAllowed(['POST']);
  if (parts.length === 2 && (parts[1] === 'read' || parts[1] === 'unread')) {
    return m === 'POST' ? setRead(env, who, parts[0], parts[1] === 'read') : methodNotAllowed(['POST']);
  }
  return notFound(NOTIFICATION_ROUTES);
}
