// Typed calls into the Rust backend. When the UI runs in a plain browser
// (design preview, no Tauri), a small in-memory mock answers instead.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { noteCall, noteEvent } from './perf';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { CoverPos } from './coverframe';
import type { RiverFace } from './riverplay';

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
  /** The slideshow / timing settings last used in the viewer (restored next time; normalised when read). */
  lastPlayback?: Record<string, unknown> | null;
  /** Slideshow "Line up faces": the main face stays at the same place and size. */
  alignFaces?: boolean;
  /** The picture grows out of its tile when opened and shrinks back into it when closed. */
  openCloseAnim?: boolean;
  /** Slideshow: a small ring by the Slideshow button shows the time to the next item. */
  slideRing?: boolean;
  /** Face boxes in the viewer include the "not important" faces (dimmed). */
  hiddenFaces?: boolean;
  /** 3D photos: the picture follows the mouse (the viewer's 3D button). */
  depthMouse?: boolean;
  /** 3D photos: how strong the depth is (1 = as designed). */
  depthAmount?: number;
  /** 3D photos with the mouse: how strongly it reacts (1 = the picture's edge leans all the way). */
  depthReact?: number;
  /** 3D photos (View ▾): still pictures move gently in depth, in slideshows and while just open. */
  depthAuto?: boolean;
  /** …how far they move (1 = as designed; 0.3–4), how fast (1 = as designed; 0.25–4) and along which shape. */
  depthMotion?: number;
  depthSpeed?: number;
  depthShape?: 'random' | 'circle' | 'infinity' | 'side' | 'updown' | 'diagonal' | 'zoom' | 'drift' | 'spiral' | 'pendulum';
  /** 3D photos: how much the depth map's edges are softened (0.25 sharp – 2 soft; absent = automatic: Best 0.5, Fast 1). */
  depthEdges?: number; // 0 = automatic
  /** 3D for moving pictures (GIFs, animated WebP/PNG; videos too): its own switch and amount (1 = as designed). */
  depthMoving?: boolean;
  depthMovingAmount?: number;
  /** 3D to the beat: with music playing, a push closer or a little bounce on each beat, this strong (1 = as designed). */
  depthBeat?: boolean;
  depthBeatKind?: 'push' | 'bounce';
  depthBeatAmount?: number;
  /** Live video 3D: show each video frame (and its sound) ~0.1 s late so it meets its own depth. */
  depthVideoDelay?: boolean;
  /** The old slideshow setting "3D photos" has been carried over to depthAuto (done once). */
  depthAutoMigrated?: boolean;
  /** 3D photos: which depth model ('v2-small' Fast, 'da3-mono-large' Best; '' = the best one installed; the retired 'da3-base' falls back to the best installed). */
  depthModel?: string;
  /** 3D photos: 'high' sends bigger pictures to models that take any size (more detail, about twice as slow). */
  depthDetail?: 'standard' | 'high';
  /** Subject effects (pictures only): which subject outline model ('birefnet-lite' Fast, 'birefnet' Best; '' = the best one installed). */
  subjectModel?: string;
  /** Lift-off: the subject comes forward a little with a soft shadow behind it, this strong (1 = as designed; 0.3–3). */
  depthLift?: boolean;
  depthLiftAmount?: number;
  /** Sharper depth edges (pictures with an outline): the depth follows the subject's outline, this strong (0.2–1). */
  depthEdges3d?: boolean;
  depthEdgesStrength?: number;
  /** 3D only on the subject: the background stays still, only the subject moves in 3D. */
  depthSubjectOnly?: boolean;
  /** Layered 3D: a filled-in background behind the subject; how it's filled ('' = Simple, 'migan' MI-GAN, 'lama' LaMa). */
  depthLayered?: boolean;
  inpaintModel?: '' | 'migan' | 'lama';
  /** Pictures' depth maps and outlines are worked out (and saved) while the app is left alone for a while. */
  depthIdlePrepare?: boolean;
  /** Discovery river: the current's speed (1 = normal), how many items flow (1 = as designed) and how many depth layers. */
  riverFlow?: number;
  riverDensity?: number;
  riverLayers?: number;
  /** Face boxes in the viewer include the "poor faces" (too small, blurry or turned; dimmed). */
  poorFaces?: boolean;
  /** Discovery river: pictures, or round faces of known people (whose: riverPeople, empty = everyone; smallest face in px: riverFaceMin). */
  riverMode?: 'pictures' | 'faces';
  riverPeople?: number[];
  riverFaceMin?: number;
  // ---- a person's faces (face wall, Best faces, face time-lapse) ----
  /** "Smallest face" of each (pixels tall in the original picture). */
  faceWallMin?: number;
  bestFacesMin?: number;
  timelapseMin?: number;
  /** Best faces: how many to show. */
  bestFacesCount?: number;
  /** Time-lapse: faces per second, morph instead of a cut, and the part of each face's time spent morphing. */
  timelapseFps?: number;
  timelapseMorph?: boolean;
  timelapseMorphShare?: number;
  /** Viewer: drag sideways beside the picture, or click at the far left / right, to go to the previous / next item. */
  swipeNav?: boolean;
}

export const DEFAULT_VIEWER: ViewerSettings = {
  smoothFit: true, smoothZoom: true, sharpen: false, seekSeconds: 5, seekBigSeconds: 30, muted: true, soundVolume: 0, gridColumns: 0,
  ambient: false, faceBoxes: false, alignFaces: false, openCloseAnim: true, slideRing: true, hiddenFaces: false,
  depthMouse: false, depthAmount: 1, depthReact: 1,
  depthAuto: false, depthMotion: 1, depthSpeed: 1, depthShape: 'random', depthEdges: 0, depthMoving: false, depthMovingAmount: 0.6, depthBeat: false, depthBeatKind: 'push', depthBeatAmount: 1, depthVideoDelay: false, depthAutoMigrated: false,
  depthModel: '', depthDetail: 'standard',
  subjectModel: '', depthLift: false, depthLiftAmount: 1,
  depthEdges3d: false, depthEdgesStrength: 0.7, depthSubjectOnly: false,
  depthLayered: false, inpaintModel: '', depthIdlePrepare: true,
  riverFlow: 1, riverDensity: 1, riverLayers: 5,
  poorFaces: false,
  riverMode: 'pictures', riverPeople: [], riverFaceMin: 0,
  faceWallMin: 40, bestFacesMin: 80, timelapseMin: 120, bestFacesCount: 24, timelapseFps: 8, timelapseMorph: false, timelapseMorphShare: 0.5,
  swipeNav: true,
};

export interface AppConfig {
  accent: string;
  lock: LockSettings;
  fullscreenControlsOnMouse: boolean;
  /** Grid previews: everything on screen plays, only the hovered one, or none (always muted). */
  preview: 'all' | 'hover' | 'off';
  /** While previewing, the hovered video/GIF shows uncropped. */
  wholeOnHover: boolean;
  /** Video previews: tiny clips first and the real video when the PC keeps up, or tiny clips only (hover still plays the real video). */
  previewQuality?: 'auto' | 'tiny';
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
  /** Settings → Faces → Poor faces: when a face is too small, blurry or turned to be trusted. */
  poorFaces?: PoorFaceSettings;
  /** After deleting for good, the space deleted files leave in the packs is reclaimed in the background. */
  autoReclaim?: boolean;
  /** Smart search at all (off: no ✦ button, nothing analysed for it). */
  smartEnabled?: boolean;
}

// ---- poor faces (begin) ----
/** A face below these is a "poor face": never named on its own or learned from, unless you name it. */
export interface PoorFaceSettings {
  /** Shorter than this (pixels of the item itself) = too small. 0 = off. */
  minPx: number;
  /** Less sharp than this, on a 0–100 scale = too blurry. 0 = off. */
  blur: number;
  /** Turned further away than this (degrees) = too turned. 90 = off. */
  turn: number;
}

export const DEFAULT_POOR_FACES: PoorFaceSettings = { minPx: 40, blur: 25, turn: 60 };

/** A poor face on the People page, and why it is one. */
export interface PoorFace extends Suggestion {
  small: boolean;
  blurry: boolean;
  turned: boolean;
}
// ---- poor faces (end) ----

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
  /** Stacked folder cards fan out to the sides on hover. */
  fanCards?: boolean;
}

export interface VaultEntry {
  path: string;
  name: string;
  status: 'ready' | 'missing' | 'notVault';
  sizeBytes: number | null;
  /** Opens without a password (clicking it opens it). */
  passwordless: boolean;
  /** False for a vault without encryption. */
  encrypted?: boolean;
}

export interface SessionInfo {
  path: string;
  name: string;
  items: number;
  folders: number;
  needsNewPassword: boolean;
  /** False for a vault that opens without a password (it never locks by itself). */
  hasPassword: boolean;
  /** False for a vault without encryption (its files are ordinary files). */
  encrypted?: boolean;
  /** "plain" or "encrypted" while the vault is being changed to that. */
  converting?: 'plain' | 'encrypted' | null;
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
  /** Poor faces: height (px), sharpness and turn (degrees), measured when found. */
  px?: number;
  sharp?: number;
  turn?: number;
}

