// Library tabs, like a web browser's: each tab is its own library view with its
// own back / forward history. Pure functions on an immutable state, so the
// rules (where a new tab goes, which tab becomes active when one closes,
// reopening, reordering, restoring) are easy to test.
//
// What tabs show can name private folders, so the saved form goes into the
// encrypted vault (api.uiSet), never into the plain config file.

import type { LibView } from '../screens/Library';

export interface Tab {
  id: number;
  view: LibView;
  back: LibView[];
  fwd: LibView[];
  /** The tab it was opened from (new background tabs line up after it, like a browser). */
  opener?: number;
}

export interface ClosedTab {
  tab: Tab;
  index: number;
}

export interface TabsState {
  tabs: Tab[];
  active: number;
  /** Recently closed, newest last (Ctrl+Shift+T). */
  closed: ClosedTab[];
  nextId: number;
}

export const HOME: LibView = { kind: 'folders' };
const MAX_HISTORY = 100;
const MAX_CLOSED = 25;
/** History kept per tab when saved (enough for back/forward after a restart). */
const SAVED_HISTORY = 20;
const MAX_TABS_SAVED = 60;

const same = (a: LibView, b: LibView) => JSON.stringify(a) === JSON.stringify(b);
const copy = (v: LibView): LibView => JSON.parse(JSON.stringify(v)) as LibView;

export function initialTabs(view: LibView = HOME): TabsState {
  return { tabs: [{ id: 1, view, back: [], fwd: [] }], active: 1, closed: [], nextId: 2 };
}

export const activeTab = (s: TabsState): Tab => s.tabs.find((t) => t.id === s.active) ?? s.tabs[0];
const indexOf = (s: TabsState, id: number) => s.tabs.findIndex((t) => t.id === id);

function patchActive(s: TabsState, fn: (t: Tab) => Tab): TabsState {
  const a = activeTab(s);
  return { ...s, tabs: s.tabs.map((t) => (t.id === a.id ? fn(t) : t)) };
}

// ---- navigation inside the active tab ------------------------------------------------------

/** Go to a view in the active tab (adds to its history). */
export function navigate(s: TabsState, view: LibView): TabsState {
  if (same(view, activeTab(s).view)) return s;
  return patchActive(s, (t) => ({ ...t, view, back: [...t.back, t.view].slice(-MAX_HISTORY), fwd: [] }));
}

/** Show a view in the active tab without adding a history step (coming back from the viewer). */
export function replaceView(s: TabsState, view: LibView): TabsState {
  return patchActive(s, (t) => ({ ...t, view }));
}

export function goBack(s: TabsState): TabsState | null {
  const t = activeTab(s);
  if (!t.back.length) return null;
  return patchActive(s, () => ({ ...t, view: t.back[t.back.length - 1], back: t.back.slice(0, -1), fwd: [...t.fwd, t.view] }));
}

export function goForward(s: TabsState): TabsState | null {
  const t = activeTab(s);
  if (!t.fwd.length) return null;
  return patchActive(s, () => ({ ...t, view: t.fwd[t.fwd.length - 1], fwd: t.fwd.slice(0, -1), back: [...t.back, t.view] }));
}

// ---- opening, closing, switching ---------------------------------------------------------

/**
 * Open a view in a new tab. In the background (middle-click) it goes after the
 * active tab and after the tabs already opened from it; in front (Ctrl+T) it
 * goes at the end and becomes active.
 */
export function openTab(s: TabsState, view: LibView, opts: { background?: boolean } = {}): TabsState {
  const tab: Tab = { id: s.nextId, view: copy(view), back: [], fwd: [] };
  const tabs = [...s.tabs];
  if (opts.background) {
    tab.opener = s.active;
    let i = indexOf(s, s.active) + 1;
    while (i < tabs.length && tabs[i].opener === s.active) i++;
    tabs.splice(i, 0, tab);
    return { ...s, tabs, nextId: s.nextId + 1 };
  }
  tabs.push(tab);
  return { ...s, tabs, active: tab.id, nextId: s.nextId + 1 };
}

/** Switch to a tab. Choosing a tab ends the "opened from" run (like a browser). */
export function activate(s: TabsState, id: number): TabsState {
  if (id === s.active || indexOf(s, id) < 0) return s;
  return { ...s, active: id, tabs: s.tabs.map((t) => (t.opener != null ? { ...t, opener: undefined } : t)) };
}

