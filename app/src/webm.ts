// A small WebM writer for tiny preview clips: one video track (VP9 or VP8
// frames from WebCodecs), all in memory. Writes a known duration and an index
// (Cues) in front of the frames, so the clip loops and seeks without reading
// to the end. Also a matching reader for the tests.

export interface WebmFrame {
  data: Uint8Array;
  /** Presentation time in microseconds. */
  timestampUs: number;
  key: boolean;
}

export interface WebmTrack {
  codec: 'V_VP9' | 'V_VP8' | 'V_AV1';
  width: number;
  height: number;
  /** Codec setup bytes (needed for AV1 only). */
  codecPrivate?: Uint8Array;
}

// Element ids (with their length marker bits, as written).
const ID = {
  EBML: 0x1a45dfa3,
  EBMLVersion: 0x4286,
  EBMLReadVersion: 0x42f7,
  EBMLMaxIDLength: 0x42f2,
  EBMLMaxSizeLength: 0x42f3,
  DocType: 0x4282,
  DocTypeVersion: 0x4287,
  DocTypeReadVersion: 0x4285,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  FlagLacing: 0x9c,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
} as const;

type Bytes = Uint8Array;

function concat(parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function idBytes(id: number): Bytes {
  const out: number[] = [];
  let x = id;
  while (x > 0) {
    out.unshift(x & 0xff);
    x = Math.floor(x / 256);
  }
  return Uint8Array.from(out);
}

/** EBML variable-length size, shortest form. */
export function vint(n: number): Bytes {
  for (let len = 1; len <= 8; len++) {
    // All ones is reserved for "unknown size".
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let x = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = x & 0xff;
        x = Math.floor(x / 256);
      }
      out[0] |= 1 << (8 - len);
      return out;
    }
  }
  throw new Error('too big');
}

function uintBytes(n: number, fixed?: number): Bytes {
  const out: number[] = [];
  let x = Math.max(0, Math.floor(n));
  do {
    out.unshift(x & 0xff);
    x = Math.floor(x / 256);
  } while (x > 0);
  while (fixed && out.length < fixed) out.unshift(0);
  return Uint8Array.from(out);
}

const el = (id: number, body: Bytes): Bytes => concat([idBytes(id), vint(body.length), body]);
const master = (id: number, children: Bytes[]) => el(id, concat(children));
const uint = (id: number, n: number, fixed?: number) => el(id, uintBytes(n, fixed));
const str = (id: number, s: string) => el(id, new TextEncoder().encode(s));
function float(id: number, x: number): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return el(id, b);
}

/** Frames (in presentation order) → a complete WebM file. */
export function writeWebm(track: WebmTrack, frames: WebmFrame[], durationUs?: number): Uint8Array {
  if (!frames.length) throw new Error('no frames');
  const sorted = [...frames].sort((a, b) => a.timestampUs - b.timestampUs);
  const ms = (us: number) => Math.round(us / 1000);
  const last = sorted[sorted.length - 1];
  const step = sorted.length > 1 ? (last.timestampUs - sorted[0].timestampUs) / (sorted.length - 1) : 40_000;
  const dur = durationUs ?? last.timestampUs + step;

  // Clusters: a new one at every keyframe (and at least every 30 s).
  const clusters: { time: number; bytes: Bytes }[] = [];
  let cur: { time: number; blocks: Bytes[] } | null = null;
  const flush = () => {
    if (cur) clusters.push({ time: cur.time, bytes: master(ID.Cluster, [uint(ID.Timestamp, cur.time), ...cur.blocks]) });
    cur = null;
  };
  for (const f of sorted) {
    const t = ms(f.timestampUs);
    if (!cur || f.key || t - cur.time > 30_000) {
      flush();
      cur = { time: t, blocks: [] };
    }
    const head = new Uint8Array(4);
    head[0] = 0x81; // track 1
    new DataView(head.buffer).setInt16(1, t - cur.time);
    head[3] = f.key ? 0x80 : 0;
    cur.blocks.push(el(ID.SimpleBlock, concat([head, f.data])));
  }
  flush();

  const info = master(ID.Info, [uint(ID.TimestampScale, 1_000_000), float(ID.Duration, dur / 1000), str(ID.MuxingApp, 'Media Vault'), str(ID.WritingApp, 'Media Vault')]);
  const entry: Bytes[] = [
    uint(ID.TrackNumber, 1),
    uint(ID.TrackUID, 1),
    uint(ID.TrackType, 1),
    uint(ID.FlagLacing, 0),
    str(ID.CodecID, track.codec),
  ];
  if (track.codecPrivate?.length) entry.push(el(ID.CodecPrivate, track.codecPrivate));
  entry.push(master(ID.Video, [uint(ID.PixelWidth, track.width), uint(ID.PixelHeight, track.height)]));
  const tracks = master(ID.Tracks, [master(ID.TrackEntry, entry)]);

  // Cues sit before the clusters; positions are written with a fixed size so
  // the length of the index doesn't depend on the numbers in it.
  const cues = (positions: number[]) =>
    master(ID.Cues, clusters.map((c, i) => master(ID.CuePoint, [
      uint(ID.CueTime, c.time),
      master(ID.CueTrackPositions, [uint(ID.CueTrack, 1), uint(ID.CueClusterPosition, positions[i], 8)]),
    ])));
  const cuesLen = cues(clusters.map(() => 0)).length;
  const positions: number[] = [];
  let at = info.length + tracks.length + cuesLen;
  for (const c of clusters) {
    positions.push(at);
    at += c.bytes.length;
  }
  const header = master(ID.EBML, [
    uint(ID.EBMLVersion, 1),
    uint(ID.EBMLReadVersion, 1),
    uint(ID.EBMLMaxIDLength, 4),
    uint(ID.EBMLMaxSizeLength, 8),
    str(ID.DocType, 'webm'),
    uint(ID.DocTypeVersion, 4),
    uint(ID.DocTypeReadVersion, 2),
  ]);
  const segment = master(ID.Segment, [info, tracks, cues(positions), ...clusters.map((c) => c.bytes)]);
  return concat([header, segment]);
}

