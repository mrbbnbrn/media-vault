import { describe, expect, it } from 'vitest';
import {
  alignEyes, applySim, bigEnough, byMonth, countLabel, eyeTargets, framePoints, grow, lapseAt, lapseLength, lerpPts, MESH, meshPoints, morphMs,
  pointsFromBox, similarityFrom, sliderMax, slotMs, tileCrop, triAffine, triArea, videoFps, videoFrameTimes, type FivePoints, type Pt,
} from './facecrops';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('smallest face', () => {
  const faces = [{ height: 1000, facePx: 50 }, { height: 1000, facePx: 300 }, { height: 0, facePx: 0 }, { height: 2000, facePx: 120 }];
  it('keeps faces at least that tall, and those of pictures of unknown size', () => {
    expect(bigEnough(faces, 100).map((f) => f.facePx)).toEqual([300, 0, 120]);
    expect(bigEnough(faces, 0)).toHaveLength(4);
    expect(bigEnough(faces, 1000)).toHaveLength(1);
  });
  it('says how many', () => {
    expect(countLabel(312, 1040)).toBe('312 of 1,040 faces');
    expect(countLabel(5, 5)).toBe('5 faces');
    expect(countLabel(1, 1)).toBe('1 face');
    expect(sliderMax([{ facePx: 1234 }])).toBe(1240);
    expect(sliderMax([])).toBe(100);
  });
});

describe('the wall', () => {
  it('groups faces by month in order', () => {
    const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime() / 1000;
    const g = byMonth([{ date: at(2023, 2, 1) }, { date: at(2023, 2, 30) }, { date: at(2023, 3, 2) }, { date: at(2024, 2, 1) }]);
    expect(g.map((x) => [x.label, x.faces.length])).toEqual([['March 2023', 2], ['April 2023', 1], ['March 2024', 1]]);
  });
  it('centres the face in its tile, never leaving an empty edge', () => {
    const face = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const c = tileCrop(face, 1000, 1000, 100, 0.5);
    // The face (200 px) takes half the tile: the picture is drawn at 250 px.
    close(c.w, 250);
    close(c.left + 0.5 * c.w, 50);
    close(c.top + 0.5 * c.h, 50);
    // A face at the picture's corner: the picture still covers the tile.
    const k = tileCrop({ x: 0, y: 0, w: 0.1, h: 0.1 }, 1000, 500, 100);
    expect(k.left).toBe(0);
    expect(k.top).toBe(0);
    expect(k.w).toBeGreaterThanOrEqual(100);
    expect(k.h).toBeGreaterThanOrEqual(100);
    // A big face in a small picture: never smaller than the tile.
    const b = tileCrop({ x: 0, y: 0, w: 1, h: 1 }, 50, 80, 100);
    expect(Math.min(b.w, b.h)).toBeGreaterThanOrEqual(100 - 1e-9);
  });
});

describe('lining up by the eyes', () => {
  it('maps two points exactly, turning and scaling evenly', () => {
    const m = similarityFrom([10, 10], [30, 10], [100, 100], [100, 140])!;
    const a = applySim(m, [10, 10]);
    const b = applySim(m, [30, 10]);
    close(a[0], 100); close(a[1], 100);
    close(b[0], 100); close(b[1], 140);
    // A quarter turn and twice the size: a point below the first goes to its left.
    const c = applySim(m, [10, 20]);
    close(c[0], 80); close(c[1], 100);
    expect(similarityFrom([1, 1], [1, 1], [0, 0], [1, 0])).toBeNull();
  });
  it('puts every face\'s eyes at the same place in the frame', () => {
    const size = 512;
    const [tl, tr] = eyeTargets(size);
    const tilted: FivePoints = [[0.2, 0.3], [0.3, 0.35], [0.26, 0.4], [0.22, 0.45], [0.28, 0.48]];
    for (const [pts, pw, ph] of [[tilted, 4000, 3000], [pointsFromBox({ x: 0.5, y: 0.1, w: 0.1, h: 0.2 }), 640, 480]] as const) {
      const m = alignEyes(pts as FivePoints, pw, ph, size);
      const f = framePoints(pts as FivePoints, pw, ph, m);
      close(f[0][0], tl[0], 1e-6); close(f[0][1], tl[1], 1e-6);
      close(f[1][0], tr[0], 1e-6); close(f[1][1], tr[1], 1e-6);
    }
  });
  it('guesses points inside the box, eyes level', () => {
    const p = pointsFromBox({ x: 0.1, y: 0.2, w: 0.4, h: 0.4 });
    for (const [x, y] of p) {
      expect(x).toBeGreaterThan(0.1); expect(x).toBeLessThan(0.5);
      expect(y).toBeGreaterThan(0.2); expect(y).toBeLessThan(0.6);
    }
    expect(p[0][1]).toBe(p[1][1]);
    expect(p[0][0]).toBeLessThan(p[1][0]);
  });
});