/** Close tabs; the last one closed is replaced by a fresh top-level tab. */
export function closeTabs(s: TabsState, ids: number[]): TabsState {
  const gone = new Set(ids.filter((id) => indexOf(s, id) >= 0));
  if (!gone.size) return s;
  const closed = [...s.closed];
  s.tabs.forEach((tab, index) => {
    if (gone.has(tab.id)) closed.push({ tab, index });
  });
  const tabs = s.tabs.filter((t) => !gone.has(t.id));
  const trimmed = closed.slice(-MAX_CLOSED);
  if (!tabs.length) {
    const fresh: Tab = { id: s.nextId, view: HOME, back: [], fwd: [] };
    return { tabs: [fresh], active: fresh.id, closed: trimmed, nextId: s.nextId + 1 };
  }
  let active = s.active;
  if (gone.has(active)) {
    // The tab to its right takes over (or the one to its left at the end).
    const old = indexOf(s, active);
    const right = s.tabs.slice(old + 1).find((t) => !gone.has(t.id));
    const left = s.tabs.slice(0, old).reverse().find((t) => !gone.has(t.id));
    active = (right ?? left ?? tabs[0]).id;
  }
  return { ...s, tabs: tabs.map((t) => (t.opener != null && gone.has(t.opener) ? { ...t, opener: undefined } : t)), active, closed: trimmed };
}

export const closeTab = (s: TabsState, id: number) => closeTabs(s, [id]);
export const closeOthers = (s: TabsState, id: number) => closeTabs(s, s.tabs.filter((t) => t.id !== id).map((t) => t.id));
export function closeToRight(s: TabsState, id: number): TabsState {
  const i = indexOf(s, id);
  return i < 0 ? s : closeTabs(s, s.tabs.slice(i + 1).map((t) => t.id));
}

/** Bring back the most recently closed tab, where it was, and switch to it. */
export function reopenClosed(s: TabsState): TabsState {
  if (!s.closed.length) return s;
  const { tab, index } = s.closed[s.closed.length - 1];
  const back: Tab = { ...tab, id: s.nextId, opener: undefined };
  const tabs = [...s.tabs];
  tabs.splice(Math.min(index, tabs.length), 0, back);
  return { tabs, active: back.id, closed: s.closed.slice(0, -1), nextId: s.nextId + 1 };
}

/** A copy of a tab (with its history) right after it, made active. */
export function duplicateTab(s: TabsState, id: number): TabsState {
  const i = indexOf(s, id);
  if (i < 0) return s;
  const src = s.tabs[i];
  const dup: Tab = { id: s.nextId, view: copy(src.view), back: src.back.map(copy), fwd: src.fwd.map(copy) };
  const tabs = [...s.tabs];
  tabs.splice(i + 1, 0, dup);
  return { ...s, tabs, active: dup.id, nextId: s.nextId + 1 };
}

/** Move a tab to another place (index in the list after the move). */
export function moveTab(s: TabsState, id: number, to: number): TabsState {
  const from = indexOf(s, id);
  if (from < 0) return s;
  const target = Math.max(0, Math.min(s.tabs.length - 1, to));
  if (target === from) return s;
  const tabs = [...s.tabs];
  const [t] = tabs.splice(from, 1);
  tabs.splice(target, 0, { ...t, opener: undefined });
  return { ...s, tabs };
}

/** Ctrl+Tab (+1) / Ctrl+Shift+Tab (−1), wrapping round. */
export function cycle(s: TabsState, dir: 1 | -1): TabsState {
  const n = s.tabs.length;
  if (n < 2) return s;
  const i = indexOf(s, s.active);
  return activate(s, s.tabs[(i + dir + n) % n].id);
}

/** Ctrl+1…8 picks that tab, Ctrl+9 the last one. */
export function jumpTo(s: TabsState, n: number): TabsState {
  if (n < 1 || n > 9) return s;
  const t = n === 9 ? s.tabs[s.tabs.length - 1] : s.tabs[n - 1];
  return t ? activate(s, t.id) : s;
}

// ---- saving (in the encrypted vault) --------------------------------------------------------

interface SavedTabs {
  v: 1;
  active: number;
  tabs: { view: LibView; back?: LibView[]; fwd?: LibView[] }[];
}

export function serializeTabs(s: TabsState): string {
  const tabs = s.tabs.slice(0, MAX_TABS_SAVED);
  const saved: SavedTabs = {
    v: 1,
    active: Math.max(0, tabs.findIndex((t) => t.id === s.active)),
    tabs: tabs.map((t) => ({ view: t.view, back: t.back.slice(-SAVED_HISTORY), fwd: t.fwd.slice(-SAVED_HISTORY) })),
  };
  return JSON.stringify(saved);
}

const KINDS = new Set([
  'folders', 'folder', 'all', 'favourites', 'recent', 'timeline', 'trash', 'stats', 'search', 'smart', 'people', 'lookalikes', 'similar', 'continue', 'memories',
]);
const isId = (x: unknown) => typeof x === 'number' && Number.isSafeInteger(x);
const isStrings = (x: unknown) => Array.isArray(x) && x.every((y) => typeof y === 'string');

