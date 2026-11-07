// Shaped multi-screen layouts. Every layout fills the whole screen: each
// area is a panel, including the space between bubbles. Shapes are drawn on
// a 150 × 84 design grid and stretched to the screen; circles stay round.
//
// Each panel gets a box (where its video is fitted) and an outline path in
// that box's coordinates (used as its clip-path and for its border).

export interface ShapePanel {
  /** Position on the stage, in px. */
  box: { x: number; y: number; w: number; h: number };
  /** Outline in the box's own coordinates (SVG path data, px). */
  d: string;
  /** Where its hover controls go, in stage px. */
  anchor: { x: number; y: number };
  /** Higher draws on top. */
  z: number;
}

export interface LayoutDef {
  id: string;
  name: string;
  /** Number of panels. */
  count: number;
  kind: 'grid' | 'shape';
  /** Grid layouts: columns. */
  cols?: number;
  /** Shape layouts: the heading they're listed under in the layout menu. */
  group?: string;
}

type Pt = [number, number];

const GRID: LayoutDef[] = [1, 2, 4, 6, 8].map((n) => ({ id: String(n), name: `${n} panel${n > 1 ? 's' : ''}`, count: n, kind: 'grid', cols: { 1: 1, 2: 2, 4: 2, 6: 3, 8: 4 }[n] }));

const SHAPES: LayoutDef[] = [
  { id: 'bullseye', name: 'Bullseye', count: 5, kind: 'shape', group: 'Shapes' },
  { id: 'diamond', name: 'Diamond', count: 5, kind: 'shape', group: 'Shapes' },
  { id: 'wideDiamond', name: 'Wide diamond', count: 5, kind: 'shape', group: 'Shapes' },
  { id: 'pinwheel', name: 'Pinwheel', count: 5, kind: 'shape', group: 'Shapes' },
  { id: 'sunburst', name: 'Sunburst', count: 9, kind: 'shape', group: 'Shapes' },
  { id: 'waves', name: 'Waves', count: 3, kind: 'shape', group: 'Shapes' },
  { id: 'mondrian', name: 'Mondrian', count: 6, kind: 'shape', group: 'Shapes' },
  { id: 'kaleidoscope', name: 'Kaleidoscope', count: 14, kind: 'shape', group: 'Shapes' },
  { id: 'slices', name: 'Slices', count: 4, kind: 'shape', group: 'Shapes' },
  { id: 'backdrop', name: 'Bubbles: backdrop', count: 6, kind: 'shape', group: 'Bubbles' },
  { id: 'pearls', name: 'Bubbles: pearls', count: 5, kind: 'shape', group: 'Bubbles' },
  { id: 'foam', name: 'Bubbles: foam', count: 7, kind: 'shape', group: 'Bubbles' },
  { id: 'bubbleGrid', name: 'Bubbles: grid', count: 7, kind: 'shape', group: 'Bubbles' },
  { id: 'moons', name: 'Bubbles: moons', count: 7, kind: 'shape', group: 'Bubbles' },
];

const S = (group: string, list: [string, string, number][]): LayoutDef[] => list.map(([id, name, count]) => ({ id, name, count, kind: 'shape', group }));

const MORE: LayoutDef[] = [
  ...S('Bubbles', [['bubbleRing', 'Bubbles: ring', 8]]),
  ...S('Tall boxes', [
    ['tall3', '3 tall', 3],
    ['tall4', '4 tall', 4],
    ['tall5', '5 tall', 5],
    ['tallSides', '2 tall + sides', 6],
    ['tallGrid4', 'Tall + 4', 5],
    ['tallGrid6', 'Tall + 6', 7],
    ['wideOverTall', 'Wide over tall', 8],
    ['tallWideTall', 'Tall, wide, tall', 4],
  ]),
  ...S('Mixed sizes', [
    ['bigL', 'Big + L', 6],
    ['bigFrame', 'Big + frame', 11],
    ['rows23', '2 + 3 rows', 5],
    ['filmStrip', 'Film strip', 7],
    ['bigLeft3', 'Big + 3 stacked', 4],
  ]),
  ...S('Fun', [
    ['honeycomb', 'Honeycomb', 12],
    ['stripes', 'Diagonal stripes', 5],
    ['roundTiles', 'Rounded tiles', 10],
    ['capsules', 'Capsules', 4],
  ]),
  ...S('Picture in picture', [
    ['pip1', 'PiP: 1 window', 2],
    ['pip2', 'PiP: 2 windows', 3],
    ['pip3', 'PiP: 3 stacked', 4],
    ['pip4', 'PiP: 4 corners', 5],
  ]),
];

