import { describe, expect, it } from 'vitest';
import type { DepthMap } from './api';
import { mapBytes, parseDepth } from './api';
import {
  AHEAD_CAP, aheadCount, bgDepthNear, boxBlur, distanceTo, edgesStrength, fillDepth, fillRgba, holeMask, lightAngle, lightDir, lightFrame, lightStrength,
  lightWords, pushPull, refineEdges, resample,
} from './layers';
import { pickAhead } from './depth';

const W = 64;
/** A square subject in the middle (uv 0.3–0.7), as an outline. */
function squareMask(w = W, h = W): DepthMap {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x >= 0.3 * w && x < 0.7 * w && y >= 0.3 * h && y < 0.7 * h) data[y * w + x] = 255;
  return { w, h, data };
}
/** Depth: the subject at 200, the background at 50, then blurred so the subject's depth bleeds across its outline (as the models do). */
function bledDepth(): DepthMap {
  const m = squareMask();
  const v = new Float32Array(W * W);
  for (let i = 0; i < v.length; i++) v[i] = m.data[i] ? 200 : 50;
  const b = boxBlur(v, W, W, 4);
  return { w: W, h: W, data: Uint8Array.from(b, (x) => Math.round(x)) };
}
const at = (m: DepthMap, x: number, y: number) => m.data[y * m.w + x];

describe('picture layers: helpers', () => {
  it('measures distance to the nearest set pixel', () => {
    const set = new Uint8Array(9 * 9);
    set[4 * 9 + 4] = 1;
    const d = distanceTo(set, 9, 9);
    expect(d[4 * 9 + 4]).toBe(0);
    expect(d[4 * 9 + 7]).toBeCloseTo(3);
    expect(d[0]).toBeCloseTo(4 * Math.SQRT2);
  });
  it('resamples with the pixel centres lined up', () => {
    const r = resample([0, 255], 2, 1, 4, 1);
    expect(r[0]).toBe(0);
    expect(r[3]).toBe(255);
    expect(r[1]).toBeGreaterThan(0);
    expect(r[1]).toBeLessThan(r[2]);
  });
});

describe('push-pull fill', () => {
  it('keeps what is known and fills a hole from its surroundings', () => {
    const w = 32;
    const v = new Float32Array(w * w);
    const k = new Float32Array(w * w);
    for (let y = 0; y < w; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        v[i] = x < 16 ? 40 : 200; // left dark, right bright
        k[i] = Math.hypot(x - 16, y - 16) < 6 ? 0 : 1; // a round hole in the middle
        if (!k[i]) v[i] = 999; // never leaks into the fill
      }
    const f = pushPull(v, k, w, w);
    expect(f[0]).toBe(40);
    expect(f[w - 1]).toBe(200);
    // Inside the hole: between the two sides, darker on the left, brighter on the right.
    const left = f[16 * w + 12];
    const right = f[16 * w + 20];
    expect(left).toBeGreaterThanOrEqual(40);
    expect(right).toBeLessThanOrEqual(200);
    expect(left).toBeLessThan(right);
    for (let i = 0; i < f.length; i++) expect(f[i]).toBeLessThanOrEqual(200.001);
  });
  it('fills several values per pixel and odd sizes', () => {
    const w = 7;
    const h = 5;
    const v = new Float32Array(w * h * 3).fill(0);
    const k = new Float32Array(w * h).fill(1);
    for (let i = 0; i < w * h; i++) [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]] = [10, 20, 30];
    k[2 * w + 3] = 0;
    v.set([255, 255, 255], (2 * w + 3) * 3);
    const f = pushPull(v, k, w, h, 3);
    expect(Array.from(f.slice((2 * w + 3) * 3, (2 * w + 3) * 3 + 3)).map(Math.round)).toEqual([10, 20, 30]);
  });
  it('fills a picture (Simple) only inside the hole, alpha opaque', () => {
    const w = 16;
    const rgba = new Uint8Array(w * w * 4);
    for (let i = 0; i < w * w; i++) rgba.set([100, 150, 200, 255], i * 4);
    const hole = new Float32Array(w * w);
    for (let y = 6; y < 10; y++) for (let x = 6; x < 10; x++) {
      hole[y * w + x] = 1;
      rgba.set([255, 0, 0, 255], (y * w + x) * 4);
    }
    const out = fillRgba(rgba, w, w, hole);
    expect(Array.from(out.slice((8 * w + 8) * 4, (8 * w + 8) * 4 + 4))).toEqual([100, 150, 200, 255]);
    expect(Array.from(out.slice(0, 4))).toEqual([100, 150, 200, 255]);
  });
  it('fills the subject area of a depth map with the background depth around it', () => {
    const d = bledDepth();
    const hole = Float32Array.from(holeMask(squareMask(), 5, 2));
    const f = fillDepth(d, hole);
    // The middle of the subject now has the background's depth.
    expect(at(f, 32, 32)).toBeLessThan(70);
    expect(at(f, 2, 2)).toBe(at(d, 2, 2));
  });
  it('grows the hole beyond the outline and fades it out', () => {
    const h = holeMask(squareMask(), 3, 2);
    const row = 32 * W;
    expect(h[row + 32]).toBe(1);
    expect(h[row + Math.ceil(0.3 * W) - 3]).toBe(1); // 3 px outside
    expect(h[row + Math.ceil(0.3 * W) - 4]).toBeGreaterThan(0); // fading
    expect(h[row + Math.ceil(0.3 * W) - 7]).toBe(0);
  });
});

