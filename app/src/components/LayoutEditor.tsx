// The layout editor: draw your own multi-screen layout from boxes. Drag a box
// to move it, drag its edges or corners to resize it, right-click it for more.
// Boxes snap to the screen's edges and to the other boxes (hold Alt to place
// freely). Saved layouts are kept as 'freeLayout' named settings; see
// customLayouts.ts for the format and how they play.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import {
  addBox, boxesFromLayout, DRAFT_ID, duplicate, registerFree, forSaving, freeEntry, freeId, makeSquare, makeTall, makeWide, MAX_BOXES, savedFreeLayouts, setCorner, setFreeLayouts, snapRect,
  tidyZ, toBack, toFront, visibleRect, type Edges, type FreeBox, type FreeLayoutSettings, type Rect, DEFAULT_RADIUS,
} from '../customLayouts';
import { useLayer } from '../keylayers';
import { ContextMenu, PromptDialog, type MenuItem } from './Dialogs';
import { CloseIcon, PlusIcon, UndoIcon } from './Icons';
import './layouteditor.css';

const MIN = 32;
const HANDLES: { k: string; e: Edges }[] = [
  { k: 'n', e: { t: true } }, { k: 's', e: { b: true } }, { k: 'w', e: { l: true } }, { k: 'e', e: { r: true } },
  { k: 'nw', e: { t: true, l: true } }, { k: 'ne', e: { t: true, r: true } }, { k: 'sw', e: { b: true, l: true } }, { k: 'se', e: { b: true, r: true } },
];

interface Drag { i: number; mode: 'move' | Edges; sx: number; sy: number; start: Rect; before: FreeBox[]; moved: boolean }

/** A label for a box whose shape is one of the named ones. */
function shapeName(w: number, h: number): string | null {
  const a = w / h;
  if (Math.abs(a - 1) < 0.01) return 'square';
  if (Math.abs(a - 9 / 16) < 0.01) return '9:16';
  if (Math.abs(a - 16 / 9) < 0.01) return '16:9';
  return null;
}

