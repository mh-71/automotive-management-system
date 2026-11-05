/* page-render-block — no page paints before its shell exists.

   Every page change is a full document load, and the sidebar and header are
   drawn by app.js, which runs from the scripts at the end of <body>. A page
   that paints before then shows a frame with no sidebar navigation and no
   header -- a visible redraw on every click. Each page therefore holds its
   first paint (<link rel="expect" ... blocking="render">) until a marker that
   sits AFTER its scripts has been parsed.

   Static checks over the shipped HTML; nothing is reimplemented. */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { check, ok, summary } = require('../lib/harness.cjs');
const ROOT = path.resolve(__dirname, '..', '..');

const pages = ['index.html', ...fs.readdirSync(path.join(ROOT, 'pages')).filter(f => f.endsWith('.html')).map(f => `pages/${f}`)];
const headers = fs.readFileSync(path.join(ROOT, '_headers'), 'utf8');
const allowedHash = (headers.match(/'sha256-([^']+)'/) || [])[1];

console.log('=== page-render-block: first paint waits for the shell ===\n');
check('every module page is covered', pages.length, 46);   // index.html + every page in pages/ (45), counted again whenever a page is added

for (const p of pages) {
  const html = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const expect = '<link rel="expect" href="#shell-drawn" blocking="render">';
  const marker = '<span id="shell-drawn" hidden></span>';
  ok(`${p}: holds its first paint in <head>`, head.includes(expect), 'expect link missing from <head>');
  check(`${p}:    ...once`, html.split(expect).length - 1, 1);
  const iMarker = html.indexOf(marker);
  const iApp = html.search(/<script src="(\.\.\/)?js\/app\.js"><\/script>/);
  const iLastScript = html.lastIndexOf('<script src=');
  ok(`${p}:    ...until a marker placed after app.js and every other script`,
    iMarker > iApp && iApp !== -1 && iMarker > iLastScript, `marker at ${iMarker}, app.js at ${iApp}, last script at ${iLastScript}`);
  check(`${p}:    ...which appears once`, html.split('id="shell-drawn"').length - 1, 1);
  // The pre-paint theme script is allowed by hash in the CSP; editing around it must not change it.
  const inline = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  check(`${p}:    ...and the theme script still matches the CSP hash`,
    crypto.createHash('sha256').update(inline).digest('base64'), allowedHash);
}

process.exit(summary('Page render-block unit') === 0 ? 0 : 1);
