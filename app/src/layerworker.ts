// The 3D picture layers' heavy maths, away from the window's thread (plate.ts):
// the background plate (the subject filled in: Simple here, or a fill model's
// result composed here) and the subject's own layer (clean rim, own depth).
// Pure arithmetic on pixel arrays (layers.ts); nothing here touches the vault.
//
// In:  { id, op: 'plate', orig, w, h, mask, depth, fill?: { data, w, h } | null }
//      { id, op: 'fore', orig, w, h, mask, depth }
//      { id, op: 'holeSquare', mask, side }  (the hole for a fill model, at its square size)
// Out: { id, data: ArrayBuffer } (transferred) or { id, error }

import type { DepthMap, SubjectMask } from './api';
import { composeFore, composePlate, holeSquare } from './platemath';

type Msg =
  | { id: number; op: 'plate'; orig: ArrayBuffer; w: number; h: number; mask: SubjectMask; depth: DepthMap; fill: { data: ArrayBuffer; w: number; h: number } | null }
  | { id: number; op: 'fore'; orig: ArrayBuffer; w: number; h: number; mask: SubjectMask; depth: DepthMap }
  | { id: number; op: 'holeSquare'; mask: SubjectMask; side: number };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    let out: Uint8Array;
    if (m.op === 'plate') {
      out = composePlate(new Uint8ClampedArray(m.orig), m.w, m.h, m.mask, m.depth, m.fill ? { data: new Uint8ClampedArray(m.fill.data), w: m.fill.w, h: m.fill.h } : null);
    } else if (m.op === 'fore') {
      out = composeFore(new Uint8ClampedArray(m.orig), m.w, m.h, m.mask, m.depth);
    } else {
      out = holeSquare(m.mask, m.side);
    }
    const buf = out.buffer as ArrayBuffer;
    post({ id: m.id, data: buf }, [buf]);
  } catch (err) {
    post({ id: m.id, error: String(err) });
  }
};
