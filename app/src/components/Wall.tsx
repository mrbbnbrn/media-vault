// Wall mode: many small tiles, each swapping to a new item at random times.
// Picks follow the weights (0 = never). Only a few videos play at once so a
// big wall stays smooth; the rest show their thumbnail. Always muted.
// Double-click a tile to watch it alone.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayItem } from '../media';
import { ContextMenu } from './Dialogs';
import { LockIcon } from './Icons';
import { bestMatch, columnOrder, quantile, sortSlots } from '../colour';
import { measureColours, onColours, rainbowOf, stopMeasuring } from '../colourcache';

export const WALL_SIZES = [12, 20, 30];
export const WALL_SPEEDS: { id: 'calm' | 'normal' | 'fast'; label: string; perTile: number }[] = [
  { id: 'calm', label: 'Calm', perTile: 16 },
  { id: 'normal', label: 'Normal', perTile: 9 },
  { id: 'fast', label: 'Fast', perTile: 4 },
];
const MAX_VIDEOS = 4;

export function wallGrid(n: number): { cols: number; rows: number } {
  if (n <= 12) return { cols: 4, rows: 3 };
  if (n <= 20) return { cols: 5, rows: 4 };
  return { cols: 6, rows: 5 };
}

/** Weighted pick, avoiding `exclude` when there is anything else. */
export function pickWeighted(items: PlayItem[], exclude: Set<string>, rnd = Math.random): PlayItem | null {
  const w = (i: PlayItem) => i.weight ?? 1;
  const pool = items.filter((i) => w(i) > 0 && !exclude.has(i.key));
  const list = pool.length ? pool : items.filter((i) => w(i) > 0);
  const total = list.reduce((a, i) => a + w(i), 0);
  if (!list.length || total <= 0) return null;
  let x = rnd() * total;
  for (const i of list) {
    if (x < w(i)) return i;
    x -= w(i);
  }
  return list[list.length - 1];
}

/** Colour flow: a few weighted picks to choose the best-matching colour from. */
const COLOUR_CANDIDATES = 8;

/** Up to `k` different weighted picks, none of them in `exclude`. */
export function pickSome(items: PlayItem[], exclude: Set<string>, k: number, rnd = Math.random): PlayItem[] {
  const ex = new Set(exclude);
  const out: PlayItem[] = [];
  for (let n = 0; n < k; n++) {
    const it = pickWeighted(items, ex, rnd);
    if (!it || ex.has(it.key)) break;
    ex.add(it.key);
    out.push(it);
  }
  return out;
}

/**
 * Colour flow on a wall: the rainbow runs column by column, left to right. The
 * colour tile `i` wants: where it comes in that order, as a share of the
 * colours of the other tiles.
 */
export function wallColourTarget(keys: (string | null)[], i: number, cols: number, rows: number, pos: (key: string) => number | null): number | null {
  const order = columnOrder(cols, rows, keys.length);
  const k = order.indexOf(i);
  if (k < 0) return null;
  const vals = keys.filter((x, j): x is string => j !== i && x != null).map(pos).filter((v): v is number => v != null);
  return quantile(vals, (k + 0.5) / Math.max(1, order.length));
}

interface Tile {
  item: PlayItem;
  gen: number;
}

