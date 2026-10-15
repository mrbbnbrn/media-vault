// 3D photos: still pictures move with gentle depth parallax (in slideshows,
// and over and over while a picture is simply open; View ▾ → 3D photos).
//
// The depth of a picture comes from an optional depth pack (Fast or Best,
// chosen in Settings → 3D photos; run natively: depth.rs). The window
// decodes the picture in memory, scales it to the size the chosen model wants
// and sends the pixels; the depth map comes back and is kept here, in memory
// only, for the session (dropped on lock, and when another model or detail is
// chosen, so maps from different models never mix). The neighbouring pictures
// are worked out ahead, so slideshows and browsing by hand don't wait.
//
// The camera path (this file) is pure maths, drawn by components/Depth3D.tsx:
// one camera moves on and on along the chosen shape, never stopping and never
// starting again at the next picture (each picture takes over where the
// camera is), like moving the mouse yourself with the 3D button.

import { api, onLocked, type DepthDetail, type DepthInfo, type DepthMap, type ViewerSettings } from './api';
import { viewerPrefs } from './prefs';

/** The Fast model's input size, and the size used until the chosen model has said its own. */
export const DEPTH_SIDE = 518;
/** Depth maps kept in memory (about 270 KB each at 518, 570 KB at 756). */
const KEEP = 48;
/** Pictures worked out ahead at most at once (so quick browsing never piles up work). */
const AHEAD_MAX = 3;

export const NO_DEPTH_PACK =
  '3D photos need a depth pack: get MediaVault-depth-windows.zip (Fast) or MediaVault-depth-da3-mono-large-windows.zip (Best) from the Releases page and unzip it next to the app.';

/** The download each known model comes in (for "not installed" hints). */
export const DEPTH_ZIPS: Record<string, string> = {
  'v2-small': 'MediaVault-depth-windows.zip',
  'da3-mono-large': 'MediaVault-depth-da3-mono-large-windows.zip',
};

// ---- the pack and the chosen model ----------------------------------------------------------

/** The chosen model ('' = the best installed) and detail, read safely from the settings. */
export function depthChoice(p: Pick<ViewerSettings, 'depthModel' | 'depthDetail'>): { model: string; detail: DepthDetail } {
  return { model: typeof p.depthModel === 'string' ? p.depthModel : '', detail: p.depthDetail === 'high' ? 'high' : 'standard' };
}

/** What the depth maps in memory were made with: the model actually used, the picture size sent and the edge softening. */
export interface DepthSetup {
  model: string;
  side: number;
  detail: DepthDetail;
  /** Edge softening (1 = as designed, smaller = sharper; absent = 1). */
  soft?: number;
}

/** Edge softening used when "Edges" is left automatic: Best's more accurate edges are softened half as much. */
export function autoSoft(model: string): number {
  return model === 'da3-mono-large' ? 0.5 : 1;
}

/** The "Edges" setting read safely (undefined = automatic). */
export function edgesSetting(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(2, Math.max(0.25, v)) : undefined;
}

/** A depth map belongs to one picture and one model at one size and softening: a map from another is never mixed in. */
export function depthKey(src: string, s: DepthSetup): string {
  return `${s.model}@${s.side}~${s.soft ?? 1}|${src}`;
}

/** The setup from what depth_info said (null when there's no usable model); `edges` = the Edges setting. */
export function setupOf(i: DepthInfo | null, edges?: number): DepthSetup | null {
  if (!i?.available) return null;
  const model = i.model ?? '';
  return { model, side: i.inputSide && i.inputSide > 0 ? i.inputSide : DEPTH_SIDE, detail: i.detail === 'high' ? 'high' : 'standard', soft: edgesSetting(edges) ?? autoSoft(model) };
}

let setup: DepthSetup | null = null;

/** Use this setup from now on; another model or size forgets the maps made with the old one. */
export function applyDepthSetup(next: DepthSetup | null) {
  const same = !!next && !!setup && next.model === setup.model && next.side === setup.side && (next.soft ?? 1) === (setup.soft ?? 1);
  if (same) return;
  if (setup) forgetDepth();
  setup = next;
}

/** The setup in use now (null until the pack has been asked about). */
export function depthSetup(): DepthSetup | null {
  return setup;
}

