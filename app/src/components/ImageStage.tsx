// Pictures and GIFs are drawn by the app itself onto a canvas, so the
// scaling is under our control (like IrfanView):
//  - shrinking to fit: high-quality resampling, or hard pixels
//  - zoomed in past 100%: smooth, or crisp square pixels (pixel art)
//  - optional light sharpening after smoothing
// GIFs / animated WebP are decoded frame by frame (WebCodecs ImageDecoder),
// which also gives pause, single-frame steps and A–B loops. Engines without
// ImageDecoder fall back to a plain <img>.
//
// Everything stays in memory; nothing is written to disk.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { animationMs } from '../media';
import type { ViewerSettings } from '../api';
import { turnedSize, turnedStyle, turnMatrix, type Quarter } from '../rotation';

export interface Zoom {
  s: number;
  x: number;
  y: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  /** Animated: number of frames and one loop's length. */
  frames: number;
  loopMs: number;
}

export interface ImageStageHandle {
  /** GIFs: pause or play. */
  setPaused: (p: boolean) => void;
  /** GIFs: one frame forward (+1) or back (−1); pauses. */
  step: (dir: 1 | -1) => void;
  /** GIFs: loop between two frames (inclusive), or null for the whole GIF. */
  setLoop: (loop: { a: number; b: number } | null) => void;
  frame: () => number;
  /** GIFs: show this frame (pauses). */
  seek: (index: number) => void;
  /** The picture as shown (current GIF frame), at full size. */
  capture: () => Promise<Blob | null>;
}

interface Props {
  src: string;
  kind: 'image' | 'gif';
  name: string;
  fit: 'contain' | 'cover';
  zoom: Zoom;
  /** Shown turned this many clockwise quarter turns (rotation.ts). */
  rot?: Quarter;
  prefs: ViewerSettings;
  paused: boolean;
  className?: string;
  onInfo?: (i: ImageInfo) => void;
  onFrame?: (index: number, count: number) => void;
  onError?: () => void;
  ref?: Ref<ImageStageHandle>;
}

type DecoderLike = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  completed: Promise<void>;
  decode: (o: { frameIndex: number }) => Promise<{ image: VideoFrameLike }>;
  close: () => void;
};
type VideoFrameLike = CanvasImageSource & { duration: number | null; displayWidth: number; displayHeight: number; close: () => void };

const hasDecoder = typeof window !== 'undefined' && 'ImageDecoder' in window;

function mimeOf(name: string, bytes: Uint8Array): string {
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (name.toLowerCase().endsWith('.webp')) return 'image/webp';
  return 'image/gif';
}

