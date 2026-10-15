// Browser preview only (no Tauri): made-up faces for a person's face wall,
// Best faces and the time-lapse. Every picture of the person gets one face,
// placed and sized from its id, so the screens have something to show.
// Never used in the app.

import type { FaceMeasure, Item, PersonFace } from './api';
import { pointsFromBox } from './facecrops';

const wobble = (id: number, k: number) => (((id * 7919 + k * 104729) % 1000) / 1000);

function faceOf(it: Item): PersonFace {
  const W = it.width ?? 1600;
  const H = it.height ?? 1200;
  // A face 8–45% of the picture's height, somewhere in its upper middle.
  const h = 0.08 + 0.37 * wobble(it.id, 1);
  const w = (h * H * 0.8) / W;
  const x = Math.min(1 - w, Math.max(0, 0.2 + 0.5 * wobble(it.id, 2) - w / 2));
  const y = Math.min(1 - h, 0.08 + 0.3 * wobble(it.id, 3));
  return { id: it.id * 10 + 1, mediaId: it.id, frameMs: 0, x, y, w, h, date: it.takenAt, width: W, height: H, facePx: h * H };
}

const known = new Map<number, PersonFace>();

/** An answer for the preview, or undefined to let the normal mock answer. */
export async function cropsAnswer(cmd: string, a: Record<string, unknown>, itemsOf: (person: number) => Promise<Item[]>): Promise<unknown> {
  switch (cmd) {
    case 'face_crops_list': {
      const items = ((await itemsOf(a.person as number)) ?? []).filter((i) => i.kind === 'image' || i.kind === 'gif');
      const faces = items.map(faceOf).sort((p, q) => p.date - q.date || p.id - q.id);
      for (const f of faces) known.set(f.id, f);
      return faces;
    }
    case 'face_crops_measure': {
      const ids = a.ids as number[];
      // About as slow as the real thing on a quick PC.
      await new Promise((r) => setTimeout(r, 20 * ids.length));
      return ids.map((id): FaceMeasure => {
        const f = known.get(id);
        const box = f ?? { x: 0.4, y: 0.3, w: 0.2, h: 0.3 };
        const turn = (wobble(id, 4) - 0.5) * 0.2 * box.w;
        // The head turned a little: only the nose moves off the middle.
        const pts = pointsFromBox(box).map(([x, y], k) => [k === 2 ? x + turn : x, y] as [number, number]);
        const sharp = 20 + 400 * wobble(id, 5);
        const front = Math.max(0, 1 - (Math.abs(turn) / Math.max(0.01, box.w)) * 2.5);
        const px = f?.facePx ?? 100;
        const score = 0.35 * Math.min(1, Math.log(Math.max(1, px / 40)) / Math.log(20)) + 0.35 * (sharp / (sharp + 120)) + 0.3 * front;
        return { id, sharp, front, points: pts, facePx: px, score, failed: false };
      });
    }
    case 'face_crops_stop':
      return null;
    default:
      return undefined;
  }
}
