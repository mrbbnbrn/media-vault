// The museum walk-through: a full-screen 3D gallery made from a folder's
// pictures. Loaded lazily (three.js is big), see launch.tsx.
//
// Click to start (the mouse is captured), W A S D / arrows walk, Shift hurries,
// the mouse looks around, clicking a picture opens it in the viewer. Esc frees
// the mouse; Esc again (or "Leave museum") leaves.

import { useEffect, useMemo, useRef, useState } from 'react';
import { MuseumEngine, type Aim, type Pose, type Quality, type Sources } from './engine';
import { hallAt, layoutWing, planWings, roman, wingContent, type Door, type Frame, type MuseumItem, type WingLayout } from './layout';
import './museum.css';

export interface MuseumProps {
  title: string;
  items: MuseumItem[];
  sources: Sources;
  /** Where to stand when coming back from the viewer. */
  resume?: { wing: number; pose: Pose } | null;
  onClose: () => void;
  onOpenItem?: (id: number, at: { wing: number; pose: Pose }) => void;
}

const QKEY = 'mv-museum-quality';
function savedQuality(): Quality {
  try {
    return localStorage.getItem(QKEY) === 'fast' ? 'fast' : 'high';
  } catch {
    return 'high';
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const bare = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, '');
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);

export default function Museum(props: MuseumProps) {
  const plan = useMemo(() => planWings(props.items), [props.items]);
  const [wing, setWing] = useState(() => Math.min(props.resume?.wing ?? 0, plan.wings.length - 1));
  const [quality, setQuality] = useState<Quality>(savedQuality);
  const layout = useMemo<WingLayout>(() => {
    const c = wingContent(plan, wing);
    return layoutWing(c.gallery, { featured: c.featured, hasPrev: wing > 0, hasNext: wing < plan.wings.length - 1, wing });
  }, [plan, wing]);
  /** First item number in each wing (for the door signs). */
  const ranges = useMemo(() => {
    let n = 0;
    return plan.wings.map((_, k) => {
      const c = wingContent(plan, k);
      const count = c.gallery.length + c.featured.length;
      const r = [n + 1, n + count];
      n += count;
      return r;
    });
  }, [plan]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const engine = useRef<MuseumEngine | null>(null);
  const startPose = useRef<Pose>(props.resume?.pose ?? { ...layout.spawn, pitch: 0 });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [entered, setEntered] = useState(!!props.resume);
  const [dragMode, setDragMode] = useState(false);
  const [aim, setAim] = useState<Aim>(null);
  const [hall, setHall] = useState<string>('');
  const [hint, setHint] = useState(false);
  const [fading, setFading] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const lockedRef = useRef(false);
  const props_ = useRef(props);
  props_.current = props;

  // ---- engine lifetime ------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setReady(false);
    let eng: MuseumEngine | null = null;
    // Let the "Polishing the marble…" card paint before the (synchronous) build.
    const t = setTimeout(() => {
      try {
        eng = new MuseumEngine(canvas, layout, quality, props_.current.sources, startPose.current, {
          onAim: setAim,
          onOpen: (f: Frame) => open(f),
          onDoor: (d: Door) => throughDoor(d),
          doorText: (d: Door) => {
            const k = d.kind === 'next' ? wing + 1 : wing - 1;
            const r = ranges[k];
            return [d.kind === 'next' ? 'Next wing' : 'Previous wing', r ? `Wing ${roman(k + 1)} · pictures ${r[0].toLocaleString()}–${r[1].toLocaleString()}` : ''];
          },
          plaqueText: (f: Frame) => {
            const it = f.item;
            const parts: string[] = [];
            if (it.kind === 'video') parts.push('Film');
            if (it.favourite) parts.push('Favourite');
            if (it.takenAt) {
              const d = new Date(it.takenAt * 1000);
              parts.push(`${MONTHS[d.getMonth()]} ${d.getFullYear()}`);
            }
            return [bare(it.name), parts.join(' · ')];
          },
        });
        engine.current = eng;
        // The browser preview's test page drives the camera from outside.
        if (import.meta.env.DEV) (window as unknown as { __museum?: MuseumEngine }).__museum = eng;
        setReady(true);
        setFading(false);
      } catch (e) {
        setFailed(e instanceof Error ? e.message : String(e));
      }
    }, 40);
    return () => {
      clearTimeout(t);
      if (eng) {
        startPose.current = eng.getPose();
        eng.dispose();
      }
      if (engine.current === eng) engine.current = null;
    };
  }, [layout, quality]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (f: Frame) => {
    const eng = engine.current;
    if (!eng || !props_.current.onOpenItem) return;
    if (document.pointerLockElement) document.exitPointerLock();
    props_.current.onOpenItem(f.item.id, { wing, pose: eng.getPose() });
  };

  const throughDoor = (d: Door) => {
    const next = d.kind === 'next' ? wing + 1 : wing - 1;
    if (next < 0 || next >= plan.wings.length) return;
    setFading(true);
    setTimeout(() => {
      const c = wingContent(plan, next);
      const l = layoutWing(c.gallery, { featured: c.featured, hasPrev: next > 0, hasNext: next < plan.wings.length - 1, wing: next });
      const s = d.kind === 'next' ? l.spawn : l.spawnBack;
      startPose.current = { x: s.x, y: s.y, yaw: s.yaw, pitch: 0 };
      engine.current?.clearKeys();
      setWing(next);
    }, 350);
  };

  // ---- pointer lock and mouse -------------------------------------------------------------
  useEffect(() => {
    const onChange = () => {
      const on = document.pointerLockElement === canvasRef.current;
      lockedRef.current = on;
      setLocked(on);
      if (!on) engine.current?.clearKeys();
    };
    const onMove = (e: MouseEvent) => {
      if (lockedRef.current) engine.current?.look(e.movementX, e.movementY);
    };
    document.addEventListener('pointerlockchange', onChange);
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('pointerlockchange', onChange);
      document.removeEventListener('mousemove', onMove);
      if (document.pointerLockElement === canvasRef.current) document.exitPointerLock();
    };
  }, []);

  const lock = async () => {
    const c = canvasRef.current;
    if (!c) return;
    setEntered(true);
    try {
      // unadjustedMovement isn't everywhere; fall back to the plain call.
      try {
        await (c.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void)({ unadjustedMovement: true });
      } catch {
        await (c.requestPointerLock as () => Promise<void> | void)();
      }
    } catch {
      setDragMode(true);
    }
  };

  useEffect(() => {
    if (!locked) return;
    setHint(true);
    const t = setTimeout(() => setHint(false), 7000);
    return () => clearTimeout(t);
  }, [locked]);

  // Dragging to look when the mouse can't be captured.
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if (locked) {
      engine.current?.click();
      return;
    }
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || locked) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    engine.current?.look(dx, dy);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || locked) return;
    if (d.moved < 5) {
      if (dragMode) {
        const r = (e.target as HTMLElement).getBoundingClientRect();
        engine.current?.click({ x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) });
      } else lock();
    }
  };

  // ---- keyboard (captured so the library underneath doesn't react) ------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey) return; // the panic key and friends
      e.stopPropagation();
      if (e.code === 'Escape') {
        e.preventDefault();
        if (!lockedRef.current) props_.current.onClose();
        return;
      }
      if (MOVE.has(e.code)) {
        e.preventDefault();
        engine.current?.setKey(e.code, true);
      } else if (e.code === 'KeyM') setShowMap((v) => !v);
      else if (e.code === 'Enter' || e.code === 'KeyE') engine.current?.click();
    };
    const up = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey) return;
      e.stopPropagation();
      if (MOVE.has(e.code)) engine.current?.setKey(e.code, false);
    };
    const blur = () => engine.current?.clearKeys();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // ---- minimap and the hall name ----------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const eng = engine.current;
      if (!eng) return;
      const p = eng.getPose();
      const h = hallAt(layout, p);
      if (h) setHall(h.name);
      const c = mapRef.current;
      if (c && showMap) drawMap(c, layout, p);
    }, 100);
    return () => clearInterval(id);
  }, [layout, showMap]);

  const setQ = (q: Quality) => {
    try {
      localStorage.setItem(QKEY, q);
    } catch {
      /* not remembered, fine */
    }
    if (q !== quality) setQuality(q);
  };

  const count = props.items.length;
  const aimLabel = aim?.kind === 'frame'
    ? { name: bare(aim.frame.item.name), sub: aim.frame.item.kind === 'video' ? 'Click to watch' : 'Click to open' }
    : aim?.kind === 'door'
      ? { name: aim.door.kind === 'next' ? 'Next wing' : 'Previous wing', sub: 'Click or walk through' }
      : null;
  const paused = entered && !locked && !dragMode;

  return (
    <div className="museum" role="application" aria-label={`Museum of ${props.title}`}>
      <canvas ref={canvasRef} className={`museum-canvas${locked ? ' locked' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} />

      <div className={`museum-fade${fading || !ready ? ' on' : ''}`} />

      {ready && (
        <div className="museum-top">
          <div className="museum-title">
            <span className="museum-kicker">Museum · {props.title}</span>
            <b>{hall}</b>
            {plan.wings.length > 1 && <span className="museum-kicker">Wing {roman(wing + 1)} of {roman(plan.wings.length)}</span>}
          </div>
          {!locked && (
            <div className="museum-actions">
              <div className="museum-seg" role="group" aria-label="Quality">
                <button type="button" className={quality === 'high' ? 'on' : ''} onClick={() => setQ('high')} title="Glow and smoother edges">High</button>
                <button type="button" className={quality === 'fast' ? 'on' : ''} onClick={() => setQ('fast')} title="For slower computers">Fast</button>
              </div>
              <button type="button" className="btn btn-sm museum-leave" onClick={props.onClose} title="Esc">Leave museum</button>
            </div>
          )}
        </div>
      )}

      {ready && (locked || dragMode) && <div className="museum-dot" aria-hidden="true" />}
      {ready && aimLabel && (locked || dragMode) && (
        <div className="museum-aim">
          <b>{aimLabel.name}</b>
          <span>{aimLabel.sub}</span>
        </div>
      )}

      {ready && showMap && <canvas ref={mapRef} className="museum-map" width={200} height={200} aria-label="Map" />}

      {ready && !entered && (
        <div className="museum-card">
          <span className="museum-crest" aria-hidden="true">✦</span>
          <h2>{props.title}</h2>
          <p>A museum of {count.toLocaleString()} {count === 1 ? 'piece' : 'pieces'}{plan.wings.length > 1 ? ` in ${plan.wings.length} wings` : ''}.</p>
          <button type="button" className="btn btn-primary" onClick={lock} autoFocus>Click to enter</button>
          <span className="museum-keys">W A S D to walk · mouse to look · Shift to hurry</span>
        </div>
      )}
      {ready && paused && (
        <div className="museum-card small">
          <h3>Paused</h3>
          <button type="button" className="btn btn-primary" onClick={lock}>Carry on walking</button>
          <button type="button" className="btn" onClick={props.onClose}>Leave museum</button>
          <span className="museum-keys">Esc again to leave</span>
        </div>
      )}
      {!ready && !failed && <div className="museum-loading">Polishing the marble…</div>}
      {failed && (
        <div className="museum-card small">
          <h3>The museum couldn't open</h3>
          <p>This computer's graphics didn't start ({failed}).</p>
          <button type="button" className="btn" onClick={props.onClose}>Back</button>
        </div>
      )}

      {ready && (locked || dragMode) && (
        <div className={`museum-hint${hint || dragMode ? ' on' : ''}`}>
          {dragMode
            ? 'Drag to look · W A S D to walk · Shift to hurry · click a picture to open it · Esc to leave'
            : 'W A S D to walk · Shift to hurry · click a picture to open it · M for the map · Esc to pause'}
        </div>
      )}
    </div>
  );
}

function drawMap(c: HTMLCanvasElement, l: WingLayout, p: Pose) {
  const dpr = window.devicePixelRatio || 1;
  const size = 200;
  if (c.width !== size * dpr) {
    c.width = size * dpr;
    c.height = size * dpr;
  }
  const g = c.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const b = l.bounds;
  const pad = 12;
  const k = Math.min((size - pad * 2) / (b.x1 - b.x0), (size - pad * 2) / (b.y1 - b.y0));
  const ox = pad + ((size - pad * 2) - (b.x1 - b.x0) * k) / 2 - b.x0 * k;
  const oy = pad + ((size - pad * 2) - (b.y1 - b.y0) * k) / 2 - b.y0 * k;
  const X = (x: number) => ox + x * k;
  const Y = (y: number) => oy + y * k;
  for (const h of l.halls) {
    g.fillStyle = h.grand ? 'rgba(120, 26, 34, 0.55)' : 'rgba(90, 22, 28, 0.45)';
    g.fillRect(X(h.rect.x0), Y(h.rect.y0), (h.rect.x1 - h.rect.x0) * k, (h.rect.y1 - h.rect.y0) * k);
  }
  g.strokeStyle = 'rgba(222, 182, 98, 0.9)';
  g.lineWidth = 1.5;
  g.beginPath();
  for (const w of l.walls) {
    g.moveTo(X(w.a.x), Y(w.a.y));
    g.lineTo(X(w.b.x), Y(w.b.y));
  }
  g.stroke();
  g.fillStyle = 'rgba(240, 220, 180, 0.8)';
  for (const f of l.frames) g.fillRect(X(f.at.x) - 1, Y(f.at.y) - 1, 2, 2);
  for (const d of l.doors) {
    if (d.kind === 'pass') continue;
    g.fillStyle = '#e8c06a';
    g.beginPath();
    g.arc(X(d.at.x), Y(d.at.y), 3, 0, Math.PI * 2);
    g.fill();
  }
  // You: a teal arrow.
  const x = X(p.x);
  const y = Y(p.y);
  g.save();
  g.translate(x, y);
  g.rotate(-p.yaw);
  g.fillStyle = '#2ec4b6';
  g.strokeStyle = '#0a1214';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(0, -7);
  g.lineTo(5, 5);
  g.lineTo(0, 2.5);
  g.lineTo(-5, 5);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}
