import { describe, expect, it } from 'vitest';
import {
  clock, difference, exposureOf, exposureScore, faceScore, frameName, frameNames, laplacianVariance, pickBest, sampleTimes, scoreSamples, signature, SIG,
  toGray, wanted, type Sample,
} from './bestframes';

const W = 64;
const H = 48;
/** A grey picture from a function of (x, y). */
const pic = (f: (x: number, y: number) => number) => {
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = f(x, y);
  return g;
};
const checker = (n: number, lo = 40, hi = 210) => pic((x, y) => ((Math.floor(x / n) + Math.floor(y / n)) % 2 ? hi : lo));
/** A box blur, n passes. */
const blur = (g: Float32Array, n: number) => {
  let a = g;
  for (let k = 0; k < n; k++) {
    const b = new Float32Array(a.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H) {
              s += a[yy * W + xx];
              c++;
            }
          }
        }
        b[y * W + x] = s / c;
      }
    }
    a = b;
  }
  return a;
};

describe('where to look', () => {
  it('about every second for short videos, skipping the very ends', () => {
    const t = sampleTimes(30);
    expect(t[0]).toBeGreaterThan(0);
    expect(t[t.length - 1]).toBeLessThan(30);
    expect(t.length).toBeGreaterThanOrEqual(28);
    expect(t.length).toBeLessThanOrEqual(31);
    expect(t[1] - t[0]).toBeCloseTo(1, 5);
  });
  it('at most the cap for long videos, spread over all of it', () => {
    const t = sampleTimes(3 * 3600);
    expect(t.length).toBeLessThanOrEqual(241);
    expect(t[t.length - 1]).toBeGreaterThan(3 * 3600 * 0.98);
  });
  it('a 1.5 s step for medium videos', () => {
    const t = sampleTimes(200);
    expect(t[1] - t[0]).toBeCloseTo(1.5, 5);
  });
  it('tiny and empty videos', () => {
    expect(sampleTimes(0)).toEqual([]);
    expect(sampleTimes(NaN)).toEqual([]);
    expect(sampleTimes(0.8)).toEqual([0.4]);
  });
  it('how many to offer', () => {
    expect(wanted(20)).toBe(6);
    expect(wanted(90)).toBe(9);
    expect(wanted(3600)).toBe(12);
  });
});

describe('scoring', () => {
  it('grey from RGBA', () => {
    const g = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), 3, 1);
    expect(g[0]).toBeCloseTo(255, 3);
    expect(g[1]).toBe(0);
    expect(g[2]).toBeCloseTo(76.245, 2);
  });
  it('sharp beats blurred, flat is zero', () => {
    const sharp = checker(4);
    const soft = blur(sharp, 3);
    expect(laplacianVariance(sharp, W, H)).toBeGreaterThan(laplacianVariance(soft, W, H) * 5);
    expect(laplacianVariance(pic(() => 120), W, H)).toBe(0);
    expect(laplacianVariance(new Float32Array(4), 2, 2)).toBe(0);
  });
  it('well lit beats black, white and flat', () => {
    const good = exposureScore(exposureOf(checker(4, 60, 190)));
    expect(good).toBeGreaterThan(0.7);
    expect(exposureScore(exposureOf(pic(() => 3)))).toBeLessThan(0.15);
    expect(exposureScore(exposureOf(pic(() => 252)))).toBeLessThan(0.15);
    expect(exposureScore(exposureOf(pic(() => 120)))).toBeLessThan(0.15);
    expect(exposureScore(exposureOf(checker(4, 0, 255)))).toBeLessThan(good);
  });
  it('faces near the moment count, bigger ones more', () => {
    const faces = [{ frameMs: 10_000, w: 0.1, h: 0.1 }, { frameMs: 30_000, w: 0.4, h: 0.4 }];
    expect(faceScore(faces, 20)).toBe(0);
    expect(faceScore(faces, 10.5)).toBeGreaterThan(0);
    expect(faceScore(faces, 30)).toBeGreaterThan(faceScore(faces, 10));
    expect(faceScore(faces, 30)).toBeLessThanOrEqual(1);
  });
});

