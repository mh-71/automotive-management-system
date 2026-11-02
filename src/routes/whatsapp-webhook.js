/* ============================================================
   routes/whatsapp-webhook.js — /api/webhooks/whatsapp
   ------------------------------------------------------------
   The one door Meta uses to tell this Worker about WhatsApp activity
   on the workshop's WhatsApp Business number. Public by necessity --
   Meta has no session cookie -- so it carries its own security:

     GET   the subscription handshake. The challenge is echoed back
           only when hub.mode is "subscribe" and hub.verify_token
           matches WHATSAPP_WEBHOOK_VERIFY_TOKEN (constant time).
     POST  an event delivery. Refused unless X-Hub-Signature-256 is the
           HMAC-SHA256 of the RAW body under the App Secret
           (WHATSAPP_APP_SECRET, else META_APP_SECRET). Nothing in an
           unsigned body is read, let alone stored.

   Cloud API payload:
     { object: "whatsapp_business_account",
       entry: [{ id: <WABA id>, changes: [{ field: "messages", value: {
         metadata: { phone_number_id },
         contacts: [{ wa_id, profile: { name } }],
         messages: [{ from, id, timestamp, type, text: { body }, ... }],
         statuses: [{ id, status, timestamp, recipient_id, errors }] } }] }] }

   Handled:
     messages   a customer wrote -> stored, conversation created/updated
     statuses   sent / delivered / read / failed for a message sent from
                here -> moved forward only (a late "delivered" never
                undoes "read")
   Anything else (another business number, other fields) is acknowledged
   and ignored.

   Meta retries a delivery that is not answered 200, so the same event can
   arrive twice: the unique index on the wamid makes the second one a no-op.
   A storage failure answers 500 so that Meta retries it.

   One diagnostic line is logged per request: booleans, counts and the
   status only -- never a token, secret, signature, phone number, message
   id, message text or the body.
   ============================================================ */

import { fail, methodNotAllowed, noDatabase, SECURITY_HEADERS } from '../lib/http.js';
import { allocateId, nowIso } from '../lib/write.js';
import { whatsappConfig, whatsappVerifyTokenMatches, whatsappSignatureValid, describeWhatsAppError } from '../lib/whatsapp.js';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TEXT = 20000;
const PREVIEW = 300;
const WA_ID = /^\d{5,20}$/;
/** Forward-only order of an outbound message's states. */
const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };

const text = (body, status = 200) => new Response(body, {
  status, headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' },
});

/* ---------- GET: the handshake ---------- */

function verify(request, env, url) {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') || '';
  const check = {
    configured: whatsappConfig(env).webhook,
    modeOk: mode === 'subscribe',
    tokenMatched: whatsappVerifyTokenMatches(env, token),
    challengeOk: /^[A-Za-z0-9_-]{1,200}$/.test(challenge),
  };
  const status = !check.configured ? 503 : check.modeOk && check.tokenMatched && check.challengeOk ? 200 : 403;
  console.log(JSON.stringify({ event: 'whatsapp_verify', ...check, status }));
  if (status === 503) return fail('webhook_not_configured', 'This webhook is not configured.', 503);
  if (status === 403) return fail('forbidden', 'Webhook verification failed.', 403);
  return text(challenge);
}

/* ---------- POST: events ---------- */

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : null);
const secondsToIso = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : nowIso();
};

/** The text a message carries, or null for a type this inbox shows only as a label. */
function textOf(m) {
  switch (m.type) {
    case 'text': return clip(m.text && m.text.body, MAX_TEXT);
    case 'button': return clip(m.button && m.button.text, MAX_TEXT);
    case 'interactive': {
      const i = m.interactive || {};
      return clip((i.button_reply && i.button_reply.title) || (i.list_reply && i.list_reply.title), MAX_TEXT);
    }
    case 'image': case 'video': case 'document': return clip(m[m.type] && m[m.type].caption, MAX_TEXT);
    case 'reaction': return clip(m.reaction && m.reaction.emoji, 20);
    default: return null;
  }
}

