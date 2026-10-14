// Smart search runs here, off the window's main thread, so the app stays
// smooth while pictures are analysed.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { ClipText, ClipTextEn, ClipVision, FILES, blend, type LoadFile } from './clipcore';

type In =
  | { id: number; type: 'image'; px: Float32Array }
  | { id: number; type: 'text'; q: string }
  | { id: number; type: 'base'; url: string };

let base = '';
const EN_WEIGHT = 0.5;
const load: LoadFile = async (name) => {
  // The engine itself is part of the app; only the models live in the models folder.
  const r = await fetch(name === FILES.wasm ? wasmUrl : base + name);
  if (!r.ok) throw new Error(`missing ${name}`);
  return r.arrayBuffer();
};
let vision: Promise<ClipVision> | null = null;
let text: Promise<ClipText> | null = null;
// Optional (newer models download): the English text model. null = not there.
let english: Promise<ClipTextEn | null> | null = null;

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    if (m.type === 'base') {
      base = m.url;
      self.postMessage({ id: m.id, ok: true });
      return;
    }
    if (m.type === 'image') {
      vision ??= ClipVision.create(ort, load).catch((err) => {
        vision = null;
        throw err;
      });
      const v = await (await vision).embed(m.px);
      self.postMessage({ id: m.id, vec: v }, { transfer: [v.buffer] });
    } else {
      text ??= ClipText.create(ort, load).catch((err) => {
        text = null;
        throw err;
      });
      english ??= ClipTextEn.create(ort, load).catch(() => null);
      const multi = await (await text).embedQuery(m.q);
      const en = await english;
      // English words also get the original CLIP text model's opinion.
      const v = en && en.isEnglish(m.q) ? blend(multi, await en.embedQuery(m.q), EN_WEIGHT) : multi;
      self.postMessage({ id: m.id, vec: v }, { transfer: [v.buffer] });
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err as Error)?.message ?? err) });
  }
};
