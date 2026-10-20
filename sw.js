const CACHE_NAME = 'corngrid-static-v6';
const OFFLINE_PAGE = '/offline.html';
const NETWORK_FIRST_ASSETS = new Set([
  '/style.css',
  '/login.js',
  '/dashboard.css',
  '/dashboard.js',
  '/market.js',
  '/feed.js',
  '/admin.css',
  '/admin.js',
  '/public-portfolios.js',
  '/public-portfolio.js',
  '/reset-password.js'
]);

const CORE_ASSETS = [
  '/manifest.webmanifest',
  '/offline.html',
  '/pwa.css',
  '/pwa.js',
  '/favicon.ico',
  '/images/pwa-192.png',
  '/images/pwa-512.png',
  '/style.css',
  '/login.js',
  '/dashboard.css',
  '/dashboard.js',
  '/market.js',
  '/feed.js',
  '/vendor/lightweight-charts.standalone.production.js',
  '/admin.css',
  '/admin.js',
  '/public-portfolios.js',
  '/public-portfolio.js',
  '/reset-password.js'
];

const STATIC_ASSETS = new Set([
  ...CORE_ASSETS,
  '/mystyle.css',
  '/script.js',
  '/images/Corngrid%20logo%204k.jpg',
  '/images/bg-algo-specs.jpg',
  '/images/bg-faq.jpg',
  '/images/bg-features.jpg',
  '/images/bg-support.jpg',
  '/images/bg-testimonial.jpg',
  '/images/bg-testimonial%20(2).jpg',
  '/images/background2.jpg',
  '/images/hero-image.png',
  '/images/1.jpg',
  '/images/2.jpg',
  '/images/3.jpg',
  '/images/gmail.svg',
  '/images/hfmarket.png',
  '/images/Hfmarket.svg',
  '/images/Litefinance.svg',
  '/images/myfxbook.png',
  '/images/Roboforex.svg',
  '/images/telegram.svg',
  '/images/tiktok.svg',
  '/images/whatsapp.svg'
]);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CORE_ASSETS.map(url => new Request(url, { cache: 'reload' })))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(cacheNames
        .filter(name => name.startsWith('corngrid-cache-') || (name.startsWith('corngrid-static-') && name !== CACHE_NAME))
        .map(name => caches.delete(name)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const offlinePage = await caches.match(OFFLINE_PAGE);
        return offlinePage || Response.error();
      })
    );
    return;
  }

  if (!STATIC_ASSETS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(url.pathname);

    if (!NETWORK_FIRST_ASSETS.has(url.pathname) && cachedResponse) return cachedResponse;

    try {
      const response = await fetch(request);
      if (response.ok && response.type === 'basic') {
        await cache.put(url.pathname, response.clone());
      }
      return response;
    } catch (error) {
      if (cachedResponse) return cachedResponse;
      throw error;
    }
  })());
});
