// Where a video's keyframes are, read from its index without decoding
// anything: the MP4 sample tables (stss/stts/ctts/elst) or the WebM Cues.
// Seeking exactly to a keyframe means the decoder only has to decode that one
// picture, instead of everything from the keyframe before up to the asked
// moment. Used for video thumbnails (previews.ts, media.ts).
//
// Only byte ranges of the encrypted item are fetched (the vault protocol
// decrypts just those chunks); nothing is written anywhere.

import { WEBM_IDS, children, readUint } from './webm';

type Bytes = Uint8Array;

/** Keyframe presentation times in seconds (sorted), or 'all' when every frame is one. */
export type KeyframeIndex = number[] | 'all';

const u32 = (b: Bytes, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const i32 = (b: Bytes, p: number) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const u64 = (b: Bytes, p: number) => u32(b, p) * 2 ** 32 + u32(b, p + 4);
const type4 = (b: Bytes, p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

interface Box {
  type: string;
  /** Payload start and end. */
  start: number;
  end: number;
}

function boxes(b: Bytes, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = type4(b, p + 4);
    let head = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(b, p + 8);
      head = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < head) break;
    out.push({ type, start: p + head, end: Math.min(end, p + size) });
    p += size;
  }
  return out;
}

const find = (b: Bytes, box: Box, type: string) => boxes(b, box.start, box.end).find((x) => x.type === type);

/** Keyframe times of the first video track in an MP4 `moov` box's payload. Null = can't tell. */
export function mp4Keyframes(b: Bytes, moov: Box = { type: 'moov', start: 0, end: b.length }): KeyframeIndex | null {
  for (const trak of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak')) {
    const mdia = find(b, trak, 'mdia');
    if (!mdia) continue;
    const hdlr = find(b, mdia, 'hdlr');
    if (!hdlr || type4(b, hdlr.start + 8) !== 'vide') continue;
    const mdhd = find(b, mdia, 'mdhd');
    const stbl = (() => {
      const minf = find(b, mdia, 'minf');
      return minf && find(b, minf, 'stbl');
    })();
    if (!mdhd || !stbl) return null;
    const timescale = b[mdhd.start] === 1 ? u32(b, mdhd.start + 20) : u32(b, mdhd.start + 12);
    if (!timescale) return null;
    const stts = find(b, stbl, 'stts');
    if (!stts) return null;
    // Decode times of every sample.
    const dts: number[] = [];
    let t = 0;
    for (let i = 0, n = u32(b, stts.start + 4); i < n; i++) {
      const q = stts.start + 8 + i * 8;
      if (q + 8 > stts.end) break;
      const count = u32(b, q);
      const delta = u32(b, q + 4);
      for (let k = 0; k < count && dts.length < 2_000_000; k++) {
        dts.push(t);
        t += delta;
      }
    }
    if (!dts.length) return null; // a fragmented MP4: the samples are elsewhere
    const stss = find(b, stbl, 'stss');
    if (!stss) return 'all';
    // Composition offsets (B-frames) and the edit list's start shift.
    const ctts = find(b, stbl, 'ctts');
    // Run-length table: first sample of each run and its offset.
    const runStart: number[] = [];
    const runOff: number[] = [];
    if (ctts) {
      const signed = b[ctts.start] === 1;
      let s = 0;
      for (let i = 0, n = u32(b, ctts.start + 4); i < n; i++) {
        const q = ctts.start + 8 + i * 8;
        if (q + 8 > ctts.end) break;
        const count = u32(b, q);
        const off = signed ? i32(b, q + 4) : u32(b, q + 4);
        runStart.push(s);
        runOff.push(off);
        s += count;
      }
    }
    const offsetOf = (sample: number) => {
      let lo = 0;
      let hi = runStart.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (runStart[mid] <= sample) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return best >= 0 ? runOff[best] : 0;
    };
    let shift = 0;
    const edts = find(b, trak, 'edts');
    const elst = edts && find(b, edts, 'elst');
    if (elst) {
      const v1 = b[elst.start] === 1;
      const n = u32(b, elst.start + 4);
      for (let i = 0; i < n; i++) {
        const q = elst.start + 8 + i * (v1 ? 20 : 12);
        if (q + (v1 ? 20 : 12) > elst.end) break;
        const mediaTime = v1 ? u64(b, q + 8) : i32(b, q + 4);
        if (mediaTime !== -1 && mediaTime !== 0xffffffff && mediaTime < 2 ** 52) {
          shift = mediaTime;
          break;
        }
      }
    }
    const out: number[] = [];
    for (let i = 0, n = u32(b, stss.start + 4); i < n; i++) {
      const q = stss.start + 8 + i * 4;
      if (q + 4 > stss.end) break;
      const sample = u32(b, q) - 1;
      if (sample < 0 || sample >= dts.length) continue;
      const off = offsetOf(sample);
      out.push(Math.max(0, (dts[sample] + off - shift) / timescale));
    }
    return out.sort((a, z) => a - z);
  }
  return null;
}

