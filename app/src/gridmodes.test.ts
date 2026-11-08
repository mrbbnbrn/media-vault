import { describe, expect, it } from 'vitest';
import { approach, lensShares, normalizeBreathing, trackAt, wanderAt } from './breathing';
import { normalizePulse, swapOnWave, tileToSwap, waveDelays, waveLook } from './pulse';
import {
  chooseVideos, laneGap, LAYERS, normalizeParallax, placeOf, seed, step, type Drifter, type Screen, type Source,
} from './parallax';
import { normalizeGridModes } from './gridmodes';

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('breathing grid', () => {
  it('shares always fill the screen and the track under the lens is biggest', () => {
    for (const n of [3, 4, 5]) {
      for (const at of [0, 0.13, 0.45, 0.77, 1]) {
        const s = lensShares(n, at, 2.6);
        expect(s).toHaveLength(n);
        expect(sum(s)).toBeCloseTo(1, 9);
        const big = s.indexOf(Math.max(...s));
        expect(big).toBe(Math.min(n - 1, Math.floor(at * n)));
        for (const x of s) expect(x).toBeGreaterThan(0.05);
      }
    }
  });
  it('strong is stronger than gentle, and no gain is even', () => {
    expect(Math.max(...lensShares(4, 0.4, 2.6))).toBeGreaterThan(Math.max(...lensShares(4, 0.4, 1.1)));
    for (const x of lensShares(4, 0.4, 0)) expect(x).toBeCloseTo(0.25, 9);
  });
  it('neighbours shrink smoothly as the lens moves', () => {
    let prev = lensShares(4, 0, 2.6);
    for (let at = 0.01; at <= 1; at += 0.01) {
      const cur = lensShares(4, at, 2.6);
      for (let i = 0; i < 4; i++) expect(Math.abs(cur[i] - prev[i])).toBeLessThan(0.02);
      prev = cur;
    }
  });
  it('the wandering lens stays on screen and moves slowly', () => {
    for (let t = 0; t < 600; t += 0.5) {
      const p = wanderAt(t);
      expect(p.x).toBeGreaterThanOrEqual(0.05);
      expect(p.x).toBeLessThanOrEqual(0.95);
      expect(p.y).toBeGreaterThanOrEqual(0.05);
      expect(p.y).toBeLessThanOrEqual(0.95);
      const q = wanderAt(t + 0.5);
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(0.05);
    }
  });
  it('approach eases toward the target', () => {
    expect(approach(0, 1, 0.5, 0.5)).toBeCloseTo(1 - Math.exp(-1), 9);
    expect(approach(0, 1, 100, 0.5)).toBeCloseTo(1, 6);
    expect(approach(0.3, 1, 0, 0.5)).toBeCloseTo(0.3, 9);
  });
  it('trackAt finds the track under a point', () => {
    expect(trackAt([0.2, 0.5, 0.3], 0.1)).toBe(0);
    expect(trackAt([0.2, 0.5, 0.3], 0.69)).toBe(1);
    expect(trackAt([0.2, 0.5, 0.3], 1)).toBe(2);
  });
  it('odd saved settings fall back to the defaults', () => {
    expect(normalizeBreathing({ size: 9, strength: 'wild', speed: 'fast' })).toEqual({ size: 4, strength: 'gentle', speed: 'fast' });
  });
});

describe('pulse grid', () => {
  it('across, diagonal and centre waves run from 0 to 1 in order', () => {
    const a = waveDelays('across', 4, 3);
    expect(a.slice(0, 4)).toEqual([0, 1 / 3, 2 / 3, 1]);
    const d = waveDelays('diagonal', 4, 3);
    expect(d[0]).toBe(0);
    expect(d[11]).toBe(1);
    const c = waveDelays('centre', 5, 5) as number[];
    expect(c[12]).toBe(0);
    expect(Math.max(...c)).toBeCloseTo(1, 9);
    expect(c[0]).toBeCloseTo(1, 9);
  });
  it('sparkle lights only some tiles, but always at least one', () => {
    const rnd = seeded(3);
    for (let k = 0; k < 50; k++) {
      const s = waveDelays('sparkle', 4, 3, rnd);
      expect(s).toHaveLength(12);
      expect(s.some((x) => x != null)).toBe(true);
    }
    const none = waveDelays('sparkle', 3, 3, () => 0.99);
    expect(none.filter((x) => x != null)).toHaveLength(1);
  });
  it('stronger beats give bigger waves, within limits', () => {
    expect(waveLook(1).scale).toBeCloseTo(1.08, 9);
    expect(waveLook(0).scale).toBeCloseTo(1.02, 9);
    expect(waveLook(0.8).glow).toBeGreaterThan(waveLook(0.3).glow);
    expect(waveLook(Number.NaN).scale).toBeGreaterThan(1);
  });
  it('swaps happen now and then, never too close together', () => {
    expect(swapOnWave(1000, 0, 1, () => 0)).toBe(false);
    expect(swapOnWave(5000, 0, 1, () => 0.5)).toBe(true);
    expect(swapOnWave(5000, 0, 0, () => 0.5)).toBe(false);
  });
  it('the swapped tile is one the wave lights and not the one under the mouse', () => {
    const d = [null, 0.2, null, 0.7];
    for (let k = 0; k < 20; k++) {
      const i = tileToSwap(d, 1, seeded(k));
      expect(i).toBe(3);
    }
  });
  it('odd saved settings fall back to the defaults', () => {
    expect(normalizePulse({ pattern: 'diagonal', beat: 'yes' })).toEqual({ pattern: 'diagonal', size: 'normal', beat: false });
  });
});

