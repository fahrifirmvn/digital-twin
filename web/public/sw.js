// Service worker Driver PWA / Operator View: halaman dan manifest network-first (fallback cache), aset cache-first.
const CACHE = 'lactos-field-v1';
const PAGES = ['/driver', '/operator', '/field/manifest'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;

    // Keluar dari akun: buang salinan halaman/data supaya perangkat bersama tidak membocorkan data pengguna lain.
    if (req.method === 'POST' && url.pathname === '/logout') {
        e.waitUntil(caches.delete(CACHE));
        return;
    }
    if (req.method !== 'GET') return;

    if (PAGES.includes(url.pathname)) {
        e.respondWith(networkFirst(req));
    } else if (url.pathname.startsWith('/build/assets/') || url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest') {
        e.respondWith(cacheFirst(req));
    }
});

async function networkFirst(req) {
    const cache = await caches.open(CACHE);
    try {
        const res = await fetch(req);
        // Jangan simpan redirect ke /login atau galat.
        if (res.ok && !res.redirected) await cache.put(req, res.clone());
        return res;
    } catch {
        return (await cache.match(req)) ?? new Response('Luring dan belum ada data tersimpan.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
}

async function cacheFirst(req) {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
}
