const CACHE_VERSION = 'v4';
const CACHE_NAME = `gallery-cache-${CACHE_VERSION}`;
const API_CACHE_NAME = `api-cache-${CACHE_VERSION}`;
const BOOTSTRAP_CACHE_NAME = `bootstrap-cache-${CACHE_VERSION}`;
const EGRESS_DB_NAME = 'egress-tracker';
const EGRESS_STORE_NAME = 'daily-egress';

// Core assets to precache
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/offline.html',
];

// Supabase API patterns to cache
const SUPABASE_REST_PATTERNS = [
  /rest\/v1\/site_config/,
  /rest\/v1\/gallery_images/,
  /rest\/v1\/about_content/,
  /rest\/v1\/skills/,
  /rest\/v1\/contact_info/,
  /rest\/v1\/social_links/,
  /rest\/v1\/notifications/,
  /rest\/v1\/advertisements/,
];

// Bootstrap endpoint pattern
const BOOTSTRAP_PATTERN = /functions\/v1\/bootstrap/;

// Cache durations
const API_CACHE_DURATION = 30 * 60 * 1000;
const BOOTSTRAP_CACHE_DURATION = 60 * 60 * 1000;
const IMAGE_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// ========== EGRESS TRACKING ==========

// Open IndexedDB for egress tracking
const openEgressDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EGRESS_DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(EGRESS_STORE_NAME)) {
        db.createObjectStore(EGRESS_STORE_NAME, { keyPath: 'date' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const getTodayKey = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

// Track egress for a response
const trackEgress = async (url, responseSize, category) => {
  try {
    const db = await openEgressDB();
    const tx = db.transaction(EGRESS_STORE_NAME, 'readwrite');
    const store = tx.objectStore(EGRESS_STORE_NAME);
    const dateKey = getTodayKey();
    
    const existing = await new Promise((resolve) => {
      const req = store.get(dateKey);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    const record = existing || {
      date: dateKey,
      totalBytes: 0,
      requestCount: 0,
      categories: { api: 0, images: 0, fonts: 0, bootstrap: 0, other: 0 },
      cacheHits: 0,
      cacheMisses: 0,
    };

    record.totalBytes += responseSize;
    record.requestCount += 1;
    record.categories[category] = (record.categories[category] || 0) + responseSize;
    record.cacheMisses += 1;

    store.put(record);
    db.close();
  } catch (e) {
    // Silent fail - tracking shouldn't break the app
  }
};

const trackCacheHit = async (category) => {
  try {
    const db = await openEgressDB();
    const tx = db.transaction(EGRESS_STORE_NAME, 'readwrite');
    const store = tx.objectStore(EGRESS_STORE_NAME);
    const dateKey = getTodayKey();
    
    const existing = await new Promise((resolve) => {
      const req = store.get(dateKey);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    const record = existing || {
      date: dateKey,
      totalBytes: 0,
      requestCount: 0,
      categories: { api: 0, images: 0, fonts: 0, bootstrap: 0, other: 0 },
      cacheHits: 0,
      cacheMisses: 0,
    };

    record.cacheHits += 1;
    store.put(record);
    db.close();
  } catch (e) {
    // Silent fail
  }
};

// Get response size from headers or clone
const getResponseSize = (response) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength) return parseInt(contentLength, 10);
  // Fallback estimate based on content-type
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('image')) return 200 * 1024; // ~200KB avg
  if (ct.includes('font')) return 50 * 1024; // ~50KB avg
  return 5 * 1024; // ~5KB for API responses
};

// ========== URL HELPERS ==========

const isCacheableUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch {
    return false;
  }
};

const isSupabaseApiRequest = (url) => {
  return SUPABASE_REST_PATTERNS.some(pattern => pattern.test(url));
};

const isBootstrapRequest = (url) => {
  return BOOTSTRAP_PATTERN.test(url);
};

const isImageRequest = (url) => {
  return /\.(jpg|jpeg|png|gif|webp|avif|svg)(\?|$)/i.test(url);
};

const isFontRequest = (url) => {
  return /\.(woff|woff2|ttf|otf|eot)(\?|$)/i.test(url) || 
         url.includes('fonts.googleapis.com') ||
         url.includes('fonts.gstatic.com');
};

// ========== INSTALL & ACTIVATE ==========

self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker: Installing v4...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      const validAssets = CORE_ASSETS.filter(asset => 
        !asset.startsWith('chrome-extension://') && 
        (asset.startsWith('/') || isCacheableUrl(asset))
      );
      return cache.addAll(validAssets).catch((error) => {
        console.warn('⚠️ Precache error:', error);
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker: Activating v4...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => !name.includes(CACHE_VERSION))
          .map((name) => {
            console.log('🗑️ Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ========== REQUEST HANDLERS ==========

const handleBootstrapRequest = async (request) => {
  const cache = await caches.open(BOOTSTRAP_CACHE_NAME);
  const url = new URL(request.url);
  const cacheKey = url.origin + url.pathname;
  const cachedResponse = await cache.match(cacheKey);
  
  if (cachedResponse) {
    const cachedTime = cachedResponse.headers.get('x-cache-time');
    if (cachedTime && Date.now() - parseInt(cachedTime) < BOOTSTRAP_CACHE_DURATION) {
      trackCacheHit('bootstrap');
      
      fetch(request.clone()).then(async (response) => {
        if (response.ok) {
          const size = getResponseSize(response);
          trackEgress(request.url, size, 'bootstrap');
          const headers = new Headers(response.headers);
          headers.set('x-cache-time', Date.now().toString());
          const body = await response.blob();
          cache.put(cacheKey, new Response(body, { status: response.status, statusText: response.statusText, headers }));
        }
      }).catch(() => {});
      
      return cachedResponse;
    }
  }
  
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const size = getResponseSize(networkResponse);
      trackEgress(request.url, size, 'bootstrap');
      const headers = new Headers(networkResponse.headers);
      headers.set('x-cache-time', Date.now().toString());
      const body = await networkResponse.clone().blob();
      cache.put(cacheKey, new Response(body, { status: networkResponse.status, statusText: networkResponse.statusText, headers }));
    }
    return networkResponse;
  } catch (error) {
    if (cachedResponse) return cachedResponse;
    throw error;
  }
};

const handleApiRequest = async (request) => {
  const cache = await caches.open(API_CACHE_NAME);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    const cachedTime = cachedResponse.headers.get('x-cache-time');
    if (cachedTime && Date.now() - parseInt(cachedTime) < API_CACHE_DURATION) {
      trackCacheHit('api');
      return cachedResponse;
    }
  }
  
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const size = getResponseSize(networkResponse);
      trackEgress(request.url, size, 'api');
      const headers = new Headers(networkResponse.headers);
      headers.set('x-cache-time', Date.now().toString());
      const body = await networkResponse.clone().blob();
      cache.put(request, new Response(body, { status: networkResponse.status, statusText: networkResponse.statusText, headers }));
    }
    return networkResponse;
  } catch (error) {
    if (cachedResponse) return cachedResponse;
    throw error;
  }
};

const handleImageRequest = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    trackCacheHit('images');
    fetch(request.clone()).then(response => {
      if (response.ok) {
        const size = getResponseSize(response);
        trackEgress(request.url, size, 'images');
        cache.put(request, response);
      }
    }).catch(() => {});
    return cachedResponse;
  }
  
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const size = getResponseSize(networkResponse);
      trackEgress(request.url, size, 'images');
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect fill="#e5e7eb" width="100" height="100"/><text x="50" y="55" text-anchor="middle" fill="#9ca3af" font-size="12">Offline</text></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } }
    );
  }
};

