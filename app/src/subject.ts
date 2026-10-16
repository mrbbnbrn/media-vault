// Subject effects for still pictures (GIFs and videos never get them):
// "Lift-off" brings the subject forward a little with a soft shadow behind
// it
// background stays still. Both are drawn by components/Depth3D.tsx on top of
// the 3D photo (and with it, when the 3D motion or the 3D mouse is on).
//
// The subject comes from an optional subject pack (Fast or Best; run
// natively: subject.rs). Like the depth maps (depth.ts), the window decodes
// the picture in memory, scales it to the size the model wants and sends the
// pixels; the subject outline comes back and is kept here, in memory only,
// for the session (dropped on lock, and when another model is chosen, so
// outlines from different models never mix). The neighbouring pictures are
// worked out ahead while one of the effects is on.
//
// The rest of this file is pure maths for the drawing: where the subject is,
// how far it is lifted, how it sways and breathes.

import { api, onLocked, type DepthMap, type SubjectInfo, type SubjectMask, type ViewerSettings } from './api';
import { viewerPrefs } from './prefs';
import { savedId, savedOr } from './derived';

/** The size used until the chosen model has said its own. */
export const SUBJECT_SIDE = 1024;
/** Outlines kept in memory (about 1 MB each at 1024). */
const KEEP = 24;
/** Pictures worked out ahead at most at once. */
const AHEAD_MAX = 3;

export const NO_SUBJECT_PACK =
  'Lift-off and the other subject effects need a subject pack: get MediaVault-subject-birefnet-lite-windows.zip (Fast) or MediaVault-subject-birefnet-windows.zip (Best) from the Releases page and unzip it next to the app.';

/** For the other outline buttons (sharper edges, the light, subject-only 3D, layered 3D, saving the subject). */
export const NEED_OUTLINE = 'This needs a subject outline download: get MediaVault-subject-birefnet-lite-windows.zip (Fast) from the Releases page and unzip it next to the app.';

/** The download each known model comes in (for "not installed" hints). */
export const SUBJECT_ZIPS: Record<string, string> = {
  'birefnet-lite': 'MediaVault-subject-birefnet-lite-windows.zip',
  birefnet: 'MediaVault-subject-birefnet-windows.zip',
};

// ---- the pack and the chosen model ----------------------------------------------------------

/** The chosen model ('' = the best installed), read safely from the settings. */
export function subjectChoice(p: Pick<ViewerSettings, 'subjectModel'>): string {
  return typeof p.subjectModel === 'string' ? p.subjectModel : '';
}

/** An effect's amount read safely (0.3–3; anything else is 1). */
export function effectAmount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(3, Math.max(0.3, v)) : 1;
}

/** What the outlines in memory were made with: the model actually used and the picture size sent. */
export interface SubjectSetup {
  model: string;
  side: number;
}

/** An outline belongs to one picture and one model at one size. */
export function subjectKey(src: string, s: SubjectSetup): string {
  return `${subjectTag(s)}|${src}`;
}

/** The model and size an outline was made with (what a saved outline is saved under). */
export function subjectTag(s: SubjectSetup): string {
  return `${s.model}@${s.side}`;
}

/** The setup from what subject_info said (null when there's no usable model). */
export function subjectSetupOf(i: SubjectInfo | null): SubjectSetup | null {
  if (!i?.available) return null;
  return { model: i.model ?? '', side: i.inputSide && i.inputSide > 0 ? i.inputSide : SUBJECT_SIDE };
}

let setup: SubjectSetup | null = null;

/** Use this setup from now on; another model or size forgets the outlines made with the old one. */
export function applySubjectSetup(next: SubjectSetup | null) {
  const same = !!next && !!setup && next.model === setup.model && next.side === setup.side;
  if (same) return;
  if (setup) forgetSubjects();
  setup = next;
}

/** The setup in use now (null until the pack has been asked about). */
export function subjectSetup(): SubjectSetup | null {
  return setup;
}

let info: Promise<SubjectInfo | null> | null = null;
let infoFor: string | null = null;
/** Which model the subject effects will use and whether it's there (`again` asks anew, e.g. after unzipping a pack). */
export function subjectPack(again = false, model?: string): Promise<SubjectInfo | null> {
  const want = model ?? subjectChoice(viewerPrefs());
  if (!info || again || want !== infoFor) {
    infoFor = want;
    const p: Promise<SubjectInfo | null> = api.subjectInfo(want).catch(() => null).then((i) => {
      if (info === p) applySubjectSetup(subjectSetupOf(i));
      return i;
    });
    info = p;
  }
  return info;
}

