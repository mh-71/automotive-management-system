/* Facebook Messenger (0014) — unit tests against the REAL Worker:
   /api/webhooks/messenger and /api/messenger/...

   The handlers run against an in-memory SQLite database built from the real
   migrations (0001-0014). Meta is never contacted: env.META_FETCH stands in
   for graph.facebook.com and records every call it would have made.

   What must hold:
     A. Schema: the two tables, their CHECKs and unique indexes, the FBC
        counter; nothing else changed; re-runnable.
     B. Webhook GET: the challenge only for subscribe + the right token;
        a wrong token, mode or missing config refused.
     C. Webhook POST security: no / malformed / wrong signature refused
        before anything is read or stored; fail closed with no secret.
     D. Events: a message creates the conversation (name looked up) and is
        stored; a second message updates it; a duplicate delivery is a
        no-op; attachments and postbacks are kept; echoes of our replies are
        matched, echoes from other tools stored once; delivery / read move
        outbound statuses; another Page and unknown events are ignored.
     E. Inbox API: 401 without a credential (before any statement); list,
        search, status / unread filters, paging, summary, connection flags
        (booleans only); detail; messages paged newest-last; read; status,
        assignment and notes.
     F. Replies: validation; not configured; outside the 24-hour window;
        sent (Meta's id saved, the Page token in a header and never in the
        URL); a retried request is not sent twice; Meta refusing marks the
        reply failed and says so; network failure too.
   Needs node:sqlite (Node 22.5+); says SKIPPED without it. */
import worker from '../../src/index.js';
import { readFileSync } from 'node:fs';
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
  console.log(`\nMessenger unit: ${pass} passed, ${fail} failed`);
  process.exit(0);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = ['0001_initial_schema.sql', '0002_invoice_adjustments.sql', '0003_job_card_discount_type.sql',
  '0004_job_card_discount_rate.sql', '0005_customer_follow_ups.sql', '0006_follow_up_tasks.sql',
  '0007_estimates.sql', '0008_staff.sql', '0009_user_accounts.sql', '0010_attendance.sql',
  '0011_leave_requests.sql', '0012_activity_log.sql', '0013_tools.sql', '0014_messenger.sql', '0018_roles_permissions.sql'];
const TOKEN = 'unit-test-token';
const APP_SECRET = 'test-app-secret-not-real';
const VERIFY = 'test-verify-token-not-real';
const PAGE_TOKEN = 'test-page-token-not-real';
const PAGE = '111222333';
const PSID = '900001';

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
  let mode = 'ok';
  let seq = 0;
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (mode === 'network') throw new TypeError('fetch failed');
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (!init.method || init.method === 'GET') return json(200, { first_name: 'Rahim', last_name: 'Uddin', profile_pic: 'https://example.invalid/p.jpg' });
    if (mode === 'window') return json(400, { error: { message: 'secret internal detail', code: 10, error_subcode: 2018278 } });
    if (mode === 'token') return json(400, { error: { message: 'Invalid OAuth access token secret', code: 190 } });
    return json(200, { recipient_id: PSID, message_id: `m_sent_${++seq}` });
  };
  fn.calls = calls;
  fn.set = (m) => { mode = m; };
  return fn;
}

