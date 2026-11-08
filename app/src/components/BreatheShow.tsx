// Breathe mode: a calm slideshow in one to four frames that slowly breathe
// (grow and shrink a little, each a bit out of step), with a soft glow that
// breathes with them. Each frame shows its picture for a while, then crossfades
// to the next (by weight, no repeats on screen). With "Beat like a heart" it
// listens to the music playing on the PC: every beat gives each frame a
// "lub-dub", and the slideshow can move on every 4 or 8 beats. With no music
// it simply breathes on its own timer. Double-click a frame to watch it alone.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type BeatEvent } from '../api';
import { BeatCounter, useBeatSync } from '../beats';
import {
  BREATHE_BEAT_EVERY, BREATHE_LAYOUTS, BREATHE_SPEEDS, breatheBoxes, breatheStay, changeGap, FADE_MS, frameCount,
  frameScale, oldestFrame, playingVideos, type BeatHit, type BreatheSettings,
} from '../breathe';
import type { PlayItem } from '../media';
import { BeatStatusLine } from './BeatStatus';
import { BlurBackdrop } from './BlurBackdrop';
import { Dropdown } from './Dialogs';
import { HeartIcon, MuteIcon, SoundIcon } from './Icons';
import { pickWeighted } from './Wall';
import './breathe.css';

interface Slide {
  gen: number;
  item: PlayItem;
}
interface Frame {
  cur: Slide | null;
  /** The picture fading out underneath. */
  prev: Slide | null;
}

const noop = () => {};
/** Never move on with the music sooner than this after the last change (s). */
const MIN_BEAT_CHANGE = 1.6;

