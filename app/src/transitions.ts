// Transitions between items (slideshow and moving on by hand): what each one
// does, as keyframes for the picture going out (a copy of it, the "ghost") and
// the one coming in. Player.tsx / components/ItemTransition.tsx play them.
// "Transition speed" (PlaybackSettings.fadeMs) is how long every one takes.

export type Transition = 'none' | 'fade' | 'black' | 'slide' | 'zoom' | 'blur' | 'iris' | 'wipe' | 'cube' | 'curl' | 'film' | 'random';
/** The transitions played with a copy of the picture going out ("fade" too, when Random picks it). */
export type Effect = 'fade' | 'black' | 'slide' | 'zoom' | 'blur' | 'iris' | 'wipe' | 'cube' | 'curl' | 'film';

export const TRANSITIONS: { id: Transition; label: string; hint: string }[] = [
  { id: 'none', label: 'None', hint: 'the next item shows straight away' },
  { id: 'fade', label: 'Fade', hint: 'the next item fades in' },
  { id: 'black', label: 'Through black', hint: 'fades to black, then into the next item' },
  { id: 'slide', label: 'Slide', hint: 'the next item slides in from the side' },
  { id: 'zoom', label: 'Zoom', hint: 'zooms out of one item and into the next' },
  { id: 'blur', label: 'Blur', hint: 'blurs into the next item' },
  { id: 'iris', label: 'Iris', hint: 'the next item opens up in a growing circle' },
  { id: 'wipe', label: 'Wipe', hint: 'the next item is wiped across' },
  { id: 'cube', label: 'Cube', hint: 'turns like the sides of a cube' },
  { id: 'curl', label: 'Page curl', hint: 'the item turns away like a page' },
  { id: 'film', label: 'Film strip', hint: 'moves on like a film strip' },
  { id: 'random', label: 'Random', hint: 'a different one each time' },
];

/** Every transition Random picks from. */
export const RANDOM_POOL: Effect[] = ['fade', 'black', 'slide', 'zoom', 'blur', 'iris', 'wipe', 'cube', 'curl', 'film'];

const IDS = new Set<string>(TRANSITIONS.map((t) => t.id));

/** A saved value read back: anything unknown (or missing) is the old default, Fade. */
export function normalTransition(v: unknown): Transition {
  return typeof v === 'string' && IDS.has(v) ? (v as Transition) : 'fade';
}

/**
 * What plays when moving on: null = nothing to play here ("None", or the plain
 * "Fade", which the new item does by itself). Random never picks the same one twice in a row.
 */