export interface FaceBox {
  id: number;
  frameMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
  person: number | null;
  /** Named automatically (not by you). */
  auto?: boolean;
  /** Marked "not important" (only listed when asked for). */
  hidden?: boolean;
  /** Too small, blurry or turned to be trusted: shown only with "Show poor faces too". */
  poor?: boolean;
}

/** One face of a person, for the face wall, Best faces and the time-lapse (facecrops.rs). */
export interface PersonFace {
  id: number;
  mediaId: number;
  frameMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The photo's best known date (seconds). */
  date: number;
  /** The picture's own size (0 when not known yet). */
  width: number;
  height: number;
  /** How tall the face is in the original picture (px). */
  facePx: number;
}

/** What was measured on a face (sharpness, looking at the camera, the five points). */
export interface FaceMeasure {
  id: number;
  sharp: number;
  /** 0 turned away … 1 straight at the camera; null without the faces pack. */
  front: number | null;
  /** Eyes, nose tip, mouth corners, as parts of the picture. */
  points: [number, number][] | null;
  facePx: number;
  /** All together, 0…1. */
  score: number;
  failed: boolean;
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
  person: {
    folder: number; name: string;
    /** Faces you confirmed. */
    known: number;
    unsure: number;
    /** Faces named automatically. */
    recognised?: number;
    /** Photos and videos showing them (their folder, or recognised anywhere). */
    photos?: number;
  };
  /** Unsure faces to tick, most alike first. */
  suggestions: Suggestion[];
  suggestionsTotal?: number;
  /** Named automatically, newest first. */
  recent?: Suggestion[];
  recentTotal?: number;
  /** "This looks like X in 46 photos" (few confirmed faces yet). */
  owner?: { photos: number; samples: Suggestion[] } | null;
}

export interface UnknownGroup {
  /** Stable while the group stays the same. */
  key?: number;
  faceIds: number[];
  samples: Suggestion[];
  photos: number;
  looksLike?: { folder: number; name: string; confidence: number } | null;
}

export interface MergeHint {
  a: number;
  aName: string;
  b: number;
  bName: string;
  confidence: number;
}

/** Native face recognition (InsightFace buffalo_l, the optional faces pack). */
export interface FaceEngineInfo {
  available: boolean;
  problem: string | null;
  folder: string | null;
  device: 'gpu' | 'cpu' | null;
  deviceKnown: boolean;
  /** ONNX Runtime comes from the upscaler pack. */
  sharedRuntime: boolean;
}

export interface FaceEngineStatus {
  native: FaceEngineInfo;
  /** 'none': no faces pack, nothing is scanned. */
  active: 'buffalo_l' | 'none';
  /** Items still to be scanned again with the new model. */
  upgradeLeft: number;
  upgraded: number;
}

export interface FaceReview {
  people: PersonGroup[];
  unknown: UnknownGroup[];
  unknownTotal?: number;
  /** "Not important" people. */
  hidden?: UnknownGroup[];
  /** Faces too small, blurry or turned to be trusted, newest first. */
  poor?: PoorFace[];
  poorTotal?: number;
  /** "These look like the same person — merge?" */
  merges?: MergeHint[];
  status: ScanStatus;
  engine?: FaceEngineStatus;
}

/** How much the People page shows (more as you scroll). */
export interface ReviewRequest {
  /** Per person: how many suggestions. */
  more?: [number, number][];
  /** Per person: how many recognised faces. */
  recent?: [number, number][];
  groups?: number;
  /** How many poor faces. */
  poor?: number;
}

export interface OwnerProposal {
  person: number;
  name: string;
  /** One face per photo, most alike first. */
  faces: Suggestion[];
}

export interface SortOffers {
  /** Of the items asked about, still waiting to be scanned. */
  waiting: number;
  /** Of the items asked about (pictures, GIFs, videos), never scanned for faces. */
  unscanned?: number;
  offers: { folder: number; name: string; items: Item[] }[];
}

export interface ClipStatus {
  total: number;
  done: number;
  failed: number;
}

/** Smart search's picture side: natively (graphics card / processor) or in the window (slow). */
export interface SmartEngine {
  models: boolean;
  native: boolean;
  device: 'gpu' | 'cpu' | null;
  deviceKnown: boolean;
  problem: string | null;
}

/** The native analysis pass (analyse.rs). */
export interface AnalyseStatus {
  running: boolean;
  busy: boolean;
  /** Items done since it started, and per step. */
  done: number;
  thumbs: number;
  prints: number;
  smart: number;
  faces: number;
  /** Items still with something to do. */
  left: number;
  facesLeft: number;
}

export interface AnalyseReport {
  id: number;
  thumb: boolean;
  print: string | null;
  smart: boolean;
  faces: number | null;
  leftToWindow: boolean;
  ms: number;
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
  /** The thumbnail's version (start of its stored id; changes when it is remade): part of its address. */
  thumbV?: string | null;
  importedAt: number;
  folderId: number | null;
  /** Best known date taken (seconds). */
  takenAt: number;
  views: number;
  /** In the trash since (ms). */
  deletedAt: number | null;
  /** Videos: a small preview clip (frame strip) exists. */
  preview: boolean;
  /** Videos: a tiny preview video (a few seconds, small, silent) exists. */
  tiny?: boolean;
  /** A free copy: the original's id. */
  copyOf: number | null;
  /** Other items share this item's stored file (original or free copies). */
  linked: boolean;
  note: string | null;
  /** Videos: where you left off (ms). */
  resumeMs: number | null;
  /** A tiny colour sketch of the thumbnail, drawn until it loads (sketch.ts); none yet = null or missing. */
  sketch?: string | null;
}

export interface Crumb {
  id: number;
  name: string;
}

export interface FolderCard {
  /** The newest / oldest picture date inside, subfolders included (seconds; 0 = empty). */
  newest?: number;
  oldest?: number;
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
  /** The hand-set framing of the cover ("Adjust cover…", coverframe.ts); null = automatic. */
  coverPos?: CoverPos | null;
}

/** A folder's banner: one item shown wide at the top of the folder (banner.rs). */
export interface FolderBanner {
  folder: number;
  media: number;
  kind: Kind;
  /** Where to look, top to bottom (0..1). */
  y: number;
  width: number | null;
  height: number | null;
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
  /** Thumbnail pages (a folder's thumbnails in a few objects; made again by themselves). */
  pages?: number;
  pageBytes?: number;
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
  /** The 3D models' last runs: device, waiting, loading and running times (gpuroom.rs; the timing panel's report). */
  modelsLog: () => call<import('./perf').ModelRun[]>('models_log'),
  /** The user is using the window (or a video plays): the backend's background loops wait between items (bgpace.ts). */
  setUserBusy: (busy: boolean, video: boolean) => call<void>('set_user_busy', { busy, video }),
  getState: () => call<AppState>('get_state'),
  saveConfig: (config: AppConfig) => call<AppConfig>('save_config', { config }),
  addVault: (path: string) => call<VaultEntry>('add_vault', { path }),
  forgetVault: (path: string) => call<void>('forget_vault', { path }),
  /** `password` null = a vault without a password. */
  /** `encrypt` false: a vault without encryption (no password, no recovery key; `words` is empty). */
  createVault: (parent: string, name: string, password: string | null, encrypt = true) =>
    call<{ session: SessionInfo; words: string[] }>('create_vault', { parent, name, password, encrypt }),
  /** Remove the encryption (the current password is checked first, when there is one). Runs in the background. */
  encryptionOff: (current: string | null) => call<SessionInfo>('encryption_off', { current }),
  /** Encrypt a vault without encryption, with this password or none. Returns the new recovery key. */
  encryptionOn: (password: string | null) => call<{ session: SessionInfo; words: string[] }>('encryption_on', { password }),
  /** Carry on with a paused or interrupted change (false: nothing to carry on with). */
  encryptionContinue: () => call<boolean>('encryption_continue'),
  encryptionStop: () => call<void>('encryption_stop'),
  encryptionRunning: () => call<boolean>('encryption_running'),
  /** Open a vault-without-encryption's Files folder in Explorer. */
  openFilesFolder: () => call<void>('open_files_folder'),
  /** Open a vault that has no password. */
  openVault: (path: string) => call<SessionInfo>('open_vault', { path }).then(keepLogin),
  /** Remove the password (the current one is checked first). */
  turnPasswordOff: (current: string) => call<SessionInfo>('turn_password_off', { current }),
  /** Give a vault without a password one. */
  setPassword: (password: string) => call<SessionInfo>('set_password', { password }),
  unlock: (path: string, password: string) => call<SessionInfo>('unlock', { path, password }).then(keepLogin),
  unlockWithRecovery: (path: string, words: string) => call<SessionInfo>('unlock_with_recovery', { path, words }).then(keepLogin),
  setNewPassword: (password: string) => call<SessionInfo>('set_new_password', { password }),
  changePassword: (current: string, password: string) => call<void>('change_password', { current, password }),
  resetRecovery: (current: string) => call<string[]>('reset_recovery', { current }),
  lock: () => call<void>('lock_vault'),
  reportActivity: (kind: 'input' | 'playing') => call<void>('report_activity', { kind }),

