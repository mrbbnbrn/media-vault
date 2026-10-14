// The sidebar's folder sort, your pinned-folder order and when each folder was
// last opened. They name folders, so they are kept in the encrypted vault
// (ui_set), never in the plain config file.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { isFolderSort, markOpened, type FolderSort, type Opened } from './foldersort';

export interface FolderPrefs {
  /** How the sidebar sorts folders (every level, and the pinned list). */
  side: FolderSort;
  /** Pinned folders in your own order. */
  pins: number[];
  opened: Opened;
}

const KEY = 'folderSort';
const EMPTY: FolderPrefs = { side: 'own', pins: [], opened: {} };

function parse(raw: string | null): FolderPrefs {
  if (!raw) return EMPTY;
  try {
    const v = JSON.parse(raw) as Partial<FolderPrefs>;
    return {
      side: isFolderSort(v.side) ? v.side : 'own',
      pins: Array.isArray(v.pins) ? v.pins.filter((x) => Number.isInteger(x)) : [],
      opened: v.opened && typeof v.opened === 'object' ? v.opened : {},
    };
  } catch {
    return EMPTY;
  }
}

/** The folder prefs of the open vault, and ways to change them (saved shortly after). */
export function useFolderPrefs(vault: string) {
  const [prefs, setPrefs] = useState<FolderPrefs>(EMPTY);
  const cur = useRef(prefs);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let live = true;
    api.uiGet(KEY).then((raw) => {
      if (!live) return;
      cur.current = parse(raw);
      setPrefs(cur.current);
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [vault]);
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      api.uiSet(KEY, JSON.stringify(cur.current)).catch(() => {});
    }
  }, []);
  const update = useCallback((fn: (p: FolderPrefs) => FolderPrefs, soon = false) => {
    cur.current = fn(cur.current);
    setPrefs(cur.current);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      api.uiSet(KEY, JSON.stringify(cur.current)).catch(() => {});
    }, soon ? 50 : 1500);
  }, []);
  return {
    ...prefs,
    setSide: useCallback((side: FolderSort) => update((p) => ({ ...p, side }), true), [update]),
    setPins: useCallback((pins: number[]) => update((p) => ({ ...p, pins }), true), [update]),
    markOpened: useCallback((id: number) => update((p) => ({ ...p, opened: markOpened(p.opened, id, Date.now()) })), [update]),
  };
}
