// Pulse grid maths: waves of light that run across a grid of tiles. Each
// wave says, for every tile, how long after the wave starts it lights up
// (or that it stays dark), and how strong the bump is.

export type PulsePattern = 'across' | 'centre' | 'diagonal' | 'sparkle';
export type PulseSize = 'big' | 'normal' | 'small';

export const PULSE_PATTERNS: { id: PulsePattern; label: string; hint: string }[] = [
  { id: 'across', label: 'Across', hint: 'left to right' },
  { id: 'centre', label: 'From the centre', hint: 'rings going outward' },
  { id: 'diagonal', label: 'Diagonal', hint: 'corner to corner' },
  { id: 'sparkle', label: 'Random sparkle', hint: 'a few tiles at random' },
];
export const PULSE_SIZES: { id: PulseSize; label: string; cols: number; rows: number }[] = [
  { id: 'big', label: '12 tiles', cols: 4, rows: 3 },
  { id: 'normal', label: '20 tiles', cols: 5, rows: 4 },
  { id: 'small', label: '30 tiles', cols: 6, rows: 5 },
];

export interface PulseSettings {
  pattern: PulsePattern;
  size: PulseSize;
  /** Send a wave on every beat of the music playing on the computer. */
  beat: boolean;
}
export const DEFAULT_PULSE: PulseSettings = { pattern: 'centre', size: 'normal', beat: false };

export function normalizePulse(x: unknown): PulseSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<PulseSettings>;
  return {
    pattern: PULSE_PATTERNS.some((p) => p.id === o.pattern) ? o.pattern! : DEFAULT_PULSE.pattern,
    size: PULSE_SIZES.some((p) => p.id === o.size) ? o.size! : DEFAULT_PULSE.size,
    beat: typeof o.beat === 'boolean' ? o.beat : DEFAULT_PULSE.beat,
  };
}

/** Without music: a calm wave this often (ms). */
export const CALM_WAVE_MS = 2600;
/** How long a wave takes to cross the whole grid (ms). */
export const SWEEP_MS = 900;

/**
 * When each tile (row-major) lights up in a wave, as a fraction 0..1 of the
 * sweep; null = this tile stays dark this time (sparkle only).
 */
export function waveDelays(pattern: PulsePattern, cols: number, rows: number, rnd = Math.random): (number | null)[] {
  const out: (number | null)[] = [];
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  const far = Math.hypot(cx, cy) || 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      switch (pattern) {
        case 'across': out.push(cols > 1 ? c / (cols - 1) : 0); break;
        case 'diagonal': out.push(cols + rows > 2 ? (r + c) / (cols + rows - 2) : 0); break;
        case 'centre': out.push(Math.hypot(c - cx, r - cy) / far); break;
        case 'sparkle': out.push(rnd() < 0.3 ? rnd() : null); break;
      }
    }
  }
  // Sparkle always lights at least one tile.
  if (pattern === 'sparkle' && out.length && !out.some((d) => d != null)) out[Math.floor(rnd() * out.length)] = 0;
  return out;
}

/** How a wave looks for a beat of this strength (0..1; calm waves use about 0.45). */
export function waveLook(strength: number): { scale: number; glow: number } {
  const s = Math.min(1, Math.max(0, Number.isFinite(strength) ? strength : 0.5));
  return { scale: 1.02 + 0.06 * s, glow: 0.18 + 0.55 * s };
}

/**
 * Whether this wave also swaps a tile for new media: now and then, more
 * likely on strong waves, never more often than every `minGapMs`.
 */
export function swapOnWave(now: number, lastSwap: number, strength: number, rnd = Math.random, minGapMs = 1800): boolean {
  if (now - lastSwap < minGapMs) return false;
  return rnd() < 0.3 + 0.4 * Math.min(1, Math.max(0, strength));
}

/** A tile this wave lights (so the change lands as the wave passes), not `avoid` (under the mouse). */
export function tileToSwap(delays: (number | null)[], avoid: number | null, rnd = Math.random): number {
  const lit = delays.map((d, i) => ({ d, i })).filter((x) => x.d != null && x.i !== avoid);
  const pool = lit.length ? lit : delays.map((d, i) => ({ d, i })).filter((x) => x.i !== avoid);
  if (!pool.length) return 0;
  return pool[Math.floor(rnd() * pool.length)].i;
}
