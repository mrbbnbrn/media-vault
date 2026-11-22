// Prepared 3D (video3d.ts): the per-frame work away from the window's thread.
// The window sends each frame's picture and what the models made of it; this
// calms it over time, makes the Layered 3D background (with background seen
// in earlier frames) and the subject's own layer, packs it all into one
// picture of tiles and encodes it (WebCodecs; WebP pictures if no video codec
// works here). Every SEG_FRAMES frames a finished piece goes back to be saved.
//
// In:  { id, op: 'init', w, h, fps, plate, subject }        → { id, codec }
//      { id, op: 'calm', t, rgba, depth, mask, holeSide }    → { id, depth, mask, hole, cut, moving }
//      { id, op: 'finish', fill, edges, info }               → { id, segment? }
//      { id, op: 'end' }                                     → { id, segment? }
// A piece: { bytes, t0, t1, frames }. Out on failure: { id, error }.

import type { DepthMap, SubjectMask } from './api';
import { refineEdges } from './layers';
import { composeFore, composePlate, holeSquare, plateHole } from './platemath';
import { SEG_FRAMES, packSegment } from './trackformat';
import {
  BG_FRESH, calmDepth, calmMask, COLS, lumaGrid, motionBetween, newBgMemory, packTiles, rememberBackground, ROWS,
  type BgMemory, type FrameInfo, type Motion,
} from './video3dmath';

type Msg =
  | { id: number; op: 'init'; w: number; h: number; fps: number; plate: boolean; subject: boolean }
  | { id: number; op: 'calm'; t: number; rgba: ArrayBuffer; depth: DepthMap; mask: SubjectMask | null; holeSide: number }
  | { id: number; op: 'finish'; fill: { data: ArrayBuffer; w: number; h: number } | null; edges: number; info: FrameInfo }
  | { id: number; op: 'end' };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

/** Video codecs tried in turn (the window must be able to decode it too). */
const CODECS = ['vp09.00.40.08', 'av01.0.08M.08', 'avc1.640033'];

let W = 0;
let H = 0;
let FPS = 30;
let codec = 'webp';
let wantPlate = false;
let wantSubject = false;
let encoder: VideoEncoder | null = null;
/** Encoded frames of the piece being made, by timestamp. */
const out = new Map<number, { bytes: Uint8Array; key: boolean }>();
let encodeError: string | null = null;
/** The frames of the piece being made, in order. */
let seg: { t: number; key: boolean; i: FrameInfo; ts: number; webp?: Uint8Array }[] = [];
let lastTs = -1;

// The last frame's state.
let prevLuma: Float32Array | null = null;
let prevDepth: DepthMap | null = null;
let prevMask: SubjectMask | null = null;
let bg: BgMemory | null = null;
// This frame's, between 'calm' and 'finish'.
let cur: { t: number; rgba: Uint8ClampedArray; depth: DepthMap; mask: SubjectMask | null; motion: Motion } | null = null;

function encoderConfig(c: string): VideoEncoderConfig {
  const cw = W * COLS;
  const ch = H * ROWS;
  const bitrate = Math.round(Math.min(20e6, Math.max(300e3, cw * ch * FPS * 0.05)));
  return { codec: c, width: cw, height: ch, bitrate, framerate: FPS, latencyMode: 'quality', ...(c.startsWith('avc1') ? { avc: { format: 'annexb' } } : {}) } as VideoEncoderConfig;
}

async function pickCodec(): Promise<string> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return 'webp';
  for (const c of CODECS) {
    try {
      const e = await VideoEncoder.isConfigSupported(encoderConfig(c));
      const d = await VideoDecoder.isConfigSupported({ codec: c, codedWidth: W * COLS, codedHeight: H * ROWS });
      if (e.supported && d.supported) return c;
    } catch {
      /* the next one */
    }
  }
  return 'webp';
}

function startEncoder() {
  encoder = new VideoEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      out.set(chunk.timestamp, { bytes, key: chunk.type === 'key' });
    },
    error: (e) => {
      encodeError = String(e);
    },
  });
  encoder.configure(encoderConfig(codec));
}

