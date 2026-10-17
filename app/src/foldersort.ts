// Sorting folders: the sidebar tree (every level the same way), the pinned
// list and folder cards. Pure functions, so they are easy to test; the chosen
// sorts are remembered in the vault (folderprefs.ts).

export type FolderSort = 'own' | 'nameAsc' | 'nameDesc' | 'newest' | 'oldest' | 'opened' | 'items' | 'size';

export const FOLDER_SORTS: { id: FolderSort; label: string; short: string; hint?: string }[] = [
  { id: 'own', label: 'Your own order', short: 'Own order', hint: 'drag to arrange' },
  { id: 'nameAsc', label: 'Name A–Z', short: 'A–Z' },
  { id: 'nameDesc', label: 'Name Z–A', short: 'Z–A' },
  { id: 'newest', label: 'Newest first', short: 'Newest', hint: 'by the pictures inside' },
  { id: 'oldest', label: 'Oldest first', short: 'Oldest', hint: 'by the pictures inside' },
  { id: 'opened', label: 'Recently opened', short: 'Recent' },
  { id: 'items', label: 'Most items', short: 'Most items' },
  { id: 'size', label: 'Largest size', short: 'Largest' },
];

export const isFolderSort = (x: unknown): x is FolderSort => FOLDER_SORTS.some((s) => s.id === x);

/** What sorting needs to know about a folder (a FolderCard has all of it). */
export interface SortableFolder {
  id: number;
  name: string;
  parentId: number | null;
  items: number;
  /** Seconds. */
  createdAt?: number;
  /** The newest / oldest picture date inside (seconds; 0 or missing = empty). */
  newest?: number;
  oldest?: number;
  bytes?: number;
}

/** When each folder was last opened (ms), by id. */
export type Opened = Record<number, number>;

// Natural ("Ödev 2" before "Ödev 10") and case-insensitive; Turkish letters sort sensibly.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const byName = (a: SortableFolder, b: SortableFolder) => collator.compare(a.name, b.name) || a.id - b.id;

/** A comparator for a sort; null for "your own order" (keep the order given). */
export function folderComparator(sort: FolderSort, opened: Opened = {}): ((a: SortableFolder, b: SortableFolder) => number) | null {
  switch (sort) {
    case 'own':
      return null;
    case 'nameAsc':
      return byName;
    case 'nameDesc':
      return (a, b) => byName(b, a);
    // By the pictures inside (empty folders last, newest made first).
    case 'newest':
      return (a, b) => (b.newest || 0) - (a.newest || 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id - a.id;
    case 'oldest':
      return (a, b) => (a.oldest || Infinity) - (b.oldest || Infinity) || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id - b.id;
    case 'opened':
      // Never opened ones go last, by name.
      return (a, b) => (opened[b.id] ?? 0) - (opened[a.id] ?? 0) || byName(a, b);
    case 'items':
      return (a, b) => b.items - a.items || byName(a, b);
    case 'size':
      return (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || byName(a, b);
  }
}

/** Sort a flat list (siblings, cards). "Your own order" keeps the order given. */
export function sortFolders<T extends SortableFolder>(list: T[], sort: FolderSort, opened: Opened = {}): T[] {
  const cmp = folderComparator(sort, opened);
  return cmp ? [...list].sort(cmp) : [...list];
}

/**
 * The whole tree sorted the same way at every level, still in tree order
 * (each folder followed by its subfolders). `folders` comes in your own
 * order (as the library gives it); folders whose parent is missing count as
 * top level.
 */
export function sortTree<T extends SortableFolder>(folders: T[], sort: FolderSort, opened: Opened = {}): T[] {
  const ids = new Set(folders.map((f) => f.id));
  const kids = new Map<number | null, T[]>();
  for (const f of folders) {
    const p = f.parentId != null && ids.has(f.parentId) ? f.parentId : null;
    const list = kids.get(p);
    if (list) list.push(f);
    else kids.set(p, [f]);
  }
  const out: T[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null) => {
    for (const f of sortFolders(kids.get(parent) ?? [], sort, opened)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
      walk(f.id);
    }
  };
  walk(null);
  return out;
}

/**
 * The pinned list: in your own order it follows `pinOrder` (folders not in
 * it keep their tree order, after the others); otherwise it is sorted like
 * the tree.
 */
export function sortPinned<T extends SortableFolder>(pinned: T[], sort: FolderSort, pinOrder: number[], opened: Opened = {}): T[] {
  if (sort !== 'own') return sortFolders(pinned, sort, opened);
  const at = new Map(pinOrder.map((id, k) => [id, k]));
  return pinned
    .map((f, k) => ({ f, k }))
    .sort((a, b) => (at.get(a.f.id) ?? 1e9 + a.k) - (at.get(b.f.id) ?? 1e9 + b.k))
    .map((x) => x.f);
}

/** Put `moving` before or after `target` in `order` (ids); the others keep their places. */
export function placeIds(order: number[], moving: number[], target: number, edge: 'before' | 'after'): number[] {
  if (moving.includes(target)) return order;
  const rest = order.filter((id) => !moving.includes(id));
  const k = rest.indexOf(target);
  if (k < 0) return [...rest, ...moving];
  const at = k + (edge === 'after' ? 1 : 0);
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** Ids of folders opened more than this long ago are forgotten (keeps the saved list small). */
const KEEP_MS = 400 * 86_400_000;
const KEEP_MAX = 2000;

/** Remember that a folder was opened now; old entries are dropped. */
export function markOpened(opened: Opened, id: number, now: number): Opened {
  const entries = Object.entries({ ...opened, [id]: now })
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([, v]) => now - v < KEEP_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, KEEP_MAX);
  return Object.fromEntries(entries);
}

// ---- a steady order ------------------------------------------------------------------------------
// Sorts by what is inside (newest picture, most items, size, recently opened)
// would otherwise reshuffle the sidebar and the folder cards whenever background
// work or opening a folder changes those numbers. Instead the numbers are taken
// once (when the sort is chosen, or chosen again) and kept: folders new since
// then use their own. Names are always the live ones (a rename re-sorts).

export interface SortSnap {
  /** Changes when a new snapshot starts (the sort changed or was chosen again). */
  key: string;
  values: Map<number, { newest?: number; oldest?: number; items: number; bytes?: number; opened?: number }>;
}

/** Keep `snap` (or start a new one when `key` changed), adding folders it doesn't know yet. */
export function updateSnap(snap: SortSnap | null, key: string, folders: SortableFolder[], opened: Opened): SortSnap {
  const s = snap && snap.key === key ? snap : { key, values: new Map() };
  for (const f of folders) {
    if (!s.values.has(f.id)) s.values.set(f.id, { newest: f.newest, oldest: f.oldest, items: f.items, bytes: f.bytes, opened: opened[f.id] });
  }
  return s;
}

/** Sort `folders` (with `sortTree` or `sortFolders`) by the snapshot's numbers; returns the live folders. */
export function sortSteady<T extends SortableFolder>(folders: T[], snap: SortSnap, how: (list: (SortableFolder & { live: T })[], opened: Opened) => (SortableFolder & { live: T })[]): T[] {
  const opened: Opened = {};
  const view = folders.map((f) => {
    const v = snap.values.get(f.id);
    if (v?.opened != null) opened[f.id] = v.opened;
    return { id: f.id, name: f.name, parentId: f.parentId, createdAt: f.createdAt, newest: v?.newest ?? f.newest, oldest: v?.oldest ?? f.oldest, items: v?.items ?? f.items, bytes: v?.bytes ?? f.bytes, live: f };
  });
  return how(view, opened).map((x) => x.live);
}