describe('the morph mesh', () => {
  const S = 512;
  const canon: FivePoints = [[0.37 * S, 0.4 * S], [0.63 * S, 0.4 * S], [0.5 * S, 0.55 * S], [0.4 * S, 0.7 * S], [0.6 * S, 0.7 * S]];
  const tri = (pts: Pt[], t: readonly number[]) => [pts[t[0]], pts[t[1]], pts[t[2]]] as [Pt, Pt, Pt];
  it('covers the whole frame once, every triangle the same way round', () => {
    const pts = meshPoints(canon, S);
    const areas = MESH.map((t) => triArea(...tri(pts, t)));
    expect(areas.every((a) => a > 0)).toBe(true);
    close(areas.reduce((a, b) => a + b, 0), S * S, 1e-6);
    // Every point is used, and only valid ones.
    expect(new Set(MESH.flat())).toEqual(new Set(pts.map((_, i) => i)));
  });
  it('moves only the face points, half way at the middle', () => {
    const other: FivePoints = canon.map(([x, y]) => [x + 10, y - 6]) as FivePoints;
    const a = meshPoints(canon, S);
    const b = meshPoints(other, S);
    const m = lerpPts(a, b, 0.5);
    for (let i = 0; i < 8; i++) expect(m[i]).toEqual(a[i]);
    close(m[8][0], canon[0][0] + 5); close(m[8][1], canon[0][1] - 3);
    expect(lerpPts(a, b, 0)).toEqual(a);
    expect(lerpPts(a, b, 1)).toEqual(b);
  });
  it('maps each triangle onto another exactly', () => {
    const src: [Pt, Pt, Pt] = [[0, 0], [10, 0], [0, 10]];
    const dst: [Pt, Pt, Pt] = [[5, 5], [5, 25], [-5, 5]];
    const [a, b, c, d, e, f] = triAffine(src, dst)!;
    src.forEach(([x, y], i) => {
      close(a * x + c * y + e, dst[i][0]);
      close(b * x + d * y + f, dst[i][1]);
    });
    expect(triAffine([[0, 0], [1, 1], [2, 2]], dst)).toBeNull();
  });
  it('grows triangles a little outwards', () => {
    const t: [Pt, Pt, Pt] = [[0, 0], [30, 0], [0, 30]];
    expect(triArea(...grow(t, 1))).toBeGreaterThan(triArea(...t));
  });
});

describe('time-lapse timing', () => {
  it('shows each face for one slot; cuts never mix', () => {
    const t = { fps: 10, morph: false, morphShare: 0.5 };
    expect(slotMs(10)).toBe(100);
    expect(lapseAt(0, 5, t)).toEqual({ index: 0, mix: 0 });
    expect(lapseAt(99, 5, t)).toEqual({ index: 0, mix: 0 });
    expect(lapseAt(100, 5, t)).toEqual({ index: 1, mix: 0 });
    expect(lapseAt(10_000, 5, t)).toEqual({ index: 4, mix: 0 });
    expect(lapseAt(50, 0, t)).toEqual({ index: 0, mix: 0 });
    expect(morphMs(t)).toBe(0);
    expect(lapseLength(5, 10)).toBe(500);
  });
  it('holds, then morphs into the next face over its share of the slot', () => {
    const t = { fps: 4, morph: true, morphShare: 0.4 }; // 250 ms each: 150 hold, 100 morph
    close(morphMs(t), 100);
    expect(lapseAt(100, 3, t)).toEqual({ index: 0, mix: 0 });
    close(lapseAt(200, 3, t).mix, 0.5);
    expect(lapseAt(200, 3, t).index).toBe(0);
    close(lapseAt(249.9, 3, t).mix, 0.999, 1e-3);
    expect(lapseAt(260, 3, t)).toEqual({ index: 1, mix: 0 });
    // The last face only holds.
    expect(lapseAt(740, 3, t)).toEqual({ index: 2, mix: 0 });
    // Morph share is kept sensible.
    close(morphMs({ fps: 4, morph: true, morphShare: 5 }), 225);
  });
  it('saves one video frame per face for cuts and smooth frames for morphs', () => {
    expect(videoFps({ fps: 12, morph: false, morphShare: 0.5 })).toBe(12);
    expect(videoFrameTimes(4, { fps: 12, morph: false, morphShare: 0.5 })).toHaveLength(4);
    expect(videoFps({ fps: 5, morph: true, morphShare: 0.5 })).toBe(30);
    // 3 faces at 5 a second = 600 ms at 30 frames a second = 18 frames.
    expect(videoFrameTimes(3, { fps: 5, morph: true, morphShare: 0.5 })).toHaveLength(18);
    expect(videoFrameTimes(0, { fps: 5, morph: true, morphShare: 0.5 })).toEqual([]);
  });
});