let info: Promise<DepthInfo | null> | null = null;
let infoFor = '';
/**
 * Which model 3D photos will use and whether it's there. Asked once per
 * choice of model and detail (`again` asks anew, e.g. after unzipping a pack).
 */
export function depthPack(again = false, choice?: { model: string; detail: DepthDetail }): Promise<DepthInfo | null> {
  // Settings passes its own copy of the choice (the shared one follows once it's saved).
  const c = choice ?? depthChoice(viewerPrefs());
  const edges = edgesSetting(viewerPrefs().depthEdges);
  const want = `${c.model}|${c.detail}|${edges ?? 'auto'}`;
  if (!info || again || want !== infoFor) {
    infoFor = want;
    const p: Promise<DepthInfo | null> = api.depthInfo(c.model, c.detail).catch(() => null).then((i) => {
      // Only the latest answer counts (a slower, older one doesn't undo a newer choice).
      if (info === p) applyDepthSetup(setupOf(i, edges));
      return i;
    });
    info = p;
  }
  return info;
}

// ---- depth maps, worked out one at a time ------------------------------------------------------

type Compute = (src: string, s: DepthSetup) => Promise<DepthMap | null>;

interface Waiting {
  src: string;
  setup: DepthSetup;
  urgent: boolean;
  /** When asked (newest urgent first). */
  seq: number;
  resolve: ((m: DepthMap | null) => void)[];
}

const cache = new Map<string, DepthMap | null>();
const waiting = new Map<string, Waiting>();
/** The latest pictures to work out ahead, most wanted first. */
let aheadKeys: string[] = [];
let running: string | null = null;
let busy = false;
let generation = 0;
let seq = 0;
let compute: Compute = computeReal;

function remember(key: string, m: DepthMap | null) {
  cache.delete(key);
  cache.set(key, m);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
}

/** Forget every depth map (the vault locked, or another model or detail was chosen). */
export function forgetDepth() {
  generation += 1;
  cache.clear();
  for (const w of waiting.values()) w.resolve.forEach((r) => r(null));
  waiting.clear();
  aheadKeys = [];
}
void onLocked(() => forgetDepth()).catch(() => {});

/** The depth map of this picture if it's known already (null = it has none; undefined = not yet). */
export function knownDepth(src: string): DepthMap | null | undefined {
  return setup ? cache.get(depthKey(src, setup)) : undefined;
}

/**
 * The depth map of the picture at `src` (null if it can't be had). `urgent`
 * puts it ahead of the pictures worked out in advance.
 */
export function depthOf(src: string, urgent = false): Promise<DepthMap | null> {
  const s = setup;
  if (!s) return depthPack().then(() => (setup ? depthOf(src, urgent) : null));
  const key = depthKey(src, s);
  if (cache.has(key)) {
    const m = cache.get(key)!;
    remember(key, m);
    return Promise.resolve(m);
  }
  return new Promise((resolve) => {
    const w = waiting.get(key);
    if (w) {
      if (urgent && !w.urgent) w.seq = ++seq;
      w.urgent ||= urgent;
      w.resolve.push(resolve);
    } else waiting.set(key, { src, setup: s, urgent, seq: ++seq, resolve: [resolve] });
    void pump();
  });
}

/**
 * The picture at `src` isn't needed any more (it was left before its depth
 * came): if it hasn't started, it's dropped, unless it's one of the pictures
 * still wanted ahead (then it just waits its turn there).
 */
export function depthLetGo(src: string) {
  if (!setup) return;
  const key = depthKey(src, setup);
  const w = waiting.get(key);
  if (!w) return;
  if (key === running || aheadKeys.includes(key)) {
    w.urgent = false;
    return;
  }
  waiting.delete(key);
  w.resolve.forEach((r) => r(null));
}

/**
 * The pictures to work out ahead while browsing: the next two pictures and
 * the previous one (videos and GIFs skipped; `next` and `prev` are the
 * neighbours in viewing order, nearest first).
 */
export function pickAhead<T extends { kind: string; src: string }>(next: T[], prev: T[]): string[] {
  const pics = (xs: T[]) => xs.filter((x) => x.kind === 'image').map((x) => x.src);
  const out: string[] = [];
  for (const s of [...pics(next).slice(0, 2), ...pics(prev).slice(0, 1)]) if (!out.includes(s)) out.push(s);
  return out;
}

