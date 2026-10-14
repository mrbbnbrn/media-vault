// Where each tile of the media grid goes. Two modes:
//  - "grid": equal 4:3 tiles (pictures are cropped to fill them)
//  - "shape": justified rows; every tile has its item's true shape
// Optional groups (the timeline's months) start with a header row.

export let GAP = 10;
/** Space between tiles (Settings → Appearance). */
export function setGridGap(px: number) {
  GAP = Math.max(0, Math.min(40, Math.round(px)));
}
export const HEADER_H = 46;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GroupHeader {
  y: number;
  label: string;
  count: number;
}

export interface Layout {
  boxes: Box[];
  headers: GroupHeader[];
  height: number;
  /** Tile size in "grid" mode (used for the uncropped hover view). */
  tileW: number;
  tileH: number;
}

export interface Sized {
  width: number | null;
  height: number | null;
  kind: string;
}

export interface Group {
  /** Index of the first item in this group. */
  start: number;
  label: string;
}

export function aspectOf(it: Sized): number {
  if (it.width && it.height && it.width > 0 && it.height > 0) return Math.min(4, Math.max(0.25, it.width / it.height));
  return it.kind === 'pdf' || it.kind === 'text' ? 0.75 : 4 / 3;
}

export function layoutGrid(items: Sized[], width: number, tile: number, mode: 'grid' | 'shape', groups?: Group[]): Layout {
  width = Math.max(1, width);
  const cols = Math.max(1, Math.floor((width + GAP) / (tile + GAP)));
  const tileW = (width - GAP * (cols - 1)) / cols;
  const tileH = tileW * 0.75;
  const boxes: Box[] = new Array(items.length);
  const headers: GroupHeader[] = [];
  const gs: Group[] = groups?.length ? groups : [{ start: 0, label: '' }];
  let y = 0;
  for (let g = 0; g < gs.length; g++) {
    const from = gs[g].start;
    const to = g + 1 < gs.length ? gs[g + 1].start : items.length;
    if (to <= from) continue;
    if (gs[g].label) {
      headers.push({ y, label: gs[g].label, count: to - from });
      y += HEADER_H;
    }
    if (mode === 'grid') {
      for (let i = from; i < to; i++) {
        const k = i - from;
        const r = Math.floor(k / cols);
        const c = k % cols;
        boxes[i] = { x: c * (tileW + GAP), y: y + r * (tileH + GAP), w: tileW, h: tileH };
      }
      y += Math.ceil((to - from) / cols) * (tileH + GAP);
    } else {
      const target = tile * 0.75;
      let row: number[] = [];
      let sum = 0;
      const place = (h: number, stretch: boolean) => {
        let x = 0;
        // A final row that is nearly full is stretched like the others.
        const k = stretch ? (width - GAP * (row.length - 1)) / (sum * h) : 1;
        for (const i of row) {
          const w = aspectOf(items[i]) * h * k;
          boxes[i] = { x, y, w, h: h * k };
          x += w + GAP;
        }
        y += h * k + GAP;
        row = [];
        sum = 0;
      };
      for (let i = from; i < to; i++) {
        row.push(i);
        sum += aspectOf(items[i]);
        if (sum * target + GAP * (row.length - 1) >= width) place(target, true);
      }
      if (row.length) place(target, sum * target + GAP * (row.length - 1) > width * 0.85);
    }
  }
  return { boxes, headers, height: Math.max(0, y - GAP), tileW, tileH };
}

/** Indices of boxes that overlap [top, bottom] (boxes are in reading order). */
export function visibleRange(boxes: Box[], top: number, bottom: number): [number, number] {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].y + boxes[mid].h < top) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < boxes.length && boxes[end].y <= bottom) end++;
  return [lo, end];
}

/** Month groups for the timeline; items must already be sorted by date. */
export function monthGroups(dates: number[]): Group[] {
  const out: Group[] = [];
  let last = '';
  const fmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  dates.forEach((secs, i) => {
    const d = new Date(secs * 1000);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (key !== last) {
      out.push({ start: i, label: fmt.format(d) });
      last = key;
    }
  });
  return out;
}
