// "Beat drop" hit: a short white flash over the picture and a quick zoom punch
// (about 6 % bigger and back) on the stage, when the music drops. Plays with
// WAAPI only (no re-render per frame); with "reduce motion" there is only a
// softer flash.
//
//   <BeatHit n={hitCount} stage={stageRef} />   // bump n to play it once

import { useEffect, useRef, type RefObject } from 'react';

export const HIT_FLASH_MS = 220;
export const HIT_PUNCH_MS = 300;
/** How much bigger the punch makes the picture at its peak. */
export const HIT_SCALE = 1.06;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function BeatHit({ n, stage }: { n: number; stage: RefObject<HTMLElement | null> }) {
  const flashRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!n) return;
    const calm = reducedMotion();
    const flash = flashRef.current?.animate(
      [{ opacity: 0 }, { opacity: calm ? 0.25 : 0.7, offset: 0.15 }, { opacity: 0 }],
      { duration: HIT_FLASH_MS, easing: 'ease-out' },
    );
    const punch = calm ? undefined : stage.current?.animate(
      [
        { transform: 'scale(1)', easing: 'cubic-bezier(.2,.8,.3,1)' },
        { transform: `scale(${HIT_SCALE})`, offset: 0.3, easing: 'cubic-bezier(.4,0,.2,1)' },
        { transform: 'scale(1)' },
      ],
      { duration: HIT_PUNCH_MS },
    );
    return () => {
      flash?.cancel();
      punch?.cancel();
    };
  }, [n]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={flashRef} className="beat-hit" aria-hidden="true"
      style={{ position: 'absolute', inset: 0, background: '#fff', opacity: 0, pointerEvents: 'none', zIndex: 5 }} />
  );
}
