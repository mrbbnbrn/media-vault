// The library: folder tree, folder cards with covers, the media grid, search
// by tag and file name, the timeline, the trash, statistics, selection
// actions with undo, and importing by drag and drop.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  api, DEFAULT_LOOK, inTauri, mediaUrl, onEvent, thumbUrl, type DropSummary, type FolderCard, type ImportReport, type Item, type Kind,
  type ClipStatus, type CopyLinks, type ExportRequest, type FaceBox, type Merged, type Extracted, type LoginInfo, type StorageDone, type StorageInfo, type StorageProgress, type TagCount, type TrashView,
  takeLogin,
} from '../api';
import type { Nav } from '../App';
import { ActionBar, type BarAction } from '../components/ActionBar';
import { ContactSheet } from '../components/ContactSheet';
import { ConfirmDialog, ContextMenu, Dropdown, FolderPicker, Modal, PromptDialog, type MenuItem } from '../components/Dialogs';
import { FolderLookDialog, FolderMark } from '../components/FolderLook';
import {
  ChartIcon, ChevronIcon, ClockIcon, CloseIcon, DiceIcon, FolderIcon, GearIcon, GridIcon, HeartIcon, HelpIcon, ImportIcon, LockIcon, MoveIcon, PinIcon,
  ArrowIcon, ExportIcon, FaceIcon, PlayIcon, TwinIcon, ImagesIcon, NoteIcon, RailIcon, SortIcon, PlusIcon, RestoreIcon, SearchIcon, SheetIcon, SparkleIcon, TagIcon, TrashIcon, UndoIcon, WeightIcon,
} from '../components/Icons';
import { LookAlikes } from '../components/LookAlikes';
import { PeopleView } from '../components/People';
import { RenameDialog, type RenameEntry } from '../components/RenameDialog';
import { QuickSort } from '../components/QuickSort';
import { TagManager } from '../components/TagManager';
import { DeleteOriginalDialog, MergeDialog, NoteDialog } from '../components/OrganizeDialogs';
import { MemoriesView, type Memory } from '../components/Memories';
import { ShareDialog } from '../components/ShareDialog';
import { ConvertDialog } from '../components/ConvertDialog';
import { AnimationDialog } from '../components/AnimationDialog';
import { Duel } from '../components/Duel';
import { SlotMachine } from '../components/SlotMachine';
import { WhyHere, type WhyQuery } from '../components/WhyHere';
import { FOLDER_SORTS, placeIds, sortFolders, sortPinned, sortTree, type FolderSort } from '../foldersort';
import { useFolderPrefs } from '../folderprefs';
import { MuseumHost, openFolderMuseum, openMuseum } from '../components/museum/launch';
import { copyOut, readPaste, savePastedPicture } from '../winclip';
import { maybeDragOut, lastDragOutError } from '../dragout';
import { openRect, revealInGrid, setLibraryReveal, sourceElement, visibleRect } from '../viewerflip';
import { bandPick, folderPick, returnPick } from '../selection';
import { ExportDialog, LoginBanner, TaskCards, hasTaskCards } from '../components/Safety';
import { ActivityRing } from '../components/ActivityRing';
import { kickFaceScanner } from '../ml/facescan';
import { embedQuery, onClipProgress, smartAvailable } from '../ml/smart';
import { useTasks } from '../tasks';
import { MediaGrid } from '../components/MediaGrid';
import { RoundCover } from '../components/RoundCover';
import { ShortcutsDialog, useHelpKey } from '../components/Shortcuts';
import { StatsView } from '../components/StatsView';
import { TodaysPickCard, useTodaysPick } from '../components/TodaysPick';
import { setDropHandler } from '../drop';
import { startMoveDrag, targetFolder } from '../dragmove';
import { QuickLook } from '../components/QuickLook';
import {
  getAnchor, getScroll, getSideScroll, lastPlace, setAnchor as setScrollAnchor, loadViewPrefs, prefsKey, rememberPlace, setScroll, setSideScroll, setViewPrefs, viewKey, viewPrefsFor,
  rememberSelection, takeSelection, type LastPlace,
} from '../viewmemory';
import type { ScrollAnchor } from '../viewmemory';
import { monthGroups } from '../gridlayout';
import { fromItem, kickThumbnails, onThumb } from '../media';
import { sorted, type Order } from '../playlist';
import { saveViewerPrefs, setFaceBoxes, useFaceBoxes, useViewerPrefs } from '../prefs';
import { formatBytes } from '../theme';
import { clearUndo, plural, pushUndo, undoLast, useUndoTop } from '../undo';

export type LibView =
  | { kind: 'folders' }
  | { kind: 'folder'; id: number | null }
  | { kind: 'all' }
  | { kind: 'favourites' }
  | { kind: 'recent' }
  /** Everything by month; with `person`, only that person (person timeline). */
  | { kind: 'timeline'; person?: number }
  | { kind: 'trash' }
  | { kind: 'stats' }
  | { kind: 'search'; tags: string[]; names: string[]; people: number[] }
  | { kind: 'smart'; q: string }
  | { kind: 'people' }
  /** Groups of pictures that look the same (whole library or one folder). */
  | { kind: 'lookalikes'; folder: number | null }
  /** Items that look like one item, most alike first. */
  | { kind: 'similar'; id: number; name: string }
  /** Videos you stopped watching part-way. */
  | { kind: 'continue' }
  /** Slideshows the app puts together. */
  | { kind: 'memories' };

type Dialog =
  | { t: 'newFolder'; parent: number | null }
  | { t: 'moveFolder'; folder: FolderCard }
  | { t: 'deleteFolder'; folder: FolderCard }
  | { t: 'folderTag'; folder: FolderCard }
  | { t: 'look'; folder: FolderCard }
  | { t: 'moveItems'; ids: number[] }
  | { t: 'tagItems'; ids: number[] }
  | { t: 'weight'; ids: number[]; current: number }
  | { t: 'archivePassword'; paths: string[]; target: number | null; summary: DropSummary }
  | { t: 'cover'; folder: FolderCard }
  | { t: 'emptyTrash' }
  | { t: 'forever'; ids: number[]; folder: number | null; what: string }
  | { t: 'shortcuts' }
  | { t: 'sheet' }
  | { t: 'export'; request: Omit<ExportRequest, 'dest'>; what: string }
  | { t: 'deleteMany'; folders: FolderCard[]; items: number[] }
  | { t: 'moveFolders'; folders: FolderCard[] }
  | { t: 'moveMixed'; folders: FolderCard[]; ids: number[] }
  | { t: 'renameMany'; entries: RenameEntry[] }
  | { t: 'freeCopy'; ids: number[] }
  | { t: 'deleteOriginal'; groups: [Item, Item[]][]; ids: number[]; folders: FolderCard[] }
  | { t: 'merge'; folders: FolderCard[] }
  | { t: 'note'; folder: boolean; id: number; name: string; note: string | null }
  | { t: 'copies'; item: Item; list: Item[] }
  | { t: 'tags' }
  | { t: 'quickSort'; folder: FolderCard | null }
  | { t: 'duel'; items: Item[] }
  | { t: 'share'; ids: number[]; folders: number[]; what: string }
  | { t: 'convert'; items: Item[]; target?: 'mp4' }
  | { t: 'animation'; items: Item[] }
  | { t: 'dragOut'; resolve: (ok: boolean) => void }
  | { t: 'extracted'; folder: FolderCard; x: Extracted }
  | { t: 'slots'; folder: FolderCard | null }
  | { t: 'why'; item: Item; query: WhyQuery };

const SORTS: { id: Order; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'nameAsc', label: 'Name A–Z' },
  { id: 'nameDesc', label: 'Name Z–A' },
  { id: 'largest', label: 'Largest first' },
];

/** What the minimap preview says at an item: its month when sorted by date, its first letter when by name. */
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
function minimapLabel(sort: Order | null): ((it: Item) => string | null) | undefined {
  if (sort === 'newest' || sort === 'oldest') return (it) => `Added ${monthFmt.format(new Date(it.importedAt * 1000))}`;
  if (sort === 'nameAsc' || sort === 'nameDesc') return (it) => {
    const c = it.name.trim().charAt(0).toLocaleUpperCase();
    return !c ? null : /\d/.test(c) ? '0–9' : c;
  };
  return undefined;
}

const KINDS: { id: Kind | 'any'; label: string }[] = [
  { id: 'any', label: 'All types' },
  { id: 'image', label: 'Pictures' },
  { id: 'gif', label: 'GIFs' },
  { id: 'video', label: 'Videos' },
  { id: 'text', label: 'Text files' },
  { id: 'pdf', label: 'PDFs' },
];