// ---- outlines, worked out one at a time ------------------------------------------------------

type Compute = (src: string, s: SubjectSetup) => Promise<SubjectMask | null>;

interface Waiting {
  src: string;
  setup: SubjectSetup;
  urgent: boolean;
  seq: number;
  resolve: ((m: SubjectMask | null) => void)[];
}

const cache = new Map<string, SubjectMask | null>();
const waiting = new Map<string, Waiting>();
let aheadKeys: string[] = [];
let running: string | null = null;
let busy = false;
let generation = 0;
let seq = 0;
let compute: Compute = computeReal;

function remember(key: string, m: SubjectMask | null) {
  cache.delete(key);
  cache.set(key, m);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
}

/** Forget every outline (the vault locked, or another model was chosen). */
export function forgetSubjects() {
  generation += 1;
  cache.clear();
  for (const w of waiting.values()) w.resolve.forEach((r) => r(null));
  waiting.clear();
  aheadKeys = [];
}
void onLocked(() => forgetSubjects()).catch(() => {});

/** The outline of this picture if it's known already (null = it has none; undefined = not yet). */
export function knownSubject(src: string): SubjectMask | null | undefined {
  return setup ? cache.get(subjectKey(src, setup)) : undefined;
}

/** The outline of the picture at `src` (null if it can't be had); `urgent` puts it ahead of the pictures worked out in advance. */
export function subjectOf(src: string, urgent = false): Promise<SubjectMask | null> {
  const s = setup;
  if (!s) return subjectPack().then(() => (setup ? subjectOf(src, urgent) : null));
  const key = subjectKey(src, s);
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

/** The picture at `src` was left before its outline came: dropped unless it's wanted ahead or already running. */
export function subjectLetGo(src: string) {
  if (!setup) return;
  const key = subjectKey(src, setup);
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
 * Work out the outlines of these pictures in the background, most wanted
 * first (the next two pictures and the previous one: depth.ts pickAhead).
 * Each call replaces the last one's list.
 */
export function subjectAhead(srcs: string[], max = AHEAD_MAX) {
  const s = setup;
  if (!s) return;
  const keys = srcs.slice(0, max).map((src) => subjectKey(src, s));
  for (const k of aheadKeys) {
    const w = waiting.get(k);
    if (w && !keys.includes(k) && !w.urgent && k !== running) {
      waiting.delete(k);
      w.resolve.forEach((r) => r(null));
    }
  }
  aheadKeys = keys;
  for (const src of srcs.slice(0, max)) {
    const k = subjectKey(src, s);
    if (!cache.has(k) && !waiting.has(k)) waiting.set(k, { src, setup: s, urgent: false, seq: ++seq, resolve: [] });
  }
  void pump();
}

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
      let m: SubjectMask | null = null;
      try {
        m = savedId(job.src) == null ? await compute(job.src, job.setup) : await savedOr('outline', subjectTag(job.setup), job.src, () => compute(job.src, job.setup));
      } catch {
        m = null;
      } finally {
        running = null;
      }
      if (gen !== generation) continue;
      const w = waiting.get(key);
      waiting.delete(key);
      remember(key, m);
      w?.resolve.forEach((r) => r(m));
    }
  } finally {
    busy = false;
  }
}

/** Tests only: work out outlines some other way (null puts the real way back). */
export function setSubjectCompute(f: Compute | null) {
  compute = f ?? computeReal;
}

/** Tests only: use this setup without asking the pack. */
export function setSubjectSetupForTests(s: SubjectSetup | null) {
  forgetSubjects();
  setup = s;
}

async function computeReal(src: string, s: SubjectSetup): Promise<SubjectMask | null> {
  const side = s.side;
  const r = await fetch(src);
  if (!r.ok) return null;
  const blob = await r.blob();
  const opts = { imageOrientation: 'from-image', resizeWidth: side, resizeHeight: side, resizeQuality: 'high' } as ImageBitmapOptions;
  const bmp = await createImageBitmap(blob, opts);
  try {
    const c = new OffscreenCanvas(side, side);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, side, side).data;
    return await api.subjectEstimate({ width: side, height: side, model: s.model }, new Uint8Array(px.buffer, px.byteOffset, px.byteLength));
  } finally {
    bmp.close();
  }
}

