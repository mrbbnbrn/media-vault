// Smart search models, the maths part (no DOM). Pictures and words are both
// turned into 512-number "meaning" vectors in the same space (OpenAI CLIP
// ViT-B/32 for pictures, a multilingual text model trained to match it, so
// Turkish and 50+ other languages work). Everything runs offline in
// WebAssembly; the model files come from the `models` folder next to the app.

import type * as OrtNS from 'onnxruntime-web';
import { Tokenizer } from '@huggingface/tokenizers';

export type Ort = typeof OrtNS;
/** Reads a model file by name (from the models folder). */
export type LoadFile = (name: string) => Promise<ArrayBuffer>;

export const DIM = 512;
export const SIZE = 224;
export const FILES = {
  wasm: 'ort-wasm-simd-threaded.wasm',
  vision: 'clip-vision.onnx',
  text: 'clip-text.onnx',
  tokenizer: 'clip-text-tokenizer.json',
  tokenizerConfig: 'clip-text-tokenizer_config.json',
  dense: 'clip-text-dense.safetensors',
  enText: 'clip-en-text.onnx',
  enTokenizer: 'clip-en-tokenizer.json',
  enTokenizerConfig: 'clip-en-tokenizer_config.json',
};

const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];
const MAX_TOKENS = 77;

let ortReady: Promise<void> | null = null;
export function initOrt(ort: Ort, load: LoadFile): Promise<void> {
  ortReady ??= (async () => {
    ort.env.wasm.numThreads = 1; // no cross-origin isolation in the app window
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmBinary = await load(FILES.wasm);
  })();
  return ortReady;
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** RGBA (or RGB) pixels of a SIZE×SIZE centre crop -> CLIP's input tensor data. */
export function toPixelValues(px: ArrayLike<number>, channels: 3 | 4): Float32Array {
  const out = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (px[i * channels + c] / 255 - MEAN[c]) / STD[c];
  }
  return out;
}

/** Where to draw a w×h picture so it covers SIZE×SIZE, centred (CLIP's resize + crop). */
export function coverRect(w: number, h: number): { x: number; y: number; w: number; h: number } {
  const s = SIZE / Math.min(w, h);
  const dw = w * s;
  const dh = h * s;
  return { x: (SIZE - dw) / 2, y: (SIZE - dh) / 2, w: dw, h: dh };
}

export class ClipVision {
  private constructor(private ort: Ort, private session: OrtNS.InferenceSession) {}

  static async create(ort: Ort, load: LoadFile): Promise<ClipVision> {
    await initOrt(ort, load);
    const session = await ort.InferenceSession.create(new Uint8Array(await load(FILES.vision)), { executionProviders: ['wasm'] });
    return new ClipVision(ort, session);
  }

  async embed(pixelValues: Float32Array): Promise<Float32Array> {
    const input = new this.ort.Tensor('float32', pixelValues, [1, 3, SIZE, SIZE]);
    const out = await this.session.run({ [this.session.inputNames[0]]: input });
    const t = out.image_embeds ?? out[this.session.outputNames[0]];
    return normalize(t.data as Float32Array);
  }
}

