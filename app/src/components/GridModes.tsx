// Multi-screen glue for the Breathing grid, Pulse grid and Parallax layers:
// their buttons in the top bar, their settings in the bar while one is on,
// and the stage (or the "choose what to show" note while it has nothing).
// They share the wall's source and its "watch it alone".

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import type { PlayItem } from '../media';
import { Dropdown } from './Dialogs';
import { GridIcon } from './Icons';
import { BreathingGrid } from './BreathingGrid';
import { PulseBeatChip, PulseGrid } from './PulseGrid';
import { ParallaxLayers } from './ParallaxLayers';
import { BREATH_SIZES, BREATH_SPEEDS, BREATH_STRENGTHS } from '../breathing';
import { PULSE_PATTERNS, PULSE_SIZES } from '../pulse';
import { PARALLAX_DIRECTIONS, PARALLAX_SPEEDS } from '../parallax';
import { GRID_MODE_IDS, type GridModeId, type GridModes } from '../gridmodes';
import './grids.css';

export const GRID_MODE_INFO: Record<GridModeId, { name: string; back: string; title: string; about: string }> = {
  breathing: {
    name: 'Breathing',
    back: 'breathing grid',
    title: 'A grid where the piece under the mouse slowly grows, like a lens',
    about: 'A grid of pictures, GIFs and videos. The piece under the mouse slowly grows and gently pushes its neighbours smaller; leave the mouse and the lens wanders by itself.',
  },
  pulse: {
    name: 'Pulse',
    back: 'pulse grid',
    title: 'A grid that lights up in waves (on the beat of your music, if you like)',
    about: 'A grid of pictures, GIFs and videos that light up and bump in waves. Turn on “On the beat” to send a wave on every beat of the music playing on your PC.',
  },
  parallax: {
    name: 'Parallax',
    back: 'layers',
    title: 'Layers of pieces drifting past at different speeds, for depth',
    about: 'Big pieces in front, smaller and softer ones far behind, all drifting slowly past. Move the mouse to look around a little.',
  },
};

/** The three buttons, next to Wall and Mosaic. */
export function GridModeButtons({ current, onPick }: { current: string; onPick: (id: GridModeId) => void }) {
  return (
    <>
      {GRID_MODE_IDS.map((id) => (
        <button key={id} type="button" className={`btn btn-sm${current === id ? ' accent-soft' : ''}`} onClick={() => onPick(id)}
          title={GRID_MODE_INFO[id].title}>{GRID_MODE_INFO[id].name}</button>
      ))}
    </>
  );
}

// Whether this computer can listen for beats (asked once).
let beatsOk: Promise<boolean> | null = null;
function useBeatsSupported(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    let alive = true;
    beatsOk ??= api.beatsSupported().catch(() => false);
    beatsOk.then((v) => alive && setOk(v));
    return () => { alive = false; };
  }, []);
  return ok;
}

/** This mode's settings in the top bar, then the source menu. */
export function GridModeBar({ mode, s, set, source }: {
  mode: GridModeId; s: GridModes; set: (patch: Partial<GridModes>) => void; source: ReactNode;
}) {
  const beats = useBeatsSupported();
  const b = s.breathing;
  const p = s.pulse;
  const x = s.parallax;
  return (
    <>
      {mode === 'breathing' && (
        <>
          <Dropdown label={`${BREATH_SIZES.find((o) => o.id === b.size)?.label} ▾`} title="How many pieces"
            items={BREATH_SIZES.map((o) => ({ label: o.label, hint: `${o.id * o.id} pieces`, checked: o.id === b.size, onSelect: () => set({ breathing: { ...b, size: o.id } }) }))} />
          <Dropdown label={`${BREATH_STRENGTHS.find((o) => o.id === b.strength)?.label} lens ▾`} title="How much the piece under the lens grows"
            items={BREATH_STRENGTHS.map((o) => ({ label: o.label, hint: o.hint, checked: o.id === b.strength, onSelect: () => set({ breathing: { ...b, strength: o.id } }) }))} />
          <Dropdown label={`${BREATH_SPEEDS.find((o) => o.id === b.speed)?.label} ▾`} title="How often pieces change"
            items={BREATH_SPEEDS.map((o) => ({ label: o.label, hint: `each stays about ${o.perTile} s`, checked: o.id === b.speed, onSelect: () => set({ breathing: { ...b, speed: o.id } }) }))} />
        </>
      )}
      {mode === 'pulse' && (
        <>
          <Dropdown label={`${PULSE_PATTERNS.find((o) => o.id === p.pattern)?.label} ▾`} title="How the waves run"
            items={PULSE_PATTERNS.map((o) => ({ label: o.label, hint: o.hint, checked: o.id === p.pattern, onSelect: () => set({ pulse: { ...p, pattern: o.id } }) }))} />
          <Dropdown label={`${PULSE_SIZES.find((o) => o.id === p.size)?.label} ▾`} title="How many tiles"
            items={PULSE_SIZES.map((o) => ({ label: o.label, checked: o.id === p.size, onSelect: () => set({ pulse: { ...p, size: o.id } }) }))} />
          {beats && (
            <button type="button" className={`btn btn-sm${p.beat ? ' accent-soft' : ''}`} aria-pressed={p.beat} onClick={() => set({ pulse: { ...p, beat: !p.beat } })}
              title={p.beat ? 'A wave on every beat of the music playing on your PC — click for calm waves only' : 'Send a wave on every beat of the music playing on your PC'}>
              On the beat
            </button>
          )}
          {beats && p.beat && <PulseBeatChip />}
        </>
      )}
      {mode === 'parallax' && (
        <>
          <Dropdown label={`${PARALLAX_DIRECTIONS.find((o) => o.id === x.direction)?.label} ▾`} title="Which way the pieces drift"
            items={PARALLAX_DIRECTIONS.map((o) => ({ label: o.label, hint: o.hint, checked: o.id === x.direction, onSelect: () => set({ parallax: { ...x, direction: o.id } }) }))} />
          <Dropdown label={`${PARALLAX_SPEEDS.find((o) => o.id === x.speed)?.label} ▾`} title="How fast they drift"
            items={PARALLAX_SPEEDS.map((o) => ({ label: o.label, checked: o.id === x.speed, onSelect: () => set({ parallax: { ...x, speed: o.id } }) }))} />
        </>
      )}
      {source}
    </>
  );
}

/** The mode itself, or a note with "Choose what to show" while there is nothing yet. */
export function GridModeStage({ mode, s, items, error, paused, onOpen, pick }: {
  mode: GridModeId; s: GridModes; items: PlayItem[]; error?: string; paused: boolean; onOpen: (item: PlayItem) => void; pick: ReactNode;
}) {
  if (!items.length)
    return (
      <div className="panel-empty">
        {error && <span className="error-text">{error}</span>}
        <GridIcon size={26} />
        <b>{GRID_MODE_INFO[mode].name}</b>
        <span className="muted">{GRID_MODE_INFO[mode].about}</span>
        {pick}
      </div>
    );
  if (mode === 'breathing') return <BreathingGrid items={items} settings={s.breathing} paused={paused} onOpen={onOpen} />;
  if (mode === 'pulse') return <PulseGrid items={items} settings={s.pulse} paused={paused} onOpen={onOpen} />;
  return <ParallaxLayers items={items} settings={s.parallax} paused={paused} onOpen={onOpen} />;
}