describe('telling frames apart', () => {
  it('the same scene a little brighter is the same; another scene is different', () => {
    const a = signature(checker(8), W, H);
    const brighter = signature(pic((x, y) => ((Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 230 : 70)), W, H);
    const other = signature(pic((x) => (x / W) * 255), W, H);
    expect(a.length).toBe(SIG * SIG);
    expect(difference(a, brighter)).toBeLessThan(0.05);
    expect(difference(a, other)).toBeGreaterThan(0.5);
  });
});

describe('picking', () => {
  const sigA = signature(checker(8), W, H);
  const sigB = signature(pic((x) => (x / W) * 255), W, H);
  const sigC = signature(pic((_, y) => (y / H) * 255), W, H);
  const sigD = signature(pic((x, y) => Math.abs(Math.sin(x / 5) * Math.cos(y / 7)) * 255), W, H);
  const s = (t: number, sharp: number, sig: Float32Array, exposure = 0.8, face = 0): Sample => ({ t, sharp, exposure, face, sig });

  it('best first, no near duplicates, in time order', () => {
    const samples = [
      s(1, 900, sigA, 0.7), s(2, 1000, sigA, 0.9), s(3, 10, sigB), s(10, 800, sigB), s(20, 700, sigC), s(30, 750, sigD), s(31, 760, sigD),
    ];
    const best = pickBest(scoreSamples(samples, false), 4);
    expect(best.map((b) => b.t)).toEqual([2, 10, 20, 31]);
  });
  it('keeps a gap in time even for different-looking frames', () => {
    const samples = [s(5, 1000, sigA), s(5.5, 990, sigB), s(9, 500, sigC)];
    expect(pickBest(scoreSamples(samples, false), 3).map((b) => b.t)).toEqual([5, 9]);
  });
  it('dark frames never win', () => {
    const samples = [s(1, 5000, sigA, 0.05), s(8, 300, sigB, 0.8), s(16, 200, sigC, 0.8)];
    const scored = scoreSamples(samples, false);
    expect(scored[0].score).toBeLessThan(scored[1].score);
  });
  it('faces tip the balance when known', () => {
    const samples = [s(1, 500, sigA, 0.7, 0), s(10, 480, sigB, 0.7, 1)];
    const scored = scoreSamples(samples, true);
    expect(scored[1].score).toBeGreaterThan(scored[0].score);
    expect(pickBest(scored, 1)[0].t).toBe(10);
  });
  it('not padded out with blurred frames', () => {
    const samples = [s(2, 2000, sigA), s(9, 1800, sigB), s(16, 15, sigC), s(24, 12, sigD)];
    expect(pickBest(scoreSamples(samples, false), 4).map((b) => b.t)).toEqual([2, 9]);
  });
  it('fewer than asked when the video is all one scene', () => {
    const samples = Array.from({ length: 20 }, (_, i) => s(i * 2, 500 + i, sigA));
    expect(pickBest(scoreSamples(samples, false), 8)).toHaveLength(1);
  });
  it('nothing in, nothing out', () => {
    expect(scoreSamples([], false)).toEqual([]);
    expect(pickBest([], 5)).toEqual([]);
  });
});

describe('names', () => {
  it('the time shown matches the name', () => {
    expect(clock(83.9)).toBe('1:23');
    expect(clock(3723)).toBe('1:02:03');
  });
  it('video name, a dot and the time', () => {
    expect(frameName('Holiday.mp4', 83.4)).toBe('Holiday · 01m23s.jpg');
    expect(frameName('a.b.webm', 5)).toBe('a.b · 00m05s.jpg');
    expect(frameName('Long.mkv', 3723)).toBe('Long · 1h02m03s.jpg');
    expect(frameName('.mp4', 1)).toBe('Frame · 00m01s.jpg');
  });
  it('unique when two land in the same second', () => {
    expect(frameNames('v.mp4', [1.2, 1.7, 3])).toEqual(['v · 00m01s.jpg', 'v · 00m01s (2).jpg', 'v · 00m03s.jpg']);
  });
});
