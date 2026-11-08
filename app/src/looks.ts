// "Looks" that can be laid over whatever the player shows (MediaLooks.tsx):
//  - Mirror world: the picture mirrored into a symmetric, kaleidoscope-like
//    view whose source window slowly drifts and turns.
//  - Echo trail: moving videos and GIFs leave soft, fading copies behind them
//    (each new frame blended over the faded earlier ones, like a long exposure).
// The sums here are plain functions (tested); the drawing does the same in a shader.

import type { Box } from './flip';
import type { Quarter } from './rotation';

export type MirrorLook = 'off' | 'two' | 'four' | 'six';
export type EchoLook = 'off' | 'light' | 'strong';

export const MIRROR_LOOKS: { id: MirrorLook; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'as it is' },
  { id: 'two', label: 'Mirror (2 sides)', hint: 'left and right alike' },
  { id: 'four', label: 'Four ways', hint: 'mirrored in each corner' },
  { id: 'six', label: 'Kaleidoscope (6 slices)', hint: 'slowly turning' },
];
export const ECHO_LOOKS: { id: EchoLook; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'as it is' },
  { id: 'light', label: 'Light', hint: 'a short soft trail' },
  { id: 'strong', label: 'Strong', hint: 'a long trail' },
];

export const mirrorLook = (v: unknown): MirrorLook => (v === 'two' || v === 'four' || v === 'six' ? v : 'off');
export const echoLook = (v: unknown): EchoLook => (v === 'light' || v === 'strong' ? v : 'off');

/** Folds a point (relative to the centre) into the first slice: what every slice mirrors. */
export function foldPoint(mode: MirrorLook, x: number, y: number): [number, number] {
  if (mode === 'two') return [Math.abs(x), y];
  if (mode === 'four') return [Math.abs(x), Math.abs(y)];
  if (mode === 'six') {
    const seg = Math.PI / 3;
    const r = Math.hypot(x, y);
    let a = Math.atan2(y, x);
    a = a - 2 * seg * Math.floor(a / (2 * seg)); // 0 .. 2·seg
    if (a > seg) a = 2 * seg - a; // every other slice mirrored
    return [r * Math.cos(a), r * Math.sin(a)];
  }
  return [x, y];
}

/** `v` bounced back and forth inside lo..hi (a mirror at each end), so nothing is ever stretched or cut. */
export function reflect(v: number, lo: number, hi: number): number {
  const w = hi - lo;
  if (!(w > 0)) return lo;
  const t = (((v - lo) % (2 * w)) + 2 * w) % (2 * w);
  return lo + (t > w ? 2 * w - t : t);
}

/** How the source window moves at `t` seconds (half sizes hw × hh of the picture): turn, shift and scale. */
export function mirrorMotion(mode: MirrorLook, t: number, hw: number, hh: number): { angle: number; dx: number; dy: number; scale: number } {
  const wave = (period: number, phase = 0) => Math.sin((2 * Math.PI * t) / period + phase);
  const angle = mode === 'six' ? (2 * Math.PI * t) / 120 : 0.09 * wave(47);
  return {
    angle,
    dx: 0.22 * hw * wave(37),
    dy: 0.16 * hh * wave(53, 1.3),
    scale: (mode === 'six' ? 0.7 : 0.85) + 0.05 * wave(61, 0.7),
  };
}

/**
 * Where a point of the shown picture (px, py relative to its centre) takes
 * its colour from, also relative to the centre: fold, then the moving window,
 * then bounced to stay inside the picture.
 */
export function mirrorSource(mode: MirrorLook, px: number, py: number, t: number, hw: number, hh: number): [number, number] {
  const [fx, fy] = foldPoint(mode, px, py);
  const m = mirrorMotion(mode, t, hw, hh);
  const c = Math.cos(m.angle);
  const s = Math.sin(m.angle);
  const sx = (c * fx - s * fy) * m.scale + m.dx;
  const sy = (s * fx + c * fy) * m.scale + m.dy;
  return [reflect(sx, -hw, hw), reflect(sy, -hh, hh)];
}

/** Echo trail: how much of each new frame goes into the trail, and how much of the trail shows over the frame. */
export function echoAmounts(e: EchoLook): { take: number; show: number } {
  if (e === 'strong') return { take: 0.06, show: 0.55 };
  if (e === 'light') return { take: 0.18, show: 0.4 };
  return { take: 1, show: 0 };
}

/**
 * A point of a video's shown (turned) box, as parts 0..1, in the unturned
 * video frame (the turn is clockwise quarter turns, as in rotation.ts).
 */
export function unturn(r: Quarter, bx: number, by: number): [number, number] {
  switch (r) {
    case 1:
      return [by, 1 - bx];
    case 2:
      return [1 - bx, 1 - by];
    case 3:
      return [1 - by, bx];
    default:
      return [bx, by];
  }
}

/** The part of the stage the look covers: the shown media, cut to the stage (Fill runs past the edges). */
export function lookArea(drawn: Box, W: number, H: number): Box | null {
  const left = Math.max(0, drawn.left);
  const top = Math.max(0, drawn.top);
  const right = Math.min(W, drawn.left + drawn.width);
  const bottom = Math.min(H, drawn.top + drawn.height);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** The look canvas's pixel size: the stage at screen sharpness, but never bigger than `max` on its long side. */
export function lookCanvasSize(W: number, H: number, dpr: number, max = 2560): { w: number; h: number } {
  const k = Math.min(dpr || 1, max / Math.max(1, W, H));
  return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) };
}
