// What the library remembers about each view: scroll positions (for this
// unlock), and — kept in the vault — each folder's own sort order, type filter
// and items per row, plus where you left off.

import { api, type Kind } from './api';
import type { Order } from './playlist';
import type { LibView } from './screens/Library';

export const viewKey = (v: LibView) => JSON.stringify(v);

// ---- scroll positions (this unlock only) ----------------------------------------------------

const scrolls = new Map<string, number>();
let sideScroll = 0;
/** Each library tab keeps its own scroll positions and selections. */
let scope = '';
export const setMemoryScope = (s: string) => {
  scope = s;
};
const scoped = (key: string) => `${scope}\u0000${key}`;

export const getScroll = (key: string) => scrolls.get(scoped(key)) ?? 0;
export const setScroll = (key: string, top: number) => void scrolls.set(scoped(key), top);
export const getSideScroll = () => sideScroll;
export const setSideScroll = (top: number) => {
  sideScroll = top;
};

// ---- selection per tab (this unlock only) ----------------------------------------------------

const selections = new Map<string, { items: number[]; folders: number[] }>();
let selectionArmed = false;
export function rememberSelection(key: string, items: Iterable<number>, folders: Iterable<number>) {
  const it = [...items];
  const fs = [...folders];
  if (!it.length && !fs.length) selections.delete(scoped(key));
  else selections.set(scoped(key), { items: it, folders: fs });
}
/** The next view load puts back the selection it had (switching to another tab). */
export function armSelectionRestore() {
  selectionArmed = true;
}
/** The selection to put back for this view, once after armSelectionRestore(); otherwise null. */
export function takeSelection(key: string): { items: number[]; folders: number[] } | null {
  if (!selectionArmed) return null;
  selectionArmed = false;
  return selections.get(scoped(key)) ?? null;
}

// ---- per-view settings (kept in the vault) -----------------------------------------------------

export interface ViewPrefs {
  sort?: Order;
  kind?: Kind | 'any';
  cols?: number;
  /** Scroll mode: one long column of full-width pictures. */
  scroll?: boolean;
}

let prefs: Record<string, ViewPrefs> = {};
let loadedFor: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** The settings key of a view: each folder its own, searches share one. */
export function prefsKey(v: LibView): string {
  if (v.kind === 'folder') return `f${v.id ?? 'top'}`;
  if (v.kind === 'search' || v.kind === 'smart') return 'search';
  return v.kind;
}

export async function loadViewPrefs(vault: string): Promise<void> {
  if (loadedFor === vault) return;
  loadedFor = vault;
  prefs = {};
  try {
    const raw = await api.uiGet('views');
    if (raw) prefs = JSON.parse(raw) as Record<string, ViewPrefs>;
  } catch {
    /* start fresh */
  }
}

export const viewPrefsFor = (key: string): ViewPrefs => prefs[key] ?? {};

export function setViewPrefs(key: string, patch: ViewPrefs) {
  prefs = { ...prefs, [key]: { ...prefs[key], ...patch } };
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.uiSet('views', JSON.stringify(prefs)).catch(() => {}), 800);
}

// ---- where you left off ---------------------------------------------------------------------

export interface LastPlace {
  view: LibView;
  item?: number | null;
}

let lastTimer: ReturnType<typeof setTimeout> | null = null;
export function rememberPlace(p: LastPlace) {
  if (lastTimer) clearTimeout(lastTimer);
  lastTimer = setTimeout(() => api.uiSet('last', JSON.stringify(p)).catch(() => {}), 1000);
}

export async function lastPlace(): Promise<LastPlace | null> {
  try {
    const raw = await api.uiGet('last');
    return raw ? (JSON.parse(raw) as LastPlace) : null;
  } catch {
    return null;
  }
}

/** Forget everything (when the vault locks). */
export function clearViewMemory() {
  scrolls.clear();
  sideScroll = 0;
  selections.clear();
  selectionArmed = false;
  scope = '';
  prefs = {};
  loadedFor = null;
}
