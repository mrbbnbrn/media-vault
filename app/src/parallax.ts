// Parallax layers maths: three layers of pieces drifting across the screen at
// different speeds (far = small, slow, soft; near = big, quicker), for depth.
// Each layer has one or more lanes (bands across the screen); in a lane the
// pieces follow each other in a queue with a gap, so they never overlap their
// lane-mates. A piece that has drifted off the far side is dropped, and new
// pieces come in at the entry side whenever there is room behind the last one.

export type ParallaxDirection = 'left' | 'right' | 'up';
export type ParallaxSpeed = 'calm' | 'normal' | 'fast';

export const PARALLAX_DIRECTIONS: { id: ParallaxDirection; label: string; hint: string }[] = [
  { id: 'left', label: 'Drift left', hint: 'pieces come in from the right' },
  { id: 'right', label: 'Drift right', hint: 'pieces come in from the left' },
  { id: 'up', label: 'Drift up', hint: 'pieces rise from the bottom' },
];
/** Speed of the front layer, in screen-widths per minute. */
export const PARALLAX_SPEEDS: { id: ParallaxSpeed; label: string; perMin: number }[] = [
  { id: 'calm', label: 'Calm', perMin: 1.2 },
  { id: 'normal', label: 'Normal', perMin: 2.4 },
  { id: 'fast', label: 'Fast', perMin: 5 },
];

export interface ParallaxSettings {
  direction: ParallaxDirection;
  speed: ParallaxSpeed;
}
export const DEFAULT_PARALLAX: ParallaxSettings = { direction: 'left', speed: 'normal' };

export function normalizeParallax(x: unknown): ParallaxSettings {
  const o = (x && typeof x === 'object' ? x : {}) as Partial<ParallaxSettings>;
  return {
    direction: PARALLAX_DIRECTIONS.some((d) => d.id === o.direction) ? o.direction! : DEFAULT_PARALLAX.direction,
    speed: PARALLAX_SPEEDS.some((s) => s.id === o.speed) ? o.speed! : DEFAULT_PARALLAX.speed,
  };
}

export interface LayerDef {
  id: 'far' | 'mid' | 'near';
  /** Piece size: its height as a share of the screen's height (or width, drifting up). */
  size: number;
  lanes: number;
  /** About how many pieces per lane are on screen at once. */
  perLane: number;
  /** Speed relative to the front layer. */
  speed: number;
  /** Soft blur (px) and brightness (0..1) for depth. */
  blur: number;
  dim: number;
  /** How far (px) the layer shifts when the mouse is at the edge of the screen. */
  shift: number;
}
export const LAYERS: LayerDef[] = [
  { id: 'far', size: 0.15, lanes: 4, perLane: 5, speed: 0.3, blur: 2.5, dim: 0.45, shift: 10 },
  { id: 'mid', size: 0.27, lanes: 2, perLane: 3.4, speed: 0.6, blur: 0.6, dim: 0.75, shift: 26 },
  { id: 'near', size: 0.48, lanes: 1, perLane: 2.2, speed: 1, blur: 0, dim: 1, shift: 52 },
];

export interface Drifter<T> {
  uid: number;
  item: T;
  layer: number;
  lane: number;
  /** Leading edge, measured inward from the entry side (px). */
  lead: number;
  /** Size along the drift (len) and across it (thick), px. */
  len: number;
  thick: number;
  /** Where across its lane it sits, 0..1. */
  cross: number;
}

export interface Screen { W: number; H: number; dir: ParallaxDirection }

const along = (s: Screen) => (s.dir === 'up' ? s.H : s.W);
const across = (s: Screen) => (s.dir === 'up' ? s.W : s.H);

/** A piece's box (len × thick) for an item of this shape in this layer. */
export function pieceSize(aspect: number, layer: LayerDef, s: Screen): { len: number; thick: number } {
  const a = Math.min(2, Math.max(0.5, Number.isFinite(aspect) && aspect > 0 ? aspect : 1));
  const base = layer.size * Math.min(s.H, s.W * 0.75);
  const w = base * a;
  const h = base;
  return s.dir === 'up' ? { len: h, thick: w } : { len: w, thick: h };
}

/** The gap kept between lane-mates so about `perLane` are on screen. */
export function laneGap(layer: LayerDef, s: Screen): number {
  const typical = layer.size * Math.min(s.H, s.W * 0.75) * 1.2;
  return Math.max(typical * 0.15, along(s) / layer.perLane - typical);
}

