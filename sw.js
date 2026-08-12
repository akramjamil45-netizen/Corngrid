const CACHE_NAME = 'corngrid-cache-v2.5';

// Senarai fail yang ingin disimpan dalam cache browser
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/mystyle.css',
    '/script.js',
    '/favicon.ico',
    '/images/1.jpg',
    '/images/2.jpg',
    '/images/3.jpg',
    '/images/akram.jfif',
    '/images/azudin.jfif',
    '/images/background2.jpg',
    '/images/bg-algo-specs.jpg',
    '/images/bg-faq.jpg',
    '/images/bg-features.jpg',
    '/images/bg-support.jpg',
    '/images/bg-testimonial (2).jpg',
    '/images/bg-testimonial.jpg',
    '/images/CornGrid logo 4k.jpg',
    '/images/hero-image.png',
    '/images/dashboard.jfif',
    '/images/fahrul.jfif',
    '/images/favicon.ico',
    '/images/gmail.svg',
    '/images/hfmarket.png',
    '/images/Hfmarket.svg',
    '/images/Litefinance.svg',
    '/images/myfxbook.png',
    '/images/Nadiah.jfif',
    '/images/Roboforex.svg',
    '/images/suhaimi.jfif',
    '/images/telegram.svg',
    '/images/tiktok.svg',
    '/images/whatsapp.svg',
    '/files/terms.txt',
    '/video/background2.mp4'
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