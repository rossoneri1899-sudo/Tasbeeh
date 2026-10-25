// Offline support. App files are network-first (so updates show up when online) with a cache fallback.
// Fonts are cached as they load. Recordings are left to the browser: media players need range (206) responses.
// The same file serves the live app (site root) and the test channel (beta/), each with its own cache.
const CHANNEL = new URL(self.registration.scope).pathname.includes('/beta/') ? 'beta' : 'app';
const CACHE = 'tasbeeh-' + CHANNEL + '-4';
const CORE = ['./', './index.html', './app.js', './voice.js', './adhkar.js', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // drop this channel's old caches; the live app also removes the old app's cache and its 40 MB Whisper model
  const stale = k => k !== CACHE && (k.startsWith('tasbeeh-' + CHANNEL + '-') || CHANNEL === 'app' && (/^tasbeeh-v\d+$/.test(k) || k === 'transformers-cache'));
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(stale).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/\.mp3$/.test(url.pathname)) return;
  if (url.origin === location.origin) e.respondWith(networkFirst(req, url));
  else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(staleWhileRevalidate(req));
});
async function networkFirst(req, url) {
  const c = await caches.open(CACHE), key = url.origin + url.pathname; // ignore ?v= and ?check=
  try {
    // no-cache: always ask the server, so GitHub Pages' 10-minute browser cache can't serve an old file
    const r = await Promise.race([fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000))]);
    if (r.ok && !url.search.includes('check=')) c.put(key, r.clone());
    return r;
  } catch (err) {
    return (await c.match(key)) || (req.mode === 'navigate' && (await c.match(new URL('./', self.registration.scope).href) || await c.match(new URL('./index.html', self.registration.scope).href))) || Response.error();
  }
}
async function staleWhileRevalidate(req) {
  const c = await caches.open(CACHE), hit = await c.match(req);
  const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
  return hit || net;
}
