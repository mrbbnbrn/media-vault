// The library's tabs as React state: one library view (with its own history)
// per tab, saved in the encrypted vault while it is open, forgotten on lock.
//
// Only the active tab's library is mounted; switching tabs shows that tab's
// view in the same Library. Each tab keeps its own scroll positions and
// selection (viewmemory scopes them by tab), so it feels like separate pages
// without hidden grids playing videos or listening for keys in the background.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type FolderCard } from '../api';
import type { LibView } from '../screens/Library';
import { armSelectionRestore, setMemoryScope } from '../viewmemory';
import {
  activate, activeTab, closeOthers, closeTab, closeToRight, cycle, duplicateTab, goBack, goForward, HOME, initialTabs, jumpTo, moveTab, navigate,
  openTab, reopenClosed, replaceView, restoreTabs, serializeTabs, tabLook, type FolderName, type TabIconKind, type TabsState,
} from './tabs';

const STORE_KEY = 'tabs';

export interface TabInfo {
  id: number;
  title: string;
  icon: TabIconKind;
  path: string;
  active: boolean;
}

export interface LibraryTabs {
  /** Tabs restored (after unlocking): the library can show. */
  ready: boolean;
  view: LibView;
  activeId: number;
  list: TabInfo[];
  canBack: boolean;
  canForward: boolean;
  canReopen: boolean;
  navigate: (v: LibView) => void;
  replace: (v: LibView) => void;
  back: () => boolean;
  forward: () => boolean;
  open: (v: LibView, background?: boolean) => void;
  newTab: () => void;
  activate: (id: number) => void;
  close: (id: number) => void;
  closeOthers: (id: number) => void;
  closeToRight: (id: number) => void;
  duplicate: (id: number) => void;
  reopen: () => void;
  move: (id: number, to: number) => void;
  cycle: (dir: 1 | -1) => void;
  jump: (n: number) => void;
  /** Show a view in a given tab (if it is still open) without a history step — coming back from the viewer. */
  returnTo: (tab: number | null, v: LibView) => void;
  /** The library's folder list, for tab names. */
  onFolders: (f: FolderCard[]) => void;
  /** Forget everything (the vault locked). */
  reset: () => void;
}

export function useLibraryTabs(vault: string | null): LibraryTabs {
  const [state, setState] = useState<TabsState>(() => initialTabs());
  const ref = useRef(state);
  const [ready, setReady] = useState(false);
  const loadedFor = useRef<string | null>(null);
  const [names, setNames] = useState<Map<number, FolderName>>(() => new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<string>('');

  // Each tab has its own scroll positions and selection.
  setMemoryScope(`t${state.active}`);

  const update = useCallback((fn: (s: TabsState) => TabsState | null): boolean => {
    const cur = ref.current;
    const next = fn(cur);
    if (!next || next === cur) return false;
    if (next.active !== cur.active) armSelectionRestore();
    ref.current = next;
    setState(next);
    return true;
  }, []);

  const reset = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    loadedFor.current = null;
    lastSaved.current = '';
    const fresh = initialTabs();
    ref.current = fresh;
    setState(fresh);
    setNames(new Map());
    setReady(false);
  }, []);

  // Open the tabs saved in this vault.
  useEffect(() => {
    if (!vault) {
      if (loadedFor.current) reset();
      return;
    }
    if (loadedFor.current === vault) return;
    let live = true;
    setReady(false);
    api.uiGet(STORE_KEY)
      .then((raw) => restoreTabs(raw), () => null)
      .then((restored) => {
        if (!live) return;
        const s = restored ?? initialTabs();
        ref.current = s;
        setState(s);
        lastSaved.current = serializeTabs(s);
        loadedFor.current = vault;
        setReady(true);
      });
    // Names for the tabs that are not showing yet.
    api.folders().then((f) => live && setNames(namesOf(f))).catch(() => {});
    return () => {
      live = false;
    };
  }, [vault, reset]);

  // Save a moment after each change (encrypted, in the vault).
  useEffect(() => {
    if (!ready || !loadedFor.current) return;
    const raw = serializeTabs(state);
    if (raw === lastSaved.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      if (!loadedFor.current) return;
      lastSaved.current = raw;
      api.uiSet(STORE_KEY, raw).catch(() => {});
    }, 500);
  }, [state, ready]);

  const onFolders = useCallback((f: FolderCard[]) => setNames(namesOf(f)), []);

  const tab = activeTab(state);
  const list = useMemo(
    () => state.tabs.map((t) => ({ id: t.id, active: t.id === state.active, ...tabLook(t.view, names) })),
    [state.tabs, state.active, names],
  );

  return {
    ready,
    view: tab.view,
    activeId: tab.id,
    list,
    canBack: tab.back.length > 0,
    canForward: tab.fwd.length > 0,
    canReopen: state.closed.length > 0,
    navigate: (v) => void update((s) => navigate(s, v)),
    replace: (v) => void update((s) => replaceView(s, v)),
    back: () => update(goBack),
    forward: () => update(goForward),
    open: (v, background = true) => void update((s) => openTab(s, v, { background })),
    newTab: () => void update((s) => openTab(s, HOME)),
    activate: (id) => void update((s) => activate(s, id)),
    close: (id) => void update((s) => closeTab(s, id)),
    closeOthers: (id) => void update((s) => activate(closeOthers(s, id), id)),
    closeToRight: (id) => void update((s) => closeToRight(s, id)),
    duplicate: (id) => void update((s) => duplicateTab(s, id)),
    reopen: () => void update(reopenClosed),
    move: (id, to) => void update((s) => moveTab(s, id, to)),
    cycle: (dir) => void update((s) => cycle(s, dir)),
    jump: (n) => void update((s) => jumpTo(s, n)),
    returnTo: (id, v) => void update((s) => replaceView(id != null ? activate(s, id) : s, v)),
    onFolders,
    reset,
  };
}

function namesOf(f: FolderCard[]): Map<number, FolderName> {
  return new Map(f.map((x) => [x.id, { id: x.id, name: x.name, parentId: x.parentId, person: x.person }]));
}

/** Tab keys: Ctrl+T, Ctrl+W, Ctrl+Shift+T, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgUp/PgDn, Ctrl+1…9. */
export function useTabKeys(tabs: LibraryTabs, enabled: boolean) {
  const ref = useRef(tabs);
  ref.current = tabs;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const t = ref.current;
      const k = e.key.toLowerCase();
      let done = true;
      if (k === 't' && e.shiftKey) t.reopen();
      else if (k === 't') t.newTab();
      else if ((k === 'w' || k === 'f4') && !e.shiftKey) t.close(t.activeId);
      else if (e.key === 'Tab') t.cycle(e.shiftKey ? -1 : 1);
      else if (e.key === 'PageDown' && !e.shiftKey) t.cycle(1);
      else if (e.key === 'PageUp' && !e.shiftKey) t.cycle(-1);
      else if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) t.jump(Number(e.code.slice(5)));
      else done = false;
      if (done) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Capture: before the library's own keys (and the browser's Ctrl+Tab focus moves).
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
