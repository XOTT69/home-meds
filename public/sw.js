// The registration scope is `/home-meds/` on GitHub Pages and `/` in a local
// preview. Resolving cache keys against it keeps the worker portable.
const CACHE_PREFIX = 'home-meds-cache-';
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const SCOPE_URL = self.registration.scope;
const APP_SHELL_URL = new URL('./', SCOPE_URL).href;
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const APP_SHELL_ASSETS = [
  APP_SHELL_URL,
  INDEX_URL,
  new URL('manifest.webmanifest', SCOPE_URL).href,
  new URL('favicon.svg', SCOPE_URL).href,
];

function isSameOriginAppRequest(url) {
  const scope = new URL(SCOPE_URL);
  return url.origin === scope.origin && url.pathname.startsWith(scope.pathname);
}

async function cacheResponse(request, response) {
  if (!response.ok) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME)
      .map((cacheName) => caches.delete(cacheName)));
    await self.clients.claim();
  })());
});

async function respondToNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const requestUrl = new URL(request.url);
      // Refresh the application shell on each normal navigation. Do not cache
      // arbitrary SPA routes, because GitHub Pages returns a 404 for them.
      if (requestUrl.href === APP_SHELL_URL || requestUrl.href === INDEX_URL) {
        await cacheResponse(request, response);
      }
      return response;
    }
  } catch {
    // The cached shell below is the intended offline route.
  }

  return (await caches.match(APP_SHELL_URL))
    || (await caches.match(INDEX_URL))
    || new Response('Home Meds is unavailable offline.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
}

async function respondToAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    await cacheResponse(request, response);
    return response;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (!isSameOriginAppRequest(requestUrl)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(respondToNavigation(event.request));
    return;
  }

  event.respondWith(respondToAsset(event.request));
});

function notificationTarget(data) {
  if (!data || typeof data.url !== 'string') return APP_SHELL_URL;
  try {
    const url = new URL(data.url, SCOPE_URL);
    return isSameOriginAppRequest(url) ? url.href : APP_SHELL_URL;
  } catch {
    return APP_SHELL_URL;
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = notificationTarget(event.notification.data);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => {
      try {
        return isSameOriginAppRequest(new URL(client.url));
      } catch {
        return false;
      }
    });

    if (existing) {
      if (existing.url !== target && 'navigate' in existing) {
        try {
          await existing.navigate(target);
        } catch {
          // Focusing an existing app window is still preferable to failing.
        }
      }
      return existing.focus();
    }

    return self.clients.openWindow(target);
  })());
});
