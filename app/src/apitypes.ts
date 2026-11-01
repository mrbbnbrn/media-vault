// The shapes of what the backend sends and takes (settings, items, folders,
// faces, jobs…), and the default settings. api.ts re-exports all of it, so
// `import { type Item } from './api'` keeps working.

import type { CoverPos } from './coverframe';

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
  /** Make small preview clips of videos in the background. */
  makePreviews: boolean;
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
  /** Today's pick after unlocking (off: it never pops up). */
  todaysPick?: boolean;
  /** The face scan is paused (remembered across restarts). */
  facesPaused?: boolean;
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

/** The native analysis pass (analyse.rs). */
export interface AnalyseStatus {
  running: boolean;
  busy: boolean;
  /** Items done since it started, and per step. */
  done: number;
  thumbs: number;
  prints: number;
  faces: number;
  /** Items still with something to do. */
  left: number;
  facesLeft: number;
}

export interface AnalyseReport {
  id: number;
  thumb: boolean;
  print: string | null;
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
  /** What smart search (no longer in the app) left in the library: items and bytes. */
  clipItems: number;
  clipBytes: number;
  backups: number;
  backupBytes: number;
  libraryBytes: number;
}

/** One of the library backups (meta-backups/ in the vault folder). */
export interface LibraryBackup {
  name: string;
  /** When it was made (ms since 1970). */
  atMs: number;
  bytes: number;
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
