// 3D photos: still pictures move with gentle depth parallax (in slideshows,
// and over and over while a picture is simply open; View ▾ → 3D photos).
//
// The depth of a picture comes from the optional depth pack (Depth Anything
// V2 Small, run natively: depth.rs). The window decodes the picture in memory,
// scales it to the model's size and sends the pixels; the depth map comes back
// and is kept here, in memory only, for the session (and dropped on lock).
// The next pictures are worked out ahead, so the slideshow doesn't wait.
//
// The camera path (this file) is pure maths, drawn by components/Depth3D.tsx:
// every loop of the movement starts and ends exactly as the still picture,
// so fades and "Line up faces" work as usual and loops join without a jump,
// and it moves a few per cent in between.

import { api, onLocked, type DepthInfo, type DepthMap } from './api';

/** The model's input size: pictures are sent at this size. */
export const DEPTH_SIDE = 518;
/** Depth maps kept in memory (about 270 KB each). */
const KEEP = 48;

export const NO_DEPTH_PACK =
  '3D photos need the depth pack: get MediaVault-depth-windows.zip from the Releases page and unzip it next to the app.';

// ---- the pack ----------------------------------------------------------------------------

let info: Promise<DepthInfo | null> | null = null;
/** Whether the depth pack is there (asked once per session; `again` asks anew). */
export function depthPack(again = false): Promise<DepthInfo | null> {
  if (!info || again) info = api.depthInfo().catch(() => null);
  return info;
}

// ---- depth maps, worked out one at a time ------------------------------------------------------

const cache = new Map<string, DepthMap | null>();
const waiting = new Map<string, { urgent: boolean; resolve: ((m: DepthMap | null) => void)[] }>();
let busy = false;
let generation = 0;

function remember(key: string, m: DepthMap | null) {
  cache.delete(key);
  cache.set(key, m);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
}

/** Forget every depth map (the vault locked). */
export function forgetDepth() {
  generation += 1;
  cache.clear();
  for (const w of waiting.values()) w.resolve.forEach((r) => r(null));
  waiting.clear();
}
void onLocked(() => forgetDepth()).catch(() => {});

/** The depth map of this picture if it's known already (null = it has none; undefined = not yet). */
export function knownDepth(src: string): DepthMap | null | undefined {
  return cache.get(src);
}

/**
 * The depth map of the picture at `src` (null if it can't be had). `urgent`
 * puts it ahead of the pictures worked out in advance.
 */
export function depthOf(src: string, urgent = false): Promise<DepthMap | null> {
  if (cache.has(src)) {
    const m = cache.get(src)!;
    remember(src, m);
    return Promise.resolve(m);
  }
  return new Promise((resolve) => {
    const w = waiting.get(src);
    if (w) {
      w.urgent ||= urgent;
      w.resolve.push(resolve);
    } else waiting.set(src, { urgent, resolve: [resolve] });
    void pump();
  });
}

/** Work out the depth of the coming pictures, in the background. */
export function depthAhead(srcs: string[]) {
  for (const s of srcs) if (!cache.has(s) && !waiting.has(s)) void depthOf(s);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (waiting.size) {
      // Urgent first, otherwise in the order asked.
      const key = [...waiting.entries()].find(([, w]) => w.urgent)?.[0] ?? (waiting.keys().next().value as string);
      const gen = generation;
      let m: DepthMap | null = null;
      try {
        m = await compute(key);
      } catch {
        m = null;
      }
      if (gen !== generation) continue; // locked meanwhile: forgotten
      const w = waiting.get(key);
      waiting.delete(key);
      remember(key, m);
      w?.resolve.forEach((r) => r(m));
    }
  } finally {
    busy = false;
  }
}

async function compute(src: string): Promise<DepthMap | null> {
  const r = await fetch(src);
  if (!r.ok) return null;
  const blob = await r.blob();
  // Straight to the model's size (it is square; the map is stretched back over the picture).
  const opts = { imageOrientation: 'from-image', resizeWidth: DEPTH_SIDE, resizeHeight: DEPTH_SIDE, resizeQuality: 'high' } as ImageBitmapOptions;
  const bmp = await createImageBitmap(blob, opts);
  try {
    const c = new OffscreenCanvas(DEPTH_SIDE, DEPTH_SIDE);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, DEPTH_SIDE, DEPTH_SIDE).data;
    return await api.depthEstimate({ width: DEPTH_SIDE, height: DEPTH_SIDE }, new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
  } finally {
    bmp.close();
  }
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
