// Thumbnails the window already fetched, kept in memory as blob: URLs.
//
// The vault answers every request with `Cache-Control: no-store`, so the web
// engine never keeps a decrypted copy in its HTTP cache (which WebView2 keeps
// on disk). Instead the grid keeps its own copies here, in memory only: a
// tile scrolled back into view (or a folder opened again) shows its
// thumbnail at once, without asking the vault again. Keys are thumbnail
// addresses that carry the thumbnail's object id (`?v=…`), so a remade
// thumbnail never shows an old copy. At most MAX_BYTES are kept (the least
// recently used go first, never one a tile is showing), and everything is
// let go the moment the vault locks. Kept far below the size at which the
// web engine would move blob data out of memory.
//
// Loads are cancellable (AbortSignal): a tile that scrolls away stops its
// fetch (loadqueue.ts).

import { onLocked } from './api';

export const MAX_BYTES = 48 * 1024 * 1024;

interface Entry {
  url: string;
  bytes: number;
  /** Tiles showing it right now (never let go while > 0). */
  users: number;
}

/** In least-recently-used order (a Map keeps insertion order). */
const cache = new Map<string, Entry>();
let total = 0;
/** Bumped when everything is let go, so loads that finish afterwards are thrown away. */
let generation = 0;

export const stats = { hits: 0, fetched: 0, aborted: 0, bytes: () => total, count: () => cache.size };

function touch(src: string): Entry | undefined {
  const e = cache.get(src);
  if (e) {
    cache.delete(src);
    cache.set(src, e);
  }
  return e;
}

function trim() {
  if (total <= MAX_BYTES) return;
  for (const [k, e] of cache) {
    if (total <= MAX_BYTES) break;
    if (e.users > 0) continue;
    URL.revokeObjectURL(e.url);
    cache.delete(k);
    total -= e.bytes;
  }
}

/** The kept copy of `src`, if there is one (without using it: see `take`). */
export function peek(src: string): string | null {
  return touch(src)?.url ?? null;
}

/** The kept copy of `src`, if there is one; the caller now uses it (call `release`). */
export function take(src: string): string | null {
  const e = touch(src);
  if (!e) return null;
  e.users += 1;
  stats.hits += 1;
  return e.url;
}

/** A tile no longer shows `src`. */
export function release(src: string) {
  const e = cache.get(src);
  if (e && e.users > 0) e.users -= 1;
  trim();
}

/**
 * Fetch `src` (cancellable), keep it, and use it (call `release` later).
 * Rejects with an AbortError when cancelled.
 */
export async function load(src: string, signal: AbortSignal, priority: 'high' | 'low' | 'auto' = 'auto'): Promise<string> {
  const have = take(src);
  if (have) return have;
  const gen = generation;
  let res: Response;
  try {
    res = await fetch(src, { signal, priority } as RequestInit);
  } catch (e) {
    if (signal.aborted) stats.aborted += 1;
    throw e;
  }
  if (!res.ok) throw new Error(`thumbnail ${res.status}`);
  const blob = await res.blob();
  if (signal.aborted) {
    stats.aborted += 1;
    throw new DOMException('cancelled', 'AbortError');
  }
  if (gen !== generation) throw new DOMException('locked', 'AbortError');
  stats.fetched += 1;
  // Another tile with the same address may have been quicker.
  const again = take(src);
  if (again) return again;
  const url = URL.createObjectURL(blob);
  cache.set(src, { url, bytes: blob.size, users: 1 });
  total += blob.size;
  trim();
  return url;
}

/** Let every kept thumbnail go (the vault locked). */
export function clear() {
  generation += 1;
  for (const e of cache.values()) URL.revokeObjectURL(e.url);
  cache.clear();
  total = 0;
}

void onLocked(() => clear());

// Counts only (for measuring in the browser preview's dev tools).
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __thumbStats: () => object }).__thumbStats = () => ({ hits: stats.hits, fetched: stats.fetched, aborted: stats.aborted, kept: cache.size, bytes: total });
}
