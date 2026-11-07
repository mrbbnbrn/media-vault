// Mosaic mode: the whole screen filled with pictures, GIFs and videos, each at
// its own shape (tall stays tall, wide stays wide), packed edge to edge in
// justified rows. Every few seconds one piece is swapped for a new one (by
// weight, no repeats on screen) and the others glide to their new places.
// Only a few videos play at once (they take turns); sound, when on, plays for
// the piece under the mouse. Double-click a piece to watch it alone.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlayItem } from '../media';
import { pickWeighted } from './Wall';
import {
  chooseMosaic, MOSAIC_MAX_VIDEOS, MOSAIC_SPEEDS, mosaicRows, packMosaic, polish, swapPiece,
  type Box, type Chooser, type MosaicSettings,
} from '../mosaic';
import './mosaic.css';

/** Shapes measured when the media loaded (for files whose size the vault does not know). */
const measured = new Map<string, number>();

function aspectOf(i: PlayItem): number {
  const m = measured.get(i.key);
  if (m) return m;
  if (i.width && i.height && i.width > 0 && i.height > 0) return i.width / i.height;
  return i.kind === 'video' ? 16 / 9 : 4 / 3;
}

interface Piece {
  uid: number;
  item: PlayItem;
}

const MOVE_MS = 600;
/** How often the videos that play take turns (ms). */
const TURN_MS = 12_000;

