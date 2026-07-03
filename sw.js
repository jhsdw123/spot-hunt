// Spot Hunt service worker — app shell precache + runtime image caching.
const SHELL_CACHE = 'sh-shell-v4';
const IMG_CACHE = 'sh-img-v1';
const SHELL = [
  './', 'index.html', 'css/game.css',
  'js/main.js', 'js/game.js', 'js/data.js', 'js/audio.js', 'js/confetti.js',
  'js/versus.js', 'js/config.js', 'vendor/supabase.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== IMG_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // puzzle images: cache-first (they never change once published)
  if (url.pathname.includes('/library/img/')) {
    e.respondWith(
      caches.open(IMG_CACHE).then(async c => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // library manifest: network-first so new puzzles appear, cached fallback for offline
  if (url.pathname.endsWith('/library/manifest.json')) {
    e.respondWith(
      fetch(e.request).then(res => {
        caches.open(IMG_CACHE).then(c => c.put(e.request, res.clone()));
        return res.clone();
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // app shell: cache-first
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
  }
});
