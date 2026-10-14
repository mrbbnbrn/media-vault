// Museum floor plan: a pure function from items to halls, walls, doors and
// frame positions. No three.js here, so it can be unit-tested.
//
// Plan coordinates: x points east, y points south (it becomes three.js z), so
// "north" is -y. Each wing starts with a grand hall (favourites or the best
// rated, behind velvet ropes), followed by long galleries that turn
// alternately north and east like a staircase, so halls never overlap.

export type MuseumKind = 'image' | 'gif' | 'video';

export interface MuseumItem {
  id: number;
  name: string;
  kind: MuseumKind;
  width: number | null;
  height: number | null;
  favourite: boolean;
  weight: number;
  /** Date taken (seconds), for the plaque. */
  takenAt?: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Hall {
  index: number;
  name: string;
  rect: Rect;
  height: number;
  grand: boolean;
  /** Entry centre on the plan, walking direction and length. */
  origin: Vec2;
  forward: Vec2;
  width: number;
  length: number;
  chandeliers: { x: number; y: number; scale: number }[];
}

/** A straight, axis-aligned wall (its centre line). */
export interface WallSeg {
  a: Vec2;
  b: Vec2;
  height: number;
}

export type DoorKind = 'pass' | 'next' | 'prev';

export interface Door {
  /** Centre of the opening on the wall line. */
  at: Vec2;
  /** Unit vector along the wall. */
  along: Vec2;
  /** Unit vector pointing into the hall the door belongs to. */
  inward: Vec2;
  width: number;
  height: number;
  /** The wall's full height (the lintel goes from height to wallHeight). */
  wallHeight: number;
  kind: DoorKind;
  hall: number;
}

export interface Frame {
  item: MuseumItem;
  /** Picture centre on the wall surface (plan) and its height above the floor. */
  at: Vec2;
  z: number;
  /** Unit vector pointing away from the wall, into the room. */
  normal: Vec2;
  /** Picture (inside the frame) size in metres. */
  w: number;
  h: number;
  /** Width of the gilded moulding. */
  border: number;
  featured: boolean;
  /** Velvet rope stanchions in front. */
  rope: boolean;
  hall: number;
}

export interface Column {
  x: number;
  y: number;
  r: number;
}

export interface WingLayout {
  halls: Hall[];
  walls: WallSeg[];
  doors: Door[];
  frames: Frame[];
  columns: Column[];
  /** Rope lines (posts at both ends) for collision and drawing. */
  ropes: { a: Vec2; b: Vec2 }[];
  spawn: { x: number; y: number; yaw: number };
  /** Where to stand when coming back from the next wing. */
  spawnBack: { x: number; y: number; yaw: number };
  bounds: Rect;
}

export const WALL_T = 0.3;
export const GALLERY_W = 8;
export const GALLERY_H = 6.5;
export const GRAND_W = 16;
export const GRAND_L = 20;
export const GRAND_H = 8;
export const DOOR_W = 3.2;
export const DOOR_H = 4.4;
const MARGIN = 1.7;
const GAP = 1.5;
const PER_HALL = 12;
const FEATURED_MAX = 8;
/** Up to this many items: everything hangs in the grand hall. */
const SMALL = 8;

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
export const roman = (n: number) => ROMAN[n - 1] ?? String(n);

const add = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });
/** Left of the walking direction (x east, y south): north → west, east → north. */
const leftOf = (f: Vec2): Vec2 => ({ x: f.y, y: -f.x });

/** Picture size (without frame) from the item's shape. */
export function pictureSize(item: Pick<MuseumItem, 'width' | 'height'>, featured: boolean): { w: number; h: number } {
  const a0 = item.width && item.height ? item.width / item.height : 4 / 3;
  const a = Math.min(3, Math.max(1 / 3, a0));
  const area = featured ? 4.8 : 1.7;
  let w = Math.sqrt(area * a);
  let h = Math.sqrt(area / a);
  const maxW = featured ? 3.6 : 2.4;
  const maxH = featured ? 2.9 : 1.75;
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;
  return { w, h };
}

