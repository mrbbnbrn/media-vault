// Breathing grid maths: a grid whose rows and columns resize like a magnifying
// lens moving over it. The track (row or column) under the lens grows, its
// neighbours shrink, and the tracks always add up to the whole screen. With no
// mouse the lens wanders by itself along a slow, smooth path.

export type BreathSize = 3 | 4 | 5;
export type BreathStrength = 'gentle' | 'strong';
export type BreathSpeed = 'calm' | 'normal' | 'fast';

export const BREATH_SIZES: { id: BreathSize; label: string }[] = [
  { id: 3, label: '3 × 3' },
  { id: 4, label: '4 × 4' },
  { id: 5, label: '5 × 5' },
];
/** How much bigger the track under the lens gets (as extra weight on its share). */
export const BREATH_STRENGTHS: { id: BreathStrength; label: string; hint: string; gain: number }[] = [
  { id: 'gentle', label: 'Gentle', hint: 'a soft swell', gain: 1.1 },
  { id: 'strong', label: 'Strong', hint: 'the piece under the lens gets much bigger', gain: 2.6 },
];
/** About how long each piece stays before it may change (seconds). */
export const BREATH_SPEEDS: { id: BreathSpeed; label: string; perTile: number }[] = [
  { id: 'calm', label: 'Calm', perTile: 30 },
  { id: 'normal', label: 'Normal', perTile: 16 },
  { id: 'fast', label: 'Fast', perTile: 7 },
];

export interface BreathingSettings {
  size: BreathSize;
  strength: BreathStrength;
  speed: BreathSpeed;
}
export const DEFAULT_BREATHING: BreathingSettings = { size: 4, strength: 'gentle', speed: 'normal' };

export function normalizeBreathing(x: unknown): BreathingSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<BreathingSettings>;
  return {
    size: BREATH_SIZES.some((s) => s.id === o.size) ? o.size! : DEFAULT_BREATHING.size,
    strength: BREATH_STRENGTHS.some((s) => s.id === o.strength) ? o.strength! : DEFAULT_BREATHING.strength,
    speed: BREATH_SPEEDS.some((s) => s.id === o.speed) ? o.speed! : DEFAULT_BREATHING.speed,
  };
}

/**
 * The share (0..1, adding up to 1) of each of `n` tracks when the lens is at
 * `at` (0..1 across). A smooth bump (Gaussian, about one track wide) on top
 * of an even share, so the change is gradual and nothing ever vanishes.
 */
export function lensShares(n: number, at: number, gain: number): number[] {
  const count = Math.max(1, Math.round(n));
  const p = Math.min(1, Math.max(0, Number.isFinite(at) ? at : 0.5));
  const sigma = 0.75 / count;
  const w = Array.from({ length: count }, (_, i) => {
    const c = (i + 0.5) / count;
    return 1 + Math.max(0, gain) * Math.exp(-((c - p) ** 2) / (2 * sigma * sigma));
  });
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / total);
}

/** Where the lens drifts when nobody moves the mouse (t in seconds): a slow Lissajous path. */
export function wanderAt(t: number): { x: number; y: number } {
  return {
    x: 0.5 + 0.4 * Math.sin(t * 0.13) * Math.cos(t * 0.031),
    y: 0.5 + 0.4 * Math.sin(t * 0.089 + 1.3),
  };
}

/** Move `cur` toward `target`, covering about 63% of the way every `tau` seconds (frame-rate independent). */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (cur - target) * Math.exp(-Math.max(0, dt) / tau);
}

/** Which track a point (0..1) is in, given the shares. */
export function trackAt(shares: number[], at: number): number {
  let acc = 0;
  for (let i = 0; i < shares.length; i++) {
    acc += shares[i];
    if (at < acc) return i;
  }
  return Math.max(0, shares.length - 1);
}
