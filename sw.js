// VocaVera Service Worker
// Version: 1.0.0
const CACHE_VERSION = 'v1.0.0';
const CACHE_NAME = `vocavera-cache-${CACHE_VERSION}`;

// Static assets to cache immediately (Cache-first strategy)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// Word list cache names for different pool types
const WORD_CACHE = 'vocavera-words';
const WORD_CACHE_STALE = 3600000; // 1 hour stale-while-revalidate

// Background sync queue name
const SYNC_QUEUE = 'vocavera-sync-queue';

// Install event - cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        // Force activation immediately
        return self.skipWaiting();
      })
  );
});

// Activate event - clean old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames
            .filter(name => name.startsWith('vocavera-cache-') && name !== CACHE_NAME)
            .map(name => {
              console.log('[SW] Deleting old cache:', name);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        // Take control of all pages immediately
        return self.clients.claim();
      })
  );
});

// Fetch event - implement caching strategies
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Handle same-origin requests
  if (url.origin === location.origin) {
    event.respondWith(handleLocalRequest(request));
  }
  // Handle CDN requests (static)
  else if (request.url.includes('cdn.sheetjs.com')) {
    event.respondWith(cacheFirst(request));
  }
  // Fallback for other cross-origin
  else {
    event.respondWith(networkFirst(request));
  }
});

async function handleLocalRequest(request) {
  const url = request.url;

  // HTML pages - network first with fallback to cache
  if (request.headers.get('accept')?.includes('text/html')) {
    return networkFirstWithOfflineFallback(request, '/offline.html');
  }

  // Static assets (CSS, JS, images, fonts) - cache first
  if (isStaticAsset(url)) {
    return cacheFirst(request);
  }

  // API/word data requests - network first with stale-while-revalidate
  if (url.pathname.includes('/words') || url.pathname.includes('/api')) {
    return networkFirstWithStaleWhileRevalidate(request, WORD_CACHE, WORD_CACHE_STALE);
  }

  // Default: network first
  return networkFirst(request);
}

function isStaticAsset(url) {
  const staticExtensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.webp', '.json'];
  return staticExtensions.some(ext => url.includes(ext) || url.endsWith(ext)) ||
         url.includes('/static/') ||
         url.includes('/assets/') ||
         url.includes('/icons/');
}

// Caching Strategies

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    return createOfflineResponse(request);
  }
}

async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return createOfflineResponse(request);
  }
}

async function networkFirstWithOfflineFallback(request, fallbackPath) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.log('[SW] Offline, serving fallback:', fallbackPath);
    const cached = await caches.match(fallbackPath);
    if (cached) return cached;

    // Create simple offline HTML
    return new Response(`
      <!DOCTYPE html>
      <html>
        <head><title>Offline - VocaVera</title></head>
        <body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#FAFAFA;color:#374151">
          <div style="text-align:center;padding:24px">
            <div style="font-size:48px;margin-bottom:16px">📚</div>
            <h1 style="margin:0 0 8px">You're offline</h1>
            <p style="margin:0;color:#6B7280">Check your internet connection and try again.</p>
          </div>
        </body>
      </html>
    `, { headers: { 'Content-Type': 'text/html' } });
  }
}

async function networkFirstWithStaleWhileRevalidate(request, cacheName, staleTime) {
  const cache = await caches.open(CacheName);
  const cached = await cache.match(request);

  // Fetch in background to update cache
  const fetchPromise = fetch(request)
    .then(response => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // Return cached immediately if available and fresh
  if (cached) {
    const cachedTime = cached.headers.get('x-cached-time');
    if (cachedTime && (Date.now() - parseInt(cachedTime) < staleTime)) {
      return cached;
    }
  }

  // Wait for network or return cached
  const networkResponse = await fetchPromise;
  return networkResponse || cached || new Response(JSON.stringify({ error: 'Offline' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

function createOfflineResponse(request) {
  // Return cached version or basic error
  return caches.match(request).then(cached => {
    if (cached) return cached;

    // Special offline pages for specific routes
    if (request.url.includes('/words')) {
      return new Response(JSON.stringify({ words: [], message: 'Offline - no cached data' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Offline', { status: 503 });
  });
}

// Background Sync
self.addEventListener('sync', (event) => {
  console.log('[SW] Background sync:', event.tag);

  if (event.tag === 'quiz-sync') {
    event.waitUntil(syncQuizResults());
  }

  if (event.tag === 'progress-sync') {
    event.waitUntil(syncProgress());
  }
});

async function syncQuizResults() {
  console.log('[SW] Syncing quiz results...');
  const db = await getIndexedDB();
  const queue = await db.getAll('syncQueue');

  for (const item of queue) {
    try {
      const response = await fetch('/api/quiz-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.data)
      });

      if (response.ok) {
        await db.delete('syncQueue', item.id);
        console.log('[SW] Synced quiz result:', item.id);
      }
    } catch (error) {
      console.log('[SW] Sync failed, will retry:', error.message);
      break; // Stop on first error, will retry later
    }
  }
}

async function syncProgress() {
  console.log('[SW] Syncing progress...');
  // Similar implementation for progress sync
}

// Push Notifications
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};

  const options = {
    body: data.body || 'Continue your learning streak!',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/badge-72x72.png',
    vibrate: [200, 100, 200],
    data: {
      url: data.url || '/',
      action: data.action || 'open'
    },
    actions: data.actions || [
      { action: 'open', title: 'Open App' },
      { action: 'quiz', title: 'Start Quiz' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'VocaVera',
      options
    )
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'quiz') {
    event.waitUntil(
      clients.openWindow('/?tab=quiz')
    );
  } else {
    event.waitUntil(
      clients.openWindow(event.notification.data.url || '/')
    );
  }
});

// IndexedDB helpers for sync queue
async function getIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('VocaVera', 2);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      resolve({
        getAll: (store) => new Promise((res, rej) => {
          const tx = db.transaction(store, 'readonly');
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        }),
        delete: (store, id) => new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          const req = tx.objectStore(store).delete(id);
          req.onsuccess = () => res();
          req.onerror = () => rej(req.error);
        }),
        add: (store, data) => new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          const req = tx.objectStore(store).add(data);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        })
      });
    };

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('syncQueue')) {
        const store = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
}

// Helpers
function isOnline() {
  return navigator.onLine;
}

// Message handling from main app
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }

  if (type === 'QUEUE_SYNC') {
    // Add item to sync queue
    getIndexedDB().then(db => {
      db.add('syncQueue', {
        type: data.type,
        data: data.payload,
        timestamp: Date.now()
      });
    });
  }
});

console.log('[SW] Service Worker loaded');
