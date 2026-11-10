/**
 * sw.js — MoneyFlow offline shell.
 *
 * Strategy: **versioned precache, cache first**. The build (tools/build-shell-manifest.ps1)
 * writes the shell version and the full file list into the deployed copy of this file.
 * Why cache first: on a weak network a network-first fetch does not fail, it hangs, and the
 * app stayed on the splash screen until the browser gave up. The shell now starts from the
 * cache instantly, whatever the network.
 * Why versioned: file names carry no content hash, so per-file caching could mix old and new
 * modules after a deploy. A new version is downloaded as a whole set into its own cache and
 * switched on at once; any change of a shell file changes this file, so the browser notices it.
 *
 * Source (unbuilt) copy: SHELL_FILES is empty → the worker does not intercept requests, so local
 * development always gets fresh files from disk.
 *
 * What is not cached: POST requests to Apps Script (another domain anyway), everything external.
 */

// Both lines are replaced by tools/build-shell-manifest.ps1; keep them exactly as they are.
const SHELL_VERSION = "dev";
const SHELL_FILES = [];

const CACHE_PREFIX = "moneyflow-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${SHELL_VERSION}`;
const IS_PRECACHE_BUILD = SHELL_FILES.length > 0;
const NAVIGATION_FALLBACK = "index.html";

self.addEventListener("install", (event) => {
  if (!IS_PRECACHE_BUILD) {
    event.waitUntil(self.skipWaiting());
    return;
  }

  // No skipWaiting here: the open page keeps its version until the user accepts the update
  // (message SKIP_WAITING), so modules of two versions never meet in one page.
  event.waitUntil(precacheShell());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  if (!IS_PRECACHE_BUILD) return;

  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The worker's script itself is never served from cache: otherwise a new version would never arrive.
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(cacheFirst(request, url));
});

/**
 * Downloads the whole shell into this version's cache.
 * `cache: "reload"` bypasses the HTTP cache: a CDN copy of an older file must not be stored
 * under the new version. `addAll` is atomic — one failed file fails the install, and the
 * previous version keeps serving until the next update check.
 *
 * @returns {Promise<void>}
 */
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const requests = SHELL_FILES.map(
    (path) => new Request(new URL(path, self.registration.scope), { cache: "reload" }),
  );
  await cache.addAll(requests);
}

/**
 * Cache first, network only for what the shell does not contain.
 *
 * @param {Request} request
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function cacheFirst(request, url) {
  const cache = await caches.open(CACHE_NAME);

  // ignoreSearch: a query (tracker, start_url variant) does not make it a different shell file.
  let cached = await cache.match(request, { ignoreSearch: true });

  // The app is opened as "./" as often as "./index.html"; both are the same page.
  if (!cached && request.mode === "navigate" && isShellPageUrl(url)) {
    cached = await cache.match(new URL(NAVIGATION_FALLBACK, self.registration.scope));
  }

  if (cached) return cached;

  // The browser may evict the cache under storage pressure; then the network is the only source.
  try {
    return await fetch(request);
  } catch (error) {
    return new Response("Offline, and this file is not in the offline shell.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/**
 * @param {URL} url
 * @returns {boolean} whether the URL addresses the app page itself (scope root or index.html)
 */
function isShellPageUrl(url) {
  const scopePath = new URL(self.registration.scope).pathname;
  return url.pathname === scopePath || url.pathname === `${scopePath}${NAVIGATION_FALLBACK}`;
}
