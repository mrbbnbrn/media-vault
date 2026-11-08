// Drives video.playbackRate from SpeedRamp (speedramp.ts) once per animation
// frame while "Speed ramp" is on and the video plays. Turning it off puts the
// user's own speed back.

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { SpeedRamp } from './speedramp';

/** Returns `hit(strength, now, force)` to call on each beat. */
export function useSpeedRamp(video: RefObject<HTMLVideoElement | null>, on: boolean, base: number, running: boolean) {
  const ramp = useRef<SpeedRamp | null>(null);

  useEffect(() => {
    if (!on) return;
    const r = (ramp.current ??= new SpeedRamp(performance.now(), base));
    r.setBase(base);
    if (!running) return;
    let raf = 0;
    const step = () => {
      raf = requestAnimationFrame(step);
      const v = video.current;
      if (!v || v.paused || document.hidden) return;
      const rate = r.rate(performance.now());
      if (Math.abs(v.playbackRate - rate) >= 0.02) v.playbackRate = rate;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [on, base, running, video]);

  // Off again: back to the user's own speed.
  useEffect(() => {
    if (on) return;
    if (ramp.current) {
      ramp.current = null;
      const v = video.current;
      if (v) v.playbackRate = base;
    }
  }, [on, base, video]);

  return useCallback((strength: number, now: number, force = false) => {
    ramp.current?.hit(now, strength, force);
  }, []);
}
