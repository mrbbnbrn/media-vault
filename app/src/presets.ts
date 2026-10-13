// Playback settings ("presets"): how long pictures stay, how videos and GIFs
// play, order, repeat and sound. Saved by name in the vault.

import type { Order, Repeat } from './playlist';

export interface PlaybackSettings {
  imageSeconds: number;
  /** Videos: stop after this many seconds (0 = play to the end). */
  videoMaxSeconds: number;
  videoRandomStart: boolean;
  /** GIFs / animated WebP: play this many loops (0 = use gifSeconds). */
  gifLoops: number;
  /** Used when loops is 0, or as an upper limit. 0 = no limit. */
  gifMaxSeconds: number;
  order: Order;
  repeat: Repeat;
  speed: number;
  fit: 'contain' | 'cover';
  transition: 'none' | 'fade';
  volume: number;
  muted: boolean;
}

export const DEFAULT_PLAYBACK: PlaybackSettings = {
  imageSeconds: 6,
  videoMaxSeconds: 0,
  videoRandomStart: false,
  gifLoops: 3,
  gifMaxSeconds: 20,
  order: 'nameAsc',
  repeat: 'all',
  speed: 1,
  fit: 'contain',
  transition: 'fade',
  volume: 0.8,
  muted: false,
};

export const SPEEDS = [0.5, 1, 2];

export function normalize(p: Partial<PlaybackSettings> | null | undefined): PlaybackSettings {
  const s = { ...DEFAULT_PLAYBACK, ...(p ?? {}) };
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    ...s,
    imageSeconds: num(s.imageSeconds, 6, 1, 3600),
    videoMaxSeconds: num(s.videoMaxSeconds, 0, 0, 24 * 3600),
    gifLoops: Math.round(num(s.gifLoops, 3, 0, 1000)),
    gifMaxSeconds: num(s.gifMaxSeconds, 20, 0, 3600),
    speed: SPEEDS.includes(s.speed) ? s.speed : 1,
    volume: num(s.volume, 0.8, 0, 1),
  };
}

/** How long a GIF should stay, given one loop's length in ms (0 = unknown). */
export function gifShowMs(s: PlaybackSettings, loopMs: number): number {
  const cap = s.gifMaxSeconds > 0 ? s.gifMaxSeconds * 1000 : Infinity;
  if (s.gifLoops > 0 && loopMs > 0) return Math.min(cap, Math.max(loopMs * s.gifLoops, 1500));
  if (cap !== Infinity) return cap;
  return Math.max(s.imageSeconds * 1000, loopMs || 0);
}
