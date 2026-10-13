// One player for pictures, GIFs / animated WebP, videos, text and PDF. Used
// by the full viewer, each multi-screen panel, and the player outside the vault.
//
// Mouse: wheel = next / previous (scrolls inside text and PDF), Ctrl+wheel =
// zoom, drag = draw a rectangle (click inside it to zoom to it, outside to
// dismiss), right-drag = move the zoomed picture, 0 = reset zoom.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { setPlaying as reportPlaying } from '../activity';
import { animationMs, formatTime, type PlayItem } from '../media';
import { ORDERS, Playlist, type Order, type Repeat } from '../playlist';
import { gifShowMs, SPEEDS, type PlaybackSettings } from '../presets';
import { Dropdown } from './Dialogs';
import { PdfView, TextView } from './DocViews';
import {
  BrokenIcon, FullscreenIcon, HeartIcon, MuteIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon, RepeatIcon, ShuffleIcon, SoundIcon,
} from './Icons';

export interface PlayerHandle {
  setPaused: (paused: boolean) => void;
  next: () => void;
  prev: () => void;
  toggleMute: () => void;
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
  onCurrent?: (item: PlayItem | null) => void;
  ref?: Ref<PlayerHandle>;
}

const WEIGHTS = [0, 0.5, 1, 2, 3, 5, 10];