/** Shape layouts in menu order, grouped under their headings. */
const ALL_SHAPES: LayoutDef[] = [...SHAPES, ...MORE];
const ORDER = ['Shapes', 'Bubbles', 'Tall boxes', 'Mixed sizes', 'Fun', 'Picture in picture'];
export const SHAPE_GROUPS: { name: string; layouts: LayoutDef[] }[] = ORDER.map((name) => ({ name, layouts: ALL_SHAPES.filter((l) => l.group === name) }));


export const LAYOUTS: LayoutDef[] = [...GRID, ...SHAPE_GROUPS.flatMap((g) => g.layouts)];
export const GRID_LAYOUTS = GRID;
export const SHAPE_LAYOUTS = SHAPE_GROUPS.flatMap((g) => g.layouts);
export const MAX_PANELS = Math.max(...LAYOUTS.map((l) => l.count));

export function layoutDef(id: string): LayoutDef {
  return LAYOUTS.find((l) => l.id === id) ?? GRID[2];
}

// ---- geometry helpers ------------------------------------------------------------------

/** Clip a polygon to the rectangle [0,W]×[0,H] (Sutherland–Hodgman). */
export function clipToRect(poly: Pt[], W: number, H: number): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= W, (a, b) => [W, a[1] + ((b[1] - a[1]) * (W - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= H, (a, b) => [a[0] + ((b[0] - a[0]) * (H - a[1])) / (b[1] - a[1]), H]],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (!out.length) break;
  }
  return out;
}

function bbox(pts: Pt[]) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Area-weighted centroid of a polygon (falls back to the average point). */
export function centroid(pts: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-6) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  return [cx / (3 * a), cy / (3 * a)];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function polyPanel(design: Pt[], sx: number, sy: number, W: number, H: number, z = 0): ShapePanel | null {
  const pts = clipToRect(design.map(([x, y]) => [x * sx, y * sy] as Pt), W, H);
  if (pts.length < 3) return null;
  const b = bbox(pts);
  if (b.w < 1 || b.h < 1) return null;
  const d = `M${pts.map(([x, y]) => `${r2(x - b.x)} ${r2(y - b.y)}`).join(' L')} Z`;
  const [ax, ay] = centroid(pts);
  return { box: b, d, anchor: { x: ax, y: ay }, z };
}

function circlePanel(cx: number, cy: number, r: number, sx: number, sy: number, s: number, z = 1): ShapePanel {
  const x = cx * sx;
  const y = cy * sy;
  const rr = r * s;
  const box = { x: x - rr, y: y - rr, w: 2 * rr, h: 2 * rr };
  const d = `M0 ${r2(rr)} A${r2(rr)} ${r2(rr)} 0 1 0 ${r2(2 * rr)} ${r2(rr)} A${r2(rr)} ${r2(rr)} 0 1 0 0 ${r2(rr)} Z`;
  return { box, d, anchor: { x, y }, z };
}

/** A rounded rectangle, given in design units; the corner radius is in design units too (kept round). */
function roundPanel(x: number, y: number, w: number, h: number, r: number, sx: number, sy: number, s: number, z = 1): ShapePanel {
  const box = { x: x * sx, y: y * sy, w: w * sx, h: h * sy };
  const R = r2(Math.min(r * s, box.w / 2, box.h / 2));
  const bw = r2(box.w);
  const bh = r2(box.h);
  const d = `M${R} 0 L${r2(bw - R)} 0 A${R} ${R} 0 0 1 ${bw} ${R} L${bw} ${r2(bh - R)} A${R} ${R} 0 0 1 ${r2(bw - R)} ${bh} L${R} ${bh} A${R} ${R} 0 0 1 0 ${r2(bh - R)} L0 ${R} A${R} ${R} 0 0 1 ${R} 0 Z`;
  return { box, d, anchor: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, z };
}

const rect = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// ---- the layouts ------------------------------------------------------------------------

