/* サービスワーカー：オフラインでもアプリを開けるようにし、電波が戻ったら自動送信する */
importScripts('shared.js');

const CACHE = 'kidsfam-receipt-v1';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'crop.js', 'shared.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // GAS への通信はそのまま
  // 新しい版があれば取りに行き、オフラインならキャッシュを使う
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
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