export function LayoutEditor(props: {
  start: FreeBox[];
  /** Set when changing a saved layout ("Done" then saves to it). */
  name: string | null;
  canSave: boolean;
  onSave: (name: string, boxes: FreeBox[]) => Promise<void>;
  onDone: (boxes: FreeBox[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [boxes, setBoxesRaw] = useState<FreeBox[]>(() => tidyZ(props.start.slice(0, MAX_BOXES)));
  const [history, setHistory] = useState<FreeBox[][]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [menu, setMenu] = useState<{ x: number; y: number; i: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [size, setSize] = useState({ w: 1280, h: 720 });
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const W = size.w;
  const H = size.h;

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }));
    ro.observe(el);
    setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
    return () => ro.disconnect();
  }, []);

  /** Change the boxes, remembering the old ones for Undo. */
  const change = (next: FreeBox[], before = boxes) => {
    setHistory((h) => [...h.slice(-49), before]);
    setBoxesRaw(next);
  };
  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    setBoxesRaw(last);
    setSel(null);
  };
  const remove = (i: number) => {
    change(tidyZ(boxes.filter((_, j) => j !== i)));
    setSel(null);
  };
  const patch = (i: number, f: (b: FreeBox) => FreeBox) => change(boxes.map((b, j) => (j === i ? f(b) : b)));

  // ---- dragging ------------------------------------------------------------------------------

  const toPx = (b: FreeBox): Rect => ({ x: b.x * W, y: b.y * H, w: b.w * W, h: b.h * H });
  const toFr = (r: Rect, b: FreeBox): FreeBox => ({ ...b, x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H });

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    d.moved = true;
    const s = d.start;
    let r: Rect = { ...s };
    const others = d.before.filter((_, j) => j !== d.i).map((b) => visibleRect(b, W, H));
    const circle = d.before[d.i].corner === 'circle';
    if (d.mode === 'move') {
      r.x = Math.min(Math.max(s.x + dx, 0), W - s.w);
      r.y = Math.min(Math.max(s.y + dy, 0), H - s.h);
      if (!e.altKey) {
        const sn = snapRect(r, 'move', others, W, H);
        r = { ...sn.rect, x: Math.min(Math.max(sn.rect.x, 0), W - s.w), y: Math.min(Math.max(sn.rect.y, 0), H - s.h) };
        setGuides(sn.guides);
      } else setGuides({ x: [], y: [] });
    } else {
      const m = d.mode;
      const right = s.x + s.w;
      const bottom = s.y + s.h;
      if (m.l) { r.x = Math.min(Math.max(s.x + dx, 0), right - MIN); r.w = right - r.x; }
      if (m.r) r.w = Math.min(Math.max(s.w + dx, MIN), W - s.x);
      if (m.t) { r.y = Math.min(Math.max(s.y + dy, 0), bottom - MIN); r.h = bottom - r.y; }
      if (m.b) r.h = Math.min(Math.max(s.h + dy, MIN), H - s.y);
      if (!e.altKey && !circle) {
        const sn = snapRect(r, m, others, W, H);
        if (sn.rect.w >= MIN && sn.rect.h >= MIN && sn.rect.x >= 0 && sn.rect.y >= 0 && sn.rect.x + sn.rect.w <= W + 0.5 && sn.rect.y + sn.rect.h <= H + 0.5) r = sn.rect;
        setGuides(sn.guides);
      } else setGuides({ x: [], y: [] });
      if (circle) {
        // A circle's box stays square: it grows from the corner or edge held still.
        let side = (m.l || m.r) && (m.t || m.b) ? Math.max(r.w, r.h) : m.l || m.r ? r.w : r.h;
        side = Math.max(MIN, Math.min(side, m.l ? right : W - r.x, m.t ? bottom : H - r.y));
        if (!(m.l || m.r)) {
          // Dragged from the top or bottom: keep the middle where it was, across.
          const cx = s.x + s.w / 2;
          r.x = Math.min(Math.max(cx - side / 2, 0), W - side);
        } else if (m.l) r.x = right - side;
        if (!(m.t || m.b)) {
          const cy = s.y + s.h / 2;
          r.y = Math.min(Math.max(cy - side / 2, 0), H - side);
        } else if (m.t) r.y = bottom - side;
        r.w = side;
        r.h = side;
      }
    }
    setBoxesRaw(d.before.map((b, j) => (j === d.i ? toFr(r, b) : b)));
  }, [W, H]); // eslint-disable-line react-hooks/exhaustive-deps

  const onUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    setGuides({ x: [], y: [] });
    if (d?.moved) setHistory((h) => [...h.slice(-49), d.before]);
  }, [onMove]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  }, [onMove, onUp]);

  const startDrag = (e: React.PointerEvent, i: number, mode: 'move' | Edges) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSel(i);
    drag.current = { i, mode, sx: e.clientX, sy: e.clientY, start: toPx(boxes[i]), before: boxes, moved: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ---- keys ------------------------------------------------------------------------------------

  const layer = useLayer(true, { name: 'layout editor', onBack: () => props.onCancel() });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      if (!layer.mine()) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') undo();
      else if (sel != null && (k === 'delete' || k === 'backspace')) remove(sel);
      else if (sel != null && k.startsWith('arrow')) {
        const step = e.shiftKey ? 10 : 1;
        const [mx, my] = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k] ?? [0, 0];
        patch(sel, (b) => ({ ...b, x: Math.min(Math.max(b.x + mx / W, 0), 1 - b.w), y: Math.min(Math.max(b.y + my / H, 0), 1 - b.h) }));
      } else if (k === 'escape') setSel(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- the right-click menu --------------------------------------------------------------------

  const menuItems = (i: number): MenuItem[] => {
    const b = boxes[i];
    const corner = b.corner ?? 'square';
    return [
      { label: 'Bring to front', onSelect: () => change(toFront(boxes, i)) },
      { label: 'Send to back', onSelect: () => change(toBack(boxes, i)) },
      { label: 'Corners: square', checked: corner === 'square', sepBefore: true, onSelect: () => patch(i, (x) => setCorner(x, 'square', W, H)) },
      { label: 'Corners: rounded', checked: corner === 'rounded', onSelect: () => patch(i, (x) => setCorner(x, 'rounded', W, H)) },
      { label: 'Corners: circle', checked: corner === 'circle', onSelect: () => patch(i, (x) => setCorner(x, 'circle', W, H)) },
      { label: 'Make square', sepBefore: true, onSelect: () => patch(i, (x) => makeSquare(x, W, H)) },
      { label: 'Make tall (9:16)', onSelect: () => patch(i, (x) => makeTall(x, W, H)) },
      { label: 'Make wide (16:9)', onSelect: () => patch(i, (x) => makeWide(x, W, H)) },
      { label: 'Fill the screen', onSelect: () => patch(i, (x) => ({ ...x, x: 0, y: 0, w: 1, h: 1 })) },
      { label: 'Duplicate', sepBefore: true, disabled: boxes.length >= MAX_BOXES, onSelect: () => { change(duplicate(boxes, i)); setSel(boxes.length); } },
      { label: 'Remove', danger: true, onSelect: () => remove(i) },
    ];
  };

  // ---- render ------------------------------------------------------------------------------------

  const full = boxes.length >= MAX_BOXES;
  const finish = async (f: () => void | Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="le">
      <div className="mbar le-bar">
        <b className="le-title">{props.name ? `Changing “${props.name}”` : 'Edit layout'}</b>
        <button type="button" className="btn btn-sm" disabled={full} title={full ? `Up to ${MAX_BOXES} boxes` : 'Add a box'}
          onClick={() => { change(addBox(boxes, W, H)); setSel(boxes.length); }}>
          <PlusIcon size={13} /> Box
        </button>
        <button type="button" className="btn btn-sm" disabled={!boxes.length} onClick={() => { change([]); setSel(null); }}>Start empty</button>
        <button type="button" className="btn btn-sm" disabled={!history.length} onClick={undo} title="Undo (Ctrl+Z)"><UndoIcon size={13} /> Undo</button>
        <span className="faint le-hint">Drag to move, drag the edges to resize, right-click a box for more. Hold Alt to place freely.</span>
        <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
          <span className="faint le-count">{boxes.length} of {MAX_BOXES} boxes</span>
          <button type="button" className="btn btn-sm" disabled={!props.canSave || !boxes.length || busy}
            title={props.canSave ? 'Save as a new layout' : 'Open a vault to save layouts'} onClick={() => setSaving(true)}>Save as…</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!boxes.length || busy}
            title={props.name ? `Save the changes to “${props.name}” and play it` : 'Play this layout (not saved)'}
            onClick={() => finish(() => props.onDone(forSaving(boxes).boxes))}>Done</button>
          <button type="button" className="btn btn-sm" onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
      <div className="mstage le-stage" ref={stageRef} onPointerDown={() => setSel(null)} onContextMenu={(e) => e.preventDefault()}>
        {boxes.map((b, i) => {
          const r = toPx(b);
          const v = visibleRect(b, W, H);
          const corner = b.corner ?? 'square';
          const radius = corner === 'circle' ? '50%' : corner === 'rounded' ? `${(b.r ?? DEFAULT_RADIUS) * Math.min(r.w, r.h)}px` : '3px';
          const named = shapeName(v.w, v.h);
          return (
            <div key={i} className={`le-box${sel === i ? ' sel' : ''}${corner === 'circle' ? ' circle' : ''}`}
              style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: (b.z ?? i) + 1 }}
              onPointerDown={(e) => startDrag(e, i, 'move')}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setSel(i); setMenu({ x: e.clientX, y: e.clientY, i }); }}>
              <div className="le-tile" style={{ left: v.x - r.x, top: v.y - r.y, width: v.w, height: v.h, borderRadius: radius }}>
                <span className="le-num" style={{ fontSize: Math.max(18, Math.min(v.w, v.h) * 0.45) }}>{i + 1}</span>
                {named && <span className="le-shape">{named}</span>}
              </div>
              <button type="button" className="le-x" aria-label={`Remove box ${i + 1}`} title="Remove"
                onPointerDown={(e) => e.stopPropagation()} onClick={() => remove(i)}><CloseIcon size={11} /></button>
              {HANDLES.map((h) => (
                <span key={h.k} className={`le-h le-h-${h.k}`} onPointerDown={(e) => startDrag(e, i, h.e)} />
              ))}
            </div>
          );
        })}
        {guides.x.map((x) => <div key={`x${x}`} className="le-guide v" style={{ left: x }} />)}
        {guides.y.map((y) => <div key={`y${y}`} className="le-guide h" style={{ top: y }} />)}
        {!boxes.length && (
          <div className="le-empty">
            <b>No boxes yet</b>
            <span className="muted">Add boxes with “+ Box”, then drag them where you want them. Each box becomes a panel.</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); change(addBox(boxes, W, H)); setSel(0); }}
              onPointerDown={(e) => e.stopPropagation()}><PlusIcon size={13} /> Box</button>
          </div>
        )}
      </div>
      {menu && boxes[menu.i] && (
        <ContextMenu x={menu.x} y={menu.y} title={`Box ${menu.i + 1}`} items={menuItems(menu.i)} onClose={() => setMenu(null)} />
      )}
      {saving && (
        <PromptDialog title="Save layout as" label="Name" confirm="Save" initial={props.name ?? ''} onClose={() => setSaving(false)}
          hint="It shows up under “My layouts” in the shapes menu and in Layouts."
          onSubmit={(name) => props.onSave(name, forSaving(boxes).boxes)} />
      )}
    </div>
  );
}

