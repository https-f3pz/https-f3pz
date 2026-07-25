// Service worker: makes the game a genuinely offline app.
//
// Strategy is cache-first for everything in the shell, because the shell IS
// the whole game — there is no server-side content to stay fresh with. A new
// version ships by bumping CACHE, which precaches the new shell in the
// background and swaps it in on the next launch.

const CACHE = 'flashover-v1';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/core/loop.js',
  './src/core/input.js',
  './src/core/audio.js',
  './src/core/storage.js',
  './src/core/rng.js',
  './src/core/fx.js',
  './src/core/draw.js',
  './src/core/widgets.js',
  './src/game/game.js',
  './src/game/config.js',
  './src/game/entities.js',
  './src/game/run.js',
  './src/game/render.js',
  './src/game/hud.js',
  './src/game/screens.js',
  './src/game/meta.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-64.png',
];

// Icons are nice to have; the code is not. Splitting them means a flaky
// network can cost you an app icon but can never leave a "successfully"
// installed service worker serving a half-cached shell that cannot boot —
// which, because activate() then deletes the old cache, would brick offline
// launch permanently rather than transiently.
const OPTIONAL = SHELL.filter((u) => u.startsWith('./icons/'));
const CORE = SHELL.filter((u) => !OPTIONAL.includes(u));

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Any core file failing must reject the install, so the previous
      // (working) service worker and its cache stay in place.
      await Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
      await Promise.all(
        OPTIONAL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {
            /* an icon is not worth failing the install over */
          })
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // nothing external is used

  // Navigations always resolve to the cached shell so a cold launch from the
  // home screen works with the radio off, including on a deep link.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = (await cache.match('./index.html')) || (await cache.match('./'));
        if (cached) {
          // Refresh in the background; never block the launch on the network.
          event.waitUntil(
            fetch(req)
              .then((res) => res.ok && cache.put('./index.html', res.clone()))
              .catch(() => {})
          );
          return cached;
        }
        try {
          return await fetch(req);
        } catch {
          return new Response('<h1>Offline</h1><p>Open the app once while online to install it.</p>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504, statusText: 'offline' });
      }
    })()
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
