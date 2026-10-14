// One player for pictures, GIFs / animated WebP, videos, text and PDF. Used
// by the full viewer, each multi-screen panel, and the player outside the vault.
//
// Mouse: wheel = next / previous (scrolls inside text and PDF), Ctrl+wheel =
// zoom, drag = draw a rectangle (click inside it to zoom to it, outside to
// dismiss), right-drag = move the zoomed picture, 0 = reset zoom.
// Videos: ←/→ jump (Shift = bigger jump), Ctrl+←/→ one frame, Ctrl+Space /
// Shift+Space next / previous item, A/B/X loop, K bookmark, S save frame.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { setPlaying as reportPlaying } from '../activity';
import { api, previewUrl, type Bookmark, type FaceBox } from '../api';
import { useBeatSync } from '../beats';
import { clipBox, drawnRect, type Box } from '../flip';
import { kickFaceScanner } from '../ml/facescan';
import { facesAt, kenBurnsPath, resumeStart, resumeValue } from '../viewerlogic';
import { noteResume } from '../resumebus';
import { captureVideoFrame, derivedName } from '../clips';
import { formatTime, kickThumbnails, type PlayItem } from '../media';
import { ORDERS, Playlist, type Order, type Repeat } from '../playlist';
import { gifShowMs, SPEEDS, type PlaybackSettings } from '../presets';
import { rememberSound, saveViewerPrefs, setFaceBoxes, unmuteVolume, useViewerPrefs } from '../prefs';
import { ContextMenu, Dropdown } from './Dialogs';
import { FaceLayer } from './FaceBoxes';
import { PdfView, TextView } from './DocViews';
import { ImageStage, type ImageInfo, type ImageStageHandle } from './ImageStage';
import { useFaceAlign } from './FaceAlign';
import {
  BookmarkIcon, BrokenIcon, CameraIcon, CloseIcon, ExpandIcon, FaceIcon, FrameBackIcon, FrameNextIcon, FullscreenIcon, GifIcon, HeartIcon, HelpIcon, LoopIcon,
  MiniPlayerIcon, MuteIcon, NextIcon,
  PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ShuffleIcon, SoundIcon,
} from './Icons';
import { ShortcutsDialog } from './Shortcuts';
import { BookmarksPanel, GifMakerDialog, PositionBar, preciseTime, ScalingMenu } from './VideoTools';

export interface PlayerHandle {
  setPaused: (paused: boolean) => void;
  isPaused: () => boolean;
  next: () => void;
  prev: () => void;
  toggleMute: () => void;
  /** Where the current picture / video is drawn on screen (null if unknown). */
  mediaRect: () => Box | null;
}

export interface PlayerProps {
  items: PlayItem[];
  startKey?: string;
  settings: PlaybackSettings;
  onSettings: (s: PlaybackSettings) => void;
  /** Start with the slideshow running (otherwise it starts when asked). */
  autoSlideshow?: boolean;
  /** Multi-screen master volume / mute, multiplied with this player's own. */
  masterVolume?: number;
  masterMuted?: boolean;
  compact?: boolean;
  /** Media only, no controls (shaped multi-screen panels bring their own). */
  bare?: boolean;
  /** Clean full screen: no UI unless `controlsOnMouse`. */
  clean?: boolean;
  controlsOnMouse?: boolean;
  /** Listen to keyboard shortcuts (the focused player only). */
  keys?: boolean;
  activityId: string;
  title?: ReactNode;
  topRight?: ReactNode;
  panelExtra?: ReactNode;
  onFavourite?: (item: PlayItem, on: boolean) => void;
  onWeight?: (item: PlayItem, weight: number) => void;
  onFullscreen?: () => void;
  onClose?: () => void;
  /** Extra line under the file name (e.g. its folder, as a link). */
  subtitle?: (item: PlayItem) => React.ReactNode;
  onCurrent?: (item: PlayItem | null) => void;
  /** Shrink into the mini player (button and M). */
  onMinimize?: () => void;
  /** Shown as the small floating mini player, with its own little controls. */
  mini?: { onExpand: () => void; onClose: () => void };
  /** Pictures slowly pan and zoom during the slideshow (also a slideshow setting). */
  kenBurns?: boolean;
  /** Wait (like paused), e.g. while a title card shows. */
  hold?: boolean;
  /** A known face was clicked: show everything of that person (folder id). */
  onShowPerson?: (folderId: number) => void;
  /** The slideshow is about this person (folder id): "Line up faces" uses their face. */
  person?: number | null;
  ref?: Ref<PlayerHandle>;
}

const WEIGHTS = [0, 0.5, 1, 2, 3, 5, 10];
const NO_LOOP = { a: null, b: null } as { a: number | null; b: number | null };

