const CACHE_NAME = "javi-supabase-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=20260208",
  "./app.js?v=20260208",
  "./config.js?v=20260208",
  "./manifest.webmanifest",
  "./icons/icon.svg"
];

const NETWORK_FIRST = new Set([
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./sw.js",
  "./config.js"
]);

function normalizeAssetPath(url){
  try{
    const u = new URL(url);
    const p = u.pathname || "/";
    if(p.endsWith("/")) return "./";
    return `.${p}`;
  }catch(_){
    return "";
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const method = (req.method || "GET").toUpperCase();
  if(method !== "GET") return;

  const assetPath = normalizeAssetPath(req.url);

  event.respondWith((async () => {
    if(NETWORK_FIRST.has(assetPath)){
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      }catch(_){
        const fallback = await caches.match(req);
        if(fallback) return fallback;
        return caches.match("./index.html");
      }
    }

    const cached = await caches.match(req);
    if(cached) return cached;
    try {
      const net = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, net.clone());
      return net;
    } catch (_e) {
      return caches.match("./index.html");
    }
  })());
});
