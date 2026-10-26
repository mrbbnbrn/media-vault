// Slideshows remember, per folder, their own settings (timing, order, repeat,
// transitions…) and the item where you stopped, so starting the folder's
// slideshow again can carry on from there. Folders without their own settings
// use the usual ones (the last ones changed outside a folder).
//
// They name folders, so they are kept in the encrypted vault (ui_set), never in
// the plain config file, and forgotten from memory when the vault locks.

import { api, onLocked } from './api';
import type { PlaybackSettings } from './presets';
import type { Order } from './playlist';

const KEY = 'slideshowFolders';
/** At most this many folders are remembered (the ones used longest ago go first). */
export const MAX_FOLDERS = 300;

export interface FolderShow {
  /** The folder's own settings (sound left out: it has its own memory). */
  settings?: Partial<PlaybackSettings>;
  /** The item showing when the slideshow stopped (its key), to carry on from. */
  at?: string;
  /** Last used (ms). */
  t: number;
}
export type ShowStore = Record<string, FolderShow>;

/** Keeps the `max` most recently used folders. */
export function trimShows(store: ShowStore, max = MAX_FOLDERS): ShowStore {
  const keys = Object.keys(store);
  if (keys.length <= max) return store;
  const keep = keys.sort((a, b) => (store[b].t ?? 0) - (store[a].t ?? 0)).slice(0, max);
  return Object.fromEntries(keep.map((k) => [k, store[k]]));
}

const RANDOM: Order[] = ['shuffle', 'random', 'weighted'];

/**
 * Where a slideshow of this folder should start: the item where you stopped, if it is still
 * there, the order goes one way (not shuffled or random) and it isn't the first one anyway.
 */
export function resumeAt(entry: FolderShow | null | undefined, keysInOrder: string[], order: Order): string | null {
  const at = entry?.at;
  if (!at || RANDOM.includes(order)) return null;
  const i = keysInOrder.indexOf(at);
  return i > 0 ? at : null;
}

/** Reads what was saved (anything broken counts as nothing). */
export function parseShows(raw: string | null): ShowStore {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: ShowStore = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      if (!e || typeof e !== 'object') continue;
      const x = e as Partial<FolderShow>;
      out[k] = {
        settings: x.settings && typeof x.settings === 'object' ? x.settings : undefined,
        at: typeof x.at === 'string' ? x.at : undefined,
        t: typeof x.t === 'number' ? x.t : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

// ---- the open vault's memory ----------------------------------------------------------------

let mem: { vault: string; store: ShowStore } | null = null;
let loading: { vault: string; p: Promise<ShowStore> } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let hooked = false;

function hookUp() {
  if (hooked) return;
  hooked = true;
  onLocked(() => {
    // Locked: nothing about folders stays in memory (changes not yet saved are dropped).
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    mem = null;
    loading = null;
  }).catch(() => {});
}

/** Loads the vault's memory (once; later calls get the same). */
export function loadShows(vault: string): Promise<ShowStore> {
  hookUp();
  if (mem?.vault === vault) return Promise.resolve(mem.store);
  if (loading?.vault === vault) return loading.p;
  const p = api.uiGet(KEY).catch(() => null).then((raw) => {
    if (loading?.p === p) loading = null;
    if (mem?.vault !== vault) mem = { vault, store: parseShows(raw) };
    return mem.store;
  });
  loading = { vault, p };
  return p;
}

/** Already loaded? (null while not.) */
export function peekShows(vault: string): ShowStore | null {
  return mem?.vault === vault ? mem.store : null;
}

/** Changes one folder's memory (`null` forgets it) and saves shortly after. */
export function updateShow(vault: string, place: string, patch: Partial<Omit<FolderShow, 't'>> | null) {
  if (mem?.vault !== vault) return;
  const store = { ...mem.store };
  if (patch === null) delete store[place];
  else {
    const next: FolderShow = { ...store[place], ...patch, t: Date.now() };
    // Nothing left to remember: forgotten.
    if (!next.settings && !next.at) delete store[place];
    else store[place] = next;
  }
  mem = { vault, store: trimShows(store) };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (mem?.vault === vault) api.uiSet(KEY, JSON.stringify(mem.store)).catch(() => {});
  }, 400);
}
