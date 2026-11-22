// Prepared 3D for videos and GIFs: how it is saved and how it is played.
//
// Saved in the vault (derived.rs, kind "track"), per item and tag (the models
// and settings it was made with):
// - `<tag>.i`: the index ("MV3I" + JSON): which pieces there are, their times,
//   the tile size, the codec, whether it's finished.
// - `<tag>.s<n>`: piece n ("MV3S"): up to SEG_FRAMES frames, each frame's 3D
//   data packed into one picture of tiles (video3dmath.ts) and encoded as a
//   small video (VP9 / AV1 / H.264 with WebCodecs, or WebP pictures), the first
//   frame a key frame, so every piece can be decoded on its own.
//   Layout: "MV3S", u8 version, 3 bytes nothing, u32 header length (LE),
//   header JSON { codec, cw, ch, frames: [{ t, key, len, i }] }, the frames' bytes.
//
// Playing (TrackPlayer): the piece for the time on screen is read, decoded a
// few frames ahead, and the frame matching the video's exact frame time is
// handed out; frames already passed are let go. GIFs use the frame number as
// the time.

import { api } from './api';
import type { FrameInfo } from './video3dmath';
import { covers, frameStep, parseIndex, parseSegment, segmentFor, type Segment, type TrackIndex } from './trackformat';

export * from './trackformat';

// ---- finding an item's prepared 3D --------------------------------------------------------------

/** Looked up already: "item|tag wanted" → its index. */
const found = new Map<string, Promise<TrackIndex | null>>();
const subs = new Set<() => void>();

/** Prepared 3D changed for an item (made, extended or deleted; none = any): it is looked up again. */
export function trackChanged(item?: number) {
  if (item == null) found.clear();
  else for (const k of [...found.keys()]) if (k.startsWith(`${item}|`)) found.delete(k);
  subs.forEach((f) => f());
}

