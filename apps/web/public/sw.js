/*
 * Marginalia service worker.
 *
 * Exists to make the app installable and to survive a dropped connection
 * with the shell intact rather than the browser's offline page. It is
 * deliberately narrow: it only answers requests it explicitly matches, so
 * anything unanticipated (/mcp, WebSocket upgrades, future endpoints)
 * reaches the network untouched.
 *
 * Document content is never cached. Everything under /api is authorized
 * per-request and changes as collaborators edit, so a cached copy would be
 * both stale and a way to read a document after access was revoked.
 */

/**
 * Bump to discard every cache. Not needed for a normal deploy — navigations
 * are network-first, so a new build's hashed asset URLs miss the cache and
 * come from the network. Superseded entries are left behind until then.
 */
const VERSION = 'v1';
const SHELL_CACHE = `marginalia-shell-${VERSION}`;
const ASSET_CACHE = `marginalia-assets-${VERSION}`;
const CURRENT_CACHES = new Set([SHELL_CACHE, ASSET_CACHE]);

/** Every route renders the same SPA entry, so one cached copy serves all. */
const SHELL_URL = '/';

/** Root-level files that are stable but not content-hashed. */
const STATIC_PATHS = new Set([
  '/manifest.webmanifest',
  '/favicon.ico',
  '/icon.svg',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
});

/**
 * Caches the SPA entry plus the bundles it boots from. The HTML alone is
 * not enough — offline it would render an empty #root, which looks exactly
 * like a crash. Route-level chunks are left to runtime caching; they are
 * only reachable once the app is running anyway.
 *
 * Workers have no DOMParser, hence the regex over our own build output.
 */
async function precacheShell() {
  const response = await fetch(SHELL_URL, { cache: 'reload' });
  if (!response.ok) throw new Error(`Cannot precache shell: ${response.status}`);

  const html = await response.clone().text();
  const shell = await caches.open(SHELL_CACHE);
  await shell.put(SHELL_URL, response);

  const bootAssets = new Set();
  for (const [, href] of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
    if (href.startsWith('/assets/')) bootAssets.add(href);
  }
  if (bootAssets.size > 0) {
    const assets = await caches.open(ASSET_CACHE);
    await assets.addAll([...bootAssets]);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('marginalia-') && !CURRENT_CACHES.has(name))
          .map((name) => caches.delete(name)),
      );
      // Take over tabs opened before this worker existed, so the first
      // visit is offline-capable without a second reload.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // Range requests want a real byte-range response; a cache hit would be wrong.
  if (request.headers.has('range')) return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request));
    return;
  }
  // Vite content-hashes these filenames, so a hit is always the right bytes.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }
  if (STATIC_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request, ASSET_CACHE));
  }
});

async function networkFirstShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(event, request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok) await cache.put(request, response.clone());
    return response;
  });

  if (!cached) return update;
  // Serve the cached copy now; refreshing it must not reject into the page.
  event.waitUntil(update.catch(() => undefined));
  return cached;
}