// ---- speed tests (remembered for this session only) ------------------------------------------

export interface SubjectSpeed {
  ms: number;
  device: 'gpu' | 'cpu';
  loadMs: number;
}
const speeds = new Map<string, SubjectSpeed>();

export function lastSubjectSpeed(id: string): SubjectSpeed | undefined {
  return speeds.get(id);
}

export async function testSubjectSpeed(id: string): Promise<SubjectSpeed> {
  const r = await api.subjectBenchmark(id);
  const res = { ms: r.ms, device: r.device, loadMs: r.loadMs };
  speeds.set(id, res);
  return res;
}

// ---- where the subject is ---------------------------------------------------------------------

/** Where the subject is in a picture (all 0–1 of the picture's width and height). */
export interface SubjectStats {
  box: { x0: number; y0: number; x1: number; y1: number };
  /** The bottom middle of the box. */
  bottom: { x: number; y: number };
  /** The subject's middle (weighted by the outline): Lift-off grows from it. */
  centroid: { x: number; y: number };
  /** How much of the picture the subject covers (0–1). */
  coverage: number;
}

/** Below this the outline is treated as empty, above it as the whole picture (the effects are skipped). */
export const COVER_MIN = 0.004;
export const COVER_MAX = 0.9;

/**
 * Where the subject is, from its outline (null when there's no clear subject:
 * the outline is empty or covers almost everything).
 */
export function maskStats(m: SubjectMask | null | undefined): SubjectStats | null {
  if (!m || !m.w || !m.h || m.data.length < m.w * m.h) return null;
  const { w, h, data } = m;
  const step = Math.max(1, Math.floor(Math.min(w, h) / 256));
  let sum = 0;
  let sx = 0;
  let sy = 0;
  let n = 0;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step) {
      const v = data[y * w + x];
      n++;
      if (!v) continue;
      sum += v;
      sx += v * (x + 0.5);
      sy += v * (y + 0.5);
      if (v >= 128) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  const coverage = n ? sum / 255 / n : 0;
  if (coverage < COVER_MIN || coverage > COVER_MAX || !Number.isFinite(x0)) return null;
  const box = { x0: x0 / w, y0: y0 / h, x1: Math.min(1, (x1 + step) / w), y1: Math.min(1, (y1 + step) / h) };
  return {
    box,
    bottom: { x: (box.x0 + box.x1) / 2, y: box.y1 },
    centroid: { x: sx / sum / w, y: sy / sum / h },
    coverage,
  };
}

/** The subject's depth (0–1, the average of the depth map under the outline; null without a subject). */
export function subjectDepth(depth: DepthMap, mask: SubjectMask): number | null {
  if (!depth.w || !depth.h || !mask.w || !mask.h) return null;
  let sum = 0;
  let wsum = 0;
  const G = 96;
  for (let j = 0; j < G; j++)
    for (let i = 0; i < G; i++) {
      const u = (i + 0.5) / G;
      const v = (j + 0.5) / G;
      const m = mask.data[Math.min(mask.h - 1, Math.floor(v * mask.h)) * mask.w + Math.min(mask.w - 1, Math.floor(u * mask.w))];
      if (m < 128) continue;
      sum += depth.data[Math.min(depth.h - 1, Math.floor(v * depth.h)) * depth.w + Math.min(depth.w - 1, Math.floor(u * depth.w))] * m;
      wsum += m;
    }
  return wsum ? sum / wsum / 255 : null;
}

// ---- the movement --------------------------------------------------------------------------------

/** Lift-off: how much bigger the subject gets at 100%, how long it takes to come forward (ms). */
export const LIFT_GROW = 0.035;
export const LIFT_MS = 700;
/** The shadow: how much it darkens, how far it falls (down and right) and how soft it is, at 100% (share of the picture's height). */
export const SHADOW_DARK = 0.35;
export const SHADOW_OFFSET = { x: 0.009, y: 0.014 };
export const SHADOW_BLUR = 0.022;
/** Ease out: quick at first, coming to rest softly. */
export function easeOut(u: number): number {
  const t = Math.min(1, Math.max(0, u));
  return 1 - (1 - t) ** 3;
}

/** A value that eases to where it's told over LIFT_MS (switching on or off never jumps). */
export interface Fade {
  from: number;
  to: number;
  start: number;
}

