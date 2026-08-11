/// <reference lib="webworker" />

const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = "wardy-app-shell-v1";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest"];

worker.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  void worker.skipWaiting();
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
  )).then(() => worker.clients.claim()));
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== worker.location.origin) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.match("/index.html");
      if (shell) return shell;
    }
    return new Response("Wardy is offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
