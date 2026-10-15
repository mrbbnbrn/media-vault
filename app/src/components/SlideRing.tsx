// "Time to next slide": a small ring around the Slideshow button's icon. It
// empties clockwise as the slide's time goes (pictures, GIFs, videos), stops
// with the slideshow, and with beat sync shows the beats left instead,
// pulsing on each beat. Drawn straight from a reader every frame, so the
// player doesn't re-render for it.

import { useEffect, useRef } from 'react';
import type { RingInfo } from '../slidering';
import './slidering.css';

const SIZE = 26;
const R = 11;
const C = 2 * Math.PI * R;

export function SlideRing({ read, pulse, children }: {
  /** What to show now (null: the slide hasn't started yet, so a full ring). */
  read: () => RingInfo | null;
  /** Counts beats heard (beat sync), for the pulse. */
  pulse: number;
  children: React.ReactNode;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const arc = useRef<SVGCircleElement>(null);
  const ticks = useRef<SVGGElement>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const lastSeg = useRef(0);
  const lastMode = useRef('');

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const info = readRef.current();
      const frac = !info ? 0 : info.mode === 'time' ? info.frac : info.filled / Math.max(1, info.every);
      const segs = !info ? 1 : info.mode === 'time' ? info.segments : info.every;
      const running = !!info?.running;
      arc.current?.setAttribute('stroke-dashoffset', String(-C * frac));
      const el = root.current;
      if (el) {
        el.classList.toggle('halted', !running);
        const mode = info?.mode ?? 'time';
        if (mode !== lastMode.current) {
          el.dataset.mode = mode;
          lastMode.current = mode;
        }
      }
      if (segs !== lastSeg.current && ticks.current) {
        lastSeg.current = segs;
        const g = ticks.current;
        g.replaceChildren();
        if (segs > 1) {
          for (let k = 0; k < segs; k++) {
            const a = (k / segs) * 2 * Math.PI - Math.PI / 2;
            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.setAttribute('x1', String(SIZE / 2 + Math.cos(a) * (R - 2.4)));
            l.setAttribute('y1', String(SIZE / 2 + Math.sin(a) * (R - 2.4)));
            l.setAttribute('x2', String(SIZE / 2 + Math.cos(a) * (R + 2.4)));
            l.setAttribute('y2', String(SIZE / 2 + Math.sin(a) * (R + 2.4)));
            g.appendChild(l);
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // A little beat on each beat heard.
  const firstPulse = useRef(pulse);
  useEffect(() => {
    const el = root.current;
    if (!el || pulse === firstPulse.current || el.dataset.mode !== 'beat' || typeof el.animate !== 'function') return;
    el.animate([{ transform: 'scale(1.16)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
  }, [pulse]);

  return (
    <span ref={root} className="slide-ring" data-mode="time">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle className="slide-ring-track" cx={SIZE / 2} cy={SIZE / 2} r={R} />
        <circle ref={arc} className="slide-ring-arc" cx={SIZE / 2} cy={SIZE / 2} r={R}
          strokeDasharray={`${C} ${C}`} strokeDashoffset={0} transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} />
        <g ref={ticks} className="slide-ring-ticks" />
      </svg>
      <span className="slide-ring-icon">{children}</span>
    </span>
  );
}
