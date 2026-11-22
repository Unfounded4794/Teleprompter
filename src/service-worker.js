const appCache = 'teleprompter-app-__VERSION__';
const modelCache = 'teleprompter-models-v2';
const assets = ["__ASSETS__"];
// The speech runtime is completed separately with model preparation.
const coreAssets = assets.filter(path => (path === '/runtime/manifest.json' || !path.startsWith('/runtime/')) && !path.startsWith('/assets/ort-wasm-'));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(appCache);
    try {
      for (let index = 0; index < coreAssets.length; index += 12) {
        await cache.addAll(coreAssets.slice(index, index + 12));
      }
    } catch (error) {
      await caches.delete(appCache);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const previous = keys.filter(key => key.startsWith('teleprompter-app-') && key !== appCache);
    await Promise.all(previous.slice(0, -1).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'offline-status') event.ports[0]?.postMessage({ version: appCache, coreAssets: coreAssets.length });
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!['GET', 'HEAD'].includes(event.request.method) || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname)) {
    event.respondWith(caches.open(appCache).then(async cache => (await cache.match('/index.html')) || fetch(event.request)));
    return;
  }
  if (url.pathname.startsWith('/models/') || (url.pathname.startsWith('/runtime/') && url.pathname !== '/runtime/manifest.json')) {
    event.respondWith(caches.open(modelCache).then(async cache => {
      const saved = await cache.match(event.request.url);
      return saved ? responseForMethod(saved, event.request.method) : fetch(event.request);
    }));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(event.request.url).then(saved => saved ? responseForMethod(saved, event.request.method) : fetch(event.request)));
    return;
  }
  if (coreAssets.includes(url.pathname)) {
    event.respondWith(caches.open(appCache).then(async cache => {
      const saved = await cache.match(url.pathname);
      return saved ? responseForMethod(saved, event.request.method) : fetch(event.request);
    }));
  }
});

function responseForMethod(response, method) {
  return method === 'HEAD' ? new Response(null, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  }) : response;
}
