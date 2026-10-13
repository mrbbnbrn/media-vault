// Typed calls into the Rust backend. When the UI runs in a plain browser
// (design preview, no Tauri), a small in-memory mock answers instead.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

export interface LockSettings {
  idleMinutes: number;
  onSystemLock: boolean;
  onMinimize: boolean;
  safetyNetMinutes: number;
}

export interface ViewerSettings {
  smoothFit: boolean;
  smoothZoom: boolean;
  sharpen: boolean;
  seekSeconds: number;
  seekBigSeconds: number;
}

export const DEFAULT_VIEWER: ViewerSettings = { smoothFit: true, smoothZoom: true, sharpen: false, seekSeconds: 5, seekBigSeconds: 30 };

export interface AppConfig {
  accent: string;
  lock: LockSettings;
  fullscreenControlsOnMouse: boolean;
  /** Grid previews: everything on screen plays, only the hovered one, or none (always muted). */
  preview: 'all' | 'hover' | 'off';
  /** While previewing, the hovered video/GIF shows uncropped. */
  wholeOnHover: boolean;
  /** Grid shows every item at its true shape (no cropping). */
  gridShape: boolean;
  viewer: ViewerSettings;
  vaults: { path: string }[];
  lastVault: string | null;
}

export interface VaultEntry {
  path: string;
  name: string;
  status: 'ready' | 'missing' | 'notVault';
  sizeBytes: number | null;
}

export interface SessionInfo {
  path: string;
  name: string;
  items: number;
  folders: number;
  needsNewPassword: boolean;
  restoredFromBackup: string | null;
}

export interface AppState {
  config: AppConfig;
  vaults: VaultEntry[];
  session: SessionInfo | null;
  minPasswordChars: number;
}

export type Kind = 'image' | 'gif' | 'video' | 'text' | 'pdf';

export interface Item {
  id: number;
  kind: Kind;
  name: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  favourite: boolean;
  weight: number;
  thumb: 'ok' | 'pending' | 'failed';
  importedAt: number;
  folderId: number | null;
  /** Best known date taken (seconds). */
  takenAt: number;
  views: number;
  /** In the trash since (ms). */
  deletedAt: number | null;
}

export interface Crumb {
  id: number;
  name: string;
}

export interface FolderCard {
  id: number;
  name: string;
  parentId: number | null;
  path: Crumb[];
  depth: number;
  items: number;
  directItems: number;
  subfolders: number;
  cover: number | null;
  coverKind: Kind | null;
  tags: string[];
  pinned: boolean;
  color: string | null;
  emoji: string | null;
}

export interface FolderView {
  folder: FolderCard | null;
  subfolders: FolderCard[];
  items: Item[];
}

export interface ItemFilter {
  /** number = that folder, null = top level, undefined = no folder limit */
  folder?: number | null;
  recursive?: boolean;
  folders?: number[];
  tags?: string[];
  favouritesOnly?: boolean;
  kinds?: Kind[];
  recentDays?: number;
  /** File name contains each of these. */
  names?: string[];
  trash?: boolean;
}

export interface TrashFolder {
  id: number;
  name: string;
  location: string;
  deletedAt: number;
  items: number;
  bytes: number;
  cover: number | null;
}

export interface TrashView {
  folders: TrashFolder[];
  items: Item[];
  totalItems: number;
  totalBytes: number;
}

export interface Stats {
  items: number;
  bytes: number;
  folders: number;
  tags: number;
  favourites: number;
  neverViewed: number;
  totalViews: number;
  trashItems: number;
  trashBytes: number;
  byKind: { kind: Kind; items: number; bytes: number }[];
  byFolder: { id: number | null; name: string; items: number; bytes: number }[];
  byMonth: { month: string; items: number; bytes: number }[];
  mostViewed: Item[];
}

export interface Bookmark {
  id: number;
  positionMs: number;
  note: string;
}

export interface TagCount {
  name: string;
  items: number;
  folders: number;
}

export interface Named<S = unknown> {
  id: number | null;
  name: string;
  settings: S;
}

export interface ArchiveInfo {
  path: string;
  name: string;
  parts: number;
  needsPassword: boolean;
  media: number;
  error: string | null;
}

