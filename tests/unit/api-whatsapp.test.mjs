/* WhatsApp (0015) — unit tests against the REAL Worker:
   /api/webhooks/whatsapp and /api/whatsapp/...

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0015). Meta is never contacted: env.META_FETCH stands in
   for graph.facebook.com and records every call it would have made.

   What must hold:
     A. Schema: the two tables, their CHECKs and unique indexes, the WAC
        counter; additive; re-runnable; no column for a secret.
     B. Webhook GET: challenge only for subscribe + the right token (spaces
        tolerated); wrong or missing token, mode or config refused.
     C. Webhook POST security: missing, malformed or wrong signatures
        refused before anything is stored; the App Secret is trimmed; an
        optional WhatsApp-specific secret wins over the shared one.
     D. Events: a text creates the conversation (WhatsApp profile name) and
        is stored; another updates it; duplicates are no-ops; non-text types
        are kept as labelled rows; another business number and other fields
        are ignored; statuses move forward only; failed keeps a reason.
     E. Inbox API: 401 without a credential (before any statement); list,
        search (name, message, phone digits), status / unread / assigned
        filters, paging, summary, connection booleans; read and unread;
        status, notes and assignment to an active member of staff only.
     F. Replies: validation; not configured; outside the 24-hour window;
        sent (wamid saved, the token in a header, never in the URL); a
        retried request is not sent twice; a Cloud API refusal or network
        failure is saved as failed with a plain reason.
     G. The diagnostic log lines hold only booleans, counts and the status.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  good ? pass++ : fail++;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}`);
  if (!good) console.log(`        expected ${JSON.stringify(expected)}\n        got      ${JSON.stringify(actual)}`);
};
const ok_ = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -- ' + detail}`);
};

let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* reported below */ }
if (!DatabaseSync) {
  console.log('SKIPPED  node:sqlite is not available in this Node version; nothing was checked.');
  console.log(`\nWhatsApp unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = readdirSync(join(ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) <= '0015').sort();
const TOKEN = 'unit-test-token';
const APP_SECRET = 'test-app-secret-not-real';
const VERIFY = 'test-wa-verify-not-real';
const WA_TOKEN = 'test-wa-access-token-not-real';
const NUMBER = '109876543210';
const CUSTOMER = '8801711000001';
const NOW_S = Math.floor(Date.now() / 1000);
const AT = '2026-10-08T00:00:00Z';

function makeD1() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of MIGRATIONS) raw.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const returnsRows = (sql) => /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
  const clean = (a) => a.map((x) => (x === undefined ? null : x));
  const statements = [];
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...a) { return new Stmt(this.sql, clean(a)); }
    exec() {
      statements.push(this.sql);
      const s = raw.prepare(this.sql);
      if (returnsRows(this.sql)) { const r = s.all(...this.binds); return { results: r, meta: { changes: r.length } }; }
      const r = s.run(...this.binds);
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async first(col) {
      if (/\bRETURNING\b/i.test(this.sql)) { const r = this.exec().results[0] ?? null; return r && col ? r[col] : r; }
      statements.push(this.sql);
      const r = raw.prepare(this.sql).get(...this.binds) ?? null; return r && col ? r[col] : r;
    }
    async all() { statements.push(this.sql); return { results: raw.prepare(this.sql).all(...this.binds), meta: {} }; }
    async run() { return this.exec(); }
  }
  return {
    raw, statements,
    prepare: (sql) => new Stmt(sql),
    async batch(list) {
      raw.exec('BEGIN');
      try { const out = list.map((s) => s.exec()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
  };
}



/** A stand-in for graph.facebook.com: records calls, answers as told. */
function fakeMeta() {
  const calls = [];
  let mode = 'ok', seq = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (mode === 'network') throw new TypeError('fetch failed');
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (mode === 'window') return json(400, { error: { message: 'internal detail text', code: 131047 } });
    if (mode === 'token') return json(401, { error: { message: 'secret internal token detail', code: 190 } });
    if (mode === 'rate') return json(400, { error: { message: 'x', code: 130429 } });
    return json(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: CUSTOMER }], messages: [{ id: `wamid.SENT${++seq}` }] });
  };
  fn.calls = calls;
  fn.set = (m) => { mode = m; };
  return fn;
}

function fresh(envExtra = {}) {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO mechanics (id, name, phone, created_at) VALUES ('MEC-0001', 'Jamal Uddin', '01800000001', '${AT}');
    INSERT INTO mechanics (id, name, phone, status, created_at) VALUES ('MEC-0002', 'Left Already', '01800000002', 'Inactive', '${AT}');
    INSERT INTO staff (id, name, phone, status, designation, department, created_at) VALUES ('STF-0001', 'Nadia Akter', '01911000001', 'Active', 'Service Advisor', 'Front Desk', '${AT}');`);
  const meta = fakeMeta();
  const env = { DB, API_TOKEN: TOKEN, META_APP_SECRET: APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
    WHATSAPP_ACCESS_TOKEN: WA_TOKEN, WHATSAPP_PHONE_NUMBER_ID: NUMBER, META_FETCH: meta, ...envExtra };
  const api = async (method, path, body, cred = 'token') => {
    const headers = {};
    if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`;
    const res = await worker.fetch(new Request('http://worker.local' + path, {
      method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env, {});
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: json, text };
  };
  const hook = async (payload, { sign = true, secret = APP_SECRET, header = null, e = env } = {}) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sig = header ?? (sign ? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` : null);
    const res = await worker.fetch(new Request('http://worker.local/api/webhooks/whatsapp', {
      method: 'POST', headers: sig ? { 'x-hub-signature-256': sig, 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: raw,
    }), e, {});
    return { status: res.status, text: await res.text() };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);
  return { DB, env, api, hook, one, all, meta };
}

