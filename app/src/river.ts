// The discovery river's maths, kept apart so it can be tested: depth layers,
// where items float in, how they drift (and queue politely behind one you are
// looking at), when they leave and are reused, and what is under the mouse.
// The drawing is components/river/engine.ts.

export interface LayerSpec {
  /** Card height as a share of the screen height. */
  size: number;
  /** Drift speed (px/s on a 1080 px tall screen, at normal flow). */
  speed: number;
  /** Look: dimmer, softer and blurrier further away. */
  opacity: number;
  blur: number;
  bright: number;
  /** Where card centres may sit (share of the screen height). */
  yMin: number;
  yMax: number;
  /** Space between neighbours, as a share of the card height (random in between). */
  gapMin: number;
  gapMax: number;
  /** Gentle bob (share of screen height) and sway (degrees). */
  bob: number;
  sway: number;
}

/** The five designed depths, far to near. Even the furthest stays recognisable. */
const BASE: LayerSpec[] = [
  { size: 0.085, speed: 6, opacity: 0.55, blur: 1.4, bright: 0.68, yMin: 0.24, yMax: 0.6, gapMin: 0.3, gapMax: 1.3, bob: 0.003, sway: 0.4 },
  { size: 0.115, speed: 10, opacity: 0.66, blur: 0.9, bright: 0.76, yMin: 0.2, yMax: 0.68, gapMin: 0.45, gapMax: 1.6, bob: 0.004, sway: 0.6 },
  { size: 0.155, speed: 16, opacity: 0.78, blur: 0.5, bright: 0.85, yMin: 0.16, yMax: 0.76, gapMin: 0.6, gapMax: 1.9, bob: 0.006, sway: 0.9 },
  { size: 0.215, speed: 26, opacity: 0.92, blur: 0.15, bright: 0.94, yMin: 0.14, yMax: 0.84, gapMin: 0.9, gapMax: 2.5, bob: 0.008, sway: 1.2 },
  { size: 0.31, speed: 41, opacity: 1, blur: 0, bright: 1, yMin: 0.16, yMax: 0.86, gapMin: 1.4, gapMax: 3.4, bob: 0.01, sway: 1.5 },
];

/** How many depths the river can have (the Layers slider). */
export const MIN_LAYERS = 2;
export const MAX_LAYERS = 8;
export const DEFAULT_LAYERS = BASE.length;

/**
 * `n` depths, far to near. Fewer than five keeps the nearest ones (two = a
 * front row and the row just behind it); more than five puts extra depths in
 * between, for a crowded screen.
 */
export function makeLayers(n: number): LayerSpec[] {
  const count = Math.max(MIN_LAYERS, Math.min(MAX_LAYERS, Math.round(n)));
  const from = count >= BASE.length ? 0 : BASE.length - count;
  const span = BASE.length - 1 - from;
  const out: LayerSpec[] = [];
  for (let i = 0; i < count; i++) {
    const at = from + (count === 1 ? span : (span * i) / (count - 1));
    const a = BASE[Math.floor(at)];
    const b = BASE[Math.min(BASE.length - 1, Math.floor(at) + 1)];
    const t = at - Math.floor(at);
    const mix = (k: keyof LayerSpec) => a[k] + (b[k] - a[k]) * t;
    out.push({
      size: mix('size'), speed: mix('speed'), opacity: mix('opacity'), blur: mix('blur'), bright: mix('bright'), yMin: mix('yMin'), yMax: mix('yMax'),
      gapMin: mix('gapMin'), gapMax: mix('gapMax'), bob: mix('bob'), sway: mix('sway'),
    });
  }
  // With more than five, each depth gets a little less crowded, so the screen stays readable.
  if (count > BASE.length) for (const l of out) {
    l.gapMin *= count / BASE.length;
    l.gapMax *= count / BASE.length;
  }
  return out;
}

/** The depths in use (changed in place by setLayerCount, so every importer sees the change). */
export const LAYERS: LayerSpec[] = makeLayers(DEFAULT_LAYERS);
// eslint-disable-next-line import/no-mutable-exports
export let NEAREST = LAYERS.length - 1;

export function setLayerCount(n: number) {
  const next = makeLayers(n);
  LAYERS.length = 0;
  LAYERS.push(...next);
  NEAREST = LAYERS.length - 1;
}

/** How many items flow (the Flow amount slider): 1 = as designed; more = smaller gaps. */
export const MIN_DENSITY = 0.4;
export const MAX_DENSITY = 2.5;
let density = 1;
export function setDensity(d: number) {
  density = Math.max(MIN_DENSITY, Math.min(MAX_DENSITY, d));
}
export const getDensity = () => density;