function fresh(envExtra = {}) {
  const DB = makeD1();
  const meta = fakeMeta();
  const env = { DB, API_TOKEN: TOKEN, META_APP_SECRET: APP_SECRET, META_WEBHOOK_VERIFY_TOKEN: VERIFY,
    META_PAGE_ACCESS_TOKEN: PAGE_TOKEN, META_PAGE_ID: PAGE, META_FETCH: meta, ...envExtra };
  const api = async (method, path, body, cred = 'token') => {
    const headers = {};
    if (cred === 'token') headers.authorization = `Bearer ${TOKEN}`;
    const res = await worker.fetch(new Request('http://worker.local' + path, {
      method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }), env, { waitUntil: (p) => p });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, body: json, text };
  };
  /** POST a webhook delivery, signed (or not) the way Meta signs it. */
  const hook = async (payload, { sign = true, secret = APP_SECRET, header = null } = {}) => {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const sig = header ?? (sign ? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` : null);
    const res = await worker.fetch(new Request('http://worker.local/api/webhooks/messenger', {
      method: 'POST', headers: sig ? { 'x-hub-signature-256': sig, 'content-type': 'application/json' } : { 'content-type': 'application/json' }, body: raw,
    }), env, { waitUntil: (p) => p });
    return { status: res.status, text: await res.text() };
  };
  const one = (sql, ...a) => DB.raw.prepare(sql).get(...a);
  const all = (sql, ...a) => DB.raw.prepare(sql).all(...a);
  return { DB, env, api, hook, one, all, meta };
}

const NOW = Date.now();
const msgEvent = (mid, text, extra = {}, psid = PSID, ts = NOW) => ({
  object: 'page',
  entry: [{ id: PAGE, time: ts, messaging: [{ sender: { id: psid }, recipient: { id: PAGE }, timestamp: ts, message: { mid, text, ...extra } }] }],
});
const wrap = (ev, page = PAGE) => ({ object: 'page', entry: [{ id: page, time: NOW, messaging: [ev] }] });

/* ---------- A. schema ---------- */
{
  const h = fresh();
  check('the conversation table has the planned columns', h.all('PRAGMA table_info(messenger_conversations)').map((c) => c.name),
    ['id', 'page_id', 'customer_psid', 'customer_name', 'customer_profile_pic', 'status', 'unread_count', 'last_message',
      'last_message_at', 'last_direction', 'last_inbound_at', 'assigned_to', 'notes', 'created_at', 'updated_at']);
  check('the message table has the planned columns', h.all('PRAGMA table_info(messenger_messages)').map((c) => c.name),
    ['id', 'conversation_id', 'platform_message_id', 'direction', 'sender_type', 'sender_id', 'sent_by', 'kind', 'message_text',
      'attachments_json', 'status', 'error_code', 'error_message', 'client_request_id', 'platform_timestamp', 'created_at', 'updated_at']);
  check('an FBC counter starts at 0', h.one("SELECT prefix, last_value FROM id_counters WHERE collection='messengerConversations'"), { prefix: 'FBC', last_value: 0 });
  ok_('no column could hold a token or secret', !h.all("SELECT name FROM pragma_table_info('messenger_conversations') UNION SELECT name FROM pragma_table_info('messenger_messages')")
    .some((c) => /token|secret|password/i.test(c.name)));
  const ins = (sql) => { try { h.DB.raw.exec(sql); return 'ok'; } catch (e) { return /CHECK|UNIQUE|FOREIGN KEY|NOT NULL/.exec(e.message)?.[0] || e.message; } };
  check('a conversation needs a real status', ins("INSERT INTO messenger_conversations (id, page_id, customer_psid, status, created_at) VALUES ('FBC-9', 'p', 'c', 'Lost', 'x')"), 'CHECK');
  check('a valid conversation is accepted', ins("INSERT INTO messenger_conversations (id, page_id, customer_psid, created_at) VALUES ('FBC-9', 'p', 'c', 'x')"), 'ok');
  check('one conversation per Page and customer', ins("INSERT INTO messenger_conversations (id, page_id, customer_psid, created_at) VALUES ('FBC-8', 'p', 'c', 'x')"), 'UNIQUE');
  check('a message must belong to a conversation', ins("INSERT INTO messenger_messages (conversation_id, direction, sender_type, status, created_at) VALUES ('FBC-404', 'in', 'customer', 'received', 'x')"), 'FOREIGN KEY');
  check('an inbound message cannot be from staff', ins("INSERT INTO messenger_messages (conversation_id, direction, sender_type, status, created_at) VALUES ('FBC-9', 'in', 'staff', 'received', 'x')"), 'CHECK');
  check('an outbound message cannot be "received"', ins("INSERT INTO messenger_messages (conversation_id, direction, sender_type, status, created_at) VALUES ('FBC-9', 'out', 'staff', 'received', 'x')"), 'CHECK');
  check('attachments must be JSON', ins("INSERT INTO messenger_messages (conversation_id, direction, sender_type, status, attachments_json, created_at) VALUES ('FBC-9', 'in', 'customer', 'received', '{bad', 'x')"), 'CHECK');
  ins("INSERT INTO messenger_messages (conversation_id, platform_message_id, direction, sender_type, status, created_at) VALUES ('FBC-9', 'm1', 'in', 'customer', 'received', 'x')");
  check('a platform message id is stored once', ins("INSERT INTO messenger_messages (conversation_id, platform_message_id, direction, sender_type, status, created_at) VALUES ('FBC-9', 'm1', 'in', 'customer', 'received', 'x')"), 'UNIQUE');
  check('a conversation with messages cannot be deleted', ins("DELETE FROM messenger_conversations WHERE id = 'FBC-9'"), 'FOREIGN KEY');
  let again = 'ok';
  try { h.DB.raw.exec(readFileSync(join(ROOT, 'migrations', '0014_messenger.sql'), 'utf8')); } catch (e) { again = e.message; }
  check('the migration is re-runnable', again, 'ok');
  const plain = new DatabaseSync(':memory:');
  for (const f of MIGRATIONS.filter((m) => m !== '0014_messenger.sql')) plain.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
  const shape = (db) => JSON.stringify(db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '%messenger%' AND name NOT LIKE '%msc%' AND name NOT LIKE '%msm%' ORDER BY name").all());
  check('0014 is additive: every other table and index is unchanged', shape(h.DB.raw) === shape(plain), true);
}

/* ---------- B. webhook GET ---------- */
{
  const h = fresh();
  const get = (qs, env = h.env) => worker.fetch(new Request(`http://worker.local/api/webhooks/messenger?${qs}`), env);
  const okRes = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
  check('the right token gets the challenge back, as plain text', [okRes.status, await okRes.text(), okRes.headers.get('content-type')], [200, '1158201444', 'text/plain; charset=utf-8']);
  check('a wrong token is 403', (await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  check('a token differing in its last character is 403', (await get(`hub.mode=subscribe&hub.verify_token=${VERIFY.slice(0, -1)}X&hub.challenge=1`)).status, 403);
  check('a missing token is 403', (await get('hub.mode=subscribe&hub.challenge=1')).status, 403);
  check('the wrong mode is 403', (await get(`hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`)).status, 403);
  const xss = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`);
  check('a challenge that is not Meta\'s shape is never echoed', [xss.status, (await xss.text()).includes('<script>')], [403, false]);
  check('not configured is 503, never a pass', (await get('hub.mode=subscribe&hub.verify_token=&hub.challenge=1', { DB: h.DB })).status, 503);
  check('the webhook needs no session (it is public by design)', okRes.status, 200);
}

/* ---------- B2. handshake: whitespace and the safe diagnostic log ---------- */
{
  const h = fresh();
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  let results;
  try {
    const get = (qs, headers = {}, env = h.env) => worker.fetch(new Request(`http://worker.local/api/webhooks/messenger?${qs}`, { headers }), env);
    const META_UA = { 'user-agent': 'facebookplatform/1.0 (+http://developers.facebook.com)' };
    results = [];
    for (const [qs, headers, env] of [
      [`hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY + ' ')}&hub.challenge=4242`, META_UA],
      [`hub.mode=subscribe&hub.verify_token=${encodeURIComponent(' ' + VERIFY + '\n')}&hub.challenge=4243`, {}],
      [`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4244`, META_UA, { ...h.env, META_WEBHOOK_VERIFY_TOKEN: `${VERIFY}\r\n` }],
      ['hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=4245', META_UA],
      [`hub.mode=subscribe&hub.verify_token=${encodeURIComponent('   ')}&hub.challenge=4246`, {}],
      [`hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=4247`, {}],
      [`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=${encodeURIComponent('<b>')}`, {}],
      [`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=4248`, {}, { DB: h.DB }],
    ]) {
      const r = await get(qs, headers, env);
      results.push([r.status, await r.text()]);
    }
  } finally {
    console.log = realLog;
  }
  check('a token Meta sends with a trailing space still verifies, and the exact challenge comes back', results[0], [200, '4242']);
  check('a token with a leading space and a line break still verifies', results[1], [200, '4243']);
  check('a secret saved with a trailing line break still verifies', results[2], [200, '4244']);
  check('a wrong token is still 403', results[3][0], 403);
  check('a token of only spaces is still 403', results[4][0], 403);
  check('the wrong mode is still 403', results[5][0], 403);
  check('a challenge that is not Meta\'s shape is still 403', results[6][0], 403);
  check('no configuration is still 503', results[7][0], 503);

  const logs = lines.filter((l) => l.includes('messenger_verify')).map((l) => JSON.parse(l));
  check('every handshake writes exactly one diagnostic line', logs.length, 8);
  check('the line holds only the agreed fields',
    Object.keys(logs[0]), ['event', 'fromMeta', 'configured', 'tokenConfigured', 'modeOk', 'tokenMatched', 'challengeOk', 'status']);
  check('a passing Meta handshake is logged as such', logs[0], { event: 'messenger_verify', fromMeta: true, configured: true, tokenConfigured: true, modeOk: true, tokenMatched: true, challengeOk: true, status: 200 });
  check('a token mismatch names itself', [logs[3].tokenMatched, logs[3].modeOk, logs[3].status], [false, true, 403]);
  check('a mode mismatch names itself', [logs[5].modeOk, logs[5].tokenMatched, logs[5].status], [false, true, 403]);
  check('a bad challenge names itself', [logs[6].challengeOk, logs[6].status], [false, 403]);
  check('missing configuration names itself', [logs[7].configured, logs[7].tokenConfigured, logs[7].status], [false, false, 503]);
  check('a request without Meta\'s user-agent is told apart', logs[1].fromMeta, false);
  const all = lines.join('\n');
  ok_('no log line contains the verify token, the App Secret or the Page token', ![VERIFY, APP_SECRET, PAGE_TOKEN, 'wrong-token'].some((v) => all.includes(v)));
  ok_('no log line contains the query string, a challenge or the URL', !/hub\.|verify_token|challenge=|4242|worker\.local|\/api\/webhooks/.test(all), all);
  ok_('every value in the line is a boolean or the status', logs.every((l) => Object.entries(l).every(([k, v]) => (k === 'event' ? v === 'messenger_verify' : k === 'status' ? Number.isInteger(v) : typeof v === 'boolean'))));
}

/* ---------- C. webhook POST security ---------- */
{
  const h = fresh();
  h.DB.statements.length = 0;
  const ev = msgEvent('m_a', 'Hi');
  check('no signature is 401', (await h.hook(ev, { sign: false })).status, 401);
  check('a signature made with another secret is 401', (await h.hook(ev, { secret: 'not-the-secret' })).status, 401);
  check('a malformed signature header is 401', (await h.hook(ev, { header: 'sha1=abc' })).status, 401);
  const raw = JSON.stringify(ev);
  const sig = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const tampered = await worker.fetch(new Request('http://worker.local/api/webhooks/messenger', {
    method: 'POST', headers: { 'x-hub-signature-256': sig }, body: raw.replace('Hi', 'Hj'),
  }), h.env);
  check('a body changed after signing is 401', tampered.status, 401);
  check('nothing was read or stored for any refused delivery', [h.DB.statements.length, h.one('SELECT count(*) AS n FROM messenger_messages').n], [0, 0]);
  const noSecret = await worker.fetch(new Request('http://worker.local/api/webhooks/messenger', { method: 'POST', body: raw }), { DB: h.DB });
  check('with no App Secret configured every delivery is refused (503)', noSecret.status, 503);
  check('a signed body that is not JSON is 400', (await h.hook('not json')).status, 400);
  check('another object type is acknowledged and ignored', [(await h.hook({ object: 'instagram', entry: [] })).status, h.one('SELECT count(*) AS n FROM messenger_messages').n], [200, 0]);
  check('PUT on the webhook is 405', (await h.api('PUT', '/api/webhooks/messenger', {}, 'none')).status, 405);
}

/* ---------- C2. App Secret whitespace, SHA1 header, and the safe delivery log ---------- */
{
  const lines = [];
  const realLog = console.log;
  const signed = (payload, secret = APP_SECRET) => {
    const raw = JSON.stringify(payload);
    return { raw, sig256: `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, sha1: `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}` };
  };
  const post = async (env, raw, headers) => {
    const res = await worker.fetch(new Request('http://worker.local/api/webhooks/messenger', { method: 'POST', headers, body: raw }), env, { waitUntil: (p) => p });
    return res.status;
  };
  const META_HEADERS = (s) => ({ 'x-hub-signature': s.sha1, 'x-hub-signature-256': s.sig256, 'content-type': 'application/json', 'user-agent': 'Webhooks/1.0 (https://fb.me/webhooks)' });
  const results = {};
  const h = fresh();
  console.log = (...a) => { lines.push(a.map(String).join(' ')); };
  try {
    const ev = signed(msgEvent('m_ws_1', 'Customer text that must never be logged', {}, '900777', NOW));
    results.crlf = await post({ ...h.env, META_APP_SECRET: `${APP_SECRET}\r\n` }, ev.raw, META_HEADERS(ev));
    const ev2 = signed(msgEvent('m_ws_2', 'Second', {}, '900777', NOW + 1));
    results.space = await post({ ...h.env, META_APP_SECRET: ` ${APP_SECRET} ` }, ev2.raw, META_HEADERS(ev2));
    const ev3 = signed(msgEvent('m_ws_3', 'Third', {}, '900777', NOW + 2), 'some-other-app-secret');
    results.otherApp = await post(h.env, ev3.raw, META_HEADERS(ev3));
    const ev4 = signed(msgEvent('m_ws_4', 'Fourth', {}, '900777', NOW + 3));
    results.sha1Only = await post(h.env, ev4.raw, { 'x-hub-signature': ev4.sha1, 'content-type': 'application/json' });
    const ev5 = signed({ object: 'page', entry: [{ id: '0', time: NOW, messaging: [{ sender: { id: '12334' }, recipient: { id: '23245' }, timestamp: '1527459824', message: { mid: 'test_message_id', text: 'test_message' } }] }] });
    results.dashboardTest = await post(h.env, ev5.raw, META_HEADERS(ev5));
    const ev6 = signed({ object: 'instagram', entry: [] });
    results.otherObject = await post(h.env, ev6.raw, META_HEADERS(ev6));
    results.noSecret = await post({ DB: h.DB }, ev.raw, META_HEADERS(ev));
  } finally {
    console.log = realLog;
  }
  check('a genuine Meta delivery verifies when the App Secret was saved with a trailing line break', results.crlf, 200);
  check('...and with spaces around it', results.space, 200);
  check('both were stored, once each', h.one("SELECT count(*) AS n FROM messenger_messages WHERE platform_message_id IN ('m_ws_1','m_ws_2')").n, 2);
  check('a delivery signed with another app\'s secret is still 401', results.otherApp, 401);
  check('the SHA1 header alone is not accepted (only X-Hub-Signature-256 counts)', results.sha1Only, 401);
  check('nothing from a refused delivery was stored', h.one("SELECT count(*) AS n FROM messenger_messages WHERE platform_message_id IN ('m_ws_3','m_ws_4')").n, 0);
  check('the dashboard Test sample is acknowledged but not stored (another Page id)', [results.dashboardTest, h.one("SELECT count(*) AS n FROM messenger_messages WHERE platform_message_id = 'test_message_id'").n], [200, 0]);
  check('missing configuration is still 503', results.noSecret, 503);

  const logs = lines.filter((l) => l.includes('messenger_delivery')).map((l) => JSON.parse(l));
  check('every delivery writes exactly one diagnostic line', logs.length, 7);
  check('the line holds only the agreed fields', Object.keys(logs[0]),
    ['event', 'signatureHeader', 'signatureValid', 'objectOk', 'entries', 'otherPage', 'stored', 'duplicate', 'matched', 'updated', 'ignored', 'status']);
  check('a stored delivery is logged as such', logs[0], { event: 'messenger_delivery', signatureHeader: true, signatureValid: true, objectOk: true,
    entries: 1, otherPage: 0, stored: 1, duplicate: 0, matched: 0, updated: 0, ignored: 0, status: 200 });
  check('a wrong secret is logged as an invalid signature', [logs[2].signatureHeader, logs[2].signatureValid, logs[2].status], [true, false, 401]);
  check('a missing SHA-256 header is logged as such', [logs[3].signatureHeader, logs[3].signatureValid, logs[3].status], [false, false, 401]);
  check('the dashboard Test sample is logged as another Page', [logs[4].signatureValid, logs[4].entries, logs[4].otherPage, logs[4].stored, logs[4].status], [true, 1, 1, 0, 200]);
  check('another object type is logged as such', [logs[5].objectOk, logs[5].status], [false, 200]);
  check('missing configuration is logged with its status', logs[6].status, 503);
  const all = lines.join('\n');
  ok_('no log line contains the App Secret, a signature, the Page token or the verify token',
    ![APP_SECRET, PAGE_TOKEN, VERIFY, 'sha256=', 'sha1=', 'some-other-app-secret'].some((v) => all.includes(v)));
  ok_('no log line contains customer data: PSID, message id or message text',
    !['900777', '12334', 'm_ws_1', 'test_message', 'Customer text', 'Second'].some((v) => all.includes(v)), all);
  ok_('every value in the line is a boolean or a number', logs.every((l) => Object.entries(l).every(([k, v]) => (k === 'event' ? v === 'messenger_delivery' : typeof v === 'boolean' || Number.isInteger(v)))));
}

/* ---------- D. events ---------- */
{
  const h = fresh();
  const first = await h.hook(msgEvent('m_1', 'Assalamu alaikum, my car makes a noise'));
  check('a valid message is acknowledged', [first.status, first.text], [200, 'EVENT_RECEIVED']);
  const conv = h.one('SELECT * FROM messenger_conversations');
  check('the first message creates the conversation, named from the profile', [conv.id, conv.customer_psid, conv.page_id, conv.customer_name, conv.status, conv.unread_count],
    ['FBC-0001', PSID, PAGE, 'Rahim Uddin', 'Open', 1]);
  ok_('   ...the profile lookup sent the token in a header, never the URL', h.meta.calls[0].method === 'GET' && !h.meta.calls[0].url.includes(PAGE_TOKEN) && h.meta.calls[0].headers.authorization === `Bearer ${PAGE_TOKEN}`, JSON.stringify(h.meta.calls[0]));
  check('   ...and the message is stored as received', h.one('SELECT direction, sender_type, message_text, status, platform_message_id FROM messenger_messages'),
    { direction: 'in', sender_type: 'customer', message_text: 'Assalamu alaikum, my car makes a noise', status: 'received', platform_message_id: 'm_1' });
  check('   ...with the preview and the window start', [conv.last_message, conv.last_direction, conv.last_inbound_at === new Date(NOW).toISOString()], ['Assalamu alaikum, my car makes a noise', 'in', true]);

  await h.hook(msgEvent('m_2', 'Can I come tomorrow?', {}, PSID, NOW + 1000));
  const c2 = h.one('SELECT * FROM messenger_conversations');
  check('a second message updates the same conversation', [h.one('SELECT count(*) AS n FROM messenger_conversations').n, c2.unread_count, c2.last_message], [1, 2, 'Can I come tomorrow?']);
  check('   ...without looking the profile up again', h.meta.calls.length, 1);
  const dup = await h.hook(msgEvent('m_2', 'Can I come tomorrow?', {}, PSID, NOW + 1000));
  check('a duplicate delivery is acknowledged and stored once', [dup.status, h.one('SELECT count(*) AS n FROM messenger_messages').n, h.one('SELECT unread_count FROM messenger_conversations').unread_count], [200, 2, 2]);

  await h.hook(msgEvent('m_3', undefined, { attachments: [{ type: 'image', payload: { url: 'https://scontent.example/x.jpg' } }, { type: 'file', payload: { url: 'javascript:alert(1)' } }] }, PSID, NOW + 2000));
  const att = JSON.parse(h.one("SELECT attachments_json FROM messenger_messages WHERE platform_message_id='m_3'").attachments_json);
  check('attachment metadata is kept; only https URLs survive', att, [{ type: 'image', url: 'https://scontent.example/x.jpg', title: null }, { type: 'file', url: null, title: null }]);
  check('   ...and the preview says what it was', h.one('SELECT last_message FROM messenger_conversations').last_message, '[Photo]');

  await h.hook(wrap({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: NOW + 3000, postback: { mid: 'm_pb', title: 'Book a service', payload: 'BOOK' } }));
  check('a postback is stored as the button title', h.one("SELECT kind, message_text FROM messenger_messages WHERE platform_message_id='m_pb'"), { kind: 'postback', message_text: 'Book a service' });

  h.DB.raw.exec("UPDATE messenger_conversations SET status = 'Resolved'");
  await h.hook(msgEvent('m_4', 'One more thing', {}, PSID, NOW + 4000));
  check('a new message reopens a resolved conversation', h.one('SELECT status FROM messenger_conversations').status, 'Open');

  await h.hook(wrap({ sender: { id: PAGE }, recipient: { id: PSID }, timestamp: NOW + 5000, message: { mid: 'm_echo_bs', text: 'Sent from Business Suite', is_echo: true, app_id: 1 } }));
  await h.hook(wrap({ sender: { id: PAGE }, recipient: { id: PSID }, timestamp: NOW + 5000, message: { mid: 'm_echo_bs', text: 'Sent from Business Suite', is_echo: true, app_id: 1 } }));
  check('an echo of a message sent from another tool is stored once, as from the Page', h.all("SELECT direction, sender_type, status FROM messenger_messages WHERE platform_message_id='m_echo_bs'"),
    [{ direction: 'out', sender_type: 'page', status: 'sent' }]);

  await h.hook(wrap({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: NOW + 6000, delivery: { mids: ['m_echo_bs'], watermark: NOW + 5500 } }));
  check('a delivery receipt moves outbound messages to delivered', h.one("SELECT status FROM messenger_messages WHERE platform_message_id='m_echo_bs'").status, 'delivered');
  await h.hook(wrap({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: NOW + 7000, read: { watermark: NOW + 6500 } }));
  check('a read receipt moves them to read', h.one("SELECT status FROM messenger_messages WHERE platform_message_id='m_echo_bs'").status, 'read');
  check('receipts never touch inbound messages', h.all("SELECT DISTINCT status FROM messenger_messages WHERE direction='in'").map((r) => r.status), ['received']);

  const before = h.one('SELECT count(*) AS n FROM messenger_messages').n;
  await h.hook(wrap({ sender: { id: '777' }, recipient: { id: '999' }, timestamp: NOW, message: { mid: 'm_x', text: 'x' } }, '999'));
  await h.hook(wrap({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: NOW, reaction: { reaction: 'love', mid: 'm_1' } }));
  await h.hook(wrap({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: NOW, message: { text: 'no mid' } }));
  check('another Page, unsupported events and events without an id are ignored', [h.one('SELECT count(*) AS n FROM messenger_messages').n, h.one('SELECT count(*) AS n FROM messenger_conversations').n], [before, 1]);

  const broken = { ...h.env, DB: { prepare() { throw new Error('D1_ERROR: detail'); } } };
  const raw = JSON.stringify(msgEvent('m_z', 'x'));
  const res = await worker.fetch(new Request('http://worker.local/api/webhooks/messenger', {
    method: 'POST', headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}` }, body: raw,
  }), broken);
  const t = await res.text();
  check('a storage failure answers 500 (so Meta retries) and reveals nothing', [res.status, /D1_ERROR|detail/.test(t)], [500, false]);
}

