import { describe, expect, it } from 'vitest';
import {
  alignFace, alignedCss, applyAligned, coverFit, COVER_FACE_SHARE, faceTarget, mainFace, MAX_TURN, maxScaleFor, NO_ALIGN, zoomAbout,
} from './facealign';

const close = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d);

describe('round covers', () => {
  it('centres a square picture without a face', () => {
    expect(coverFit(1)).toEqual({ w: 1, h: 1, left: 0, top: 0 });
  });

  it('covers the circle like object-fit: cover without a face', () => {
    const wide = coverFit(2);
    expect(wide.h).toBe(1);
    expect(wide.w).toBe(2);
    expect(wide.left).toBe(-0.5);
    const tall = coverFit(0.5);
    expect(tall.w).toBe(1);
    expect(tall.h).toBe(2);
    expect(tall.top).toBe(-0.5);
  });

  it('puts the face in the middle at about half the circle', () => {
    // A small face right of centre in a landscape photo.
    const face = { x: 0.6, y: 0.3, w: 0.1, h: 0.15 };
    const f = coverFit(1.5, face);
    const cx = f.left + (face.x + face.w / 2) * f.w;
    const cy = f.top + (face.y + face.h / 2) * f.h;
    close(cx, 0.5);
    close(cy, 0.5);
    close(Math.max(face.w * f.w, face.h * f.h), COVER_FACE_SHARE);
  });

  it('never leaves part of the circle empty', () => {
    // A big face near the edge: the picture stays covering the square.
    const f = coverFit(1, { x: 0, y: 0, w: 0.9, h: 0.9 });
    expect(f.w).toBeGreaterThanOrEqual(1);
    expect(f.left).toBeLessThanOrEqual(0);
    expect(f.left + f.w).toBeGreaterThanOrEqual(1);
    expect(f.top + f.h).toBeGreaterThanOrEqual(1);
    // A face in the corner can't be centred, but the edge stays covered.
    const g = coverFit(1, { x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
    close(g.left + g.w, 1);
    close(g.top + g.h, 1);
  });

  it('copes with nonsense', () => {
    expect(coverFit(NaN)).toEqual({ w: 1, h: 1, left: 0, top: 0 });
    expect(coverFit(1, { x: 0.5, y: 0.5, w: 0, h: 0 })).toEqual({ w: 1, h: 1, left: 0, top: 0 });
  });
});

describe('line up faces', () => {
  const drawn = { left: 100, top: 0, width: 800, height: 600 };
  const target = faceTarget(1000, 600);

  it('moves the face centre onto the target at the target size', () => {
    const face = { x: 0.2, y: 0.5, w: 0.1, h: 0.1 };
    const a = alignFace(drawn, face, target);
    const c = applyAligned(a, drawn.left + 0.25 * 800, 0.55 * 600);
    close(c.x, target.x);
    close(c.y, target.y);
    const size = Math.sqrt(0.1 * 800 * 0.1 * 600) * a.s;
    close(size, target.size);
    expect(a.rot).toBe(0);
  });

  it('two pictures put their faces in the same place', () => {
    const f1 = { x: 0.1, y: 0.1, w: 0.2, h: 0.3 };
    const f2 = { x: 0.7, y: 0.6, w: 0.05, h: 0.07 };
    const d2 = { left: 0, top: 50, width: 1000, height: 500 };
    const a1 = alignFace(drawn, f1, target, { maxScale: 50 });
    const a2 = alignFace(d2, f2, target, { maxScale: 50 });
    const p1 = applyAligned(a1, drawn.left + 0.2 * 800, drawn.top + 0.25 * 600);
    const p2 = applyAligned(a2, d2.left + 0.725 * 1000, d2.top + 0.635 * 500);
    close(p1.x, p2.x);
    close(p1.y, p2.y);
  });

  it('limits the scale so tiny faces stay sharp', () => {
    const a = alignFace(drawn, { x: 0.5, y: 0.5, w: 0.01, h: 0.01 }, target, { maxScale: 3 });
    expect(a.s).toBe(3);
    // The face still lands on the target, just smaller.
    const c = applyAligned(a, drawn.left + 0.505 * 800, 0.505 * 600);
    close(c.x, target.x);
    close(c.y, target.y);
  });

  it('levels the eye line, at most about 20°', () => {
    const face = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    // Right eye lower than the left one: tilted clockwise in screen terms.
    const eyes = { lx: 0.45, ly: 0.45, rx: 0.55, ry: 0.47 };
    const a = alignFace(drawn, face, target, { eyes });
    const l = applyAligned(a, drawn.left + eyes.lx * 800, eyes.ly * 600);
    const r = applyAligned(a, drawn.left + eyes.rx * 800, eyes.ry * 600);
    close(l.y, r.y, 1e-6);
    const steep = alignFace(drawn, face, target, { eyes: { lx: 0.4, ly: 0.4, rx: 0.5, ry: 0.6 } });
    expect(Math.abs(steep.rot)).toBeCloseTo(MAX_TURN);
    // The face centre still lands on the target when turned.
    const c = applyAligned(steep, drawn.left + 0.5 * 800, 0.5 * 600);
    close(c.x, target.x);
    close(c.y, target.y);
  });

  it('does nothing without a usable face or picture', () => {
    expect(alignFace({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0, w: 0.1, h: 0.1 }, target)).toEqual(NO_ALIGN);
    expect(alignFace(drawn, { x: 0, y: 0, w: 0, h: 0.1 }, target)).toEqual(NO_ALIGN);
  });

  it('zooms gently around the target without moving it', () => {
    const a = alignFace(drawn, { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, target);
    const z = zoomAbout(a, target.x, target.y, 1.06);
    const c = applyAligned(z, drawn.left + 0.25 * 800, 0.25 * 600);
    close(c.x, target.x);
    close(c.y, target.y);
    close(z.s, a.s * 1.06);
  });

  it('writes a CSS transform', () => {
    expect(alignedCss({ tx: 1, ty: 2, s: 1.5, rot: 0 })).toBe('translate(1.00px, 2.00px) rotate(0.0000rad) scale(1.5000)');
  });

  it("picks the person's face, else the biggest", () => {
    const faces = [
      { x: 0, y: 0, w: 0.3, h: 0.3, person: 7 },
      { x: 0.5, y: 0, w: 0.1, h: 0.1, person: 9 },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.2, person: null },
    ];
    expect(mainFace(faces, 9)).toBe(faces[1]);
    expect(mainFace(faces)).toBe(faces[0]);
    expect(mainFace(faces, 3)).toBe(faces[0]); // not in this picture: the biggest
    expect(mainFace([])).toBeNull();
  });

  it('allows enlarging up to 2.5× of the picture’s own pixels', () => {
    expect(maxScaleFor(4000, 800)).toBe(12.5);
    expect(maxScaleFor(400, 800)).toBe(1.25);
    expect(maxScaleFor(100, 800)).toBe(1);
    expect(maxScaleFor(0, 800)).toBe(1);
  });
});
