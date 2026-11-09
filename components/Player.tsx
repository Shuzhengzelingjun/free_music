"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  STORE_NAME,
  buildOrder,
  formatClock,
  formatElapsed,
} from "@/lib/audio";
import { prepareDeviceAudio, retainDeviceAudio } from "@/lib/audioCache";
import type { PublicTrack } from "@/lib/types";

type Download = { loaded: number; total: number; state: "pending" | "downloading" | "complete" | "failed" };

type Slot = "a" | "b";

export function Player({
  playlistId,
  presentation = "full",
}: {
  playlistId?: string;
  presentation?: "full" | "mini";
}) {
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
  const metadataCleanup = useRef<(() => void) | null>(null);
  const failCount = useRef(0);
  const retryAfter = useRef(0);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekGrace = useRef(0);
  const draftSeek = useRef<number | null>(null);
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

  const [mobileQueue, setMobileQueue] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [songs, setSongs] = useState<PublicTrack[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [pos, setPos] = useState(0);
  const [playlistName, setPlaylistName] = useState("");
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [progress, setProgress] = useState({ current: 0, duration: 0 });
  const [downloads, setDownloads] = useState<Record<string, Download>>({});
  const [buffering, setBuffering] = useState(false);
  const [seekPreview, setSeekPreview] = useState<number | null>(null);
  const [buffered, setBuffered] = useState<Array<[number, number]>>([]);
  const [volume, setVolume] = useState(0.85);
  const [issue, setIssue] = useState("");
  const [role, setRole] = useState("store");
  const [cacheStatus, setCacheStatus] = useState("Preparing offline music");
  const [sessionIssue, setSessionIssue] = useState("");
  const [renewUser, setRenewUser] = useState("");
  const [renewPassword, setRenewPassword] = useState("");
  const [renewBusy, setRenewBusy] = useState(false);

  async function signInAgain(event: React.FormEvent) {
    event.preventDefault();
    setRenewBusy(true);
    try {
      const response = await fetch("/api/admin/session", {
        method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify({username:renewUser,password:renewPassword}),
        signal:AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Login failed");
      setRole(data.role);
      void fetch("/api/admin/session", {cache:"no-store"}).catch(() => undefined);
      setSessionIssue("");
      setRenewPassword("");
    } catch (error) { setSessionIssue(error instanceof Error ? error.message : "Login failed"); }
    finally { setRenewBusy(false); }
  }
  const [deviceReady, setDeviceReady] = useState(false);
  const [clock, setClock] = useState("--:--");
  const [elapsedLabel, setElapsedLabel] = useState("0 sec");

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

  function readBuffer(slot: Slot) {
    if (slot !== activeSlot.current) return;
    const el = slotEl(slot);
    if (!el) return;
    setBuffered(Array.from({length:el.buffered.length}, (_, i) => [el.buffered.start(i), el.buffered.end(i)] as [number,number]));
    if (Number.isFinite(el.duration)) setProgress(p => ({...p,duration:el.duration}));
  }

  function seekTo(time: number) {
    const el = slotEl(activeSlot.current);
    const song = songsRef.current.find(s => s.id === orderRef.current[posRef.current]);
    if (!el || !song || !Number.isFinite(el.duration)) return;
    const target = Math.min(Math.max(time,0), Math.max(0,el.duration - 0.1));
    const locallyBuffered = Array.from({length:el.buffered.length}, (_, i) => i).some(i => target >= el.buffered.start(i) && target < el.buffered.end(i));
    if (!navigator.onLine && downloads[song.url]?.state !== "complete" && !locallyBuffered) {
      setIssue("This position is not cached. Reconnect to seek here.");
      return;
    }
    seekGrace.current = Date.now() + 30000;
    setBuffering(true);
    setIssue("");
    try { el.currentTime = target; setProgress(p => ({...p,current:target})); }
    catch { setBuffering(false); setIssue("This position is not available yet. Try again."); }
  }

  function cancelSeek() {
    if (seekTimer.current) clearTimeout(seekTimer.current);
    seekTimer.current = null;
    draftSeek.current = null;
    seekGrace.current = 0;
    setSeekPreview(null);
    setBuffering(false);
  }

  function previewSeek(time: number) {
    draftSeek.current = time;
    setSeekPreview(time);
    if (seekTimer.current) clearTimeout(seekTimer.current);
    const token = playToken.current;
    const songId = orderRef.current[posRef.current];
    seekTimer.current = setTimeout(() => {
      if (token !== playToken.current || songId !== orderRef.current[posRef.current]) return;
      seekTimer.current = null;
      seekTo(time); draftSeek.current = null; setSeekPreview(null);
    }, 200);
  }

  useEffect(() => () => {
    ++playToken.current;
    if (seekTimer.current) clearTimeout(seekTimer.current);
    metadataCleanup.current?.();
  }, []);

  function playCurrent(preferIdle: boolean, seekTo?: number) {
    const song = songsRef.current.find((item) => item.id === orderRef.current[posRef.current]);
    if (!song) return;
    // Invalidate callbacks before pausing/reloading either audio element.
    const token = ++playToken.current;
    metadataCleanup.current?.();
    metadataCleanup.current = null;
    cancelSeek();
    retryAfter.current = 0;
    setBuffered([]);
    setProgress({current:0,duration:0});
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
    const begin = () => {
      if (token !== playToken.current || el.dataset.songId !== song.id) return;
      metadataCleanup.current?.();
      metadataCleanup.current = null;
      if (seekTo != null && el.duration && Number.isFinite(el.duration)) {
        el.currentTime = Math.min(Math.max(seekTo, 0), Math.max(0, el.duration - 0.25));
      }
      if (el.ended) el.currentTime = 0;
      el.volume = volumeRef.current;
      armNext();
      if (!shouldPlayRef.current) return;
      void el.play().then(() => {
        if (token !== playToken.current) return;
        failCount.current = 0;
        setPlaying(true);
        setIssue("");
      }).catch((error: unknown) => {
        if (token !== playToken.current || !shouldPlayRef.current) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof DOMException && error.name === "NotAllowedError") shouldPlayRef.current = false;
        setPlaying(false);
        setIssue("Playback could not start. Press Play to retry.");
      });
    };
    const listenForMetadata = () => {
      el.addEventListener("loadedmetadata", begin, { once: true });
      metadataCleanup.current = () => el.removeEventListener("loadedmetadata", begin);
    };
    if (el.dataset.songId !== song.id || el.seeking || el.error) {
      // load() aborts any outstanding seek/play request from the previous track.
      el.pause();
      listenForMetadata();
      el.dataset.songId = song.id;
      el.src = song.url;
      el.load();
    } else if (el.readyState >= 1) {
      // A preloaded/reused slot must start this track at its beginning.
      if (seekTo == null) el.currentTime = 0;
      begin();
    } else {
      listenForMetadata();
    }
    if (presentation === "full") document.title = `${song.title} · ${STORE_NAME}`;
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
    else {
      const token = playToken.current;
      void el.play().catch((error: unknown) => {
        if (token !== playToken.current || !shouldPlayRef.current) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof DOMException && error.name === "NotAllowedError") shouldPlayRef.current = false;
        setPlaying(false);
        setIssue("Playback could not start. Press Play to retry.");
      });
    }
  }

  function start() {
    if (!songsRef.current.length) return;
    startedRef.current = true;
    setStarted(true);
    shouldPlayRef.current = true;
    const saved = resumeRef.current;
    const savedId = saved && songsRef.current.some((song) => song.id === saved.songId) ? saved.songId : undefined;
    const nextOrder = shuffleRef.current
      ? buildOrder(songsRef.current, true, savedId)
      : buildOrder(songsRef.current, false, savedId);
    commitOrder(nextOrder, 0);
    const seek = saved && savedId && saved.time > 1 ? saved.time : undefined;
    playCurrent(false, seek);
  }

  function toggleShuffle() {
    const next = !shuffleRef.current;
    shuffleRef.current = next;
    setShuffle(next);
    localStorage.setItem("fm-shuffle", next ? "1" : "0");
    const currentId = orderRef.current[posRef.current];
    commitOrder(buildOrder(songsRef.current, next, currentId), 0);
    if (startedRef.current) armNext();
  }

  function playFromQueue(id: string) {
    setMobileQueue(false);
    const index = orderRef.current.indexOf(id);
    if (index < 0) return;
    startedRef.current = true;
    setStarted(true);
    shouldPlayRef.current = true;
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
      setPlaying(false);
      retryAfter.current = Date.now() + 30000;
      setIssue("Tracks unavailable. Retrying automatically.");
      return;
    }
    setIssue("This track couldn't be opened. Skipping to the next one.");
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
    setPlaying(true);
    setBuffering(false);
    setIssue("");
    const token = playToken.current;
    window.setTimeout(() => {
      if (token !== playToken.current) return;
      const el = slotEl(slot);
      if (slot === activeSlot.current && el && !el.paused) failCount.current = 0;
    }, 800);
  };

  useEffect(() => {
    const renew = async () => {
      try {
        const response = await fetch("/api/admin/session", {cache:"no-store", signal:AbortSignal.timeout(10000)});
        const data = await response.json();
        if (data.ok) { setRole(data.role); setSessionIssue(""); }
        else setSessionIssue("Please sign in again. Existing music will continue.");
      } catch { /* offline sessions keep playing */ }
    };
    const online = () => { retryAfter.current = 0; void renew(); retainDeviceAudio(songsRef.current.map(song => song.url)); };
    const message = (event: MessageEvent) => {
      if (event.data?.type === "track-download") {
        const d = event.data;
        setDownloads(previous => ({...previous,[d.url]:{loaded:d.loaded,total:d.total,state:d.state}}));
        return;
      }
      if (event.data?.type !== "cache-progress") return;
      const d = event.data;
      setCacheStatus(d.ready ? `Offline ready · ${d.done} tracks` : `${d.failed ? "Download incomplete; will retry" : "Downloading"} · ${d.done}/${d.total}`);
    };
    void renew();
    const timer = window.setInterval(() => void renew(), 60 * 60 * 1000);
    window.addEventListener("online", online);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => { window.clearInterval(timer); window.removeEventListener("online", online); navigator.serviceWorker?.removeEventListener("message", message); };
  }, []);

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
      setClock(date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }));
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
        const response = await fetch(`/api/playlist${query}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (stop) return;
        if (response.status === 401) {
          setSessionIssue("Login needs renewal. Music will continue; sign in again when convenient.");
          return;
        }
        if (response.status === 404) {
          setIssue("Playlist not found");
          setLoading(false);
          return;
        }
        if (!response.ok) throw new Error("load failed");
        const data = await response.json();
        if (!first && data.updatedAt === updatedAtRef.current) { retainDeviceAudio(songsRef.current.map(song => song.url)); return; }
        updatedAtRef.current = data.updatedAt || "";
        const list = (data.songs || []) as PublicTrack[];
        const previousId = orderRef.current[posRef.current];
        songsRef.current = list;
        setSongs(list);
        retainDeviceAudio(list.map((song) => song.url));
        setPlaylistName(data.playlist?.name || "");
        if (Boolean(playlistId) && !data.playlist) setIssue("Playlist not found");
        setLoading(false);
        const ids = list.map((song) => song.id);
        if (!ids.length) {
          aRef.current?.pause(); bRef.current?.pause();
          setPlaying(false); commitOrder([], 0);
          return;
        }
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
          setIssue("Couldn't load the playlist. Retrying.");
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
    let stop = false;
    prepareDeviceAudio().catch(() => { setCacheStatus("Offline storage unavailable on this device"); }).finally(() => {
      if (!stop) setDeviceReady(true);
    });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (!deviceReady || startedRef.current || !songs.length) return;
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { songId?: string; time?: number };
        if (saved.songId && songs.some((song) => song.id === saved.songId)) {
          resumeRef.current = { songId: saved.songId, time: Number(saved.time) || 0 };
        }
      } catch {
        resumeRef.current = null;
      }
    }
    start();
  }, [deviceReady, songs, storageKey]);

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
      if (Date.now() - lastMove > 15000 && Date.now() >= retryAfter.current && Date.now() >= seekGrace.current && draftSeek.current === null) {
        lastMove = Date.now();
        setPlaying(false);
        setIssue("Playback stalled. Retrying another track.");
        el.removeAttribute("src");
        delete el.dataset.songId;
        el.load();
        api.current.next();
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
    if (presentation === "mini") {
      document.title = `Manage · ${STORE_NAME}`;
      return;
    }
    const song = songs.find((item) => item.id === order[pos]);
    document.title = song ? `${song.title} · ${STORE_NAME}` : STORE_NAME;
  }, [presentation, songs, order, pos]);

  useEffect(() => {
    if (!shouldPlayRef.current) return;
    const el = slotEl(activeSlot.current);
    if (!el?.src || !el.paused) return;
    const resume = () => {
      if (shouldPlayRef.current && el.paused) void el.play().catch(() => undefined);
    };
    resume();
    const timer = window.setTimeout(resume, 0);
    return () => window.clearTimeout(timer);
  }, [presentation]);

  useEffect(() => {
    if (!playing || presentation === "mini") {
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
  }, [playing, presentation]);

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
  const queue = order.map(id => songs.find(song => song.id === id)).filter((song): song is PublicTrack => Boolean(song));
  const displayTime = seekPreview ?? progress.current;
  const percent = progress.duration ? (displayTime / progress.duration) * 100 : 0;
  const download = current ? downloads[current.url] : undefined;
  const downloadPercent = download?.total ? Math.min(99, Math.floor(download.loaded / download.total * 100)) : null;
  const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const downloadLabel = !current ? "" : download?.state === "complete" ? "Current track · Saved for offline playback"
    : download?.state === "downloading" ? `Downloading current track · ${downloadPercent !== null ? `${downloadPercent}% · ` : ""}${megabytes(download.loaded)}${download.total ? ` / ${megabytes(download.total)}` : ""}`
    : download?.state === "failed" ? "Offline download interrupted · Online playback is still available"
    : "Current track · Streaming / waiting to cache";

  useEffect(() => {
    if (!current?.url) return;
    const post = () => navigator.serviceWorker?.controller?.postMessage({type:"track-status",url:current.url});
    post();
    navigator.serviceWorker?.addEventListener("controllerchange",post);
    const timer = window.setInterval(post,3000);
    return () => { window.clearInterval(timer); navigator.serviceWorker?.removeEventListener("controllerchange",post); };
  }, [current?.url]);

  if (loading && presentation === "full") return <main className="booting">Preparing playlist</main>;

  const audios = (
    <>
      <audio ref={aRef} preload="auto" playsInline onEnded={() => api.current.onEnded("a")} onError={() => api.current.onError("a")} onTimeUpdate={() => api.current.onTime("a")} onPlaying={() => api.current.onPlaying("a")} onProgress={() => readBuffer("a")} onLoadedMetadata={() => readBuffer("a")} onDurationChange={() => readBuffer("a")} onWaiting={() => { if (activeSlot.current === "a") setBuffering(true); }} onSeeking={() => { if (activeSlot.current === "a") setBuffering(true); }} onSeeked={() => { if (activeSlot.current === "a") { setBuffering(false); readBuffer("a"); } }} onCanPlay={() => { if (activeSlot.current === "a") setBuffering(false); }} />
      <audio ref={bRef} preload="auto" playsInline onEnded={() => api.current.onEnded("b")} onError={() => api.current.onError("b")} onTimeUpdate={() => api.current.onTime("b")} onPlaying={() => api.current.onPlaying("b")} onProgress={() => readBuffer("b")} onLoadedMetadata={() => readBuffer("b")} onDurationChange={() => readBuffer("b")} onWaiting={() => { if (activeSlot.current === "b") setBuffering(true); }} onSeeking={() => { if (activeSlot.current === "b") setBuffering(true); }} onSeeked={() => { if (activeSlot.current === "b") { setBuffering(false); readBuffer("b"); } }} onCanPlay={() => { if (activeSlot.current === "b") setBuffering(false); }} />
    </>
  );

  if (presentation === "mini") {
    return (
      <>
        <div className="mini-player">
          <div className="mini-progress" style={{ width: `${percent}%` }} />
          <Link className="mini-meta" href="/">
            <strong>{current?.title || (loading ? "Preparing playlist" : "No music yet")}</strong>
            <span>{current?.artist || playlistName || STORE_NAME}</span>
          </Link>
          <div className="mini-controls">
            <button className="icon-btn" type="button" aria-label="Previous" onClick={prev} disabled={!songs.length}>
              <PrevIcon />
            </button>
            <button
              className="play-btn mini-play"
              type="button"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!songs.length}
              onClick={() => (started ? setWantPlay(!playing) : start())}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon-btn" type="button" aria-label="Next" onClick={() => advance(1)} disabled={!songs.length}>
              <NextIcon />
            </button>
          </div>
        </div>
        {audios}
      </>
    );
  }

  return (
    <>
    <main className={`player${mobileMenu ? " mobile-menu-open" : ""}${mobileQueue ? " mobile-queue-open" : ""}`} style={{ ["--glow" as string]: String(18 + (pos % 6) * 4) }}>
      <div className="mobile-player-nav">
        <button className="icon-btn" type="button" aria-label="账户与播放状态" aria-expanded={mobileMenu} onClick={() => { setMobileMenu(!mobileMenu); setMobileQueue(false); }}><svg className="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m5 9 7 7 7-7" /></svg></button>
        <strong>Now Playing</strong>
        <button className="icon-btn" type="button" aria-label="打开歌单" aria-expanded={mobileQueue} aria-controls="player-playlist" onClick={() => { setMobileQueue(!mobileQueue); setMobileMenu(false); }}><OrderIcon /></button>
      </div>
      <header className="topbar">
        <div className="brand-block">
          <div>
          <p className="eyebrow">
            {playlistName || "Waiting for a playlist"}

          </p>
          <h1 className="brand"><Link className="wordmark" href="/">{STORE_NAME}</Link></h1>
          </div>
        </div>
        <div className="clock-block">
          <div className="clock">{clock}</div>
          <div className="elapsed">Playing for {elapsedLabel}</div>
        </div>
        <div className="live-pill">
          <span className={playing ? "dot on" : "dot"} />
          {playing ? "Playing" : started ? "Paused" : "Not started"}
          {role === "admin" ? <Link className="admin-link" href="/admin">Manage</Link> : null}
          <button
            className="admin-link"
            type="button"
            onClick={() => {
              void fetch("/api/admin/session", { method: "DELETE" }).then(() => {
                window.location.reload();
              });
            }}
          >
            Log out
          </button>
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
          <p className="kicker">Now playing {songs.length ? `${Math.min(pos + 1, songs.length)} / ${songs.length}` : ""}</p>
          <h2 className="title">{current?.title || "No music yet"}</h2>
          <p className="artist">{current?.artist || (songs.length ? "Unknown artist" : "Upload a playlist in Manage and it will loop here.")}</p>
          <p className="issue" role="status">{issue}</p>
          <div className="download-status" role="status">
            <span>{downloadLabel}</span>
            {download?.state === "downloading" ? <progress aria-label="Current track download" max={download.total || undefined} value={download.total ? download.loaded : undefined} /> : null}
            <small>{cacheStatus}</small>
          </div>
          {buffering ? <p className="buffering" role="status">Buffering selected position…</p> : null}
          {sessionIssue ? <form onSubmit={signInAgain}>
            <p role="alert">{sessionIssue}</p>
            <input className="field" aria-label="Username" autoComplete="username" value={renewUser} onChange={e => setRenewUser(e.target.value)} required />
            <input className="field" aria-label="Password" autoComplete="current-password" type="password" value={renewPassword} onChange={e => setRenewPassword(e.target.value)} required />
            <button className="pill" disabled={renewBusy} type="submit">{renewBusy ? "Signing in…" : "Sign in without stopping music"}</button>
          </form> : null}
          <div className="playback-dock" role="group" aria-label="播放控制">
          <div className="timeline">
            <div className="seek-track">
            <div className="buffered-track" aria-hidden="true">
              {buffered.map(([start,end],i) => progress.duration > 0 ? <span key={i} style={{left:`${start / progress.duration * 100}%`,width:`${(end - start) / progress.duration * 100}%`}} /> : null)}
            </div>
            <input
              type="range"
              min={0}
              max={progress.duration || 0}
              step={0.1}
              value={Math.min(displayTime, progress.duration || 0)}
              aria-label="Seek"
              disabled={!current || !progress.duration}
              aria-valuetext={`${formatClock(displayTime)} / ${formatClock(progress.duration)}`}
              style={{ background: `linear-gradient(90deg, var(--accent) ${percent}%, transparent ${percent}%)` }}
              onChange={(event) => previewSeek(Number(event.target.value))}
            />
            </div>
            <div className="times">
              <span>{formatClock(displayTime)}</span>
              <span>{formatClock(progress.duration)}</span>
            </div>
          </div>
          <div className="controls">
            <button className={`icon-btn mobile-control mode-toggle${shuffle ? " on" : ""}`} type="button" aria-label="随机播放" aria-pressed={shuffle} onClick={toggleShuffle}>{shuffle ? <ShuffleIcon /> : <OrderIcon />}</button>
            <button className="icon-btn" type="button" aria-label="Previous" onClick={prev} disabled={!songs.length}>
              <PrevIcon />
            </button>
            <button
              className="play-btn"
              type="button"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!songs.length}
              onClick={() => (started ? setWantPlay(!playing) : start())}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button className="icon-btn" type="button" aria-label="Next" onClick={() => advance(1)} disabled={!songs.length}>
              <NextIcon />
            </button>
            <button className="icon-btn mobile-control" type="button" aria-label="打开歌单" aria-expanded={mobileQueue} onClick={() => setMobileQueue(true)}><PlaylistIcon /></button>
          </div>
          <div className="tools">
            <button
              className={shuffle ? "icon-btn mode-toggle on" : "icon-btn mode-toggle"}
              type="button"
              aria-label="随机播放"
              aria-pressed={shuffle}
              title={shuffle ? "随机播放 · 点击切换为顺序播放" : "顺序播放 · 点击切换为随机播放"}
              onClick={toggleShuffle}

            >
              {shuffle ? <ShuffleIcon /> : <OrderIcon />}
            </button>
            <label className="vol" title="音量">
              <VolumeIcon />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                aria-label="Volume"
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </label>
            <button
              className="icon-btn"
              type="button"
              aria-label="切换全屏"
              title="切换全屏"
              onClick={() => {
                if (!document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => undefined);
                else void document.exitFullscreen();
              }}
            >
              <FullscreenIcon />
            </button>
            <span className="hints">Space to pause · Arrow keys to skip</span>
          </div>
          </div>
        </section>
        <aside className="queue" id="player-playlist" aria-label="Playlist">
          <button type="button" className="mobile-queue-close" aria-label="关闭歌单" onClick={() => setMobileQueue(false)}>关闭 ×</button>
          <h2>Playlist <span className="queue-count">{queue.length} tracks</span></h2>
          {queue.length === 0 ? (
            <p className="quiet">This playlist is empty.</p>
          ) : (
            <ol aria-label="Playlist tracks" tabIndex={0}>
              {queue.map((song, index) => (
                <li key={song.id}>
                  <button type="button" className={song.id === current?.id ? "current-track" : undefined} aria-current={song.id === current?.id ? "true" : undefined} onClick={() => playFromQueue(song.id)}>
                    <span className="q-number">{song.id === current?.id ? (playing ? "▶" : "Ⅱ") : String(index + 1).padStart(2, "0")}</span>
                    <span className="q-title">{song.title}</span>
                    <span className="q-artist">{song.artist || "Unknown artist"}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </section>
    </main>
    {audios}
    </>
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

function ShuffleIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h3c4 0 8 12 12 12h3m-4-4 4 4-4 4M3 18h3c1.5 0 3-1.7 4.5-4M14 9c1.4-1.8 2.6-3 4-3h3m-4-4 4 4-4 4" /></svg>;
}
function OrderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h11M4 12h8M4 19h8M18 5v14m-3-3 3 3 3-3" /></svg>;
}
function VolumeIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4 6 8H3v8h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></svg>;
}
function FullscreenIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg>;
}

function PlaylistIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M3 10h14M3 15h8m5-1v6m0-6 5-1v6"/><ellipse cx="14" cy="20" rx="2" ry="1.5"/><ellipse cx="19" cy="19" rx="2" ry="1.5"/></svg>;
}