describe('sharper depth edges', () => {
  it('stops the depth bleeding across the outline, leaves the rest alone', () => {
    const d = bledDepth();
    const r = refineEdges(d, squareMask(), 1);
    const edge = Math.ceil(0.3 * W); // first subject column
    // Before: smeared both ways.
    expect(at(d, edge - 2, 32)).toBeGreaterThan(80);
    expect(at(d, edge + 1, 32)).toBeLessThan(170);
    // After: the background two pixels out keeps the background's depth, the subject's edge the subject's.
    expect(at(r, edge - 2, 32)).toBeLessThan(60);
    expect(at(r, edge - 3, 32)).toBeLessThan(55);
    expect(at(r, edge + 1, 32)).toBeGreaterThan(185);
    expect(at(r, edge + 2, 32)).toBeGreaterThan(190);
    // Softened over about a pixel right at the outline (no hard aliasing step).
    expect(at(r, edge - 1, 32)).toBeGreaterThan(at(r, edge - 3, 32));
    expect(at(r, edge, 32)).toBeLessThan(at(r, edge + 2, 32) + 1);
    // Far away: as it was.
    expect(at(r, 2, 2)).toBe(at(d, 2, 2));
    expect(at(r, 32, 32)).toBe(at(d, 32, 32));
  });
  it('a weaker strength changes less', () => {
    const d = bledDepth();
    const edge = Math.ceil(0.3 * W);
    const strong = refineEdges(d, squareMask(), 1);
    const weak = refineEdges(d, squareMask(), 0.2);
    const off = (m: DepthMap) => Math.abs(at(m, edge - 3, 32) - at(d, edge - 3, 32));
    expect(off(weak)).toBeLessThan(off(strong));
  });
  it('leaves maps without a clear subject (or flat ones) as they are', () => {
    const d = bledDepth();
    expect(refineEdges(d, { w: W, h: W, data: new Uint8Array(W * W) }, 1)).toBe(d);
    const flat = { w: 1, h: 1, data: new Uint8Array([128]) };
    expect(refineEdges(flat, squareMask(), 1)).toBe(flat);
  });
  it('works with an outline at another size than the depth map', () => {
    const d = bledDepth();
    const r = refineEdges(d, squareMask(128, 128), 1);
    expect(at(r, Math.ceil(0.3 * W) - 3, 32)).toBeLessThan(60);
  });
  it('reads the strength safely', () => {
    expect(edgesStrength(undefined)).toBe(0.7);
    expect(edgesStrength(5)).toBe(1);
    expect(edgesStrength(0.01)).toBe(0.2);
  });
  it('finds the background depth around the subject', () => {
    const d = bledDepth();
    const z = bgDepthNear(d, squareMask());
    expect(z).not.toBeNull();
    expect(z! * 255).toBeLessThan(110);
    expect(bgDepthNear(d, { w: W, h: W, data: new Uint8Array(W * W) })).toBeNull();
  });
});