/**
 * Work out the depth of these pictures in the background, most wanted first.
 * Each call replaces the last one's list: pictures asked for earlier that
 * haven't started yet are dropped, so flicking quickly through the viewer
 * never builds up a queue.
 */
export function depthAhead(srcs: string[]) {
  const s = setup;
  if (!s) return;
  const keys = srcs.slice(0, AHEAD_MAX).map((src) => depthKey(src, s));
  for (const k of aheadKeys) {
    const w = waiting.get(k);
    if (w && !keys.includes(k) && !w.urgent && k !== running) {
      waiting.delete(k);
      w.resolve.forEach((r) => r(null));
    }
  }
  aheadKeys = keys;
  for (const src of srcs.slice(0, AHEAD_MAX)) {
    const k = depthKey(src, s);
    if (!cache.has(k) && !waiting.has(k)) waiting.set(k, { src, setup: s, urgent: false, seq: ++seq, resolve: [] });
  }
  void pump();
}

/** The next one to work out: the newest urgent one, else the most wanted ahead, else the oldest. */
function nextKey(): string {
  let best: string | null = null;
  let bestW: Waiting | null = null;
  for (const [k, w] of waiting) {
    if (w.urgent && (!bestW?.urgent || w.seq > bestW.seq)) {
      best = k;
      bestW = w;
    }
  }
  if (best) return best;
  const ahead = aheadKeys.find((k) => waiting.has(k));
  if (ahead) return ahead;
  for (const [k, w] of waiting) if (!bestW || w.seq < bestW.seq) [best, bestW] = [k, w];
  return best as string;
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (waiting.size) {
      const key = nextKey();
      const job = waiting.get(key)!;
      const gen = generation;
      running = key;
      let m: DepthMap | null = null;
      try {
        m = await compute(job.src, job.setup);
      } catch {
        m = null;
      } finally {
        running = null;
      }
      if (gen !== generation) continue; // forgotten meanwhile (locked, or another model chosen)
      const w = waiting.get(key);
      waiting.delete(key);
      remember(key, m);
      w?.resolve.forEach((r) => r(m));
    }
  } finally {
    busy = false;
  }
}

/** Tests only: work out depth maps some other way (null puts the real way back). */
export function setDepthCompute(f: Compute | null) {
  compute = f ?? computeReal;
}

async function computeReal(src: string, s: DepthSetup): Promise<DepthMap | null> {
  const side = s.side;
  const r = await fetch(src);
  if (!r.ok) return null;
  const blob = await r.blob();
  // Straight to the model's size (square; the map is stretched back over the picture).
  const opts = { imageOrientation: 'from-image', resizeWidth: side, resizeHeight: side, resizeQuality: 'high' } as ImageBitmapOptions;
  const bmp = await createImageBitmap(blob, opts);
  try {
    const c = new OffscreenCanvas(side, side);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, side, side).data;
    return await api.depthEstimate({ width: side, height: side, model: s.model, detail: s.detail, soft: s.soft ?? 1 }, new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
  } finally {
    bmp.close();
  }
}

// ---- speed tests (Settings → 3D photos; remembered for this session only) ----------------------

export interface SpeedResult {
  ms: number;
  device: 'gpu' | 'cpu';
  loadMs: number;
}
const speeds = new Map<string, SpeedResult>();

/** The last speed test of a model at a detail, this session. */
export function lastSpeed(id: string, detail: DepthDetail): SpeedResult | undefined {
  return speeds.get(`${id}|${detail}`);
}

/** Run a speed test and remember the result for this session. */
export async function testSpeed(id: string, detail: DepthDetail): Promise<SpeedResult> {
  const r = await api.depthBenchmark(id, detail);
  const res = { ms: r.ms, device: r.device, loadMs: r.loadMs };
  speeds.set(`${id}|${detail}`, res);
  return res;
}

/** "0.15 s per picture on the graphics card". */
export function speedText(r: SpeedResult): string {
  const s = r.ms / 1000;
  const t = s < 1 ? s.toFixed(2) : s < 10 ? s.toFixed(1) : Math.round(s).toString();
  return `${t} s per picture on the ${r.device === 'gpu' ? 'graphics card' : 'processor'}`;
}