/** A view read back from storage, checked field by field (anything odd → null). */
export function cleanView(x: unknown): LibView | null {
  if (!x || typeof x !== 'object') return null;
  const v = x as Record<string, unknown>;
  if (typeof v.kind !== 'string' || !KINDS.has(v.kind)) return null;
  switch (v.kind) {
    case 'folder': return v.id === null || isId(v.id) ? { kind: 'folder', id: v.id as number | null } : null;
    case 'timeline': return v.person == null ? { kind: 'timeline' } : isId(v.person) ? { kind: 'timeline', person: v.person as number } : null;
    case 'search': {
      const people = v.people ?? [];
      return isStrings(v.tags) && isStrings(v.names) && Array.isArray(people) && people.every(isId)
        ? { kind: 'search', tags: v.tags as string[], names: v.names as string[], people: people as number[] } : null;
    }
    case 'smart': return typeof v.q === 'string' ? { kind: 'smart', q: v.q } : null;
    case 'lookalikes': return v.folder === null || isId(v.folder) ? { kind: 'lookalikes', folder: v.folder as number | null } : null;
    case 'similar': return isId(v.id) && typeof v.name === 'string' ? { kind: 'similar', id: v.id as number, name: v.name } : null;
    default: return { kind: v.kind } as LibView;
  }
}

const cleanList = (x: unknown): LibView[] =>
  Array.isArray(x) ? x.map(cleanView).filter((v): v is LibView => v !== null).slice(-SAVED_HISTORY) : [];

/** Tabs saved earlier; null when there is nothing usable. */
export function restoreTabs(raw: string | null | undefined): TabsState | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<SavedTabs>;
  if (d.v !== 1 || !Array.isArray(d.tabs)) return null;
  const tabs: Tab[] = [];
  let activeIdx = typeof d.active === 'number' ? d.active : 0;
  d.tabs.slice(0, MAX_TABS_SAVED).forEach((t, i) => {
    const view = cleanView(t?.view);
    if (!view) {
      if (i < activeIdx) activeIdx--;
      return;
    }
    tabs.push({ id: tabs.length + 1, view, back: cleanList(t.back), fwd: cleanList(t.fwd) });
  });
  if (!tabs.length) return null;
  activeIdx = Math.max(0, Math.min(tabs.length - 1, activeIdx));
  return { tabs, active: tabs[activeIdx].id, closed: [], nextId: tabs.length + 1 };
}

// ---- how a tab looks ---------------------------------------------------------------------

export type TabIconKind = 'folder' | 'folders' | 'person' | 'heart' | 'search' | 'smart' | 'clock' | 'trash' | 'chart' | 'face' | 'twin' | 'play' | 'sparkle' | 'images' | 'recent';

export interface FolderName {
  id: number;
  name: string;
  parentId: number | null;
  person?: boolean;
}

/** Name, icon and full path (tooltip) of a tab. */
export function tabLook(v: LibView, folders: Map<number, FolderName>): { title: string; icon: TabIconKind; path: string } {
  const name = (id: number | null | undefined, fallback: string) => (id == null ? fallback : folders.get(id)?.name ?? fallback);
  const pathOf = (id: number) => {
    const parts: string[] = [];
    const seen = new Set<number>();
    let cur: number | null = id;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const f = folders.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parentId;
    }
    return parts.length ? `All folders › ${parts.join(' › ')}` : 'Folder';
  };
  switch (v.kind) {
    case 'folders': return { title: 'All folders', icon: 'folders', path: 'All folders' };
    case 'folder':
      if (v.id == null) return { title: 'Top level', icon: 'folder', path: 'All folders › Top level' };
      return { title: name(v.id, 'Folder'), icon: folders.get(v.id)?.person ? 'person' : 'folder', path: pathOf(v.id) };
    case 'all': return { title: 'All media', icon: 'images', path: 'All media' };
    case 'favourites': return { title: 'Favourites', icon: 'heart', path: 'Favourites' };
    case 'recent': return { title: 'Recently added', icon: 'recent', path: 'Recently added' };
    case 'timeline': {
      if (v.person == null) return { title: 'Timeline', icon: 'clock', path: 'Timeline' };
      const t = `${name(v.person, 'Person')} · timeline`;
      return { title: t, icon: 'clock', path: t };
    }
    case 'trash': return { title: 'Trash', icon: 'trash', path: 'Trash' };
    case 'stats': return { title: 'Statistics', icon: 'chart', path: 'Statistics' };
    case 'search': {
      const parts = [
        ...(v.people ?? []).map((p) => name(p, 'person')),
        ...v.tags.map((t) => `#${t}`),
        ...v.names.map((n) => `“${n}”`),
      ];
      const t = parts.join(' + ') || 'Search';
      return { title: t, icon: v.people?.length && !v.tags.length && !v.names.length ? 'person' : 'search', path: `Search: ${t}` };
    }
    case 'smart': return { title: v.q || 'Smart search', icon: 'smart', path: `Smart search: “${v.q}”` };
    case 'people': return { title: 'People', icon: 'face', path: 'People' };
    case 'lookalikes': {
      const t = v.folder == null ? 'Look-alikes' : `Look-alikes · ${name(v.folder, 'folder')}`;
      return { title: t, icon: 'twin', path: t };
    }
    case 'similar': return { title: `Similar to “${v.name}”`, icon: 'twin', path: `Similar to “${v.name}”` };
    case 'continue': return { title: 'Continue watching', icon: 'play', path: 'Continue watching' };
    case 'memories': return { title: 'Memories', icon: 'sparkle', path: 'Memories' };
  }
}
