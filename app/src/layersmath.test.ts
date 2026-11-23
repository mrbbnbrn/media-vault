import { describe, expect, it } from 'vitest';
import { borderCanvas, borderNeedsFill, composeBorder, composeLayer, layerCoverage, planLayers } from './layersmath';
import { mapLabel } from './derived';
import { boxBlur } from './layers';

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

// A wall (far), a table in front of the lower half, a box on the table: three clear jumps.
const scene = map(120, 90, (x, y) => (x > 50 && x < 80 && y > 30 && y < 60 ? 230 : y > 45 ? 150 : 40));

describe('More layers: where the picture is cut', () => {
  it('cuts at real jumps into three layers, far to near', () => {
    const p = planLayers(scene, null, 4, 'medium')!;
    expect(p).not.toBeNull();
    expect(p.n).toBe(3);
    expect(p.cls[10 * 120 + 10]).toBe(0);
    expect(p.cls[80 * 120 + 10]).toBe(1);
    expect(p.cls[45 * 120 + 65]).toBe(2);
  });
  it('never cuts along a slope (a floor going into the distance)', () => {
    expect(planLayers(map(120, 90, (_x, y) => 30 + y * 2), null, 4, 'small')).toBeNull();
  });
  it('up to 3 layers when asked', () => {
    expect(planLayers(scene, null, 3, 'medium')!.n).toBeLessThanOrEqual(3);
    const four = map(160, 90, (x) => (x < 40 ? 20 : x < 80 ? 90 : x < 120 ? 160 : 240));
    expect(planLayers(four, null, 3, 'small')!.n).toBe(3);
    expect(planLayers(four, null, 4, 'small')!.n).toBe(4);
  });
  it('a soft jump (as real depth models make them) is one cut in its middle, not thin rim layers', () => {
    // A person (near) before a wall, its depth edge a ramp over ~13 pixels.
    const W = 260;
    const H = 200;
    const raw = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) raw[y * W + x] = ((x - 130) / 40) ** 2 + ((y - 120) / 80) ** 2 < 1 ? 170 : 50 + (y / H) * 20;
    const soft = boxBlur(raw, W, H, 6);
    const d = map(W, H, (x, y) => soft[y * W + x]);
    const p = planLayers(d, null, 4, 'medium')!;
    expect(p.n).toBe(2);
    // Along the middle row the cut is where the depth is halfway up the ramp.
    const row = 120;
    let cutX = 0;
    for (let x = 0; x < W; x++)
      if (p.cls[row * W + x] === 1) {
        cutX = x;
        break;
      }
    const half = (d.data[row * W + 60] + d.data[row * W + 130]) / 2;
    expect(Math.abs(d.data[row * W + cutX] - half)).toBeLessThan(15);
  });
  it('small bits (hair, leaves) are not layers of their own', () => {
    const dots = map(120, 90, (x, y) => (x % 30 === 0 && y % 30 === 0 ? 250 : 40));
    expect(planLayers(dots, null, 4, 'small')).toBeNull();
  });
  it('the subject outline is a cut of its own when it stands out', () => {
    const d = map(100, 100, (x, y) => (Math.hypot(x - 50, y - 50) < 20 ? 160 : 60 + y * 0.3));
    const mask = map(100, 100, (x, y) => (Math.hypot(x - 50, y - 50) < 20 ? 255 : 0));
    const p = planLayers(d, mask, 4, 'big')!;
    expect(p.n).toBe(2);
    expect(p.cls[50 * 100 + 50]).toBe(1);
  });
  it('fills only a band behind the jump, from its own side', () => {
    const p = planLayers(scene, null, 4, 'medium')!;
    const h0 = p.holes[0];
    // Just below the table's top edge: filled for the wall layer; deep inside the table: not.
    expect(h0[48 * 120 + 10]).toBe(255);
    expect(h0[88 * 120 + 10]).toBe(0);
    // Never on the wall itself.
    expect(h0[10 * 120 + 10]).toBe(0);
    const orig = rgba(120, 90, (_x, y) => (y > 45 ? [200, 0, 0] : [0, 0, 200]));
    const l0 = composeLayer(orig, 120, 90, scene, p, 0, null);
    const at = (x: number, y: number) => Array.from(l0.subarray((y * 120 + x) * 4, (y * 120 + x) * 4 + 4));
    // The band: the wall's blue and depth carried down; further in behind the table filled too (a big
    // camera move sees past the band: no copy of the table there), and the layer's own depth (the
    // wall's) carried on under the table: no ramp up to the table.
    expect(at(10, 48)[2]).toBeGreaterThan(150);
    expect(at(10, 48)[3]).toBeLessThan(80);
    expect(at(10, 88)[0]).toBeLessThan(60);
    expect(at(10, 88)[2]).toBeGreaterThan(150);
    expect(at(10, 88)[3]).toBeLessThan(80);
    expect(at(10, 10)).toEqual([0, 0, 200, 40]);
    // The nearest layer (the box): its own depth carried out over the wall beside it.
    const near = composeLayer(orig, 120, 90, scene, p, 2, null);
    expect(near[(45 * 120 + 65) * 4 + 3]).toBe(230);
    expect(near[(20 * 120 + 65) * 4 + 3]).toBeGreaterThan(200);
  });
  it('coverage: each layer where it is the surface (plus its band)', () => {
    const p = planLayers(scene, null, 4, 'medium')!;
    const c = layerCoverage(p);
    const at = (x: number, y: number, ch: number) => c[(y * 120 + x) * 4 + ch];
    expect(at(10, 80, 0)).toBe(255);
    expect(at(10, 10, 0)).toBe(0);
    expect(at(65, 45, 1)).toBe(255);
    expect(at(10, 80, 1)).toBe(0);
  });
});

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
  it('names border fills and layers', () => {
    expect(mapLabel('plate', 'da3-mono-large@518~1_b8_lama', names)).toEqual({ name: 'Best', detail: 'border fill 8 % · LaMa fill' });
    expect(mapLabel('plate', 'da3-mono-large@518~1_birefnet-lite@1024_e0.70_m4m_simple_l3abc_1', names))
      .toEqual({ name: 'Best', detail: 'More layers: layer 2 of 3 · outline Fast · sharper edges · Simple fill' });
    expect(mapLabel('plate', 'da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2x_0', names).detail).toBe('More layers: layer 1 of 2 · MI-GAN fill');
    expect(mapLabel('plate', 'da3-mono-large@518~1_nomask_e0.00_m3s_migan_l2xr2_1', names).detail).toBe('More layers: layer 2 of 2 · MI-GAN fill');
  });
});