// ---- the camera path -----------------------------------------------------------------------------

/** The shapes the automatic movement can follow (View ▾ → 3D photos → Motion shape). */
export type MotionShape = 'circle' | 'infinity' | 'side' | 'updown' | 'diagonal' | 'zoom' | 'drift' | 'spiral' | 'pendulum';
/** A shape, or Random: wandering about like a hand moving the mouse. */
export type MotionChoice = MotionShape | 'random';

export const MOTION_SHAPES: MotionShape[] = ['circle', 'infinity', 'side', 'updown', 'diagonal', 'zoom', 'drift', 'spiral', 'pendulum'];

/** Names for the chooser. */
export const MOTION_LABELS: Record<MotionChoice, string> = {
  random: 'Random',
  circle: 'Circle',
  infinity: 'Infinity',
  side: 'Side to side',
  updown: 'Up and down',
  diagonal: 'Diagonal',
  zoom: 'Zoom in and out',
  drift: 'Zoom drift',
  spiral: 'Spiral',
  pendulum: 'Pendulum',
};

/** A saved choice read back safely (anything unknown is Random). */
export function motionChoice(v: unknown): MotionChoice {
  return v === 'random' || MOTION_SHAPES.includes(v as MotionShape) ? (v as MotionChoice) : 'random';
}

export interface Pose {
  /** Camera shift (share of the shorter side; x right, y down). */
  x: number;
  y: number;
  /** Dolly: nearer things grow by this much per unit of depth. */
  dolly: number;
}

/** How far the camera moves at 100%, as a share of the picture's shorter side. */
export const SHIFT = 0.022;
/** How much nearer things grow at 100% during a zoom (share per unit of depth). */
export const DOLLY = 0.07;
/** No shape goes further than this from the middle (times SHIFT × amount). */
export const SHAPE_REACH = 1.2;
/** Once round a shape at 100% speed (ms): slow enough to feel calm. */
export const LOOP_MS = 9000;

/** 0 → 1 with no speed at either end (Zoom in and out only: it rests at the still picture each time). */
const settle = (u: number) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);

/**
 * Where the camera is after `phase` times round (any number, growing for
 * ever), at 100%. Every shape is an endless smooth path: no stops, no
 * restarts, so a picture can take over wherever the camera happens to be.
 * Zoom in and out is the one exception (as before): it rests at the still
 * picture between zooms.
 */
export function motionPose(choice: MotionChoice, phase: number): Pose {
  const p = Number.isFinite(phase) ? phase : 0;
  const a = 2 * Math.PI * p;
  const S = SHIFT;
  switch (choice) {
    case 'circle':
      // Round and round the middle, like circling the mouse.
      return { x: S * 0.85 * Math.cos(a), y: S * 0.85 * Math.sin(a), dolly: 0 };
    case 'infinity':
      // A figure of eight through the middle.
      return { x: S * Math.sin(a), y: S * 0.5 * Math.sin(2 * a), dolly: 0 };
    case 'side':
      return { x: S * Math.sin(a), y: 0, dolly: 0 };
    case 'updown':
      return { x: 0, y: S * 0.8 * Math.sin(a), dolly: 0 };
    case 'diagonal': {
      const k = (S * Math.sin(a)) / Math.SQRT2;
      return { x: k, y: k, dolly: 0 };
    }
    case 'zoom': {
      // Towards the picture and back, resting at the still picture in between.
      const t = settle(p - Math.floor(p));
      return { x: 0, y: 0, dolly: DOLLY * (1 - Math.cos(2 * Math.PI * t)) * 0.5 };
    }
    case 'drift':
      // In and out without resting, with a slow sway so the camera never stands still.
      return { x: S * 0.35 * Math.sin(a * 0.5), y: S * 0.25 * Math.sin(a * 0.5 + 1.3), dolly: DOLLY * (0.5 - 0.5 * Math.cos(a)) };
    case 'spiral': {
      // Round and round, the circle slowly widening and narrowing, closer when wide.
      const w = 0.5 - 0.5 * Math.cos(a / 3);
      const r = S * (0.3 + 0.7 * w);
      return { x: r * Math.cos(a), y: r * Math.sin(a), dolly: DOLLY * 0.5 * w };
    }
    case 'pendulum': {
      // Along a hanging arc: lowest in the middle, rising towards each end.
      const k = Math.sin(a);
      return { x: S * k, y: S * 0.4 * (0.5 - k * k), dolly: 0 };
    }
    case 'random':
    default: {
      // Wandering: a few slow swings at unrelated speeds added up, so it never repeats
      // and never jerks (like a hand moving the mouse about).
      const x = 0.6 * Math.sin(a * 0.71 + 1.1) + 0.4 * Math.sin(a * 1.17 + 4.0);
      const y = 0.6 * Math.sin(a * 0.53 + 2.3) + 0.4 * Math.sin(a * 0.97 + 0.4);
      const z = 0.5 + 0.5 * Math.sin(a * 0.31 + 0.9);
      return { x: S * 0.95 * x, y: S * 0.65 * y, dolly: DOLLY * 0.25 * z };
    }
  }
}

