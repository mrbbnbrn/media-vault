// Playback settings ("presets"): how long pictures stay, how videos and GIFs
// play, order, repeat and sound. Saved by name in the vault.

import type { Order, Repeat } from './playlist';
import { normalTransition, type Transition } from './transitions';
import type { Fit } from './flip';

export type { Fit };

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
  /** Fit (whole picture), Fill (crop edges) or Original size (never enlarged). */
  fit: Fit;
  /** With Fit or Original size: the empty space shows a blurred copy of the picture instead of black. */
  blurBg?: boolean;
  /**
   * "Repeat this one": keep showing the current item (videos and GIFs loop,
   * pictures stay); no timer, video limit or beat moves on. Skipping by hand still works.
   */
  repeatThis?: boolean;
  /** How the next item comes in (transitions.ts). Old saved values ('none', 'fade') keep working. */
  transition: Transition;
  /** "Transition speed": how long every transition takes (ms). With beat sync it gets shorter to keep up with fast music. */
  fadeMs: number;
  volume: number;
  muted: boolean;
  /** Move on with the music heard on the computer (falls back to the timer when silent). */
  beatSync: boolean;
  /** …on every 1st, 2nd or 4th beat… */
  beatEvery: 1 | 2 | 4;
  /** …but never sooner than this many seconds per item. */
  beatMinSeconds: number;
  /** "Montage": instead of every N beats, quick cuts on busy parts and long holds on calm parts. */
  beatMontage?: boolean;
  /** "Beat drop": on a big hit, move on at once with a white flash and a zoom punch. */
  beatDrop?: boolean;
  /** "Speed ramp": videos speed up and slow down in waves (slow-mo on strong beats). */
  speedRamp?: boolean;
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
  blurBg: false,
  repeatThis: false,
  transition: 'fade',
  fadeMs: 350,
  volume: 0.8,
  muted: false,
  beatSync: false,
  beatEvery: 1,
  beatMinSeconds: 0.3,
  beatMontage: false,
  beatDrop: false,
  speedRamp: false,
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
    imageSeconds: num(s.imageSeconds, 6, 0.1, 3600),
    videoMaxSeconds: num(s.videoMaxSeconds, 0, 0, 24 * 3600),
    gifLoops: Math.round(num(s.gifLoops, 3, 0, 1000)),
    gifMaxSeconds: num(s.gifMaxSeconds, 20, 0, 3600),
    speed: SPEEDS.includes(s.speed) ? s.speed : 1,
    volume: num(s.volume, 0.8, 0, 1),
    beatSync: s.beatSync === true,
    beatEvery: s.beatEvery === 2 || s.beatEvery === 4 ? s.beatEvery : 1,
    // 2 s was the old default: it made "every beat" wait about 4 beats at 120 BPM.
    beatMinSeconds: s.beatMinSeconds === 2 ? 0.3 : num(s.beatMinSeconds, 0.3, 0.1, 60),
    beatMontage: s.beatMontage === true,
    beatDrop: s.beatDrop === true,
    speedRamp: s.speedRamp === true,
    transition: normalTransition(s.transition),
    fadeMs: Math.round(num(s.fadeMs, 350, 50, 3000)),
    fit: s.fit === 'cover' || s.fit === 'original' ? s.fit : 'contain',
    blurBg: s.blurBg === true,
    repeatThis: s.repeatThis === true,
    kenBurns: s.kenBurns === true,
    depth3d: s.depth3d === true,
  };
}

/** How long a GIF should stay, given one loop's length in ms (0 = unknown). */
export function gifShowMs(s: PlaybackSettings, loopMs: number): number {
  const cap = s.gifMaxSeconds > 0 ? s.gifMaxSeconds * 1000 : Infinity;
  if (s.gifLoops > 0 && loopMs > 0) return Math.max(100, Math.min(cap, loopMs * s.gifLoops));
  if (cap !== Infinity) return Math.max(100, cap);
  return Math.max(100, s.imageSeconds * 1000, loopMs || 0);
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
