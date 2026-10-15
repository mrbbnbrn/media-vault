// After unlocking, the grid comes first: background work (thumbnails, faces,
// smart search, previews, fingerprints, the native analysis pass) starts
// once the library has shown its first page, or after a short wait at most,
// so it doesn't compete with that first load.

let shown = false;
const waiters = new Set<() => void>();

/** The library showed its first page since unlocking. */
export function gridShown(): void {
  if (shown) return;
  shown = true;
  waiters.forEach((w) => w());
  waiters.clear();
}

/** The vault locked: the next unlock waits for its first page again. */
export function resetGrid(): void {
  shown = false;
}

/** Resolves once the first page is shown (or after `maxMs` at most). */
export function afterGrid(maxMs = 2500): Promise<void> {
  if (shown) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      waiters.delete(done);
      resolve();
    };
    const t = setTimeout(done, maxMs);
    waiters.add(done);
  });
}

/** Start some background work after the first page; returns how to stop it (also before it started). */
export function whenGridShown(start: () => () => void, maxMs?: number): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;
  afterGrid(maxMs).then(() => {
    if (!cancelled) stop = start();
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}
