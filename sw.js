const CACHE_NAME = 'corngrid-cache-v3.2'; // Tukar versi ini setiap kali ada kemaskini

const ASSETS_TO_CACHE = [
    '/',
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

// 1. Install Event - Simpan fail dalam cache baharu
self.addEventListener('install', (event) => {
    self.skipWaiting(); // Paksa Service Worker baharu mengambil alih serta-merta
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[Service Worker] Caching all new assets');
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

// 2. Activate Event - Padam cache lama
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => {
                    if (cache !== CACHE_NAME) {
                        console.log('[Service Worker] Deleting old cache:', cache);
                        return caches.delete(cache);
                    }
                })
            );
        }).then(() => self.clients.claim()) // Ambil kawalan ke atas semua tab serta-merta
    );
});

// 3. Fetch Event - Network-First untuk HTML/Navigasi, Cache-First untuk Asset Statik
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const isHTMLPage = event.request.mode === 'navigate' || 
                       event.request.headers.get('accept').includes('text/html');

    if (isHTMLPage) {
        // STRATEGI NETWORK-FIRST (Utamakan Server untuk HTML)
        event.respondWith(
            fetch(event.request).then((networkResponse) => {
                return caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, networkResponse.clone());
                    return networkResponse;
                });
            }).catch(() => {
                // Gunakan cache jika tiada sambungan internet (offline)
                return caches.match(event.request);
            })
        );
    } else {
        // STRATEGI CACHE-FIRST (Utamakan Cache untuk Gambar, CSS, JS)
        event.respondWith(
            caches.match(event.request).then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(event.request).then((networkResponse) => {
                    return networkResponse;
                });
            })
        );
    }
});