export function Wall(props: { items: PlayItem[]; count: number; speed: 'calm' | 'normal' | 'fast'; paused: boolean; onOpen: (item: PlayItem) => void;
  /** Colour flow: tiles sit next to ones of similar colour, a rainbow from left to right. */
  colour?: boolean }) {
  const { cols, rows } = wallGrid(props.count);
  const n = cols * rows;
  const [tiles, setTiles] = useState<Tile[]>([]);
  const gen = useRef(0);
  const ref = useRef<HTMLDivElement>(null);
  const colour = !!props.colour;
  const colourRef = useRef(colour);
  colourRef.current = colour;
  // Locked tiles (right-click): never swapped, a locked video always plays, on loop. For this visit.
  const [locked, setLocked] = useState<Set<string>>(() => new Set());
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const [menu, setMenu] = useState<{ x: number; y: number; item: PlayItem } | null>(null);
  const toggleLock = (key: string) => setLocked((l) => {
    const next = new Set(l);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  /** Colour order, with locked tiles staying where they are. */
  const tilePos = (t: Tile) => (lockedRef.current.has(t.item.key) ? null : rainbowOf(t.item.key));

  // Fill the wall whenever the source or size changes (locked tiles stay where they were).
  useEffect(() => {
    setTiles((cur) => {
      const there = new Set(props.items.map((i) => i.key));
      const kept = new Map(cur.map((t, i) => [i, t] as const).filter(([i, t]) => i < n && lockedRef.current.has(t.item.key) && there.has(t.item.key)));
      const shown = new Set([...kept.values()].map((t) => t.item.key));
      const t: Tile[] = [];
      for (let i = 0; i < n; i++) {
        const k = kept.get(i);
        if (k) {
          t.push(k);
          continue;
        }
        const it = pickWeighted(props.items, shown);
        if (!it) break;
        shown.add(it.key);
        t.push({ item: it, gen: gen.current++ });
      }
      return colourRef.current ? sortSlots(t, columnOrder(cols, rows, t.length), tilePos) : t;
    });
  }, [props.items, n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Colour flow: measure what is on the wall (then the rest, from thumbnails); as colours come in
  // (or it is turned on), the tiles are put in rainbow order. Tiles of unknown colour stay put.
  useEffect(() => {
    if (!colour || !tiles.length) return;
    measureColours(tiles.map((t) => t.item), props.items);
  }, [colour, tiles, props.items]);
  useEffect(() => () => stopMeasuring(), []);
  const resort = useRef<() => void>(() => {});
  resort.current = () => {
    if (!colourRef.current) return;
    setTiles((cur) => {
      const sorted = sortSlots(cur, columnOrder(cols, rows, cur.length), tilePos);
      if (sorted.every((t, i) => t === cur[i])) return cur;
      // A tile that moved fades in at its new place.
      return sorted.map((t, i) => (t === cur[i] ? t : { item: t.item, gen: gen.current++ }));
    });
  };
  useEffect(() => onColours(() => resort.current()), []);
  useEffect(() => {
    if (colour) resort.current();
  }, [colour, n]);

  // Swap one random tile at a time.
  const perTile = WALL_SPEEDS.find((s) => s.id === props.speed)?.perTile ?? 9;
  useEffect(() => {
    if (props.paused || tiles.length === 0) return;
    const delay = ((perTile * 1000) / Math.max(1, tiles.length)) * (0.5 + Math.random());
    const t = setTimeout(() => {
      setTiles((cur) => {
        // Never a locked tile.
        const free = cur.map((x, j) => (lockedRef.current.has(x.item.key) ? -1 : j)).filter((j) => j >= 0);
        if (!free.length) return cur;
        const i = free[Math.floor(Math.random() * free.length)];
        const shown = new Set(cur.map((x) => x.item.key));
        // Colour flow: of a few weighted picks, the one whose colour suits this spot.
        const it = colourRef.current
          ? bestMatch(pickSome(props.items, shown, COLOUR_CANDIDATES), wallColourTarget(cur.map((x) => x.item.key), i, cols, rows, rainbowOf), (x) => rainbowOf(x.key)) ?? pickWeighted(props.items, shown)
          : pickWeighted(props.items, shown);
        if (!it) return cur;
        const next = [...cur];
        next[i] = { item: it, gen: gen.current++ };
        return next;
      });
    }, delay);
    return () => clearTimeout(t);
  }, [tiles, props.paused, perTile, props.items]);

  // Pause or resume the videos on the wall.
  useEffect(() => {
    ref.current?.querySelectorAll('video').forEach((v) => (props.paused ? v.pause() : v.play().catch(() => {})));
  }, [props.paused, tiles]);

  // Only the first few videos (in wall order) actually play; locked ones always do (they count, but come first).
  const playing = useMemo(() => {
    const keys = new Set<number>();
    tiles.forEach((t, i) => {
      if (t.item.kind === 'video' && locked.has(t.item.key) && keys.size < MAX_VIDEOS) keys.add(i);
    });
    tiles.forEach((t, i) => {
      if (t.item.kind === 'video' && keys.size < MAX_VIDEOS) keys.add(i);
    });
    return keys;
  }, [tiles, locked]);

  const big = props.count <= 12;
  return (
    <div ref={ref} className="wall" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {tiles.map((t, i) => (
        <button key={i} type="button" className={`wall-tile${locked.has(t.item.key) ? ' locked' : ''}`} onDoubleClick={() => props.onOpen(t.item)}
          title={`${t.item.name}${locked.has(t.item.key) ? ' (locked)' : ''} — double-click to watch it alone, right-click to ${locked.has(t.item.key) ? 'unlock' : 'lock'}`}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, item: t.item });
          }}>
          {locked.has(t.item.key) && <span className="wall-lock" aria-label="Locked"><LockIcon size={13} /></span>}
          <div key={t.gen} className="wall-media">
            {t.item.kind === 'video' && playing.has(i) ? (
              <video src={t.item.src} muted loop autoPlay={!props.paused} playsInline preload="auto"
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (Number.isFinite(v.duration) && v.duration > 6) v.currentTime = Math.random() * (v.duration - 5);
                }} />
            ) : t.item.kind === 'video' || t.item.kind === 'text' || t.item.kind === 'pdf' ? (
              t.item.thumb ? <img src={t.item.thumb} alt="" draggable={false} /> : <span className="wall-name">{t.item.name}</span>
            ) : (
              <img src={t.item.kind === 'gif' || big || !t.item.thumb ? t.item.src : t.item.thumb} alt="" draggable={false} />
            )}
          </div>
        </button>
      ))}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} title={menu.item.name} onClose={() => setMenu(null)}
          items={[locked.has(menu.item.key)
            ? { label: 'Unlock', hint: 'it changes again like the others', onSelect: () => toggleLock(menu.item.key) }
            : { label: 'Lock this one', hint: 'keeps playing on loop', onSelect: () => toggleLock(menu.item.key) }]} />
      )}
    </div>
  );
}
