// The heavy maths of More layers and Border fill (layersmath.ts), away from
// the window's thread (looklayers.ts sends the jobs). Pure arithmetic on pixel
// arrays plus the saved layers' packing (layerpack.ts); nothing here touches the vault.
//
// In:  { id, op, ...args } (see LookJob in looklayers.ts)
// Out: { id, out } or { id, error }

import { packLayer, unpackLayer } from './layerpack';
import {
  borderCanvas, borderModelHole, borderNeedsFill, composeBorder, composeLayer, layerCoverage, layerModelHole, planLayers,
} from './layersmath';
import { resizeRgba } from './platemath';
import type { LookJob } from './looklayers';

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

export async function runLook(j: LookJob): Promise<unknown> {
  switch (j.op) {
    case 'plan':
      return planLayers(j.depth, j.mask, j.max, j.cut);
    case 'layerHole':
      return layerModelHole(j.plan, j.j, j.side);
    case 'layer':
      return composeLayer(j.orig, j.w, j.h, j.depth, j.plan, j.j, j.fill);
    case 'coverage':
      return layerCoverage(j.plan);
    case 'borderInput': {
      const c = borderCanvas(j.orig, j.w, j.h, j.b);
      if (!borderNeedsFill(c)) return null;
      return { rgba: new Uint8Array(resizeRgba(c.data, c.W, c.H, j.side, j.side).buffer), hole: borderModelHole(c, j.side) };
    }
    case 'border': {
      const c = borderCanvas(j.orig, j.w, j.h, j.b);
      return composeBorder(c, j.w, j.h, j.b, j.depth, j.fill);
    }
    case 'pack':
      return packLayer(j.orig, j.layer, j.w, j.h);
    case 'unpack':
      return unpackLayer(j.orig, j.bytes);
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
