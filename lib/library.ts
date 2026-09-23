import { isSafeAudioUrl } from "@/lib/audio";
import { HttpError } from "@/lib/http";
import { deleteAudio, readManifest, updateManifest } from "@/lib/manifest";
import type { Manifest } from "@/lib/types";

export async function applyAction(body: Record<string, unknown>): Promise<Manifest> {
  switch (body.action) {
    case "create-playlist":
      return createPlaylist(text(body.name, 80));
    case "rename-playlist":
      return renamePlaylist(text(body.id, 80), text(body.name, 80));
    case "delete-playlist":
      return deletePlaylist(text(body.id, 80));
    case "set-active":
      return setActive(text(body.id, 80));
    case "add-song":
      return addSong({
        title: text(body.title, 200),
        artist: text(body.artist, 200),
        url: typeof body.url === "string" ? body.url : "",
        playlistId: optionalId(body.playlistId),
      });
    case "update-song":
      return updateSong(text(body.id, 80), text(body.title, 200), text(body.artist, 200));
    case "delete-song":
      return deleteSong(text(body.id, 80));
    case "remove-from-playlist":
      return removeFromPlaylist(text(body.playlistId, 80), text(body.songId, 80));
    case "add-to-playlist":
      return addToPlaylist(text(body.playlistId, 80), text(body.songId, 80));
    case "reorder":
      return reorder(text(body.playlistId, 80), body.songIds);
    default:
      throw new HttpError("未知操作");
  }
}

export function addSong(input: { title: string; artist: string; url: string; playlistId?: string | null }) {
  const title = input.title.trim();
  const artist = input.artist.trim();
  if (!title) throw new HttpError("请填写歌名");
  if (!isSafeAudioUrl(input.url)) throw new HttpError("音频地址无效");
  return updateManifest((manifest) => {
    let song = manifest.songs.find((item) => item.url === input.url);
    if (!song) {
      song = {
        id: crypto.randomUUID(),
        title: title.slice(0, 200),
        artist: artist.slice(0, 200),
        url: input.url,
        createdAt: new Date().toISOString(),
      };
      manifest.songs.push(song);
    } else {
      song.title = title.slice(0, 200);
      song.artist = artist.slice(0, 200);
    }
    const songId = song.id;
    let playlistId = input.playlistId || "";
    if (!playlistId) {
      if (manifest.playlists.length === 0) {
        const playlist = {
          id: crypto.randomUUID(),
          name: "门店歌单",
          songIds: [] as string[],
          createdAt: new Date().toISOString(),
        };
        manifest.playlists.push(playlist);
        manifest.activePlaylistId = playlist.id;
        playlistId = playlist.id;
      } else {
        playlistId = manifest.activePlaylistId || manifest.playlists[0].id;
      }
    }
    const playlist = manifest.playlists.find((item) => item.id === playlistId);
    if (!playlist) throw new HttpError("找不到歌单");
    if (!playlist.songIds.includes(songId)) playlist.songIds.push(songId);
  });
}

async function createPlaylist(name: string) {
  if (!name) throw new HttpError("请填写歌单名称");
  return updateManifest((manifest) => {
    const playlist = {
      id: crypto.randomUUID(),
      name,
      songIds: [] as string[],
      createdAt: new Date().toISOString(),
    };
    manifest.playlists.push(playlist);
    if (!manifest.activePlaylistId) manifest.activePlaylistId = playlist.id;
  });
}

async function renamePlaylist(id: string, name: string) {
  if (!name) throw new HttpError("请填写歌单名称");
  return updateManifest((manifest) => {
    const playlist = requirePlaylist(manifest, id);
    playlist.name = name;
  });
}

async function deletePlaylist(id: string) {
  return updateManifest((manifest) => {
    manifest.playlists = manifest.playlists.filter((playlist) => playlist.id !== id);
    if (manifest.activePlaylistId === id) {
      manifest.activePlaylistId = manifest.playlists[0]?.id ?? null;
    }
  });
}

async function setActive(id: string) {
  return updateManifest((manifest) => {
    requirePlaylist(manifest, id);
    manifest.activePlaylistId = id;
  });
}

async function updateSong(id: string, title: string, artist: string) {
  if (!title) throw new HttpError("歌名不能为空");
  return updateManifest((manifest) => {
    const song = manifest.songs.find((item) => item.id === id);
    if (!song) throw new HttpError("找不到歌曲");
    song.title = title;
    song.artist = artist;
  });
}

async function deleteSong(id: string) {
  const existing = (await readManifest()).songs.find((song) => song.id === id);
  if (!existing) throw new HttpError("找不到歌曲");
  const manifest = await updateManifest((current) => {
    current.songs = current.songs.filter((song) => song.id !== id);
    for (const playlist of current.playlists) {
      playlist.songIds = playlist.songIds.filter((songId) => songId !== id);
    }
  });
  await deleteAudio(existing.url);
  return manifest;
}

async function removeFromPlaylist(playlistId: string, songId: string) {
  return updateManifest((manifest) => {
    const playlist = requirePlaylist(manifest, playlistId);
    playlist.songIds = playlist.songIds.filter((id) => id !== songId);
  });
}

async function addToPlaylist(playlistId: string, songId: string) {
  return updateManifest((manifest) => {
    const playlist = requirePlaylist(manifest, playlistId);
    if (!manifest.songs.some((song) => song.id === songId)) throw new HttpError("找不到歌曲");
    if (!playlist.songIds.includes(songId)) playlist.songIds.push(songId);
  });
}

async function reorder(playlistId: string, songIds: unknown) {
  if (!Array.isArray(songIds) || songIds.some((id) => typeof id !== "string")) {
    throw new HttpError("顺序无效");
  }
  const ids = songIds as string[];
  return updateManifest((manifest) => {
    const playlist = requirePlaylist(manifest, playlistId);
    const allowed = new Set(playlist.songIds);
    if (ids.length !== playlist.songIds.length || ids.some((id) => !allowed.has(id))) {
      throw new HttpError("顺序无效");
    }
    playlist.songIds = [...ids];
  });
}

function requirePlaylist(manifest: Manifest, id: string) {
  const playlist = manifest.playlists.find((item) => item.id === id);
  if (!playlist) throw new HttpError("找不到歌单");
  return playlist;
}

function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function optionalId(value: unknown) {
  const id = text(value, 80);
  return id || null;
}