  // library
  folders: () => call<FolderCard[]>('library_folders'),
  /** Folders, tags and (with a filter) items in one call; `focusHere` also
   *  points background work at these items first. */
  libraryPage: (filter: ItemFilter | null, focusHere = false) =>
    call<{ folders: FolderCard[]; tags: TagCount[]; items: Item[] | null }>('library_page', { filter, focusHere }),
  folderView: (folder: number | null) => call<FolderView>('folder_view', { folder }),
  queryItems: (filter: ItemFilter) => call<Item[]>('query_items', { filter }),
  getItem: (id: number) => call<Item>('get_item', { id }),
  createFolder: (parent: number | null, name: string) => call<number>('create_folder', { parent, name }),
  renameFolder: (id: number, name: string) => call<void>('rename_folder', { id, name }),
  /** All or nothing; folders can swap names. */
  renameMany: (folders: [number, string][], items: [number, string][]) => call<void>('rename_many', { folders, items }),
  moveFolder: (id: number, parent: number | null) => call<void>('move_folder', { id, parent }),
  /** Several folders at once (each to its own parent), one save. Stops at the
   *  first that can't move: `done` before it moved, `error` says why. */
  moveFolders: async (moves: [number, number | null][]) => {
    if (!moves.length) return { done: 0, error: null as string | null };
    const r = await call<{ done: number; error: string | null }>('move_folders', { moves });
    return { done: Math.min(r.done, moves.length), error: r.error };
  },
  /** Moves to the trash. */
  deleteFolder: (id: number) => call<number>('delete_folder', { id }),
  /** Several folders to the trash in one go. */
  deleteFolders: (ids: number[]) => (ids.length ? call<number>('delete_folders', { ids }) : Promise.resolve(0)),
  /** Moves to the trash. */
  deleteItems: (ids: number[]) => call<number>('delete_items', { ids }),
  restoreItems: (ids: number[]) => call<number>('restore_items', { ids }),
  restoreFolder: (id: number) => call<void>('restore_folder', { id }),
  restoreFolders: (ids: number[]) => (ids.length ? call<void>('restore_folders', { ids }) : Promise.resolve()),
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
  /** Per person folder: the ids of the items showing them (one call for all of them). */
  personItemIds: (people: number[]) => call<[number, number[]][]>('person_item_ids', { people }),
  /** What is on screen (the open folder, null = top level; the items shown): background work does these first. */
  setFocus: (focus: { folder: number | null; inFolder: boolean; ids: number[] } | null) => call<void>('set_focus', { focus }),
  bookmarks: (media: number) => call<Bookmark[]>('bookmarks', { media }),
  addBookmark: (media: number, positionMs: number, note: string) => call<number>('add_bookmark', { media, positionMs, note }),
  updateBookmark: (id: number, positionMs: number, note: string) => call<void>('update_bookmark', { id, positionMs, note }),
  deleteBookmark: (id: number) => call<void>('delete_bookmark', { id }),
  /** Save a file made in the app (frame, GIF) into a folder; returns the new item id. */
  addFileBytes: (folder: number | null, name: string, data: Uint8Array) =>
    callRaw<number>('add_file_bytes', { folder, name }, data),
  /** Save a picture made from item `from` (the picture editor's copy) next to it, with its date and tags. */
  addCopyBytes: (from: number, name: string, data: Uint8Array, width: number, height: number) =>
    callRaw<SavedCopy>('add_copy_bytes', { from, name, width, height }, data),
  moveItems: (ids: number[], folder: number | null) => call<number>('move_items', { ids, folder }),
  setFavourite: (ids: number[], on: boolean) => call<void>('set_favourite', { ids, on }),
  setWeight: (ids: number[], weight: number) => call<void>('set_weight', { ids, weight }),
  setCover: (folder: number, media: number | null) => call<void>('set_cover', { folder, media }),
  // cover framing: media = the cover it was made for (becomes the chosen cover); pos null = automatic again
  setCoverFrame: (folder: number, media: number | null, pos: CoverPos | null) => call<void>('set_cover_frame', { folder, media, pos }),
  // folder banners (banner.rs): media null removes it; y = where to look, 0 top … 1 bottom
  folderBanner: (folder: number) => call<FolderBanner | null>('folder_banner', { folder }),
  setBanner: (folder: number, media: number | null, y?: number) => call<void>('set_banner', { folder, media, y: y ?? null }),
  // faces river (riverfaces.rs): known faces of these people (empty = everyone), no hidden ones, no videos
  riverFaces: (people: number[]) => call<RiverFace[]>('river_faces', { people }),
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
  saveThumb: (id: number, data: Bytes, width: number | null, height: number | null, durationMs: number | null, sharper = false) =>
    callRaw<void>('save_thumb', { id, width, height, durationMs, sharper }, data),
  /** Older, smaller thumbnails still to remake sharper (ids after..upto). */
  thumbsToSharpen: (after: number, upto: number, limit: number) => call<{ id: number; kind: Kind }[]>('thumbs_to_sharpen', { after, upto, limit }),
  newestItemId: () => call<number>('newest_item_id'),
  /** Older JPEG thumbnails to make again as WebP; `next` = looked at everything up to this id. */
  thumbsToWebp: (after: number, upto: number, limit: number) => call<{ tasks: { id: number; kind: Kind }[]; next: number }>('thumbs_to_webp', { after, upto, limit }),
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
  previewsNeeded: (limit: number, prefer: number[]) =>
    call<{ id: number; durationMs: number | null; needStrip: boolean; needTiny: boolean }[]>('previews_needed', { limit, prefer }),
  savePreview: (id: number, data: Bytes) => callRaw<void>('save_preview', { id }, data),
  previewFailed: (id: number) => call<void>('preview_failed', { id }),
  /** A tiny preview video made by the window (WebM or MP4 bytes). */
  saveTiny: (id: number, data: Bytes) => callRaw<void>('save_tiny', { id }, data),
  tinyFailed: (id: number) => call<void>('tiny_failed', { id }),
  /** Make the tiny clip with the video tool; false = no video tool installed. */
  makeTinyWithTool: (id: number, starts: number[], piece: number) => call<boolean>('make_tiny_with_tool', { id, starts, piece }),

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
  /** model 1 = InsightFace (512 numbers; the faces pack). */
  facesSave: (media: number, faces: FaceIn[], model = 1) => call<number>('faces_save', { media, faces, model }),
  facesFailed: (media: number, model = 1) => call<void>('faces_failed', { media, model }),
  facesStatus: () => call<ScanStatus>('faces_status'),
  facesReview: (request?: ReviewRequest) => call<FaceReview>('faces_review', { request: request ?? null }),
  /** Names sure faces automatically; returns how many changed. */
  facesAuto: () => call<number>('faces_auto'),
  facesEngine: () => call<FaceEngineStatus>('faces_engine'),
  /** Scan everything again with the new model (once). */
  facesUpgrade: () => call<number>('faces_upgrade'),
  /** Faces in one picture (RGBA), found natively; throws when the faces pack isn't there. */
  facesDetect: (request: { width: number; height: number; frameMs: number }, rgba: Uint8Array) => facesDetect(request, rgba),
  /** The upscaler: the five face points (eyes, nose tip, mouth corners) of each face, in picture pixels (needs the faces pack). */
  facesPoints: (request: { width: number; height: number }, rgba: Uint8Array) => facesPoints(request, rgba),
  // a person's faces cut out (facecrops.rs)
  faceCropsList: (person: number) => call<PersonFace[]>('face_crops_list', { person }),
  /** Measures faces (remembered for the session); progress comes as "face-measure-progress" { job, done, total }. */
  faceCropsMeasure: (job: string, ids: number[]) => call<FaceMeasure[]>('face_crops_measure', { job, ids }),
  faceCropsStop: (job: string) => call<void>('face_crops_stop', { job }),
  facesFindOwner: (person: number) => call<OwnerProposal | null>('faces_find_owner', { person }),
  facesHide: (faceIds: number[], hidden: boolean) => call<number>('faces_hide', { faceIds, hidden }),
  facesMergePeople: (keep: number, other: number) => call<number>('faces_merge_people', { keep, other }),
  facesNotSame: (a: number, b: number) => call<void>('faces_not_same', { a, b }),
  /** After an import (seconds): queues the new pictures for scanning; returns them. */
  facesAfterImport: (since: number) => call<number[]>('faces_after_import', { since }),
  facesSortOffers: (ids: number[]) => call<SortOffers>('faces_sort_offers', { ids }),
  /** Every recognised person with the photos of them that aren't in their folder yet. */
  /** Every person and their photos outside their folder; or only these items / one folder (with subfolders). */
  facesSortAll: (scope?: { ids?: number[]; folder?: number }) => call<SortOffers>('faces_sort_all', { ids: scope?.ids ?? null, folder: scope?.folder ?? null }),
  facesAccept: (faceIds: number[], person: number) => call<{ named?: number; moved: number; tagged: number }>('faces_accept', { faceIds, person }),
  facesReject: (faceIds: number[], person: number) => call<void>('faces_reject', { faceIds, person }),
  facesNewPerson: (name: string, parent: number | null, faceIds: number[]) =>
    call<{ folder: number; accepted: { moved: number; tagged: number } }>('faces_new_person', { name, parent, faceIds }),
  /** `hidden`: the "not important" faces too (marked with `hidden`). */
  facesOf: (media: number, hidden = false) => call<FaceBox[]>('faces_of', { media, hidden }),
  /** "Reset and re-scan": forget every face in these items and look again. */
  facesReset: (media: number[]) => call<number>('faces_reset', { media }),
  /** "Who is it?": [person folder, how likely 0–99], most likely first. */
  facesMatches: (face: number) => call<[number, number][]>('faces_matches', { face }),
  facesOfMany: (media: number[]) => call<[number, FaceBox[]][]>('faces_of_many', { media }),
  setResume: (id: number, ms: number | null) => call<void>('set_resume', { id, ms }),
  facesUnsure: (person: number) => call<Item[]>('faces_unsure', { person }),

