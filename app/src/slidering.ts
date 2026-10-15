// The slideshow's "time to next slide" ring (components/SlideRing.tsx): the
// sums on their own, so they can be tested.

import type { PlaybackSettings } from './presets';

/** What the ring shows right now. `frac` is how much of this slide has gone (0..1). */
export type RingInfo =
  | { mode: 'time'; frac: number; running: boolean; segments: number }
  | { mode: 'beat'; filled: number; every: number; running: boolean };

/** The slide timer: how long the slide shows, how much has gone before the
 *  current run (pauses keep it), and when the current run started (null = stopped). */
export interface SlideClock {
  key: string;
  ms: number;
  used: number;
  since: number | null;
  segments: number;
}

export const newClock = (): SlideClock => ({ key: '', ms: 0, used: 0, since: null, segments: 1 });

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** How much of the slide has gone at `now`. */
export function clockFrac(c: SlideClock, now: number): number {
  if (c.ms <= 0) return 0;
  return clamp01((c.used + (c.since != null ? now - c.since : 0)) / c.ms);
}

/** How long to wait for the rest of the slide: what is left, but after a
 *  pause never less than a moment, so it doesn't jump on straight away. */
export function remainingWait(c: SlideClock): number {
  return Math.max(c.used > 0 ? 400 : 0, c.ms - c.used);
}

/** A video's progress through its part of the slideshow: to its end, or to
 *  the "at most" limit counted from where it started. Null when unknown. */
export function videoFrac(at: number, start: number, dur: number, maxSeconds: number): number | null {
  if (!Number.isFinite(dur) || dur <= 0) return null;
  const end = maxSeconds > 0 ? Math.min(dur, start + maxSeconds) : dur;
  const span = end - start;
  if (span <= 0.05) return null;
  return clamp01((at - start) / span);
}

/** GIFs that play a set number of loops show one ring segment per loop
 *  (2 to 8 loops, and only when the time limit doesn't cut them short). */
export function gifSegments(s: Pick<PlaybackSettings, 'gifLoops' | 'gifMaxSeconds'>, loopMs: number): number {
  const n = s.gifLoops;
  if (n < 2 || n > 8 || loopMs <= 0) return 1;
  const total = n * loopMs;
  if (total < 1500) return 1;
  if (s.gifMaxSeconds > 0 && total > s.gifMaxSeconds * 1000) return 1;
  return n;
}

/** Beats heard since this slide came, within the "every N beats" count. */
export function beatFilled(pulse: number, base: number, every: number): number {
  const e = Math.max(1, every);
  const n = Math.max(0, pulse - base);
  return n % e;
}
