// A playing video tile: thumbnail → flip-book → tiny clip → real video, each
// taking over (with a short fade) once its first picture is actually on
// screen, so there is never a black flash. Players come from a shared pool
// (videopool.ts) and rest when the library can't be seen (previewgate.ts).
// Which layer a tile wants comes from the grid (previewplan.ts).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { mediaUrl, previewUrl, tinyUrl } from '../api';
import { CLIP_FPS, FRAMES, frameTimes, playClip, stopClip, tinyToSource } from '../previews';
import { PlayerPool } from '../videopool';
import { Budget, type Layer } from '../previewplan';
import { onPreviewsPaused, previewsPaused } from '../previewgate';

// ---- the player pool ------------------------------------------------------------------------

function makePlayer(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.loop = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.disablePictureInPicture = true;
  v.setAttribute('aria-hidden', 'true');
  v.dataset.gated = '1';
  return v;
}

export const players = new PlayerPool<HTMLVideoElement>(makePlayer);
onPreviewsPaused((p) => (p ? players.pauseAll() : players.resumeAll()));
if (previewsPaused()) players.pauseAll();

/** For measurements in dev tools: `__mvPool.stats`. */
(globalThis as unknown as { __mvPool?: PlayerPool<HTMLVideoElement> }).__mvPool = players;

// ---- watching how well the real videos play ------------------------------------------------------

const budget = new Budget(2);
let budgetNow = budget.budget;
const budgetSubs = new Set<() => void>();
let wanted = 0;
let realAsked = 0;
const lastQ = new WeakMap<HTMLVideoElement, { total: number; dropped: number }>();
let monitoring = false;

/** The grid says how many tiles play and how many of them it gave the real video. */
export function reportPlan(playing: number, real: number) {
  wanted = playing;
  realAsked = real;
  startMonitor();
}

export function useRealBudget(): number {
  return useSyncExternalStore(
    (cb) => {
      budgetSubs.add(cb);
      startMonitor();
      return () => budgetSubs.delete(cb);
    },
    () => budgetNow,
  );
}

