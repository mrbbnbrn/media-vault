// Where a picture is drawn, and the sums for the grow / shrink between a grid
// tile and the viewer (FLIP: First, Last, Invert, Play; see viewerflip.ts).

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Zoom {
  s: number;
  x: number;
  y: number;
}

/**
 * Where a picture of `nw`×`nh` is drawn inside a `W`×`H` area with the
 * viewer's fit and zoom (the same sums as ImageStage and the video zoom layer).
 */
export function drawnRect(W: number, H: number, nw: number, nh: number, fit: 'contain' | 'cover', zoom: Zoom = { s: 1, x: 0, y: 0 }): Box {
  if (!nw || !nh || !W || !H) return { left: 0, top: 0, width: W, height: H };
  const k = fit === 'cover' ? Math.max(W / nw, H / nh) : Math.min(W / nw, H / nh);
  const dw = nw * k;
  const dh = nh * k;
  return {
    left: zoom.x + (zoom.s * (W - dw)) / 2,
    top: zoom.y + (zoom.s * (H - dh)) / 2,
    width: zoom.s * dw,
    height: zoom.s * dh,
  };
}

/** The visible part of `r` inside a `W`×`H` area (for `cover`, the picture runs past the edges). */
export function clipBox(r: Box, W: number, H: number): Box {
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  return { left, top, width: Math.max(0, Math.min(W, r.left + r.width) - left), height: Math.max(0, Math.min(H, r.top + r.height) - top) };
}

/**
 * The transform that makes an element laid out at `to` appear at `from`
 * (`translate(x, y) scale(s)` with transform-origin at the element's top
 * left). Uniform scale so it doesn't stretch; centred.
 */
export function invert(from: Box, to: Box): { x: number; y: number; s: number } {
  if (!to.width || !to.height) return { x: 0, y: 0, s: 1 };
  const s = Math.max(from.width / to.width, from.height / to.height);
  return {
    s,
    x: from.left + from.width / 2 - to.left - (s * to.width) / 2,
    y: from.top + from.height / 2 - to.top - (s * to.height) / 2,
  };
}

export function toBox(r: { left: number; top: number; width: number; height: number }): Box {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
