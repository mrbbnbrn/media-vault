import { describe, expect, it } from 'vitest';
import { borderCanvas, borderNeedsFill, composeBorder } from './layersmath';
import { isMoreLayersTag, mapLabel } from './derived';

const map = (w: number, h: number, f: (x: number, y: number) => number) => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.round(f(x, y));
  return { w, h, data };
};
const rgba = (w: number, h: number, f: (x: number, y: number) => [number, number, number]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      d.set([r, g, b, 255], (y * w + x) * 4);
    }
  return d;
};

describe('Border fill', () => {
  it('carries a plain edge on as it is and paints the rest', () => {
    // Black bars on the left and right, a picture in between.
    const orig = rgba(40, 20, (x, y) => (x < 4 || x >= 36 ? [0, 0, 0] : [x * 6, y * 10, 100]));
    const c = borderCanvas(orig, 40, 20, 5);
    expect([c.W, c.H]).toEqual([50, 30]);
    expect(c.hole[10 * 50 + 1]).toBe(0);
    expect(c.hole[1 * 50 + 25]).toBe(1);
    expect(c.data[(10 * 50 + 1) * 4]).toBe(0);
    expect(borderNeedsFill(c)).toBe(true);
    const flat = borderCanvas(rgba(40, 20, () => [10, 10, 10]), 40, 20, 5);
    expect(borderNeedsFill(flat)).toBe(false);
  });
  it('the depth is carried straight out from the edge; the picture stays as it is inside', () => {
    const orig = rgba(40, 20, (x) => [x * 6, 0, 0]);
    const depth = map(20, 10, (x) => x * 10);
    const c = borderCanvas(orig, 40, 20, 5);
    const out = composeBorder(c, 40, 20, 5, depth, null);
    const at = (x: number, y: number) => out.subarray((y * 50 + x) * 4, (y * 50 + x) * 4 + 4);
    expect(at(0, 15)[3]).toBe(at(5, 15)[3]);
    expect(at(49, 15)[3]).toBe(at(44, 15)[3]);
    expect(Array.from(at(20, 15)).slice(0, 3)).toEqual([90, 0, 0]);
  });
});

describe('saved looks labels', () => {
  const names = new Map([['da3-mono-large', 'Best'], ['birefnet-lite', 'Fast']]);
  it('names border fills', () => {
    expect(mapLabel('plate', 'da3-mono-large@518~1_b8_lama', names)).toEqual({ name: 'Best', detail: 'border fill 8 % · LaMa fill' });
  });
  it('knows the removed More layers saves (hidden from Delete 3D data; deleted once after unlock)', () => {
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_birefnet-lite@1024_e0.70_m4m_simple_l3abc_1')).toBe(true);
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2x_0')).toBe(true);
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2xr2_1')).toBe(true);
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2xr3_1')).toBe(true);
    // Border fill and Layered 3D / Lift-off are not.
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_b8_lama')).toBe(false);
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_birefnet-lite@1024_e0.70_lama')).toBe(false);
    expect(isMoreLayersTag('plate', 'da3-mono-large@518~1_birefnet-lite@1024_e0.00')).toBe(false);
    expect(isMoreLayersTag('fore', 'da3-mono-large@518~1_birefnet-lite@1024_e0.70_m4m_simple_l3abc_1')).toBe(false);
  });
});
