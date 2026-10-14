// Typed calls into the Rust backend. When the UI runs in a plain browser
// (design preview, no Tauri), a small in-memory mock answers instead.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { demoCall, demoOn, NOT_DEMO } from './mockdemo';

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
  /** Last mute choice, used by every player. */
  muted: boolean;
  soundVolume: number;
  /** Items per row in the library grid (0 = automatic). */
  gridColumns: number;
  /** A soft, blurred colour glow of the picture behind it instead of black. */
  ambient: boolean;
  /** Boxes around found faces in the viewer (also switched from the library). */
  faceBoxes: boolean;
  /** Slideshow "Line up faces": the main face stays at the same place and size. */
  alignFaces?: boolean;
}

export const DEFAULT_VIEWER: ViewerSettings = {
  smoothFit: true, smoothZoom: true, sharpen: false, seekSeconds: 5, seekBigSeconds: 30, muted: true, soundVolume: 0, gridColumns: 0,
  ambient: false, faceBoxes: false, alignFaces: false,
};

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
  /** Use the web engine shipped next to the app (full package). */
  builtinEngine: boolean;
  /** The smart-search switch next to the search box. */
  smartSearch: boolean;
  /** Make small preview clips of videos in the background. */
  makePreviews: boolean;
  /** Analyse pictures for smart search in the background. */
  smartIndex: boolean;
  /** Hide the app's windows from screenshots, screen recording and screen sharing. */
  blockCapture: boolean;
  look: LookSettings;
  /** Remove camera info, location and dates from files that leave the vault. */
  stripMetadata: boolean;
  /** A Windows notification when a long job finishes in the background. */
  notifyDone: boolean;
  vaults: { path: string }[];
  lastVault: string | null;
}

export const DEFAULT_LOOK: LookSettings = {
  sidebarRail: false, hoverInfo: true, faceCrop: false, uiScale: 1, style: 'default', tileGap: 10, tileRadius: 8, topBar: [], minimap: true,
};

export interface LookSettings {
  sidebarRail: boolean;
  hoverInfo: boolean;
  faceCrop: boolean;
  /** 0.5–2, 1 = normal. */
  uiScale: number;
  style: 'default' | 'oled' | 'graphite' | 'midnight';
  tileGap: number;
  tileRadius: number;
  /** Top-bar buttons in order; empty = default. */
  topBar: string[];
  /** The scroll preview strip beside the grid's scrollbar (long grids only). */
  minimap?: boolean;
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
  /** Only right after unlocking. */
  login?: LoginInfo | null;
}

export interface LoginInfo {
  /** The previous opening (seconds, computer name). */
  last: { at: number; computer: string } | null;
  /** Wrong passwords / recovery words tried since then (seconds). */
  failed: number[];
}

export interface DamageReport {
  itemsChecked: number;
  bytesChecked: number;
  damaged: { id: number; name: string; location: string; inTrash: boolean; problem: string }[];
  thumbsRedone: number;
  backupsOk: number;
  backupsBad: string[];
  cancelled: boolean;
  seconds: number;
}

export interface ExportRequest {
  ids?: number[];
  folder?: number | null;
  all?: boolean;
  dest: string;
}

export interface ExportProgress {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
  name: string;
}

export interface ExportDone {
  exported: number;
  bytes: number;
  failed: [string, string][];
  folder: string;
  cancelled: boolean;
  error: string | null;
}

// ---- share as encrypted .7z ----

export interface ShareRequest {
  ids: number[];
  folders: number[];
  /** Full path of the .7z to create (".7z" is added if missing). */
  dest: string;
  password: string;
  encryptNames: boolean;
  /** 0 = store (no compression), 1–9 = LZMA2 level. */
  level: number;
  /** Split into parts of this many bytes (name.7z.001, .002, …); null = one file. */
  splitBytes: number | null;
  keepStructure: boolean;
}

/** Same shape as ExportProgress. */
export type ShareProgress = ExportProgress;

export interface ShareDone {
  files: number;
  bytes: number;
  archiveBytes: number;
  parts: string[];
  failed: [string, string][];
  cancelled: boolean;
  error: string | null;
}

// ---- end share ----