export interface Drifter {
  /** Unique, for the drawing to keep its card. */
  key: number;
  layer: number;
  /** Index into the river's items. */
  item: number;
  /** Centre, px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Bob/sway phase and resting tilt (degrees). */
  phase: number;
  tilt: number;
  /** 0–1: brought forward under the mouse (eased). */
  lift: number;
  /** 0–1: faded in after appearing (eased). */
  shown: number;
  /** Held by the mouse: follows it, nothing else moves it. */
  held?: boolean;
  /** Frozen in place (right-click while holding): stays until grabbed again. */
  frozen?: boolean;
  /** Thrown: its own speed (px/s), slowing down; the current carries it as well. */
  vx?: number;
  vy?: number;
}

/** Out of the stream (held, frozen or thrown): others don't queue behind it, and it can leave any way. */
export const loose = (d: Drifter) => !!(d.held || d.frozen || d.vx || d.vy);

export interface View {
  w: number;
  h: number;
  /** Gentler: slower, no bob or sway. */
  reduced: boolean;
}

export type Rand = () => number;

/** A deterministic random source (for tests and stable layouts). */
export function seeded(seed: number): Rand {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Hands out items in a shuffled order and starts a new shuffle when all have
 * been shown; never one that is on screen already (when there are enough).
 */
export class Deck {
  private order: number[] = [];
  private at = 0;
  constructor(private readonly n: number, private readonly rand: Rand = Math.random) {}

  private shuffle() {
    this.order = Array.from({ length: this.n }, (_, i) => i);
    for (let i = this.n - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    this.at = 0;
  }

  next(showing: Set<number>): number {
    if (this.n <= 0) return -1;
    for (let tries = 0; tries < this.n + 1; tries++) {
      if (this.at >= this.order.length) this.shuffle();
      const i = this.order[this.at++];
      if (!showing.has(i) || showing.size >= this.n) return i;
    }
    return this.order[0] ?? 0;
  }
}

/** The size cards and speeds follow: the screen height, or less on a tall narrow window. */
export const unit = (v: View) => Math.min(v.h, v.w * 0.72);

/** Card size for an item of this shape in a layer (wide and tall pictures kept within reason). */
export function cardSize(layer: number, aspect: number, v: View): { w: number; h: number } {
  const a = Math.max(0.6, Math.min(1.8, Number.isFinite(aspect) && aspect > 0 ? aspect : 4 / 3));
  // Very wide pictures are a little shorter, so all have a similar weight.
  const h = LAYERS[layer].size * unit(v) * (a > 1.35 ? Math.sqrt(1.35 / a) : 1);
  return { w: h * a, h };
}

/** px/s for a layer at this flow. */
export function layerSpeed(layer: number, flow: number, v: View): number {
  return LAYERS[layer].speed * (unit(v) / 1080) * flow * (v.reduced ? 0.5 : 1);
}

const MARGIN = 0.06;
/** How far beyond the screen edges cards are kept (px). */
export const margin = (v: View) => Math.max(40, v.w * MARGIN);

export interface Spawner {
  /** Picks the next item and its shape (width / height). */
  pick: () => { item: number; aspect: number } | null;
  rand: Rand;
}

let nextKey = 1;

function make(layer: number, x: number, v: View, s: Spawner, leftOf?: Drifter): Drifter | null {
  const p = s.pick();
  if (!p) return null;
  const L = LAYERS[layer];
  const { w, h } = cardSize(layer, p.aspect, v);
  const lo = L.yMin * v.h + h / 2 * 0.3;
  const hi = L.yMax * v.h - h / 2 * 0.3;
  let y = lo + s.rand() * Math.max(0, hi - lo);
  // Not straight behind the one it follows: keeps the stream loose, not a queue.
  if (leftOf && Math.abs(leftOf.y - y) < h * 0.35) y = y < v.h / 2 ? Math.min(hi, y + h * 0.45) : Math.max(lo, y - h * 0.45);
  let right = x;
  if (leftOf && right > leftOf.x - leftOf.w / 2 - 4 && Math.abs(leftOf.y - y) < (h + leftOf.h) / 2 + 4) {
    // A busy river packs cards closer than a card's width: then this one takes a row above or below
    // the one it follows; with no room for that, it waits its turn behind it.
    const need = (h + leftOf.h) / 2 + 6;
    const up = leftOf.y - need;
    const down = leftOf.y + need;
    const fits = [up, down].filter((c) => c >= lo && c <= hi);
    if (fits.length) y = fits.reduce((a, c) => (Math.abs(c - y) < Math.abs(a - y) ? c : a));
    else right = leftOf.x - leftOf.w / 2 - 4;
  }
  return {
    key: nextKey++, layer, item: p.item, x: right - w / 2, y, w, h, phase: s.rand() * Math.PI * 2, tilt: (s.rand() - 0.5) * 2 * L.sway * 0.8,
    lift: 0, shown: 0,
  };
}

const gapFor = (layer: number, h: number, r: Rand) => {
  const L = LAYERS[layer];
  const g = (h * (L.gapMin + r() * (L.gapMax - L.gapMin))) / density;
  // Above the designed amount, the next card may start before this one ends (it takes another row).
  return density > 1 ? g - h * 0.9 * (1 - 1 / density) : g;
};

/** A thrown card slows to the current's pace over about a second. */
const THROW_FRICTION = 1.8;

/** The opening picture: every layer filled across the whole width, at random spacing. */
export function fill(v: View, s: Spawner): Drifter[] {
  const out: Drifter[] = [];
  for (let layer = 0; layer < LAYERS.length; layer++) {
    // Starting a little in, so the first card isn't always at the very edge.
    let right = v.w + margin(v) - s.rand() * LAYERS[layer].size * unit(v) * 2;
    let prev: Drifter | undefined;
    while (right > -margin(v)) {
      const d = make(layer, right, v, s, prev);
      if (!d) return out;
      out.push(d);
      prev = d;
      right = d.x - d.w / 2 - gapFor(layer, d.h, s.rand);
    }
  }
  return out;
}

const overlapY = (a: Drifter, b: Drifter) => Math.abs(a.y - b.y) < (a.h + b.h) / 2;

/**
 * One frame: drift right, ease the lift and fade, queue behind a slowed card
 * in the same layer, drop cards that have left on the right and float new ones
 * in on the left. Returns the dropped cards (their drawings can be reused).
 */
export function step(list: Drifter[], dt: number, flow: number, v: View, s: Spawner, hovered: number | null): { gone: Drifter[]; added: Drifter[] } {
  const gone: Drifter[] = [];
  const added: Drifter[] = [];
  const dts = Math.min(0.1, Math.max(0, dt));
  const ease = (from: number, to: number, rate: number) => from + (to - from) * (1 - Math.exp(-rate * dts));
  const m = margin(v);
  for (let layer = 0; layer < LAYERS.length; layer++) {
    const all = list.filter((d) => d.layer === layer);
    const base = layerSpeed(layer, flow, v);
    // Held, frozen and thrown cards move on their own.
    for (const d of all) {
      if (!loose(d)) continue;
      d.lift = ease(d.lift, d.held || d.key === hovered ? 1 : 0, 7);
      d.shown = 1;
      if (d.held || d.frozen) continue;
      const k = Math.exp(-THROW_FRICTION * dts);
      d.x += ((d.vx ?? 0) + base) * dts;
      d.y += (d.vy ?? 0) * dts;
      d.vx = (d.vx ?? 0) * k;
      d.vy = (d.vy ?? 0) * k;
      // Slowed down to the current: back in the stream.
      if (Math.hypot(d.vx, d.vy) < 8) {
        d.vx = 0;
        d.vy = 0;
      }
      const out = d.x - d.w / 2 > v.w + m || d.x + d.w / 2 < -m * 3 || d.y - d.h / 2 > v.h + m || d.y + d.h / 2 < -m;
      if (out) gone.push(d);
    }
    const mine = all.filter((d) => !loose(d)).sort((a, b) => b.x - a.x);
    for (let i = 0; i < mine.length; i++) {
      const d = mine[i];
      d.lift = ease(d.lift, d.key === hovered ? 1 : 0, d.key === hovered ? 7 : 4);
      d.shown = ease(d.shown, 1, 1.6);
      if (d.shown > 0.999) d.shown = 1;
      // Hovered: almost holds still.
      let nx = d.x + base * (1 - 0.9 * d.lift) * dts;
      for (let j = 0; j < i; j++) {
        const f = mine[j];
        if (!overlapY(d, f)) continue;
        const limit = f.x - (f.w + d.w) / 2 - d.h * 0.12;
        if (nx > limit) nx = Math.max(d.x, limit);
      }
      d.x = nx;
      if (d.x - d.w / 2 > v.w + m) gone.push(d);
    }
    // Room on the left: float new ones in.
    const left = mine.filter((d) => !gone.includes(d)).reduce<Drifter | undefined>((a, d) => (!a || d.x < a.x ? d : a), undefined);
    let edge = left ? left.x - left.w / 2 - gapFor(layer, left.h, s.rand) : v.w + m;
    let prev = left;
    let guard = 0;
    while (edge > -m && guard++ < 40) {
      const d = make(layer, edge, v, s, prev);
      if (!d) break;
      d.shown = left ? 1 : 0;
      added.push(d);
      prev = d;
      edge = d.x - d.w / 2 - gapFor(layer, d.h, s.rand);
    }
  }
  if (gone.length) {
    const out = new Set(gone);
    for (let i = list.length - 1; i >= 0; i--) if (out.has(list[i])) list.splice(i, 1);
  }
  list.push(...added);
  return { gone, added };
}

export interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  scale: number;
}

/** Where a card is drawn now (with its bob, sway and lift). */
export function placed(d: Drifter, t: number, v: View): Placed {
  const L = LAYERS[d.layer];
  const calm = v.reduced || d.held || d.frozen ? 0 : 1;
  const bob = Math.sin(t * 0.55 + d.phase) * L.bob * v.h * calm * (1 - d.lift);
  const sway = Math.sin(t * 0.37 + d.phase * 1.7) * L.sway * calm * (1 - d.lift);
  const scale = 1 + d.lift * (d.layer === NEAREST ? 0.1 : 0.22);
  return { x: d.x, y: d.y + bob - d.lift * v.h * 0.01, w: d.w, h: d.h, rot: (d.tilt + sway) * (1 - d.lift), scale };
}

/** The card under the point: nearer layers first, then the one drawn last. */
export function hitTest(list: Drifter[], px: number, py: number, t: number, v: View, hovered: number | null = null): Drifter | null {
  let best: Drifter | null = null;
  let rank = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.shown < 0.3) continue;
    const p = placed(d, t, v);
    // A little generous around the one already under the mouse, so it doesn't flicker at the edge.
    const pad = d.key === hovered ? 6 : 0;
    if (Math.abs(px - p.x) > (p.w * p.scale) / 2 + pad || Math.abs(py - p.y) > (p.h * p.scale) / 2 + pad) continue;
    const r = (d.held ? 1000 : 0) + (d.key === hovered ? 100 : 0) + (d.frozen ? 50 : 0) + d.layer * 10 + i / list.length;
    if (r > rank) {
      rank = r;
      best = d;
    }
  }
  return best;
}