/** Read the one F32 matrix out of a .safetensors file. */
export function readSafetensor(buf: ArrayBuffer): { shape: number[]; data: Float32Array } {
  const dv = new DataView(buf);
  const n = Number(dv.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const key = Object.keys(header).find((k) => k !== '__metadata__');
  if (!key || header[key].dtype !== 'F32') throw new Error('Unexpected model layer file.');
  const { shape, data_offsets: [a, b] } = header[key];
  const bytes = buf.slice(8 + n + a, 8 + n + b);
  return { shape, data: new Float32Array(bytes) };
}

export class ClipText {
  private constructor(
    private ort: Ort,
    private session: OrtNS.InferenceSession,
    private tokenizer: Tokenizer,
    private dense: { shape: number[]; data: Float32Array },
  ) {}

  static async create(ort: Ort, load: LoadFile): Promise<ClipText> {
    await initOrt(ort, load);
    const json = (b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b));
    const [model, tok, cfg, dense] = await Promise.all([load(FILES.text), load(FILES.tokenizer), load(FILES.tokenizerConfig), load(FILES.dense)]);
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    return new ClipText(ort, session, new Tokenizer(json(tok), json(cfg)), readSafetensor(dense));
  }

  /** A search: the words alone and in two picture phrasings, averaged
   *  (short queries, especially single Turkish words, match much better). */
  async embedQuery(q: string): Promise<Float32Array> {
    const parts = [q, `a photo of ${q}`, `${q} fotoğrafı`];
    const sum = new Float32Array(DIM);
    for (const p of parts) {
      const v = await this.embed(p);
      for (let i = 0; i < DIM; i++) sum[i] += v[i];
    }
    return normalize(sum);
  }

  async embed(text: string): Promise<Float32Array> {
    const enc = this.tokenizer.encode(text.trim());
    let ids = enc.ids;
    if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]];
    const n = ids.length;
    const feeds: Record<string, OrtNS.Tensor> = {};
    for (const name of this.session.inputNames) {
      const data = name === 'input_ids' ? BigInt64Array.from(ids.map(BigInt)) : name === 'attention_mask' ? new BigInt64Array(n).fill(1n) : new BigInt64Array(n);
      feeds[name] = new this.ort.Tensor('int64', data, [1, n]);
    }
    const out = await this.session.run(feeds);
    const h = out.last_hidden_state ?? out[this.session.outputNames[0]];
    const hidden = h.data as Float32Array;
    const width = h.dims[2];
    // Mean of all token vectors, then the 768 -> 512 layer.
    const mean = new Float32Array(width);
    for (let t = 0; t < n; t++) for (let i = 0; i < width; i++) mean[i] += hidden[t * width + i] / n;
    const [rows, cols] = this.dense.shape;
    const W = this.dense.data;
    const y = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let s = 0;
      const o = r * cols;
      for (let c = 0; c < cols; c++) s += W[o + c] * mean[c];
      y[r] = s;
    }
    return normalize(y);
  }
}

/** OpenAI CLIP's own text model: the best at English words (including
 *  everyday and adult vocabulary the multilingual model learned less well). */
export class ClipTextEn {
  private constructor(private ort: Ort, private session: OrtNS.InferenceSession, private tokenizer: Tokenizer) {}

  static async create(ort: Ort, load: LoadFile): Promise<ClipTextEn> {
    await initOrt(ort, load);
    const json = (b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b));
    const [model, tok, cfg] = await Promise.all([load(FILES.enText), load(FILES.enTokenizer), load(FILES.enTokenizerConfig)]);
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
    return new ClipTextEn(ort, session, new Tokenizer(json(tok), json(cfg)));
  }

  async embed(text: string): Promise<Float32Array> {
    let ids = this.tokenizer.encode(text.trim().toLowerCase()).ids;
    if (ids.length > MAX_TOKENS) ids = [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]];
    const n = ids.length;
    const feeds: Record<string, OrtNS.Tensor> = {};
    for (const name of this.session.inputNames) {
      const data = name === 'input_ids' ? BigInt64Array.from(ids.map(BigInt)) : new BigInt64Array(n).fill(1n);
      feeds[name] = new this.ort.Tensor('int64', data, [1, n]);
    }
    const out = await this.session.run(feeds);
    const t = out.text_embeds ?? out[this.session.outputNames[0]];
    return normalize(t.data as Float32Array);
  }

  /** Plain English (every word a known English word)? Other languages are
   *  left to the multilingual model. */
  isEnglish(q: string): boolean {
    if (!/^[\x20-\x7e]+$/.test(q) || !q.trim()) return false;
    const toks = this.tokenizer.encode(q.trim().toLowerCase()).tokens.slice(1, -1);
    return toks.length > 0 && toks.every((t) => t.endsWith('</w>'));
  }

  async embedQuery(q: string): Promise<Float32Array> {
    const sum = new Float32Array(DIM);
    for (const p of [q, `a photo of ${q}`]) {
      const v = await this.embed(p);
      for (let i = 0; i < DIM; i++) sum[i] += v[i];
    }
    return normalize(sum);
  }
}

/** Both text models together: the multilingual one for every language,
 *  the English one (weight `en`) where it understands the words. */
export function blend(multi: Float32Array, english: Float32Array | null, en = 1): Float32Array {
  if (!english) return multi;
  const out = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) out[i] = multi[i] + en * english[i];
  return normalize(out);
}
