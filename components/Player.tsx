"use client";

import { useEffect, useRef, useState } from "react";
import {
  STORE_NAME,
  buildOrder,
  formatClock,
  formatElapsed,
} from "@/lib/audio";
import type { PublicTrack } from "@/lib/types";

type Slot = "a" | "b";

export function Player({ playlistId }: { playlistId?: string }) {
  const aRef = useRef<HTMLAudioElement>(null);
  const bRef = useRef<HTMLAudioElement>(null);
  const activeSlot = useRef<Slot>("a");
  const songsRef = useRef<PublicTrack[]>([]);
  const orderRef = useRef<string[]>([]);
  const posRef = useRef(0);
  const shouldPlayRef = useRef(false);
  const shuffleRef = useRef(false);
  const startedRef = useRef(false);
  const volumeRef = useRef(0.85);
  const playToken = useRef(0);
  const moving = useRef(false);
  const failCount = useRef(0);
  const updatedAtRef = useRef("");
  const resumeRef = useRef<{ songId: string; time: number } | null>(null);
  const lastMedia = useRef(0);
  const skipVolumeSave = useRef(true);
  const runAnchor = useRef<number | null>(null);
  const accumulated = useRef(0);
  const storageKey = `fm-pos:${playlistId || "active"}`;

  const api = useRef({
    next: () => {},
    prev: () => {},
    toggle: () => {},
    playCurrent: (_preferIdle: boolean, _seekTo?: number) => {},
    armNext: () => {},
    onEnded: (_slot: Slot) => {},
    onError: (_slot: Slot) => {},
    onTime: (_slot: Slot) => {},
    onPlaying: (_slot: Slot) => {},
  });

  const [songs, setSongs] = useState<PublicTrack[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [pos, setPos] = useState(0);
  const [playlistName, setPlaylistName] = useState("");
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [volume, setVolume] = useState(0.85);
  const [issue, setIssue] = useState("");
  const [clock, setClock] = useState("--:--");
  const [elapsedLabel, setElapsedLabel] = useState("0 秒");
  const [resumeTitle, setResumeTitle] = useState<string | null>(null);

  function slotEl(slot: Slot) {
    return slot === "a" ? aRef.current : bRef.current;
  }

  function other(slot: Slot): Slot {
    return slot === "a" ? "b" : "a";
  }

  function commitOrder(nextOrder: string[], nextPos: number) {
    orderRef.current = nextOrder;
    posRef.current = nextPos;
    setOrder(nextOrder);
    setPos(nextPos);
  }

  function armNext() {
    const upcoming = orderRef.current[posRef.current + 1] || orderRef.current[0];
    const song = songsRef.current.find((item) => item.id === upcoming);
    const idle = slotEl(other(activeSlot.current));
    if (!song || !idle || orderRef.current.length < 2) return;
    if (idle.dataset.songId === song.id) return;
    idle.pause();
    idle.dataset.songId = song.id;
    idle.src = song.url;
    idle.preload = "auto";
  }

  function playCurrent(preferIdle: boolean, seekTo?: number) {
    const song = songsRef.current.find((item) => item.id === orderRef.current[posRef.current]);
    if (!song) return;
    let slot = activeSlot.current;
    const idleSlot = other(slot);
    const idle = slotEl(idleSlot);
    if (preferIdle && idle && idle.dataset.songId === song.id && idle.readyState >= 2) {
      slotEl(slot)?.pause();
      slot = idleSlot;
      activeSlot.current = slot;
    }
    const el = slotEl(slot);
    slotEl(other(slot))?.pause();
    if (!el) return;
    const token = ++playToken.current;
    const begin = () => {
      if (token !== playToken.current) return;
      if (seekTo != null && el.duration && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(Math.max(seekTo, 0), Math.max(0, el.duration - 0.25));
      }
      el.volume = volumeRef.current;
      armNext();
      if (!shouldPlayRef.current) return;
      void el.play().then(() => {
        if (token !== playToken.current) return;
        failCount.current = 0;
        setPlaying(true);
        setIssue("");
      }).catch(() => undefined);
    };
    if (el.dataset.songId !== song.id) {
      el.dataset.songId = song.id;
      el.src = song.url;
      el.addEventListener("loadedmetadata", begin, { once: true });
    } else if (el.readyState >= 1) {
      begin();
    } else {
      el.addEventListener("loadedmetadata", begin, { once: true });
    }
    document.title = `${song.title} · ${STORE_NAME}`;
  }

  function advance(delta: number) {
    if (moving.current || !orderRef.current.length) return;
    moving.current = true;
    try {
      if (delta > 0 && posRef.current >= orderRef.current.length - 1) {
        const lastId = orderRef.current[posRef.current];
        let rebuilt = buildOrder(songsRef.current, shuffleRef.current);
        if (shuffleRef.current && rebuilt.length > 1 && rebuilt[0] === lastId) {
          rebuilt = [...rebuilt.slice(1), rebuilt[0]];
        }
        commitOrder(rebuilt, 0);
      } else {
        const nextPos = (posRef.current + delta + orderRef.current.length) % orderRef.current.length;
        commitOrder(orderRef.current, nextPos);
      }
      playCurrent(delta > 0);
    } finally {
      moving.current = false;
    }
  }

  function prev() {
    const el = slotEl(activeSlot.current);
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      setProgress((current) => ({ ...current, current: 0 }));
      return;
    }
    advance(-1);
  }

  function setWantPlay(want: boolean) {
    shouldPlayRef.current = want;
    setPlaying(want);
    startedRef.current = true;
    setStarted(true);
    const el = slotEl(activeSlot.current);
    if (!want) {
      el?.pause();
      return;
    }
    if (!el?.dataset.songId) playCurrent(false);
    else void el.play().catch(() => undefined);
  }

  function start() {
    if (!songsRef.current.length) return;
    startedRef.current = true;
    setStarted(true);
    shouldPlayRef.current = true;
    setPlaying(true);
    const saved = resumeRef.current;
    const savedId = saved && songsRef.current.some((song) => song.id === saved.songId) ? saved.songId : undefined;
    const nextOrder = shuffleRef.current
      ? buildOrder(songsRef.current, true, savedId)
      : buildOrder(songsRef.current, false, savedId);
    commitOrder(nextOrder, 0);
    const seek = saved && savedId && saved.time > 1 ? saved.time : undefined;
    playCurrent(false, seek);
  }

  function playFromQueue(id: string) {
    const index = orderRef.current.indexOf(id);
    if (index < 0) return;
    startedRef.current = true;
    setStarted(true);
    shouldPlayRef.current = true;
    setPlaying(true);
    commitOrder(orderRef.current, index);
    playCurrent(false);
  }

  api.current.next = () => advance(1);
  api.current.prev = prev;
  api.current.toggle = () => setWantPlay(!shouldPlayRef.current);
  api.current.playCurrent = playCurrent;
  api.current.armNext = armNext;
  api.current.onEnded = (slot) => {
    if (slot !== activeSlot.current || !shouldPlayRef.current) return;
    advance(1);
  };
  api.current.onError = (slot) => {
    if (slot !== activeSlot.current) return;
    const el = slotEl(slot);
    if (!el?.dataset.songId || !startedRef.current) return;
    failCount.current += 1;
    if (failCount.current >= Math.max(songsRef.current.length, 1)) {
      shouldPlayRef.current = false;
      setPlaying(false);
      setIssue("这些歌曲暂时都无法播放");
      return;
    }
    setIssue("这首歌打不开，已跳到下一首");
    advance(1);
  };
  api.current.onTime = (slot) => {
    if (slot !== activeSlot.current) return;
    const el = slotEl(slot);
    if (!el) return;
    setProgress({
      current: el.currentTime || 0,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
    });
    const now = Date.now();
    if (el.duration > 0 && now - lastMedia.current > 1000 && "mediaSession" in navigator) {
      lastMedia.current = now;
      try {
        navigator.mediaSession.setPositionState({
          duration: el.duration,
          playbackRate: el.playbackRate || 1,
          position: Math.min(el.currentTime, el.duration),
        });
      } catch {
        /* ignore unsupported position state */
      }
    }
  };
  api.current.onPlaying = (slot) => {
    if (slot !== activeSlot.current) return;
    window.setTimeout(() => {
      const el = slotEl(slot);
      if (slot === activeSlot.current && el && !el.paused) failCount.current = 0;
    }, 800);
  };

  useEffect(() => {
    const rawVolume = localStorage.getItem("fm-volume");
    const rawShuffle = localStorage.getItem("fm-shuffle");
    if (rawVolume) {
      const next = Number(rawVolume);
      if (Number.isFinite(next) && next >= 0 && next <= 1) setVolume(next);
    }
    if (rawShuffle === "0" || rawShuffle === "1") {
      shuffleRef.current = rawShuffle === "1";
      setShuffle(rawShuffle === "1");
    }
  }, []);

  useEffect(() => {
    volumeRef.current = volume;
    if (aRef.current) aRef.current.volume = volume;
    if (bRef.current) bRef.current.volume = volume;
    if (skipVolumeSave.current) {
      skipVolumeSave.current = false;
      return;
    }
    localStorage.setItem("fm-volume", String(volume));
  }, [volume]);

  useEffect(() => {
    if (playing) {
      runAnchor.current = Date.now();
      return;
    }
    if (runAnchor.current) {
      accumulated.current += Date.now() - runAnchor.current;
      runAnchor.current = null;
    }
  }, [playing]);

  useEffect(() => {
    const tick = () => {
      const date = new Date();
      setClock(date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
      const extra = runAnchor.current ? Date.now() - runAnchor.current : 0;
      setElapsedLabel(formatElapsed((accumulated.current + extra) / 1000));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let stop = false;
    async function load(first: boolean) {
      try {
        const query = playlistId ? `?id=${encodeURIComponent(playlistId)}` : "";
        const response = await fetch(`/api/playlist${query}`, { cache: "no-store" });
        if (stop) return;
        if (response.status === 404) {
          setMissing(true);
          setLoading(false);
          return;
        }
        if (!response.ok) throw new Error("load failed");
        const data = await response.json();
        if (!first && data.updatedAt === updatedAtRef.current) return;
        updatedAtRef.current = data.updatedAt || "";
        const list = (data.songs || []) as PublicTrack[];
        const previousId = orderRef.current[posRef.current];
        songsRef.current = list;
        setSongs(list);
        setPlaylistName(data.playlist?.name || "");
        setMissing(Boolean(playlistId) && !data.playlist);
        setLoading(false);
        const ids = list.map((song) => song.id);
        const idSet = new Set(ids);
        if (!startedRef.current) {
          commitOrder(ids, 0);
          return;
        }
        if (previousId && !idSet.has(previousId)) {
          commitOrder(ids, 0);
          if (shouldPlayRef.current) api.current.playCurrent(false);
          return;
        }
        const nextOrder = orderRef.current.filter((id) => idSet.has(id));
        for (const id of ids) if (!nextOrder.includes(id)) nextOrder.push(id);
        commitOrder(nextOrder, previousId ? Math.max(0, nextOrder.indexOf(previousId)) : 0);
        api.current.armNext();
      } catch {
        if (first && !stop) {
          setIssue("歌单加载失败，正在重试");
          setLoading(false);
        }
      }
    }
    void load(true);
    const id = window.setInterval(() => void load(false), 20000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [playlistId]);

  useEffect(() => {
    if (startedRef.current) return;
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      setResumeTitle(null);
      return;
    }
    try {
      const saved = JSON.parse(raw) as { songId?: string; time?: number };
      if (!saved.songId) return;
      resumeRef.current = { songId: saved.songId, time: Number(saved.time) || 0 };
      setResumeTitle(songs.find((song) => song.id === saved.songId)?.title ?? null);
    } catch {
      setResumeTitle(null);
    }
  }, [songs, storageKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!startedRef.current) start();
        else api.current.toggle();
      } else if (event.code === "ArrowRight") api.current.next();
      else if (event.code === "ArrowLeft") api.current.prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let last = 0;
    let lastMove = Date.now();
    let wasPlaying = false;
    let seenSong = "";
    const id = window.setInterval(() => {
      const el = (activeSlot.current === "a" ? aRef : bRef).current;
      const songId = orderRef.current[posRef.current];
      if (startedRef.current && songId && el) {
        localStorage.setItem(storageKey, JSON.stringify({ songId, time: el.currentTime || 0 }));
      }
      if (!shouldPlayRef.current || !el) {
        wasPlaying = false;
        return;
      }
      if (!wasPlaying || songId !== seenSong) {
        wasPlaying = true;
        seenSong = songId || "";
        last = el.currentTime || 0;
        lastMove = Date.now();
        return;
      }
      if (el.currentTime > last + 0.05) {
        last = el.currentTime;
        lastMove = Date.now();
        return;
      }
      if (Date.now() - lastMove > 8000 && el.paused) {
        setIssue("播放卡住了，正在恢复");
        void el.play().catch(() => undefined);
      }
    }, 2000);
    const onVis = () => {
      if (document.visibilityState !== "visible" || !shouldPlayRef.current) return;
      const el = (activeSlot.current === "a" ? aRef : bRef).current;
      if (el && el.paused && !el.ended) void el.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [storageKey]);

  useEffect(() => {
    if (!playing) {
      document.body.classList.remove("player-idle");
      return;
    }
    let timer = 0;
    const move = () => {
      document.body.classList.remove("player-idle");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => document.body.classList.add("player-idle"), 3500);
    };
    move();
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      window.clearTimeout(timer);
      document.body.classList.remove("player-idle");
    };
  }, [playing]);

  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    async function acquire() {
      if (!playing || !("wakeLock" in navigator)) return;
      try {
        lock = await navigator.wakeLock.request("screen");
        if (cancelled) await lock.release();
      } catch {
        /* page hidden or unsupported */
      }
    }
    void acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release().catch(() => undefined);
    };
  }, [playing]);

  useEffect(() => {
    const song = songs.find((item) => item.id === order[pos]);
    if (!song || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist || STORE_NAME,
      album: playlistName || STORE_NAME,
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    const bind = (action: MediaSessionAction, fn: () => void) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* action unsupported */
      }
    };
    bind("play", () => setWantPlay(true));
    bind("pause", () => setWantPlay(false));
    bind("nexttrack", () => api.current.next());
    bind("previoustrack", () => api.current.prev());
  }, [songs, order, pos, playing, playlistName]);

  const current = songs.find((song) => song.id === order[pos]) || null;
  const queue: Array<PublicTrack & { lead: boolean }> = [];
  for (let step = 1; step < order.length && queue.length < 12; step += 1) {
    const song = songs.find((item) => item.id === order[(pos + step) % order.length]);
    if (song) queue.push({ ...song, lead: step === 1 });
  }
  const percent = progress.duration ? (progress.current / progress.duration) * 100 : 0;

  if (loading) return <main className="booting">正在准备歌单</main>;

  return (
    <main className="player" style={{ ["--glow" as string]: String(18 + (pos % 6) * 4) }}>
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">{playlistName || "等待歌单"}</p>
          <h1 className="brand">{STORE_NAME}</h1>
        </div>
        <div className="clock-block">
          <div className="clock">{clock}</div>
          <div className="elapsed">已播放 {elapsedLabel}</div>
        </div>
        <div className="live-pill">
          <span className={playing ? "dot on" : "dot"} />
          {playing ? "连续播放中" : started ? "已暂停" : "尚未开始"}
          <a className="admin-link" href="/admin">管理</a>
        </div>
      </header>
      <div className="rule" />
      <section className="stage">
        <div className="vinyl-wrap">
          <div className={playing ? "vinyl spin" : "vinyl"}>
            <div className="label" />
            <div className="hole" />
          </div>
        </div>
        <section className="now">
          <p className="kicker">正在播放 {songs.length ? `${Math.min(pos + 1, songs.length)} / ${songs.length}` : ""}</p>
          <h2 className="title">{current?.title || "还没有音乐"}</h2>
          <p className="artist">{current?.artist || (songs.length ? "未知艺人" : "去后台上传歌单后，这里会循环播放")}</p>
          <p className="issue" role="status">{issue}</p>
          <div className="timeline">
            <input
              type="range"
              min={0}
              max={progress.duration || 0}
              step={0.1}
              value={Math.min(progress.current, progress.duration || 0)}
              aria-label="播放进度"
              disabled={!current}
              style={{ background: `linear-gradient(90deg, var(--accent) ${percent}%, rgba(243,236,223,.18) ${percent}%)` }}
              onChange={(event) => {
                const el = slotEl(activeSlot.current);
                const next = Number(event.target.value);
                if (el) el.currentTime = next;
                setProgress((item) => ({ ...item, current: next }));
              }}
            />
            <div className="times">
              <span>{formatClock(progress.current)}</span>
              <span>{formatClock(progress.duration)}</span>
            </div>
          </div>
          <div className="controls">
            <button className="icon-btn" type="button" aria-label="上一首" onClick={prev} disabled={!songs.length}>
              <PrevIcon />
            </button>
            <button
              className="play-btn"
              type="button"
              aria-label={playing ? "暂停" : "播放"}
              disabled={!songs.length}
              onClick={() => (started ? setWantPlay(!playing) : start())}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon-btn" type="button" aria-label="下一首" onClick={() => advance(1)} disabled={!songs.length}>
              <NextIcon />
            </button>
          </div>
          <div className="tools">
            <button
              className={shuffle ? "pill on" : "pill"}
              type="button"
              onClick={() => {
                const next = !shuffleRef.current;
                shuffleRef.current = next;
                setShuffle(next);
                localStorage.setItem("fm-shuffle", next ? "1" : "0");
                const currentId = orderRef.current[posRef.current];
                const rebuilt = buildOrder(songsRef.current, next, currentId);
                commitOrder(rebuilt, 0);
                if (startedRef.current) armNext();
              }}
            >
              {shuffle ? "随机播放" : "顺序播放"}
            </button>
            <label className="vol">
              音量
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                aria-label="音量"
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <button
              className="pill"
              type="button"
              onClick={() => {
                if (!document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
                else void document.exitFullscreen();
              }}
            >
              全屏
            </button>
            <span className="hints">空格暂停 · 左右切歌</span>
          </div>
        </section>
        <aside className="queue">
          <h2>接下来</h2>
          {queue.length === 0 ? (
            <p className="quiet">{songs.length ? "只有这一首，会重复播放。" : "歌单是空的。"}</p>
          ) : (
            <ol>
              {queue.map((song) => (
                <li key={`${song.id}-${song.lead ? "next" : "later"}`}>
                  <button type="button" onClick={() => playFromQueue(song.id)}>
                    {song.lead ? <span className="q-next">下一首</span> : null}
                    <span className="q-title">{song.title}</span>
                    <span className="q-artist">{song.artist || "未知艺人"}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </section>
      {!started ? (
        <div className="gate">
          <div className="gate-card">
            <p className="eyebrow">{STORE_NAME}</p>
            <h2>{missing ? "找不到歌单" : playlistName || "准备播放"}</h2>
            {missing ? (
              <p>这个播放链接没有对应的歌单。</p>
            ) : songs.length ? (
              <p>
                共 {songs.length} 首，开始后会按歌单一直循环。请让这个页面保持打开，切到其他窗口也会继续播放，屏幕会尽量保持常亮。
                {resumeTitle ? ` 上次听到「${resumeTitle}」。` : ""}
              </p>
            ) : (
              <p>
                还没有歌曲。请先在<a href="/admin">后台</a>上传歌单。
              </p>
            )}
            <button className="big-play" type="button" onClick={start} disabled={!songs.length}>
              {resumeTitle ? "继续播放" : "开始播放"}
            </button>
          </div>
        </div>
      ) : null}
      <audio ref={aRef} preload="auto" playsInline onEnded={() => api.current.onEnded("a")} onError={() => api.current.onError("a")} onTimeUpdate={() => api.current.onTime("a")} onPlaying={() => api.current.onPlaying("a")} />
      <audio ref={bRef} preload="auto" playsInline onEnded={() => api.current.onEnded("b")} onError={() => api.current.onError("b")} onTimeUpdate={() => api.current.onTime("b")} onPlaying={() => api.current.onPlaying("b")} />
    </main>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph">
      <path fill="currentColor" d="M8 5.2v13.6L19 12 8 5.2z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph">
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </svg>
  );
}

function PrevIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph">
      <path fill="currentColor" d="M6 6h2v12H6zM18 6v12L9 12l9-6z" />
    </svg>
  );
}

function NextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph">
      <path fill="currentColor" d="M16 6h2v12h-2zM6 6l9 6-9 6V6z" />
    </svg>
  );
}
