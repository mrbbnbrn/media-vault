import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cache from './thumbcache';

function fakeFetch(sizes: Record<string, number>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (src: string, init: RequestInit) => {
    calls.push(src);
    if (init.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    return new Response(new Uint8Array(sizes[src] ?? 10));
  });
  let n = 0;
  const revoked: string[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++n}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => void revoked.push(u));
  return { calls, revoked };
}

afterEach(() => {
  cache.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('thumbnails kept in memory', () => {
  it('fetches once, then answers from memory until the vault locks', async () => {
    const { calls, revoked } = fakeFetch({});
    const u = await cache.load('t/1?v=a', new AbortController().signal, 'high');
    expect(u).toBe('blob:1');
    expect(cache.take('t/1?v=a')).toBe('blob:1');
    expect(await cache.load('t/1?v=a', new AbortController().signal)).toBe('blob:1');
    expect(calls).toEqual(['t/1?v=a']);
    // A remade thumbnail is another address: fetched anew.
    expect(cache.peek('t/1?v=b')).toBeNull();
    // Locking lets everything go.
    cache.clear();
    expect(cache.peek('t/1?v=a')).toBeNull();
    expect(revoked).toEqual(['blob:1']);
    expect(cache.stats.bytes()).toBe(0);
  });

  it('a cancelled load keeps nothing', async () => {
    fakeFetch({});
    const c = new AbortController();
    c.abort();
    await expect(cache.load('t/2', c.signal)).rejects.toThrow();
    expect(cache.peek('t/2')).toBeNull();
  });

  it('lets the least recently used go first, never one that is showing', async () => {
    const big = cache.MAX_BYTES / 4 + 1;
    const { revoked } = fakeFetch({ a: big, b: big, c: big, d: big });
    const sig = new AbortController().signal;
    await cache.load('a', sig); // shown (one user)
    await cache.load('b', sig);
    cache.release('b'); // no longer shown
    await cache.load('c', sig);
    cache.release('c');
    // Over the limit: b (oldest not shown) goes; a stays although it is older.
    await cache.load('d', sig);
    expect(revoked).toEqual(['blob:2']);
    expect(cache.peek('a')).toBe('blob:1');
    expect(cache.peek('b')).toBeNull();
    expect(cache.stats.bytes()).toBeLessThanOrEqual(cache.MAX_BYTES);
  });
});

describe('which thumbnail size a tile gets', () => {
  it('the small one only while it stays sharp at this pixel density', async () => {
    const { smallEnough, thumbUrl } = await import('./api');
    // A 3:2 photo in a 160 px square tile, cropped to fill: drawn 240 px wide.
    expect(smallEnough(160, 160, 3000, 2000, 'cover', 1)).toBe(true);
    // The same at 150 % scaling: 360 device px, too many for 256.
    expect(smallEnough(160, 160, 3000, 2000, 'cover', 1.5)).toBe(false);
    expect(smallEnough(250, 167, 3000, 2000, 'cover', 1)).toBe(true);
    expect(smallEnough(300, 300, 1000, 1000, 'cover', 1)).toBe(false);
    // Size unknown: the big one.
    expect(smallEnough(100, 100, null, null)).toBe(false);
    expect(thumbUrl(5)).toMatch(/thumb\/5$/);
    expect(thumbUrl(5, 'ab12cd34', true)).toMatch(/thumb\/5\?v=ab12cd34&small=1$/);
    expect(thumbUrl(5, null, true)).toMatch(/thumb\/5\?small=1$/);
  });
});
