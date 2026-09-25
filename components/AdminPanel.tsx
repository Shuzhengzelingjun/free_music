"use client";

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  STORE_NAME,
  contentTypeFor,
  extensionOf,
  isAudioFilename,
  parseTrackName,
} from "@/lib/audio";
import type { LibraryResponse, Manifest, Playlist, Song } from "@/lib/types";

type Job = { id: string; name: string; progress: number; status: string };

export function AdminPanel() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [selected, setSelected] = useState<string>("library");
  const [uploadTo, setUploadTo] = useState("");
  const [newName, setNewName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const previewRef = useRef<HTMLAudioElement>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const picked = useRef(false);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? "" : current)), 2800);
  }

  async function loadSession() {
    const response = await fetch("/api/admin/session", { cache: "no-store" });
    const data = await response.json();
    setAuthed(Boolean(data.ok));
    if (data.ok) await loadLibrary();
  }

  async function loadLibrary() {
    const response = await fetch("/api/admin/library", { cache: "no-store" });
    if (response.status === 401) {
      setAuthed(false);
      return;
    }
    const data = (await response.json()) as LibraryResponse;
    applyLibrary(data);
  }

  function applyLibrary(data: LibraryResponse) {
    setLibrary(data);
    if (picked.current) return;
    picked.current = true;
    const initial = data.manifest.activePlaylistId || data.manifest.playlists[0]?.id || "library";
    setSelected(initial);
    setUploadTo(data.manifest.activePlaylistId || data.manifest.playlists[0]?.id || "");
  }

  useEffect(() => {
    void loadSession();
  }, []);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setLoginError("");
    const response = await fetch("/api/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      setLoginError(data.error || "Couldn't log in");
      return;
    }
    setAuthed(true);
    await loadLibrary();
  }

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/library", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (response.status === 401) {
        setAuthed(false);
        throw new Error("Session expired");
      }
      if (!response.ok) throw new Error(data.error || "Something went wrong");
      setLibrary((current) => (current ? { ...current, manifest: data.manifest as Manifest } : current));
      return data.manifest as Manifest;
    } finally {
      setBusy(false);
    }
  }

  async function onFiles(list: FileList | File[]) {
    if (!library?.persistent) return;
    const files = Array.from(list);
    for (const file of files) {
      if (!isAudioFilename(file.name)) {
        notify(`${file.name} is not a supported audio file`);
        continue;
      }
      if (file.size > 200 * 1024 * 1024) {
        notify(`${file.name} is over 200MB`);
        continue;
      }
      const jobId = `${file.name}-${Date.now()}`;
      setJobs((current) => [...current, { id: jobId, name: file.name, progress: 0, status: "Uploading" }]);
      try {
        const parsed = parseTrackName(file.name);
        const manifest = library.storage === "blob"
          ? await uploadBlob(file, parsed, jobId)
          : await uploadLocal(file, parsed, jobId);
        setLibrary((current) => (current ? { ...current, manifest } : current));
        if (!uploadTo) {
          const created = manifest.playlists[manifest.playlists.length - 1];
          if (created) {
            setSelected(created.id);
            setUploadTo(created.id);
          }
        }
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, progress: 100, status: "Added" } : job)));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, status: message } : job)));
        notify(message);
      }
    }
  }

  function uploadLocal(file: File, parsed: { title: string; artist: string }, jobId: string) {
    const form = new FormData();
    form.set("file", file);
    form.set("title", parsed.title);
    form.set("artist", parsed.artist);
    if (uploadTo) form.set("playlistId", uploadTo);
    return new Promise<Manifest>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/upload");
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        const progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, progress } : job)));
      };
      xhr.onload = () => {
        let data: { error?: string; manifest?: Manifest } = {};
        try {
          data = JSON.parse(xhr.responseText) as { error?: string; manifest?: Manifest };
        } catch {
          reject(new Error("Upload failed"));
          return;
        }
        if (xhr.status < 200 || xhr.status >= 300 || !data.manifest) {
          reject(new Error(data.error || "Upload failed"));
          return;
        }
        resolve(data.manifest);
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(form);
    });
  }

  async function uploadBlob(file: File, parsed: { title: string; artist: string }, jobId: string) {
    const extension = extensionOf(file.name);
    const pathname = `freemusic/audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const blob = await upload(pathname, file, {
      access: "public",
      handleUploadUrl: "/api/upload",
      contentType: contentTypeFor(extension),
      multipart: file.size > 8 * 1024 * 1024,
      onUploadProgress: ({ loaded, total, percentage }) => {
        const next = Number.isFinite(percentage) && percentage > 0
          ? percentage
          : total > 0
            ? (loaded / total) * 100
            : 0;
        const progress = Math.min(99, Math.round(next));
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, progress } : job)));
      },
    });
    const response = await fetch("/api/admin/library", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "add-song",
        title: parsed.title,
        artist: parsed.artist,
        url: blob.url,
        playlistId: uploadTo || undefined,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The file uploaded, but it could not be added to the playlist");
    return data.manifest as Manifest;
  }

  function preview(song: Song) {
    const audio = previewRef.current;
    if (!audio) return;
    if (previewId === song.id) {
      audio.pause();
      setPreviewId(null);
      return;
    }
    audio.src = song.url;
    void audio.play().then(() => setPreviewId(song.id)).catch(() => notify("This audio can't be played right now"));
  }

  if (authed === null) return <main className="booting">Opening manage</main>;

  if (!authed) {
    return (
      <main className="login">
        <section className="login-card">
          <p className="eyebrow">{STORE_NAME}</p>
          <h1>Manage</h1>
          <p>Log in to upload tracks, edit playlists, and choose what the store is playing.</p>
          <form onSubmit={login}>
            <input
              className="field"
              value={username}
              autoComplete="username"
              placeholder="Username"
              onChange={(event) => setUsername(event.target.value)}
            />
            <input
              className="field"
              type="password"
              value={password}
              autoComplete="current-password"
              placeholder="Password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="primary" type="submit">Log in</button>
            <p className="error">{loginError}</p>
          </form>
        </section>
      </main>
    );
  }

  const manifest = library?.manifest;
  const playlist = manifest?.playlists.find((item) => item.id === selected) || null;
  const playlistSongs = playlist
    ? playlist.songIds
        .map((id) => manifest?.songs.find((song) => song.id === id))
        .filter((song): song is Song => Boolean(song))
    : [];
  const librarySongs = [...(manifest?.songs || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <main className="admin">
      <header className="admin-top">
        <div>
          <p className="eyebrow">Playlists</p>
          <h1>Manage</h1>
        </div>
        <div className="admin-actions row">
          <span className="badge">{library?.storage === "blob" ? "Cloud storage" : "Local storage"}</span>
          <a className="ghost" href="/" target="_blank" rel="noreferrer">Open player</a>
          <button
            className="ghost"
            type="button"
            onClick={async () => {
              await fetch("/api/admin/session", { method: "DELETE" });
              setAuthed(false);
            }}
          >
            Log out
          </button>
        </div>
      </header>

      {library && !library.persistent ? (
        <section className="callout">
          <strong>Songs can't be saved online yet.</strong>
          <ol>
            <li>In the Vercel project, open Storage, create a Blob store, and connect it to this project.</li>
            <li>Redeploy. Uploaded tracks will stay, and the player can loop them.</li>
          </ol>
        </section>
      ) : null}

      {library?.persistent && library.storage === "local" ? (
        <p className="quiet" style={{ padding: "12px 28px 0" }}>
          Tracks are saved on this computer for local preview. Connect Blob when you deploy to Vercel so they are stored in the cloud.
        </p>
      ) : null}

      <div className="admin-shell">
        <aside className="sidebar">
          <div className="side-head">
            <h2>Playlists</h2>
            <button className="text-btn" type="button" onClick={() => setSelected("library")}>Library</button>
          </div>
          {(manifest?.playlists || []).map((item) => (
            <button
              key={item.id}
              className={selected === item.id ? "pl-item on" : "pl-item"}
              type="button"
              onClick={() => {
                setSelected(item.id);
                setUploadTo(item.id);
              }}
            >
              <span>
                <strong>{item.name}</strong>
                <small>{item.songIds.length} tracks</small>
              </span>
              {manifest?.activePlaylistId === item.id ? <em>Live</em> : null}
            </button>
          ))}
          <form
            className="create-row"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!newName.trim()) return;
              try {
                const before = new Set((manifest?.playlists || []).map((item) => item.id));
                const next = await act({ action: "create-playlist", name: newName.trim() });
                const created = next.playlists.find((item) => !before.has(item.id));
                if (created) {
                  setSelected(created.id);
                  setUploadTo(created.id);
                }
                setNewName("");
              } catch (error) {
                notify(error instanceof Error ? error.message : "Couldn't create the playlist");
              }
            }}
          >
            <input value={newName} placeholder="New playlist name" onChange={(event) => setNewName(event.target.value)} />
            <button className="primary" type="submit" disabled={busy || !library?.persistent}>Create</button>
          </form>
        </aside>

        <section className="panel">
          {library?.persistent ? (
            <div
              className={dragOver ? "upload drag" : "upload"}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragOver(false);
                void onFiles(event.dataTransfer.files);
              }}
            >
              <strong>Upload tracks</strong>
              <p>Drop mp3, m4a, or wav files here, or click to choose. You can upload many at once. Name a file “Artist - Title” and those fields fill in automatically.</p>
              <p className="quiet">Only upload music you have the right to play in the store. Track links are public, so anyone with the link can play them.</p>
              {manifest?.playlists.length ? (
                <label className="quiet">
                  Upload to
                  <select className="field" value={uploadTo} onChange={(event) => setUploadTo(event.target.value)}>
                    {manifest.playlists.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="quiet">There is no playlist yet. The first upload creates “Store playlist”.</p>
              )}
              <button className="primary" type="button" onClick={() => fileRef.current?.click()}>Choose files</button>
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm"
                multiple
                onChange={(event) => {
                  if (event.target.files) void onFiles(event.target.files);
                  event.target.value = "";
                }}
              />
              {jobs.length ? (
                <div className="jobs">
                  {jobs.slice(-4).map((job) => (
                    <div className="job" key={job.id}>
                      <div>{job.name} · {job.status}{job.status === "Uploading" ? ` ${job.progress}%` : ""}</div>
                      {job.status === "Uploading" ? (
                        <div className="job-bar" aria-hidden="true"><span style={{ width: `${job.progress}%` }} /></div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {playlist ? (
            <>
              <div className="panel-head row">
                <input
                  className="field"
                  defaultValue={playlist.name}
                  key={playlist.id + playlist.name}
                  aria-label="Playlist name"
                  onBlur={async (event) => {
                    const name = event.target.value.trim();
                    if (!name || name === playlist.name) return;
                    try {
                      await act({ action: "rename-playlist", id: playlist.id, name });
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "Couldn't rename the playlist");
                    }
                  }}
                />
                <button
                  className="primary"
                  type="button"
                  disabled={busy || manifest?.activePlaylistId === playlist.id}
                  onClick={async () => {
                    try {
                      await act({ action: "set-active", id: playlist.id });
                      notify("The store player will use this playlist");
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "Couldn't set the live playlist");
                    }
                  }}
                >
                  {manifest?.activePlaylistId === playlist.id ? "Now playing in store" : "Set as store playlist"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    const url = `${window.location.origin}/play/${playlist.id}`;
                    await navigator.clipboard.writeText(url);
                    notify("Playlist link copied");
                  }}
                >
                  Copy link
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={async () => {
                    if (!confirm(`Delete playlist “${playlist.name}”? Tracks stay in the library.`)) return;
                    try {
                      await act({ action: "delete-playlist", id: playlist.id });
                      setSelected("library");
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "Couldn't delete");
                    }
                  }}
                >
                  Delete playlist
                </button>
              </div>
              {playlistSongs.length === 0 ? <p className="quiet">This playlist has no tracks yet.</p> : null}
              {playlistSongs.map((song, index) => (
                <SongRow
                  key={song.id}
                  song={song}
                  index={index + 1}
                  onPreview={() => preview(song)}
                  previewing={previewId === song.id}
                  onSave={async (title, artist) => {
                    const next = await act({ action: "update-song", id: song.id, title, artist });
                    setLibrary((current) => (current ? { ...current, manifest: next } : current));
                  }}
                  extra={
                    <>
                      <button className="text-btn" type="button" disabled={index === 0} onClick={() => move(playlist, index, -1)}>Up</button>
                      <button className="text-btn" type="button" disabled={index === playlistSongs.length - 1} onClick={() => move(playlist, index, 1)}>Down</button>
                      <button
                        className="text-btn"
                        type="button"
                        onClick={async () => {
                          try {
                            await act({ action: "remove-from-playlist", playlistId: playlist.id, songId: song.id });
                          } catch (error) {
                            notify(error instanceof Error ? error.message : "Couldn't remove the track");
                          }
                        }}
                      >
                        Remove
                      </button>
                    </>
                  }
                />
              ))}
            </>
          ) : (
            <>
              <div className="panel-head">
                <h2>All tracks</h2>
              </div>
              {librarySongs.length === 0 ? <p className="quiet">The library is empty.</p> : null}
              {librarySongs.map((song, index) => (
                <SongRow
                  key={song.id}
                  song={song}
                  index={index + 1}
                  onPreview={() => preview(song)}
                  previewing={previewId === song.id}
                  onSave={async (title, artist) => {
                    await act({ action: "update-song", id: song.id, title, artist });
                  }}
                  extra={
                    <>
                      <select
                        className="field lib-add"
                        defaultValue=""
                        onChange={async (event) => {
                          const playlistId = event.target.value;
                          event.target.value = "";
                          if (!playlistId) return;
                          try {
                            await act({ action: "add-to-playlist", playlistId, songId: song.id });
                            notify("Added to playlist");
                          } catch (error) {
                            notify(error instanceof Error ? error.message : "Couldn't add the track");
                          }
                        }}
                      >
                        <option value="">Add to playlist</option>
                        {(manifest?.playlists || []).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <button
                        className="text-btn danger"
                        type="button"
                        onClick={async () => {
                          if (!confirm(`Delete “${song.title}” and the audio file?`)) return;
                          try {
                            await act({ action: "delete-song", id: song.id });
                          } catch (error) {
                            notify(error instanceof Error ? error.message : "Couldn't delete");
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  }
                />
              ))}
            </>
          )}
        </section>
      </div>
      <audio
        ref={previewRef}
        onEnded={() => setPreviewId(null)}
        onPause={() => {
          if (previewRef.current && previewRef.current.currentTime > 0 && !previewRef.current.ended) return;
        }}
      />
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </main>
  );

  async function move(target: Playlist, index: number, direction: number) {
    const ids = [...target.songIds];
    const next = index + direction;
    if (next < 0 || next >= ids.length) return;
    const current = ids[index];
    ids[index] = ids[next];
    ids[next] = current;
    try {
      await act({ action: "reorder", playlistId: target.id, songIds: ids });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Couldn't reorder");
    }
  }
}

function SongRow({
  song,
  index,
  onPreview,
  previewing,
  onSave,
  extra,
}: {
  song: Song;
  index: number;
  onPreview: () => void;
  previewing: boolean;
  onSave: (title: string, artist: string) => Promise<void>;
  extra: React.ReactNode;
}) {
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist);
  useEffect(() => {
    setTitle(song.title);
    setArtist(song.artist);
  }, [song.title, song.artist]);

  return (
    <div className="song-row">
      <span className="index-no">{index}</span>
      <div className="song-main">
        <input
          value={title}
          aria-label="Title"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title.trim() && (title !== song.title || artist !== song.artist)) {
              void onSave(title.trim(), artist.trim()).catch(() => undefined);
            }
          }}
        />
        <input
          value={artist}
          aria-label="Artist"
          placeholder="Artist"
          onChange={(event) => setArtist(event.target.value)}
          onBlur={() => {
            if ((title !== song.title || artist !== song.artist) && title.trim()) {
              void onSave(title.trim(), artist.trim()).catch(() => undefined);
            }
          }}
        />
        <button className="ghost" type="button" onClick={onPreview}>{previewing ? "Stop" : "Preview"}</button>
      </div>
      <div className="row-actions">{extra}</div>
    </div>
  );
}
