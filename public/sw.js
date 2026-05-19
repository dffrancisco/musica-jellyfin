const CACHE_VERSION = "v8";
const CACHE_NAME = `zima-dlp-${CACHE_VERSION}`;

const PRECACHE = ["/", "/index.html", "/icon.png", "/manifest.webmanifest"];

function isApiRequest(url) {
    return (
        url.pathname === "/download" ||
        url.pathname.startsWith("/progress/") ||
        url.pathname.startsWith("/cancel/") ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/progress/")
    );
}

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (isApiRequest(url)) return;

    const wantsHtml =
        request.mode === "navigate" ||
        (request.headers.get("accept") || "").includes("text/html");

    if (wantsHtml) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() =>
                    caches.match(request).then((cached) => cached || caches.match("/index.html"))
                )
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request).then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            });
            return cached || network;
        })
    );
});
