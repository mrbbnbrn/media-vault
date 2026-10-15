// The tiny colour sketch of a thumbnail (made in Rust, sketch.rs), drawn
// as a tile's background the moment the grid shows, so the grid is never a
// wall of grey squares while thumbnails load. The browser stretches a few
// pixels across the whole tile, which comes out as a soft blur of the
// picture's colours; the thumbnail then fades in over it.
//
// Text form: columns digit, rows digit, then 3 hex digits (R, G, B, 4 bits
// each) per cell, row by row.

export interface Sketch {
  cols: number;
  rows: number;
  /** RGB bytes, row by row (cols × rows × 3). */
  rgb: Uint8Array;
}

export function parseSketch(s: string | null | undefined): Sketch | null {
  if (!s || s.length < 5) return null;
  const cols = s.charCodeAt(0) - 48;
  const rows = s.charCodeAt(1) - 48;
  if (!(cols > 0 && cols < 10 && rows > 0 && rows < 10) || s.length !== 2 + cols * rows * 3) return null;
  const rgb = new Uint8Array(cols * rows * 3);
  for (let i = 0; i < rgb.length; i++) {
    const v = parseInt(s[2 + i], 16);
    if (Number.isNaN(v)) return null;
    rgb[i] = v * 17;
  }
  return { cols, rows, rgb };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

/** A 24-bit BMP of the sketch's cells (no canvas needed, so it is quick and works anywhere). */
export function sketchBmp(k: Sketch): Uint8Array {
  const stride = (k.cols * 3 + 3) & ~3;
  const size = 54 + stride * k.rows;
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 0x42;
  b[1] = 0x4d;
  v.setUint32(2, size, true);
  v.setUint32(10, 54, true);
  v.setUint32(14, 40, true);
  v.setInt32(18, k.cols, true);
  v.setInt32(22, k.rows, true); // positive: rows bottom-up
  v.setUint16(26, 1, true);
  v.setUint16(28, 24, true);
  v.setUint32(34, stride * k.rows, true);
  for (let r = 0; r < k.rows; r++) {
    const row = 54 + (k.rows - 1 - r) * stride;
    for (let c = 0; c < k.cols; c++) {
      const i = (r * k.cols + c) * 3;
      b[row + c * 3] = k.rgb[i + 2];
      b[row + c * 3 + 1] = k.rgb[i + 1];
      b[row + c * 3 + 2] = k.rgb[i];
    }
  }
  return b;
}

/** Cubic B-spline weights for the 4 cells around a point `t` (0–1) past cell 1. */
function bspline(t: number): [number, number, number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(1 - t) ** 3 / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6];
}

/**
 * The sketch made `f` times finer with a soft cubic (B-spline) blend between
 * cell centres, so the browser's own stretching shows a smooth blur instead
 * of the creases plain stretching leaves at each cell.
 */
export function smoothSketch(k: Sketch, f: number): Sketch {
  const cols = k.cols * f;
  const rows = k.rows * f;
  const rgb = new Uint8Array(cols * rows * 3);
  const clampC = (c: number) => Math.min(k.cols - 1, Math.max(0, c));
  const clampR = (r: number) => Math.min(k.rows - 1, Math.max(0, r));
  for (let y = 0; y < rows; y++) {
    const fy = (y + 0.5) / f - 0.5;
    const ry = Math.floor(fy);
    const wy = bspline(fy - ry);
    for (let x = 0; x < cols; x++) {
      const fx = (x + 0.5) / f - 0.5;
      const cx = Math.floor(fx);
      const wx = bspline(fx - cx);
      for (let ch = 0; ch < 3; ch++) {
        let v = 0;
        for (let j = 0; j < 4; j++) {
          const r = clampR(ry - 1 + j);
          for (let i = 0; i < 4; i++) v += wy[j] * wx[i] * k.rgb[(r * k.cols + clampC(cx - 1 + i)) * 3 + ch];
        }
        rgb[(y * cols + x) * 3 + ch] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return { cols, rows, rgb };
}

const urls = new Map<string, string>();

/** A data: URL to use as a tile's background (CSS `background-size: cover`), or null. Remembered per sketch. */
export function sketchUrl(s: string | null | undefined): string | null {
  if (!s) return null;
  const known = urls.get(s);
  if (known) return known;
  const k = parseSketch(s);
  if (!k) return null;
  const url = `data:image/bmp;base64,${base64(sketchBmp(smoothSketch(k, 4)))}`;
  if (urls.size > 5000) urls.clear();
  urls.set(s, url);
  return url;
}

/** The average colour of a sketch, as CSS (for anything that only wants one colour). */
export function sketchColour(s: string | null | undefined): string | null {
  const k = parseSketch(s);
  if (!k) return null;
  const n = k.cols * k.rows;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    r += k.rgb[i * 3];
    g += k.rgb[i * 3 + 1];
    b += k.rgb[i * 3 + 2];
  }
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
}
