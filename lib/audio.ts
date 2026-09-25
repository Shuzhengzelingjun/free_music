import type { Manifest, Playlist, PublicPlaylistResponse, Song } from "@/lib/types";

export const STORE_NAME = process.env.NEXT_PUBLIC_STORE_NAME || "Store Music";

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4"];

const CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".webm": "audio/webm",
};

export function extensionOf(filename: string) {
  const match = filename.toLowerCase().match(/\.[a-z0-9]+$/);
  return match ? match[0] : "";
}

export function isAudioFilename(filename: string) {
  return AUDIO_EXTENSIONS.includes(extensionOf(filename));
}

export function contentTypeFor(extension: string) {
  return CONTENT_TYPES[extension] || "application/octet-stream";
}

export function parseTrackName(filename: string) {
  const base = filename.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ").trim();
  const parts = base.split(/\s+-\s+/);
  if (parts.length >= 2) {
    return {
      artist: cleanLabel(parts[0]),
      title: cleanLabel(parts.slice(1).join(" - ")) || "Untitled",
    };
  }
  return { artist: "", title: cleanLabel(base) || "Untitled" };
}

function cleanLabel(value: string) {
  return value.replace(/^\d{1,3}\s*[.\-_]\s*/, "").trim();
}

export function isSafeAudioUrl(url: string) {
  if (url.startsWith("/uploads/")) {
    return /^[a-zA-Z0-9._-]+$/.test(url.slice("/uploads/".length));
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function formatClock(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const seconds = Math.floor(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  const padded = remain.toString().padStart(2, "0");
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${padded}`;
  return `${minutes}:${padded}`;
}

export function formatElapsed(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} sec`;
}

export function buildOrder(list: Array<{ id: string }>, shuffle: boolean, firstId?: string) {
  const ids = list.map((item) => item.id);
  if (!shuffle) {
    if (firstId && ids.includes(firstId)) {
      const index = ids.indexOf(firstId);
      return [...ids.slice(index), ...ids.slice(0, index)];
    }
    return ids;
  }
  const rest = shuffleIds(ids.filter((id) => id !== firstId));
  return firstId && ids.includes(firstId) ? [firstId, ...rest] : rest;
}

function shuffleIds(ids: string[]) {
  const next = [...ids];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const current = next[index];
    next[index] = next[swap];
    next[swap] = current;
  }
  return next;
}

export function emptyManifest(): Manifest {
  return {
    songs: [],
    playlists: [],
    activePlaylistId: null,
    updatedAt: new Date().toISOString(),
  };
}

export function normalizeManifest(input: unknown): Manifest {
  const raw = input && typeof input === "object" ? (input as Partial<Manifest>) : {};
  const songs = (Array.isArray(raw.songs) ? raw.songs : [])
    .map((item) => normalizeSong(item))
    .filter((item): item is Song => Boolean(item));
  const songIds = new Set(songs.map((song) => song.id));
  const playlists = (Array.isArray(raw.playlists) ? raw.playlists : [])
    .map((item) => normalizePlaylist(item, songIds))
    .filter((item): item is Playlist => Boolean(item));
  const active = playlists.some((playlist) => playlist.id === raw.activePlaylistId)
    ? (raw.activePlaylistId as string)
    : null;
  return {
    songs,
    playlists,
    activePlaylistId: active,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function normalizeSong(input: unknown): Song | null {
  if (!input || typeof input !== "object") return null;
  const song = input as Partial<Song>;
  if (!song.id || !song.title || !song.url || !isSafeAudioUrl(song.url)) return null;
  return {
    id: song.id.slice(0, 80),
    title: song.title.trim().slice(0, 200),
    artist: typeof song.artist === "string" ? song.artist.trim().slice(0, 200) : "",
    url: song.url,
    createdAt: typeof song.createdAt === "string" ? song.createdAt : new Date().toISOString(),
  };
}

function normalizePlaylist(input: unknown, songIds: Set<string>): Playlist | null {
  if (!input || typeof input !== "object") return null;
  const playlist = input as Partial<Playlist>;
  if (!playlist.id || !playlist.name || !Array.isArray(playlist.songIds)) return null;
  return {
    id: playlist.id.slice(0, 80),
    name: playlist.name.trim().slice(0, 80),
    songIds: [...new Set(playlist.songIds.filter((id) => typeof id === "string" && songIds.has(id)))],
    createdAt: typeof playlist.createdAt === "string" ? playlist.createdAt : new Date().toISOString(),
  };
}

export function toPublicPlaylist(manifest: Manifest, playlistId?: string | null): PublicPlaylistResponse | null {
  const playlist = playlistId
    ? manifest.playlists.find((item) => item.id === playlistId) || null
    : manifest.playlists.find((item) => item.id === manifest.activePlaylistId) || null;
  if (playlistId && !playlist) return null;
  const songs = (playlist?.songIds || [])
    .map((id) => manifest.songs.find((song) => song.id === id))
    .filter((song): song is Song => Boolean(song))
    .map((song) => ({
      id: song.id,
      title: song.title,
      artist: song.artist,
      url: song.url,
    }));
  return {
    playlist: playlist ? { id: playlist.id, name: playlist.name } : null,
    songs,
    updatedAt: manifest.updatedAt,
  };
}