export interface DropSummary {
  files: number;
  folders: number;
  archives: ArchiveInfo[];
  unsupported: number;
}

export interface ImportProgress {
  job: number;
  done: number;
  total: number;
  bytes: number;
  current: string;
  source: string;
}

export interface ImportReport {
  job: number;
  imported: number;
  duplicates: number;
  skipped: string[];
  skippedCount: number;
  failed: [string, string][];
  cancelled: boolean;
  bytes: number;
  seconds: number;
}

export interface LocalItem {
  key: string;
  name: string;
  path: string;
  kind: Kind;
  size: number;
  modified: number;
}

export interface LocalSet {
  title: string;
  items: LocalItem[];
  start: number;
}

export interface StorageInfo {
  files: number;
  totalBytes: number;
  packFiles: number;
  reclaimableBytes: number;
  looseObjects: number;
}

export interface StorageProgress {
  task: 'convert' | 'reclaim';
  done: number;
  total: number;
}

export interface StorageDone {
  task: 'convert' | 'reclaim';
  ok: boolean;
  message: string;
}

export type LockReason = 'idle' | 'safetyNet' | 'systemLocked' | 'sleep' | 'minimized' | 'panicKey' | 'manual';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api = {
  getState: () => call<AppState>('get_state'),
  saveConfig: (config: AppConfig) => call<AppConfig>('save_config', { config }),
  addVault: (path: string) => call<VaultEntry>('add_vault', { path }),
  forgetVault: (path: string) => call<void>('forget_vault', { path }),
  createVault: (parent: string, name: string, password: string) =>
    call<{ session: SessionInfo; words: string[] }>('create_vault', { parent, name, password }),
  unlock: (path: string, password: string) => call<SessionInfo>('unlock', { path, password }),
  unlockWithRecovery: (path: string, words: string) => call<SessionInfo>('unlock_with_recovery', { path, words }),
  setNewPassword: (password: string) => call<SessionInfo>('set_new_password', { password }),
  changePassword: (current: string, password: string) => call<void>('change_password', { current, password }),
  resetRecovery: (current: string) => call<string[]>('reset_recovery', { current }),
  lock: () => call<void>('lock_vault'),
  reportActivity: (kind: 'input' | 'playing') => call<void>('report_activity', { kind }),

  // library
  folders: () => call<FolderCard[]>('library_folders'),
  folderView: (folder: number | null) => call<FolderView>('folder_view', { folder }),
  queryItems: (filter: ItemFilter) => call<Item[]>('query_items', { filter }),
  getItem: (id: number) => call<Item>('get_item', { id }),
  createFolder: (parent: number | null, name: string) => call<number>('create_folder', { parent, name }),
  renameFolder: (id: number, name: string) => call<void>('rename_folder', { id, name }),
  moveFolder: (id: number, parent: number | null) => call<void>('move_folder', { id, parent }),
  /** Moves to the trash. */
  deleteFolder: (id: number) => call<number>('delete_folder', { id }),
  /** Moves to the trash. */
  deleteItems: (ids: number[]) => call<number>('delete_items', { ids }),
  restoreItems: (ids: number[]) => call<number>('restore_items', { ids }),
  restoreFolder: (id: number) => call<void>('restore_folder', { id }),
  trashView: () => call<TrashView>('trash_view'),
  deleteForever: (ids: number[]) => call<number>('delete_forever', { ids }),
  deleteFolderForever: (id: number) => call<number>('delete_folder_forever', { id }),
  emptyTrash: () => call<number>('empty_trash'),
  setPinned: (id: number, on: boolean) => call<void>('set_pinned', { id, on }),
  setFolderLook: (id: number, color: string | null, emoji: string | null) => call<void>('set_folder_look', { id, color, emoji }),
  stats: () => call<Stats>('library_stats'),
  markViewed: (id: number) => call<void>('mark_viewed', { id }),
  randomJourney: () => call<{ folder: number | null; item: number } | null>('random_journey'),
  todaysPick: (day: number) => call<Item | null>('todays_pick', { day }),
  folderSamples: (folder: number, n: number) => call<number[]>('folder_samples', { folder, n }),
  bookmarks: (media: number) => call<Bookmark[]>('bookmarks', { media }),
  addBookmark: (media: number, positionMs: number, note: string) => call<number>('add_bookmark', { media, positionMs, note }),
  updateBookmark: (id: number, positionMs: number, note: string) => call<void>('update_bookmark', { id, positionMs, note }),
  deleteBookmark: (id: number) => call<void>('delete_bookmark', { id }),
  /** Save a file made in the app (frame, GIF) into a folder; returns the new item id. */
  addFileBytes: (folder: number | null, name: string, data: Uint8Array) =>
    call<number>('add_file_bytes', { folder, name, data: Array.from(data) }),
  moveItems: (ids: number[], folder: number | null) => call<number>('move_items', { ids, folder }),
  setFavourite: (ids: number[], on: boolean) => call<void>('set_favourite', { ids, on }),
  setWeight: (ids: number[], weight: number) => call<void>('set_weight', { ids, weight }),
  setCover: (folder: number, media: number | null) => call<void>('set_cover', { folder, media }),
  allTags: () => call<TagCount[]>('all_tags'),
  itemTags: (id: number) => call<{ own: string[]; inherited: [string, string][] }>('item_tags', { id }),
  /** Returns, per tag, the items that newly got it. */
  tagItems: (ids: number[], tags: string[]) => call<[string, number[]][]>('tag_items', { ids, tags }),
  /** Returns the items that had the tag. */
  untagItems: (ids: number[], tag: string) => call<number[]>('untag_items', { ids, tag }),
  tagFolder: (folder: number, tags: string[]) => call<void>('tag_folder', { folder, tags }),
  untagFolder: (folder: number, tag: string) => call<void>('untag_folder', { folder, tag }),
  listNamed: <S,>(kind: 'preset' | 'layout') => call<Named<S>[]>('list_named', { kind }),
  saveNamed: <S,>(kind: 'preset' | 'layout', item: Named<S>) => call<number>('save_named', { kind, item }),
  deleteNamed: (kind: 'preset' | 'layout', id: number) => call<void>('delete_named', { kind, id }),

  // thumbnails
  thumbsNeeded: (limit: number) => call<{ id: number; kind: Kind }[]>('thumbs_needed', { limit }),
  saveThumb: (id: number, data: number[], width: number | null, height: number | null, durationMs: number | null) =>
    call<void>('save_thumb', { id, data, width, height, durationMs }),
  thumbFailed: (id: number) => call<void>('thumb_failed', { id }),

  // import
  inspectDrop: (paths: string[]) => call<DropSummary>('inspect_drop', { paths }),
  checkArchivePassword: (path: string, password: string) => call<void>('check_archive_password', { path, password }),
  startImport: (paths: string[], target: number | null, password: string | null, archiveFolder = true) =>
    call<number>('start_import', { paths, target, password, archiveFolder }),
  cancelImport: (job: number) => call<void>('cancel_import', { job }),

  // storage housekeeping
  storageInfo: () => call<StorageInfo>('storage_info'),
  storageTask: (task: 'convert' | 'reclaim') => call<void>('storage_task', { task }),

  // outside-vault player
  scanLocal: (paths: string[]) => call<LocalSet>('scan_local', { paths }),
};