/** Flow speeds (the wheel moves smoothly between these; ←/→ step through them). */
export const FLOWS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
export const MIN_FLOW = FLOWS[0];
export const MAX_FLOW = FLOWS[FLOWS.length - 1];

export function stepFlow(flow: number, dir: 1 | -1): number {
  if (dir > 0) return FLOWS.find((f) => f > flow + 1e-6) ?? MAX_FLOW;
  return [...FLOWS].reverse().find((f) => f < flow - 1e-6) ?? MIN_FLOW;
}

/** Wheel: up/away = faster (multiplicative, so it feels even at any speed). */
export function wheelFlow(flow: number, deltaY: number): number {
  const f = flow * Math.exp(-deltaY * 0.0015);
  return Math.max(MIN_FLOW, Math.min(MAX_FLOW, f));
}

export const flowText = (flow: number) => `×${flow >= 1 ? Math.round(flow * 10) / 10 : Math.round(flow * 100) / 100}`;

/** The speed slider: 0–1 along the whole range (even steps feel even: logarithmic). */
export const flowToSlider = (flow: number) => Math.log(flow / MIN_FLOW) / Math.log(MAX_FLOW / MIN_FLOW);
export const sliderToFlow = (u: number) => MIN_FLOW * Math.pow(MAX_FLOW / MIN_FLOW, Math.max(0, Math.min(1, u)));

/**
 * The mouse's speed while holding a card (px/s), from its recent moves: the
 * last ~0.1 s count, so a flick is a flick and a stop before letting go is a stop.
 */
export class Momentum {
  private pts: { x: number; y: number; t: number }[] = [];
  add(x: number, y: number, t: number) {
    this.pts.push({ x, y, t });
    while (this.pts.length > 2 && t - this.pts[0].t > 100) this.pts.shift();
  }
  clear() {
    this.pts = [];
  }
  velocity(now: number): { x: number; y: number } {
    const p = this.pts;
    if (p.length < 2 || now - p[p.length - 1].t > 80) return { x: 0, y: 0 };
    const a = p[0];
    const b = p[p.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { x: 0, y: 0 };
    const cap = 4000;
    const c = (v: number) => Math.max(-cap, Math.min(cap, v));
    return { x: c((b.x - a.x) / dt), y: c((b.y - a.y) / dt) };
  }
}
