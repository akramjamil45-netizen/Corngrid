const CACHE_NAME = 'corngrid-cache-v1';

// Senarai fail yang ingin disimpan dalam cache browser
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/images/CornGrid logo 4k.png',
    '/images/hero-image.png',
    '/images/dashboard.jpg',
    '/images/myfxbook.png',
    '/files/terms.txt',
    '/video/background.mp4'
];

// 1. Install Event - Simpan fail semasa laman web mula diakses
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching all assets');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

// 2. Activate Event - Padam cache lama jika ada versi baharu
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('[Service Worker] Clearing old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// 3. Fetch Event - Gunakan fail daripada Cache terlebih dahulu (Sangat Pantas)
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                // Pulangkan fail daripada cache
                return cachedResponse;
            }
            // Jika tiada dalam cache, muat turun daripada server
            return fetch(event.request).then((networkResponse) => {
                return networkResponse;
            });
        })
    );
});