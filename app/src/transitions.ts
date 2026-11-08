// Transitions between items (slideshow and moving on by hand): what each one
// does, as keyframes for the picture going out (a copy of it, the "ghost") and
// the one coming in. Player.tsx / components/ItemTransition.tsx play them.
// "Transition speed" (PlaybackSettings.fadeMs) is how long every one takes.

export type Transition = 'none' | 'fade' | 'black' | 'slide' | 'zoom' | 'blur' | 'iris' | 'wipe' | 'cube' | 'curl' | 'film' | 'random'
  | 'punch' | 'whip' | 'shake' | 'spin' | 'endless' | 'edits';
/** The transitions played with a copy of the picture going out ("fade" too, when Random picks it). */
export type Effect = 'fade' | 'black' | 'slide' | 'zoom' | 'blur' | 'iris' | 'wipe' | 'cube' | 'curl' | 'film'
  | 'punch' | 'whip' | 'shake' | 'spin' | 'endless';

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
  { id: 'punch', label: 'Zoom punch', hint: 'zooms hard into the next item' },
  { id: 'whip', label: 'Whip pan', hint: 'a fast blurred swing to the side' },
  { id: 'shake', label: 'Shake', hint: 'the next item lands with a camera shake' },
  { id: 'spin', label: 'Spin', hint: 'spins fast into the next item' },
  { id: 'endless', label: 'Endless zoom', hint: 'zooms deep into the picture to find the next one' },
  { id: 'random', label: 'Random', hint: 'a different one each time' },
  { id: 'edits', label: 'Random edit style', hint: 'mixes the edit-style ones' },
];

/** Every transition Random picks from. */
export const RANDOM_POOL: Effect[] = ['fade', 'black', 'slide', 'zoom', 'blur', 'iris', 'wipe', 'cube', 'curl', 'film', 'punch', 'whip', 'shake', 'spin', 'endless'];

/** The fast "video edit" ones (Random edit style picks from these). */
export const EDIT_POOL: Effect[] = ['punch', 'whip', 'shake', 'spin', 'endless'];

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
  if (t !== 'random' && t !== 'edits') return t;
  const pool = (t === 'edits' ? EDIT_POOL : RANDOM_POOL).filter((e) => e !== last);
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

/** A spot on screen, 0..1 across and down (where Endless zoom dives in). */
export interface Spot {
  x: number;
  y: number;
}

/** Somewhere near the middle, for Endless zoom when there's no face to aim at. */
export function randomSpot(rnd: () => number = Math.random): Spot {
  return { x: 0.3 + rnd() * 0.4, y: 0.3 + rnd() * 0.4 };
}

/** How small the next item starts in Endless zoom (part of the screen). */
export const ENDLESS_START = 0.12;

/**
 * The keyframes of `e`. `dir` = 1 going to the next item, -1 to the previous
 * (things move the other way). `fromPx`: the item was already dragged this far
 * sideways (a mouse swipe), so a slide carries on from there. `spot`: where
 * Endless zoom dives in (the middle if not given).
 */