// ---- saved free-form layouts -------------------------------------------------------------------

/** The saved free-form layouts, with what to do with them, and the rename dialog (render `dialogs` once). */
export function useFreeLayouts(vault: boolean, current: string, play: (id: string) => void) {
  const [list, setList] = useState(savedFreeLayouts);
  const [renaming, setRenaming] = useState<{ dbId: number; name: string } | null>(null);
  const reload = useCallback(async () => {
    if (!vault) return;
    setFreeLayouts(await api.listNamed<FreeLayoutSettings>('freeLayout'));
    setList(savedFreeLayouts());
  }, [vault]);
  useEffect(() => void reload().catch(() => {}), [reload]);
  /** Save (new when dbId is null); gives the layout id to play. */
  const save = async (name: string, boxes: FreeBox[], dbId: number | null): Promise<string> => {
    const id = await api.saveNamed<FreeLayoutSettings>('freeLayout', { id: dbId, name, settings: forSaving(boxes) });
    await reload();
    return freeId(id);
  };
  const rename = async (dbId: number, name: string) => {
    const e = freeEntry(freeId(dbId));
    if (!e) return;
    const id = await save(name, e.boxes, dbId);
    if (current === freeId(dbId)) play(id);
  };
  const remove = async (dbId: number) => {
    await api.deleteNamed('freeLayout', dbId);
    await reload();
    if (current === freeId(dbId)) play('4');
  };
  const dialogs: ReactNode = renaming && (
    <PromptDialog title="Rename layout" label="Name" confirm="Rename" initial={renaming.name} onClose={() => setRenaming(null)}
      onSubmit={(name) => rename(renaming.dbId, name)} />
  );
  /** What the editor starts from: the layout on screen now (a saved free-form one is changed in place). */
  const startEdit = (layoutId: string, W: number, H: number): EditTarget => {
    const e = freeEntry(layoutId);
    return { boxes: boxesFromLayout(layoutId, W, H), dbId: e?.dbId ?? null, name: e?.dbId != null ? e.name : null };
  };
  /**
   * The editor is finished: save as a new layout (`asName`), save the changes to the
   * saved one being changed, or keep it as an unsaved layout. Gives the layout id to play.
   */
  const commit = async (boxes: FreeBox[], target: EditTarget, asName?: string): Promise<string> => {
    if (asName != null) return save(asName, boxes, null);
    if (target.dbId != null && target.name) return save(target.name, boxes, target.dbId);
    registerFree(DRAFT_ID, 'Unsaved layout', boxes);
    return DRAFT_ID;
  };
  return { list, save, remove, startRename: (dbId: number, name: string) => setRenaming({ dbId, name }), startEdit, commit, dialogs };
}