export interface Source<T> {
  pick: () => T | null;
  aspect: (t: T) => number;
  uid: () => number;
  rnd: () => number;
}

function make<T>(src: Source<T>, layer: number, lane: number, lead: number, s: Screen): Drifter<T> | null {
  const item = src.pick();
  if (item == null) return null;
  const { len, thick } = pieceSize(src.aspect(item), LAYERS[layer], s);
  return { uid: src.uid(), item, layer, lane, lead, len, thick, cross: src.rnd() };
}

/** A screen already full of pieces (so nothing has to drift in from empty). */
export function seed<T>(src: Source<T>, s: Screen): Drifter<T>[] {
  const out: Drifter<T>[] = [];
  const L = along(s);
  LAYERS.forEach((def, li) => {
    const gap = laneGap(def, s);
    for (let lane = 0; lane < def.lanes; lane++) {
      // The first piece is partly off the exit side; then queue back to the entry side.
      let lead = L + src.rnd() * gap;
      for (let guard = 0; guard < 60 && lead > 0; guard++) {
        const p = make(src, li, lane, lead, s);
        if (!p) return;
        out.push(p);
        lead = p.lead - p.len - gap * (0.6 + 0.8 * src.rnd());
      }
    }
  });
  return out;
}

/** Pixels per second the front layer moves at this speed. */
export function frontSpeed(speed: ParallaxSpeed, s: Screen): number {
  const perMin = PARALLAX_SPEEDS.find((x) => x.id === speed)?.perMin ?? 2.4;
  return (perMin * along(s)) / 60;
}

/**
 * Move everything on by `dt` seconds. Returns the new list and whether pieces
 * left or arrived (the caller re-renders only then).
 */
export function step<T>(list: Drifter<T>[], dt: number, v: number, src: Source<T>, s: Screen): { list: Drifter<T>[]; changed: boolean } {
  const L = along(s);
  let changed = false;
  const moved: Drifter<T>[] = [];
  for (const p of list) {
    const lead = p.lead + v * LAYERS[p.layer].speed * dt;
    if (lead - p.len >= L) { changed = true; continue; }
    moved.push(lead === p.lead ? p : { ...p, lead });
  }
  // Room behind the last piece in a lane: a new one comes in.
  LAYERS.forEach((def, li) => {
    const gap = laneGap(def, s);
    for (let lane = 0; lane < def.lanes; lane++) {
      for (let guard = 0; guard < 8; guard++) {
        let tail = Infinity;
        for (const p of moved) if (p.layer === li && p.lane === lane) tail = Math.min(tail, p.lead - p.len);
        if (tail === Infinity) tail = L; // an empty lane starts over from the entry side
        const room = gap * (0.6 + 0.8 * src.rnd());
        if (tail < room) break;
        const p = make(src, li, lane, Math.min(0, tail - room), s);
        if (!p) break;
        moved.push(p);
        changed = true;
      }
    }
  });
  return { list: moved, changed };
}

/** Where a piece is on screen (top-left, px), before the mouse shift. */
export function placeOf(p: Drifter<unknown>, s: Screen): { x: number; y: number; w: number; h: number } {
  const def = LAYERS[p.layer];
  const band = across(s) / def.lanes;
  const c = band * p.lane + Math.max(0, band - p.thick) * p.cross - Math.max(0, p.thick - band) * p.cross;
  const pos = Math.min(across(s) - p.thick, Math.max(0, c));
  const a = s.dir === 'right' ? p.lead - p.len : along(s) - p.lead;
  return s.dir === 'up' ? { x: pos, y: a, w: p.thick, h: p.len } : { x: a, y: pos, w: p.len, h: p.thick };
}

/** Which pieces may play their video: the front ones first, those most on screen, at most `max`. */
export function chooseVideos(list: Drifter<{ kind: string }>[], s: Screen, max: number): Set<number> {
  const L = along(s);
  return new Set(
    list
      .filter((p) => p.item.kind === 'video' && p.lead > 0 && p.lead - p.len < L)
      .sort((a, b) => b.layer - a.layer || Math.abs(a.lead - a.len / 2 - L / 2) - Math.abs(b.lead - b.len / 2 - L / 2))
      .slice(0, max)
      .map((p) => p.uid),
  );
}
