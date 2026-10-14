// "Continue watching" points saved while the library stays open underneath
// (the mini player): the grid's progress lines follow at once, without
// reloading the folder.

import { useSyncExternalStore } from 'react';

const latest = new Map<number, number | null>();
const subs = new Set<() => void>();
let version = 0;

/** The player saved (or cleared) where a video was left off. */
export function noteResume(id: number, ms: number | null) {
  if (latest.get(id) === ms) return;
  latest.set(id, ms);
  version++;
  subs.forEach((f) => f());
}

/** The newest known resume point of an item. */
export function resumeOf(it: { id: number; resumeMs: number | null }): number | null {
  return latest.has(it.id) ? latest.get(it.id)! : it.resumeMs;
}

/** Re-render when a resume point changes. */
export function useResumeChanges(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => version,
  );
}