export function Player(props: PlayerProps) {
  const { settings: s, onSettings } = props;
  const prefs = useViewerPrefs();
  const listRef = useRef<Playlist<PlayItem> | null>(null);
  const [cur, setCur] = useState<PlayItem | null>(null);
  const [tick, setTick] = useState(0); // bumps when the same item restarts
  const [paused, setPaused] = useState(false);
  const [slideshow, setSlideshow] = useState(!!props.autoSlideshow);
  const [overrides, setOverrides] = useState<Record<string, Partial<PlayItem>>>({});
  const [failed, setFailed] = useState(false);
  const [imgInfo, setImgInfo] = useState<ImageInfo | null>(null);
  const [gifFrame, setGifFrame] = useState({ index: 0, count: 0 });
  const [time, setTime] = useState({ at: 0, dur: 0 });
  const [controls, setControls] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const imgRef = useRef<ImageStageHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoStart = useRef(0);
  const frameDur = useRef(0);
  const wasPaused = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [docZoom, setDocZoom] = useState(1);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [loop, setLoop] = useState(NO_LOOP);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bmOpen, setBmOpen] = useState(false);
  const [bmFocus, setBmFocus] = useState<number | null>(null);
  const [gifMaker, setGifMaker] = useState(false);
  const [help, setHelp] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const lastWheel = useRef(0);
  const zoomed = zoom.s > 1.001;
  const halted = paused || !!props.hold;
  const mini = !!props.mini;
  const [vidSize, setVidSize] = useState<{ w: number; h: number } | null>(null);
  const [stageWH, setStageWH] = useState({ w: 0, h: 0 });
  const [resumed, setResumed] = useState<number | null>(null);
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const [faceFlash, setFaceFlash] = useState(false);
  const [faceReload, setFaceReload] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const panMoved = useRef(false);
  const kbRef = useRef<HTMLDivElement>(null);
  const kbAnim = useRef<Animation | null>(null);
  const scanToken = useRef(0);

  const item = cur ? { ...cur, ...overrides[cur.key] } : null;
  const isVideo = item?.kind === 'video';
  const isGif = item?.kind === 'gif';
  const isPicture = item?.kind === 'image' || isGif;
  const inVault = item?.itemId != null;

  // Build the play order whenever the item list changes.
  useEffect(() => {
    const p = new Playlist(props.items, s.order, s.repeat, props.startKey ?? listRef.current?.current()?.key);
    listRef.current = p;
    setCur(p.current());
    setFailed(false);
  }, [props.items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const p = listRef.current;
    if (!p) return;
    if (p.orderName !== s.order) {
      p.setOrder(s.order);
      setCur(p.current());
    }
    p.repeat = s.repeat;
  }, [s.order, s.repeat]);

  useEffect(() => props.onCurrent?.(item), [item?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new item starts unzoomed, without a loop.
  useEffect(() => {
    setZoom({ s: 1, x: 0, y: 0 });
    setRect(null);
    setDrawing(null);
    setLoop(NO_LOOP);
    setImgInfo(null);
    setGifFrame({ index: 0, count: 0 });
    setBmOpen(false);
    frameDur.current = 0;
    setVidSize(null);
    setResumed(null);
    setFaces([]);
    setFaceFlash(false);
    setMenu(null);
    scanToken.current += 1;
  }, [item?.key]);

  // Counts as viewed after a couple of seconds on screen (main viewer only).
  useEffect(() => {
    if (!props.keys || item?.itemId == null) return;
    const id = item.itemId;
    const t = setTimeout(() => api.markViewed(id).catch(() => {}), 2000);
    return () => clearTimeout(t);
  }, [item?.key, props.keys]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bookmarks of the current video.
  const loadBookmarks = useCallback(() => {
    if (!isVideo || item?.itemId == null || props.compact) return setBookmarks([]);
    api.bookmarks(item.itemId).then(setBookmarks).catch(() => setBookmarks([]));
  }, [item?.key, isVideo, props.compact]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(loadBookmarks, [loadBookmarks]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const beatMark = useRef<() => void>(() => {});
  const alignSnap = useRef<() => void>(() => {});
  const go = useCallback((dir: 'next' | 'prev', auto = false) => {
    const p = listRef.current;
    if (!p) return;
    const before = p.current()?.key;
    const n = dir === 'next' ? p.next(auto) : p.prev();
    if (n === null) {
      // End of the list with repeat off.
      setSlideshow(false);
      return;
    }
    beatMark.current();
    if (n.key !== before) alignSnap.current();
    setFailed(false);
    if (n.key === before) {
      setTick((t) => t + 1);
      const v = videoRef.current;
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
    }
    setCur(n);
  }, []);

  // Beat sync: with music playing on the computer, the slideshow moves on with
  // the beat (videos too); when it's quiet the normal timing takes over.
  const beatOn = slideshow && !halted && s.beatSync;
  const beat = useBeatSync({ enabled: beatOn, everyBeats: s.beatEvery, minSeconds: s.beatMinSeconds, onAdvance: () => go('next', true) });
  beatMark.current = beat.markAdvanced;
  const beatDriving = beatOn && !beat.silent && !zoomed;

  // Pictures and GIFs advance on a timer while the slideshow runs.
  useEffect(() => {
    if (!item || !slideshow || halted || zoomed) return;
    if (beatDriving && !failed) return;
    let ms = 0;
    if (failed) ms = 1500;
    else if (item.kind === 'image' || item.kind === 'text' || item.kind === 'pdf') ms = s.imageSeconds * 1000;
    else if (item.kind === 'gif') {
      if (!imgInfo) return;
      ms = gifShowMs(s, imgInfo.loopMs);
    } else return;
    const t = setTimeout(() => go('next', true), ms);
    return () => clearTimeout(t);
  }, [item?.key, tick, slideshow, halted, zoomed, failed, imgInfo, s.imageSeconds, s.gifLoops, s.gifMaxSeconds, go, beatDriving]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Line up faces": the main face stays at the same place and size from picture to picture.
  const align = useFaceAlign({
    on: !!prefs.alignFaces && slideshow && !mini,
    item,
    natural: isPicture && imgInfo ? { w: imgInfo.width, h: imgInfo.height } : null,
    stage: stageWH,
    fit: s.fit,
    blocked: zoomed || failed,
    person: props.person,
    upcoming: () => listRef.current?.peek(5) ?? [],
    layer: kbRef,
    kenBurns: !!(props.kenBurns || s.kenBurns),
    showMs: s.imageSeconds * 1000,
    halted,
  });
  alignSnap.current = align.snap;

  // Slow pan and zoom over each picture during the slideshow.
  const kenBurns = (props.kenBurns || s.kenBurns) && slideshow && item?.kind === 'image' && !zoomed && !failed && !align.lining;
  useEffect(() => {
    const el = kbRef.current;
    if (!el || !kenBurns || typeof el.animate !== 'function') return;
    const p = kenBurnsPath();
    const tf = (k: { s: number; x: number; y: number }) => `translate(${k.x}%, ${k.y}%) scale(${k.s})`;
    const a = el.animate([{ transform: tf(p.from) }, { transform: tf(p.to) }], {
      duration: Math.max(1500, s.imageSeconds * 1000 + 800),
      easing: 'ease-in-out',
      fill: 'both',
    });
    kbAnim.current = a;
    return () => {
      a.cancel();
      kbAnim.current = null;
    };
  }, [item?.key, tick, kenBurns]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = kbAnim.current;
    if (!a) return;
    if (halted) a.pause();
    else if (a.playState === 'paused') a.play();
  }, [halted, kenBurns]);

  // ---- zoom, rectangle zoom, panning, wheel ---------------------------------------------

  const isDoc = item?.kind === 'text' || item?.kind === 'pdf';
  const stageSize = () => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, w: r.width, h: r.height } : { left: 0, top: 0, w: 1, h: 1 };
  };
  const clampZoom = (z: { s: number; x: number; y: number }) => {
    const { w, h } = stageSize();
    const sc = Math.min(64, Math.max(1, z.s));
    if (sc <= 1.001) return { s: 1, x: 0, y: 0 };
    // Keep at least part of the picture on screen.
    return { s: sc, x: Math.min(w * 0.5, Math.max(w * 0.5 - w * sc, z.x)), y: Math.min(h * 0.5, Math.max(h * 0.5 - h * sc, z.y)) };
  };
  const zoomAt = (px: number, py: number, factor: number) =>
    setZoom((z) => {
      const ns = Math.min(64, Math.max(1, z.s * factor));
      const k = ns / z.s;
      return clampZoom({ s: ns, x: px - (px - z.x) * k, y: py - (py - z.y) * k });
    });
  const zoomToRect = (r: { x: number; y: number; w: number; h: number }) =>
    setZoom((z) => {
      const { w, h } = stageSize();
      const k = Math.min(w / r.w, h / r.h);
      const ns = Math.min(64, z.s * k);
      const cx = (r.x + r.w / 2 - z.x) / z.s;
      const cy = (r.y + r.h / 2 - z.y) / z.s;
      return clampZoom({ s: ns, x: w / 2 - ns * cx, y: h / 2 - ns * cy });
    });

  // Wheel needs a non-passive listener so Ctrl+wheel doesn't zoom the whole window.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (mini) return; // the page behind scrolls
      const doc = isDoc;
      if (e.ctrlKey) {
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0018);
        if (doc) setDocZoom((d) => Math.min(6, Math.max(0.3, d * f)));
        else {
          const st = stageSize();
          zoomAt(e.clientX - st.left, e.clientY - st.top, f);
        }
        return;
      }
      if (doc) return; // scroll inside the text / PDF
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheel.current < 280 || Math.abs(e.deltaY) < 4) return;
      lastWheel.current = now;
      go(e.deltaY > 0 ? 'next' : 'prev');
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const onStagePointerDown = (e: React.PointerEvent) => {
    if (!item || isDoc || failed || mini) return;
    const st = stageSize();
    const x0 = e.clientX - st.left;
    const y0 = e.clientY - st.top;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    if (e.button === 2) {
      // Right button: move the zoomed picture.
      panMoved.current = false;
      if (!zoomed) return;
      let lx = e.clientX;
      let ly = e.clientY;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - lx;
        const dy = ev.clientY - ly;
        if (Math.abs(dx) + Math.abs(dy) > 0) panMoved.current = true;
        lx = ev.clientX;
        ly = ev.clientY;
        setZoom((z) => clampZoom({ ...z, x: z.x + dx, y: z.y + dy }));
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      return;
    }
    if (e.button !== 0) return;
    let dragged = false;
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - st.left;
      const y1 = ev.clientY - st.top;
      if (!dragged && Math.hypot(x1 - x0, y1 - y0) < 6) return;
      dragged = true;
      setDrawing({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const x1 = ev.clientX - st.left;
      const y1 = ev.clientY - st.top;
      setDrawing(null);
      if (dragged) {
        const r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
        if (r.w > 12 && r.h > 12) setRect(r);
        return;
      }
      // A plain click.
      if (rect) {
        const inside = x1 >= rect.x && x1 <= rect.x + rect.w && y1 >= rect.y && y1 <= rect.y + rect.h;
        if (inside) zoomToRect(rect);
        setRect(null);
      } else if (item.kind === 'video' || (item.kind === 'gif' && !slideshow)) {
        setPaused((p) => !p);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // Video element follows play/pause, speed and volume.
  const volume = Math.max(0, Math.min(1, s.volume * (props.masterVolume ?? 1)));
  // Slideshow videos stay quiet while beat sync listens (so they don't confuse it).
  const beatQuiet = slideshow && s.beatSync;
  const muted = s.muted || !!props.masterMuted || beatQuiet;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = s.speed;
    const resumed = wasPaused.current && !halted;
    wasPaused.current = halted;
    if (halted) v.pause();
    else if (v.paused && (!v.ended || resumed)) v.play().catch(() => {}); // play() after the end starts over
  });

  // Learn the video's frame length (for single-frame steps).
  useEffect(() => {
    const v = videoRef.current as (HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, m: { mediaTime: number }) => void) => number; cancelVideoFrameCallback?: (h: number) => void }) | null;
    if (!v || !isVideo || !v.requestVideoFrameCallback) return;
    let last: number | null = null;
    let samples = 0;
    let handle = 0;
    const cb = (_now: number, m: { mediaTime: number }) => {
      if (last != null) {
        const d = m.mediaTime - last;
        if (d > 0.004 && d < 0.2) {
          frameDur.current = frameDur.current ? Math.min(frameDur.current, d) : d;
          samples += 1;
        }
      }
      last = m.mediaTime;
      if (samples < 40) handle = v.requestVideoFrameCallback!(cb);
    };
    handle = v.requestVideoFrameCallback(cb);
    return () => v.cancelVideoFrameCallback?.(handle);
  }, [item?.key, isVideo]);

  // A–B loop for videos.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isVideo || loop.a == null || loop.b == null) return;
    const lo = Math.min(loop.a, loop.b);
    const hi = Math.max(loop.a, loop.b);
    let raf = 0;
    const check = () => {
      if (v.currentTime >= hi || v.ended) {
        v.currentTime = lo;
        if (!paused) v.play().catch(() => {});
      }
      raf = requestAnimationFrame(check);
    };
    raf = requestAnimationFrame(check);
    return () => cancelAnimationFrame(raf);
  }, [loop, isVideo, paused, item?.key]);

  // A–B loop for GIFs (frames).
  useEffect(() => {
    if (!isGif) return;
    imgRef.current?.setLoop(loop.a != null && loop.b != null ? { a: loop.a, b: loop.b } : null);
  }, [loop, isGif]);

  // Tell auto-lock that something is playing.
  const isPlaying = !!item && !halted && (slideshow || item.kind === 'video');
  useEffect(() => {
    reportPlaying(props.activityId, isPlaying);
    return () => reportPlaying(props.activityId, false);
  }, [isPlaying, props.activityId]);

  // ---- continue watching: long videos opened by hand remember where you were ----
  const lastPos = useRef<{ id: number; at: number; dur: number; saved: number | null | undefined } | null>(null);
  const saveResume = useCallback(() => {
    const p = lastPos.current;
    if (!p) return;
    const ms = resumeValue(p.at, p.dur);
    if (ms === p.saved) return;
    p.saved = ms;
    api.setResume(p.id, ms).catch(() => {});
    noteResume(p.id, ms);
    // This list's copy follows, so coming back to it starts at the right place.
    const it = props.items.find((x) => x.itemId === p.id);
    if (it) it.resumeMs = ms;
  }, [props.items]);
  useEffect(() => {
    if (!isVideo || halted || slideshow) return;
    const t = setInterval(saveResume, 5000);
    return () => clearInterval(t);
  }, [isVideo, halted, slideshow, saveResume, item?.key]);
  // On leaving the video (another item, or closing the viewer).
  useEffect(() => () => {
    saveResume();
    lastPos.current = null;
  }, [item?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (resumed == null) return;
    const t = setTimeout(() => setResumed(null), 6000);
    return () => clearTimeout(t);
  }, [resumed]);

  const onVideoMeta = () => {
    const v = videoRef.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    setVidSize(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null);
    let start = 0;
    // Opened by hand (not in a slideshow): carry on where you left off.
    const back = !slideshow && item?.itemId != null ? resumeStart(item.resumeMs, d) : 0;
    if (back > 0) {
      start = back;
      setResumed(back);
    } else if (s.videoRandomStart && d > 10) {
      const window = Math.min(s.videoMaxSeconds > 0 ? s.videoMaxSeconds : 30, d / 2);
      start = Math.random() * Math.max(0, d - window);
    }
    v.currentTime = start;
    videoStart.current = start;
    setTime({ at: start, dur: d });
  };

  const onVideoTime = () => {
    const v = videoRef.current;
    if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    setTime({ at: v.currentTime, dur });
    if (!slideshow && item?.itemId != null) {
      const p = lastPos.current;
      if (p && p.id === item.itemId) {
        p.at = v.currentTime;
        p.dur = dur;
      } else lastPos.current = { id: item.itemId, at: v.currentTime, dur, saved: item.resumeMs };
    }
    // With the beat in charge, videos move on with the music instead.
    if (slideshow && !beatDriving && s.videoMaxSeconds > 0 && v.currentTime - videoStart.current >= s.videoMaxSeconds) go('next', true);
  };

  const onVideoEnd = () => {
    if (lastPos.current) {
      // Watched to the end: nothing to continue.
      lastPos.current.at = lastPos.current.dur;
      saveResume();
    }
    if (loop.a != null && loop.b != null) return; // the loop takes over
    if (slideshow) go('next', true);
    else if (s.repeat === 'one') {
      const v = videoRef.current;
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
    }
  };

  // The video element is memoised; its handlers always reach this render's state.
  const vh = useRef({ meta: onVideoMeta, time: onVideoTime, end: onVideoEnd });
  vh.current = { meta: onVideoMeta, time: onVideoTime, end: onVideoEnd };

  // ---- where the picture is drawn (face boxes, the grow / shrink animation) ------------------

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageWH({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageWH({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const natural = isPicture && imgInfo ? { w: imgInfo.width, h: imgInfo.height } : isVideo ? vidSize : null;
  const drawn: Box | null = natural && stageWH.w > 0 && !failed ? drawnRect(stageWH.w, stageWH.h, natural.w, natural.h, s.fit, zoom) : null;

  // ---- faces ------------------------------------------------------------------------------------

  const faceCapable = inVault && !props.compact && !mini && (isPicture || isVideo) && !failed;
  const showFaces = faceCapable && (prefs.faceBoxes || faceFlash);
  useEffect(() => {
    if (!showFaces || item?.itemId == null) return;
    let alive = true;
    api.facesOf(item.itemId).then((f) => alive && setFaces(f)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [showFaces, item?.key, faceReload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!faceFlash) return;
    const t = setTimeout(() => setFaceFlash(false), 3000);
    return () => clearTimeout(t);
  }, [faceFlash, faceReload]);
  const what = isVideo ? 'video' : 'picture';
  const flashFaces = async () => {
    if (item?.itemId == null) return;
    const id = item.itemId;
    const list = await api.facesOf(id).catch(() => [] as FaceBox[]);
    if (listRef.current?.current()?.itemId !== id) return;
    setFaces(list);
    if (list.length) {
      setFaceFlash(true);
      setFaceReload((n) => n + 1);
    } else setFlash(`No faces found in this ${what}`);
  };
  const scanFaces = async () => {
    if (item?.itemId == null) return;
    const id = item.itemId;
    const token = ++scanToken.current;
    try {
      await api.facesQueue({ ids: [id], again: true });
      kickFaceScanner();
    } catch (e) {
      setFlash(`Couldn't look for faces: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setFlash(`Looking for faces in this ${what}…`);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (token !== scanToken.current) return; // moved on to another item
      const list = await api.facesOf(id).catch(() => [] as FaceBox[]);
      if (token !== scanToken.current) return;
      if (list.length) {
        setFaces(list);
        setFaceFlash(true);
        setFaceReload((n) => n + 1);
        setFlash(list.length === 1 ? 'Found 1 face' : `Found ${list.length} faces`);
        return;
      }
    }
    if (token === scanToken.current) setFlash(`No faces found in this ${what}`);
  };
  const shownFaces = showFaces ? facesAt(faces, isVideo, time.at) : [];

  // ---- video and GIF tools ------------------------------------------------------------------

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    // Stop just short of the end so a jump forward doesn't end the video.
    v.currentTime = Math.max(0, Math.min(Number.isFinite(v.duration) ? Math.max(0, v.duration - 0.05) : t, t));
    videoStart.current = v.currentTime;
    setTime((x) => ({ ...x, at: v.currentTime }));
  };
  const seekBy = (d: number) => {
    const v = videoRef.current;
    if (v) seekTo(v.currentTime + d);
  };
  const stepFrame = (dir: 1 | -1) => {
    if (isGif) {
      setPaused(true);
      imgRef.current?.step(dir);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    setPaused(true);
    v.pause();
    const fd = frameDur.current || 1 / 30;
    seekTo(v.currentTime + dir * fd);
  };
  const position = () => (isGif ? gifFrame.index : videoRef.current?.currentTime ?? 0);
  const setLoopPoint = (which: 'a' | 'b') => {
    const at = position();
    setLoop((l) => ({ ...l, [which]: at }));
    setFlash(`Loop ${which === 'a' ? 'start' : 'end'}: ${isGif ? `frame ${at + 1}` : preciseTime(at)}`);
  };
  const clearLoop = () => {
    setLoop(NO_LOOP);
    setFlash('Loop cleared');
  };
  const addBookmark = async () => {
    const v = videoRef.current;
    if (!v || item?.itemId == null) return;
    try {
      const id = await api.addBookmark(item.itemId, Math.round(v.currentTime * 1000), '');
      setBmFocus(id);
      setBmOpen(true);
      loadBookmarks();
    } catch (e) {
      setFlash(String(e));
    }
  };
  const saveFrame = async () => {
    if (!item || item.itemId == null) return;
    try {
      let blob: Blob | null;
      let name: string;
      if (isVideo && videoRef.current) {
        blob = await captureVideoFrame(videoRef.current);
        name = derivedName(item.name, videoRef.current.currentTime, 'jpg');
      } else {
        blob = (await imgRef.current?.capture()) ?? null;
        name = derivedName(item.name, null, 'png', `frame ${gifFrame.index + 1}`);
      }
      if (!blob) throw new Error('Nothing to save yet.');
      await api.addFileBytes(item.folderId, name, new Uint8Array(await blob.arrayBuffer()));
      kickThumbnails();
      setFlash(`Saved “${name}” in this folder`);
    } catch (e) {
      setFlash(`Couldn't save the frame: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const set = (patch: Partial<PlaybackSettings>) => {
    const next = { ...s, ...patch };
    // Turning sound on at volume 0 starts at 20%. (Dragging the slider itself to 0 stays 0.)
    if (patch.muted === false && !('volume' in patch)) next.volume = unmuteVolume(next.volume);
    if ('muted' in patch || 'volume' in patch) rememberSound(next.muted, next.volume);
    onSettings(next);
  };
  const toggleSlideshow = () => {
    if (slideshow && !paused) setSlideshow(false);
    else {
      setSlideshow(true);
      setPaused(false);
    }
  };
  const cycleRepeat = () => set({ repeat: ({ off: 'all', all: 'one', one: 'off' } as Record<Repeat, Repeat>)[s.repeat] });
  const cycleSpeed = () => set({ speed: SPEEDS[(SPEEDS.indexOf(s.speed) + 1) % SPEEDS.length] });

  useImperativeHandle(props.ref, () => ({
    setPaused: (p: boolean) => setPaused(p),
    isPaused: () => paused,
    next: () => go('next'),
    prev: () => go('prev'),
    toggleMute: () => set({ muted: !s.muted }),
    mediaRect: () => {
      const st = stageRef.current?.getBoundingClientRect();
      if (!st || !drawn) return null;
      const c = clipBox(drawn, st.width, st.height);
      return c.width > 0 && c.height > 0 ? { left: st.left + c.left, top: st.top + c.top, width: c.width, height: c.height } : null;
    },
  }));

  // Controls fade out while watching and come back when the mouse moves.
  const allowControls = !props.clean || props.controlsOnMouse !== false;
  const poke = useCallback(() => {
    if (!allowControls) return;
    setControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setControls(false), 2500);
  }, [allowControls]);
  useEffect(() => {
    if (props.clean) setControls(false);
    else poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [props.clean]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts.
  useEffect(() => {
    if (!props.keys) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      if (menu) return; // the right-click menu handles its own keys
      const k = e.key.toLowerCase();
      const timed = isVideo || isGif;
      if (k === ' ') {
        e.preventDefault();
        if (e.ctrlKey) go('next');
        else if (e.shiftKey) go('prev');
        else if (timed && !slideshow) setPaused((p) => !p);
        else toggleSlideshow();
      } else if (k === 'arrowright' || k === 'arrowleft') {
        const dir = k === 'arrowright' ? 1 : -1;
        e.preventDefault();
        if (e.ctrlKey && timed) stepFrame(dir);
        else if (isVideo) seekBy(dir * (e.shiftKey ? prefs.seekBigSeconds : prefs.seekSeconds));
        else go(dir > 0 ? 'next' : 'prev');
      } else if (k === 'a' && timed && !e.ctrlKey) setLoopPoint('a');
      else if (k === 'b' && timed && !e.ctrlKey) setLoopPoint('b');
      else if (k === 'x' && timed && !e.ctrlKey) clearLoop();
      else if (k === 'k' && isVideo && inVault) addBookmark();
      else if (k === 's' && (isVideo || isGif) && inVault && !e.ctrlKey) saveFrame();
      else if (k === 'p' && !e.ctrlKey) {
        saveViewerPrefs({ smoothZoom: !prefs.smoothZoom });
        setFlash(prefs.smoothZoom ? 'Crisp pixels when zoomed in' : 'Smooth when zoomed in');
      } else if (k === '?') setHelp(true);
      else if (k === 'm' && props.onMinimize && !e.shiftKey && !e.ctrlKey) props.onMinimize();
      else if (k === 'm') set({ muted: !s.muted });
      else if (k === 'f') props.onFullscreen?.();
      else if (k === '0') {
        setZoom({ s: 1, x: 0, y: 0 });
        setDocZoom(1);
      } else if (k === '+' || k === '=' || k === '-') {
        const f = k === '-' ? 1 / 1.25 : 1.25;
        if (isDoc) setDocZoom((d) => Math.min(6, Math.max(0.3, d * f)));
        else {
          const st = stageSize();
          zoomAt(st.w / 2, st.h / 2, f);
        }
      } else if (k === 'escape' && bmOpen) setBmOpen(false);
      else if (k === 'escape' && (rect || zoomed)) {
        setRect(null);
        setZoom({ s: 1, x: 0, y: 0 });
      } else if (k === 'escape' || k === 'backspace') props.onClose?.();
      else return;
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const index = listRef.current?.index() ?? -1;
  const total = props.items.length;
  const orderLabel = ORDERS.find((o) => o.id === s.order)?.label ?? '';
  const orderItems = ORDERS.map((o) => ({ label: o.label, hint: o.hint, checked: o.id === s.order, onSelect: () => set({ order: o.id as Order }) }));
  const showUi = controls && allowControls;
  const anim = s.transition === 'fade' ? 'fade-in' : undefined;
  const pixelVideo = !prefs.smoothZoom && zoomed;
  const media = useMemo(() => {
    if (!item) return null;
    if (failed)
      return (
        <div className="media-failed">
          <BrokenIcon size={32} />
          <span>{item.name} can't be shown{item.kind === 'video' ? ' (unsupported video format, e.g. HEVC)' : ''}.</span>
        </div>
      );
    if (item.kind === 'video')
      return (
        <video key={item.key} ref={videoRef} className={`media ${anim ?? ''}`} style={{ objectFit: s.fit, imageRendering: pixelVideo ? 'pixelated' : undefined }}
          src={item.src} autoPlay={!halted} crossOrigin="anonymous"
          playsInline preload="auto" onLoadedMetadata={() => vh.current.meta()} onTimeUpdate={() => vh.current.time()} onEnded={() => vh.current.end()}
          onError={() => setFailed(true)} />
      );
    if (item.kind === 'text') return <TextView key={item.key} src={item.src} zoom={docZoom} onError={() => setFailed(true)} />;
    if (item.kind === 'pdf') return <PdfView key={item.key} src={item.src} zoom={docZoom} onError={() => setFailed(true)} />;
    return null;
  }, [item?.key, item?.src, failed, s.fit, s.transition, tick, docZoom, pixelVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  const fav = item?.favourite ?? false;
  const weight = item?.weight ?? 1;
  const timeline = !props.compact && isGif && gifFrame.count > 1 ? (
    <PositionBar at={gifFrame.index} dur={gifFrame.count - 1} onSeek={(i) => { setPaused(true); imgRef.current?.seek(i); }}
      bookmarks={[]} loop={loop} frames={gifFrame} />
  ) : isVideo && time.dur > 0 ? (
    <PositionBar at={time.at} dur={time.dur} onSeek={seekTo} bookmarks={props.compact ? [] : bookmarks} loop={props.compact ? NO_LOOP : loop}
      suffix={s.videoMaxSeconds > 0 && slideshow ? ` · max ${formatTime(s.videoMaxSeconds * 1000)}` : ''}
      hover={props.compact ? undefined : {
        strip: item?.preview && item.itemId != null ? previewUrl(item.itemId) : null,
        aspect: vidSize ? vidSize.w / vidSize.h : 16 / 9,
      }} />
  ) : null;

  const muteKey = props.onMinimize ? 'Shift+M' : 'M';
  // Beat sync status: a tiny level meter and the tempo.
  const beatBadge = s.beatSync && slideshow && (
    <span className="beat-badge" title="The slideshow follows the music playing on your computer">
      <span className="beat-meter" aria-hidden="true"><span style={{ transform: `scaleY(${Math.max(0.08, Math.min(1, beat.level))})` }} /></span>
      {paused ? 'Beat sync paused' : beat.silent || !beat.bpm ? 'Listening… play some music on your computer' : `♪ ${Math.round(beat.bpm)} BPM`}
    </span>
  );

  // Pictures and videos can have a soft glow of themselves around them.
  const ambient = prefs.ambient && !props.compact && !failed && !!item?.thumb && (isPicture || isVideo);

  const miniControls = props.mini && (
    <div className="p-mini" onPointerDown={(e) => e.stopPropagation()}>
      <div className="p-mini-row">
        <button type="button" className="pbtn" aria-label={halted ? 'Play' : 'Pause'} title={halted ? 'Play' : 'Pause'}
          onClick={() => setPaused((p) => !p)}>{halted ? <PlayIcon size={14} /> : <PauseIcon size={14} />}</button>
        <button type="button" className="pbtn" aria-label="Next" title="Next" onClick={() => go('next')}><NextIcon size={14} /></button>
        <button type="button" className="pbtn" aria-label={muted ? 'Sound on' : 'Mute'} title={muted ? 'Sound on' : 'Mute'}
          onClick={() => set({ muted: !s.muted })}>{muted ? <MuteIcon size={14} /> : <SoundIcon size={14} />}</button>
        <span className="p-mini-name ellipsis">{item?.name}</span>
        <button type="button" className="pbtn" aria-label="Back to the full view" title="Back to the full view" onClick={props.mini.onExpand}><ExpandIcon size={14} /></button>
        <button type="button" className="pbtn" aria-label="Close the mini player" title="Close" onClick={props.mini.onClose}><CloseIcon size={12} /></button>
      </div>
      {isVideo && time.dur > 0 ? (
        <div className="p-mini-bar" role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(time.dur)} aria-valuenow={Math.round(time.at)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seekTo(((e.clientX - r.left) / Math.max(1, r.width)) * time.dur);
          }}>
          <span style={{ width: `${Math.min(100, (time.at / time.dur) * 100)}%` }} />
        </div>
      ) : total > 1 && listRef.current && listRef.current.index() >= 0 ? (
        <div className="p-mini-bar static" aria-hidden="true">
          <span style={{ width: `${((listRef.current.index() + 1) / total) * 100}%` }} />
        </div>
      ) : null}
    </div>
  );

  const speedButton = (
    <div role="group" aria-label="Playback speed" className="seg">
      {SPEEDS.map((sp) => (
        <button key={sp} type="button" className={sp === s.speed ? 'on' : ''} disabled={item?.kind !== 'video'}
          onClick={() => set({ speed: sp })}>{sp === 1 ? '1×' : `${sp}×`}</button>
      ))}
    </div>
  );

  const timedTools = (isVideo || isGif) && !failed && (
    <>
      <span className="vsep" />
      <button type="button" className="pbtn" aria-label="One frame back" title="One frame back (Ctrl+←)" onClick={() => stepFrame(-1)}><FrameBackIcon /></button>
      <button type="button" className="pbtn" aria-label="One frame forward" title="One frame forward (Ctrl+→)" onClick={() => stepFrame(1)}><FrameNextIcon /></button>
      <div className="ab-group" role="group" aria-label="A–B loop">
        <LoopIcon size={14} />
        <button type="button" className={`ab${loop.a != null ? ' on' : ''}`} title="Loop start here (A)" onClick={() => setLoopPoint('a')}>A</button>
        <button type="button" className={`ab${loop.b != null ? ' on' : ''}`} title="Loop end here (B)" onClick={() => setLoopPoint('b')}>B</button>
        {(loop.a != null || loop.b != null) && (
          <button type="button" className="ab" title="Clear the loop (X)" aria-label="Clear the loop" onClick={clearLoop}><CloseIcon size={10} /></button>
        )}
      </div>
      {inVault && isVideo && (
        <div className="bm-wrap">
          <button type="button" className={`pbtn bm-toggle${bmOpen ? ' on' : ''}`} aria-label="Bookmarks" title="Bookmarks (K adds one here)"
            onClick={() => { setBmFocus(null); setBmOpen((o) => !o); }}>
            <BookmarkIcon />{bookmarks.length > 0 && <small>{bookmarks.length}</small>}
          </button>
          {bmOpen && (
            <BookmarksPanel list={bookmarks} at={time.at} focusId={bmFocus} onAdd={addBookmark} onChange={loadBookmarks}
              onJump={(ms) => seekTo(ms / 1000)} onClose={() => setBmOpen(false)} />
          )}
        </div>
      )}
      {inVault && (
        <button type="button" className="pbtn" aria-label="Save this frame as a picture" title="Save this frame as a picture (S)" onClick={saveFrame}><CameraIcon /></button>
      )}
      {inVault && isVideo && (
        <button type="button" className="pbtn" aria-label="Make a GIF" title="Make a GIF from part of this video" onClick={() => { setPaused(true); setGifMaker(true); }}><GifIcon /></button>
      )}
    </>
  );

  return (
    <div ref={rootRef} className={`player${props.compact ? ' compact' : ''}${showUi && !mini ? '' : ' idle'}${mini ? ' mini' : ''}${ambient ? ' ambient' : ''}`}
      onMouseMove={poke} onMouseDown={poke}>
      {ambient && item?.thumb && <div key={item.key} className="ambient-glow" style={{ backgroundImage: `url("${item.thumb}")` }} aria-hidden="true" />}
      <div ref={stageRef} className={`stage${isDoc ? ' doc' : ''}${zoomed ? ' zoomed' : ''}`} onPointerDown={onStagePointerDown}
        onContextMenu={(e) => {
          e.preventDefault();
          if (panMoved.current) {
            panMoved.current = false;
            return;
          }
          if (faceCapable) setMenu({ x: e.clientX, y: e.clientY });
        }}>
        {isDoc ? media : (
          <div ref={kbRef} className="kb-layer">
            {isPicture && item && !failed ? (
              <ImageStage key={item.key + tick} ref={imgRef} src={item.src} kind={isGif ? 'gif' : 'image'} name={item.name} fit={s.fit} zoom={zoom}
                prefs={prefs} paused={halted} className={anim}
                onInfo={setImgInfo} onFrame={(i, n) => setGifFrame({ index: i, count: n })} onError={() => setFailed(true)} />
            ) : (
              <div className="zoom-layer" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` }}>{media}</div>
            )}
            {drawn && shownFaces.length > 0 && (
              <FaceLayer faces={shownFaces} rect={drawn} onShowPerson={props.onShowPerson}
                onChanged={() => setFaceReload((n) => n + 1)} onMessage={setFlash} />
            )}
          </div>
        )}
        {align.ghost}
        {!item && <div className="media-failed">Nothing to play here.</div>}
        {drawing && <div className="zoom-rect drawing" style={{ left: drawing.x, top: drawing.y, width: drawing.w, height: drawing.h }} />}
        {rect && !drawing && (
          <div className="zoom-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
            <span>Click inside to zoom</span>
          </div>
        )}
      </div>
      {!mini && (zoomed || (isDoc && Math.abs(docZoom - 1) > 0.01)) && (
        <button type="button" className="zoom-badge" onClick={() => { setZoom({ s: 1, x: 0, y: 0 }); setDocZoom(1); }}
          title="Reset zoom (0)">
          {Math.round((isDoc ? docZoom : zoom.s) * 100)}%{!isDoc && !prefs.smoothZoom ? ' · crisp' : ''} · Reset
        </button>
      )}
      {flash && <div className="p-flash" role="status">{flash}</div>}
      {resumed != null && !mini && (
        <div className="resume-chip" role="status">
          Resumed at {formatTime(resumed * 1000)} ·{' '}
          <button type="button" className="link" onClick={() => { seekTo(0); setResumed(null); }}>Start over</button>
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} title={item?.name} onClose={() => setMenu(null)} items={[
          { label: 'Show faces', hint: 'for a moment', onSelect: () => { setMenu(null); flashFaces(); } },
          { label: `Look for faces in this ${what}`, onSelect: () => { setMenu(null); scanFaces(); } },
          { label: 'Always show face boxes', checked: prefs.faceBoxes, sepBefore: true, onSelect: () => { setMenu(null); setFaceBoxes(!prefs.faceBoxes); } },
        ]} />
      )}
      {miniControls}

      {!props.compact && !mini && (
        <div className="p-top">
          <div className="p-title">
            {props.title}
            {item && (
              <>
                <span className="p-name">{item.name}</span>
                <span className="faint">{index >= 0 ? `${index + 1} of ${total}` : `${orderLabel} · ${total} files`}</span>
                {props.subtitle?.(item)}
              </>
            )}
          </div>
          <div className="row">
            {item?.itemId != null && props.onWeight && (
              <Dropdown className="btn btn-sm glass" label={<>Weight {weight}</>} title="How often this file comes up in Weighted random"
                items={WEIGHTS.map((w) => ({ label: String(w), hint: w === 0 ? 'never' : w === 1 ? 'normal' : undefined, checked: w === weight, onSelect: () => {
                  setOverrides((o) => ({ ...o, [item.key]: { ...o[item.key], weight: w } }));
                  if (cur) cur.weight = w; // the play order uses the new weight right away
                  props.onWeight!(item, w);
                } }))} />
            )}
            {item?.itemId != null && props.onFavourite && (
              <button type="button" className={`btn btn-icon glass${fav ? ' accent' : ''}`} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'}
                aria-pressed={fav} onClick={() => {
                  setOverrides((o) => ({ ...o, [item.key]: { ...o[item.key], favourite: !fav } }));
                  props.onFavourite!(item, !fav);
                }}><HeartIcon filled={fav} size={18} /></button>
            )}
            <ScalingMenu prefs={prefs} />
            {props.topRight}
            {props.keys && (
              <button type="button" className="btn btn-icon btn-sm glass" aria-label="Shortcuts" title="Keyboard and mouse shortcuts (?)" onClick={() => setHelp(true)}>
                <HelpIcon />
              </button>
            )}
          </div>
        </div>
      )}

      {props.bare || mini ? null : props.compact ? (
        <>
          <div className="p-badges">
            {props.title}
            <span className="chip-dark mono">{item ? `${item.kind.toUpperCase()}${item.kind === 'video' && s.speed !== 1 ? ` ${s.speed}×` : ''}` : ''}</span>
          </div>
          <button type="button" className={`p-sound${muted ? '' : ' on'}`} aria-label={muted ? 'Muted — click to turn sound on' : 'Sound on — click to mute'}
            onClick={() => set({ muted: !s.muted })}>{muted ? <MuteIcon /> : <SoundIcon />}</button>
          <div className="p-bottom">
            {timeline}
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="pbtn" aria-label="Previous" title="Previous" onClick={() => go('prev')}><PrevIcon size={14} /></button>
              <button type="button" className="pbtn main" aria-label={slideshow && !paused ? 'Pause' : 'Play'} onClick={() => {
                if (slideshow && !paused) setPaused(true);
                else { setSlideshow(true); setPaused(false); }
              }}>{slideshow && !paused ? <PauseIcon size={14} /> : <PlayIcon size={14} />}</button>
              <button type="button" className="pbtn" aria-label="Next" title="Next" onClick={() => go('next')}><NextIcon size={14} /></button>
              <Dropdown up className={`pbtn${s.order === 'shuffle' || s.order === 'random' || s.order === 'weighted' ? ' on' : ''}`}
                ariaLabel={`Order: ${orderLabel}`} title={`Order: ${orderLabel}`} label={<ShuffleIcon size={14} />} items={orderItems} />
              <button type="button" className={`pbtn${s.repeat !== 'off' ? ' on' : ''}`} aria-label={`Repeat: ${s.repeat}`} title={`Repeat: ${s.repeat}`}
                onClick={cycleRepeat}><RepeatIcon size={14} />{s.repeat === 'one' && <small>1</small>}</button>
              <button type="button" className="pbtn mono" aria-label="Playback speed" title="Speed (videos)" onClick={cycleSpeed}>{s.speed}×</button>
              <input type="range" min={0} max={1} step={0.01} value={s.volume} aria-label="Volume" className="vol"
                onChange={(e) => set({ volume: Number(e.target.value), muted: false })} />
              {props.panelExtra}
            </div>
          </div>
        </>
      ) : (
        <div className="p-controls">
          {timeline}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="pbtn lg" aria-label="Previous" title={isVideo || isGif ? 'Previous (Shift+Space)' : 'Previous (←)'} onClick={() => go('prev')}><PrevIcon /></button>
            <button type="button" className="btn btn-primary slideshow" aria-pressed={slideshow && !paused} onClick={toggleSlideshow}
              title={isVideo || isGif ? 'Slideshow' : 'Slideshow (Space)'}>
              {slideshow && !paused ? <PauseIcon /> : <PlayIcon />} Slideshow
            </button>
            <button type="button" className="pbtn lg" aria-label="Next" title={isVideo || isGif ? 'Next (Ctrl+Space)' : 'Next (→)'} onClick={() => go('next')}><NextIcon /></button>
            {(isVideo || isGif) && !slideshow && (
              <button type="button" className="pbtn lg" aria-label={paused ? 'Play' : 'Pause'} title={paused ? 'Play (Space)' : 'Pause (Space)'} onClick={() => setPaused((p) => !p)}>
                {paused ? <PlayIcon /> : <PauseIcon />}
              </button>
            )}
            {timedTools}
            <span className="vsep" />
            {/* With the video tools showing, order and repeat shrink to icons (names in the tooltip). */}
            <Dropdown up className={`btn btn-sm glass${s.order === 'shuffle' || s.order === 'random' || s.order === 'weighted' ? ' accent-soft' : ''}`}
              label={<><ShuffleIcon />{timedTools ? '' : ` ${orderLabel}`}</>} title={`Order: ${orderLabel}`} ariaLabel={`Order: ${orderLabel}`} items={orderItems} />
            <button type="button" className={`btn btn-sm glass${s.repeat !== 'off' ? ' accent-soft' : ''}`} onClick={cycleRepeat}
              title={`${s.repeat === 'off' ? 'Repeat off' : s.repeat === 'all' ? 'Repeat all' : 'Repeat one'} (off → all → one)`}
              aria-label={s.repeat === 'off' ? 'Repeat off' : s.repeat === 'all' ? 'Repeat all' : 'Repeat one'}>
              <RepeatIcon />{timedTools ? (s.repeat === 'one' ? ' 1' : '') : ` ${s.repeat === 'off' ? 'Repeat off' : s.repeat === 'all' ? 'Repeat all' : 'Repeat one'}`}
            </button>
            {speedButton}
            {beatBadge}
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              {faceCapable && (
                <button type="button" className={`pbtn lg${prefs.faceBoxes ? ' on' : ''}`} aria-pressed={prefs.faceBoxes}
                  aria-label="Face boxes" title={prefs.faceBoxes ? 'Hide face boxes' : 'Show boxes around faces'} onClick={() => setFaceBoxes(!prefs.faceBoxes)}>
                  <FaceIcon size={18} />
                </button>
              )}
              <button type="button" className="pbtn lg" aria-label={muted ? `Unmute (${muteKey})` : `Mute (${muteKey})`}
                title={beatQuiet ? 'Slideshow videos stay muted while the slideshow follows the beat' : muted ? `Unmute (${muteKey})` : `Mute (${muteKey})`}
                onClick={() => set({ muted: !s.muted })}>
                {muted ? <MuteIcon /> : <SoundIcon />}
              </button>
              <input type="range" min={0} max={1} step={0.01} value={s.volume} aria-label="Volume" className="vol"
                onChange={(e) => set({ volume: Number(e.target.value), muted: false })} />
              {props.onMinimize && (
                <button type="button" className="pbtn lg" aria-label="Mini player (M)" title="Mini player: keep watching in a corner while you browse (M)" onClick={props.onMinimize}>
                  <MiniPlayerIcon />
                </button>
              )}
              {props.onFullscreen && (
                <button type="button" className="pbtn lg" aria-label="Clean full screen (F)" title="Clean full screen (F)" onClick={props.onFullscreen}>
                  <FullscreenIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {gifMaker && item && isVideo && (
        <GifMakerDialog name={item.name} src={item.src} folder={item.folderId} at={time.at} dur={time.dur} loop={loop}
          videoWidth={videoRef.current?.videoWidth ?? 480} onClose={() => setGifMaker(false)}
          onSaved={(n) => { kickThumbnails(); setFlash(`Saved “${n}” in this folder`); }} />
      )}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
