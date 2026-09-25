import { del, list, put } from "@vercel/blob";
import { emptyManifest, normalizeManifest } from "@/lib/audio";
import type { Manifest } from "@/lib/types";

const MANIFEST_PREFIX = "freemusic/manifests/";

let queue: Promise<unknown> = Promise.resolve();

export function blobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export function persistentStorage() {
  return blobConfigured();
}

export function readManifest() {
  const run = queue.then(() => readFresh());
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function updateManifest(mutator: (manifest: Manifest) => void) {
  const run = queue.then(async () => {
    const current = await readFresh();
    const next = structuredClone(current);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    const normalized = normalizeManifest(next);
    await writeManifest(normalized);
    return normalized;
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function deleteAudio(url: string) {
  if (!url.includes(".blob.vercel-storage.com") || !blobConfigured()) return;
  await del(url).catch((error) => {
    console.error("delete blob failed", error);
  });
}

async function readFresh(): Promise<Manifest> {
  if (!blobConfigured()) return emptyManifest();
  return readBlobManifest();
}

async function writeManifest(manifest: Manifest) {
  if (!blobConfigured()) {
    throw new Error("Connect Vercel Blob storage first, or playlists will not be saved.");
  }
  await writeBlobManifest(manifest);
}

async function readBlobManifest(): Promise<Manifest> {
  const blobs = await listAll(MANIFEST_PREFIX);
  if (!blobs.length) return emptyManifest();
  blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
  const response = await fetchFresh(blobs[0].url);
  return normalizeManifest(await response.json());
}

async function writeBlobManifest(manifest: Manifest) {
  const pathname = `${MANIFEST_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await put(pathname, JSON.stringify(manifest), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  try {
    const blobs = await listAll(MANIFEST_PREFIX);
    blobs.sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime());
    const stale = blobs.slice(8);
    if (stale.length) await del(stale.map((blob) => blob.url));
  } catch (error) {
    console.error("manifest cleanup failed", error);
  }
}

async function listAll(prefix: string) {
  const blobs: Array<{ url: string; uploadedAt: Date; pathname: string }> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  return blobs;
}

async function fetchFresh(url: string) {
  let last: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store",
    });
    if (response.ok) return response;
    last = response;
    await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
  }
  throw new Error(`Couldn't read the playlist (${last?.status || "unknown"})`);
}
