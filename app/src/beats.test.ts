import { describe, expect, it } from 'vitest';
import { BeatCounter } from './beats';

/** Beats every `ms` from `from`; returns the times the counter advanced. */
function run(c: BeatCounter, beats: number, ms: number, every: number, minSeconds: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = 1; i <= beats; i++) {
    const t = from + i * ms;
    if (c.beat(t, every, minSeconds)) out.push(t);
  }
  return out;
}

describe('BeatCounter', () => {
  it('advances on every beat when allowed', () => {
    expect(run(new BeatCounter(0), 4, 500, 1, 0)).toEqual([500, 1000, 1500, 2000]);
  });

  it('advances on every 4th beat', () => {
    expect(run(new BeatCounter(0), 12, 500, 4, 0)).toEqual([2000, 4000, 6000]);
  });

  it('waits the minimum time, then takes the next whole group of beats', () => {
    // 120 BPM, every 2nd beat, at least 1.5 s: beat 2 (1 s) is too soon,
    // beat 4 (2 s) goes; then 3 s too soon, 4 s goes.
    expect(run(new BeatCounter(0), 8, 500, 2, 1.5)).toEqual([2000, 4000]);
  });

  it('starts over after reset', () => {
    const c = new BeatCounter(0);
    c.beat(500, 2, 0);
    c.reset(600);
    expect(c.beat(1000, 2, 0)).toBe(false);
    expect(c.beat(1500, 2, 0)).toBe(true);
  });
});
