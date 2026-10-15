import { describe, expect, it } from 'vitest';
import { beatFilled, clockFrac, gifSegments, newClock, remainingWait, videoFrac } from './slidering';

describe('slide ring', () => {
  it('counts the time a slide has shown, over pauses', () => {
    const c = { ...newClock(), ms: 6000 };
    expect(clockFrac(c, 0)).toBe(0);
    c.since = 1000;
    expect(clockFrac(c, 4000)).toBeCloseTo(0.5);
    // paused at 4000: 3 s used
    c.used += 4000 - c.since;
    c.since = null;
    expect(clockFrac(c, 99999)).toBeCloseTo(0.5);
    expect(remainingWait(c)).toBe(3000);
    c.since = 10000;
    expect(clockFrac(c, 13000)).toBe(1);
    expect(clockFrac(c, 20000)).toBe(1);
  });

  it('never jumps on straight after a pause', () => {
    const c = { ...newClock(), ms: 6000, used: 5990 };
    expect(remainingWait(c)).toBe(400);
    expect(remainingWait({ ...newClock(), ms: 6000 })).toBe(6000);
  });

  it('follows a video to its end or its limit', () => {
    expect(videoFrac(5, 0, 10, 0)).toBeCloseTo(0.5);
    expect(videoFrac(25, 20, 100, 10)).toBeCloseTo(0.5);
    expect(videoFrac(95, 90, 100, 30)).toBeCloseTo(0.5); // the limit runs past the end
    expect(videoFrac(1, 0, NaN, 0)).toBeNull();
    expect(videoFrac(1, 0, 0, 0)).toBeNull();
  });

  it('shows GIF loops as segments when they all play', () => {
    expect(gifSegments({ gifLoops: 3, gifMaxSeconds: 20 }, 1000)).toBe(3);
    expect(gifSegments({ gifLoops: 3, gifMaxSeconds: 2 }, 1000)).toBe(1);
    expect(gifSegments({ gifLoops: 1, gifMaxSeconds: 20 }, 1000)).toBe(1);
    expect(gifSegments({ gifLoops: 12, gifMaxSeconds: 0 }, 1000)).toBe(1);
    expect(gifSegments({ gifLoops: 3, gifMaxSeconds: 20 }, 100)).toBe(1);
  });

  it('counts beats within every N', () => {
    expect(beatFilled(10, 10, 4)).toBe(0);
    expect(beatFilled(13, 10, 4)).toBe(3);
    expect(beatFilled(15, 10, 4)).toBe(1); // the wait for "at least" let it run over
    expect(beatFilled(12, 10, 1)).toBe(0);
  });
});
