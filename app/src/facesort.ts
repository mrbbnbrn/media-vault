// After an import: once the new pictures are scanned for faces, offer
// "47 of these are Baran — put them in his folder?". Only offered; nothing
// moves unless you say so.

import { useSyncExternalStore } from 'react';
import { api, onEvent, type ImportReport, type SortOffers } from './api';
import { kickFaceScanner, onFaceProgress } from './ml/facescan';

export type Offer = SortOffers['offers'][number];

/** Imports smaller than this aren't worth asking about. */
const MIN_IMPORT = 3;

let pending: number[] = [];
let offers: Offer[] = [];
const subs = new Set<() => void>();
const emit = () => {
  offers = [...offers];
  subs.forEach((s) => s());
};

export function useSortOffers(): Offer[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => offers,
  );
}

export function dismissOffer(folder: number) {
  offers = offers.filter((o) => o.folder !== folder);
  emit();
}

let checking = false;
async function check() {
  if (checking || !pending.length) return;
  checking = true;
  try {
    const r = await api.facesSortOffers(pending);
    if (r.waiting === 0) {
      pending = [];
      if (r.offers.length) {
        offers = [...offers.filter((o) => !r.offers.some((n) => n.folder === o.folder)), ...r.offers];
        emit();
      }
    }
  } catch {
    // Locked or closed: forget it.
    pending = [];
  } finally {
    checking = false;
  }
}

/** Start watching imports (returns a stop function). */
export function watchImports(): () => void {
  const off = onEvent<ImportReport>('import-done', async (r) => {
    if (r.cancelled || r.imported < MIN_IMPORT) return;
    const since = Math.floor(Date.now() / 1000 - r.seconds - 10);
    const ids = await api.facesAfterImport(since).catch(() => [] as number[]);
    if (!ids.length) return;
    pending = [...new Set([...pending, ...ids])];
    kickFaceScanner();
  });
  let t: ReturnType<typeof setTimeout> | null = null;
  const offProgress = onFaceProgress(() => {
    if (!pending.length || t) return;
    t = setTimeout(() => {
      t = null;
      check();
    }, 1500);
  });
  return () => {
    off.then((u) => u());
    offProgress();
    if (t) clearTimeout(t);
    pending = [];
    offers = [];
    emit();
  };
}

// "Sort people into their folders…" (People page, or the after-import card).
let sortAllOpen = false;
const sortSubs = new Set<() => void>();
export function openSortAll(open = true) {
  sortAllOpen = open;
  sortSubs.forEach((s) => s());
}
export function useSortAllOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      sortSubs.add(cb);
      return () => sortSubs.delete(cb);
    },
    () => sortAllOpen,
  );
}

/** Browser preview / tests: show an offer. */
export function showOffer(o: Offer) {
  offers = [...offers, o];
  emit();
}
