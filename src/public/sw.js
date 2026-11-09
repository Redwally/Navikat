const CACHE_NAME = 'navikat-shell-v1';

const STATIC_SHELL = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/images/logo.svg',
  '/images/placeholder.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/manifest.webmanifest',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL).catch((err) => {
        console.warn('[SW] Cache addAll warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept non-GET requests
  if (req.method !== 'GET') {
    return;
  }

  // Never intercept Socket.io, auth routes, or api calls
  if (
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/login') ||
    url.pathname.startsWith('/logout')
  ) {
    return;
  }

  // HTML Navigation requests: Network-first with offline fallback
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          return networkRes;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          return new Response(
            `<!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Navikat — Offline</title>
              <style>
                body { font-family: sans-serif; background: #dfe4ec; color: #1b2430; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; padding: 20px; }
                .card { background: rgba(255,255,255,0.7); backdrop-filter: blur(16px); padding: 32px; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); max-width: 400px; }
                h1 { margin-top: 0; font-size: 22px; }
                p { color: #475569; font-size: 14px; line-height: 1.5; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>📡 Mode Hors Ligne</h1>
                <p>Navikat est actuellement inaccessible sans connexion réseau. Vérifiez votre connexion pour reprendre les téléchargements.</p>
              </div>
            </body>
            </html>`,
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // Static assets (CSS, JS, Fonts, Images, Icons, Manifest): Stale-while-revalidate
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/images/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cachedRes = await cache.match(req);
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              cache.put(req, networkRes.clone());
            }
            return networkRes;
          })
          .catch(() => cachedRes);
        return cachedRes || fetchPromise;
      })
    );
    return;
  }
});