const PREVIEWS: { id: 'all' | 'hover' | 'off'; label: string; hint: string }[] = [
  { id: 'all', label: 'Play everything on screen', hint: 'muted' },
  { id: 'hover', label: 'Play what I hover', hint: 'muted' },
  { id: 'off', label: 'No previews', hint: 'still pictures' },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function viewTitle(v: LibView, folder: FolderCard | null): string {
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

type SearchValue = { tags: string[]; names: string[]; people: number[] };
const NO_SEARCH: SearchValue = { tags: [], names: [], people: [] };

/** Lower-case for matching names: Turkish İ/I/ı/i all match. */
const foldName = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/\u0307/g, '');

function searchTitle(v: SearchValue, folders: FolderCard[]) {
  const parts = [
    ...v.people.map((p) => folders.find((f) => f.id === p)?.name ?? 'person'),
    ...v.tags.map((t) => `tagged “${t}”`),
    ...v.names.map((n) => `name contains “${n}”`),
  ];
  return parts.join(' + ');
}

/** Group ids by a value, e.g. previous folder or previous weight (for undo). */
function groupBy<K>(ids: number[], key: (id: number) => K): Map<K, number[]> {
  const m = new Map<K, number[]>();
  for (const id of ids) {
    const k = key(id);
    m.set(k, [...(m.get(k) ?? []), id]);
  }
  return m;
}

let colsTimer: ReturnType<typeof setTimeout> | null = null;
function saveColsLater(n: number) {
  if (colsTimer) clearTimeout(colsTimer);
  colsTimer = setTimeout(() => saveViewerPrefs({ gridColumns: n }), 700);
}

let resumeOfferedFor: string | null = null;

/** The first tile or folder card at the top of the scroller, and its distance from the top edge. */
function findAnchor(sc: HTMLElement): ScrollAnchor | null {
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

export function Library({ nav, view, setView, history, reveal, tabs, frozen = false }: {
  nav: Nav; view: LibView; setView: (v: LibView) => void;
  /** The viewer is open over the library: nothing changes, nothing plays, no keys (it stays mounted so its scroll and state are kept). */
  frozen?: boolean;
  history: { back: () => boolean; forward: () => boolean; canBack: boolean; canForward: boolean };
  /** Scroll to and highlight this item (after coming back from the viewer, "show in folder"). */
  reveal: { id: number; n: number } | null;
  /** Tabs (tabs/TabHost): open a view in a new background tab; the folder list for tab names. */
  tabs?: { open: (v: LibView) => void; onFolders: (f: FolderCard[]) => void };
}) {
  // ---- tabs: hooks used by the tab host ----
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  /** Middle-click opens a view in a new tab (in the background). */
  const middleView = (v: LibView) => ({
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault(); // no auto-scroll
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1 && tabs) {
        e.preventDefault();
        tabs.open(v);
      }
    },
  });
  // ---- end tabs ----
  // ---- frozen under the viewer (viewerflip.ts) ----
  // Keys wake up a moment after the viewer closes, so the key that closed it
  // (Escape, Backspace) isn't also handled here.
  const [awake, setAwake] = useState(!frozen);
  const asleep = frozen || !awake;
  const asleepRef = useRef(asleep);
  asleepRef.current = asleep;
  useEffect(() => {
    if (frozen) {
      setAwake(false);
      return;
    }
    const t = setTimeout(() => setAwake(true), 0);
    return () => clearTimeout(t);
  }, [frozen]);
  // ---- end frozen ----
  const s = nav.app.session!;
  const cfg = nav.app.config;
  const [folders, setFolders] = useState<FolderCard[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [subfolders, setSubfolders] = useState<FolderCard[]>([]);
  const [folder, setFolder] = useState<FolderCard | null>(null);
  const [trash, setTrash] = useState<TrashView | null>(null);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Folders are selected like items: click (Ctrl / Shift for more). The folder you open is selected.
  const [selFolders, setSelFolders] = useState<Set<number>>(new Set());
  const [folderAnchor, setFolderAnchor] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  // Each view remembers its own sort, type filter and items per row (kept in the vault).
  const viewerPrefs = useViewerPrefs();
  const vKey = prefsKey(view);
  const vp = viewPrefsFor(vKey);
  const [, setPrefsTick] = useState(0);
  const sort: Order = vp.sort ?? 'newest';
  const kind: Kind | 'any' = vp.kind ?? 'any';
  const cols = vp.cols ?? (viewerPrefs.gridColumns || 5);
  const scrollMode = !!vp.scroll;
  const setScrollMode = (on: boolean) => { setViewPrefs(vKey, { scroll: on }); setPrefsTick((t) => t + 1); };
  const setSort = (o: Order) => { setViewPrefs(vKey, { sort: o }); setPrefsTick((t) => t + 1); };
  const setKind = (k: Kind | 'any') => { setViewPrefs(vKey, { kind: k }); setPrefsTick((t) => t + 1); };
  const vKeyRef = useRef(vKey);
  vKeyRef.current = vKey;
  const setCols = useCallback((n: number) => {
    const c = Math.min(12, Math.max(2, Math.round(n)));
    setViewPrefs(vKeyRef.current, { cols: c });
    saveColsLater(c); // also the default for views without their own
    setPrefsTick((t) => t + 1);
  }, []);
  useEffect(() => {
    loadViewPrefs(s.path).then(() => setPrefsTick((t) => t + 1));
  }, [s.path]);
  // Keyboard cursor in the grid, quick look, and the item to show.
  const [cursor, setCursor] = useState<number | null>(null);
  const [quick, setQuick] = useState<number | null>(null);
  const [revealHere, setRevealHere] = useState<{ id: number; n: number } | null>(null);
  const [resume, setResume] = useState<LastPlace | null>(null);
  const [everyFolder, setEveryFolder] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // Folder sorting: the sidebar (every level and the pinned list) and the folder cards (foldersort.ts).
  const fprefs = useFolderPrefs(s.path);
  const sideSort = fprefs.side;
  const cardSort: FolderSort = vp.folderSort ?? sideSort;
  const setCardSort = (o: FolderSort) => { setViewPrefs(vKey, { folderSort: o }); setPrefsTick((t) => t + 1); };
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reports, setReports] = useState<ImportReport[]>([]);
  const [coverBump, setCoverBump] = useState(0);
  const [ctx, setCtx] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [storageJob, setStorageJob] = useState<StorageProgress | null>(null);
  const [storageMsg, setStorageMsg] = useState<StorageDone | null>(null);
  const [hoverCard, setHoverCard] = useState<number | null>(null);
  const [samples, setSamples] = useState<Record<number, number[]>>({});
  const [cycle, setCycle] = useState(0);
  const [note, setNote] = useState<{ text: string; at: number } | null>(null);
  const [login, setLogin] = useState<LoginInfo | null>(() => takeLogin());
  const [smartOk, setSmartOk] = useState(false);
  const smartOn = smartOk && !!cfg.smartSearch;
  // "Find similar" uses smart search when it is on (only that view reloads when it changes).
  const similarSmart = view.kind === 'similar' && smartOn;
  const [clip, setClip] = useState<ClipStatus | null>(null);
  const [lookTick, setLookTick] = useState(0);
  // Cut / copy inside the library (Ctrl+X / Ctrl+C, then Ctrl+V).
  const [clipboard, setClipboard] = useState<{ mode: 'cut' | 'copy'; ids: number[]; folders: number[] } | null>(null);
  // How often each folder was a destination: "Move to" submenu and quick sort.
  const moveStats = useRef<Record<number, number>>({});
  useEffect(() => {
    api.uiGet('moveStats').then((v) => { if (v) moveStats.current = JSON.parse(v); }).catch(() => {});
  }, [s.path]);
  const bumpMoveStat = (folder: number | null) => {
    if (folder == null) return;
    moveStats.current = { ...moveStats.current, [folder]: (moveStats.current[folder] ?? 0) + 1 };
    api.uiSet('moveStats', JSON.stringify(moveStats.current)).catch(() => {});
  };
  // Faces on the grid (face boxes / face-aware tiles), by item.
  const [gridFaces, setGridFaces] = useState<Map<number, FaceBox[]>>(new Map());
  const tasks = useTasks();
  const undoTop = useUndoTop();
  const [pick, dismissPick] = useTodaysPick(s.path);
  const preview = cfg.preview ?? 'hover';
  const shape = !!cfg.gridShape;
  const look = { ...DEFAULT_LOOK, ...(cfg.look ?? {}) };
  const faceBoxesOn = useFaceBoxes();
  const scroller = useRef<HTMLElement>(null);
  const side = useRef<HTMLElement>(null);
  const header = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const showItem = (id: number) => setRevealHere({ id, n: Date.now() });
  useEffect(() => {
    if (reveal) setRevealHere(reveal);
  }, [reveal]);

  // Pop-up messages sit just under the top bar (its height changes when it wraps).
  useLayoutEffect(() => {
    const h = header.current;
    if (!h) return;
    const set = () => root.current?.style.setProperty('--top-h', `${h.offsetHeight}px`);
    const ro = new ResizeObserver(set);
    ro.observe(h);
    set();
    return () => ro.disconnect();
  }, []);

  // Scroll positions: each view keeps its own; the sidebar keeps its place.
  const viewK = viewKey(view);
  const viewKRef = useRef(viewK);
  viewKRef.current = viewK;
  const restoring = useRef(false);
  // While a new view loads, scroll changes are not that view's position.
  useLayoutEffect(() => {
    restoring.current = true;
  }, [viewK]);
  useLayoutEffect(() => {
    const sd = side.current;
    if (sd) sd.scrollTop = getSideScroll();
    const onSide = () => sd && setSideScroll(sd.scrollTop);
    sd?.addEventListener('scroll', onSide, { passive: true });
    const sc = scroller.current;
    let frame = 0;
    const onMain = () => {
      if (!sc || restoring.current) return;
      setScroll(viewKRef.current, sc.scrollTop);
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (!restoring.current) setScrollAnchor(viewKRef.current, findAnchor(sc));
      });
    };
    // Scrolling by hand ends any restoring still going on.
    const byHand = () => {
      userScrolled.current = true;
    };
    sc?.addEventListener('scroll', onMain, { passive: true });
    sc?.addEventListener('wheel', byHand, { passive: true });
    sc?.addEventListener('pointerdown', byHand, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      sd?.removeEventListener('scroll', onSide);
      sc?.removeEventListener('scroll', onMain);
      sc?.removeEventListener('wheel', byHand);
      sc?.removeEventListener('pointerdown', byHand);
    };
  }, []);
  // The sidebar's content arrives a moment later; put it back where it was then.
  const sideRestored = useRef(false);
  useEffect(() => {
    const sd = side.current;
    if (!sd || sideRestored.current || !folders.length) return;
    sideRestored.current = true;
    sd.scrollTop = getSideScroll();
  }, [folders.length]);
  const userScrolled = useRef(false);
  const restoreScroll = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const key = viewKRef.current;
    const top = getScroll(key);
    const anchor = getAnchor(key);
    restoring.current = true;
    userScrolled.current = false;
    // Put the remembered tile back at the same height on screen; things above it
    // (notices, folder cards, notes) may have appeared or gone since.
    const apply = () => {
      if (userScrolled.current || viewKRef.current !== key) return;
      const el = anchor ? sc.querySelector<HTMLElement>(anchor.sel) : null;
      if (el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - anchor!.offset;
      else sc.scrollTop = top;
    };
    apply();
    requestAnimationFrame(() => {
      apply();
      requestAnimationFrame(apply);
    });
    setTimeout(() => {
      apply();
      restoring.current = false;
    }, 150);
    // Late arrivals (subfolder cards, covers) can still shift things a little.
    for (const ms of [400, 900]) setTimeout(() => {
      if (!restoring.current && !userScrolled.current) {
        restoring.current = true;
        apply();
        requestAnimationFrame(() => {
          restoring.current = false;
        });
      }
    }, ms);
  }, []);

  // Where you left off: remembered as you go, offered once after unlocking.
  useEffect(() => {
    rememberPlace({ view, item: revealHere?.id ?? null });
  }, [viewK, revealHere?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (resumeOfferedFor === s.path) return;
    resumeOfferedFor = s.path;
    lastPlace().then((p) => {
      if (p && p.view && viewKey(p.view) !== viewKey(view) && !['folders', 'stats'].includes(p.view.kind)) setResume(p);
    });
  }, [s.path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.storageInfo().then(setStorage).catch(() => {});
    const a = onEvent<StorageProgress>('storage-progress', setStorageJob);
    const b = onEvent<StorageDone>('storage-done', (d) => {
      setStorageJob(null);
      setStorageMsg(d);
      api.storageInfo().then(setStorage).catch(() => {});
    });
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
  }, []);
  // Smart search: are the models there, and how far is the analysis?
  useEffect(() => {
    smartAvailable().then(setSmartOk);
    const upd = () => api.clipStatus().then(setClip).catch(() => {});
    upd();
    return onClipProgress(upd);
  }, []);
  // The login note goes away by itself unless wrong passwords were tried.
  useEffect(() => {
    if (!login || login.failed.length) return;
    const t = setTimeout(() => setLogin(null), 20_000);
    return () => clearTimeout(t);
  }, [login]);
  // Undo history belongs to this unlock only.
  useEffect(() => () => clearUndo(), [s.path]);

  const saveCfg = async (patch: Partial<typeof cfg>) => {
    await api.saveConfig({ ...cfg, ...patch });
    await nav.refresh();
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [f, t] = await Promise.all([api.folders(), api.allTags()]);
      setFolders(f);
      tabsRef.current?.onFolders(f);
      setTags(t);
      setTrash(null);
      if (view.kind === 'folder') {
        const fv = await api.folderView(view.id);
        setFolder(fv.folder);
        setSubfolders(fv.subfolders);
        setItems(fv.items);
      } else {
        setFolder(null);
        setSubfolders([]);
        if (view.kind === 'folders' || view.kind === 'stats' || view.kind === 'people') setItems([]);
        else if (view.kind === 'lookalikes') setLookTick((t) => t + 1); // the page fetches its groups
        else if (view.kind === 'continue') setItems(await api.continueWatching());
        else if (view.kind === 'memories') setItems([]);
        else if (view.kind === 'similar') {
          const [me, hits] = await Promise.all([api.getItem(view.id).catch(() => null), api.similarTo(view.id, similarSmart)]);
          setItems([...(me && me.deletedAt == null ? [me] : []), ...hits.map((h) => h.item)]);
        }
        else if (view.kind === 'smart') {
          const vec = await embedQuery(view.q);
          const hits = await api.smartSearch(Array.from(vec), null);
          setItems(hits.map((h) => h.item));
        }
        else if (view.kind === 'timeline' && view.person != null) setItems(await api.queryItems({ people: [view.person] }));
        else if (view.kind === 'all' || view.kind === 'timeline') setItems(await api.queryItems({}));
        else if (view.kind === 'favourites') setItems(await api.queryItems({ favouritesOnly: true }));
        else if (view.kind === 'recent') setItems(await api.queryItems({ recentDays: 14 }));
        else if (view.kind === 'search') setItems(await api.queryItems({ tags: view.tags, names: view.names, people: view.people ?? [] }));
        else if (view.kind === 'trash') {
          const t2 = await api.trashView();
          setTrash(t2);
          setItems(t2.items);
        }
      }
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [view, similarSmart]);

  useEffect(() => {
    let live = true;
    // Switching tabs puts back that tab's selection.
    const kept = takeSelection(viewKRef.current);
    setSelected(new Set(kept?.items));
    setAnchor(null);
    setCursor(null);
    setQuick(null);
    // The folder you are in is the selected folder (so the sidebar shows one thing, and Delete works on it).
    const here = view.kind === 'folder' && view.id != null ? view.id : null;
    setSelFolders(kept ? new Set(kept.folders) : here != null ? new Set([here]) : new Set());
    setFolderAnchor(here);
    reload().then(() => {
      if (live) restoreScroll();
    });
    return () => {
      live = false;
    };
  }, [reload, restoreScroll]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => rememberSelection(viewKRef.current, selected, selFolders), [selected, selFolders]);
  // Remember when each folder was opened (the "Recently opened" sort).
  const openedId = view.kind === 'folder' ? view.id : null;
  const markOpened = fprefs.markOpened;
  useEffect(() => {
    if (openedId != null) markOpened(openedId);
  }, [openedId, markOpened]);

  // Folder covers appear as soon as their first thumbnail is made.
  useEffect(() => onThumb(() => setCoverBump((b) => b + 1)), []);
  useEffect(() => {
    if (!coverBump) return;
    const t = setTimeout(() => api.folders().then(setFolders).catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, [coverBump]);

  // ---- undo -------------------------------------------------------------------------------

  /** Record an action that can be undone, and say what happened. */
  const did = (label: string, undo: () => Promise<unknown>) => {
    pushUndo(label, undo);
    setNote({ text: label, at: Date.now() });
  };
  const undo = useCallback(async () => {
    try {
      const label = await undoLast();
      if (label) {
        setNote({ text: `Undone: ${label}`, at: 0 });
        await reload();
        nav.refresh().catch(() => {});
      }
    } catch (e) {
      setError(`Couldn't undo: ${errText(e)}`);
    }
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (asleepRef.current || (e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (e.key === 'Delete' && keyActions.current.anySelected()) {
        e.preventDefault();
        keyActions.current.del();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && ['x', 'c', 'v'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const k = e.key.toLowerCase();
        if (k === 'v') keyActions.current.paste();
        else if (keyActions.current.anySelected()) keyActions.current.clip(k === 'x' ? 'cut' : 'copy');
      } else if (e.key === 'F2' && keyActions.current.anySelected()) {
        e.preventDefault();
        keyActions.current.rename();
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && keyActions.current.openFolder()) {
        e.preventDefault();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !e.shiftKey) {
        e.preventDefault();
        keyActions.current.selectAll();
      } else if (e.key === 'Escape' && keyActions.current.anySelected()) {
        keyActions.current.selectNone();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('lib-search')?.focus();
      } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') keyActions.current.back();
        else keyActions.current.forward();
      } else if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        keyActions.current.back();
      } else if (e.key.length === 1 && /[\p{L}\p{N}]/u.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        keyActions.current.typeJump(e.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);
  const [noteHover, setNoteHover] = useState(false);
  useEffect(() => {
    if (!note || noteHover) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note, noteHover]);

  const colsRef = useRef(cols);
  colsRef.current = cols;
  // Ctrl + mouse wheel: fewer (bigger) or more (smaller) items per row.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      const step = acc > 0 ? 1 : -1;
      acc = 0;
      setCols(colsRef.current + step);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setCols]);

  const showHelp = useCallback(() => {
    if (!asleepRef.current) setDialog({ t: 'shortcuts' });
  }, []);
  useHelpKey(showHelp);

  // ---- actions (all undoable) --------------------------------------------------------------

  // Items fetched from selected folders (so undo knows their old values).
  const known = useRef(new Map<number, Item>());
  const itemById = (id: number) => items.find((i) => i.id === id) ?? known.current.get(id);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const moveItems = async (ids: number[], target: number | null) => {
    const before = groupBy(ids, (id) => itemById(id)?.folderId ?? null);
    await api.moveItems(ids, target);
    bumpMoveStat(target);
    const name = target === null ? 'Top level' : folders.find((f) => f.id === target)?.name ?? 'folder';
    did(`Moved ${plural(ids.length, 'item')} to “${name}”`, async () => {
      for (const [f, g] of before) await api.moveItems(g, f);
    });
    setSelected(new Set());
    await reload();
  };
  const setFav = (ids: number[], on: boolean) => act(async () => {
    const before = groupBy(ids, (id) => !!itemById(id)?.favourite);
    await api.setFavourite(ids, on);
    did(on ? `Added ${plural(ids.length, 'item')} to favourites` : `Removed ${plural(ids.length, 'item')} from favourites`, async () => {
      for (const [f, g] of before) await api.setFavourite(g, f);
    });
  });
  const setWeight = async (ids: number[], w: number) => {
    const before = groupBy(ids, (id) => itemById(id)?.weight ?? 1);
    await api.setWeight(ids, w);
    did(`Weight ${w} for ${plural(ids.length, 'item')}`, async () => {
      for (const [old, g] of before) await api.setWeight(g, old);
    });
    await reload();
  };
  /** Originals about to be deleted that have free copies (not being deleted too). */
  const originalsWithCopies = async (ids: number[]): Promise<[Item, Item[]][]> => {
    const cands = ids.filter((id) => {
      const it = itemById(id);
      return !it || (it.copyOf == null && it.linked);
    });
    if (!cands.length) return [];
    const set = new Set(ids);
    const res = await api.freeCopiesOf(cands);
    const out: [Item, Item[]][] = [];
    for (const [o, cs] of res) {
      const rest = cs.filter((c) => !set.has(c.id));
      if (rest.length) out.push([itemById(o) ?? (await api.getItem(o)), rest]);
    }
    return out;
  };
  /** Delete things, asking first what to do with free copies of originals. */
  const askTrash = async (fs: FolderCard[], ids: number[]) => {
    const groups = ids.length ? await originalsWithCopies(ids).catch(() => []) : [];
    if (groups.length) {
      setDialog({ t: 'deleteOriginal', groups, ids, folders: fs });
      return;
    }
    await deleteMany(fs, ids);
  };
  const trashItems = (ids: number[]) => askTrash([], ids);
  const trashFolder = async (f: FolderCard) => {
    await api.deleteFolder(f.id);
    did(`Moved “${f.name}” to the trash`, () => api.restoreFolder(f.id));
    if (!leaveDeleted([f])) await reload();
    nav.refresh().catch(() => {});
  };
  const moveFolder = async (f: FolderCard, parent: number | null) => {
    await api.moveFolder(f.id, parent);
    did(`Moved “${f.name}”`, () => api.moveFolder(f.id, f.parentId));
    await reload();
  };
  const tagFolder = async (f: FolderCard, list: string[]) => {
    const fresh = list.map((t) => t.trim().replace(/^#/, '')).filter((t) => t && !f.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    await api.tagFolder(f.id, list);
    if (fresh.length) did(`Tagged “${f.name}”`, async () => { for (const t of fresh) await api.untagFolder(f.id, t); });
    await reload();
  };
  const untagFolder = (f: FolderCard, t: string) => act(async () => {
    await api.untagFolder(f.id, t);
    did(`Removed tag “${t}” from “${f.name}”`, () => api.tagFolder(f.id, [t]));
  });
  const setPinned = (f: FolderCard, on: boolean) => act(async () => {
    await api.setPinned(f.id, on);
    did(on ? `Pinned “${f.name}”` : `Unpinned “${f.name}”`, () => api.setPinned(f.id, !on));
  });
  const setLook = async (f: FolderCard, color: string | null, emoji: string | null) => {
    await api.setFolderLook(f.id, color, emoji);
    did(`Changed the look of “${f.name}”`, () => api.setFolderLook(f.id, f.color, f.emoji));
    await reload();
  };
  const restoreItems = (ids: number[]) => act(async () => {
    const homeless = await api.restoreItems(ids);
    did(`Restored ${plural(ids.length, 'item')}${homeless ? ` (${homeless} to the top level, their folder is gone)` : ''}`, () => api.deleteItems(ids));
    setSelected(new Set());
    nav.refresh().catch(() => {});
  });
  const restoreFolder = (id: number, name: string) => act(async () => {
    await api.restoreFolder(id);
    did(`Restored “${name}”`, () => api.deleteFolder(id));
    nav.refresh().catch(() => {});
  });

  // The Delete key acts on the current selection.
  const keyActions = useRef({
    selected, del: () => {}, selectAll: () => {}, selectNone: () => {}, back: () => {}, forward: () => {}, typeJump: (_k: string) => {},
    anySelected: () => false as boolean, openFolder: () => false as boolean, rename: () => {},
    clip: (_m: 'cut' | 'copy') => {}, paste: () => {},
  });
  keyActions.current = {
    selected,
    anySelected: () => selected.size > 0 || selFolders.size > 0,
    rename: () => askRename(),
    clip: (m: 'cut' | 'copy') => clipSelection(m),
    paste: () => { paste().catch((err) => setError(errText(err))); },
    openFolder: () => {
      if (selected.size || selFolders.size !== 1) return false;
      const [id] = selFolders;
      if (view.kind === 'folder' && view.id === id) return false;
      openFolder(id);
      return true;
    },
    back: () => {
      if (!history.back() && view.kind === 'folder') setView(view.id == null ? { kind: 'folders' } : { kind: 'folder', id: folder?.parentId ?? null });
    },
    forward: () => void history.forward(),
    typeJump: (k: string) => typeJump(k),
    selectAll: () => selectAll(),
    selectNone: () => {
      setSelected(new Set());
      setSelFolders(new Set());
    },
    del: () => {
      const ids = [...selected];
      if (selFolders.size && view.kind !== 'trash') {
        askDeleteMany();
        return;
      }
      if (view.kind === 'trash') setDialog({ t: 'forever', ids, folder: null, what: plural(ids.length, 'item') });
      else if (view.kind === 'lookalikes') setDialog({ t: 'deleteMany', folders: [], items: ids });
      else trashItems(ids);
    },
  };

  // ---- import ----------------------------------------------------------------------

  const currentTarget = (): number | null => (view.kind === 'folder' ? view.id : null);

  const beginImport = useCallback(async (paths: string[], target: number | null) => {
    try {
      const summary = await api.inspectDrop(paths);
      if (summary.archives.some((a) => a.needsPassword)) {
        setDialog({ t: 'archivePassword', paths, target, summary });
        return;
      }
      if (!summary.files && !summary.archives.length) {
        setError('Nothing to import there. Supported: pictures (jpg, png, webp), GIFs, videos (mp4, m4v, webm), text files, PDFs and .7z archives.');
        return;
      }
      await api.startImport(paths, target, null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    setDropHandler((paths, target) => {
      let t: number | null = currentTarget();
      if (target === 'folder:top') t = null;
      else if (target?.startsWith('folder:')) t = Number(target.slice(7));
      beginImport(paths, t);
    });
    return () => setDropHandler(null);
  });

  useEffect(() => {
    // Progress shows in the background-jobs ring (jobs.ts); the summary card here.
    const b = onEvent<ImportReport>('import-done', (r) => {
      setReports((rs) => [...rs, r]);
      kickThumbnails();
      reload();
      nav.refresh().catch(() => {});
    });
    return () => {
      b.then((u) => u());
    };
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickAndImport = async (directory: boolean) => {
    if (!inTauri) return;
    const r = await open({ directory, multiple: true, title: directory ? 'Import folders' : 'Import files or .7z archives',
      filters: directory ? undefined : [{ name: 'Media, documents and archives', extensions: ['mp4', 'm4v', 'webm', 'gif', 'webp', 'png', 'jpg', 'jpeg', 'pdf', 'txt', 'md', 'log', 'csv', 'json', 'srt', '7z', '001'] }] });
    const paths = Array.isArray(r) ? r : r ? [r] : [];
    if (paths.length) beginImport(paths, currentTarget());
  };

  // ---- derived -------------------------------------------------------------------------

  const timeline = view.kind === 'timeline';
  const inTrash = view.kind === 'trash';
  const smart = view.kind === 'smart';
  const shown = useMemo(() => {
    const k = kind === 'any' ? items : items.filter((i) => i.kind === kind);
    if (timeline) {
      const dir = sort === 'oldest' ? 1 : -1;
      return [...k].sort((a, b) => dir * (a.takenAt - b.takenAt) || dir * (a.id - b.id)).map((i) => ({ ...i, key: String(i.id), added: i.importedAt }));
    }
    if (inTrash || smart || view.kind === 'similar') return k.map((i) => ({ ...i, key: String(i.id), added: i.importedAt }));
    return sorted(k.map((i) => ({ ...i, key: String(i.id), added: i.importedAt })), sort);
  }, [items, kind, sort, timeline, inTrash, smart, view.kind]);
  const groups = useMemo(() => (timeline ? monthGroups(shown.map((i) => i.takenAt)) : undefined), [timeline, shown]);
  // Faces of the items shown, for face boxes and face-aware tiles.
  const wantFaces = faceBoxesOn || look.faceCrop;
  const faceKey = wantFaces ? shown.filter((i) => i.kind === 'image' || i.kind === 'gif').map((i) => i.id).join(',') : '';
  useEffect(() => {
    if (!faceKey) return;
    let live = true;
    const ids = faceKey.split(',').map(Number).filter((id) => !gridFaces.has(id));
    if (!ids.length) return;
    api.facesOfMany(ids.slice(0, 2000)).then((res) => {
      if (!live) return;
      setGridFaces((m) => {
        const n = new Map(m);
        for (const id of ids) if (!n.has(id)) n.set(id, []);
        for (const [id, f] of res) n.set(id, f);
        return n;
      });
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [faceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sidebar tree, every level sorted the same way; folder cards sorted by the Sort menu.
  const tree = useMemo(() => sortTree(folders, sideSort, fprefs.opened), [folders, sideSort, fprefs.opened]);
  const cards = useMemo(() => {
    if (view.kind !== 'folders') return sortFolders(subfolders, cardSort, fprefs.opened);
    if (!everyFolder) return sortFolders(folders.filter((f) => f.parentId === null), cardSort, fprefs.opened);
    return cardSort === 'own' ? folders : sortFolders(folders, cardSort, fprefs.opened);
  }, [view.kind, subfolders, folders, everyFolder, cardSort, fprefs.opened]);
  const pinned = useMemo(() => sortPinned(folders.filter((f) => f.pinned), sideSort, fprefs.pins, fprefs.opened), [folders, sideSort, fprefs.pins, fprefs.opened]);
  const selIds = [...selected];
  const allSelected = shown.length > 0 && shown.every((i) => selected.has(i.id));
  /** Everything shown here: the folder cards and the items (not the folder you are in). */
  function selectAll() {
    if (view.kind === 'lookalikes') return setLookTick((t) => t + 1); // mark all but the best again
    setSelFolders(new Set(inTrash ? [] : cards.map((f) => f.id)));
    if (!gridView || !shown.length) return setSelected(new Set());
    setSelected(new Set(shown.map((i) => i.id)));
    setAnchor(shown[0].id);
  }
  const gridView = !['folders', 'stats', 'people', 'lookalikes', 'memories'].includes(view.kind);
  const looks = view.kind === 'lookalikes';

  /** The item the viewer was opened on, and the element it grew from (for coming back). */
  const opened = useRef<{ id: number; el: HTMLElement | null } | null>(null);
  const markOpen = (id: number | undefined, auto: boolean) => {
    opened.current = id != null && !auto ? { id, el: sourceElement(id) } : null;
    return id != null && !auto ? openRect(id) : undefined;
  };
  const playList = (list: Item[], auto: boolean, startId?: number, title = viewTitle(view, folder)) => {
    if (!list.length) return;
    const fromRect = markOpen(startId, auto);
    nav.go({
      name: 'viewer',
      items: list.map(fromItem),
      startKey: startId != null ? `v${startId}` : undefined,
      title,
      auto,
      back: view,
      order: timeline ? undefined : sort,
      fromRect,
      person: view.kind === 'folder' && folder?.person ? folder.id : view.kind === 'timeline' ? view.person
        : view.kind === 'search' && view.people?.length === 1 ? view.people[0] : null,
    });
  };
  // Closing the viewer: bring the item's tile into view (instantly, still under
  // the viewer) and select it, and say where it is so the picture can shrink into it.
  const closeReveal = useRef<(id: number) => ReturnType<typeof visibleRect>>(() => null);
  closeReveal.current = (id) => {
    const o = opened.current;
    let rect = gridView ? revealInGrid(id) : null;
    if (!rect) {
      // Not in the media grid (People page, look-alikes…): the tile it was opened from, if it is that item.
      const el = o?.id === id && o.el?.isConnected ? o.el : sourceElement(id);
      el?.scrollIntoView({ block: 'nearest' });
      rect = visibleRect(el ?? null);
    }
    if (gridView && shown.some((i) => i.id === id)) {
      const p = returnPick(selected, o?.id ?? null, id);
      if (p) {
        setSelected(p.selected);
        setAnchor(p.anchor);
        setCursor(p.cursor);
        setSelFolders(new Set());
      }
    }
    return rect;
  };
  useEffect(() => {
    setLibraryReveal((id) => closeReveal.current(id));
    return () => setLibraryReveal(null);
  }, []);
  // While frozen: grid videos are paused where they are, folder cards stop cycling.
  useEffect(() => {
    const el = root.current;
    if (!frozen || !el) return;
    setHoverCard(null);
    const paused = [...el.querySelectorAll('video')].filter((v) => !v.paused);
    paused.forEach((v) => v.pause());
    return () => paused.forEach((v) => { if (v.isConnected) v.play().catch(() => {}); });
  }, [frozen]);

  const playItems = (auto: boolean, startId?: number, onlySelected = false) => {
    const list = onlySelected && selected.size > 1 ? shown.filter((i) => selected.has(i.id)) : shown;
    playList(list, auto, startId);
  };

  /**
   * Open an item with its own folder as the playlist. `stay`: going back returns
   * to this view as it was (the People page); otherwise to the item's folder.
   */
  const openInFolder = async (it: Item, stay = false) => {
    try {
      const fromRect = stay ? markOpen(it.id, false) : undefined;
      const list = await api.queryItems({ folder: it.folderId });
      const name = it.folderId == null ? 'Top level' : folders.find((f) => f.id === it.folderId)?.name ?? 'Folder';
      nav.go({ name: 'viewer', items: list.map(fromItem), startKey: `v${it.id}`, title: name, auto: false, back: stay ? view : { kind: 'folder', id: it.folderId }, fromRect });
    } catch (e) {
      setError(errText(e));
    }
  };
  const randomJourney = async () => {
    try {
      const p = await api.randomJourney();
      if (!p) return setError('Nothing to visit yet — import some pictures or videos first.');
      openInFolder({ id: p.item, folderId: p.folder } as Item);
    } catch (e) {
      setError(errText(e));
    }
  };

  const openFolder = (id: number | null) => setView({ kind: 'folder', id });
  /** The "›" in the folder path: the folders at that level, to jump sideways. */
  const crumbJump = (e: React.MouseEvent, parent: number | null) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const kids = folders.filter((f) => f.parentId === parent);
    setCtx({ x: r.left, y: r.bottom + 4, title: parent == null ? 'Top level' : folders.find((f) => f.id === parent)?.name ?? 'Folders',
      items: kids.length ? kids.map((f) => ({ label: f.name, checked: view.kind === 'folder' && view.id === f.id, hint: f.items ? f.items.toLocaleString() : undefined, onSelect: () => openFolder(f.id) }))
        : [{ label: 'No folders here', disabled: true, onSelect: () => {} }] });
  };
  /** Open an item's folder with the item highlighted. */
  const showInFolder = (it: Item) => {
    setView({ kind: 'folder', id: it.folderId });
    showItem(it.id);
  };
  /** Shift + middle-click a folder: play it as a slideshow. */
  const playFolder = async (f: FolderCard) => {
    const list = await api.queryItems({ folder: f.id, recursive: true });
    if (list.length) nav.go({ name: 'viewer', items: list.map(fromItem), title: f.name, auto: true, back: view, person: f.person ? f.id : null });
    else setNote({ text: `“${f.name}” is empty`, at: 0 });
  };
  const middle = (f: FolderCard) => ({
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 1) e.preventDefault(); // no auto-scroll
    },
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        // Middle-click opens it in a new tab; Shift + middle-click plays it.
        if (e.shiftKey || !tabs) playFolder(f);
        else tabs.open({ kind: 'folder', id: f.id });
      }
    },
  });
  // Type to jump: the first folder card or item whose name starts with what you type.
  const jumpBuf = useRef({ text: '', at: 0 });
  const typeJump = (k: string) => {
    const now = Date.now();
    const b = jumpBuf.current;
    b.text = now - b.at > 900 ? k : b.text + k;
    b.at = now;
    const q = foldName(b.text);
    const card = cards.find((f) => foldName(f.name).startsWith(q));
    if (card) {
      // Selected, like an item you jump to (the ring shows where you are).
      document.querySelector<HTMLElement>(`[data-card="${card.id}"]`)?.scrollIntoView({ block: 'nearest' });
      setSelected(new Set());
      setSelFolders(new Set([card.id]));
      setFolderAnchor(card.id);
      return;
    }
    const it = shown.find((i) => foldName(i.name).startsWith(q));
    if (it) {
      setSelFolders(new Set());
      setSelected(new Set([it.id]));
      setAnchor(it.id);
      setCursor(it.id);
      showItem(it.id);
    }
  };
  const folderMenu = (f: FolderCard): MenuItem[] => [
    { label: 'Open', onSelect: () => openFolder(f.id) },
    ...(tabs ? [{ label: 'Open in new tab', hint: 'middle-click', onSelect: () => tabs.open({ kind: 'folder', id: f.id }) }] : []),
    { label: 'Slideshow', onSelect: async () => {
      const list = await api.queryItems({ folder: f.id, recursive: true });
      if (list.length) nav.go({ name: 'viewer', items: list.map(fromItem), title: f.name, auto: true, back: view, person: f.person ? f.id : null });
    } },
    { label: 'Walk through as a museum', hint: '3D', onSelect: () => openFolderMuseum(f, (text) => setNote({ text, at: 0 })) },
    { label: f.pinned ? 'Unpin from the top' : 'Pin to the top', sepBefore: true, onSelect: () => setPinned(f, !f.pinned) },
    { label: 'Colour and emoji…', onSelect: () => setDialog({ t: 'look', folder: f }) },
    { label: 'Choose cover…', onSelect: () => setDialog({ t: 'cover', folder: f }) },
    { label: 'Add tag…', onSelect: () => setDialog({ t: 'folderTag', folder: f }) },
    { label: 'Person folder', hint: 'face recognition', checked: f.person, sepBefore: true, onSelect: () => setPersonFolder(f, !f.person) },
    { label: 'Scan for faces', onSelect: () => scanFaces({ folder: f.id }, f.name) },
    ...(f.person ? [{ label: 'Person timeline', hint: 'by date', onSelect: () => setView({ kind: 'timeline', person: f.id }) }] : []),
    { label: 'Find look-alikes in here', onSelect: () => setView({ kind: 'lookalikes', folder: f.id }) },
    { label: 'Quick sort', hint: 'send items to folders fast', sepBefore: true, onSelect: () => setDialog({ t: 'quickSort', folder: f }) },
    { label: 'Speed round', hint: 'favourite fast', onSelect: () => startSpeedRound(f) },
    { label: 'Duel', hint: 'pick favourites, set weights', onSelect: () => startDuel(f) },
    { label: 'Slot machine', hint: 'feeling lucky?', onSelect: () => setDialog({ t: 'slots', folder: f }) },
    { label: 'Note…', hint: f.note ? 'has a note' : undefined, onSelect: () => setDialog({ t: 'note', folder: true, id: f.id, name: f.name, note: f.note }) },
    { label: 'Share as encrypted .7z…', sepBefore: true, onSelect: () => setDialog({ t: 'share', ids: [], folders: [f.id], what: `“${f.name}”` }) },
    { label: 'Export decrypted…', onSelect: () => setDialog({ t: 'export', request: { folder: f.id }, what: `“${f.name}”` }) },
    { label: 'New folder inside…', sepBefore: true, onSelect: () => setDialog({ t: 'newFolder', parent: f.id }) },
    { label: 'Rename…', hint: 'F2', onSelect: () => renameFolderAsk(f) },
    { label: 'Move to…', onSelect: () => setDialog({ t: 'moveFolder', folder: f }),
      sub: moveSub((to) => { moveFolder(f, to.id).catch((err) => setError(errText(err))); }, [f.id, ...(f.parentId != null ? [f.parentId] : [])]) },
    { label: 'Extract here', hint: 'contents move up', onSelect: () => extractHere(f) },
    { label: 'Delete…', danger: true, sepBefore: true, onSelect: () => setDialog({ t: 'deleteFolder', folder: f }) },
  ];

  const setPersonFolder = (f: FolderCard, on: boolean) => act(async () => {
    await api.setPersonFolder(f.id, on);
    did(on ? `“${f.name}” is now a person folder` : `“${f.name}” is no longer a person folder`, () => api.setPersonFolder(f.id, !on));
    if (on) {
      const n = await api.facesQueue({ folder: f.id });
      kickFaceScanner();
      if (n) setNote({ text: `Scanning ${plural(n, 'item')} in “${f.name}” for faces. See People.`, at: 0 });
    }
  });
  const scanFaces = async (req: { ids?: number[]; folder?: number }, what: string) => {
    try {
      const n = await api.facesQueue(req);
      kickFaceScanner();
      setNote({ text: n ? `Scanning ${plural(n, 'item')} in ${what} for faces. Results appear in People.` : `${what} has been scanned already.`, at: 0 });
    } catch (e) {
      setError(errText(e));
    }
  };

  // ---- one selection of folders and items ----------------------------------------------

  /**
   * Everything a media action should touch: the selected items plus every item inside
   * the selected folders (and their subfolders). Selected items come first, in the
   * order shown.
   */
  const selectedMedia = async (): Promise<Item[]> => {
    const out = new Map<number, Item>();
    for (const it of shown) if (selected.has(it.id)) out.set(it.id, it);
    for (const id of selected) if (!out.has(id)) { const it = itemById(id); if (it) out.set(id, it); }
    for (const f of topMost(selFolders)) {
      for (const it of await api.queryItems({ folder: f.id, recursive: true })) {
        if (!out.has(it.id)) out.set(it.id, it);
        known.current.set(it.id, it);
      }
    }
    return [...out.values()];
  };
  /** Run a media action on the selection; folders count as all the items inside them. */
  const onMedia = (fn: (list: Item[]) => unknown) => async () => {
    try {
      const list = await selectedMedia();
      if (!list.length) return setNote({ text: 'There is nothing inside the selected folders.', at: 0 });
      await fn(list);
    } catch (e) {
      setError(errText(e));
    }
  };
  /** Move folders and items to the same place, undone together. */
  const moveMixed = async (fs: FolderCard[], ids: number[], target: number | null) => {
    const movedFolders = fs.filter((f) => f.parentId !== target);
    const before = groupBy(ids, (id) => itemById(id)?.folderId ?? null);
    bumpMoveStat(target);
    for (const f of movedFolders) await api.moveFolder(f.id, target);
    if (ids.length) await api.moveItems(ids, target);
    const name = target === null ? 'Top level' : folders.find((f) => f.id === target)?.name ?? 'folder';
    const what = [movedFolders.length ? plural(movedFolders.length, 'folder') : '', ids.length ? plural(ids.length, 'item') : ''].filter(Boolean).join(' and ');
    did(`Moved ${what} to “${name}”`, async () => {
      for (const f of movedFolders) await api.moveFolder(f.id, f.parentId);
      for (const [f, g] of before) await api.moveItems(g, f);
    });
    setSelFolders(new Set());
    setSelected(new Set());
    await reload();
  };

  /** F2: rename what is selected (folders in tree order, then items as shown). */
  const askRename = () => {
    if (inTrash || looks) return;
    const fs = folders.filter((f) => selFolders.has(f.id));
    const its = [...shown.filter((i) => selected.has(i.id)), ...[...selected].filter((id) => !shown.some((i) => i.id === id)).map(itemById).filter((i): i is Item => !!i)];
    const entries: RenameEntry[] = [
      ...fs.map((f): RenameEntry => ({ kind: 'folder', id: f.id, name: f.name })),
      ...its.map((i): RenameEntry => ({ kind: 'item', id: i.id, name: i.name, ext: i.ext })),
    ];
    if (entries.length) setDialog({ t: 'renameMany', entries });
  };
  const renameFolderAsk = (f: FolderCard) => setDialog({ t: 'renameMany', entries: [{ kind: 'folder', id: f.id, name: f.name }] });
  const doRename = async (changes: { entry: RenameEntry; name: string }[]) => {
    const pick = (k: 'folder' | 'item', fromNew: boolean) =>
      changes.filter((c) => c.entry.kind === k).map((c): [number, string] => [c.entry.id, fromNew ? c.name : c.entry.name]);
    await api.renameMany(pick('folder', true), pick('item', true));
    did(changes.length === 1 ? `Renamed “${changes[0].entry.name}” to “${changes[0].name}”` : `Renamed ${plural(changes.length, 'thing')}`,
      () => api.renameMany(pick('folder', false), pick('item', false)));
    await reload();
    nav.refresh().catch(() => {});
  };

  // ---- rubber-band selection: drag a box in empty space -------------------------------------
  const rubberBand = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('button, a, input, select, textarea, [data-item], [data-card], .dropzone, .looks, .memories, .menu, [role=dialog]')) return;
    const sc = scroller.current;
    if (!sc) return;
    // Not on the scrollbar.
    const sr = sc.getBoundingClientRect();
    if (e.clientX > sr.left + sc.clientWidth) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const startSel = new Set(additive ? selected : []);
    const startFolders = new Set(additive ? selFolders : []);
    const x0 = e.clientX;
    const y0 = e.clientY + sc.scrollTop;
    let box: HTMLDivElement | null = null;
    const move = (ev: PointerEvent) => {
      const y1 = ev.clientY + sc.scrollTop;
      if (!box && Math.hypot(ev.clientX - x0, y1 - y0) < 6) return;
      if (!box) {
        box = document.createElement('div');
        box.className = 'rubber';
        document.body.appendChild(box);
      }
      const top = Math.min(y0, y1) - sc.scrollTop;
      const r = { left: Math.min(x0, ev.clientX), top, right: Math.max(x0, ev.clientX), bottom: top + Math.abs(y1 - y0) };
      Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
      // Scroll when the box reaches the edge.
      if (ev.clientY > sr.bottom - 30) sc.scrollTop += 20;
      else if (ev.clientY < sr.top + 30) sc.scrollTop -= 20;
      const hit = (el: Element) => {
        const b = el.getBoundingClientRect();
        return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
      };
      const its = [...sc.querySelectorAll<HTMLElement>('[data-item]')].filter(hit).map((el) => Number(el.dataset.item));
      const fs = [...sc.querySelectorAll<HTMLElement>('[data-card]')].filter(hit).map((el) => Number(el.dataset.card));
      setSelected(bandPick(startSel, its, true));
      setSelFolders(bandPick(startFolders, fs, true));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box?.remove();
      if (!box && !additive) {
        // A plain click on empty space clears the selection.
        setSelected(new Set());
        setSelFolders(view.kind === 'folder' && view.id != null ? new Set([view.id]) : new Set());
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- cut, copy, paste, free copies, merging, notes -------------------------------------

  /** Ctrl+X / Ctrl+C: remember what is selected; Ctrl+C also offers it to Windows (desktop, Explorer). */
  const clipSelection = (mode: 'cut' | 'copy') => {
    if (inTrash || looks) return;
    const fs = topMost(selFolders).map((f) => f.id);
    const ids = [...selected];
    if (!fs.length && !ids.length) return;
    setClipboard({ mode, ids, folders: fs });
    const what = [fs.length ? plural(fs.length, 'folder') : '', ids.length ? plural(ids.length, 'item') : ''].filter(Boolean).join(' and ');
    setNote({ text: mode === 'cut' ? `Cut ${what}: open a folder and press Ctrl+V to move them there` : `Copied ${what}: Ctrl+V pastes them into another folder (or on the desktop)`, at: 0 });
    if (mode === 'copy' && inTauri) copyOut(ids, fs).catch(() => {});
  };
  /** Where Ctrl+V puts things: a selected folder card / sidebar folder, else the folder you're in. */
  const pasteTarget = (): number | null | undefined => {
    if (selFolders.size === 1 && !selected.size) {
      const [id] = selFolders;
      return id;
    }
    if (view.kind === 'folder') return view.id;
    if (view.kind === 'folders') return null;
    return undefined;
  };
  const paste = async () => {
    const t = pasteTarget();
    // Files or a picture copied outside the app are imported.
    if (inTauri) {
      const p = await readPaste().catch(() => null);
      if (p && !p.ours && (p.files.length || p.picture)) {
        const to = t === undefined ? null : t;
        if (p.files.length) await beginImport(p.files, to);
        else if (p.picture) {
          const id = await savePastedPicture(to, p.picture);
          did('Pasted a picture', () => api.deleteItems([id]));
          kickThumbnails();
          await reload();
        }
        return;
      }
    }
    if (!clipboard) return;
    if (t === undefined) {
      setNote({ text: 'Open a folder to paste into.', at: 0 });
      return;
    }
    const fs = folders.filter((f) => clipboard.folders.includes(f.id));
    if (clipboard.mode === 'cut') {
      if (t != null && fs.some((f) => f.id === t || folders.find((x) => x.id === t)?.path.some((c) => c.id === f.id))) {
        setError("A folder can't be moved into itself.");
        return;
      }
      await moveMixed(fs, clipboard.ids, t);
      setClipboard(null);
      return;
    }
    setNote({ text: 'Copying…', at: 0 });
    const r = await api.copyInto(clipboard.ids, clipboard.folders, t);
    const what = [r.folders.length ? plural(r.folders.length, 'folder') : '', r.items.length ? plural(r.items.length, 'item') : ''].filter(Boolean).join(' and ');
    did(`Copied ${what || 'nothing'}`, async () => {
      if (r.items.length) await api.deleteItems(r.items);
      for (const f of r.folders) await api.deleteFolder(f);
    });
    kickThumbnails();
    await reload();
    nav.refresh().catch(() => {});
  };
  const freeCopyTo = async (ids: number[], target: number | null) => {
    const made = await api.freeCopy(ids, target);
    const name = target === null ? 'Top level' : folders.find((f) => f.id === target)?.name ?? 'folder';
    bumpMoveStat(target);
    did(`Made ${plural(made.length, 'free copy', 'free copies')} in “${name}”`, async () => {
      await api.deleteItems(made);
      await api.deleteForever(made);
    });
    await reload();
  };
  /** Your most-used destination folders (the "Move to" submenu). */
  const topFolders = (n: number, except: number[] = []) => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    return Object.entries(moveStats.current)
      .map(([id, c]) => [Number(id), c] as const)
      .filter(([id]) => byId.has(id) && !except.includes(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id]) => byId.get(id)!);
  };
  const moveSub = (go: (f: FolderCard) => void, except: number[] = []): MenuItem[] =>
    topFolders(6, except).map((f) => ({ label: f.name, hint: f.path.map((c) => c.name).join(' › ') || undefined, onSelect: () => go(f) }));
  const finishMerge = async (m: Merged, target: FolderCard, sources: FolderCard[]) => {
    did(`Merged ${plural(sources.length, 'folder')} into “${target.name}”`, () => api.unmergeFolders(m));
    if (view.kind === 'folder' && sources.some((f) => f.id === view.id || folder?.path.some((c) => c.id === f.id))) setView({ kind: 'folder', id: target.id });
    else await reload();
    setSelFolders(new Set());
    nav.refresh().catch(() => {});
  };
  const saveNote = async (isFolder: boolean, id: number, name: string, note: string | null) => {
    const old = await api.setNote(isFolder, id, note);
    did(note ? `Saved the note on “${name}”` : `Removed the note on “${name}”`, () => api.setNote(isFolder, id, old));
    await reload();
  };
  const showCopies = async (it: Item) => {
    const list = await api.itemCopies(it.id);
    setDialog({ t: 'copies', item: it, list });
  };
  const askDragOut = () => new Promise<boolean>((resolve) => setDialog({ t: 'dragOut', resolve }));
  const dragOut = (e: React.PointerEvent, ids: number[], fs: number[]) => {
    if (!inTauri || e.button !== 0) return;
    maybeDragOut(e.nativeEvent, ids, fs, askDragOut).then((r) => {
      if (r === 'confirmed') setNote({ text: 'Now drag them out of the window again to copy them.', at: 0 });
      else if (r === 'copied') setNote({ text: 'Copied out of the vault.', at: 0 });
      else if (r === 'error') setError(lastDragOutError());
    }).catch(() => {});
  };
  const pictures = (list: Item[]) => list.filter((i) => i.kind === 'image' || i.kind === 'gif');
  const visualItems = (list: Item[]) => list.filter((i) => i.kind === 'image' || i.kind === 'gif' || i.kind === 'video');
  const startSpeedRound = async (f: FolderCard | null, list?: Item[]) => {
    const items = pictures(list ?? (await api.queryItems({ folder: f?.id ?? null, recursive: true })));
    if (!items.length) return setNote({ text: 'No pictures to go through here.', at: 0 });
    nav.go({ name: 'viewer', items: items.map(fromItem), title: `Speed round · ${f?.name ?? viewTitle(view, folder)}`, auto: true, back: view, speedRound: true });
  };
  const startDuel = async (f: FolderCard | null, list?: Item[]) => {
    const items = visualItems(list ?? (await api.queryItems({ folder: f?.id ?? null, recursive: true })));
    if (items.length < 2) return setNote({ text: 'Duels need at least two pictures.', at: 0 });
    setDialog({ t: 'duel', items });
  };

  // ---- several folders ----------------------------------------------------------------

  /** Only the outermost of the selected folders (a subfolder goes along with its parent). */
  const topMost = (ids: Iterable<number>): FolderCard[] => {
    const set = new Set(ids);
    return folders.filter((f) => set.has(f.id) && !f.path.some((c) => set.has(c.id)));
  };
  /**
   * Click on a folder: select it (and, in the sidebar, open it). Ctrl adds or removes it,
   * Shift selects a range. A plain click starts a new selection, like a plain click on an item.
   */
  const folderClick = (e: React.MouseEvent, f: FolderCard, list: FolderCard[], openIt: boolean) => {
    // The same rule as items (selection.ts); a plain click also clears the items and, in the sidebar, opens it.
    const p = folderPick(list.map((x) => x.id), selFolders, folderAnchor, f.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    setSelFolders(p.selected);
    setFolderAnchor(p.anchor);
    if (p.additive) return;
    setSelected(new Set());
    if (openIt) openFolder(f.id);
  };
  /** Where to go when the folder on screen (or one above it) is deleted: the deleted folder's parent. */
  const leaveDeleted = (fs: FolderCard[]): boolean => {
    if (view.kind !== 'folder') return false;
    const gone = fs.find((f) => f.id === view.id || folder?.path.some((c) => c.id === f.id));
    if (!gone) return false;
    setView(gone.parentId == null ? { kind: 'folders' } : { kind: 'folder', id: gone.parentId });
    return true;
  };
  const askDeleteMany = () => {
    const fs = topMost(selFolders);
    if (!fs.length && !selected.size) return;
    setDialog({ t: 'deleteMany', folders: fs, items: [...selected] });
  };
  const deleteMany = async (fs: FolderCard[], items: number[], links: CopyLinks[] = []) => {
    for (const f of fs) await api.deleteFolder(f.id);
    if (items.length) await api.deleteItems(items);
    const what = [fs.length ? plural(fs.length, 'folder') : '', items.length ? plural(items.length, 'item') : ''].filter(Boolean).join(' and ');
    did(`Moved ${what} to the trash`, async () => {
      for (const f of fs) await api.restoreFolder(f.id);
      if (items.length) await api.restoreItems(items);
      for (const l of links) await api.restoreLinks(l);
    });
    setSelFolders(new Set());
    setSelected(new Set());
    if (!leaveDeleted(fs)) await reload();
    nav.refresh().catch(() => {});
  };
  const moveFolders = async (fs: FolderCard[], parent: number | null) => {
    const done: FolderCard[] = [];
    try {
      for (const f of fs) {
        if (f.parentId === parent) continue;
        await api.moveFolder(f.id, parent);
        done.push(f);
      }
    } finally {
      if (done.length) {
        did(done.length === 1 ? `Moved “${done[0].name}”` : `Moved ${plural(done.length, 'folder')}`, async () => {
          for (const f of done) await api.moveFolder(f.id, f.parentId);
        });
      }
      setSelFolders(new Set());
      await reload();
    }
  };
  /** "Extract here": everything inside goes up one level; then ask about the empty folder. */
  const extractHere = async (f: FolderCard) => {
    try {
      const x = await api.extractFolder(f.id);
      setDialog({ t: 'extracted', folder: f, x });
      await reload();
    } catch (err) {
      setError(errText(err));
    }
  };
  const finishExtract = async (f: FolderCard, x: Extracted, remove: boolean) => {
    if (remove) await api.deleteFolder(f.id);
    const n = x.items.length + x.folders.length;
    did(`Extracted “${f.name}” (${plural(n, 'thing')} moved up)${remove ? ' and removed it' : ''}`, async () => {
      if (remove) await api.restoreFolder(f.id);
      await api.unextractFolder(f.id, x);
    });
    if (remove && view.kind === 'folder' && view.id === f.id) setView(x.parent == null ? { kind: 'folders' } : { kind: 'folder', id: x.parent });
    else await reload();
    nav.refresh().catch(() => {});
  };

  /** Drag a folder (sidebar, pinned list or card) onto another folder or Top level. */
  const startFolderDrag = (e: React.PointerEvent, f: FolderCard) => {
    // Dragging one of several selected folders moves them all.
    const group = selFolders.has(f.id) && selFolders.size > 1 ? topMost(selFolders) : [f];
    const what = group.length > 1 ? plural(group.length, 'folder') : `“${f.name}”`;
    startMoveDrag(e, {
      label: (t) => {
        if (!t) return what;
        const to = targetFolder(t);
        return `Move ${what} into ${to === null ? 'Top level' : `“${folders.find((x) => x.id === to)?.name ?? 'folder'}”`}`;
      },
      canDrop: (t) => {
        const to = targetFolder(t);
        if (group.every((g) => g.parentId === to)) return false;
        if (to === null) return true;
        const target = folders.find((x) => x.id === to);
        return !!target && group.every((g) => g.id !== to && !target.path.some((c) => c.id === g.id));
      },
      edges: true,
      onDrop: (t, edge, order) => {
        const to = targetFolder(t);
        if (edge && to != null) {
          (order?.startsWith('pin:') ? reorderPins(group, to, edge) : reorderFolders(group, to, edge)).catch((err) => setError(errText(err)));
          return;
        }
        if (group.length === 1) moveFolder(f, to).catch((err) => setError(errText(err)));
        else moveFolders(group, to).catch((err) => setError(errText(err)));
      },
    });
    dragOut(e, [], group.map((g) => g.id));
  };
  /**
   * Dragging to arrange only makes sense in your own order: while another sort is on,
   * switch to your own order, starting from what you see now. Returns how to undo that.
   */
  const ownOrderFirst = async (): Promise<(() => Promise<void>) | null> => {
    if (sideSort === 'own') return null;
    const was = sideSort;
    const wasPins = fprefs.pins;
    const before = await api.setFolderOrder(tree.map((f) => f.id));
    fprefs.setPins(pinned.map((f) => f.id));
    fprefs.setSide('own');
    return async () => {
      await api.restoreFolderOrder(before);
      fprefs.setPins(wasPins);
      fprefs.setSide(was);
    };
  };
  const switchedText = (what: string, switched: boolean) => (switched ? `${what} · switched to your own order` : what);
  /** Drop on a folder's top or bottom edge: put the dragged folders before / after it. */
  const reorderFolders = async (group: FolderCard[], targetId: number, edge: 'before' | 'after') => {
    const target = folders.find((x) => x.id === targetId);
    if (!target || group.some((g) => g.id === targetId)) return;
    if (group.some((g) => target.path.some((c) => c.id === g.id))) {
      setError("A folder can't be moved into itself.");
      return;
    }
    const unseed = await ownOrderFirst();
    const parent = target.parentId;
    const moving = group.filter((g) => g.parentId !== parent);
    for (const g of moving) await api.moveFolder(g.id, parent);
    // Siblings as you see them (after switching, your own order is what you saw).
    const siblings = tree.filter((x) => x.parentId === parent).map((x) => x.id);
    const order = placeIds(siblings, group.map((g) => g.id), targetId, edge);
    const before = await api.setFolderOrder(order);
    const label = group.length === 1 ? `Moved “${group[0].name}”` : `Moved ${plural(group.length, 'folder')}`;
    did(switchedText(label, !!unseed), async () => {
      await api.restoreFolderOrder(before);
      for (const g of moving) await api.moveFolder(g.id, g.parentId);
      if (unseed) await unseed();
    });
    await reload();
    nav.refresh().catch(() => {});
  };
  /** Drop on a pinned folder's edge: arrange the pinned list (pinning what wasn't pinned yet). */
  const reorderPins = async (group: FolderCard[], targetId: number, edge: 'before' | 'after') => {
    if (group.some((g) => g.id === targetId)) return;
    const unseed = await ownOrderFirst();
    const wasPins = unseed ? pinned.map((f) => f.id) : fprefs.pins;
    const current = pinned.map((f) => f.id);
    const newlyPinned = group.filter((g) => !g.pinned);
    for (const g of newlyPinned) await api.setPinned(g.id, true);
    fprefs.setPins(placeIds(current, group.map((g) => g.id), targetId, edge));
    const label = newlyPinned.length ? `Pinned ${group.length === 1 ? `“${group[0].name}”` : plural(group.length, 'folder')}` : 'Arranged the pinned folders';
    did(switchedText(label, !!unseed), async () => {
      for (const g of newlyPinned) await api.setPinned(g.id, false);
      fprefs.setPins(wasPins);
      if (unseed) await unseed();
    });
    if (newlyPinned.length) await reload();
  };

  const folderContext = (e: React.MouseEvent, f: FolderCard) => {
    e.preventDefault();
    if (selFolders.has(f.id) && selFolders.size > 1) {
      const fs = topMost(selFolders);
      setCtx({ x: e.clientX, y: e.clientY, title: plural(fs.length, 'folder'), items: [
        { label: `Move ${plural(fs.length, 'folder')} to…`, onSelect: () => setDialog({ t: 'moveFolders', folders: fs }),
          sub: moveSub((to) => { moveFolders(fs, to.id).catch((err) => setError(errText(err))); }, fs.map((x) => x.id)) },
        { label: `Merge into one…`, hint: 'asks first', onSelect: () => setDialog({ t: 'merge', folders: fs }) },
        { label: `Rename ${plural(selFolders.size, 'folder')}…`, hint: 'F2', onSelect: askRename },
        { label: 'Share as encrypted .7z…', sepBefore: true, onSelect: () => setDialog({ t: 'share', ids: [], folders: fs.map((x) => x.id), what: plural(fs.length, 'folder') }) },
        { label: `Delete ${plural(fs.length, 'folder')}…`, danger: true, sepBefore: true, onSelect: askDeleteMany },
      ] });
      return;
    }
    setCtx({ x: e.clientX, y: e.clientY, title: f.name, items: folderMenu(f) });
  };

  const itemContext = (e: React.MouseEvent, it: Item) => {
    // Right-clicking outside the selection selects just that item.
    let sel = selected;
    if (!selected.has(it.id)) {
      sel = new Set([it.id]);
      setSelected(sel);
      setAnchor(it.id);
      setCursor(it.id);
      setSelFolders(new Set());
    }
    const ids = [...sel];
    const many = ids.length > 1;
    if (inTrash) {
      setCtx({ x: e.clientX, y: e.clientY, title: many ? `${ids.length} items` : it.name, items: [
        { label: 'Open', onSelect: () => playItems(false, it.id) },
        { label: many ? `Restore ${ids.length} items` : 'Restore', onSelect: () => restoreItems(ids) },
        { label: 'Delete for good…', danger: true, sepBefore: true, onSelect: () => setDialog({ t: 'forever', ids, folder: null, what: many ? `${ids.length} items` : `“${it.name}”` }) },
      ] });
      return;
    }
    const allFav = ids.every((id) => itemById(id)?.favourite);
    const home = it.folderId != null ? folders.find((f) => f.id === it.folderId) : null;
    setCtx({
      x: e.clientX,
      y: e.clientY,
      title: many ? `${ids.length} items` : it.name,
      items: [
        { label: 'Open', onSelect: () => playItems(false, it.id) },
        { label: many ? 'Play these as a slideshow' : 'Slideshow from here', onSelect: () => playItems(true, it.id, many) },
        ...(!many && !(view.kind === 'folder' && view.id === it.folderId) ? [{ label: 'Show in its folder', onSelect: () => showInFolder(it) }] : []),
        ...(!many && (view.kind === 'search' || view.kind === 'smart') ? [{ label: 'Why is this here?', hint: 'what matched', onSelect: () => setDialog({
          t: 'why', item: it, query: view.kind === 'smart' ? { kind: 'smart', q: view.q } : { kind: 'search', tags: view.tags, names: view.names, people: view.people ?? [] },
        }) }] : []),
        ...(!many && ['image', 'gif', 'video'].includes(it.kind) ? [{ label: 'Find similar', hint: smartOn ? 'smart search' : undefined, onSelect: () => { setView({ kind: 'similar', id: it.id, name: it.name }); showItem(it.id); } }] : []),
        { label: allFav ? 'Remove from favourites' : 'Add to favourites', sepBefore: true, onSelect: () => setFav(ids, !allFav) },
        { label: 'Tags…', onSelect: () => setDialog({ t: 'tagItems', ids }) },
        { label: 'Weight…', hint: `now ${it.weight}`, onSelect: () => setDialog({ t: 'weight', ids, current: it.weight }) },
        { label: 'Move to…', onSelect: () => setDialog({ t: 'moveItems', ids }),
          sub: moveSub((to) => { moveItems(ids, to.id).catch((err) => setError(errText(err))); }, it.folderId != null ? [it.folderId] : []) },
        { label: 'Free copy to…', hint: 'no extra space', onSelect: () => setDialog({ t: 'freeCopy', ids }),
          sub: moveSub((to) => { freeCopyTo(ids, to.id).catch((err) => setError(errText(err))); }) },
        ...(!many && it.linked ? [{ label: it.copyOf != null ? 'Show the original and other copies' : 'Show its free copies', onSelect: () => { showCopies(it).catch((err) => setError(errText(err))); } }] : []),
        { label: 'Rename…', hint: 'F2', onSelect: () => {
          const list = shown.filter((x) => sel.has(x.id));
          setDialog({ t: 'renameMany', entries: list.map((x): RenameEntry => ({ kind: 'item', id: x.id, name: x.name, ext: x.ext })) });
        } },
        ...(!many ? [{ label: 'Note…', hint: it.note ? 'has a note' : undefined, onSelect: () => setDialog({ t: 'note', folder: false, id: it.id, name: it.name, note: it.note }) }] : []),
        { label: 'Scan for faces', sepBefore: true, onSelect: () => scanFaces({ ids }, many ? `${ids.length} items` : `“${it.name}”`) },
        ...(it.thumb === 'failed' && it.kind === 'video' ? [{ label: 'Make a playable copy', hint: 'converts to MP4', onSelect: () => setDialog({ t: 'convert', items: [it], target: 'mp4' }) }] : []),
        { label: 'Convert to…', onSelect: () => setDialog({ t: 'convert', items: shown.filter((x) => sel.has(x.id)) }) },
        ...(pictures(shown.filter((x) => sel.has(x.id))).length >= 2 ? [{ label: 'Create GIF or video…', onSelect: () => setDialog({ t: 'animation', items: pictures(shown.filter((x) => sel.has(x.id))) }) }] : []),
        ...(many ? [{ label: 'Duel these', onSelect: () => { startDuel(null, shown.filter((x) => sel.has(x.id))); } }] : []),
        { label: 'Share as encrypted .7z…', sepBefore: true, onSelect: () => setDialog({ t: 'share', ids, folders: [], what: many ? `${ids.length} items` : `“${it.name}”` }) },
        { label: 'Export decrypted…', onSelect: () => setDialog({ t: 'export', request: { ids }, what: many ? `${ids.length} items` : `“${it.name}”` }) },
        ...(home && !many ? [{ label: `Use as cover of “${home.name}”`, onSelect: () => act(() => api.setCover(home.id, it.id)) }] : []),
        { label: many ? `Delete ${ids.length} items` : 'Delete', hint: 'to the trash', danger: true, sepBefore: true, onSelect: () => trashItems(ids) },
      ],
    });
  };

  // Living folder cards: hovering a card cycles through a few items inside.
  const cardIndex = useMemo(() => new Map(cards.map((c, i) => [c.id, i])), [cards]);
  useEffect(() => {
    if (hoverCard == null) return;
    const id = hoverCard;
    const t = setTimeout(() => {
      if (!samples[id]) api.folderSamples(id, 8).then((v) => setSamples((m) => ({ ...m, [id]: v }))).catch(() => {});
    }, 200);
    setCycle(0);
    const iv = setInterval(() => setCycle((c) => c + 1), 900);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, [hoverCard]); // eslint-disable-line react-hooks/exhaustive-deps

  const coverView = (f: FolderCard) => {
    const hovered = hoverCard === f.id;
    // Person folders: a round cover centred on the face; hovering opens it
    // into the card's square, and holding there cycles pictures from inside.
    if (f.person && f.cover) {
      const others = samples[f.id]?.filter((x) => x !== f.cover) ?? [];
      const cycling = hovered && others.length > 0 && cycle > 0 ? others[(cycle - 1) % others.length] : null;
      const before = hovered && others.length > 1 && cycle > 1 ? others[(cycle - 2) % others.length] : null;
      return <span className={`pcard${hovered ? ' open' : ''}`}><RoundCover folder={f} bump={coverBump} open={hovered} cycle={cycling} before={before} /></span>;
    }
    const playing = preview === 'all' || (preview === 'hover' && hovered);
    const animated = f.coverKind === 'video' || f.coverKind === 'gif';
    if (f.cover && playing && animated) {
      const still = <img src={`${thumbUrl(f.cover)}?c=${coverBump}`} alt="" draggable={false} />;
      if (f.coverKind === 'video') return <>{still}<video src={mediaUrl(f.cover)} muted loop autoPlay playsInline preload="auto" /></>;
      return <img src={mediaUrl(f.cover)} alt="" draggable={false} />;
    }
    const list = samples[f.id];
    // Stacked card: two more pictures from inside peek out behind the cover;
    // hovering fans them out over the neighbouring cards (the mouse passes
    // through them), the front card grows a little and then cycles through
    // the folder. Cards in the first or last column fan less towards the edge.
    const behind = f.cover ? f.samples.filter((x) => x !== f.cover).slice(0, 2) : [];
    if (behind.length) {
      const others = list?.filter((x) => !behind.includes(x)) ?? [];
      const cycling = hovered && others.length > 1 && cycle > 0 ? others[(cycle - 1) % others.length] : null;
      // The picture before stays underneath while the next one fades in.
      const before = hovered && others.length > 1 && cycle > 1 ? others[(cycle - 2) % others.length] : null;
      const per = Math.max(1, cols - 1);
      const at = (cardIndex.get(f.id) ?? 0) % per;
      const edge = `${at === 0 ? ' edge-l' : ''}${at === per - 1 ? ' edge-r' : ''}`;
      return (
        <span className={`fstack${edge}`}>
          {behind.map((x, k) => <img key={x} className={`fstack-${k + 1}`} src={thumbUrl(x)} alt="" draggable={false} />)}
          <img className="fstack-top" src={`${thumbUrl(f.cover!)}?c=${coverBump}`} alt="" draggable={false} />
          {before != null && <img key={`b${before}`} className="fstack-top" src={thumbUrl(before)} alt="" draggable={false} />}
          {cycling != null && <img key={cycling} className="fstack-top cycle" src={thumbUrl(cycling)} alt="" draggable={false} />}
        </span>
      );
    }
    if (hovered && list && list.length > 1 && cycle > 0) {
      const id = list[(cycle - 1) % list.length];
      return <img key={id} className="cycle" src={thumbUrl(id)} alt="" draggable={false} />;
    }
    if (!f.cover) return <FolderIcon size={40} />;
    return <img src={`${thumbUrl(f.cover)}?c=${coverBump}`} alt="" draggable={false} />;
  };

  // ---- the top bar: your buttons in your order (right-click → Customise top bar) ----------
  const [topEdit, setTopEdit] = useState(false);
  const topButtons: Record<string, { label: string; node: React.ReactNode }> = {
    dice: { label: 'Random journey', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Random journey" title="Random journey: jump to a random item in a random folder" onClick={randomJourney}><DiceIcon /></button> },
    faces: { label: 'Face boxes', node: <button type="button" className={`btn btn-icon btn-sm${faceBoxesOn ? ' accent-soft' : ''}`} aria-pressed={faceBoxesOn} aria-label="Face boxes"
      title={faceBoxesOn ? 'Face boxes are on: squares and name tags around known faces. Click to turn off.' : 'Show squares and name tags around faces (in the grid and the viewer)'}
      onClick={() => setFaceBoxes(!faceBoxesOn)}><FaceIcon size={15} /></button> },
    preview: { label: 'Preview', node: <Dropdown label={`Preview: ${preview === 'all' ? 'all' : preview === 'hover' ? 'hover' : 'off'} ▾`} title="Play videos and GIFs in the grid (always muted)"
      items={[
        ...PREVIEWS.map((p) => ({ label: p.label, hint: p.hint, checked: p.id === preview, onSelect: () => saveCfg({ preview: p.id }) })),
        { label: 'Show the whole video on hover', hint: 'uncropped', checked: !!cfg.wholeOnHover, sepBefore: true,
          disabled: preview === 'off', onSelect: () => saveCfg({ wholeOnHover: !cfg.wholeOnHover }) },
      ]} /> },
    slideshow: { label: 'Slideshow', node: <button type="button" className="btn btn-sm" onClick={() => playItems(true)} disabled={!shown.length || inTrash}
      title="Play everything shown here as a slideshow"><PlayIcon size={14} /> Slideshow</button> },
    multi: { label: 'Multi-screen', node: <button type="button" className="btn btn-sm" onClick={() => nav.go({ name: 'multi', back: view })}><GridIcon /> Multi-screen</button> },
    import: { label: 'Import', node: <Dropdown className="btn btn-sm btn-primary" label={<><ImportIcon /> Import</>} items={[
      { label: 'Files or .7z archives…', onSelect: () => pickAndImport(false) },
      { label: 'Folders…', onSelect: () => pickAndImport(true) },
    ]} /> },
    tags: { label: 'Tags', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Tags" title="Tags: rename, merge, colour, delete" onClick={() => setDialog({ t: 'tags' })}><TagIcon /></button> },
    stats: { label: 'Statistics', node: <button type="button" className={`btn btn-icon btn-sm${view.kind === 'stats' ? ' accent-soft' : ''}`} aria-label="Statistics" title="Statistics"
      onClick={() => setView({ kind: 'stats' })}><ChartIcon /></button> },
    help: { label: 'Shortcuts', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Shortcuts" title="Keyboard and mouse shortcuts (?)" onClick={showHelp}><HelpIcon /></button> },
    settings: { label: 'Settings', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Settings" onClick={() => nav.go({ name: 'settings' })}><GearIcon /></button> },
    lock: { label: 'Lock', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Lock vault" title="Lock (Ctrl+Shift+L)" onClick={() => api.lock()}><LockIcon size={16} /></button> },
  };
  const TOP_DEFAULT = ['dice', 'faces', 'preview', 'slideshow', 'multi', 'import', 'stats', 'help', 'settings', 'lock'];
  const savedTop = (look.topBar ?? []).filter((k) => topButtons[k]);
  const topOrder = savedTop.length ? (savedTop.includes('settings') ? savedTop : [...savedTop, 'settings']) : TOP_DEFAULT;
  const setTopOrder = (list: string[]) => saveCfg({ look: { ...look, topBar: list } });
  const moveTop = (k: string, before: string) => {
    if (!k || k === before) return;
    const list = topOrder.filter((x) => x !== k);
    list.splice(Math.max(0, list.indexOf(before)), 0, k);
    setTopOrder(list);
  };
  const hiddenTop = Object.keys(topButtons).filter((k) => !topOrder.includes(k));

  // ---- the bottom bar: what is selected, and one set of actions for all of it ------------

  // Called as a function (not <SelectionBar />) so the bar keeps its state between renders.
  const selectionBar = () => {
    const fs = topMost(selFolders);
    const nF = fs.length;
    const nI = selected.size;
    const here = view.kind === 'folder' ? view.id : undefined;
    if (looks) {
      const bytes = items.filter((i) => selected.has(i.id)).reduce((a, i) => a + i.size, 0);
      return (
        <ActionBar summary={nI ? <><b>{plural(nI, 'picture')} marked</b> · {formatBytes(bytes)}</> : <span className="faint">Nothing marked</span>}
          actions={nI ? [
            { key: 'trash', label: `Move ${plural(nI, 'marked picture')} to the trash`, icon: <TrashIcon />, danger: true, pinned: true,
              title: 'Asks first · Ctrl+Z undoes it', onClick: () => setDialog({ t: 'deleteMany', folders: [], items: selIds }) },
          ] : []}
          end={<button type="button" className="link" onClick={() => setLookTick((t) => t + 1)} title="Mark everything but the best of each group again">Reset marks</button>} />
      );
    }
    if (!nF && !nI) {
      return (
        <ActionBar summary={<span className="faint">{gridView ? `${shown.length.toLocaleString()} items` : ''}{cards.length && !inTrash ? `${gridView ? ' · ' : ''}${plural(cards.length, 'folder')}` : ''}</span>}
          actions={[]}
          end={gridView && shown.length > 0 ? <button type="button" className="link" onClick={selectAll} title="Ctrl+A">Select all</button> : undefined} />
      );
    }
    const summary = nF === 1 && !nI ? <><b>“{fs[0].name}”</b> selected</>
      : <><b>{[nF ? plural(nF, 'folder') : '', nI ? plural(nI, 'item') : ''].filter(Boolean).join(' and ')}</b> selected</>;
    const clear = (
      <>
        {gridView && !allSelected && shown.length > nI && (
          <button type="button" className="link" onClick={selectAll} title="Ctrl+A">Select all {shown.length.toLocaleString()}</button>
        )}
        <button type="button" className="link" title="Esc" onClick={() => { setSelected(new Set()); setSelFolders(new Set()); }}>Clear</button>
      </>
    );
    if (inTrash) {
      return (
        <ActionBar summary={summary} end={clear} actions={[
          { key: 'restore', label: 'Restore', icon: <RestoreIcon />, onClick: () => restoreItems(selIds) },
          { key: 'forever', label: 'Delete for good', danger: true, pinned: true,
            onClick: () => setDialog({ t: 'forever', ids: selIds, folder: null, what: plural(selIds.length, 'item') }) },
        ]} />
      );
    }
    const itemsOnly = nF === 0;
    const allFav = itemsOnly && selIds.every((id) => itemById(id)?.favourite);
    const what = nF === 1 && !nI ? `“${fs[0].name}”` : [nF ? plural(nF, 'folder') : '', nI ? plural(nI, 'item') : ''].filter(Boolean).join(' and ');
    const actions: BarAction[] = [];
    if (nF === 1 && !nI && here !== fs[0].id) actions.push({ key: 'open', label: 'Open', icon: <FolderIcon size={14} />, title: 'Enter', onClick: () => openFolder(fs[0].id) });
    actions.push(
      { key: 'play', label: 'Play', icon: <PlayIcon size={13} />, title: 'Slideshow of everything selected (folders: everything inside)',
        onClick: onMedia((list) => {
          const first = itemsOnly ? selIds[0] : undefined;
          playList(list, true, first, nF === 1 && !nI ? fs[0].name : 'Selection');
        }) },
      { key: 'fav', label: allFav ? 'Unfavourite' : 'Favourite', icon: <HeartIcon size={14} />,
        onClick: onMedia((list) => setFav(list.map((i) => i.id), !list.every((i) => i.favourite))) },
      { key: 'tag', label: 'Tag…', icon: <TagIcon />, title: nF ? 'Tags every item inside the selected folders too' : undefined,
        onClick: onMedia((list) => setDialog({ t: 'tagItems', ids: list.map((i) => i.id) })) },
      { key: 'weight', label: 'Weight…', icon: <WeightIcon />,
        onClick: onMedia((list) => setDialog({ t: 'weight', ids: list.map((i) => i.id), current: list[0].weight ?? 1 })) },
      { key: 'move', label: 'Move to…', icon: <MoveIcon />,
        onClick: () => (itemsOnly ? setDialog({ t: 'moveItems', ids: selIds }) : setDialog({ t: 'moveMixed', folders: fs, ids: selIds })) },
      { key: 'export', label: 'Export…', icon: <ExportIcon />, title: 'Write unencrypted copies to a folder',
        onClick: nF === 1 && !nI
          ? () => setDialog({ t: 'export', request: { folder: fs[0].id }, what })
          : onMedia((list) => setDialog({ t: 'export', request: { ids: list.map((i) => i.id) }, what })) },
    );
    if (folder && itemsOnly && nI === 1) actions.push({ key: 'cover', label: 'Set as folder cover', onClick: () => act(() => api.setCover(folder.id, selIds[0])) });
    if (nF === 1 && !nI) {
      actions.push({ key: 'look', label: 'Colour and emoji…', onClick: () => setDialog({ t: 'look', folder: fs[0] }) });
    }
    actions.push({ key: 'rename', label: 'Rename…', title: 'F2', onClick: askRename });
    if (itemsOnly) actions.push({ key: 'free', label: 'Free copy to…', title: 'Copies that take no extra space', onClick: () => setDialog({ t: 'freeCopy', ids: selIds }) });
    if (nF >= 2 && !nI) actions.push({ key: 'merge', label: 'Merge…', onClick: () => setDialog({ t: 'merge', folders: fs }) });
    if (nF === 1 && !nI) actions.push({ key: 'qsort', label: 'Quick sort', onClick: () => setDialog({ t: 'quickSort', folder: fs[0] }) });
    if (nF === 1 && !nI) actions.push({ key: 'note', label: 'Note…', onClick: () => setDialog({ t: 'note', folder: true, id: fs[0].id, name: fs[0].name, note: fs[0].note }) });
    if (!nF && nI === 1) {
      const it = itemById(selIds[0]);
      if (it) actions.push({ key: 'note', label: 'Note…', onClick: () => setDialog({ t: 'note', folder: false, id: it.id, name: it.name, note: it.note }) });
    }
    actions.push({ key: 'share', label: 'Share as .7z…', title: 'A password-protected archive', onClick: () => setDialog({ t: 'share', ids: selIds, folders: fs.map((f) => f.id), what }) });
    actions.push({ key: 'convert', label: 'Convert…', onClick: onMedia((list) => setDialog({ t: 'convert', items: list })) });
    actions.push({ key: 'gif', label: 'Create GIF…', onClick: onMedia((list) => {
      const p = pictures(list);
      if (p.length < 2) setNote({ text: 'Select at least two pictures to make a GIF or video.', at: 0 });
      else setDialog({ t: 'animation', items: p });
    }) });
    actions.push({ key: 'speed', label: 'Speed round', title: 'Pictures flash by; press F to favourite', onClick: onMedia((list) => startSpeedRound(nF === 1 && !nI ? fs[0] : null, list)) });
    actions.push({ key: 'duel', label: 'Duel', title: 'Pick the better of two; sets the weights', onClick: onMedia((list) => startDuel(null, list)) });
    if (nF === 1 && !nI) actions.push({ key: 'slots', label: 'Slot machine', title: 'Spin three reels of pictures from this folder', onClick: () => setDialog({ t: 'slots', folder: fs[0] }) });
    actions.push({ key: 'museum', label: 'Walk through as a museum', title: 'A 3D gallery of these pictures',
      onClick: onMedia((list) => openMuseum(nF === 1 && !nI ? fs[0].name : 'Selection', list, (text) => setNote({ text, at: 0 }))) });
    actions.push({ key: 'faces', label: 'Scan for faces', onClick: onMedia((list) => scanFaces({ ids: list.map((i) => i.id) }, what)) });
    actions.push({ key: 'delete', label: 'Delete', icon: <TrashIcon />, danger: true, pinned: true, title: 'Moves to the trash (Delete key · Ctrl+Z to undo)',
      onClick: () => (itemsOnly ? trashItems(selIds) : askDeleteMany()) });
    return <ActionBar summary={summary} actions={actions} end={clear} />;
  };

  // ---- render ---------------------------------------------------------------------------

  const visibleTree = tree.filter((f) => !f.path.some((c) => collapsed.has(c.id)));
  const rail = !!cfg.look?.sidebarRail;
  const sideSortInfo = FOLDER_SORTS.find((o) => o.id === sideSort) ?? FOLDER_SORTS[0];
  /** The sidebar's sort button: a small menu (works in the narrow sidebar too). */
  const sideSortButton = (cls: string) => (
    <button type="button" className={cls} aria-label={`Sort folders: ${sideSortInfo.label}`} aria-haspopup="menu"
      title={`Sort the folders: ${sideSortInfo.label}`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setCtx({ x: rail ? r.right + 6 : r.left, y: rail ? r.top : r.bottom + 4, title: 'Sort folders',
          items: FOLDER_SORTS.map((o) => ({ label: o.label, hint: o.hint, checked: o.id === sideSort, onSelect: () => fprefs.setSide(o.id) })) });
      }}>
      <SortIcon size={13} />{!rail && sideSort !== 'own' && <span>{sideSortInfo.short}</span>}
    </button>
  );
  const sideView = (v: LibView, label: string, count?: number, icon?: React.ReactNode, onClick?: () => void) => {
    const on = !onClick && v.kind === view.kind && (v.kind !== 'folder' || (view.kind === 'folder' && view.id === v.id))
      && !(view.kind === 'timeline' && view.person != null);
    return (
      <button type="button" className={`side-row${on ? ' on' : ''}`} onClick={onClick ?? (() => setView(v))} title={rail ? label : undefined} aria-label={label} {...(onClick ? {} : middleView(v))}>
        {icon}{!rail && label}
        {!rail && count != null && count > 0 && <span className="count">{count.toLocaleString()}</span>}
      </button>
    );
  };
  /** A folder's little picture (its cover), or the folder icon. */
  const folderPic = (f: FolderCard, size: number) => f.cover && f.person
    ? <RoundCover folder={f} size={size} bump={coverBump} className="side-round" />
    : f.cover
    ? <img className="side-cover" src={`${thumbUrl(f.cover)}?c=${coverBump}`} alt="" draggable={false} style={{ width: size, height: size }} />
    : (!f.emoji ? <FolderIcon size={Math.round(size * 0.9)} /> : null);

  const heading = view.kind === 'search' ? `Search: ${searchTitle({ ...view, people: view.people ?? [] }, folders)}`
    : view.kind === 'timeline' && view.person != null ? `${folders.find((f) => f.id === view.person)?.name ?? 'Person'} · timeline`
    : viewTitle(view, folder);
  const showNote = !!note;
  return (
    <div className={`library${frozen ? ' frozen' : ''}`} ref={root} inert={frozen} aria-hidden={frozen || undefined}>
      <header className="lib-top" ref={header} onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('input, .search')) return;
        e.preventDefault();
        setCtx({ x: e.clientX, y: e.clientY, title: 'Top bar', items: [
          { label: topEdit ? 'Done customising' : 'Customise top bar…', onSelect: () => setTopEdit(!topEdit) },
          { label: 'Reset top bar', disabled: !savedTop.length, onSelect: () => setTopOrder([]) },
        ] });
      }}>
        <div className="brand">
          <LockIcon size={18} />
          <span>{s.name}</span>
        </div>
        <SearchBar tags={tags} folders={folders} value={view.kind === 'search' ? { ...view, people: view.people ?? [] } : NO_SEARCH}
          onChange={(v) => setView(v.tags.length || v.names.length || v.people.length ? { kind: 'search', ...v } : { kind: 'folders' })}
          onOpenFolder={openFolder}
          onEscape={() => {
            if (view.kind === 'search' || view.kind === 'smart') {
              if (!history.back()) setView({ kind: 'folders' });
            }
          }}
          smart={smartOk && !!cfg.smartSearch} smartQuery={smart ? view.q : ''}
          onSmart={(q) => setView(q ? { kind: 'smart', q } : { kind: 'folders' })} />
        <button type="button" className={`btn btn-icon btn-sm smart-toggle${smartOk && cfg.smartSearch ? ' on' : ''}`} aria-pressed={smartOk && !!cfg.smartSearch}
          disabled={!smartOk} aria-label="Smart search"
          title={!smartOk ? 'Smart search needs the full package (with the “models” folder next to the app)'
            : cfg.smartSearch ? 'Smart search is on: describe what you are looking for, in any language. Click to turn off.'
            : 'Smart search: find pictures by describing them (“beach at sunset”, “kırmızı araba”). Click to turn on.'}
          onClick={() => saveCfg({ smartSearch: !cfg.smartSearch })}><SparkleIcon /></button>
        <nav className={`row topbar${topEdit ? ' editing' : ''}`} style={{ gap: 8 }}>
          {topOrder.map((k) => {
            const b = topButtons[k];
            if (!b) return null;
            return topEdit ? (
              <span key={k} className="tb-item" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', k)}
                onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); moveTop(e.dataTransfer.getData('text/plain'), k); }}>
                <span className="tb-inner" aria-hidden="true">{b.node}</span>
                {k !== 'settings' && <button type="button" className="tb-x" aria-label={`Hide ${b.label}`} onClick={() => setTopOrder(topOrder.filter((x) => x !== k))}>×</button>}
              </span>
            ) : <span key={k} className="tb-slot">{b.node}</span>;
          })}
        </nav>
      </header>
      {topEdit && (
        <div className="tb-tray" role="toolbar" aria-label="Hidden top bar buttons">
          <span className="faint">Drag buttons to reorder them · × hides one · hidden buttons:</span>
          {hiddenTop.map((k) => (
            <button key={k} type="button" className="btn btn-sm" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', k)}
              onClick={() => setTopOrder([...topOrder.filter((x) => x !== 'settings' && x !== 'lock'), k, ...topOrder.filter((x) => x === 'settings' || x === 'lock')])}>+ {topButtons[k].label}</button>
          ))}
          {!hiddenTop.length && <span className="faint">none</span>}
          <span style={{ marginLeft: 'auto' }} />
          <button type="button" className="btn btn-sm" onClick={() => setTopOrder([])}>Reset</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setTopEdit(false)}>Done</button>
        </div>
      )}

      <div className="lib-body">
        <div className="side-col">
        <aside className={`side${rail ? ' rail' : ''}`} aria-label="Library" ref={side}>
          <button type="button" className="side-row faint rail-toggle" title={rail ? 'Show names (wider sidebar)' : 'Compact sidebar: icons and folder pictures only'}
            aria-label={rail ? 'Wider sidebar' : 'Compact sidebar'} onClick={() => saveCfg({ look: { ...DEFAULT_LOOK, ...cfg.look, sidebarRail: !rail } })}>
            <RailIcon size={15} open={rail} />{!rail && <span className="faint" style={{ fontSize: 12 }}>Compact</span>}
          </button>
          {sideView({ kind: 'folders' }, 'All folders', folders.length, rail ? <FolderIcon size={16} /> : undefined)}
          {sideView({ kind: 'all' }, 'All media', s.items, rail ? <ImagesIcon size={16} /> : undefined)}
          {sideView({ kind: 'favourites' }, 'Favourites', undefined, rail ? <HeartIcon size={16} /> : undefined)}
          {sideView({ kind: 'recent' }, 'Recently added', undefined, rail ? <ImportIcon size={16} /> : undefined)}
          {sideView({ kind: 'continue' }, 'Continue watching', undefined, <PlayIcon size={rail ? 16 : 13} />)}
          {sideView({ kind: 'timeline' }, 'Timeline', undefined, <ClockIcon size={rail ? 16 : 14} />)}
          {sideView({ kind: 'memories' }, 'Memories', undefined, <SparkleIcon size={rail ? 16 : 14} />)}
          {sideView({ kind: 'people' }, 'People', undefined, <FaceIcon size={rail ? 16 : 14} />)}
          {sideView({ kind: 'lookalikes', folder: null }, 'Look-alikes', undefined, <TwinIcon size={rail ? 16 : 14} />)}
          {sideView({ kind: 'folders' }, 'Tags', undefined, <TagIcon size={rail ? 16 : 14} />, () => setDialog({ t: 'tags' }))}
          {rail && (
            <div className="rail-folders">
              {sideSortButton(`rail-sort${sideSort !== 'own' ? ' on' : ''}`)}
              {tree.map((f) => {
                const parent = f.subfolders > 0;
                return (
                  <button key={f.id} type="button" data-drop={`folder:${f.id}`} data-order={f.id}
                    className={`rail-folder${parent ? ' parent' : ''}${f.depth > 0 ? ' sub' : ''}${view.kind === 'folder' && view.id === f.id ? ' on' : ''}${selFolders.has(f.id) ? ' fsel' : ''}`}
                    title={f.path.map((c) => c.name).concat(f.name).join(' › ')} aria-label={f.name}
                    onClick={(e) => folderClick(e, f, tree, true)} onPointerDown={(e) => startFolderDrag(e, f)} onContextMenu={(e) => folderContext(e, f)} {...middle(f)}>
                    {parent && <span className="rail-shape" aria-hidden="true" />}
                    {f.cover && f.person ? <RoundCover folder={f} bump={coverBump} className="rail-round" />
                      : f.cover ? <img src={`${thumbUrl(f.cover)}?c=${coverBump}`} alt="" draggable={false} /> : <span className="rail-blank">{f.emoji ?? <FolderIcon size={14} />}</span>}
                    {f.pinned && <span className="rail-pin" aria-hidden="true"><PinIcon size={9} /></span>}
                  </button>
                );
              })}
            </div>
          )}
          {!rail && <>
          {pinned.length > 0 && <div className="side-head"><PinIcon size={11} /> Pinned</div>}
          {pinned.map((f) => (
            <div key={`pin${f.id}`} className={`side-row tree${view.kind === 'folder' && view.id === f.id ? ' on' : ''}${selFolders.has(f.id) ? ' fsel' : ''}`} data-drop={`folder:${f.id}`}
              data-order={`pin:${f.id}`} onContextMenu={(e) => folderContext(e, f)}>
              <span className="twisty" />
              <button type="button" className="tree-name" onClick={(e) => folderClick(e, f, pinned, true)} onPointerDown={(e) => startFolderDrag(e, f)} {...middle(f)}
                title={`${f.path.map((c) => c.name).concat(f.name).join(' › ')} — drag onto another folder to move it, onto a pinned folder's top or bottom edge to arrange the pinned list`}>
                {folderPic(f, 18)}<FolderMark f={f} /> <span className="ellipsis">{f.name}</span>
                {f.person && <span className="person-mark" title="Person folder (face recognition)"><FaceIcon size={11} /></span>}
              </button>
              <span className="count">{f.items.toLocaleString()}</span>
            </div>
          ))}
          <div className="side-head side-head-row">Folders {sideSortButton(`side-sort${sideSort !== 'own' ? ' on' : ''}`)}</div>
          <button type="button" data-drop="folder:top" className={`side-row${view.kind === 'folder' && view.id === null ? ' on' : ''}`}
            onClick={() => openFolder(null)} {...middleView({ kind: 'folder', id: null })}>
            <FolderIcon size={15} /> Top level
          </button>
          {visibleTree.map((f) => (
            <div key={f.id} className={`side-row tree${view.kind === 'folder' && view.id === f.id ? ' on' : ''}${selFolders.has(f.id) ? ' fsel' : ''}${clipboard?.mode === 'cut' && clipboard.folders.includes(f.id) ? ' cut' : ''}`}
              data-drop={`folder:${f.id}`} data-order={f.id}
              style={{ paddingLeft: 6 + f.depth * 16 }} onContextMenu={(e) => folderContext(e, f)}>
              {f.subfolders > 0 ? (
                <button type="button" className="twisty" aria-label={collapsed.has(f.id) ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((c) => {
                  const n = new Set(c);
                  if (n.has(f.id)) n.delete(f.id);
                  else n.add(f.id);
                  return n;
                })}><ChevronIcon open={!collapsed.has(f.id)} /></button>
              ) : <span className="twisty" />}
              <button type="button" className="tree-name" onClick={(e) => folderClick(e, f, visibleTree, true)} onPointerDown={(e) => startFolderDrag(e, f)} {...middle(f)}
                title="Click to open · Ctrl/Shift + click to select several · middle-click: new tab · Shift + middle-click to play · drag onto a folder to move it, onto its top or bottom edge to put it before or after">
                {folderPic(f, 18)}<FolderMark f={f} /> <span className="ellipsis">{f.name}</span>
                {f.person && <span className="person-mark" title="Person folder (face recognition)"><FaceIcon size={11} /></span>}
              </button>
              <span className="count">{f.items.toLocaleString()}</span>
            </div>
          ))}
          <button type="button" className="side-row faint" onClick={() => setDialog({ t: 'newFolder', parent: view.kind === 'folder' ? view.id : null })}>
            <PlusIcon size={14} /> New folder
          </button>
          </>}
          <div className="side-spacer" />
          {sideView({ kind: 'trash' }, 'Trash', undefined, <TrashIcon size={rail ? 16 : 14} />)}
        </aside>
        {/* Its own strip under the folder list, so it never covers a folder. */}
        <div className={`side-foot${rail ? ' rail' : ''}`}>
          <ActivityRing rail={rail} notify={cfg.notifyDone !== false} />
        </div>
        </div>

        <main className="lib-main" ref={scroller} onPointerDown={rubberBand} data-drop={view.kind === 'folder' ? `folder:${view.id ?? 'top'}` : inTrash ? undefined : 'folder:top'}>
          {login && <LoginBanner login={login} onClose={() => setLogin(null)} />}
          {s.restoredFromBackup && (
            <div className="notice">The library database was damaged, so the most recent backup was used. Recent changes may be missing.</div>
          )}
          {storage && storage.looseObjects > 0 && !storageJob && (
            <div className="info row-between">
              <span>
                This vault keeps every item and thumbnail as a separate file ({storage.files.toLocaleString()} files).
                Packing them into a few large files makes backups much easier. Your files stay encrypted, and nothing is
                deleted until the packed copies are checked.
              </span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => api.storageTask('convert').catch((e) => setError(String(e)))}>
                Pack now
              </button>
            </div>
          )}
          {resume && (
            <div className="info row-between" role="status">
              <span>Continue where you left off: <b>{resume.view.kind === 'folder' ? (resume.view.id == null ? 'Top level' : folders.find((f) => f.id === (resume.view as { id: number }).id)?.name ?? 'a folder') : viewTitle(resume.view, null)}</b></span>
              <span className="row" style={{ gap: 12 }}>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => {
                  setView(resume.view);
                  if (resume.item != null) showItem(resume.item);
                  setResume(null);
                }}>Go there</button>
                <button type="button" className="link" onClick={() => setResume(null)}>Dismiss</button>
              </span>
            </div>
          )}
          <div className="lib-head">
            <div role="group" aria-label="History" className="row" style={{ gap: 4 }}>
              <button type="button" className="btn btn-icon btn-sm ghost" aria-label="Back" title="Back (Alt+← or Backspace)" disabled={!history.canBack}
                onClick={() => history.back()}><ArrowIcon dir="left" /></button>
              <button type="button" className="btn btn-icon btn-sm ghost" aria-label="Forward" title="Forward (Alt+→)" disabled={!history.canForward}
                onClick={() => history.forward()}><ArrowIcon dir="right" /></button>
            </div>
            {view.kind === 'folder' && (
              <span className="crumbs">
                <button type="button" className="link" data-drop="folder:top" onClick={() => setView({ kind: 'folders' })} {...middleView({ kind: 'folders' })}>All folders</button>
                <button type="button" className="crumb-jump" aria-label="Folders at the top level" title="Jump to another folder at this level" onClick={(e) => crumbJump(e, null)}>›</button>
                {folder?.path.map((c) => (
                  <span key={c.id}>
                    <button type="button" className="link" data-drop={`folder:${c.id}`} onClick={() => openFolder(c.id)} {...middleView({ kind: 'folder', id: c.id })}>{c.name}</button>
                    <button type="button" className="crumb-jump" aria-label={`Folders in ${c.name}`} title="Jump to another folder at this level" onClick={(e) => crumbJump(e, c.id)}>›</button>
                  </span>
                ))}
              </span>
            )}
            <h1>{folder && <FolderMark f={folder} />}{heading}</h1>
            {folder?.note && <span className="folder-note" title={folder.note}><NoteIcon size={13} /> {folder.note}</span>}
            <span className="faint">
              {view.kind === 'folders' ? `${cards.length} folders`
                : view.kind === 'stats' || view.kind === 'people' || looks || view.kind === 'memories' ? ''
                : inTrash && trash ? (trash.totalItems ? `${plural(trash.totalItems, 'item')} · ${formatBytes(trash.totalBytes)}` : 'empty')
                : `${shown.length.toLocaleString()} items`}
              {loading && ' · loading…'}
            </span>
            {folder && (
              <div className="row" style={{ gap: 6 }}>
                {folder.tags.map((t) => (
                  <span key={t} className="chip">{t}
                    <button type="button" aria-label={`Remove tag ${t}`} onClick={() => untagFolder(folder, t)}><CloseIcon size={11} /></button>
                  </span>
                ))}
                <button type="button" className="chip dashed" onClick={() => setDialog({ t: 'folderTag', folder })}>+ tag folder</button>
                <button type="button" className="btn btn-sm" title="Go through this folder one by one and send each item to a folder" onClick={() => setDialog({ t: 'quickSort', folder })}>
                  <SortIcon size={14} /> Quick sort
                </button>
                <Dropdown className="btn btn-sm" label="Folder ▾" items={folderMenu(folder).slice(1)} />
              </div>
            )}
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              {view.kind === 'folders' && folders.length > 0 && (
                <Dropdown title="Sort the folders" label={`${FOLDER_SORTS.find((o) => o.id === cardSort)?.label} ▾`}
                  items={FOLDER_SORTS.map((o) => ({ label: o.label, checked: o.id === cardSort, onSelect: () => setCardSort(o.id) }))} />
              )}
              {view.kind === 'folders' && (
                <div role="group" aria-label="Show" className="seg">
                  <button type="button" className={!everyFolder ? 'on' : ''} onClick={() => setEveryFolder(false)}>Top level</button>
                  <button type="button" className={everyFolder ? 'on' : ''} onClick={() => setEveryFolder(true)}>Every folder</button>
                </div>
              )}
              {gridView && shown.length > 0 && (
                <button type="button" className="btn btn-sm" title={allSelected ? 'Clear the selection (Esc)' : 'Select everything shown here (Ctrl+A)'}
                  onClick={() => { if (allSelected) { setSelected(new Set()); setSelFolders(new Set()); } else selectAll(); }}>
                  {allSelected ? 'Select none' : 'Select all'}
                </button>
              )}
              {gridView && !inTrash && (
                <>
                  {shown.length > 0 && (
                    <button type="button" className="btn btn-sm" title="See everything here on one sheet" onClick={() => setDialog({ t: 'sheet' })}>
                      <SheetIcon /> Contact sheet
                    </button>
                  )}
                  {!smart && view.kind !== 'similar' && <Dropdown label={`${timeline ? (sort === 'oldest' ? 'Oldest first' : 'Newest first') : SORTS.find((x) => x.id === sort)?.label} ▾`}
                    items={[
                      ...(timeline ? SORTS.slice(0, 2) : SORTS).map((o) => ({ label: o.label, checked: o.id === sort, onSelect: () => setSort(o.id) })),
                      // Inside a folder the same menu sorts its subfolder cards.
                      ...(view.kind === 'folder' && cards.length > 0 ? FOLDER_SORTS.map((o, k) => ({
                        label: `Folders: ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}`, sepBefore: k === 0, checked: o.id === cardSort, onSelect: () => setCardSort(o.id),
                      })) : []),
                    ]} />}
                  <Dropdown label={`${KINDS.find((x) => x.id === kind)?.label} ▾`} items={KINDS.map((o) => ({ label: o.label, checked: o.id === kind, onSelect: () => setKind(o.id) }))} />
                  <div role="group" aria-label="Tile shape" className="seg">
                    <button type="button" className={!shape && !scrollMode ? 'on' : ''} title="Equal tiles (edges cropped)" onClick={() => { setScrollMode(false); saveCfg({ gridShape: false }); }}>Tiles</button>
                    <button type="button" className={shape && !scrollMode ? 'on' : ''} title="Every item at its true shape, nothing cropped" onClick={() => { setScrollMode(false); saveCfg({ gridShape: true }); }}>True shape</button>
                    <button type="button" className={scrollMode ? 'on' : ''} title="Scroll mode: one long column of big pictures; videos play as you scroll past" onClick={() => setScrollMode(!scrollMode)}>Scroll</button>
                  </div>
                </>
              )}
              {inTrash && trash && (trash.totalItems > 0 || trash.folders.length > 0) && (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog({ t: 'emptyTrash' })}><TrashIcon /> Empty trash</button>
              )}
              {view.kind !== 'stats' && view.kind !== 'people' && !looks && view.kind !== 'memories' && !scrollMode && (
                <>
                  <label className="faint" htmlFor="tile-size" style={{ fontSize: 12 }} title="Ctrl + mouse wheel changes this too">Size · {cols} per row</label>
                  <input id="tile-size" type="range" min={2} max={12} step={1} value={cols} style={{ direction: 'rtl' }}
                    title={`${cols} per row — Ctrl + mouse wheel changes this too`} onChange={(e) => setCols(Number(e.target.value))} />
                </>
              )}
            </div>
          </div>

          {error && (
            <div className="error" role="alert">
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" className="link" onClick={() => setError(null)}>Dismiss</button>
            </div>
          )}

          {view.kind === 'people' && (
            <PeopleView folders={folders} onChanged={() => { reload(); nav.refresh().catch(() => {}); }} onOpenItem={(it) => openInFolder(it, true)} onTimeline={(id) => setView({ kind: 'timeline', person: id })}
              onOpenTab={tabs ? (v) => tabs.open(v) : undefined} />
          )}
          {smart && clip && clip.done + clip.failed < clip.total && (
            <div className="info" style={{ marginBottom: 12 }}>
              Still analysing pictures for smart search: {clip.done.toLocaleString()} of {clip.total.toLocaleString()} done. Results get better as it finishes.
            </div>
          )}

          {view.kind === 'memories' && (
            <MemoriesView folders={folders} onPlay={(m: Memory) => nav.go({
              name: 'viewer', items: m.items.map(fromItem), title: m.title, auto: true, back: view, kenBurns: true, titleCard: { title: m.title, subtitle: m.subtitle },
            })} />
          )}
          {view.kind === 'lookalikes' && (
            <LookAlikes folder={view.folder} folderName={folders.find((f) => f.id === view.folder)?.name ?? null}
              smartOk={smartOn} tick={lookTick} marked={selected} setMarked={setSelected}
              onGroups={(g) => setItems(g.flat())}
              onOpen={(g, id) => playList(g, false, id, 'Look-alikes')}
              onAllFolders={() => setView({ kind: 'lookalikes', folder: null })} />
          )}

          {view.kind === 'stats' && (
            <StatsView onOpenFolder={(id) => openFolder(id)} onOpenItem={(it, list) => playList(list, false, it.id, 'Most viewed')} />
          )}

          {inTrash && (
            <p className="faint" style={{ margin: '0 0 12px', fontSize: 13 }}>
              Deleted things stay here for 30 days, then they are removed for good. Restore puts them back where they were.
            </p>
          )}
          {inTrash && trash && trash.folders.length > 0 && (
            <div className="fgrid" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols - 1)}, minmax(0, 1fr))` }}>
              {trash.folders.map((f) => (
                <div key={f.id} className="fcard trashed">
                  <div className="fcover">{f.cover ? <img src={thumbUrl(f.cover)} alt="" draggable={false} /> : <FolderIcon size={40} />}</div>
                  <div className="fmeta" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="fname ellipsis">{f.name}</div>
                      <div className="faint ellipsis" style={{ fontSize: 12 }}>
                        {plural(f.items, 'item')} · {formatBytes(f.bytes)} · was in {f.location} · deleted {new Date(f.deletedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button" className="btn btn-sm" onClick={() => restoreFolder(f.id, f.name)}><RestoreIcon /> Restore</button>
                      <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog({ t: 'forever', ids: [], folder: f.id, what: `“${f.name}” and ${plural(f.items, 'item')} in it` })}>
                        Delete for good
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!inTrash && cards.length > 0 && (
            <div className="fgrid" style={{ gridTemplateColumns: `repeat(${Math.max(1, cols - 1)}, minmax(0, 1fr))` }}>
              {cards.map((f) => (
                <div key={f.id} className={`fcard${selFolders.has(f.id) ? ' fsel' : ''}`} data-card={f.id} data-drop={`folder:${f.id}`} onContextMenu={(e) => folderContext(e, f)}
                  onClick={(e) => { if (!(e.target as HTMLElement).closest('.dropdown')) folderClick(e, f, cards, false); }}
                  onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('.dropdown')) openFolder(f.id); }}
                  style={f.color ? { ['--fcolor' as string]: f.color } : undefined}
                  onPointerEnter={() => setHoverCard(f.id)} onPointerLeave={() => setHoverCard((h) => (h === f.id ? null : h))}>
                  <button type="button" className={`fcover${f.coverKind === 'pdf' || f.coverKind === 'text' ? ' doc' : ''}${f.color ? ' tinted' : ''}`}
                    onPointerDown={(e) => startFolderDrag(e, f)} {...middle(f)} aria-label={f.name}
                    title="Click to select · double-click (or Enter) to open · Ctrl/Shift + click to select several · middle-click: new tab · Shift + middle-click to play · drag onto a folder to move">
                    {coverView(f)}
                    {f.pinned && <span className="pin-badge" title="Pinned"><PinIcon size={12} /></span>}
                    <span className="drop-label">Drop here</span>
                  </button>
                  <div className="fmeta">
                    <div style={{ minWidth: 0 }}>
                      <div className="fname ellipsis"><FolderMark f={f} />{f.name}</div>
                      <div className="faint ellipsis" style={{ fontSize: 12 }}>
                        {view.kind === 'folders' && everyFolder && f.path.length > 0 ? `${f.path.map((c) => c.name).join(' › ')} · ` : ''}
                        {f.items.toLocaleString()} items{f.subfolders ? ` · ${f.subfolders} subfolder${f.subfolders > 1 ? 's' : ''}` : ''}
                      </div>
                    </div>
                    <Dropdown className="btn btn-icon btn-sm ghost" ariaLabel={`${f.name} options`} label="⋯" items={folderMenu(f)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {gridView && (
            shown.length ? (
              <div className={scrollMode ? 'scroll-mode' : 'grid-mode'}>
              <MediaGrid items={shown} columns={scrollMode ? 1 : cols} cursor={cursor} onCursor={setCursor} onQuickLook={(it) => setQuick(it.id)}
                keyboard={quick == null && !dialog && !ctx && !asleep} reveal={revealHere} selected={selected} anchor={anchor} scroller={scroller}
                onSelect={(sel, a, additive) => {
                  setSelected(sel);
                  setAnchor(a);
                  if (a != null) setCursor(a);
                  if (!additive) setSelFolders(new Set());
                }}
                onOpen={(it) => playItems(false, it.id)}
                onContext={itemContext}
                preview={inTrash ? 'off' : scrollMode ? 'all' : preview}
                wholeOnHover={!!cfg.wholeOnHover && !scrollMode}
                layout={shape || scrollMode ? 'shape' : 'grid'}
                groups={groups}
                hoverInfo={look.hoverInfo && !scrollMode}
                faces={gridFaces} faceBoxes={faceBoxesOn} faceCrop={look.faceCrop}
                personName={(id) => folders.find((f) => f.id === id)?.name}
                dimmed={clipboard?.mode === 'cut' ? new Set(clipboard.ids) : undefined}
                onDragStart={inTrash ? undefined : (e, ids) => dragOut(e, ids, [])}
                gap={look.tileGap}
                minimap={look.minimap !== false} minimapLabel={minimapLabel(timeline || smart || inTrash || view.kind === 'similar' ? null : sort)}
                onDropOnFolder={inTrash ? undefined : (ids, target) => act(() => moveItems(ids, target === 'folder:top' ? null : Number(target.slice(7))))} />
              </div>
            ) : !loading && !(inTrash && trash?.folders.length) && (
              <div className="dropzone">
                {inTrash ? <TrashIcon size={28} /> : <ImportIcon size={28} />}
                <b>{inTrash ? 'The trash is empty'
                  : view.kind === 'folder' ? 'This folder is empty'
                  : view.kind === 'search' || smart ? 'Nothing matches this search'
                  : 'Nothing here yet'}</b>
                {!inTrash && <span className="muted">Drag files, folders or .7z archives from Windows onto any folder to import them.</span>}
              </div>
            )
          )}
          {view.kind === 'folders' && !folders.length && !loading && (
            <div className="dropzone">
              <ImportIcon size={28} />
              <b>Your vault is empty</b>
              <span className="muted">Drag files, folders or .7z archives here, or use Import. Folders and archives keep their structure.</span>
              <button type="button" className="btn" onClick={() => setDialog({ t: 'newFolder', parent: null })}><PlusIcon /> New folder</button>
            </div>
          )}
        </main>
      </div>

      {selectionBar()}

      <div className="notes" onPointerEnter={() => setNoteHover(true)} onPointerLeave={() => setNoteHover(false)}>
      {showNote && note && (
        <div className="undo-toast" role="status">
          <span className="ellipsis">{note.text}</span>
          {note.at !== 0 && undoTop && undoTop.label === note.text && (
            <button type="button" className="btn btn-sm" onClick={undo}><UndoIcon /> Undo <kbd>Ctrl+Z</kbd></button>
          )}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setNote(null)}><CloseIcon size={12} /></button>
        </div>
      )}
      {(reports.length > 0 || storageMsg || hasTaskCards(tasks)) && (
        <section className="imports" aria-label="Import progress">
          <TaskCards />
          {storageMsg && (
            <div className="icard">
              <div className="row-between">
                <b>{storageMsg.ok ? 'Done' : 'Stopped'}</b>
                <button type="button" className="link" onClick={() => setStorageMsg(null)}>Dismiss</button>
              </div>
              <span style={{ fontSize: 13 }}>{storageMsg.message}</span>
            </div>
          )}
          {reports.map((r) => (
            <ImportSummary key={r.job} r={r} onClose={() => setReports((rs) => rs.filter((x) => x.job !== r.job))} />
          ))}
        </section>
      )}
      {pick && !dialog && (
        <TodaysPickCard item={pick} onClose={dismissPick} onOpen={() => { dismissPick(); openInFolder(pick); }} />
      )}
      </div>

      {quick != null && (
        <QuickLook items={shown} id={quick} onClose={() => setQuick(null)}
          onMove={(id) => { setQuick(id); setCursor(id); setSelected(new Set([id])); setAnchor(id); }}
          onOpen={(it) => { setQuick(null); playItems(false, it.id); }}
          onShowFolder={view.kind === 'folder' ? undefined : (it) => { setQuick(null); showInFolder(it); }} />
      )}

      {dialog?.t === 'newFolder' && (
        <PromptDialog title="New folder" label="Name" confirm="Create" onClose={() => setDialog(null)}
          onSubmit={async (name) => { await api.createFolder(dialog.parent, name); await reload(); }} />
      )}
      {dialog?.t === 'folderTag' && (
        <PromptDialog title={`Tag “${dialog.folder.name}”`} label="Tags (separate with commas)" confirm="Add"
          hint="Everything inside this folder, including subfolders, counts as tagged." onClose={() => setDialog(null)}
          onSubmit={(v) => tagFolder(dialog.folder, v.split(','))} />
      )}
      {dialog?.t === 'look' && (
        <FolderLookDialog folder={dialog.folder} onClose={() => setDialog(null)} onSave={(c, e) => setLook(dialog.folder, c, e)} />
      )}
      {dialog?.t === 'tagItems' && (
        <TagItemsDialog ids={dialog.ids} all={tags} onClose={() => setDialog(null)} onDone={reload} did={did} />
      )}
      {dialog?.t === 'weight' && (
        <PromptDialog title={`Weight for ${dialog.ids.length} item${dialog.ids.length > 1 ? 's' : ''}`} label="Weight" type="number"
          initial={String(dialog.current)} confirm="Set weight" onClose={() => setDialog(null)}
          hint="Used by “Weighted random”: weight 5 comes up about five times as often as weight 1. 0 = never. Files without a weight count as 1."
          onSubmit={async (v) => {
            const w = Number(v.replace(',', '.'));
            if (!Number.isFinite(w)) throw new Error('Enter a number, e.g. 1, 2.5 or 10.');
            await setWeight(dialog.ids, w);
          }} />
      )}
      {dialog?.t === 'moveItems' && (
        <FolderPicker title={`Move ${dialog.ids.length} item${dialog.ids.length > 1 ? 's' : ''} to…`} folders={folders} confirm="Move"
          onClose={() => setDialog(null)} onPick={(f) => moveItems(dialog.ids, f)} />
      )}
      {dialog?.t === 'moveFolder' && (
        <FolderPicker title={`Move “${dialog.folder.name}” into…`} folders={folders} exclude={[dialog.folder.id]} confirm="Move"
          onClose={() => setDialog(null)} onPick={(f) => moveFolder(dialog.folder, f)} />
      )}
      {dialog?.t === 'deleteFolder' && (
        <ConfirmDialog title={`Delete “${dialog.folder.name}”?`} confirm="Move to trash" danger onClose={() => setDialog(null)}
          onConfirm={() => trashFolder(dialog.folder)}>
          The folder, its {dialog.folder.subfolders} subfolder(s) and all {dialog.folder.items.toLocaleString()} item(s) inside go to the trash.
          You can restore them from there for 30 days, or press Ctrl+Z right away. Your original files outside the vault are not touched.
        </ConfirmDialog>
      )}
      {dialog?.t === 'forever' && (
        <ConfirmDialog title="Delete for good?" confirm="Delete for good" danger onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (dialog.folder != null) await api.deleteFolderForever(dialog.folder);
            else await api.deleteForever(dialog.ids);
            setSelected(new Set());
            await reload();
          }}>
          {dialog.what} will be removed from the vault and can't be brought back.
        </ConfirmDialog>
      )}
      {dialog?.t === 'emptyTrash' && (
        <ConfirmDialog title="Empty the trash?" confirm="Empty trash" danger onClose={() => setDialog(null)}
          onConfirm={async () => { await api.emptyTrash(); clearUndo(); await reload(); }}>
          Everything in the trash ({plural(trash?.totalItems ?? 0, 'item')}, {formatBytes(trash?.totalBytes ?? 0)}) is removed for good.
        </ConfirmDialog>
      )}
      {dialog?.t === 'cover' && (
        <CoverPicker folder={dialog.folder} onClose={() => setDialog(null)} onPicked={async (id) => {
          await api.setCover(dialog.folder.id, id);
          await reload();
        }} />
      )}
      {dialog?.t === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog?.t === 'deleteMany' && (() => {
        const nItems = dialog.folders.reduce((a, f) => a + f.items, 0);
        const parts = [
          dialog.folders.length ? `${plural(dialog.folders.length, 'folder')} (with ${plural(nItems, 'item')} inside)` : '',
          dialog.items.length ? plural(dialog.items.length, 'selected item') : '',
        ].filter(Boolean);
        return (
          <ConfirmDialog title={`Delete ${parts.join(' and ')}?`} confirm="Move to trash" danger onClose={() => setDialog(null)}
            onConfirm={() => askTrash(dialog.folders, dialog.items)}>
            {dialog.folders.length > 0 && <>{dialog.folders.slice(0, 6).map((f) => `“${f.name}”`).join(', ')}{dialog.folders.length > 6 ? ' …' : ''}. </>}
            Everything goes to the trash, where you can restore it for 30 days, or press Ctrl+Z right away.
          </ConfirmDialog>
        );
      })()}
      {dialog?.t === 'moveFolders' && (
        <FolderPicker title={`Move ${plural(dialog.folders.length, 'folder')} into…`} folders={folders} exclude={dialog.folders.map((f) => f.id)} confirm="Move"
          onClose={() => setDialog(null)} onPick={(p) => moveFolders(dialog.folders, p)} />
      )}
      {dialog?.t === 'freeCopy' && (
        <FolderPicker title={`Free copy ${plural(dialog.ids.length, 'item')} to…`} folders={folders} confirm="Make free copies"
          onClose={() => setDialog(null)} onPick={(f) => freeCopyTo(dialog.ids, f)} />
      )}
      {dialog?.t === 'deleteOriginal' && (
        <DeleteOriginalDialog groups={dialog.groups} onCancel={() => setDialog(null)}
          folderName={(id) => (id == null ? 'Top level' : folders.find((f) => f.id === id)?.name ?? 'a folder')}
          onChoice={async (c) => {
            const d = dialog;
            setDialog(null);
            try {
              if (c.mode === 'all') await deleteMany(d.folders, [...d.ids, ...d.groups.flatMap(([, cs]) => cs.map((x) => x.id))]);
              else {
                const links: CopyLinks[] = [];
                for (const [o] of d.groups) links.push(await api.promoteCopy(o.id, c.picks.get(o.id)!));
                await deleteMany(d.folders, d.ids, links);
              }
            } catch (err) {
              setError(errText(err));
            }
          }} />
      )}
      {dialog?.t === 'merge' && <MergeDialog folders={dialog.folders} onClose={() => setDialog(null)} onDone={(m, t, src) => { finishMerge(m, t, src); }} />}
      {dialog?.t === 'note' && (
        <NoteDialog name={dialog.name} note={dialog.note} onClose={() => setDialog(null)} onSave={(n) => saveNote(dialog.folder, dialog.id, dialog.name, n)} />
      )}
      {dialog?.t === 'copies' && (
        <Modal title={dialog.item.copyOf != null ? 'The original and other free copies' : 'Free copies'} onClose={() => setDialog(null)}>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>These share one stored file with “{dialog.item.name}”, so they take no extra space.</p>
          <div className="picker">
            {dialog.list.map((x) => (
              <button key={x.id} type="button" className="picker-row" onClick={() => { setDialog(null); showInFolder(x); }}>
                <FolderIcon size={15} /> {x.folderId == null ? 'Top level' : folders.find((f) => f.id === x.folderId)?.name ?? 'folder'}
                <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{x.copyOf == null ? 'original' : 'free copy'} · {x.name}</span>
              </button>
            ))}
            {!dialog.list.length && <span className="faint">No other copies.</span>}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={() => setDialog(null)}>Close</button></div>
        </Modal>
      )}
      {dialog?.t === 'tags' && (
        <TagManager onClose={() => setDialog(null)} did={did} onChanged={() => { reload(); }}
          onSearch={(t) => { setDialog(null); setView({ kind: 'search', tags: [t], names: [], people: [] }); }} />
      )}
      {dialog?.t === 'quickSort' && (
        <QuickSort source={dialog.folder} folders={folders} moveStats={moveStats.current} onMoved={bumpMoveStat} did={did} undo={undo}
          onClose={(changed) => { setDialog(null); if (changed) { reload(); nav.refresh().catch(() => {}); } }} />
      )}
      {dialog?.t === 'duel' && <Duel items={dialog.items} onClose={() => { setDialog(null); reload(); }} />}
      {dialog?.t === 'slots' && (
        <SlotMachine folder={dialog.folder} onClose={() => setDialog(null)}
          onPlay={(list, title) => { setDialog(null); playList(list, true, undefined, title); }} />
      )}
      {dialog?.t === 'why' && <WhyHere item={dialog.item} query={dialog.query} kind={kind} onClose={() => setDialog(null)} />}
      <MuseumHost nav={nav} view={view} />
      {dialog?.t === 'share' && <ShareDialog ids={dialog.ids} folders={dialog.folders} what={dialog.what} onClose={() => setDialog(null)} />}
      {dialog?.t === 'convert' && (
        <ConvertDialog items={dialog.items} target={dialog.target} onClose={() => setDialog(null)} onDone={() => { kickThumbnails(); reload(); }} />
      )}
      {dialog?.t === 'animation' && <AnimationDialog items={dialog.items} onClose={() => setDialog(null)} onDone={() => { kickThumbnails(); reload(); }} />}
      {dialog?.t === 'dragOut' && (() => {
        const d = dialog;
        let answered = false;
        const answer = (ok: boolean) => { if (!answered) { answered = true; d.resolve(ok); } };
        return (
          <ConfirmDialog title="Copy out of the vault?" confirm="Yes, copy them" onClose={() => { answer(false); setDialog(null); }} onConfirm={() => answer(true)}>
            Dragging items out of the window makes normal, unencrypted copies where you drop them (Explorer, the desktop). Only this time is asked; after that, drag them out again.
          </ConfirmDialog>
        );
      })()}
      {dialog?.t === 'renameMany' && (
        <RenameDialog entries={dialog.entries} onClose={() => setDialog(null)} onRename={doRename} />
      )}
      {dialog?.t === 'moveMixed' && (
        <FolderPicker title={`Move ${[plural(dialog.folders.length, 'folder'), dialog.ids.length ? plural(dialog.ids.length, 'item') : ''].filter(Boolean).join(' and ')} to…`}
          folders={folders} exclude={dialog.folders.map((f) => f.id)} confirm="Move"
          onClose={() => setDialog(null)} onPick={(p) => moveMixed(dialog.folders, dialog.ids, p)} />
      )}
      {dialog?.t === 'extracted' && (
        <ConfirmDialog title="Remove the remaining empty folder?" confirm="Yes" cancel="No" onClose={() => setDialog(null)}
          onCancel={() => { const d = dialog; setDialog(null); finishExtract(d.folder, d.x, false); }}
          onConfirm={() => finishExtract(dialog.folder, dialog.x, true)}>
          Everything inside “{dialog.folder.name}” moved up to {dialog.x.parent == null ? 'the top level' : `“${folders.find((f) => f.id === dialog.x.parent)?.name ?? 'its parent'}”`}
          {dialog.x.renamed.length > 0 && <> ({dialog.x.renamed.map(([, a, b]) => `“${a}” is now “${b}”`).join(', ')}, because that name was taken)</>}.
          “{dialog.folder.name}” is empty now.
        </ConfirmDialog>
      )}
      {dialog?.t === 'export' && <ExportDialog request={dialog.request} what={dialog.what} onClose={() => setDialog(null)} />}
      {dialog?.t === 'sheet' && (
        <ContactSheet title={heading} items={shown} onClose={() => setDialog(null)} onOpen={(it) => { setDialog(null); playItems(false, it.id); }} />
      )}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} title={ctx.title} items={ctx.items} onClose={() => setCtx(null)} />}
      {dialog?.t === 'archivePassword' && (
        <ArchivePasswordDialog summary={dialog.summary} onClose={() => setDialog(null)}
          onImport={async (pw) => { await api.startImport(dialog.paths, dialog.target, pw); }} />
      )}
    </div>
  );
}

function SearchBar(props: {
  tags: TagCount[]; folders: FolderCard[]; value: SearchValue; onChange: (v: SearchValue) => void; onOpenFolder: (id: number) => void;
  smart: boolean; smartQuery: string; onSmart: (q: string) => void; onEscape: () => void;
}) {
  if (props.smart) return <SmartBar query={props.smartQuery} onSearch={props.onSmart} onEscape={props.onEscape} />;
  return <TagNameBar {...props} />;
}

/** Smart search: type a description, Enter to search. */
function SmartBar(props: { query: string; onSearch: (q: string) => void; onEscape: () => void }) {
  const [text, setText] = useState(props.query);
  useEffect(() => setText(props.query), [props.query]);
  return (
    <div className="search smart">
      <SparkleIcon />
      <label htmlFor="lib-search" className="sr-only">Smart search</label>
      <input id="lib-search" value={text} autoComplete="off" placeholder="Describe what you're looking for… (any language)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); props.onSearch(text.trim()); }
          else if (e.key === 'Escape') {
            // Esc clears the box; Esc on an empty box leaves the search.
            if (text) setText('');
            else {
              (e.target as HTMLInputElement).blur();
              props.onEscape();
            }
          }
        }} />
      {text && (
        <button type="button" className="link" aria-label="Clear" onClick={() => { setText(''); props.onSearch(''); }}><CloseIcon size={12} /></button>
      )}
    </div>
  );
}

function TagNameBar(props: { tags: TagCount[]; folders: FolderCard[]; value: SearchValue; onChange: (v: SearchValue) => void; onOpenFolder: (id: number) => void; onEscape: () => void }) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [hi, setHi] = useState(0);
  const fold = (x: string) => x.toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/\u0307/g, '');
  const q = fold(text.trim());
  const { tags, names, people } = props.value;
  const starts = (x: string) => Number(!fold(x).startsWith(q));
  const tagHits = props.tags
    .filter((t) => !tags.some((v) => v.toLowerCase() === t.name.toLowerCase()))
    .filter((t) => !q || fold(t.name).includes(q))
    .sort((a, b) => starts(a.name) - starts(b.name))
    .slice(0, 8);
  // People (person folders) and other folders whose name matches.
  const personHits = props.folders
    .filter((f) => f.person && !people.includes(f.id) && (!q || fold(f.name).includes(q)))
    .sort((a, b) => starts(a.name) - starts(b.name))
    .slice(0, q ? 5 : 3);
  const folderHits = q
    ? props.folders.filter((f) => !f.person && fold(f.name).includes(q)).sort((a, b) => starts(a.name) - starts(b.name)).slice(0, 5)
    : [];
  type Opt =
    | { t: 'person'; id: number; name: string; hint: string }
    | { t: 'tag'; name: string; hint: string }
    | { t: 'folder'; id: number; name: string; hint: string }
    | { t: 'name'; text: string };
  const opts: Opt[] = [
    ...personHits.map((f): Opt => ({ t: 'person', id: f.id, name: f.name, hint: 'person' })),
    ...tagHits.map((t): Opt => ({
      t: 'tag', name: t.name,
      hint: `${t.items ? `${t.items} items` : ''}${t.items && t.folders ? ' · ' : ''}${t.folders ? `${t.folders} folders` : ''}`,
    })),
    ...folderHits.map((f): Opt => ({ t: 'folder', id: f.id, name: f.name, hint: f.path.length ? f.path.map((c) => c.name).join(' › ') : 'open folder' })),
    ...(q ? [{ t: 'name', text: text.trim() } as Opt] : []),
  ];
  const choose = (o: Opt | undefined) => {
    if (!o) return;
    if (o.t === 'person') props.onChange({ tags, names, people: [...people, o.id] });
    else if (o.t === 'tag') props.onChange({ tags: [...tags, o.name], names, people });
    else if (o.t === 'folder') props.onOpenFolder(o.id);
    else props.onChange({ tags, names: [...names, o.text], people });
    setText('');
    setHi(0);
  };
  const any = tags.length || names.length || people.length;
  const personName = (id: number) => props.folders.find((f) => f.id === id)?.name ?? 'person';
  return (
    <div className="search">
      <SearchIcon />
      {people.map((p) => (
        <span key={`p${p}`} className="chip accent"><FaceIcon size={11} /> {personName(p)}
          <button type="button" aria-label={`Remove ${personName(p)}`} onClick={() => props.onChange({ tags, names, people: people.filter((x) => x !== p) })}><CloseIcon size={11} /></button>
        </span>
      ))}
      {tags.map((t) => (
        <span key={`t${t}`} className="chip accent"><TagIcon size={11} /> {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => props.onChange({ tags: tags.filter((x) => x !== t), names, people })}><CloseIcon size={11} /></button>
        </span>
      ))}
      {names.map((n) => (
        <span key={`n${n}`} className="chip name">“{n}” in name
          <button type="button" aria-label={`Remove ${n}`} onClick={() => props.onChange({ tags, names: names.filter((x) => x !== n), people })}><CloseIcon size={11} /></button>
        </span>
      ))}
      <label htmlFor="lib-search" className="sr-only">Search people, tags, folders or file names</label>
      <input id="lib-search" value={text} placeholder={any ? 'Narrow down…' : 'Search people, tags, folders or file names…'} autoComplete="off"
        onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 150)}
        onChange={(e) => { setText(e.target.value); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); choose(opts[hi]); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, opts.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Backspace' && !text && any) {
            if (names.length) props.onChange({ tags, names: names.slice(0, -1), people });
            else if (tags.length) props.onChange({ tags: tags.slice(0, -1), names, people });
            else props.onChange({ tags, names, people: people.slice(0, -1) });
          } else if (e.key === 'Escape') {
            // Esc clears what you typed; Esc again leaves the search.
            if (text) setText('');
            else {
              (e.target as HTMLInputElement).blur();
              props.onEscape();
            }
          }
        }} />
      {focus && opts.length > 0 && (
        <div className="menu suggest" role="listbox">
          {opts.map((o, i) => (
            <button key={o.t === 'name' ? 'name' : `${o.t}${'id' in o ? o.id : o.name}`} type="button" role="option" aria-selected={i === hi}
              className={`menu-item${i === hi ? ' on' : ''}`} onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
              {o.t === 'person' ? <><FaceIcon size={13} /> {o.name}<span className="hint">{o.hint}</span></>
                : o.t === 'tag' ? <><TagIcon size={13} /> {o.name}<span className="hint">{o.hint}</span></>
                : o.t === 'folder' ? <><FolderIcon size={13} /> {o.name}<span className="hint">{o.hint}</span></>
                : <><SearchIcon size={13} /> File name contains “{o.text}”</>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TagItemsDialog(props: {
  ids: number[]; all: TagCount[]; onClose: () => void; onDone: () => Promise<void>;
  did: (label: string, undo: () => Promise<unknown>) => void;
}) {
  const [own, setOwn] = useState<string[]>([]);
  const [inherited, setInherited] = useState<[string, string][]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const single = props.ids.length === 1;
  const load = useCallback(async () => {
    if (!single) return;
    const t = await api.itemTags(props.ids[0]);
    setOwn(t.own);
    setInherited(t.inherited);
  }, [props.ids, single]);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    const list = text.split(',').map((t) => t.trim()).filter(Boolean);
    if (!list.length) return;
    try {
      const added = await api.tagItems(props.ids, list);
      const real = added.filter(([, ids]) => ids.length);
      if (real.length)
        props.did(`Tagged ${plural(new Set(real.flatMap(([, ids]) => ids)).size, 'item')} “${real.map(([t]) => t).join('”, “')}”`, async () => {
          for (const [t, ids] of real) await api.untagItems(ids, t);
        });
      setText('');
      await load();
      await props.onDone();
    } catch (e) { setErr(String(e)); }
  };
  const remove = async (t: string) => {
    const had = await api.untagItems(props.ids, t);
    if (had.length) props.did(`Removed tag “${t}” from ${plural(had.length, 'item')}`, () => api.tagItems(had, [t]));
    await load();
    await props.onDone();
  };
  return (
    <Modal title={single ? 'Tags' : `Tag ${props.ids.length} items`} onClose={props.onClose}>
      {single && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 6 }}>
            {own.length ? own.map((t) => (
              <span key={t} className="chip">{t}<button type="button" aria-label={`Remove ${t}`} onClick={() => remove(t)}><CloseIcon size={11} /></button></span>
            )) : <span className="faint">No tags of its own yet.</span>}
          </div>
          {inherited.length > 0 && (
            <div className="faint" style={{ fontSize: 13 }}>
              Also tagged through folders: {inherited.map(([t, f]) => `${t} (from ${f})`).join(', ')}
            </div>
          )}
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input className="input" style={{ flex: 1 }} list="known-tags" value={text} autoFocus aria-label="New tags"
          placeholder="Add tags, separated by commas" onChange={(e) => setText(e.target.value)} />
        <datalist id="known-tags">{props.all.map((t) => <option key={t.name} value={t.name} />)}</datalist>
        <button type="submit" className="btn btn-primary">Add</button>
      </form>
      {!single && (
        <form className="row" onSubmit={async (e) => {
          e.preventDefault();
          const t = (new FormData(e.currentTarget).get('rm') as string).trim();
          if (t) { await remove(t); (e.currentTarget as HTMLFormElement).reset(); }
        }}>
          <input name="rm" className="input" style={{ flex: 1 }} list="known-tags" placeholder="Remove a tag from all of them" aria-label="Tag to remove" />
          <button type="submit" className="btn">Remove</button>
        </form>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Done</button>
      </div>
    </Modal>
  );
}

function ArchivePasswordDialog(props: { summary: DropSummary; onClose: () => void; onImport: (pw: string) => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = props.summary.archives.filter((a) => a.needsPassword);
  return (
    <Modal title="Archive password" onClose={props.onClose}>
      <p className="muted" style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
        {locked.length === 1 ? `“${locked[0].name}” is` : `${locked.length} archives are`} password-protected.
        Files are decrypted in memory and go straight into the vault — nothing is extracted to disk.
        The password is not saved.
      </p>
      <ul className="faint" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
        {props.summary.archives.map((a) => (
          <li key={a.path}>{a.name}{a.parts > 1 ? ` (${a.parts} parts)` : ''}{a.error ? ` — ${a.error}` : ''}</li>
        ))}
      </ul>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          for (const a of locked) await api.checkArchivePassword(a.path, pw);
          await props.onImport(pw);
          props.onClose();
        } catch (x) {
          setErr(x instanceof Error ? x.message : String(x));
        } finally {
          setBusy(false);
        }
      }}>
        <div className="field">
          <label htmlFor="arch-pw">Password{locked.length > 1 ? ' (tried on all of them)' : ''}</label>
          <input id="arch-pw" className="input" type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} />
        </div>
        {err && <div className="error" role="alert">{err}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!pw || busy}>{busy ? 'Checking…' : 'Import'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ImportSummary({ r, onClose }: { r: ImportReport; onClose: () => void }) {
  const [more, setMore] = useState(false);
  return (
    <div className="icard">
      <div className="row-between">
        <b>{r.cancelled ? 'Import cancelled' : 'Import finished'}</b>
        <button type="button" className="link" onClick={onClose}>Dismiss</button>
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>
        {r.imported.toLocaleString()} imported ({formatBytes(r.bytes)} in {Math.max(1, Math.round(r.seconds))} s)
        {r.duplicates > 0 && <> · {r.duplicates} already in that folder</>}
        {r.skippedCount > 0 && <> · {r.skippedCount} not media, skipped</>}
      </div>
      {r.failed.length > 0 && (
        <div className="error" style={{ flexDirection: 'column', gap: 4 }}>
          {(more ? r.failed : r.failed.slice(0, 3)).map(([n, why], i) => <span key={i}>{n}: {why}</span>)}
          {r.failed.length > 3 && !more && <button type="button" className="link" onClick={() => setMore(true)}>Show all {r.failed.length}</button>}
        </div>
      )}
    </div>
  );
}

function CoverPicker(props: { folder: FolderCard; onClose: () => void; onPicked: (id: number | null) => Promise<void> }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.queryItems({ folder: props.folder.id, recursive: true }).then((x) => setItems(x.slice(0, 600))).catch((e) => setErr(String(e)));
  }, [props.folder.id]);
  const pick = async (id: number | null) => {
    try {
      await props.onPicked(id);
      props.onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title={`Cover for “${props.folder.name}”`} onClose={props.onClose} wide>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        Pick any picture, GIF or video inside this folder (or its subfolders). Videos and GIFs play on the card when previews are on.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="cover-grid">
        <button type="button" className={`cover-pick${props.folder.cover == null ? ' on' : ''}`} onClick={() => pick(null)}>
          <span className="tile-msg">Automatic<br />(first picture)</span>
        </button>
        {items?.map((it) => (
          <button key={it.id} type="button" title={it.name} className={`cover-pick${props.folder.cover === it.id ? ' on' : ''}${it.kind === 'pdf' || it.kind === 'text' ? ' doc' : ''}`} onClick={() => pick(it.id)}>
            {it.thumb === 'ok' ? <img src={thumbUrl(it.id)} alt={it.name} loading="lazy" /> : <span className="tile-msg">{it.name}</span>}
            {it.kind !== 'image' && <span className="badge">{it.kind === 'video' ? 'VIDEO' : it.kind.toUpperCase()}</span>}
          </button>
        ))}
        {!items && <span className="faint">Loading…</span>}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={props.onClose}>Close</button>
      </div>
    </Modal>
  );
}
