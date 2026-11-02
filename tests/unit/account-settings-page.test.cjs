/* account-settings-page — the Account Settings hub is truthful and read-only.

   It shows the workshop's REAL saved settings (GET /api/settings) and edits
   none of them: every business, invoice and workshop value links to the
   Settings page instead. The one control is Appearance, which must reuse the
   existing per-device theme preference (App.applyTheme / Storage.getTheme).

   Static checks over the shipped files, then the REAL js/app.js and
   js/account-settings.js booted through the shared harness in each state:
   connected (saved row, no row, server error, session ended), loading,
   this browser only, and signed out. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { boot, check, ok, summary, makeElement } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const html = read('pages/account-settings.html');
// The <body> only: the shared <head> preloads the header avatar and mentions
// "<body>" in a comment, so slice at the real body tag.
const body = html.slice(html.indexOf('<body data-page='));
const css = read('css/account-settings.css');
// Code only: comments may name what the module deliberately avoids.
const js = read('js/account-settings.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('=== account-settings-page: truthful read-only hub ===\n');

/* ---------- the five sections ---------- */
const SECTIONS = [['as-business', 'Business Information'], ['as-invoice', 'Invoice &amp; Tax'],
  ['as-workshop', 'Workshop Defaults'], ['as-appearance', 'Appearance'], ['as-data', 'Data Management']];
for (const [id, title] of SECTIONS) {
  const sec = new RegExp(`<section class="card as-card" id="${id}" aria-labelledby="(as-h-[a-z]+)"`).exec(body);
  ok(`section ${title}: present and labelled by its heading`, !!sec && body.includes(`<h2 id="${sec && sec[1]}">${title}</h2>`));
}
const FIELD_KEYS = ['businessName', 'phone', 'address', 'email', 'website', 'taxId', 'businessDescription',
  'taxRate', 'currency', 'invoiceFooter', 'paymentTerms',
  'defaultAppointmentDuration', 'openingTime', 'closingTime', 'workingDays'];
check('every settings-model field has exactly one display slot',
  FIELD_KEYS.filter(k => (body.match(new RegExp(`data-as="${k}"`, 'g')) || []).length === 1).length, FIELD_KEYS.length);
const settingsRoute = read('src/routes/settings.js');
ok('every displayed field exists in the settings model (Worker WRITABLE list)',
  FIELD_KEYS.every(k => settingsRoute.includes(`'${k}'`)));
ok('payment terms are labelled as not used', /Payment Terms \/ Note <span class="as-ref">Saved for reference — not printed or used anywhere yet<\/span>/.test(body));
ok('business description is labelled as not used elsewhere', /Business Description \/ Notes <span class="as-ref">Saved for reference — not shown elsewhere/.test(body));
ok('workshop defaults are labelled as reference only', body.includes('Saved for reference only — not used by the Appointments scheduler or Job Cards.'));
ok('data management explains export and reset, and that reset is refused against the database',
  /Export Data<\/h3>/.test(body) && /Reset to Seed Data<\/h3>/.test(body) && body.includes('is refused against the shared database'));

/* ---------- links ---------- */
const edit = body.match(/<a class="as-edit" href="settings\.html">Edit in Settings<\/a>/g) || [];
check('Business, Invoice and Workshop each link to the Settings page ("Edit in Settings")', edit.length, 3);
const dataSec = body.slice(body.indexOf('id="as-data"'), body.indexOf('</section>', body.indexOf('id="as-data"')));
check('Data Management links to the Settings page for export and reset', (dataSec.match(/href="settings\.html"/g) || []).length, 2);
ok('the Settings page exists', fs.existsSync(path.join(ROOT, 'pages/settings.html')));

/* ---------- no demo data, no write controls ---------- */
for (const demo of ['Demo Auto Service Center', 'info@example.com', 'example.com', '000000000-0000', 'House 00',
  '(demo)', 'Design prototype', 'Preview only', 'Thank you for your business', 'Payment due within 7 days', '+880 1XXX']) {
  ok(`no demo value "${demo}"`, !body.includes(demo));
}
ok('no disabled placeholder controls remain', !/\sdisabled\b/.test(body));
ok('no buttons and no forms on the page (nothing to submit, export or reset here)', !/<button\b|<form\b/.test(body));
const inputs = body.match(/<input\b[^>]*>/g) || [];
ok('the only inputs are the three theme radios', inputs.length === 3 && inputs.every(i => /type="radio" name="as-theme"/.test(i)));