/**
 * The shape drawn small for the chooser: `n` points of one time round (two for the
 * slower shapes), fitted into a `w` × `h` box with a margin, and how much it zooms (0–1) at each point.
 */
export function shapeOutline(shape: MotionChoice, w: number, h: number, n = 48): { x: number; y: number; zoom: number }[] {
  const turns = shape === 'spiral' ? 3 : shape === 'drift' ? 2 : shape === 'random' ? 6 : 1;
  const m = n * turns;
  const pts = Array.from({ length: m + 1 }, (_, i) => motionPose(shape, (i / m) * turns));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Same scale both ways so a circle stays round; a shape with no sideways movement sits in the middle.
  const k = Math.min((w * 0.8) / Math.max(x1 - x0, 1e-9), (h * 0.8) / Math.max(y1 - y0, 1e-9), (Math.min(w, h) * 0.8) / SHIFT);
  return pts.map((p) => ({ x: w / 2 + (p.x - (x0 + x1) / 2) * k, y: h / 2 + (p.y - (y0 + y1) / 2) * k, zoom: p.dolly / DOLLY }));
}

/** One time round (ms): faster speed, shorter. */
export function loopMs(speed: number): number {
  const k = Number.isFinite(speed) ? Math.min(8, Math.max(0.1, speed)) : 1;
  return LOOP_MS / k;
}

/** How long a change of shape takes to blend in (ms). */
export const BLEND_MS = 1200;
/** The longest step the camera takes at once (ms): after a pause or a hidden window it carries on, never jumps. */
const MAX_STEP_MS = 50;

/** The one camera all pictures share: where it is on its path, and a shape it is blending away from. */
export interface Camera {
  phase: number;
  last: number;
  choice: MotionChoice | null;
  from: MotionChoice | null;
  blendStart: number;
}

export function newCamera(): Camera {
  return { phase: 0, last: Number.NaN, choice: null, from: null, blendStart: 0 };
}

/** Smooth 0 → 1. */
const smooth = (u: number) => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

/**
 * The camera at time `t` (ms, any steady clock): moved on by the time since
 * it was last asked (if `running`), at this speed and along this shape. Asking
 * twice at the same moment (two pictures crossfading) moves it once. A new
 * shape blends in from the old one over BLEND_MS, so nothing jumps.
 */
export function cameraAt(c: Camera, choice: MotionChoice, speed: number, t: number, running: boolean): Pose {
  if (Number.isFinite(c.last) && running) {
    const dt = Math.min(MAX_STEP_MS, Math.max(0, t - c.last));
    c.phase += dt / loopMs(speed);
  }
  c.last = t;
  if (c.choice !== choice) {
    if (c.choice !== null) {
      c.from = c.choice;
      c.blendStart = t;
    }
    c.choice = choice;
  }
  const to = motionPose(choice, c.phase);
  if (c.from === null) return to;
  const k = smooth((t - c.blendStart) / BLEND_MS);
  if (k >= 1) {
    c.from = null;
    return to;
  }
  const was = motionPose(c.from, c.phase);
  return { x: was.x + (to.x - was.x) * k, y: was.y + (to.y - was.y) * k, dolly: was.dolly + (to.dolly - was.dolly) * k };
}

