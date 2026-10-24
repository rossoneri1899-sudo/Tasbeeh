// Offline support. The page is network-first (so updates show up when online) and falls back to the cache offline.
// CDN scripts and the speech engine's wasm are versioned URLs, so they are cache-first.
// Whisper's model files are cached by transformers.js itself ("transformers-cache"), so they are left alone here.
const CACHE='tasbeeh-v1';
const CORE=['./','./index.html','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png',
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all(CORE.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('tasbeeh-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin)e.respondWith(networkFirst(req,url));
  else if(url.hostname==='cdn.jsdelivr.net')e.respondWith(cacheFirst(req));
});
async function networkFirst(req,url){
  const c=await caches.open(CACHE),key=url.origin+url.pathname; // ignore ?v=N
  try{
    // don't leave the user staring at a blank screen on a weak connection
    const r=await Promise.race([fetch(req),new Promise((_,rej)=>setTimeout(()=>rej(new Error('slow')),4000))]);
    if(r.ok)c.put(key,r.clone());
    return r;
  }catch(err){
    return (await c.match(key))||(req.mode==='navigate'&&((await c.match(url.origin+url.pathname.replace(/[^/]*$/,'')))||(await c.match('./index.html'))))||Response.error();
  }
}
async function cacheFirst(req){
  const c=await caches.open(CACHE),hit=await c.match(req,{ignoreVary:true});
  if(hit)return hit;
  const r=await fetch(req);
  if(r.ok||r.type==='opaque')c.put(req,r.clone());
  return r;
}
