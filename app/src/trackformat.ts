// Prepared 3D for videos and GIFs: the saved format (track3d.ts has the
// overview). No imports that need the window: the preparing worker uses it too.

import type { FrameInfo } from './video3dmath';

/** Frames per saved piece. */
export const SEG_FRAMES = 48;

export interface TrackSeg {
  /** Its number (the `.s<n>` in its name). */
  n: number;
  /** First and last frame's time (seconds; GIFs: frame numbers). */
  t0: number;
  t1: number;
  frames: number;
  bytes: number;
}

/**
 * What a video's Prepare 3D window was set to: its own 3D (the pictures' 3D switches never apply to it).
 * Models: '' = the one the pictures use; fill 'simple' = Simple. Lift-off, 3D only on the subject and the
 * calmer camera are only how it plays (changed without preparing again); the rest is in the saved 3D.
 */
export interface Video3dChoices {
  depthModel: string;
  lift: boolean;
  liftAmount: number;
  subjectOnly: boolean;
  edges: boolean;
  edgesAmount: number;
  layered: boolean;
  fillModel: string;
  /** The fill on every 1st–3rd frame (the others reuse it). */
  fillEvery: number;
  subjectModel: string;
  size: number;
  every: number;
  calm: boolean;
}

/** The sizes prepared 3D can be made at (long side). */
export const VIDEO3D_SIZES = [512, 768, 1024] as const;

const modelId = (v: unknown) => (typeof v === 'string' && /^[a-z0-9-]{0,40}$/.test(v) ? v : '');
const amount = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(hi, Math.max(lo, v)) : d);

/** The Prepare 3D window's choices read safely (what it was last set to, or a video's own). */
export function cleanChoices(c: Partial<Video3dChoices> | null | undefined): Video3dChoices {
  const x = c ?? {};
  const fe = x.fillEvery;
  return {
    depthModel: modelId(x.depthModel),
    lift: !!x.lift,
    liftAmount: amount(x.liftAmount, 0.3, 3, 1),
    subjectOnly: !!x.subjectOnly,
    edges: !!x.edges,
    edgesAmount: amount(x.edgesAmount, 0.2, 1, 0.7),
    layered: !!x.layered,
    fillModel: modelId(x.fillModel),
    fillEvery: fe === 2 || fe === 3 ? fe : 1,
    subjectModel: modelId(x.subjectModel),
    size: (VIDEO3D_SIZES as readonly number[]).includes(x.size ?? 0) ? x.size! : 768,
    every: x.every === 2 ? 2 : 1,
    calm: x.calm !== false,
  };
}

/** Ticked effects that need the subject's outline. */
export function needsOutline(c: Pick<Video3dChoices, 'lift' | 'subjectOnly' | 'edges' | 'layered'>): boolean {
  return c.lift || c.subjectOnly || c.edges || c.layered;
}

export interface TrackIndex {
  v: 1;
  tag: string;
  kind: 'video' | 'gif';
  /** One tile's size; the packed picture is 3w × 2h. */
  w: number;
  h: number;
  codec: string;
  segs: TrackSeg[];
  /** Every frame (1) or every second frame (2). */
  every: number;
  /** All of the video is prepared (else up to the last piece). */
  complete: boolean;
  /** What it holds besides the depth. */
  has: { subject: boolean; plate: boolean };
  /** What it was made with (for labels). */
  models: { depth: string; subject: string; fill: string; edges: number };
  /** The video's length (seconds; GIFs: frames), when known. */
  duration: number;
  made: number;
  /** The choices it was prepared with (absent: prepared before 2026-11-23's Prepare 3D window). */
  choices?: Video3dChoices;
}

/** How a prepared video plays: only what was ticked for it (and what its saved 3D holds). lift 0 = off. */
export function trackLook(i: TrackIndex): { lift: number; subjectOnly: boolean; layered: boolean; calm: boolean } {
  const c = i.choices;
  // Prepared before the window: everything its saved 3D holds.
  if (!c) return { lift: i.has.subject ? 1 : 0, subjectOnly: false, layered: i.has.plate, calm: true };
  return {
    lift: c.lift && i.has.subject ? Math.min(3, Math.max(0.3, Number.isFinite(c.liftAmount) ? c.liftAmount : 1)) : 0,
    subjectOnly: c.subjectOnly && i.has.subject,
    layered: c.layered && i.has.plate,
    calm: c.calm !== false,
  };
}

export interface SegFrame {
  t: number;
  key: boolean;
  len: number;
  i: FrameInfo;
}