async function encodeFrame(packed: Uint8ClampedArray, ts: number, key: boolean): Promise<Uint8Array | undefined> {
  const cw = W * COLS;
  const ch = H * ROWS;
  if (codec === 'webp') {
    const c = new OffscreenCanvas(cw, ch);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('No canvas here.');
    ctx.putImageData(new ImageData(packed as unknown as Uint8ClampedArray<ArrayBuffer>, cw, ch), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/webp', quality: 0.9 });
    return new Uint8Array(await blob.arrayBuffer());
  }
  if (!encoder || encoder.state === 'closed') startEncoder();
  if (encodeError) throw new Error(encodeError);
  const frame = new VideoFrame(packed, { format: 'RGBA', codedWidth: cw, codedHeight: ch, timestamp: ts });
  try {
    encoder!.encode(frame, { keyFrame: key });
  } finally {
    frame.close();
  }
  return undefined;
}

/** The piece made so far, finished and packed (null: nothing in it). */
async function closeSegment(): Promise<{ bytes: Uint8Array; t0: number; t1: number; frames: number } | null> {
  if (!seg.length) return null;
  if (codec !== 'webp' && encoder && encoder.state === 'configured') await encoder.flush();
  if (encodeError) throw new Error(encodeError);
  const frames: { t: number; key: boolean; i: FrameInfo; bytes: Uint8Array }[] = [];
  for (const f of seg) {
    const got = f.webp ? { bytes: f.webp, key: true } : out.get(f.ts);
    // A frame the encoder dropped: left out (its neighbour shows instead).
    if (got) frames.push({ t: f.t, key: got.key, i: f.i, bytes: got.bytes });
  }
  out.clear();
  const first = seg[0];
  const last = seg[seg.length - 1];
  seg = [];
  if (!frames.length || !frames[0].key) return null;
  return { bytes: packSegment(codec, W * COLS, H * ROWS, frames), t0: first.t, t1: last.t, frames: frames.length };
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (m.op === 'init') {
      W = m.w;
      H = m.h;
      FPS = Math.min(120, Math.max(1, m.fps || 30));
      wantPlate = m.plate;
      wantSubject = m.subject;
      codec = await pickCodec();
      prevLuma = null;
      prevDepth = null;
      prevMask = null;
      bg = wantPlate ? newBgMemory(W, H) : null;
      seg = [];
      out.clear();
      lastTs = -1;
      encodeError = null;
      post({ id: m.id, codec });
      return;
    }
    if (m.op === 'calm') {
      const rgba = new Uint8ClampedArray(m.rgba);
      const luma = lumaGrid(rgba, W, H);
      const motion = motionBetween(luma, prevLuma);
      prevLuma = luma;
      const depth = calmDepth(m.depth, prevDepth, motion);
      const mask = wantSubject && m.mask ? calmMask(m.mask, prevMask, motion) : null;
      prevDepth = depth;
      prevMask = mask;
      cur = { t: m.t, rgba, depth, mask, motion };
      const hole = mask && m.holeSide > 0 ? holeSquare(mask, m.holeSide) : null;
      post({ id: m.id, depth, mask, hole, cut: motion.cut, moving: motion.moving });
      return;
    }
    if (m.op === 'finish') {
      const c = cur;
      cur = null;
      if (!c) throw new Error('No frame to finish.');
      const depth = c.mask && m.edges > 0 ? refineEdges(c.depth, c.mask, m.edges) : c.depth;
      let plate: Uint8Array | null = null;
      let fore: Uint8Array | null = null;
      if (c.mask) {
        if (wantPlate) {
          const fill = m.fill ? { data: new Uint8ClampedArray(m.fill.data), w: m.fill.w, h: m.fill.h } : null;
          plate = composePlate(c.rgba, W, H, c.mask, depth, fill, bg ? { rgb: bg.rgb, age: bg.age, fresh: BG_FRESH } : undefined);
          if (bg) rememberBackground(bg, c.rgba, plateHole(c.mask, W, H), c.motion);
        }
        fore = composeFore(c.rgba, W, H, c.mask, depth);
      } else if (bg) rememberBackground(bg, c.rgba, new Float32Array(W * H), c.motion);
      const packed = packTiles(W, H, { plate, fore, mask: c.mask, depth });
      // Timestamps must go up (a frame without a time of its own gets one just after the last).
      let ts = Math.round(c.t * 1e6);
      if (!(ts > lastTs)) ts = lastTs + 1;
      lastTs = ts;
      const key = seg.length === 0;
      const webp = await encodeFrame(packed, ts, key);
      seg.push({ t: c.t, key, i: m.info, ts, webp });
      let segment = null;
      if (seg.length >= SEG_FRAMES) segment = await closeSegment();
      if (segment) post({ id: m.id, segment }, [segment.bytes.buffer as ArrayBuffer]);
      else post({ id: m.id });
      return;
    }
    // 'end': the last piece, then the encoder is let go.
    const segment = await closeSegment();
    try {
      encoder?.close();
    } catch {
      /* already closed */
    }
    encoder = null;
    if (segment) post({ id: m.id, segment }, [segment.bytes.buffer as ArrayBuffer]);
    else post({ id: m.id });
  } catch (err) {
    post({ id: m.id, error: String(err) });
  }
};