// ---- reading (tests, and keyframe times of WebM videos) --------------------------------------

export interface EbmlElement {
  id: number;
  /** Where the element's data starts and ends in the buffer. */
  start: number;
  end: number;
}

function readVint(b: Bytes, p: number, keepMarker: boolean): { value: number; len: number } | null {
  if (p >= b.length) return null;
  const first = b[p];
  let len = 1;
  while (len <= 8 && !(first & (1 << (8 - len)))) len++;
  if (len > 8 || p + len > b.length) return null;
  let value = keepMarker ? first : first & ((1 << (8 - len)) - 1);
  let allOnes = value === (1 << (8 - len)) - 1;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[p + i];
    if (b[p + i] !== 0xff) allOnes = false;
  }
  return { value: !keepMarker && allOnes ? -1 : value, len };
}

/** The elements directly inside [start, end). Unknown sizes run to `end`. */
export function children(b: Bytes, start: number, end: number): EbmlElement[] {
  const out: EbmlElement[] = [];
  let p = start;
  while (p < end) {
    const id = readVint(b, p, true);
    if (!id) break;
    const size = readVint(b, p + id.len, false);
    if (!size) break;
    const s = p + id.len + size.len;
    const e = size.value < 0 ? end : Math.min(end, s + size.value);
    out.push({ id: id.value, start: s, end: e });
    if (size.value < 0 || s + size.value > end) break;
    p = e;
  }
  return out;
}

export function readUint(b: Bytes, e: EbmlElement): number {
  let x = 0;
  for (let i = e.start; i < e.end; i++) x = x * 256 + b[i];
  return x;
}

export function readFloat(b: Bytes, e: EbmlElement): number {
  const v = new DataView(b.buffer, b.byteOffset + e.start, e.end - e.start);
  return e.end - e.start === 4 ? v.getFloat32(0) : v.getFloat64(0);
}

export const WEBM_IDS = ID;

/** Every frame of a WebM file this module wrote (or any simple one): time (ms) and keyframe flag. */
export function readWebmFrames(b: Bytes): { width: number; height: number; codec: string; durationMs: number; frames: { ms: number; key: boolean; size: number }[]; cues: { ms: number; pos: number }[] } {
  const top = children(b, 0, b.length);
  const seg = top.find((e) => e.id === ID.Segment);
  if (!seg) throw new Error('no segment');
  const out = { width: 0, height: 0, codec: '', durationMs: 0, frames: [] as { ms: number; key: boolean; size: number }[], cues: [] as { ms: number; pos: number }[] };
  let scale = 1_000_000;
  for (const e of children(b, seg.start, seg.end)) {
    if (e.id === ID.Info) {
      for (const c of children(b, e.start, e.end)) {
        if (c.id === ID.TimestampScale) scale = readUint(b, c);
        if (c.id === ID.Duration) out.durationMs = (readFloat(b, c) * scale) / 1e6;
      }
    } else if (e.id === ID.Tracks) {
      const t = children(b, e.start, e.end).find((x) => x.id === ID.TrackEntry);
      for (const c of t ? children(b, t.start, t.end) : []) {
        if (c.id === ID.CodecID) out.codec = new TextDecoder().decode(b.subarray(c.start, c.end));
        if (c.id === ID.Video) {
          for (const v of children(b, c.start, c.end)) {
            if (v.id === ID.PixelWidth) out.width = readUint(b, v);
            if (v.id === ID.PixelHeight) out.height = readUint(b, v);
          }
        }
      }
    } else if (e.id === ID.Cues) {
      for (const cp of children(b, e.start, e.end)) {
        let ms = 0;
        let pos = -1;
        for (const c of children(b, cp.start, cp.end)) {
          if (c.id === ID.CueTime) ms = (readUint(b, c) * scale) / 1e6;
          if (c.id === ID.CueTrackPositions) {
            const p = children(b, c.start, c.end).find((x) => x.id === ID.CueClusterPosition);
            if (p) pos = readUint(b, p);
          }
        }
        out.cues.push({ ms, pos });
      }
    } else if (e.id === ID.Cluster) {
      let base = 0;
      for (const c of children(b, e.start, e.end)) {
        if (c.id === ID.Timestamp) base = readUint(b, c);
        if (c.id === ID.SimpleBlock) {
          const tn = readVint(b, c.start, false);
          if (!tn) continue;
          const rel = new DataView(b.buffer, b.byteOffset + c.start + tn.len, 2).getInt16(0);
          const flags = b[c.start + tn.len + 2];
          out.frames.push({ ms: ((base + rel) * scale) / 1e6, key: !!(flags & 0x80), size: c.end - c.start - tn.len - 3 });
        }
      }
    }
  }
  return out;
}