export function MosaicWall(props: {
  items: PlayItem[];
  settings: MosaicSettings;
  volume: number;
  paused: boolean;
  onOpen: (item: PlayItem) => void;
}) {
  const rows = mosaicRows(props.settings.size);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [leaving, setLeaving] = useState<(Piece & { box: Box })[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  hoverRef.current = hover;
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden);
  const [turn, setTurn] = useState(0);
  const [shapeTick, setShapeTick] = useState(0);
  const uid = useRef(1);
  const fresh = useRef(new Set<number>());
  const stopped = props.paused || hidden;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
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

  const chooser = useMemo<Chooser<PlayItem>>(() => ({
    key: (i) => i.key,
    aspect: aspectOf,
    pick: (ex) => pickWeighted(props.items, ex),
  }), [props.items]);

  const wrap = (list: PlayItem[], old: Piece[]): Piece[] => {
    // Keep the identity (and so the position animation) of pieces that stay.
    const byKey = new Map(old.map((p) => [p.item.key, p]));
    return list.map((item) => {
      const was = byKey.get(item.key);
      if (was) return was;
      const p = { uid: uid.current++, item };
      fresh.current.add(p.uid);
      return p;
    });
  };

  // A fresh screenful when the source or size setting changes.
  const ready = size.w > 0 && size.h > 0;
  useEffect(() => {
    if (!ready) return;
    setLeaving([]);
    setPieces(wrap(chooseMosaic(chooser, size.w, size.h, rows), []));
  }, [chooser, rows, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const fit = useMemo(() => packMosaic(pieces.map((p) => aspectOf(p.item)), size.w, size.h, rows), [pieces, size.w, size.h, rows, shapeTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // The window changed shape, or a piece turned out to have another shape: improve the fit.
  useEffect(() => {
    if (!ready || !pieces.length || fit.error < 0.015) return;
    setPieces((cur) => wrap(polish(cur.map((p) => p.item), chooser, size.w, size.h, rows), cur));
  }, [size.w, size.h, shapeTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const boxOf = useRef(new Map<number, Box>());
  pieces.forEach((p, i) => fit.boxes[i] && boxOf.current.set(p.uid, fit.boxes[i]));

  // Swap one piece every few seconds.
  const every = MOSAIC_SPEEDS.find((s) => s.id === props.settings.speed)?.every ?? 5;
  useEffect(() => {
    if (stopped || !pieces.length || !ready) return;
    const t = setTimeout(() => {
      const cur = pieces;
      // Never take away the piece under the mouse.
      const hv = hoverRef.current;
      const keep = new Set(cur.filter((p) => p.uid === hv).map((p) => p.item.key));
      const choices = cur.map((_, i) => i).filter((i) => cur[i].uid !== hv);
      if (!choices.length) return;
      const victim = choices[Math.floor(Math.random() * choices.length)];
      const next = wrap(swapPiece(cur.map((p) => p.item), victim, chooser, size.w, size.h, rows, keep), cur);
      const stay = new Set(next.map((p) => p.uid));
      const gone = cur.filter((p) => !stay.has(p.uid)).map((p) => ({ ...p, box: boxOf.current.get(p.uid)! })).filter((p) => p.box);
      setLeaving((l) => [...l, ...gone]);
      setTimeout(() => setLeaving((l) => l.filter((x) => !gone.includes(x))), MOVE_MS + 100);
      setPieces(next);
    }, every * 1000 * (0.7 + Math.random() * 0.6));
    return () => clearTimeout(t);
  }, [pieces, stopped, every, chooser, size.w, size.h, rows, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Videos take turns playing.
  const videoCount = pieces.filter((p) => p.item.kind === 'video').length;
  useEffect(() => {
    if (stopped || videoCount <= MOSAIC_MAX_VIDEOS) return;
    const t = setInterval(() => setTurn((x) => x + 1), TURN_MS);
    return () => clearInterval(t);
  }, [stopped, videoCount]);
  const playing = useMemo(() => {
    const vids = pieces.filter((p) => p.item.kind === 'video').map((p) => p.uid);
    const set = new Set<number>();
    if (hover != null && vids.includes(hover)) set.add(hover);
    const off = vids.length ? (turn * Math.max(1, Math.floor(MOSAIC_MAX_VIDEOS / 2))) % vids.length : 0;
    for (let k = 0; k < vids.length && set.size < MOSAIC_MAX_VIDEOS; k++) set.add(vids[(off + k) % vids.length]);
    return set;
  }, [pieces, turn, hover]);

  // Pause or resume the videos.
  useEffect(() => {
    ref.current?.querySelectorAll<HTMLVideoElement>('video[data-play]').forEach((v) => (stopped ? v.pause() : v.play().catch(() => {})));
  }, [stopped, playing, pieces]);

  const learnShape = (item: PlayItem, w: number, h: number) => {
    if (!w || !h) return;
    const a = w / h;
    if (Math.abs(a / aspectOf(item) - 1) > 0.02) {
      measured.set(item.key, a);
      setShapeTick((x) => x + 1);
    }
  };

  // New pieces fade in; they stop counting as new once they have.
  useEffect(() => {
    if (!fresh.current.size) return;
    const t = setTimeout(() => fresh.current.clear(), MOVE_MS + 200);
    return () => clearTimeout(t);
  }, [pieces]);

  const useThumb = rows >= 4;
  const media = (p: Piece) => {
    const it = p.item;
    if (it.kind === 'video') {
      if (playing.has(p.uid))
        return (
          <video data-play src={it.src} loop autoPlay={!stopped} playsInline preload="auto"
            muted={!(props.settings.sound && hover === p.uid && !stopped)}
            ref={(v) => { if (v) v.volume = Math.max(0, Math.min(1, props.volume)); }}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              learnShape(it, v.videoWidth, v.videoHeight);
              if (Number.isFinite(v.duration) && v.duration > 6) v.currentTime = Math.random() * (v.duration - 5);
            }} />
        );
      if (it.thumb) return <img src={it.thumb} alt="" draggable={false} />;
      // No thumbnail (files on this PC): the video's own first frame.
      return <video src={it.src} muted playsInline preload="metadata" onLoadedMetadata={(e) => learnShape(it, e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />;
    }
    if (useThumb && it.kind === 'image' && it.thumb) return <img src={it.thumb} alt="" draggable={false} />;
    return <img src={it.src} alt="" draggable={false} onLoad={(e) => learnShape(it, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />;
  };

  const style = (b: Box) => ({ width: b.w, height: b.h, transform: `translate(${b.x}px, ${b.y}px)` });
  return (
    <div ref={ref} className={`mosaic${props.settings.sound ? ' sound' : ''}`} onPointerLeave={() => setHover(null)}>
      {leaving.map((p) => (
        <div key={`gone-${p.uid}`} className="mosaic-piece leaving" style={style(p.box)} aria-hidden="true">
          {p.item.kind === 'video' ? (p.item.thumb ? <img src={p.item.thumb} alt="" /> : null) : <img src={useThumb && p.item.thumb ? p.item.thumb : p.item.src} alt="" />}
        </div>
      ))}
      {pieces.map((p, i) => {
        const b = fit.boxes[i];
        if (!b) return null;
        return (
          <button key={p.uid} type="button" className={`mosaic-piece${fresh.current.has(p.uid) ? ' entering' : ''}${hover === p.uid ? ' hover' : ''}`}
            style={style(b)} title={`${p.item.name} — double-click to watch it alone`}
            onPointerEnter={() => setHover(p.uid)} onDoubleClick={() => props.onOpen(p.item)}>
            {media(p)}
          </button>
        );
      })}
    </div>
  );
}
