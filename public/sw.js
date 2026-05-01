// BOTDOT Service Worker
//
// Estrategia (compliance-first):
//   - /api/*           : NETWORK-ONLY  (jamas cachear datos operacionales)
//   - HTML (.html, /)  : NETWORK-FIRST (update rapido, fallback cache offline)
//   - estaticos        : CACHE-FIRST   (CSS/JS/img/manifest/font)
//
// Por que /api/* no se cachea: BOTDOT es herramienta de compliance DOT.
// Mostrar HOS, drivers o escalations stale = riesgo de mala recomendacion.
// Si el usuario esta offline, prefiero que /api/* falle visiblemente a que
// muestre datos viejos.
//
// Versioning: bumpea CACHE_VERSION cuando cambies assets. La activacion
// purga caches viejas.

const CACHE_VERSION = 'botdot-v3';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Shell pre-cache — minimo necesario para que la UI rinda algo offline.
const SHELL_ASSETS = [
  '/index.html',
  '/app.html',
  '/css/styles.css',
  '/js/auth.js',
  '/js/app.js',
  '/js/chat.js',
  '/js/dashboard.js',
  '/img/dotbot-header.png',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/img/apple-touch-180.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_ASSETS).catch((err) => {
        // Si un asset falla, no bloqueamos la instalacion entera —
        // el SW igual sirve para network-only en /api/* y network-first en HTML.
        console.warn('[sw] precache parcial:', err);
      })
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// skipWaiting controlado desde la pagina (pwa.js manda 'SKIP_WAITING')
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function isHtml(req, url) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/html')) return true;
  if (url.pathname.endsWith('.html')) return true;
  if (url.pathname === '/') return true;
  return false;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo manejar GET — POST/PATCH/DELETE pasan directo a la red siempre.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Mismo origen unicamente. Cross-origin (CDN tailwind, etc) lo deja al browser.
  if (url.origin !== self.location.origin) return;

  // 1. /api/* — NETWORK-ONLY. Compliance integrity > offline UX.
  if (isApi(url)) {
    return; // dejar pasar al browser sin interceptar
  }

  // 2. HTML — NETWORK-FIRST con fallback a cache.
  if (isHtml(req, url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          // Ultimo fallback: el shell de index.html
          const shell = await caches.match('/index.html');
          if (shell) return shell;
          return new Response('Sin conexion', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
    );
    return;
  }

  // 3. Estaticos — CACHE-FIRST con fill on miss.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res && res.ok && (res.type === 'basic' || res.type === 'default')) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          return new Response('', { status: 504 });
        });
    })
  );
});