export function Player(props: PlayerProps) {
  const { settings: s, onSettings } = props;
  const listRef = useRef<Playlist<PlayItem> | null>(null);
  const [cur, setCur] = useState<PlayItem | null>(null);
  const [tick, setTick] = useState(0); // bumps when the same item restarts
  const [paused, setPaused] = useState(false);
  const [slideshow, setSlideshow] = useState(!!props.autoSlideshow);
  const [overrides, setOverrides] = useState<Record<string, Partial<PlayItem>>>({});
  const [failed, setFailed] = useState(false);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifMs, setGifMs] = useState(0);
  const [time, setTime] = useState({ at: 0, dur: 0 });
  const [controls, setControls] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const videoStart = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 });
  const [docZoom, setDocZoom] = useState(1);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drawing, setDrawing] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const lastWheel = useRef(0);
  const zoomed = zoom.s > 1.001;

  const item = cur ? { ...cur, ...overrides[cur.key] } : null;

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

  // A new item starts unzoomed.
  useEffect(() => {
    setZoom({ s: 1, x: 0, y: 0 });
    setRect(null);
    setDrawing(null);
  }, [item?.key]);

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

  // GIFs: read the file once (in memory) to learn how long one loop lasts.
  useEffect(() => {
    setGifUrl(null);
    setGifMs(0);
    if (!item || item.kind !== 'gif') return;
    let url: string | null = null;
    let cancelled = false;
    fetch(item.src)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        if (cancelled) return;
        const bytes = new Uint8Array(buf);
        setGifMs(animationMs(bytes));
        url = URL.createObjectURL(new Blob([bytes], { type: item.name.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/gif' }));
        setGifUrl(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item?.key, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pictures and GIFs advance on a timer while the slideshow runs.
  useEffect(() => {
    if (!item || !slideshow || paused || zoomed) return;
    let ms = 0;
    if (failed) ms = 1500;
    else if (item.kind === 'image' || item.kind === 'text' || item.kind === 'pdf') ms = s.imageSeconds * 1000;
    else if (item.kind === 'gif') {
      if (!gifUrl) return;
      ms = gifShowMs(s, gifMs);
    } else return;
    const t = setTimeout(() => go('next', true), ms);
    return () => clearTimeout(t);
  }, [item?.key, tick, slideshow, paused, zoomed, failed, gifUrl, gifMs, s.imageSeconds, s.gifLoops, s.gifMaxSeconds, go]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- zoom, rectangle zoom, panning, wheel ---------------------------------------------

  const isDoc = item?.kind === 'text' || item?.kind === 'pdf';
  const stageSize = () => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, w: r.width, h: r.height } : { left: 0, top: 0, w: 1, h: 1 };
  };
  const clampZoom = (z: { s: number; x: number; y: number }) => {
    const { w, h } = stageSize();
    const sc = Math.min(40, Math.max(1, z.s));
    if (sc <= 1.001) return { s: 1, x: 0, y: 0 };
    // Keep at least part of the picture on screen.
    return { s: sc, x: Math.min(w * 0.5, Math.max(w * 0.5 - w * sc, z.x)), y: Math.min(h * 0.5, Math.max(h * 0.5 - h * sc, z.y)) };
  };
  const zoomAt = (px: number, py: number, factor: number) =>
    setZoom((z) => {
      const ns = Math.min(40, Math.max(1, z.s * factor));
      const k = ns / z.s;
      return clampZoom({ s: ns, x: px - (px - z.x) * k, y: py - (py - z.y) * k });
    });
  const zoomToRect = (r: { x: number; y: number; w: number; h: number }) =>
    setZoom((z) => {
      const { w, h } = stageSize();
      const k = Math.min(w / r.w, h / r.h);
      const ns = Math.min(40, z.s * k);
      const cx = (r.x + r.w / 2 - z.x) / z.s;
      const cy = (r.y + r.h / 2 - z.y) / z.s;
      return clampZoom({ s: ns, x: w / 2 - ns * cx, y: h / 2 - ns * cy });
    });

  // Wheel needs a non-passive listener so Ctrl+wheel doesn't zoom the whole window.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
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
    if (!item || isDoc || failed) return;
    const st = stageSize();
    const x0 = e.clientX - st.left;
    const y0 = e.clientY - st.top;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    if (e.button === 2) {
      // Right button: move the zoomed picture.
      if (!zoomed) return;
      let lx = e.clientX;
      let ly = e.clientY;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - lx;
        const dy = ev.clientY - ly;
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
      } else if (item.kind === 'video') {
        setPaused((p) => !p);
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  // Video element follows play/pause, speed and volume.
  const volume = Math.max(0, Math.min(1, s.volume * (props.masterVolume ?? 1)));
  const muted = s.muted || !!props.masterMuted;
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = s.speed;
    if (paused) v.pause();
    else v.play().catch(() => {});
  });

  // Tell auto-lock that something is playing.
  const isPlaying = !!item && !paused && (slideshow || item.kind === 'video');
  useEffect(() => {
    reportPlaying(props.activityId, isPlaying);
    return () => reportPlaying(props.activityId, false);
  }, [isPlaying, props.activityId]);

  const onVideoMeta = () => {
    const v = videoRef.current;
    if (!v) return;
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    let start = 0;
    if (s.videoRandomStart && d > 10) {
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
    setTime({ at: v.currentTime, dur: Number.isFinite(v.duration) ? v.duration : 0 });
    if (slideshow && s.videoMaxSeconds > 0 && v.currentTime - videoStart.current >= s.videoMaxSeconds) go('next', true);
  };

  const onVideoEnd = () => {
    if (slideshow) go('next', true);
    else if (s.repeat === 'one') {
      const v = videoRef.current;
      if (v) {
        v.currentTime = 0;
        v.play().catch(() => {});
      }
    }
  };

  const set = (patch: Partial<PlaybackSettings>) => onSettings({ ...s, ...patch });
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
    next: () => go('next'),
    prev: () => go('prev'),
    toggleMute: () => onSettings({ ...s, muted: !s.muted }),
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
      const k = e.key.toLowerCase();
      if (k === ' ') {
        e.preventDefault();
        if (item?.kind === 'video' && !slideshow) setPaused((p) => !p);
        else toggleSlideshow();
      } else if (k === 'arrowright') go('next');
      else if (k === 'arrowleft') go('prev');
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
      } else if (k === 'escape' && (rect || zoomed)) {
        setRect(null);
        setZoom({ s: 1, x: 0, y: 0 });
      } else if (k === 'escape') props.onClose?.();
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
  const media = useMemo(() => {
    if (!item) return null;
    const fit = { objectFit: s.fit } as const;
    const anim = s.transition === 'fade' ? 'fade-in' : undefined;
    if (failed)
      return (
        <div className="media-failed">
          <BrokenIcon size={32} />
          <span>{item.name} can't be shown{item.kind === 'video' ? ' (unsupported video format, e.g. HEVC)' : ''}.</span>
        </div>
      );
    if (item.kind === 'video')
      return (
        <video key={item.key} ref={videoRef} className={`media ${anim ?? ''}`} style={fit} src={item.src} autoPlay={!paused}
          playsInline preload="auto" onLoadedMetadata={onVideoMeta} onTimeUpdate={onVideoTime} onEnded={onVideoEnd}
          onError={() => setFailed(true)} />
      );
    if (item.kind === 'text') return <TextView key={item.key} src={item.src} zoom={docZoom} onError={() => setFailed(true)} />;
    if (item.kind === 'pdf') return <PdfView key={item.key} src={item.src} zoom={docZoom} onError={() => setFailed(true)} />;
    if (item.kind === 'gif')
      return gifUrl ? <img key={item.key + tick} className={`media ${anim ?? ''}`} style={fit} src={gifUrl} alt={item.name} draggable={false} /> : null;
    return <img key={item.key} className={`media ${anim ?? ''}`} style={fit} src={item.src} alt={item.name} draggable={false} onError={() => setFailed(true)} />;
  }, [item?.key, item?.src, gifUrl, failed, s.fit, s.transition, tick, docZoom]); // eslint-disable-line react-hooks/exhaustive-deps

  const fav = item?.favourite ?? false;
  const weight = item?.weight ?? 1;
  const timeline = item?.kind === 'video' && time.dur > 0 && (
    <div className="timeline">
      <span>{formatTime(time.at * 1000)}</span>
      <input type="range" min={0} max={time.dur} step={0.1} value={time.at} aria-label="Position"
        onChange={(e) => {
          const v = videoRef.current;
          if (v) {
            v.currentTime = Number(e.target.value);
            videoStart.current = v.currentTime;
          }
        }} />
      <span>{formatTime(time.dur * 1000)}{s.videoMaxSeconds > 0 && slideshow ? ` · max ${formatTime(s.videoMaxSeconds * 1000)}` : ''}</span>
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

  return (
    <div ref={rootRef} className={`player${props.compact ? ' compact' : ''}${showUi ? '' : ' idle'}`}
      onMouseMove={poke} onMouseDown={poke}>
      <div ref={stageRef} className={`stage${isDoc ? ' doc' : ''}${zoomed ? ' zoomed' : ''}`} onPointerDown={onStagePointerDown}
        onContextMenu={(e) => e.preventDefault()}>
        {isDoc ? media : (
          <div className="zoom-layer" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` }}>{media}</div>
        )}
        {!item && <div className="media-failed">Nothing to play here.</div>}
        {drawing && <div className="zoom-rect drawing" style={{ left: drawing.x, top: drawing.y, width: drawing.w, height: drawing.h }} />}
        {rect && !drawing && (
          <div className="zoom-rect" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
            <span>Click inside to zoom</span>
          </div>
        )}
      </div>
      {(zoomed || (isDoc && Math.abs(docZoom - 1) > 0.01)) && (
        <button type="button" className="zoom-badge" onClick={() => { setZoom({ s: 1, x: 0, y: 0 }); setDocZoom(1); }}
          title="Reset zoom (0)">
          {Math.round((isDoc ? docZoom : zoom.s) * 100)}% · Reset
        </button>
      )}

      {!props.compact && (
        <div className="p-top">
          <div className="p-title">
            {props.title}
            {item && (
              <>
                <span className="p-name">{item.name}</span>
                <span className="faint">{index >= 0 ? `${index + 1} of ${total}` : `${orderLabel} · ${total} files`}</span>
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
            {props.topRight}
          </div>
        </div>
      )}

      {props.compact ? (
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
              <button type="button" className="pbtn" aria-label="Previous" onClick={() => go('prev')}><PrevIcon size={14} /></button>
              <button type="button" className="pbtn main" aria-label={slideshow && !paused ? 'Pause' : 'Play'} onClick={() => {
                if (slideshow && !paused) setPaused(true);
                else { setSlideshow(true); setPaused(false); }
              }}>{slideshow && !paused ? <PauseIcon size={14} /> : <PlayIcon size={14} />}</button>
              <button type="button" className="pbtn" aria-label="Next" onClick={() => go('next')}><NextIcon size={14} /></button>
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
            <button type="button" className="pbtn lg" aria-label="Previous" onClick={() => go('prev')}><PrevIcon /></button>
            <button type="button" className="btn btn-primary slideshow" aria-pressed={slideshow && !paused} onClick={toggleSlideshow}>
              {slideshow && !paused ? <PauseIcon /> : <PlayIcon />} Slideshow
            </button>
            <button type="button" className="pbtn lg" aria-label="Next" onClick={() => go('next')}><NextIcon /></button>
            {item?.kind === 'video' && !slideshow && (
              <button type="button" className="pbtn lg" aria-label={paused ? 'Play video' : 'Pause video'} onClick={() => setPaused((p) => !p)}>
                {paused ? <PlayIcon /> : <PauseIcon />}
              </button>
            )}
            <span className="vsep" />
            <Dropdown up className={`btn btn-sm glass${s.order === 'shuffle' || s.order === 'random' || s.order === 'weighted' ? ' accent-soft' : ''}`}
              label={<><ShuffleIcon /> Order: {orderLabel}</>} items={orderItems} />
            <button type="button" className={`btn btn-sm glass${s.repeat !== 'off' ? ' accent-soft' : ''}`} onClick={cycleRepeat}
              title="Off → repeat all → repeat one">
              <RepeatIcon /> {s.repeat === 'off' ? 'Repeat off' : s.repeat === 'all' ? 'Repeat all' : 'Repeat one'}
            </button>
            {speedButton}
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              <button type="button" className="pbtn lg" aria-label={muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => set({ muted: !s.muted })}>
                {muted ? <MuteIcon /> : <SoundIcon />}
              </button>
              <input type="range" min={0} max={1} step={0.01} value={s.volume} aria-label="Volume" className="vol"
                onChange={(e) => set({ volume: Number(e.target.value), muted: false })} />
              {props.onFullscreen && (
                <button type="button" className="pbtn lg" aria-label="Clean full screen (F)" title="Clean full screen (F)" onClick={props.onFullscreen}>
                  <FullscreenIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