let beatsOk: Promise<boolean> | null = null;
/** Whether this PC can listen for beats (Windows). */
function useBeatsSupported(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    beatsOk ??= api.beatsSupported().catch(() => false);
    beatsOk.then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

export function BreatheShow(props: {
  items: PlayItem[];
  settings: BreatheSettings;
  volume: number;
  paused: boolean;
  /** Show the small "listening" line (when the top bar shows). */
  showStatus: boolean;
  onOpen: (item: PlayItem) => void;
}) {
  const s = props.settings;
  const count = frameCount(s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [frames, setFrames] = useState<Frame[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const stopped = props.paused || hidden;
  const gen = useRef(1);
  const since = useRef<number[]>([]);
  const frameEls = useRef<(HTMLDivElement | null)[]>([]);
  const glowEls = useRef<(HTMLDivElement | null)[]>([]);
  const hits = useRef<BeatHit[]>([]);
  const counter = useRef(new BeatCounter(performance.now()));
  const supported = useBeatsSupported();
  const heart = s.heart && supported;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((z) => (z.w === el.clientWidth && z.h === el.clientHeight ? z : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  // A fresh set of pictures when the source or the number of frames changes.
  useEffect(() => {
    const shown = new Set<string>();
    const next: Frame[] = [];
    for (let i = 0; i < count; i++) {
      const it = pickWeighted(props.items, shown);
      if (it) shown.add(it.key);
      next.push({ cur: it ? { gen: gen.current++, item: it } : null, prev: null });
    }
    // Start the frames' clocks a little apart so they don't all change at once.
    const now = Date.now();
    since.current = next.map((_, i) => now - (i * changeGap(breatheStay(s.speed), count)));
    setFrames(next);
  }, [props.items, count]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The frame that has shown its picture the longest gets a new one. */
  const advance = useCallback(() => {
    setFrames((cur) => {
      if (!cur.length) return cur;
      const i = oldestFrame(since.current);
      const it = pickWeighted(props.items, new Set(cur.map((f) => f.cur?.item.key ?? '')));
      if (!it) return cur;
      since.current[i] = Date.now();
      return cur.map((f, j) => (j === i ? { cur: { gen: gen.current++, item: it }, prev: f.cur } : f));
    });
  }, [props.items]);
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  // The picture underneath is dropped once the new one has faded in.
  useEffect(() => {
    if (!frames.some((f) => f.prev)) return;
    const t = setTimeout(() => setFrames((cur) => cur.map((f) => (f.prev ? { ...f, prev: null } : f))), FADE_MS + 150);
    return () => clearTimeout(t);
  }, [frames]);

  // ---- the music ----------------------------------------------------------------------------
  const live = useRef({ stopped, beatEvery: s.beatEvery });
  live.current = { stopped, beatEvery: s.beatEvery };
  const onBeat = useCallback((b: BeatEvent) => {
    if (live.current.stopped) return;
    const now = performance.now();
    hits.current = [...hits.current.filter((h) => now - h.at < 1300), { at: now, strength: b.strength }];
    const every = live.current.beatEvery;
    if (every > 0 && counter.current.beat(now, every, MIN_BEAT_CHANGE)) advanceRef.current();
  }, []);
  const beat = useBeatSync({ enabled: heart, everyBeats: 1, minSeconds: 0, onAdvance: noop, onBeat });
  const beating = heart && !beat.silent;
  const byMusic = beating && s.beatEvery > 0;
  useEffect(() => counter.current.reset(performance.now()), [byMusic, s.beatEvery]);

  // ---- the slideshow's own timer (also when the music stops) -----------------------------
  const stay = breatheStay(s.speed);
  useEffect(() => {
    if (stopped || byMusic || !frames.length || !props.items.length) return;
    const gap = changeGap(stay, frames.length);
    const due = Math.min(...since.current) + stay * 1000;
    const wait = Math.max(FADE_MS, Math.min(gap * 1.5, due - Date.now())) * (0.9 + Math.random() * 0.2);
    const t = setTimeout(advance, wait);
    return () => clearTimeout(t);
  }, [frames, stopped, byMusic, stay, advance, props.items.length]);

  // ---- breathing (and beating): one animation loop moves every frame -------------------
  const beatingRef = useRef(beating);
  beatingRef.current = beating;
  const clock = useRef({ offset: 0, pausedAt: 0 });
  useEffect(() => {
    if (stopped) {
      clock.current.pausedAt = performance.now();
      return;
    }
    if (clock.current.pausedAt) {
      const away = performance.now() - clock.current.pausedAt;
      clock.current.offset += away;
      // The pictures' time on screen does not count while paused.
      since.current = since.current.map((x) => x + away);
      clock.current.pausedAt = 0;
    }
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const t = now - clock.current.offset;
      for (let i = 0; i < frameEls.current.length; i++) {
        const el = frameEls.current[i];
        if (!el) continue;
        // Beats are timed on the real clock (they arrive in real time).
        const { scale, glow } = frameScale(t, i, hits.current.map((h) => ({ ...h, at: h.at - clock.current.offset })), beatingRef.current);
        el.style.transform = `scale(${scale.toFixed(4)})`;
        const g = glowEls.current[i];
        if (g) {
          g.style.transform = `scale(${scale.toFixed(4)})`;
          g.style.opacity = glow.toFixed(3);
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [stopped]);

  // ---- videos -------------------------------------------------------------------------------
  const playing = useMemo(() => playingVideos(frames.map((f) => f.cur?.item.kind)), [frames]);
  const soundFrame = s.sound ? (hover != null && playing.has(hover) ? hover : [...playing][0] ?? null) : null;
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLVideoElement>('video[data-play]').forEach((v) => (stopped ? v.pause() : v.play().catch(() => {})));
  }, [stopped, frames]);

  const boxes = useMemo(() => breatheBoxes(s.layout, size.w, size.h), [s.layout, size.w, size.h]);
  return (
    <div ref={ref} className={`breathe${beating ? ' beating' : ''} l-${s.layout}`} onPointerLeave={() => setHover(null)}>
      {frames.map((f, i) => {
        const b = boxes[i];
        if (!b) return null;
        const pos = { left: b.x, top: b.y, width: b.w, height: b.h };
        return [
          <div key={`g${i}`} className="breathe-glow" style={pos} ref={(el) => { glowEls.current[i] = el; }} aria-hidden="true" />,
          <div key={`f${i}`} className={`breathe-frame${hover === i ? ' hover' : ''}`} style={pos} ref={(el) => { frameEls.current[i] = el; }}
            title={f.cur ? `${f.cur.item.name} — double-click to watch it alone` : undefined}
            onPointerEnter={() => setHover(i)} onDoubleClick={() => f.cur && props.onOpen(f.cur.item)}>
            {[f.prev, f.cur].map((sl, k) => sl && (
              <SlideView key={sl.gen} slide={sl} entering={k === 1 && !!f.prev} play={playing.has(i) || k === 0}
                muted={soundFrame !== i || k === 0 || stopped} volume={props.volume} stopped={stopped} />
            ))}
          </div>,
        ];
      })}
      {s.heart && props.showStatus && supported && (
        <div className="breathe-status">
          <BeatStatusLine on />
          {beat.silent && <span className="faint">No music heard — breathing calmly until there is.</span>}
        </div>
      )}
    </div>
  );
}

function SlideView(props: { slide: Slide; entering: boolean; play: boolean; muted: boolean; volume: number; stopped: boolean }) {
  const v = useRef<HTMLVideoElement>(null);
  const it = props.slide.item;
  const video = it.kind === 'video';
  const still = video && !props.play && !!it.thumb;
  let media: ReactNode;
  if (video && !still)
    media = props.play ? (
      <video ref={v} data-play src={it.src} loop autoPlay={!props.stopped} playsInline preload="auto" muted={props.muted}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.volume = Math.max(0, Math.min(1, props.volume));
          if (Number.isFinite(el.duration) && el.duration > 8) el.currentTime = Math.random() * (el.duration - 6);
        }} />
    ) : <video ref={v} src={it.src} muted playsInline preload="metadata" />;
  else media = <img src={still ? it.thumb! : it.src} alt="" draggable={false} />;
  useEffect(() => {
    if (v.current) v.current.volume = Math.max(0, Math.min(1, props.volume));
  }, [props.volume]);
  return (
    <div className={`breathe-slide${props.entering ? ' entering' : ''}`}>
      <BlurBackdrop kind={video && !still ? 'video' : it.kind === 'gif' ? 'gif' : 'image'} src={still ? it.thumb! : it.src} thumb={it.thumb}
        video={v} running={props.play && !props.stopped} />
      {media}
    </div>
  );
}

/** Breathe's settings in the top bar: layout, speed, the heartbeat, sound, and what it shows. */
export function BreatheControls(props: { s: BreatheSettings; set: (patch: Partial<BreatheSettings>) => void; source: ReactNode }) {
  const { s, set } = props;
  const supported = useBeatsSupported();
  return (
    <>
      <Dropdown label={`${BREATHE_LAYOUTS.find((l) => l.id === s.layout)?.label} ▾`} title="How many frames, and how they sit"
        items={BREATHE_LAYOUTS.map((l) => ({ label: l.label, hint: l.hint, checked: l.id === s.layout, onSelect: () => set({ layout: l.id }) }))} />
      <Dropdown label={`${BREATHE_SPEEDS.find((x) => x.id === s.speed)?.label} ▾`} title="How long each picture stays"
        items={BREATHE_SPEEDS.map((x) => ({ label: x.label, hint: `each stays about ${x.stay} s`, checked: x.id === s.speed, onSelect: () => set({ speed: x.id }) }))} />
      {supported && (
        <button type="button" className={`btn btn-sm${s.heart ? ' accent-soft' : ''}`} aria-pressed={s.heart} onClick={() => set({ heart: !s.heart })}
          title={s.heart ? 'Beating with the music playing on this PC — click to just breathe' : 'Beat like a heart: pulse with the music playing on this PC'}>
          <HeartIcon size={14} filled={s.heart} /> Beat like a heart
        </button>
      )}
      {supported && s.heart && (
        <Dropdown label={`${s.beatEvery ? `Every ${s.beatEvery} beats` : 'Own pace'} ▾`} title="When the pictures change while music plays"
          items={BREATHE_BEAT_EVERY.map((x) => ({ label: x.label, hint: x.hint, checked: x.id === s.beatEvery, onSelect: () => set({ beatEvery: x.id }) }))} />
      )}
      <button type="button" className={`btn btn-sm${s.sound ? ' accent-soft' : ''}`} aria-pressed={s.sound} onClick={() => set({ sound: !s.sound })}
        title={s.sound ? 'Videos play with sound (the one under the mouse) — click to mute' : 'Videos are muted — click to hear them'}>
        {s.sound ? <><SoundIcon size={15} /> Sound on</> : <><MuteIcon size={15} /> Sound off</>}
      </button>
      {props.source}
    </>
  );
}
