// Media helpers: thumbnail making (in memory, never on disk), GIF / animated
// WebP length, and the playable item shape shared by every player.

import { api, mediaUrl, localUrl, thumbUrl, type Item, type Kind, type LocalItem } from './api';
import type { Entry } from './playlist';
import { decodeText, fetchBytes, pdfThumbCanvas, textThumbCanvas } from './docs';

/** Something a player can show: from the vault or from a dropped folder. */
export interface PlayItem extends Entry {
  kind: Kind;
  src: string;
  thumb: string | null;
  durationMs: number | null;
  /** Vault item id (favourites, weights); null for files outside the vault. */
  itemId: number | null;
  /** Its folder in the vault (where saved frames and GIFs go). */
  folderId: number | null;
  favourite: boolean;
  /** Videos: where you left off last time (ms). */
  resumeMs?: number | null;
  /** Videos: a small preview clip (frame strip) exists. */
  preview?: boolean;
  /** Picture size when known (for the grow-from-the-tile animation). */
  width?: number | null;
  height?: number | null;
}

export function fromItem(i: Item): PlayItem {
  return {
    key: `v${i.id}`,
    name: i.name,
    added: i.importedAt,
    size: i.size,
    weight: i.weight,
    kind: i.kind,
    src: mediaUrl(i.id),
    thumb: i.thumb === 'ok' ? thumbUrl(i.id) : null,
    durationMs: i.durationMs,
    itemId: i.id,
    folderId: i.folderId,
    favourite: i.favourite,
    resumeMs: i.resumeMs,
    preview: i.preview,
    width: i.width,
    height: i.height,
  };
}

export function fromLocal(l: LocalItem): PlayItem {
  return {
    key: `l${l.key}`,
    name: l.name,
    added: l.modified,
    size: l.size,
    weight: 1,
    kind: l.kind,
    src: localUrl(l.key),
    thumb: null,
    durationMs: null,
    itemId: null,
    folderId: null,
    favourite: false,
  };
}

export function formatTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ---- animation length -------------------------------------------------------------------

/** Total length of one loop of an animated GIF, in ms (0 if not animated). */
export function gifDurationMs(b: Uint8Array): number {
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return 0;
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 0x07) + 1)); // global colour table
  let total = 0;
  let frames = 0;
  const skipBlocks = () => {
    while (p < b.length && b[p] !== 0) p += b[p] + 1;
    p += 1;
  };
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) break; // trailer
    if (t === 0x21) {
      if (b[p + 1] === 0xf9 && b[p + 2] === 4) {
        const d = b[p + 4] | (b[p + 5] << 8);
        total += (d < 2 ? 10 : d) * 10; // browsers treat 0–1 as 100 ms
      }
      p += 2;
      skipBlocks();
    } else if (t === 0x2c) {
      frames += 1;
      const flags = b[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * (1 << ((flags & 0x07) + 1));
      p += 1; // LZW minimum code size
      skipBlocks();
    } else {
      break;
    }
  }
  return frames > 1 ? total : 0;
}

/** Total length of an animated WebP, in ms (0 if not animated). */
export function webpDurationMs(b: Uint8Array): number {
  if (b.length < 16 || String.fromCharCode(...b.slice(8, 12)) !== 'WEBP') return 0;
  let p = 12;
  let total = 0;
  let frames = 0;
  while (p + 8 <= b.length) {
    const id = String.fromCharCode(...b.slice(p, p + 4));
    const size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
    if (id === 'ANMF' && p + 8 + 16 <= b.length) {
      const q = p + 8 + 12;
      total += b[q] | (b[q + 1] << 8) | (b[q + 2] << 16);
      frames += 1;
    }
    p += 8 + size + (size & 1);
  }
  return frames > 1 ? total : 0;
}

export function animationMs(bytes: Uint8Array): number {
  return gifDurationMs(bytes) || webpDurationMs(bytes);
}

// ---- thumbnails -------------------------------------------------------------------------

const THUMB_MAX = 360;