describe('parallax layers', () => {
  const make = (rnd: () => number): Source<{ key: string; kind: string; a: number }> => {
    let n = 0;
    return {
      pick: () => ({ key: `k${n}`, kind: n % 3 === 0 ? 'video' : 'image', a: [0.6, 1.5, 1][n++ % 3] }),
      aspect: (t) => t.a,
      uid: () => ++n * 1000,
      rnd,
    };
  };
  for (const dir of ['left', 'right', 'up'] as const) {
    const s: Screen = { W: 1600, H: 900, dir };
    it(`fills the screen and keeps lane-mates apart (${dir})`, () => {
      const src = make(seeded(7));
      let list = seed(src, s);
      const check = (l: Drifter<unknown>[]) => {
        LAYERS.forEach((def, li) => {
          for (let lane = 0; lane < def.lanes; lane++) {
            const q = l.filter((p) => p.layer === li && p.lane === lane).sort((a, b) => b.lead - a.lead);
            expect(q.length).toBeGreaterThan(0);
            for (let i = 1; i < q.length; i++) expect(q[i - 1].lead - q[i - 1].len).toBeGreaterThanOrEqual(q[i].lead - 0.001);
          }
        });
      };
      check(list);
      // Drift for two minutes: pieces leave and arrive, lanes stay full and apart.
      let changes = 0;
      for (let t = 0; t < 120 * 30; t++) {
        const r = step(list, 1 / 30, 80, src, s);
        if (r.changed) changes++;
        list = r.list;
      }
      expect(changes).toBeGreaterThan(5);
      check(list);
      const L = dir === 'up' ? s.H : s.W;
      for (const p of list) {
        expect(p.lead - p.len).toBeLessThan(L);
        const b = placeOf(p, s);
        if (dir === 'up') { expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.w).toBeLessThanOrEqual(s.W + 0.001); }
        else { expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.h).toBeLessThanOrEqual(s.H + 0.001); }
      }
      // Never piles up: about perLane per lane.
      expect(list.length).toBeLessThan(LAYERS.reduce((a, d) => a + d.lanes * (d.perLane + 3), 0));
    });
  }
  it('the far layer moves slower than the near one, and pieces move the right way', () => {
    const s: Screen = { W: 1600, H: 900, dir: 'right' };
    const src = make(seeded(1));
    const list = seed(src, s);
    const next = step(list, 1, 100, src, s).list;
    const far = list.find((p) => p.layer === 0 && next.some((q) => q.uid === p.uid))!;
    const near = list.find((p) => p.layer === 2 && next.some((q) => q.uid === p.uid))!;
    const moved = (p: Drifter<unknown>) => placeOf(next.find((q) => q.uid === p.uid)!, s).x - placeOf(p, s).x;
    expect(moved(far)).toBeCloseTo(30, 6);
    expect(moved(near)).toBeCloseTo(100, 6);
    const sl: Screen = { ...s, dir: 'left' };
    const a = placeOf(near, sl).x;
    expect(placeOf({ ...near, lead: near.lead + 10 }, sl).x).toBeCloseTo(a - 10, 6);
  });
  it('gaps are never negative and videos are capped, front first', () => {
    for (const d of LAYERS) expect(laneGap(d, { W: 800, H: 1200, dir: 'up' })).toBeGreaterThan(0);
    const s: Screen = { W: 1600, H: 900, dir: 'left' };
    const list = seed(make(seeded(2)), s);
    const vids = chooseVideos(list, s, 3);
    expect(vids.size).toBeLessThanOrEqual(3);
    const chosen = list.filter((p) => vids.has(p.uid));
    const nearVids = list.filter((p) => p.layer === 2 && p.item.kind === 'video' && p.lead > 0 && p.lead - p.len < s.W);
    expect(chosen.filter((p) => p.layer === 2).length).toBe(Math.min(3, nearVids.length));
  });
  it('odd saved settings fall back to the defaults', () => {
    expect(normalizeParallax({ direction: 'down', speed: 'calm' })).toEqual({ direction: 'left', speed: 'calm' });
  });
});

describe('saved grid modes', () => {
  it('older saves without them still load with defaults', () => {
    const g = normalizeGridModes(undefined);
    expect(g.breathing.size).toBe(4);
    expect(g.pulse.pattern).toBe('centre');
    expect(g.parallax.direction).toBe('left');
    expect(normalizeGridModes({ pulse: { pattern: 'across' } }).pulse.pattern).toBe('across');
  });
});
