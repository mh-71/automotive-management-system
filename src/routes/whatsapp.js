/* ============================================================
   routes/whatsapp.js — /api/whatsapp/...   (migration 0015)
   ------------------------------------------------------------
   The staff side of the WhatsApp inbox. Every route is behind the
   API's auth gate (the router dispatches through run()), so only a
   signed-in member of staff can read, assign or reply.

     GET  /api/whatsapp/conversations                list: q (name, number,
                                                     any message), status,
                                                     unread=1, assigned,
                                                     limit, offset
     GET  /api/whatsapp/conversations/:id            one conversation
     GET  /api/whatsapp/conversations/:id/messages   history: limit,
                                                     before (a message id)
     POST /api/whatsapp/conversations/:id/reply      { text, clientRequestId }
     POST /api/whatsapp/conversations/:id/read       unread count -> 0
     POST /api/whatsapp/conversations/:id/unread     mark unread again
     PUT  /api/whatsapp/conversations/:id/status     { status?, assignedToId?, notes? }

   ---- replies ----

   A reply is saved as 'sending' BEFORE the Cloud API is asked, then
   becomes 'sent' (with the wamid) or 'failed' (with the reason); the
   status webhook later moves it to delivered / read. The screen never
   shows a message as sent that WhatsApp refused. `clientRequestId`
   makes a retried request safe: the same id for the same conversation
   returns the first attempt instead of sending again.

   Free-form replies are offered only inside WhatsApp's customer service
   window -- 24 hours from the customer's last message. Outside it
   WhatsApp requires an approved template, which this inbox does not
   send: it cannot start conversations or broadcast.

   ---- assignment ----

   A conversation is assigned to an ACTIVE member of staff from the
   roster (a staff id or a mechanic id), checked here; the name is kept
   with it as it was when assigned.
   ============================================================ */

import { ok, fail, methodNotAllowed, noDatabase, readIntParam, notFound, unprocessable, conflict } from '../lib/http.js';
import { readJsonBody, nowIso } from '../lib/write.js';
import { principalOf } from '../lib/auth.js';
import { whatsappConfig, sendWhatsAppText } from '../lib/whatsapp.js';

export const CONVERSATION_STATUSES = ['Open', 'Pending', 'Resolved'];
const MAX_REPLY = 4096;            // the Cloud API's limit for one text body
const WINDOW_MS = 24 * 3600 * 1000;
const CONV_ID = /^WAC-\d{1,10}$/;
const STAFF_ID = /^[A-Z]{2,5}-\d{1,10}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const LIMITS = { q: 100, notes: 2000 };

const CONV_COLUMNS = `id, phone_number_id, customer_wa_id, customer_name, status, unread_count, last_message, last_message_at,
  last_direction, last_inbound_at, assigned_to_id, assigned_to_name, notes, created_at, updated_at`;
const MSG_COLUMNS = `id, conversation_id, wamid, direction, sender_type, sent_by, type, message_text, status,
  error_code, error_message, client_request_id, created_at, updated_at`;

/** Is the customer service window still open for this conversation? */
export function windowOpen(row, now = Date.now()) {
  if (!row || !row.last_inbound_at) return false;
  return now - Date.parse(row.last_inbound_at) < WINDOW_MS;
}

