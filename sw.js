// VocaVera Service Worker — Versioned Cache
const CACHE_VERSION = 'v3'; // Bumped for icon & manifest fixes
const CACHE_NAME = `vocavera-cache-${CACHE_VERSION}`;

// Assets to precache on install
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png'
];

// Install event - precache core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log(`[SW] Caching core assets`);
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .catch((error) => {
        console.log('[SW] Precache failed:', error);
      })
  );
  self.skipWaiting();
});

// Activate event - claim clients & clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
  // Notify all clients that new SW is active
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({ type: 'SW_UPDATE_AVAILABLE' });
    });
  });
});

// Fetch event - smart caching strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests (e.g., Supabase, CDNs)
  if (!request.url.startsWith(self.location.origin)) return;

  // For HTML, manifest, service worker: Network-first (always fresh)
  if (request.destination === 'document' || 
      request.url.includes('manifest.json') || 
      request.url.includes('sw.js')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Update cache with fresh response
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseToCache);
          });
          return response;
        })
        .catch(() => {
          // Network failed, try cache
          return caches.match(request).then(cached => {
            if (cached) return cached;
            return new Response('Offline', { status: 503 });
          });
        })
    );
    return;
  }

  // For images (icons, screenshots): Network-first with fallback to cache
  if (request.destination === 'image') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseToCache);
          });
          return response;
        })
        .catch(() => {
          return caches.match(request).then(cached => {
            if (cached) return cached;
            // Return a 1x1 transparent PNG as fallback
            return new Response(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
              {
                status: 200,
                statusText: 'OK',
                headers: { 'Content-Type': 'image/png' }
              }
            );
          });
        })
    );
    return;
  }

  // For other static assets: Cache-first with background revalidation
  event.respondWith(
    caches.match(request)
      .then((cached) => {
        if (cached) {
          // Revalidate in background
          fetch(request).then(response => {
            if (response && response.status === 200) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(request, response.clone());
              });
            }
          }).catch(() => {});
          return cached;
        }
        // Not in cache, fetch from network
        return fetch(request)
          .then((response) => {
            if (!response || response.status !== 200) return response;
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, responseToCache);
            });
            return response;
          })
          .catch(() => new Response('Offline', { status: 503 }));
      })
  );
});

// Handle messages from main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'VERSION', version: CACHE_VERSION });
      });
    });
  }
});