function makeFrame(item: MuseumItem, featured: boolean, hall: number): Omit<Frame, 'at' | 'z' | 'normal'> {
  const { w, h } = pictureSize(item, featured);
  return { item, w, h, border: featured ? 0.26 : 0.17, featured, rope: featured, hall };
}

const outerW = (f: { w: number; border: number }) => f.w + f.border * 2;

/** Height of the picture centre: eye level, but never down into the panelling. */
function centreZ(f: { h: number; border: number; featured: boolean }): number {
  return Math.max(f.featured ? 2.45 : 1.85, 1.2 + f.h / 2 + f.border);
}

/** Favourites first; without any, the highest weighted (only when it stands out). */
export function pickFeatured(items: MuseumItem[], max = FEATURED_MAX): MuseumItem[] {
  const favs = items.filter((i) => i.favourite);
  if (favs.length) return favs.slice(0, max);
  const top = [...items].sort((a, b) => b.weight - a.weight);
  if (!top.length || top[0].weight <= (top[top.length - 1]?.weight ?? 0)) return items.slice(0, Math.min(max, 4));
  return top.filter((i) => i.weight > top[top.length - 1].weight).slice(0, max);
}

/** Splits everything into wings; the first wing's grand hall shows the featured items. */
export function planWings(items: MuseumItem[], wingSize = 120): { featured: MuseumItem[]; wings: MuseumItem[][] } {
  if (items.length <= SMALL) return { featured: items, wings: [[]] };
  const featured = pickFeatured(items);
  const set = new Set(featured.map((i) => i.id));
  const rest = items.filter((i) => !set.has(i.id));
  const wings: MuseumItem[][] = [];
  for (let i = 0; i < rest.length; i += wingSize) wings.push(rest.slice(i, i + wingSize));
  if (!wings.length) wings.push([]);
  // A tiny last wing joins the one before.
  if (wings.length > 1 && wings[wings.length - 1].length < wingSize / 4) {
    const last = wings.pop()!;
    wings[wings.length - 1].push(...last);
  }
  return { featured, wings };
}

/** What hangs in wing k: its grand hall's pictures and the galleries' pictures. */
export function wingContent(plan: { featured: MuseumItem[]; wings: MuseumItem[][] }, k: number): { featured: MuseumItem[]; gallery: MuseumItem[] } {
  if (k === 0) return { featured: plan.featured, gallery: plan.wings[0] ?? [] };
  const chunk = plan.wings[k] ?? [];
  const featured = pickFeatured(chunk, 4);
  const set = new Set(featured.map((i) => i.id));
  return { featured, gallery: chunk.filter((i) => !set.has(i.id)) };
}

/** Evenly spread frames over a stretch of wall (positions of their centres). */
function spread(widths: number[], from: number, to: number): number[] {
  const total = widths.reduce((s, w) => s + w, 0);
  const gap = Math.max(0, (to - from - total) / widths.length);
  const out: number[] = [];
  let t = from + gap / 2;
  for (const w of widths) {
    out.push(t + w / 2);
    t += w + gap;
  }
  return out;
}

