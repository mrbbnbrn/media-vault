// The discovery river: an endless, slow stream of random pictures and videos
// drifting past in layers of depth. Hover one to bring it closer; click to
// open it; hold and move one around and flick it (it carries on with the
// mouse's speed); right-click while holding to freeze it there; middle-click
// for the mini player; wheel or ←/→ for a faster or slower current; Space
// pauses; Esc leaves. Speed, flow amount and layers: the bar that appears at
// the bottom when the mouse is there. The drawing is engine.ts, the maths river.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_LAYERS, flowText, flowToSlider, MAX_DENSITY, MAX_LAYERS, MIN_DENSITY, MIN_LAYERS, sliderToFlow } from '../../river';
import { saveViewerPrefs, viewerPrefs } from '../../prefs';
import { CloseIcon } from '../Icons';
import { grainTile, RiverEngine, type RiverItem, type Sources } from './engine';
import './river.css';

/** The bar shows while the mouse is in the bottom part of the river and has moved lately. */
const BAR_ZONE = 0.78;
const BAR_IDLE_MS = 2600;

const REDUCED = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function River(props: {
  title: string;
  kicker: string;
  items: RiverItem[];
  sources: Sources;
  /** The viewer is open on top. */
  covered: boolean;
  onOpen: (index: number) => void;
  /** Middle-click: open this item in the mini player. */
  onMini?: (index: number) => void;
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
  // The settings bar at the bottom (remembered between rivers).
  const saved = useMemo(() => viewerPrefs(), []);
  const [flow, setFlowValue] = useState(saved.riverFlow ?? 1);
  const [density, setDensityValue] = useState(saved.riverDensity ?? 1);
  const [layers, setLayersValue] = useState(saved.riverLayers ?? DEFAULT_LAYERS);
  const [bar, setBar] = useState(false);
  const overBar = useRef(false);
  const barTimer = useRef(0);
  const saveTimer = useRef(0);
  const remember = (patch: Parameters<typeof saveViewerPrefs>[0]) => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => saveViewerPrefs(patch), 500);
  };
  const pending = useRef<Parameters<typeof saveViewerPrefs>[0]>({});
  const rememberSoon = (patch: Parameters<typeof saveViewerPrefs>[0]) => {
    pending.current = { ...pending.current, ...patch };
    remember(pending.current);
  };
  const pokeBar = (y: number) => {
    const h = root.current?.clientHeight ?? 1;
    window.clearTimeout(barTimer.current);
    const show = overBar.current || y > h * BAR_ZONE;
    setBar(show);
    if (show) barTimer.current = window.setTimeout(() => !overBar.current && setBar(false), BAR_IDLE_MS);
  };
  useEffect(() => () => {
    window.clearTimeout(barTimer.current);
    window.clearTimeout(saveTimer.current);
    if (Object.keys(pending.current).length) saveViewerPrefs(pending.current);
  }, []);

  useEffect(() => {
    if (!root.current || !stage.current || !canvas.current) return;
    const start = viewerPrefs();
    const e = new RiverEngine(root.current, stage.current, canvas.current, props.items, props.sources, {
      onOpen: (i) => p.current.onOpen(i),
      onFlow: (text, f) => {
        setNote({ text, at: Date.now() });
        if (text !== 'Paused') {
          setFlowValue(f);
          rememberSoon({ riverFlow: f });
        }
      },
      onLeave: () => p.current.onClose(),
    }, REDUCED, { flow: start.riverFlow ?? 1, density: start.riverDensity ?? 1, layers: start.riverLayers ?? DEFAULT_LAYERS });
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
        pokeBar(q.y);
      }}
      onPointerLeave={() => {
        if (!engine.current?.holding) engine.current?.pointer(null);
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button, input, .rv-bar')) return;
        const en = engine.current;
        if (!en) return;
        const q = at(e);
        if (e.button === 2 && en.holding) {
          // Right-click while holding: freeze it right there.
          en.freeze();
          e.preventDefault();
          return;
        }
        if (e.button === 1) {
          // Middle-click: the mini player (no auto-scroll circle).
          e.preventDefault();
          const i = en.itemAt(q.x, q.y);
          if (i != null) p.current.onMini?.(i);
          return;
        }
        if (e.button !== 0) return;
        if (en.press(q.x, q.y)) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerUp={(e) => {
        if (e.button === 0) engine.current?.release();
      }}
      // A second button while one is held comes as a mouse event only (no new pointer-down).
      onMouseDown={(e) => {
        if (e.button === 2 && engine.current?.holding) {
          engine.current.freeze();
          e.preventDefault();
        }
      }}
      onPointerCancel={() => engine.current?.release()}
      onAuxClick={(e) => e.preventDefault()}
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
      <div className={`rv-hint${hint && !bar ? ' on' : ''}`}>
        Click to open · hold and flick · right-click while holding freezes · middle-click: mini player · settings at the bottom · Esc leaves
      </div>
      <div className={`rv-bar${bar ? ' on' : ''}`} role="group" aria-label="River settings"
        onPointerEnter={() => {
          overBar.current = true;
          window.clearTimeout(barTimer.current);
          setBar(true);
        }}
        onPointerLeave={() => {
          overBar.current = false;
          barTimer.current = window.setTimeout(() => setBar(false), BAR_IDLE_MS);
        }}>
        <label className="rv-set" title="How fast the current flows (the mouse wheel changes it too)">
          <span>Speed <b>{flowText(flow)}</b></span>
          <input type="range" min={0} max={1} step={0.005} value={flowToSlider(flow)} aria-label="River speed"
            onChange={(e) => {
              const f = sliderToFlow(Number(e.target.value));
              setFlowValue(f);
              engine.current?.setFlow(f);
              rememberSoon({ riverFlow: f });
            }} />
          <span className="rv-ends"><i>Slow</i><i>Very fast</i></span>
        </label>
        <label className="rv-set" title="How many items flow past">
          <span>Flow amount <b>{Math.round(density * 100)}%</b></span>
          <input type="range" min={MIN_DENSITY} max={MAX_DENSITY} step={0.05} value={density} aria-label="Flow amount"
            onChange={(e) => {
              const d = Number(e.target.value);
              setDensityValue(d);
              engine.current?.setDensity(d);
              rememberSoon({ riverDensity: d });
            }} />
          <span className="rv-ends"><i>Fewer</i><i>More</i></span>
        </label>
        <label className="rv-set" title="How many depth layers: 2 = a front row and the row just behind it; more = a crowded screen">
          <span>Layers <b>{layers}</b></span>
          <input type="range" min={MIN_LAYERS} max={MAX_LAYERS} step={1} value={layers} aria-label="Layers"
            onChange={(e) => {
              const n = Number(e.target.value);
              setLayersValue(n);
              engine.current?.setLayers(n);
              rememberSoon({ riverLayers: n });
            }} />
          <span className="rv-ends"><i>Few</i><i>Crowded</i></span>
        </label>
      </div>
    </div>
  );
}
