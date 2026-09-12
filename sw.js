// ══════════════════════════════════════════════════════════
// CRIMSON TIDE TRACKER — SERVICE WORKER
//
// This has to be a real file served over http(s). It used to be generated at
// runtime and registered from a blob: URL, which every browser rejects
// ("The URL protocol of the script is not supported"), so no service worker
// was ever installed: no offline mode, no cache, no update detection.
//
// The cache name is derived from the ?v= parameter the page appends when it
// registers, which comes from <meta name="app-version">. Bumping that single
// value changes this script's URL, which is what makes the browser treat it
// as a new worker and invalidate the old cache.
// ══════════════════════════════════════════════════════════

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE   = 'ctt-v' + VERSION;

// Everything the app needs to start with no network at all.
const PRECACHE = [
  './',
  './index.html',
  './cycle-core.js',
  './manifest.webmanifest',
  './icon-192.jpg',
  './icon-512.jpg',
  './icon-maskable-192.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png',
  './logo.png',
];

// No skipWaiting() here on purpose: a new worker stays in "waiting" so the
// page can offer the update and the user decides when to take it. Activating
// straight away would swap the worker under a running page and reload it
// mid-interaction — and would make the update toast unreachable dead code.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(PRECACHE))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: answer from cache at once, refresh in the background.
// Only same-origin GETs — everything this app loads is local.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener('message', e => {
  // Sent by the page when the user taps the update toast.
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

// ══════════════════════════════════════════════════════════
// WEB PUSH
//
// The relay sends an EMPTY push on purpose — a payload would be the one place
// cycle information could leak to the server. The wording lives here instead,
// written into a local cache by the page when it subscribes.
//
// PUSH_CACHE holds one entry:
//   { body, periodStart }   what to say, and which period it is about
// After showing the warning the worker records notifiedFor in the same entry,
// so the page does not announce the same period a second time on next open.
// ══════════════════════════════════════════════════════════
const PUSH_CACHE = 'ctt-push';
const PUSH_KEY = './__push-message';

async function readPushMessage() {
  try {
    const res = await (await caches.open(PUSH_CACHE)).match(PUSH_KEY);
    return res ? await res.json() : null;
  } catch (e) { return null; }
}

async function writePushMessage(data) {
  try {
    const cache = await caches.open(PUSH_CACHE);
    await cache.put(PUSH_KEY, new Response(JSON.stringify(data),
      { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {}
}

self.addEventListener('push', e => {
  e.waitUntil((async () => {
    const msg = await readPushMessage();
    // userVisibleOnly is a promise to the browser: always show something, even
    // if the local text went missing.
    const body = (msg && msg.body)
      || 'Deine Periode steht bevor. Öffne die App für Details.';

    await self.registration.showNotification('🏄\u200d♀️ Crimson Tide Tracker', {
      body,
      icon: './icon-192.jpg',
      badge: './icon-192.jpg',
      tag: 'period-warning',   // replaces an earlier warning instead of stacking
      renotify: false,
      requireInteraction: false,
    });

    if (msg && msg.periodStart) {
      await writePushMessage({ ...msg, notifiedFor: msg.periodStart });
    }
  })());
});

// Push services may rotate a subscription on their own. Tell the page so it can
// re-register with the relay; the old endpoint simply expires there.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clientList) c.postMessage({ type: 'PUSH_SUBSCRIPTION_CHANGED' });
  })());
});

// Focus an already open window instead of stacking up new ones.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wins => {
      for (const w of wins) {
        if ('focus' in w) return w.focus();
      }
      return clients.openWindow('./');
    })
  );
});