export function onTrackChange(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/**
 * The item's prepared 3D: under `want` (the tag the settings give now) when
 * there is one, else the most recently made one (any settings).
 */
export function findTrack(item: number, want: string): Promise<TrackIndex | null> {
  const key = `${item}|${want}`;
  const known = found.get(key);
  if (known) return known;
  const p = (async () => {
    try {
      const groups = await api.derivedSummary([item]);
      const tags = groups.filter((g) => g.kind === 'track').map((g) => g.model);
      if (!tags.length) return null;
      const order = tags.includes(want) ? [want, ...tags.filter((t) => t !== want)] : tags;
      let best: TrackIndex | null = null;
      for (const tag of order) {
        const i = parseIndex(await api.derivedGet(item, 'track', `${tag}.i`));
        if (!i || !i.segs.length) continue;
        if (tag === want) return i;
        if (!best || i.made > best.made) best = i;
      }
      return best;
    } catch {
      return null;
    }
  })();
  found.set(key, p);
  return p;
}

// ---- playing ---------------------------------------------------------------------------------------

type Img = VideoFrame | ImageBitmap;
interface Ready {
  t: number;
  img: Img;
  info: FrameInfo;
}

/** Frames decoded ahead of the one on screen. */
const AHEAD = 6;
/** Pieces kept read. */
const SEGS_KEEP = 3;

/**
 * Hands out each prepared frame as its video frame shows (`frameAt`). Decodes
 * a few frames ahead; a jump elsewhere starts again from that piece's first
 * frame (a moment without 3D while it catches up). `changed` is called when a
 * frame that was missing arrives.
 */
export class TrackPlayer {
  private segs = new Map<number, Promise<Segment | null>>();
  private decoder: VideoDecoder | null = null;
  private ready: Ready[] = [];
  /** Frames sent to the decoder and not out yet: timestamp → time and numbers. */
  private sent = new Map<number, { t: number; info: FrameInfo }>();
  private pos = -1;
  private k = 0;
  private want = 0;
  private gen = 0;
  private pumping = false;
  private closed = false;
  private broken = false;
  readonly step: number;

  constructor(private item: number, readonly index: TrackIndex, private changed: () => void) {
    this.step = frameStep(index);
  }

  private segment(pos: number): Promise<Segment | null> {
    const known = this.segs.get(pos);
    if (known) return known;
    const s = this.index.segs[pos];
    const p = s ? api.derivedGet(this.item, 'track', `${this.index.tag}.s${s.n}`).then(parseSegment).catch(() => null) : Promise.resolve(null);
    this.segs.set(pos, p);
    while (this.segs.size > SEGS_KEEP) {
      const far = [...this.segs.keys()].sort((a, b) => Math.abs(b - this.pos) - Math.abs(a - this.pos))[0];
      this.segs.delete(far);
    }
    return p;
  }

  /** The frame for time `t` (null: not decoded yet, or not prepared). */
  frameAt(t: number): Ready | null {
    if (this.closed || this.broken) return null;
    this.want = t;
    const tol = this.step / 2;
    // Let go of frames already passed (keeping the latest one at or before t).
    while (this.ready.length >= 2 && this.ready[1].t <= t + tol) this.ready.shift()!.img.close();
    const f = this.ready[0];
    // Only its own frame (the nearest): a neighbour would put the 3D a frame off on moving edges.
    // (A little more room when only every second frame was prepared, or the times are uneven.)
    const ok = !!f && f.t <= t + tol && t - f.t <= tol * 1.25;
    if (!ok && covers(this.index, t)) {
      // How far is still worth decoding through instead of starting again (about a second).
      const far = this.index.kind === 'gif' ? 12 : 1.2;
      if (this.pos < 0) this.seek(t);
      else if (f && f.t > t + tol) this.seek(t); // went back (or a GIF started over)
      else if (f && t - f.t > far) this.seek(t); // jumped ahead
      else if (!f && Math.abs(t - this.aim) > far) this.seek(t); // jumped while nothing was decoded yet
    }
    void this.pump();
    return ok ? f : null;
  }

  /** Where the last jump went. */
  private aim = 0;

  private seek(t: number) {
    this.aim = t;
    this.gen++;
    for (const r of this.ready) r.img.close();
    this.ready = [];
    this.sent.clear();
    if (this.decoder && this.decoder.state !== 'closed') {
      try {
        this.decoder.reset();
      } catch {
        /* configured again below */
      }
    }
    this.confCodec = null;
    this.pos = Math.max(0, segmentFor(this.index.segs, t, this.step / 2));
    this.k = 0;
  }

  /** The codec the decoder is set up for (pieces made on another computer may use another). */
  private confCodec: string | null = null;

  private ensureDecoder(s: Segment): boolean {
    if (s.codec === 'webp') return true;
    if (typeof VideoDecoder === 'undefined') {
      this.broken = true;
      return false;
    }
    if (!this.decoder || this.decoder.state === 'closed') {
      const gen = () => this.gen;
      this.decoder = new VideoDecoder({
        output: (frame) => {
          const meta = this.sent.get(frame.timestamp);
          this.sent.delete(frame.timestamp);
          if (!meta || this.closed) return frame.close();
          this.accept({ t: meta.t, img: frame, info: meta.info }, gen());
        },
        error: () => {
          // Can't decode here: no 3D for this video (it plays as usual).
          this.broken = true;
          this.changed();
        },
      });
      this.confCodec = null;
    }
    // (A piece always starts with a key frame, so setting up again between pieces is fine.)
    if (this.confCodec !== s.codec) {
      this.decoder.configure({ codec: s.codec, codedWidth: s.cw, codedHeight: s.ch, optimizeForLatency: true });
      this.confCodec = s.codec;
    }
    return true;
  }

  private accept(r: Ready, gen: number) {
    if (gen !== this.gen || this.closed) return r.img.close();
    // Already passed while it was being decoded.
    if (r.t < this.want - this.step * 1.5) return r.img.close();
    this.ready.push(r);
    // One that can show now (e.g. while paused, when no new video frame comes to ask).
    if (Math.abs(r.t - this.want) <= this.step) this.changed();
  }

  private async pump() {
    if (this.pumping || this.closed || this.broken) return;
    this.pumping = true;
    try {
      while (!this.closed && !this.broken) {
        const queued = this.ready.length + this.sent.size;
        if (queued >= AHEAD || this.pos < 0 || this.pos >= this.index.segs.length) break;
        const gen = this.gen;
        const pos = this.pos;
        const s = await this.segment(pos);
        if (gen !== this.gen) continue;
        if (!s || this.k >= s.frames.length) {
          this.pos++;
          this.k = 0;
          if (!s) continue;
          // The next piece read ahead.
          if (this.pos < this.index.segs.length) void this.segment(this.pos);
          continue;
        }
        if (!this.ensureDecoder(s)) break;
        const f = s.frames[this.k];
        const data = s.chunks[this.k];
        this.k++;
        if (s.codec === 'webp') {
          try {
            const img = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/webp' }));
            this.accept({ t: f.t, img, info: f.i }, gen);
          } catch {
            /* a damaged frame: skipped */
          }
          continue;
        }
        const ts = Math.round(f.t * 1e6);
        this.sent.set(ts, { t: f.t, info: f.i });
        try {
          this.decoder!.decode(new EncodedVideoChunk({ type: f.key ? 'key' : 'delta', timestamp: ts, data }));
        } catch {
          this.sent.delete(ts);
          // Out of step (e.g. a delta frame first): start that piece again.
          this.seek(this.want);
        }
        // The next piece is read well before it's needed (it comes from the vault, decrypted).
        if (this.k >= s.frames.length - 16 && this.pos + 1 < this.index.segs.length) void this.segment(this.pos + 1);
      }
    } finally {
      this.pumping = false;
    }
  }

  close() {
    this.closed = true;
    for (const r of this.ready) r.img.close();
    this.ready = [];
    this.sent.clear();
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      /* already gone */
    }
    this.decoder = null;
    this.segs.clear();
  }
}