export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  return listen<T>(name, (e) => cb(e.payload));
}

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/** URL for a custom protocol path (Windows uses http://<scheme>.localhost). */
function proto(scheme: string, path: string): string {
  return isWindows ? `http://${scheme}.localhost/${path}` : `${scheme}://localhost/${path}`;
}

export const mediaUrl = (id: number) => proto('vault', `media/${id}`);
export const thumbUrl = (id: number) => proto('vault', `thumb/${id}`);
export const localUrl = (key: string) => proto('local', `f/${key}`);

export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return mock.pickFolder();
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === 'string' ? r : null;
}

export async function onLocked(cb: (reason: LockReason) => void): Promise<UnlistenFn> {
  if (!inTauri) {
    mock.lockListeners.push(cb);
    return () => {};
  }
  return listen<LockReason>('vault-locked', (e) => cb(e.payload));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) return mock.call(cmd, args ?? {}) as Promise<T>;
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

// ---- browser-only mock -------------------------------------------------------

const WORDS =
  'harbor lunar ticket pepper oval wisdom gentle forest canyon ribbon atom spray velvet frozen orbit maple shadow guitar remind lens unfair candle drift solar'.split(
    ' ',
  );

const mock = {
  lockListeners: [] as ((r: LockReason) => void)[],
  state: {
    config: {
      accent: '#2ec4b6',
      lock: { idleMinutes: 15, onSystemLock: true, onMinimize: false, safetyNetMinutes: 0 },
      fullscreenControlsOnMouse: true,
      preview: 'hover',
      wholeOnHover: false,
      gridShape: false,
      viewer: { smoothFit: true, smoothZoom: true, sharpen: false, seekSeconds: 5, seekBigSeconds: 30 },
      vaults: [{ path: 'D:\\Vaults\\Photos' }, { path: 'D:\\Vaults\\Archive' }, { path: 'F:\\Vault backup' }],
      lastVault: 'D:\\Vaults\\Photos',
    },
    vaults: [
      { path: 'D:\\Vaults\\Photos', name: 'Photos', status: 'ready', sizeBytes: 8.2e9 },
      { path: 'D:\\Vaults\\Archive', name: 'Archive', status: 'ready', sizeBytes: 1.01e11 },
      { path: 'F:\\Vault backup', name: 'Vault backup', status: 'missing', sizeBytes: null },
    ],
    session: null,
    minPasswordChars: 8,
  } as AppState,
  pickFolder: async () => 'D:\\Vaults',
  async call(cmd: string, a: Record<string, unknown>): Promise<unknown> {
    await new Promise((r) => setTimeout(r, cmd.startsWith('unlock') || cmd === 'create_vault' ? 600 : 50));
    const s = this.state;
    const session = (path: string, needsNewPassword = false): SessionInfo => ({
      path,
      name: path.split('\\').pop() ?? path,
      items: 0,
      folders: 0,
      needsNewPassword,
      restoredFromBackup: null,
    });
    switch (cmd) {
      case 'get_state':
        return structuredClone(s);
      case 'save_config':
        s.config = { ...(a.config as AppConfig), vaults: s.config.vaults, lastVault: s.config.lastVault };
        return s.config;
      case 'unlock':
        if (a.password !== 'password') throw new Error("That password doesn't match this vault. (Preview: use “password”.)");
        return (s.session = session(a.path as string));
      case 'unlock_with_recovery':
        return (s.session = session(a.path as string, true));
      case 'set_new_password':
        s.session = { ...s.session!, needsNewPassword: false };
        return s.session;
      case 'create_vault': {
        const path = `${a.parent}\\${a.name}`;
        s.vaults.push({ path, name: a.name as string, status: 'ready', sizeBytes: 4096 });
        return { session: (s.session = session(path)), words: WORDS };
      }
      case 'reset_recovery':
        return WORDS;
      case 'lock_vault':
        s.session = null;
        this.lockListeners.forEach((l) => l('manual'));
        return;
      case 'forget_vault':
        s.vaults = s.vaults.filter((v) => v.path !== a.path);
        return;
      case 'add_vault':
        throw new Error('Preview: adding vaults works in the real app.');
      case 'library_folders':
      case 'query_items':
      case 'all_tags':
      case 'list_named':
      case 'thumbs_needed':
        return [];
      case 'storage_info':
        return { files: 14, totalBytes: 3.2e9, packFiles: 4, reclaimableBytes: 0, looseObjects: 0 };
      case 'trash_view':
        return { folders: [], items: [], totalItems: 0, totalBytes: 0 };
      case 'library_stats':
        return { items: 0, bytes: 0, folders: 0, tags: 0, favourites: 0, neverViewed: 0, totalViews: 0, trashItems: 0, trashBytes: 0, byKind: [], byFolder: [], byMonth: [], mostViewed: [] };
      case 'bookmarks':
      case 'folder_samples':
        return [];
      case 'folder_view':
        return { folder: null, subfolders: [], items: [] };
      default:
        return;
    }
  },
};
