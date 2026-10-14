import { describe, expect, it } from 'vitest';
import { BeatCounter, beatStatusText } from './beats';

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

describe('beat sync status line', () => {
  const base = { state: 'listening' as const, device: 'Speakers (Realtek(R) Audio)', format: '48 kHz · stereo · 32-bit float', error: null, receiving: true, volume: 0.5, muted: false, log: [] };

  it('names the output it listens to', () => {
    expect(beatStatusText({ listening: true, error: null, status: base })).toEqual({ text: 'Listening to: Speakers (Realtek(R) Audio)', problem: false });
    expect(beatStatusText({ listening: true, error: null, status: { ...base, receiving: false } }).text).toMatch(/nothing is playing/);
  });

  it('says plainly why it hears nothing', () => {
    const err = beatStatusText({ listening: true, error: null, status: { ...base, state: 'error', error: "Couldn't open the sound output: No speakers or headphones are set as the default output (0x80070490)" } });
    expect(err.problem).toBe(true);
    expect(err.text).toMatch(/^Couldn't open the sound output/);
    expect(beatStatusText({ listening: true, error: null, status: { ...base, muted: true } }).text).toMatch(/muted in Windows/);
    expect(beatStatusText({ listening: false, error: "Listening to the computer's sound only works on Windows.", status: null }).problem).toBe(true);
    expect(beatStatusText({ listening: false, error: null, status: null }).text).toBe('Starting to listen…');
  });
});
