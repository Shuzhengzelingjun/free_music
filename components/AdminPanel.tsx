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
  const [devHint, setDevHint] = useState(false);
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
    setDevHint(Boolean(data.devHint));
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
      body: JSON.stringify({ password }),
    });
    const data = await response.json();
    if (!response.ok) {
      setLoginError(data.error || "登录失败");
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
        throw new Error("登录已失效");
      }
      if (!response.ok) throw new Error(data.error || "操作失败");
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
        notify(`${file.name} 不是支持的音频`);
        continue;
      }
      if (file.size > 100 * 1024 * 1024) {
        notify(`${file.name} 超过 100MB`);
        continue;
      }
      const jobId = `${file.name}-${Date.now()}`;
      setJobs((current) => [...current, { id: jobId, name: file.name, progress: 0, status: "正在上传" }]);
      try {
        const parsed = parseTrackName(file.name);
        const manifest = library.storage === "blob"
          ? await uploadBlob(file, parsed, jobId)
          : await uploadLocal(file, parsed);
        setLibrary((current) => (current ? { ...current, manifest } : current));
        if (!uploadTo) {
          const created = manifest.playlists[manifest.playlists.length - 1];
          if (created) {
            setSelected(created.id);
            setUploadTo(created.id);
          }
        }
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, progress: 100, status: "已加入歌单" } : job)));
      } catch (error) {
        const message = error instanceof Error ? error.message : "上传失败";
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, status: message } : job)));
        notify(message);
      }
    }
  }

  async function uploadLocal(file: File, parsed: { title: string; artist: string }) {
    const form = new FormData();
    form.set("file", file);
    form.set("title", parsed.title);
    form.set("artist", parsed.artist);
    if (uploadTo) form.set("playlistId", uploadTo);
    const response = await fetch("/api/admin/upload", { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "上传失败");
    return data.manifest as Manifest;
  }

  async function uploadBlob(file: File, parsed: { title: string; artist: string }, jobId: string) {
    const extension = extensionOf(file.name);
    const pathname = `freemusic/audio/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
    const typed = new File([file], pathname.split("/").pop() || file.name, { type: contentTypeFor(extension) });
    const blob = await upload(pathname, typed, {
      access: "public",
      handleUploadUrl: "/api/upload",
      contentType: contentTypeFor(extension),
      multipart: file.size > 8 * 1024 * 1024,
      onUploadProgress: ({ percentage }) => {
        setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, progress: Math.round(percentage) } : job)));
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
    if (!response.ok) throw new Error(data.error || "歌曲已上传，但写入歌单失败");
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
    void audio.play().then(() => setPreviewId(song.id)).catch(() => notify("这段音频暂时播不了"));
  }

  if (authed === null) return <main className="booting">正在打开后台</main>;

  if (!authed) {
    return (
      <main className="login">
        <section className="login-card">
          <p className="eyebrow">{STORE_NAME}</p>
          <h1>后台</h1>
          <p>登录后可以上传歌曲、整理歌单，并指定门店正在播放的列表。</p>
          <form onSubmit={login}>
            <input
              className="field"
              type="password"
              value={password}
              autoComplete="current-password"
              placeholder="密码"
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="primary" type="submit">登录</button>
            <p className="error">{loginError}</p>
            {devHint ? <p className="quiet">本地默认密码是 admin。部署后请设置 ADMIN_PASSWORD。</p> : null}
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
          <p className="eyebrow">歌单管理</p>
          <h1>后台</h1>
        </div>
        <div className="admin-actions row">
          <span className="badge">{library?.storage === "blob" ? "云端存储" : "本机存储"}</span>
          <a className="ghost" href="/" target="_blank" rel="noreferrer">打开播放页</a>
          <button
            className="ghost"
            type="button"
            onClick={async () => {
              await fetch("/api/admin/session", { method: "DELETE" });
              setAuthed(false);
            }}
          >
            退出
          </button>
        </div>
      </header>

      {library && !library.persistent ? (
        <section className="callout">
          <strong>还不能在线上保存歌曲。</strong>
          <ol>
            <li>打开 Vercel 项目，进入 Storage，创建一个 Blob 存储并连接到这个项目。</li>
            <li>在 Settings → Environment Variables 设置 ADMIN_PASSWORD。</li>
            <li>重新部署。之后在这里上传的歌曲会一直保留，播放页可以循环播放。</li>
          </ol>
        </section>
      ) : null}

      {library?.persistent && library.storage === "local" ? (
        <p className="quiet" style={{ padding: "12px 28px 0" }}>
          当前歌曲保存在这台电脑，方便本地试听。部署到 Vercel 后请连接 Blob，歌曲会改存到云端。
        </p>
      ) : null}

      <div className="admin-shell">
        <aside className="sidebar">
          <div className="side-head">
            <h2>歌单</h2>
            <button className="text-btn" type="button" onClick={() => setSelected("library")}>曲库</button>
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
                <small>{item.songIds.length} 首</small>
              </span>
              {manifest?.activePlaylistId === item.id ? <em>播放中</em> : null}
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
                notify(error instanceof Error ? error.message : "创建失败");
              }
            }}
          >
            <input value={newName} placeholder="新歌单名称" onChange={(event) => setNewName(event.target.value)} />
            <button className="primary" type="submit" disabled={busy || !library?.persistent}>创建</button>
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
              <strong>上传歌曲</strong>
              <p>把 mp3、m4a、wav 拖到这里，或点击选择。可以一次传很多首。文件名写成「艺人 - 歌名」会自动填好。</p>
              <p className="quiet">请只上传你有权在门店播放的音乐。歌曲链接是公开的，拿到链接的人可以播放。</p>
              {manifest?.playlists.length ? (
                <label className="quiet">
                  上传到
                  <select className="field" value={uploadTo} onChange={(event) => setUploadTo(event.target.value)}>
                    {manifest.playlists.map((item) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="quiet">还没有歌单，上传后会自动创建「门店歌单」。</p>
              )}
              <button className="primary" type="button" onClick={() => fileRef.current?.click()}>选择文件</button>
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
                    <div key={job.id}>{job.name} · {job.status}{job.status === "正在上传" ? ` ${job.progress}%` : ""}</div>
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
                  aria-label="歌单名称"
                  onBlur={async (event) => {
                    const name = event.target.value.trim();
                    if (!name || name === playlist.name) return;
                    try {
                      await act({ action: "rename-playlist", id: playlist.id, name });
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "重命名失败");
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
                      notify("门店播放页会使用这个歌单");
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "设置失败");
                    }
                  }}
                >
                  {manifest?.activePlaylistId === playlist.id ? "门店正在播放" : "设为门店播放"}
                </button>
                <button
                  className="ghost"
                  type="button"
                  onClick={async () => {
                    const url = `${window.location.origin}/play/${playlist.id}`;
                    await navigator.clipboard.writeText(url);
                    notify("这个歌单的播放链接已复制");
                  }}
                >
                  复制链接
                </button>
                <button
                  className="danger"
                  type="button"
                  onClick={async () => {
                    if (!confirm(`删除歌单「${playlist.name}」？歌曲仍会留在曲库。`)) return;
                    try {
                      await act({ action: "delete-playlist", id: playlist.id });
                      setSelected("library");
                    } catch (error) {
                      notify(error instanceof Error ? error.message : "删除失败");
                    }
                  }}
                >
                  删除歌单
                </button>
              </div>
              {playlistSongs.length === 0 ? <p className="quiet">这个歌单还没有歌。</p> : null}
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
                      <button className="text-btn" type="button" disabled={index === 0} onClick={() => move(playlist, index, -1)}>上移</button>
                      <button className="text-btn" type="button" disabled={index === playlistSongs.length - 1} onClick={() => move(playlist, index, 1)}>下移</button>
                      <button
                        className="text-btn"
                        type="button"
                        onClick={async () => {
                          try {
                            await act({ action: "remove-from-playlist", playlistId: playlist.id, songId: song.id });
                          } catch (error) {
                            notify(error instanceof Error ? error.message : "移除失败");
                          }
                        }}
                      >
                        移出
                      </button>
                    </>
                  }
                />
              ))}
            </>
          ) : (
            <>
              <div className="panel-head">
                <h2>全部曲库</h2>
              </div>
              {librarySongs.length === 0 ? <p className="quiet">曲库是空的。</p> : null}
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
                            notify("已加入歌单");
                          } catch (error) {
                            notify(error instanceof Error ? error.message : "加入失败");
                          }
                        }}
                      >
                        <option value="">加入歌单</option>
                        {(manifest?.playlists || []).map((item) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <button
                        className="text-btn danger"
                        type="button"
                        onClick={async () => {
                          if (!confirm(`删除「${song.title}」和音频文件？`)) return;
                          try {
                            await act({ action: "delete-song", id: song.id });
                          } catch (error) {
                            notify(error instanceof Error ? error.message : "删除失败");
                          }
                        }}
                      >
                        删除
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
      notify(error instanceof Error ? error.message : "调整顺序失败");
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
          aria-label="歌名"
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            if (title.trim() && (title !== song.title || artist !== song.artist)) {
              void onSave(title.trim(), artist.trim()).catch(() => undefined);
            }
          }}
        />
        <input
          value={artist}
          aria-label="艺人"
          placeholder="艺人"
          onChange={(event) => setArtist(event.target.value)}
          onBlur={() => {
            if ((title !== song.title || artist !== song.artist) && title.trim()) {
              void onSave(title.trim(), artist.trim()).catch(() => undefined);
            }
          }}
        />
        <button className="ghost" type="button" onClick={onPreview}>{previewing ? "停止" : "试听"}</button>
      </div>
      <div className="row-actions">{extra}</div>
    </div>
  );
}
