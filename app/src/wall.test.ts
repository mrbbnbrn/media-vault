import { describe, expect, it } from 'vitest';
import { pickWeighted, wallGrid } from './components/Wall';
import type { PlayItem } from './media';

const item = (key: string, weight: number): PlayItem => ({ key, name: key, added: 0, size: 1, weight, kind: 'image', src: '', thumb: null, durationMs: null, itemId: null, folderId: null, favourite: false });

describe('wall', () => {
  it('picks by weight, never weight 0, and avoids what is on the wall', () => {
    const items = [item('a', 1), item('b', 4), item('z', 0)];
    const counts: Record<string, number> = { a: 0, b: 0, z: 0 };
    for (let i = 0; i < 20000; i++) counts[pickWeighted(items, new Set())!.key]++;
    expect(counts.z).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(3.5);
    expect(counts.b / counts.a).toBeLessThan(4.5);
    expect(pickWeighted(items, new Set(['b']))!.key).toBe('a');
    expect(pickWeighted(items, new Set(['a', 'b']))!.key).not.toBe('z'); // falls back to showing a repeat
    expect(pickWeighted([item('z', 0)], new Set())).toBeNull();
  });
  it('wall sizes', () => {
    expect(wallGrid(12)).toEqual({ cols: 4, rows: 3 });
    expect(wallGrid(20).cols * wallGrid(20).rows).toBe(20);
    expect(wallGrid(30).cols * wallGrid(30).rows).toBe(30);
  });
});
