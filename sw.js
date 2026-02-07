// Temporary no-op service worker that self-unregisters.
// This is used to flush stale cached app bundles that caused old behavior to persist.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try{
      const keys = await caches.keys();
      await Promise.all(keys.map((k)=>caches.delete(k)));
    }catch(_){ }
    try{ await self.registration.unregister(); }catch(_){ }
    try{ await self.clients.claim(); }catch(_){ }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for(const c of clients){
      try{ c.navigate(c.url); }catch(_){ }
    }
  })());
});
