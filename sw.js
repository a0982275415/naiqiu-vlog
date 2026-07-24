/* 奶球 Vlog — 離線快取（app 殼層） */
const CACHE = 'naiqiu-vlog-v61';
const ASSETS = [
  './',
  'index.html',
  'css/style.css?v=61',
  'js/db.js?v=61',
  'js/encode.js?v=61',
  'js/encode2.js?v=61',
  'vendor/mp4box.all.min.js',
  'vendor/mp4-muxer.min.js',
  'js/app.js?v=61',
  'manifest.webmanifest',
  'fonts/Cubic_11.woff2',
  
  
  'assets/sprite-baby-alpha.png',
  'assets/corner-flowers-r.png',
  'assets/s-flower.png',
  'assets/rec-btn.png',
  'assets/tape-p.png',
  'assets/s-camera.png',
  'assets/s-book.png',
  'assets/t-camera.png',
  'assets/t-today.png',
  'assets/t-diary.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  /* 頁面本體「先連網、連不到才用快取」。
     以前是一律先吃快取 → 新版上線了也永遠看不到（要關開好幾次才碰運氣），
     這是更新一直送不到手機上的真正原因。 */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('./')))
    );
    return;
  }

  /* 其他資源都帶版本號（?v=），網址一換就等於新檔案，可以放心先吃快取 */
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }))
  );
});