export interface EngineInfo {
  mode: 'builtin' | 'system' | 'fallback';
  available: boolean;
  version: string | null;
}

export interface ScanRequest {
  ids?: number[];
  folder?: number | null;
  all?: boolean;
  again?: boolean;
}

export interface ScanStatus {
  queued: number;
  scanned: number;
  faces: number;
  failed: number;
}

export interface FaceIn {
  frameMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  descriptor: number[];
}

export interface FaceBox {
  id: number;
  frameMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
  person: number | null;
}

export interface Suggestion {
  faceId: number;
  item: Item;
  frameMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
  /** Very likely: ticked by default. */
  sure: boolean;
}

export interface PersonGroup {
  person: { folder: number; name: string; known: number; unsure: number };
  suggestions: Suggestion[];
}

export interface UnknownGroup {
  faceIds: number[];
  samples: Suggestion[];
  photos: number;
}

export interface FaceReview {
  people: PersonGroup[];
  unknown: UnknownGroup[];
  status: ScanStatus;
}

export interface ClipStatus {
  total: number;
  done: number;
  failed: number;
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
  /** Videos: a small preview clip exists. */
  preview: boolean;
  /** A free copy: the original's id. */
  copyOf: number | null;
  /** Other items share this item's stored file (original or free copies). */
  linked: boolean;
  note: string | null;
  /** Videos: where you left off (ms). */
  resumeMs: number | null;
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
  /** A person folder (face recognition learns this person from it). */
  person: boolean;
  /** Up to three pictures from inside (stacked cards). */
  samples: number[];
  note: string | null;
  /** When the folder was made (seconds). */
  createdAt: number;
  /** Size of everything inside, subfolders included (bytes). */
  bytes: number;
  /** Person folders: the face in the cover picture [x, y, w, h] (parts of its size), for the round cover. */
  coverFace?: [number, number, number, number] | null;
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
  /** Person folders: in the folder or confirmed by face recognition. */
  people?: number[];
}

