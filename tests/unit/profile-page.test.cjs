/* profile-page — the Profile page shows only truthful data.

   The system has one shared workshop account (a passphrase, no per-person
   users), so the page must name no person and invent nothing. It reads the
   existing Settings data and the connection mode, and it never writes or
   makes a request of its own.

   Static checks over the shipped files, then the REAL js/profile.js booted
   through the shared harness in each state: this browser only, connected,
   and signed out. */
const fs = require('fs'), path = require('path');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const html = read('pages/profile.html');
// The <body> only: the <head> is shared byte-for-byte with every page and
// preloads the header's avatar, which is not part of the Profile content.
const body = html.slice(html.indexOf('<body data-page='));   // not the '<body>' named in a head comment
// Code only: comments may name what the module deliberately avoids.
const js = read('js/profile.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const auth = read('src/lib/auth.js');

console.log('=== profile-page: truthful data, read-only ===\n');

/* ---------- no invented personal data ---------- */
for (const demo of ['Md. Admin Example', 'admin@example.com', 'ADM-0001', 'Member since',
  'Workshop Administrator', 'Password (demo)', '1XXX', 'Design prototype', 'Preview only',
  'admin.webp', 'Service Management', 'Uttara', 'Two-step verification</dt>', 'Edit Profile']) {
  ok(`no demo value "${demo}" on the page`, !body.includes(demo));
}

/* ---------- truthful fixed facts ---------- */
const hours = (auth.match(/const SESSION_HOURS = (\d+);/) || [])[1];
check('server session length is read from auth.js', hours, '12');
ok('page states the same session length as the server', html.includes(`Up to ${hours} hours per sign-in`));
ok('page names the shared account model', html.includes('Shared workshop account'));
ok('page explains features unavailable without per-person accounts',
  ['Personal name and photo', 'Changing your own password', 'Two-step verification',
    'Sign-in history', 'Signing out other devices'].every(t => html.includes(t)));

/* ---------- Edit in Settings ---------- */
const editLinks = html.match(/<a [^>]*href="settings\.html"[^>]*>Edit in Settings<\/a>/g) || [];
ok('"Edit in Settings" links to the existing Settings page', editLinks.length >= 1 && fs.existsSync(path.join(ROOT, 'pages/settings.html')));

/* ---------- script order and CSP ---------- */
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
check('scripts: shell scripts, then profile.js', scripts,
  ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/profile.js']);
ok('the shell-drawn marker comes after every script',
  html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='));
ok('no inline event handlers (the CSP would block them)', !/\son[a-z]+\s*=/i.test(html));
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'))
  .replace('<title>Settings — ', '<title>Profile — ')
  .replace('<link rel="stylesheet" href="../css/responsive.css">',
    '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/profile.css">');
check('<head> matches the Settings page except title and stylesheet', head(html), settingsHead);

/* ---------- read-only, plain text ---------- */
ok('profile.js never uses innerHTML / insertAdjacentHTML / outerHTML', !/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js));
ok('profile.js makes no request of its own', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|\bApi\.(get|post|put|delete|request|login|logout|session|probe)\b/.test(js));
ok('profile.js writes nothing', !/\bStorage\.(save\w*|put\w*|create|update|remove|action|add\w*|delete\w*|reset\w*|seed\w*|signIn|signOut|reload|refreshAll|hydrate)\b|localStorage|sessionStorage/.test(js));

/* ---------- the real module, in each state ---------- */
const FIELDS = ['businessName', 'phone', 'email', 'website', 'address', 'updatedAt', 'signedInWith', 'connection'];
async function run({ mode, settings, hasToken = false } = {}) {
  const pf = {};
  FIELDS.forEach(k => { pf[k] = [makeElement(`pf-${k}`)]; });
  // profile.js toggles a class on each value; record it.
  Object.values(pf).flat().forEach(el => {
    el._classes = new Set();
    el.classList = { toggle(c, on) { on ? el._classes.add(c) : el._classes.delete(c); }, add() {}, remove() {}, contains: c => el._classes.has(c) };
  });
  const h = boot({
    modules: ['js/profile.js'],
    beforeModules(doc, ctx) {
      doc.querySelectorAll = sel => {
        const m = /^\[data-pf="([a-zA-Z]+)"\]$/.exec(sel);
        return m && pf[m[1]] ? pf[m[1]] : [];
      };
      if (settings && mode === 'local') ctx.localStorage.setItem('taqwa_settings', JSON.stringify(settings));
    },
  });
  // Stand in for the connected / signed-out states at the public Storage
  // boundary profile.js reads; the harness itself has no server.
  if (mode === 'api') {
    h.ctx.Storage.isApi = () => true;
    h.ctx.Storage.getSettings = () => settings;
    h.ctx.Api.hasToken = () => hasToken;
  }
  if (mode === 'locked') {
    h.ctx.Storage.isLocked = () => true;
    h.ctx.Storage.getSettings = () => { throw new Error('read settings while signed out'); };
  }
  const writes = [];
  ['saveSettings', 'putSettings', 'saveData', 'create', 'update', 'remove'].forEach(fn => {
    const orig = h.ctx.Storage[fn];
    h.ctx.Storage[fn] = (...a) => { writes.push(fn); return orig && orig(...a); };
  });
  h.fireReady();
  // Storage.ready() may hand over on a later tick; let it settle.
  await new Promise(r => setTimeout(r, 0));
  const text = k => pf[k][0].textContent;
  return { h, pf, text, writes, el: id => h.ctx.document.getElementById(id) };
}

const XSS = '<img src=x onerror="alert(1)">';
(async () => {
{
  const r = await run({ mode: 'local', settings: { businessName: XSS, phone: '01700-000000', email: '', website: '  ', address: 'Road 1' } });
  check('this browser only: status badge', r.el('pfStatus').textContent, 'This browser only');
  check('this browser only: connection', r.text('connection'), 'This browser only');
  check('this browser only: not signed in', r.text('signedInWith'), 'Not signed in (no server connection)');
  ok('this browser only: notice says the details are not from the shared database',
    r.el('pfNotice').hidden === false && /not the shared database/.test(r.el('pfNotice').textContent));
  check('markup in a settings value is shown as text, not parsed', r.text('businessName'), XSS);
  ok('no value went in through innerHTML', Object.values(r.pf).flat().every(e => e.innerHTML === ''));
  check('an empty value reads "Not set"', r.text('email'), 'Not set');
  check('a whitespace-only value reads "Not set"', r.text('website'), 'Not set');
  ok('an empty value is marked as empty', r.pf.email[0]._classes.has('pf-empty') && !r.pf.phone[0]._classes.has('pf-empty'));
  ok('no "Last updated" without a database date', r.el('pfUpdatedRow').hidden !== false);
  check('nothing was written', r.writes, []);
}
{
  const r = await run({ mode: 'api', settings: { businessName: 'Demo Workshop', phone: '0123', email: 'a@b.c', website: 'w', address: 'x', updatedAt: '2026-10-01T08:00:00.000Z' } });
  check('connected: status badge', r.el('pfStatus').textContent, 'Connected');
  check('connected: connection', r.text('connection'), 'Connected to the database');
  check('connected: signed in with the workshop passphrase', r.text('signedInWith'), 'Workshop passphrase');
  ok('connected: no warning notice', r.el('pfNotice').hidden !== false);
  check('connected: business name from settings', r.text('businessName'), 'Demo Workshop');
  ok('connected: "Last updated" shown from the database date', r.el('pfUpdatedRow').hidden === false && r.text('updatedAt') === '1 Oct 2026');
  check('connected: nothing was written', r.writes, []);
}
{
  const r = await run({ mode: 'api', settings: { businessName: 'W' }, hasToken: true });
  check('connected with a developer token: says so', r.text('signedInWith'), 'Workshop passphrase (and a machine token set in this browser)');
}
{
  const r = await run({ mode: 'locked' });
  check('signed out: status badge', r.el('pfStatus').textContent, 'Signed out');
  check('signed out: business details are not read', r.text('businessName'), '');
  check('signed out: not signed in', r.text('signedInWith'), 'Not signed in');
  check('signed out: nothing was written', r.writes, []);
}

process.exit(summary('Profile page unit') === 0 ? 0 : 1);
})();
