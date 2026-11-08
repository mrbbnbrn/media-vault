// The library: folder tree, folder cards with covers, the media grid, search
// by tag and file name, the timeline, the trash, statistics, selection
// actions with undo, and importing by drag and drop.

import { SORTS, minimapLabel, KINDS, PREVIEWS, viewTitle, NO_SEARCH, foldName, searchTitle, groupBy, saveColsLater, findAnchor } from './library/helpers';
import { FolderCover } from './library/FolderCover';
import { TagItemsDialog, ArchivePasswordDialog, ImportSummary, CoverPicker } from './library/LibraryDialogs';
import { SearchBar } from './library/SearchBars';
import { errText } from '../text';
import { MESSAGE_SLOT } from '../components/Messages';
import { say } from '../messages';
import { onTransferArrived, useTransfer } from '../transfer';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StatsGo } from '../components/StatsView';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { gridShown } from '../firstgrid';
import { api, DEFAULT_LOOK, inTauri, onEvent, thumbUrl, type DropSummary, type FolderCard, type ImportReport, type Item, type Kind, type CopyLinks, type ExportRequest, type FaceBox, type Merged, type Extracted, type LoginInfo, type StorageDone, type StorageInfo, type StorageProgress, type TagCount, type TrashView, type FolderBanner, takeLogin } from '../api';
import type { Nav } from '../App';
import { ActionBar, type BarAction } from '../components/ActionBar';
import { ConfirmDialog, ContextMenu, Dropdown, FolderPicker, Modal, PromptDialog, type MenuItem } from '../components/Dialogs';
import { FolderLookDialog, FolderMark } from '../components/FolderLook';
import { ChartIcon, ChevronIcon, ClockIcon, CloseIcon, DiceIcon, FolderIcon, GearIcon, GridIcon, HeartIcon, HelpIcon, ImportIcon, LeaveIcon, LockIcon, MoveIcon, PinIcon, ArrowIcon, ExportIcon, FaceIcon, PhoneIcon, PlayIcon, TwinIcon, ImagesIcon, NoteIcon, RailIcon, SortIcon, PlusIcon, RestoreIcon, SheetIcon, SparkleIcon, TagIcon, TrashIcon, UndoIcon, WeightIcon } from '../components/Icons';
import { FaceSortOffer } from '../components/FaceSort';
import { openSortAll } from '../facesort';
import type { RenameEntry } from '../components/RenameDialog';
import type { Memory } from '../components/Memories';
import { ShareDialog } from '../components/ShareDialog';
import type { WhyQuery } from '../components/WhyHere';
import { FOLDER_SORTS, placeIds, sortFolders, sortPinned, sortSteady, sortTree, updateSnap, type FolderSort, type SortSnap } from '../foldersort';
import { useFolderPrefs } from '../folderprefs';
import { MuseumHost, museumOpen, openFolderMuseum, openMuseum } from '../components/museum/launch';
import { openFolderRiver, openVaultRiver, RiverHost, RiverIcon, riverOpen } from '../components/river/launch';
import { copyOut, readPaste, savePastedPicture } from '../winclip';
import { maybeDragOut, lastDragOutError } from '../dragout';
import { openRect, revealInGrid, setLibraryReveal, sourceElement, visibleRect } from '../viewerflip';
import { bandPick, folderPick, returnPick } from '../selection';
import { ExportDialog, LoginBanner, TaskCards, hasTaskCards } from '../components/Safety';
import { CoverImg, leaveCard, setHoveredCard } from '../components/CoverImg';
import { kickFaceScanner, noteFaceProgress } from '../ml/facescan';
import { useTaskPart } from '../tasks';
import { prepareFolder, prepareFolders, prepareItems } from '../prepare';
import { Delete3DData, type Delete3DTarget } from '../components/Delete3DData';
import { SeparateFaces, type SeparateTarget } from '../components/SeparateFaces';
import { MediaGrid } from '../components/MediaGrid';
import { Framed } from '../components/FramedCover';
import { CoverFrameEditor } from '../components/CoverFrameEditor';
import { BannerPicker, FolderBannerView, useFolderBanner } from '../components/FolderBanner'; // folder banners
import { setPreviewCover } from '../previewgate';
import { RoundCover } from '../components/RoundCover';
import { ShortcutsDialog, useHelpKey } from '../components/Shortcuts';
import { TodaysPickCard, useTodaysPick } from '../components/TodaysPick';
import { setDropHandler } from '../drop';
import { startMoveDrag, targetFolder } from '../dragmove';
import { QuickLook } from '../components/QuickLook';
import {
  getAnchor, getScroll, getSideScroll, lastPlace, setAnchor as setScrollAnchor, loadViewPrefs, prefsKey, rememberPlace, setScroll, setSideScroll, setViewPrefs, viewKey, viewPrefsFor,
  rememberSelection, takeSelection, type LastPlace,
} from '../viewmemory';
import { monthGroups } from '../gridlayout';
import { fromItem, kickThumbnails, onItemsChanged, onThumb } from '../media';
import { beginStep, dropStep, endStep, whenImagesShown } from '../perf';
import { calmly, reuseSame, shallowSame, useStableList } from '../calm';
import { useEvent } from '../useevent';
import { sorted, type Order } from '../playlist';
import { saveAppConfig, setFaceBoxes, useFaceBoxes, useViewerPrefs } from '../prefs';
import { formatBytes } from '../theme';
import { clearUndo, plural, pushUndo, undoLast, useUndoTop } from '../undo';
import { lazyPart } from '../lazypart';
import { FaceToolsHost, faceToolOpen, openFaceTool } from '../components/facecrops/launch';
import { noLayerOpen, setScreenNav } from '../keylayers';
import { PROBLEM_MS, RESULT_MS, useAutoDismiss } from '../autodismiss';
import { requestLock } from '../keepopen';
import { setItemMenuProvider, setItemTrasher } from '../itemmenu';
import { loadShows } from '../slideshowmemory';

// Views and dialogs that load when first opened (lazypart.tsx).
const ContactSheet = lazyPart(() => import('../components/ContactSheet').then((m) => m.ContactSheet));
const LookAlikes = lazyPart(() => import('../components/LookAlikes').then((m) => m.LookAlikes));
const PeopleView = lazyPart(() => import('../components/People').then((m) => m.PeopleView));
const PersonAlso = lazyPart(() => import('../components/People').then((m) => m.PersonAlso));
const RenameDialog = lazyPart(() => import('../components/RenameDialog').then((m) => m.RenameDialog));
const QuickSort = lazyPart(() => import('../components/QuickSort').then((m) => m.QuickSort));
const TagManager = lazyPart(() => import('../components/TagManager').then((m) => m.TagManager));
const DeleteOriginalDialog = lazyPart(() => import('../components/OrganizeDialogs').then((m) => m.DeleteOriginalDialog));
const MergeDialog = lazyPart(() => import('../components/OrganizeDialogs').then((m) => m.MergeDialog));
const NoteDialog = lazyPart(() => import('../components/OrganizeDialogs').then((m) => m.NoteDialog));
const MemoriesView = lazyPart(() => import('../components/Memories').then((m) => m.MemoriesView));
const ConvertDialog = lazyPart(() => import('../components/ConvertDialog').then((m) => m.ConvertDialog));
const AnimationDialog = lazyPart(() => import('../components/AnimationDialog').then((m) => m.AnimationDialog));
const Duel = lazyPart(() => import('../components/Duel').then((m) => m.Duel));
const SlotMachine = lazyPart(() => import('../components/SlotMachine').then((m) => m.SlotMachine));
const WhyHere = lazyPart(() => import('../components/WhyHere').then((m) => m.WhyHere));
const StatsView = lazyPart(() => import('../components/StatsView').then((m) => m.StatsView));
const FaceWall = lazyPart(() => import('../components/facecrops/FaceWall').then((m) => m.FaceWall));

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
  | { kind: 'people' }
  /** Groups of pictures that look the same (whole library or one folder). */
  | { kind: 'lookalikes'; folder: number | null; only?: number[]; onlyLabel?: string }
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
  | { t: 'delFaces'; folder: FolderCard }
  | { t: 'delFacesItems'; ids: number[]; what: string }
  | { t: 'delPreviews'; folders: FolderCard[] }
  | { t: 'folderTag'; folder: FolderCard }
  | { t: 'look'; folder: FolderCard }
  | { t: 'moveItems'; ids: number[] }
  | { t: 'tagItems'; ids: number[] }
  | { t: 'weight'; ids: number[]; current: number }
  | { t: 'archivePassword'; paths: string[]; target: number | null; summary: DropSummary }
  | { t: 'cover'; folder: FolderCard }
  | { t: 'coverFrame'; folder: number }
  | { t: 'banner'; folder: FolderCard }
  | { t: 'emptyTrash' }
  | { t: 'forever'; ids: number[]; folder: number | null; what: string }
  | ({ t: 'del3d' } & Delete3DTarget)
  | { t: 'separate'; folder: { id: number; name: string }; items?: Item[]; what?: string }
  | { t: 'shortcuts' }
  | { t: 'sheet' }
  | { t: 'export'; request: Omit<ExportRequest, 'dest'>; what: string }
  | { t: 'deleteMany'; folders: FolderCard[]; items: number[] }
  | { t: 'moveFolders'; folders: FolderCard[] }
  | { t: 'moveMixed'; folders: FolderCard[]; ids: number[] }
  | { t: 'renameMany'; entries: RenameEntry[] }
  | { t: 'freeCopy'; ids: number[] }
  | { t: 'deleteOriginal'; groups: [Item, Item[]][]; ids: number[]; folders: FolderCard[]; done?: (deleted: boolean) => void }
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