export function newFade(v = 0): Fade {
  return { from: v, to: v, start: -Infinity };
}

export function fadeAt(f: Fade, t: number, ms = LIFT_MS): number {
  return f.from + (f.to - f.from) * easeOut((t - f.start) / ms);
}

/** Ease towards `to` from wherever the fade is now. */
export function fadeTo(f: Fade, to: number, t: number, ms = LIFT_MS) {
  if (f.to === to) return;
  f.from = fadeAt(f, t, ms);
  f.to = to;
  f.start = t;
}

export function fadeDone(f: Fade, t: number, ms = LIFT_MS): boolean {
  return t - f.start >= ms;
}

/** Everything the drawing needs for the subject layer (uv = 0–1 of the picture; `asp` = width / height). */
export interface SubjectFrame {
  /** Lift-off grows the subject from here, by this much. */
  centre: { x: number; y: number };
  lift: number;
  /** The subject's bottom middle after lifting (kept for the drawing; no turning any more). */
  pivot: { x: number; y: number };
  angle: number;
  breath: number;
  /** How far the outline is grown so the subject's old edge never shows (share of the picture's height). */
  grow: number;
  /** The shadow: darkness (0 = none), offset (uv) and softness (share of the height). */
  shadow: number;
  shadowOffset: { x: number; y: number };
  shadowBlur: number;
}

/** The subject layer for this moment: `lift` is how far Lift-off is on (0–1, eased) and its amount. */
export function subjectFrame(st: SubjectStats, asp: number, lift: { level: number; amount: number }): SubjectFrame {
  const a = asp > 0 && Number.isFinite(asp) ? asp : 1;
  const lv = Math.min(1, Math.max(0, lift.level));
  const scale = 1 + LIFT_GROW * Math.max(0, lift.amount) * lv;
  const c = st.centroid;
  const pivot = { x: c.x + (st.bottom.x - c.x) * scale, y: c.y + (st.bottom.y - c.y) * scale };
  const on = lv > 0;
  const k = Math.max(0, lift.amount);
  return {
    centre: { ...c },
    lift: scale,
    pivot,
    angle: 0,
    breath: 1,
    grow: on ? 0.003 : 0,
    shadow: SHADOW_DARK * lv,
    shadowOffset: { x: (SHADOW_OFFSET.x * k) / a, y: SHADOW_OFFSET.y * k },
    shadowBlur: SHADOW_BLUR * Math.sqrt(Math.max(0.1, k)) + 0.006,
  };
}

/** Where a point of the picture (uv) ends up once the subject layer has moved (the shader does the reverse). */
export function moveSubjectPoint(f: SubjectFrame, asp: number, p: { x: number; y: number }): { x: number; y: number } {
  const a = asp > 0 ? asp : 1;
  // Lifted (grown from the centre)…
  const lx = f.centre.x + (p.x - f.centre.x) * f.lift;
  const ly = f.centre.y + (p.y - f.centre.y) * f.lift;
  // …then turned and breathing around the bottom middle (worked out in square units so turning keeps the shape).
  const dx = (lx - f.pivot.x) * a * f.breath;
  const dy = (ly - f.pivot.y) * f.breath;
  const cs = Math.cos(f.angle);
  const sn = Math.sin(f.angle);
  return { x: f.pivot.x + (cs * dx - sn * dy) / a, y: f.pivot.y + sn * dx + cs * dy };
}

/** The reverse of moveSubjectPoint: which point of the picture shows here (as the shader does it). */
export function unmoveSubjectPoint(f: SubjectFrame, asp: number, q: { x: number; y: number }): { x: number; y: number } {
  const a = asp > 0 ? asp : 1;
  const dx = (q.x - f.pivot.x) * a;
  const dy = q.y - f.pivot.y;
  const cs = Math.cos(f.angle);
  const sn = Math.sin(f.angle);
  const rx = (cs * dx + sn * dy) / f.breath;
  const ry = (-sn * dx + cs * dy) / f.breath;
  const lx = f.pivot.x + rx / a;
  const ly = f.pivot.y + ry;
  return { x: f.centre.x + (lx - f.centre.x) / f.lift, y: f.centre.y + (ly - f.centre.y) / f.lift };
}

/** A flat depth map (everything at the same depth): the subject effects work without a depth pack. */
export function flatDepth(): DepthMap {
  return { w: 1, h: 1, data: new Uint8Array([128]) };
}
