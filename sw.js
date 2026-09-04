/* Bump this whenever the app changes. A new service worker only installs when
   this file's bytes change, and installing is what clears the old cache. */
const CACHE = 'plan-v5';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

/* The page itself is fetched network-first, so a re-published plan actually
   arrives instead of the cached copy being served forever. The cache is the
   fallback, and it wins after three seconds — with no signal, or on a bad
   connection, the app still opens instantly and offline. */
function pageResponse(req) {
  const net = fetch(req).then(res => {
    caches.open(CACHE).then(c => c.put('./index.html', res.clone())).catch(() => {});
    return res;
  });
  net.catch(() => {});                        // handled below; don't warn about it here
  return caches.match('./index.html', {ignoreSearch: true}).then(cached => {
    if (!cached) return net;                  // nothing to fall back to
    return Promise.race([
      net,
      new Promise((_, reject) => setTimeout(reject, 3000)),
    ]).catch(() => cached);
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  /* Anything off this origin is the sync Worker, and it must go straight to
     the network. The cache-first branch below would otherwise store the very
     first tracker blob it saw and serve that same stale copy on every later
     pull - sync would appear to work once and then quietly freeze. Its own
     failure path is just as wrong here: it answers a failed request with the
     cached index.html, which the decrypter would choke on. */
  try {
    if (new URL(e.request.url).origin !== self.location.origin) return;
  } catch (err) { return; }
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(pageResponse(e.request));
    return;
  }
  /* icons and the manifest never change: cache-first is right for them */
  e.respondWith(
    caches.match(e.request, {ignoreSearch:true}).then(hit =>
      hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