let resumeOfferedFor: string | null = null;

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
  const [folders, setFoldersRaw] = useState<FolderCard[]>([]);
  const [items, setItemsRaw] = useState<Item[]>([]);
  const [subfolders, setSubfoldersRaw] = useState<FolderCard[]>([]);
  // What you do yourself shows at once; changes from background work keep things in place (calm.ts).
  const bgList = useRef(false);
  const setItems = (f: Item[]) => { bgList.current = false; setItemsRaw(f); };
  const [folder, setFolderRaw] = useState<FolderCard | null>(null);
  const [trash, setTrashRaw] = useState<TrashView | null>(null);
  const [tags, setTagsRaw] = useState<TagCount[]>([]);
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
  // The views' own settings (sort, size…) come first, so the first grid is drawn with them
  // instead of with the defaults and then re-sorted.
  const [prefsReady, setPrefsReady] = useState(false);
  useEffect(() => {
    loadViewPrefs(s.path).catch(() => {}).finally(() => {
      setPrefsTick((t) => t + 1);
      setPrefsReady(true);
    });
  }, [s.path]);
  // Keyboard cursor in the grid, quick look, and the item to show.
  const [cursor, setCursor] = useState<number | null>(null);
  const [quick, setQuick] = useState<number | null>(null);
  const [revealHere, setRevealHere] = useState<{ id: number; n: number } | null>(null);
  const [resume, setResume] = useState<LastPlace | null>(null);
  // "Where you left off" goes away by itself too (it is only an offer).
  useAutoDismiss(resume, () => setResume(null), PROBLEM_MS);
  const [everyFolder, setEveryFolder] = useState(true);
  // Folded-up sidebar folders are remembered between visits.
  const [collapsed, setCollapsedRaw] = useState<Set<number>>(new Set());
  useEffect(() => {
    api.uiGet('sidebar-collapsed').then((v) => {
      if (!v) return;
      try {
        const ids = JSON.parse(v);
        if (Array.isArray(ids)) setCollapsedRaw(new Set(ids.filter((x) => typeof x === 'number')));
      } catch { /* old or broken value: start unfolded */ }
    }).catch(() => {});
  }, []);
  const setCollapsed = useCallback((f: (c: Set<number>) => Set<number>) => {
    setCollapsedRaw((c) => {
      const n = f(c);
      if (n !== c) api.uiSet('sidebar-collapsed', JSON.stringify([...n])).catch(() => {});
      return n;
    });
  }, []);
  // Folder sorting: the sidebar (every level and the pinned list) and the folder cards (foldersort.ts).
  const fprefs = useFolderPrefs(s.path);
  // Folder slideshows' own settings and where they stopped, ready before a slideshow starts.
  useEffect(() => void loadShows(s.path), [s.path]);
  const sideSort = fprefs.side;
  const cardSort: FolderSort = vp.folderSort ?? sideSort;
  const setCardSort = (o: FolderSort) => { setViewPrefs(vKey, { folderSort: o }); setPrefsTick((t) => t + 1); };
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // Problems go to the one message stack (messages.ts), above any dialog.
  const [error, setErrorRaw] = useState<string | null>(null);
  const setError = setErrorRaw;
  useEffect(() => {
    if (!error) return;
    say(error, 'problem');
    setErrorRaw(null);
  }, [error]);
  const [loading, setLoading] = useState(false);
  const [reports, setReports] = useState<ImportReport[]>([]);
  // ---- folder banners (begin) ----
  const [banner, reloadBanner] = useFolderBanner(view.kind === 'folder' ? folder : null);
  // Choosing what the banner shows (the item being repositioned).
  const [bannerEditOf, setBannerEditOf] = useState<number | null>(null);
  // Folders where face search was turned off (their subfolders too; faces.rs).
  const [facesOff, setFacesOff] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    api.facesOffFolders().then((l) => setFacesOff(new Set(l))).catch(() => {});
  }, []);
  // Folders where preview clips are turned off (their subfolders too; previewsoff.rs).
  const [previewsOff, setPreviewsOff] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    api.previewsOffFolders().then((l) => setPreviewsOff(new Set(l))).catch(() => {});
  }, []);
  const bannerEdit = banner != null && bannerEditOf === banner.media;
  useEffect(() => setBannerEditOf(null), [view]);
  const showBanner = view.kind === 'folder' && !!banner && !!folder && banner.folder === folder.id;
  /** Banners of folders other than the open one, as far as known (asked when their menu opens). */
  const bannerKnown = useRef(new Map<number, FolderBanner | null>());
  const bannerOf = (id: number): FolderBanner | null => (banner?.folder === id ? banner : bannerKnown.current.get(id) ?? null);
  const removeBanner = (f: FolderCard) => {
    const was = bannerOf(f.id);
    api.setBanner(f.id, null).then(() => {
      bannerKnown.current.set(f.id, null);
      if (was) did('Banner removed', () => api.setBanner(f.id, was.media, was.y).then(reloadBanner));
      reloadBanner();
    }, (err) => setError(errText(err)));
  };
  // ---- folder banners (end) ----
  const [ctx, setCtx] = useState<{ x: number; y: number; title: string; items: MenuItem[] } | null>(null);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  // Only whether packing runs (its progress shows in the jobs ring): progress messages don't redraw the library.
  const [storageJob, setStorageJob] = useState(false);
  const [storageMsg, setStorageMsg] = useState<StorageDone | null>(null);
  const [note, setNote] = useState<{ text: string; at: number } | null>(null);
  const [login, setLogin] = useState<LoginInfo | null>(() => takeLogin());
  const [lookTick, setLookTick] = useState(0);
  // Wi-Fi transfer: "Send to phone" in the menus (transfer.ts).
  const phone = useTransfer();
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
  // Only whether a result card shows: progress messages don't redraw the library.
  const taskCards = useTaskPart(hasTaskCards);
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
    let idle: ReturnType<typeof setTimeout> | null = null;
    const onMain = () => {
      if (!sc || restoring.current) return;
      setScroll(viewKRef.current, sc.scrollTop);
      // The anchor tile is looked for once the scrolling pauses, not every frame
      // (it measures every tile on screen, which forces a layout mid-scroll).
      const k = viewKRef.current;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = 0;
          // (Another view by now: its tiles aren't the ones that were scrolled.)
          if (!restoring.current && viewKRef.current === k) setScrollAnchor(k, findAnchor(sc));
        });
      }, 250);
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
      if (idle) clearTimeout(idle);
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
    const a = onEvent<StorageProgress>('storage-progress', () => setStorageJob(true));
    const b = onEvent<StorageDone>('storage-done', (d) => {
      setStorageJob(false);
      setStorageMsg(d);
      api.storageInfo().then(setStorage).catch(() => {});
    });
    return () => {
      a.then((u) => u());
      b.then((u) => u());
    };
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
    await saveAppConfig((c) => ({ ...c, ...patch }));
    await nav.refresh();
  };

  /**
   * Load the page again. `bg`: because of background work (an import or a conversion
   * finished, thumbnails arrived): no "loading…", unchanged things keep their objects,
   * and what is on screen keeps its order (calm.ts). Views worked out from the
   * fingerprints (similar, look-alikes) aren't recomputed then.
   */
  /** Each load gets a number: an answer that arrives after a newer load started is dropped. */
  const loadGen = useRef(0);
  /** The folder of the view before (to select it when you come back up out of it). */
  const cameFrom = useRef<number | null>(null);
  /** The view whose items are showing (set when its load finishes). */
  const loadedFor = useRef<string | null>(null);
  const reload = useCallback(async (opts?: { bg?: boolean; quiet?: boolean }) => {
    const bg = !!opts?.bg;
    const gen = ++loadGen.current;
    // (Clicking folder A then B quickly: A's answer must never fill B's grid.)
    const stale = () => gen !== loadGen.current;
    // `quiet`: after something you did (it already shows): no "loading…", and unchanged
    // things keep their objects so only what changed draws again (the order is fresh, though).
    const keep = bg || !!opts?.quiet;
    bgList.current = bg;
    const setFolders = (f: FolderCard[]) => !stale() && setFoldersRaw((prev) => (keep ? reuseSame(prev, f, (x) => x.id, shallowSame) : f));
    const setSubfolders = (f: FolderCard[]) => !stale() && setSubfoldersRaw((prev) => (keep ? reuseSame(prev, f, (x) => x.id, shallowSame) : f));
    const setItems = (f: Item[]) => !stale() && setItemsRaw((prev) => (keep ? reuseSame(prev, f, (x) => x.id, shallowSame) : f));
    const setFolder = (f: FolderCard | null) => !stale() && setFolderRaw(f);
    const setTags = (t: TagCount[]) => !stale() && setTagsRaw(t);
    const setTrash = (t: TrashView | null) => !stale() && setTrashRaw(t);
    const setError = (e: string | null) => !stale() && setErrorRaw(e);
    if (!keep) setLoading(true);
    else if (view.kind === 'similar' || view.kind === 'lookalikes') {
      // Only the folders and tags (the sidebar) then.
      const page = await api.libraryPage(null, false).catch(() => null);
      if (page) {
        setFolders(page.folders);
        tabsRef.current?.onFolders(page.folders);
        setTags(page.tags);
      }
      return;
    }
    try {
      // A folder's own card and its subfolders come from the full folder
      // list, so the library works out every folder's counts once, not twice.
      const inFolder = view.kind === 'folder' ? view.id : undefined;
      // One call for folders, tags and the folder's items (and its focus).
      const page = await api.libraryPage(inFolder !== undefined ? { folder: inFolder } : null, inFolder !== undefined);
      const { folders: f, tags: t, items: folderItems } = page;
      setFolders(f);
      tabsRef.current?.onFolders(f);
      setTags(t);
      setTrash(null);
      if (view.kind === 'folder' && folderItems) {
        const here = view.id == null ? null : f.find((x) => x.id === view.id) ?? null;
        if (view.id != null && !here) {
          // Gone meanwhile (deleted, merged; an old tab or Back): to All folders, not an error.
          if (!stale()) {
            setNote({ text: 'That folder no longer exists, so here are all folders.', at: 0 });
            setView({ kind: 'folders' });
          }
          return;
        }
        setFolder(here);
        setSubfolders(f.filter((x) => (x.parentId ?? null) === (view.id ?? null)));
        setItems(folderItems);
        // (Background work already does this folder first: libraryPage's focusHere.)
      } else {
        setFolder(null);
        setSubfolders([]);
        if (view.kind === 'folders' || view.kind === 'stats' || view.kind === 'people') setItems([]);
        else if (view.kind === 'lookalikes') setLookTick((t) => t + 1); // the page fetches its groups
        else if (view.kind === 'continue') setItems(await api.continueWatching());
        else if (view.kind === 'memories') setItems([]);
        else if (view.kind === 'similar') {
          const [me, hits] = await Promise.all([api.getItem(view.id).catch(() => null), api.similarTo(view.id)]);
          setItems([...(me && me.deletedAt == null ? [me] : []), ...hits.map((h) => h.item)]);
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
      if (!stale()) loadedFor.current = viewKey(view);
      if (!keep && !stale()) setLoading(false);
      // Background work may start now (firstgrid.ts).
      gridShown();
    }
  }, [view]);
  /** Load again because of background work, once you have paused (calm.ts). */
  const reloadCalmly = useCallback(() => calmly('library-reload', () => void reloadRef.current({ bg: true })), []);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  // ---- the last views, shown at once (back/forward, tabs) ----
  // What each of the last few views showed is kept in memory; going back to one shows it at
  // once, and it is loaded again quietly behind (anything changed meanwhile then appears).
  const viewCache = useRef(new Map<string, { items: Item[]; folder: FolderCard | null; subfolders: FolderCard[]; trash: TrashView | null }>());
  useEffect(() => {
    // Only what was loaded for this very view (right after switching, the old view's items still show).
    if (loading || loadedFor.current !== viewK) return;
    const c = viewCache.current;
    c.delete(viewK);
    c.set(viewK, { items, folder, subfolders, trash });
    while (c.size > 12) c.delete(c.keys().next().value as string);
  }, [items, folder, subfolders, trash, loading]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!prefsReady) return;
    let live = true;
    const cached = viewCache.current.get(viewKRef.current);
    if (cached) {
      loadedFor.current = viewKRef.current;
      setItemsRaw(cached.items);
      setFolderRaw(cached.folder);
      setSubfoldersRaw(cached.subfolders);
      setTrashRaw(cached.trash);
    }
    // Switching tabs puts back that tab's selection.
    const kept = takeSelection(viewKRef.current);
    setSelected(new Set(kept?.items));
    setAnchor(null);
    setCursor(null);
    setQuick(null);
    // The folder you are in is the selected folder (so the sidebar shows one thing, and Delete works on it).
    const here = view.kind === 'folder' && view.id != null ? view.id : null;
    // Coming up out of a subfolder (Back, Up, the breadcrumb): that subfolder is selected, as in
    // Explorer, so you keep your place among its sisters.
    const from = cameFrom.current;
    cameFrom.current = here;
    const parentOfFrom = from != null ? folders.find((f) => f.id === from)?.parentId ?? null : undefined;
    const outOf = !kept && from != null && parentOfFrom !== undefined && (view.kind === 'folder' || view.kind === 'folders') && parentOfFrom === here ? from : null;
    setSelFolders(kept ? new Set(kept.folders) : outOf != null ? new Set([outOf]) : here != null ? new Set([here]) : new Set());
    setFolderAnchor(outOf ?? here);
    if (outOf != null) {
      setTimeout(() => {
        if (live) scroller.current?.querySelector<HTMLElement>(`[data-card="${outOf}"]`)?.scrollIntoView({ block: 'nearest' });
      }, 60);
    }
    // Timing panel (perf.ts): the page, then its first thumbnails.
    const what = viewTitle(view, null);
    beginStep('Open view', what);
    dropStep('First thumbnails');
    // Shown from memory: loaded again quietly (no "loading…", unchanged tiles stay as they are).
    if (cached) requestAnimationFrame(() => live && restoreScroll());
    (cached ? reload({ quiet: true }) : reload()).then(() => {
      if (!live) return dropStep('Open view');
      restoreScroll();
      endStep('Open view');
      beginStep('First thumbnails', what);
      whenImagesShown(scroller.current, () => live && endStep('First thumbnails'));
    });
    return () => {
      live = false;
    };
  }, [reload, restoreScroll, prefsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => rememberSelection(viewKRef.current, selected, selFolders), [selected, selFolders]);
  // Remember when each folder was opened (the "Recently opened" sort).
  const openedId = view.kind === 'folder' ? view.id : null;
  const markOpened = fprefs.markOpened;
  useEffect(() => {
    if (openedId != null) markOpened(openedId);
  }, [openedId, markOpened]);

  // Folder covers appear as soon as their first thumbnail is made (each cover
  // loads again by itself: thumbver.ts); the folder list follows once you pause.
  useEffect(() => onThumb(() => calmly('library-folders', () => {
    api.folders().then((f) => {
      bgList.current = true;
      setFoldersRaw((prev) => reuseSame(prev, f, (x) => x.id, shallowSame));
    }).catch(() => {});
  })), []);
  // A rotation saved in the viewer changes an item's shape: load again once the viewer closes.
  const itemsStale = useRef(false);
  useEffect(() => onItemsChanged(() => { itemsStale.current = true; }), []);
  useEffect(() => {
    if (frozen || !itemsStale.current) return;
    itemsStale.current = false;
    reload();
  }, [frozen]); // eslint-disable-line react-hooks/exhaustive-deps

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
        await reload({ quiet: true });
        nav.refresh().catch(() => {});
      }
    } catch (e) {
      setError(`Couldn't undo: ${errText(e)}`);
    }
  }, [reload]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Anything open on top (a menu, a dialog, the museum, the river…) has the keys (keylayers.ts).
      if (e.defaultPrevented && e.key.startsWith('Arrow')) return; // the sidebar used it
      if (asleepRef.current || !noLayerOpen() || museumOpen() || riverOpen() || faceToolOpen() || (e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      // The face wall shows instead of the grid: what is selected there can't be seen, so no selection keys.
      const hiddenSel = keyActions.current.selectionHidden();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (hiddenSel && (e.key === 'Delete' || e.key === 'F2' || ((e.ctrlKey || e.metaKey) && ['a', 'x', 'c'].includes(e.key.toLowerCase())))) {
        return;
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
      } else if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key.startsWith('Arrow') && keyActions.current.cardArrow(e.key, e.shiftKey)) {
        e.preventDefault();
      } else if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        keyActions.current.up();
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
  // The library's cards show in the app's one message column (components/Messages.tsx).
  const [noteSlot, setNoteSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setNoteSlot(document.getElementById(MESSAGE_SLOT)), []);
  // Results and problems close by themselves after a while (hovering keeps them open).
  useAutoDismiss(storageMsg, () => setStorageMsg(null), storageMsg && !storageMsg.ok ? PROBLEM_MS : RESULT_MS, noteHover);
  useAutoDismiss(reports.length ? reports[0].job : null, () => setReports((rs) => rs.slice(1)), reports[0]?.failed.length ? PROBLEM_MS : RESULT_MS, noteHover);
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
  /** Items by id (a lookup, not a search through the list: with thousands selected, every redraw used to search the list once per selected item). */
  const itemIndex = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const itemById = (id: number) => itemIndex.get(id) ?? known.current.get(id);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload({ quiet: true });
    } catch (e) {
      setError(errText(e));
      // Anything shown ahead of time goes back to how it really is.
      void reload({ quiet: true });
    }
  };
  /** A folder got a new cover: then the cover editor opens, to choose what part shows. */
  const coverSet = (folderId: number, media: number) => act(async () => {
    await api.setCover(folderId, media);
    setDialog({ t: 'coverFrame', folder: folderId });
  });

  /**
   * Show a change at once (before the backend has it): `patch` gives the item's new
   * look, or null when it leaves this view. The quiet reload afterwards puts right
   * anything that came out differently.
   */
  const patchItems = (ids: number[], patch: (i: Item) => Item | null) => {
    const set = new Set(ids);
    setItemsRaw((prev) => {
      let changed = false;
      const out: Item[] = [];
      for (const i of prev) {
        if (!set.has(i.id)) {
          out.push(i);
          continue;
        }
        changed = true;
        const n = patch(i);
        if (n) out.push(n);
      }
      return changed ? out : prev;
    });
  };
  const moveItems = async (ids: number[], target: number | null) => {
    const before = groupBy(ids, (id) => itemById(id)?.folderId ?? null);
    // They leave the folder on screen right away.
    if (view.kind === 'folder' && view.id !== target) patchItems(ids, () => null);
    await api.moveItems(ids, target).catch((e) => {
      void reload({ quiet: true });
      throw e;
    });
    bumpMoveStat(target);
    const name = target === null ? 'Top level' : folders.find((f) => f.id === target)?.name ?? 'folder';
    did(`Moved ${plural(ids.length, 'item')} to “${name}”`, async () => {
      for (const [f, g] of before) await api.moveItems(g, f);
    });
    setSelected(new Set());
    await reload({ quiet: true });
  };
  const setFav = (ids: number[], on: boolean) => act(async () => {
    const before = groupBy(ids, (id) => !!itemById(id)?.favourite);
    patchItems(ids, (i) => ({ ...i, favourite: on }));
    await api.setFavourite(ids, on);
    did(on ? `Added ${plural(ids.length, 'item')} to favourites` : `Removed ${plural(ids.length, 'item')} from favourites`, async () => {
      for (const [f, g] of before) await api.setFavourite(g, f);
    });
  });
  const setWeight = async (ids: number[], w: number) => {
    const before = groupBy(ids, (id) => itemById(id)?.weight ?? 1);
    patchItems(ids, (i) => ({ ...i, weight: w }));
    await api.setWeight(ids, w);
    did(`Weight ${w} for ${plural(ids.length, 'item')}`, async () => {
      for (const [old, g] of before) await api.setWeight(g, old);
    });
    await reload({ quiet: true });
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
    if (!leaveDeleted([f])) await reload({ quiet: true });
    nav.refresh().catch(() => {});
  };
  const moveFolder = async (f: FolderCard, parent: number | null) => {
    await api.moveFolder(f.id, parent);
    did(`Moved “${f.name}”`, () => api.moveFolder(f.id, f.parentId));
    await reload({ quiet: true });
  };
  const tagFolder = async (f: FolderCard, list: string[]) => {
    const fresh = list.map((t) => t.trim().replace(/^#/, '')).filter((t) => t && !f.tags.some((x) => x.toLowerCase() === t.toLowerCase()));
    await api.tagFolder(f.id, list);
    if (fresh.length) did(`Tagged “${f.name}”`, async () => { for (const t of fresh) await api.untagFolder(f.id, t); });
    await reload({ quiet: true });
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
    await reload({ quiet: true });
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
    anySelected: () => false as boolean, openFolder: () => false as boolean, rename: () => {}, selectionHidden: () => false as boolean,
    cardArrow: (_k: string, _shift: boolean) => false as boolean, up: () => {},
    clip: (_m: 'cut' | 'copy') => {}, paste: () => {},
  });
  keyActions.current = {
    selected,
    selectionHidden: () => faceWall,
    // Arrow keys move between folder cards too (like items); down from the last row goes on into the items.
    cardArrow: (k: string, shift: boolean) => {
      if (selected.size || selFolders.size !== 1) return false;
      const [id] = selFolders;
      const i = cards.findIndex((c) => c.id === id);
      if (i < 0) return false;
      const per = Math.max(1, cols - 1);
      const j = k === 'ArrowLeft' ? i - 1 : k === 'ArrowRight' ? i + 1 : k === 'ArrowUp' ? i - per : i + per;
      if (j >= cards.length && k === 'ArrowDown' && gridView && shown.length && Math.floor(i / per) === Math.floor((cards.length - 1) / per)) {
        setSelFolders(new Set());
        setSelected(new Set([shown[0].id]));
        setAnchor(shown[0].id);
        setCursor(shown[0].id);
        return true;
      }
      const n = Math.max(0, Math.min(cards.length - 1, j));
      const next = cards[n];
      if (shift && folderAnchor != null) {
        const a = cards.findIndex((c) => c.id === folderAnchor);
        if (a >= 0) {
          const [lo, hi] = a < n ? [a, n] : [n, a];
          setSelFolders(new Set(cards.slice(lo, hi + 1).map((c) => c.id)));
          document.querySelector<HTMLElement>(`[data-card="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
          return true;
        }
      }
      setSelFolders(new Set([next.id]));
      setFolderAnchor(next.id);
      document.querySelector<HTMLElement>(`[data-card="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      return true;
    },
    // Only the folder you are in (it shows as selected) doesn't count: Ctrl+C / Ctrl+X / F2
    // would otherwise copy, cut or rename the folder around you (Delete already guarded this).
    anySelected: () => selected.size > 0 || (selFolders.size > 0 && !(view.kind === 'folder' && selFolders.size === 1 && selFolders.has(view.id ?? -1))),
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
    // Alt+↑: the folder this one is in (and, from the top level, the folder list).
    up: () => {
      if (view.kind !== 'folder') return;
      if (view.id == null) setView({ kind: 'folders' });
      else openFolder(folders.find((f) => f.id === view.id)?.parentId ?? folder?.parentId ?? null);
    },
    typeJump: (k: string) => typeJump(k),
    selectAll: () => selectAll(),
    selectNone: () => {
      setSelected(new Set());
      setSelFolders(new Set());
    },
    del: () => {
      const ids = [...selected];
      // Only the folder you are in (it shows as selected): Delete doesn't delete the folder around you.
      if (!ids.length && view.kind === 'folder' && selFolders.size === 1 && selFolders.has(view.id ?? -1)) return;
      if (selFolders.size && view.kind !== 'trash') {
        askDeleteMany();
        return;
      }
      if (view.kind === 'trash') setDialog({ t: 'forever', ids, folder: null, what: plural(ids.length, 'item') });
      else if (view.kind === 'lookalikes') setDialog({ t: 'deleteMany', folders: [], items: ids });
      else trashItems(ids);
    },
  };

  // The mouse's back / forward buttons do what Backspace / Alt+→ do here (App, keylayers.ts).
  useEffect(() => {
    if (frozen) return;
    setScreenNav({ back: () => keyActions.current.back(), forward: () => keyActions.current.forward() });
    return () => setScreenNav(null);
  }, [frozen]);

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
      // Once you pause, in place (calm.ts).
      reloadCalmly();
      nav.refresh().catch(() => {});
    });
    // Items that arrived from the phone are in the library now: the same as an import finishing.
    const offPhone = onTransferArrived(() => {
      kickThumbnails();
      reloadCalmly();
      nav.refresh().catch(() => {});
    });
    return () => {
      b.then((u) => u());
      offPhone();
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
  // A person's own page, their timeline or a search for just them: the face tools (face wall, Best faces, time-lapse).
  const facePerson = view.kind === 'folder' && folder?.person ? folder.id : view.kind === 'timeline' && view.person != null ? view.person
    : view.kind === 'search' && view.people?.length === 1 && !view.tags.length && !view.names.length ? view.people[0] : null;
  const facePersonName = facePerson != null ? folders.find((f) => f.id === facePerson)?.name ?? 'Person' : '';
  const [faceWallFor, setFaceWallFor] = useState<number | null>(null);
  const faceWall = facePerson != null && faceWallFor === facePerson;
  const inTrash = view.kind === 'trash';
  // Each item's grid entry is made once per item object (unchanged items keep
  // theirs, so their tiles don't draw again: MediaGrid's Tile is memoised).
  const deco = useRef(new WeakMap<Item, Item & { key: string; added: number; date: number }>());
  const shownFresh = useMemo(() => {
    const d = (i: Item) => {
      let x = deco.current.get(i);
      if (!x) deco.current.set(i, (x = { ...i, key: String(i.id), added: i.importedAt, date: i.takenAt }));
      return x;
    };
    const k = kind === 'any' ? items : items.filter((i) => i.kind === kind);
    if (timeline) {
      const dir = sort === 'oldest' ? 1 : -1;
      return [...k].sort((a, b) => dir * (a.takenAt - b.takenAt) || dir * (a.id - b.id)).map(d);
    }
    if (inTrash || view.kind === 'similar') return k.map(d);
    return sorted(k.map(d), sort);
  }, [items, kind, sort, timeline, inTrash, view.kind]);
  // After background work, what is on screen keeps its place (calm.ts).
  const shown = useStableList(shownFresh, (x) => x.id, bgList.current, `${viewK}|${sort}|${kind}`);
  const groups = useMemo(() => (timeline ? monthGroups(shown.map((i) => i.takenAt)) : undefined), [timeline, shown]);
  // Faces of the items shown, for face boxes and face-aware tiles.
  const wantFaces = faceBoxesOn || look.faceCrop;
  const faceKey = wantFaces ? shown.filter((i) => i.kind === 'image' || i.kind === 'gif').map((i) => i.id).join(',') : '';
  useEffect(() => {
    if (!faceKey) return;
    let live = true;
    const ids = faceKey.split(',').map(Number).filter((id) => !gridFaces.has(id));
    if (!ids.length) return;
    // In batches (the backend takes up to 2,000 at a time), so every item gets its faces.
    void (async () => {
      for (let i = 0; i < ids.length && live; i += 2000) {
        const part = ids.slice(i, i + 2000);
        const res = await api.facesOfMany(part).catch(() => null);
        if (!live || !res) return;
        setGridFaces((m) => {
          const n = new Map(m);
          for (const id of part) if (!n.has(id)) n.set(id, []);
          for (const [id, f] of res) n.set(id, f);
          return n;
        });
      }
    })();
    return () => {
      live = false;
    };
  }, [faceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sidebar tree, every level sorted the same way; folder cards sorted by the Sort menu.
  // Steady (foldersort.ts): the numbers a sort uses are taken when the sort is chosen
  // (or chosen again), so background work and opening folders don't reshuffle them.
  const sideSnap = useRef<SortSnap | null>(null);
  const cardSnap = useRef<SortSnap | null>(null);
  const [resort, setResort] = useState(0);
  const tree = useMemo(() => {
    sideSnap.current = updateSnap(sideSnap.current, `${sideSort}#${resort}`, folders, fprefs.opened);
    return sortSteady(folders, sideSnap.current, (l, o) => sortTree(l, sideSort, o));
  }, [folders, sideSort, fprefs.opened, resort]);
  const cards = useMemo(() => {
    const list = view.kind !== 'folders' ? subfolders : !everyFolder ? folders.filter((f) => f.parentId === null) : folders;
    if (view.kind === 'folders' && everyFolder && cardSort === 'own') return folders;
    cardSnap.current = updateSnap(cardSnap.current, `${cardSort}#${resort}#${viewK}`, list, fprefs.opened);
    return sortSteady(list, cardSnap.current, (l, o) => sortFolders(l, cardSort, o));
  }, [view.kind, subfolders, folders, everyFolder, cardSort, fprefs.opened, resort, viewK]);
  const pinned = useMemo(() => {
    const list = folders.filter((f) => f.pinned);
    if (!sideSnap.current) return sortPinned(list, sideSort, fprefs.pins, fprefs.opened);
    return sortSteady(list, sideSnap.current, (l, o) => sortPinned(l, sideSort, fprefs.pins, o));
  }, [folders, sideSort, fprefs.pins, fprefs.opened, tree]); // eslint-disable-line react-hooks/exhaustive-deps
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
      // In a folder: its slideshow settings and where you stopped are remembered.
      place: view.kind === 'folder' ? { key: view.id == null ? 'top' : `f${view.id}`, name: view.id == null ? 'Top level' : folder?.name ?? 'this folder' } : null,
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
  // Grid and card previews rest through previewgate.ts; any other video here is paused too.
  const coverKey = useId();
  useEffect(() => {
    setPreviewCover(coverKey, frozen);
    return () => setPreviewCover(coverKey, false);
  }, [frozen, coverKey]);
  useEffect(() => {
    const el = root.current;
    if (!frozen || !el) return;
    setHoveredCard(null);
    const paused = [...el.querySelectorAll('video')].filter((v) => !v.paused && !v.dataset.gated);
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
    if (list.length) nav.go({ name: 'viewer', items: list.map(fromItem), title: f.name, auto: true, back: view, person: f.person ? f.id : null, place: { key: `f${f.id}`, name: f.name } });
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
  // Typing a letter in the folder list (left side) jumps to the next folder whose name starts
  // with it, like Explorer: E → "Easy", E again → "Emine", then "Ezgi"; F → "Felek". Letters typed
  // quickly one after another spell the start of a name ("em" → "Emine"). Folded folders are
  // skipped. In the right-hand side (the folder's contents) letters do nothing.
  const sideZone = useRef(false);
  const typeJump = (k: string) => {
    const focus = document.activeElement;
    if (focus?.closest('.lib-main') || (!sideZone.current && !focus?.closest('.side-col'))) return;
    const now = Date.now();
    const b = jumpBuf.current;
    const fresh = now - b.at > 900;
    b.at = now;
    // The same letter again cycles; a different one quickly after spells a longer start.
    b.text = fresh || b.text === k || (b.text.length === 1 && foldName(b.text) === foldName(k)) ? k : b.text + k;
    const q = foldName(b.text);
    const rows = [...document.querySelectorAll<HTMLElement>('.side-col .side-row.tree[data-order], .side-col .rail-folder[data-order]')];
    if (!rows.length) return;
    const nameOf = (el: HTMLElement) => folders.find((f) => f.id === Number(el.dataset.order))?.name ?? '';
    const focused = document.activeElement?.closest<HTMLElement>('[data-order]');
    const at = focused ? rows.indexOf(focused) : -1;
    // A single letter starts after the folder you're on; a longer start may match that folder itself.
    const from = q.length === 1 ? at + 1 : Math.max(0, at);
    const order = [...rows.slice(from), ...rows.slice(0, from)];
    let hit = order.find((el) => foldName(nameOf(el)).startsWith(q));
    if (!hit && q.length > 1) {
      // No name starts like that: the new letter on its own (E then F quickly → "Felek").
      b.text = k;
      const one = foldName(k);
      const next = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
      hit = next.find((el) => foldName(nameOf(el)).startsWith(one));
    }
    if (!hit) return;
    const btn = hit.matches('button') ? hit : hit.querySelector<HTMLElement>('.tree-name');
    btn?.focus({ preventScroll: true });
    hit.scrollIntoView({ block: 'nearest' });
    const id = Number(hit.dataset.order);
    setSelected(new Set());
    setSelFolders(new Set([id]));
    setFolderAnchor(id);
  };
  /** What "Prepare 3D data" says it did. */
  const prepNote = (r: 'started' | 'queued' | 'already', what: string, faces = false, inUse = false) => {
    const pics = faces ? `the pictures with faces in ${what}` : `the pictures in ${what}`;
    const models = inUse ? 'for the models in use' : 'for every installed model';
    setNote({ text: r === 'already' ? `Already preparing ${pics}.` : r === 'queued' ? `${pics[0].toUpperCase()}${pics.slice(1)} will be prepared for 3D (${models}) after the job running now.` : `Preparing ${pics} for 3D in the background, ${models}${faces ? '; pictures not scanned for faces yet are left out' : ''}. See the ring in the title bar.`, at: 0 });
  };
  const folderMenuRef = useRef<(f: FolderCard) => MenuItem[]>(() => []);
  /** A submenu row (clicking it only opens the submenu). */
  const group = (label: string, sub: (MenuItem | false | null | undefined)[], more: Partial<MenuItem> = {}): MenuItem =>
    ({ label, subOnly: true, onSelect: () => {}, sub: sub.filter((x): x is MenuItem => !!x), ...more });
  // About 15 rows, the rest in submenus (Play, Appearance, Faces, 3D, Share and export).
  const folderMenu = (f: FolderCard): MenuItem[] => [
    { label: 'Open', onSelect: () => openFolder(f.id) },
    ...(tabs ? [{ label: 'Open in new tab', hint: 'middle-click', onSelect: () => tabs.open({ kind: 'folder', id: f.id }) }] : []),
    group('Play', [
      { label: 'Slideshow', hint: 'Shift + middle-click', onSelect: async () => {
        const list = await api.queryItems({ folder: f.id, recursive: true });
        if (list.length) nav.go({ name: 'viewer', items: list.map(fromItem), title: f.name, auto: true, back: view, person: f.person ? f.id : null, place: { key: `f${f.id}`, name: f.name } });
      } },
      { label: 'Walk through as a museum', hint: '3D', onSelect: () => openFolderMuseum(f, (text) => setNote({ text, at: 0 })) },
      { label: 'Discovery river from here', hint: 'drift through it', onSelect: () => openFolderRiver(f, (text) => setNote({ text, at: 0 })) },
      { label: 'Speed round', hint: 'favourite fast', sepBefore: true, onSelect: () => startSpeedRound(f) },
      { label: 'Duel', hint: 'pick favourites, set weights', onSelect: () => startDuel(f) },
      { label: 'Slot machine', hint: 'feeling lucky?', onSelect: () => setDialog({ t: 'slots', folder: f }) },
      { label: 'Quick sort', hint: 'send items to folders fast', sepBefore: true, onSelect: () => setDialog({ t: 'quickSort', folder: f }) },
    ]),
    { label: 'Cut', hint: 'Ctrl+X', sepBefore: true, onSelect: () => clipThese('cut', [f.id], []) },
    { label: 'Copy', hint: 'Ctrl+C', onSelect: () => clipThese('copy', [f.id], []) },
    ...(clipboard || inTauri ? [{ label: 'Paste here', hint: 'Ctrl+V', onSelect: () => { paste(f.id).catch((err) => setError(errText(err))); } }] : []),
    { label: f.pinned ? 'Unpin from the top' : 'Pin to the top', sepBefore: true, onSelect: () => setPinned(f, !f.pinned) },
    group('Appearance', [
      { label: 'Colour and emoji…', onSelect: () => setDialog({ t: 'look', folder: f }) },
      { label: 'Choose cover…', onSelect: () => setDialog({ t: 'cover', folder: f }) },
      f.cover != null && { label: 'Adjust cover…', hint: 'drag and zoom', onSelect: () => setDialog({ t: 'coverFrame', folder: f.id }) },
      { label: bannerOf(f.id) ? 'Change banner…' : 'Set banner…', hint: 'wide, at the top', onSelect: () => setDialog({ t: 'banner', folder: f }) },
      !!bannerOf(f.id) && { label: 'Remove banner', onSelect: () => removeBanner(f) },
    ]),
    { label: 'Add tag…', onSelect: () => setDialog({ t: 'folderTag', folder: f }) },
    { label: 'Note…', hint: f.note ? 'has a note' : undefined, onSelect: () => setDialog({ t: 'note', folder: true, id: f.id, name: f.name, note: f.note }) },
    group('Faces', [
      { label: 'Person folder', hint: 'face recognition', checked: f.person, onSelect: () => setPersonFolder(f, !f.person) },
      ...(facesOff.has(f.id)
        ? [{ label: 'Enable face search for this folder', hint: 'subfolders too', onSelect: () => setFaceSearch(f, false) }]
        : [
            { label: 'Scan for faces', onSelect: () => scanFaces({ folder: f.id }, `“${f.name}”`) },
            { label: 'Disable face search for this folder', hint: 'subfolders too', onSelect: () => setFaceSearch(f, true) },
          ]),
      { label: 'Sort into person folders…', hint: 'recognised people', sepBefore: true, onSelect: () => openSortAll(true, { folder: f.id, label: `“${f.name}”` }) },
      { label: 'Separate pictures without faces…', hint: 'move them to a folder', onSelect: () => setDialog({ t: 'separate', folder: { id: f.id, name: f.name } }) },
      f.person && { label: 'Person timeline', hint: 'by date', onSelect: () => setView({ kind: 'timeline', person: f.id }) },
      f.person && { label: 'Face time-lapse', hint: 'faces lined up, fast', onSelect: () => openFaceTool('timelapse', f.id, f.name) },
      { label: 'Find look-alikes in here', onSelect: () => setView({ kind: 'lookalikes', folder: f.id }) },
      { label: 'Delete face data…', hint: 'faces found in here', danger: true, sepBefore: true, onSelect: () => setDialog({ t: 'delFaces', folder: f }) },
    ]),
    group('3D data', [
      // "Models in use": only the depth and outline models chosen in the 3D settings (quicker, less space).
      { label: 'Prepare 3D data, models in use', hint: 'the ones chosen in 3D settings', onSelect: () => prepNote(prepareFolder({ id: f.id, name: f.name, person: f.person }, false, true), `“${f.name}”`, false, true) },
      { label: 'Prepare 3D data, every installed model', hint: 'takes longer', onSelect: () => prepNote(prepareFolder({ id: f.id, name: f.name, person: f.person }), `“${f.name}”`) },
      { label: 'Pictures with faces only, models in use', hint: 'scanned ones', sepBefore: true, onSelect: () => prepNote(prepareFolder({ id: f.id, name: f.name, person: f.person }, true, true), `“${f.name}”`, true, true) },
      { label: 'Pictures with faces only, every installed model', hint: 'scanned ones', onSelect: () => prepNote(prepareFolder({ id: f.id, name: f.name, person: f.person }, true), `“${f.name}”`, true) },
      { label: 'Delete 3D data…', hint: 'choose which', danger: true, sepBefore: true, onSelect: () => setDialog({ t: 'del3d', what: `“${f.name}”`, folders: [{ id: f.id, name: f.name, person: f.person }], ids: [] }) },
    ]),
    (() => {
      const at = previewsOffAt(f);
      return at === f
        ? { label: 'Make preview clips here again', hint: 'subfolders too', onSelect: () => setPreviewClips([f], false) }
        : at
          ? { label: 'Preview clips are off here', hint: `set on “${at.name}”`, disabled: true, onSelect: () => {} }
          : { label: "Don't make preview clips here", hint: 'subfolders too', onSelect: () => setPreviewClips([f], true) };
    })(),
    { label: 'Delete preview clips here…', hint: 'subfolders too', onSelect: () => setDialog({ t: 'delPreviews', folders: [f] }) },
    // What the bottom bar can do with a selected folder, here too (mediaActions).
    group('Everything inside', menuOf(mediaActions([f], [], null).filter((x) => ['fav', 'tags', 'weight', 'convert', 'gif'].includes(x.id))).map((x) => ({ ...x, label: x.label.replace(' (everything inside)', '') })),
      { hint: 'favourite, tags, weight…' }),
    group('Share and export', [
      { label: 'Share as encrypted .7z…', onSelect: () => setDialog({ t: 'share', ids: [], folders: [f.id], what: `“${f.name}”` }) },
      { label: 'Export decrypted…', onSelect: () => setDialog({ t: 'export', request: { folder: f.id }, what: `“${f.name}”` }) },
      !!phone.status?.peers.length && { label: 'Send to phone', hint: phone.status.connected ?? 'Open Aktarım on your phone', disabled: !phone.status.connected,
        onSelect: () => { api.transferSend([], [f.id]).then((r) => { if (!r.items) say('There is nothing in there to send.', 'note'); }).catch((e) => say(errText(e), 'problem')); } },
    ]),
    { label: 'New folder inside…', sepBefore: true, onSelect: () => setDialog({ t: 'newFolder', parent: f.id }) },
    { label: 'Rename…', hint: 'F2', onSelect: () => renameFolderAsk(f) },
    { label: 'Move to…', onSelect: () => setDialog({ t: 'moveFolder', folder: f }),
      sub: moveSub((to) => { moveFolder(f, to.id).catch((err) => setError(errText(err))); }, [f.id, ...(f.parentId != null ? [f.parentId] : [])], [], () => setDialog({ t: 'moveFolder', folder: f })) },
    { label: 'Extract here', hint: 'contents move up', onSelect: () => extractHere(f) },
    { label: 'Move to trash…', hint: 'Delete', danger: true, sepBefore: true, onSelect: () => setDialog({ t: 'deleteFolder', folder: f }) },
  ];
  folderMenuRef.current = folderMenu;

  const setPersonFolder = (f: FolderCard, on: boolean) => act(async () => {
    await api.setPersonFolder(f.id, on);
    did(on ? `“${f.name}” is now a person folder` : `“${f.name}” is no longer a person folder`, () => api.setPersonFolder(f.id, !on));
    if (on) {
      const n = await api.facesQueue({ folder: f.id });
      kickFaceScanner();
      if (n) setNote({ text: `Scanning ${plural(n, 'item')} in “${f.name}” for faces. See People.`, at: 0 });
    }
  });
  /** The folder (itself or one it is inside) where preview clips were turned off, if any. */
  const previewsOffAt = (f: FolderCard): FolderCard | null => {
    if (previewsOff.has(f.id)) return f;
    const up = [...f.path].reverse().find((c) => previewsOff.has(c.id));
    return up ? folders.find((x) => x.id === up.id) ?? null : null;
  };
  /** "Don't make preview clips here" / "Make preview clips here again" (subfolders too), undoable. */
  const setPreviewClips = (fs: FolderCard[], off: boolean) => act(async () => {
    const ids = fs.map((f) => f.id);
    const change = async (to: boolean) => {
      await api.previewsFolderOff(ids, to);
      setPreviewsOff((cur) => {
        const next = new Set(cur);
        for (const id of ids) {
          if (to) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    };
    await change(off);
    const what = fs.length === 1 ? `“${fs[0].name}”` : plural(fs.length, 'folder');
    did(off ? `No preview clips are made in ${what} (subfolders too)` : `Preview clips are made in ${what} again`, () => change(!off));
  });
  const [previewsAlsoOff, setPreviewsAlsoOff] = useState(true);
  const deletePreviewClips = async (fs: FolderCard[], alsoOff: boolean) => {
    try {
      if (alsoOff) {
        await api.previewsFolderOff(fs.map((f) => f.id), true);
        setPreviewsOff((cur) => new Set([...cur, ...fs.map((f) => f.id)]));
      }
      const n = await api.previewsDeleteFolders(fs.map((f) => f.id));
      const where = fs.length === 1 ? `“${fs[0].name}”` : plural(fs.length, 'folder');
      setNote({ text: n ? `Deleted the preview clips of ${plural(n, 'video')} in ${where}${alsoOff ? '; no new ones are made there' : ''}.` : `There were no preview clips in ${where}.`, at: 0 });
      void reload({ quiet: true });
    } catch (e) {
      setError(errText(e));
    }
  };
  const setFaceSearch = (f: FolderCard, off: boolean) => act(async () => {
    const n = await api.facesFolderOff(f.id, off);
    setFacesOff((cur) => {
      const next = new Set(cur);
      if (off) next.add(f.id);
      else next.delete(f.id);
      return next;
    });
    if (!off) kickFaceScanner();
    const label = off
      ? `Face search is off for “${f.name}”${n ? ` (${plural(n, 'item')} left the scan queue)` : ''}`
      : `Face search is on again for “${f.name}”${n ? ` · scanning ${plural(n, 'item')}` : ''}`;
    did(label, async () => {
      await api.facesFolderOff(f.id, !off);
      setFacesOff((cur) => {
        const next = new Set(cur);
        if (off) next.delete(f.id);
        else next.add(f.id);
        return next;
      });
    });
  });
  const deleteFaceData = async (f: FolderCard) => {
    try {
      const n = await api.facesDeleteFolder(f.id);
      noteFaceProgress();
      setNote({ text: n ? `Deleted ${plural(n, 'face')} found in “${f.name}”` : `No faces had been found in “${f.name}”`, at: 0 });
    } catch (e) {
      setError(errText(e));
    }
  };
  const deleteItemFaces = async (ids: number[], what: string) => {
    try {
      const n = await api.facesDeleteItems(ids);
      noteFaceProgress();
      setNote({ text: n ? `Deleted ${plural(n, 'face')} found in ${what}` : `No faces had been found in ${what}`, at: 0 });
    } catch (e) {
      setError(errText(e));
    }
  };
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

  /** Move folders and items to the same place, undone together. */
  const moveMixed = async (fs: FolderCard[], ids: number[], target: number | null) => {
    const movedFolders = fs.filter((f) => f.parentId !== target);
    const before = groupBy(ids, (id) => itemById(id)?.folderId ?? null);
    bumpMoveStat(target);
    const mv = await api.moveFolders(movedFolders.map((f) => [f.id, target]));
    if (mv.error) throw new Error(mv.error);
    if (ids.length) await api.moveItems(ids, target);
    const name = target === null ? 'Top level' : folders.find((f) => f.id === target)?.name ?? 'folder';
    const what = [movedFolders.length ? plural(movedFolders.length, 'folder') : '', ids.length ? plural(ids.length, 'item') : ''].filter(Boolean).join(' and ');
    did(`Moved ${what} to “${name}”`, async () => {
      await api.moveFolders(movedFolders.map((f) => [f.id, f.parentId]));
      for (const [f, g] of before) await api.moveItems(g, f);
    });
    setSelFolders(new Set());
    setSelected(new Set());
    await reload({ quiet: true });
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
    await reload({ quiet: true });
    nav.refresh().catch(() => {});
  };

  // ---- rubber-band selection: drag a box in empty space -------------------------------------
  /** The grid's own hit test (tiles scrolled out of the drawn range count too). */
  const gridHit = useRef<((r: { left: number; top: number; right: number; bottom: number }) => number[]) | null>(null);
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
    let last: PointerEvent | null = null;
    let edge = 0;
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
      // Scroll when the box reaches the edge (and keep scrolling while it stays there).
      last = ev;
      if (ev.clientY > sr.bottom - 30) sc.scrollTop += 20;
      else if (ev.clientY < sr.top + 30) sc.scrollTop -= 20;
      if (!edge && (ev.clientY > sr.bottom - 30 || ev.clientY < sr.top + 30)) {
        edge = window.setInterval(() => {
          if (!last || (last.clientY <= sr.bottom - 30 && last.clientY >= sr.top + 30)) {
            window.clearInterval(edge);
            edge = 0;
            return;
          }
          move(last);
        }, 50);
      }
      const hit = (el: Element) => {
        const b = el.getBoundingClientRect();
        return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
      };
      const its = gridHit.current ? gridHit.current(r) : [...sc.querySelectorAll<HTMLElement>('[data-item]')].filter(hit).map((el) => Number(el.dataset.item));
      const fs = [...sc.querySelectorAll<HTMLElement>('[data-card]')].filter(hit).map((el) => Number(el.dataset.card));
      setSelected(bandPick(startSel, its, true));
      setSelFolders(bandPick(startFolders, fs, true));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (edge) window.clearInterval(edge);
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
  const clipSelection = (mode: 'cut' | 'copy') => clipThese(mode, topMost(selFolders).map((f) => f.id), [...selected]);
  const clipThese = (mode: 'cut' | 'copy', fs: number[], ids: number[]) => {
    if (inTrash || looks) return;
    if (!fs.length && !ids.length) return;
    setClipboard({ mode, ids, folders: fs });
    const what = [fs.length ? plural(fs.length, 'folder') : '', ids.length ? plural(ids.length, 'item') : ''].filter(Boolean).join(' and ');
    setNote({ text: mode === 'cut' ? `Cut ${what}: right-click a folder and choose Paste here (or open it and press Ctrl+V)` : `Copied ${what}: Paste here (right-click a folder) or Ctrl+V puts copies in another folder, or on the desktop`, at: 0 });
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
  const paste = async (into?: number | null) => {
    const t = into !== undefined ? into : pasteTarget();
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
          await reload({ quiet: true });
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
      await api.deleteFolders(r.folders);
    });
    kickThumbnails();
    await reload({ quiet: true });
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
    await reload({ quiet: true });
  };
  /** "Separate pictures without faces": into a new folder inside `parent` or a chosen one; moved or free-copied; one undo. */
  const separate = async (parent: number, items: Item[], target: SeparateTarget, copy: boolean) => {
    let to: number | null;
    let made: number | null = null;
    if ('newName' in target) {
      to = made = await api.createFolder(parent, target.newName);
    } else to = target.id;
    const ids = items.map((i) => i.id);
    const name = 'newName' in target ? target.newName : to === null ? 'Top level' : folders.find((f) => f.id === to)?.name ?? 'folder';
    const dropMade = async () => {
      if (made != null) await api.deleteFolder(made).catch(() => {});
    };
    if (copy) {
      const copies = await api.freeCopy(ids, to);
      did(`Made ${plural(copies.length, 'free copy', 'free copies')} in “${name}”`, async () => {
        await api.deleteItems(copies);
        await api.deleteForever(copies);
        await dropMade();
      });
    } else {
      const byFolder = new Map(items.map((i) => [i.id, i.folderId ?? null] as const));
      const before = groupBy(ids, (id) => byFolder.get(id) ?? null);
      await api.moveItems(ids, to);
      bumpMoveStat(to);
      did(`Moved ${plural(ids.length, 'item')} to “${name}”`, async () => {
        for (const [f, g] of before) await api.moveItems(g, f);
        await dropMade();
      });
    }
    await reload({ quiet: true });
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
  /**
   * The "Move to ›" list: person folders of the people in the picture first, then the folders
   * moved into most, then "Choose any folder…" (`any`: the searchable list of every folder).
   */
  const moveSub = (go: (f: FolderCard) => void, except: number[] = [], people: number[] = [], any?: () => void): MenuItem[] => {
    const persons = people.map((id) => folders.find((f) => f.id === id)).filter((f): f is FolderCard => !!f && !except.includes(f.id));
    const rest = topFolders(8, [...except, ...persons.map((f) => f.id)]);
    return [
      ...persons.map((f) => ({ label: f.name, hint: 'in this picture', onSelect: () => go(f) })),
      ...rest.map((f, k) => ({ label: f.name, hint: f.path.map((c) => c.name).join(' › ') || undefined, sepBefore: k === 0 && persons.length > 0, onSelect: () => go(f) })),
      ...(any ? [{ label: 'Choose any folder…', hint: 'search every folder', sepBefore: persons.length + rest.length > 0, onSelect: any }] : []),
    ];
  };
  const finishMerge = async (m: Merged, target: FolderCard, sources: FolderCard[]) => {
    did(`Merged ${plural(sources.length, 'folder')} into “${target.name}”`, () => api.unmergeFolders(m));
    if (view.kind === 'folder' && sources.some((f) => f.id === view.id || folder?.path.some((c) => c.id === f.id))) setView({ kind: 'folder', id: target.id });
    else await reload({ quiet: true });
    setSelFolders(new Set());
    nav.refresh().catch(() => {});
  };
  const saveNote = async (isFolder: boolean, id: number, name: string, note: string | null) => {
    const old = await api.setNote(isFolder, id, note);
    did(note ? `Saved the note on “${name}”` : `Removed the note on “${name}”`, () => api.setNote(isFolder, id, old));
    await reload({ quiet: true });
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
    // Gone from the screen right away (to the trash).
    if (items.length && view.kind !== 'trash') patchItems(items, () => null);
    try {
      await api.deleteFolders(fs.map((f) => f.id));
      if (items.length) await api.deleteItems(items);
    } catch (e) {
      void reload({ quiet: true });
      throw e;
    }
    const what = [fs.length ? plural(fs.length, 'folder') : '', items.length ? plural(items.length, 'item') : ''].filter(Boolean).join(' and ');
    did(`Moved ${what} to the trash`, async () => {
      await api.restoreFolders(fs.map((f) => f.id));
      if (items.length) await api.restoreItems(items);
      for (const l of links) await api.restoreLinks(l);
    });
    setSelFolders(new Set());
    setSelected(new Set());
    if (!leaveDeleted(fs)) await reload({ quiet: true });
    nav.refresh().catch(() => {});
  };
  const moveFolders = async (fs: FolderCard[], parent: number | null) => {
    const done: FolderCard[] = [];
    try {
      const todo = fs.filter((f) => f.parentId !== parent);
      const r = await api.moveFolders(todo.map((f) => [f.id, parent]));
      done.push(...todo.slice(0, r.done));
      if (r.error) throw new Error(r.error);
    } finally {
      if (done.length) {
        did(done.length === 1 ? `Moved “${done[0].name}”` : `Moved ${plural(done.length, 'folder')}`, async () => {
          await api.moveFolders(done.map((f) => [f.id, f.parentId]));
        });
      }
      setSelFolders(new Set());
      await reload({ quiet: true });
    }
  };
  /** "Extract here": everything inside goes up one level; then ask about the empty folder. */
  const extractHere = async (f: FolderCard) => {
    try {
      const x = await api.extractFolder(f.id);
      setDialog({ t: 'extracted', folder: f, x });
      await reload({ quiet: true });
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
    else await reload({ quiet: true });
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
    const mv = await api.moveFolders(moving.map((g) => [g.id, parent]));
    if (mv.error) throw new Error(mv.error);
    // Siblings as you see them (after switching, your own order is what you saw).
    const siblings = tree.filter((x) => x.parentId === parent).map((x) => x.id);
    const order = placeIds(siblings, group.map((g) => g.id), targetId, edge);
    const before = await api.setFolderOrder(order);
    const label = group.length === 1 ? `Moved “${group[0].name}”` : `Moved ${plural(group.length, 'folder')}`;
    did(switchedText(label, !!unseed), async () => {
      await api.restoreFolderOrder(before);
      await api.moveFolders(moving.map((g) => [g.id, g.parentId]));
      if (unseed) await unseed();
    });
    await reload({ quiet: true });
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
    if (newlyPinned.length) await reload({ quiet: true });
  };

  // ---- one set of actions ------------------------------------------------------------------
  /**
   * Everything you can do with a selection (items, folders or both), defined once.
   * The right-click menus (an item, several items, several folders, the viewer's),
   * the bottom bar and the keys all come from this list, so the same thing can be
   * done the same way wherever it shows.
   */
  type Act = {
    id: string; label: string; hint?: string; icon?: React.ReactNode; danger?: boolean; sepBefore?: boolean; sub?: MenuItem[];
    /** In the bottom bar ('pinned': always at its right end), with this shorter label. */
    bar?: boolean | 'pinned'; barLabel?: string; title?: string;
    /** Not in right-click menus (the bar only). */
    noMenu?: boolean;
    /** In right-click menus, inside this submenu (keeps the menus short). */
    group?: string;
    /** In right-click menus only, not the bottom bar. */
    menuOnly?: boolean;
    /** Shown greyed out in menus (left out of the bottom bar). */
    disabled?: boolean;
    run: () => void;
  };
  /** The items inside these folders (and subfolders) plus these items, selected ones first. */
  const mediaOf = async (fs: FolderCard[], ids: number[]): Promise<Item[]> => {
    const out = new Map<number, Item>();
    const want = new Set(ids);
    for (const it of shown) if (want.has(it.id)) out.set(it.id, it);
    for (const id of ids) if (!out.has(id)) { const it = itemById(id) ?? (await api.getItem(id).catch(() => null)); if (it) out.set(id, it); }
    for (const f of fs) {
      for (const it of await api.queryItems({ folder: f.id, recursive: true })) {
        if (!out.has(it.id)) out.set(it.id, it);
        known.current.set(it.id, it);
      }
    }
    return [...out.values()];
  };
  const mediaActions = (fs: FolderCard[], ids: number[], anchor: Item | null, people: number[] = []): Act[] => {
    const nF = fs.length;
    const nI = ids.length;
    const itemsOnly = nF === 0;
    const one = itemsOnly && nI === 1 ? anchor ?? itemById(ids[0]) ?? null : null;
    const oneFolder = nF === 1 && !nI ? fs[0] : null;
    const many = nI > 1 || nF > 1 || (nI > 0 && nF > 0);
    const what = oneFolder ? `“${oneFolder.name}”` : one ? `“${one.name}”`
      : [nF ? plural(nF, 'folder') : '', nI ? plural(nI, 'item') : ''].filter(Boolean).join(' and ');
    const selIdSet = new Set(ids);
    const shownSel = shown.filter((x) => selIdSet.has(x.id));
    const failed = (p: Promise<unknown> | unknown) => {
      if (p instanceof Promise) p.catch((e) => setError(errText(e)));
    };
    /** Run on every item (folders count as all the items inside them). */
    const onAll = (fn: (list: Item[]) => unknown) => () => {
      failed((async () => {
        const list = await mediaOf(fs, ids);
        if (!list.length) return setNote({ text: 'There is nothing inside the selected folders.', at: 0 });
        await fn(list);
      })());
    };
    const inside = itemsOnly ? '' : ' (everything inside)';
    if (inTrash) {
      return [
        ...(one ? [{ id: 'open', label: 'Open', hint: 'Enter', run: () => playItems(false, one.id) }] : []),
        { id: 'restore', label: nI > 1 ? `Restore ${nI} items` : 'Restore', barLabel: 'Restore', icon: <RestoreIcon />, bar: true, run: () => restoreItems(ids) },
        { id: 'delete', label: 'Delete for good…', danger: true, sepBefore: true, bar: 'pinned', hint: 'Delete',
          run: () => setDialog({ t: 'forever', ids, folder: null, what: nI > 1 ? plural(nI, 'item') : one ? `“${one.name}”` : plural(nI, 'item') }) },
      ];
    }
    const allFav = itemsOnly && ids.every((id) => itemById(id)?.favourite);
    const pics = itemsOnly ? ids.filter((id) => itemById(id)?.kind === 'image') : [];
    const picList = pictures(shownSel);
    const home = one && one.folderId != null ? folders.find((f) => f.id === one.folderId) ?? null : null;
    const here = view.kind === 'folder' ? view.id : undefined;
    const fRefs = fs.map((x) => ({ id: x.id, name: x.name, person: x.person }));
    const openMovePicker = () => (itemsOnly ? setDialog({ t: 'moveItems', ids }) : !nI && nF > 1 ? setDialog({ t: 'moveFolders', folders: fs }) : setDialog({ t: 'moveMixed', folders: fs, ids }));
    const acts: (Act | false | null)[] = [
      oneFolder && here !== oneFolder.id && { id: 'open', label: 'Open', hint: 'Enter', icon: <FolderIcon size={14} />, bar: true, title: 'Enter', run: () => openFolder(oneFolder.id) },
      one && { id: 'open', label: 'Open', hint: 'Enter', run: () => playItems(false, one.id) },
      { id: 'play', label: nI > 1 && itemsOnly ? 'Play these as a slideshow' : one ? 'Slideshow from here' : 'Slideshow', barLabel: 'Play', icon: <PlayIcon size={13} />, bar: true,
        title: 'Slideshow of everything selected (folders: everything inside)',
        run: itemsOnly && one ? () => playItems(true, one.id) : onAll((list) => playList(list, true, itemsOnly ? ids[0] : undefined, oneFolder ? oneFolder.name : 'Selection')) },
      one && !(view.kind === 'folder' && view.id === one.folderId) && { id: 'showFolder', label: 'Show in its folder', run: () => showInFolder(one) },
      one && view.kind === 'search' && { id: 'why', label: 'Why is this here?', hint: 'what matched', run: () => setDialog({
        t: 'why', item: one, query: { kind: 'search', tags: view.tags, names: view.names, people: view.people ?? [] },
      }) },
      one && ['image', 'gif', 'video'].includes(one.kind) && { id: 'similar', label: 'Find similar', run: () => { setView({ kind: 'similar', id: one.id, name: one.name }); showItem(one.id); } },
      { id: 'fav', sepBefore: true, label: itemsOnly ? (allFav ? 'Remove from favourites' : 'Add to favourites') : 'Favourite everything inside',
        barLabel: allFav ? 'Unfavourite' : 'Favourite', icon: <HeartIcon size={14} />, bar: true,
        run: itemsOnly ? () => setFav(ids, !allFav) : onAll((list) => setFav(list.map((i) => i.id), !list.every((i) => i.favourite))) },
      { id: 'tags', label: `Tags…${inside}`, barLabel: 'Tag…', icon: <TagIcon />, bar: true, title: nF ? 'Tags every item inside the selected folders too' : undefined,
        run: itemsOnly ? () => setDialog({ t: 'tagItems', ids }) : onAll((list) => setDialog({ t: 'tagItems', ids: list.map((i) => i.id) })) },
      { id: 'weight', label: `Weight…${inside}`, hint: one ? `now ${one.weight}` : undefined, barLabel: 'Weight…', icon: <WeightIcon />, bar: true,
        run: itemsOnly ? () => setDialog({ t: 'weight', ids, current: one?.weight ?? itemById(ids[0])?.weight ?? 1 }) : onAll((list) => setDialog({ t: 'weight', ids: list.map((i) => i.id), current: list[0].weight ?? 1 })) },
      { id: 'move', label: 'Move to…', icon: <MoveIcon />, bar: true,
        run: () => openMovePicker(),
        sub: itemsOnly
          ? moveSub((to) => failed(moveItems(ids, to.id)), one?.folderId != null ? [one.folderId] : [], people, () => openMovePicker())
          : moveSub((to) => failed(!nI ? moveFolders(fs, to.id) : moveMixed(fs, ids, to.id)), fs.map((x) => x.id), [], () => openMovePicker()) },
      itemsOnly && { id: 'freeCopy', label: 'Free copy to…', hint: 'no extra space', title: 'Copies that take no extra space', bar: true,
        run: () => setDialog({ t: 'freeCopy', ids }), sub: moveSub((to) => failed(freeCopyTo(ids, to.id)), [], people, () => setDialog({ t: 'freeCopy', ids })) },
      { id: 'cut', label: 'Cut', hint: 'Ctrl+X', sepBefore: true, run: () => clipThese('cut', fs.map((x) => x.id), ids) },
      { id: 'copy', label: 'Copy', hint: 'Ctrl+C', run: () => clipThese('copy', fs.map((x) => x.id), ids) },
      oneFolder && (clipboard || inTauri) && { id: 'paste', label: 'Paste here', hint: 'Ctrl+V', run: () => failed(paste(oneFolder.id)) },
      one && one.linked && { id: 'copies', label: one.copyOf != null ? 'Show the original and other copies' : 'Show its free copies', run: () => failed(showCopies(one)) },
      { id: 'rename', label: many ? `Rename ${plural(nI + nF, nF && nI ? 'thing' : nF ? 'folder' : 'item')}…` : 'Rename…', barLabel: 'Rename…', hint: 'F2', title: 'F2', bar: true, run: () => {
        const entries: RenameEntry[] = [
          ...fs.map((f): RenameEntry => ({ kind: 'folder', id: f.id, name: f.name })),
          ...(shownSel.length === nI ? shownSel : ids.map((id) => itemById(id)).filter((i): i is Item => !!i))
            .map((x): RenameEntry => ({ kind: 'item', id: x.id, name: x.name, ext: x.ext })),
        ];
        if (entries.length) setDialog({ t: 'renameMany', entries });
      } },
      (one || oneFolder) && { id: 'note', label: 'Note…', hint: (one ?? oneFolder)?.note ? 'has a note' : undefined, bar: true,
        run: () => (one ? setDialog({ t: 'note', folder: false, id: one.id, name: one.name, note: one.note }) : setDialog({ t: 'note', folder: true, id: oneFolder!.id, name: oneFolder!.name, note: oneFolder!.note })) },
      oneFolder && { id: 'look', label: 'Colour and emoji…', bar: true, run: () => setDialog({ t: 'look', folder: oneFolder }) },
      home && { id: 'cover', label: `Use as cover of “${home.name}”`, barLabel: 'Set as folder cover', bar: true, run: () => coverSet(home.id, one!.id) },
      !nI && nF >= 2 && { id: 'merge', label: 'Merge into one…', hint: 'asks first', barLabel: 'Merge…', bar: true, run: () => setDialog({ t: 'merge', folders: fs }) },
      oneFolder && { id: 'qsort', label: 'Quick sort', hint: 'send items to folders fast', bar: true, run: () => setDialog({ t: 'quickSort', folder: oneFolder }) },
      { id: 'faces', group: 'Faces', label: 'Scan for faces', sepBefore: true, bar: true, run: itemsOnly ? () => failed(scanFaces({ ids }, what)) : onAll((list) => scanFaces({ ids: list.map((i) => i.id) }, what)) },
      (itemsOnly || oneFolder) && { id: 'sortPeople', group: 'Faces', label: 'Sort into person folders…', hint: 'recognised people',
        run: () => openSortAll(true, itemsOnly ? { ids, label: what } : { folder: oneFolder!.id, label: what }) },
      // Faces and look-alikes for a selection too (folders: everything inside).
      !oneFolder && { id: 'delFaces', group: 'Faces', label: 'Delete face data…', hint: 'faces found in these', run: onAll((list) => setDialog({ t: 'delFacesItems', ids: list.map((i) => i.id), what })) },
      !oneFolder && { id: 'separate', group: 'Faces', label: 'Separate pictures without faces…', hint: 'move them to a folder',
        run: onAll((list) => {
          const at = view.kind === 'folder' && view.id != null ? folders.find((f) => f.id === view.id) : folders.find((f) => f.id === list[0].folderId);
          if (!at) return setNote({ text: 'Open a folder first: the pictures are separated into a folder inside it.', at: 0 });
          setDialog({ t: 'separate', folder: { id: at.id, name: at.name }, items: list, what });
        }) },
      !oneFolder && (many || nF > 0) && { id: 'looks', group: 'Faces', label: 'Find look-alikes among these',
        run: onAll((list) => setView({ kind: 'lookalikes', folder: null, only: list.map((i) => i.id), onlyLabel: what })) },
      one && one.thumb === 'failed' && one.kind === 'video' && { id: 'playable', label: 'Make a playable copy', hint: 'converts to MP4', run: () => setDialog({ t: 'convert', items: [one], target: 'mp4' }) },
      { id: 'convert', label: `Convert to…${inside}`, barLabel: 'Convert…', bar: true, run: itemsOnly && shownSel.length === nI ? () => setDialog({ t: 'convert', items: shownSel }) : onAll((list) => setDialog({ t: 'convert', items: list })) },
      // "Models in use": only the depth and outline models chosen in the 3D settings.
      ...([[false, true], [false, false], [true, true], [true, false]] as const).map(([faces, inUse], k) => {
        const label = `${faces ? 'Pictures with faces only' : 'Prepare 3D data'}, ${inUse ? 'models in use' : 'every installed model'}`;
        const hint = faces ? 'scanned ones' : inUse ? 'the ones chosen in 3D settings' : 'takes longer';
        const go = () => prepNote(itemsOnly ? prepareItems(pics, what, faces, inUse)
          : nF === 1 ? prepareFolder(fRefs[0], faces, inUse) : prepareFolders(fRefs, plural(nF, 'folder'), faces, inUse), what, faces, inUse);
        return (itemsOnly ? pics.length > 0 : true) && { id: `prep3d-${k}`, group: '3D data', label, hint, sepBefore: k === 2, run: go };
      }),
      (itemsOnly ? pics.length > 0 : !nI) && { id: 'del3d', group: '3D data', label: 'Delete 3D data…', hint: 'choose which', run: () => setDialog({ t: 'del3d', what, folders: fRefs, ids: pics }) },
      // Several folders: preview clips off / on for all of them (one folder: its own menu has it).
      nF > 1 && !nI && { id: 'previewsOff', label: "Don't make preview clips here", hint: 'subfolders too', sepBefore: true, run: () => setPreviewClips(fs, true) },
      nF > 1 && !nI && fs.some((f) => previewsOff.has(f.id)) && { id: 'previewsOn', label: 'Make preview clips here again', hint: 'subfolders too', run: () => setPreviewClips(fs, false) },
      nF > 1 && !nI && { id: 'previewsDel', label: 'Delete preview clips here…', hint: 'subfolders too', run: () => setDialog({ t: 'delPreviews', folders: fs }) },
      { id: 'gif', label: 'Create GIF or video…', barLabel: 'Create GIF…', bar: true, noMenu: itemsOnly && picList.length < 2,
        run: itemsOnly && shownSel.length === nI ? () => (picList.length < 2 ? setNote({ text: 'Select at least two pictures to make a GIF or video.', at: 0 }) : setDialog({ t: 'animation', items: picList }))
          : onAll((list) => {
            const p = pictures(list);
            if (p.length < 2) setNote({ text: 'Select at least two pictures to make a GIF or video.', at: 0 });
            else setDialog({ t: 'animation', items: p });
          }) },
      { id: 'speed', group: 'More ways to play', label: 'Speed round', hint: 'favourite fast', bar: true, title: 'Pictures flash by; press F to favourite',
        run: onAll((list) => startSpeedRound(oneFolder, list)) },
      (many || nF > 0) && { id: 'duel', group: 'More ways to play', label: itemsOnly ? 'Duel these' : 'Duel', hint: 'pick favourites, set weights', barLabel: 'Duel', bar: true, title: 'Pick the better of two; sets the weights',
        run: onAll((list) => startDuel(null, list)) },
      oneFolder && { id: 'slots', group: 'More ways to play', label: 'Slot machine', hint: 'feeling lucky?', bar: true, title: 'Spin three reels of pictures from this folder', run: () => setDialog({ t: 'slots', folder: oneFolder }) },
      { id: 'museum', group: 'More ways to play', label: 'Walk through as a museum', hint: '3D', bar: true, title: 'A 3D gallery of these pictures',
        run: onAll((list) => openMuseum(oneFolder ? oneFolder.name : one ? one.name : 'Selection', list, (text) => setNote({ text, at: 0 }))) },
      { id: 'share', group: 'Share and export', label: 'Share as encrypted .7z…', barLabel: 'Share as .7z…', title: 'A password-protected archive', sepBefore: true, bar: true,
        run: () => setDialog({ t: 'share', ids, folders: fs.map((f) => f.id), what }) },
      { id: 'export', group: 'Share and export', label: 'Export decrypted…', barLabel: 'Export…', icon: <ExportIcon />, title: 'Write unencrypted copies to a folder', bar: true,
        run: oneFolder ? () => setDialog({ t: 'export', request: { folder: oneFolder.id }, what })
          : itemsOnly ? () => setDialog({ t: 'export', request: { ids }, what }) : onAll((list) => setDialog({ t: 'export', request: { ids: list.map((i) => i.id) }, what })) },
      // Wi-Fi transfer: only once a phone is paired; greyed out until it is connected.
      !!phone.status?.peers.length && { id: 'phone', group: 'Share and export', label: 'Send to phone', bar: true, barLabel: 'Send to phone',
        icon: <PhoneIcon size={14} />, disabled: !phone.status.connected, hint: phone.status.connected ? phone.status.connected : 'Open Aktarım on your phone',
        title: phone.status.connected ? `Send to ${phone.status.connected} over Wi-Fi` : undefined,
        run: () => failed(api.transferSend(ids, fs.map((f) => f.id)).then((r) => {
          if (!r.items) say('There is nothing in there to send.', 'note');
        }).catch((e) => say(errText(e), 'problem'))) },
      { id: 'delete', label: itemsOnly ? 'Move to trash' : 'Move to trash…', hint: 'Delete', barLabel: 'Move to trash', icon: <TrashIcon />,
        danger: true, sepBefore: true, bar: 'pinned', title: 'Moves to the trash (Delete key · Ctrl+Z to undo)',
        run: itemsOnly ? () => failed(trashItems(ids)) : () => setDialog({ t: 'deleteMany', folders: fs, items: ids }) },
    ];
    return acts.filter((a): a is Act => !!a);
  };
  // The viewer's right-click menu offers the same actions (itemmenu.ts).
  const itemMenuRef = useRef<(id: number, leaveOut: string[]) => Promise<MenuItem[]>>(async () => []);
  itemMenuRef.current = async (id, leaveOut) => {
    const it = itemById(id) ?? (await api.getItem(id));
    if (it.deletedAt != null) return [];
    known.current.set(id, it);
    const people = await peopleIn([id]);
    return menuOf(mediaActions([], [id], it, people).filter((a) => !leaveOut.includes(a.id)));
  };
  // …and its Delete key, the same way as here (asks first about an original with free copies).
  const trashRef = useRef<(id: number) => Promise<boolean>>(async () => false);
  trashRef.current = async (id) => {
    const groups = await originalsWithCopies([id]).catch(() => []);
    if (groups.length) {
      // Asks first (it has free copies); the viewer moves on once you've chosen.
      return new Promise<boolean>((resolve) => setDialog({ t: 'deleteOriginal', groups, ids: [id], folders: [], done: resolve }));
    }
    await deleteMany([], [id]);
    return true;
  };
  useEffect(() => {
    setItemMenuProvider((id, leaveOut) => itemMenuRef.current(id, leaveOut));
    setItemTrasher((id) => trashRef.current(id));
    return () => {
      setItemMenuProvider(null);
      setItemTrasher(null);
    };
  }, []);
  /** The actions as a right-click menu. */
  const menuOf = (acts: Act[]): MenuItem[] => {
    const out: MenuItem[] = [];
    const groups = new Map<string, MenuItem>();
    for (const a of acts) {
      if (a.noMenu) continue;
      const item: MenuItem = { label: a.label, hint: a.hint, danger: a.danger, disabled: a.disabled, sepBefore: a.sepBefore, sub: a.sub, onSelect: a.run };
      if (!a.group) {
        out.push(item);
        continue;
      }
      // The first of a group puts the submenu where it stands.
      let g = groups.get(a.group);
      if (!g) {
        g = { label: a.group, subOnly: true, sepBefore: a.sepBefore, sub: [], onSelect: () => {} };
        groups.set(a.group, g);
        out.push(g);
      }
      g.sub!.push({ ...item, sepBefore: g.sub!.length > 0 && !!item.sepBefore });
    }
    // A group of one is just that item.
    return out.map((m) => (m.subOnly && m.sub?.length === 1 && groups.get(m.label) === m ? { ...m.sub[0], sepBefore: m.sepBefore } : m));
  };
  /** The actions as the bottom bar's buttons. */
  const barOf = (acts: Act[]): BarAction[] => acts.filter((a) => a.bar && !a.menuOnly && !a.disabled).map((a) => ({
    key: a.id, label: a.barLabel ?? a.label, icon: a.icon, title: a.title, danger: a.danger, pinned: a.bar === 'pinned', onClick: a.run,
  }));

  const folderContext = (e: React.MouseEvent, f: FolderCard) => {
    e.preventDefault();
    if (selFolders.has(f.id) && selFolders.size > 1) {
      const fs = topMost(selFolders);
      setCtx({ x: e.clientX, y: e.clientY, title: plural(fs.length, 'folder'), items: menuOf(mediaActions(fs, [], null)) });
      return;
    }
    // Right-clicking a folder selects it (as with items), so the bar and keys act on what the menu shows.
    if (!selFolders.has(f.id)) {
      setSelFolders(new Set([f.id]));
      setSelected(new Set());
      setFolderAnchor(f.id);
    }
    setCtx({ x: e.clientX, y: e.clientY, title: f.name, items: folderMenu(f) });
    // Whether this folder has a banner (only the open folder's is loaded): the menu fills in when known.
    if (!bannerKnown.current.has(f.id) && banner?.folder !== f.id) {
      api.folderBanner(f.id).then((b) => {
        bannerKnown.current.set(f.id, b);
        setCtx((c) => (c && c.title === f.name ? { ...c, items: folderMenuRef.current(f) } : c));
      }).catch(() => {});
    }
  };

  /** Person folders of the people recognised in these items (for "Move to"); quick, local. */
  const peopleIn = async (ids: number[]): Promise<number[]> => {
    try {
      const r = await Promise.race([
        api.facesOfMany(ids.slice(0, 60)),
        new Promise<[number, FaceBox[]][]>((res) => setTimeout(() => res([]), 250)),
      ]);
      const count = new Map<number, number>();
      for (const [, fs] of r) for (const p of new Set(fs.map((f) => f.person).filter((x): x is number => x != null))) count.set(p, (count.get(p) ?? 0) + 1);
      return [...count].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p]) => p);
    } catch {
      return [];
    }
  };
  const itemContext = async (e: React.MouseEvent, it: Item) => {
    const at = { clientX: e.clientX, clientY: e.clientY };
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
    const title = many ? `${ids.length} items` : it.name;
    // The menu opens at once; the people in the picture ("Move to" their folders) join when known.
    setCtx({ x: at.clientX, y: at.clientY, title, items: menuOf(mediaActions([], ids, it, [])) });
    if (inTrash) return;
    const people = await peopleIn(ids);
    if (people.length) setCtx((c) => (c && c.title === title && c.x === at.clientX && c.y === at.clientY ? { ...c, items: itemMenuRef2.current(ids, it, people) } : c));
  };
  const itemMenuRef2 = useRef<(ids: number[], it: Item, people: number[]) => MenuItem[]>(() => []);
  itemMenuRef2.current = (ids, it, people) => menuOf(mediaActions([], ids, it, people));

  // Living folder cards: hovering a card cycles through a few items inside
  // (the counter lives in the hovered card's FolderCover, not here).
  const cardIndex = useMemo(() => new Map(cards.map((c, i) => [c.id, i])), [cards]);

  const coverView = (f: FolderCard) => {
    const per = Math.max(1, cols - 1);
    const at = (cardIndex.get(f.id) ?? 0) % per;
    const edge = `${at === 0 ? ' edge-l' : ''}${at === per - 1 ? ' edge-r' : ''}`;
    return <FolderCover f={f} preview={preview} whole={!!cfg.wholeOnHover} edge={edge} />;
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
        { label: 'Video quality: automatic', hint: 'real videos when your PC keeps up', checked: (cfg.previewQuality ?? 'auto') === 'auto', sepBefore: true,
          disabled: preview === 'off', onSelect: () => saveCfg({ previewQuality: 'auto' }) },
        { label: 'Video quality: tiny clips only', hint: 'lightest; hover still plays the video', checked: cfg.previewQuality === 'tiny',
          disabled: preview === 'off', onSelect: () => saveCfg({ previewQuality: 'tiny' }) },
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
    lock: nav.app.session?.hasPassword === false
      ? { label: 'Close vault', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Close vault" title="Close the vault, back to the vault list (Ctrl+Shift+L)" onClick={() => requestLock()}><LeaveIcon size={16} /></button> }
      : { label: 'Lock', node: <button type="button" className="btn btn-icon btn-sm" aria-label="Lock vault" title="Lock (Ctrl+Shift+L)" onClick={() => requestLock()}><LockIcon size={16} /></button> },
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
    // The same actions as the right-click menus (mediaActions), as buttons.
    return <ActionBar summary={summary} actions={barOf(mediaActions(fs, selIds, null))} end={clear} />;
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
          items: FOLDER_SORTS.map((o) => ({ label: o.label, hint: o.hint, checked: o.id === sideSort, onSelect: () => (o.id === sideSort ? setResort((r) => r + 1) : fprefs.setSide(o.id)) })) });
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
    ? <RoundCover folder={f} size={size} className="side-round" />
    : f.cover && f.coverPos
    ? <Framed pos={f.coverPos} className="side-cover" style={{ width: size, height: size }}><CoverImg id={f.cover} small={size <= 80} /></Framed>
    : f.cover
    ? <CoverImg id={f.cover} small={size <= 80} className="side-cover" style={{ width: size, height: size }} />
    : (!f.emoji ? <FolderIcon size={Math.round(size * 0.9)} /> : null);

  // The grid's handlers never change (useEvent), so the grid (memoised) draws again
  // only when what it shows changes, not on every redraw of the library around it.
  const gridQuickLook = useEvent((it: Item) => setQuick(it.id));
  const gridSelect = useEvent((sel: Set<number>, a: number | null, additive: boolean) => {
    setSelected(sel);
    setAnchor(a);
    if (a != null) setCursor(a);
    if (!additive) setSelFolders(new Set());
  });
  const gridOpen = useEvent((it: Item) => playItems(false, it.id));
  const gridContext = useEvent((e: React.MouseEvent, it: Item) => itemContext(e, it));
  const gridDragStart = useEvent((e: React.PointerEvent, ids: number[]) => dragOut(e, ids, []));
  const gridDrop = useEvent((ids: number[], target: string) => act(() => moveItems(ids, target === 'folder:top' ? null : Number(target.slice(7)))));
  const folderNames = useMemo(() => new Map(folders.map((f) => [f.id, f.name])), [folders]);
  const personName = useCallback((id: number) => folderNames.get(id), [folderNames]);
  const dimmed = useMemo(() => (clipboard?.mode === 'cut' ? new Set(clipboard.ids) : undefined), [clipboard]);
  const minimapSort = timeline || inTrash || view.kind === 'similar' ? null : sort;
  const gridMinimapLabel = useMemo(() => minimapLabel(minimapSort), [minimapSort]);

  // The folder being opened, from the full folder list (known at once), so the title and the
  // breadcrumb never show the previous folder's while the new one loads.
  const headFolder = view.kind === 'folder' && view.id != null ? folders.find((f) => f.id === view.id) ?? folder : null;
  // Arrow keys in the sidebar: ↑/↓ move between rows, → unfolds, ← folds (or goes to the parent row).
  const sideKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !e.key.startsWith('Arrow')) return;
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>('.side-row > .tree-name, button.side-row');
    if (!btn) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.side-row > .tree-name, button.side-row')];
    const i = rows.indexOf(btn);
    const row = btn.closest<HTMLElement>('[data-order]');
    const id = row ? Number(row.dataset.order) : NaN;
    const f = Number.isFinite(id) ? folders.find((x) => x.id === id) : undefined;
    e.preventDefault();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (f && e.key === 'ArrowRight' && f.subfolders > 0 && collapsed.has(f.id)) {
      setCollapsed((c) => { const n = new Set(c); n.delete(f.id); return n; });
    } else if (f && e.key === 'ArrowLeft') {
      if (f.subfolders > 0 && !collapsed.has(f.id)) setCollapsed((c) => new Set(c).add(f.id));
      else if (f.parentId != null) e.currentTarget.querySelector<HTMLElement>(`[data-order="${f.parentId}"] > .tree-name`)?.focus();
    }
  };
  /** A statistics tile or row was clicked: open what it counts. */
  const statsGo = (to: StatsGo) => {
    if (to === 'tags') return setDialog({ t: 'tags' });
    if (to === 'folders' || to === 'favourites' || to === 'trash' || to === 'recent') return setView({ kind: to });
    // Everything, largest first or of one type (the view's own settings).
    setViewPrefs(prefsKey({ kind: 'all' }), to === 'largest' ? { sort: 'largest', kind: 'any' } : typeof to === 'object' ? { kind: to.kind as Kind } : { kind: 'any' });
    setPrefsTick((t) => t + 1);
    setView({ kind: 'all' });
  };
  // The sidebar follows the folder you're in: its parents unfold and its row scrolls into view.
  const followId = headFolder?.id ?? null;
  useEffect(() => {
    if (followId == null) return;
    const f = folders.find((x) => x.id === followId);
    if (!f) return;
    const up = f.path.map((c) => c.id).filter((id) => id !== followId);
    if (up.some((id) => collapsed.has(id))) {
      setCollapsed((c) => {
        const n = new Set(c);
        for (const id of up) n.delete(id);
        return n;
      });
    }
    const t = setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`.side-col [data-order="${followId}"]`);
      row?.scrollIntoView({ block: 'nearest' });
    }, 60);
    return () => clearTimeout(t);
  }, [followId]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A view is loading and nothing of it is known yet: what still shows is dimmed. */
  const switching = loading && loadedFor.current !== viewK;
  const heading = view.kind === 'search' ? `Search: ${searchTitle({ ...view, people: view.people ?? [] }, folders)}`
    : view.kind === 'timeline' && view.person != null ? `${folders.find((f) => f.id === view.person)?.name ?? 'Person'} · timeline`
    : viewTitle(view, headFolder);
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
            if (view.kind === 'search') {
              if (!history.back()) setView({ kind: 'folders' });
            }
          }} />
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
        <div className="side-col" onKeyDown={sideKeys} onPointerDown={() => { sideZone.current = true; }}>
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
          {sideView({ kind: 'folders' }, 'Discovery river', undefined, <RiverIcon size={rail ? 16 : 14} />, () => openVaultRiver((text) => setNote({ text, at: 0 })))}
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
                    {f.cover && f.person ? <RoundCover folder={f} className="rail-round" />
                      // (a framed cover borrows the blank tile's size and selection ring)
                      : f.cover && f.coverPos ? <Framed pos={f.coverPos} className="rail-blank"><CoverImg id={f.cover} small /></Framed>
                      : f.cover ? <CoverImg id={f.cover} small /> : <span className="rail-blank">{f.emoji ?? <FolderIcon size={14} />}</span>}
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
        </div>
        </div>

        <main className={`lib-main${switching ? ' switching' : ''}`} ref={scroller} onPointerDown={(e) => { sideZone.current = false; rubberBand(e); }} data-drop={view.kind === 'folder' ? `folder:${view.id ?? 'top'}` : inTrash ? undefined : 'folder:top'}>
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
          {showBanner && banner && folder && (
            <FolderBannerView banner={banner} title={<><FolderMark f={folder} />{heading}</>} note={folder.note} preview={preview} scroller={scroller}
              editing={bannerEdit} onReposition={() => setBannerEditOf(banner.media)} onChange={() => setDialog({ t: 'banner', folder })} onRemove={() => removeBanner(folder)}
              onEditDone={(y) => {
                setBannerEditOf(null);
                if (y != null && Math.abs(y - banner.y) > 0.001) {
                  const was = banner.y;
                  api.setBanner(folder.id, banner.media, y).then(() => {
                    pushUndo('Banner moved', () => api.setBanner(folder.id, banner.media, was).then(reloadBanner));
                    reloadBanner();
                  }, (err) => setError(errText(err)));
                }
              }} />
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
                {headFolder?.path.map((c) => (
                  <span key={c.id}>
                    <button type="button" className="link" data-drop={`folder:${c.id}`} onClick={() => openFolder(c.id)} {...middleView({ kind: 'folder', id: c.id })}>{c.name}</button>
                    <button type="button" className="crumb-jump" aria-label={`Folders in ${c.name}`} title="Jump to another folder at this level" onClick={(e) => crumbJump(e, c.id)}>›</button>
                  </span>
                ))}
              </span>
            )}
            {/* With a banner, the name and note are shown on it. */}
            {!showBanner && <h1>{folder && <FolderMark f={folder} />}{heading}</h1>}
            {!showBanner && folder?.note && <span className="folder-note" title={folder.note}><NoteIcon size={13} /> {folder.note}</span>}
            {folder?.person && view.kind === 'folder' && <PersonAlso folder={folder} onShowAll={() => setView({ kind: 'timeline', person: folder.id })} />}
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
                <Dropdown className="btn btn-sm" label="Folder ▾" items={() => folderMenu(folder).slice(1)} />
              </div>
            )}
            <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
              {view.kind === 'folder' && !inTrash && (
                <button type="button" className="btn btn-sm" title="Make a new folder inside this one" onClick={() => setDialog({ t: 'newFolder', parent: view.id })}>
                  <PlusIcon size={14} /> New folder
                </button>
              )}
              {view.kind === 'folders' && folders.length > 0 && (
                <Dropdown title="Sort the folders" label={`${FOLDER_SORTS.find((o) => o.id === cardSort)?.label} ▾`}
                  items={FOLDER_SORTS.map((o) => ({ label: o.label, checked: o.id === cardSort, onSelect: () => (o.id === cardSort ? setResort((r) => r + 1) : setCardSort(o.id)) }))} />
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
              {gridView && !inTrash && facePerson != null && (
                <>
                  <button type="button" className="btn btn-sm" title="Their biggest, sharpest faces looking at the camera; pick a cover" onClick={() => openFaceTool('best', facePerson, facePersonName)}>
                    <FaceIcon size={14} /> Best faces
                  </button>
                  <button type="button" className="btn btn-sm" title="Every face, oldest first, lined up by the eyes and played fast" onClick={() => openFaceTool('timelapse', facePerson, facePersonName)}>
                    <PlayIcon size={14} /> Time-lapse
                  </button>
                </>
              )}
              {gridView && !inTrash && (
                <>
                  {shown.length > 0 && (
                    <button type="button" className="btn btn-sm" title="See everything here on one sheet" onClick={() => setDialog({ t: 'sheet' })}>
                      <SheetIcon /> Contact sheet
                    </button>
                  )}
                  {/* Sort, what to show, layout and size in one menu. */}
                  <Dropdown label="View ▾" title={`${timeline ? (sort === 'oldest' ? 'Oldest first' : 'Newest first') : SORTS.find((x) => x.id === sort)?.label} · ${KINDS.find((x) => x.id === kind)?.label} · ${faceWall ? 'face wall' : scrollMode ? 'scroll' : shape ? 'true shape' : 'tiles'}${!scrollMode && !faceWall ? ` · ${cols} per row` : ''}`}
                    items={() => [
                      ...(view.kind !== 'similar' ? [group(`Sort: ${(timeline ? (sort === 'oldest' ? 'Oldest first' : 'Newest first') : SORTS.find((x) => x.id === sort)?.label ?? '').toLowerCase()}`, [
                        ...(timeline ? SORTS.slice(0, 2) : SORTS).map((o) => ({ label: o.label, checked: o.id === sort, onSelect: () => setSort(o.id) })),
                        // Inside a folder the same menu sorts its subfolder cards.
                        ...(view.kind === 'folder' && cards.length > 0 ? FOLDER_SORTS.map((o, k) => ({
                          label: `Folders: ${o.label.charAt(0).toLowerCase()}${o.label.slice(1)}`, sepBefore: k === 0, checked: o.id === cardSort, onSelect: () => (o.id === cardSort ? setResort((r) => r + 1) : setCardSort(o.id)),
                        })) : []),
                      ])] : []),
                      group(`Show: ${(KINDS.find((x) => x.id === kind)?.label ?? '').toLowerCase()}`, KINDS.map((o) => ({ label: o.label, checked: o.id === kind, onSelect: () => setKind(o.id) }))),
                      { label: 'Tiles', hint: 'edges cropped', sepBefore: true, checked: !shape && !scrollMode && !faceWall, onSelect: () => { setFaceWallFor(null); setScrollMode(false); saveCfg({ gridShape: false }); } },
                      { label: 'True shape', hint: 'nothing cropped', checked: shape && !scrollMode && !faceWall, onSelect: () => { setFaceWallFor(null); setScrollMode(false); saveCfg({ gridShape: true }); } },
                      { label: 'Scroll mode', hint: 'one long column', checked: scrollMode && !faceWall, onSelect: () => { setFaceWallFor(null); setScrollMode(!scrollMode); } },
                      ...(facePerson != null ? [{ label: 'Face wall', hint: 'their face from every photo', checked: faceWall, onSelect: () => setFaceWallFor(faceWall ? null : facePerson) }] : []),
                      ...(!scrollMode && !faceWall ? [group(`Size: ${cols} per row`, [2, 3, 4, 5, 6, 7, 8, 10, 12].map((n) => ({ label: `${n} per row`, checked: n === cols, onSelect: () => setCols(n) })),
                        { sepBefore: true, hint: 'Ctrl + wheel' })] : []),
                    ]} />
                </>
              )}
              {inTrash && trash && (trash.totalItems > 0 || trash.folders.length > 0) && (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => setDialog({ t: 'emptyTrash' })}><TrashIcon /> Empty trash</button>
              )}
              {/* In item views the size is in View ▾ (and Ctrl + wheel). */}
              {view.kind === 'folders' && (
                <>
                  <label className="faint" htmlFor="tile-size" style={{ fontSize: 12 }} title="Ctrl + mouse wheel changes this too">Size · {cols} per row</label>
                  <input id="tile-size" type="range" min={2} max={12} step={1} value={cols} style={{ direction: 'rtl' }}
                    title={`${cols} per row — Ctrl + mouse wheel changes this too`} onChange={(e) => setCols(Number(e.target.value))} />
                </>
              )}
            </div>
          </div>

          {view.kind === 'people' && (
            <PeopleView folders={folders} onChanged={() => { void reload({ quiet: true }); nav.refresh().catch(() => {}); }} onOpenItem={(it) => openInFolder(it, true)} onTimeline={(id) => setView({ kind: 'timeline', person: id })}
              onOpenTab={tabs ? (v) => tabs.open(v) : undefined} />
          )}

          {view.kind === 'memories' && (
            <MemoriesView folders={folders} onPlay={(m: Memory) => nav.go({
              name: 'viewer', items: m.items.map(fromItem), title: m.title, auto: true, back: view, kenBurns: true, titleCard: { title: m.title, subtitle: m.subtitle },
            })} />
          )}
          {view.kind === 'lookalikes' && (
            <LookAlikes folder={view.folder} folderName={folders.find((f) => f.id === view.folder)?.name ?? null} only={view.only} onlyLabel={view.onlyLabel}
              tick={lookTick} marked={selected} setMarked={setSelected}
              onGroups={(g) => setItems(g.flat())}
              onOpen={(g, id) => playList(g, false, id, 'Look-alikes')}
              onAllFolders={() => setView({ kind: 'lookalikes', folder: null })} />
          )}

          {view.kind === 'stats' && (
            <StatsView onOpenFolder={(id) => openFolder(id)} onOpenItem={(it, list) => playList(list, false, it.id, 'Most viewed')} onGo={statsGo} />
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
                  onPointerEnter={() => setHoveredCard(f.id)} onPointerLeave={() => leaveCard(f.id)}>
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
                    <Dropdown className="btn btn-icon btn-sm ghost" ariaLabel={`${f.name} options`} label="⋯" items={() => folderMenu(f)} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {faceWall && facePerson != null ? (
            <FaceWall person={facePerson} name={facePersonName} onOpen={async (id) => {
              // Like clicking a tile; a face from elsewhere opens among every photo of them.
              const list = shown.some((i) => i.id === id) ? shown : await api.queryItems({ people: [facePerson] }).catch(() => shown);
              playList(list, false, id);
            }} onContext={(e, id) => {
              // The photo's own menu, the same as on its tile (mediaActions).
              const at = { x: e.clientX, y: e.clientY };
              itemMenuRef.current(id, []).then((menuItems) => menuItems.length && setCtx({ ...at, title: itemById(id)?.name ?? known.current.get(id)?.name ?? 'Photo', items: menuItems }));
            }} />
          ) : gridView && (
            shown.length ? (
              <div className={scrollMode ? 'scroll-mode' : 'grid-mode'}>
              <MediaGrid items={shown} columns={scrollMode ? 1 : cols} cursor={cursor} onCursor={setCursor} onQuickLook={gridQuickLook} hitTest={gridHit}
                keyboard={quick == null && !dialog && !ctx && !asleep && !(selected.size === 0 && selFolders.size === 1 && cards.some((c) => selFolders.has(c.id)))} reveal={revealHere} selected={selected} anchor={anchor} scroller={scroller}
                onSelect={gridSelect}
                onOpen={gridOpen}
                onContext={gridContext}
                preview={inTrash ? 'off' : scrollMode ? 'all' : preview}
                wholeOnHover={!!cfg.wholeOnHover && !scrollMode}
                previewQuality={cfg.previewQuality ?? 'auto'}
                layout={shape || scrollMode ? 'shape' : 'grid'}
                groups={groups}
                hoverInfo={look.hoverInfo && !scrollMode}
                faces={gridFaces} faceBoxes={faceBoxesOn} faceCrop={look.faceCrop}
                personName={personName}
                dimmed={dimmed}
                onDragStart={inTrash ? undefined : gridDragStart}
                gap={look.tileGap}
                minimap={look.minimap !== false} minimapLabel={gridMinimapLabel}
                onDropOnFolder={inTrash ? undefined : gridDrop} />
              </div>
            ) : !loading && !(inTrash && trash?.folders.length) && (
              <div className="dropzone">
                {inTrash ? <TrashIcon size={28} /> : <ImportIcon size={28} />}
                <b>{inTrash ? 'The trash is empty'
                  : view.kind === 'folder' ? 'This folder is empty'
                  : view.kind === 'search' ? 'Nothing matches this search'
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

      {noteSlot && createPortal(<div className="notes-lib" onPointerEnter={() => setNoteHover(true)} onPointerLeave={() => setNoteHover(false)}>
      {showNote && note && (
        <div className="undo-toast" role="status">
          <span className="ellipsis">{note.text}</span>
          {note.at !== 0 && undoTop && undoTop.label === note.text && (
            <button type="button" className="btn btn-sm" onClick={undo}><UndoIcon /> Undo <kbd>Ctrl+Z</kbd></button>
          )}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setNote(null)}><CloseIcon size={12} /></button>
        </div>
      )}
      {(reports.length > 0 || storageMsg || taskCards) && (
        <section className="imports" aria-label="Import progress">
          <TaskCards paused={noteHover} />
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
      <FaceSortOffer did={did} onChanged={() => { void reload({ quiet: true }); nav.refresh().catch(() => {}); }} />
      </div>, noteSlot)}

      {quick != null && (
        <QuickLook items={shown} id={quick} onClose={() => setQuick(null)}
          onMove={(id) => { setQuick(id); setCursor(id); setSelected(new Set([id])); setAnchor(id); }}
          onOpen={(it) => { setQuick(null); playItems(false, it.id); }}
          onShowFolder={view.kind === 'folder' ? undefined : (it) => { setQuick(null); showInFolder(it); }}
          onFavourite={view.kind === 'trash' ? undefined : (it) => void setFav([it.id], !it.favourite)}
          onDelete={view.kind === 'trash' ? undefined : (it, next) => {
            // The next one shows straight away; back to this one if it didn't go (cancelled, or failed).
            const go = (id: number | null) => {
              setQuick(id);
              if (id != null) { setCursor(id); setSelected(new Set([id])); setAnchor(id); }
            };
            go(next?.id ?? null);
            trashRef.current(it.id).then((ok) => { if (!ok) go(it.id); }, () => go(it.id));
          }}
          onUndo={() => void undo()} />
      )}

      {dialog?.t === 'newFolder' && (
        <PromptDialog title="New folder" label="Name" confirm="Create" onClose={() => setDialog(null)}
          onSubmit={async (name) => { await api.createFolder(dialog.parent, name); await reload({ quiet: true }); }} />
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
        <TagItemsDialog ids={dialog.ids} all={tags} onClose={() => setDialog(null)} onDone={() => reload({ quiet: true })} did={did} />
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
        <ConfirmDialog title={`Move “${dialog.folder.name}” to the trash?`} confirm="Move to trash" danger onClose={() => setDialog(null)}
          onConfirm={() => trashFolder(dialog.folder)}>
          The folder, its {dialog.folder.subfolders} subfolder(s) and all {dialog.folder.items.toLocaleString()} item(s) inside go to the trash.
          You can restore them from there for 30 days, or press Ctrl+Z right away. Your original files outside the vault are not touched.
        </ConfirmDialog>
      )}
      {dialog?.t === 'delFaces' && (
        <ConfirmDialog title={`Delete face data in “${dialog.folder.name}”?`} confirm="Delete face data" danger onClose={() => setDialog(null)}
          onConfirm={() => deleteFaceData(dialog.folder)}>
          Every face found in the items of this folder and its subfolders is forgotten, with the names given to them.
          The pictures and videos themselves don't change, and people found elsewhere stay.
          {facesOff.has(dialog.folder.id) ? ' Face search stays off here.' : ' They are scanned again only if you choose "Scan for faces" (or turn face search off here so they never are).'}
        </ConfirmDialog>
      )}
      {dialog?.t === 'delPreviews' && (
        <ConfirmDialog title={`Delete the preview clips in ${dialog.folders.length === 1 ? `“${dialog.folders[0].name}”` : plural(dialog.folders.length, 'folder')}?`}
          confirm="Delete preview clips" danger onClose={() => setDialog(null)}
          onConfirm={() => deletePreviewClips(dialog.folders, previewsAlsoOff)}>
          The small moving previews of the videos in {dialog.folders.length === 1 ? 'this folder' : 'these folders'} and their subfolders are
          deleted to free the space. The videos themselves don't change.
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={previewsAlsoOff} onChange={(e) => setPreviewsAlsoOff(e.target.checked)} />
            Don't make them again here (otherwise they are made again in the background)
          </label>
        </ConfirmDialog>
      )}
      {dialog?.t === 'delFacesItems' && (
        <ConfirmDialog title={`Delete face data of ${dialog.what}?`} confirm="Delete face data" danger onClose={() => setDialog(null)}
          onConfirm={() => deleteItemFaces(dialog.ids, dialog.what)}>
          Every face found in these is forgotten, with the names given to them.
          The pictures and videos themselves don't change, and people found elsewhere stay.
          They are scanned again only if you choose "Scan for faces".
        </ConfirmDialog>
      )}
      {dialog?.t === 'forever' && (
        <ConfirmDialog title="Delete for good?" confirm="Delete for good" danger onClose={() => setDialog(null)}
          onConfirm={async () => {
            if (dialog.folder != null) await api.deleteFolderForever(dialog.folder);
            else await api.deleteForever(dialog.ids);
            setSelected(new Set());
            await reload({ quiet: true });
          }}>
          {dialog.what} will be removed from the vault and can't be brought back.
        </ConfirmDialog>
      )}
      {dialog?.t === 'separate' && (
        <SeparateFaces folder={dialog.folder} items={dialog.items} what={dialog.what} folders={folders} onClose={() => setDialog(null)}
          onScan={async (ids) => { await api.facesQueue({ ids }); kickFaceScanner(); }}
          onApply={(items, target, copy) => separate(dialog.folder.id, items, target, copy)} />
      )}
      {dialog?.t === 'del3d' && (
        <Delete3DData what={dialog.what} folders={dialog.folders} ids={dialog.ids} onClose={() => setDialog(null)} onDone={(text) => setNote({ text, at: 0 })} />
      )}
      {dialog?.t === 'emptyTrash' && (
        <ConfirmDialog title="Empty the trash?" confirm="Empty trash" danger onClose={() => setDialog(null)}
          onConfirm={async () => { await api.emptyTrash(); clearUndo(); await reload({ quiet: true }); }}>
          Everything in the trash ({plural(trash?.totalItems ?? 0, 'item')}, {formatBytes(trash?.totalBytes ?? 0)}) is removed for good.
        </ConfirmDialog>
      )}
      {dialog?.t === 'banner' && (
        <BannerPicker folder={dialog.folder} current={bannerOf(dialog.folder.id)?.media ?? null} onClose={() => setDialog(null)} onPicked={async (id) => {
          const f = dialog.folder;
          const was = bannerOf(f.id);
          bannerKnown.current.delete(f.id);
          await api.setBanner(f.id, id, was?.media === id ? was.y : 0.5);
          did(was ? 'Banner changed' : 'Banner set', () => api.setBanner(f.id, was?.media ?? null, was?.y).then(reloadBanner));
          if (view.kind === 'folder' && view.id === f.id) setBannerEditOf(id); // then drag it to choose what shows
          reloadBanner();
        }} />
      )}
      {dialog?.t === 'cover' && (
        <CoverPicker folder={dialog.folder} onClose={() => setDialog((d) => (d?.t === 'cover' ? null : d))} onPicked={async (id) => {
          await api.setCover(dialog.folder.id, id);
          await reload({ quiet: true });
          // A new picture: choose what part of it shows (the picker then closes, the editor stays).
          if (id != null && id !== dialog.folder.cover) setDialog({ t: 'coverFrame', folder: dialog.folder.id });
        }} />
      )}
      {dialog?.t === 'coverFrame' && (() => {
        const f = folders.find((x) => x.id === dialog.folder);
        if (!f || f.cover == null) return null;
        return (
          // (starts afresh when the cover itself changes underneath, e.g. right after choosing it)
          <CoverFrameEditor key={`${f.id}:${f.cover}`} folder={f} onClose={() => setDialog(null)} onSave={async (pos) => {
            const was = f.coverPos ?? null;
            await api.setCoverFrame(f.id, f.cover, pos);
            did(pos ? `Adjusted the cover of “${f.name}”` : `“${f.name}” cover framed automatically again`, () => api.setCoverFrame(f.id, f.cover, was));
            await reload({ quiet: true });
          }} />
        );
      })()}
      {dialog?.t === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog?.t === 'deleteMany' && (() => {
        const nItems = dialog.folders.reduce((a, f) => a + f.items, 0);
        const parts = [
          dialog.folders.length ? `${plural(dialog.folders.length, 'folder')} (with ${plural(nItems, 'item')} inside)` : '',
          dialog.items.length ? plural(dialog.items.length, 'selected item') : '',
        ].filter(Boolean);
        return (
          <ConfirmDialog title={`Move ${parts.join(' and ')} to the trash?`} confirm="Move to trash" danger onClose={() => setDialog(null)}
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
        <DeleteOriginalDialog groups={dialog.groups} onCancel={() => { dialog.done?.(false); setDialog(null); }}
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
              d.done?.(true);
            } catch (err) {
              d.done?.(false);
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
        <TagManager onClose={() => setDialog(null)} did={did} onChanged={() => { void reload({ quiet: true }); }}
          onSearch={(t) => { setDialog(null); setView({ kind: 'search', tags: [t], names: [], people: [] }); }} />
      )}
      {dialog?.t === 'quickSort' && (
        <QuickSort source={dialog.folder} folders={folders} moveStats={moveStats.current} onMoved={bumpMoveStat} did={did} undo={undo}
          onClose={(changed) => { setDialog(null); if (changed) { void reload({ quiet: true }); nav.refresh().catch(() => {}); } }} />
      )}
      {dialog?.t === 'duel' && <Duel items={dialog.items} onClose={() => { setDialog(null); void reload({ quiet: true }); }} />}
      {dialog?.t === 'slots' && (
        <SlotMachine folder={dialog.folder} onClose={() => setDialog(null)}
          onPlay={(list, title) => { setDialog(null); playList(list, true, undefined, title); }} />
      )}
      {dialog?.t === 'why' && <WhyHere item={dialog.item} query={dialog.query} kind={kind} onClose={() => setDialog(null)} />}
      <MuseumHost nav={nav} view={view} />
      <FaceToolsHost nav={nav} onChanged={() => { void reload({ quiet: true }); nav.refresh().catch(() => {}); }} />
      <RiverHost nav={nav} />
      {dialog?.t === 'share' && <ShareDialog ids={dialog.ids} folders={dialog.folders} what={dialog.what} onClose={() => setDialog(null)} />}
      {dialog?.t === 'convert' && (
        <ConvertDialog items={dialog.items} target={dialog.target} onClose={() => setDialog(null)} onDone={() => { kickThumbnails(); reloadCalmly(); }} />
      )}
      {dialog?.t === 'animation' && <AnimationDialog items={dialog.items} onClose={() => setDialog(null)} onDone={() => { kickThumbnails(); reloadCalmly(); }} />}
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