export function layoutWing(
  items: MuseumItem[],
  opts: { featured: MuseumItem[]; hasPrev: boolean; hasNext: boolean; wing?: number },
): WingLayout {
  const halls: Hall[] = [];
  const walls: WallSeg[] = [];
  const doors: Door[] = [];
  const frames: Frame[] = [];
  const columns: Column[] = [];
  const ropes: { a: Vec2; b: Vec2 }[] = [];

  /** Emits a wall from a to b with openings; returns nothing. */
  const wall = (a: Vec2, b: Vec2, height: number, openings: { t: number; kind: DoorKind; inward: Vec2; hall: number; h?: number }[]) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const along = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    let t0 = 0;
    for (const o of [...openings].sort((p, q) => p.t - q.t)) {
      const s = o.t - DOOR_W / 2;
      if (s > t0) walls.push({ a: add(a, along, t0), b: add(a, along, s), height });
      doors.push({ at: add(a, along, o.t), along, inward: o.inward, width: DOOR_W, height: o.h ?? DOOR_H, wallHeight: height, kind: o.kind, hall: o.hall });
      t0 = o.t + DOOR_W / 2;
    }
    if (len > t0) walls.push({ a: add(a, along, t0), b, height });
  };

  const hang = (f: Omit<Frame, 'at' | 'z' | 'normal'>, wallA: Vec2, along: Vec2, t: number, normal: Vec2) => {
    const at = add(wallA, along, t);
    // The picture surface sits just off the wall (half the wall's thickness).
    const surf = add(at, normal, WALL_T / 2);
    const fr: Frame = { ...f, at: surf, z: centreZ(f), normal };
    frames.push(fr);
    if (f.rope) {
      const half = outerW(f) / 2 + 0.25;
      const front = add(surf, normal, 1.1);
      ropes.push({ a: add(front, along, -half), b: add(front, along, half) });
    }
  };

  const wingNo = opts.wing ?? 0;
  const gallery = items;

  // ---- the grand hall ----------------------------------------------------------
  const small = gallery.length === 0;
  const featured = small ? opts.featured.slice(0, 12) : opts.featured.slice(0, FEATURED_MAX);
  const gW = GRAND_W;
  // A small folder lives entirely in the grand hall; make it fit.
  const sideSlots = small ? Math.max(2, Math.ceil(Math.max(0, featured.length - 4) / 2)) : 2;
  const gL = small ? Math.max(14, sideSlots * 6.5) : GRAND_L;
  const g: Hall = {
    index: 0,
    name: wingNo === 0 ? 'The Grand Hall' : `Grand Hall, wing ${roman(wingNo + 1)}`,
    rect: { x0: -gW / 2, x1: gW / 2, y0: -gL, y1: 0 },
    height: GRAND_H,
    grand: true,
    origin: { x: 0, y: 0 },
    forward: { x: 0, y: -1 },
    width: gW,
    length: gL,
    chandeliers: [],
  };
  const nCh = Math.max(1, Math.round(gL / 9));
  for (let i = 0; i < nCh; i++) g.chandeliers.push({ x: 0, y: -gL * ((i + 0.5) / nCh), scale: 1.45 });
  halls.push(g);

  const hasGallery = gallery.length > 0;
  const sw = { x: -gW / 2, y: 0 };
  const se = { x: gW / 2, y: 0 };
  const nw = { x: -gW / 2, y: -gL };
  const ne = { x: gW / 2, y: -gL };
  // South wall (entrance side), west to east; north wall, west to east.
  wall(sw, se, GRAND_H, opts.hasPrev ? [{ t: gW / 2, kind: 'prev', inward: { x: 0, y: -1 }, hall: 0 }] : []);
  const northKind: DoorKind | null = hasGallery ? 'pass' : opts.hasNext ? 'next' : null;
  wall(nw, ne, GRAND_H, northKind ? [{ t: gW / 2, kind: northKind, inward: { x: 0, y: 1 }, hall: 0, h: northKind === 'pass' ? 5 : DOOR_H }] : []);
  wall(nw, sw, GRAND_H, []); // west, north to south
  wall(ne, se, GRAND_H, []); // east

  // Featured pictures: both long walls first, then beside the north door, then the south wall.
  const fFrames = featured.map((it) => makeFrame(it, true, 0));
  const west = { a: { x: -gW / 2, y: 0 }, along: { x: 0, y: -1 }, normal: { x: 1, y: 0 } };
  const east = { a: { x: gW / 2, y: 0 }, along: { x: 0, y: -1 }, normal: { x: -1, y: 0 } };
  const bySlot: { side: typeof west; ts: number[] }[] = [];
  const sideTs = Array.from({ length: sideSlots }, (_, i) => (gL * (i + 0.5)) / sideSlots);
  bySlot.push({ side: west, ts: sideTs }, { side: east, ts: sideTs });
  const northWall = { a: nw, along: { x: 1, y: 0 }, normal: { x: 0, y: 1 } };
  const southWall = { a: sw, along: { x: 1, y: 0 }, normal: { x: 0, y: -1 } };
  const flank = [gW / 2 - 5.2, gW / 2 + 5.2];
  let k = 0;
  // Interleave west/east so pairs face each other.
  for (let s = 0; s < sideSlots && k < fFrames.length; s++) {
    for (const side of [west, east]) {
      if (k >= fFrames.length) break;
      hang(fFrames[k++], side.a, side.along, sideTs[s], side.normal);
    }
  }
  for (const wl of [northWall, southWall]) {
    const ts = (wl === northWall ? northKind : opts.hasPrev) ? flank : [flank[0], gW / 2, flank[1]];
    for (const t of ts) if (k < fFrames.length) hang(fFrames[k++], wl.a, wl.along, t, wl.normal);
  }
  // Columns stand between the pictures along the long walls and flank the doors.
  for (let i = 1; i < sideSlots; i++) for (const x of [-gW / 2 + 2.3, gW / 2 - 2.3]) columns.push({ x, y: -(gL * i) / sideSlots, r: 0.42 });
  if (northKind) for (const x of [-2.4, 2.4]) columns.push({ x, y: -gL + 0.9, r: 0.42 });
  if (opts.hasPrev) for (const x of [-2.4, 2.4]) columns.push({ x, y: -0.9, r: 0.42 });

  // ---- galleries ---------------------------------------------------------------
  let origin: Vec2 = { x: 0, y: -gL };
  let forward: Vec2 = { x: 0, y: -1 };
  let rest = [...gallery];
  let hallNo = 1;
  let lastExit: { at: Vec2; inward: Vec2 } | null = northKind === 'next' ? { at: { x: 0, y: -gL }, inward: { x: 0, y: 1 } } : null;
  while (rest.length) {
    let n = Math.min(PER_HALL, rest.length);
    if (rest.length - n > 0 && rest.length - n <= 3) n = rest.length;
    const batch = rest.slice(0, n);
    rest = rest.slice(n);
    const isLast = rest.length === 0;
    const W = GALLERY_W;
    const left = leftOf(forward);
    const right = neg(left);
    // North-going halls leave through the right (east) wall, east-going through the left (north).
    const exitSide: 'left' | 'right' | 'end' | null = isLast ? (opts.hasNext ? 'end' : null) : forward.y !== 0 ? 'right' : 'left';
    const focal = exitSide !== 'end' && batch.length >= 3;
    const sideItems = focal ? batch.slice(0, -1) : batch;
    const fs = sideItems.map((it) => makeFrame(it, false, hallNo));
    let usedL = exitSide === 'left' ? W : 0;
    let usedR = exitSide === 'right' ? W : 0;
    const L0: typeof fs = [];
    const R0: typeof fs = [];
    for (const f of fs) {
      if (usedL <= usedR) {
        L0.push(f);
        usedL += outerW(f) + GAP;
      } else {
        R0.push(f);
        usedR += outerW(f) + GAP;
      }
    }
    const len = Math.max(12, Math.max(usedL, usedR) + MARGIN * 2);
    const hall: Hall = {
      index: hallNo,
      name: `Gallery ${roman(hallNo)}`,
      rect: {
        x0: Math.min(origin.x + left.x * W / 2, origin.x - left.x * W / 2, origin.x + forward.x * len + left.x * W / 2, origin.x + forward.x * len - left.x * W / 2),
        x1: Math.max(origin.x + left.x * W / 2, origin.x - left.x * W / 2, origin.x + forward.x * len + left.x * W / 2, origin.x + forward.x * len - left.x * W / 2),
        y0: Math.min(origin.y + left.y * W / 2, origin.y - left.y * W / 2, origin.y + forward.y * len + left.y * W / 2, origin.y + forward.y * len - left.y * W / 2),
        y1: Math.max(origin.y + left.y * W / 2, origin.y - left.y * W / 2, origin.y + forward.y * len + left.y * W / 2, origin.y + forward.y * len - left.y * W / 2),
      },
      height: GALLERY_H,
      grand: false,
      origin,
      forward,
      width: W,
      length: len,
      chandeliers: [],
    };
    const nc = Math.max(1, Math.round(len / 9));
    for (let i = 0; i < nc; i++) {
      const p = add(origin, forward, (len * (i + 0.5)) / nc);
      hall.chandeliers.push({ x: p.x, y: p.y, scale: 1 });
    }
    halls.push(hall);

    const lA = add(origin, left, W / 2);
    const rA = add(origin, right, W / 2);
    const lB = add(lA, forward, len);
    const rB = add(rA, forward, len);
    const exitT = len - W / 2;
    wall(lA, lB, GALLERY_H, exitSide === 'left' ? [{ t: exitT, kind: 'pass', inward: right, hall: hallNo }] : []);
    wall(rA, rB, GALLERY_H, exitSide === 'right' ? [{ t: exitT, kind: 'pass', inward: left, hall: hallNo }] : []);
    wall(lB, rB, GALLERY_H, exitSide === 'end' ? [{ t: W / 2, kind: 'next', inward: neg(forward), hall: hallNo }] : []);
    if (exitSide === 'end') lastExit = { at: add(origin, forward, len), inward: neg(forward) };

    const place = (list: typeof fs, a: Vec2, normal: Vec2, reserve: boolean) => {
      if (!list.length) return;
      const ts = spread(list.map(outerW), MARGIN, (reserve ? len - W : len) - MARGIN);
      list.forEach((f, i) => hang(f, a, forward, ts[i], normal));
    };
    place(L0, lA, right, exitSide === 'left');
    place(R0, rA, left, exitSide === 'right');
    if (focal) {
      const f = makeFrame(batch[batch.length - 1], false, hallNo);
      const big = { ...f, w: f.w * 1.25, h: f.h * 1.25, border: 0.2 };
      // Along the end wall from left to right; the picture faces back down the hall.
      hang(big, lB, right, W / 2, neg(forward));
    }

    if (exitSide === 'left' || exitSide === 'right') {
      const side = exitSide === 'left' ? left : right;
      origin = add(add(origin, forward, exitT), side, W / 2);
      forward = side;
    }
    hallNo++;
  }

  const bounds = halls.reduce(
    (b, h) => ({ x0: Math.min(b.x0, h.rect.x0), y0: Math.min(b.y0, h.rect.y0), x1: Math.max(b.x1, h.rect.x1), y1: Math.max(b.y1, h.rect.y1) }),
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  );
  const spawn = { x: 0, y: -2.6, yaw: 0 };
  let spawnBack = spawn;
  if (lastExit) {
    const p = add(lastExit.at, lastExit.inward, 2.6);
    spawnBack = { x: p.x, y: p.y, yaw: yawOf(lastExit.inward) };
  }
  return { halls, walls, doors, frames, columns, ropes, spawn, spawnBack, bounds };
}