/** A Cloud API "messages" delivery. */
const delivery = ({ messages = [], statuses = [], contacts = [], number = NUMBER, field = 'messages', object = 'whatsapp_business_account' } = {}) => ({
  object, entry: [{ id: 'WABA1', changes: [{ field, value: { messaging_product: 'whatsapp',
    metadata: { display_phone_number: '8801700000000', phone_number_id: number }, contacts, messages, statuses } }] }],
});
const textMsg = (id, body, from = CUSTOMER, ts = NOW_S) => ({ from, id, timestamp: String(ts), type: 'text', text: { body } });
const contact = (wa = CUSTOMER, name = 'Rahim Uddin') => ({ wa_id: wa, profile: { name } });

/* ---------- A. schema ---------- */
{
  const h = fresh();
  check('the conversation table has the planned columns', h.all('PRAGMA table_info(whatsapp_conversations)').map((c) => c.name),
    ['id', 'phone_number_id', 'customer_wa_id', 'customer_name', 'status', 'unread_count', 'last_message', 'last_message_at', 'last_direction',
      'last_inbound_at', 'assigned_to_id', 'assigned_to_name', 'notes', 'created_at', 'updated_at']);
  check('the message table has the planned columns', h.all('PRAGMA table_info(whatsapp_messages)').map((c) => c.name),
    ['id', 'conversation_id', 'wamid', 'direction', 'sender_type', 'sent_by', 'type', 'message_text', 'status', 'error_code', 'error_message',
      'client_request_id', 'platform_timestamp', 'created_at', 'updated_at']);
  check('a WAC counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='whatsappConversations'"), { prefix: 'WAC', last_value: 0 });
  ok_('no column could hold a token or secret', !h.all("SELECT name FROM pragma_table_info('whatsapp_conversations') UNION SELECT name FROM pragma_table_info('whatsapp_messages')").some((c) => /token|secret|password/i.test(c.name)));
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|FOREIGN KEY|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  check('a valid conversation is accepted', ins("INSERT INTO whatsapp_conversations (id, phone_number_id, customer_wa_id, created_at) VALUES ('WAC-9', 'n', '880', 'x')"), 'ok');
  check('one conversation per number and customer', ins("INSERT INTO whatsapp_conversations (id, phone_number_id, customer_wa_id, created_at) VALUES ('WAC-8', 'n', '880', 'x')"), 'UNIQUE');
  check('an assignment needs both id and name', ins("UPDATE whatsapp_conversations SET assigned_to_id = 'STF-1' WHERE id = 'WAC-9'"), 'CHECK');
  check('a message must belong to a conversation', ins("INSERT INTO whatsapp_messages (conversation_id, direction, sender_type, status, created_at) VALUES ('WAC-404', 'in', 'customer', 'received', 'x')"), 'FOREIGN KEY');
  check('an outbound message cannot be "received"', ins("INSERT INTO whatsapp_messages (conversation_id, direction, sender_type, status, created_at) VALUES ('WAC-9', 'out', 'staff', 'received', 'x')"), 'CHECK');
  ins("INSERT INTO whatsapp_messages (conversation_id, wamid, direction, sender_type, status, created_at) VALUES ('WAC-9', 'w1', 'in', 'customer', 'received', 'x')");
  check('a wamid is stored once', ins("INSERT INTO whatsapp_messages (conversation_id, wamid, direction, sender_type, status, created_at) VALUES ('WAC-9', 'w1', 'in', 'customer', 'received', 'x')"), 'UNIQUE');
  check('a conversation with messages cannot be deleted', ins("DELETE FROM whatsapp_conversations WHERE id = 'WAC-9'"), 'FOREIGN KEY');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0015_whatsapp.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable', again, 'ok');
  const plain = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS.slice(0, -1)) plain.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%whatsapp%' AND name NOT LIKE '%_wac_%' AND name NOT LIKE '%_wam_%' ORDER BY name").all());
  check('0015 is additive: every other table and index is unchanged', shape(h.DB.raw) === shape(plain), true);
}