/** Keyframe times from a WebM file's Cues element (its payload range). */
export function webmCueTimes(b: Bytes, cues: { start: number; end: number }, scale: number): number[] {
  const out: number[] = [];
  for (const cp of children(b, cues.start, cues.end)) {
    const t = children(b, cp.start, cp.end).find((x) => x.id === WEBM_IDS.CueTime);
    if (t) out.push((readUint(b, t) * scale) / 1e9);
  }
  return out.sort((a, z) => a - z);
}

// ---- fetching the index ---------------------------------------------------------------------

export type RangeReader = (start: number, end: number) => Promise<{ bytes: Bytes; total: number }>;

/** Reads byte ranges of a URL (the vault protocol answers Range requests). */
export function httpRanges(url: string): RangeReader {
  return async (start, end) => {
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    const m = /\/(\d+)\s*$/.exec(r.headers.get('Content-Range') ?? '');
    const total = m ? Number(m[1]) : r.status === 200 ? bytes.length : Infinity;
    return { bytes: r.status === 200 ? bytes.subarray(start, end) : bytes, total };
  };
}

const MAX_INDEX = 16 << 20;

async function mp4Index(read: RangeReader, first: { bytes: Bytes; total: number }): Promise<KeyframeIndex | null> {
  let p = 0;
  let head = first;
  let headAt = 0;
  for (let guard = 0; guard < 64 && p + 8 <= first.total; guard++) {
    if (p + 16 > headAt + head.bytes.length || p < headAt) {
      head = await read(p, Math.min(first.total, p + 64 * 1024));
      headAt = p;
    }
    const b = head.bytes;
    const q = p - headAt;
    let size = u32(b, q);
    const type = type4(b, q + 4);
    let hl = 8;
    if (size === 1) {
      size = u64(b, q + 8);
      hl = 16;
    } else if (size === 0) {
      size = first.total - p;
    }
    if (size < hl) return null;
    if (type === 'moov') {
      if (size > MAX_INDEX) return null;
      const moov = q + size <= b.length ? b.subarray(q, q + size) : (await read(p, p + size)).bytes;
      return mp4Keyframes(moov, { type: 'moov', start: hl, end: moov.length });
    }
    p += size;
  }
  return null;
}

async function webmIndex(read: RangeReader, first: { bytes: Bytes; total: number }): Promise<KeyframeIndex | null> {
  const b = first.bytes;
  const top = children(b, 0, b.length);
  const seg = top.find((e) => e.id === WEBM_IDS.Segment);
  if (!seg) return null;
  let scale = 1_000_000;
  let cuesAt: number | null = null;
  for (const e of children(b, seg.start, Math.min(seg.end, b.length))) {
    if (e.id === WEBM_IDS.Info) {
      const s = children(b, e.start, e.end).find((x) => x.id === WEBM_IDS.TimestampScale);
      if (s) scale = readUint(b, s);
    } else if (e.id === WEBM_IDS.Cues && e.end <= b.length) {
      return webmCueTimes(b, e, scale);
    } else if (e.id === 0x114d9b74) {
      // SeekHead: where the Cues are.
      for (const seek of children(b, e.start, e.end)) {
        const kids = children(b, seek.start, seek.end);
        const id = kids.find((x) => x.id === 0x53ab);
        const pos = kids.find((x) => x.id === 0x53ac);
        if (id && pos && readUint(b, id) === WEBM_IDS.Cues) cuesAt = seg.start + readUint(b, pos);
      }
    }
  }
  if (cuesAt == null || cuesAt >= first.total) return null;
  const h = await read(cuesAt, Math.min(first.total, cuesAt + 16));
  const el = children(h.bytes, 0, h.bytes.length)[0];
  if (!el || el.id !== WEBM_IDS.Cues) return null;
  const len = el.end - el.start;
  if (len > MAX_INDEX) return null;
  const all = await read(cuesAt, Math.min(first.total, cuesAt + el.start + len));
  const c = children(all.bytes, 0, all.bytes.length)[0];
  return c ? webmCueTimes(all.bytes, c, scale) : null;
}

/** Keyframe times of a video, from its index. Null when they can't be found cheaply. */
export async function readKeyframes(read: RangeReader): Promise<KeyframeIndex | null> {
  const first = await read(0, 256 * 1024);
  const b = first.bytes;
  if (b.length >= 8 && type4(b, 4) === 'ftyp') return mp4Index(read, first);
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return webmIndex(read, { bytes: b, total: first.total });
  return null;
}

/**
 * The time to seek to for a picture near `target`: the closest keyframe, if
 * one is within `slack` seconds (a tiny bit after it, so the seek lands on it
 * and not on the frame before), else `target` itself.
 */
export function keyframeNear(index: KeyframeIndex | null, target: number, slack: number, duration = Infinity): number {
  if (!index || index === 'all' || !index.length) return target;
  let best = -1;
  let bestD = Infinity;
  for (const k of index) {
    const d = Math.abs(k - target);
    if (d < bestD && k < duration - 0.05) {
      bestD = d;
      best = k;
    }
  }
  return best >= 0 && bestD <= slack ? best + 0.001 : target;
}
