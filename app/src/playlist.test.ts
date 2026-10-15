import { describe, expect, it } from 'vitest';
import { Playlist, seeded, sorted, weightedPick, type Entry } from './playlist';

const mk = (name: string, added: number, size = 1, weight?: number): Entry => ({ key: name, name, added, size, weight });
const items = [mk('b2.jpg', 3, 30), mk('a10.jpg', 1, 10), mk('a2.jpg', 2, 20)];

describe('orders', () => {
  it('sorts names naturally and by date and size', () => {
    expect(sorted(items, 'nameAsc').map((x) => x.name)).toEqual(['a2.jpg', 'a10.jpg', 'b2.jpg']);
    expect(sorted(items, 'nameDesc').map((x) => x.name)).toEqual(['b2.jpg', 'a10.jpg', 'a2.jpg']);
    expect(sorted(items, 'newest').map((x) => x.name)).toEqual(['b2.jpg', 'a2.jpg', 'a10.jpg']);
    expect(sorted(items, 'oldest').map((x) => x.name)).toEqual(['a10.jpg', 'a2.jpg', 'b2.jpg']);
    expect(sorted(items, 'largest').map((x) => x.size)).toEqual([30, 20, 10]);
  });

  it('plays in order, stops or repeats at the end', () => {
    const p = new Playlist(items, 'nameAsc', 'off');
    expect(p.current()?.name).toBe('a2.jpg');
    p.next(true);
    p.next(true);
    expect(p.next(true)).toBeNull(); // repeat off: the slideshow ends
    const r = new Playlist(items, 'nameAsc', 'all');
    r.next(); r.next();
    expect(r.next(true)?.name).toBe('a2.jpg'); // repeat all: back to the start
    expect(r.prev()?.name).toBe('b2.jpg');
  });

  it('repeat one replays when advancing by itself but skips manually', () => {
    const p = new Playlist(items, 'nameAsc', 'one');
    expect(p.next(true)?.name).toBe('a2.jpg');
    expect(p.next(false)?.name).toBe('a10.jpg');
  });

  it('starts at a chosen item', () => {
    const p = new Playlist(items, 'nameAsc', 'all', 'b2.jpg');
    expect(p.current()?.name).toBe('b2.jpg');
    expect(p.index()).toBe(2);
  });

  it('shuffle shows every item once per round, never twice in a row across rounds', () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(`f${i}`, i));
    const p = new Playlist(many, 'shuffle', 'all', undefined, seeded(7));
    for (let round = 0; round < 5; round++) {
      const seen = new Set<string>();
      let prev = '';
      for (let i = 0; i < 20; i++) {
        const k = p.current()!.key;
        expect(k).not.toBe(prev);
        seen.add(k);
        prev = k;
        p.next(true);
      }
      expect(seen.size).toBe(20);
    }
  });

  it('random never repeats the same item back to back', () => {
    const p = new Playlist(items, 'random', 'all', undefined, seeded(3));
    let prev = p.current()!.key;
    for (let i = 0; i < 200; i++) {
      const k = p.next(true)!.key;
      expect(k).not.toBe(prev);
      prev = k;
    }
  });

  it('previous retraces random history', () => {
    const p = new Playlist(items, 'random', 'all', undefined, seeded(11));
    const a = p.current()!.key;
    const b = p.next()!.key;
    p.next();
    expect(p.prev()!.key).toBe(b);
    expect(p.prev()!.key).toBe(a);
  });
});