export function ImageStage(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 1, h: 1 });

  // What is drawn: a still bitmap, or the current GIF frame.
  const still = useRef<ImageBitmap | null>(null);
  const frame = useRef<VideoFrameLike | null>(null);
  const hq = useRef<{ w: number; h: number; bmp: ImageBitmap } | null>(null);
  const natural = useRef({ w: 0, h: 0 });
  const decoder = useRef<DecoderLike | null>(null);
  const anim = useRef({ index: 0, count: 1, paused: false, loop: null as { a: number; b: number } | null, timer: 0 as unknown as ReturnType<typeof setTimeout>, gen: 0 });
  const propsRef = useRef(props);
  propsRef.current = props;

  // ---- drawing --------------------------------------------------------------------------

  const draw = () => {
    const c = canvasRef.current;
    const src: CanvasImageSource | null = frame.current ?? still.current;
    const { w: nw, h: nh } = natural.current;
    if (!c || !src || !nw || !nh) return;
    const p = propsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    const cw = Math.max(1, Math.round(W * dpr));
    const ch = Math.max(1, Math.round(H * dpr));
    if (c.width !== cw || c.height !== ch) {
      c.width = cw;
      c.height = ch;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    // Turned: the fit uses the turned shape; the picture is drawn turned into that box.
    const r = p.rot ?? 0;
    const t = turnedSize({ w: nw, h: nh }, r);
    const k = p.fit === 'cover' ? Math.max(W / t.w, H / t.h) : Math.min(W / t.w, H / t.h);
    const dw = t.w * k;
    const dh = t.h * k;
    const z = p.zoom;
    const x = (z.x + z.s * (W - dw) / 2) * dpr;
    const y = (z.y + z.s * (H - dh) / 2) * dpr;
    const w = z.s * dw * dpr;
    const h = z.s * dh * dpr;
    // The picture's own (unturned) drawn size.
    const iw = r % 2 ? h : w;
    const ih = r % 2 ? w : h;
    const shrinking = iw < nw - 0.5;
    const smooth = shrinking ? p.prefs.smoothFit : p.prefs.smoothZoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = 'high';
    const pre = hq.current;
    if (shrinking && smooth && pre && Math.abs(pre.w - iw) < 1.5 && Math.abs(pre.h - ih) < 1.5 && !frame.current) {
      // Whole pixels, so the resampled picture stays sharp.
      const bw = r % 2 ? pre.h : pre.w;
      const bh = r % 2 ? pre.w : pre.h;
      ctx.setTransform(...turnMatrix(r, Math.round(x), Math.round(y), bw, bh));
      ctx.drawImage(pre.bmp, 0, 0);
    } else {
      ctx.setTransform(...turnMatrix(r, x, y, w, h));
      ctx.drawImage(src, 0, 0, iw, ih);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    c.style.filter = p.prefs.sharpen && smooth ? 'url(#mv-sharpen)' : '';
    // A high-quality resample for this size is made once the zoom settles.
    if (shrinking && smooth && !frame.current && still.current && (!pre || Math.abs(pre.w - iw) >= 1.5 || Math.abs(pre.h - ih) >= 1.5)) scheduleHq(iw, ih);
  };

  const hqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHq = (w: number, h: number) => {
    if (hqTimer.current) clearTimeout(hqTimer.current);
    hqTimer.current = setTimeout(async () => {
      const bmp = still.current;
      if (!bmp || w < 1 || h < 1 || w > 8192 || h > 8192) return;
      try {
        const r = await createImageBitmap(bmp, { resizeWidth: Math.round(w), resizeHeight: Math.round(h), resizeQuality: 'high' });
        if (still.current !== bmp) return r.close();
        hq.current?.bmp.close();
        hq.current = { w: Math.round(w), h: Math.round(h), bmp: r };
        draw();
      } catch {
        /* the plain draw stays */
      }
    }, 140);
  };

  useEffect(draw); // every render: zoom, fit, prefs, size

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      requestAnimationFrame(() => draw()); // again once layout has settled
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  void size;

  // ---- loading --------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    const st = anim.current;
    st.gen += 1;
    const gen = st.gen;
    (async () => {
      const r = await fetch(props.src);
      if (!r.ok) throw new Error(String(r.status));
      const bytes = new Uint8Array(await r.arrayBuffer());
      if (cancelled) return;
      if (props.kind === 'gif') {
        const loopMs = animationMs(bytes);
        const Dec = (window as unknown as { ImageDecoder?: new (o: { data: Uint8Array; type: string }) => DecoderLike }).ImageDecoder;
        if (!hasDecoder || !Dec) {
          const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(props.name, bytes) }));
          setFallback(url);
          const img = new Image();
          img.onload = () => props.onInfo?.({ width: img.naturalWidth, height: img.naturalHeight, frames: 0, loopMs });
          img.src = url;
          return;
        }
        const dec = new Dec({ data: bytes, type: mimeOf(props.name, bytes) });
        decoder.current = dec;
        await dec.tracks.ready;
        await dec.completed.catch(() => {});
        if (cancelled || gen !== st.gen) return dec.close();
        st.count = Math.max(1, dec.tracks.selectedTrack?.frameCount ?? 1);
        st.index = 0;
        st.loop = null;
        const first = await dec.decode({ frameIndex: 0 });
        if (cancelled || gen !== st.gen) {
          first.image.close();
          return dec.close();
        }
        frame.current = first.image;
        natural.current = { w: first.image.displayWidth, h: first.image.displayHeight };
        props.onInfo?.({ width: natural.current.w, height: natural.current.h, frames: st.count, loopMs });
        props.onFrame?.(0, st.count);
        draw();
        schedule(first.image.duration);
      } else {
        const blob = new Blob([bytes]);
        let bmp: ImageBitmap;
        try {
          bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch {
          bmp = await createImageBitmap(blob);
        }
        if (cancelled) return bmp.close();
        still.current = bmp;
        natural.current = { w: bmp.width, h: bmp.height };
        props.onInfo?.({ width: bmp.width, height: bmp.height, frames: 0, loopMs: 0 });
        draw();
      }
    })().catch(() => !cancelled && props.onError?.());
    return () => {
      cancelled = true;
      st.gen += 1;
      clearTimeout(st.timer);
      if (hqTimer.current) clearTimeout(hqTimer.current);
      frame.current?.close();
      frame.current = null;
      still.current?.close();
      still.current = null;
      hq.current?.bmp.close();
      hq.current = null;
      decoder.current?.close();
      decoder.current = null;
      setFallback((u) => {
        if (u) URL.revokeObjectURL(u);
        return null;
      });
    };
  }, [props.src]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- GIF playback -----------------------------------------------------------------------

  const show = async (i: number) => {
    const dec = decoder.current;
    const st = anim.current;
    if (!dec) return null;
    const gen = st.gen;
    const r = await dec.decode({ frameIndex: i }).catch(() => null);
    if (!r || gen !== st.gen) {
      r?.image.close();
      return null;
    }
    frame.current?.close();
    frame.current = r.image;
    st.index = i;
    propsRef.current.onFrame?.(i, st.count);
    draw();
    return r.image;
  };

  const nextIndex = (i: number) => {
    const st = anim.current;
    const lo = st.loop ? Math.min(st.loop.a, st.loop.b) : 0;
    const hi = st.loop ? Math.max(st.loop.a, st.loop.b) : st.count - 1;
    return i >= hi || i < lo ? lo : i + 1;
  };

  function schedule(durUs: number | null) {
    const st = anim.current;
    clearTimeout(st.timer);
    if (st.paused || st.count < 2) return;
    const ms = durUs && durUs > 0 ? Math.max(20, durUs / 1000) : 100;
    const gen = st.gen;
    st.timer = setTimeout(async () => {
      if (gen !== st.gen || st.paused) return;
      const img = await show(nextIndex(st.index));
      if (img && gen === st.gen) schedule(img.duration);
    }, ms);
  }

  useEffect(() => {
    const st = anim.current;
    st.paused = props.paused;
    if (props.paused) clearTimeout(st.timer);
    else if (frame.current) schedule(frame.current.duration);
  }, [props.paused]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(props.ref, () => ({
    setPaused: (p) => {
      anim.current.paused = p;
      if (p) clearTimeout(anim.current.timer);
      else if (frame.current) schedule(frame.current.duration);
    },
    step: (dir) => {
      const st = anim.current;
      st.paused = true;
      clearTimeout(st.timer);
      if (!decoder.current) return;
      show((st.index + dir + st.count) % st.count);
    },
    setLoop: (loop) => {
      anim.current.loop = loop;
    },
    frame: () => anim.current.index,
    seek: (i) => {
      const st = anim.current;
      st.paused = true;
      clearTimeout(st.timer);
      if (decoder.current) show(Math.max(0, Math.min(st.count - 1, Math.round(i))));
    },
    capture: async () => {
      const src: CanvasImageSource | null = frame.current ?? still.current;
      const { w, h } = natural.current;
      if (!src || !w || !h) return null;
      // Turned as it is shown.
      const r = propsRef.current.rot ?? 0;
      const t = turnedSize({ w, h }, r);
      const c = document.createElement('canvas');
      c.width = t.w;
      c.height = t.h;
      const ctx = c.getContext('2d')!;
      ctx.setTransform(...turnMatrix(r, 0, 0, t.w, t.h));
      ctx.drawImage(src, 0, 0, w, h);
      return new Promise((res) => c.toBlob((b) => res(b), 'image/png'));
    },
  }));

  if (fallback) {
    // No frame decoder in this engine: a plain image, zoomed by CSS.
    const z = props.zoom;
    return (
      <div ref={boxRef} className="image-stage">
        <div className="zoom-layer" style={{ transform: `translate(${z.x}px, ${z.y}px) scale(${z.s})` }}>
          <img className={`media ${props.className ?? ''}`}
            style={{ objectFit: props.fit, imageRendering: props.prefs.smoothZoom ? undefined : 'pixelated', ...turnedStyle(props.rot ?? 0, size.w, size.h) }}
            src={fallback} alt={props.name} draggable={false} />
        </div>
      </div>
    );
  }
  return (
    <div ref={boxRef} className="image-stage">
      <canvas ref={canvasRef} className={`media-canvas ${props.className ?? ''}`} role="img" aria-label={props.name} />
    </div>
  );
}
