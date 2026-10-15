// Pictures and GIFs are drawn by the app itself onto a canvas, so the
// scaling is under our control (like IrfanView):
//  - shrinking to fit: high-quality resampling, or hard pixels
//  - zoomed in past 100%: smooth, or crisp square pixels (pixel art)
//  - optional light sharpening after smoothing
// GIFs / animated WebP are decoded frame by frame (WebCodecs ImageDecoder),
// which also gives pause, single-frame steps and A–B loops. Engines without
// ImageDecoder fall back to a plain <img>.
//
// Big photos are decoded off the main thread at about screen size, and the
// whole picture only once you zoom in past that (picturecache.ts, which also
// keeps the last few decoded and the next ones decoded ahead of time).
//
// Everything stays in memory; nothing is written to disk.

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { animationMs } from '../media';
import { cachedPicture, fullPicture, holdPicture, loadPicture, resizedPicture, type Picture } from '../picturecache';
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
  /** The picture's size if known (lets a big photo be decoded at screen size). */
  size?: { w: number; h: number } | null;
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
  /** The decoded picture `still` comes from (owned by the picture cache unless `ownStill`). */
  const picture = useRef<Picture | null>(null);
  const ownStill = useRef(false);
  /** The whole picture, decoded once zoomed in past the screen-sized copy. */
  const full = useRef<ImageBitmap | null>(null);
  const fullAsked = useRef<Promise<void> | null>(null);
  const stillSrc = () => full.current ?? still.current;
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
    const src: CanvasImageSource | null = frame.current ?? stillSrc();
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
    // Zoomed in past what the screen-sized copy holds: decode the whole picture (off the main thread).
    const pic = picture.current;
    if (pic && !pic.full && !full.current && !fullAsked.current && still.current && iw > still.current.width * 1.05) loadFull();
    const smooth = shrinking ? p.prefs.smoothFit : p.prefs.smoothZoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = smooth;
    ctx.imageSmoothingQuality = 'high';
    const pre = hq.current;
    const preFits = !!pre && Math.abs(pre.w - iw) < 1.5 && Math.abs(pre.h - ih) < 1.5;
    // Between screen size and full size, until the sharp resample (made in the worker) is there:
    // the screen-sized copy, a little soft, rather than shrinking the whole big picture here.
    const img: CanvasImageSource = !frame.current && full.current && still.current && shrinking && smooth && !preFits && iw <= 8192 && ih <= 8192 ? still.current : src;
    if (shrinking && smooth && pre && preFits && !frame.current) {
      // Whole pixels, so the resampled picture stays sharp.
      const bw = r % 2 ? pre.h : pre.w;
      const bh = r % 2 ? pre.w : pre.h;
      ctx.setTransform(...turnMatrix(r, Math.round(x), Math.round(y), bw, bh));
      ctx.drawImage(pre.bmp, 0, 0);
    } else if (r === 0 && typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap && (x < 0 || y < 0 || x + w > cw || y + h > ch)) {
      // Zoomed in: draw only the part of the picture that is on screen (a 50 MP picture is mostly off screen).
      const kx = img.width / w;
      const ky = img.height / h;
      const sx0 = Math.max(0, Math.floor(Math.max(0, -x) * kx) - 1);
      const sy0 = Math.max(0, Math.floor(Math.max(0, -y) * ky) - 1);
      const sx1 = Math.min(img.width, Math.ceil(Math.min(w, cw - x) * kx) + 1);
      const sy1 = Math.min(img.height, Math.ceil(Math.min(h, ch - y) * ky) + 1);
      if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, x + sx0 / kx, y + sy0 / ky, (sx1 - sx0) / kx, (sy1 - sy0) / ky);
    } else {
      ctx.setTransform(...turnMatrix(r, x, y, w, h));
      ctx.drawImage(img, 0, 0, iw, ih);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    c.style.filter = p.prefs.sharpen && smooth ? 'url(#mv-sharpen)' : '';
    // A high-quality resample for this size is made once the zoom settles.
    // (Only from a source with at least that many pixels: blowing up the screen-sized copy gains nothing.)
    const base = stillSrc();
    if (shrinking && smooth && !frame.current && base && base.width >= iw - 1 && !preFits) scheduleHq(iw, ih);
  };

  const hqTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHq = (w: number, h: number) => {
    if (hqTimer.current) clearTimeout(hqTimer.current);
    hqTimer.current = setTimeout(async () => {
      const bmp = stillSrc();
      if (!bmp || w < 1 || h < 1 || w > 8192 || h > 8192) return;
      try {
        // From the whole picture: resampled in the worker, from the file (a 50 MP resample here would freeze the window).
        const pic = picture.current;
        const r = pic && bmp === full.current
          ? await resizedPicture(pic, w, h)
          : await createImageBitmap(bmp, { resizeWidth: Math.round(w), resizeHeight: Math.round(h), resizeQuality: 'high' });
        if (!r) return;
        if (stillSrc() !== bmp) return r.close();
        hq.current?.bmp.close();
        hq.current = { w: Math.round(w), h: Math.round(h), bmp: r };
        draw();
      } catch {
        /* the plain draw stays */
      }
    }, 140);
  };

  /** Decode the whole picture once (it is drawn from then on); resolves when it is there or failed. */
  const loadFull = (): Promise<void> => {
    const pic = picture.current;
    if (!pic) return Promise.resolve();
    if (fullAsked.current) return fullAsked.current;
    fullAsked.current = fullPicture(pic)
      .then((bmp) => {
        if (!bmp) return;
        if (picture.current !== pic) return bmp.close();
        full.current = bmp;
        // A resample made from the smaller copy is redone from the whole picture.
        hq.current?.bmp.close();
        hq.current = null;
        draw();
      })
      .catch(() => {
        /* the screen-sized copy stays */
      });
    return fullAsked.current;
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
    const unhold = holdPicture(props.src);
    (async () => {
      const got = await loadPicture(props.src, props.kind, props.kind === 'image' ? props.size : null);
      if (cancelled) return;
      if ('gif' in got) {
        const bytes = got.bytes;
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
        // Kept by the picture cache (shared with going back and forth), unless it was forgotten meanwhile.
        ownStill.current = cachedPicture(props.src) !== got;
        picture.current = got;
        still.current = got.bmp;
        natural.current = got.natural;
        props.onInfo?.({ width: got.natural.w, height: got.natural.h, frames: 0, loopMs: 0 });
        draw();
      }
    })().catch(() => !cancelled && props.onError?.());
    return () => {
      cancelled = true;
      unhold();
      st.gen += 1;
      clearTimeout(st.timer);
      if (hqTimer.current) clearTimeout(hqTimer.current);
      frame.current?.close();
      frame.current = null;
      if (ownStill.current) still.current?.close();
      still.current = null;
      ownStill.current = false;
      picture.current = null;
      full.current?.close();
      full.current = null;
      fullAsked.current = null;
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
      // At full size: decode the whole picture first if only the screen-sized copy is there.
      if (!frame.current && !full.current && picture.current && !picture.current.full) await loadFull();
      const src: CanvasImageSource | null = frame.current ?? stillSrc();
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
