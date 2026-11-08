// The settings of the three extra wall-like modes on the Multi-screen (Breathing
// grid, Pulse grid, Parallax layers), kept together so they are saved and
// restored with a layout in one piece. Older saves have none of them.

import { DEFAULT_BREATHING, normalizeBreathing, type BreathingSettings } from './breathing';
import { DEFAULT_PARALLAX, normalizeParallax, type ParallaxSettings } from './parallax';
import { DEFAULT_PULSE, normalizePulse, type PulseSettings } from './pulse';

export type GridModeId = 'breathing' | 'pulse' | 'parallax';
export const GRID_MODE_IDS: GridModeId[] = ['breathing', 'pulse', 'parallax'];
export const isGridMode = (layout: string): layout is GridModeId => (GRID_MODE_IDS as string[]).includes(layout);

export interface GridModes {
  breathing: BreathingSettings;
  pulse: PulseSettings;
  parallax: ParallaxSettings;
}
export const DEFAULT_GRID_MODES: GridModes = { breathing: DEFAULT_BREATHING, pulse: DEFAULT_PULSE, parallax: DEFAULT_PARALLAX };

export function normalizeGridModes(x: unknown): GridModes {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<Record<GridModeId, unknown>>;
  return { breathing: normalizeBreathing(o.breathing), pulse: normalizePulse(o.pulse), parallax: normalizeParallax(o.parallax) };
}
