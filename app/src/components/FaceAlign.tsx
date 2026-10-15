// Slideshow "Line up faces": each picture is moved and scaled so its main face
// (the person's, when the slideshow is about a person; otherwise the biggest)
// lands at the same place and size on screen, and pictures crossfade — the
// faces stay still while the pictures change. Pictures without a face show
// normally. With slow pan and zoom on, the picture zooms gently around the
// face instead. The maths is in facealign.ts.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type FaceBox } from '../api';
import { alignedCss, alignFace, faceTarget, mainFace, maxScaleFor, NO_ALIGN, zoomAbout, type Aligned } from '../facealign';
import { drawnRect } from '../flip';
import type { PlayItem } from '../media';

/** Faces per item, kept for the session (also for upcoming items). */
const faceCache = new Map<number, FaceBox[]>();
const GENTLE_ZOOM = 1.06;

function pictureId(it: PlayItem | null | undefined): number | null {
  return it && it.itemId != null && (it.kind === 'image' || it.kind === 'gif') ? it.itemId : null;
}

export function useFaceAlign(o: {
  /** Crossfade length (ms); 0 = the transition is "None": switch instantly, no ghost. */
  fadeMs: number;
  /** The setting is on and the slideshow is running. */
  on: boolean;
  item: PlayItem | null;
  /** The picture's own size once loaded (null while loading). */
  natural: { w: number; h: number } | null;
  stage: { w: number; h: number };
  fit: 'contain' | 'cover';
  /** Nothing moves while zoomed in by hand, or when the picture failed. */
  blocked: boolean;
  person?: number | null;
  /** The next few items (their faces are fetched ahead). */
  upcoming: () => PlayItem[];
  /** The layer that holds the picture (and its face boxes). */
  layer: React.RefObject<HTMLDivElement | null>;
  kenBurns: boolean;
  showMs: number;
  halted: boolean;
}) {
  const [, setFacesTick] = useState(0);
  const [ghost, setGhost] = useState<{ n: number; canvas: HTMLCanvasElement; transform: string; w: number; h: number; fading: boolean } | null>(null);
  const ghostN = useRef(0);
  const id = pictureId(o.item);

  // Fetch faces of this picture and the next few, ahead of time.
  useEffect(() => {
    if (!o.on) return;
    const ids = [o.item, ...o.upcoming()].map(pictureId).filter((x): x is number => x != null && !faceCache.has(x));
    if (!ids.length) return;
    let alive = true;
    api.facesOfMany([...new Set(ids)]).then((res) => {
      for (const x of ids) if (!faceCache.has(x)) faceCache.set(x, []);
      for (const [m, f] of res) faceCache.set(m, f);
      if (alive) setFacesTick((t) => t + 1);
    }).catch(() => {
      for (const x of ids) faceCache.set(x, []);
      if (alive) setFacesTick((t) => t + 1);
    });
    return () => {
      alive = false;
    };
  }, [o.on, o.item?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where this picture goes (null = not decided yet: still loading).
  let aligned: Aligned | null = null;
  const active = o.on && !o.blocked && id != null;
  if (active && o.natural && o.stage.w > 0 && faceCache.has(id!)) {
    const f = mainFace(faceCache.get(id!)!, o.person);
    if (!f) aligned = NO_ALIGN;
    else {
      const drawn = drawnRect(o.stage.w, o.stage.h, o.natural.w, o.natural.h, o.fit);
      aligned = alignFace(drawn, f, faceTarget(o.stage.w, o.stage.h), { maxScale: maxScaleFor(o.natural.w, drawn.width) });
    }
  }
  // No face: the picture shows as usual (and may pan and zoom as usual).
  const moving = aligned != null && aligned !== NO_ALIGN;
  const target = faceTarget(o.stage.w, o.stage.h);
  const css = moving ? alignedCss(aligned!) : null;
  const end = moving && o.kenBurns ? alignedCss(zoomAbout(aligned!, target.x, target.y, GENTLE_ZOOM)) : css;

  // Move the picture (and its face boxes) into place; with pan and zoom, keep zooming gently around the face.
  const anim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = o.layer.current;
    if (!el || !css || !end) return;
    el.style.transformOrigin = '0 0';
    el.style.transform = css;
    let a: Animation | null = null;
    if (end !== css && typeof el.animate === 'function') {
      a = el.animate([{ transform: css }, { transform: end }], { duration: Math.max(1500, o.showMs + o.fadeMs), easing: 'ease-in-out', fill: 'both' });
      if (o.halted) a.pause();
    }
    anim.current = a;
    return () => {
      a?.cancel();
      anim.current = null;
      el.style.transform = '';
      el.style.transformOrigin = '';
    };
  }, [css, end, o.item?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = anim.current;
    if (!a) return;
    if (o.halted) a.pause();
    else if (a.playState === 'paused') a.play();
  }, [o.halted]);

  // The old picture fades out over the new one once that is in place (or after a moment anyway).
  const ready = !o.on || id == null || o.blocked || aligned != null;
  useEffect(() => {
    if (!ghost || ghost.fading) return;
    const t = setTimeout(() => setGhost((g) => (g && g.n === ghost.n ? { ...g, fading: true } : g)), ready ? 30 : 400);
    return () => clearTimeout(t);
  }, [ready, ghost]);
  useEffect(() => {
    if (!ghost?.fading) return;
    const t = setTimeout(() => setGhost((g) => (g && g.n === ghost.n ? null : g)), o.fadeMs + 50);
    return () => clearTimeout(t);
  }, [ghost]);
  useEffect(() => {
    if (!o.on) setGhost(null);
  }, [o.on]);

  /** Call right before moving to another item: keeps a copy of the picture on screen for the crossfade. */
  const snap = () => {
    if (!o.on || o.fadeMs <= 0) return;
    const el = o.layer.current;
    const cv = el?.querySelector('canvas');
    if (!el || !cv || !cv.width || !cv.height) return;
    try {
      const copy = document.createElement('canvas');
      copy.width = cv.width;
      copy.height = cv.height;
      copy.getContext('2d')?.drawImage(cv, 0, 0);
      const tf = getComputedStyle(el).transform;
      setGhost({ n: ++ghostN.current, canvas: copy, transform: tf === 'none' ? '' : tf, w: cv.clientWidth, h: cv.clientHeight, fading: false });
    } catch {
      /* no crossfade this time */
    }
  };
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const ghostNode = ghost && (
    <div key={ghost.n} className={`align-ghost${ghost.fading ? ' fading' : ''}`} aria-hidden="true"
      style={{ transform: ghost.transform, transformOrigin: '0 0', animationDuration: `${o.fadeMs}ms` }}
      ref={(div) => {
        if (div && ghost.canvas.parentNode !== div) {
          ghost.canvas.style.width = `${ghost.w}px`;
          ghost.canvas.style.height = `${ghost.h}px`;
          div.appendChild(ghost.canvas);
        }
      }} />
  );

  /** True while this picture is (or is about to be) lined up: the usual pan and zoom stays off. */
  const lining = active && (aligned == null || moving);
  return { lining, ghost: ghostNode, snap: () => snapRef.current() };
}
