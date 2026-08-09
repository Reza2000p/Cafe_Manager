// ==========================================
// CAFE CLOVER - SERVICE WORKER (NETWORK FIRST & AUTO-UPDATE STRATEGY)
// ==========================================
const CACHE_NAME = 'cafe-v19';

const STATIC_ASSETS = [
    './',
    './index.html?v=20260809_v4',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './css/styles.css?v=20260809_v4',
    './js/config.js?v=20260809_v4',
    './js/timers.js?v=20260809_v4',
    './js/app.js?v=20260809_v4'
];

// Install Event: Force immediate SW update
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(STATIC_ASSETS).catch(err => console.log('Cache addAll error:', err));
        })
    );
});

// Activate Event: Immediately claim clients and purge ALL old cache versions
self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then((keys) => {
                return Promise.all(
                    keys.map((key) => {
                        if (key !== CACHE_NAME) {
                            return caches.delete(key);
                        }
                    })
                );
            })
        ])
    );
});

// Fetch Event: NETWORK-FIRST STRATEGY (Never lock out updates)
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Bypass cache completely for API/WebSockets
    if (url.hostname.includes('supabase.co') || url.protocol === 'wss:') {
        return;
    }

    event.respondWith(
        fetch(event.request, { cache: 'no-cache' })
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return networkResponse;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                if (cached) return cached;
                return new Response('', { status: 404, statusText: 'Not Found' });
            })
    );
});