/** The camera the viewer's pictures share (it keeps going from one picture to the next). */
export const sharedCamera: Camera = newCamera();

/** A pose made stronger or weaker (Settings: 3D depth, 1 = as designed). */
export function scalePose(p: Pose, amount: number): Pose {
  return { x: p.x * amount, y: p.y * amount, dolly: p.dolly * amount };
}

/** 3D with the mouse: how far the camera leans at the edge of the picture (share of SHIFT). */
const MOUSE_REACH = 1.6;

/**
 * Where the mouse is over the picture (−1…1 each way from the middle), made
 * more or less sensitive by `react` (1 = the edge of the picture leans all
 * the way), held within the furthest lean.
 */
export function mouseLean(dx: number, dy: number, react: number): { x: number; y: number } {
  const k = Math.max(0.05, react);
  const c = (v: number) => Math.max(-1, Math.min(1, v * k));
  return { x: c(dx), y: c(dy) };
}

/** The camera for a mouse lean (−1…1 each way): sideways and up/down, a little less up/down. */
export function mousePose(lean: { x: number; y: number }, amount: number): Pose {
  return { x: lean.x * SHIFT * MOUSE_REACH * amount, y: lean.y * SHIFT * MOUSE_REACH * 0.75 * amount, dolly: 0 };
}

/** Eases `from` toward `to` over about 1/8 s, whatever the frame rate. */
export function easeToward(from: number, to: number, dtMs: number): number {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / 120);
  return from + (to - from) * k;
}

/**
 * The shift in picture coordinates (0–1 each way) for a picture of this
 * shape, so the movement is the same in pixels both ways.
 */
export function shiftUv(pose: Pose, w: number, h: number): { x: number; y: number } {
  const short = Math.min(w, h) || 1;
  return { x: (pose.x * short) / (w || 1), y: (pose.y * short) / (h || 1) };
}

/**
 * How much the picture is enlarged so the moved picture still fills its own
 * frame (the edges never show). `pivot` is the depth that stays still.
 */
export function cropScale(shift: { x: number; y: number }, dolly: number, pivot: number): number {
  const most = furthest(shift, dolly, pivot);
  return 1 / Math.max(1 - 2 * MOST, 1 - 2 * most);
}

/** The furthest any sample moves (share of the picture), with the picture not enlarged. */
function furthest(shift: { x: number; y: number }, dolly: number, pivot: number): number {
  const reach = Math.max(pivot, 1 - pivot);
  return (Math.max(Math.abs(shift.x), Math.abs(shift.y)) + Math.abs(dolly) * 0.5) * reach;
}

/** The most the picture may move (share of it): enlarged at most 1 / (1 − 2 × 0.3) = 2.5 times. */
const MOST = 0.3;

/**
 * Everything the drawing needs for a pose on a picture this size: the shift
 * in picture coordinates, the dolly and how much to enlarge. A pose that
 * would need the picture enlarged more than 2.5 times (the strongest amount
 * and depth together) is scaled down to fit, so the edges never show.
 */
export function framePose(pose: Pose, w: number, h: number, pivot: number): { shift: { x: number; y: number }; dolly: number; scale: number } {
  let shift = shiftUv(pose, w, h);
  let dolly = pose.dolly;
  const most = furthest(shift, dolly, pivot);
  if (most > MOST) {
    const k = MOST / most;
    shift = { x: shift.x * k, y: shift.y * k };
    dolly *= k;
  }
  return { shift, dolly, scale: cropScale(shift, dolly, pivot) };
}

/**
 * The depth that stays still: the average depth of the middle of the picture
 * (usually the subject), so the background moves behind it.
 */
export function pivotOf(m: DepthMap): number {
  const { w, h, data } = m;
  if (!w || !h || data.length < w * h) return 0.5;
  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
  for (let y = Math.floor(h * 0.25); y < h * 0.75; y += step)
    for (let x = Math.floor(w * 0.25); x < w * 0.75; x += step) {
      sum += data[y * w + x];
      n++;
    }
  const v = n ? sum / n / 255 : 0.5;
  return Math.min(0.85, Math.max(0.25, v));
}
