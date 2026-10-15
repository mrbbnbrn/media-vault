// 3D photos: still pictures move with gentle depth parallax (in slideshows,
// and over and over while a picture is simply open; View ▾ → 3D photos).
//
// The depth of a picture comes from an optional depth pack (Fast, Balanced or
// Best, chosen in Settings → 3D photos; run natively: depth.rs). The window
// decodes the picture in memory, scales it to the size the chosen model wants
// and sends the pixels; the depth map comes back and is kept here, in memory
// only, for the session (dropped on lock, and when another model or detail is
// chosen, so maps from different models never mix). The neighbouring pictures
// are worked out ahead, so slideshows and browsing by hand don't wait.
//
// The camera path (this file) is pure maths, drawn by components/Depth3D.tsx:
// every loop of the movement starts and ends exactly as the still picture,
// so fades and "Line up faces" work as usual and loops join without a jump,
// and it moves a few per cent in between.

import { api, onLocked, type DepthDetail, type DepthInfo, type DepthMap, type ViewerSettings } from './api';
import { viewerPrefs } from './prefs';

/** The Fast model's input size, and the size used until the chosen model has said its own. */
export const DEPTH_SIDE = 518;
/** Depth maps kept in memory (about 270 KB each at 518, 570 KB at 756). */
const KEEP = 48;
/** Pictures worked out ahead at most at once (so quick browsing never piles up work). */
const AHEAD_MAX = 3;

export const NO_DEPTH_PACK =
  '3D photos need a depth pack: get MediaVault-depth-windows.zip (Fast), MediaVault-depth-da3-base-windows.zip (Balanced) or MediaVault-depth-da3-mono-large-windows.zip (Best) from the Releases page and unzip it next to the app.';

/** The download each known model comes in (for "not installed" hints). */
export const DEPTH_ZIPS: Record<string, string> = {
  'v2-small': 'MediaVault-depth-windows.zip',
  'da3-base': 'MediaVault-depth-da3-base-windows.zip',
  'da3-mono-large': 'MediaVault-depth-da3-mono-large-windows.zip',
};

// ---- the pack and the chosen model ----------------------------------------------------------

/** The chosen model ('' = the best installed) and detail, read safely from the settings. */
export function depthChoice(p: Pick<ViewerSettings, 'depthModel' | 'depthDetail'>): { model: string; detail: DepthDetail } {
  return { model: typeof p.depthModel === 'string' ? p.depthModel : '', detail: p.depthDetail === 'high' ? 'high' : 'standard' };
}

/** What the depth maps in memory were made with: the model actually used and the picture size sent. */
export interface DepthSetup {
  model: string;
  side: number;
  detail: DepthDetail;
}

/** A depth map belongs to one picture and one model at one size: a map from another model is never mixed in. */
export function depthKey(src: string, s: DepthSetup): string {
  return `${s.model}@${s.side}|${src}`;
}

/** The setup from what depth_info said (null when there's no usable model). */
export function setupOf(i: DepthInfo | null): DepthSetup | null {
  if (!i?.available) return null;
  return { model: i.model ?? '', side: i.inputSide && i.inputSide > 0 ? i.inputSide : DEPTH_SIDE, detail: i.detail === 'high' ? 'high' : 'standard' };
}

let setup: DepthSetup | null = null;