  // smart search
  clipNeeded: (limit: number) => call<{ id: number; kind: Kind; preview: boolean }[]>('clip_needed', { limit }),
  /** The vectors go as raw little-endian 32-bit floats. */
  clipSave: (media: number, vec: Float32Array | number[]) =>
    callRaw<void>('clip_save', { media }, new Uint8Array(Float32Array.from(vec).buffer)),
  clipFailed: (media: number) => call<void>('clip_failed', { media }),
  clipStatus: () => call<ClipStatus>('clip_status'),
  /** Where pictures are analysed for smart search (Settings). */
  smartEngine: () => call<SmartEngine>('smart_engine'),
  // the native analysis pass: thumbnails, fingerprints, smart search and faces from one decode
  analyseStart: (options: { smart: boolean; facesPaused: boolean }) => call<AnalyseStatus>('analyse_start', { options }),
  analyseStatus: () => call<AnalyseStatus>('analyse_status'),
  analyseKick: () => call<void>('analyse_kick'),
  /** Remake one thumbnail natively; false when the window has to. */
  analyseThumb: (id: number) => call<boolean>('analyse_thumb', { id }),
  /** The self-test: the whole pass now for these items. */
  analyseNow: (ids: number[], smart: boolean) => call<AnalyseReport[]>('analyse_now', { ids, smart }),
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
  /** Part of a video saved as a new MP4 next to it (with its sound). Runs in the background: 'cut-progress' events, then 'cut-done'. */
  cutStart: (request: CutRequest) => call<void>('cut_start', { request }),
  // beat detection from the computer's own sound (Windows; nothing is recorded)
  /** True where listening to the computer's sound can work (Windows). */
  beatsSupported: () => call<boolean>('beats_supported'),
  /** Start listening; "beat" and "beat-level" events follow. Safe to call twice. */
  beatsStart: () => call<void>('beats_start'),
  beatsStop: () => call<void>('beats_stop'),
  /** What the listener is doing (device, errors, recent log); "beat-status" events follow changes. */
  beatsStatus: () => call<BeatStatus>('beats_status'),

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
  // 3D photos: depth maps for gentle parallax in slideshows (Rust: depth.rs; window side: depth.ts, components/Depth3D.tsx)
  /** What 3D photos will use for this choice (model '' = the best installed). */
  depthInfo: (model = '', detail: DepthDetail = 'standard') => call<DepthInfo>('depth_info', { model, detail }),
  /** Every depth model, installed or not (Settings → 3D photos). */
  depthModels: () => call<DepthModel[]>('depth_models'),
  /** Settings → 3D photos → Test speed. */
  depthBenchmark: (id: string, detail: DepthDetail) => call<DepthBenchmark>('depth_benchmark', { id, detail }),
  /** Sends the picture's pixels (DepthInfo.inputSide square); the depth map comes back. */
  depthEstimate: (request: DepthRequest, rgba: Uint8Array) => depthEstimate(request, rgba),
  /** The viewer closed: free the model's memory. */
  depthForget: () => call<void>('depth_forget'),
  // Subject effects (Lift-off and friends): a subject outline per picture (Rust: subject.rs; window side: subject.ts, components/Depth3D.tsx)
  /** What the subject effects will use for this choice (model '' = the best installed). */
  subjectInfo: (model = '') => call<SubjectInfo>('subject_info', { model }),
  /** Every subject outline model, installed or not. */
  subjectModels: () => call<SubjectModel[]>('subject_models'),
  /** Test speed for one subject outline model. */
  subjectBenchmark: (id: string) => call<SubjectBenchmark>('subject_benchmark', { id }),
  /** Sends the picture's pixels (SubjectInfo.inputSide square); the subject outline comes back (255 = subject). */
  subjectEstimate: (request: SubjectRequest, rgba: Uint8Array) => subjectEstimate(request, rgba),
  /** Free the subject model's memory. */
  subjectForget: () => call<void>('subject_forget'),
  // Layered 3D: filling in the background behind the subject (Rust: inpaint.rs; window side: inpaint.ts, plate.ts)
  /** Every background fill model (MI-GAN, LaMa), installed or not. */
  inpaintModels: () => call<InpaintModel[]>('inpaint_models'),
  /** What the background fill will use for this choice. */
  inpaintInfo: (model = '') => call<InpaintInfo>('inpaint_info', { model }),
  /** Sends a square picture (InpaintInfo.inputSide) and its mask (255 = fill this in); the filled picture comes back. */
  inpaintEstimate: (request: InpaintRequest, rgba: Uint8Array, mask: Uint8Array) => inpaintEstimate(request, rgba, mask),
  inpaintBenchmark: (id: string) => call<InpaintBenchmark>('inpaint_benchmark', { id }),
  inpaintForget: () => call<void>('inpaint_forget'),
  // Saved depth maps and outlines (pictures only; kept in the vault, encrypted)
  /** A saved depth map or outline of an item (exactly what depth_estimate / subject_estimate sent back), or null when none is saved. */
  derivedGet: (item: number, kind: DerivedKind, model: string) => derivedGet(item, kind, model),
  /** Saves a depth map or outline (the bytes as depth_estimate / subject_estimate sent them back). */
  derivedPut: (item: number, kind: DerivedKind, model: string, bytes: Uint8Array) => callRaw<void>('derived_put', { item, kind, model }, bytes),
  /** Forgets the saved ones (of one kind, or all); how many were removed. */
  derivedClear: (kind?: DerivedKind) => call<number>('derived_clear', kind ? { kind } : {}),
  derivedStats: () => call<DerivedStats>('derived_stats'),
  /** Items that already have a saved map of this kind for this model. */
  derivedHave: (kind: DerivedKind, model: string) => call<number[]>('derived_have', { kind, model }),
  /** These pictures sorted by what the face scan found. */
  facesSplit: (items: number[]) => call<FaceSplit>('faces_split', { items }),
  /** What is saved for these items, per kind and model. */
  derivedSummary: (items: number[]) => call<DerivedGroup[]>('derived_summary', { items }),
  /** Remove these items' maps of these kinds and models; how many went. */
  derivedRemove: (items: number[], which: [DerivedKind, string][]) => call<number>('derived_remove', { items, which }),

  // saving a rotation from the viewer (rotate.rs); `quarter` = clockwise quarter turns
  /** A JPEG, losslessly (its EXIF orientation). */
  rotatePicture: (item: number, quarter: number) => call<Turned>('rotate_picture', { item, quarter }),
  /** PNG, WebP or GIF turned by the window: replaces the stored file. */
  rotateReplace: (request: { itemId: number; quarter: number; lossless: boolean }, file: Uint8Array) => rotateReplace(request, file),
  /** A video: only its rotation changes (needs the video tool). */
  rotateVideo: (item: number, quarter: number) => call<Turned>('rotate_video', { item, quarter }),
  /** Ctrl+Z: the file from before comes back. */
  rotateUndo: (turned: Turned) => call<void>('rotate_undo', { turned }),
};

/** What "Save rotation" changed (handed back to undo it). */
export interface Turned {
  item: number;
  quarter: number;
  /** Free copies that share the file and turned too. */
  copies: number;
  /** Nothing was re-encoded. */
  lossless: boolean;
  oldObject: string;
  newObject: string;
  oldThumb: string | null;
  oldPreview: string | null;
  oldSize: number;
  oldSha: string;
  oldWidth: number | null;
  oldHeight: number | null;
  width: number | null;
  height: number | null;
}