function canvasToBytes(c: HTMLCanvasElement): Promise<number[]> {
  return new Promise((resolve, reject) =>
    c.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('encode failed'));
        blob.arrayBuffer().then((a) => resolve(Array.from(new Uint8Array(a))), reject);
      },
      'image/jpeg',
      0.82,
    ),
  );
}

function draw(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function imageThumb(id: number) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = mediaUrl(id);
  await withTimeout(img.decode(), 30_000);
  const bytes = await canvasToBytes(draw(img, img.naturalWidth, img.naturalHeight));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  img.src = '';
  return { bytes, w, h, ms: null as number | null };
}

async function videoThumb(id: number) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous';
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  try {
    v.src = mediaUrl(id);
    await withTimeout(
      new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('unsupported'));
      }),
      30_000,
    );
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const at = Math.min(dur * 0.1, 5);
    if (at > 0.05) {
      await withTimeout(
        new Promise<void>((res) => {
          v.onseeked = () => res();
          v.currentTime = at;
        }),
        15_000,
      );
    }
    if (!v.videoWidth) throw new Error('no picture');
    const bytes = await canvasToBytes(draw(v, v.videoWidth, v.videoHeight));
    return { bytes, w: v.videoWidth, h: v.videoHeight, ms: Math.round(dur * 1000) || null };
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

/** First lines of a text file as a little page. */
async function textThumb(id: number) {
  const bytes = await fetchBytes(mediaUrl(id));
  const c = textThumbCanvas(decodeText(bytes.subarray(0, 64 * 1024)).text, THUMB_MAX, Math.round(THUMB_MAX * 0.75));
  return { bytes: await canvasToBytes(c), w: null as number | null, h: null as number | null, ms: null as number | null };
}

async function pdfThumb(id: number) {
  const bytes = await fetchBytes(mediaUrl(id));
  const { canvas } = await pdfThumbCanvas(bytes, THUMB_MAX);
  return { bytes: await canvasToBytes(canvas), w: canvas.width as number | null, h: canvas.height as number | null, ms: null as number | null };
}

/** Make a thumbnail for a vault item, in memory. Used by the background loop and the self-test. */
export function makeThumb(id: number, kind: Kind) {
  switch (kind) {
    case 'video':
      return videoThumb(id);
    case 'text':
      return textThumb(id);
    case 'pdf':
      return pdfThumb(id);
    default:
      return imageThumb(id);
  }
}

let running = false;
let wake: (() => void) | null = null;
const listeners = new Set<(id: number) => void>();

/** Ask the thumbnailer to look for new work now (after an import). */
export function kickThumbnails() {
  wake?.();
}

/** Called whenever a thumbnail is ready, so grids can refresh that tile. */
export function onThumb(cb: (id: number) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Background loop that makes thumbnails for items that don't have one yet,
 * two at a time. Stops when the vault locks.
 */
export function startThumbnailer(): () => void {
  if (running) return () => {};
  running = true;
  let stopped = false;
  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake = () => {
        clearTimeout(t);
        r();
      };
    });
  const work = async (t: { id: number; kind: Kind }) => {
    try {
      const r = await makeThumb(t.id, t.kind);
      if (stopped) return;
      await api.saveThumb(t.id, r.bytes, r.w, r.h, r.ms);
      listeners.forEach((l) => l(t.id));
    } catch {
      if (!stopped) await api.thumbFailed(t.id).catch(() => {});
      listeners.forEach((l) => l(t.id));
    }
  };
  (async () => {
    while (!stopped) {
      let tasks: { id: number; kind: Kind }[] = [];
      try {
        tasks = await api.thumbsNeeded(8);
      } catch {
        break; // locked
      }
      if (!tasks.length) {
        await sleep(4000);
        continue;
      }
      for (let i = 0; i < tasks.length && !stopped; i += 2) {
        await Promise.all(tasks.slice(i, i + 2).map(work));
      }
    }
    running = false;
  })();
  return () => {
    stopped = true;
    running = false;
    wake?.();
  };
}
