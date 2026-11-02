/* ============================================================
   sw.js — the service worker (offline Phase 1)
   ------------------------------------------------------------
   Makes the app SHELL available offline: every page, script,
   style and image (js/sw-assets.js). It never touches business
   data: /api/* requests pass straight to the network and are
   never cached here -- the offline copy of the data is the
   encrypted one in IndexedDB (js/offline.js).

   Strategy: network first. Online, every file comes fresh from
   the server (so a deploy is seen at once) and the cached copy is
   refreshed; offline, the cached copy is used. A navigation that
   has no cached page falls back to the dashboard page, which then
   explains that the computer is offline.

   Versions: the cache is named after TAQWA_VERSION (js/version.js).
   A new version installs its own cache, takes over, and deletes
   the old one.
   ============================================================ */
importScripts('/js/version.js', '/js/sw-assets.js');

const CACHE = `taqwa-shell-${self.TAQWA_VERSION}`;
const TIMEOUT_MS = 8000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' -- straight from the server, not from the browser's HTTP cache.
    await cache.addAll(self.TAQWA_ASSETS.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('taqwa-shell-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: self.TAQWA_VERSION, cache: CACHE });
  }
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The cache key for a request: its path, without a query (pages take ?view=...). */
const keyOf = (url) => new Request(url.origin + url.pathname);

async function networkFirst(request, url) {
  const cache = await caches.open(CACHE);
  try {
    const response = await withTimeout(fetch(request), TIMEOUT_MS);
    // Only plain same-origin successes are kept: never an error page, a redirect or an opaque reply.
    if (response.ok && response.type === 'basic' && !response.redirected) {
      cache.put(keyOf(url), response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const hit = await cache.match(keyOf(url));
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const shell = await cache.match(new Request(url.origin + '/index.html'));
      if (shell) return shell;
    }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;          // fonts and anything else: the browser's business
  if (url.pathname.startsWith('/api/')) return;             // business data is never cached here
  if (url.pathname === '/sw.js') return;
  event.respondWith(networkFirst(request, url));
});
