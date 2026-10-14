import { describe, expect, it } from 'vitest';
import { clipBox, drawnRect, invert } from './flip';
import { clampSpeed, facesAt, kenBurnsPath, nearestFrame, pairKey, pickPair, resumeStart, resumeValue } from './viewerlogic';
import { frameTimes } from './previews';

describe('continue watching', () => {
  it('saves only for long videos, away from the start and the end', () => {
    expect(resumeValue(60, 100)).toBeNull(); // short video
    expect(resumeValue(751.2, 3600)).toBe(751200);
    expect(resumeValue(3, 3600)).toBeNull();
    expect(resumeValue(3500, 3600)).toBeNull(); // last 5%
    expect(resumeValue(290, 300)).toBeNull(); // last 20 s
  });
  it('starts where you left off unless that was the end', () => {
    expect(resumeStart(751200, 3600)).toBeCloseTo(751.2);
    expect(resumeStart(null, 3600)).toBe(0);
    expect(resumeStart(3590_000, 3600)).toBe(0);
    expect(resumeStart(50_000, 90)).toBe(0);
  });
});

describe('viewer geometry', () => {
  it('fits and fills like the canvas', () => {
    expect(drawnRect(1000, 500, 2000, 2000, 'contain')).toEqual({ left: 250, top: 0, width: 500, height: 500 });
    expect(drawnRect(1000, 500, 2000, 2000, 'cover')).toEqual({ left: 0, top: -250, width: 1000, height: 1000 });
    const z = drawnRect(1000, 500, 2000, 2000, 'contain', { s: 2, x: -100, y: -50 });
    expect(z).toEqual({ left: 400, top: -50, width: 1000, height: 1000 });
    expect(clipBox({ left: -10, top: -250, width: 1020, height: 1000 }, 1000, 500)).toEqual({ left: 0, top: 0, width: 1000, height: 500 });
  });
  it('inverts a rect onto another', () => {
    const t = invert({ left: 10, top: 20, width: 100, height: 100 }, { left: 0, top: 0, width: 1000, height: 1000 });
    expect(t.s).toBeCloseTo(0.1);
    expect(t.x).toBeCloseTo(10);
    expect(t.y).toBeCloseTo(20);
    // Laid out at (200, 100, 400×400), shown over a 40×40 tile at (10, 10).
    const u = invert({ left: 10, top: 10, width: 40, height: 40 }, { left: 200, top: 100, width: 400, height: 400 });
    expect(u.s).toBeCloseTo(0.1);
    // Top-left of the element after the transform: origin + translate.
    expect(200 + u.x).toBeCloseTo(10);
    expect(100 + u.y).toBeCloseTo(10);
  });
});

describe('seek previews', () => {
  it('finds the nearest clip frame', () => {
    const times = frameTimes(600);
    expect(nearestFrame(times[13], 600)).toBe(13);
    expect(nearestFrame(0, 600)).toBe(0);
    expect(nearestFrame(599, 600)).toBe(47);
  });
});

describe('faces over videos', () => {
  const f = (frameMs: number) => ({ id: frameMs, frameMs, x: 0, y: 0, w: 0.1, h: 0.1, person: null });
  it('shows faces near the current time only', () => {
    const list = [f(0), f(10_000), f(11_400), f(13_000)];
    expect(facesAt(list, false, 99)).toHaveLength(4);
    expect(facesAt(list, true, 10).map((x) => x.frameMs)).toEqual([10_000, 11_400]);
  });
});

describe('slow pan and zoom', () => {
  it('zooms between 1 and 1.12 with a small pan', () => {
    let n = 0;
    const seq = [0.25, 0.5, 0.1];
    const p = kenBurnsPath(() => seq[n++ % seq.length]);
    expect(p.from.s).toBe(1);
    expect(p.to.s).toBe(1.12);
    expect(Math.hypot(p.to.x, p.to.y)).toBeLessThanOrEqual(5);
  });
});

describe('duel pairs', () => {
  const list = [
    { id: 1, elo: 1000, duels: 0 },
    { id: 2, elo: 1010, duels: 0 },
    { id: 3, elo: 1400, duels: 9 },
    { id: 4, elo: 990, duels: 5 },
  ];
  it('never picks the same item twice or the last pair again', () => {
    for (let i = 0; i < 200; i++) {
      const p = pickPair(list, pairKey(1, 2));
      expect(p).not.toBeNull();
      const [a, b] = p!;
      expect(a.id).not.toBe(b.id);
      expect(pairKey(a.id, b.id)).not.toBe(pairKey(1, 2));
    }
  });
  it('prefers fresh items with similar ratings', () => {
    const p = pickPair(list, null, () => 0)!;
    expect(p.map((x) => x.id).sort()).toEqual([1, 2]);
    expect(pickPair(list.slice(0, 1), null)).toBeNull();
    expect(pickPair(list.slice(0, 2), pairKey(1, 2))).not.toBeNull();
  });
  it('keeps the speed round speed in range', () => {
    expect(clampSpeed(0.1)).toBe(0.5);
    expect(clampSpeed(9)).toBe(3);
    expect(clampSpeed(1.25)).toBe(1.25);
  });
});
