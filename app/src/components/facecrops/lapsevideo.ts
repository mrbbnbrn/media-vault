// "Save as video": the face time-lapse, with the same settings, encoded in
// memory (WebCodecs, VP9 or VP8 in a WebM) and handed back as bytes for the
// vault. Frames are made one at a time from the small cache of lined-up
// faces, so memory stays bounded however many faces there are.

import type { PersonFace } from '../../api';
import { lapseAt, lapseLength, videoFps, videoFrameTimes, type LapseTiming } from '../../facecrops';
import { writeWebm, type WebmFrame } from '../../webm';
import { drawLapse, FRAME, type AlignedCache } from './render';

const BITRATE = 6_000_000;

async function pickCodec(): Promise<{ codec: string; webm: 'V_VP9' | 'V_VP8' } | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const [codec, webm] of [['vp09.00.30.08', 'V_VP9'], ['vp8', 'V_VP8']] as const) {
    try {
      const s = await VideoEncoder.isConfigSupported({ codec, width: FRAME, height: FRAME, bitrate: BITRATE, framerate: 30 });
      if (s.supported) return { codec, webm };
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * Record the time-lapse of `faces`. `ready(face)` makes sure a face can be
 * drawn (measured and lined up) and gives its frame (null: skip it).
 * Throws when this window can't make videos or the recording is stopped.
 */
export async function recordLapse(
  faces: PersonFace[],
  timing: LapseTiming,
  cache: AlignedCache,
  ready: (f: PersonFace) => Promise<unknown>,
  opts: { progress: (done: number, total: number) => void; stopped: () => boolean },
): Promise<Uint8Array> {
  const enc = await pickCodec();
  if (!enc) throw new Error("This window can't make videos.");
  const times = videoFrameTimes(faces.length, timing);
  if (!times.length) throw new Error('There are no faces to record.');
  const fps = videoFps(timing);
  const step = 1e6 / fps;
  const chunks: WebmFrame[] = [];
  let failure: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestampUs: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({ codec: enc.codec, width: FRAME, height: FRAME, bitrate: BITRATE, framerate: fps, latencyMode: 'quality' });
  const canvas = document.createElement('canvas');
  canvas.width = FRAME;
  canvas.height = FRAME;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FRAME, FRAME);
  try {
    for (let i = 0; i < times.length; i++) {
      if (opts.stopped()) throw new Error('Stopped.');
      if (failure) throw failure;
      const { index, mix } = lapseAt(times[i], faces.length, timing);
      const fa = faces[index];
      const fb = mix > 0 ? faces[index + 1] : null;
      await ready(fa);
      if (fb) await ready(fb);
      const a = cache.get(fa.id);
      const b = fb ? cache.get(fb.id) ?? null : null;
      // A face that couldn't be shown: the last picture stays a moment longer.
      if (a) drawLapse(ctx, a, b, mix);
      else if (b) drawLapse(ctx, b, null, 0);
      // Don't let frames pile up waiting to be encoded.
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 5));
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
      encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      opts.progress(i + 1, times.length);
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
    canvas.width = 0;
  }
  chunks.sort((p, q) => p.timestampUs - q.timestampUs);
  return writeWebm({ codec: enc.webm, width: FRAME, height: FRAME }, chunks, Math.round(lapseLength(faces.length, timing.fps) * 1000));
}
