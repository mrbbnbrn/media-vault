// One player for pictures, GIFs / animated WebP and videos. Used by the
// full viewer, each multi-screen panel, and the player outside the vault.

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { setPlaying as reportPlaying } from '../activity';
import { animationMs, formatTime, type PlayItem } from '../media';
import { ORDERS, Playlist, type Order, type Repeat } from '../playlist';
import { gifShowMs, SPEEDS, type PlaybackSettings } from '../presets';
import { Dropdown } from './Dialogs';
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
    if (!item || !slideshow || paused) return;
    let ms = 0;
    if (failed) ms = 1500;
    else if (item.kind === 'image') ms = s.imageSeconds * 1000;
    else if (item.kind === 'gif') {
      if (!gifUrl) return;
      ms = gifShowMs(s, gifMs);
    } else return;
    const t = setTimeout(() => go('next', true), ms);
    return () => clearTimeout(t);
  }, [item?.key, tick, slideshow, paused, failed, gifUrl, gifMs, s.imageSeconds, s.gifLoops, s.gifMaxSeconds, go]); // eslint-disable-line react-hooks/exhaustive-deps

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
      else if (k === 'escape') props.onClose?.();
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
          onError={() => setFailed(true)} onClick={() => setPaused((p) => !p)} />
      );
    if (item.kind === 'gif')
      return gifUrl ? <img key={item.key + tick} className={`media ${anim ?? ''}`} style={fit} src={gifUrl} alt={item.name} draggable={false} /> : null;
    return <img key={item.key} className={`media ${anim ?? ''}`} style={fit} src={item.src} alt={item.name} draggable={false} onError={() => setFailed(true)} />;
  }, [item?.key, item?.src, gifUrl, failed, s.fit, s.transition, tick]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="stage">{media}{!item && <div className="media-failed">Nothing to play here.</div>}</div>

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