/* ---------- E. inbox API ---------- */
{
  const h = fresh();
  for (let i = 1; i <= 7; i++) await h.hook(msgEvent(`m_c${i}`, i === 3 ? 'Brake pads price?' : `Hello ${i}`, {}, `90000${i}`, NOW + i * 1000));
  h.DB.statements.length = 0;
  const denied = [];
  for (const [m, p, b] of [['GET', '/api/messenger/conversations'], ['GET', '/api/messenger/conversations/FBC-0001'], ['GET', '/api/messenger/conversations/FBC-0001/messages'],
    ['POST', '/api/messenger/conversations/FBC-0001/reply', { text: 'x', clientRequestId: 'abcdefgh' }], ['POST', '/api/messenger/conversations/FBC-0001/read', {}],
    ['PUT', '/api/messenger/conversations/FBC-0001/status', { status: 'Resolved' }]]) denied.push((await h.api(m, p, b, 'none')).status);
  check('every inbox route is 401 without a credential', denied, [401, 401, 401, 401, 401, 401]);
  check('...and no statement ran', h.DB.statements.length, 0);
  check('Meta was not called for a refused caller', h.meta.calls.filter((c) => c.method === 'POST').length, 0);

  const list = await h.api('GET', '/api/messenger/conversations');
  check('the list is newest first, every row Facebook', [list.status, list.body.data.map((c) => c.id), [...new Set(list.body.data.map((c) => c.platform))]],
    [200, ['FBC-0007', 'FBC-0006', 'FBC-0005', 'FBC-0004', 'FBC-0003', 'FBC-0002', 'FBC-0001'], ['Facebook']]);
  check('the summary counts conversations and unread', list.body.summary, { total: 7, unreadConversations: 7, unreadMessages: 7, open: 7, pending: 0, resolved: 0 });
  check('the connection is reported as booleans only', list.body.connection, { send: true, webhook: true });
  ok_('no token or secret appears in any response', ![list.text].some((t) => t.includes(PAGE_TOKEN) || t.includes(APP_SECRET) || t.includes(VERIFY)));
  check('search matches a message preview', (await h.api('GET', '/api/messenger/conversations?q=brake')).body.data.map((c) => c.id), ['FBC-0003']);
  check('search matches a customer name', (await h.api('GET', '/api/messenger/conversations?q=RAHIM')).body.total, 7);
  check('LIKE wildcards are literal', (await h.api('GET', '/api/messenger/conversations?q=%25')).body.total, 0);
  const page = await h.api('GET', '/api/messenger/conversations?limit=3&offset=3');
  check('paging: limit and offset, total is the whole match', [page.body.data.map((c) => c.id), page.body.total], [['FBC-0004', 'FBC-0003', 'FBC-0002'], 7]);
  for (const [qs, label] of [['limit=0', 'limit'], ['status=Gone', 'status'], ['unread=2', 'unread'], [`q=${'x'.repeat(101)}`, 'q']]) {
    check(`a bad ${label} is 400`, (await h.api('GET', `/api/messenger/conversations?${qs}`)).status, 400);
  }

  const read = await h.api('POST', '/api/messenger/conversations/FBC-0003/read', {});
  check('read clears the unread count', [read.status, read.body.data.unreadCount], [200, 0]);
  check('unread=1 then leaves it out', (await h.api('GET', '/api/messenger/conversations?unread=1')).body.total, 6);
  const st = await h.api('PUT', '/api/messenger/conversations/FBC-0003/status', { status: 'Pending', assignedTo: ' Karim ', notes: 'Wants a quote' });
  check('status, assignment and notes are saved', [st.status, st.body.data.status, st.body.data.assignedTo, st.body.data.notes], [200, 'Pending', 'Karim', 'Wants a quote']);
  check('the status filter finds it', (await h.api('GET', '/api/messenger/conversations?status=Pending')).body.data.map((c) => c.id), ['FBC-0003']);
  check('a bad status is 422', (await h.api('PUT', '/api/messenger/conversations/FBC-0003/status', { status: 'Closed' })).status, 422);
  check('an unknown field is 422', (await h.api('PUT', '/api/messenger/conversations/FBC-0003/status', { customerName: 'x' })).status, 422);
  check('an empty change is 422', (await h.api('PUT', '/api/messenger/conversations/FBC-0003/status', {})).status, 422);
  check('an unknown conversation is 404', [(await h.api('GET', '/api/messenger/conversations/FBC-0999')).status, (await h.api('POST', '/api/messenger/conversations/FBC-0999/read', {})).status], [404, 404]);
  check('a malformed id is 400', (await h.api('GET', '/api/messenger/conversations/1%3BDROP')).status, 400);
  check('an unknown sub-route is 404', (await h.api('GET', '/api/messenger/conversations/FBC-0001/delete')).status, 404);
  check('DELETE on a conversation is 405', (await h.api('DELETE', '/api/messenger/conversations/FBC-0001')).status, 405);

  for (let i = 0; i < 5; i++) await h.hook(msgEvent(`m_more${i}`, `More ${i}`, {}, '900001', NOW + 10000 + i));
  const msgs = await h.api('GET', '/api/messenger/conversations/FBC-0001/messages?limit=4');
  check('messages: the newest page, shown oldest first, with a cursor back', [msgs.body.data.map((m) => m.text), msgs.body.hasMore], [['More 1', 'More 2', 'More 3', 'More 4'], true]);
  const older = await h.api('GET', `/api/messenger/conversations/FBC-0001/messages?limit=4&before=${msgs.body.nextBefore}`);
  check('   ...and the page before it', [older.body.data.map((m) => m.text), older.body.hasMore], [['Hello 1', 'More 0'], false]);
}