const LABEL = { image: '[Photo]', video: '[Video]', audio: '[Voice message]', document: '[Document]', sticker: '[Sticker]',
  location: '[Location]', contacts: '[Contact]', reaction: '[Reaction]', button: '[Button]', interactive: '[Reply]' };

function previewOf(type, body) {
  if (body && body.trim()) return `${type !== 'text' && LABEL[type] ? `${LABEL[type]} ` : ''}${body.replace(/\s+/g, ' ').trim()}`.slice(0, PREVIEW);
  return LABEL[type] || '[Message]';
}

/** The conversation for this business number and customer, created on their first message. */
async function conversationFor(env, phoneNumberId, waId, name) {
  const find = () => env.DB.prepare(
    'SELECT id FROM whatsapp_conversations WHERE phone_number_id = ?1 AND customer_wa_id = ?2'
  ).bind(phoneNumberId, waId).first();
  let row = await find();
  if (!row) {
    const allocated = await allocateId(env, 'whatsappConversations');
    if (allocated.error) throw new Error(allocated.error);
    const now = nowIso();
    await env.DB.prepare(
      `INSERT INTO whatsapp_conversations (id, phone_number_id, customer_wa_id, customer_name, status, unread_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'Open', 0, ?5, ?5)
       ON CONFLICT(phone_number_id, customer_wa_id) DO NOTHING`
    ).bind(allocated.id, phoneNumberId, waId, name, now).run();
    row = await find();
  } else if (name) {
    // The customer's WhatsApp profile name, as WhatsApp reports it on each message.
    await env.DB.prepare('UPDATE whatsapp_conversations SET customer_name = ?2 WHERE id = ?1 AND customer_name IS NOT ?2')
      .bind(row.id, name).run();
  }
  return row;
}

async function storeMessage(env, phoneNumberId, m, names) {
  const waId = typeof m.from === 'string' ? m.from : '';
  const wamid = clip(m.id, 200);
  if (!WA_ID.test(waId) || !wamid) return 'ignored';
  const type = typeof m.type === 'string' && /^[a-z_]{1,30}$/.test(m.type) ? m.type : 'unsupported';
  const conv = await conversationFor(env, phoneNumberId, waId, names.get(waId) || null);
  const body = textOf({ ...m, type });
  const at = secondsToIso(m.timestamp);
  const res = await env.DB.prepare(
    `INSERT INTO whatsapp_messages (conversation_id, wamid, direction, sender_type, type, message_text, status, platform_timestamp, created_at)
     VALUES (?1, ?2, 'in', 'customer', ?3, ?4, 'received', ?5, ?6)
     ON CONFLICT(wamid) WHERE wamid IS NOT NULL DO NOTHING`
  ).bind(conv.id, wamid, type, body, Number.isFinite(Number(m.timestamp)) ? Number(m.timestamp) : null, at).run();
  if (!res.meta || res.meta.changes !== 1) return 'duplicate';
  await env.DB.prepare(
    `UPDATE whatsapp_conversations
        SET unread_count = unread_count + 1,
            last_message = ?2, last_message_at = ?3, last_direction = 'in', last_inbound_at = ?3,
            status = CASE WHEN status = 'Resolved' THEN 'Open' ELSE status END,
            updated_at = ?4
      WHERE id = ?1`
  ).bind(conv.id, previewOf(type, body), at, nowIso()).run();
  return 'stored';
}