export interface Extracted {
  parent: number | null;
  items: number[];
  folders: number[];
  renamed: [number, string, string][];
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

export interface CacheInfo {
  thumbs: number;
  thumbBytes: number;
  previews: number;
  previewBytes: number;
}

export interface DataInfo {
  faces: number;
  faceBytes: number;
  clipItems: number;
  clipBytes: number;
  backups: number;
  backupBytes: number;
  libraryBytes: number;
}

export type StorageTask = 'convert' | 'reclaim' | 'deleteThumbs' | 'deletePreviews';

export interface StorageProgress {
  task: StorageTask;
  done: number;
  total: number;
}

export interface StorageDone {
  task: StorageTask;
  ok: boolean;
  message: string;
}

export type LockReason = 'idle' | 'safetyNet' | 'systemLocked' | 'sleep' | 'minimized' | 'panicKey' | 'manual';

let lastLogin: LoginInfo | null = null;
function keepLogin(s: SessionInfo): SessionInfo {
  lastLogin = s.login ?? null;
  return s;
}
/** The login history from the last unlock, once. */
export function takeLogin(): LoginInfo | null {
  const l = lastLogin;
  lastLogin = null;
  return l;
}

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const api = {
  getState: () => call<AppState>('get_state'),
  saveConfig: (config: AppConfig) => call<AppConfig>('save_config', { config }),
  addVault: (path: string) => call<VaultEntry>('add_vault', { path }),
  forgetVault: (path: string) => call<void>('forget_vault', { path }),
  createVault: (parent: string, name: string, password: string) =>
    call<{ session: SessionInfo; words: string[] }>('create_vault', { parent, name, password }),
  unlock: (path: string, password: string) => call<SessionInfo>('unlock', { path, password }).then(keepLogin),
  unlockWithRecovery: (path: string, words: string) => call<SessionInfo>('unlock_with_recovery', { path, words }).then(keepLogin),
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
  /** All or nothing; folders can swap names. */
  renameMany: (folders: [number, string][], items: [number, string][]) => call<void>('rename_many', { folders, items }),
  moveFolder: (id: number, parent: number | null) => call<void>('move_folder', { id, parent }),
  /** Moves to the trash. */
  deleteFolder: (id: number) => call<number>('delete_folder', { id }),
  /** Moves to the trash. */
  deleteItems: (ids: number[]) => call<number>('delete_items', { ids }),
  restoreItems: (ids: number[]) => call<number>('restore_items', { ids }),
  restoreFolder: (id: number) => call<void>('restore_folder', { id }),
  /** Move everything inside a folder up into its parent (the folder stays, empty). */
  extractFolder: (id: number) => call<Extracted>('extract_folder', { id }),
  unextractFolder: (id: number, extracted: Extracted) => call<void>('unextract_folder', { id, extracted }),
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
  // ---- organising
  freeCopy: (ids: number[], folder: number | null) => call<number[]>('free_copy', { ids, folder }),
  itemCopies: (id: number) => call<Item[]>('item_copies', { id }),
  freeCopiesOf: (ids: number[]) => call<[number, Item[]][]>('free_copies_of', { ids }),
  promoteCopy: (old: number, next: number) => call<CopyLinks>('promote_copy', { old, new: next }),
  restoreLinks: (links: CopyLinks) => call<void>('restore_links', { links }),
  /** Real copies; 'copy-progress' [done, total] while it works. */
  copyInto: (ids: number[], folders: number[], target: number | null) => call<{ items: number[]; folders: number[] }>('copy_into', { ids, folders, target }),
  mergePlan: (target: number, sources: number[]) => call<Item[][]>('merge_plan', { target, sources }),
  mergeFolders: (target: number, sources: number[], trash: number[]) => call<Merged>('merge_folders', { target, sources, trash }),
  unmergeFolders: (merged: Merged) => call<void>('unmerge_folders', { merged }),
  setFolderOrder: (ids: number[]) => call<[number, number][]>('set_folder_order', { ids }),
  restoreFolderOrder: (before: [number, number][]) => call<void>('restore_folder_order', { before }),
  tagList: () => call<TagInfo[]>('tag_list'),
  renameTag: (old: string, next: string) => call<TagUse>('rename_tag', { old, new: next }),
  deleteTag: (name: string) => call<TagUse>('delete_tag', { name }),
  restoreTag: (before: TagUse, current: string | null) => call<void>('restore_tag', { before, current }),
  setTagColor: (name: string, color: string | null) => call<string | null>('set_tag_color', { name, color }),
  setNote: (folder: boolean, id: number, note: string | null) => call<string | null>('set_note', { folder, id, note }),
  continueWatching: () => call<Item[]>('continue_watching'),
  suggestFolders: (item: number) => call<{ folder: number; reason: 'face' | 'look'; score: number }[]>('suggest_folders', { item }),
  exactGroups: (folder: number | null) => call<Item[][]>('exact_groups', { folder }),
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
  saveThumb: (id: number, data: number[], width: number | null, height: number | null, durationMs: number | null, sharper = false) =>
    call<void>('save_thumb', { id, data, width, height, durationMs, sharper }),
  /** Older, smaller thumbnails still to remake sharper (ids after..upto). */
  thumbsToSharpen: (after: number, upto: number, limit: number) => call<{ id: number; kind: Kind }[]>('thumbs_to_sharpen', { after, upto, limit }),
  newestItemId: () => call<number>('newest_item_id'),
  countToSharpen: (after: number, upto: number) => call<number>('count_to_sharpen', { after, upto }),
  thumbFailed: (id: number) => call<void>('thumb_failed', { id }),

  // import
  inspectDrop: (paths: string[]) => call<DropSummary>('inspect_drop', { paths }),
  checkArchivePassword: (path: string, password: string) => call<void>('check_archive_password', { path, password }),
  startImport: (paths: string[], target: number | null, password: string | null, archiveFolder = true) =>
    call<number>('start_import', { paths, target, password, archiveFolder }),
  cancelImport: (job: number) => call<void>('cancel_import', { job }),

  // storage housekeeping
  storageInfo: () => call<StorageInfo>('storage_info'),
  storageTask: (task: StorageTask) => call<void>('storage_task', { task }),
  cacheInfo: () => call<CacheInfo>('cache_info'),
  dataInfo: () => call<DataInfo>('data_info'),
  /** Delete face data, smart-search data or library backups; returns what happened. */
  deleteData: (what: 'faces' | 'clip' | 'backups') => call<string>('delete_data', { what }),
  /** Ctrl+S: write everything to disk now. */
  saveNow: () => call<void>('save_now'),
  /** Small remembered UI state for this vault (JSON text). */
  uiGet: (key: string) => call<string | null>('ui_get', { key }),
  uiSet: (key: string, value: string) => call<void>('ui_set', { key, value }),

  // preview clips
  previewsNeeded: (limit: number, prefer: number[]) => call<{ id: number; durationMs: number | null }[]>('previews_needed', { limit, prefer }),
  savePreview: (id: number, data: number[]) => call<void>('save_preview', { id, data }),
  previewFailed: (id: number) => call<void>('preview_failed', { id }),

  // outside-vault player
  scanLocal: (paths: string[]) => call<LocalSet>('scan_local', { paths }),

  // safety
  checkDamage: () => call<void>('check_damage'),
  cancelTask: (task: 'check' | 'export' | 'share' | 'convert' | 'animation') => call<void>('cancel_task', { task }),
  exportStart: (request: ExportRequest) => call<void>('export_start', { request }),
  // share as encrypted .7z: "share-progress" (ShareProgress), then "share-done" (ShareDone)
  share7zStart: (request: ShareRequest) => call<void>('share_7z_start', { request }),
  engineInfo: () => call<EngineInfo>('engine_info'),
  engineStarted: () => call<void>('engine_started'),
  engineRetry: () => call<void>('engine_retry'),

  // faces
  setPersonFolder: (folder: number, on: boolean) => call<void>('set_person_folder', { folder, on }),
  facesQueue: (request: ScanRequest) => call<number>('faces_queue', { request }),
  facesNeeded: (limit: number) => call<{ id: number; kind: Kind; durationMs: number | null }[]>('faces_needed', { limit }),
  facesSave: (media: number, faces: FaceIn[]) => call<number>('faces_save', { media, faces }),
  facesFailed: (media: number) => call<void>('faces_failed', { media }),
  facesStatus: () => call<ScanStatus>('faces_status'),
  facesReview: () => call<FaceReview>('faces_review'),
  facesAccept: (faceIds: number[], person: number) => call<{ moved: number; tagged: number }>('faces_accept', { faceIds, person }),
  facesReject: (faceIds: number[], person: number) => call<void>('faces_reject', { faceIds, person }),
  facesNewPerson: (name: string, parent: number | null, faceIds: number[]) =>
    call<{ folder: number; accepted: { moved: number; tagged: number } }>('faces_new_person', { name, parent, faceIds }),
  facesOf: (media: number) => call<FaceBox[]>('faces_of', { media }),
  facesOfMany: (media: number[]) => call<[number, FaceBox[]][]>('faces_of_many', { media }),
  setResume: (id: number, ms: number | null) => call<void>('set_resume', { id, ms }),
  facesUnsure: (person: number) => call<Item[]>('faces_unsure', { person }),

  // smart search
  clipNeeded: (limit: number) => call<{ id: number; kind: Kind; preview: boolean }[]>('clip_needed', { limit }),
  clipSave: (media: number, vec: number[]) => call<void>('clip_save', { media, vec }),
  clipFailed: (media: number) => call<void>('clip_failed', { media }),
  clipStatus: () => call<ClipStatus>('clip_status'),
  smartSearch: (vec: number[], folder: number | null, limit?: number) =>
    call<{ item: Item; score: number }[]>('smart_search', { vec, folder, limit }),
  similarNeeded: (limit: number) => call<{ id: number; kind: Kind }[]>('similar_needed', { limit }),
  similarSave: (id: number, hash: string, sharpness: number) => call<void>('similar_save', { id, hash, sharpness }),
  similarFailed: (id: number) => call<void>('similar_failed', { id }),
  similarStatus: () => call<{ total: number; done: number }>('similar_status'),
  /** Groups of look-alikes, biggest first, each with its best picture first. */
  similarGroups: (level: SimilarLevel, smart: boolean, folder: number | null, videos: boolean) =>
    call<Item[][]>('similar_groups', { level, smart, folder, videos }),
  similarTo: (id: number, smart: boolean) => call<{ item: Item; score: number }[]>('similar_to', { id, smart }),

  // video tool (ffmpeg): convert, animation from pictures
  videoToolInfo: () => call<VideoToolInfo | undefined>('video_tool_info'),
  /** Runs in the background: 'convert-progress' events, then 'convert-done'. */
  convertStart: (request: ConvertRequest) => call<void>('convert_start', { request }),
  /** Runs in the background: 'animation-progress' events, then 'animation-done'. */
  animationStart: (request: AnimationRequest) => call<void>('animation_start', { request }),
  cancelVideoTask: (task: VideoTask) => call<void>('cancel_task', { task }),
  // beat detection from the computer's own sound (Windows; nothing is recorded)
  /** True where listening to the computer's sound can work (Windows). */
  beatsSupported: () => call<boolean>('beats_supported'),
  /** Start listening; "beat" and "beat-level" events follow. Safe to call twice. */
  beatsStart: () => call<void>('beats_start'),
  beatsStop: () => call<void>('beats_stop'),

  // duel mode: pick the better of two; Elo ratings set the slideshow weights
  duelRatings: (ids: number[]) => call<DuelState[]>('duel_ratings', { ids }),
  duelResult: (winner: number, loser: number) => call<DuelOutcome>('duel_result', { winner, loser }),
  /** Undo: put items back as they were (`before` of a DuelOutcome). */
  duelRestore: (states: DuelState[]) => call<void>('duel_restore', { states }),

  // "Why is this here?" (explain.rs): the search's own rules, item by item.
  // `smart` is the smart-search query vector (searched in `smartFolder`).
  explainMatch: (id: number, filter: ItemFilter, smart?: number[] | null, smartFolder?: number | null) =>
    call<Explanation>('explain_match', { id, filter, smart: smart ?? null, smartFolder: smartFolder ?? null }),
  // the slot machine (slots.rs): pictures of a folder and its subfolders, with people and tag groups
  slotData: (folder: number | null) => call<SlotData>('slot_machine_data', { folder }),
  // offline AI upscaler (Rust: upscale.rs; window side: components/Upscale.tsx)
  upscaleInfo: () => call<UpscalerInfo>('upscale_info'),
  /** Sends the picture's pixels; 'upscale-progress' events follow, then 'upscale-done'. Returns the job number. */
  upscaleStart: (request: UpscaleRequest, rgba: Uint8Array) => upscaleStart(request, rgba),
  /** Stops the running upscale (its 'upscale-done' says cancelled). */
  upscaleCancel: () => call<void>('upscale_cancel'),
  /** Saves a result as a new item next to the original. */
  upscaleSave: (token: number) => call<UpscaleSaved>('upscale_save', { token }),
  /** The viewer closed: forget results, free the models' memory. */
  upscaleForget: () => call<void>('upscale_forget'),
};

// ---- why is this here? / slot machine ----------------------------------------------

/** Character ranges [start, end) in the original text (count with Array.from). */
export type Ranges = [number, number][];

export interface Explanation {
  item: Item;
  /** Passes every rule of the search (the same answer the search gives). */
  matched: boolean;
  folderPath: string[];
  names: { word: string; found: boolean; inName: Ranges; inNote: Ranges; inFolderPath: boolean }[];
  tags: { tag: string; found: boolean; own: boolean; fromFolders: string[] }[];
  people: { id: number; name: string; found: boolean; inFolder: boolean; faces: number }[];
  filters: { filter: 'kind' | 'favourites' | 'recent' | 'folder' | 'trash'; passed: boolean; wants: string; has: string }[];
  smart: { score: number | null; best: number; cut: number; minResults: number; rank: number | null; kept: boolean } | null;
}

export interface SlotData {
  items: Item[];
  groups: { kind: 'person' | 'tag'; key: string; label: string; items: number[] }[];
}

// ---- duel mode -----------------------------------------------------------------

export interface DuelState {
  id: number;
  /** 1000 for items that never duelled. */
  elo: number;
  duels: number;
  weight: number;
}

export interface DuelOutcome {
  winnerElo: number;
  loserElo: number;
  winnerWeight: number;
  loserWeight: number;
  /** Both items before this duel (winner first), for undo. */
  before: DuelState[];
}

// ---- video tool (ffmpeg) -----------------------------------------------------

export interface VideoToolInfo {
  available: boolean;
  version: string | null;
}

export type ConvertTarget = 'mp4' | 'webm' | 'gif' | 'jpg' | 'png' | 'webp';
export type VideoTask = 'convert' | 'animation';

export interface ConvertRequest {
  ids: number[];
  target: ConvertTarget;
  /** Put the originals in the trash once the new items are saved. */
  replace: boolean;
}

/** Payload of 'convert-progress' and 'animation-progress'. */
export interface VideoToolProgress {
  task: VideoTask;
  done: number;
  total: number;
  name: string;
  /** Everything together, 0…1. */
  fraction: number;
}

/** Payload of 'convert-done'. */
export interface ConvertDone {
  converted: number;
  created: number[];
  replaced: number;
  failed: [string, string][];
  cancelled: boolean;
  error: string | null;
}

export interface AnimationRequest {
  /** In the order they should appear. */
  ids: number[];
  format: 'gif' | 'mp4';
  secondsPerImage: number;
  /** 0 = the first picture's own width. */
  width: number;
  quality: 'low' | 'medium' | 'high';
  loopForever: boolean;
  fit: 'bars' | 'crop';
}

/** Payload of 'animation-done'. */
export interface AnimationDone {
  id: number | null;
  name: string;
  skipped: [string, string][];
  cancelled: boolean;
  error: string | null;
}


/** Payload of the "beat" event. */
export interface BeatEvent {
  /** Milliseconds since listening started. */
  t_ms: number;
  /** 0..1, how clearly the beat stood out. */
  strength: number;
  /** Tempo estimate once there is a steady one. */
  bpm: number | null;
}

/** Payload of the "beat-level" event (about 10 a second). */
export interface BeatLevelEvent {
  level: number;
}

export type SimilarLevel = 'strict' | 'normal' | 'loose';

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
export const previewUrl = (id: number) => proto('vault', `preview/${id}`);
export const localUrl = (key: string) => proto('local', `f/${key}`);
export const modelUrl = (name: string) => proto('models', name);

export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return mock.pickFolder();
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === 'string' ? r : null;
}