export interface Segment {
  codec: string;
  cw: number;
  ch: number;
  frames: SegFrame[];
  /** Each frame's bytes, in order. */
  chunks: Uint8Array[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function packIndex(i: TrackIndex): Uint8Array {
  const j = enc.encode(JSON.stringify(i));
  const out = new Uint8Array(4 + j.length);
  out.set(enc.encode('MV3I'));
  out.set(j, 4);
  return out;
}

export function parseIndex(b: Uint8Array | null | undefined): TrackIndex | null {
  if (!b || b.length < 6 || dec.decode(b.subarray(0, 4)) !== 'MV3I') return null;
  try {
    const i = JSON.parse(dec.decode(b.subarray(4))) as TrackIndex;
    if (i.v !== 1 || !Array.isArray(i.segs) || !(i.w > 0) || !(i.h > 0) || typeof i.codec !== 'string') return null;
    return i;
  } catch {
    return null;
  }
}

export function packSegment(codec: string, cw: number, ch: number, frames: { t: number; key: boolean; i: FrameInfo; bytes: Uint8Array }[]): Uint8Array {
  const head = enc.encode(JSON.stringify({ codec, cw, ch, frames: frames.map((f) => ({ t: f.t, key: f.key, len: f.bytes.length, i: f.i })) }));
  const body = frames.reduce((n, f) => n + f.bytes.length, 0);
  const out = new Uint8Array(12 + head.length + body);
  out.set(enc.encode('MV3S'));
  out[4] = 1;
  new DataView(out.buffer).setUint32(8, head.length, true);
  out.set(head, 12);
  let o = 12 + head.length;
  for (const f of frames) {
    out.set(f.bytes, o);
    o += f.bytes.length;
  }
  return out;
}

export function parseSegment(b: Uint8Array | null | undefined): Segment | null {
  if (!b || b.length < 12 || dec.decode(b.subarray(0, 4)) !== 'MV3S' || b[4] !== 1) return null;
  try {
    const hl = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(8, true);
    if (12 + hl > b.length) return null;
    const h = JSON.parse(dec.decode(b.subarray(12, 12 + hl))) as { codec: string; cw: number; ch: number; frames: SegFrame[] };
    const chunks: Uint8Array[] = [];
    let o = 12 + hl;
    for (const f of h.frames) {
      if (!(f.len >= 0) || o + f.len > b.length) return null;
      chunks.push(b.subarray(o, o + f.len));
      o += f.len;
    }
    return { codec: h.codec, cw: h.cw, ch: h.ch, frames: h.frames, chunks };
  } catch {
    return null;
  }
}

/** The piece (its place in `segs`) holding time `t`: the last one starting at or before it (-1: before the first). */
export function segmentFor(segs: TrackSeg[], t: number, tol: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].t0 <= t + tol) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Time between two prepared frames (seconds; GIFs: frames), from the first piece that has two. */
export function frameStep(i: TrackIndex): number {
  for (const s of i.segs) if (s.frames > 1 && s.t1 > s.t0) return (s.t1 - s.t0) / (s.frames - 1);
  return i.kind === 'gif' ? i.every : i.every / 30;
}

/** The time `t` falls within what's prepared (with half a frame to spare at the ends). */
export function covers(i: TrackIndex, t: number): boolean {
  if (!i.segs.length) return false;
  const half = frameStep(i) / 2;
  return t >= i.segs[0].t0 - half && t <= i.segs[i.segs.length - 1].t1 + half;
}

/**
 * How preparing works now: raised when a change makes newly prepared videos better, so ones prepared
 * before count as "made with other settings" (they still play; the 3D menu offers to prepare them again).
 * 2: smoothed with later frames too, cleaner outline, more bits (2026-11-23).
 */
export const TRACK_WAY = 2;

/**
 * The tag of prepared 3D: the models and settings it's made with (derived.rs track names). `plate`:
 * Layered 3D's fill made too (else "noplate"); `fillEvery` > 1 adds "_n<n>".
 */
export function trackTag(p: { depth: string; subject: string; edges: number; fill: string; size: number; every: number; plate?: boolean; fillEvery?: number }): string {
  const fill = !p.subject ? 'none' : p.plate === false ? 'noplate' : p.fill || 'simple';
  const n = p.plate !== false && p.subject && (p.fillEvery ?? 1) > 1 ? `_n${p.fillEvery}` : '';
  return `${p.depth}_${p.subject || 'none'}_e${p.edges.toFixed(2)}_${fill}_w${p.size}_f${p.every}${n}_v${TRACK_WAY}`;
}

/** The parts of a track tag (null: not one). */
export function parseTrackTag(tag: string): { depth: string; subject: string; edges: number; fill: string; size: number; every: number; plate: boolean; fillEvery: number } | null {
  const m = /^(.+?@\d+~[\d.]+)_(.+?)_e([\d.]+)_([a-z0-9-]+)_w(\d+)_f(\d)(?:_n(\d))?(?:_v\d+)?$/.exec(tag);
  if (!m) return null;
  const fill = m[4] === 'none' || m[4] === 'noplate' ? '' : m[4];
  return { depth: m[1], subject: m[2] === 'none' ? '' : m[2], edges: Number(m[3]), fill, size: Number(m[5]), every: Number(m[6]), plate: m[4] !== 'none' && m[4] !== 'noplate', fillEvery: m[7] ? Number(m[7]) : 1 };
}
