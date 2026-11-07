// Free-form multi-screen layouts: boxes you draw yourself in the layout
// editor (components/LayoutEditor.tsx). Each box is stored in fractions of the
// stage (0..1), so a layout fits any screen. They play like the shaped
// layouts in shapes.ts: `buildCustomShapes` gives the same ShapePanel list.
//
// Ids are `free:<saved id>` (or `free:draft` for one not saved yet). The
// registry below is filled by MultiScreen after loading, and hooked into
// shapes.ts so layoutDef() and buildShapes() know these ids.

import type { Named } from './api';
import { buildShapes, layoutDef, layoutHooks, type LayoutDef, type ShapePanel } from './shapes';

export type Corner = 'square' | 'rounded' | 'circle';

/** One box, in fractions of the stage. */
export interface FreeBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Square (default), rounded, or a true circle (diameter = the smaller side, centred). */
  corner?: Corner;
  /** Rounded corners: radius as a fraction of the box's smaller side (0..0.5). */
  r?: number;
  /** Higher draws on top. */
  z?: number;
}

/** What is saved (named-settings kind 'freeLayout'). */
export interface FreeLayoutSettings {
  v: 1;
  boxes: FreeBox[];
}

export const FREE_PREFIX = 'free:';
export const DRAFT_ID = 'free:draft';
export const MAX_BOXES = 14;
export const DEFAULT_RADIUS = 0.12;

export interface Rect { x: number; y: number; w: number; h: number }

// ---- the registry ----------------------------------------------------------------------------

interface Entry { name: string; boxes: FreeBox[]; dbId: number | null; def: LayoutDef }
const registry = new Map<string, Entry>();

export const isFree = (id: string) => id.startsWith(FREE_PREFIX);
export const freeId = (dbId: number) => `${FREE_PREFIX}${dbId}`;
export const freeEntry = (id: string): Entry | undefined => registry.get(id);

/** Keep only boxes that make sense, clamped to the stage. */
export function cleanBoxes(raw: unknown): FreeBox[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const out: FreeBox[] = [];
  for (const b of raw.slice(0, MAX_BOXES)) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    const x = Math.min(Math.max(num(o.x, 0), 0), 0.99);
    const y = Math.min(Math.max(num(o.y, 0), 0), 0.99);
    const w = Math.min(Math.max(num(o.w, 0), 0.01), 1 - x);
    const h = Math.min(Math.max(num(o.h, 0), 0.01), 1 - y);
    const corner: Corner = o.corner === 'rounded' || o.corner === 'circle' ? o.corner : 'square';
    const box: FreeBox = { x, y, w, h, corner, z: num(o.z, out.length) };
    if (corner === 'rounded') box.r = Math.min(Math.max(num(o.r, DEFAULT_RADIUS), 0), 0.5);
    out.push(box);
  }
  return out;
}

/** Saved free-form layouts, as loaded (replaces the saved ones; drafts stay). */
export function setFreeLayouts(list: Named<FreeLayoutSettings>[]) {
  for (const [k, e] of [...registry]) if (e.dbId != null) registry.delete(k);
  for (const l of list) if (l.id != null) registerFree(freeId(l.id), l.name, l.settings?.boxes ?? [], l.id);
}

/** Add or replace one (a draft, or one restored from a saved multi-screen layout). */
export function registerFree(id: string, name: string, boxes: FreeBox[], dbId: number | null = null) {
  const clean = cleanBoxes(boxes);
  // One def object per version, so screens can memoise on it.
  registry.set(id, { name, boxes: clean, dbId, def: { id, name, count: clean.length, kind: 'shape' } });
}

/** What a saved multi-screen layout keeps of the free-form layout it uses (so it still plays if that one is changed or deleted). */
export interface FreeSnapshot { name: string; boxes: FreeBox[] }

export function freeSnapshot(id: string): FreeSnapshot | undefined {
  const e = registry.get(id);
  return e ? { name: e.name, boxes: forSaving(e.boxes).boxes } : undefined;
}

/**
 * The layout id to play for a saved multi-screen layout: the free-form layout
 * it names when that one is still there under the same name, or else its own
 * copy (`free:restored-<key>`), registered here.
 */
