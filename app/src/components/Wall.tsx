// Wall mode: many small tiles, each swapping to a new item at random times.
// Picks follow the weights (0 = never). Only a few videos play at once so a
// big wall stays smooth; the rest show their thumbnail. Always muted.
// Double-click a tile to watch it alone.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayItem } from '../media';

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

interface Tile {
  item: PlayItem;
  gen: number;
}

export function Wall(props: { items: PlayItem[]; count: number; speed: 'calm' | 'normal' | 'fast'; paused: boolean; onOpen: (item: PlayItem) => void }) {
  const { cols, rows } = wallGrid(props.count);
  const n = cols * rows;
  const [tiles, setTiles] = useState<Tile[]>([]);
  const gen = useRef(0);
  const ref = useRef<HTMLDivElement>(null);

  // Fill the wall whenever the source or size changes.
  useEffect(() => {
    const shown = new Set<string>();
    const t: Tile[] = [];
    for (let i = 0; i < n; i++) {
      const it = pickWeighted(props.items, shown);
      if (!it) break;
      shown.add(it.key);
      t.push({ item: it, gen: gen.current++ });
    }
    setTiles(t);
  }, [props.items, n]);

  // Swap one random tile at a time.
  const perTile = WALL_SPEEDS.find((s) => s.id === props.speed)?.perTile ?? 9;
  useEffect(() => {
    if (props.paused || tiles.length === 0) return;
    const delay = ((perTile * 1000) / Math.max(1, tiles.length)) * (0.5 + Math.random());
    const t = setTimeout(() => {
      setTiles((cur) => {
        if (!cur.length) return cur;
        const i = Math.floor(Math.random() * cur.length);
        const shown = new Set(cur.map((x) => x.item.key));
        const it = pickWeighted(props.items, shown);
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

  // Only the first few videos (in wall order) actually play.
  const playing = useMemo(() => {
    const keys = new Set<number>();
    tiles.forEach((t, i) => {
      if (t.item.kind === 'video' && keys.size < MAX_VIDEOS) keys.add(i);
    });
    return keys;
  }, [tiles]);

  const big = props.count <= 12;
  return (
    <div ref={ref} className="wall" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
      {tiles.map((t, i) => (
        <button key={i} type="button" className="wall-tile" title={`${t.item.name} — double-click to watch it alone`} onDoubleClick={() => props.onOpen(t.item)}>
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
    </div>
  );
}
