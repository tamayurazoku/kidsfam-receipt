/* サービスワーカー：オフラインでもアプリを開けるようにし、電波が戻ったら自動送信する */
importScripts('shared.js');

const CACHE = 'kidsfam-receipt-v5';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'crop.js', 'shared.js', 'icons.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // GAS への通信はそのまま
  // すぐにキャッシュから表示し（起動が速い）、裏で最新版を取りに行く
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const cached = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request, { cache: 'no-cache' }).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }
    return (await fresh) || (await c.match('index.html')) || Response.error();
  }));
});

async function notifyClients() {
  const list = await self.clients.matchAll({ includeUncontrolled: true });
  list.forEach((c) => c.postMessage({ type: 'queue-updated' }));
}

self.addEventListener('sync', (e) => {
  if (e.tag !== 'kf-upload') return;
  e.waitUntil(self.KF.processQueue().then(async (s) => {
    await notifyClients();
    if (s.offline) throw new Error('offline'); // 失敗扱いにしてブラウザに再試行してもらう
  }));
});
