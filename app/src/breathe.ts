// Breathe mode maths: a slideshow whose frames slowly breathe (grow and shrink
// a little, like a calm breath), and, with "Beat like a heart", give a
// "lub-dub" on every beat of the music. Pure functions only, so they can be tested.

export type BreatheLayout = 'one' | 'two' | 'three' | 'grid' | 'tall';
export type BreatheSpeed = 'calm' | 'normal' | 'fast';
/** Move on with the music every 4 or 8 beats, or keep the slideshow's own pace (0). */
export type BreatheBeatEvery = 0 | 4 | 8;

export const BREATHE_LAYOUTS: { id: BreatheLayout; label: string; hint: string; frames: number }[] = [
  { id: 'one', label: 'One big', hint: 'one picture at a time', frames: 1 },
  { id: 'two', label: 'Two side by side', hint: 'two frames', frames: 2 },
  { id: 'three', label: 'Three across', hint: 'three frames in a row', frames: 3 },
  { id: 'grid', label: '2 × 2 grid', hint: 'four frames', frames: 4 },
  { id: 'tall', label: 'Tall three', hint: 'three tall frames, good for phone videos', frames: 3 },
];
/** How long each frame keeps its picture (seconds). */
export const BREATHE_SPEEDS: { id: BreatheSpeed; label: string; stay: number }[] = [
  { id: 'calm', label: 'Calm', stay: 14 },
  { id: 'normal', label: 'Normal', stay: 8 },
  { id: 'fast', label: 'Fast', stay: 4 },
];
export const BREATHE_BEAT_EVERY: { id: BreatheBeatEvery; label: string; hint: string }[] = [
  { id: 4, label: 'Change every 4 beats', hint: 'moves on with the music' },
  { id: 8, label: 'Change every 8 beats', hint: 'moves on with the music, slower' },
  { id: 0, label: 'Change at its own pace', hint: 'only the heartbeat follows the music' },
];
/** At most this many videos play at once. */
export const BREATHE_MAX_VIDEOS = 4;
/** One breath (in and out), ms. */
export const BREATH_MS = 4600;
/** How much bigger a frame gets at the top of a breath. */
export const BREATH_DEPTH = 0.05;
/** Crossfade between two pictures in a frame, ms. */
export const FADE_MS = 1400;

export interface BreatheSettings {
  layout: BreatheLayout;
  speed: BreatheSpeed;
  /** "Beat like a heart": listen to the music and pulse on every beat. */
  heart: boolean;
  beatEvery: BreatheBeatEvery;
  /** Videos play with sound (the one under the mouse, or the first one). */
  sound: boolean;
}
export const DEFAULT_BREATHE: BreatheSettings = { layout: 'one', speed: 'normal', heart: false, beatEvery: 4, sound: false };

/** Settings from a saved layout (anything missing or odd falls back to the default). */
export function normalizeBreathe(x: unknown): BreatheSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<BreatheSettings>;
  return {
    layout: BREATHE_LAYOUTS.some((l) => l.id === o.layout) ? o.layout! : DEFAULT_BREATHE.layout,
    speed: BREATHE_SPEEDS.some((s) => s.id === o.speed) ? o.speed! : DEFAULT_BREATHE.speed,
    heart: typeof o.heart === 'boolean' ? o.heart : DEFAULT_BREATHE.heart,
    beatEvery: BREATHE_BEAT_EVERY.some((b) => b.id === o.beatEvery) ? o.beatEvery! : DEFAULT_BREATHE.beatEvery,
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULT_BREATHE.sound,
  };
}

export const frameCount = (l: BreatheLayout) => BREATHE_LAYOUTS.find((x) => x.id === l)?.frames ?? 1;
export const breatheStay = (s: BreatheSpeed) => BREATHE_SPEEDS.find((x) => x.id === s)?.stay ?? 8;

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Where the frames go on a W × H stage. There is room around every frame so it can
 * breathe and beat without touching its neighbours.
 */
