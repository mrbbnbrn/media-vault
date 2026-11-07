// "Fit" inside a shaped multi-screen panel: the largest rectangle with the
// media's shape that lies wholly inside the panel's outline (a circle, a
// diamond, a slanted slice…), so nothing of the picture is cut off by the shape.

import type { ShapePanel } from './shapes';

type Pt = [number, number];

/** A panel's outline in its box's own coordinates. */
export type Outline = { kind: 'poly'; pts: Pt[] } | { kind: 'circle'; cx: number; cy: number; r: number } | { kind: 'rect'; w: number; h: number };

export interface FitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The outline of a panel: from its `outline` when it has one, otherwise read
 * from its path (straight lines, or a circle drawn with arcs); anything else is its box.
 */
export function outlineOf(sp: Pick<ShapePanel, 'box' | 'd'> & { outline?: Outline }): Outline {
  if (sp.outline) return sp.outline;
  const { w, h } = sp.box;
  const d = sp.d.trim();
  if (/[Aa]/.test(d)) {
    // circlePanel: a circle filling its square box.
    const r = Math.min(w, h) / 2;
    return { kind: 'circle', cx: w / 2, cy: h / 2, r };
  }
  if (/^[MLZ0-9.\s,eE+-]+$/.test(d)) {
    const nums = (d.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number);
    const pts: Pt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
    if (pts.length >= 3) return { kind: 'poly', pts };
  }
  return { kind: 'rect', w, h };
}

/** Whether (x, y) is inside the outline (points on the edge count as inside). */
export function insideOutline(o: Outline, x: number, y: number, eps = 0.5): boolean {
  if (o.kind === 'rect') return x >= -eps && y >= -eps && x <= o.w + eps && y <= o.h + eps;
  if (o.kind === 'circle') return (x - o.cx) ** 2 + (y - o.cy) ** 2 <= (o.r + eps) ** 2;
  const p = o.pts;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    // On an edge (within eps): inside.
    const dx = xj - xi;
    const dy = yj - yi;
    const len2 = dx * dx + dy * dy;
    if (len2 > 0) {
      const t = Math.max(0, Math.min(1, ((x - xi) * dx + (y - yi) * dy) / len2));
      if ((xi + t * dx - x) ** 2 + (yi + t * dy - y) ** 2 <= eps * eps) return true;
    }
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centreOf(o: Outline): Pt {
  if (o.kind === 'rect') return [o.w / 2, o.h / 2];
  if (o.kind === 'circle') return [o.cx, o.cy];
  let a = 0;
  let cx = 0;
  let cy = 0;
  const p = o.pts;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-6) return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Whether the rectangle lies inside the outline: its corners and edge middles inside, and (for polygons) no corner of the shape poking into it. */
function rectInside(o: Outline, x: number, y: number, w: number, h: number): boolean {
  const xs = [x, x + w / 2, x + w];
  const ys = [y, y + h / 2, y + h];
  for (const px of xs) for (const py of ys) if ((px !== xs[1] || py !== ys[1]) && !insideOutline(o, px, py, 0.01)) return false;
  if (o.kind === 'poly') {
    for (const [px, py] of o.pts) if (px > x + 0.5 && px < x + w - 0.5 && py > y + 0.5 && py < y + h - 0.5) return false;
  }
  return true;
}

/** The biggest scale (rect height) of a rect of `aspect` centred at (cx, cy) inside the outline. */
function biggestAt(o: Outline, cx: number, cy: number, aspect: number, maxH: number): number {
  if (!insideOutline(o, cx, cy, 0)) return 0;
  let lo = 0;
  let hi = maxH;
  for (let i = 0; i < 26; i++) {
    const m = (lo + hi) / 2;
    const w = m * aspect;
    if (rectInside(o, cx - w / 2, cy - m / 2, w, m)) lo = m;
    else hi = m;
  }
  return lo;
}

/**
 * The largest rectangle of `aspect` (width / height) inside the outline of a
 * W × H box, centred at or near the shape's middle. Null if nothing fits.
 */
export function fitRectInOutline(o: Outline, W: number, H: number, aspect: number): FitRect | null {
  if (!(aspect > 0) || !(W > 0) || !(H > 0)) return null;
  const maxH = Math.min(H, W / aspect);
  if (o.kind === 'rect') {
    const h = Math.min(o.h, o.w / aspect);
    const w = h * aspect;
    return { x: (o.w - w) / 2, y: (o.h - h) / 2, w, h };
  }
  const [c0x, c0y] = centreOf(o);
  let best = { h: biggestAt(o, c0x, c0y, aspect, maxH), cx: c0x, cy: c0y };
  if (o.kind === 'poly') {
    // Near the centroid there may be room for a bigger one (e.g. in a triangle): a coarse
    // search around it, then a finer one around the best spot.
    for (const step of [Math.max(W, H) / 10, Math.max(W, H) / 40]) {
      const around = best;
      for (let i = -3; i <= 3; i++)
        for (let j = -3; j <= 3; j++) {
          if (!i && !j) continue;
          const cx = around.cx + i * step;
          const cy = around.cy + j * step;
          const h = biggestAt(o, cx, cy, aspect, maxH);
          if (h > best.h + 0.01) best = { h, cx, cy };
        }
    }
  }
  if (best.h < 2) return null;
  const w = best.h * aspect;
  return { x: best.cx - w / 2, y: best.cy - best.h / 2, w, h: best.h };
}

const cache = new Map<string, FitRect | null>();

/** fitRectInOutline for a panel (in its box's coordinates), remembered for the last few sizes. */
export function fitRectInShape(sp: Pick<ShapePanel, 'box' | 'd'> & { outline?: Outline }, aspect: number): FitRect | null {
  const key = `${sp.box.w.toFixed(1)}x${sp.box.h.toFixed(1)}:${aspect.toFixed(4)}:${sp.d}`;
  if (cache.has(key)) return cache.get(key)!;
  const r = fitRectInOutline(outlineOf(sp), sp.box.w, sp.box.h, aspect);
  if (cache.size > 300) cache.clear();
  cache.set(key, r);
  return r;
}