export function transitionPlan(e: Effect, dir: 1 | -1, fromPx = 0, spot: Spot = { x: 0.5, y: 0.5 }): TransitionPlan {
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
    case 'punch': {
      // Ease in hard towards the middle, then the next one snaps out of it.
      const pull = 'cubic-bezier(0.75, 0, 0.95, 0.45)';
      const snap = 'cubic-bezier(0.15, 0.85, 0.3, 1)';
      return {
        ghostOnTop: true, easing: 'linear',
        out: [
          { transform: 'scale(1)', filter: 'blur(0px)', opacity: 1, easing: pull },
          { transform: 'scale(2.6)', filter: 'blur(14px)', opacity: 1, offset: 0.5 },
          { transform: 'scale(3.2)', filter: 'blur(18px)', opacity: 0, offset: 0.62 },
          { transform: 'scale(3.2)', filter: 'blur(18px)', opacity: 0 },
        ],
        in: [
          { transform: 'scale(2.2)', filter: 'blur(16px)', opacity: 0 },
          { transform: 'scale(2.2)', filter: 'blur(16px)', opacity: 0, offset: 0.48, easing: snap },
          { transform: 'scale(0.97)', filter: 'blur(0px)', opacity: 1, offset: 0.86, easing: 'ease-in-out' },
          { transform: 'scale(1)', filter: 'blur(0px)', opacity: 1 },
        ],
      };
    }
    case 'whip': {
      // Like the camera was swung: both move as one strip, speeding up, blurred
      // and stretched along the way, and the next one overshoots a little.
      const go = 'cubic-bezier(0.6, 0, 0.95, 0.5)';
      const far = 115 * dir;
      return {
        ghostOnTop: true, easing: 'linear',
        out: [
          { transform: `translateX(${px}px) scaleX(1)`, filter: 'blur(0px)', easing: go },
          { transform: `translateX(${-far}%) scaleX(1.3)`, filter: 'blur(22px)', offset: 0.5 },
          { transform: `translateX(${-far}%) scaleX(1.3)`, filter: 'blur(22px)' },
        ],
        in: [
          { transform: `translateX(calc(${far}% + ${px}px)) scaleX(1.3)`, filter: 'blur(22px)', easing: go },
          { transform: 'translateX(0%) scaleX(1.3)', filter: 'blur(22px)', offset: 0.5, easing: 'cubic-bezier(0.1, 0.6, 0.3, 1)' },
          { transform: `translateX(${-3 * dir}%) scaleX(1.07)`, filter: 'blur(2px)', offset: 0.74, easing: 'ease-in-out' },
          { transform: 'translateX(0%) scaleX(1)', filter: 'blur(0px)' },
        ],
      };
    }
    case 'shake': {
      // The old one is gone at once; the next lands with a few jolts that die down
      // (a little bigger than the screen, so the edges don't show).
      const jolts: [number, number, number, number][] = [
        // offset, x %, y %, turn (deg)
        [0.1, 4, -1.2, -1.6], [0.22, -3, 1, 1.3], [0.36, 2, -0.7, -0.9],
        [0.5, -1.1, 0.5, 0.55], [0.66, 0.6, -0.25, -0.25], [0.82, -0.2, 0.1, 0.1],
      ];
      const n = jolts.length;
      return {
        ghostOnTop: true, easing: 'linear',
        out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.08)', offset: 0.12 }, { opacity: 0, transform: 'scale(1.08)' }],
        in: [
          { transform: 'translate(0%, 0%) rotate(0deg) scale(1.1)', filter: 'brightness(1.35)', easing: 'ease-out' },
          ...jolts.map(([offset, x, y, r], i): Keyframe => ({
            offset, easing: 'ease-in-out',
            transform: `translate(${x * dir}%, ${y}%) rotate(${r * dir}deg) scale(${(1.1 - (0.08 * (i + 1)) / n).toFixed(3)})`,
            filter: i === 0 ? 'brightness(1.1)' : 'brightness(1)',
          })),
          { transform: 'translate(0%, 0%) rotate(0deg) scale(1)', filter: 'brightness(1)' },
        ],
      };
    }
    case 'spin': {
      // A fast turn: the old one spins away getting bigger, the next spins in and settles.
      const pull = 'cubic-bezier(0.7, 0, 0.95, 0.5)';
      return {
        ghostOnTop: true, easing: 'linear',
        out: [
          { transform: 'rotate(0deg) scale(1)', filter: 'blur(0px)', opacity: 1, easing: pull },
          { transform: `rotate(${110 * dir}deg) scale(1.9)`, filter: 'blur(16px)', opacity: 1, offset: 0.48 },
          { transform: `rotate(${150 * dir}deg) scale(2.2)`, filter: 'blur(18px)', opacity: 0, offset: 0.6 },
          { transform: `rotate(${150 * dir}deg) scale(2.2)`, filter: 'blur(18px)', opacity: 0 },
        ],
        in: [
          { transform: `rotate(${-150 * dir}deg) scale(2.2)`, filter: 'blur(18px)', opacity: 0 },
          { transform: `rotate(${-110 * dir}deg) scale(1.9)`, filter: 'blur(16px)', opacity: 0, offset: 0.42, easing: 'cubic-bezier(0.1, 0.7, 0.3, 1)' },
          { transform: `rotate(${4 * dir}deg) scale(0.98)`, filter: 'blur(0px)', opacity: 1, offset: 0.88, easing: 'ease-in-out' },
          { transform: 'rotate(0deg) scale(1)', filter: 'blur(0px)', opacity: 1 },
        ],
      };
    }
    case 'endless': {
      // The next item starts as a small picture inside the old one, at `spot`;
      // both grow together around that spot (the next one is a fixed part of the
      // old one's picture), evenly in steps so the zoom feels steady.
      const s = ENDLESS_START;
      const at = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) * 100 : 50).toFixed(2);
      const origin = `${at(spot.x)}% ${at(spot.y)}%`;
      const steps = 6;
      const out: Keyframe[] = [];
      const inn: Keyframe[] = [];
      for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        const k = Math.pow(1 / s, p); // the old one, 1 -> 1/s
        out.push({
          offset: p, transformOrigin: origin, transform: `scale(${k.toFixed(4)})`,
          filter: `blur(${(Math.pow(p, 1.5) * 12).toFixed(1)}px)`, opacity: p < 0.6 ? 1 : Math.max(0, 1 - (p - 0.6) / 0.4),
        });
        inn.push({ offset: p, transformOrigin: origin, transform: `scale(${(s * k).toFixed(4)})`, opacity: Math.min(1, p / 0.12) });
      }
      return { ghostOnTop: false, easing: 'cubic-bezier(0.55, 0, 0.3, 1)', out, in: inn };
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