async function rotateReplace(request: { itemId: number; quarter: number; lossless: boolean }, file: Uint8Array): Promise<Turned> {
  if (!inTauri) return mock.call('rotate_replace', { request }) as Promise<Turned>;
  try {
    return await invoke<Turned>('rotate_replace', upscaleBody(request as unknown as UpscaleRequest, file));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

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
export type VideoTask = 'convert' | 'animation' | 'cut';

export interface CutRequest {
  item: number;
  /** Seconds into the video. */
  start: number;
  end: number;
  /** Re-encoded, on the exact frames (otherwise copied as it is, from the keyframe before the start). */
  exact: boolean;
  name: string;
}

/** Payload of 'cut-done'. */
export interface CutDone {
  id: number | null;
  name: string;
  /** An identical item was already there and is used (nothing new to undo). */
  reused: boolean;
  cancelled: boolean;
  error: string | null;
}

/** What add_copy_bytes saved. */
export interface SavedCopy {
  id: number;
  /** An identical item was already there and is used (nothing new to undo). */
  reused: boolean;
}

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

/** What the beat listener is doing (beats_status, and the "beat-status" event). */
export interface BeatStatus {
  state: 'off' | 'starting' | 'listening' | 'error';
  /** The sound output being listened to, e.g. "Speakers (Realtek(R) Audio)". */
  device: string | null;
  /** e.g. "48 kHz · stereo · 32-bit float". */
  format: string | null;
  error: string | null;
  /** Sound arrived in the last second (Windows sends nothing while all is quiet). */
  receiving: boolean;
  /** Windows volume of that output, 0..1. */
  volume: number | null;
  muted: boolean;
  /** The last few things that happened, oldest first. */
  log: string[];
}

export type SimilarLevel = 'strict' | 'normal' | 'loose';

const mockListeners = new Map<string, Set<(p: unknown) => void>>();

export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) {
    // Browser preview: events sent by the mock.
    const set = mockListeners.get(name) ?? new Set();
    mockListeners.set(name, set);
    const f = cb as (p: unknown) => void;
    set.add(f);
    return Promise.resolve(() => {
      set.delete(f);
    });
  }
  return listen<T>(name, (e) => {
    noteEvent(name);
    cb(e.payload);
  });
}

/** Browser preview: send an event to the window. */
function mockEmit(name: string, payload: unknown) {
  noteEvent(name);
  mockListeners.get(name)?.forEach((f) => f(payload));
}

const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

/** URL for a custom protocol path (Windows uses http://<scheme>.localhost). */
function proto(scheme: string, path: string): string {
  return isWindows ? `http://${scheme}.localhost/${path}` : `${scheme}://localhost/${path}`;
}

export const mediaUrl = (id: number) => proto('vault', `media/${id}`);
/**
 * An item's thumbnail. `v` (the item's `thumbV`, or a counter) makes the
 * address change when the thumbnail is remade, so no old copy is shown;
 * `small` asks for the 256 px one (made per folder in the background; the
 * big one comes until it is there).
 */
export const thumbUrl = (id: number, v?: string | number | null, small = false) => {
  const q = [v != null && v !== '' ? `v=${v}` : '', small ? 'small=1' : ''].filter(Boolean).join('&');
  return proto('vault', `thumb/${id}${q ? `?${q}` : ''}`);
};
/** An item's thumbnail address, versioned (see `thumbUrl`). */
export const itemThumbUrl = (it: { id: number; thumbV?: string | null }, small = false) => thumbUrl(it.id, it.thumbV, small);
/** Longest side of small thumbnails (thumbpages.rs). */
export const SMALL_THUMB = 256;
/**
 * Is the small thumbnail sharp enough for a tile `w` × `h` (CSS px) showing
 * a picture of `pw` × `ph` cropped to fill it (`cover`) or whole (`contain`)?
 * Counts the screen's pixel density; a little upscaling (10%) is allowed.
 */
export function smallEnough(w: number, h: number, pw: number | null | undefined, ph: number | null | undefined, fit: 'cover' | 'contain' = 'cover', dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1): boolean {
  if (!pw || !ph || w <= 0 || h <= 0) return false;
  const s = fit === 'cover' ? Math.max(w / pw, h / ph) : Math.min(w / pw, h / ph);
  // The picture's longest side as drawn, in device pixels.
  const need = s * Math.max(pw, ph) * dpr;
  return need <= SMALL_THUMB * 1.1;
}
export const previewUrl = (id: number) => proto('vault', `preview/${id}`);
export const tinyUrl = (id: number) => proto('vault', `tiny/${id}`);
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
  const t0 = performance.now();
  try {
    if (!inTauri) return (await mock.call(cmd, args ?? {})) as T;
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw e instanceof Error ? e : new Error(typeof e === 'string' ? e : String(e));
  } finally {
    noteCall(cmd, performance.now() - t0);
  }
}

/** Bytes for the backend (a plain number array still works, but costs a copy). */
export type Bytes = Uint8Array | ArrayLike<number>;

/**
 * A request carrying bytes, as one raw body instead of JSON (where every
 * byte would become a number in text): 4 bytes JSON length (little-endian),
 * the other arguments as JSON, then the bytes.
 */
export function rawBody(args: Record<string, unknown>, data: Bytes): Uint8Array {
  const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const json = new TextEncoder().encode(JSON.stringify(args));
  const body = new Uint8Array(4 + json.length + bytes.length);
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  body.set(bytes, 4 + json.length);
  return body;
}