export function breatheBoxes(layout: BreatheLayout, W: number, H: number): Rect[] {
  if (W <= 0 || H <= 0) return [];
  const padX = Math.round(Math.max(24, W * 0.05));
  const padY = Math.round(Math.max(24, H * 0.06));
  const gap = Math.round(Math.max(20, Math.min(W, H) * 0.05));
  const iw = Math.max(1, W - 2 * padX);
  const ih = Math.max(1, H - 2 * padY);
  const grid = (cols: number, rows: number): Rect[] => {
    // Bigger frames grow more when they breathe, so they need more room between them.
    const gx = Math.max(gap, (iw / cols) * 0.1);
    const gy = Math.max(gap, (ih / rows) * 0.1);
    const w = (iw - gx * (cols - 1)) / cols;
    const h = (ih - gy * (rows - 1)) / rows;
    const out: Rect[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: padX + c * (w + gx), y: padY + r * (h + gy), w, h });
    return out;
  };
  switch (layout) {
    case 'one': return grid(1, 1);
    case 'two': return grid(2, 1);
    case 'three': return grid(3, 1);
    case 'grid': return grid(2, 2);
    case 'tall': {
      // Three 9:16 frames, as tall as fits, centred.
      let h = ih;
      let w = (h * 9) / 16;
      if (3 * w + 2 * gap > iw) {
        w = (iw - 2 * gap) / 3;
        h = (w * 16) / 9;
      }
      const x0 = (W - (3 * w + 2 * gap)) / 2;
      const y0 = (H - h) / 2;
      return [0, 1, 2].map((i) => ({ x: x0 + i * (w + gap), y: y0, w, h }));
    }
  }
}

/** Each frame breathes a little out of step with the one before. */
export const breathPhase = (frame: number) => (frame * 0.23) % 1;

const easeInOut = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));

/**
 * How far into a breath (0 = out, 1 = full) at time `t` ms. Like a real breath:
 * breathe in (40%), a short hold, a slower breath out (45%), a short rest.
 */
export function breath(t: number, phase = 0, period = BREATH_MS): number {
  const u = (((t / period + phase) % 1) + 1) % 1;
  if (u < 0.4) return easeInOut(u / 0.4);
  if (u < 0.48) return 1;
  if (u < 0.93) return 1 - easeInOut((u - 0.48) / 0.45);
  return 0;
}

/** One quick pulse `dt` ms after it starts: a fast rise then a decay (0..1, peak 1 at 60 ms). */
function pulse(dt: number): number {
  if (dt < 0) return 0;
  const rise = 60;
  if (dt < rise) return Math.sin((dt / rise) * (Math.PI / 2));
  return Math.exp(-(dt - rise) / 110);
}

/** The second beat ("dub") comes this long after the first ("lub"). */
export const DUB_MS = 190;

/**
 * A heartbeat's extra size `dt` ms after a beat of the given strength (0..1):
 * "lub" about +6%, then "dub" about +3%, both fading. Nothing after ~1 s.
 */
export function heartbeat(dt: number, strength: number): number {
  if (dt < 0 || dt > 1200) return 0;
  const s = 0.35 + 0.65 * Math.max(0, Math.min(1, strength));
  return s * (0.06 * pulse(dt) + 0.03 * pulse(dt - DUB_MS));
}

export interface BeatHit { at: number; strength: number }

/**
 * A frame's scale at `now`: the calm breath, plus a heartbeat for each recent beat.
 * While the heart beats, the breath is shallower so the beats stand out. Frames
 * other than the first feel the beat a moment later, like a wave.
 */
export function frameScale(now: number, frame: number, beats: readonly BeatHit[], heartOn: boolean): { scale: number; glow: number } {
  const b = breath(now, breathPhase(frame));
  const depth = heartOn ? BREATH_DEPTH * 0.5 : BREATH_DEPTH;
  let beat = 0;
  if (heartOn) {
    const lag = frame * 35;
    for (const h of beats) beat += heartbeat(now - h.at - lag, h.strength);
    beat = Math.min(beat, 0.12);
  }
  return { scale: 1 + depth * b + beat, glow: Math.min(1, 0.35 + 0.65 * b * (heartOn ? 0.6 : 1) + beat * 8) };
}

/** Which frame changes next: the one that has shown its picture the longest. */
export function oldestFrame(since: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < since.length; i++) if (since[i] < since[best]) best = i;
  return best;
}

/**
 * How long until the next frame changes (ms), so every frame keeps its picture
 * about `stay` seconds and frames take turns.
 */
export function changeGap(stay: number, frames: number): number {
  return (stay * 1000) / Math.max(1, frames);
}

/** Which frames' videos may play: at most `max`, in frame order. */
export function playingVideos(kinds: readonly (string | undefined)[], max = BREATHE_MAX_VIDEOS): Set<number> {
  const out = new Set<number>();
  kinds.forEach((k, i) => {
    if (k === 'video' && out.size < max) out.add(i);
  });
  return out;
}