/** Panels for a shaped layout on a stage of W × H px, in panel order. */
export function buildShapes(id: string, W: number, H: number): ShapePanel[] {
  const sx = W / 150;
  const sy = H / 84;
  const s = Math.min(sx, sy);
  const P = (pts: Pt[], z = 0) => polyPanel(pts, sx, sy, W, H, z);
  const C = (cx: number, cy: number, r: number, z = 1) => circlePanel(cx, cy, r, sx, sy, s, z);
  const Rd = (x: number, y: number, w: number, h: number, r: number, z = 1) => roundPanel(x, y, w, h, r, sx, sy, s, z);
  const R = (x: number, y: number, w: number, h: number) => P(rect(x, y, w, h));
  /** Columns of equal width across [x0, x0 + w], full height unless given. */
  const cols = (n: number, x0: number, w: number, y = 0, h = 84) => Array.from({ length: n }, (_, i) => R(x0 + (i * w) / n, y, w / n, h));
  /** A cols × rows grid of boxes filling the given area, row by row. */
  const grid = (c: number, r: number, x0: number, y0: number, w: number, h: number) =>
    Array.from({ length: c * r }, (_, i) => R(x0 + ((i % c) * w) / c, y0 + (Math.floor(i / c) * h) / r, w / c, h / r));
  const quads = () => [rect(0, 0, 75, 42), rect(75, 0, 75, 42), rect(0, 42, 75, 42), rect(75, 42, 75, 42)].map((q) => P(q));
  let out: (ShapePanel | null)[] = [];
  switch (id) {
    case 'bullseye':
      out = [C(75, 42, 27), ...quads()];
      break;
    case 'diamond':
      out = [
        P([[75, 0], [117, 42], [75, 84], [33, 42]]),
        P([[0, 0], [75, 0], [33, 42], [0, 42]]),
        P([[150, 0], [75, 0], [117, 42], [150, 42]]),
        P([[0, 42], [33, 42], [75, 84], [0, 84]]),
        P([[150, 42], [117, 42], [75, 84], [150, 84]]),
      ];
      break;
    case 'wideDiamond':
      out = [
        P([[75, 0], [150, 42], [75, 84], [0, 42]]),
        P([[0, 0], [75, 0], [0, 42]]),
        P([[75, 0], [150, 0], [150, 42]]),
        P([[0, 42], [0, 84], [75, 84]]),
        P([[150, 42], [150, 84], [75, 84]]),
      ];
      break;
    case 'pinwheel':
      out = [P(rect(50, 21, 50, 42)), P(rect(0, 0, 100, 21)), P(rect(100, 0, 50, 63)), P(rect(50, 63, 100, 21)), P(rect(0, 21, 50, 63))];
      break;
    case 'sunburst': {
      const far = 400;
      const wedges: (ShapePanel | null)[] = [];
      for (let i = 0; i < 8; i++) {
        const a0 = (i * Math.PI) / 4 - Math.PI / 2;
        const a1 = ((i + 1) * Math.PI) / 4 - Math.PI / 2;
        // Wedges are built in stage space so they stay even on any screen shape.
        const c: Pt = [W / 2, H / 2];
        const pts = clipToRect([c, [c[0] + far * W * Math.cos(a0), c[1] + far * W * Math.sin(a0)], [c[0] + far * W * Math.cos(a1), c[1] + far * W * Math.sin(a1)]], W, H);
        wedges.push(pts.length >= 3 ? polyPanel(pts.map(([x, y]) => [x / sx, y / sy] as Pt), sx, sy, W, H) : null);
      }
      out = [C(75, 42, 18), ...wedges];
      break;
    }
    case 'waves': {
      const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] =>
        Array.from({ length: 25 }, (_, i) => {
          const t = i / 24;
          const u = 1 - t;
          return [
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
          ] as Pt;
        });
      const w1 = cubic([0, 26], [40, 42], [110, 10], [150, 26]);
      const w2 = cubic([0, 58], [40, 42], [110, 74], [150, 58]);
      out = [
        P([...w1, ...[...w2].reverse()]),
        P([[0, 0], [150, 0], ...[...w1].reverse()]),
        P([...w2, [150, 84], [0, 84]]),
      ];
      break;
    }
    case 'mondrian':
      out = [P(rect(0, 0, 60, 50)), P(rect(60, 0, 90, 28)), P(rect(60, 28, 45, 22)), P(rect(105, 28, 45, 56)), P(rect(0, 50, 30, 34)), P(rect(30, 50, 75, 34))];
      break;
    case 'kaleidoscope': {
      const tris: Pt[][] = [];
      tris.push([[50, 0], [100, 0], [75, 42]], [[50, 84], [100, 84], [75, 42]]);
      for (const x of [-25, 25, 75, 125]) {
        tris.push([[x, 42], [x + 25, 0], [x + 50, 42]]);
        tris.push([[x, 42], [x + 25, 84], [x + 50, 42]]);
      }
      tris.push([[0, 0], [50, 0], [25, 42]], [[100, 0], [150, 0], [125, 42]], [[0, 84], [50, 84], [25, 42]], [[100, 84], [150, 84], [125, 42]]);
      out = tris.map((t) => P(t));
      break;
    }
    case 'slices':
      out = [P([[40, 0], [78, 0], [62, 84], [24, 84]]), P([[0, 0], [40, 0], [24, 84], [0, 84]]), P([[78, 0], [116, 0], [100, 84], [62, 84]]), P([[116, 0], [150, 0], [150, 84], [100, 84]])];
      break;
    case 'backdrop':
      out = [C(38, 42, 26), P(rect(0, 0, 150, 84)), C(92, 26, 18), C(118, 58, 20), C(78, 66, 12), C(132, 16, 10)];
      break;
    case 'pearls':
      out = [C(75, 42, 21), P(rect(0, 0, 150, 42)), P(rect(0, 42, 150, 42)), C(30, 42, 21), C(120, 42, 21)];
      break;
    case 'foam':
      out = [
        P([[38, 30], [72, 22], [105, 28], [122, 50], [90, 60], [52, 58]]),
        P([[0, 0], [45, 0], [38, 30], [0, 40]]),
        P([[45, 0], [100, 0], [105, 28], [72, 22], [38, 30]]),
        P([[100, 0], [150, 0], [150, 40], [122, 50], [105, 28]]),
        P([[0, 40], [38, 30], [52, 58], [30, 84], [0, 84]]),
        P([[52, 58], [90, 60], [100, 84], [30, 84]]),
        P([[90, 60], [122, 50], [150, 40], [150, 84], [100, 84]]),
      ];
      break;
    case 'bubbleGrid':
      out = [C(75, 63, 20), P(rect(0, 0, 150, 84)), C(25, 21, 20), C(75, 21, 20), C(125, 21, 20), C(25, 63, 20), C(125, 63, 20)];
      break;
    case 'moons':
      out = [C(75, 42, 37, 2), ...quads(), C(20, 42, 16), C(130, 42, 16)];
      break;
    // ---- tall boxes (a 9:16 box the height of a 16:9 screen is about 47 units wide) ----
    case 'tall3':
      out = cols(3, 0, 150);
      break;
    case 'tall4':
      out = cols(4, 0, 150);
      break;
    case 'tall5':
      out = cols(5, 0, 150);
      break;
    case 'tallSides':
      out = [R(28, 0, 47, 84), R(75, 0, 47, 84), R(0, 0, 28, 42), R(0, 42, 28, 42), R(122, 0, 28, 42), R(122, 42, 28, 42)];
      break;
    case 'tallGrid4':
      out = [R(0, 0, 47, 84), ...grid(2, 2, 47, 0, 103, 84)];
      break;
    case 'tallGrid6':
      out = [R(0, 0, 47, 84), ...grid(2, 3, 47, 0, 103, 84)];
      break;
    case 'wideOverTall':
      out = [R(45, 0, 60, 34), R(0, 0, 45, 34), R(105, 0, 45, 34), ...cols(5, 0, 150, 34, 50)];
      break;
    case 'tallWideTall':
      out = [R(37.5, 0, 75, 42), R(0, 0, 37.5, 84), R(112.5, 0, 37.5, 84), R(37.5, 42, 75, 42)];
      break;
    // ---- mixed sizes ----
    case 'bigL':
      out = [R(0, 0, 100, 56), R(100, 0, 50, 28), R(100, 28, 50, 28), R(100, 56, 50, 28), R(0, 56, 50, 28), R(50, 56, 50, 28)];
      break;
    case 'bigFrame':
      out = [R(37.5, 21, 75, 42), ...cols(4, 0, 150, 0, 21), R(0, 21, 37.5, 42), R(112.5, 21, 37.5, 42), ...cols(4, 0, 150, 63, 21)];
      break;
    case 'rows23':
      out = [...cols(2, 0, 150, 0, 48), ...cols(3, 0, 150, 48, 36)];
      break;
    case 'filmStrip':
      out = [R(0, 0, 150, 66), ...cols(6, 0, 150, 66, 18)];
      break;
    case 'bigLeft3':
      out = [R(0, 0, 105, 84), R(105, 0, 45, 28), R(105, 28, 45, 28), R(105, 56, 45, 28)];
      break;
    // ---- fun ----
    case 'honeycomb': {
      // Flat-topped hexagons, two rows tall, centred; the edge cells are cut by the screen.
      const hh = 42;
      const r = hh / Math.sqrt(3);
      const step = 1.5 * r;
      const hex = (cx: number, cy: number): Pt[] => Array.from({ length: 6 }, (_, i) => [cx + r * Math.cos((i * Math.PI) / 3), cy + r * Math.sin((i * Math.PI) / 3)] as Pt);
      const cells: Pt[] = [];
      for (let k = -3; k <= 3; k++) {
        const cx = 75 + k * step;
        if (cx + r <= 0 || cx - r >= 150) continue;
        for (const cy of k % 2 === 0 ? [21, 63] : [0, 42, 84]) cells.push([cx, cy]);
      }
      // Whole cells first, middle out.
      const cut = (c: Pt) => (c[1] === 0 || c[1] === 84 || c[0] - r < 0 || c[0] + r > 150 ? 1 : 0);
      cells.sort((a, b) => cut(a) - cut(b) || Math.abs(a[0] - 75) - Math.abs(b[0] - 75) || a[1] - b[1]);
      out = cells.map((c) => P(hex(c[0], c[1])));
      break;
    }
    case 'bubbleRing': {
      const ring = Array.from({ length: 6 }, (_, i) => C(75 + 50 * Math.cos((i * Math.PI) / 3), 42 + 26 * Math.sin((i * Math.PI) / 3), 13));
      out = [C(75, 42, 18), P(rect(0, 0, 150, 84)), ...ring];
      break;
    }
    case 'stripes': {
      // 45° bands; the end ones are triangles in the corners.
      const ks = [-84, -37.2, 9.6, 56.4, 103.2, 150];
      const band = (k0: number, k1: number): Pt[] => [[k0, 0], [k1, 0], [k1 + 84, 84], [k0 + 84, 84]];
      out = [2, 1, 3, 0, 4].map((i) => P(band(ks[i], ks[i + 1])));
      break;
    }
    case 'roundTiles': {
      const g = 4;
      const w = (150 - 4 * g) / 3;
      const h = (84 - 4 * g) / 3;
      const tiles = Array.from({ length: 9 }, (_, i) => Rd(g + (i % 3) * (w + g), g + Math.floor(i / 3) * (h + g), w, h, 5));
      out = [tiles[4], P(rect(0, 0, 150, 84)), ...tiles.filter((_, i) => i !== 4)];
      break;
    }
    case 'capsules':
      out = [Rd(57, 4, 36, 76, 18), P(rect(0, 0, 150, 84)), Rd(12, 4, 36, 76, 18), Rd(102, 4, 36, 76, 18)];
      break;
    // ---- picture in picture: a full-screen panel with small windows floating over it ----
    case 'pip1':
    case 'pip2':
    case 'pip3':
    case 'pip4': {
      const m = 4;
      const w = 36;
      const h = (w * 9) / 16; // design units are about square on a 16:9 screen
      const corner = (right: boolean, bottom: boolean) => Rd(right ? 150 - m - w : m, bottom ? 84 - m - h : m, w, h, 3);
      const back = P(rect(0, 0, 150, 84));
      if (id === 'pip1') out = [back, corner(true, true)];
      else if (id === 'pip2') out = [back, corner(true, true), corner(false, true)];
      else if (id === 'pip4') out = [back, corner(false, false), corner(true, false), corner(false, true), corner(true, true)];
      else {
        const sh = (84 - 4 * m) / 3;
        const sw = (sh * 16) / 9;
        out = [back, ...[0, 1, 2].map((i) => Rd(150 - m - sw, m + i * (sh + m), sw, sh, 3))];
      }
      break;
    }
  }
  return out.filter((p): p is ShapePanel => !!p);
}