export interface EditTarget { boxes: FreeBox[]; dbId: number | null; name: string | null }

export type FreeLayouts = ReturnType<typeof useFreeLayouts>;

/** The "My layouts" part of the shapes menu. */
export function MyLayoutsMenu(props: {
  free: FreeLayouts;
  current: string;
  thumb: (id: string) => ReactNode;
  onPick: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
}) {
  const { free } = props;
  return (
    <>
      <div className="le-menu-head">
        <span>My layouts</span>
        <button type="button" className="btn btn-sm" onClick={props.onNew}><PlusIcon size={12} /> Draw a new one</button>
      </div>
      {!free.list.length && <div className="faint le-menu-empty">Layouts you draw with “Edit layout” and save show up here.</div>}
      {free.list.map((l) => (
        <div key={l.id} className="le-pick">
          <button type="button" role="menuitemradio" aria-checked={l.id === props.current} className={`shape-pick${l.id === props.current ? ' on' : ''}`}
            onClick={() => props.onPick(l.id)}>
            {props.thumb(l.id)}
            <span className="ellipsis" style={{ maxWidth: '100%' }}>{l.name}</span>
            <span className="faint">{l.count} panel{l.count > 1 ? 's' : ''}</span>
          </button>
          <div className="le-pick-tools">
            <button type="button" className="pbtn" title="Change this layout" onClick={() => props.onEdit(l.id)}>Edit</button>
            <button type="button" className="pbtn" title="Rename" onClick={() => free.startRename(l.dbId, l.name)}>Rename</button>
            <button type="button" className="pbtn" title="Delete" aria-label={`Delete “${l.name}”`} onClick={() => void free.remove(l.dbId)}><CloseIcon size={11} /></button>
          </div>
        </div>
      ))}
    </>
  );
}
