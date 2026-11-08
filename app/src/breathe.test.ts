import { describe, expect, it } from 'vitest';
import {
  breath, BREATH_MS, breatheBoxes, changeGap, DEFAULT_BREATHE, DUB_MS, frameCount, frameScale, heartbeat, normalizeBreathe,
  oldestFrame, playingVideos, BREATHE_LAYOUTS,
} from './breathe';
import { BeatCounter } from './beats';

describe('breathe', () => {
  it('breathes in and out smoothly between 0 and 1, once per breath', () => {
    let lo = 1;
    let hi = 0;
    let prev = breath(0);
    let maxStep = 0;
    for (let t = 0; t <= BREATH_MS * 2; t += 16) {
      const b = breath(t);
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
      maxStep = Math.max(maxStep, Math.abs(b - prev));
      prev = b;
    }
    expect(lo).toBe(0);
    expect(hi).toBe(1);
    expect(maxStep).toBeLessThan(0.03); // no jumps
    expect(breath(BREATH_MS * 0.44)).toBe(1); // a short hold at the top
    expect(breath(123)).toBeCloseTo(breath(123 + BREATH_MS), 6);
    // frames out of step
    expect(breath(1000, 0.23)).not.toBeCloseTo(breath(1000, 0), 2);
  });

  it('scales about 1.00 → 1.05 when just breathing', () => {
    let hi = 0;
    let lo = 2;
    for (let t = 0; t < BREATH_MS; t += 10) {
      const { scale } = frameScale(t, 0, [], false);
      hi = Math.max(hi, scale);
      lo = Math.min(lo, scale);
    }
    expect(lo).toBeCloseTo(1, 5);
    expect(hi).toBeCloseTo(1.05, 5);
  });

  it('beats lub-dub: a big pulse, then a smaller one, then nothing', () => {
    const at = (dt: number) => heartbeat(dt, 1);
    let lub = 0;
    for (let t = 0; t < 150; t++) lub = Math.max(lub, at(t));
    let dub = 0;
    for (let t = DUB_MS; t < DUB_MS + 120; t++) dub = Math.max(dub, at(t) - at(DUB_MS - 1) * Math.exp(-(t - DUB_MS + 1) / 110));
    expect(lub).toBeGreaterThan(0.055);
    expect(lub).toBeLessThan(0.07);
    expect(dub).toBeGreaterThan(0.02);
    expect(dub).toBeLessThan(lub);
    // between lub and dub it dips
    expect(at(DUB_MS - 5)).toBeLessThan(lub);
    expect(at(DUB_MS + 60)).toBeGreaterThan(at(DUB_MS - 5));
    expect(at(1500)).toBe(0);
    expect(at(-10)).toBe(0);
    // stronger beat = bigger
    expect(heartbeat(60, 1)).toBeGreaterThan(heartbeat(60, 0.3));
    expect(heartbeat(60, 0)).toBeGreaterThan(0);
  });

  it('adds the heartbeat to the breath, later frames a moment later', () => {
    const beats = [{ at: 1000, strength: 1 }];
    const calm = frameScale(1060, 0, beats, false).scale;
    const beat = frameScale(1060, 0, beats, true).scale;
    expect(beat - calm).toBeGreaterThan(0.04);
    expect(frameScale(1060, 0, beats, true).scale - frameScale(1060, 0, [], true).scale)
      .toBeGreaterThan(frameScale(1060, 3, beats, true).scale - frameScale(1060, 3, [], true).scale);
    // never wild, even with many beats piled up
    const many = Array.from({ length: 10 }, () => ({ at: 1000, strength: 1 }));
    expect(frameScale(1060, 0, many, true).scale).toBeLessThan(1.15);
  });

  it('moves on every 4 / 8 beats, not too soon', () => {
    const c = new BeatCounter(0);
    const hits: number[] = [];
    for (let i = 1; i <= 16; i++) if (c.beat(i * 500, 4, 1.6)) hits.push(i);
    expect(hits).toEqual([4, 8, 12, 16]);
    const c8 = new BeatCounter(0);
    const h8: number[] = [];
    for (let i = 1; i <= 16; i++) if (c8.beat(i * 500, 8, 1.6)) h8.push(i);
    expect(h8).toEqual([8, 16]);
  });

  it('lays out frames inside the stage with room between them', () => {
    for (const l of BREATHE_LAYOUTS) {
      const boxes = breatheBoxes(l.id, 1600, 900);
      expect(boxes.length).toBe(frameCount(l.id));
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        // room to breathe in and beat (about 9% bigger) without leaving the stage
        expect(b.x - b.w * 0.045).toBeGreaterThan(-1);
        expect(b.x + b.w * 1.045).toBeLessThan(1601);
        expect(b.y - b.h * 0.045).toBeGreaterThan(-1);
        expect(b.y + b.h * 1.045).toBeLessThan(901);
      }
      for (let i = 1; i < boxes.length; i++) {
        const a = boxes[i - 1];
        const b = boxes[i];
        const apart = Math.max(b.x - (a.x + a.w), b.y - (a.y + a.h));
        // neighbours at the top of a beat still don't touch
        expect(apart).toBeGreaterThan(Math.max(a.w + b.w, 0) * 0.045 * (b.x > a.x + a.w ? 1 : 0) + (b.y > a.y + a.h ? (a.h + b.h) * 0.045 : 0));
      }
    }
    const tall = breatheBoxes('tall', 1600, 900);
    for (const b of tall) expect(b.h / b.w).toBeCloseTo(16 / 9, 5);
    expect(breatheBoxes('one', 0, 0)).toEqual([]);
  });

  it('changes the oldest frame, frames take turns', () => {
    expect(oldestFrame([5, 2, 9])).toBe(1);
    expect(changeGap(8, 4)).toBe(2000);
    expect(changeGap(8, 1)).toBe(8000);
  });

  it('plays at most 4 videos', () => {
    expect([...playingVideos(['video', 'image', 'video', 'video', 'video', 'video'])]).toEqual([0, 2, 3, 4]);
  });

  it('reads saved settings safely', () => {
    expect(normalizeBreathe(null)).toEqual(DEFAULT_BREATHE);
    expect(normalizeBreathe({ layout: 'tall', speed: 'fast', heart: true, beatEvery: 8, sound: true }))
      .toEqual({ layout: 'tall', speed: 'fast', heart: true, beatEvery: 8, sound: true });
    expect(normalizeBreathe({ layout: 'nope', beatEvery: 3 })).toEqual(DEFAULT_BREATHE);
    expect(normalizeBreathe({ beatEvery: 0 }).beatEvery).toBe(0);
  });
});