async function callRaw<T>(cmd: string, args: Record<string, unknown>, data: Bytes): Promise<T> {
  const t0 = performance.now();
  try {
    if (!inTauri) return (await mock.call(cmd, { ...args, data })) as T;
    return await invoke<T>(cmd, rawBody(args, data));
  } catch (e) {
    throw e instanceof Error ? e : new Error(typeof e === 'string' ? e : String(e));
  } finally {
    noteCall(cmd, performance.now() - t0);
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
      previewQuality: 'auto',
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
      { path: 'D:\\Vaults\\Photos', name: 'Photos', status: 'ready', sizeBytes: 8.2e9, passwordless: false },
      { path: 'D:\\Vaults\\Archive', name: 'Archive', status: 'ready', sizeBytes: 1.01e11, passwordless: true },
      { path: 'F:\\Vault backup', name: 'Vault backup', status: 'missing', sizeBytes: null, passwordless: false },
    ],
    session: null,
    minPasswordChars: 8,
  } as AppState,
  pickFolder: async () => 'D:\\Vaults',
  async call(cmd: string, a: Record<string, unknown>): Promise<unknown> {
    // The batched commands, made of the single ones the previews answer.
    if (cmd === 'library_page') {
      const [folders, tags, items] = await Promise.all([
        this.call('library_folders', {}),
        this.call('all_tags', {}),
        a.filter ? this.call('query_items', { filter: a.filter }) : Promise.resolve(null),
      ]);
      return { folders: folders ?? [], tags: tags ?? [], items };
    }
    if (cmd === 'add_copy_bytes') return { id: 90_000 + Math.floor(Math.random() * 1000), reused: false };
    if (cmd === 'move_folders') {
      for (const [id, parent] of a.moves as [number, number | null][]) await this.call('move_folder', { id, parent });
      return { done: (a.moves as unknown[]).length, error: null };
    }
    if (cmd === 'delete_folders' || cmd === 'restore_folders') {
      let n = 0;
      for (const id of a.ids as number[]) n += Number((await this.call(cmd.slice(0, -1), { id })) ?? 0);
      return n;
    }
    await new Promise((r) => setTimeout(r, cmd.startsWith('unlock') || cmd === 'create_vault' ? 600 : 50));
    // Preview with sample folders, people and tags: open the page with ?demo.
    if (typeof location !== 'undefined' && /[?&]demo\b/.test(location.search)) {
      const { demoCall, NOT_DEMO } = await import('./mockdemo');
      const d = demoCall(cmd, a);
      if (d !== NOT_DEMO) return d;
    }
    const demo = (await import('./mockgrid')).demoAnswer(cmd, a);
    if (demo !== undefined) return demo;
    // Face recognition with made-up people (People page, Settings).
    const faces = (await import('./mockfaces')).facesAnswer(cmd, a);
    if (faces !== undefined) return faces;
    // A person's faces cut out (face wall, Best faces, time-lapse).
    const crops = await (await import('./mockfacecrops')).cropsAnswer(cmd, a, (person) => this.call('query_items', { filter: { people: [person] } }) as Promise<Item[]>);
    if (crops !== undefined) return crops;
    const s = this.state;
    const passwordless = (path: string) => !!s.vaults.find((v) => v.path === path)?.passwordless;
    const session = (path: string, needsNewPassword = false): SessionInfo => ({
      path,
      name: path.split('\\').pop() ?? path,
      items: 0,
      folders: 0,
      needsNewPassword,
      hasPassword: !passwordless(path),
      encrypted: s.vaults.find((v) => v.path === path)?.encrypted !== false,
      converting: null,
      restoredFromBackup: null,
    });
    const setPasswordless = (on: boolean) => {
      const v = s.vaults.find((x) => x.path === s.session?.path);
      if (v) v.passwordless = on;
      s.session = { ...s.session!, hasPassword: !on };
      return s.session;
    };
    switch (cmd) {
      case 'get_state':
        return structuredClone(s);
      case 'save_config':
        s.config = { ...(a.config as AppConfig), vaults: s.config.vaults, lastVault: s.config.lastVault };
        return s.config;
      case 'unlock':
        if (a.password !== 'password') throw new Error("That password doesn't match this vault. (Preview: use “password”.)");
        return (s.session = session(a.path as string));
      case 'open_vault':
        if (!passwordless(a.path as string)) throw new Error('This vault has a password.');
        return (s.session = session(a.path as string));
      case 'turn_password_off':
        if (a.current !== 'password') throw new Error('Your current password is not correct. (Preview: use “password”.)');
        return setPasswordless(true);
      case 'set_password':
        return setPasswordless(false);
      case 'unlock_with_recovery':
        return (s.session = session(a.path as string, !passwordless(a.path as string)));
      case 'set_new_password':
        s.session = { ...s.session!, needsNewPassword: false };
        return s.session;
      case 'create_vault': {
        const path = `${a.parent}\\${a.name}`;
        const plain = a.encrypt === false;
        s.vaults.push({ path, name: a.name as string, status: 'ready', sizeBytes: 4096, passwordless: plain || a.password == null, encrypted: !plain });
        return { session: (s.session = session(path)), words: plain ? [] : WORDS };
      }
      case 'encryption_off':
      case 'encryption_on': {
        const to = cmd === 'encryption_off' ? 'plain' : 'encrypted';
        if (to === 'plain' && s.session?.hasPassword && a.current !== 'password') throw new Error('Your current password is not correct. (Preview: use “password”.)');
        const v = s.vaults.find((x) => x.path === s.session?.path);
        s.session = { ...s.session!, converting: to };
        // Preview: about three seconds of progress.
        let done = 0;
        const t = setInterval(() => {
          done += 7;
          mockEmit('encryption-progress', { to, done: Math.min(done, 40), total: 40 });
          if (done >= 40) {
            clearInterval(t);
            if (v) {
              v.encrypted = to === 'encrypted';
              v.passwordless = to === 'plain' || a.password == null;
            }
            s.session = { ...s.session!, converting: null, encrypted: to === 'encrypted', hasPassword: to === 'encrypted' && a.password != null };
            mockEmit('encryption-done', { to, ok: true, stopped: false, message: to === 'plain' ? 'The vault isn’t encrypted any more: your files are ordinary files in its Files folder.' : 'The vault is encrypted now.' });
          }
        }, 500);
        return to === 'plain' ? s.session : { session: s.session, words: WORDS };
      }
      case 'encryption_continue':
        return false;
      case 'encryption_stop':
        return;
      case 'encryption_running':
        return false;
      case 'open_files_folder':
        return;
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
        // Preview: add ?beatdemo to the address to see the beat sync controls.
        return typeof location !== 'undefined' && new URLSearchParams(location.search).has('beatdemo');
      case 'beats_status':
        return { state: 'listening', device: 'Speakers (Preview Audio)', format: '48 kHz · stereo · 32-bit float', error: null, receiving: true, volume: 0.62, muted: false, log: ['Listening to Speakers (Preview Audio) (48 kHz · stereo · 32-bit float)', 'Sound is coming in'] } satisfies BeatStatus;
      case 'upscale_info':
        return { available: true, problem: null, folder: 'C:\\MediaVault\\tools\\upscaler', device: 'gpu', deviceKnown: false } satisfies UpscalerInfo;
      case 'upscale_start':
        return mockUpscale(a.request as UpscaleRequest);
      case 'depth_info':
        return mockDepthInfo(String(a.model ?? ''), a.detail === 'high' ? 'high' : 'standard');
      case 'depth_models':
        return mockDepthModels();
      case 'depth_benchmark': {
        // Preview: a pretend speed test (Best is slowest, high detail about twice as slow).
        await new Promise((r) => setTimeout(r, 900));
        const base = a.id === 'da3-mono-large' ? 310 : a.id === 'da3-base' ? 120 : 45;
        const dyn = a.id !== 'v2-small';
        return { ms: base * (dyn && a.detail === 'high' ? 2.1 : 1), device: 'gpu', loadMs: 800, side: dyn && a.detail === 'high' ? 756 : 518 } satisfies DepthBenchmark;
      }
      case 'depth_forget':
        return;
      case 'subject_info':
        return mockSubjectInfo(String(a.model ?? ''));
      case 'subject_models':
        return mockSubjectModels();
      case 'subject_benchmark': {
        // Preview: a pretend speed test (Best is slower).
        await new Promise((r) => setTimeout(r, 900));
        return { ms: a.id === 'birefnet' ? 420 : 140, device: 'gpu', loadMs: 900, side: 1024 } satisfies SubjectBenchmark;
      }
      case 'subject_forget':
        return;
      case 'inpaint_models':
        return mockInpaintModels();
      case 'inpaint_info':
        return mockInpaintInfo(String(a.model ?? ''));
      case 'inpaint_benchmark':
        await new Promise((r) => setTimeout(r, 900));
        return { ms: a.id === 'lama' ? 260 : 60, device: 'gpu', loadMs: 600, side: 512 } satisfies InpaintBenchmark;
      case 'inpaint_forget':
        return;
      case 'derived_put': {
        const b = a.data as Uint8Array;
        mockDerived.set(`${a.item}|${a.kind}|${a.model}`, b.slice());
        return;
      }
      case 'derived_get':
        return mockDerived.get(`${a.item}|${a.kind}|${a.model}`) ?? new Uint8Array(0);
      case 'derived_clear': {
        let n = 0;
        for (const k of [...mockDerived.keys()]) if (!a.kind || k.split('|')[1] === a.kind) {
          mockDerived.delete(k);
          n++;
        }
        return n;
      }
      case 'derived_have': {
        const out: number[] = [];
        for (const k of mockDerived.keys()) {
          const [item, kind, model] = k.split('|');
          if (kind === a.kind && model === a.model) out.push(Number(item));
        }
        return out;
      }
      case 'faces_split': {
        // Demo: every third picture has faces, every third has none, a few only poor ones, the rest unscanned.
        const sp: FaceSplit = { withFaces: [], noFaces: [], onlyPoor: [], unscanned: [] };
        for (const id of (a.items as number[]) ?? []) {
          const r = id % 6;
          (r < 2 ? sp.withFaces : r < 4 ? sp.noFaces : r === 4 ? sp.onlyPoor : sp.unscanned).push(id);
        }
        return sp;
      }
      case 'derived_summary': {
        const want = new Set((a.items as number[]) ?? []);
        const acc = new Map<string, DerivedGroup>();
        for (const [k, v] of mockDerived) {
          const [item, kind, model] = k.split('|');
          if (!want.has(Number(item))) continue;
          const g = acc.get(`${kind}|${model}`) ?? { kind: kind as DerivedKind, model, count: 0, bytes: 0 };
          g.count++;
          g.bytes += v.length;
          acc.set(`${kind}|${model}`, g);
        }
        return [...acc.values()].sort((x, y) => (x.kind === y.kind ? x.model.localeCompare(y.model) : x.kind === 'depth' ? -1 : 1));
      }
      case 'derived_remove': {
        const want = new Set((a.items as number[]) ?? []);
        const which = new Set(((a.which as [string, string][]) ?? []).map(([k, m]) => `${k}|${m}`));
        let n = 0;
        for (const k of [...mockDerived.keys()]) {
          const [item, kind, model] = k.split('|');
          if (want.has(Number(item)) && which.has(`${kind}|${model}`)) {
            mockDerived.delete(k);
            n++;
          }
        }
        return n;
      }
      case 'derived_stats': {
        const st: DerivedStats = { depthCount: 0, depthBytes: 0, outlineCount: 0, outlineBytes: 0 };
        for (const [k, v] of mockDerived) {
          if (k.split('|')[1] === 'depth') {
            st.depthCount++;
            st.depthBytes += v.length;
          } else {
            st.outlineCount++;
            st.outlineBytes += v.length;
          }
        }
        return st;
      }
      case 'upscale_cancel':
        mockJob += 1;
        return;
      case 'upscale_save':
        return { id: 999, name: 'Picture (upscaled).jpg' } satisfies UpscaleSaved;
      case 'rotate_picture':
      case 'rotate_replace':
      case 'rotate_video':
        throw new Error('Preview: saving the rotation works in the real app.');
      case 'rotate_undo':
        return;
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
      case 'similar_needed':
      case 'faces_of':
      case 'river_faces':
      case 'smart_search':
        return [];
      case 'engine_info':
        return { mode: 'system', available: false, version: null };
      case 'faces_status':
        return { queued: 0, scanned: 0, faces: 0, failed: 0 };
      case 'faces_review':
        return { people: [], unknown: [], status: { queued: 0, scanned: 0, faces: 0, failed: 0 } };
      case 'make_tiny_with_tool':
        return false;
      case 'previews_needed':
      case 'thumbs_to_sharpen':
        return [];
      case 'thumbs_to_webp':
        return { tasks: [], next: Number(a.upto ?? 0) };
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
      case 'smart_engine':
        return { models: true, native: true, device: 'gpu', deviceKnown: false, problem: null } satisfies SmartEngine;
      case 'analyse_start':
      case 'analyse_status':
        return { running: false, busy: false, done: 0, thumbs: 0, prints: 0, smart: 0, faces: 0, left: 0, facesLeft: 0 } satisfies AnalyseStatus;
      case 'analyse_thumb':
        return false;
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

async function facesDetect(request: { width: number; height: number; frameMs: number }, rgba: Uint8Array): Promise<FaceIn[]> {
  if (!inTauri) throw new Error('Preview: native face recognition works in the real app.');
  try {
    return await invoke<FaceIn[]>('faces_detect', upscaleBody(request as unknown as UpscaleRequest, rgba));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

async function facesPoints(request: { width: number; height: number }, rgba: Uint8Array): Promise<[number, number][][]> {
  if (!inTauri) return [];
  try {
    return await invoke<[number, number][][]>('faces_points', upscaleBody({ ...request, frameMs: 0 } as unknown as UpscaleRequest, rgba));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

// ---- 3D photos (depth maps) ------------------------------------------------------------

export interface DepthInfo {
  available: boolean;
  /** Why not, in one sentence. */
  problem: string | null;
  folder: string | null;
  device: 'gpu' | 'cpu' | null;
  deviceKnown: boolean;
  /** ONNX Runtime comes from another pack. */
  sharedRuntime: boolean;
  /** The model in use: the chosen one, or the best installed when that isn't there. */
  model?: string | null;
  modelName?: string | null;
  /** Pictures are sent at this size (square). */
  inputSide?: number;
  /** The detail actually used ('standard' for fixed-size models). */
  detail?: DepthDetail;
  /** The model takes any size (so "High detail" applies). */
  dynamic?: boolean;
}

export type DepthDetail = 'standard' | 'high';

/** One depth model (Settings → 3D photos → Depth model). */
export interface DepthModel {
  id: string;
  name: string;
  model: string;
  /** Where the pack is, or where it goes. */
  folder: string | null;
  /** Its folder is there. */
  installed: boolean;
  /** Why it can't be used (null = ready). */
  problem: string | null;
  sizeBytes: number;
  /** Takes any size, so "High detail" applies. */
  dynamic: boolean;
  /** The download it comes in. */
  zip?: string | null;
  standardSide?: number;
  highSide?: number;
  licence?: string | null;
}

/** A speed test: average ms per picture (warm-up not counted), where it ran, and how long loading took. */
export interface DepthBenchmark {
  ms: number;
  device: 'gpu' | 'cpu';
  loadMs: number;
  side?: number;
}

export interface DepthRequest {
  width: number;
  height: number;
  /** The chosen model ('' = the best installed) and detail. */
  model?: string;
  detail?: DepthDetail;
  /** Edge softening (1 = as designed, smaller = sharper). */
  soft?: number;
}

/** Preview: Fast and Best installed (add ?nodepth to see none installed). */
function mockDepthModels(): DepthModel[] {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nodepth');
  const root = 'C:\\MediaVault\\tools\\';
  return [
    { id: 'v2-small', name: 'Fast', model: 'Depth Anything V2 Small', folder: `${root}depth`, installed: !none, problem: none ? 'Not installed: get MediaVault-depth-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 99_000_000, dynamic: false, zip: 'MediaVault-depth-windows.zip', standardSide: 518, highSide: 518, licence: 'Apache-2.0' },
    { id: 'v2-small-fp16', name: 'Fast (half precision)', model: 'Depth Anything V2 Small (fp16)', folder: `${root}depth-v2-small-fp16`, installed: !none, problem: none ? 'Not installed: get MediaVault-depth-v2-small-fp16-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 50_000_000, dynamic: false, zip: 'MediaVault-depth-v2-small-fp16-windows.zip', standardSide: 518, highSide: 518, licence: 'Apache-2.0' },
    { id: 'da3-mono-large', name: 'Best', model: 'Depth Anything 3 Mono Large', folder: `${root}depth-da3-mono-large`, installed: !none, problem: none ? 'Not installed: get MediaVault-depth-da3-mono-large-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 1_350_000_000, dynamic: false, zip: 'MediaVault-depth-da3-mono-large-windows.zip', standardSide: 518, highSide: 518, licence: 'Apache-2.0' },
  ];
}

function mockDepthInfo(model: string, detail: DepthDetail): DepthInfo {
  const ready = mockDepthModels().filter((m) => m.installed && !m.problem);
  const pick = ready.find((m) => m.id === model) ?? ['da3-mono-large', 'v2-small'].map((id) => ready.find((m) => m.id === id)).find(Boolean);
  if (!pick) return { available: false, problem: "The depth pack isn't installed.", folder: 'C:\\MediaVault\\tools\\depth', device: null, deviceKnown: false, sharedRuntime: false, model: null, modelName: null, inputSide: 518, detail: 'standard', dynamic: false };
  const d = pick.dynamic ? detail : 'standard';
  return { available: true, problem: null, folder: pick.folder, device: 'gpu', deviceKnown: false, sharedRuntime: false, model: pick.id, modelName: pick.name, inputSide: d === 'high' ? pick.highSide ?? 518 : pick.standardSide ?? 518, detail: d, dynamic: pick.dynamic };
}

/** A depth map: w × h bytes, 255 = nearest. It covers the whole picture (stretched to a square). */
export interface DepthMap {
  w: number;
  h: number;
  data: Uint8Array;
}

/** What depth_estimate sends back: width, height (u32 little-endian), then the bytes. */
export function parseDepth(buf: ArrayBuffer | Uint8Array): DepthMap {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 8) throw new Error('3D photos got something unexpected back.');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = v.getUint32(0, true);
  const h = v.getUint32(4, true);
  if (!w || !h || b.length !== 8 + w * h) throw new Error('3D photos got something unexpected back.');
  return { w, h, data: b.slice(8) };
}

/** (Timed for the timing panel: the 3D models share the graphics card with the window.) */
async function depthEstimate(request: DepthRequest, rgba: Uint8Array): Promise<DepthMap> {
  const t0 = performance.now();
  try {
    return await depthEstimateNow(request, rgba);
  } finally {
    noteCall('depth_estimate', performance.now() - t0);
  }
}
async function depthEstimateNow(request: DepthRequest, rgba: Uint8Array): Promise<DepthMap> {
  if (!inTauri) return mockDepth(request.width, request.height, rgba);
  try {
    return parseDepth(await invoke<ArrayBuffer>('depth_estimate', upscaleBody(request as unknown as UpscaleRequest, rgba)));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

/** Preview: a pretend depth map (nearer towards the bottom and the middle). Tests can supply real ones via `__mvDepthMock`. */
async function mockDepth(w: number, h: number, rgba: Uint8Array): Promise<DepthMap> {
  const hook = (globalThis as { __mvDepthMock?: (w: number, h: number, rgba: Uint8Array) => Promise<DepthMap | null> }).__mvDepthMock;
  const real = hook ? await hook(w, h, rgba) : null;
  if (real) return real;
  await new Promise((r) => setTimeout(r, 150));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = x / w - 0.5;
      const dy = y / h - 0.55;
      const blob = Math.max(0, 1 - Math.hypot(dx * 1.6, dy * 1.2) * 2.2);
      data[y * w + x] = Math.round(255 * Math.min(1, 0.15 + 0.45 * (y / h) + 0.5 * blob));
    }
  return { w, h, data };
}

// ---- subject effects (subject outlines) -------------------------------------------------

export interface SubjectInfo {
  available: boolean;
  /** Why not, in one sentence. */
  problem: string | null;
  folder: string | null;
  device: 'gpu' | 'cpu' | null;
  deviceKnown: boolean;
  /** The model in use: the chosen one, or the best installed when that isn't there. */
  model?: string | null;
  modelName?: string | null;
  /** Pictures are sent at this size (square). */
  inputSide?: number;
}

/** One subject outline model ('birefnet-lite' Fast, 'birefnet' Best). */
export interface SubjectModel {
  id: string;
  name: string;
  model: string;
  folder: string | null;
  installed: boolean;
  problem: string | null;
  sizeBytes: number;
  zip?: string | null;
  inputSide?: number;
  licence?: string | null;
}

export interface SubjectBenchmark {
  ms: number;
  device: 'gpu' | 'cpu';
  loadMs: number;
  side?: number;
}

export interface SubjectRequest {
  width: number;
  height: number;
  /** The chosen model ('' = the best installed). */
  model?: string;
}

/** A subject outline: w × h bytes, 255 = the subject. It covers the whole picture (stretched to a square). */
export type SubjectMask = DepthMap;

/** What subject_estimate sends back: width, height (u32 little-endian), then the mask bytes. */
export function parseSubject(buf: ArrayBuffer | Uint8Array): SubjectMask {
  try {
    return parseDepth(buf);
  } catch {
    throw new Error('The subject outline came back in an unexpected shape.');
  }
}

/** (Timed for the timing panel: the 3D models share the graphics card with the window.) */
async function subjectEstimate(request: SubjectRequest, rgba: Uint8Array): Promise<SubjectMask> {
  const t0 = performance.now();
  try {
    return await subjectEstimateNow(request, rgba);
  } finally {
    noteCall('subject_estimate', performance.now() - t0);
  }
}
async function subjectEstimateNow(request: SubjectRequest, rgba: Uint8Array): Promise<SubjectMask> {
  if (!inTauri) return mockSubject(request.width, request.height, rgba);
  try {
    return parseSubject(await invoke<ArrayBuffer>('subject_estimate', upscaleBody(request as unknown as UpscaleRequest, rgba)));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

/** Preview: Fast and Best installed (add ?nosubject to see none installed). */
function mockSubjectModels(): SubjectModel[] {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nosubject');
  const root = 'C:\\MediaVault\\tools\\';
  return [
    { id: 'birefnet-lite', name: 'Fast', model: 'BiRefNet Lite', folder: `${root}subject-birefnet-lite`, installed: !none, problem: none ? 'Not installed: get MediaVault-subject-birefnet-lite-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 180_000_000, zip: 'MediaVault-subject-birefnet-lite-windows.zip', inputSide: 1024, licence: 'MIT' },
    { id: 'birefnet', name: 'Best', model: 'BiRefNet', folder: `${root}subject-birefnet`, installed: !none, problem: none ? 'Not installed: get MediaVault-subject-birefnet-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 900_000_000, zip: 'MediaVault-subject-birefnet-windows.zip', inputSide: 1024, licence: 'MIT' },
  ];
}

function mockSubjectInfo(model: string): SubjectInfo {
  const ready = mockSubjectModels().filter((m) => m.installed && !m.problem);
  const pick = ready.find((m) => m.id === model) ?? ['birefnet', 'birefnet-lite'].map((id) => ready.find((m) => m.id === id)).find(Boolean);
  if (!pick) return { available: false, problem: "The subject pack isn't installed.", folder: 'C:\\MediaVault\\tools\\subject-birefnet', device: null, deviceKnown: false, model: null, modelName: null, inputSide: 1024 };
  return { available: true, problem: null, folder: pick.folder, device: 'gpu', deviceKnown: false, model: pick.id, modelName: pick.name, inputSide: pick.inputSide ?? 1024 };
}

/** Preview: a pretend subject outline (a soft-edged rounded shape in the middle). Tests can supply real ones via `__mvSubjectMock`. */
async function mockSubject(w: number, h: number, rgba: Uint8Array): Promise<SubjectMask> {
  const hook = (globalThis as { __mvSubjectMock?: (w: number, h: number, rgba: Uint8Array) => Promise<SubjectMask | null> }).__mvSubjectMock;
  const real = hook ? await hook(w, h, rgba) : null;
  if (real) return real;
  await new Promise((r) => setTimeout(r, 150));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // A head-and-shoulders shape: a body ellipse with a smaller head on top.
      const u = x / w - 0.5;
      const v = y / h;
      const body = Math.hypot(u / 0.26, (v - 0.82) / 0.32);
      const head = Math.hypot(u / 0.13, (v - 0.38) / 0.16);
      const d = Math.min(body, head);
      data[y * w + x] = Math.round(255 * Math.min(1, Math.max(0, (1 - d) * 25)));
    }
  return { w, h, data };
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

// ---- Layered 3D: filling in the background behind the subject --------------------------------

export interface InpaintInfo {
  available: boolean;
  problem: string | null;
  folder: string | null;
  device: 'gpu' | 'cpu' | null;
  deviceKnown: boolean;
  model?: string | null;
  modelName?: string | null;
  /** Pictures are sent at this size (square, typically 512). */
  inputSide?: number;
}

/** One background fill model ('migan' MI-GAN, 'lama' LaMa). */
export interface InpaintModel {
  id: string;
  name: string;
  model: string;
  folder: string | null;
  installed: boolean;
  problem: string | null;
  sizeBytes: number;
  zip?: string | null;
  inputSide?: number;
  licence?: string | null;
}

export interface InpaintBenchmark {
  ms: number;
  device: 'gpu' | 'cpu';
  loadMs: number;
  side?: number;
}

export interface InpaintRequest {
  width: number;
  height: number;
  model?: string;
}

/** A picture's pixels: w × h × 4 bytes (RGBA). */
export interface Rgba {
  w: number;
  h: number;
  data: Uint8Array;
}

/** What inpaint_estimate sends back: width, height (u32 little-endian), then the RGBA bytes. */
export function parseRgba(buf: ArrayBuffer | Uint8Array): Rgba {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const bad = () => new Error('The background fill came back in an unexpected shape.');
  if (b.length < 8) throw bad();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = v.getUint32(0, true);
  const h = v.getUint32(4, true);
  if (!w || !h || b.length !== 8 + w * h * 4) throw bad();
  return { w, h, data: b.slice(8) };
}

/** (Timed for the timing panel: the 3D models share the graphics card with the window.) */
async function inpaintEstimate(request: InpaintRequest, rgba: Uint8Array, mask: Uint8Array): Promise<Rgba> {
  const t0 = performance.now();
  try {
    return await inpaintEstimateNow(request, rgba, mask);
  } finally {
    noteCall('inpaint_estimate', performance.now() - t0);
  }
}
async function inpaintEstimateNow(request: InpaintRequest, rgba: Uint8Array, mask: Uint8Array): Promise<Rgba> {
  const both = new Uint8Array(rgba.length + mask.length);
  both.set(rgba, 0);
  both.set(mask, rgba.length);
  if (!inTauri) return mockInpaint(request, rgba, mask);
  try {
    return parseRgba(await invoke<ArrayBuffer>('inpaint_estimate', rawBody(request as unknown as Record<string, unknown>, both)));
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : String(e));
  }
}

/** Preview: MI-GAN installed, LaMa not (add ?noinpaint to see neither). */
function mockInpaintModels(): InpaintModel[] {
  const none = typeof location !== 'undefined' && new URLSearchParams(location.search).has('noinpaint');
  const root = 'C:\\MediaVault\\tools\\';
  return [
    { id: 'migan', name: 'MI-GAN', model: 'MI-GAN (Places2)', folder: `${root}inpaint-migan`, installed: !none, problem: none ? 'Not installed: get MediaVault-inpaint-migan-windows.zip from the Releases page and unzip it next to the app.' : null, sizeBytes: none ? 0 : 30_000_000, zip: 'MediaVault-inpaint-migan-windows.zip', inputSide: 512, licence: 'MIT' },
    { id: 'lama', name: 'LaMa', model: 'Big LaMa', folder: `${root}inpaint-lama`, installed: false, problem: 'Not installed: get MediaVault-inpaint-lama-windows.zip from the Releases page and unzip it next to the app.', sizeBytes: 0, zip: 'MediaVault-inpaint-lama-windows.zip', inputSide: 512, licence: 'Apache-2.0' },
  ];
}

function mockInpaintInfo(model: string): InpaintInfo {
  const ready = mockInpaintModels().filter((m) => m.installed && !m.problem);
  const pick = ready.find((m) => m.id === model) ?? (model ? undefined : ready[0]);
  if (!pick) return { available: false, problem: "The background fill pack isn't installed.", folder: null, device: null, deviceKnown: false, model: null, modelName: null, inputSide: 512 };
  return { available: true, problem: null, folder: pick.folder, device: 'gpu', deviceKnown: false, model: pick.id, modelName: pick.name, inputSide: pick.inputSide ?? 512 };
}

/** Preview: a pretend fill (the surrounding colours pulled in, like Simple). Tests can supply their own via `__mvInpaintMock`. */
async function mockInpaint(r: InpaintRequest, rgba: Uint8Array, mask: Uint8Array): Promise<Rgba> {
  const hook = (globalThis as { __mvInpaintMock?: (w: number, h: number, rgba: Uint8Array, mask: Uint8Array) => Promise<Rgba | null> }).__mvInpaintMock;
  const real = hook ? await hook(r.width, r.height, rgba, mask) : null;
  if (real) return real;
  await new Promise((ok) => setTimeout(ok, 250));
  const { fillRgba } = await import('./layers');
  const hole = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) hole[i] = mask[i] / 255;
  return { w: r.width, h: r.height, data: fillRgba(rgba, r.width, r.height, hole) };
}

// ---- saved depth maps and outlines (pictures only) -----------------------------------------------

export type DerivedKind = 'depth' | 'outline';

/** What is saved for some pictures, for one kind and model (the model's name carries its settings). */
export interface DerivedGroup {
  kind: DerivedKind;
  model: string;
  count: number;
  bytes: number;
}

/** Pictures sorted by what the face scan found (a hidden face counts; a poor face isn't a good one). */
export interface FaceSplit {
  withFaces: number[];
  noFaces: number[];
  onlyPoor: number[];
  /** Not scanned for faces yet (never counted as faceless). */
  unscanned: number[];
}

export interface DerivedStats {
  depthCount: number;
  depthBytes: number;
  outlineCount: number;
  outlineBytes: number;
}

/** Preview: saved maps live in memory for the session. */
// Shared on the window so tests that load this module again see the same saved maps (browser demo only).
const mockDerived: Map<string, Uint8Array> = ((globalThis as { __mvDerived?: Map<string, Uint8Array> }).__mvDerived ??= new Map());

async function derivedGet(item: number, kind: DerivedKind, model: string): Promise<Uint8Array | null> {
  let b: ArrayBuffer | Uint8Array | null;
  if (!inTauri) b = (await mock.call('derived_get', { item, kind, model })) as Uint8Array;
  else {
    try {
      b = await invoke<ArrayBuffer>('derived_get', { item, kind, model });
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : String(e));
    }
  }
  const u = b instanceof Uint8Array ? b : b ? new Uint8Array(b) : null;
  return u && u.length ? u : null;
}

/** A depth map or outline as depth_estimate / subject_estimate send it: width, height (u32 little-endian), then the bytes. */
export function mapBytes(m: DepthMap): Uint8Array {
  const b = new Uint8Array(8 + m.data.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, m.w, true);
  v.setUint32(4, m.h, true);
  b.set(m.data, 8);
  return b;
}
