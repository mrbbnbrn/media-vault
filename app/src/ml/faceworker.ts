// Face finding runs here, off the window's main thread, so the app stays
// smooth while pictures are scanned.
import './faceenv';
import * as faceapi from '@vladmandic/face-api';

type In = { id: number; type: 'init' } | { id: number; type: 'detect'; img: ImageData } | { id: number; type: 'points'; img: ImageData };

const MODELS = '/facemodels';
let ready: Promise<string> | null = null;

function init(): Promise<string> {
  ready ??= (async () => {
    const tf = faceapi.tf as unknown as { setBackend(b: string): Promise<boolean>; ready(): Promise<void>; getBackend(): string };
    const ok = await tf.setBackend('webgl').catch(() => false);
    if (!ok) await tf.setBackend('cpu');
    await tf.ready();
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(MODELS),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
    ]);
    return tf.getBackend();
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    const backend = await init();
    if (m.type === 'init') {
      self.postMessage({ id: m.id, backend });
      return;
    }
    const tf = faceapi.tf as unknown as { browser: { fromPixels(i: ImageData): unknown }; dispose(t: unknown): void };
    const input = tf.browser.fromPixels(m.img) as Parameters<typeof faceapi.detectAllFaces>[0];
    if (m.type === 'points') {
      // The upscaler: the 68 face points of each face (pixels of this image).
      try {
        const found = await faceapi
          .detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 40 }))
          .withFaceLandmarks();
        const points = found.map((r) => r.landmarks.positions.map((p) => [p.x, p.y] as [number, number]));
        self.postMessage({ id: m.id, points });
      } finally {
        tf.dispose(input);
      }
      return;
    }
    try {
      const found = await faceapi
        .detectAllFaces(input, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 40 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
      const W = m.img.width;
      const H = m.img.height;
      const faces = found.map((r) => {
        const b = r.detection.box;
        return { x: b.x / W, y: b.y / H, w: b.width / W, h: b.height / H, px: b.width, score: r.detection.score, descriptor: Array.from(r.descriptor) };
      });
      self.postMessage({ id: m.id, faces });
    } finally {
      tf.dispose(input);
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String((err as Error)?.message ?? err) });
  }
};
