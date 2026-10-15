// 3D photos: still pictures in the slideshow move with gentle depth parallax.
//
// The depth of a picture comes from the optional depth pack (Depth Anything
// V2 Small, run natively: depth.rs). The window decodes the picture in memory,
// scales it to the model's size and sends the pixels; the depth map comes back
// and is kept here, in memory only, for the session (and dropped on lock).
// The next pictures are worked out ahead, so the slideshow doesn't wait.
//
// The camera path (this file) is pure maths, drawn by components/Depth3D.tsx:
// each picture starts and ends exactly as the still picture, so fades and
// "Line up faces" work as usual, and moves a few per cent in between.

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

export type PathKind = 'orbit' | 'swing' | 'dolly';

export interface DepthPath {
  kind: PathKind;
  /** Direction of the swing / orbit (radians). */
  angle: number;
  /** Clockwise or not (orbit). */
  turn: 1 | -1;
}

/** How far the camera moves, as a share of the picture's shorter side. */
export const SHIFT = 0.022;
/** How much nearer things grow during a dolly (share per unit of depth). */
export const DOLLY = 0.07;

export function pickPath(rand: () => number = Math.random): DepthPath {
  const r = rand();
  const kind: PathKind = r < 0.45 ? 'orbit' : r < 0.8 ? 'swing' : 'dolly';
  // Mostly sideways: that's where parallax looks best.
  const angle = (rand() - 0.5) * 0.9 + (rand() < 0.5 ? 0 : Math.PI);
  return { kind, angle, turn: rand() < 0.5 ? 1 : -1 };
}

export interface Pose {
  /** Camera shift (share of the shorter side; x right, y down). */
  x: number;
  y: number;
  /** Dolly: nearer things grow by this much per unit of depth. */
  dolly: number;
}

/** 0 → 1 with no speed at either end. */
const settle = (u: number) => u - Math.sin(2 * Math.PI * u) / (2 * Math.PI);

/**
 * Where the camera is, `u` (0–1) of the way through the picture's time. The
 * pose is exactly still at 0 and at 1 (and moves off gently), so the picture
 * matches the plain still picture when it fades in and out.
 */
export function poseAt(u: number, p: DepthPath): Pose {
  const t = settle(Math.min(1, Math.max(0, u)));
  const c = Math.cos(p.angle);
  const s = Math.sin(p.angle);
  if (p.kind === 'orbit') {
    // A small circle through the still pose.
    const a = 2 * Math.PI * t;
    const along = Math.sin(a) * SHIFT;
    const across = (1 - Math.cos(a)) * 0.5 * SHIFT * p.turn;
    return { x: along * c - across * s, y: along * s + across * c, dolly: DOLLY * 0.35 * Math.sin(Math.PI * t) };
  }
  if (p.kind === 'swing') {
    // Out to one side, across to the other, and back.
    const k = Math.sin(2 * Math.PI * t) * SHIFT * 1.15;
    return { x: k * c, y: k * s * 0.5, dolly: 0 };
  }
  // In and back out, drifting a little.
  const k = Math.sin(Math.PI * t);
  return { x: k * SHIFT * 0.35 * c, y: k * SHIFT * 0.35 * s, dolly: DOLLY * k };
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
  const reach = Math.max(pivot, 1 - pivot);
  const most = (Math.max(Math.abs(shift.x), Math.abs(shift.y)) + dolly * 0.5) * reach;
  return 1 / Math.max(0.5, 1 - 2 * most);
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
