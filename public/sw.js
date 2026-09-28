const CACHE = "fm-audio-v1";
const inflight = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (!isStoreAudio(event.request)) return;
  event.respondWith(serve(event));
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "retain-audio" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(retain(event.data.urls));
});

function isStoreAudio(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  return url.hostname.endsWith(".public.blob.vercel-storage.com") && url.pathname.startsWith("/freemusic/audio/");
}

async function serve(event) {
  const url = event.request.url;
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) return fulfill(hit, event.request);

  const pending = inflight.get(url);
  if (pending) {
    await pending;
    const stored = await cache.match(url);
    if (stored) return fulfill(stored, event.request);
    return fetch(url, { mode: "cors", credentials: "omit" });
  }

  const download = fetch(url, { mode: "cors", credentials: "omit" });
  const stored = download
    .then(async (response) => {
      if (response.ok && response.status === 200) await cache.put(url, response.clone());
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(url));
  inflight.set(url, stored);
  try {
    event.waitUntil(stored);
  } catch {
    /* the open page keeps this download alive */
  }

  const response = await download;
  if (!response.ok || response.status !== 200) return response;
  return fulfill(response, event.request);
}

async function fulfill(response, request) {
  const range = request.headers.get("range");
  const total = Number(response.headers.get("content-length")) || 0;
  if (!range || total <= 0) return response;
  const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!match) return response;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : total - 1;
  if (start <= 0) return partial(response, 0, total - 1, total);
  if (start >= total) {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${total}` },
    });
  }
  const blob = await response.blob();
  const slice = blob.slice(start, Math.min(end, total - 1) + 1);
  return partial(new Response(slice), start, start + slice.size - 1, total, slice.type || response.headers.get("content-type"));
}

function partial(response, start, end, total, type) {
  const headers = new Headers();
  headers.set("content-type", type || response.headers.get("content-type") || "audio/mpeg");
  headers.set("content-length", String(end - start + 1));
  headers.set("content-range", `bytes ${start}-${end}/${total}`);
  headers.set("accept-ranges", "bytes");
  return new Response(response.body, { status: 206, headers });
}

async function retain(urls) {
  const keep = new Set(urls);
  const cache = await caches.open(CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => !keep.has(request.url)).map((request) => cache.delete(request)));
}
