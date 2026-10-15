import { describe, expect, it } from 'vitest';
import { drawnRect } from './flip';
import {
  gifFrame, gifLoops, isAnimatedPng, isLosslessWebp, saveWay, turn, turnBox, turnedRect, turnedSize, turnedStyle, turnLabel, turnMatrix, turnPixels, turnPoint,
  type Quarter,
} from './rotation';

const Q: Quarter[] = [0, 1, 2, 3];
const apply = (m: number[], u: number, v: number) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];

describe('rotating in the viewer', () => {
  it('composes quarter turns both ways', () => {
    expect(turn(0, 1)).toBe(1);
    expect(turn(3, 1)).toBe(0);
    expect(turn(0, -1)).toBe(3);
    expect(turn(1, -2)).toBe(3);
    expect(turn(2, 6)).toBe(0);
    for (const r of Q) {
      expect(turn(turn(r, 1), -1)).toBe(r);
      expect(turn(r, 4)).toBe(r);
      // Three rights make a left.
      expect(turn(turn(turn(r, 1), 1), 1)).toBe(turn(r, -1));
    }
    expect(turnLabel(1)).toBe('Rotated 90° right');
    expect(turnLabel(3)).toBe('Rotated 90° left');
  });

  it('fits the turned shape', () => {
    // A landscape 400×200 picture turned a quarter on a 1000×500 stage: 250×500, centred.
    expect(turnedSize({ w: 400, h: 200 }, 1)).toEqual({ w: 200, h: 400 });
    expect(turnedSize({ w: 400, h: 200 }, 2)).toEqual({ w: 400, h: 200 });
    expect(turnedRect(1000, 500, 400, 200, 'contain', 1)).toEqual({ left: 375, top: 0, width: 250, height: 500 });
    expect(turnedRect(1000, 500, 400, 200, 'contain', 0)).toEqual({ left: 0, top: 0, width: 1000, height: 500 });
    // Fill (cover) with the turned shape: as wide as the stage.
    expect(turnedRect(1000, 500, 400, 200, 'cover', 3)).toEqual({ left: 0, top: -750, width: 1000, height: 2000 });
    // Zoom and pan stay in screen pixels on top.
    const z = { s: 2, x: -100, y: -50 };
    expect(turnedRect(1000, 500, 400, 200, 'contain', 1, z)).toEqual(drawnRect(1000, 500, 200, 400, 'contain', z));
  });

  it('draws the unturned picture into the turned box', () => {
    // Picture 40×20 drawn turned into the box (10, 5, 20, 40).
    for (const r of Q) {
      const odd = r % 2 === 1;
      const [bw, bh] = odd ? [20, 40] : [40, 20];
      const m = turnMatrix(r, 10, 5, bw, bh);
      const corners = [[0, 0], [40, 0], [0, 20], [40, 20]].map(([u, v]) => apply(m, u, v));
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      expect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]).toEqual([10, 5, 10 + bw, 5 + bh]);
      // The picture's top-left corner lands where a clockwise turn puts it.
      const [px, py] = turnPoint(0, 0, r);
      expect(apply(m, 0, 0)).toEqual([10 + px * bw, 5 + py * bh]);
      // …and so does any point.
      const [qx, qy] = turnPoint(0.25, 0.75, r);
      const p = apply(m, 10, 15);
      expect(p[0]).toBeCloseTo(10 + qx * bw);
      expect(p[1]).toBeCloseTo(5 + qy * bh);
    }
  });

  it('turns face boxes with the picture', () => {
    const f = { id: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4, person: null };
    expect(turnBox(f, 0)).toBe(f);
    const right = turnBox(f, 1);
    expect(right.x).toBeCloseTo(0.4);
    expect(right.y).toBeCloseTo(0.1);
    expect([right.w, right.h, right.id]).toEqual([0.4, 0.3, 1]);
    const half = turnBox(f, 2);
    expect(half.x).toBeCloseTo(0.6);
    expect(half.y).toBeCloseTo(0.4);
    // Every turn agrees with turning its corners, and four turns are none.
    for (const r of Q) {
      const b = turnBox(f, r);
      const pts = [turnPoint(f.x, f.y, r), turnPoint(f.x + f.w, f.y + f.h, r)];
      expect(b.x).toBeCloseTo(Math.min(pts[0][0], pts[1][0]));
      expect(b.y).toBeCloseTo(Math.min(pts[0][1], pts[1][1]));
      expect(b.w * b.h).toBeCloseTo(f.w * f.h);
      const back = [1, 2, 3, 4].reduce((acc) => turnBox(acc, 1), f);
      expect(back.x).toBeCloseTo(f.x);
      expect(back.y).toBeCloseTo(f.y);
    }
  });

  it('lays a video out turned so object-fit uses the turned shape', () => {
    expect(turnedStyle(0, 1000, 500)).toBeUndefined();
    expect(turnedStyle(1, 1000, 500)).toMatchObject({ width: 500, height: 1000, transform: 'translate(-50%, -50%) rotate(90deg)' });
    expect(turnedStyle(2, 1000, 500)).toMatchObject({ width: 1000, height: 500 });
  });

  it('turns pixels like the canvas does', () => {
    // 3×2: 1 2 3 / 4 5 6
    const px = new Uint8ClampedArray(new Uint32Array([1, 2, 3, 4, 5, 6]).buffer);
    const vals = (r: Quarter) => {
      const t = turnPixels(px, 3, 2, r);
      return { w: t.w, h: t.h, v: Array.from(new Uint32Array(t.data.buffer)) };
    };
    expect(vals(1)).toEqual({ w: 2, h: 3, v: [4, 1, 5, 2, 6, 3] });
    expect(vals(2)).toEqual({ w: 3, h: 2, v: [6, 5, 4, 3, 2, 1] });
    expect(vals(3)).toEqual({ w: 2, h: 3, v: [3, 6, 2, 5, 1, 4] });
  });

  it('knows how each kind is saved', () => {
    expect(saveWay('image', 'Beach.JPG')).toEqual({ way: 'jpeg' });
    expect(saveWay('image', 'a.png')).toEqual({ way: 'pixels', mime: 'image/png' });
    expect(saveWay('image', 'a.webp')).toEqual({ way: 'pixels', mime: 'image/webp' });
    expect(saveWay('gif', 'a.gif')).toEqual({ way: 'gif' });
    expect(saveWay('gif', 'moving.webp').way).toBe('no');
    expect(saveWay('video', 'clip.mp4')).toEqual({ way: 'video' });
    expect(saveWay('video', 'clip.webm').way).toBe('no');
    expect(saveWay('text', 'a.txt').way).toBe('no');
  });

  it('reads what matters from the file', () => {
    const png = (chunks: string[]) => {
      const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      for (const c of chunks) out.push(0, 0, 0, 0, ...Array.from(c).map((ch) => ch.charCodeAt(0)), 0, 0, 0, 0);
      return new Uint8Array(out);
    };
    expect(isAnimatedPng(png(['IHDR', 'acTL', 'IDAT']))).toBe(true);
    expect(isAnimatedPng(png(['IHDR', 'IDAT', 'IEND']))).toBe(false);
    const riff = (tag: string) => new Uint8Array([...'RIFF', 0, 0, 0, 0, ...'WEBP', ...tag, 0, 0, 0, 0].map((x) => (typeof x === 'string' ? x.charCodeAt(0) : x)));
    expect(isLosslessWebp(riff('VP8L'))).toBe(true);
    expect(isLosslessWebp(riff('VP8 '))).toBe(false);
    const ns = (lo: number) => new Uint8Array([0x47, 0x49, 0x46, ...Array.from('NETSCAPE2.0').map((c) => c.charCodeAt(0)), 3, 1, lo, 0, 0]);
    expect(gifLoops(ns(0))).toBe(0);
    expect(gifLoops(ns(3))).toBe(3);
    expect(gifLoops(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });

  it('keeps a GIF frame’s exact colours and its see-through pixels', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255]);
    const f = gifFrame(rgba);
    expect(f.exact).toBe(true);
    expect(f.palette).toEqual([[255, 0, 0], [0, 255, 0], [0, 0, 0]]);
    expect(Array.from(f.index)).toEqual([0, 1, 2, 0]);
    expect(f.transparent).toBe(2);
    // More than 256 colours: the nearest 256.
    const many = new Uint8ClampedArray(300 * 4);
    for (let i = 0; i < 300; i++) many.set([i % 256, Math.floor(i / 256) * 100, 7, 255], i * 4);
    const g = gifFrame(many);
    expect(g.exact).toBe(false);
    expect(g.palette.length).toBeLessThanOrEqual(256);
    expect(g.index.length).toBe(300);
  });
});
