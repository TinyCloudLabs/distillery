// Distillery feed service worker — hand-rolled, four rules:
//   1. /api/* and /media/*  → network-first, cache fallback (last-loaded feed
//      and its media keep working offline).
//   2. navigations          → network-first, fallback to the cached shell.
//   3. /assets/* GET        → cache-first (vite assets are content-hashed and
//      immutable; new builds get new URLs, so stale entries are harmless).
//   4. other same-origin GET (manifest, icons) → stale-while-revalidate, so
//      icon/manifest edits propagate to installed clients on the next load
//      without needing a VERSION bump.
// Bump VERSION on SW changes to drop old caches on activate.

const VERSION = "folio-3";
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = `runtime-${VERSION}`;

const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    // Cache only complete OK responses — partial (206 Range) responses for
    // audio seeking are not cacheable and would poison playback.
    if (response.ok && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

// Serve from cache immediately (shell precache or runtime), refresh the
// runtime copy in the background. event.waitUntil keeps the SW alive for the
// refresh after the cached response has been returned.
async function staleWhileRevalidate(event, request) {
  const cached = await caches.match(request);
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok && response.status === 200) {
        const cache = await caches.open(RUNTIME_CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(refresh);
    return cached;
  }
  const response = await refresh;
  if (response) return response;
  return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put("/", response.clone());
    }
    return response;
  } catch {
    const shell = await caches.match("/");
    if (shell) return shell;
    return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
    // Range requests (audio seeks) go straight to the network — the server
    // answers 206 and the cache can't.
    if (request.headers.has("range")) return;
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Only content-hashed vite output is safe to serve cache-first forever.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Unhashed statics (manifest, icons) — stale-while-revalidate so changes
  // reach installed clients without a VERSION bump.
  event.respondWith(staleWhileRevalidate(event, request));
});