function startMonitor() {
  if (monitoring || typeof requestAnimationFrame === 'undefined') return;
  monitoring = true;
  let last = performance.now();
  let frames = 0;
  let slow = 0;
  let sum = 0;
  let windowStart = last;
  const loop = (now: number) => {
    const dt = now - last;
    last = now;
    const watching = wanted > 0 && !previewsPaused() && document.visibilityState === 'visible';
    if (dt < 1000 && watching) {
      frames++;
      sum += dt;
      if (dt > 50) slow++;
    }
    if (now - windowStart >= 2000) {
      if (watching && frames > 10) {
        let total = 0;
        let dropped = 0;
        for (const v of players.inUse()) {
          if (v.dataset.layer !== 'real') continue;
          const q = v.getVideoPlaybackQuality?.();
          if (!q) continue;
          const prev = lastQ.get(v);
          // A reused player starts counting afresh.
          if (prev && q.totalVideoFrames >= prev.total) {
            total += q.totalVideoFrames - prev.total;
            dropped += Math.max(0, q.droppedVideoFrames - prev.dropped);
          }
          lastQ.set(v, { total: q.totalVideoFrames, dropped: q.droppedVideoFrames });
        }
        const b = budget.look({ real: realAsked, wanted, frames: total, dropped, slowShare: slow / frames, avgFrameMs: sum / frames }, now);
        if (b !== budgetNow) {
          budgetNow = b;
          budgetSubs.forEach((s) => s());
        }
      }
      frames = 0;
      slow = 0;
      sum = 0;
      windowStart = now;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---- one pooled player inside a layer ---------------------------------------------------------------

/** Calls `onReady` once the first picture of `src` has been drawn. */
function PooledVideo(props: { src: string; role: 'tiny' | 'real' | 'card'; startAt?: () => number; onReady: (v: HTMLVideoElement) => void; fit?: 'cover' | 'contain' }) {
  const slot = useRef<HTMLSpanElement>(null);
  const ready = useRef(props.onReady);
  ready.current = props.onReady;
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    const v = players.acquire(props.src);
    v.dataset.layer = props.role;
    v.style.objectFit = props.fit ?? 'cover';
    let alive = true;
    const warm = v.src === props.src && v.readyState >= 1;
    if (!warm) v.src = props.src;
    const seekTo = () => {
      const t = props.startAt?.();
      if (t != null && Number.isFinite(t) && t > 0.05 && Number.isFinite(v.duration)) {
        try {
          v.currentTime = Math.min(t, Math.max(0, v.duration - 0.2));
        } catch {
          // not seekable yet
        }
      }
    };
    if (v.readyState >= 1) seekTo();
    else v.addEventListener('loadedmetadata', seekTo, { once: true });
    el.appendChild(v);
    const done = () => {
      if (alive) ready.current(v);
    };
    if (typeof v.requestVideoFrameCallback === 'function') {
      v.requestVideoFrameCallback(() => done());
    } else {
      v.addEventListener('playing', () => requestAnimationFrame(() => requestAnimationFrame(done)), { once: true });
    }
    players.play(v);
    return () => {
      alive = false;
      v.removeEventListener('loadedmetadata', seekTo);
      players.release(v);
    };
  }, [props.src]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={slot} className="vslot" />;
}

// ---- flip-book --------------------------------------------------------------------------------------

/** A frame strip played as a flip-book, covering the tile like the video would. */
export function FlipBook(props: { id: number; w: number; h: number; aspect: number }) {
  const w = Math.max(props.w, props.h * props.aspect);
  const h = w / props.aspect;
  return (
    <span className="clip-frame" aria-hidden="true">
      <span className="clip" style={{ width: w, height: h, left: (props.w - w) / 2, top: (props.h - h) / 2, backgroundImage: `url("${previewUrl(props.id)}")` }}
        ref={(el) => {
          playClip(el);
          return () => {
            if (el) stopClip(el);
          };
        }} />
    </span>
  );
}

/** The video moment the flip-book shows right now (to carry on from there). */
function flipTime(duration: number): number {
  const i = Math.floor(performance.now() / (1000 / CLIP_FPS)) % FRAMES;
  return frameTimes(duration)[i] ?? 0;
}

// ---- a playing tile ----------------------------------------------------------------------------------

const ORDER: Layer[] = ['flip', 'tiny', 'real'];
const FADE_MS = 240;

export function VideoPreview(props: {
  id: number;
  /** What the tile should show now. */
  layer: Layer;
  hasStrip: boolean;
  hasTiny: boolean;
  durationMs: number | null;
  w: number;
  h: number;
  aspect: number;
  fit?: 'cover' | 'contain';
}) {
  // `top`: the layer on screen; `under`: the one it replaced, kept for the fade.
  const [top, setTop] = useState<Layer>('thumb');
  const [under, setUnder] = useState<Layer | null>(null);
  const [ready, setReady] = useState<Set<Layer>>(() => new Set());
  const tinyEl = useRef<HTMLVideoElement | null>(null);
  const want = props.layer;
  const duration = (props.durationMs ?? 0) / 1000;

  // The wanted layer is ready: it fades in over the old one, which then goes.
  useEffect(() => {
    if (want === top) return;
    if (want !== 'thumb' && !ready.has(want)) return;
    setUnder(top === 'thumb' ? null : top);
    setTop(want);
    const t = setTimeout(() => setUnder(null), FADE_MS + 40);
    return () => clearTimeout(t);
  }, [want, ready, top]);

  const markReady = (l: Layer) => setReady((r) => (r.has(l) ? r : new Set(r).add(l)));
  const unready = (l: Layer) => setReady((r) => {
    if (!r.has(l)) return r;
    const n = new Set(r);
    n.delete(l);
    return n;
  });
  // A layer that goes away must show its first picture again before it counts as ready.
  const mounted = new Set<Layer>([want, top, ...(under ? [under] : [])].filter((l) => l !== 'thumb'));
  const mountedKey = ORDER.filter((l) => mounted.has(l)).join(',');
  useEffect(() => {
    for (const l of ORDER) if (!mounted.has(l)) unready(l);
  }, [mountedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const z = (l: Layer) => (l === want && l !== top ? 3 : l === top ? 2 : 1);
  const cls = (l: Layer) => `vlayer${ready.has(l) ? ' ready' : ''}`;
  const realStart = () => {
    const tv = tinyEl.current;
    if (top === 'tiny' && tv && tv.isConnected && Number.isFinite(tv.currentTime)) return tinyToSource(tv.currentTime + 0.35, duration);
    if (top === 'flip') return flipTime(duration);
    return 0;
  };
  return (
    <span className="vstack" aria-hidden="true">
      {mounted.has('flip') && props.hasStrip && (
        <span className={cls('flip')} style={{ zIndex: z('flip') }} ref={(el) => { if (el) markReady('flip'); }}>
          <FlipBook id={props.id} w={props.w} h={props.h} aspect={props.aspect} />
        </span>
      )}
      {mounted.has('tiny') && props.hasTiny && (
        <span className={cls('tiny')} style={{ zIndex: z('tiny') }}>
          <PooledVideo src={tinyUrl(props.id)} role="tiny" fit={props.fit}
            onReady={(v) => {
              tinyEl.current = v;
              markReady('tiny');
            }} />
        </span>
      )}
      {mounted.has('real') && (
        <span className={cls('real')} style={{ zIndex: z('real') }}>
          <PooledVideo src={mediaUrl(props.id)} role="real" fit={props.fit} startAt={realStart} onReady={() => markReady('real')} />
        </span>
      )}
    </span>
  );
}

/** A folder card's video cover: the still stays until the video's first picture is drawn. */
export function CoverVideo(props: { id: number }) {
  const [shown, setShown] = useState(false);
  return (
    <span className={`vlayer${shown ? ' ready' : ''}`} aria-hidden="true">
      <PooledVideo src={mediaUrl(props.id)} role="card" onReady={() => setShown(true)} />
    </span>
  );
}