/** Save dialog for the shared archive. */
export async function pickSave7z(title: string, defaultPath: string): Promise<string | null> {
  if (!inTauri) return `D:\\Shared\\${defaultPath}`;
  const r = await save({ title, defaultPath, filters: [{ name: '7-Zip archive', extensions: ['7z'] }] });
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
      viewer: { smoothFit: true, smoothZoom: true, sharpen: false, seekSeconds: 5, seekBigSeconds: 30, muted: true, soundVolume: 0, gridColumns: 0, ambient: false, faceBoxes: false },
      builtinEngine: true,
      smartSearch: false,
      makePreviews: true,
      smartIndex: true,
      blockCapture: true,
      look: { sidebarRail: false, hoverInfo: true, faceCrop: false, uiScale: 1, style: 'default', tileGap: 10, tileRadius: 8, topBar: [] },
      stripMetadata: false,
      notifyDone: true,
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
    // Preview with sample folders, people and tags: open the page with ?demo.
    if (demoOn()) {
      const d = demoCall(cmd, a);
      if (d !== NOT_DEMO) return d;
    }
    const demo = (await import('./mockgrid')).demoAnswer(cmd, a);
    if (demo !== undefined) return demo;
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
      case 'beats_supported':
        return false;
      case 'upscale_info':
        return { available: true, problem: null, folder: 'C:\\MediaVault\\tools\\upscaler', device: 'gpu', deviceKnown: false } satisfies UpscalerInfo;
      case 'upscale_start':
        return mockUpscale(a.request as UpscaleRequest);
      case 'upscale_cancel':
        mockJob += 1;
        return;
      case 'upscale_save':
        return { id: 999, name: 'Picture (upscaled).jpg' } satisfies UpscaleSaved;
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
      case 'faces_needed':
      case 'clip_needed':
      case 'faces_of':
      case 'smart_search':
        return [];
      case 'engine_info':
        return { mode: 'system', available: false, version: null };
      case 'faces_status':
        return { queued: 0, scanned: 0, faces: 0, failed: 0 };
      case 'faces_review':
        return { people: [], unknown: [], status: { queued: 0, scanned: 0, faces: 0, failed: 0 } };
      case 'previews_needed':
      case 'thumbs_to_sharpen':
        return [];
      case 'newest_item_id':
      case 'count_to_sharpen':
        return 0;
      case 'ui_get':
        return null;
      case 'data_info':
        return { faces: 0, faceBytes: 0, clipItems: 0, clipBytes: 0, backups: 0, backupBytes: 0, libraryBytes: 0 };
      case 'cache_info':
        return { thumbs: 0, thumbBytes: 0, previews: 0, previewBytes: 0 };
      case 'clip_status':
        return { total: 0, done: 0, failed: 0 };
      case 'folder_view':
        return { folder: null, subfolders: [], items: [] };
      default:
        return;
    }
  },
};

