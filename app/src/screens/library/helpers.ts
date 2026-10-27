// Plain helpers for the library screen: sort and type choices, titles of
// views and searches, grouping, and where the grid is scrolled to.

import { type SearchValue } from './SearchBars';
import { type FolderCard, type Item, type Kind } from '../../api';
import type { ScrollAnchor } from '../../viewmemory';
import { type Order } from '../../playlist';
import { saveViewerPrefs } from '../../prefs';
import type { LibView } from '../Library';

export const SORTS: { id: Order; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'added', label: 'Recently added' },
  { id: 'nameAsc', label: 'Name A–Z' },
  { id: 'nameDesc', label: 'Name Z–A' },
  { id: 'largest', label: 'Largest first' },
];

/** What the minimap preview says at an item: its month when sorted by date, its first letter when by name. */
export const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

export function minimapLabel(sort: Order | null): ((it: Item) => string | null) | undefined {
  if (sort === 'newest' || sort === 'oldest') return (it) => monthFmt.format(new Date(it.takenAt * 1000));
  if (sort === 'added') return (it) => `Added ${monthFmt.format(new Date(it.importedAt * 1000))}`;
  if (sort === 'nameAsc' || sort === 'nameDesc') return (it) => {
    const c = it.name.trim().charAt(0).toLocaleUpperCase();
    return !c ? null : /\d/.test(c) ? '0–9' : c;
  };
  return undefined;
}

export const KINDS: { id: Kind | 'any'; label: string }[] = [
  { id: 'any', label: 'All types' },
  { id: 'image', label: 'Pictures' },
  { id: 'gif', label: 'GIFs' },
  { id: 'video', label: 'Videos' },
  { id: 'text', label: 'Text files' },
  { id: 'pdf', label: 'PDFs' },
];

export const PREVIEWS: { id: 'all' | 'hover' | 'off'; label: string; hint: string }[] = [
  { id: 'all', label: 'Play everything on screen', hint: 'muted' },
  { id: 'hover', label: 'Play what I hover', hint: 'muted' },
  { id: 'off', label: 'No previews', hint: 'still pictures' },
];

export function viewTitle(v: LibView, folder: FolderCard | null): string {
  switch (v.kind) {
    case 'folders': return 'All folders';
    case 'folder': return v.id === null ? 'Top level' : folder?.name ?? 'Folder';
    case 'all': return 'All media';
    case 'favourites': return 'Favourites';
    case 'recent': return 'Recently added';
    case 'timeline': return 'Timeline';
    case 'trash': return 'Trash';
    case 'stats': return 'Statistics';
    case 'search': return 'Search';
    case 'smart': return `Smart search: “${v.q}”`;
    case 'people': return 'People';
    case 'lookalikes': return 'Look-alikes';
    case 'similar': return `Similar to “${v.name}”`;
    case 'continue': return 'Continue watching';
    case 'memories': return 'Memories';
  }
}

export const NO_SEARCH: SearchValue = { tags: [], names: [], people: [] };

/** Lower-case for matching names: Turkish İ/I/ı/i all match. */
export const foldName = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/\u0307/g, '');

export function searchTitle(v: SearchValue, folders: FolderCard[]) {
  const parts = [
    ...v.people.map((p) => folders.find((f) => f.id === p)?.name ?? 'person'),
    ...v.tags.map((t) => `tagged “${t}”`),
    ...v.names.map((n) => `name contains “${n}”`),
  ];
  return parts.join(' + ');
}

/** Group ids by a value, e.g. previous folder or previous weight (for undo). */
export function groupBy<K>(ids: number[], key: (id: number) => K): Map<K, number[]> {
  const m = new Map<K, number[]>();
  for (const id of ids) {
    const k = key(id);
    m.set(k, [...(m.get(k) ?? []), id]);
  }
  return m;
}

export let colsTimer: ReturnType<typeof setTimeout> | null = null;

export function saveColsLater(n: number) {
  if (colsTimer) clearTimeout(colsTimer);
  colsTimer = setTimeout(() => saveViewerPrefs({ gridColumns: n }), 700);
}

/** The first tile or folder card at the top of the scroller, and its distance from the top edge. */
export function findAnchor(sc: HTMLElement): ScrollAnchor | null {
  const top = sc.getBoundingClientRect().top;
  let best: { el: HTMLElement; y: number } | null = null;
  for (const el of sc.querySelectorAll<HTMLElement>('[data-item], [data-card]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= top + 1) continue;
    if (!best || r.top < best.y - 1 || (Math.abs(r.top - best.y) <= 1 && r.left < best.el.getBoundingClientRect().left)) best = { el, y: r.top };
  }
  if (!best) return null;
  const sel = best.el.dataset.item != null ? `[data-item="${best.el.dataset.item}"]` : `[data-card="${best.el.dataset.card}"]`;
  return { sel, offset: best.y - top };
}
