const CACHE = "fm-audio-v2";
const SHELL = "fm-shell-v2";
const DATA = "fm-data-v2";
const inflight = new Map();
const trackProgress = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.destination === "audio" || isStoreAudio(event.request)) { event.respondWith(serve(event)); return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api/admin/session" && event.request.method === "DELETE") {
    event.respondWith((async () => {
      await Promise.all([caches.delete(DATA), caches.delete(CACHE)]);
      return fetch(event.request);
    })());
    return;
  }
  if (event.request.method !== "GET") return;
  if (url.pathname === "/api/playlist" || url.pathname === "/api/admin/session") {
    event.respondWith((async () => {
      const cache = await caches.open(DATA);
      try {
        const response = await fetch(event.request);
        if (url.pathname.endsWith("session")) {
          const data = await response.clone().json();
          if (data.ok) await cache.put(event.request, new Response(JSON.stringify({ok:true,role:"store",offline:true, offlineUntil:Date.now()+30*24*60*60*1000}), {headers:{"content-type":"application/json"}}));
          else await cache.delete(event.request);
        } else if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        const cached = await cache.match(event.request);
        if (cached && url.pathname.endsWith("session")) {
          const grant = await cached.clone().json();
          if (grant.offlineUntil < Date.now()) return Response.json({ok:false});
        }
        return cached || Response.error();
      }
    })());
    return;
  }
  if (event.request.mode === "navigate" || url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.svg") {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const response = await fetch(event.request);
        if (response.ok) await cache.put(event.request, response.clone());
        return response;
      } catch {
        return await cache.match(event.request) || (event.request.mode === "navigate" ? await cache.match("/") : null) || Response.error();
      }
    })());
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "track-status" && typeof event.data.url === "string") {
    event.waitUntil((async () => {
      const url = event.data.url;
      const cached = await (await caches.open(CACHE)).match(url);
      event.source?.postMessage(cached
        ? {type:"track-download",url,loaded:Number(cached.headers.get("content-length")) || 0,total:Number(cached.headers.get("content-length")) || 0,state:"complete"}
        : trackProgress.get(url) || {type:"track-download",url,loaded:0,total:0,state:"pending"});
    })());
    return;
  }
  if (event.data?.type !== "retain-audio" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(downloadPlaylist(event.data.urls, event.source, event.data.pagePath));
});

let downloading = false;
async function downloadPlaylist(urls, client, pagePath = "/") {
  if (typeof pagePath !== "string" || (!pagePath.startsWith("/play/") && pagePath !== "/")) return;
  if (downloading) return;
  downloading = true;
  let done = 0;
  try {
    const shell = await caches.open(SHELL);
    const page = await shell.match(pagePath) || await fetch(pagePath, {signal:AbortSignal.timeout(15000)});
    if (!page.ok) throw new Error("Page unavailable");
    await shell.put(pagePath, page.clone());
    const html = await page.text();
    const assets = [...new Set([...html.matchAll(/(?:src|href)="([^" ]+)"/g)].map(m => m[1]).filter(u => u.startsWith("/_next/static/")))];
    for (const asset of assets) {
      if (!await shell.match(asset)) {
        const response = await fetch(asset, {signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error("App download failed");
        await shell.put(asset, response);
      }
      if (asset.endsWith(".css")) {
        const css = await (await shell.match(asset)).text();
        for (const match of css.matchAll(/url\(["']?([^\)"']+)["']?\)/g)) {
          const url = new URL(match[1], new URL(asset, self.location.origin));
          if (url.origin === self.location.origin && !await shell.match(url.href)) {
            const response = await fetch(url.href, {signal:AbortSignal.timeout(15000)});
            if (!response.ok) throw new Error("Font download failed");
            await shell.put(url.href, response);
          }
        }
      }
    }
    const cache = await caches.open(CACHE);
    for (const url of [...new Set(urls)]) {
      await cacheTrack(url);
      done++;
      client?.postMessage({type:"cache-progress",done,total:urls.length,ready:false});
    }
    // Preserve other playlists: multiple store tabs may share this cache.
    client?.postMessage({type:"cache-progress",done,total:urls.length,ready:true});
  } catch {
    client?.postMessage({type:"cache-progress",done,total:urls.length,ready:false,failed:true});
  } finally { downloading = false; }
}

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

  // Playback Range requests must never wait for the full offline download.
  // Let the origin serve the requested position immediately, while the cache
  // downloads a separate complete response in the background.
  event.waitUntil(cacheTrack(url).catch(() => undefined));
  return fetch(event.request);
}

async function reportTrack(url, loaded, total, state) {
  const message = {type:"track-download",url,loaded,total,state};
  trackProgress.set(url, message);
  const clients = await self.clients.matchAll({type:"window"});
  for (const client of clients) client.postMessage(message);
}

function cacheTrack(url) {
  if (inflight.has(url)) return inflight.get(url);
  const job = (async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const size = Number(hit.headers.get("content-length")) || 0;
      await reportTrack(url,size,size,"complete");
      return;
    }
    let loaded = 0;
    let total = 0;
    try {
      await reportTrack(url,0,0,"downloading");
      const response = await fetch(url, {mode:"cors",credentials:"omit",signal:AbortSignal.timeout(120000)});
      if (response.status !== 200 || !response.body) throw new Error("Download failed");
      total = Number(response.headers.get("content-length")) || 0;
      let lastReport = 0;
      const measured = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          controller.enqueue(chunk);
          if (Date.now() - lastReport >= 250) {
            lastReport = Date.now();
            void reportTrack(url,loaded,total,"downloading").catch(() => undefined);
          }
        }
      }));
      // Cache Storage only commits the entry when the entire stream succeeds.
      await cache.put(url,new Response(measured,{status:200,headers:response.headers}));
      await reportTrack(url,loaded,total || loaded,"complete");
    } catch (error) {
      await reportTrack(url,loaded,total,"failed");
      throw error;
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url,job);
  return job;
}

async function fulfill(response, request) {
  const range = request.headers.get("range");
  if (!range) return response;
  let total = Number(response.headers.get("content-length")) || 0;
  if (!total) {
    const bytes = await response.blob();
    total = bytes.size;
    response = new Response(bytes,{headers:response.headers});
  }
  if (!total) return response;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match || (!match[1] && !match[2])) return response;
  const start = match[1] ? Number(match[1]) : Math.max(0, total - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]),total - 1) : total - 1;
  if (start >= total || end < start) {
    return new Response(null, {status:416, headers:{"content-range":`bytes */${total}`}});
  }
  if (start === 0 && end === total - 1) return partial(response, 0, total - 1, total);
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