/** sent / delivered / read move forward only; failed records the reason. */
async function storeStatus(env, s) {
  const wamid = clip(s && s.id, 200);
  const state = s && s.status;
  if (!wamid || !['sent', 'delivered', 'read', 'failed'].includes(state)) return 'ignored';
  if (state === 'failed') {
    const code = s.errors && s.errors[0] && Number.isFinite(s.errors[0].code) ? s.errors[0].code : null;
    const res = await env.DB.prepare(
      `UPDATE whatsapp_messages SET status = 'failed', error_code = ?2, error_message = ?3, updated_at = ?4
        WHERE wamid = ?1 AND direction = 'out' AND status <> 'read'`
    ).bind(wamid, code === null ? 'wa_failed' : `wa_${code}`, describeWhatsAppError(code), nowIso()).run();
    return res.meta && res.meta.changes ? 'updated' : 'ignored';
  }
  const res = await env.DB.prepare(
    `UPDATE whatsapp_messages SET status = ?2, updated_at = ?3
      WHERE wamid = ?1 AND direction = 'out'
        AND (CASE status WHEN 'sending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 9 END) < ?4`
  ).bind(wamid, state, nowIso(), RANK[state]).run();
  return res.meta && res.meta.changes ? 'updated' : 'ignored';
}

async function receive(request, env) {
  const diag = { event: 'whatsapp_delivery', signatureHeader: false, signatureValid: false, objectOk: false,
    changes: 0, otherNumber: 0, stored: 0, duplicate: 0, updated: 0, ignored: 0 };
  const done = (response) => {
    console.log(JSON.stringify({ ...diag, status: response.status }));
    return response;
  };

  const cfg = whatsappConfig(env);
  if (!cfg.webhook) return done(fail('webhook_not_configured', 'This webhook is not configured.', 503));
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return done(fail('payload_too_large', 'Delivery too large.', 413));
  const signature = request.headers.get('x-hub-signature-256');
  diag.signatureHeader = typeof signature === 'string' && signature !== '';
  diag.signatureValid = await whatsappSignatureValid(env, signature, raw);
  if (!diag.signatureValid) return done(fail('invalid_signature', 'Signature verification failed.', 401));
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return done(fail('invalid_body', 'Body is not JSON.', 400)); }
  diag.objectOk = Boolean(payload && payload.object === 'whatsapp_business_account' && Array.isArray(payload.entry));
  if (!diag.objectOk) return done(text('IGNORED'));
  if (!env.DB) return done(noDatabase());

  try {
    for (const entry of payload.entry.slice(0, 50)) {
      for (const change of (Array.isArray(entry && entry.changes) ? entry.changes.slice(0, 50) : [])) {
        if (!change || change.field !== 'messages' || !change.value) { diag.ignored += 1; continue; }
        diag.changes += 1;
        const v = change.value;
        const number = v.metadata && typeof v.metadata.phone_number_id === 'string' ? v.metadata.phone_number_id : '';
        // Only the configured business number is this inbox's.
        if (!number || (cfg.phoneNumberId && number !== cfg.phoneNumberId)) { diag.otherNumber += 1; continue; }
        const names = new Map((Array.isArray(v.contacts) ? v.contacts : [])
          .filter((c) => c && typeof c.wa_id === 'string')
          .map((c) => [c.wa_id, clip(c.profile && c.profile.name, 120) || null]));
        for (const m of (Array.isArray(v.messages) ? v.messages.slice(0, 100) : [])) diag[await storeMessage(env, number, m || {}, names)] += 1;
        for (const s of (Array.isArray(v.statuses) ? v.statuses.slice(0, 100) : [])) diag[await storeStatus(env, s)] += 1;
      }
    }
  } catch (err) {
    // 500 makes Meta deliver it again; what was already stored is deduplicated then.
    console.error('WhatsApp webhook: storing an event failed:', err && err.message);
    return done(fail('database_error', 'The event could not be stored.', 500));
  }
  return done(text('EVENT_RECEIVED'));
}

/** The router hands every /api/webhooks/whatsapp request here. Public: see the header. */
export async function whatsappWebhook(request, env, url) {
  if (request.method === 'GET') return verify(request, env, url);
  if (request.method === 'POST') return receive(request, env);
  return methodNotAllowed(['GET', 'POST']);
}