// ---- Windows Explorer: drag out, copy/paste (Rust: winshell) ----------------------
// Kept apart from `api` above. Off Windows every call fails with "This only
// works on Windows.". See dragout.ts and winclip.ts for how to use them.

export interface ClipboardContent {
  /** Files and folders copied in Explorer (full paths): import them like a drop. */
  files: string[];
  /** A copied picture (screenshot, image from a browser…) as PNG bytes. */
  imagePng: number[] | null;
  /** The clipboard holds items Ctrl+C'd in this app. */
  ours: boolean;
}

export const winshell = {
  /** Start a real Windows drag of these items/folders (the mouse button must still be held). */
  dragOut: (ids: number[], folders: number[]) => call<'copied' | 'cancelled'>('drag_out', { ids, folders }),
  /** Ctrl+C: offer these items/folders to Explorer. Explorer asks before copying. Returns the file count. */
  clipboardPutFiles: (ids: number[], folders: number[]) => call<number>('clipboard_put_files', { ids, folders }),
  /** Take our items off the clipboard, if they are still on it. */
  clipboardClearOurs: () => call<void>('clipboard_clear_ours'),
  /** What is on the clipboard (undefined in the browser preview). */
  clipboardRead: () => call<ClipboardContent | undefined>('clipboard_read'),
  /** Save a pasted picture as a new item (the same path as saving a video frame). */
  importImageBytes: (folder: number | null, name: string, bytes: Uint8Array) => api.addFileBytes(folder, name, bytes),
};

