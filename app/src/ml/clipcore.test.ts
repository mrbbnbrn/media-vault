// Runs only when the real models are around (MV_MODELS_DIR) and test pictures
// (MV_TEST_IMAGES, raw 224×224 RGB files). Checks that words in English and
// Turkish find the right pictures.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web/wasm';
import { ClipText, ClipTextEn, ClipVision, blend, cosine, toPixelValues } from './clipcore';

const MODELS = process.env.MV_MODELS_DIR;
const IMAGES = process.env.MV_TEST_IMAGES;
const load = async (n: string) => {
  const b = readFileSync(join(MODELS!, n));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(!MODELS || !IMAGES)('smart search models', () => {
  it('finds pictures by words in two languages', async () => {
    const vision = await ClipVision.create(ort, load);
    const text = await ClipText.create(ort, load);
    const en = await ClipTextEn.create(ort, load);
    const pics: Record<string, Float32Array> = {};
    for (const f of readdirSync(IMAGES!).filter((f) => f.endsWith('.raw'))) {
      pics[f.replace('.raw', '')] = await vision.embed(toPixelValues(readFileSync(join(IMAGES!, f)), 3));
    }
    const best = async (q: string) => {
      // As the app does it: English words also get the English model (half weight).
      const multi = await text.embedQuery(q);
      const v = en.isEnglish(q) ? blend(multi, await en.embedQuery(q), 0.5) : multi;
      const ranked = Object.entries(pics).map(([k, p]) => [k, cosine(v, p)] as const).sort((a, b) => b[1] - a[1]);
      console.log(q, ranked.map(([k, s]) => `${k}:${s.toFixed(3)}`).join(' '));
      return ranked[0][0];
    };
    expect(await best('monkey')).toBe('baboon');
    expect(await best('maymun')).toBe('baboon');
    expect(await best('meyve')).toBe('fruits');
    expect(await best('fruta')).toBe('fruits');
    expect(await best('a football player')).toBe('messi5');
    expect(await best('futbol')).toBe('messi5');
    expect(await best('şapkalı kadın')).toBe('lena');
    expect(await best('woman with a hat')).toBe('lena');
    expect(await best('tall building')).toBe('building');
    expect(en.isEnglish('a football player')).toBe(true);
    expect(en.isEnglish('şapkalı kadın')).toBe(false);
    expect(en.isEnglish('meyve')).toBe(false);
  }, 300_000);
});
