// Service worker : permet d'installer l'appli et de la rouvrir sans réseau.
// Stratégie « réseau d'abord » + revalidation systématique (cache: 'no-cache') :
// chaque fichier est revérifié auprès du serveur, donc une mise à jour publiée
// est prise en compte dès la réouverture de l'appli (le cache HTTP de 10 min
// de GitHub Pages est ignoré). Hors ligne, on sert la dernière copie.
const CACHE = 'caisse-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