/** Yaw (0 = looking north, -y) that looks along a plan direction. */
export const yawOf = (d: Vec2) => Math.atan2(-d.x, -d.y);

/** Keeps a circle of radius r out of walls, columns and ropes. Returns the corrected position. */
export function collide(p: Vec2, r: number, layout: Pick<WingLayout, 'walls' | 'columns' | 'ropes' | 'doors'>): Vec2 {
  let { x, y } = p;
  const pushSeg = (a: Vec2, b: Vec2, half: number) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    const ox = x - cx;
    const oy = y - cy;
    const d = Math.hypot(ox, oy);
    const min = r + half;
    if (d < min) {
      if (d < 1e-6) {
        // Exactly on the line: push sideways.
        const nx = -dy / Math.sqrt(l2);
        const ny = dx / Math.sqrt(l2);
        x = cx + nx * min;
        y = cy + ny * min;
      } else {
        x = cx + (ox / d) * min;
        y = cy + (oy / d) * min;
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (const w of layout.walls) pushSeg(w.a, w.b, WALL_T / 2);
    // Closed doors (to other wings) are solid too.
    for (const d of layout.doors) {
      if (d.kind === 'pass') continue;
      pushSeg(add(d.at, d.along, -d.width / 2), add(d.at, d.along, d.width / 2), WALL_T / 2);
    }
    for (const c of layout.columns) pushSeg(c, c, c.r);
    for (const rp of layout.ropes) pushSeg(rp.a, rp.b, 0.08);
  }
  return { x, y };
}

/** The hall that contains a point (or null between walls). */
export function hallAt(layout: Pick<WingLayout, 'halls'>, p: Vec2): Hall | null {
  for (const h of layout.halls) if (p.x >= h.rect.x0 && p.x <= h.rect.x1 && p.y >= h.rect.y0 && p.y <= h.rect.y1) return h;
  return null;
}
