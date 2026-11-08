// Pulse grid: a grid where tiles light up and bump in waves across the screen.
// With "On the beat", every beat of the music playing on the computer sends a
// wave (a stronger beat, a stronger wave); without music, a slow calm wave
// every couple of seconds. Now and then a wave also changes a tile to new
// media as it passes. Only a few videos play. Double-click to watch one alone.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayItem } from '../media';
import { pickWeighted } from './Wall';
import { beatStatusText, useBeatSync } from '../beats';
import { CALM_WAVE_MS, PULSE_SIZES, SWEEP_MS, swapOnWave, tileToSwap, waveDelays, waveLook, type PulseSettings } from '../pulse';
import { GRID_MAX_VIDEOS, GridMedia, useHidden, usePauseVideos } from './gridmedia';

interface Tile { item: PlayItem; gen: number }

const noop = () => {};
/** How long one tile's bump lasts (ms). */
const BUMP_MS = 700;

export function PulseGrid(props: { items: PlayItem[]; settings: PulseSettings; paused: boolean; onOpen: (item: PlayItem) => void }) {
  const size = PULSE_SIZES.find((s) => s.id === props.settings.size) ?? PULSE_SIZES[1];
  const { cols, rows } = size;
  const n = cols * rows;
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useHidden();
  const stopped = props.paused || hidden;
  const [tiles, setTiles] = useState<Tile[]>([]);
  const gen = useRef(0);
  const hover = useRef<number | null>(null);
  const lastSwap = useRef(0);
  const lastWave = useRef(0);

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

  const swapTile = (i: number) => setTiles((cur) => {
    if (!cur[i]) return cur;
    const it = pickWeighted(props.items, new Set(cur.map((x) => x.item.key)));
    if (!it) return cur;
    const next = [...cur];
    next[i] = { item: it, gen: gen.current++ };
    return next;
  });

  /** Send one wave across the grid. */
  const wave = (strength: number) => {
    const el = ref.current;
    if (!el) return;
    const now = performance.now();
    if (now - lastWave.current < 120) return; // beats closer than this would just blur together
    lastWave.current = now;
    const delays = waveDelays(props.settings.pattern, cols, rows);
    const look = waveLook(strength);
    const sweep = props.settings.pattern === 'sparkle' ? SWEEP_MS * 0.6 : SWEEP_MS;
    const tileEls = el.querySelectorAll<HTMLElement>(':scope > .grid-tile');
    delays.forEach((d, i) => {
      const t = tileEls[i];
      if (d == null || !t) return;
      const timing = { duration: BUMP_MS, delay: d * sweep, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' };
      t.animate([{ transform: 'scale(1)' }, { transform: `scale(${look.scale})`, offset: 0.3 }, { transform: 'scale(1)' }], timing);
      t.querySelector<HTMLElement>('.pulse-glow')?.animate([{ opacity: 0 }, { opacity: look.glow, offset: 0.25 }, { opacity: 0 }], timing);
    });
    if (swapOnWave(now, lastSwap.current, strength)) {
      lastSwap.current = now;
      const i = tileToSwap(delays, hover.current);
      setTimeout(() => swapTile(i), (delays[i] ?? 0) * sweep + BUMP_MS * 0.25);
    }
  };
  const waveRef = useRef(wave);
  waveRef.current = wave;

  const beat = useBeatSync({ enabled: props.settings.beat && !stopped, everyBeats: 1, minSeconds: 0, onAdvance: noop,
    onBeat: (b) => waveRef.current(Number.isFinite(b.strength) ? b.strength : 0.5) });
  const calm = !props.settings.beat || beat.silent;

  // No music: a slow calm wave every couple of seconds.
  useEffect(() => {
    if (stopped || !calm || !tiles.length) return;
    const first = setTimeout(() => waveRef.current(0.45), 600);
    const t = setInterval(() => waveRef.current(0.45), CALM_WAVE_MS);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [stopped, calm, tiles.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // The first few videos (in grid order) play; the rest show a still.
  const playing = useMemo(() => {
    const s = new Set<number>();
    tiles.forEach((t, i) => t.item.kind === 'video' && s.size < GRID_MAX_VIDEOS && s.add(i));
    return s;
  }, [tiles]);
  usePauseVideos(ref, stopped, tiles);

  return (
    <div ref={ref} className="pulse-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      onPointerLeave={() => { hover.current = null; }}>
      {tiles.map((t, i) => (
        <button key={i} type="button" className="grid-tile" title={`${t.item.name} — double-click to watch it alone`}
          onPointerEnter={() => { hover.current = i; }} onDoubleClick={() => props.onOpen(t.item)}>
          <div key={t.gen} className="grid-media">
            <GridMedia item={t.item} play={playing.has(i)} stopped={stopped} big={n <= 12} />
          </div>
          <span className="pulse-glow" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** A small status next to "On the beat": what the app hears, with a dot on every beat. */
export function PulseBeatChip() {
  const b = useBeatSync({ enabled: true, everyBeats: 1, minSeconds: 0, onAdvance: noop });
  const { text, problem } = beatStatusText(b);
  return (
    <span className={`faint pulse-chip${problem ? ' problem' : ''}`} role="status" title={text}>
      {problem ? 'Can’t hear the music' : !b.silent
        ? <>{b.bpm ? `${Math.round(b.bpm)} BPM` : 'Finding the beat…'} <span key={b.pulse} className={`beat-dot${b.pulse ? ' hit' : ''}`} /></>
        : 'No music — calm waves'}
    </span>
  );
}
