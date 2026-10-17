// The museum walk-through: a full-screen 3D gallery made from a folder's
// pictures. Loaded lazily (three.js is big), see launch.tsx.
//
// Click to start (the mouse is captured), W A S D / arrows walk, Shift hurries,
// the mouse looks around, Q / E glide from picture to picture. Clicking a
// picture glides up for a close look (arrows move along, Enter opens the full
// viewer over the museum, Esc steps back). Esc frees the mouse; Esc again (or
// "Leave museum") leaves.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { WebGLRenderer } from 'three';
import { MuseumEngine, type Aim, type Pose, type Quality, type Sources } from './engine';
import { hallAt, layoutWing, planWings, roman, wingContent, type Door, type Frame, type MuseumItem, type WingLayout } from './layout';
import './museum.css';
import { useLayer } from '../../keylayers';

export interface MuseumProps {
  title: string;
  items: MuseumItem[];
  sources: Sources;
  /** Where to stand when coming back from the viewer. */
  resume?: { wing: number; pose: Pose } | null;
  onClose: () => void;
  onOpenItem?: (id: number, at: { wing: number; pose: Pose }) => void;
  /** The viewer is open on top: the museum holds still (and leaves the keys alone). */
  covered?: boolean;
  /** Back from the viewer on this item: look at it closely (if it hangs in this wing). */
  returnTo?: { id: number; n: number } | null;
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

function frameInfo(f: Frame): string {
  const it = f.item;
  const parts: string[] = [];
  if (it.kind === 'video') parts.push('Film');
  else if (it.kind === 'gif') parts.push('Moving picture');
  if (it.favourite) parts.push('Favourite');
  if (it.takenAt) {
    const d = new Date(it.takenAt * 1000);
    parts.push(`${MONTHS[d.getMonth()]} ${d.getFullYear()}`);
  }
  return parts.join(' · ');
}

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
  /** Where to stand in the next wing (wins over the pose saved when the old wing closes). */
  const nextPose = useRef<Pose | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [entered, setEntered] = useState(!!props.resume);
  const entered_ = useRef(entered);
  entered_.current = entered;
  const [dragMode, setDragMode] = useState(false);
  const [aim, setAim] = useState<Aim>(null);
  const [hall, setHall] = useState<string>('');
  const [hint, setHint] = useState(false);
  const [fading, setFading] = useState(false);
  const [showMap, setShowMap] = useState(true);
  /** The picture being looked at closely. */
  const [closeOn, setCloseOn] = useState<Frame | null>(null);
  const closeRef = useRef<Frame | null>(null);
  closeRef.current = closeOn;
  /** Esc freed the mouse while walking: the "Paused" card shows. */
  const [userPaused, setUserPaused] = useState(false);
  const userPausedRef = useRef(false);
  userPausedRef.current = userPaused;
  /** Set when the museum lets go of the mouse itself (close look, viewer): that isn't a pause. */
  const selfUnlock = useRef(false);
  const coveredRef = useRef(!!props.covered);
  coveredRef.current = !!props.covered;
  const lockedRef = useRef(false);
  const everLocked = useRef(false);
  const unlockedAt = useRef(0);
  /** Set while walking through a door: the next wing reuses the canvas (and keeps the mouse captured). */
  const keepContext = useRef(false);
  const renderer = useRef<WebGLRenderer | null>(null);
  const dropRenderer = () => {
    const r = renderer.current;
    if (!r) return;
    MuseumEngine.releaseRenderer(r);
    renderer.current = null;
  };
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
        const start = nextPose.current ?? startPose.current;
        nextPose.current = null;
        if (renderer.current?.domElement !== canvas) {
          dropRenderer();
          renderer.current = MuseumEngine.createRenderer(canvas, quality);
        }
        eng = new MuseumEngine(renderer.current, layout, quality, props_.current.sources, start, {
          onAim: setAim,
          onOpen: (f: Frame) => open(f),
          onDoor: (d: Door) => throughDoor(d),
          onCloseLook: (f: Frame | null) => {
            setCloseOn(f);
            // Free the mouse for the close look's buttons (that isn't a pause).
            if (f && document.pointerLockElement) {
              selfUnlock.current = true;
              document.exitPointerLock();
            }
          },
          doorText: (d: Door) => {
            const k = d.kind === 'next' ? wing + 1 : wing - 1;
            const r = ranges[k];
            return [d.kind === 'next' ? 'Next wing' : 'Previous wing', r ? `Wing ${roman(k + 1)} · pictures ${r[0].toLocaleString()}–${r[1].toLocaleString()}` : ''];
          },
          plaqueText: (f: Frame) => [bare(f.item.name), frameInfo(f)],
        });
        engine.current = eng;
        eng.setPaused(coveredRef.current);
        setCloseOn(null);
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
      // Walking into the next wing keeps the canvas, its renderer and the captured mouse.
      if (!keepContext.current) dropRenderer();
      keepContext.current = false;
      if (engine.current === eng) engine.current = null;
    };
  }, [layout, quality]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (f: Frame) => {
    const eng = engine.current;
    if (!eng || !props_.current.onOpenItem) return;
    if (document.pointerLockElement) {
      selfUnlock.current = true;
      document.exitPointerLock();
    }
    eng.clearKeys();
    props_.current.onOpenItem(f.item.id, { wing, pose: eng.getPose() });
  };

  const openRef = useRef(open);
  openRef.current = open;

  // The viewer on top: hold still (nothing is rebuilt; closing it carries on from here).
  useEffect(() => {
    engine.current?.setPaused(!!props.covered);
  }, [props.covered]);

  // Back from the viewer: look closely at the picture it ended on (if it hangs in this wing).
  const returnN = props.returnTo?.n;
  useEffect(() => {
    const r = props_.current.returnTo;
    const eng = engine.current;
    if (!r || !eng) return;
    const f = layout.frames.find((x) => x.item.id === r.id);
    if (f && eng.closeFrame() !== f) eng.closeLook(f, true);
  }, [returnN]); // eslint-disable-line react-hooks/exhaustive-deps

  const stepBack = (relock: boolean) => {
    engine.current?.stepBack();
    if (relock) lock();
  };

  const throughDoor = (d: Door) => {
    const next = d.kind === 'next' ? wing + 1 : wing - 1;
    if (next < 0 || next >= plan.wings.length) return;
    setFading(true);
    setTimeout(() => {
      const c = wingContent(plan, next);
      const l = layoutWing(c.gallery, { featured: c.featured, hasPrev: next > 0, hasNext: next < plan.wings.length - 1, wing: next });
      const s = d.kind === 'next' ? l.spawn : l.spawnBack;
      nextPose.current = { x: s.x, y: s.y, yaw: s.yaw, pitch: 0 };
      keepContext.current = true;
      setWing(next);
    }, 350);
  };

  // ---- pointer lock and mouse -------------------------------------------------------------
  useEffect(() => {
    const onChange = () => {
      const on = document.pointerLockElement === canvasRef.current;
      lockedRef.current = on;
      if (on) {
        everLocked.current = true;
        setUserPaused(false);
      } else {
        unlockedAt.current = performance.now();
        if (selfUnlock.current) selfUnlock.current = false;
        else setUserPaused(true);
      }
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
    setUserPaused(false);
    if (!c.requestPointerLock) return setDragMode(true);
    try {
      // unadjustedMovement isn't everywhere; fall back to the plain call.
      try {
        await (c.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void)({ unadjustedMovement: true });
      } catch {
        await (c.requestPointerLock as () => Promise<void> | void)();
      }
    } catch {
      // Right after Esc the browser refuses for a moment; only give up on capturing
      // the mouse (and drag to look instead) if it never worked.
      if (!everLocked.current) setDragMode(true);
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
      const r = (e.target as HTMLElement).getBoundingClientRect();
      const at = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -(((e.clientY - r.top) / r.height) * 2 - 1) };
      if (closeRef.current) {
        // On the picture: the full viewer; anywhere else: step back (and look around again).
        engine.current?.click(at);
        if (!engine.current?.closeFrame() && !dragMode) lock();
      } else if (dragMode) engine.current?.click(at);
      // With the mouse free (after a close look) a picture under it gets a close look;
      // anywhere else the mouse is captured again.
      else if (!(entered && engine.current?.click(at))) lock();
    }
  };

  // ---- keyboard (captured so the library underneath doesn't react) ------------------------
  // A layer (keylayers.ts): "back" steps out of a close look, else leaves the museum.
  const stepBackRef = useRef(stepBack);
  stepBackRef.current = stepBack;
  const layer = useLayer(true, { name: 'museum', onBack: () => (closeRef.current ? stepBackRef.current(true) : props_.current.onClose()) });
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Under the viewer (or a dialog) the keys are theirs.
      if (coveredRef.current || !layer.mine()) return;
      if (e.ctrlKey && e.shiftKey) return; // the panic key and friends
      e.stopPropagation();
      const eng = engine.current;
      const close = closeRef.current;
      if (close) {
        // A close look: move along, open, or step back.
        if (['ArrowLeft', 'KeyA', 'KeyQ', 'PageUp'].includes(e.code) || (e.code === 'Tab' && e.shiftKey)) eng?.step(-1);
        else if (['ArrowRight', 'KeyD', 'KeyE', 'PageDown', 'Tab'].includes(e.code)) eng?.step(1);
        else if (['Enter', 'NumpadEnter', 'Space', 'KeyF'].includes(e.code)) openRef.current(close);
        else if (e.code === 'Escape') stepBack(false);
        else if (['Backspace', 'KeyS', 'ArrowDown', 'ArrowUp', 'KeyW'].includes(e.code)) stepBack(true);
        else if (e.code === 'KeyM') setShowMap((v) => !v);
        else return;
        e.preventDefault();
        return;
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        // The Esc that freed the mouse must not also close the museum.
        if (lockedRef.current || performance.now() - unlockedAt.current < 300) return;
        if (userPausedRef.current || !entered_.current) props_.current.onClose();
        else setUserPaused(true);
        return;
      }
      if (MOVE.has(e.code)) {
        e.preventDefault();
        eng?.setKey(e.code, true);
      } else if (e.code === 'KeyM') setShowMap((v) => !v);
      else if (e.code === 'KeyE' || (e.code === 'Tab' && !e.shiftKey)) {
        e.preventDefault();
        eng?.step(1);
      } else if (e.code === 'KeyQ' || e.code === 'Tab') {
        e.preventDefault();
        eng?.step(-1);
      } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
        e.preventDefault();
        eng?.click();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (coveredRef.current || !layer.mine()) return;
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- minimap and the hall name ----------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const eng = engine.current;
      if (!eng || coveredRef.current) return;
      const p = eng.where();
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
    ? { name: bare(aim.frame.item.name), sub: 'Click for a close look' }
    : aim?.kind === 'door'
      ? { name: aim.door.kind === 'next' ? 'Next wing' : 'Previous wing', sub: 'Click or walk through' }
      : null;
  const paused = entered && !locked && !dragMode && userPaused && !closeOn;
  /** Walking with the mouse free (after a close look): click or drag to look around. */
  const relaxed = entered && !locked && !dragMode && !userPaused && !closeOn;

  return (
    <div className="museum" role="application" aria-label={`Museum of ${props.title}`}>
      {/* A fresh canvas for each quality: a WebGL context can't be reused once it is let go. */}
      <canvas key={quality} ref={canvasRef} className={`museum-canvas${locked ? ' locked' : ''}`}
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

      {ready && showMap && !closeOn && <canvas ref={mapRef} className="museum-map" width={200} height={200} aria-label="Map" />}

      {ready && !entered && (
        <div className="museum-card">
          <span className="museum-crest" aria-hidden="true">✦</span>
          <h2>{props.title}</h2>
          <p>A museum of {count.toLocaleString()} {count === 1 ? 'piece' : 'pieces'}{plan.wings.length > 1 ? ` in ${plan.wings.length} wings` : ''}.</p>
          <button type="button" className="btn btn-primary" onClick={lock} autoFocus>Click to enter</button>
          <span className="museum-keys">W A S D to walk · mouse to look · Shift to hurry · Q / E from picture to picture</span>
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

      {ready && (locked || dragMode || relaxed) && !closeOn && (
        <div className={`museum-hint${hint || dragMode || relaxed ? ' on' : ''}`}>
          {dragMode
            ? 'Drag to look · W A S D to walk · Shift to hurry · Q / E next picture · click a picture for a close look · Esc to leave'
            : relaxed
              ? 'Click to look around · W A S D to walk · Q / E from picture to picture · Esc to pause'
              : 'W A S D to walk · Shift to hurry · Q / E from picture to picture · click a picture for a close look · M map · Esc to pause'}
        </div>
      )}

      {ready && closeOn && (
        <div className="museum-close" role="group" aria-label="Close look">
          <button type="button" className="museum-close-nav" onClick={() => engine.current?.step(-1)} title="Previous picture (←)" aria-label="Previous picture">‹</button>
          <div className="museum-close-title">
            <b>{bare(closeOn.item.name)}</b>
            <span>{frameInfo(closeOn) || 'Close look'}</span>
          </div>
          <div className="museum-close-actions">
            {props.onOpenItem && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => open(closeOn)} title="Enter, or click the picture">
                {closeOn.item.kind === 'video' ? 'Watch with sound' : 'Open in viewer'}
              </button>
            )}
            <button type="button" className="btn btn-sm museum-back" onClick={() => stepBack(true)} title="Esc">Step back</button>
          </div>
          <button type="button" className="museum-close-nav" onClick={() => engine.current?.step(1)} title="Next picture (→)" aria-label="Next picture">›</button>
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
