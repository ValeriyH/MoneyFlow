/**
 * sw.js — MoneyFlow offline shell.
 *
 * Role is narrow and deliberate: **network first, cache fallback**. That is, if a network is available, we give what arrived and simultaneously update the cache; without a network, we give the last known.
 * Why not "cache first"? There is no build system in the project, so file names do not have a content hash, and "cache first" would mean that a fix takes a week to reach the family until someone manually deletes the app. Network first kills this entire class of problems at the cost of one request, and the app is already waiting for the network for the snapshot.
 *
 * What is not cached: POST requests to Apps Script (which go to another domain anyway), everything external, and uncacheable responses.
 *
 */

const CACHE_NAME = "moneyflow-shell-v1";

self.addEventListener("install", (event) => {
  // Do not pre-transfer the shell: it will load on the first opening anyway. The file list in the code is a list that is often forgotten to update, and without it, the cache automatically collects everything that is actually needed.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The worker's script itself is not from cache: otherwise, a new version of sw.js would never reach the browser.
  if (url.pathname.endsWith("/sw.js")) return;

  event.respondWith(networkFirst(request));
});

/**
 * Network first, cache fallback.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });

  try {
    const response = await fetch(request);

    // A failed HTTP response is the same as a break for offline_ : 502 from a proxy, a 'portal caught' page, CDN failure. fetch does not throw here but returns 5xx - and without this check, the user would see an error page instead of their budget.
    if (!response.ok) {
      if (cached) return cached;
      return response;
    }

    if (response.type === "basic") {
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    // ignoreSearch: a query might be present in the request that is not in the cache (version check, redirect from a tracker). This is the same file, so the mark after "?" doesn't matter for offline.
    if (cached) return cached;

    // Offline, and this file is not yet in the cache - first opening without a network. We say this directly because a blank page would look like a broken app.
    return new Response("Offline, and this page is not yet in the cache.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
