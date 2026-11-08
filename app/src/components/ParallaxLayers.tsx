// Parallax layers: a few big pieces in front, more medium ones in the middle
// and many small, soft, dim ones far behind, all drifting slowly the same way
// at different speeds (far = slower), for depth. Moving the mouse shifts the
// layers a little (the near ones most). Pieces that drift off one side are
// replaced by new ones coming in from the other (parallax.ts). Only a few
// videos play (front ones first). Double-click a piece to watch it alone.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PlayItem } from '../media';
import { pickWeighted } from './Wall';
import { approach } from '../breathing';
import { chooseVideos, frontSpeed, LAYERS, placeOf, seed, step, type Drifter, type Screen, type Source } from '../parallax';
import type { ParallaxSettings } from '../parallax';
import { aspectOf, GRID_MAX_VIDEOS, GridMedia, useHidden, usePauseVideos } from './gridmedia';

type Piece = Drifter<PlayItem>;

export function ParallaxLayers(props: { items: PlayItem[]; settings: ParallaxSettings; paused: boolean; onOpen: (item: PlayItem) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const hidden = useHidden();
  const stopped = props.paused || hidden;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [list, setList] = useState<Piece[]>([]);
  const listRef = useRef<Piece[]>([]);
  const els = useRef(new Map<number, HTMLElement>());
  const uid = useRef(1);
  const mouse = useRef({ x: 0, y: 0 });
  const shift = useRef({ x: 0, y: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const dir = props.settings.direction;
  const screen = useMemo<Screen>(() => ({ W: size.w, H: size.h, dir }), [size.w, size.h, dir]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);

  const src = useMemo<Source<PlayItem>>(() => ({
    // New pieces are not already on screen (when there is anything else).
    pick: () => pickWeighted(props.items, new Set(listRef.current.map((p) => p.item.key))),
    aspect: aspectOf,
    uid: () => uid.current++,
    rnd: Math.random,
  }), [props.items]);

  // A screen full of pieces when the source, size or direction changes.
  useEffect(() => {
    if (!screen.W || !screen.H) return;
    listRef.current = [];
    const l = seed(src, screen);
    listRef.current = l;
    setList(l);
  }, [src, screen]);

  const place = (p: Piece) => {
    const b = placeOf(p, screen);
    const s = LAYERS[p.layer].shift;
    return `translate3d(${(b.x - shift.current.x * s).toFixed(1)}px, ${(b.y - shift.current.y * s).toFixed(1)}px, 0)`;
  };

  // Drift: positions are written straight to the pieces every frame; React only
  // hears about pieces leaving and arriving.
  const v = frontSpeed(props.settings.speed, screen);
  useEffect(() => {
    if (stopped || !screen.W) return;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const r = step(listRef.current, dt, v, src, screen);
      listRef.current = r.list;
      shift.current = { x: approach(shift.current.x, mouse.current.x, dt, 0.5), y: approach(shift.current.y, mouse.current.y, dt, 0.5) };
      if (r.changed) setList(r.list);
      for (const p of r.list) {
        const el = els.current.get(p.uid);
        if (el) el.style.transform = place(p);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [stopped, v, src, screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const playing = useMemo(() => chooseVideos(list, screen, GRID_MAX_VIDEOS), [list, screen]);
  usePauseVideos(ref, stopped, list);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    mouse.current = { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: ((e.clientY - r.top) / r.height) * 2 - 1 };
  };

  // Positions as they are right now (the drift moves on between renders).
  const now = new Map(listRef.current.map((p) => [p.uid, p]));
  return (
    <div ref={ref} className="parallax" onPointerMove={onMove} onPointerLeave={() => { mouse.current = { x: 0, y: 0 }; setHover(null); }}>
      {LAYERS.map((def, li) => (
        <div key={def.id} className={`parallax-layer ${def.id}`}>
          {list.filter((p) => p.layer === li).map((q) => {
            const p = now.get(q.uid) ?? q;
            const b = placeOf(p, screen);
            return (
              <button key={p.uid} type="button" className={`parallax-piece${hover === p.uid ? ' hover' : ''}`}
                ref={(el) => { if (el) els.current.set(p.uid, el); else els.current.delete(p.uid); }}
                style={{ width: b.w, height: b.h, transform: place(p), filter: def.blur || def.dim < 1 ? `blur(${def.blur}px) brightness(${def.dim})` : undefined }}
                title={`${p.item.name} — double-click to watch it alone`}
                onPointerEnter={() => setHover(p.uid)} onPointerLeave={() => setHover((h) => (h === p.uid ? null : h))}
                onDoubleClick={() => props.onOpen(p.item)}>
                <GridMedia item={p.item} play={playing.has(p.uid)} stopped={stopped} big={def.id !== 'far'} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
