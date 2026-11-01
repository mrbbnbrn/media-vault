// Smart search: the small shared parts (sizes, file names, picture
// preparation, vector maths) without the models or the tokenizer, so the
// window can use them without loading those at startup. clipcore.ts
// re-exports all of it.

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

export const MEAN = [0.48145466, 0.4578275, 0.40821073];
export const STD = [0.26862954, 0.26130258, 0.27577711];
export const MAX_TOKENS = 77;

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
