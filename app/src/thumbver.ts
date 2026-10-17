// A version per item's thumbnail: it goes up when that thumbnail is made or
// remade, so only the pictures showing it load it again (a folder cover, a
// sidebar picture), not every cover on the screen.

import { useSyncExternalStore } from 'react';
import { onThumb } from './media';

const versions = new Map<number, number>();
const subs = new Map<number, Set<() => void>>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  onThumb((id) => bumpThumb(id));
}

/** The thumbnail of `id` changed. */
export function bumpThumb(id: number) {
  versions.set(id, (versions.get(id) ?? 0) + 1);
  subs.get(id)?.forEach((f) => f());
}

export function thumbVersion(id: number | null | undefined): number {
  return id == null ? 0 : versions.get(id) ?? 0;
}

/** This thumbnail's version; the component draws again only when it changes. */
export function useThumbVersion(id: number | null | undefined): number {
  listen();
  return useSyncExternalStore(
    (cb) => {
      if (id == null) return () => {};
      let set = subs.get(id);
      if (!set) subs.set(id, (set = new Set()));
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (!set!.size) subs.delete(id);
      };
    },
    () => thumbVersion(id),
  );
}

/** A cache-buster for a thumbnail address ('' when it never changed). */
export const verTag = (v: number) => (v ? `c${v}` : undefined);
