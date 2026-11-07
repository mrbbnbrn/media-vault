// "Blurred background": with Fit or Original size, the empty space around a
// picture or video shows a blurred, darkened copy of it (filling the whole
// area) instead of black. Kept light: pictures use their small thumbnail and
// one CSS blur; videos copy a frame into a tiny canvas about ten times a second.

import { useEffect, useRef, type RefObject } from 'react';

const VW = 64;
const VH = 36;

export function BlurBackdrop(props: {
  kind: 'image' | 'gif' | 'video';
  /** The picture itself (used when there is no thumbnail). */
  src: string;
  thumb?: string | null;
  video?: RefObject<HTMLVideoElement | null>;
  /** Videos: copy frames while this is true (otherwise only now and then). */
  running: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (props.kind !== 'video') return;
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    // Blurred in the tiny canvas itself (cheap), then stretched by the browser.
    const filtered = 'filter' in ctx;
    if (filtered) ctx.filter = 'blur(2px) brightness(0.45) saturate(1.2)';
    const draw = () => {
      const v = props.video?.current;
      if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;
      // Cover-scaled, a little past the edges so the blur doesn't fade at the sides.
      const k = Math.max(VW / v.videoWidth, VH / v.videoHeight) * 1.15;
      const w = v.videoWidth * k;
      const h = v.videoHeight * k;
      try {
        ctx.drawImage(v, (VW - w) / 2, (VH - h) / 2, w, h);
      } catch {
        /* not drawable yet */
      }
    };
    draw();
    const t = setInterval(draw, props.running ? 100 : 600);
    return () => clearInterval(t);
  }, [props.kind, props.running, props.video, props.src]);

  if (props.kind === 'video')
    return <canvas ref={canvas} width={VW} height={VH} className="blur-bg video" aria-hidden="true" />;
  return <img className="blur-bg" src={props.thumb || props.src} alt="" aria-hidden="true" draggable={false} />;
}
