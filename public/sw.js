/**
 * Husk app-shell service worker.
 *
 * Policy (deliberately minimal — this app holds no persisted state and every
 * room lives in SSR'd, per-request HTML):
 *
 * - PRECACHE: static, content-stable shell assets (manifest, icons, font,
 *   favicon, robots). Served cache-first so an installed PWA renders offline.
 * - "/" navigations: network-first; a successful visit keeps a fresh copy for
 *   the offline fallback. The landing SSR shell carries no secrets.
 * - /assets/*: immutable content-hashed bundles, cache-first with fill-on-miss.
 * - Everything else — including every /r/<pin> navigation and anything under
 *   /room/ or /api/ — is network-only. The Worker relay (a separate origin in
 *   production) is never intercepted: only same-origin GETs are even
 *   considered below, and cross-origin requests pass straight through.
 *
 * Bump CACHE_VERSION to invalidate every cache after a shell-asset change.
 */
const CACHE_VERSION = "v2";
const SHELL_CACHE = `husk-shell-${CACHE_VERSION}`;
const BUNDLE_CACHE = `husk-bundles-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/robots.txt",
  "/icons/husk-mark.svg",
  "/icons/husk-icon-192.png",
  "/icons/husk-icon-512.png",
  "/icons/husk-maskable-192.png",
  "/icons/husk-maskable-512.png",
  "/fonts/inter-latin.woff2",
];

const PRECACHE_SET = new Set(PRECACHE_URLS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== BUNDLE_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  // Worker relay API, WebSockets and file chunks are cross-origin in
  // production and are never touched. Room navigations are per-request SSR
  // state and are never cached either.
  if (url.origin !== self.location.origin) {
    return;
  }
  if (url.pathname.startsWith("/room/") || url.pathname.startsWith("/api/")) {
    return;
  }
  if (request.mode === "navigate") {
    if (url.pathname !== "/") {
      return;
    }
    event.respondWith(serveHomeShell(request));
    return;
  }
  if (PRECACHE_SET.has(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, BUNDLE_CACHE));
  }
  // Anything else: network only — no respondWith, so the browser handles it.
});

async function serveHomeShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("/", response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match("/");
    if (cached !== undefined) {
      return cached;
    }
    throw error;
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}