describe('weighted random', () => {
  it('picks in proportion to weight, unset = 1, 0 = never', () => {
    // Weights 5, 1 (unset), 0, 2 → expected shares 5/8, 1/8, 0, 2/8.
    const list = [mk('heavy', 0, 1, 5), mk('normal', 0), mk('never', 0, 1, 0), mk('double', 0, 1, 2)];
    const counts: Record<string, number> = {};
    const rng = seeded(42);
    const n = 80_000;
    for (let i = 0; i < n; i++) {
      const idx = weightedPick(list.map((e) => (e.weight === undefined ? 1 : e.weight)), rng);
      counts[list[idx].key] = (counts[list[idx].key] ?? 0) + 1;
    }
    expect(counts.never).toBeUndefined();
    expect(counts.heavy / n).toBeCloseTo(5 / 8, 1);
    expect(counts.normal / n).toBeCloseTo(1 / 8, 1);
    expect(counts.double / n).toBeCloseTo(2 / 8, 1);
    expect(counts.heavy / counts.normal).toBeGreaterThan(4.5);
    expect(counts.heavy / counts.normal).toBeLessThan(5.5);
  });

  it('heavier items come up more often in a weighted slideshow', () => {
    const list = [mk('heavy', 0, 1, 10), mk('a', 0), mk('b', 0), mk('c', 0)];
    const p = new Playlist(list, 'weighted', 'all', undefined, seeded(5));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) {
      const k = p.next(true)!.key;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    // Back-to-back repeats are skipped, so with only 4 files "heavy" can show
    // at most every other time (about 45% instead of 10/13) — still about 2.5x
    // as often as each of the others. In bigger folders the effect vanishes.
    expect(counts.heavy).toBeGreaterThan(counts.a * 2.2);
    const big = [mk('heavy', 0, 1, 5), ...Array.from({ length: 200 }, (_, i) => mk(`n${i}`, 0))];
    const q = new Playlist(big, 'weighted', 'all', undefined, seeded(9));
    const c2: Record<string, number> = {};
    for (let i = 0; i < 60_000; i++) {
      const k = q.next(true)!.key;
      c2[k] = (c2[k] ?? 0) + 1;
    }
    const avgNormal = (60_000 - c2.heavy) / 200;
    expect(c2.heavy / avgNormal).toBeGreaterThan(4.5);
    expect(c2.heavy / avgNormal).toBeLessThan(5.5);
  });

  it('nothing to play when every weight is 0', () => {
    const p = new Playlist([mk('x', 0, 1, 0)], 'weighted');
    expect(p.current()).toBeNull();
    expect(weightedPick([0, 0], Math.random)).toBe(-1);
  });

  it('a single playable item keeps playing', () => {
    const p = new Playlist([mk('x', 0, 1, 3), mk('y', 0, 1, 0)], 'weighted');
    expect(p.current()!.key).toBe('x');
    expect(p.next(true)!.key).toBe('x');
  });
});

describe('peek', () => {
  it('shows the next items in order, wrapping with repeat all', () => {
    const p = new Playlist(items, 'nameAsc', 'all', 'a10.jpg');
    expect(p.peek(2).map((x) => x.key)).toEqual(['b2.jpg', 'a2.jpg']);
    const off = new Playlist(items, 'nameAsc', 'off', 'a10.jpg');
    expect(off.peek(5).map((x) => x.key)).toEqual(['b2.jpg']);
    expect(new Playlist(items, 'random').peek(3)).toEqual([]);
  });
});

describe('peekBack', () => {
  it('shows the items before, nearest first, wrapping with repeat all', () => {
    const p = new Playlist(items, 'nameAsc', 'all', 'a10.jpg');
    expect(p.peekBack(2).map((x) => x.key)).toEqual(['a2.jpg', 'b2.jpg']);
    const off = new Playlist(items, 'nameAsc', 'off', 'a10.jpg');
    expect(off.peekBack(5).map((x) => x.key)).toEqual(['a2.jpg']);
    expect(off.peekBack(1)[0].key).toBe(off.prev()!.key);
  });

  it('in random modes, what was shown before', () => {
    const p = new Playlist(items, 'random', 'all', 'a2.jpg', seeded(3));
    expect(p.peekBack(1)).toEqual([]);
    const second = p.next()!.key;
    p.next();
    expect(p.peekBack(2).map((x) => x.key)).toEqual([second, 'a2.jpg']);
    expect(p.prev()!.key).toBe(second);
  });
});
