// Minimal service worker — enables the Android/Chrome install prompt and a
// tiny offline shell. Data layers are intentionally network-only: stale risk
// data is worse than no data.
const SHELL_CACHE = "ff-shell-v1";
const SHELL_ASSETS = ["/", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only same-origin navigations fall back to the cached shell when offline.
  if (event.request.mode === "navigate" && url.origin === self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
  }
});
