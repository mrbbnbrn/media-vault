// Plays the transitions between items (transitions.ts): right before moving
// on, a copy of what is on screen is kept (the "ghost"); once the next item is
// drawn, the ghost plays its way out and the next item its way in. The plain
// "Fade" and "None" don't use this (the new item fades in by itself).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { transitionPlan, type Effect, type TransitionPlan } from '../transitions';

interface Ghost {
  n: number;
  canvas: HTMLCanvasElement;
  plan: TransitionPlan;
  ms: number;
  /** The item that was showing (the ghost waits for another one to be drawn). */
  from: string | undefined;
}

export function useItemTransition(o: {
  /** The layer the items are drawn in: it plays the "in" part. */
  layer: RefObject<HTMLDivElement | null>;
  /** A copy of what is on screen now, stage-sized (null = nothing to copy). */
  snapshot: () => HTMLCanvasElement | null;
  /** The item showing now, and whether it has been drawn. */
  itemKey: string | undefined;
  ready: boolean;
}) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const n = useRef(0);
  const anims = useRef<Animation[]>([]);
  const played = useRef(0);
  const ghostEl = useRef<HTMLDivElement | null>(null);

  const stopAll = () => {
    anims.current.forEach((a) => a.cancel());
    anims.current = [];
  };

  /** Call right before moving on. */
  const start = (effect: Effect, dir: 1 | -1, ms: number, fromPx = 0): boolean => {
    if (ms <= 0) return false;
    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = o.snapshot();
    } catch {
      canvas = null;
    }
    stopAll();
    // Nothing to copy (e.g. a picture that couldn't be shown): the next item still comes in, over black.
    if (!canvas) canvas = document.createElement('canvas');
    setGhost({ n: ++n.current, canvas, plan: transitionPlan(effect, dir, fromPx), ms, from: o.itemKey });
    return true;
  };

  // Both parts are set up straight away (held at their start), so the next item never flashes up first.
  useLayoutEffect(() => {
    if (!ghost) return;
    const opts: KeyframeAnimationOptions = { duration: ghost.ms, easing: ghost.plan.easing, fill: 'both' };
    const list: Animation[] = [];
    const layer = o.layer.current;
    if (layer && typeof layer.animate === 'function') list.push(layer.animate(ghost.plan.in, opts));
    const g = ghostEl.current;
    if (g && typeof g.animate === 'function') list.push(g.animate(ghost.plan.out, opts));
    list.forEach((a) => a.pause());
    anims.current = list;
    return () => list.forEach((a) => a.cancel());
  }, [ghost?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // Played once the next item is drawn (or after a moment anyway).
  const next = !!ghost && o.itemKey !== ghost.from;
  useEffect(() => {
    if (!ghost || played.current === ghost.n) return;
    const go = () => {
      if (played.current === ghost.n) return;
      played.current = ghost.n;
      const list = anims.current;
      if (!list.length) return setGhost((g) => (g?.n === ghost.n ? null : g));
      list.forEach((a) => a.play());
      Promise.all(list.map((a) => a.finished)).then(
        () => setGhost((g) => (g?.n === ghost.n ? null : g)),
        () => {},
      );
    };
    const t = setTimeout(go, next && o.ready ? 16 : 600);
    return () => clearTimeout(t);
  }, [ghost, next, o.ready]);

  useEffect(() => () => stopAll(), []);

  const node: ReactNode = ghost && (
    <div key={ghost.n} className="tx-ghost" aria-hidden="true"
      ref={(div) => {
        ghostEl.current = div;
        if (div && ghost.canvas.parentNode !== div) div.appendChild(ghost.canvas);
      }} />
  );
  return {
    start,
    /** Stop at once (e.g. a mouse swipe starts): everything as it is without the transition. */
    stop: () => {
      stopAll();
      setGhost(null);
    },
    above: ghost?.plan.ghostOnTop ? node : null,
    below: ghost && !ghost.plan.ghostOnTop ? node : null,
    film: !!ghost?.plan.film,
  };
}
