// Breathing grid: a grid of media where the piece under the mouse slowly grows
// and pushes its neighbours smaller, like a magnifying lens moving over it.
// Rows and columns resize smoothly and always fill the screen (breathing.ts).
// With no mouse for a few seconds the lens wanders slowly by itself. Pieces
// change now and then (never the one under the mouse). Only a few videos play
// (the ones nearest the lens). Double-click a piece to watch it alone.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlayItem } from '../media';
import { pickWeighted } from './Wall';
import { approach, BREATH_SPEEDS, BREATH_STRENGTHS, lensShares, trackAt, wanderAt, type BreathingSettings } from '../breathing';
import { GRID_MAX_VIDEOS, GridMedia, useHidden, usePauseVideos } from './gridmedia';

interface Tile { item: PlayItem; gen: number }

/** The mouse stops steering the lens after this long without moving (ms). */
const IDLE_MS = 3500;

export function BreathingGrid(props: { items: PlayItem[]; settings: BreathingSettings; paused: boolean; onOpen: (item: PlayItem) => void }) {
  const n = props.settings.size;
  const gain = BREATH_STRENGTHS.find((s) => s.id === props.settings.strength)?.gain ?? 1.1;
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useHidden();
  const stopped = props.paused || hidden;
  const [tiles, setTiles] = useState<Tile[]>([]);
  const gen = useRef(0);
  const [focus, setFocus] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const hoverRef = useRef<number | null>(null);
  hoverRef.current = hover;

  // Fill the grid when the source or size changes.
  useEffect(() => {
    const shown = new Set<string>();
    const t: Tile[] = [];
    for (let i = 0; i < n * n; i++) {
      const it = pickWeighted(props.items, shown);
      if (!it) break;
      shown.add(it.key);
      t.push({ item: it, gen: gen.current++ });
    }
    setTiles(t);
  }, [props.items, n]);

  // Swap one piece at a time (not the one under the mouse).
  const perTile = BREATH_SPEEDS.find((s) => s.id === props.settings.speed)?.perTile ?? 16;
  useEffect(() => {
    if (stopped || tiles.length === 0) return;
    const delay = ((perTile * 1000) / Math.max(1, tiles.length)) * (0.5 + Math.random());
    const t = setTimeout(() => {
      setTiles((cur) => {
        if (!cur.length) return cur;
        let i = Math.floor(Math.random() * cur.length);
        if (i === hoverRef.current) i = (i + 1) % cur.length;
        const it = pickWeighted(props.items, new Set(cur.map((x) => x.item.key)));
        if (!it) return cur;
        const next = [...cur];
        next[i] = { item: it, gen: gen.current++ };
        return next;
      });
    }, delay);
    return () => clearTimeout(t);
  }, [tiles, stopped, perTile, props.items]);

  // The lens: follows the mouse, or wanders when the mouse is still or away.
  const mouse = useRef<{ x: number; y: number; t: number } | null>(null);
  const lens = useRef({ x: 0.5, y: 0.5 });
  const clock = useRef(Math.random() * 100);
  const shares = useRef({ cols: '', rows: '' });
  const apply = (el: HTMLDivElement) => {
    const cols = lensShares(n, lens.current.x, gain);
    const rows = lensShares(n, lens.current.y, gain);
    const c = cols.map((x) => `${x.toFixed(4)}fr`).join(' ');
    const r = rows.map((x) => `${x.toFixed(4)}fr`).join(' ');
    if (c !== shares.current.cols) el.style.gridTemplateColumns = shares.current.cols = c;
    if (r !== shares.current.rows) el.style.gridTemplateRows = shares.current.rows = r;
    const cell = trackAt(rows, lens.current.y) * n + trackAt(cols, lens.current.x);
    setFocus((f) => (f === cell ? f : cell));
  };
  useLayoutEffect(() => {
    shares.current = { cols: '', rows: '' };
    if (ref.current) apply(ref.current);
  }, [n, gain, tiles.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (stopped) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const m = mouse.current;
      const steering = m && Date.now() - m.t < IDLE_MS;
      if (!steering) clock.current += dt;
      const target = steering ? m : wanderAt(clock.current);
      const tau = steering ? 0.55 : 1.8;
      lens.current = { x: approach(lens.current.x, target.x, dt, tau), y: approach(lens.current.y, target.y, dt, tau) };
      if (ref.current) apply(ref.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [stopped, n, gain]); // eslint-disable-line react-hooks/exhaustive-deps

  // The videos nearest the lens play; the rest show a still.
  const playing = useMemo(() => {
    const fr = Math.floor(focus / n);
    const fc = focus % n;
    return new Set(
      tiles.map((t, i) => ({ t, i, d: Math.hypot(Math.floor(i / n) - fr, (i % n) - fc) }))
        .filter((x) => x.t.item.kind === 'video')
        .sort((a, b) => a.d - b.d)
        .slice(0, GRID_MAX_VIDEOS)
        .map((x) => x.i),
    );
  }, [tiles, focus, n]);
  usePauseVideos(ref, stopped, tiles);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    mouse.current = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, t: Date.now() };
  };

  return (
    <div ref={ref} className="breathing" onPointerMove={onMove} onPointerLeave={() => { mouse.current = null; setHover(null); }}>
      {tiles.map((t, i) => (
        <button key={i} type="button" className={`grid-tile${focus === i ? ' lens' : ''}`} title={`${t.item.name} — double-click to watch it alone`}
          onPointerEnter={() => setHover(i)} onDoubleClick={() => props.onOpen(t.item)}>
          <div key={t.gen} className="grid-media">
            <GridMedia item={t.item} play={playing.has(i)} stopped={stopped} big={n <= 4 || focus === i} />
          </div>
        </button>
      ))}
    </div>
  );
}
