import { describe, expect, it } from 'vitest';
import { evaluate, planSpin, reelStrip, seeded, usefulGroups, type SlotGroup } from './slots';

const pool = Array.from({ length: 40 }, (_, k) => k + 1);
const bahar: SlotGroup = { kind: 'person', key: '7', label: 'Bahar', items: [1, 2, 3, 4, 5] };
const sea: SlotGroup = { kind: 'tag', key: 'sea', label: 'sea', items: [10, 11, 12, 13] };
const pair: SlotGroup = { kind: 'tag', key: 'cat', label: 'cat', items: [20, 21] };

describe('slot machine', () => {
  it('keeps groups worth playing for, people first', () => {
    const all: SlotGroup = { kind: 'tag', key: 'all', label: 'everything', items: pool };
    const outside: SlotGroup = { kind: 'tag', key: 'x', label: 'x', items: [99, 98, 1] };
    const g = usefulGroups([sea, all, pair, bahar, outside], pool);
    expect(g.map((x) => x.label)).toEqual(['Bahar', 'sea', 'cat']);
  });

  it('spots jackpots and near misses', () => {
    const groups = [bahar, sea];
    expect(evaluate([1, 4, 2], groups)).toEqual({ kind: 'jackpot', group: bahar });
    expect(evaluate([30, 11, 13], groups)).toEqual({ kind: 'pair', group: sea, reels: [1, 2] });
    expect(evaluate([1, 11, 30], groups)).toEqual({ kind: 'none' });
    expect(evaluate([1, 2], groups)).toEqual({ kind: 'none' });
  });

  it('lands a jackpot now and then — about one spin in five or six', () => {
    const groups = usefulGroups([bahar, sea, pair], pool);
    const rng = seeded(42);
    let jackpots = 0;
    let pairs = 0;
    const n = 6000;
    for (let k = 0; k < n; k++) {
      const reels = planSpin(pool, groups, rng);
      expect(reels).toHaveLength(3);
      const r = evaluate(reels, groups);
      if (r.kind === 'jackpot') {
        jackpots++;
        expect(new Set(reels).size).toBe(3); // three different pictures
      } else if (r.kind === 'pair') pairs++;
    }
    expect(jackpots / n).toBeGreaterThan(0.15);
    expect(jackpots / n).toBeLessThan(0.22);
    expect(pairs / n).toBeGreaterThan(0.2);
  });

  it('just spins when there are no groups, and copes with tiny folders', () => {
    const rng = seeded(1);
    expect(planSpin([], [], rng)).toEqual([]);
    expect(planSpin([5], [], rng)).toEqual([5, 5, 5]);
    const r = planSpin([1, 2, 3, 4], [], rng);
    expect(new Set(r).size).toBe(3);
  });

  it('builds reel strips that end on the result', () => {
    const s = reelStrip(pool, 7, 12, seeded(3));
    expect(s).toHaveLength(12);
    expect(s[11]).toBe(7);
    expect(s.every((id) => pool.includes(id))).toBe(true);
  });
});
