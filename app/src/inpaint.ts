// Layered 3D's background fill (still pictures only): what fills in the
// background behind the subject. Simple needs no download (the surrounding
// colours are pulled inwards, in the window: layers.ts fillRgba); MI-GAN and
// LaMa are optional downloads run natively (inpaint.rs), sent a square
// picture of their size with the area to fill marked. The filled background
// is kept in memory only (plate.ts).

import { api, type InpaintInfo, type ViewerSettings } from './api';

export type InpaintChoice = '' | 'migan' | 'lama';

/** The download each known model comes in (for "not installed" hints). */
export const INPAINT_ZIPS: Record<string, string> = {
  migan: 'MediaVault-inpaint-migan-windows.zip',
  lama: 'MediaVault-inpaint-lama-windows.zip',
};

export const INPAINT_NAMES: Record<string, string> = { '': 'Simple', migan: 'MI-GAN', lama: 'LaMa' };

/** The chosen fill read safely ('' = Simple). */
export function inpaintChoice(p: Pick<ViewerSettings, 'inpaintModel'>): InpaintChoice {
  return p.inpaintModel === 'migan' || p.inpaintModel === 'lama' ? p.inpaintModel : '';
}

const infos = new Map<string, Promise<InpaintInfo | null>>();
/** Whether this fill model is there (asked once per model; `again` asks anew, e.g. after unzipping a pack). */
export function inpaintPack(model: string, again = false): Promise<InpaintInfo | null> {
  let p = infos.get(model);
  if (!p || again) {
    p = api.inpaintInfo(model).catch(() => null);
    infos.set(model, p);
  }
  return p;
}

/** "Background fill: get MediaVault-inpaint-lama-windows.zip … (Simple is used until then)". */
export function noFillText(model: string): string {
  const zip = INPAINT_ZIPS[model];
  return `${INPAINT_NAMES[model] ?? 'That fill'} isn't installed${zip ? `: get ${zip} from the Releases page` : ''} · Simple is used until then`;
}

const speeds = new Map<string, { ms: number; device: 'gpu' | 'cpu'; loadMs: number }>();
export function lastInpaintSpeed(id: string) {
  return speeds.get(id);
}
export async function testInpaintSpeed(id: string) {
  const r = await api.inpaintBenchmark(id);
  const res = { ms: r.ms, device: r.device, loadMs: r.loadMs };
  speeds.set(id, res);
  return res;
}