function toConversation(row, now = Date.now()) {
  return {
    id: row.id,
    platform: 'WhatsApp',
    customerWaId: row.customer_wa_id,
    customerPhone: `+${row.customer_wa_id}`,
    customerName: row.customer_name || `+${row.customer_wa_id}`,
    nameKnown: Boolean(row.customer_name),
    status: row.status,
    unreadCount: row.unread_count,
    lastMessage: row.last_message || '',
    lastMessageAt: row.last_message_at || null,
    lastDirection: row.last_direction || null,
    lastInboundAt: row.last_inbound_at || null,
    canReply: windowOpen(row, now),
    replyWindowEndsAt: row.last_inbound_at ? new Date(Date.parse(row.last_inbound_at) + WINDOW_MS).toISOString() : null,
    assignedToId: row.assigned_to_id || '',
    assignedToName: row.assigned_to_name || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function toMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderType: row.sender_type,
    sentBy: row.sent_by || '',
    type: row.type,
    text: row.message_text || '',
    status: row.status,
    error: row.status === 'failed' ? (row.error_message || 'Not sent.') : '',
    hasPlatformId: Boolean(row.wamid),
    clientRequestId: row.client_request_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function actorName(request) {
  const p = principalOf(request);
  if (!p) return null;
  if (p.kind === 'account') return String(p.username || p.id).slice(0, 100);
  if (p.kind === 'passphrase') return 'Workshop passphrase';
  return 'API token';
}

const findConversation = (env, id) =>
  env.DB.prepare(`SELECT ${CONV_COLUMNS} FROM whatsapp_conversations WHERE id = ?1`).bind(id).first();
const findMessage = (env, id) =>
  env.DB.prepare(`SELECT ${MSG_COLUMNS} FROM whatsapp_messages WHERE id = ?1`).bind(id).first();
const findByRequest = (env, id, requestId) =>
  env.DB.prepare(`SELECT ${MSG_COLUMNS} FROM whatsapp_messages WHERE conversation_id = ?1 AND client_request_id = ?2`)
    .bind(id, requestId).first();

/** An active member of staff on the roster: { id, name } or null. */
async function activeStaff(env, id) {
  return env.DB.prepare(
    `SELECT id, name FROM staff WHERE id = ?1 AND mechanic_id IS NULL AND status = 'Active'
     UNION ALL
     SELECT id, name FROM mechanics WHERE id = ?1 AND status = 'Active'
     LIMIT 1`
  ).bind(id).first();
}

/* ---------- list ---------- */

async function listConversations(request, env, url) {
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const offset = readIntParam(url, 'offset', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (offset.error) return fail('invalid_parameter', offset.error, 400);
  const status = url.searchParams.get('status') || null;
  if (status !== null && !CONVERSATION_STATUSES.includes(status)) {
    return fail('invalid_parameter', `\`status\` must be one of: ${CONVERSATION_STATUSES.join(', ')}.`, 400);
  }
  const unread = url.searchParams.get('unread');
  if (unread !== null && unread !== '' && unread !== '0' && unread !== '1') return fail('invalid_parameter', '`unread` must be 0 or 1.', 400);
  const assigned = url.searchParams.get('assigned') || null;
  if (assigned !== null && assigned !== 'none' && !STAFF_ID.test(assigned)) {
    return fail('invalid_parameter', '`assigned` must be a staff id or "none".', 400);
  }
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > LIMITS.q) return fail('invalid_parameter', `\`q\` must be ${LIMITS.q} characters or fewer.`, 400);
  const needle = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  // A search for a phone number matches its digits, whatever separators were typed.
  const digits = q.replace(/\D/g, '');
  const digitNeedle = digits.length >= 3 ? `%${digits}%` : null;

  const where = `
    WHERE (?1 IS NULL OR status = ?1)
      AND (?2 = 0 OR unread_count > 0)
      AND (?3 IS NULL OR (?3 = 'none' AND assigned_to_id IS NULL) OR assigned_to_id = ?3)
      AND (?4 IS NULL OR lower(coalesce(customer_name, '')) LIKE ?4 ESCAPE '\\'
           OR lower(id) LIKE ?4 ESCAPE '\\' OR lower(coalesce(last_message, '')) LIKE ?4 ESCAPE '\\'
           OR (?5 IS NOT NULL AND customer_wa_id LIKE ?5)
           -- Any message in the conversation, not only the latest one.
           OR EXISTS (SELECT 1 FROM whatsapp_messages m
                       WHERE m.conversation_id = whatsapp_conversations.id
                         AND lower(coalesce(m.message_text, '')) LIKE ?4 ESCAPE '\\'))`;
  const binds = [status, unread === '1' ? 1 : 0, assigned, needle, digitNeedle];
  try {
    const { results } = await env.DB.prepare(
      `SELECT ${CONV_COLUMNS} FROM whatsapp_conversations ${where}
        ORDER BY coalesce(last_message_at, created_at) DESC, id DESC LIMIT ?6 OFFSET ?7`
    ).bind(...binds, limit.value, offset.value).all();
    const total = await env.DB.prepare(`SELECT count(*) AS n FROM whatsapp_conversations ${where}`).bind(...binds).first();
    const sums = await env.DB.prepare(
      `SELECT count(*) AS total,
              coalesce(sum(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END), 0) AS unread_conversations,
              coalesce(sum(unread_count), 0) AS unread_messages,
              coalesce(sum(CASE WHEN status = 'Open' THEN 1 ELSE 0 END), 0) AS open,
              coalesce(sum(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END), 0) AS pending,
              coalesce(sum(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END), 0) AS resolved
         FROM whatsapp_conversations`
    ).first();
    const now = Date.now();
    const rows = (results || []).map((r) => toConversation(r, now));
    const cfg = whatsappConfig(env);
    return ok(rows, {
      count: rows.length, total: total ? total.n : rows.length, limit: limit.value, offset: offset.value,
      summary: {
        total: sums.total, unreadConversations: sums.unread_conversations, unreadMessages: sums.unread_messages,
        open: sums.open, pending: sums.pending, resolved: sums.resolved,
      },
      // Booleans only: whether replies can be sent and events received. Never a value.
      connection: { send: cfg.send, webhook: cfg.webhook },
    });
  } catch (err) {
    console.error('GET /api/whatsapp/conversations failed:', err && err.message);
    return fail('database_error', 'Could not read conversations.', 500);
  }
}

/* ---------- one conversation, its messages ---------- */

async function getConversation(env, id) {
  try {
    const row = await findConversation(env, id);
    if (!row) return fail('not_found', 'No conversation with that id.', 404);
    return ok(toConversation(row));
  } catch (err) {
    console.error('GET /api/whatsapp/conversations/:id failed:', err && err.message);
    return fail('database_error', 'Could not read the conversation.', 500);
  }
}

async function listMessages(env, id, url) {
  const limit = readIntParam(url, 'limit', { def: 50, min: 1, max: 200 });
  if (limit.error) return fail('invalid_parameter', limit.error, 400);
  const before = readIntParam(url, 'before', { def: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (before.error) return fail('invalid_parameter', before.error, 400);
  try {
    const conv = await findConversation(env, id);
    if (!conv) return fail('not_found', 'No conversation with that id.', 404);
    // The newest `limit` messages (older than `before` when paging back), shown oldest first.
    const { results } = await env.DB.prepare(
      `SELECT ${MSG_COLUMNS} FROM whatsapp_messages
        WHERE conversation_id = ?1 AND (?2 = 0 OR id < ?2)
        ORDER BY id DESC LIMIT ?3`
    ).bind(id, before.value, limit.value + 1).all();
    const rows = results || [];
    const hasMore = rows.length > limit.value;
    const page = rows.slice(0, limit.value).reverse().map(toMessage);
    return ok(page, { count: page.length, hasMore, nextBefore: hasMore && page.length ? page[0].id : null });
  } catch (err) {
    console.error('GET /api/whatsapp/conversations/:id/messages failed:', err && err.message);
    return fail('database_error', 'Could not read the messages.', 500);
  }
}

/* ---------- reply ---------- */

async function reply(request, env, id) {
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (!['text', 'clientRequestId'].includes(k)) errors[k] = 'This is not a reply field.';
  const textValue = typeof body.text === 'string' ? body.text.trim() : '';
  if (!textValue) errors.text = 'Write a message first.';
  else if (textValue.length > MAX_REPLY) errors.text = `A WhatsApp message can be at most ${MAX_REPLY} characters.`;
  if (typeof body.clientRequestId !== 'string' || !REQUEST_ID.test(body.clientRequestId)) {
    errors.clientRequestId = '`clientRequestId` is required: 8-64 letters, digits, - or _.';
  }
  if (Object.keys(errors).length) return unprocessable('The reply could not be sent.', errors);

  try {
    const conv = await findConversation(env, id);
    if (!conv) return fail('not_found', 'No conversation with that id.', 404);

    // The same request again (a retry after a dropped connection): answer with the first attempt.
    const prior = await findByRequest(env, id, body.clientRequestId);
    if (prior) return ok(toMessage(prior), { replayed: true });

    if (!whatsappConfig(env).send) {
      return fail('not_configured', 'WhatsApp is not connected yet, so replies cannot be sent.', 503);
    }
    if (!windowOpen(conv)) {
      return conflict('This customer last wrote more than 24 hours ago. WhatsApp only allows a free-form reply within 24 hours of their last message.',
        { reason: 'outside_service_window' });
    }

    const now = nowIso();
    const ins = await env.DB.prepare(
      `INSERT INTO whatsapp_messages (conversation_id, direction, sender_type, sent_by, type, message_text,
         status, client_request_id, platform_timestamp, created_at, updated_at)
       VALUES (?1, 'out', 'staff', ?2, 'text', ?3, 'sending', ?4, ?5, ?6, ?6)
       ON CONFLICT(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
       RETURNING id`
    ).bind(id, actorName(request), textValue, body.clientRequestId, Math.floor(Date.now() / 1000), now).first();
    if (!ins) {
      // A concurrent copy of this request got there first; report its row, send nothing.
      return ok(toMessage(await findByRequest(env, id, body.clientRequestId)), { replayed: true });
    }

    const sent = await sendWhatsAppText(env, conv.customer_wa_id, textValue);
    if (!sent.ok) {
      await env.DB.prepare(
        `UPDATE whatsapp_messages SET status = 'failed', error_code = ?2, error_message = ?3, updated_at = ?4 WHERE id = ?1`
      ).bind(ins.id, sent.code.slice(0, 40), sent.message.slice(0, 300), nowIso()).run();
      // 502: the reply is saved, as failed, so the screen can show it with the reason.
      return fail('send_failed', sent.message, 502, { reason: sent.code, retryable: sent.retryable, messageId: ins.id });
    }
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE whatsapp_messages SET status = CASE WHEN status = 'sending' THEN 'sent' ELSE status END,
                wamid = coalesce(wamid, ?2), updated_at = ?3
          WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM whatsapp_messages WHERE wamid = ?2 AND id <> ?1)`
      ).bind(ins.id, sent.wamid.slice(0, 200), nowIso()),
      env.DB.prepare(
        `UPDATE whatsapp_conversations SET last_message = ?2, last_message_at = ?3, last_direction = 'out',
                unread_count = 0, updated_at = ?3 WHERE id = ?1`
      ).bind(id, textValue.replace(/\s+/g, ' ').slice(0, 300), nowIso()),
    ]);
    return ok(toMessage(await findMessage(env, ins.id)), {}, 201);
  } catch (err) {
    console.error('POST /api/whatsapp/conversations/:id/reply failed:', err && err.message);
    return fail('database_error', 'The reply could not be saved.', 500);
  }
}

/* ---------- read / unread / status ---------- */

async function setRead(env, id, read) {
  try {
    const res = await env.DB.prepare(
      read
        ? 'UPDATE whatsapp_conversations SET unread_count = 0, updated_at = ?2 WHERE id = ?1'
        : 'UPDATE whatsapp_conversations SET unread_count = CASE WHEN unread_count = 0 THEN 1 ELSE unread_count END, updated_at = ?2 WHERE id = ?1'
    ).bind(id, nowIso()).run();
    if (!res.meta || res.meta.changes !== 1) return fail('not_found', 'No conversation with that id.', 404);
    return ok(toConversation(await findConversation(env, id)));
  } catch (err) {
    console.error(`POST /api/whatsapp/conversations/:id/${read ? 'read' : 'unread'} failed:`, err && err.message);
    return fail('database_error', 'Could not update the conversation.', 500);
  }
}

async function updateStatus(request, env, id) {
  const parsed = await readJsonBody(request);
  if (parsed.error) return fail('invalid_body', parsed.error, 400);
  const body = parsed.value;
  const errors = {};
  for (const k of Object.keys(body)) if (!['status', 'assignedToId', 'notes'].includes(k)) errors[k] = 'This is not a conversation field.';
  const sets = {};
  if (body.status !== undefined) {
    if (!CONVERSATION_STATUSES.includes(body.status)) errors.status = `Choose one of: ${CONVERSATION_STATUSES.join(', ')}.`;
    else sets.status = body.status;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') errors.notes = 'Must be text.';
    else if ((body.notes || '').trim().length > LIMITS.notes) errors.notes = `Keep this to ${LIMITS.notes} characters or fewer.`;
    else sets.notes = (body.notes || '').trim() || null;
  }
  if (body.assignedToId !== undefined) {
    if (body.assignedToId === null || body.assignedToId === '') {
      sets.assigned_to_id = null; sets.assigned_to_name = null;
    } else if (typeof body.assignedToId !== 'string' || !STAFF_ID.test(body.assignedToId)) {
      errors.assignedToId = 'Choose a member of staff.';
    }
  }
  if (!Object.keys(errors).length && !Object.keys(sets).length && body.assignedToId === undefined) errors.status = 'Nothing to change.';
  if (Object.keys(errors).length) return unprocessable('The conversation could not be updated.', errors);
  try {
    if (typeof body.assignedToId === 'string' && body.assignedToId !== '') {
      const person = await activeStaff(env, body.assignedToId);
      if (!person) return unprocessable('The conversation could not be updated.', { assignedToId: 'That is not an active member of staff.' });
      sets.assigned_to_id = person.id; sets.assigned_to_name = String(person.name || person.id).slice(0, 120);
    }
    const names = Object.keys(sets);
    const res = await env.DB.prepare(
      `UPDATE whatsapp_conversations SET ${names.map((n, i) => `${n} = ?${i + 2}`).join(', ')}, updated_at = ?${names.length + 2}
        WHERE id = ?1`
    ).bind(id, ...names.map((n) => sets[n]), nowIso()).run();
    if (!res.meta || res.meta.changes !== 1) return fail('not_found', 'No conversation with that id.', 404);
    return ok(toConversation(await findConversation(env, id)));
  } catch (err) {
    console.error('PUT /api/whatsapp/conversations/:id/status failed:', err && err.message);
    return fail('database_error', 'Could not update the conversation.', 500);
  }
}

/* ---------- the router for /api/whatsapp/... ---------- */

export const WHATSAPP_ROUTES = [
  'GET /api/whatsapp/conversations',
  'GET /api/whatsapp/conversations/:id',
  'GET /api/whatsapp/conversations/:id/messages',
  'POST /api/whatsapp/conversations/:id/reply',
  'POST /api/whatsapp/conversations/:id/read',
  'POST /api/whatsapp/conversations/:id/unread',
  'PUT /api/whatsapp/conversations/:id/status',
];

/** `rest` is the path after /api/whatsapp/. Called only once the auth gate has passed. */
export async function whatsapp(request, env, url, rest) {
  if (!env.DB) return noDatabase();
  const parts = rest.split('/');
  if (parts[0] !== 'conversations' || parts.length > 3) return notFound(WHATSAPP_ROUTES);
  const m = request.method;
  if (parts.length === 1) return m === 'GET' ? listConversations(request, env, url) : methodNotAllowed(['GET']);
  let id;
  try { id = decodeURIComponent(parts[1]); } catch { id = ''; }
  if (!CONV_ID.test(id)) return fail('invalid_id', 'Conversation id must look like WAC-0001.', 400);
  if (parts.length === 2) return m === 'GET' ? getConversation(env, id) : methodNotAllowed(['GET']);
  const action = parts[2];
  if (action === 'messages') return m === 'GET' ? listMessages(env, id, url) : methodNotAllowed(['GET']);
  if (action === 'reply') return m === 'POST' ? reply(request, env, id) : methodNotAllowed(['POST']);
  if (action === 'read') return m === 'POST' ? setRead(env, id, true) : methodNotAllowed(['POST']);
  if (action === 'unread') return m === 'POST' ? setRead(env, id, false) : methodNotAllowed(['POST']);
  if (action === 'status') return m === 'PUT' ? updateStatus(request, env, id) : methodNotAllowed(['PUT']);
  return notFound(WHATSAPP_ROUTES);
}