/** Use this setup from now on; another model or size forgets the maps made with the old one. */
export function applyDepthSetup(next: DepthSetup | null) {
  const same = !!next && !!setup && next.model === setup.model && next.side === setup.side;
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
  const want = `${c.model}|${c.detail}`;
  if (!info || again || want !== infoFor) {
    infoFor = want;
    const p: Promise<DepthInfo | null> = api.depthInfo(c.model, c.detail).catch(() => null).then((i) => {
      // Only the latest answer counts (a slower, older one doesn't undo a newer choice).
      if (info === p) applyDepthSetup(setupOf(i));
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
    return await api.depthEstimate({ width: side, height: side, model: s.model, detail: s.detail }, new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
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
export type MotionShape = 'circle' | 'infinity' | 'side' | 'updown' | 'diagonal' | 'zoom' | 'spiral' | 'pendulum';
/** A shape, or a different one for each picture. */
export type MotionChoice = MotionShape | 'random';

export const MOTION_SHAPES: MotionShape[] = ['circle', 'infinity', 'side', 'updown', 'diagonal', 'zoom', 'spiral', 'pendulum'];

/** Names for the chooser. */
export const MOTION_LABELS: Record<MotionChoice, string> = {
  random: 'Random',
  circle: 'Circle',
  infinity: 'Infinity',
  side: 'Side to side',
  updown: 'Up and down',
  diagonal: 'Diagonal',
  zoom: 'Zoom in and out',
  spiral: 'Spiral',
  pendulum: 'Pendulum',
};

/** A saved choice read back safely (anything unknown is Random). */
export function motionChoice(v: unknown): MotionChoice {
  return v === 'random' || MOTION_SHAPES.includes(v as MotionShape) ? (v as MotionChoice) : 'random';
}

/** One loop of the movement: its shape and which way round it goes this time. */
export interface MotionLoop {
  shape: MotionShape;
  /** Clockwise or not; towards one side or the other first. */
  turn: 1 | -1;
  /** Direction of the circle and spiral (radians); the other shapes keep their own direction. */
  angle: number;
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
/** No shape goes further than this from the still pose (times SHIFT × amount). */
export const SHAPE_REACH = 1.2;
/** One loop outside slideshows at 100% speed (ms): slow enough to feel calm. */
export const LOOP_MS = 9000;

/** The shape for a picture: the chosen one, or (Random) one of the real shapes. */
export function pickShape(choice: MotionChoice, rand: () => number = Math.random): MotionShape {
  if (choice !== 'random') return choice;
  return MOTION_SHAPES[Math.min(MOTION_SHAPES.length - 1, Math.floor(rand() * MOTION_SHAPES.length))];
}

/** A small repeatable random number (0–1) from two whole numbers, so a loop's direction is fixed once picked. */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Loop number `loop` of a picture (`seed` is the picture's own): a new direction each time round. */
export function loopOf(shape: MotionShape, seed: number, loop: number): MotionLoop {
  const turn = hash01(seed, loop * 2) < 0.5 ? 1 : -1;
  // Mostly sideways for the circle and spiral: that's where parallax looks best.
  const angle = (hash01(seed, loop * 2 + 1) - 0.5) * 1.2 + (hash01(seed + 1, loop) < 0.5 ? 0 : Math.PI);
  return { shape, turn, angle };
}

/** 0 → 1 with no speed at either end. */
const settle = (u: number) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);

/**
 * Where the camera is, `v` (0–1) of the way through one loop, at 100%. Every
 * shape is exactly still at 0 and at 1 and leaves and arrives with no speed,
 * so one loop runs into the next without a jump, and a slideshow picture
 * matches the plain still picture when it fades in and out.
 */
export function shapePose(v: number, l: MotionLoop): Pose {
  const t = settle(Math.min(1, Math.max(0, v)));
  const a = 2 * Math.PI * t;
  const S = SHIFT;
  const c = Math.cos(l.angle);
  const s = Math.sin(l.angle);
  const rot = (x: number, y: number, dolly: number): Pose => ({ x: x * c - y * s, y: x * s + y * c, dolly });
  switch (l.shape) {
    case 'circle': {
      // Once round a circle that passes through the still pose, coming a little closer halfway.
      const r = S * 0.6;
      return rot(r * Math.sin(a), r * (1 - Math.cos(a)) * l.turn, DOLLY * 0.25 * Math.sin(Math.PI * t));
    }
    case 'infinity':
      // A figure of eight, crossing at the still pose.
      return { x: S * Math.sin(a) * l.turn, y: S * 0.5 * Math.sin(2 * a), dolly: 0 };
    case 'side':
      return { x: S * Math.sin(a) * l.turn, y: 0, dolly: 0 };
    case 'updown':
      return { x: 0, y: S * 0.8 * Math.sin(a) * l.turn, dolly: 0 };
    case 'diagonal': {
      // Corner to corner; which diagonal changes from loop to loop.
      const k = (S * Math.sin(a) * l.turn) / Math.SQRT2;
      return { x: k, y: c >= 0 ? k : -k, dolly: 0 };
    }
    case 'zoom':
      // Towards the picture and back, with no sideways drift.
      return { x: 0, y: 0, dolly: DOLLY * (1 - Math.cos(a)) * 0.5 };
    case 'spiral': {
      // Out from the middle in two turns while coming closer, then back in.
      const r = S * Math.sin(Math.PI * t);
      const b = 4 * Math.PI * t * l.turn;
      return rot(r * Math.sin(b), r * Math.cos(b), DOLLY * 0.6 * Math.sin(Math.PI * t));
    }
    case 'pendulum': {
      // Along a hanging arc: lowest in the middle, rising and slowing at each end.
      const k = Math.sin(a);
      return { x: S * k * l.turn, y: -S * 0.4 * k * k, dolly: 0 };
    }
  }
}

/**
 * The shape drawn small for the chooser: `n` points of one loop, fitted into
 * a `w` × `h` box with a margin, and how much it zooms (0–1) at each point.
 */
export function shapeOutline(shape: MotionShape, w: number, h: number, n = 48): { x: number; y: number; zoom: number }[] {
  const loop: MotionLoop = { shape, turn: 1, angle: 0 };
  const pts = Array.from({ length: n + 1 }, (_, i) => shapePose(i / n, loop));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Same scale both ways so a circle stays round; a shape with no sideways movement sits in the middle.
  const k = Math.min((w * 0.8) / Math.max(x1 - x0, 1e-9), (h * 0.8) / Math.max(y1 - y0, 1e-9), (Math.min(w, h) * 0.8) / SHIFT);
  return pts.map((p) => ({ x: w / 2 + (p.x - (x0 + x1) / 2) * k, y: h / 2 + (p.y - (y0 + y1) / 2) * k, zoom: p.dolly / DOLLY }));
}

/** How many loops a slideshow picture gets: more with a faster speed, always whole so it ends still. */
export function slideLoops(speed: number): number {
  return Math.max(1, Math.round(Number.isFinite(speed) ? speed : 1));
}

/** One loop's length outside slideshows (ms): faster speed, shorter loop. */
export function loopMs(speed: number): number {
  const k = Number.isFinite(speed) ? Math.min(8, Math.max(0.1, speed)) : 1;
  return LOOP_MS / k;
}

/**
 * Where a slideshow picture is in its movement, `u` (0–1) of the way through
 * its time: which loop, and how far through it. At 1 it is the end of the
 * last loop (still).
 */
export function slidePhase(u: number, loops: number): { loop: number; v: number } {
  const n = Math.max(1, Math.round(loops));
  const w = Math.min(1, Math.max(0, u)) * n;
  if (w >= n) return { loop: n - 1, v: 1 };
  const loop = Math.floor(w);
  return { loop, v: w - loop };
}

/**
 * The endless movement outside slideshows, moved on by `dtMs` at this speed.
 * It is a running count of loops (2.25 = a quarter into the third), added up
 * frame by frame so a change of speed never makes it jump.
 */
export function advancePhase(phase: number, dtMs: number, speed: number): number {
  return phase + Math.max(0, dtMs) / loopMs(speed);
}

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

/** The camera's timing: how far through (0–1) after `ms` of a picture's own time. */
export function progress(ms: number, startMs: number, endMs: number): number {
  const len = endMs - startMs;
  if (len <= 0) return 1;
  return (ms - startMs) / len;
}
