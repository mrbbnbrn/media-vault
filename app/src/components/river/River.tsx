// The discovery river: an endless, slow stream of random pictures and videos
// drifting past in layers of depth. Hover one to bring it closer; click to
// open it; wheel or ←/→ for a faster or slower current; Space pauses; Esc
// leaves. The drawing is engine.ts, the maths river.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CloseIcon } from '../Icons';
import { grainTile, RiverEngine, type RiverItem, type Sources } from './engine';
import './river.css';

const REDUCED = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function River(props: {
  title: string;
  kicker: string;
  items: RiverItem[];
  sources: Sources;
  /** The viewer is open on top. */
  covered: boolean;
  onOpen: (index: number) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<RiverEngine | null>(null);
  const [note, setNote] = useState<{ text: string; at: number } | null>(null);
  const [hint, setHint] = useState(true);
  const grain = useMemo(grainTile, []);
  const p = useRef(props);
  p.current = props;

  useEffect(() => {
    if (!root.current || !stage.current || !canvas.current) return;
    const e = new RiverEngine(root.current, stage.current, canvas.current, props.items, props.sources, {
      onOpen: (i) => p.current.onOpen(i),
      onFlow: (text) => setNote({ text, at: Date.now() }),
      onLeave: () => p.current.onClose(),
    }, REDUCED);
    engine.current = e;
    e.start();
    return () => {
      e.destroy();
      engine.current = null;
    };
  }, [props.items]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    engine.current?.setCovered(props.covered);
  }, [props.covered]);

  // The flow note fades after a moment; the hint after a while.
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote((n) => (n === note ? null : n)), 1400);
    return () => window.clearTimeout(t);
  }, [note]);
  useEffect(() => {
    const t = window.setTimeout(() => setHint(false), 6500);
    return () => window.clearTimeout(t);
  }, []);

  // Keys, ahead of the library underneath (not while the viewer is on top).
  useEffect(() => {
    if (props.covered) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [role=dialog]')) return;
      const en = engine.current;
      if (!en) return;
      const k = e.key;
      if (k === 'Escape' || k === 'Backspace') p.current.onClose();
      else if (k === ' ') en.togglePause();
      else if (k === 'ArrowRight' || k === 'ArrowUp') en.faster(1);
      else if (k === 'ArrowLeft' || k === 'ArrowDown') en.faster(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.covered]);

  // The wheel sets the current (not a passive listener: the page must not scroll).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!p.current.covered) engine.current?.wheel(e.deltaY * (e.deltaMode === 1 ? 30 : 1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = root.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div ref={root} className={`river${REDUCED ? ' reduced' : ''}`} role="application" aria-label={`Discovery river: ${props.title}`}
      onPointerMove={(e) => {
        const q = at(e);
        engine.current?.pointer(q.x, q.y);
      }}
      onPointerLeave={() => engine.current?.pointer(null)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return;
        const q = at(e);
        engine.current?.click(q.x, q.y);
      }}
      onContextMenu={(e) => e.preventDefault()}>
      <div className="rv-sky" aria-hidden="true" />
      <div className="rv-sheen" aria-hidden="true" />
      <canvas ref={canvas} className="rv-motes" aria-hidden="true" />
      <div ref={stage} className="rv-stage" />
      <div className="rv-mist" aria-hidden="true" />
      <div className="rv-vignette" aria-hidden="true" />
      {grain && <div className="rv-grain" aria-hidden="true" style={{ backgroundImage: `url(${grain})` }} />}
      <div className="rv-top">
        <div className="rv-title">
          <span className="rv-kicker">{props.kicker}</span>
          <b>{props.title}</b>
        </div>
        <button type="button" className="btn btn-sm rv-leave" onClick={props.onClose} title="Leave the river (Esc)">
          <CloseIcon size={14} /> Leave
        </button>
      </div>
      {note && <div key={note.at} className="rv-note" role="status">{note.text}</div>}
      <div className={`rv-hint${hint ? ' on' : ''}`}>
        Point at one to look closer · click to open · wheel or ←/→ for the current · Space pauses · Esc leaves
      </div>
    </div>
  );
}
