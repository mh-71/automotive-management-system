/* ============================================================
   whatsapp.js — the WhatsApp Business Platform (Cloud API)
   ------------------------------------------------------------
   Everything that touches WhatsApp's secrets or Meta's servers:

     * webhook verification (the GET handshake's verify token),
     * webhook signatures (X-Hub-Signature-256, HMAC-SHA256 of the
       RAW body with the Meta App Secret -- the same scheme Messenger
       uses, so the primitives are shared with lib/meta.js),
     * sending a text message (POST /{phone-number-id}/messages),
     * plain-language reasons for the Cloud API's error codes.

   Configuration comes ONLY from Worker secrets / variables:

     WHATSAPP_ACCESS_TOKEN           a token with whatsapp_business_messaging
                                     (a System User token is recommended)
     WHATSAPP_PHONE_NUMBER_ID        the business number's Phone number ID
     WHATSAPP_WEBHOOK_VERIFY_TOKEN   the token typed into the Meta dashboard
     WHATSAPP_APP_SECRET             optional: the App Secret of the Meta app
                                     the WhatsApp webhook belongs to; when
                                     unset, META_APP_SECRET is used (one app
                                     serving both Messenger and WhatsApp)
     META_GRAPH_VERSION              optional, e.g. "v23.0"

   None of them is logged, returned, stored in D1 or sent anywhere but
   graph.facebook.com, and the token travels in an Authorization header,
   never in a URL. `env.META_FETCH` lets the unit suites stand in for
   Meta; it is never set in production.
   ============================================================ */

import { timingSafeEqualStr, signBody } from './meta.js';

const DEFAULT_GRAPH_VERSION = 'v23.0';
const GRAPH_TIMEOUT_MS = 10000;

const value = (v) => (typeof v === 'string' ? v.trim() : '');

/** The App Secret the WhatsApp webhook is signed with: its own, or the shared Meta one. */
const appSecret = (env) => value(env && env.WHATSAPP_APP_SECRET) || value(env && env.META_APP_SECRET);

/** What this Worker can do with WhatsApp, as booleans (and the public number id) -- never a secret. */
export function whatsappConfig(env) {
  return {
    webhook: appSecret(env) !== '' && value(env && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) !== '',
    send: value(env && env.WHATSAPP_ACCESS_TOKEN) !== '' && value(env && env.WHATSAPP_PHONE_NUMBER_ID) !== '',
    phoneNumberId: value(env && env.WHATSAPP_PHONE_NUMBER_ID),
  };
}

const graphVersion = (env) => {
  const v = value(env && env.META_GRAPH_VERSION);
  return /^v\d{1,2}\.\d$/.test(v) ? v : DEFAULT_GRAPH_VERSION;
};
const metaFetch = (env) => (env && typeof env.META_FETCH === 'function' ? env.META_FETCH : fetch);

/** The GET handshake: does this verify token match ours? Both sides trimmed; constant time. */
export function whatsappVerifyTokenMatches(env, supplied) {
  const expected = value(env && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  if (!expected || typeof supplied !== 'string' || supplied.trim() === '') return false;
  return timingSafeEqualStr(supplied.trim(), expected);
}

/** Is `header` ("sha256=<hex>") the App Secret's signature of exactly these raw bytes? */
export async function whatsappSignatureValid(env, header, rawBody) {
  const secret = appSecret(env);
  if (!secret || typeof header !== 'string') return false;
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header.trim());
  if (!m) return false;
  return timingSafeEqualStr(m[1].toLowerCase(), await signBody(secret, rawBody));
}

/**
 * Plain-language reasons for the Cloud API errors staff can act on. Meta's own
 * text is not passed through, because it can name internal details.
 */
export function describeWhatsAppError(code) {
  switch (code) {
    case 131047: return 'More than 24 hours have passed since the customer last wrote, so WhatsApp only allows an approved template message.';
    case 131026: return 'WhatsApp could not deliver this message to the customer\'s number.';
    case 131030: return 'This number is not on the test recipient list of the WhatsApp test number.';
    case 131056: return 'Too many messages to this customer in a short time. Try again shortly.';
    case 130429: case 131048: case 80007: case 4: return 'WhatsApp is limiting how fast this number can send. Try again in a minute.';
    case 190: return 'The WhatsApp connection has expired or was revoked. An administrator needs to renew the access token.';
    case 131031: return 'The WhatsApp Business account is locked or restricted.';
    case 368: return 'The WhatsApp Business account is temporarily blocked from sending.';
    case 131000: case 1: case 2: return 'WhatsApp had a temporary problem. Try again.';
    case 100: return 'WhatsApp rejected the request as invalid.';
    default: return 'WhatsApp refused the message.';
  }
}

const RETRYABLE = new Set([130429, 131048, 131056, 80007, 4, 131000, 1, 2]);

/**
 * Send one text message to `to` (the customer's WhatsApp id) from the
 * configured business number.
 * Resolves to { ok: true, wamid } or { ok: false, code, message, retryable }. Never throws.
 */
export async function sendWhatsAppText(env, to, text) {
  const cfg = whatsappConfig(env);
  if (!cfg.send) return { ok: false, code: 'not_configured', message: 'WhatsApp is not connected yet.', retryable: false };
  const url = `https://graph.facebook.com/${graphVersion(env)}/${encodeURIComponent(cfg.phoneNumberId)}/messages`;
  const body = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: text } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await metaFetch(env)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${value(env.WHATSAPP_ACCESS_TOKEN)}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    const wamid = json && Array.isArray(json.messages) && json.messages[0] && json.messages[0].id;
    if (res.ok && typeof wamid === 'string') return { ok: true, wamid };
    const err = (json && json.error) || {};
    const code = Number.isFinite(err.code) ? err.code : null;
    console.error('WhatsApp Cloud API refused a message:', res.status, code);
    return {
      ok: false,
      code: code === null ? `http_${res.status}` : `wa_${code}`,
      message: describeWhatsAppError(code),
      retryable: res.status >= 500 || (code !== null && RETRYABLE.has(code)),
    };
  } catch (err) {
    console.error('WhatsApp Cloud API unreachable:', err && err.name);
    return { ok: false, code: 'network_error', message: 'WhatsApp could not be reached. The message was not sent.', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
