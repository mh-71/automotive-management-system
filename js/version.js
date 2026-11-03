/* version.js — the app version, shown in the footer and used by the service
   worker (sw.js) to name its cache. Bump it with every deploy that changes a
   page, script, style or image: the new service worker then replaces the old
   cache, and the old one is deleted once it takes over. */
const TAQWA_VERSION = '2026.11.03-equipment.3';
if (typeof self !== 'undefined') self.TAQWA_VERSION = TAQWA_VERSION;