/* ---------- F. replies ---------- */
{
  const h = fresh();
  await h.hook(msgEvent('m_in', 'Is my car ready?', {}, PSID, Date.now()));
  const say = (text, id = 'req-000001', extra = {}) => h.api('POST', '/api/messenger/conversations/FBC-0001/reply', { text, clientRequestId: id, ...extra });
  check('an empty reply is 422', (await say('   ')).status, 422);
  check('a reply over 2000 characters is 422', (await say('x'.repeat(2001))).status, 422);
  check('a reply without a client request id is 422', (await h.api('POST', '/api/messenger/conversations/FBC-0001/reply', { text: 'x' })).status, 422);
  check('an unknown field is 422', (await say('x', 'req-000001', { tag: 'HUMAN_AGENT' })).status, 422);
  check('nothing was sent for a refused reply', h.meta.calls.filter((c) => c.method === 'POST').length, 0);

  const sent = await say('  Yes, it is ready. ', 'req-000001');
  check('a reply is sent and saved with Meta\'s id', [sent.status, sent.body.data.status, sent.body.data.text, sent.body.data.direction, sent.body.data.hasPlatformId], [201, 'sent', 'Yes, it is ready.', 'out', true]);
  const call = h.meta.calls.filter((c) => c.method === 'POST')[0];
  check('   ...through the Send API, as the configured Page, as a RESPONSE', [call.url, call.body.recipient.id, call.body.messaging_type, call.body.message.text, call.body.message.metadata],
    [`https://graph.facebook.com/v23.0/${PAGE}/messages`, PSID, 'RESPONSE', 'Yes, it is ready.', 'taqwa-reply:req-000001']);
  ok_('   ...with the Page token in the Authorization header and nowhere in the URL', call.headers.authorization === `Bearer ${PAGE_TOKEN}` && !call.url.includes(PAGE_TOKEN), JSON.stringify(call));
  ok_('   ...and no message tag (nothing outside Meta\'s rules)', !('tag' in call.body), JSON.stringify(call.body));
  check('   ...recorded as sent by the caller', h.one("SELECT sent_by, sender_type FROM messenger_messages WHERE client_request_id='req-000001'"), { sent_by: 'API token', sender_type: 'staff' });
  check('   ...the conversation shows it and is read', [h.one('SELECT last_message, last_direction, unread_count FROM messenger_conversations').last_message, h.one('SELECT last_direction FROM messenger_conversations').last_direction, h.one('SELECT unread_count FROM messenger_conversations').unread_count], ['Yes, it is ready.', 'out', 0]);

  const again = await say('Yes, it is ready.', 'req-000001');
  check('the same request again is not sent twice', [again.status, again.body.replayed, h.meta.calls.filter((c) => c.method === 'POST').length, h.one("SELECT count(*) AS n FROM messenger_messages WHERE direction='out'").n], [200, true, 1, 1]);
  const mid = h.one("SELECT platform_message_id FROM messenger_messages WHERE client_request_id='req-000001'").platform_message_id;
  await h.hook(wrap({ sender: { id: PAGE }, recipient: { id: PSID }, timestamp: Date.now(), message: { mid, text: 'Yes, it is ready.', is_echo: true, metadata: 'taqwa-reply:req-000001' } }));
  check('its echo from Meta does not add a second copy', h.one("SELECT count(*) AS n FROM messenger_messages WHERE direction='out'").n, 1);
  await h.hook(wrap({ sender: { id: PSID }, recipient: { id: PAGE }, timestamp: Date.now() + 5000, read: { watermark: Date.now() + 5000 } }));
  check('a read receipt marks the reply read', h.one("SELECT status FROM messenger_messages WHERE client_request_id='req-000001'").status, 'read');

  h.meta.set('window');
  const refused = await say('Another one', 'req-000002');
  check('Meta refusing is 502 and the reply is saved as failed, never sent', [refused.status, refused.body.error.code, h.one("SELECT status, error_code FROM messenger_messages WHERE client_request_id='req-000002'")],
    [502, 'send_failed', { status: 'failed', error_code: 'meta_10_2018278' }]);
  ok_('   ...the reason is plain language, not Meta\'s internal text', /24 hours/.test(refused.body.error.message) && !refused.text.includes('secret internal detail'), refused.text);
  h.meta.set('token');
  check('an expired Page token is explained', /renew/.test((await say('x', 'req-000003')).body.error.message), true);
  h.meta.set('network');
  const net = await say('x', 'req-000004');
  check('Facebook unreachable: failed and retryable', [net.status, net.body.error.retryable, h.one("SELECT status FROM messenger_messages WHERE client_request_id='req-000004'").status], [502, true, 'failed']);
  const hist = await h.api('GET', '/api/messenger/conversations/FBC-0001/messages');
  check('failed replies stay in the history with their reason', hist.body.data.filter((m) => m.status === 'failed').length, 3);
  check('   ...and the conversation preview still shows the last reply that was sent', h.one('SELECT last_message FROM messenger_conversations').last_message, 'Yes, it is ready.');

  h.DB.raw.exec(`UPDATE messenger_conversations SET last_inbound_at = '${new Date(Date.now() - 25 * 3600 * 1000).toISOString()}'`);
  h.meta.set('ok');
  const late = await say('Too late', 'req-000005');
  check('outside the 24-hour window the reply is refused before Meta is asked', [late.status, late.body.error.reason, h.meta.calls.filter((c) => c.method === 'POST').length], [409, 'outside_messaging_window', 4]);
  check('   ...and the conversation says it cannot be replied to', (await h.api('GET', '/api/messenger/conversations/FBC-0001')).body.data.canReply, false);

  const none = fresh({ META_PAGE_ACCESS_TOKEN: '', META_PAGE_ID: '' });
  await none.hook(msgEvent('m_n', 'hi', {}, PSID, Date.now()));
  const nc = await none.api('POST', '/api/messenger/conversations/FBC-0001/reply', { text: 'x', clientRequestId: 'req-000009' });
  check('with no Page token configured a reply is 503 and nothing is saved', [nc.status, none.one("SELECT count(*) AS n FROM messenger_messages WHERE direction='out'").n], [503, 0]);
  check('   ...and incoming messages are still received (named "Facebook user")', (await none.api('GET', '/api/messenger/conversations')).body.data[0].customerName, 'Facebook user');
}

console.log(`\nMessenger unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
