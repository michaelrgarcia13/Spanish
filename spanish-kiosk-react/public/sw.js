// Service Worker for Spanish Tutor PWA
const CACHE_NAME = 'spanish-tutor-v1.0.1'; // Increment version to force cache refresh
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// Detect development mode
const isDevelopment = self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1';

// Install event - cache essential assets
self.addEventListener('install', event => {
  console.log('[SW] Install event');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Skip waiting');
        return self.skipWaiting();
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activate event');
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[SW] Claiming clients');
        return self.clients.claim();
      })
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // Skip API calls - always go to network for fresh data
  if (event.request.url.includes('/chat') || 
      event.request.url.includes('/stt') || 
      event.request.url.includes('/tts')) {
    return;
  }

  event.respondWith(
    // In development mode, always fetch from network to avoid caching issues
    isDevelopment ? 
      fetch(event.request).then(response => {
        console.log('[SW] Development mode - bypassing cache:', event.request.url);
        return response;
      }) :
      caches.match(event.request)
        .then(response => {
          // Return cached version if available
          if (response) {
            console.log('[SW] Serving from cache:', event.request.url);
            return response;
          }

          // Otherwise fetch from network
          console.log('[SW] Fetching from network:', event.request.url);
          return fetch(event.request)
          .then(response => {
            // Don't cache non-successful responses
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone the response (it can only be consumed once)
            const responseToCache = response.clone();

            // Add to cache for future use
            caches.open(CACHE_NAME)
              .then(cache => {
                cache.put(event.request, responseToCache);
              });

            return response;
          });
      })
  );
});

// Background sync for offline functionality (future enhancement)
self.addEventListener('sync', event => {
  console.log('[SW] Background sync:', event.tag);
  
  if (event.tag === 'spanish-practice-sync') {
    event.waitUntil(
      // Could implement offline practice sessions here
      Promise.resolve()
    );
  }
});

// Push notifications (future enhancement)
self.addEventListener('push', event => {
  console.log('[SW] Push notification received');
  
  const options = {
    body: event.data ? event.data.text() : '¡Tiempo de practicar español!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'explore',
        title: 'Practicar ahora',
        icon: '/icon-192.png'
      },
      {
        action: 'close',
        title: 'Cerrar',
        icon: '/icon-192.png'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('Spanish Tutor', options)
  );
});
