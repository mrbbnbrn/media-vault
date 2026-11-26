// The heavy maths of Border fill (layersmath.ts), away from the window's
// thread (looklayers.ts sends the jobs). Pure arithmetic on pixel arrays plus
// the saved border's packing (layerpack.ts); nothing here touches the vault.
//
// In:  { id, op, ...args } (see LookJob in looklayers.ts)
// Out: { id, out } or { id, error }

import { packLayer, unpackLayer } from './layerpack';
import { borderCanvas, borderModelHole, borderNeedsFill, composeBorder } from './layersmath';
import { resizeRgba } from './platemath';
import type { LookJob } from './looklayers';

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

export async function runLook(j: LookJob): Promise<unknown> {
  switch (j.op) {
    case 'borderInput': {
      const c = borderCanvas(j.orig, j.w, j.h, j.b);
      if (!borderNeedsFill(c)) return null;
      return { rgba: new Uint8Array(resizeRgba(c.data, c.W, c.H, j.side, j.side).buffer), hole: borderModelHole(c, j.side) };
    }
    case 'border': {
      const c = borderCanvas(j.orig, j.w, j.h, j.b);
      return composeBorder(c, j.w, j.h, j.b, j.depth, j.fill);
    }
    case 'borderPack': {
      const c = borderCanvas(j.orig, j.w, j.h, j.b);
      return packLayer(c.data, j.layer, c.W, c.H);
    }
    case 'borderUnpack': {
      const c = borderCanvas(j.orig, j.w, j.h, j.b);
      return unpackLayer(c.data, j.bytes);
    }
  }
}

if (typeof self !== 'undefined' && typeof (self as { document?: unknown }).document === 'undefined') {
  self.onmessage = async (e: MessageEvent<LookJob & { id: number }>) => {
    try {
      const out = await runLook(e.data);
      post({ id: e.data.id, out });
    } catch (err) {
      post({ id: e.data.id, error: String(err) });
    }
  };
}
