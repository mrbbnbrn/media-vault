import { describe, expect, it } from 'vitest';
import { parseShows, resumeAt, trimShows, type ShowStore } from './slideshowmemory';

describe('folder slideshow memory', () => {
  it('carries on where you stopped, in an order that goes one way', () => {
    const keys = ['a', 'b', 'c'];
    expect(resumeAt({ at: 'b', t: 1 }, keys, 'nameAsc')).toBe('b');
    // The first one: nothing to carry on from.
    expect(resumeAt({ at: 'a', t: 1 }, keys, 'nameAsc')).toBeNull();
    // Gone from the folder.
    expect(resumeAt({ at: 'x', t: 1 }, keys, 'nameAsc')).toBeNull();
    // Shuffled or random: no "where you stopped".
    expect(resumeAt({ at: 'b', t: 1 }, keys, 'shuffle')).toBeNull();
    expect(resumeAt({ at: 'b', t: 1 }, keys, 'weighted')).toBeNull();
    expect(resumeAt(undefined, keys, 'newest')).toBeNull();
  });

  it('keeps the most recently used folders', () => {
    const store: ShowStore = { f1: { t: 1 }, f2: { t: 3 }, f3: { t: 2 } };
    expect(Object.keys(trimShows(store, 2)).sort()).toEqual(['f2', 'f3']);
    expect(trimShows(store, 5)).toBe(store);
  });

  it('reads what was saved, and ignores anything broken', () => {
    expect(parseShows(null)).toEqual({});
    expect(parseShows('not json')).toEqual({});
    expect(parseShows('[1,2]')).toEqual({});
    const s = parseShows(JSON.stringify({ f1: { settings: { imageSeconds: 3 }, at: 'v9', t: 5 }, f2: 'x', f3: { at: 7 } }));
    expect(s.f1).toEqual({ settings: { imageSeconds: 3 }, at: 'v9', t: 5 });
    expect(s.f2).toBeUndefined();
    expect(s.f3).toEqual({ settings: undefined, at: undefined, t: 0 });
  });
});