describe('a light that stays put', () => {
  it('comes from where the angle says (clockwise from the top)', () => {
    expect(lightDir(0).x).toBeCloseTo(0);
    expect(lightDir(0).y).toBeCloseTo(-1);
    expect(lightDir(90).x).toBeCloseTo(1);
    expect(lightDir(315).x).toBeLessThan(0);
    expect(lightDir(315).y).toBeLessThan(0);
    expect(lightWords(315)).toBe('From the top left');
    expect(lightWords(180)).toBe('From the bottom');
    expect(lightAngle(-45)).toBe(315);
    expect(lightAngle(undefined)).toBe(315);
    expect(lightStrength(9)).toBe(2);
  });
  it('the shadow falls away from the light, further when the subject stands out more', () => {
    const near = lightFrame(0, 1, { x: 0, y: 0 }, 1, 0.5, 0.5);
    const far = lightFrame(0, 1, { x: 0, y: 0 }, 1, 0.8, 0.3);
    // Light from the top: a shadow point sees the subject above it (offset towards the light).
    expect(near.offset.y).toBeLessThan(0);
    expect(Math.abs(near.offset.x)).toBeLessThan(1e-9);
    expect(far.offset.y).toBeLessThan(near.offset.y);
    // Wide pictures: the same distance in pixels both ways.
    const wide = lightFrame(90, 1, { x: 0, y: 0 }, 2, 0.5, 0.5);
    expect(wide.offset.x).toBeCloseTo(near.offset.y * -0.5);
  });
  it('the rim slides round the edge the other way from the camera, as if the light stayed put', () => {
    const still = lightFrame(0, 1, { x: 0, y: 0 }, 1, 0.7, 0.4);
    const right = lightFrame(0, 1, { x: 0.02, y: 0 }, 1, 0.7, 0.4);
    const left = lightFrame(0, 1, { x: -0.02, y: 0 }, 1, 0.7, 0.4);
    expect(still.rim.x).toBeCloseTo(0);
    expect(right.rim.x).toBeLessThan(0);
    expect(left.rim.x).toBeGreaterThan(0);
    expect(Math.hypot(right.rim.x, right.rim.y)).toBeCloseTo(Math.hypot(still.rim.x, still.rim.y));
    // The shadow is fixed to the room: it doesn't change with the camera (the drawing moves it with the background).
    expect(right.offset).toEqual(still.offset);
  });
  it('is stronger or weaker with the setting', () => {
    expect(lightFrame(0, 2, { x: 0, y: 0 }, 1, 0.5, 0.5).shadow).toBeGreaterThan(lightFrame(0, 0.5, { x: 0, y: 0 }, 1, 0.5, 0.5).shadow);
  });
});

describe('look-ahead by stay time', () => {
  it('prepares more ahead when stays are short', () => {
    expect(aheadCount(null)).toBe(2);
    expect(aheadCount(10)).toBe(2);
    expect(aheadCount(5)).toBe(2);
    expect(aheadCount(4.9)).toBe(4);
    expect(aheadCount(1)).toBe(4);
    expect(aheadCount(0.5)).toBe(8);
    expect(aheadCount(0.1)).toBe(AHEAD_CAP);
    expect(AHEAD_CAP).toBe(8);
  });
  it('picks that many pictures (and the previous one)', () => {
    const img = (n: string) => ({ kind: 'image', src: n });
    const next = Array.from({ length: 10 }, (_, i) => img(`n${i}`));
    expect(pickAhead(next, [img('p')], aheadCount(0.5))).toEqual([...next.slice(0, 8).map((x) => x.src), 'p']);
    expect(pickAhead(next, [img('p')], aheadCount(2))).toEqual(['n0', 'n1', 'n2', 'n3', 'p']);
  });
});

describe('saved maps', () => {
  it('saves maps in the shape depth_estimate sends them', () => {
    const m = { w: 3, h: 2, data: new Uint8Array([1, 2, 3, 4, 5, 6]) };
    expect(parseDepth(mapBytes(m))).toEqual(m);
  });
});
