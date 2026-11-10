// 掌心 C · Service Worker：预缓存全部静态资源，断网也能用
const VERSION = 'cstudio-v1.0.0';
const PRECACHE = [
  './',
  'index.html',
  'styles/app.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/editor.js',
  'js/highlight.js',
  'js/store.js',
  'engine/worker.js',
  'engine/session.js',
  'engine/cengine.js',
  'engine/core.js',
  'engine/lexer.js',
  'engine/preproc.js',
  'engine/parser.js',
  'engine/interp.js',
  'engine/builtins.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 逐个添加：单个资源失败不要让整个安装失败
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (e) {
        /* 离线首次访问时忽略 */
      }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：网络优先，断网回落缓存
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(VERSION);
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // 静态资源：缓存优先，同时后台更新
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return hit || (await network) || new Response('离线且没有缓存', { status: 504 });
  })());
});