/* ---------- B. webhook GET ---------- */
{
  const h = fresh();
  const get = (qs, env = h.env) => worker.fetch(new Request(`http://worker.local/api/webhooks/whatsapp?${qs}`), env);
  const r = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=987654`);
  check('the right token gets the exact challenge back as plain text', [r.status, await r.text(), r.headers.get('content-type')], [200, '987654', 'text/plain; charset=utf-8']);
  check('a token with a trailing space still verifies', (await get(`hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY + ' ')}&hub.challenge=1`)).status, 200);
  check('a wrong token is 403', (await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  check('the Messenger token does not verify WhatsApp', (await get(`hub.mode=subscribe&hub.verify_token=messenger-token&hub.challenge=1`, { ...h.env, META_WEBHOOK_VERIFY_TOKEN: 'messenger-token' })).status, 403);
  check('the wrong mode is 403', (await get(`hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status, 403);
  check('a challenge that is not Meta\'s shape is never echoed', (await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cb%3E`)).status, 403);
  check('not configured is 503', (await get('hub.mode=subscribe&hub.verify_token=x&hub.challenge=1', { DB: h.DB })).status, 503);
}

/* ---------- C. webhook POST security ---------- */
{
  const h = fresh();
  const ev = delivery({ messages: [textMsg('wamid.A', 'Hi')], contacts: [contact()] });
  h.DB.statements.length = 0;
  check('no signature is 401', (await h.hook(ev, { sign: false })).status, 401);
  check('another secret is 401', (await h.hook(ev, { secret: 'other' })).status, 401);
  check('a SHA1 header is not accepted', (await h.hook(ev, { header: 'sha1=abc' })).status, 401);
  check('nothing was read or stored for a refused delivery', [h.DB.statements.length, h.one('SELECT count(*) AS n FROM whatsapp_messages').n], [0, 0]);
  check('the App Secret saved with a trailing line break still verifies', (await h.hook(ev, { e: { ...h.env, META_APP_SECRET: `${APP_SECRET}\r\n` } })).status, 200);
  const own = fresh({ WHATSAPP_APP_SECRET: 'wa-only-secret' });
  check('a WhatsApp-specific App Secret wins over the shared one', [(await own.hook(ev, { secret: 'wa-only-secret' })).status, (await own.hook(ev)).status], [200, 401]);
  check('with no App Secret configured every delivery is refused (503)', (await h.hook(ev, { e: { DB: h.DB, WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY } })).status, 503);
  check('a signed body that is not JSON is 400', (await h.hook('not json')).status, 400);
  check('another object type is acknowledged and ignored', (await h.hook({ object: 'page', entry: [] })).status, 200);
  check('PUT on the webhook is 405', (await h.api('PUT', '/api/webhooks/whatsapp', {}, 'none')).status, 405);
}

/* ---------- D. events ---------- */
{
  const h = fresh();
  const r = await h.hook(delivery({ messages: [textMsg('wamid.1', 'Assalamu alaikum, is my car ready?')], contacts: [contact()] }));
  check('a text message is acknowledged', [r.status, r.text], [200, 'EVENT_RECEIVED']);
  const c = h.one('SELECT * FROM whatsapp_conversations');
  check('it creates the conversation with the WhatsApp profile name', [c.id, c.customer_wa_id, c.phone_number_id, c.customer_name, c.status, c.unread_count, c.last_direction],
    ['WAC-0001', CUSTOMER, NUMBER, 'Rahim Uddin', 'Open', 1, 'in']);
  check('...and stores the message as received', h.one('SELECT direction, sender_type, type, message_text, status, wamid FROM whatsapp_messages'),
    { direction: 'in', sender_type: 'customer', type: 'text', message_text: 'Assalamu alaikum, is my car ready?', status: 'received', wamid: 'wamid.1' });
  check('...with the window starting at the message time', c.last_inbound_at, new Date(NOW_S * 1000).toISOString());
  ok_('Meta was not called to receive a message', h.meta.calls.length === 0);

  await h.hook(delivery({ messages: [textMsg('wamid.2', 'Tomorrow?', CUSTOMER, NOW_S + 5)], contacts: [contact(CUSTOMER, 'Rahim U.')] }));
  check('a second message updates the same conversation and its name', [h.one('SELECT count(*) AS n FROM whatsapp_conversations').n, h.one('SELECT unread_count FROM whatsapp_conversations').unread_count, h.one('SELECT customer_name FROM whatsapp_conversations').customer_name],
    [1, 2, 'Rahim U.']);
  const dup = await h.hook(delivery({ messages: [textMsg('wamid.2', 'Tomorrow?', CUSTOMER, NOW_S + 5)], contacts: [contact()] }));
  check('a duplicate delivery is acknowledged and stored once', [dup.status, h.one('SELECT count(*) AS n FROM whatsapp_messages').n, h.one('SELECT unread_count FROM whatsapp_conversations').unread_count], [200, 2, 2]);

  await h.hook(delivery({ messages: [{ from: CUSTOMER, id: 'wamid.img', timestamp: String(NOW_S + 6), type: 'image', image: { id: 'MEDIA', caption: 'Scratch on the door' } }] }));
  check('an image is kept with its caption and labelled in the preview', [h.one("SELECT type, message_text FROM whatsapp_messages WHERE wamid='wamid.img'"), h.one('SELECT last_message FROM whatsapp_conversations').last_message],
    [{ type: 'image', message_text: 'Scratch on the door' }, '[Photo] Scratch on the door']);
  await h.hook(delivery({ messages: [{ from: CUSTOMER, id: 'wamid.voice', timestamp: String(NOW_S + 7), type: 'audio', audio: { id: 'M' } }] }));
  check('a voice note is kept as a labelled row', [h.one("SELECT type, message_text FROM whatsapp_messages WHERE wamid='wamid.voice'"), h.one('SELECT last_message FROM whatsapp_conversations').last_message],
    [{ type: 'audio', message_text: null }, '[Voice message]']);
  await h.hook(delivery({ messages: [{ from: CUSTOMER, id: 'wamid.btn', timestamp: String(NOW_S + 8), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b', title: 'Book now' } } }] }));
  check('a button reply is stored as its title', h.one("SELECT message_text FROM whatsapp_messages WHERE wamid='wamid.btn'").message_text, 'Book now');

  h.DB.raw.exec("UPDATE whatsapp_conversations SET status = 'Resolved'");
  await h.hook(delivery({ messages: [textMsg('wamid.3', 'One more thing', CUSTOMER, NOW_S + 9)] }));
  check('a new message reopens a resolved conversation', h.one('SELECT status FROM whatsapp_conversations').status, 'Open');

  const before = h.one('SELECT count(*) AS n FROM whatsapp_messages').n;
  await h.hook(delivery({ messages: [textMsg('wamid.other', 'x')], number: '555' }));
  await h.hook(delivery({ messages: [textMsg('wamid.f', 'x')], field: 'account_update' }));
  await h.hook(delivery({ messages: [{ from: 'not-a-number', id: 'wamid.bad', type: 'text', text: { body: 'x' } }, { from: CUSTOMER, type: 'text', text: { body: 'no id' } }] }));
  check('another business number, other fields and malformed messages are ignored', [h.one('SELECT count(*) AS n FROM whatsapp_messages').n, h.one('SELECT count(*) AS n FROM whatsapp_conversations').n], [before, 1]);

  h.DB.raw.exec(`INSERT INTO whatsapp_messages (conversation_id, wamid, direction, sender_type, status, created_at) VALUES ('WAC-0001', 'wamid.OUT', 'out', 'staff', 'sent', '${AT}')`);
  const st = (status, extra = {}) => h.hook(delivery({ statuses: [{ id: 'wamid.OUT', status, timestamp: String(NOW_S), recipient_id: CUSTOMER, ...extra }] }));
  await st('delivered');
  check('a delivered status moves the reply forward', h.one("SELECT status FROM whatsapp_messages WHERE wamid='wamid.OUT'").status, 'delivered');
  await st('read');
  await st('delivered');
  await st('sent');
  check('read is kept even when an older status arrives late', h.one("SELECT status FROM whatsapp_messages WHERE wamid='wamid.OUT'").status, 'read');
  h.DB.raw.exec(`INSERT INTO whatsapp_messages (conversation_id, wamid, direction, sender_type, status, created_at) VALUES ('WAC-0001', 'wamid.OUT2', 'out', 'staff', 'sent', '${AT}')`);
  await h.hook(delivery({ statuses: [{ id: 'wamid.OUT2', status: 'failed', timestamp: String(NOW_S), recipient_id: CUSTOMER, errors: [{ code: 131026, title: 'internal title' }] }] }));
  check('a failed status records a plain reason, not Meta\'s text', h.one("SELECT status, error_code, error_message FROM whatsapp_messages WHERE wamid='wamid.OUT2'"),
    { status: 'failed', error_code: 'wa_131026', error_message: 'WhatsApp could not deliver this message to the customer\'s number.' });
  await st('read', { id: 'wamid.UNKNOWN' });
  check('statuses never touch inbound messages', h.all("SELECT DISTINCT status FROM whatsapp_messages WHERE direction='in'").map((x) => x.status), ['received']);

  const broken = { ...h.env, DB: { prepare() { throw new Error('D1_ERROR: detail'); } } };
  const res = await h.hook(delivery({ messages: [textMsg('wamid.z', 'x')] }), { e: broken });
  check('a storage failure answers 500 (so Meta retries) and reveals nothing', [res.status, /D1_ERROR|detail/.test(res.text)], [500, false]);
}

/* ---------- E. inbox API ---------- */
{
  const h = fresh();
  for (let i = 1; i <= 6; i++) {
    await h.hook(delivery({ messages: [textMsg(`wamid.c${i}`, i === 3 ? 'Price of AC service?' : `Hello ${i}`, `88017110000${i}0`, NOW_S + i)], contacts: [contact(`88017110000${i}0`, i === 2 ? 'Karim Mia' : `Customer ${i}`)] }));
  }
  h.DB.statements.length = 0;
  const denied = [];
  for (const [m, p, b] of [['GET', '/api/whatsapp/conversations'], ['GET', '/api/whatsapp/conversations/WAC-0001'], ['GET', '/api/whatsapp/conversations/WAC-0001/messages'],
    ['POST', '/api/whatsapp/conversations/WAC-0001/reply', { text: 'x', clientRequestId: 'abcdefgh' }], ['POST', '/api/whatsapp/conversations/WAC-0001/read', {}],
    ['POST', '/api/whatsapp/conversations/WAC-0001/unread', {}], ['PUT', '/api/whatsapp/conversations/WAC-0001/status', { status: 'Resolved' }]]) denied.push((await h.api(m, p, b, 'none')).status);
  check('every inbox route is 401 without a credential', denied, [401, 401, 401, 401, 401, 401, 401]);
  check('...and no statement ran', h.DB.statements.length, 0);

  const list = await h.api('GET', '/api/whatsapp/conversations');
  check('the list is newest first, every row WhatsApp, with the phone number', [list.status, list.body.data.map((c) => c.id), [...new Set(list.body.data.map((c) => c.platform))], list.body.data[5].customerPhone],
    [200, ['WAC-0006', 'WAC-0005', 'WAC-0004', 'WAC-0003', 'WAC-0002', 'WAC-0001'], ['WhatsApp'], '+8801711000010']);
  check('the summary counts conversations and unread', list.body.summary, { total: 6, unreadConversations: 6, unreadMessages: 6, open: 6, pending: 0, resolved: 0 });
  check('the connection is reported as booleans only', list.body.connection, { send: true, webhook: true });
  ok_('no token or secret appears in any response', ![WA_TOKEN, APP_SECRET, VERIFY].some((v) => list.text.includes(v)));
  check('search: a message', (await h.api('GET', '/api/whatsapp/conversations?q=ac%20service')).body.data.map((c) => c.id), ['WAC-0003']);
  check('search: a name', (await h.api('GET', '/api/whatsapp/conversations?q=KARIM')).body.data.map((c) => c.id), ['WAC-0002']);
  check('search: phone digits, separators ignored', (await h.api('GET', `/api/whatsapp/conversations?q=${encodeURIComponent('+880 1711-0000 40')}`)).body.data.map((c) => c.id), ['WAC-0004']);
  await h.hook(delivery({ messages: [textMsg('wamid.c3b', 'A newer message', '8801711000030', NOW_S + 50)] }));
  check('search: an older message, not only the latest', (await h.api('GET', '/api/whatsapp/conversations?q=ac%20service')).body.data.map((c) => c.id), ['WAC-0003']);
  check('LIKE wildcards are literal', (await h.api('GET', '/api/whatsapp/conversations?q=%25')).body.total, 0);
  const page = await h.api('GET', '/api/whatsapp/conversations?limit=2&offset=2');
  check('paging: limit and offset, total is the whole match', [page.body.data.map((c) => c.id), page.body.total], [['WAC-0005', 'WAC-0004'], 6]);
  for (const [qs, label] of [['limit=0', 'limit'], ['status=Gone', 'status'], ['unread=2', 'unread'], ['assigned=bob', 'assigned'], [`q=${'x'.repeat(101)}`, 'q']]) {
    check(`a bad ${label} is 400`, (await h.api('GET', `/api/whatsapp/conversations?${qs}`)).status, 400);
  }

  check('read clears the unread count', (await h.api('POST', '/api/whatsapp/conversations/WAC-0003/read', {})).body.data.unreadCount, 0);
  check('unread=1 then leaves it out', (await h.api('GET', '/api/whatsapp/conversations?unread=1')).body.total, 5);
  check('unread marks it unread again', (await h.api('POST', '/api/whatsapp/conversations/WAC-0003/unread', {})).body.data.unreadCount, 1);
  check('unread on an already-unread conversation keeps its count', (await h.api('POST', '/api/whatsapp/conversations/WAC-0001/unread', {})).body.data.unreadCount, 1);

  const as = await h.api('PUT', '/api/whatsapp/conversations/WAC-0003/status', { status: 'Pending', assignedToId: 'STF-0001', notes: ' Wants a quote ' });
  check('status, notes and assignment to staff are saved, with the staff name', [as.status, as.body.data.status, as.body.data.assignedToId, as.body.data.assignedToName, as.body.data.notes],
    [200, 'Pending', 'STF-0001', 'Nadia Akter', 'Wants a quote']);
  check('a mechanic can be assigned too', (await h.api('PUT', '/api/whatsapp/conversations/WAC-0002/status', { assignedToId: 'MEC-0001' })).body.data.assignedToName, 'Jamal Uddin');
  check('the assigned filter finds them; "none" finds the rest', [(await h.api('GET', '/api/whatsapp/conversations?assigned=STF-0001')).body.data.map((c) => c.id), (await h.api('GET', '/api/whatsapp/conversations?assigned=none')).body.total], [['WAC-0003'], 4]);
  check('an inactive member of staff cannot be assigned', (await h.api('PUT', '/api/whatsapp/conversations/WAC-0001/status', { assignedToId: 'MEC-0002' })).body.error.fields.assignedToId, 'That is not an active member of staff.');
  check('an unknown member of staff cannot be assigned', (await h.api('PUT', '/api/whatsapp/conversations/WAC-0001/status', { assignedToId: 'STF-0999' })).status, 422);
  check('unassigning clears both id and name', [(await h.api('PUT', '/api/whatsapp/conversations/WAC-0002/status', { assignedToId: null })).body.data.assignedToId, h.one("SELECT assigned_to_name FROM whatsapp_conversations WHERE id='WAC-0002'").assigned_to_name], ['', null]);
  check('a bad status is 422', (await h.api('PUT', '/api/whatsapp/conversations/WAC-0003/status', { status: 'Closed' })).status, 422);
  check('an unknown field is 422', (await h.api('PUT', '/api/whatsapp/conversations/WAC-0003/status', { customerName: 'x' })).status, 422);
  check('an empty change is 422', (await h.api('PUT', '/api/whatsapp/conversations/WAC-0003/status', {})).status, 422);
  check('an unknown conversation is 404', [(await h.api('GET', '/api/whatsapp/conversations/WAC-0999')).status, (await h.api('POST', '/api/whatsapp/conversations/WAC-0999/read', {})).status], [404, 404]);
  check('a malformed id is 400', (await h.api('GET', '/api/whatsapp/conversations/FBC-0001')).status, 400);
  check('DELETE on a conversation is 405', (await h.api('DELETE', '/api/whatsapp/conversations/WAC-0001')).status, 405);

  for (let i = 0; i < 4; i++) await h.hook(delivery({ messages: [textMsg(`wamid.more${i}`, `More ${i}`, '8801711000010', NOW_S + 100 + i)] }));
  const msgs = await h.api('GET', '/api/whatsapp/conversations/WAC-0001/messages?limit=3');
  check('messages: the newest page, oldest first, with a cursor back', [msgs.body.data.map((m) => m.text), msgs.body.hasMore], [['More 1', 'More 2', 'More 3'], true]);
  const older = await h.api('GET', `/api/whatsapp/conversations/WAC-0001/messages?limit=3&before=${msgs.body.nextBefore}`);
  check('   ...and the page before it', [older.body.data.map((m) => m.text), older.body.hasMore], [['Hello 1', 'More 0'], false]);
}

/* ---------- F. replies ---------- */
{
  const h = fresh();
  await h.hook(delivery({ messages: [textMsg('wamid.in', 'Is my car ready?', CUSTOMER, Math.floor(Date.now() / 1000))], contacts: [contact()] }));
  const say = (text, id = 'req-000001', extra = {}) => h.api('POST', '/api/whatsapp/conversations/WAC-0001/reply', { text, clientRequestId: id, ...extra });
  check('an empty reply is 422', (await say('   ')).status, 422);
  check('a reply over 4096 characters is 422', (await say('x'.repeat(4097))).status, 422);
  check('a reply without a client request id is 422', (await h.api('POST', '/api/whatsapp/conversations/WAC-0001/reply', { text: 'x' })).status, 422);
  check('a template field is refused (no templates from this inbox)', (await say('x', 'req-000001', { template: 'promo' })).status, 422);
  check('nothing was sent for a refused reply', h.meta.calls.length, 0);

  const sent = await say('  Yes, it is ready. ', 'req-000001');
  check('a reply is sent and saved with the wamid', [sent.status, sent.body.data.status, sent.body.data.text, sent.body.data.hasPlatformId], [201, 'sent', 'Yes, it is ready.', true]);
  const call = h.meta.calls[0];
  check('   ...through the Cloud API, from the configured number, to the customer, as text',
    [call.url, call.body.messaging_product, call.body.to, call.body.type, call.body.text.body],
    [`https://graph.facebook.com/v23.0/${NUMBER}/messages`, 'whatsapp', CUSTOMER, 'text', 'Yes, it is ready.']);
  ok_('   ...with the token in the Authorization header and nowhere in the URL', call.headers.authorization === `Bearer ${WA_TOKEN}` && !call.url.includes(WA_TOKEN));
  ok_('   ...and no template', !('template' in call.body));
  check('   ...recorded as sent by the caller; the conversation shows it and is read', [h.one("SELECT sent_by FROM whatsapp_messages WHERE client_request_id='req-000001'").sent_by,
    h.one('SELECT last_message FROM whatsapp_conversations').last_message, h.one('SELECT unread_count FROM whatsapp_conversations').unread_count], ['API token', 'Yes, it is ready.', 0]);
  const again = await say('Yes, it is ready.', 'req-000001');
  check('the same request again is not sent twice', [again.status, again.body.replayed, h.meta.calls.length, h.one("SELECT count(*) AS n FROM whatsapp_messages WHERE direction='out'").n], [200, true, 1, 1]);
  const wamid = h.one("SELECT wamid FROM whatsapp_messages WHERE client_request_id='req-000001'").wamid;
  await h.hook(delivery({ statuses: [{ id: wamid, status: 'read', timestamp: String(NOW_S), recipient_id: CUSTOMER }] }));
  check('the status webhook marks the reply read', (await h.api('GET', '/api/whatsapp/conversations/WAC-0001/messages')).body.data.find((m) => m.clientRequestId === 'req-000001').status, 'read');

  h.meta.set('window');
  const refused = await say('Another one', 'req-000002');
  check('a Cloud API refusal is 502 and the reply is saved as failed', [refused.status, refused.body.error.code, h.one("SELECT status, error_code FROM whatsapp_messages WHERE client_request_id='req-000002'")],
    [502, 'send_failed', { status: 'failed', error_code: 'wa_131047' }]);
  ok_('   ...the reason is plain language, not Meta\'s text', /24 hours/.test(refused.body.error.message) && !refused.text.includes('internal detail'));
  h.meta.set('token');
  check('an expired token is explained', /renew/.test((await say('x', 'req-000003')).body.error.message), true);
  h.meta.set('rate');
  check('a rate limit is retryable', (await say('x', 'req-000004')).body.error.retryable, true);
  h.meta.set('network');
  const net = await say('x', 'req-000005');
  check('WhatsApp unreachable: failed and retryable', [net.status, net.body.error.retryable, h.one("SELECT status FROM whatsapp_messages WHERE client_request_id='req-000005'").status], [502, true, 'failed']);
  check('the preview still shows the last reply that was sent', h.one('SELECT last_message FROM whatsapp_conversations').last_message, 'Yes, it is ready.');

  h.DB.raw.exec(`UPDATE whatsapp_conversations SET last_inbound_at = '${new Date(Date.now() - 25 * 3600 * 1000).toISOString()}'`);
  h.meta.set('ok');
  const calls = h.meta.calls.length;
  const late = await say('Too late', 'req-000006');
  check('outside the 24-hour window the reply is refused before WhatsApp is asked', [late.status, late.body.error.reason, h.meta.calls.length], [409, 'outside_service_window', calls]);
  check('   ...and the conversation says it cannot be replied to', (await h.api('GET', '/api/whatsapp/conversations/WAC-0001')).body.data.canReply, false);

  const none = fresh({ WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '' });
  await none.hook(delivery({ messages: [textMsg('wamid.n', 'hi', CUSTOMER, Math.floor(Date.now() / 1000))], number: '' }));
  check('with no number configured, a delivery without a number id is ignored', none.one('SELECT count(*) AS n FROM whatsapp_messages').n, 0);
  const nc = await none.api('GET', '/api/whatsapp/conversations');
  check('...and the connection says replies are not set up', nc.body.connection, { send: false, webhook: true });
}

/* ---------- G. diagnostic log lines ---------- */
{
  const h = fresh();
  const lines = [];
  const real = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    await h.hook(delivery({ messages: [textMsg('wamid.L1', 'Private text that must never be logged')], contacts: [contact()] }));
    await h.hook(delivery({ messages: [textMsg('wamid.L2', 'x')] }), { secret: 'wrong' });
    await worker.fetch(new Request(`http://worker.local/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4242`), h.env);
  } finally { console.log = real; }
  const d = lines.filter((l) => l.includes('whatsapp_delivery')).map((l) => JSON.parse(l));
  const v = lines.filter((l) => l.includes('whatsapp_verify')).map((l) => JSON.parse(l));
  check('one delivery line per POST, with the agreed fields', [d.length, Object.keys(d[0])],
    [2, ['event', 'signatureHeader', 'signatureValid', 'objectOk', 'changes', 'otherNumber', 'stored', 'duplicate', 'updated', 'ignored', 'status']]);
  check('a stored message is logged as such', d[0], { event: 'whatsapp_delivery', signatureHeader: true, signatureValid: true, objectOk: true, changes: 1, otherNumber: 0, stored: 1, duplicate: 0, updated: 0, ignored: 0, status: 200 });
  check('a wrong signature is logged as such', [d[1].signatureValid, d[1].status], [false, 401]);
  check('one verify line per handshake', v[0], { event: 'whatsapp_verify', configured: true, modeOk: true, tokenMatched: true, challengeOk: true, status: 200 });
  const all = lines.join('\n');
  ok_('no log line holds a secret, token, phone number, message id, name or message text',
    ![APP_SECRET, WA_TOKEN, VERIFY, CUSTOMER, NUMBER, 'wamid', 'Rahim', 'Private text', 'sha256=', '4242'].some((x) => all.includes(x)), all);
}

console.log(`\nWhatsApp unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