/* ---------- accessibility and responsive markup ---------- */
ok('theme radios sit in a fieldset with a visible legend', /<fieldset class="as-themes">\s*<legend class="as-themes__legend">Theme<\/legend>/.test(body));
ok('each theme radio is inside its own <label>', ['light', 'dark', 'system'].every(v =>
  new RegExp(`<label class="as-theme as-theme--${v}">\\s*<input type="radio" name="as-theme" value="${v}">`).test(body)));
ok('the state line is a polite live region', /id="asState" role="status" aria-live="polite"/.test(body));
ok('the theme change is announced through a live region', /id="asThemeStatus" role="status" aria-live="polite"/.test(body));
ok('appearance says it applies to this device only', body.includes('Applies to this browser on this device only.'));
ok('keyboard focus is visible on links and theme cards', /:focus-visible/.test(css) && /\.as-theme:has\(input:focus-visible\)/.test(css));
ok('tablet and phone layouts exist', /@media \(max-width: 1100px\)/.test(css) && /@media \(max-width: 640px\)/.test(css));
ok('theme radios are visually hidden but not removed from the keyboard order', /\.as-theme input \{ position: absolute; opacity: 0;/.test(css) && !/\.as-theme input[^{]*\{[^}]*display:\s*none/.test(css));

/* ---------- CSP and script order ---------- */
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
check('scripts: shell scripts, then account-settings.js', scripts,
  ['../js/api.js', '../js/seed-data.js', '../js/version.js', '../js/offline.js', '../js/sync.js', '../js/storage.js', '../js/utils.js', '../js/app.js', '../js/account-settings.js']);
ok('the shell-drawn marker comes after every script', html.indexOf('id="shell-drawn"') > html.lastIndexOf('<script src='));
ok('no inline event handlers (the CSP would block them)', !/\son[a-z]+\s*=/i.test(html));
const head = s => s.slice(0, s.indexOf('</head>'));
const settingsHead = head(read('pages/settings.html'))
  .replace('<title>Settings — ', '<title>Account Settings — ')
  .replace('<link rel="stylesheet" href="../css/responsive.css">',
    '<link rel="stylesheet" href="../css/responsive.css">\n  <link rel="stylesheet" href="../css/account-settings.css">');
check('<head> matches the Settings page except title and stylesheet', head(html), settingsHead);
const allowedHash = (read('_headers').match(/'sha256-([^']+)'/) || [])[1];
const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
check('the inline theme script still matches the CSP hash in _headers', crypto.createHash('sha256').update(inline).digest('base64'), allowedHash);

/* ---------- read-only code ---------- */
ok('account-settings.js never uses innerHTML / insertAdjacentHTML / outerHTML', !/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(js));
ok('its only request is GET /api/settings', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon/.test(js)
  && (js.match(/\bApi\.[a-zA-Z]+/g) || []).every(c => c === 'Api.get') && /Api\.get\('\/settings'\)/.test(js));
ok('it writes no data: no Storage write, export, reset or direct storage access',
  !/\bStorage\.(save\w*|put\w*|create|update|remove|action|add\w*|delete\w*|reset\w*|seed\w*|signIn|signOut|reload|refreshAll|hydrate)\b|localStorage|sessionStorage|createObjectURL|\bBlob\b|\.download\b|COLLECTIONS|getData/.test(js));
ok('appearance reuses App.applyTheme and Storage.getTheme (no new theme storage)',
  /App\.applyTheme\(r\.value\)/.test(js) && /Storage\.getTheme\(\)/.test(js) && !/Storage\.saveTheme/.test(js));
ok('it does not read the browser display defaults (Storage.getSettings)', !/Storage\.getSettings/.test(js));

/* ---------- the real modules, in each state ---------- */
const FIELDS = [...FIELD_KEYS, 'updatedAt'];
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function run({ mode = 'local', getResult, theme, hold } = {}) {
  const fields = {}; FIELDS.forEach(k => { fields[k] = [makeElement(`as-${k}`)]; });
  Object.values(fields).flat().forEach(el => {
    el._classes = new Set();
    el.classList = { toggle(c, on) { on ? el._classes.add(c) : el._classes.delete(c); }, add() {}, remove() {}, contains: c => el._classes.has(c) };
  });
  const radios = ['light', 'dark', 'system'].map(v => {
    const r = makeElement(`theme-${v}`); r.value = v; r.checked = false;
    const card = makeElement(`card-${v}`); card._classes = new Set();
    card.classList = { toggle(c, on) { on ? card._classes.add(c) : card._classes.delete(c); }, add() {}, remove() {}, contains: c => card._classes.has(c) };
    r.closest = sel => (sel === 'label' ? card : null); r.card = card;
    return r;
  });
  const h = boot({
    modules: ['js/app.js', 'js/account-settings.js'],
    beforeModules(doc, ctx) {
      doc.querySelectorAll = sel => {
        const m = /^\[data-as="([a-zA-Z]+)"\]$/.exec(sel);
        if (m) return fields[m[1]] || [];
        if (sel === 'input[name="as-theme"]') return radios;
        return [];
      };
      if (theme) ctx.localStorage.setItem('taqwa_theme', JSON.stringify(theme));
    },
  });
  const calls = { get: [], writes: [] };
  const gate = hold ? deferred() : null;
  h.ctx.Api.get = async p => { calls.get.push(p); if (gate) await gate.promise; return getResult; };
  for (const fn of ['put', 'post', 'delete', 'request']) h.ctx.Api[fn] = async () => { calls.writes.push('Api.' + fn); return { ok: false }; };
  for (const fn of ['putSettings', 'saveSettings', 'resetToSeedData', 'saveData', 'addData', 'create', 'update', 'remove', 'action', 'seedIfEmpty']) {
    const orig = h.ctx.Storage[fn];
    h.ctx.Storage[fn] = (...a) => { if (fn !== 'seedIfEmpty') calls.writes.push('Storage.' + fn); return orig && orig(...a); };
  }
  if (mode === 'api') h.ctx.Storage.isApi = () => true;
  if (mode === 'locked') h.ctx.Storage.isLocked = () => true;
  h.fireReady();
  await new Promise(r => setTimeout(r, 0));
  const el = id => h.ctx.document.getElementById(id);
  const text = k => fields[k][0].textContent;
  const empty = k => fields[k][0]._classes.has('as-empty');
  const inner = k => fields[k][0].innerHTML;
  return { h, el, text, empty, inner, calls, radios, gate, settle: () => new Promise(r => setTimeout(r, 0)) };
}

const XSS = '<img src=x onerror="alert(1)">Bad & Co';
const SAVED = {
  businessName: XSS, phone: '01700-000000', address: 'Road 1, Dhaka', email: '', website: 'https://w.example.org',
  taxId: null, businessDescription: '   ', taxRate: 0, currency: '৳', invoiceFooter: 'Thanks', paymentTerms: '',
  defaultAppointmentDuration: 45, openingTime: '09:30', closingTime: '18:00', workingDays: ['Sat', 'Sun', 'Mon'],
  updatedAt: '2026-10-01T08:00:00.000Z',
};

(async () => {
  { // connected, saved row
    const r = await run({ mode: 'api', getResult: { ok: true, status: 200, data: SAVED } });
    check('connected: reads GET /api/settings once', r.calls.get, ['/settings']);
    check('connected: HTML-like value shown as plain text', r.text('businessName'), XSS);
    ok('connected: no value went in through innerHTML', FIELDS.every(k => r.inner(k) === ''));
    check('connected: missing optional email reads "Not set"', r.text('email'), 'Not set');
    check('connected: null tax ID reads "Not set"', r.text('taxId'), 'Not set');
    check('connected: whitespace-only description reads "Not set"', r.text('businessDescription'), 'Not set');
    ok('connected: empty values are marked empty, filled ones are not', r.empty('email') && !r.empty('phone'));
    check('connected: a 0% tax rate is a real value, not "Not set"', r.text('taxRate'), '0%');
    check('connected: duration in minutes', r.text('defaultAppointmentDuration'), '45 minutes');
    check('connected: opening time formatted', r.text('openingTime'), '9:30 AM');
    check('connected: closing time formatted', r.text('closingTime'), '6:00 PM');
    check('connected: working days listed', r.text('workingDays'), 'Sat, Sun, Mon');
    check('connected: empty payment terms read "Not set"', r.text('paymentTerms'), 'Not set');
    ok('connected: "Last updated" shown from the saved date', r.el('asUpdatedRow').hidden === false && r.text('updatedAt') === '1 Oct 2026');
    ok('connected: state line hidden once loaded', r.el('asState').hidden === true && r.el('asState').dataset.state === 'ok');
    check('connected: nothing written', r.calls.writes, []);
  }
  { // connected, a value missing entirely -> "Not set", never the browser's display default
    const r = await run({ mode: 'api', getResult: { ok: true, status: 200, data: { businessName: 'W' } } });
    check('connected: an absent phone is "Not set", not the app default "+880 1XXX-XXXXXX"', r.text('phone'), 'Not set');
    check('connected: an absent duration is "Not set", not the default 60', r.text('defaultAppointmentDuration'), 'Not set');
    ok('connected: no "Last updated" without a saved date', r.el('asUpdatedRow').hidden !== false);
  }
  { // loading
    const r = await run({ mode: 'api', getResult: { ok: true, status: 200, data: SAVED }, hold: true });
    ok('loading: state line says the settings are loading', r.el('asState').dataset.state === 'loading' && /Loading/.test(r.el('asState').textContent) && r.el('asState').hidden === false);
    r.gate.resolve(); await r.settle(); await r.settle();
    ok('loading: values appear once the request resolves', r.text('phone') === '01700-000000');
  }
  { // connected, no row
    const r = await run({ mode: 'api', getResult: { ok: false, code: 'not_found', status: 404, message: 'No settings have been saved.' } });
    ok('no saved row: every field reads "Not set"', FIELD_KEYS.every(k => r.text(k) === 'Not set'));
    ok('no saved row: says so and points to Settings', r.el('asState').dataset.state === 'info' && /No settings have been saved/.test(r.el('asState').textContent));
  }
  { // connected, server error
    const r = await run({ mode: 'api', getResult: { ok: false, code: 'database_error', status: 500, message: 'Could not read settings.' } });
    ok('error: no values shown ("Unavailable"), nothing guessed', FIELD_KEYS.every(k => r.text(k) === 'Unavailable'));
    ok('error: state line explains the failure', r.el('asState').dataset.state === 'error' && /could not be loaded \(Could not read settings\.\)/.test(r.el('asState').textContent));
  }
  { // connected, session ended
    const r = await run({ mode: 'api', getResult: { ok: false, code: 'unauthorized', status: 401, message: 'Authentication required.' } });
    ok('session ended: values unavailable, asks to sign in again', FIELD_KEYS.every(k => r.text(k) === 'Unavailable') && /session has ended/.test(r.el('asState').textContent));
  }
  { // this browser only
    const r = await run({ mode: 'local' });
    check('offline: makes no request', r.calls.get, []);
    ok('offline: no values shown (not the browser copy or its defaults)', FIELD_KEYS.every(k => r.text(k) === 'Unavailable'));
    ok('offline: state line says no server is answering', r.el('asState').dataset.state === 'warn' && /No server is answering/.test(r.el('asState').textContent));
    check('offline: nothing written', r.calls.writes, []);
  }
  { // signed out
    const r = await run({ mode: 'locked' });
    check('signed out: makes no request', r.calls.get, []);
    ok('signed out: no values, asks to sign in', FIELD_KEYS.every(k => r.text(k) === 'Unavailable') && /Signed out/.test(r.el('asState').textContent));
  }
  { // appearance: reflects and persists the existing preference
    const r = await run({ mode: 'local', theme: 'system' });
    check('appearance: the saved "system" preference is selected', r.radios.map(x => x.checked), [false, false, true]);
    ok('appearance: the selected card is marked', r.radios[2].card._classes.has('is-selected') && !r.radios[0].card._classes.has('is-selected'));
    r.radios[1].checked = true; r.radios[1].dispatch('change');
    check('appearance: choosing Dark persists "dark" through the existing storage key', r.h.ctx.localStorage.getItem('taqwa_theme'), JSON.stringify('dark'));
    check('appearance: Dark is applied to the page', r.h.ctx.document.documentElement.dataset.theme, 'dark');
    check('appearance: exactly one option selected (Dark)', r.radios.map(x => x.checked), [false, true, false]);
    ok('appearance: the change is announced', /Theme set to Dark on this device\./.test(r.el('asThemeStatus').textContent));
    r.radios[0].checked = true; r.radios[0].dispatch('change');
    check('appearance: choosing Light persists "light"', r.h.ctx.localStorage.getItem('taqwa_theme'), JSON.stringify('light'));
    r.radios[2].checked = true; r.radios[2].dispatch('change');
    check('appearance: choosing System persists "system" (the preference, not the resolved theme)', r.h.ctx.localStorage.getItem('taqwa_theme'), JSON.stringify('system'));
    check('appearance: System resolves to the device setting (light here)', r.h.ctx.document.documentElement.dataset.theme, 'light');
    check('appearance: Storage.getTheme() reads back "system"', r.h.ctx.Storage.getTheme(), 'system');
    check('appearance: no business data written while changing theme', r.calls.writes, []);
  }
  {
    const r = await run({ mode: 'local' });
    check('appearance: with nothing saved, Light (the existing default) is selected', r.radios.map(x => x.checked), [true, false, false]);
  }
  process.exit(summary('Account Settings page unit') === 0 ? 0 : 1);
})();
