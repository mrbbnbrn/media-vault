import { describe, expect, it } from 'vitest';
import { DROP_COOLDOWN_MS, DropDetector, MontagePacer, montageEvery } from './beatdrop';
import { BeatCounter } from './beats';
import { RAMP_FAST, RAMP_BACK_MS, RAMP_HOLD_MS, RAMP_PERIOD_MS, RAMP_SLOW, SpeedRamp, waveRate } from './speedramp';

/** Fake music: beats every `ms` with the given strength, level readings every 100 ms. */
function play(d: { level(now: number, l: number): void }, onBeat: (t: number) => void, from: number, to: number, level: number, ms = 500) {
  for (let t = from; t < to; t += 100) {
    d.level(t, level);
    if ((t - from) % ms === 0 && t > from) onBeat(t);
  }
}

describe('DropDetector', () => {
  it('finds the drop after a calm part, once', () => {
    const d = new DropDetector();
    const drops: number[] = [];
    play(d, (t) => d.beat(t, 0.4) && drops.push(t), 0, 6000, 0.2);
    expect(drops).toEqual([]);
    // The drop: a big beat and much louder.
    d.level(6000, 0.85);
    if (d.beat(6000, 1)) drops.push(6000);
    play(d, (t) => d.beat(t, 0.85) && drops.push(t), 6000, 9000, 0.85);
    expect(drops).toEqual([6000]);
  });

  it('ignores steady loud music with strong beats', () => {
    const d = new DropDetector();
    const drops: number[] = [];
    play(d, (t) => d.beat(t, 0.9) && drops.push(t), 0, 20000, 0.8);
    expect(drops).toEqual([]);
  });

  it('ignores a strong beat without a jump in loudness', () => {
    const d = new DropDetector();
    play(d, (t) => d.beat(t, 0.3), 0, 5000, 0.4);
    d.level(5000, 0.42);
    expect(d.beat(5000, 0.9)).toBe(false);
  });

  it('waits before another drop', () => {
    const d = new DropDetector();
    play(d, (t) => d.beat(t, 0.3), 0, 5000, 0.2);
    d.level(5000, 0.9);
    expect(d.beat(5000, 1)).toBe(true);
    // Quiet again briefly, then another hit too soon.
    d.level(5200, 0.2);
    d.level(5400, 0.95);
    expect(d.beat(5400, 1)).toBe(false);
    expect(DROP_COOLDOWN_MS).toBeGreaterThan(400);
  });

  it('needs a few beats first', () => {
    const d = new DropDetector();
    d.level(0, 0.1);
    d.level(100, 0.9);
    expect(d.beat(100, 1)).toBe(false);
  });
});

describe('BeatCounter with a drop', () => {
  it('knows the time since the last change', () => {
    const c = new BeatCounter(1000);
    expect(c.since(1300)).toBe(300);
    c.reset(1300);
    expect(c.since(1400)).toBe(100);
  });
});

describe('Montage', () => {
  it('picks quick cuts for busy music and long holds for calm music', () => {
    expect(montageEvery(0.9, 1)).toBe(1);
    expect(montageEvery(0.5, 2)).toBe(2);
    expect(montageEvery(0.3, 4)).toBe(4);
    expect(montageEvery(0.1, 8)).toBe(8);
  });

  it('does not flip back and forth around an edge', () => {
    expect(montageEvery(0.6, 2)).toBe(2); // just under the 1-beat edge (0.62)
    expect(montageEvery(0.64, 2)).toBe(2); // not yet clearly past it
    expect(montageEvery(0.7, 2)).toBe(1);
    expect(montageEvery(0.6, 1)).toBe(1); // stays on 1 until clearly below
    expect(montageEvery(0.55, 1)).toBe(2);
  });

  const run = (level: number, strength: number, gap: number) => {
    const m = new MontagePacer();
    let every = m.every();
    let beatAt = 0;
    for (let t = 0; t < 12000; t += 50) {
      if (t % 100 === 0) m.levelAt(t, level);
      if (t - beatAt >= gap) {
        beatAt = t;
        every = m.beat(t, strength);
      }
    }
    return every;
  };

  it('loud, strong, steady beats: every beat', () => {
    expect(run(0.85, 0.9, 500)).toBe(1);
  });
  it('medium music: every 2 beats', () => {
    expect(run(0.45, 0.5, 500)).toBe(2);
  });
  it('quiet, weak beats: 4 to 8 beats', () => {
    expect([4, 8]).toContain(run(0.15, 0.3, 500));
    expect(run(0.02, 0.1, 700)).toBe(8);
  });
});

describe('Speed ramp', () => {
  it('waves between slow-mo and fast', () => {
    expect(waveRate(0)).toBeCloseTo(RAMP_SLOW);
    expect(waveRate(RAMP_PERIOD_MS / 2)).toBeCloseTo(RAMP_FAST);
    expect(waveRate(RAMP_PERIOD_MS)).toBeCloseTo(RAMP_SLOW);
  });

  it('changes smoothly from frame to frame', () => {
    const r = new SpeedRamp(0);
    let last = r.rate(0);
    for (let t = 16; t < 10000; t += 16) {
      const now = r.rate(t);
      expect(Math.abs(now - last)).toBeLessThan(0.05);
      last = now;
    }
  });

  it('drops to slow-mo on a strong beat and ramps back up', () => {
    const r = new SpeedRamp(0);
    for (let i = 1; i <= 4; i++) r.hit(i * 500, 0.4);
    const at = RAMP_PERIOD_MS / 2; // fastest point of the wave
    expect(r.target(at - 1)).toBeGreaterThan(1.7);
    expect(r.hit(at, 0.95)).toBe(true);
    expect(r.target(at + 100)).toBeCloseTo(RAMP_SLOW);
    expect(r.target(at + RAMP_HOLD_MS)).toBeCloseTo(RAMP_SLOW);
    expect(r.target(at + 1000)).toBeGreaterThan(RAMP_SLOW);
    // Back in the wave, at its fast end.
    expect(r.target(at + RAMP_HOLD_MS + RAMP_BACK_MS)).toBeGreaterThan(1.7);
  });

  it('ignores ordinary beats and hits too close together', () => {
    const r = new SpeedRamp(0);
    for (let i = 1; i <= 6; i++) expect(r.hit(i * 500, 0.8)).toBe(false);
    expect(r.hit(3500, 0.5, true)).toBe(true);
    expect(r.hit(3800, 1, true)).toBe(false);
  });

  it('follows the user speed', () => {
    const r = new SpeedRamp(0, 2);
    expect(r.target(0)).toBeCloseTo(RAMP_SLOW * 2);
  });
});