export function restoreFree(id: string, snap: FreeSnapshot | undefined, key: string | number): string {
  if (!isFree(id) || !snap) return id;
  const e = registry.get(id);
  if (e && e.name === snap.name && e.boxes.length) return id;
  const own = `${FREE_PREFIX}restored-${key}`;
  registerFree(own, snap.name, snap.boxes);
  return own;
}

/** The saved ones, by name. */
export function savedFreeLayouts(): { id: string; name: string; dbId: number; count: number }[] {
  return [...registry]
    .filter(([, e]) => e.dbId != null)
    .map(([id, e]) => ({ id, name: e.name, dbId: e.dbId as number, count: e.boxes.length }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

layoutHooks.def = (id: string): LayoutDef | undefined => {
  const e = registry.get(id);
  return e && e.boxes.length ? e.def : undefined;
};
layoutHooks.build = (id: string, W: number, H: number) => {
  const e = registry.get(id);
  return e && e.boxes.length ? buildCustomShapes(e.boxes, W, H) : undefined;
};

// ---- drawing ---------------------------------------------------------------------------------

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Where a box shows on a W × H stage (a circle is the centred square inside its box). */
export function visibleRect(b: FreeBox, W: number, H: number): Rect {
  const x = b.x * W;
  const y = b.y * H;
  const w = b.w * W;
  const h = b.h * H;
  if (b.corner !== 'circle') return { x, y, w, h };
  const s = Math.min(w, h);
  return { x: x + (w - s) / 2, y: y + (h - s) / 2, w: s, h: s };
}

/** Panels for free-form boxes on a stage of W × H px, in box order. */
export function buildCustomShapes(boxes: FreeBox[], W: number, H: number): ShapePanel[] {
  return boxes.map((b, i) => {
    const box = visibleRect(b, W, H);
    const { w, h } = box;
    let d: string;
    let outline: ShapePanel['outline'];
    if (b.corner === 'circle') {
      const rr = w / 2;
      d = `M0 ${r2(rr)} A${r2(rr)} ${r2(rr)} 0 1 0 ${r2(2 * rr)} ${r2(rr)} A${r2(rr)} ${r2(rr)} 0 1 0 0 ${r2(rr)} Z`;
    } else if (b.corner === 'rounded') {
      const r = r2(Math.min(Math.max(b.r ?? DEFAULT_RADIUS, 0), 0.5) * Math.min(w, h));
      const W2 = r2(w);
      const H2 = r2(h);
      d = `M${r} 0 H${r2(w - r)} A${r} ${r} 0 0 1 ${W2} ${r} V${r2(h - r)} A${r} ${r} 0 0 1 ${r2(w - r)} ${H2} H${r} A${r} ${r} 0 0 1 0 ${r2(h - r)} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`;
      // The rounded box as a polygon (each corner cut where the arc is), for "Fit inside the shape".
      const c = r * (1 - Math.SQRT1_2);
      outline = {
        kind: 'poly',
        pts: ([[r, 0], [w - r, 0], [w - c, c], [w, r], [w, h - r], [w - c, h - c], [w - r, h], [r, h], [c, h - c], [0, h - r], [0, r], [c, c]] as [number, number][])
          .map(([x, y]) => [r2(x), r2(y)] as [number, number]),
      };
    } else {
      d = `M0 0 L${r2(w)} 0 L${r2(w)} ${r2(h)} L0 ${r2(h)} Z`;
    }
    return { box, d, anchor: { x: box.x + w / 2, y: box.y + h / 2 }, z: b.z ?? i, ...(outline ? { outline } : {}) };
  });
}

// ---- snapping -------------------------------------------------------------------------------

export interface Edges { l?: boolean; r?: boolean; t?: boolean; b?: boolean }
export interface Snapped { rect: Rect; guides: { x: number[]; y: number[] } }

/**
 * Snap a box being moved (`'move'`) or resized (the edges being dragged) to
 * the stage's edges and centre and to the other boxes' edges and centres,
 * within `tol` px. Returns the snapped box and where to draw guide lines.
 */
export function snapRect(r: Rect, mode: 'move' | Edges, others: Rect[], W: number, H: number, tol = 8): Snapped {
  const xs = [0, W / 2, W];
  const ys = [0, H / 2, H];
  for (const o of others) {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  const best = (features: number[], targets: number[]) => {
    let d: number | null = null;
    for (const f of features) for (const t of targets) if (Math.abs(t - f) <= tol && (d == null || Math.abs(t - f) < Math.abs(d))) d = t - f;
    return d;
  };
  const out = { ...r };
  if (mode === 'move') {
    const dx = best([r.x, r.x + r.w / 2, r.x + r.w], xs);
    const dy = best([r.y, r.y + r.h / 2, r.y + r.h], ys);
    if (dx != null) out.x += dx;
    if (dy != null) out.y += dy;
  } else {
    if (mode.l || mode.r) {
      const f = mode.l ? r.x : r.x + r.w;
      const d = best([f], xs);
      if (d != null) {
        if (mode.l) { out.x += d; out.w -= d; } else out.w += d;
      }
    }
    if (mode.t || mode.b) {
      const f = mode.t ? r.y : r.y + r.h;
      const d = best([f], ys);
      if (d != null) {
        if (mode.t) { out.y += d; out.h -= d; } else out.h += d;
      }
    }
  }
  const on = (fs: number[], ts: number[]) => [...new Set(ts.filter((t) => fs.some((f) => Math.abs(f - t) < 0.5)))];
  const fx = mode === 'move' ? [out.x, out.x + out.w / 2, out.x + out.w] : [...(mode.l ? [out.x] : []), ...(mode.r ? [out.x + out.w] : [])];
  const fy = mode === 'move' ? [out.y, out.y + out.h / 2, out.y + out.h] : [...(mode.t ? [out.y] : []), ...(mode.b ? [out.y + out.h] : [])];
  return { rect: out, guides: { x: on(fx, xs), y: on(fy, ys) } };
}

// ---- box helpers (fractions in, fractions out) -----------------------------------------------

const clamp01 = (b: FreeBox): FreeBox => {
  const w = Math.min(Math.max(b.w, 0.01), 1);
  const h = Math.min(Math.max(b.h, 0.01), 1);
  return { ...b, w, h, x: Math.min(Math.max(b.x, 0), 1 - w), y: Math.min(Math.max(b.y, 0), 1 - h) };
};

/** Give a box an exact shape (width : height in px), keeping its centre and staying on the stage. */
export function withAspect(b: FreeBox, aspect: number, W: number, H: number, keep: 'w' | 'h' | 'min'): FreeBox {
  let w = b.w * W;
  let h = b.h * H;
  if (keep === 'w') h = w / aspect;
  else if (keep === 'h') w = h * aspect;
  else if (w / h > aspect) w = h * aspect;
  else h = w / aspect;
  // Too big for the stage: shrink, keeping the shape.
  const k = Math.min(1, W / w, H / h);
  w *= k;
  h *= k;
  const cx = (b.x + b.w / 2) * W;
  const cy = (b.y + b.h / 2) * H;
  return clamp01({ ...b, x: (cx - w / 2) / W, y: (cy - h / 2) / H, w: w / W, h: h / H });
}

export const makeSquare = (b: FreeBox, W: number, H: number) => withAspect(b, 1, W, H, 'min');
export const makeTall = (b: FreeBox, W: number, H: number) => withAspect(b, 9 / 16, W, H, 'h');
export const makeWide = (b: FreeBox, W: number, H: number) => withAspect(b, 16 / 9, W, H, 'w');

/** Z order as 0..n-1, keeping the order. */
export function tidyZ(boxes: FreeBox[]): FreeBox[] {
  const order = boxes.map((b, i) => ({ i, z: b.z ?? i })).sort((a, b) => a.z - b.z || a.i - b.i);
  const z = new Array<number>(boxes.length);
  order.forEach((o, rank) => (z[o.i] = rank));
  return boxes.map((b, i) => ({ ...b, z: z[i] }));
}

export function toFront(boxes: FreeBox[], i: number): FreeBox[] {
  const top = Math.max(...boxes.map((b, j) => b.z ?? j));
  return tidyZ(boxes.map((b, j) => (j === i ? { ...b, z: top + 1 } : b)));
}
export function toBack(boxes: FreeBox[], i: number): FreeBox[] {
  const low = Math.min(...boxes.map((b, j) => b.z ?? j));
  return tidyZ(boxes.map((b, j) => (j === i ? { ...b, z: low - 1 } : b)));
}

/** A copy of box i placed next to it (right, then below, then left, then above), on top. */
export function duplicate(boxes: FreeBox[], i: number): FreeBox[] {
  if (boxes.length >= MAX_BOXES) return boxes;
  const b = boxes[i];
  const tries = [
    { x: b.x + b.w, y: b.y },
    { x: b.x, y: b.y + b.h },
    { x: b.x - b.w, y: b.y },
    { x: b.x, y: b.y - b.h },
  ];
  const inside = tries.filter((p) => p.x >= -1e-6 && p.y >= -1e-6 && p.x + b.w <= 1 + 1e-6 && p.y + b.h <= 1 + 1e-6);
  const e = 1e-6;
  const free = (p: { x: number; y: number }) =>
    boxes.every((o) => p.x + b.w <= o.x + e || o.x + o.w <= p.x + e || p.y + b.h <= o.y + e || o.y + o.h <= p.y + e);
  // A free spot first (so duplicating one box again and again fills a row, then the next).
  const p = inside.find(free) ?? inside[0] ?? { x: b.x + 0.03, y: b.y + 0.03 };
  const top = Math.max(...boxes.map((x, j) => x.z ?? j));
  return tidyZ([...boxes, clamp01({ ...b, ...p, z: top + 1 })]);
}

/** A new box near the middle, square on screen, on top. */
export function addBox(boxes: FreeBox[], W: number, H: number): FreeBox[] {
  if (boxes.length >= MAX_BOXES) return boxes;
  const s = Math.min(W, H) * 0.32;
  const off = (boxes.length % 6) * 0.025;
  const top = boxes.length ? Math.max(...boxes.map((x, j) => x.z ?? j)) : -1;
  return tidyZ([...boxes, clamp01({ x: 0.5 - s / W / 2 + off, y: 0.5 - s / H / 2 + off, w: s / W, h: s / H, corner: 'square', z: top + 1 })]);
}

export function setCorner(b: FreeBox, corner: Corner, W: number, H: number): FreeBox {
  const next: FreeBox = { ...b, corner };
  if (corner === 'rounded') next.r = b.r ?? DEFAULT_RADIUS;
  else delete next.r;
  // A circle uses the smaller side; make the box itself square so what you drag is what you see.
  return corner === 'circle' ? makeSquare(next, W, H) : next;
}

/** Rounded to 4 decimals for saving. */
export function forSaving(boxes: FreeBox[]): FreeLayoutSettings {
  const q = (n: number) => Math.round(n * 1e4) / 1e4;
  return {
    v: 1,
    boxes: tidyZ(boxes).map((b) => {
      const o: FreeBox = { x: q(b.x), y: q(b.y), w: q(b.w), h: q(b.h), corner: b.corner ?? 'square', z: b.z };
      if (b.corner === 'rounded') o.r = q(b.r ?? DEFAULT_RADIUS);
      return o;
    }),
  };
}

// ---- starting from an existing layout ---------------------------------------------------------

/** Boxes for any layout (grid, shaped or free-form) on a W × H stage: each shape's bounding box; circles stay circles. */
export function boxesFromLayout(id: string, W: number, H: number): FreeBox[] {
  const own = registry.get(id);
  if (own) return own.boxes.map((b) => ({ ...b }));
  const def = layoutDef(id === 'wall' ? '4' : id);
  if (def.kind === 'grid') {
    const cols = def.cols ?? 2;
    const rows = Math.ceil(def.count / cols);
    return Array.from({ length: def.count }, (_, i) => ({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows, corner: 'square' as Corner, z: i }));
  }
  const shapes = buildShapes(def.id, W, H);
  return tidyZ(
    shapes.slice(0, MAX_BOXES).map((p) => {
      const x0 = Math.max(0, p.box.x);
      const y0 = Math.max(0, p.box.y);
      const x1 = Math.min(W, p.box.x + p.box.w);
      const y1 = Math.min(H, p.box.y + p.box.h);
      const circle = /A/.test(p.d) && Math.abs(p.box.w - p.box.h) < 1 && !/[LHV]/.test(p.d);
      return { x: x0 / W, y: y0 / H, w: Math.max(x1 - x0, 1) / W, h: Math.max(y1 - y0, 1) / H, corner: (circle ? 'circle' : 'square') as Corner, z: p.z };
    }),
  );
}