const handleFontRequest = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  const cachedResponse = await cache.match(request);
  
  if (cachedResponse) {
    trackCacheHit('fonts');
    return cachedResponse;
  }
  
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const size = getResponseSize(networkResponse);
      trackEgress(request.url, size, 'fonts');
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    throw error;
  }
};

// ========== MAIN FETCH HANDLER ==========

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableUrl(request.url)) return;
  if (request.method !== 'GET') return;
  
  if (isBootstrapRequest(request.url)) {
    event.respondWith(handleBootstrapRequest(request));
    return;
  }
  if (isSupabaseApiRequest(request.url)) {
    event.respondWith(handleApiRequest(request));
    return;
  }
  if (isImageRequest(request.url)) {
    event.respondWith(handleImageRequest(request));
    return;
  }
  if (isFontRequest(request.url)) {
    event.respondWith(handleFontRequest(request));
    return;
  }
  
  // Default: Network first with cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const size = getResponseSize(response);
          trackEgress(request.url, size, 'other');
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone).catch(() => {});
          });
        }
        return response;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) return cachedResponse;
        if (request.mode === 'navigate') return caches.match('/offline.html');
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      })
  );
});

// ========== MESSAGE HANDLER ==========

self.addEventListener('message', (event) => {
  const { type, urls } = event.data;
  
  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;
      
    case 'CLEAR_ALL_CACHES':
      Promise.all([
        caches.delete(CACHE_NAME),
        caches.delete(API_CACHE_NAME),
        caches.delete(BOOTSTRAP_CACHE_NAME),
      ]).then(() => console.log('🗑️ All caches cleared'));
      break;
      
    case 'CLEAR_API_CACHE':
      caches.delete(API_CACHE_NAME).then(() => console.log('🗑️ API cache cleared'));
      break;
      
    case 'CLEAR_BOOTSTRAP_CACHE':
      caches.delete(BOOTSTRAP_CACHE_NAME).then(() => console.log('🗑️ Bootstrap cache cleared'));
      break;
      
    case 'CACHE_GALLERY_IMAGES':
      if (Array.isArray(urls)) {
        event.waitUntil(
          caches.open(CACHE_NAME).then(async (cache) => {
            const validUrls = urls.filter(isCacheableUrl);
            const results = await Promise.allSettled(
              validUrls.map(url => 
                fetch(url).then(response => {
                  if (response.ok) return cache.put(url, response);
                  throw new Error(`HTTP ${response.status}`);
                }).catch(error => console.warn(`⚠️ Cache error ${url}:`, error.message))
              )
            );
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            console.log(`✅ ${successCount}/${validUrls.length} images cached`);
          })
        );
      }
      break;
      
    case 'PREFETCH_BOOTSTRAP':
      event.waitUntil(
        fetch(event.data.url || '/functions/v1/bootstrap', { method: 'POST' })
          .then(response => { if (response.ok) console.log('✅ Bootstrap prefetched'); })
          .catch(() => {})
      );
      break;

    case 'GET_EGRESS_STATS':
      event.waitUntil(
        (async () => {
          try {
            const db = await openEgressDB();
            const tx = db.transaction(EGRESS_STORE_NAME, 'readonly');
            const store = tx.objectStore(EGRESS_STORE_NAME);
            const allRecords = await new Promise((resolve) => {
              const req = store.getAll();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve([]);
            });
            db.close();
            
            // Send data back to the client
            event.source.postMessage({
              type: 'EGRESS_STATS_RESPONSE',
              data: allRecords,
            });
          } catch (e) {
            event.source.postMessage({
              type: 'EGRESS_STATS_RESPONSE',
              data: [],
            });
          }
        })()
      );
      break;

    case 'CLEAR_EGRESS_STATS':
      event.waitUntil(
        (async () => {
          try {
            const db = await openEgressDB();
            const tx = db.transaction(EGRESS_STORE_NAME, 'readwrite');
            tx.objectStore(EGRESS_STORE_NAME).clear();
            db.close();
          } catch (e) {}
        })()
      );
      break;
  }
});

// Background sync
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-analytics') {
    event.waitUntil(Promise.resolve());
  }
});

// Push notifications
self.addEventListener('push', (event) => {
  if (event.data) {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/favicon.ico',
        badge: '/favicon.ico',
        vibrate: [100, 50, 100],
        data: { url: data.url || '/' },
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});