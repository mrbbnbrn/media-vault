// Browser preview only (no Tauri): a made-up library when the address has
// `?griddemo` (or `?griddemo=50000` for that many items), so the grid extras can be
// tried without the real app. Pictures come from whatever serves
// vault.localhost (the UI tests answer those requests). Never used in the app.

import type { FaceBox, FolderCard, Item, Kind } from './api';

const SIZES: [number, number][] = [[1600, 1200], [1200, 1600], [1920, 1080], [1000, 1000]];

function demoCount(): number {
  if (typeof location === 'undefined') return 0;
  const m = /[?&]griddemo(?:=(\d+))?/.exec(location.search);
  if (!m) return 0;
  return Math.max(1, Math.min(100_000, Number(m[1] ?? 3000)));
}

/** The face drawn into demo picture `id` (the UI tests draw the same one). */
export function demoFace(id: number): FaceBox {
  const [w, h] = SIZES[id % 4];
  const fw = 0.12 + ((id * 17) % 20) / 100;
  const fh = (fw * w) / h;
  return {
    id: id * 10, frameMs: 0, x: 0.05 + (((id * 37) % 60) / 60) * (0.9 - fw), y: 0.05 + (((id * 53) % 50) / 50) * Math.max(0, 0.9 - fh),
    w: fw, h: fh, person: id % 3 === 0 ? 1 : null,
  };
}

/** `&gridvideos` makes every other demo item a video (for trying video previews). */
const manyVideos = typeof location !== 'undefined' && /[?&]gridvideos\b/.test(location.search);

function kindOf(id: number): Kind {
  if (id % 7 === 0 || (manyVideos && id % 2 === 0)) return 'video';
  if (id % 11 === 0) return 'gif';
  return 'image';
}

/** A made-up colour sketch for demo picture `id` (the UI tests draw thumbnails in the same colours). */
export function demoSketch(id: number): string {
  const [w, h] = SIZES[id % 4];
  const cols = w / h >= 1.2 ? 4 : h / w >= 1.2 ? 3 : 3;
  const rows = w / h >= 1.2 ? 3 : h / w >= 1.2 ? 4 : 3;
  let out = `${cols}${rows}`;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const v = (k: number) => ((id * k + r * 5 + c * 3) % 16).toString(16);
      out += v(7) + v(3) + v(11);
    }
  return out;
}

/** `?gridscale=5`: pictures that many times bigger (to try very big photos in the viewer). */
function demoScale(): number {
  const m = typeof location === 'undefined' ? null : /[?&]gridscale=(\d+)/.exec(location.search);
  return m ? Math.max(1, Math.min(10, Number(m[1]))) : 1;
}

function item(id: number, folderId: number | null): Item {
  const k = demoScale();
  const [w, h] = SIZES[id % 4].map((x) => x * k);
  const kind = kindOf(id);
  const long = kind === 'video' && id % 2 === 0;
  return {
    id, kind, name: `${kind === 'video' ? 'clip' : 'photo'}-${String(id).padStart(5, '0')}.${kind === 'video' ? 'mp4' : kind === 'gif' ? 'gif' : 'jpg'}`,
    ext: kind === 'video' ? 'mp4' : kind === 'gif' ? 'gif' : 'jpg', size: 1_000_000 + id * 997, width: w, height: h,
    durationMs: kind === 'video' ? (long ? 600_000 + id * 1000 : 45_000) : null, favourite: id % 13 === 0, weight: 1, thumb: 'ok',
    importedAt: 1_700_000_000 - id * 3600 * 7, folderId, takenAt: 1_700_000_000 - id * 3600 * 7, views: 0, deletedAt: null,
    // Videos: some have a frame strip and a tiny clip already, some only a strip, some nothing yet.
    preview: kind === 'video' && (id % 14 === 0 || id % 21 === 0 || (manyVideos && (id % 4 === 0 || id % 6 === 0))),
    tiny: kind === 'video' && (id % 14 === 0 || (manyVideos && id % 4 === 0)),
    copyOf: null, linked: false, note: null, resumeMs: long && id % 4 === 0 ? Math.round((600_000 + id * 1000) * (((id * 7) % 9) + 1) / 10) : null,
    sketch: demoSketch(id),
  };
}

let cache: { n: number; items: Item[]; folders: FolderCard[] } | null = null;

function data() {
  const n = demoCount();
  if (cache?.n === n) return cache;
  const items = Array.from({ length: n }, (_, i) => item(i + 1, i < 60 ? 1 : i < 100 ? 2 : null));
  const card = (id: number, name: string, person: boolean, cover: number, samples: number[], count: number): FolderCard => ({
    id, name, parentId: null, path: [], depth: 0, items: count, directItems: count, subfolders: 0, cover, coverKind: 'image', tags: [], pinned: false,
    color: null, emoji: null, person, samples, note: null,
    createdAt: 1_700_000_000 + id * 86400, bytes: count * 2_000_000,
    coverFace: person ? (() => { const f = demoFace(cover); return [f.x, f.y, f.w, f.h] as [number, number, number, number]; })() : null,
  });
  const folders = [
    card(1, 'Alex', true, 3, [3, 6, 9], 60),
    card(2, 'Trips', false, 61, [61, 62, 64], 40),
    card(3, 'Sam', true, 12, [12, 15], 0),
  ];
  cache = { n, items, folders };
  return cache;
}

/** An answer for the preview, or undefined to let the normal mock answer. */
export function demoAnswer(cmd: string, a: Record<string, unknown>): unknown {
  if (!demoCount()) return undefined;
  const d = data();
  switch (cmd) {
    case 'library_folders':
      return d.folders;
    case 'folder_view': {
      const f = a.folder as number | null;
      if (f == null) return { folder: null, subfolders: d.folders, items: d.items.filter((x) => x.folderId == null) };
      return { folder: d.folders.find((x) => x.id === f) ?? null, subfolders: [], items: d.items.filter((x) => x.folderId === f) };
    }
    case 'query_items': {
      const f = (a.filter as { folder?: number | null } | undefined)?.folder;
      return f === undefined ? d.items : d.items.filter((x) => (x.folderId ?? null) === f);
    }
    case 'continue_watching':
      return d.items.filter((x) => x.resumeMs != null);
    case 'folder_samples':
      return d.items.filter((x) => x.folderId === a.folder).slice(0, Number(a.n ?? 8)).map((x) => x.id);
    case 'faces_review':
      return {
        people: d.folders.filter((f) => f.person).map((f) => ({ person: { folder: f.id, name: f.name, known: 12, unsure: 0 }, suggestions: [] })),
        unknown: [], status: { queued: 0, scanned: d.items.length, faces: d.items.length, failed: 0 },
      };
    case 'faces_of':
      return kindOf(a.media as number) === 'image' ? [demoFace(a.media as number)] : [];
    case 'faces_of_many':
      return (a.media as number[]).filter((id) => kindOf(id) === 'image').map((id) => [id, [demoFace(id)]]);
    default:
      return undefined;
  }
}
