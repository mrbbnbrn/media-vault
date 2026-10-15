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
  /** How long a fade between items takes (ms). With beat sync it gets shorter to keep up with fast music. */
  fadeMs: number;
  volume: number;
  muted: boolean;
  /** Move on with the music heard on the computer (falls back to the timer when silent). */
  beatSync: boolean;
  /** …on every 1st, 2nd or 4th beat… */
  beatEvery: 1 | 2 | 4;
  /** …but never sooner than this many seconds per item. */
  beatMinSeconds: number;
  /** Pictures slowly pan and zoom while they show. */
  kenBurns: boolean;
  /**
   * Old: 3D photos used to be a slideshow setting. It is now a viewer setting
   * (View ▾ → 3D photos, ViewerSettings.depthAuto); this is still read so old
   * presets load, and carried over once (depthToCarryOver).
   */
  depth3d: boolean;
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
  fadeMs: 350,
  volume: 0.8,
  muted: false,
  beatSync: false,
  beatEvery: 1,
  beatMinSeconds: 0.3,
  kenBurns: false,
  depth3d: false,
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
    beatSync: s.beatSync === true,
    beatEvery: s.beatEvery === 2 || s.beatEvery === 4 ? s.beatEvery : 1,
    // 2 s was the old default: it made "every beat" wait about 4 beats at 120 BPM.
    beatMinSeconds: s.beatMinSeconds === 2 ? 0.3 : num(s.beatMinSeconds, 0.3, 0.1, 60),
    fadeMs: Math.round(num(s.fadeMs, 350, 50, 3000)),
    kenBurns: s.kenBurns === true,
    depth3d: s.depth3d === true,
  };
}

/** How long a GIF should stay, given one loop's length in ms (0 = unknown). */
export function gifShowMs(s: PlaybackSettings, loopMs: number): number {
  const cap = s.gifMaxSeconds > 0 ? s.gifMaxSeconds * 1000 : Infinity;
  if (s.gifLoops > 0 && loopMs > 0) return Math.min(cap, Math.max(loopMs * s.gifLoops, 1500));
  if (cap !== Infinity) return cap;
  return Math.max(s.imageSeconds * 1000, loopMs || 0);
}

/**
 * Whether the old slideshow setting "3D photos" should turn on the viewer
 * setting that replaced it: once only (so turning it off later sticks), and
 * only if it was on in the current slideshow settings or a saved preset.
 */
export function depthToCarryOver(
  viewer: { depthAutoMigrated?: boolean },
  settings: (Partial<PlaybackSettings> | null | undefined)[],
): boolean {
  return !viewer.depthAutoMigrated && settings.some((s) => s?.depth3d === true);
}
