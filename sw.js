const CACHE_NAME = 'florian-portfolio-v1';
const BOOTSTRAP_CACHE = 'bootstrap-data-v1';

// Assets statiques à précacher
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/florian.ico',
];

// ── Install : précache les assets statiques ──────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate : nettoie les anciens caches ────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== BOOTSTRAP_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch : stratégie par type de ressource ──────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 0. Ignorer les schémas non supportés par la Cache API (ex: chrome-extension://)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1. Edge function bootstrap → Network first, fallback cache
  if (url.pathname.includes('/functions/v1/bootstrap')) {
    event.respondWith(networkFirstBootstrap(event.request));
    return;
  }

  // 2. Images Supabase Storage → Cache first (longue durée)
  if (url.hostname.includes('supabase.co') && url.pathname.includes('/storage/')) {
    event.respondWith(cacheFirstImages(event.request));
    return;
  }

  // 3. API Supabase REST → Network only (données dynamiques)
  if (url.hostname.includes('supabase.co') && url.pathname.includes('/rest/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 4. Assets JS/CSS/fonts → Cache first avec fallback réseau
  if (
    event.request.destination === 'script' ||
    event.request.destination === 'style' ||
    event.request.destination === 'font'
  ) {
    event.respondWith(cacheFirstStatic(event.request));
    return;
  }

  // 5. Navigation (HTML) → Network first, fallback page d'accueil cachée
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match('/index.html')
      )
    );
    return;
  }
});

// ── Stratégies ───────────────────────────────────────────────────

async function networkFirstBootstrap(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(BOOTSTRAP_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ success: false, error: 'Offline — données en cache non disponibles' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirstImages(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Image non disponible hors ligne', { status: 503 });
  }
}

async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

// ── Message : forcer la mise à jour du cache bootstrap ───────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'CLEAR_BOOTSTRAP_CACHE') {
    caches.delete(BOOTSTRAP_CACHE).then(() => {
      event.ports[0]?.postMessage({ success: true });
    });
  }
});