// ---- organising -------------------------------------------------------------------------
export interface CopyLinks { items: [number, number | null][] }
export interface Merged { items: [number, number | null][]; folders: [number, number | null][]; emptied: number[]; trashed: number[] }
export interface TagInfo { name: string; color: string | null; items: number; folders: number }
export interface TagUse { name: string; color: string | null; items: number[]; folders: number[] }

// ---- background jobs, vault growth (Rust: lib.rs, growth.rs) ---------------------------

/** Thumbnails and preview clips still to make. */
export interface BackgroundLeft {
  thumbs: number;
  previews: number;
}

export interface GrowthMonth {
  /** "2026-10" */
  month: string;
  /** Files added that month and their size. */
  items: number;
  bytes: number;
  /** Everything stored at the end of that month. */
  totalItems: number;
  totalBytes: number;
}

/** Stored size by the month things were added. Free copies count once; the trash counts (it still takes space). */
export interface Growth {
  months: GrowthMonth[];
  totalItems: number;
  totalBytes: number;
  last30Items: number;
  last30Bytes: number;
  trashItems: number;
  trashBytes: number;
}

/** A believable two-year history for the browser preview. */
function mockGrowth(): Growth {
  const months: GrowthMonth[] = [];
  const d = new Date();
  let ti = 0;
  let tb = 0;
  for (let k = 25; k >= 0; k--) {
    const at = new Date(d.getFullYear(), d.getMonth() - k, 1);
    const wave = Math.sin(k * 1.7) * 0.5 + 0.5;
    const items = k === 9 ? 0 : Math.round(40 + wave * 260 + (k % 5 === 0 ? 900 : 0));
    const bytes = Math.round(items * (2.1e6 + wave * 6e6));
    ti += items;
    tb += bytes;
    months.push({ month: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`, items, bytes, totalItems: ti, totalBytes: tb });
  }
  const last = months[months.length - 1];
  return { months, totalItems: ti, totalBytes: tb, last30Items: last.items, last30Bytes: last.bytes, trashItems: 37, trashBytes: 412e6 };
}

export const jobsApi = {
  backgroundLeft: () => (inTauri ? call<BackgroundLeft>('background_left') : Promise.resolve<BackgroundLeft>({ thumbs: 0, previews: 0 })),
  vaultGrowth: () => (inTauri ? call<Growth>('vault_growth') : new Promise<Growth>((r) => setTimeout(() => r(mockGrowth()), 80))),
};
// ---- offline AI upscaler -------------------------------------------------------------------

export type UpscaleModel = 'realesrgan' | 'gfpgan';

export interface UpscalerInfo {
  available: boolean;
  /** Why not, in one sentence. */
  problem: string | null;
  /** Where the pack is looked for. */
  folder: string | null;
  /** 'gpu' or 'cpu' (a guess until it has run once: see deviceKnown). */
  device: 'gpu' | 'cpu' | null;
  deviceKnown: boolean;
}

export interface UpscaleRequest {
  itemId: number;
  /** The pixels sent: width × height × 4 (RGBA). */
  width: number;
  height: number;
  model: UpscaleModel;
  /** Per face: eye on the picture's left, other eye, nose tip, mouth left, mouth right (pixels). */
  faces: [number, number][][];
}

/** Payload of 'upscale-progress'. */
export interface UpscaleProgress {
  job: number;
  fraction: number;
  stage: 'loading' | 'picture' | 'faces' | 'finishing';
}

/** Payload of 'upscale-done'. */
export interface UpscaleDone {
  job: number;
  /** Show it with upscaledUrl(token). */
  token: number | null;
  width: number;
  height: number;
  factor: number;
  faces: number;
  device: 'gpu' | 'cpu' | null;
  cancelled: boolean;
  error: string | null;
}

export interface UpscaleSaved {
  id: number;
  name: string;
}

export const upscaledUrl = (token: number) => proto('vault', `upscaled/${token}`);

/** Body: 4 bytes (little-endian) JSON length, the request as JSON, then RGBA. */
export function upscaleBody(request: UpscaleRequest, rgba: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(request));
  const body = new Uint8Array(4 + json.length + rgba.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(rgba, 4 + json.length);
  return body;
}

async function upscaleStart(request: UpscaleRequest, rgba: Uint8Array): Promise<number> {
  if (!inTauri) return mock.call('upscale_start', { request }) as Promise<number>;
  try {
    return await invoke<number>('upscale_start', upscaleBody(request, rgba));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

type UpscaleListener = { progress: (p: UpscaleProgress) => void; done: (d: UpscaleDone) => void };

/** Upscale events (in the browser preview, a pretend run). */
export function onUpscale(cb: UpscaleListener): () => void {
  if (!inTauri) {
    mockUpscaleListeners.add(cb);
    return () => mockUpscaleListeners.delete(cb);
  }
  const a = listen<UpscaleProgress>('upscale-progress', (e) => cb.progress(e.payload));
  const b = listen<UpscaleDone>('upscale-done', (e) => cb.done(e.payload));
  return () => {
    a.then((u) => u());
    b.then((u) => u());
  };
}

const mockUpscaleListeners = new Set<UpscaleListener>();
let mockJob = 0;
function mockUpscale(r: UpscaleRequest): number {
  const job = ++mockJob;
  let f = 0;
  const t = setInterval(() => {
    if (job !== mockJob) {
      clearInterval(t);
      mockUpscaleListeners.forEach((l) => l.done({ job, token: null, width: 0, height: 0, factor: 4, faces: 0, device: null, cancelled: true, error: null }));
      return;
    }
    f = Math.min(1, f + 0.08);
    mockUpscaleListeners.forEach((l) => l.progress({ job, fraction: f, stage: f < 0.75 || r.model === 'realesrgan' ? 'picture' : 'faces' }));
    if (f >= 1) {
      clearInterval(t);
      mockUpscaleListeners.forEach((l) => l.done({ job, token: 0, width: r.width * 4, height: r.height * 4, factor: 4, faces: r.faces.length, device: 'gpu', cancelled: false, error: null }));
    }
  }, 150);
  return job;
}