export function pickEffect(t: Transition, last: Effect | null, rnd: () => number = Math.random): Effect | null {
  if (t === 'none' || t === 'fade') return null;
  if (t !== 'random') return t;
  const pool = RANDOM_POOL.filter((e) => e !== last);
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

export interface TransitionPlan {
  /** The copy of the old item lies over the new one (otherwise under it, and the new one is revealed). */
  ghostOnTop: boolean;
  out: Keyframe[];
  in: Keyframe[];
  easing: string;
  /** Film strip: the strip with its holes shows behind while it plays. */
  film?: boolean;
}

/**
 * The keyframes of `e`. `dir` = 1 going to the next item, -1 to the previous
 * (things move the other way). `fromPx`: the item was already dragged this far
 * sideways (a mouse swipe), so a slide carries on from there.
 */
export function transitionPlan(e: Effect, dir: 1 | -1, fromPx = 0): TransitionPlan {
  const smooth = 'cubic-bezier(0.25, 0.8, 0.25, 1)';
  const inOut = 'ease-in-out';
  const px = Math.round(fromPx);
  switch (e) {
    case 'fade':
      return { ghostOnTop: true, easing: inOut, out: [{ opacity: 1 }, { opacity: 0 }], in: [{ opacity: 0 }, { opacity: 1 }] };
    case 'black':
      return {
        ghostOnTop: true, easing: 'linear',
        out: [{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }],
        in: [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }],
      };
    case 'slide':
      return {
        ghostOnTop: true, easing: smooth,
        out: [{ transform: `translateX(${px}px)` }, { transform: `translateX(${-100 * dir}%)` }],
        in: [{ transform: `translateX(calc(${100 * dir}% + ${px}px))` }, { transform: 'translateX(0)' }],
      };
    case 'zoom':
      return {
        ghostOnTop: true, easing: smooth,
        out: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.3)', opacity: 0 }],
        in: [{ transform: 'scale(0.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      };
    case 'blur':
      return {
        ghostOnTop: true, easing: inOut,
        out: [{ filter: 'blur(0px)', opacity: 1 }, { filter: 'blur(28px)', opacity: 0 }],
        in: [{ filter: 'blur(28px)', opacity: 0 }, { filter: 'blur(0px)', opacity: 1 }],
      };
    case 'iris':
      return {
        ghostOnTop: false, easing: 'cubic-bezier(0.45, 0, 0.2, 1)',
        out: [{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0.6 }],
        in: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(72% at 50% 50%)' }],
      };
    case 'wipe':
      return {
        ghostOnTop: false, easing: inOut,
        out: [{ opacity: 1 }, { opacity: 1 }],
        in: dir > 0
          ? [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }]
          : [{ clipPath: 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0%)' }],
      };
    case 'cube': {
      // The shared edge moves across: the old side turns away, the new side turns in.
      const o = dir > 0 ? '100% 50%' : '0% 50%';
      const n = dir > 0 ? '0% 50%' : '100% 50%';
      return {
        ghostOnTop: true, easing: inOut,
        out: [
          { transformOrigin: o, transform: 'perspective(1600px) translateX(0) rotateY(0deg)', filter: 'brightness(1)' },
          { transformOrigin: o, transform: `perspective(1600px) translateX(${-100 * dir}%) rotateY(${-90 * dir}deg)`, filter: 'brightness(0.45)' },
        ],
        in: [
          { transformOrigin: n, transform: `perspective(1600px) translateX(${100 * dir}%) rotateY(${90 * dir}deg)`, filter: 'brightness(0.45)' },
          { transformOrigin: n, transform: 'perspective(1600px) translateX(0) rotateY(0deg)', filter: 'brightness(1)' },
        ],
      };
    }
    case 'curl': {
      // The old item turns away like a page, hinged on one side, darkening as it goes.
      const o = dir > 0 ? '0% 50%' : '100% 50%';
      return {
        ghostOnTop: true, easing: 'cubic-bezier(0.5, 0, 0.3, 1)',
        out: [
          { transformOrigin: o, transform: 'perspective(1800px) rotateY(0deg) skewY(0deg)', filter: 'brightness(1)', opacity: 1 },
          { transformOrigin: o, transform: `perspective(1800px) rotateY(${-60 * dir}deg) skewY(${-4 * dir}deg)`, filter: 'brightness(0.8)', opacity: 1, offset: 0.6 },
          { transformOrigin: o, transform: `perspective(1800px) rotateY(${-100 * dir}deg) skewY(${-6 * dir}deg)`, filter: 'brightness(0.4)', opacity: 0 },
        ],
        in: [{ filter: 'brightness(0.55)' }, { filter: 'brightness(1)' }],
      };
    }
    case 'film': {
      const s = 0.8;
      const gap = 112;
      return {
        ghostOnTop: true, easing: inOut, film: true,
        out: [
          { transform: 'translateX(0) scale(1)' },
          { transform: `translateX(0) scale(${s})`, offset: 0.25 },
          { transform: `translateX(${-gap * s * dir}%) scale(${s})`, offset: 0.75 },
          { transform: `translateX(${-gap * s * dir}%) scale(${s})` },
        ],
        in: [
          { transform: `translateX(${gap * s * dir}%) scale(${s})` },
          { transform: `translateX(${gap * s * dir}%) scale(${s})`, offset: 0.25 },
          { transform: `translateX(0) scale(${s})`, offset: 0.75 },
          { transform: 'translateX(0) scale(1)' },
        ],
      };
    }
  }
}

/**
 * How long a transition takes: the setting, but with beat sync never longer
 * than about a third of the time between changes, so it keeps up with fast music.
 */
export function transitionMs(setting: number, beatBpm: number | null, beatEvery: number): number {
  if (beatBpm && beatBpm > 0) return Math.max(60, Math.min(setting, (60000 / beatBpm) * beatEvery * 0.35));
  return setting;
}
