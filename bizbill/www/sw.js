// Service worker for the browser (PWA) build: caches the app shell so
// BizBill opens offline. The Android app serves files from its APK and does
// not use this worker.
const CACHE = 'bizbill-v1.0.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'icons/icon.svg', 'vendor/jspdf.umd.min.js',
  'js/app.js', 'js/core/money.js', 'js/core/calc.js', 'js/core/db.js', 'js/core/store.js', 'js/core/settings.js',
  'js/core/ledger.js', 'js/core/reports.js', 'js/core/dates.js', 'js/core/states.js', 'js/core/validate.js',
  'js/core/migrate.js', 'js/core/backup.js', 'js/core/csv.js', 'js/core/security.js', 'js/core/search.js',
  'js/ui/dom.js', 'js/ui/components.js', 'js/platform/bridge.js', 'js/docs/layout.js', 'js/docs/templates.js',
  'js/docs/actions.js', 'js/services/housekeeping.js', 'js/services/update.js',
  'js/views/common.js', 'js/views/lock.js', 'js/views/dashboard.js', 'js/views/documents.js', 'js/views/parties.js',
  'js/views/products.js', 'js/views/payments.js', 'js/views/expenses.js', 'js/views/reports.js',
  'js/views/settings.js', 'js/views/data.js', 'js/views/more.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
